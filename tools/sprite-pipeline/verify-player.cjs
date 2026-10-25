#!/usr/bin/env node
/** 真实 Electron 播放验证；截图和状态日志写到 evidence 同目录。
 * node tools/sprite-pipeline/verify-player.cjs --manifest <m.json> --evidence <e.json> */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};
const manifestPath = option('--manifest');
const evidencePath = option('--evidence');
if (!manifestPath || !evidencePath) {
  console.error('用法: node verify-player.cjs --manifest <m.json> --evidence <e.json>');
  process.exit(2);
}
const evidenceFile = path.resolve(evidencePath);
const outputDir = path.dirname(evidenceFile);
const prefix = path.basename(evidenceFile, '.json');
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayper-sprite-verify-'));
const frameOf = (text) => Number(text.match(/帧 (\d+)/)[1]);
const checks = {};
const failures = [];
const logLines = [];
const log = (message) => { logLines.push(message); console.log(`[verify] ${message}`); };
const expect = (name, ok, detail) => {
  checks[name] = { ok, ...detail };
  if (!ok) failures.push(name);
  log(`${ok ? 'OK' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
(async () => {
  let exitCode = 'not-closed';
  let cleanupError = null;
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'),
      args: [path.join(__dirname, 'player.cjs'), '--manifest', path.resolve(manifestPath),
        '--data-dir', dataDir] });
    const page = await app.firstWindow();
    await page.waitForSelector('#frame');
    await page.waitForFunction(() => Boolean(window.reviewData));
    const info = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return { count: windows.length, bounds: windows[0].getBounds(),
        userData: electronApp.getPath('userData') };
    });
    expect('window', info.count === 1 && fs.existsSync(dataDir)
      && info.userData === dataDir, info);
    const secure = await page.evaluate(() => ({ require: typeof require,
      process: typeof process, ipc: typeof window.ipcRenderer,
      frames: window.reviewData.frameUrls.length }));
    expect('sandbox', secure.require === 'undefined' && secure.process === 'undefined'
      && secure.ipc === 'undefined', secure);

    const loopStart = Date.now();
    await page.waitForFunction(() => /循环 [1-9]/.test(
      document.querySelector('#status').textContent), null, { timeout: 8000 });
    expect('normal', true, { firstLoopMs: Date.now() - loopStart,
      status: await page.textContent('#status') });

    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#play').textContent === '播放');
    const pauseBefore = await page.textContent('#status');
    await page.waitForTimeout(600);
    const pauseAfter = await page.textContent('#status');
    expect('pause', pauseBefore === pauseAfter, { before: pauseBefore, after: pauseAfter });

    const before = frameOf(await page.textContent('#status'));
    await page.click('#next');
    const next = frameOf(await page.textContent('#status'));
    await page.click('#prev');
    const prev = frameOf(await page.textContent('#status'));
    expect('step', next === (before % secure.frames) + 1 && prev === before,
      { before, next, prev });

    await page.selectOption('#speed', '0.25');
    for (let i = 0; i < secure.frames
      && frameOf(await page.textContent('#status')) !== 1; i += 1) await page.click('#next');
    const slowBefore = await page.textContent('#status');
    const resumedAt = Date.now();
    await page.click('#play');
    await page.waitForTimeout(1000);
    const atOneSecond = await page.textContent('#status');
    await page.waitForFunction((previous) => document.querySelector('#status').textContent
      !== previous, slowBefore, { timeout: 8000 });
    expect('slow', atOneSecond === slowBefore && Date.now() - resumedAt >= 2000,
      { speed: await page.inputValue('#speed'), sameAt1000ms: atOneSecond === slowBefore,
        advancedMs: Date.now() - resumedAt, frameAfter: frameOf(await page.textContent('#status')) });

    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#play').textContent === '播放');
    for (let i = 0; i < 3; i += 1) await page.click('#next');
    await page.click('#background');
    const dark = await page.evaluate(() => document.body.className);
    await page.screenshot({ path: path.join(outputDir, `${prefix}-dark.png`) });
    await page.click('#background');
    const light = await page.evaluate(() => document.body.className);
    await page.screenshot({ path: path.join(outputDir, `${prefix}-light.png`) });
    expect('background', dark.includes('dark') && !light.includes('dark'),
      { dark, light, screenshots: [`${prefix}-dark.png`, `${prefix}-light.png`] });

    const urlBefore = page.url();
    await page.evaluate(() => {
      window.open('https://example.com');
      window.location.href = 'https://example.com';
    });
    await page.waitForTimeout(300);
    const windows = (await app.windows()).length;
    expect('navigation-block', page.url() === urlBefore && windows === 1,
      { url: page.url(), windows });
  } finally {
    if (app) {
      const child = app.process();
      await app.close();
      exitCode = await Promise.race([
        new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode)
          : child.once('exit', resolve))),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error.message;
      log(`FAIL cleanup-rm ${error.message}`);
    }
  }
  expect('cleanup', !cleanupError && !fs.existsSync(dataDir),
    { path: dataDir, error: cleanupError });
  expect('exit', exitCode === 0, { code: exitCode });
  const passed = failures.length === 0;
  const evidence = { manifest: path.resolve(manifestPath), capturedAt: new Date().toISOString(),
    passed, failures, exitCode,
    note: '自动检查仅证明播放入口行为，不构成视觉或节奏验收。', checks };
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, `${prefix}.log`), `${logLines.join('\n')}\n`);
  log(`${passed ? 'PASS' : 'FAIL'} evidence=${evidenceFile}`);
  if (!passed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
