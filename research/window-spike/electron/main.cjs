const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// 日志与用户数据都必须留在隔离根目录，避免碰真实用户配置。
const root = process.env.BAYPER_WINDOW_ROOT || '';
if (!/^\/(?:private\/)?tmp\/bayper-window-spike-/.test(root)) {
  console.error(`BAYPER_WINDOW_ROOT 无效: ${root || '(空)'}`);
  process.exit(1);
}
const jsonlPath = path.join(root, 'electron.jsonl');
const commandPath = path.join(root, 'command.json');
// BAYPER_PANEL=0 保留普通窗口基线，=1 走 Electron 原生 panel 路线。
const panelMode = process.env.BAYPER_PANEL === '1';
// 可选父进程探针：只检测该 PID 是否仍存在，不尝试恢复、不控制其他进程。
// 仅凭 PID 存在性判断，不抵御 PID 复用；未设置时行为与普通窗口实验一致。
const ownerPidRaw = process.env.BAYPER_OWNER_PID || '';
if (ownerPidRaw && !/^[1-9]\d*$/.test(ownerPidRaw)) {
  console.error(`BAYPER_OWNER_PID 无效: ${ownerPidRaw}`);
  process.exit(1);
}
const ownerPid = ownerPidRaw ? Number(ownerPidRaw) : null;
let win = null;
let lastSeq = 0;
let lastBadCommand = '';

function log(record) {
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (err) {
    console.error('写 electron.jsonl 失败:', err);
  }
}

app.setName('Bayper Electron Probe');
app.setPath('userData', path.join(root, 'electron-user-data'));
app.setPath('sessionData', path.join(root, 'electron-session-data'));

function state() {
  return { bounds: win.getBounds(), focused: win.isFocused(), visible: win.isVisible() };
}

function applyAction(seq, action, value, fn) {
  try {
    fn();
    log({ event: 'command-action', seq, action, value, ok: true });
    return true;
  } catch (err) {
    log({ event: 'command-action', seq, action, value, ok: false, error: String(err) });
    return false;
  }
}

function applyCommand(cmd) {
  let ok = true;
  if (typeof cmd.ignore === 'boolean') {
    ok = applyAction(cmd.seq, 'ignore', cmd.ignore, () => win.setIgnoreMouseEvents(cmd.ignore)) && ok;
  }
  if (typeof cmd.animate === 'boolean') {
    // 动画是否生效以 renderer 执行结果为准，失败单独记日志。
    win.webContents.executeJavaScript(`window.setAnimation(${cmd.animate})`)
      .then(() => log({ event: 'command-action', seq: cmd.seq, action: 'animate', value: cmd.animate, ok: true }))
      .catch((err) => log({ event: 'command-action', seq: cmd.seq, action: 'animate', value: cmd.animate, ok: false, error: String(err) }));
  }
  if (typeof cmd.x === 'number' || typeof cmd.y === 'number') {
    ok = applyAction(cmd.seq, 'position', { x: cmd.x, y: cmd.y }, () => {
      const bounds = win.getBounds();
      win.setPosition(
        typeof cmd.x === 'number' ? Math.round(cmd.x) : bounds.x,
        typeof cmd.y === 'number' ? Math.round(cmd.y) : bounds.y,
      );
    }) && ok;
  }
  if (typeof cmd.visible === 'boolean') {
    ok = applyAction(cmd.seq, 'visible', cmd.visible, () => {
      if (cmd.visible) win.showInactive();
      else win.hide();
    }) && ok;
  }
  log({ event: 'command', seq: cmd.seq, ok, ...state() });
  if (cmd.quit === true) {
    log({ event: 'quit-command', seq: cmd.seq });
    app.quit();
  }
}

function pollCommand() {
  let raw;
  try {
    raw = fs.readFileSync(commandPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log({ event: 'command-read-failed', error: String(err) });
    return;
  }
  if (raw === lastBadCommand) return;
  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch (err) {
    lastBadCommand = raw;
    log({ event: 'command-parse-failed', raw, error: String(err) });
    return;
  }
  lastBadCommand = '';
  if (typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return;
  lastSeq = cmd.seq;
  applyCommand(cmd);
}

// 守护进程消失（含 SIGKILL）后 GUI 自行退出；ESRCH 之外（如 EPERM）视为仍存在。
function watchOwner() {
  if (ownerPid === null) return;
  setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        log({ event: 'owner-exited', ownerPid });
        app.quit();
      }
    }
  }, 400);
}

app.whenReady().then(() => {
  app.dock.hide();
  watchOwner();
  if (panelMode) {
    // 可选对照：prohibited 仅用于观察是否仍抢激活；不自动把焦点抢回来。
    const policy = process.env.BAYPER_ACTIVATION_POLICY === 'prohibited' ? 'prohibited' : 'accessory';
    const result = app.setActivationPolicy(policy);
    log({ event: 'activation-policy', value: policy, result });
  }
  win = new BrowserWindow({
    width: 240, height: 240, x: 400, y: 300,
    backgroundColor: '#00000000', transparent: true, frame: false, hasShadow: false,
    resizable: false, focusable: false, show: false, alwaysOnTop: true,
    // type=panel 是 Electron 原生 NSPanel 路线，必须配合 focusable:false。
    ...(panelMode ? { type: 'panel', acceptFirstMouse: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadFile(path.join(__dirname, '../shared/index.html'), { query: { backend: 'Electron' } });

  win.webContents.once('did-finish-load', () => {
    win.showInactive();
    log({
      event: 'startup', pid: process.pid, panel_mode: panelMode,
      window_kind: panelMode ? 'panel' : 'normal', owner_pid: ownerPid,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      ...state(),
    });
    setInterval(pollCommand, 250);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log({ event: 'load-failed', code, description });
    app.quit();
  });
  win.on('focus', () => log({ event: 'focus', ...state() }));
  win.on('blur', () => log({ event: 'blur', ...state() }));
  win.on('show', () => log({ event: 'show', ...state() }));
  win.on('close', () => log({ event: 'close', ...state() }));
  win.on('closed', () => { log({ event: 'closed' }); app.quit(); });
  ipcMain.on('probe:log', (_event, payload) => log({ event: 'renderer-click', payload, ...state() }));

  // 无外部控制时也必须自行结束，避免遗留探针窗口。
  setTimeout(() => {
    log({ event: 'timeout-quit' });
    app.quit();
  }, 20 * 60 * 1000);
});

app.on('window-all-closed', () => app.quit());
