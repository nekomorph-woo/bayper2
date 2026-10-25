#!/usr/bin/env node
/** 持有本轮临时 data dir，启动 Electron 播放器并在 child 退出后清理。
 * 用法：node tools/sprite-pipeline/preview.cjs --manifest <manifest.json> */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDisplayScale } = require('./display-scale.cjs');

function readOption(name) {
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) return inline.slice(inlinePrefix.length);
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const manifestPath = readOption('--manifest');
if (!manifestPath) {
  console.error('用法: node tools/sprite-pipeline/preview.cjs --manifest <manifest.json> [--display-scale <scale>]');
  process.exit(2);
}

let displayScale;
try {
  displayScale = parseDisplayScale(readOption('--display-scale'));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayper-sprite-player-'));
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    console.error(`临时 data dir 清理失败，保留 ${dataDir}: ${error.message}`);
    process.exitCode = 1;
  }
}

let child;
try {
  child = spawn(
    require('electron'),
    [
      path.join(__dirname, 'player.cjs'),
      '--manifest', path.resolve(manifestPath),
      '--display-scale', String(displayScale),
      '--data-dir', dataDir,
    ],
    { stdio: 'inherit' },
  );
} catch (error) {
  console.error(`无法启动 Electron: ${error.message}`);
  cleanup();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

let childError = false;
child.on('error', (error) => {
  childError = true;
  console.error(`播放器启动失败: ${error.message}`);
  process.exitCode = 1;
  cleanup();
});

child.on('exit', (code, signal) => {
  if (!childError) process.exitCode = code ?? (signal ? 1 : 0);
  cleanup();
});
