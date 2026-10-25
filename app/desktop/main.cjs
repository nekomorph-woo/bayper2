/* 正式角色画布子进程。固定 Prohibited 非激活 panel，只做显示与有限输入转发；
   不访问数据库、模型 Key 或记忆。父进程 stdin 关闭时自行退出。 */
const path = require("node:path");
const readline = require("node:readline");
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");

const profileDir = process.env.BAYPER_DESKTOP_PROFILE;
const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 128, height: 128 });
if (!profileDir) {
  console.error("缺少 BAYPER_DESKTOP_PROFILE");
  app.quit();
}

let window = null;
let latestState = null;
let dragState = null;
let activationPolicy = "unconfirmed";
let lastReportedBoundsKey = "";

app.setName("Bayper Canvas");
if (profileDir) {
  app.setPath("userData", path.resolve(profileDir));
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
}

function applyState(state) {
  latestState = state;
  if (!window || window.isDestroyed()) {
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
    }
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

  const initialSize = displaySize(latestState?.animations?.display);
  window = new BrowserWindow({
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

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, "renderer", "index.html"));

  window.webContents.once("did-finish-load", () => {
    sendReady();
    if (latestState) {
      applyState(latestState);
    }
  });
  window.on("closed", () => app.quit());

  screen.on("display-added", reanchorToDisplays);
  screen.on("display-removed", reanchorToDisplays);
  screen.on("display-metrics-changed", reanchorToDisplays);

  registerIpc();

  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", handleParentLine);
  process.stdin.on("end", () => app.quit());
  process.stdin.on("close", () => app.quit());
  process.stdin.resume();
});

app.on("window-all-closed", () => app.quit());
