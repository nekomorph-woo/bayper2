#!/usr/bin/env node
/** 真实 Electron 播放验证；截图和状态日志写到 evidence 同目录。
 * node tools/sprite-pipeline/verify-player.cjs --manifest <m.json> --evidence <e.json> */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { parseDisplayScale } = require('./display-scale.cjs');
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};
const manifestPath = option('--manifest');
const evidencePath = option('--evidence');
if (!manifestPath || !evidencePath) {
  console.error('用法: node verify-player.cjs --manifest <m.json> --evidence <e.json> [--display-scale <scale>]');
  process.exit(2);
}
let displayScale;
try {
  displayScale = parseDisplayScale(option('--display-scale'));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
  console.error('manifest 缺少 frames');
  process.exit(2);
}
if (!manifest.spec?.frame_size) {
  console.error('manifest 缺少 spec.frame_size');
  process.exit(2);
}
const durations = manifest.frames.map((frame) => frame.duration_ms);
if (durations.some((duration) => !(duration > 0))) {
  console.error('manifest 缺少有效 duration_ms');
  process.exit(2);
}
const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
const MAX_WAIT_MS = 30000;
const evidenceFile = path.resolve(evidencePath);
const outputDir = path.dirname(evidenceFile);
const prefix = path.basename(evidenceFile, '.json');
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bayper-sprite-verify-'));
const frameOf = (text) => Number(text.match(/帧 (\d+)/)[1]);
const checks = {};
const failures = [];
const logLines = [];
let exitCode = 'not-closed';
let cleanupError = null;
const log = (message) => { logLines.push(message); console.log(`[verify] ${message}`); };
const expect = (name, ok, detail) => {
  checks[name] = { ok, ...detail };
  if (!ok) failures.push(name);
  log(`${ok ? 'OK' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
const skip = (name, detail) => {
  checks[name] = { ok: null, covered: false, ...detail };
  log(`SKIP ${name} ${JSON.stringify(detail)}`);
};
function saveEvidence(errorMessage) {
  if (errorMessage) {
    failures.push('exception');
    checks.exception = { ok: false, message: errorMessage };
    log(`FAIL exception ${errorMessage}`);
  }
  const passed = failures.length === 0;
  const evidence = {
    manifest: path.resolve(manifestPath), capturedAt: new Date().toISOString(),
    durationMs: totalMs, loop: Boolean(manifest.loop), passed, failures, exitCode,
    displayScale,
    note: '自动检查仅证明播放入口行为，不构成视觉或节奏验收；covered=false 表示未覆盖。',
    checks,
  };
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, `${prefix}.log`), `${logLines.join('\n')}\n`);
  console.log(`[verify] ${passed ? 'PASS' : 'FAIL'} evidence=${evidenceFile}`);
  return passed;
}

(async () => {
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'),
      args: [path.join(__dirname, 'player.cjs'), '--manifest', path.resolve(manifestPath),
        '--display-scale', String(displayScale), '--data-dir', dataDir] });
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
    await page.waitForFunction(() => {
      const image = document.querySelector('#frame');
      return image.complete && image.naturalWidth > 0 && image.style.width !== '';
    });
    const rendered = await page.evaluate(() => {
      const image = document.querySelector('#frame');
      const rect = image.getBoundingClientRect();
      return { width: rect.width, height: rect.height,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        imageRendering: getComputedStyle(image).imageRendering };
    });
    const frameSize = manifest.spec.frame_size;
    const targetSize = { width: frameSize.width * displayScale,
      height: frameSize.height * displayScale };
    const near = (actual, expected) => Math.abs(actual - expected) < 0.01;
    expect('display-size', near(rendered.width, targetSize.width)
      && near(rendered.height, targetSize.height)
      && rendered.naturalWidth === frameSize.width
      && rendered.naturalHeight === frameSize.height
      && rendered.imageRendering === 'pixelated',
      { scale: displayScale, target: targetSize, rendered });
    const pause = async () => {
      if ((await page.textContent('#play')) === '暂停') {
        await page.click('#play');
        await page.waitForFunction(() => document.querySelector('#play').textContent === '播放');
      }
    };

    if (manifest.loop) {
      if (totalMs + 3000 > MAX_WAIT_MS) {
        skip('normal', { reason: '循环时长超过验证上限', totalMs, limitMs: MAX_WAIT_MS });
      } else {
        const loopStart = Date.now();
        await page.waitForFunction(() => /循环 [1-9]/.test(
          document.querySelector('#status').textContent), null, { timeout: totalMs + 3000 });
        expect('normal', true, { covered: true, mode: 'loop',
          firstLoopMs: Date.now() - loopStart, status: await page.textContent('#status') });
      }
    } else if (totalMs + 3000 > MAX_WAIT_MS) {
      skip('normal', { reason: '播放时长超过验证上限', totalMs, limitMs: MAX_WAIT_MS });
      skip('replay', { reason: 'normal 未覆盖，未验证重新播放' });
    } else {
      await page.waitForFunction((count) => {
        const text = document.querySelector('#status').textContent;
        return Number(text.match(/帧 (\d+)/)[1]) === count
          && document.querySelector('#play').textContent === '播放';
      }, secure.frames, { timeout: totalMs + 3000 });
      const stopped = await page.textContent('#status');
      const playLabel = await page.textContent('#play');
      expect('normal', frameOf(stopped) === secure.frames && playLabel === '播放',
        { covered: true, mode: 'stop-at-end', status: stopped, playLabel });
      await page.click('#play');
      await page.waitForFunction(() => Number(
        document.querySelector('#status').textContent.match(/帧 (\d+)/)[1]) === 1
        && document.querySelector('#play').textContent === '暂停', null, { timeout: 3000 });
      expect('replay', true, { status: await page.textContent('#status') });
    }

    if ((await page.textContent('#play')) === '播放') await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#play').textContent === '暂停');
    const pauseBefore = await page.textContent('#status');
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#play').textContent === '播放');
    const pausedAt = await page.textContent('#status');
    await page.waitForTimeout(600);
    const pausedLater = await page.textContent('#status');
    expect('pause', pausedAt === pausedLater,
      { before: pauseBefore, pausedAt, pausedLater });

    const before = frameOf(await page.textContent('#status'));
    await page.click('#next');
    const next = frameOf(await page.textContent('#status'));
    await page.click('#prev');
    const prev = frameOf(await page.textContent('#status'));
    expect('step', next === (before % secure.frames) + 1 && prev === before,
      { before, next, prev });

    await page.selectOption('#speed', '0.25');
    const slowFrame = frameOf(await page.textContent('#status'));
    const frameDuration = durations[slowFrame - 1];
    const expectedMs = frameDuration * 4;
    if (expectedMs + 3000 > MAX_WAIT_MS) {
      skip('slow', { reason: '单帧 0.25× 时长超过验证上限', frame: slowFrame,
        frameDurationMs: frameDuration, expectedMs, limitMs: MAX_WAIT_MS });
    } else {
      const slowBefore = await page.textContent('#status');
      const probeMs = Math.min(1000, Math.max(1, Math.floor(expectedMs / 2)));
      const resumedAt = Date.now();
      await page.click('#play');
      await page.waitForTimeout(probeMs);
      const atProbe = await page.textContent('#status');
      await page.waitForFunction((previous) => document.querySelector('#status').textContent
        !== previous, slowBefore, { timeout: expectedMs + 3000 });
      expect('slow', atProbe === slowBefore && Date.now() - resumedAt >= frameDuration * 2,
        { covered: true, speed: await page.inputValue('#speed'), frame: slowFrame,
          frameDurationMs: frameDuration, expectedMs, probeMs,
          sameAtProbe: atProbe === slowBefore, advancedMs: Date.now() - resumedAt,
          frameAfter: frameOf(await page.textContent('#status')) });
    }

    await pause();
    for (let index = 0; index < 3; index += 1) await page.click('#next');
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
  } catch (error) {
    log(`FAIL runtime ${error.message}`);
    throw error;
  } finally {
    try {
      if (app) {
        const child = app.process();
        await app.close();
        exitCode = await Promise.race([
          new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode)
            : child.once('exit', resolve))),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
        ]);
      }
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error.message;
        log(`FAIL cleanup-rm ${error.message}`);
      }
    }
  }
  expect('cleanup', !cleanupError && !fs.existsSync(dataDir),
    { path: dataDir, error: cleanupError });
  expect('exit', exitCode === 0, { code: exitCode });
  if (!saveEvidence()) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  if (!saveEvidence(error.message)) process.exitCode = 1;
});
