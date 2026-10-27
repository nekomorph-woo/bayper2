/* Bayper 主进程：业务数据、普通管理窗口、托盘、角色画布宿主与低频生命周期。 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  session,
  powerMonitor,
  clipboard,
} = require("electron");
const { AppError, toPublicError } = require("./errors.cjs");
const { MemoryError } = require("./memory.cjs");
const { createStore } = require("./store.cjs");
const { createHerdrRuntime } = require("./herdr-runtime.cjs");
const { createOnboardingService, readStoredModelCredentials } = require("./onboarding.cjs");
const { createCompanionshipService } = require("./companionship.cjs");
const { createDesktopHost } = require("./desktop-host.cjs");
const { createSourceSettings, buildDefaultSourceCandidates } = require("./source-settings.cjs");
const { createSourceAutomation } = require("./source-automation.cjs");
const { createActivityRuntime } = require("./activity-runtime.cjs");
const { createStoryRuntime } = require("./story-runtime.cjs");
const { createStoryWindow } = require("./story-window.cjs");
const { createAutomaticOpportunities } = require("./automatic-opportunities.cjs");
const { buildDesktopPresentation, getActivitySupport } = require("./desktop-assets.cjs");
const { createAppTray } = require("./app-tray.cjs");
const { createSystemLifecycle } = require("./system-lifecycle.cjs");
const {
  boundaryTimeoutFor,
  assertBoundaryCompleted,
} = require("./presence-boundary.cjs");
const characterContent = require("./content/characters.json");
const authoredStories = require("./content/maid-stories.json");

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
const NOTIFICATION_TICK_MS = Math.max(50, Number(process.env.BAYPER_NOTIFICATION_TICK_MS) || 100);
const FALLBACK_NODE_MS = 2500;
const CONNECTOR_REGISTRY_DIR_NAME = "herdr-registry";

let mainWindow = null;
let store = null;
let onboardingService = null;
let companionship = null;
let sourceSettings = null;
let sourceAutomation = null;
let activityRuntime = null;
let storyRuntime = null;
let storyWindow = null;
let storyViewSeq = 0;
let storyView = null;
let automaticOpportunities = null;
let desktopHost = null;
let tray = null;
let heartbeatTimer = null;
let fallbackNodeTimer = null;
let systemLifecycle = null;
let rotationPending = false;
let systemPaused = false;
let desktopVisible = true;
let desktopPassthrough = false;
let desktopReady = false;
let cleanupStarted = false;
let cleanupFinished = false;
let quitting = false;
let activeChat = null;
// 阶段 2 事件可能早于 sendChatMessage 的 IPC 返回；先缓存，等阶段 1 返回后再发。
const pendingChatUpdates = new Map();
const chatUpdateReady = new Set();
let connectorRuntime = null;
let connectorRegistryDir = null;
let lastConnectorSignature = null;
let notificationTimer = null;
// 休息代次 token 只在进入休息或休息中换角色时递增；重复 desktopPresentation
// 调用不得刷新，避免把尚未播完的过渡误当成已收束。
let restEpisode = { token: 0, characterId: null, active: false };

function restTokenFor(characterId, resting) {
  if (!resting) {
    restEpisode.active = false;
    restEpisode.characterId = null;
    return 0;
  }
  if (!restEpisode.active || restEpisode.characterId !== characterId) {
    restEpisode.token += 1;
    restEpisode.active = true;
    restEpisode.characterId = characterId;
  }
  return restEpisode.token;
}

function readDataDir(argv) {
  const inline = argv.find((arg) => arg.startsWith("--data-dir="));
  if (inline) {
    return inline.slice("--data-dir=".length);
  }
  const index = argv.indexOf("--data-dir");
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

/* 仅验收夹具使用显式目录；正常启动始终读取正式作者目录，且不修改其发布标记。 */
function readStoryCatalog(argv) {
  const prefix = "--story-catalog=";
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (!inline) {
    return null;
  }
  const file = inline.slice(prefix.length);
  if (!file) {
    throw new AppError("STORY_CATALOG_INVALID", "故事目录路径为空。");
  }
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    throw new AppError("STORY_CATALOG_INVALID", "故事目录读取失败。");
  }
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

  const sourceCandidates = buildDefaultSourceCandidates({
    homeDir: os.homedir(),
    env: process.env,
  });
  const storyCatalog = readStoryCatalog(process.argv) ?? authoredStories;
  store = createStore(app.getPath("userData"), {
    storyCatalog,
    sources: { candidates: sourceCandidates },
    sourceAnalysis: {
      getCredentials: () => readStoredModelCredentials({ store, safeStorage }),
      isEligible: (characterId) => sourceAutomation?.isEligible(characterId) ?? false,
    },
    chat: {
      // 只在应用启动边界恢复崩溃遗留请求；凭据按请求从安全存储解密。
      recoverInterrupted: true,
      onVerificationSettled: handleChatVerificationSettled,
      getCredentials: () => readStoredModelCredentials({ store, safeStorage }),
    },
  });
  connectorRegistryDir = path.join(app.getPath("userData"), CONNECTOR_REGISTRY_DIR_NAME);
  connectorRuntime = createHerdrRuntime({
    registryDir: connectorRegistryDir,
    ledger: store.connectorLedger,
    onStateChange: handleConnectorStateChange,
  });
  desktopVisible = store.getAppState("desktop_visible") !== "0";
  desktopPassthrough = store.getAppState("desktop_passthrough") === "1";
  sourceSettings = createSourceSettings({
    permissions: store.externalSources,
    candidates: sourceCandidates,
    dialog,
    getWindow: () => mainWindow,
    isRequestActive: () =>
      !quitting &&
      Boolean(mainWindow) &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible(),
    onAccessChanged: () => sourceAutomation?.cancelActive(),
  });

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

  sourceAutomation = createSourceAutomation({
    store,
    companionship,
    permissions: store.externalSources,
    reader: store.sessionSources,
    analysis: store.sourceAnalysis,
    isBlocked: () => Boolean(activeChat) || systemPaused || quitting,
    isModelConfigured: () => Boolean(store.getModelConfig()),
  });

  activityRuntime = createActivityRuntime({
    store,
    companionship,
    sourceAutomation,
    isDesktopReady: () => {
      if (!desktopVisible) {
        return false;
      }
      const status = desktopHost?.getStatus();
      return status?.state === "running" && status.assetState === "ready";
    },
    activitySupport: (characterId, kind) => getActivitySupport(characterId, kind),
    isBlocked: () => Boolean(activeChat) || systemPaused || quitting,
  });

  // S06i 只消费已完成活动并保存作者故事；S03j 在同一事务内做定向主题分享。
  storyRuntime = createStoryRuntime({
    db: store.db,
    store,
    storyProgress: store.storyProgress,
    discoveryOutcomes: store.discoveryOutcomes,
    themeMemorySharing: store.themeMemorySharing,
    // 快照会写库并在内部开启事务，必须在故事事务外读取；
    // 用户聊天、系统暂停/锁屏/休眠或退出期间直接标记阻断。
    getShareContext: () => {
      if (activeChat || systemPaused || quitting) {
        return { blocked: true, snapshot: null };
      }
      return { blocked: false, snapshot: companionship.getSnapshot() };
    },
  });

  // S06j 故事回看与正式故事进度共用同一目录和 SQLite 连接，只读生成展示数据。
  storyWindow = createStoryWindow({
    db: store.db,
    storyProgress: store.storyProgress,
    discoveryOutcomes: store.discoveryOutcomes,
    catalog: storyCatalog,
    characterNames: Object.fromEntries(
      characterContent.candidates.map((candidate) => [candidate.id, candidate.name]),
    ),
  });

  automaticOpportunities = createAutomaticOpportunities({
    store,
    companionship,
    now: () => Date.now(),
    random: () => Math.random(),
    runActivity: (payload) => activityRuntime.runActivity(payload),
    cancelActivity: () => {
      sourceAutomation?.cancelActive();
    },
  });

  desktopHost = createDesktopHost({
    dataDir: app.getPath("userData"),
    onNodeComplete: handleCanvasNodeComplete,
    onActivityProgress: handleCanvasActivityProgress,
    onAssetError: handleCanvasAssetError,
    onPositionChange: persistDesktopPosition,
    onStatusChange: handleDesktopStatusChange,
    onNotificationAck: handleNotificationAck,
    onNotificationClose: handleNotificationClose,
    onNotificationVisibilityChange: handleNotificationWindowVisibility,
  });

  systemLifecycle = createSystemLifecycle(powerMonitor, {
    onPause: pauseForSystem,
    onResume: resumeFromSystem,
  });

  registerIpcHandlers();
  connectorRuntime.start().catch((error) => {
    console.error("连接器运行管理启动失败：", error?.message ?? error);
  });
  mainWindow = createManagementWindow();
  createTray();
  syncDesktop();
  startNotificationTicker();
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
  const activity = companion.current.activity ?? null;
  // 休息意图只属于稳定同屏角色：A 本人聊天时仍保持坐姿，临时聊天角色 B
  // 不继承 A 的姿势；current_mode 在互动期间仍是稳定角色的持久意图。
  const resting =
    companion.current.mode === "resting"
    || (store?.getAppState("current_mode") === "resting"
      && companion.current.characterId === store?.getAppState("current_character_id"));
  const restToken = restTokenFor(companion.current.characterId, resting);
  return {
    character: built.character,
    animations: built.animations,
    assetState: built.assetState,
    assetNote: built.assetNote,
    assetLabel: built.assetLabel,
    mode: companion.current.mode,
    resting,
    restToken,
    activity,
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
    // 角色消失时通知仍可能需要可见位置；由宿主决定是否保留子进程。
    desktopHost.stopRole();
    return;
  }
  desktopHost.start(presentation);
}

/* 气泡只拿短来源标识、Agent 与状态语义；完整实例 ID、账本诊断和
   连接内容不越过子进程边界。 */
function shortSourceLabel(item) {
  const label = item.sourceLabel ?? item.instanceId ?? "";
  return label.length > 12 ? label.slice(-8) : label;
}

function notificationPayload(view) {
  return {
    generation: view.generation,
    presentations: view.presentations.map((presentation) => ({
      presentationId: presentation.presentationId,
      channel: presentation.channel,
      slot: presentation.slot,
      state: presentation.state,
      createdAt: presentation.createdAt,
      items: presentation.items.map((item) => ({
        eventId: item.eventId,
        source: shortSourceLabel(item),
        agent: item.agentLabel,
        phrase: item.phrase,
        historical: item.historical === true,
        priority: item.priority,
        state: item.state,
        currentState: item.currentState,
        recovered: item.recovered === true,
        acknowledgedAt: item.acknowledgedAt,
        holdUntil: item.holdUntil,
        receivedAt: item.receivedAt,
      })),
    })),
  };
}

function tickNotifications() {
  if (quitting || systemPaused || !store || !desktopHost) {
    return;
  }
  try {
    const view = store.notificationPresentation.tick();
    desktopHost.updateNotifications(notificationPayload(view), true);
  } catch (error) {
    console.error("通知呈现推进失败：", error?.message ?? error);
  }
}

function startNotificationTicker() {
  if (notificationTimer) {
    clearInterval(notificationTimer);
  }
  notificationTimer = setInterval(tickNotifications, NOTIFICATION_TICK_MS);
  tickNotifications();
}

/* 回执已经过子进程身份、presentationId、代次与事件归属校验；
   这里再交给正式服务校验并原子标记 presented。 */
function handleNotificationAck({ presentationId, eventIds } = {}) {
  if (quitting || systemPaused || !store || !presentationId || !Array.isArray(eventIds)) {
    return false;
  }
  try {
    store.notificationPresentation.acknowledge({ presentationId, eventIds });
    return true;
  } catch (error) {
    console.error("通知回执未被接受：", error?.message ?? error);
    return false;
  }
}

/* 子进程重建/隐藏期间冻结阅读时间；窗口重新可见后顺延剩余 hold 再推进。 */
function handleNotificationWindowVisibility(visible) {
  if (quitting || !store) return;
  const notification = store.notificationPresentation;
  try {
    // 暂停期间任何迟到的 shown(true) 都不能解除阅读冻结；由恢复流程统一 resume。
    if (systemPaused) {
      notification.pause();
      return;
    }
    if (visible) {
      notification.resume();
      tickNotifications();
      return;
    }
    if (notification.getView().presentations.length > 0) notification.pause();
  } catch (error) {
    console.error("通知可见性结算失败：", error?.message ?? error);
  }
}

function handleNotificationClose({ presentationId } = {}) {
  if (quitting || !store || !presentationId) {
    return;
  }
  try {
    store.notificationPresentation.closePresentation({ presentationId, reason: "USER_CLOSED" });
  } catch (error) {
    console.error("收起通知失败：", error?.message ?? error);
    return;
  }
  tickNotifications();
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

function connectorStatus(instance) {
  if (instance.disabled) return "disabled";
  /* 登记消失或端点暂不可验证只代表当前连接不可确认，不能冒充 server 已停止。 */
  if (instance.stopped) return "offline";
  if (instance.online && instance.registered) return "online";
  return "reconnecting";
}

/* renderer 只拿到可展示状态与停用/恢复所需的稳定实例标识；
   socket 元数据、runId、账本诊断和任何连接内容都不越过 IPC。 */
function connectorStateForRenderer() {
  const state = connectorRuntime?.getState() ?? null;
  return {
    registryPath: connectorRegistryDir,
    registryFound: state?.registry?.found === true,
    diagnosticCount: (state?.diagnostics ?? [])
      .filter((item) => item.source === "registry").length,
    instances: (state?.instances ?? []).map((instance) => ({
      instanceId: instance.instanceId,
      shortId: instance.instanceId.slice(-8),
      source: "Herdr",
      status: connectorStatus(instance),
      agents: instance.agents.map((agent) => ({
        agentId: agent.agentId,
        label: agent.label ?? agent.agentId,
        state: agent.effectiveState,
      })),
    })),
  };
}

function handleConnectorStateChange() {
  if (quitting || !connectorRuntime) return;
  const state = connectorStateForRenderer();
  const signature = JSON.stringify(state);
  if (signature === lastConnectorSignature) return;
  lastConnectorSignature = signature;
  pushSnapshot();
}

function assertConnectorInstanceId(value) {
  if (typeof value !== "string" || !/^inst-[0-9a-f]{32}$/.test(value)) {
    throw new AppError("INVALID_INPUT", "连接实例标识无效。");
  }
  return value;
}

function snapshotForRenderer() {
  return {
    ...onboardingService.getSnapshot(),
    companionship: companionship.getSnapshot(),
    desktop: desktopHost?.getStatus() ?? { state: "stopped" },
    connectors: connectorStateForRenderer(),
    system: {
      paused: systemLifecycle?.isPaused() ?? systemPaused,
      reasons: systemLifecycle?.reasons() ?? [],
    },
  };
}

/* 故事详情是用户主动进入的动作：成熟且可用时才准备同一故事的邀请。
   准备不写 displayed_at 或 quota_at；实际可见由 renderer 单独回执。 */
function storyDetailForRenderer(storyId) {
  const story = storyWindow.getStory(storyId);
  let preparation = null;
  if (
    story.type === "character" &&
    story.progressStatus === "mature" &&
    story.available
  ) {
    preparation = store.discoveryOutcomes.prepareInvitation({
      storyId: story.storyId,
      source: "manual",
    });
  }
  const invitation = store.discoveryOutcomes.getInvitationByStory({
    storyId: story.storyId,
  });
  // 当前管理窗只认最后一次取到的故事详情；切页或换详情后旧回执不能确认展示。
  const viewToken = `story-view-${++storyViewSeq}`;
  storyView = { token: viewToken, storyId: story.storyId };
  return {
    story,
    invitation,
    otherInvitation:
      preparation?.invitation &&
      preparation.invitation.storyId !== story.storyId
        ? preparation.invitation
        : null,
    preparation: preparation
      ? {
          prepared: preparation.prepared === true,
          duplicate: preparation.duplicate === true,
          reason: preparation.reason ?? null,
        }
      : null,
    viewToken,
  };
}

function assertManagementWindowVisible() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized()
  ) {
    throw new AppError("INVITATION_NOT_VISIBLE", "管理窗当前不可见，邀请仍会保留。");
  }
}

/* renderer 只能在邀请实际绘制并进入局部视口后回执；主进程用最后一次详情
   身份核对 storyId/invitationId，切页或换详情后旧回执一律拒绝。 */
function assertStoryViewReceipt(payload) {
  if (payload?.visible !== true) {
    throw new AppError("INVITATION_NOT_VISIBLE", "邀请没有形成可见回执。");
  }
  if (
    !storyView ||
    payload.viewToken !== storyView.token ||
    payload.storyId !== storyView.storyId
  ) {
    throw new AppError("STORY_VIEW_STALE", "当前故事详情已切换。");
  }
  const invitation = store.discoveryOutcomes.getInvitationByStory({
    storyId: payload.storyId,
  });
  if (!invitation || invitation.invitationId !== payload.invitationId) {
    throw new AppError("STORY_VIEW_STALE", "当前故事详情没有这份邀请。");
  }
  return invitation;
}

function runStoryInvitationAction(method, invitationId, refreshSnapshot = false) {
  const result = store.discoveryOutcomes[method]({ invitationId });
  if (!refreshSnapshot) {
    return result;
  }
  pushSnapshot();
  return { ...result, snapshot: snapshotForRenderer() };
}

/* 管理界面只需展示正文、类别、来源语义与分享限制；factKey、来源哈希与检索分数不越过 IPC。 */
function memoryEntryForRenderer(entry) {
  return {
    id: entry.id,
    version: entry.version,
    body: entry.body,
    kind: entry.kind,
    trust: entry.trust,
    sourceKind: entry.sourceKind ?? "user",
    originCharacterId: entry.originCharacterId,
    narratorCharacterId: entry.narratorCharacterId ?? null,
    derived: entry.derived,
    sharingRestricted: entry.sharingRestricted === true,
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
        if (desktopVisible) {
          activityRuntime?.handleDesktopReady();
        } else {
          activityRuntime?.handleDesktopUnavailable();
        }
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

function handleDesktopStatusChange(status = desktopHost?.getStatus()) {
  if (quitting) {
    return;
  }
  const ready = status?.state === "running" && status?.assetState === "ready";
  if (status?.state === "failed" || status?.assetState === "error") {
    desktopReady = false;
    activityRuntime?.handleDesktopUnavailable();
  } else if (ready && !desktopReady) {
    // 只在画布重新可用时扫描持久暂停事实，几何变化不重复恢复。
    desktopReady = true;
    activityRuntime?.handleDesktopReady();
  } else {
    desktopReady = ready;
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
  desktopReady = false;
  activityRuntime?.handleDesktopUnavailable();
  ensurePendingRotationCompletion();
  pushSnapshot();
}

/* 故事运行只读取已完成活动；失败只记录，不影响陪伴心跳与角色画布。 */
function runStoryRuntime() {
  if (!storyRuntime || quitting) {
    return [];
  }
  try {
    return storyRuntime.evaluate();
  } catch (error) {
    console.error("故事进度评估失败：", error?.message ?? error);
    return [];
  }
}

function handleCanvasNodeComplete(node, message = {}) {
  if (quitting) {
    return;
  }
  // 休息坐下/起身节点只表示真实播放收束，不参与日常/轮换的自然节点结算。
  if (node === "rest-settled" || node === "rest-stand") {
    return;
  }
  // 真实播放完成是已经发生的事实；即使此时因锁屏/聊天刚暂停，也要记录，
  // 否则恢复后既不会再播完也不会收束，活动会卡住。
  if (node === "daily-action-complete") {
    try {
      const activityId = typeof message?.activityId === "string" ? message.activityId : "";
      const characterId = typeof message?.characterId === "string" ? message.characterId : "";
      if (activityId && characterId) {
        companionship.completeDailyAction(activityId, { characterId });
        syncDesktop();
        pushSnapshot();
      }
    } catch (error) {
      console.error("日常动作完成记录失败：", error?.message ?? error);
    }
    return;
  }
  if (systemPaused || activeChat) {
    return;
  }
  if (desktopHost?.hasBoundaryWaiters()) {
    // 用户主动切换/休息正在等待同一节点；用户优先，待办交给该动作清除。
    return;
  }
  try {
    if (
      !rotationPending &&
      companionship.hasScheduledActivity?.() !== true &&
      companionship.hasRunningDaily?.() !== true
    ) {
      return;
    }
    companionship.completeNaturalNode();
    rotationPending = companionship.getSnapshot().pendingRotation;
    runStoryRuntime();
    syncDesktop();
    pushSnapshot();
    ensurePendingRotationCompletion();
  } catch (error) {
    console.error(`角色节点 ${node} 收束失败：`, error?.message ?? error);
  }
}

/* 画布逐帧上报的真实播放进度；只按活动 ID 记录已完成帧数。 */
function handleCanvasActivityProgress({ activityId, characterId, progress } = {}) {
  if (quitting) {
    return;
  }
  try {
    if (typeof activityId !== "string" || typeof characterId !== "string") {
      return;
    }
    companionship.recordDailyActionProgress(activityId, progress, { characterId });
  } catch (error) {
    console.error("日常动作进度记录失败：", error?.message ?? error);
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
      runStoryRuntime();
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
      runStoryRuntime();
      ensurePendingRotationCompletion();
      syncDesktop();
      pushSnapshot();
      tray?.refresh();
      automaticOpportunities
        ?.evaluate()
        .then(() => {
          if (!quitting) {
            syncDesktop();
            pushSnapshot();
          }
        })
        .catch((error) => {
          console.error("自动机会执行失败：", error?.message ?? error);
        });
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
  automaticOpportunities?.pause();
  if (fallbackNodeTimer) {
    clearTimeout(fallbackNodeTimer);
    fallbackNodeTimer = null;
  }
  // 通知隐藏/阅读冻结独立于陪伴结算，任何一侧失败都不能让气泡继续可见或回执。
  try {
    store?.notificationPresentation.pause();
  } catch (error) {
    console.error("暂停通知阅读时间失败：", error?.message ?? error);
  }
  desktopHost?.setNotificationsVisible(false);
  try {
    // 系统暂停保留聊天会话与互动，但取消在途请求；暂停期间的 send/retry 另行拒绝。
    cancelActiveChatRequest();
    companionship.markClosed();
    pushSnapshot();
  } catch (error) {
    console.error("系统暂停结算失败：", error?.message ?? error);
  }
}

/* 只取消当前聊天请求，不关闭会话、不结束互动；复用聊天服务的取消语义。 */
function cancelActiveChatRequest() {
  const chat = activeChat;
  if (!chat?.requestId) {
    return { cancelled: false };
  }
  try {
    return store.chat.cancelRequest({
      characterId: chat.characterId,
      requestId: chat.requestId,
    });
  } catch (error) {
    console.error("系统暂停取消聊天请求失败：", error?.message ?? error);
    return { cancelled: false, error };
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
    if (!activeChat) {
      activityRuntime?.resumePausedActivities();
      automaticOpportunities?.resume();
    }
    syncDesktop();
    ensurePendingRotationCompletion();
    try {
      store?.notificationPresentation.resume();
    } catch (error) {
      console.error("恢复通知阅读时间失败：", error?.message ?? error);
    }
    tickNotifications();
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
  // 有坐姿素材的休息只接受本次 token 的真实坐下完成节点；无 sit 的
  // Hu/Cheng 继续 idle 循环，沿既有自然节点等待，不能等永远不会来的
  // rest-settled。
  if (presentation.resting && presentation.animations?.sit) {
    const restToken = presentation.restToken;
    if (desktopHost.getStatus().restSettledToken === restToken) {
      return;
    }
    const restResult = await desktopHost.waitForNodeBoundary(
      boundaryTimeoutFor(presentation),
      { node: "rest-settled", restToken },
    );
    assertBoundaryCompleted(restResult);
    return;
  }
  const result = await desktopHost.waitForNodeBoundary(boundaryTimeoutFor(presentation));
  assertBoundaryCompleted(result);
}

function acceptedCompanions() {
  return companionship?.getSnapshot().characters ?? [];
}

/* 管理窗与退出共用的聊天收尾：取消在途、关闭会话、结束陪伴互动。
   系统暂停不强制关闭聊天；聊天与锁屏作为独立原因分别解除。
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
  if (current.requestId) {
    pendingChatUpdates.delete(current.requestId);
    chatUpdateReady.delete(current.requestId);
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
  if (refresh && !quitting && !systemPaused && !degraded) {
    activityRuntime?.resumePausedActivities();
    syncDesktop();
    pushSnapshot();
    ensurePendingRotationCompletion();
    automaticOpportunities?.resume();
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
  automaticOpportunities?.pause();
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

function flushChatUpdate(requestId) {
  const payload = pendingChatUpdates.get(requestId);
  if (!payload) {
    // 阶段 2 尚未完成；保留 ready，等待 settled 回调补发。
    return;
  }
  chatUpdateReady.delete(requestId);
  pendingChatUpdates.delete(requestId);
  if (activeChat?.requestId === requestId) {
    activeChat.requestId = null;
  }
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }
  mainWindow.webContents.send("bayper:memory-changed", {
    kind: "chat-updated",
    ...payload,
  });
}

/* 阶段 2 只发一次事件；若 IPC 尚未返回，先缓存，防止 renderer 漏刷新。 */
function handleChatVerificationSettled(payload) {
  if (!payload?.requestId) {
    return;
  }
  pendingChatUpdates.set(payload.requestId, payload);
  if (chatUpdateReady.has(payload.requestId)) {
    setImmediate(() => flushChatUpdate(payload.requestId));
  }
}

async function sendChatMessage({ characterId, text, requestId } = {}) {
  if (systemPaused) {
    throw new AppError("SYSTEM_PAUSED", "系统暂停中，暂时不能发送聊天消息。");
  }
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
    const verificationPending =
      result.status === "completed" && result.verificationStatus === "pending";
    chat.requestId =
      result.status === "failed" || verificationPending ? requestId : null;
    if (verificationPending) {
      chatUpdateReady.add(requestId);
      // 让 IPC 结果先回到 renderer，再发阶段 2 事件；若阶段 2 已先完成，缓存会在下一 tick 补发。
      setImmediate(() => flushChatUpdate(requestId));
    }
  }
  return result;
}

function cancelChatMessage({ characterId, requestId } = {}) {
  if (!activeChat || activeChat.characterId !== characterId || activeChat.requestId !== requestId) {
    throw new AppError("REQUEST_NOT_FOUND", "没有可取消的聊天请求。");
  }
  const result = store.chat.cancelRequest({ characterId, requestId });
  if (result.cancelled && activeChat) {
    activeChat.requestId = null;
  }
  return result;
}

async function retryChatMessage({ characterId, requestId } = {}) {
  if (systemPaused) {
    throw new AppError("SYSTEM_PAUSED", "系统暂停中，暂时不能重试聊天消息。");
  }
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

  ipcMain.handle("bayper:source:state", (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, state: sourceSettings.getState() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:source:set-enabled", (event, enabled) => {
    try {
      assertTrustedSender(event);
      return { ok: true, state: sourceSettings.setEnabled(enabled) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:source:authorize-candidate", async (event, provider) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...(await sourceSettings.authorizeCandidate(provider)) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:source:choose-directory", async (event, provider) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...(await sourceSettings.chooseDirectory(provider)) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:source:revoke", (event, grantId) => {
    try {
      assertTrustedSender(event);
      return { ok: true, state: sourceSettings.revokeDirectory(grantId) };
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

  ipcMain.handle("bayper:story:list", (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, stories: storyWindow.listStories() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:story:detail", (event, storyId) => {
    try {
      assertTrustedSender(event);
      storyView = null;
      return { ok: true, ...storyDetailForRenderer(storyId) };
    } catch (error) {
      return failureResult(error);
    }
  });

  /* 只有管理窗可见且回执匹配最后一次故事详情身份时，才记为 manual 展示。
     source 固定由主进程选择，renderer 不能自行绕过自动邀请额度。 */
  ipcMain.handle("bayper:story:invitation-shown", (event, payload) => {
    try {
      assertTrustedSender(event);
      assertManagementWindowVisible();
      assertStoryViewReceipt(payload);
      return {
        ok: true,
        ...store.discoveryOutcomes.acknowledgeInvitation({
          invitationId: payload.invitationId,
          source: "manual",
        }),
      };
    } catch (error) {
      return failureResult(error);
    }
  });

  // 切页、切分页或换角色时主动失效当前详情身份，晚到的 ACK 不再被接受。
  ipcMain.handle("bayper:story:leave", (event) => {
    try {
      assertTrustedSender(event);
      storyView = null;
      return { ok: true };
    } catch (error) {
      return failureResult(error);
    }
  });

  const storyInvitationAction = (method, refreshSnapshot = false) => (event, invitationId) => {
    try {
      assertTrustedSender(event);
      return {
        ok: true,
        ...runStoryInvitationAction(method, invitationId, refreshSnapshot),
      };
    } catch (error) {
      return failureResult(error);
    }
  };
  ipcMain.handle(
    "bayper:story:invitation-accept",
    storyInvitationAction("acceptInvitation", true),
  );
  ipcMain.handle(
    "bayper:story:invitation-later",
    storyInvitationAction("deferInvitation"),
  );
  ipcMain.handle(
    "bayper:story:invitation-reject",
    storyInvitationAction("rejectInvitation"),
  );
  ipcMain.handle(
    "bayper:story:invitation-reopen",
    storyInvitationAction("reopenInvitation"),
  );

  ipcMain.handle("bayper:connector:set-enabled", async (event, instanceId, enabled) => {
    try {
      assertTrustedSender(event);
      assertConnectorInstanceId(instanceId);
      if (typeof enabled !== "boolean") {
        throw new AppError("INVALID_INPUT", "连接启停状态必须是布尔值。");
      }
      if (!connectorRuntime) {
        throw new AppError("CONNECTOR_UNAVAILABLE", "连接器尚未就绪，请稍后重试。");
      }
      if (enabled) {
        await connectorRuntime.enable(instanceId);
      } else {
        connectorRuntime.disable(instanceId);
      }
      return { ok: true, state: connectorStateForRenderer() };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:connector:copy-registry-path", (event) => {
    try {
      assertTrustedSender(event);
      if (!connectorRegistryDir) {
        throw new AppError("CONNECTOR_UNAVAILABLE", "连接器登记目录尚未就绪。");
      }
      clipboard.writeText(connectorRegistryDir);
      return { ok: true };
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
      if (!systemPaused && !activeChat && !quitting) {
        activityRuntime?.resumePausedActivities();
      }
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

  /* S03i 全局自动分享开关：只允许正式管理窗读取/修改，布尔值由记忆服务核验。
     读取不触发分享；修改只影响 memory.share，明确转告仍走原有 relay 路径。 */
  ipcMain.handle("bayper:memory:auto-share", (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, enabled: store.memory.isAutoShareEnabled() };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:auto-share:set", (event, enabled) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...store.memory.setAutoShareEnabled({ enabled }) };
    } catch (error) {
      return memoryFailureResult(error);
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

  /* 面板“只让所选角色记得”：保留选中角色，清除其他持有者并禁止再次分享。
     保留者与所有被清除角色都要失效旧上下文；factKeyHash 不越过 IPC。 */
  ipcMain.handle("bayper:memory:keep-exclusive", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.keepExclusive({
        characterId: payload?.characterId,
        entryId: payload?.entryId,
        expectedVersion: payload?.expectedVersion,
      });
      notifyMemoryChanged([
        ...new Set([result.retainedCharacterId, ...result.clearedCharacters]),
      ]);
      return {
        ok: true,
        retainedCharacterId: result.retainedCharacterId,
        version: result.version,
        cleared: result.cleared,
        clearedCharacters: result.clearedCharacters,
        alreadyExclusive: result.alreadyExclusive,
        blockedSharing: result.blockedSharing,
      };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  /* 用户明确转告只接收一条、一个已结识接收者；条目归属与版本由记忆服务核对。
     投递成功后接收者上下文失效，沿既有记忆变更事件刷新当前可控旧回复。 */
  ipcMain.handle("bayper:memory:relay", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.relay({
        fromCharacterId: payload?.fromCharacterId,
        toCharacterId: payload?.toCharacterId,
        entries: [
          { entryId: payload?.entryId, expectedVersion: payload?.expectedVersion },
        ],
      });
      if (result.contextVersion !== null) {
        notifyMemoryChanged([result.toCharacterId]);
      }
      return {
        ok: true,
        toCharacterId: result.toCharacterId,
        alreadyHeld: result.shared[0]?.alreadyHeld === true,
      };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:restrict-sharing", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.restrictSharing({
        characterId: payload?.characterId,
        entryId: payload?.entryId,
        expectedVersion: payload?.expectedVersion,
      });
      return { ok: true, alreadyRestricted: result.alreadyRestricted };
    } catch (error) {
      return memoryFailureResult(error);
    }
  });

  ipcMain.handle("bayper:memory:allow-sharing", (event, payload) => {
    try {
      assertTrustedSender(event);
      const result = store.memory.allowSharing({
        characterId: payload?.characterId,
        entryId: payload?.entryId,
        expectedVersion: payload?.expectedVersion,
      });
      return { ok: true, lifted: result.lifted };
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
  if (notificationTimer) {
    clearInterval(notificationTimer);
    notificationTimer = null;
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
  // runtime 的 socket/订阅/定时器必须先于唯一 SQLite 连接释放。
  if (connectorRuntime) {
    try {
      connectorRuntime.dispose();
    } catch (error) {
      console.error("退出时停止连接器运行管理失败：", error?.message ?? error);
    }
    connectorRuntime = null;
  }
  lastConnectorSignature = null;
  closeActiveChat({ refresh: false, bestEffort: true });
  if (automaticOpportunities) {
    try {
      automaticOpportunities.dispose();
    } catch (error) {
      console.error("退出时停止自动机会失败：", error?.message ?? error);
    }
    automaticOpportunities = null;
  }
  if (sourceAutomation) {
    try {
      await sourceAutomation.dispose();
    } catch (error) {
      console.error("退出时结束来源分析失败：", error?.message ?? error);
    }
    sourceAutomation = null;
  }
  if (activityRuntime) {
    activityRuntime.dispose();
    activityRuntime = null;
  }
  storyRuntime = null;
  storyWindow = null;
  storyView = null;
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
  // 进行中的对话框由 source-settings 的请求存活校验阻止退出后落库；
  // 置空只拒绝新的调用，不声称已主动取消已持有的异步调用。
  sourceSettings = null;
  if (store) {
    try {
      await store.chat.dispose();
    } catch (error) {
      console.error("退出时结束聊天请求失败：", error?.message ?? error);
    }
    try {
      // 只关闭未呈现的 offer，不把未看到的通知标成 presented。
      store.notificationPresentation.dispose();
    } catch (error) {
      console.error("退出时释放通知呈现失败：", error?.message ?? error);
    }
    store.close();
    store = null;
  }
}
