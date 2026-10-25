/* Bayper 主进程：业务数据、普通管理窗口、托盘、角色画布宿主与低频生命周期。 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  session,
  powerMonitor,
} = require("electron");
const { AppError, toPublicError } = require("./errors.cjs");
const { MemoryError } = require("./memory.cjs");
const { createStore } = require("./store.cjs");
const { createOnboardingService, readStoredModelCredentials } = require("./onboarding.cjs");
const { createCompanionshipService } = require("./companionship.cjs");
const { createDesktopHost } = require("./desktop-host.cjs");
const { buildDesktopPresentation } = require("./desktop-assets.cjs");
const { createAppTray } = require("./app-tray.cjs");
const { createSystemLifecycle } = require("./system-lifecycle.cjs");
const {
  boundaryTimeoutFor,
  assertBoundaryCompleted,
} = require("./presence-boundary.cjs");
const characterContent = require("./content/characters.json");

const RENDERER_FILE = path.join(__dirname, "renderer", "index.html");
const RENDERER_DIR_PREFIX = pathToFileURL(`${path.join(__dirname, "renderer")}${path.sep}`).href;
const TRAY_ICON_FILE = path.join(
  __dirname,
  "..",
  "assets",
  "characters",
  "rin",
  "animations",
  "idle-v3",
  "frame-00.png",
);
const HEARTBEAT_MS = Math.max(200, Number(process.env.BAYPER_HEARTBEAT_MS) || 60000);
const FALLBACK_NODE_MS = 2500;

let mainWindow = null;
let store = null;
let onboardingService = null;
let companionship = null;
let desktopHost = null;
let tray = null;
let heartbeatTimer = null;
let fallbackNodeTimer = null;
let systemLifecycle = null;
let rotationPending = false;
let systemPaused = false;
let desktopVisible = true;
let desktopPassthrough = false;
let cleanupStarted = false;
let cleanupFinished = false;
let quitting = false;
let activeChat = null;

function readDataDir(argv) {
  const inline = argv.find((arg) => arg.startsWith("--data-dir="));
  if (inline) {
    return inline.slice("--data-dir=".length);
  }
  const index = argv.indexOf("--data-dir");
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

const dataDir = readDataDir(process.argv);
if (dataDir) {
  app.setPath("userData", path.resolve(dataDir));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showManagementWindow());
  app.on("activate", () => showManagementWindow());
  app.on("window-all-closed", () => {
    // 关闭管理窗只隐藏；托盘与角色画布保持运行，完全退出走 before-quit。
  });
  app.on("before-quit", handleBeforeQuit);
  app.whenReady().then(startApplication).catch(reportStartupFailure);
}

function startApplication() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  store = createStore(app.getPath("userData"), {
    chat: {
      // 只在应用启动边界恢复崩溃遗留请求；凭据按请求从安全存储解密。
      recoverInterrupted: true,
      getCredentials: () => readStoredModelCredentials({ store, safeStorage }),
    },
  });
  desktopVisible = store.getAppState("desktop_visible") !== "0";
  desktopPassthrough = store.getAppState("desktop_passthrough") === "1";

  onboardingService = createOnboardingService({
    store,
    safeStorage,
    candidates: characterContent.candidates,
  });
  companionship = createCompanionshipService({
    store,
    candidates: characterContent.candidates,
  });
  companionship.start();
  // 上次异常退出可能留下互动锁；本次启动先恢复稳定陪伴状态。
  try {
    companionship.endInteraction();
  } catch (error) {
    console.error("启动清理互动锁失败：", error?.message ?? error);
  }

  desktopHost = createDesktopHost({
    dataDir: app.getPath("userData"),
    onNodeComplete: handleCanvasNodeComplete,
    onAssetError: handleCanvasAssetError,
    onPositionChange: persistDesktopPosition,
    onStatusChange: handleDesktopStatusChange,
  });

  systemLifecycle = createSystemLifecycle(powerMonitor, {
    onPause: pauseForSystem,
    onResume: resumeFromSystem,
  });

  registerIpcHandlers();
  mainWindow = createManagementWindow();
  createTray();
  syncDesktop();
  rotationPending = companionship.getSnapshot().pendingRotation;
  ensurePendingRotationCompletion();
  startHeartbeat();
}

function reportStartupFailure(error) {
  dialog.showErrorBox("Bayper 无法启动", error?.message ?? "未知启动错误。");
  requestQuit();
}

function createManagementWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 620,
    title: "Bayper",
    backgroundColor: "#f7f3e7",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      try {
        closeActiveChat({ notifyRenderer: true });
        win.hide();
      } catch (error) {
        console.error("管理窗关闭被聊天收尾失败阻止：", error?.message ?? error);
      }
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadFile(RENDERER_FILE);
  return win;
}

function showManagementWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function assertTrustedSender(event) {
  const url = event.senderFrame?.url ?? "";
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    !url.startsWith(RENDERER_DIR_PREFIX)
  ) {
    throw new AppError("UNTRUSTED_IPC", "请求来源无效。");
  }
}

function failureResult(error) {
  if (!(error instanceof AppError)) {
    console.error("Bayper 未预期的错误：", error?.message ?? error);
  }
  return { ok: false, error: toPublicError(error) };
}

/* 记忆服务使用自己的稳定错误码；只在具名 IPC 边界公开 code 与中文 message。 */
function memoryFailureResult(error) {
  if (error instanceof MemoryError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return failureResult(error);
}

function readDesktopPosition() {
  const raw = store?.getAppState("desktop_position");
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
      return { x: Math.round(value.x), y: Math.round(value.y) };
    }
  } catch {
    return null;
  }
  return null;
}

function persistDesktopPosition(x, y) {
  if (!store) {
    return;
  }
  store.setAppState("desktop_position", JSON.stringify({ x, y }));
}

function desktopPresentation() {
  if (!onboardingService || !companionship) {
    return null;
  }
  const base = onboardingService.getSnapshot();
  if (base.state !== "accepted") {
    return null;
  }
  const companion = companionship.getSnapshot();
  if (!companion.current) {
    return null;
  }
  const built = buildDesktopPresentation(
    companion.current.characterId,
    companion.current.displayName,
  );
  return {
    character: built.character,
    animations: built.animations,
    assetState: built.assetState,
    assetNote: built.assetNote,
    assetLabel: built.assetLabel,
    mode: companion.current.mode,
    visible: desktopVisible,
    ignoreMouse: desktopPassthrough,
    position: readDesktopPosition(),
  };
}

function syncDesktop() {
  if (!desktopHost || quitting) {
    return;
  }
  const presentation = desktopPresentation();
  if (!presentation) {
    desktopHost.stop().catch((error) => {
      console.error("角色画布停止失败：", error?.message ?? error);
    });
    return;
  }
  desktopHost.start(presentation);
}

function pushSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed() || !onboardingService || !companionship) {
    return;
  }
  const snapshot = snapshotForRenderer();
  if (snapshot.state !== "accepted") {
    return;
  }
  mainWindow.webContents.send("bayper:snapshot-updated", snapshot);
}

function snapshotForRenderer() {
  return {
    ...onboardingService.getSnapshot(),
    companionship: companionship.getSnapshot(),
    desktop: desktopHost?.getStatus() ?? { state: "stopped" },
    system: {
      paused: systemLifecycle?.isPaused() ?? systemPaused,
      reasons: systemLifecycle?.reasons() ?? [],
    },
  };
}

/* 管理界面只需展示正文、类别和来源语义；factKey、来源哈希与检索分数不越过 IPC。 */
function memoryEntryForRenderer(entry) {
  return {
    id: entry.id,
    version: entry.version,
    body: entry.body,
    kind: entry.kind,
    trust: entry.trust,
    originCharacterId: entry.originCharacterId,
    derived: entry.derived,
  };
}

function notifyMemoryChanged(affectedCharacters) {
  if (
    !Array.isArray(affectedCharacters) ||
    affectedCharacters.length === 0 ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }
  mainWindow.webContents.send("bayper:memory-changed", { affectedCharacters });
}

function createTray() {
  try {
    tray = createAppTray({
      iconPath: TRAY_ICON_FILE,
      getState: () => ({
        desktopVisible,
        desktopPassthrough,
        desktop: desktopHost?.getStatus() ?? { state: "stopped" },
      }),
      onOpen: showManagementWindow,
      onToggleVisible: () => {
        desktopVisible = !desktopVisible;
        store?.setAppState("desktop_visible", desktopVisible ? "1" : "0");
        syncDesktop();
        tray?.refresh();
        pushSnapshot();
      },
      onTogglePassthrough: (checked) => {
        desktopPassthrough = Boolean(checked);
        store?.setAppState("desktop_passthrough", desktopPassthrough ? "1" : "0");
        syncDesktop();
        tray?.refresh();
      },
      onRestartCanvas: async () => {
        const presentation = desktopPresentation();
        if (!presentation || !desktopHost) {
          return;
        }
        await desktopHost.restart(presentation);
        syncDesktop();
        pushSnapshot();
      },
      onQuit: requestQuit,
    });
  } catch (error) {
    console.error("托盘创建失败：", error?.message ?? error);
  }
}

function handleDesktopStatusChange() {
  if (quitting) {
    return;
  }
  tray?.refresh();
  pushSnapshot();
  ensurePendingRotationCompletion();
}

function handleCanvasAssetError(message) {
  if (quitting) {
    return;
  }
  console.error("角色画布素材错误：", message);
  ensurePendingRotationCompletion();
}

function handleCanvasNodeComplete(node) {
  if (systemPaused || quitting || !rotationPending || activeChat) {
    return;
  }
  if (desktopHost?.hasBoundaryWaiters()) {
    // 用户主动切换/休息正在等待同一节点；用户优先，待办交给该动作清除。
    return;
  }
  try {
    companionship.completeNaturalNode();
    rotationPending = companionship.getSnapshot().pendingRotation;
    syncDesktop();
    pushSnapshot();
    ensurePendingRotationCompletion();
  } catch (error) {
    console.error(`角色节点 ${node} 收束失败：`, error?.message ?? error);
  }
}

function ensurePendingRotationCompletion() {
  if (quitting || systemPaused || activeChat) {
    if (fallbackNodeTimer) {
      clearTimeout(fallbackNodeTimer);
      fallbackNodeTimer = null;
    }
    return;
  }
  if (!rotationPending) {
    if (fallbackNodeTimer) {
      clearTimeout(fallbackNodeTimer);
      fallbackNodeTimer = null;
    }
    return;
  }
  const status = desktopHost?.getStatus();
  const canWaitForNode = status?.state === "running" && status.assetState === "ready";
  if (canWaitForNode) {
    if (fallbackNodeTimer) {
      clearTimeout(fallbackNodeTimer);
      fallbackNodeTimer = null;
    }
    return;
  }
  const starting = status?.state === "starting" || status?.state === "restarting";
  const delay = starting ? 9000 : FALLBACK_NODE_MS;
  if (fallbackNodeTimer) {
    if (fallbackNodeTimer.delay === delay) {
      return;
    }
    clearTimeout(fallbackNodeTimer);
    fallbackNodeTimer = null;
  }
  fallbackNodeTimer = setTimeout(() => {
    fallbackNodeTimer = null;
    if (!rotationPending || systemPaused || quitting) {
      return;
    }
    try {
      companionship.completeNaturalNode();
      rotationPending = companionship.getSnapshot().pendingRotation;
      syncDesktop();
      pushSnapshot();
      ensurePendingRotationCompletion();
    } catch (error) {
      console.error("角色画布不可用时的节点收束失败：", error?.message ?? error);
    }
  }, delay);
  fallbackNodeTimer.delay = delay;
}

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    if (systemPaused || quitting || !companionship) {
      return;
    }
    try {
      const snapshot = companionship.getSnapshot();
      if (!activeChat) {
        const rotation = companionship.requestAutoRotation();
        rotationPending = rotation.pending === true || snapshot.pendingRotation === true;
      } else {
        rotationPending = snapshot.pendingRotation === true;
      }
      ensurePendingRotationCompletion();
      syncDesktop();
      pushSnapshot();
      tray?.refresh();
    } catch (error) {
      console.error("陪伴心跳失败：", error?.message ?? error);
    }
  }, HEARTBEAT_MS);
}

function pauseForSystem() {
  if (systemPaused || quitting || !companionship) {
    return;
  }
  systemPaused = true;
  if (fallbackNodeTimer) {
    clearTimeout(fallbackNodeTimer);
    fallbackNodeTimer = null;
  }
  try {
    closeActiveChat({ refresh: false, notifyRenderer: true });
    companionship.markClosed();
    pushSnapshot();
  } catch (error) {
    console.error("系统暂停结算失败：", error?.message ?? error);
  }
}

function resumeFromSystem() {
  if (!systemPaused || quitting || !companionship) {
    return;
  }
  systemPaused = false;
  try {
    companionship.resumeAfterPause();
    rotationPending = companionship.getSnapshot().pendingRotation;
    syncDesktop();
    ensurePendingRotationCompletion();
    pushSnapshot();
    tray?.refresh();
  } catch (error) {
    console.error("系统恢复结算失败：", error?.message ?? error);
  }
}

async function waitForPresentationBoundary() {
  if (systemPaused || !desktopHost) {
    return;
  }
  const presentation = desktopPresentation();
  if (!presentation || presentation.assetState !== "ready") {
    return;
  }
  const result = await desktopHost.waitForNodeBoundary(boundaryTimeoutFor(presentation));
  assertBoundaryCompleted(result);
}

function acceptedCompanions() {
  return companionship?.getSnapshot().characters ?? [];
}

/* 管理窗、系统暂停与退出共用的聊天收尾：取消在途、关闭会话、结束陪伴互动。
   普通关闭必须在持久状态收尾成功后才清 activeChat；失败保留协调状态并返回错误。
   退出可 bestEffort，由下一次启动的互动恢复兜底。 */
function closeActiveChat({
  refresh = true,
  notifyRenderer = false,
  bestEffort = false,
} = {}) {
  const current = activeChat;
  if (!current) {
    return { closed: false };
  }
  let conversationError = null;
  let interactionError = null;
  if (current.conversationId && store) {
    try {
      store.chat.closeConversation({
        characterId: current.characterId,
        conversationId: current.conversationId,
      });
    } catch (error) {
      conversationError = error;
      console.error("关闭聊天会话失败：", error?.message ?? error);
    }
  }
  if ((!conversationError || bestEffort) && companionship) {
    try {
      companionship.endInteraction();
      rotationPending = companionship.getSnapshot().pendingRotation;
    } catch (error) {
      interactionError = error;
      console.error("结束聊天互动失败：", error?.message ?? error);
    }
  }
  if ((conversationError || interactionError) && !bestEffort) {
    throw new AppError("CHAT_CLOSE_FAILED", "聊天没有完全关闭，请重试。");
  }
  activeChat = null;
  const degraded = Boolean(conversationError || interactionError);
  if (
    !degraded &&
    notifyRenderer &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send("bayper:chat-closed", {
      characterId: current.characterId,
      conversationId: current.conversationId,
    });
  }
  if (refresh && !quitting && !degraded) {
    syncDesktop();
    pushSnapshot();
    ensurePendingRotationCompletion();
    tray?.refresh();
  }
  return {
    closed: true,
    characterId: current.characterId,
    conversationId: current.conversationId,
    degraded,
  };
}

function startChat(characterId) {
  if (systemPaused) {
    throw new AppError("SYSTEM_PAUSED", "系统暂停中，暂时不能开始聊天。");
  }
  const character = acceptedCompanions().find((item) => item.characterId === characterId);
  if (!character) {
    throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
  }
  const history = store.chat.listConversations({ characterId, limit: 10 });
  closeActiveChat({ refresh: false });
  const interaction = companionship.startInteraction(characterId);
  activeChat = { characterId, conversationId: null, requestId: null };
  syncDesktop();
  pushSnapshot();
  return {
    characterId,
    displayName: character.displayName,
    interaction,
    history,
  };
}

function ensureChatConversation() {
  if (!activeChat) {
    throw new AppError("CHAT_NOT_OPEN", "聊天面板没有打开。");
  }
  if (!activeChat.conversationId) {
    const created = store.chat.openConversation({ characterId: activeChat.characterId });
    activeChat.conversationId = created.conversation.id;
  }
  return activeChat;
}

async function sendChatMessage({ characterId, text, requestId } = {}) {
  if (!activeChat || activeChat.characterId !== characterId) {
    throw new AppError("CHAT_NOT_OPEN", "聊天面板没有打开或角色已切换。");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new AppError("INVALID_INPUT", "消息不能为空。");
  }
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new AppError("INVALID_INPUT", "请求ID无效。");
  }
  const chat = ensureChatConversation();
  chat.requestId = requestId;
  let result;
  try {
    result = await store.chat.sendMessage({
      characterId,
      conversationId: chat.conversationId,
      text,
      requestId,
    });
  } catch (error) {
    if (activeChat === chat) {
      chat.requestId = null;
    }
    throw error;
  }
  if (activeChat === chat) {
    chat.requestId = result.status === "failed" ? requestId : null;
  }
  return result;
}

function cancelChatMessage({ characterId, requestId } = {}) {
  if (!activeChat || activeChat.characterId !== characterId || activeChat.requestId !== requestId) {
    throw new AppError("REQUEST_NOT_FOUND", "没有可取消的聊天请求。");
  }
  return store.chat.cancelRequest({ characterId, requestId });
}

async function retryChatMessage({ characterId, requestId } = {}) {
  if (!activeChat || activeChat.characterId !== characterId || activeChat.requestId !== requestId) {
    throw new AppError("REQUEST_NOT_FOUND", "没有可重试的聊天请求。");
  }
  const chat = activeChat;
  let result;
  try {
    result = await store.chat.retryRequest({ characterId, requestId });
  } catch (error) {
    if (activeChat === chat) {
      chat.requestId = requestId;
    }
    throw error;
  }
  if (activeChat === chat) {
    chat.requestId = result.status === "failed" ? requestId : null;
  }
  return result;
}

function registerIpcHandlers() {
  ipcMain.handle("bayper:snapshot", (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:model:validate-and-save", async (event, input) => {
    try {
      assertTrustedSender(event);
      const snapshot = await onboardingService.validateAndSaveModel(input);
      return { ok: true, snapshot };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:wish:recommend", (event, wish) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...onboardingService.recommend(wish) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:character:accept", (event, characterId) => {
    try {
      assertTrustedSender(event);
      const result = onboardingService.accept(characterId);
      companionship.start();
      syncDesktop();
      pushSnapshot();
      return { ok: true, ...result, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:model:check-stored", async (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...(await onboardingService.checkStoredModel()) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:system-status", (event) => {
    try {
      assertTrustedSender(event);
      return {
        ok: true,
        paused: systemLifecycle?.isPaused() ?? systemPaused,
        reasons: systemLifecycle?.reasons() ?? [],
      };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:nickname", (event, characterId, nickname) => {
    try {
      assertTrustedSender(event);
      const result = companionship.setNickname(characterId, nickname);
      syncDesktop();
      pushSnapshot();
      return { ok: true, ...result, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:fixed", (event, characterId) => {
    try {
      assertTrustedSender(event);
      const result = companionship.setFixed(characterId);
      pushSnapshot();
      return { ok: true, ...result, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:switch", async (event, characterId) => {
    try {
      assertTrustedSender(event);
      await waitForPresentationBoundary();
      const result = companionship.switchTo(characterId);
      rotationPending = false;
      syncDesktop();
      pushSnapshot();
      return { ok: true, ...result, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:rest", async (event) => {
    try {
      assertTrustedSender(event);
      await waitForPresentationBoundary();
      const result = companionship.rest();
      rotationPending = false;
      syncDesktop();
      pushSnapshot();
      return { ok: true, ...result, snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:list", (event, payload) => {
    try {
      assertTrustedSender(event);
      const page = store.memory.listMemoriesPage(payload?.characterId, {
        page: payload?.page,
      });
      return {
        ok: true,
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.hasMore,
        entries: page.entries.map(memoryEntryForRenderer),
      };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:correct", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.correct({
        characterId: payload?.characterId,
        entryId: payload?.entryId,
        expectedVersion: payload?.expectedVersion,
        body: payload?.body,
      });
      notifyMemoryChanged(result.affectedCharacters);
      return { ok: true, ...result };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:forget", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.forget({
        characterId: payload?.characterId,
        entryId: payload?.entryId,
        expectedVersion: payload?.expectedVersion,
        scope: payload?.scope,
      });
      notifyMemoryChanged(result.affectedCharacters);
      return { ok: true, ...result };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:open", (event, characterId) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...startChat(characterId), snapshot: snapshotForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:conversation", (event, characterId, conversationId) => {
    try {
      assertTrustedSender(event);
      return {
        ok: true,
        ...store.chat.getConversation({ characterId, conversationId }),
      };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:send", async (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = await sendChatMessage(payload);
      return { ok: true, result };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:cancel", (event, payload) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...cancelChatMessage(payload) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:retry", async (event, payload) => {
    try {
      assertTrustedSender(event);
      return { ok: true, result: await retryChatMessage(payload) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:chat:close", (event) => {
    try {
      assertTrustedSender(event);
      return {
        ok: true,
        ...closeActiveChat(),
        snapshot: snapshotForRenderer(),
      };
    } catch (error) {
      return failureResult(error);
    }
  });
}

function requestQuit() {
  if (quitting) {
    return;
  }
  quitting = true;
  app.quit();
}

function handleBeforeQuit(event) {
  quitting = true;
  if (cleanupFinished) {
    return;
  }
  event.preventDefault();
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  cleanup().finally(() => {
    cleanupFinished = true;
    app.quit();
  });
}

async function cleanup() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (fallbackNodeTimer) {
    clearTimeout(fallbackNodeTimer);
    fallbackNodeTimer = null;
  }
  if (systemLifecycle) {
    systemLifecycle.unbind();
    systemLifecycle = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  closeActiveChat({ refresh: false, bestEffort: true });
  if (companionship) {
    try {
      companionship.markClosed();
    } catch (error) {
      console.error("退出时结算失败：", error?.message ?? error);
    }
    companionship = null;
  }
  if (desktopHost) {
    await desktopHost.stop();
    desktopHost = null;
  }
  if (store) {
    try {
      await store.chat.dispose();
    } catch (error) {
      console.error("退出时结束聊天请求失败：", error?.message ?? error);
    }
    store.close();
    store = null;
  }
}
