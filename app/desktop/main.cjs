/* 正式角色画布子进程。固定 Prohibited 非激活 panel，只做显示与有限输入转发；
   不访问数据库、模型 Key 或记忆。父进程 stdin 关闭时自行退出。 */
const path = require("node:path");
const readline = require("node:readline");
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const { acceptsNotificationIpc } = require("./notification-ipc.cjs");

const profileDir = process.env.BAYPER_DESKTOP_PROFILE;
const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 128, height: 128 });
const NOTIFICATION_WIDTH = 320;
const NOTIFICATION_MIN_HEIGHT = 72;
const NOTIFICATION_MAX_HEIGHT = 520;
if (!profileDir) {
  console.error("缺少 BAYPER_DESKTOP_PROFILE");
  app.quit();
}

let window = null;
let characterWindowReady = false;
let latestState = null;
let dragState = null;
let activationPolicy = "unconfirmed";
let lastReportedBoundsKey = "";

/* 通知气泡由同一个子进程承载但使用独立非激活 panel；最多 3 普通 + 1 加急
   卡片共用一个窗口，窗口只在出现/隐藏/尺寸变化时更新，不随 tick 重建。 */
let notificationWindow = null;
let notificationReady = false;
let latestNotifications = null;
let notificationShownAt = null;
let lastNotificationSize = { width: NOTIFICATION_WIDTH, height: 140 };

app.setName("Bayper Canvas");
if (profileDir) {
  app.setPath("userData", path.resolve(profileDir));
}
// 验收进程可用 DevTools 端口直接观察真实通知窗口 DOM；正式启动不开启。
if (process.env.BAYPER_DESKTOP_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", "0");
}

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // 父进程断开时由 stdin 结束事件负责退出。
  }
}

/* 父进程按 manifest 的共同可见包围计算窗口、图片尺寸与偏移；
   子进程只执行该布局，不重新拟合各帧。 */
function displaySize(plan) {
  if (!plan) {
    return DEFAULT_WINDOW_SIZE;
  }
  return {
    width: Math.max(1, plan.windowWidth),
    height: Math.max(1, plan.windowHeight),
  };
}

function clampPosition(x, y, width, height) {
  const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - width);
  const maxY = Math.max(area.y, area.y + area.height - height);
  return {
    x: Math.min(maxX, Math.max(area.x, Math.round(x))),
    y: Math.min(maxY, Math.max(area.y, Math.round(y))),
  };
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - width - 28,
    y: area.y + area.height - height - 28,
  };
}

function applyPosition(position) {
  if (!window || window.isDestroyed()) {
    return;
  }
  const bounds = window.getBounds();
  const width = bounds.width;
  const height = bounds.height;
  const target = position
    ? clampPosition(position.x, position.y, width, height)
    : defaultPosition(width, height);
  window.setPosition(target.x, target.y, false);
  layoutNotificationWindow();
}

function displayForNotification() {
  if (window && !window.isDestroyed() && window.isVisible()) {
    return screen.getDisplayMatching(window.getBounds());
  }
  return screen.getPrimaryDisplay();
}

/* 气泡贴近角色但不遮挡角色；优先左侧，其次右侧，再上方/下方，
   最终都收敛到同一块工作区内。没有角色窗口时停在主屏右下角。 */
function layoutNotificationWindow() {
  const win = notificationWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  const bounds = win.getBounds();
  const display = displayForNotification();
  const area = display.workArea;
  const width = bounds.width;
  const height = bounds.height;
  const anchor = window && !window.isDestroyed() && window.isVisible()
    ? window.getBounds()
    : null;
  let x;
  let y;
  if (anchor) {
    const gap = 10;
    const left = anchor.x - width - gap;
    const right = anchor.x + anchor.width + gap;
    if (left >= area.x) {
      x = left;
      y = anchor.y;
    } else if (right + width <= area.x + area.width) {
      x = right;
      y = anchor.y;
    } else {
      x = anchor.x + anchor.width - width;
      y = anchor.y - height - gap;
      if (y < area.y) y = anchor.y + anchor.height + gap;
    }
  } else {
    x = area.x + area.width - width - 16;
    y = area.y + area.height - height - 16;
  }
  x = Math.min(area.x + area.width - width, Math.max(area.x, x));
  y = Math.min(area.y + area.height - height, Math.max(area.y, y));
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  if (nextX !== bounds.x || nextY !== bounds.y) {
    win.setPosition(nextX, nextY, false);
    reportNotificationWindow();
  }
}

function reportNotificationWindow() {
  const win = notificationWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  const message = {
    type: "notification-shown",
    visible: win.isVisible(),
    shownAt: notificationShownAt,
    bounds: win.getBounds(),
    windowId: win.id,
    focusable: win.isFocusable(),
    captureId: win.getMediaSourceId(),
  };
  const delayMs = Math.min(5000, Number(process.env.BAYPER_NOTIFICATION_SHOWN_DELAY_MS) || 0);
  if (message.visible && delayMs > 0) setTimeout(() => send(message), delayMs);
  else send(message);
}

/* 通知实际可用的内容高度上限；renderer 用它为三普通位预留空间后分页。 */
function notificationHeightBudget() {
  const area = displayForNotification().workArea;
  const configuredMax = Number(process.env.BAYPER_NOTIFICATION_MAX_HEIGHT)
    || NOTIFICATION_MAX_HEIGHT;
  return Math.max(
    NOTIFICATION_MIN_HEIGHT,
    Math.min(configuredMax, area.height - 16),
  );
}

function applyNotificationSize(height) {
  const win = notificationWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  const area = displayForNotification().workArea;
  const width = Math.max(220, Math.min(NOTIFICATION_WIDTH, area.width - 16));
  const maxHeight = notificationHeightBudget();
  const nextHeight = Math.max(
    NOTIFICATION_MIN_HEIGHT,
    Math.min(maxHeight, Math.round(Number(height) || NOTIFICATION_MIN_HEIGHT)),
  );
  lastNotificationSize = { width, height: nextHeight };
  win.setContentSize(width, nextHeight);
  layoutNotificationWindow();
  reportNotificationWindow();
}

function pushNotificationsToWindow() {
  if (!notificationReady || !notificationWindow || notificationWindow.isDestroyed()) {
    return;
  }
  const view = latestNotifications;
  notificationWindow.webContents.send("notifications:update", {
    token: view?.token ?? null,
    generation: view?.generation ?? null,
    presentations: view?.presentations ?? [],
    heightBudget: notificationHeightBudget(),
  });
}

function hideNotificationWindow() {
  notificationShownAt = null;
  if (notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible()) {
    notificationWindow.hide();
  }
  reportNotificationWindow();
}

function showNotificationWindow() {
  const win = notificationWindow;
  if (!win || win.isDestroyed() || !notificationReady) {
    return;
  }
  if (!win.isVisible()) {
    notificationShownAt = Date.now();
    win.showInactive();
  }
  layoutNotificationWindow();
  reportNotificationWindow();
}

function ensureNotificationWindow() {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    return notificationWindow;
  }
  const win = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: 140,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: "panel",
    webPreferences: {
      preload: path.join(__dirname, "notification-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, "renderer", "notification.html"));
  win.webContents.once("did-finish-load", () => {
    notificationReady = true;
    pushNotificationsToWindow();
    if (latestNotifications?.visible && latestNotifications.presentations.length > 0) {
      applyNotificationSize(lastNotificationSize.height);
      showNotificationWindow();
    }
  });
  win.on("closed", () => {
    notificationWindow = null;
    notificationReady = false;
    notificationShownAt = null;
  });
  notificationWindow = win;
  return win;
}

function applyNotifications(message) {
  latestNotifications = {
    token: message.token,
    generation: message.generation,
    visible: message.visible === true,
    presentations: Array.isArray(message.presentations) ? message.presentations : [],
  };
  // 隐藏时也同步视图 token，避免用户收起/回执沿用过期的窗口代次。
  pushNotificationsToWindow();
  if (!latestNotifications.visible || latestNotifications.presentations.length === 0) {
    hideNotificationWindow();
    return;
  }
  ensureNotificationWindow();
  pushNotificationsToWindow();
  showNotificationWindow();
}

function applyState(state) {
  latestState = state;
  ensureCharacterWindow();
  if (!window || window.isDestroyed() || !characterWindowReady) {
    return;
  }

  const display = state.animations?.display;
  const size = displaySize(display);
  window.setContentSize(size.width, size.height);

  window.webContents.send("canvas:state", {
    character: state.character,
    animations: state.animations,
    assetState: state.assetState,
    assetNote: state.assetNote,
    mode: state.mode,
    activity: state.activity ?? null,
    displayKey: state.displayKey,
  });

  if (state.ignoreMouse === true) {
    window.setIgnoreMouseEvents(true);
  } else {
    window.setIgnoreMouseEvents(false);
  }

  if (state.visible === false) {
    window.hide();
  } else if (!window.isVisible()) {
    window.showInactive();
  }

  if (!dragState) {
    applyPosition(state.position);
  }
  reportBounds();
  layoutNotificationWindow();
}

function ensureCharacterWindow() {
  if (window && !window.isDestroyed()) {
    return window;
  }
  const initialSize = displaySize(latestState?.animations?.display);
  const win = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: "panel",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.once("did-finish-load", () => {
    characterWindowReady = true;
    sendReady();
    if (latestState) {
      applyState(latestState);
    }
  });
  win.on("closed", () => app.quit());
  window = win;
  return win;
}

function handleParentLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (message.type === "state") {
    applyState(message);
    return;
  }
  if (message.type === "notifications") {
    applyNotifications(message);
    return;
  }
  if (message.type === "role-hidden") {
    if (window && !window.isDestroyed()) {
      window.hide();
    }
    layoutNotificationWindow();
    return;
  }
  if (message.type === "notification-ack-result") {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.webContents.send("notifications:ack-result", {
        token: Number.isInteger(message.token) ? message.token : null,
        presentationId: message.presentationId,
        eventIds: Array.isArray(message.eventIds) ? message.eventIds : [],
        accepted: message.accepted === true,
      });
    }
    return;
  }
  if (message.type === "quit") {
    app.quit();
  }
}

function registerIpc() {
  ipcMain.on("canvas:node-complete", (_event, payload) => {
    const node = typeof payload?.node === "string" ? payload.node : "unknown";
    send({
      type: "node-complete",
      node,
      displayKey: typeof payload?.displayKey === "string" ? payload.displayKey : "",
      generation: Number.isInteger(payload?.generation) ? payload.generation : null,
    });
  });
  ipcMain.on("canvas:display-state", (_event, payload) => {
    send({
      type: "display-state",
      kind: payload?.kind === "character" ? "character" : "status",
      displayKey: typeof payload?.displayKey === "string" ? payload.displayKey : "",
      generation: Number.isInteger(payload?.generation) ? payload.generation : null,
      frame: typeof payload?.frame === "string" ? payload.frame : "",
    });
  });
  ipcMain.on("canvas:asset-error", (_event, message) => {
    send({ type: "asset-error", message: String(message || "角色素材加载失败").slice(0, 300) });
  });
  ipcMain.on("canvas:drag-start", (_event, point) => {
    if (!window || !point) {
      return;
    }
    const bounds = window.getBounds();
    dragState = {
      offsetX: bounds.x - Number(point.x),
      offsetY: bounds.y - Number(point.y),
    };
  });
  ipcMain.on("canvas:drag-move", (_event, point) => {
    if (!window || !dragState || !point) {
      return;
    }
    const bounds = window.getBounds();
    const target = clampPosition(
      Number(point.x) + dragState.offsetX,
      Number(point.y) + dragState.offsetY,
      bounds.width,
      bounds.height,
    );
    window.setPosition(target.x, target.y, false);
  });
  ipcMain.on("canvas:drag-end", () => {
    dragState = null;
    if (window) {
      const bounds = window.getBounds();
      send({ type: "position-changed", x: bounds.x, y: bounds.y });
      layoutNotificationWindow();
    }
  });
  ipcMain.on("notifications:ack", (event, payload) => {
    if (!acceptsNotificationIpc({
      sender: event.sender, window: notificationWindow, latest: latestNotifications,
      requireVisible: true,
    }) || payload?.token !== latestNotifications.token) {
      return;
    }
    const eventIds = Array.isArray(payload.eventIds)
      ? payload.eventIds.filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (eventIds.length === 0 || typeof payload.presentationId !== "string") {
      return;
    }
    // token 在收到时固定；延迟转发的旧回执由父进程拒绝后经结果消息重试。
    const message = {
      type: "notification-ack",
      token: latestNotifications.token,
      generation: latestNotifications.generation,
      presentationId: payload.presentationId,
      eventIds,
    };
    const delayMs = Math.min(5000, Number(process.env.BAYPER_NOTIFICATION_ACK_DELAY_MS) || 0);
    const forward = () => {
      if (!acceptsNotificationIpc({
        sender: notificationWindow?.webContents,
        window: notificationWindow,
        latest: latestNotifications,
        requireVisible: true,
      })) {
        return;
      }
      send(message);
    };
    if (delayMs > 0) setTimeout(forward, delayMs);
    else forward();
  });
  ipcMain.on("notifications:visible", (event, payload) => {
    if (!acceptsNotificationIpc({
      sender: event.sender, window: notificationWindow, latest: latestNotifications,
      requireVisible: true,
    }) || typeof payload?.presentationId !== "string") {
      return;
    }
    send({
      type: "notification-visible",
      presentationId: payload.presentationId,
      eventIds: Array.isArray(payload.eventIds)
        ? payload.eventIds.filter((id) => Number.isInteger(id) && id > 0)
        : [],
      complete: payload.complete === true,
    });
  });
  ipcMain.on("notifications:size", (event, payload) => {
    if (!acceptsNotificationIpc({
      sender: event.sender, window: notificationWindow, latest: latestNotifications,
    })) {
      return;
    }
    applyNotificationSize(payload?.height);
  });
  ipcMain.on("notifications:close", (event, payload) => {
    // 收起是用户主动动作，不要求窗口仍可见；只校验当前窗口身份与视图代次。
    if (!acceptsNotificationIpc({
      sender: event.sender, window: notificationWindow, latest: latestNotifications,
    }) || payload?.token !== latestNotifications.token
      || typeof payload.presentationId !== "string") {
      return;
    }
    send({
      type: "notification-close",
      token: latestNotifications.token,
      generation: latestNotifications.generation,
      presentationId: payload.presentationId,
      reason: "USER_CLOSED",
    });
  });
}

function sendReady() {
  if (!window || window.isDestroyed()) {
    return;
  }
  const bounds = window.getBounds();
  lastReportedBoundsKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  send({
    type: "ready",
    pid: process.pid,
    bounds,
    windowType: "panel",
    focusable: window.isFocusable(),
    transparent: true,
    activationPolicy,
  });
}

/* 几何变化只更新 bounds；ready 只表示进程/窗口初始化，不能借它重置
   错误、最后节点或展示身份，也不触发父宿主重发 state。 */
function reportBounds() {
  if (!window || window.isDestroyed()) {
    return;
  }
  const bounds = window.getBounds();
  const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (key === lastReportedBoundsKey) {
    return;
  }
  lastReportedBoundsKey = key;
  send({ type: "bounds", bounds });
}

function reanchorToDisplays() {
  if (!window || window.isDestroyed()) {
    return;
  }
  const bounds = window.getBounds();
  const target = clampPosition(bounds.x, bounds.y, bounds.width, bounds.height);
  if (target.x !== bounds.x || target.y !== bounds.y) {
    window.setPosition(target.x, target.y, false);
    send({ type: "position-changed", x: target.x, y: target.y });
  }
  layoutNotificationWindow();
}

app.whenReady().then(() => {
  try {
    app.dock?.hide();
  } catch {
    // 无 Dock 的环境（测试/非 macOS）忽略。
  }
  try {
    // dock.hide 可能设置 Accessory，随后显式切回 Prohibited。
    app.setActivationPolicy("prohibited");
    activationPolicy = "prohibited";
  } catch {
    activationPolicy = "prohibited-failed";
  }

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  screen.on("display-added", reanchorToDisplays);
  screen.on("display-removed", reanchorToDisplays);
  screen.on("display-metrics-changed", reanchorToDisplays);

  registerIpc();
  // 角色窗口保持既有启动行为；无角色时仅隐藏，不影响通知窗口独立承载。
  ensureCharacterWindow();
  ensureNotificationWindow();

  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", handleParentLine);
  process.stdin.on("end", () => app.quit());
  process.stdin.on("close", () => app.quit());
  process.stdin.resume();

  // 通知通道独立于角色窗口就绪；无角色时也要能接收必需通知。
  send({ type: "channel-ready", pid: process.pid });
  if (latestState) {
    applyState(latestState);
  }
});

app.on("window-all-closed", () => app.quit());
