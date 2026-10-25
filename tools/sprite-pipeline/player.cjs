const { app, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const playerFile = path.join(__dirname, 'player.html');
const playerUrl = pathToFileURL(playerFile).href;

function readOption(name) {
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) return inline.slice(inlinePrefix.length);
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

// 播放器只使用 launcher 传入的目录，不创建也不删除任何 userData。
const dataDir = readOption('--data-dir');
if (dataDir) {
  app.setPath('userData', path.resolve(dataDir));
  app.setPath('sessionData', path.resolve(dataDir));
}

function readReview(manifestPath) {
  const manifestFile = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
    throw new Error('manifest 缺少 frames');
  }
  if (!manifest.spec?.frame_size) throw new Error('manifest 缺少 spec.frame_size');
  const frameUrls = manifest.frames.map((frame) => {
    if (typeof frame.file !== 'string' || !(frame.duration_ms > 0)) {
      throw new Error('manifest 帧缺少 file 或有效 duration_ms');
    }
    return pathToFileURL(path.resolve(path.dirname(manifestFile), frame.file)).href;
  });
  return { manifest, frameUrls };
}

function createWindow(review) {
  const window = new BrowserWindow({
    width: 720, height: 620, show: false, title: 'Bayper 动画审查',
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.cjs'),
      additionalArguments: [`--review-data=${encodeURIComponent(JSON.stringify(review))}`],
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== playerUrl) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (url !== playerUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(playerFile);
  window.once('ready-to-show', () => window.show());
}

app.whenReady().then(() => {
  const manifestPath = readOption('--manifest');
  if (!dataDir || !manifestPath) {
    console.error('请通过 preview.cjs 启动并提供 --manifest 与 --data-dir');
    app.exit(1);
    return;
  }
  try {
    Menu.setApplicationMenu(null);
    createWindow(readReview(manifestPath));
  } catch (error) {
    console.error(`播放器启动失败: ${error.message}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.quit());
