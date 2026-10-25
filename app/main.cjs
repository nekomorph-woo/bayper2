/* Bayper 正式应用入口（S01）。窗口是普通设置窗口，主进程持有数据库与安全存储，
   renderer 只通过 preload 暴露的窄业务接口工作。 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, safeStorage, dialog, session } = require("electron");
const { AppError, toPublicError } = require("./errors.cjs");
const { createStore } = require("./store.cjs");
const { createOnboardingService } = require("./onboarding.cjs");
const { createCompanionshipService } = require("./companionship.cjs");
const characterContent = require("./content/characters.json");

const RENDERER_FILE = path.join(__dirname, "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_FILE).href;
const RENDERER_DIR_PREFIX = pathToFileURL(`${path.join(__dirname, "renderer")}${path.sep}`).href;

let mainWindow = null;
let store = null;
let companionship = null;

function readDataDir(argv) {
  const inline = argv.find((arg) => arg.startsWith("--data-dir="));
  if (inline) {
    return inline.slice("--data-dir=".length);
  }
  const index = argv.indexOf("--data-dir");
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

/* 生产使用 Electron 用户应用目录；测试必须显式传 --data-dir，
   不读取工作会话或仓库内资料。 */
const dataDir = readDataDir(process.argv);
if (dataDir) {
  app.setPath("userData", path.resolve(dataDir));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(startApplication).catch(reportStartupFailure);
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (companionship) {
      try {
        companionship.markClosed();
      } catch (error) {
        console.error("Bayper 关闭时结算失败：", error?.message ?? error);
      }
      companionship = null;
    }
    if (store) {
      store.close();
      store = null;
    }
  });
}

function startApplication() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  store = createStore(app.getPath("userData"));
  const service = createOnboardingService({
    store,
    safeStorage,
    candidates: characterContent.candidates,
  });
  companionship = createCompanionshipService({
    store,
    candidates: characterContent.candidates,
  });
  companionship.start();

  registerIpcHandlers(service);
  mainWindow = createWindow();
}

function reportStartupFailure(error) {
  dialog.showErrorBox("Bayper 无法启动", error?.message ?? "未知启动错误。");
  app.quit();
}

function createWindow() {
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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadFile(RENDERER_FILE);
  return win;
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
    // 只记录错误摘要，不输出请求头、Key 或用户输入。
    console.error("Bayper 未预期的错误：", error?.message ?? error);
  }
  return { ok: false, error: toPublicError(error) };
}

function snapshotForRenderer(onboardingService) {
  return {
    ...onboardingService.getSnapshot(),
    companionship: companionship.getSnapshot(),
  };
}

function registerIpcHandlers(service) {
  ipcMain.handle("bayper:snapshot", (event) => {
    try {
      assertTrustedSender(event);
      return { ok: true, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:model:validate-and-save", async (event, input) => {
    try {
      assertTrustedSender(event);
      const snapshot = await service.validateAndSaveModel(input);
      return { ok: true, snapshot };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:wish:recommend", (event, wish) => {
    try {
      assertTrustedSender(event);
      return { ok: true, ...service.recommend(wish) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:character:accept", (event, characterId) => {
    try {
      assertTrustedSender(event);
      const result = service.accept(characterId);
      companionship.start();
      return { ok: true, ...result, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:model:check-stored", async (event) => {
    try {
      assertTrustedSender(event);
      const result = await service.checkStoredModel();
      return { ok: true, ...result };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:nickname", (event, characterId, nickname) => {
    try {
      assertTrustedSender(event);
      const result = companionship.setNickname(characterId, nickname);
      return { ok: true, ...result, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:fixed", (event, characterId) => {
    try {
      assertTrustedSender(event);
      const result = companionship.setFixed(characterId);
      return { ok: true, ...result, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:switch", (event, characterId) => {
    try {
      assertTrustedSender(event);
      const result = companionship.switchTo(characterId);
      return { ok: true, ...result, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });

  ipcMain.handle("bayper:companion:rest", (event) => {
    try {
      assertTrustedSender(event);
      const result = companionship.rest();
      return { ok: true, ...result, snapshot: snapshotForRenderer(service) };
    } catch (error) {
      return failureResult(error);
    }
  });
}
