/* S07c 透明像素鼠标穿透验收：真实 Electron 画布 + 自建底板 + 真实系统 CGEvent。
   直接 DOM click 只用于既有回归；本用例的身体/透明路由结论只取系统事件计数。 */
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { fileURLToPath } = require("node:url");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { buildDesktopPresentation } = require("../../app/desktop-assets.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const toolsDir = path.join(repoRoot, "tools", "desktop-input");
const inputScript = path.join(toolsDir, "system-input.py");
const probeScript = path.join(toolsDir, "alpha-probe.py");
const evidenceRoot = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s07c-transparent-input",
);

function reserveEvidenceBatch(requested) {
  const fallback = `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const base = requested || fallback;
  if (path.basename(base) !== base || base === "." || base === "..") {
    throw new Error(`S07C_EVIDENCE_BATCH 必须是单层目录名：${base}`);
  }
  fs.mkdirSync(evidenceRoot, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-r${attempt + 1}`;
    const directory = path.join(evidenceRoot, name);
    try {
      fs.mkdirSync(directory, { recursive: false });
      return { name, directory, requested: requested ?? null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`无法为证据批次生成唯一目录：${base}`);
}

const reservedBatch = reserveEvidenceBatch(process.env.S07C_EVIDENCE_BATCH);
const BATCH_DIR_NAME = reservedBatch.name;
const BATCH_ID = BATCH_DIR_NAME.replace(/^run-/, "");
const EVIDENCE_DIR = reservedBatch.directory;
const SOURCE_FILES = [
  "app/desktop/main.cjs",
  "app/desktop/preload.cjs",
  "app/desktop/canvas-ipc.cjs",
  "app/desktop/hit-test.cjs",
  "app/desktop/renderer/canvas-app.js",
  "tests/acceptance/s07c-transparent-input.spec.cjs",
  "tests/acceptance/desktop.spec.cjs",
  "tests/unit/desktop-hit-test.test.cjs",
  "tests/unit/desktop-canvas-ipc.test.cjs",
  "tools/desktop-input/README.md",
  "tools/desktop-input/alpha-probe.py",
  "tools/desktop-input/plate.cjs",
  "tools/desktop-input/plate.html",
  "tools/desktop-input/system-input.py",
];

function sourceDigest() {
  return SOURCE_FILES.map((file) => {
    const full = path.join(repoRoot, file);
    const hash = fs.existsSync(full)
      ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")
      : "missing";
    return `${hash}  ${file}`;
  }).join("\n");
}

fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    `requested-batch: ${reservedBatch.requested ?? "auto"}`,
    `exclusive-directory: true`,
    `source: tests/acceptance/s07c-transparent-input.spec.cjs`,
    "input: real macOS CGEvent（tools/desktop-input/system-input.py）",
    "direct-dom-click-is-not-passthrough-evidence: true",
    "",
    "## source sha256",
    sourceDigest(),
    "",
  ].join("\n"),
);
fs.writeFileSync(path.join(EVIDENCE_DIR, "source.sha256"), `${sourceDigest()}\n`);

const inputState = { cursor: null, trusted: false };
const caseResults = {};
const screenshots = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 12000, message = "等待条件超时") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await delay(30);
  }
  assert.fail(message);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(processHandle, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!processHandle || processHandle.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function runSystem(...args) {
  const output = execFileSync("python3", [inputScript, ...args.map(String)], {
    encoding: "utf8",
    timeout: 15000,
  });
  return JSON.parse(output);
}

function runProbe(request) {
  const output = execFileSync("python3", [probeScript], {
    encoding: "utf8",
    input: JSON.stringify(request),
    timeout: 30000,
  });
  return JSON.parse(output);
}

function clickAt(x, y) {
  return runSystem("click", Math.round(x), Math.round(y));
}

function moveTo(x, y) {
  return runSystem("move", Math.round(x), Math.round(y));
}

function dragFromTo(from, to) {
  return runSystem("drag", Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y), 420);
}

function pressAt(point) {
  return runSystem("down", Math.round(point.x), Math.round(point.y));
}

function dragTo(point) {
  return runSystem("dragto", Math.round(point.x), Math.round(point.y));
}

function releaseAt(point) {
  return runSystem("up", Math.round(point.x), Math.round(point.y));
}

function writeCase(name, failure, facts, coverage = null) {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.log`),
    [
      `# ${name}`,
      `batch: ${BATCH_ID}`,
      `time: ${new Date().toISOString()}`,
      `result: ${failure ? "FAIL" : caseResults[name] ?? "PASS"}`,
      `failure: ${failure ? failure.stack || failure.message || String(failure) : "none"}`,
      ...(coverage ? ["coverage:", JSON.stringify(coverage, null, 2)] : []),
      "",
      "## facts",
      JSON.stringify(facts, null, 2),
      "",
    ].join("\n"),
  );
}

function writeScreenshot(name, buffer) {
  if (!buffer) return;
  const file = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(file, buffer);
  screenshots.push(file);
}

async function launchCharacter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s07c-canvas-"));
  const profileDir = path.join(root, "profile");
  const child = spawn(
    electronPath,
    [
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      path.join(repoRoot, "app", "desktop"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG || "zh_CN.UTF-8",
        BAYPER_DESKTOP_PROFILE: profileDir,
        BAYPER_DESKTOP_CHILD: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const outputLines = [];
  child.stdout.on("data", (chunk) => outputLines.push(chunk.toString()));
  child.stderr.on("data", (chunk) => outputLines.push(chunk.toString()));
  const portFile = path.join(profileDir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile), 10000, "画布调试端口未生成");
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await waitFor(() => {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("/app/desktop/renderer/index.html"));
    return Boolean(page);
  }, 10000, "未找到画布 renderer");
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
  await page.waitForLoadState("domcontentloaded");
  await waitFor(
    () => parsedMessages({ outputLines }).some((message) => message.type === "channel-ready"),
    10000,
    "画布通道未就绪",
  );
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 5000 });
  await delay(500);
  return { root, profileDir, child, browser, page, outputLines, pageErrors };
}

async function launchPlate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s07c-plate-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(toolsDir, "plate.cjs")],
    env: {
      ...process.env,
      BAYPER_PLATE_PROFILE: path.join(root, "profile"),
      BAYPER_PLATE_BOUNDS: JSON.stringify({ x: 80, y: 80, width: 360, height: 300 }),
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.__plate), null, { timeout: 5000 });
  const placement = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workArea;
    const width = 360;
    const height = 300;
    const x = Math.round(area.x + area.width - width - 90);
    const y = Math.round(area.y + area.height - height - 110);
    win.setBounds({ x, y, width, height });
    return {
      bounds: win.getBounds(),
      workArea: area,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    };
  });
  await delay(200);
  return { root, app, page, placement };
}

async function focusPlate(plate) {
  await plate.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    win.focus();
  });
  await plate.page.evaluate(() => document.getElementById("probe").focus());
  await delay(200);
  return plate.page.evaluate(() => window.__plate.snapshot());
}

async function plateReset(plate) {
  await plate.page.evaluate(() => window.__plate.reset());
}

async function plateSnapshot(plate) {
  return plate.page.evaluate(() => window.__plate.snapshot());
}

function sendState(canvas, state) {
  canvas.child.stdin.write(`${JSON.stringify({ type: "state", ...state })}\n`);
}

function parsedMessages(canvas) {
  return canvas.outputLines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function messageMark(canvas) {
  return parsedMessages(canvas).length;
}

function messagesSince(canvas, mark) {
  return parsedMessages(canvas).slice(mark);
}

function latestBounds(canvas) {
  // 拖拽期间主进程只发 position-changed，不逐帧发 bounds；合并两者得到实际位置。
  const messages = parsedMessages(canvas);
  let result = null;
  for (const message of messages) {
    if ((message.type === "ready" || message.type === "bounds") && message.bounds) {
      result = { ...message.bounds };
    } else if (
      message.type === "position-changed"
      && result
      && Number.isFinite(message.x)
      && Number.isFinite(message.y)
    ) {
      result = { ...result, x: Math.round(message.x), y: Math.round(message.y) };
    }
  }
  return result;
}

async function waitForSprite(page, needle, timeout = 10000) {
  await page.waitForFunction(
    (expected) => {
      const sprite = document.getElementById("sprite");
      return Boolean(sprite?.src.includes(expected) && sprite?.complete && !sprite.hidden);
    },
    needle,
    { timeout },
  );
}

async function waitForStatus(page, timeout = 5000) {
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return Boolean(status && !status.hidden);
    },
    null,
    { timeout },
  );
}

function presentationState(presentation, displayKey, extra = {}) {
  return {
    ...presentation,
    displayKey,
    mode: "companion",
    visible: true,
    ignoreMouse: false,
    position: null,
    ...extra,
  };
}

function frameOnlyIdle(presentation, frame, duration = 5000) {
  return {
    ...presentation,
    animations: {
      ...presentation.animations,
      idle: {
        ...presentation.animations.idle,
        frames: [frame],
        durations: [duration],
        loop: true,
      },
    },
  };
}

async function showState(canvas, state, idleNeedle, settle = 420) {
  sendState(canvas, state);
  await waitForSprite(canvas.page, idleNeedle);
  await delay(settle);
}

function animationPrefix(presentation, name) {
  const frames = presentation.animations[name]?.frames ?? [];
  return frames.length
    ? frames[0].slice(0, frames[0].lastIndexOf("/") + 1)
    : "";
}

async function displayedFrame(canvas) {
  return canvas.page.evaluate(() => document.getElementById("sprite")?.src ?? "");
}

async function failureDiagnostics(canvas, plate) {
  const diagnostics = {};
  if (canvas) {
    diagnostics.bounds = latestBounds(canvas);
    diagnostics.messages = parsedMessages(canvas).slice(-30);
    diagnostics.renderer = await canvas.page.evaluate(() => ({
      src: document.getElementById("sprite")?.src ?? "",
      hidden: document.getElementById("sprite")?.hidden ?? true,
      statusHidden: document.getElementById("status")?.hidden ?? true,
      statusText: document.getElementById("status-note")?.textContent ?? "",
    })).catch((error) => ({ error: error.message }));
  }
  if (plate) {
    diagnostics.plate = await plateSnapshot(plate).catch((error) => ({ error: error.message }));
  }
  return diagnostics;
}

async function clickTransparentAndExpectPlate(plate, screenPoint) {
  await plateReset(plate);
  const before = await plateSnapshot(plate);
  clickAt(screenPoint.x, screenPoint.y);
  await delay(450);
  const after = await plateSnapshot(plate);
  return {
    screen: { x: Math.round(screenPoint.x), y: Math.round(screenPoint.y) },
    before: { pointerdown: before.pointerdown, pointerup: before.pointerup },
    after,
    delta: after.pointerdown - before.pointerdown,
  };
}

async function waitNoWave(canvas, mark, idleNeedle, duration = 900) {
  await delay(duration);
  const waveNode = messagesSince(canvas, mark).some(
    (message) => message.type === "node-complete" && message.node === "wave",
  );
  const src = await canvas.page.evaluate(() => document.getElementById("sprite")?.src ?? "");
  assert.equal(waveNode, false, "透明点击不应产生 wave 自然节点");
  assert.ok(src.includes(idleNeedle), `透明点击后应保持待机帧，实际 ${src}`);
}

test(
  "POL-HIT-001/002/003 透明像素真实穿透、身体交互、换帧/换角色/拖拽与全局忽略",
  { timeout: 300000 },
  async (t) => {
    const trust = runSystem("check");
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "environment.log"),
      JSON.stringify(
        {
          trusted: trust.trusted,
          cursor: trust.cursor,
          electron: require("electron/package.json").version,
          platform: process.platform,
          release: os.release(),
          display: process.env.DISPLAY ?? null,
        },
        null,
        2,
      ),
    );
    if (!trust.trusted) {
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "NOT_COVERED.log"),
        [
          "POL-HIT-001/002/003 未覆盖：当前进程没有辅助功能权限，无法发送真实系统鼠标事件。",
          "不会弹授权提示，也不会用 DOM click 冒充穿透证据。请由 Codex 安排可用输入能力后重跑。",
          "",
        ].join("\n"),
      );
      t.skip("辅助功能未授权：真实系统点击不可用，保留 NOT_COVERED");
      return;
    }
    inputState.trusted = true;
    inputState.cursor = trust.cursor;

    let canvas = null;
    let plate = null;
    let failure = null;
    let cleanup = null;
    const facts = {};

    try {
      plate = await launchPlate();
      const placement = plate.placement;
      const plateBounds = placement.bounds;
      const focusReady = await focusPlate(plate);
      facts.placement = placement;
      facts.focusReady = focusReady;
      const electronCursor = await plate.app.evaluate(({ screen }) =>
        screen.getCursorScreenPoint());
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "coordinate-check.log"),
        JSON.stringify(
          {
            cgEvent: trust.cursor,
            electron: electronCursor,
            agree:
              Math.abs(trust.cursor.x - electronCursor.x) < 1
              && Math.abs(trust.cursor.y - electronCursor.y) < 1,
          },
          null,
          2,
        ),
      );
      assert.ok(
        Math.abs(trust.cursor.x - electronCursor.x) < 1
          && Math.abs(trust.cursor.y - electronCursor.y) < 1,
        "CGEvent 与 Electron 屏幕坐标不一致，不能用系统点击判定路由",
      );

      canvas = await launchCharacter();
      const presentations = {
        hu: buildDesktopPresentation("hu", "琥珀"),
        cheng: buildDesktopPresentation("cheng", "澄"),
        rin: buildDesktopPresentation("rin", "凛"),
      };
      const position = {
        x: plateBounds.x + 140,
        y: plateBounds.y + 104,
      };

      const probeRequest = { threshold: 16, jobs: [] };
      const framePaths = (presentation) =>
        presentation.animations.idle.frames.map((url) => fileURLToPath(url));
      for (const characterId of ["hu", "cheng", "rin"]) {
        const presentation = presentations[characterId];
        probeRequest.jobs.push({
          id: `${characterId}-stable`,
          kind: "stable",
          frames: framePaths(presentation),
          display: presentation.animations.display,
          window: {
            width: presentation.animations.display.windowWidth,
            height: presentation.animations.display.windowHeight,
          },
        });
      }
      probeRequest.jobs.push({
        id: "hu-toggle",
        kind: "toggle",
        frames: framePaths(presentations.hu),
        display: presentations.hu.animations.display,
        window: {
          width: presentations.hu.animations.display.windowWidth,
          height: presentations.hu.animations.display.windowHeight,
        },
        from: 0,
        to: 7,
      });
      probeRequest.jobs.push({
        id: "idle0-wave1",
        kind: "toggle",
        frames: [framePaths(presentations.hu)[0], fileURLToPath(presentations.hu.animations.wave.frames[1])],
        display: presentations.hu.animations.display,
        window: {
          width: presentations.hu.animations.display.windowWidth,
          height: presentations.hu.animations.display.windowHeight,
        },
        from: 0,
        to: 1,
      });
      probeRequest.jobs.push({
        id: "idle0-stretch0",
        kind: "toggle",
        frames: [framePaths(presentations.hu)[0], fileURLToPath(presentations.hu.animations.stretch.frames[0])],
        display: presentations.hu.animations.display,
        window: {
          width: presentations.hu.animations.display.windowWidth,
          height: presentations.hu.animations.display.windowHeight,
        },
        from: 0,
        to: 1,
      });
      probeRequest.jobs.push({
        id: "hu-cheng",
        kind: "switch",
        fromFrames: framePaths(presentations.hu),
        fromDisplay: presentations.hu.animations.display,
        toFrames: framePaths(presentations.cheng),
        toDisplay: presentations.cheng.animations.display,
        window: { width: 96, height: 128 },
      });
      const probe = runProbe(probeRequest);
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "alpha-probe.json"),
        JSON.stringify({ request: probeRequest, response: probe }, null, 2),
      );
      assert.equal(probe.ok, true);
      for (const [id, result] of Object.entries(probe.results)) {
        assert.equal(result.error, undefined, `${id} 取点失败：${result.error}`);
      }
      facts.probe = probe.results;

      const screenPoint = (bounds, point) => ({
        x: bounds.x + point.x,
        y: bounds.y + point.y,
      });

      // POL-HIT-001：三角色真实身体/透明点击、底板计数与焦点。
      caseResults["POL-HIT-001"] = "RUNNING";
      {
        const caseRecord = { characters: {}, focus: {}, routing: "system-cgevent" };
        try {
          for (const characterId of ["hu", "cheng", "rin"]) {
            const presentation = presentations[characterId];
            const idlePrefix = animationPrefix(presentation, "idle");
            const wavePrefix = animationPrefix(presentation, "wave");
            const displayKey = `s07c-${characterId}-body`;
            const state = presentationState(presentation, displayKey, { position });
            await showState(canvas, state, idlePrefix);
            const bounds = latestBounds(canvas);
            assert.ok(bounds, `${characterId} 未上报窗口 bounds`);
            const stable = probe.results[`${characterId}-stable`];
            const transparentPoint = screenPoint(bounds, stable.transparent);
            const bodyPoint = screenPoint(bounds, stable.body);
            const focus = await focusPlate(plate);
            facts.focusReady = facts.focusReady && focus.hasFocus;

            const transparentMark = messageMark(canvas);
            const transparentFrame = await displayedFrame(canvas);
            const transparent = await clickTransparentAndExpectPlate(plate, transparentPoint);
            assert.equal(transparent.delta, 1, `${characterId} 透明点击应只到达底板一次`);
            await waitNoWave(canvas, transparentMark, idlePrefix);
            const afterTransparentFocus = await plateSnapshot(plate);
            assert.equal(afterTransparentFocus.hasFocus, true, `${characterId} 透明点击后下方焦点丢失`);
            assert.equal(afterTransparentFocus.active, "probe");

            await moveTo(bodyPoint.x, bodyPoint.y);
            await delay(260);
            await plateReset(plate);
            const bodyMark = messageMark(canvas);
            const bodyFrame = await displayedFrame(canvas);
            clickAt(bodyPoint.x, bodyPoint.y);
            await waitForSprite(canvas.page, wavePrefix, 6000);
            await waitFor(
              () => messagesSince(canvas, bodyMark).some(
                (message) => message.type === "node-complete" && message.node === "wave",
              ),
              8000,
              `${characterId} 身体点击未产生 wave 节点`,
            );
            const bodyPlate = await plateSnapshot(plate);
            assert.equal(bodyPlate.pointerdown, 0, `${characterId} 身体点击不应到达底板`);
            const bodyFocus = await plateSnapshot(plate);
            assert.equal(bodyFocus.hasFocus, true, `${characterId} 身体点击后下方焦点丢失`);
            assert.equal(bodyFocus.active, "probe");
            assert.equal(
              messagesSince(canvas, bodyMark).filter(
                (message) => message.type === "node-complete" && message.node === "wave",
              ).length,
              1,
              `${characterId} 一次身体点击只应有一个 wave 节点`,
            );
            await waitForSprite(canvas.page, idlePrefix, 8000);

            caseRecord.characters[characterId] = {
              displayKey,
              windowBounds: bounds,
              bodyLocal: stable.body,
              bodyAlpha: stable.body.alphas,
              transparentLocal: stable.transparent,
              transparentAlpha: stable.transparent.alphas,
              frameAtTransparentClick: transparentFrame,
              frameAtBodyClick: bodyFrame,
              transparentClick: transparent,
              bodyPlatePointerdown: bodyPlate.pointerdown,
              waveNodeCount: messagesSince(canvas, bodyMark).filter(
                (message) => message.type === "node-complete" && message.node === "wave",
              ).length,
              focusAfterTransparent: {
                hasFocus: afterTransparentFocus.hasFocus,
                active: afterTransparentFocus.active,
              },
              focusAfterBody: { hasFocus: bodyFocus.hasFocus, active: bodyFocus.active },
            };
          }
          caseResults["POL-HIT-001"] = "PASS";
          writeCase("case-POL-HIT-001", null, caseRecord, {
            routing: "PASS（真实系统 CGEvent，底板/角色双侧计数）",
            focus: "PASS（自建底板输入框保持 key）",
            retries: 0,
          });
        } catch (error) {
          caseResults["POL-HIT-001"] = "FAIL";
          caseRecord.diagnostics = await failureDiagnostics(canvas, plate);
          writeCase("case-POL-HIT-001", error, caseRecord);
          throw error;
        }
      }

      // POL-HIT-002：换帧、换角色、窗口初现/移动都不得沿用旧命中。
      caseResults["POL-HIT-002"] = "RUNNING";
      {
        const caseRecord = { frame: {}, switch: {}, appearance: {}, move: {} };
        try {
          const hu = presentations.hu;
          const toggle = probe.results["hu-toggle"];
          const frame0Presentation = {
            ...frameOnlyIdle(hu, hu.animations.idle.frames[0]),
            displayKey: "s07c-hu-f0",
          };
          const frame7Presentation = {
            ...frameOnlyIdle(hu, hu.animations.idle.frames[7]),
            displayKey: "s07c-hu-f7",
          };
          await showState(
            canvas,
            presentationState(frame0Presentation, frame0Presentation.displayKey, { position }),
            hu.animations.idle.frames[0],
          );
          const bounds = latestBounds(canvas);
          const togglePoint = screenPoint(bounds, toggle);
          const bodyPoint = screenPoint(bounds, probe.results["hu-stable"].body);
          const huIdle = animationPrefix(hu, "idle");
          const huWave = animationPrefix(hu, "wave");
          const chengIdle = animationPrefix(presentations.cheng, "idle");
          const chengWave = animationPrefix(presentations.cheng, "wave");
          await focusPlate(plate);
          await moveTo(togglePoint.x, togglePoint.y);
          await delay(300);

          // 指针不动，切到实际 frame-07：该点透明，应到达底板。
          const frameMark = messageMark(canvas);
          sendState(
            canvas,
            presentationState(frame7Presentation, frame7Presentation.displayKey, { position }),
          );
          await waitForSprite(canvas.page, hu.animations.idle.frames[7], 8000);
          await delay(350);
          const frame7Frame = await displayedFrame(canvas);
          const frame7Click = await clickTransparentAndExpectPlate(plate, togglePoint);
          await waitNoWave(canvas, frameMark, hu.animations.idle.frames[7]);
          assert.equal(frame7Click.delta, 1, "frame-07 透明点应到达底板");
          const frame7Focus = await plateSnapshot(plate);
          assert.equal(frame7Focus.hasFocus, true);
          assert.equal(frame7Focus.active, "probe");

          // 仍不移动指针，切回 frame-00：同一点为身体，应招呼。
          const backMark = messageMark(canvas);
          sendState(
            canvas,
            presentationState(frame0Presentation, frame0Presentation.displayKey, { position }),
          );
          await waitForSprite(canvas.page, hu.animations.idle.frames[0], 8000);
          await delay(350);
          await plateReset(plate);
          const frame0Frame = await displayedFrame(canvas);
          clickAt(togglePoint.x, togglePoint.y);
          await waitForSprite(canvas.page, huWave, 6000);
          await waitFor(
            () => messagesSince(canvas, backMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "切回 frame-00 后同一指针点未触发招呼",
          );
          const frameBodyPlate = await plateSnapshot(plate);
          assert.equal(frameBodyPlate.pointerdown, 0);
          await waitForSprite(canvas.page, hu.animations.idle.frames[0], 8000);
          caseRecord.frame = {
            toggleLocal: toggle,
            frame7Alpha: toggle.toAlpha,
            frame0Alpha: toggle.fromAlpha,
            frame7WindowFrame: frame7Frame,
            frame0WindowFrame: frame0Frame,
            frame7Click,
            frame0WaveNode: messagesSince(canvas, backMark).filter(
              (message) => message.type === "node-complete" && message.node === "wave",
            ).length,
            pointerStationary: true,
            note: "使用同一角色实际 idle 帧的确定性单帧状态，避免与 80–350ms 播放时序竞争",
          };

          // wave/stretch 实际帧：同一点切换到该帧变透明，切回 idle 变身体。
          const frameChecks = [
            {
              name: "wave",
              toggle: probe.results["idle0-wave1"],
              frame: hu.animations.wave.frames[1],
            },
            {
              name: "stretch",
              toggle: probe.results["idle0-stretch0"],
              frame: hu.animations.stretch.frames[0],
            },
          ];
          for (const check of frameChecks) {
            const point = screenPoint(bounds, check.toggle);
            await showState(
              canvas,
              presentationState(frame0Presentation, frame0Presentation.displayKey, { position }),
              hu.animations.idle.frames[0],
            );
            await focusPlate(plate);
            await moveTo(point.x, point.y);
            await delay(300);
            const frameMark = messageMark(canvas);
            const frameState = {
              ...frameOnlyIdle(hu, check.frame),
              displayKey: `s07c-hu-${check.name}-frame`,
            };
            sendState(
              canvas,
              presentationState(frameState, frameState.displayKey, { position }),
            );
            await waitForSprite(canvas.page, check.frame, 8000);
            await delay(300);
            const frameClick = await clickTransparentAndExpectPlate(plate, point);
            assert.equal(frameClick.delta, 1, `${check.name} 帧透明点应到达底板`);
            await waitNoWave(canvas, frameMark, check.frame);

            const backMark = messageMark(canvas);
            sendState(
              canvas,
              presentationState(frame0Presentation, frame0Presentation.displayKey, { position }),
            );
            await waitForSprite(canvas.page, hu.animations.idle.frames[0], 8000);
            await delay(300);
            await plateReset(plate);
            clickAt(point.x, point.y);
            await waitForSprite(canvas.page, huWave, 6000);
            await waitFor(
              () => messagesSince(canvas, backMark).some(
                (message) => message.type === "node-complete" && message.node === "wave",
              ),
              8000,
              `切回 idle 后 ${check.name} 边缘点未招呼`,
            );
            assert.equal((await plateSnapshot(plate)).pointerdown, 0);
            await waitForSprite(canvas.page, huIdle, 8000);
            caseRecord.frame[`${check.name}Frame`] = {
              local: check.toggle,
              frame: check.frame,
              transparentClick: frameClick,
              idleBodyWave: messagesSince(canvas, backMark).filter(
                (message) => message.type === "node-complete" && message.node === "wave",
              ).length,
            };
          }

          // 换角色：同一点 Hu 透明 -> Cheng 身体；以及 Hu 身体 -> Cheng 透明。
          const cross = probe.results["hu-cheng"];
          const toBodyPoint = screenPoint(bounds, cross.transToBody);
          await showState(
            canvas,
            presentationState(hu, "s07c-switch-hu-a", { position }),
            huIdle,
          );
          await focusPlate(plate);
          await moveTo(toBodyPoint.x, toBodyPoint.y);
          await delay(300);
          const huTransparentMark = messageMark(canvas);
          const huTransparent = await clickTransparentAndExpectPlate(plate, toBodyPoint);
          assert.equal(huTransparent.delta, 1);
          await waitNoWave(canvas, huTransparentMark, huIdle);

          const chengMark = messageMark(canvas);
          sendState(
            canvas,
            presentationState(presentations.cheng, "s07c-switch-cheng-body", { position }),
          );
          await waitForSprite(canvas.page, chengIdle, 8000);
          await delay(350);
          await plateReset(plate);
          clickAt(toBodyPoint.x, toBodyPoint.y);
          await waitForSprite(canvas.page, chengWave, 6000);
          await waitFor(
            () => messagesSince(canvas, chengMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "换到澄后同一点未触发招呼",
          );
          const chengPlate = await plateSnapshot(plate);
          assert.equal(chengPlate.pointerdown, 0);
          await waitForSprite(canvas.page, chengIdle, 8000);

          const fromBodyPoint = screenPoint(bounds, cross.bodyToTrans);
          await showState(
            canvas,
            presentationState(hu, "s07c-switch-hu-b", { position }),
            huIdle,
          );
          await focusPlate(plate);
          await moveTo(fromBodyPoint.x, fromBodyPoint.y);
          await delay(300);
          const huBodyMark = messageMark(canvas);
          await plateReset(plate);
          clickAt(fromBodyPoint.x, fromBodyPoint.y);
          await waitForSprite(canvas.page, huWave, 6000);
          await waitFor(
            () => messagesSince(canvas, huBodyMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "换角色前 Hu 身体点未招呼",
          );
          await waitForSprite(canvas.page, huIdle, 8000);

          const switchMark = messageMark(canvas);
          sendState(
            canvas,
            presentationState(presentations.cheng, "s07c-switch-cheng-trans", { position }),
          );
          await waitForSprite(canvas.page, chengIdle, 8000);
          await delay(350);
          const chengTransparent = await clickTransparentAndExpectPlate(plate, fromBodyPoint);
          assert.equal(chengTransparent.delta, 1, "换角色后原身体点变透明应到达底板");
          await waitNoWave(canvas, switchMark, chengIdle);
          const switchFocus = await plateSnapshot(plate);
          assert.equal(switchFocus.hasFocus, true);
          assert.equal(switchFocus.active, "probe");
          caseRecord.switch = {
            local: { transToBody: cross.transToBody, bodyToTrans: cross.bodyToTrans },
            huTransparentClick: huTransparent,
            chengBodyWave: messagesSince(canvas, chengMark).filter(
              (message) => message.type === "node-complete" && message.node === "wave",
            ).length,
            chengTransparentClick: chengTransparent,
            staleGenerationControlledHit: false,
          };

          // 窗口初现：指针已在身体点，显示后无需移动即可招呼。
          await showState(
            canvas,
            presentationState(hu, "s07c-appear-body", { position, visible: false }),
            huIdle,
          );
          await moveTo(bodyPoint.x, bodyPoint.y);
          await delay(250);
          const appearMark = messageMark(canvas);
          sendState(
            canvas,
            presentationState(hu, "s07c-appear-body", { position, visible: true }),
          );
          await waitForSprite(canvas.page, huIdle, 8000);
          await delay(350);
          await plateReset(plate);
          clickAt(bodyPoint.x, bodyPoint.y);
          await waitForSprite(canvas.page, huWave, 6000);
          await waitFor(
            () => messagesSince(canvas, appearMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "窗口初现后指针未移动却未命中身体",
          );
          assert.equal((await plateSnapshot(plate)).pointerdown, 0);
          await waitForSprite(canvas.page, huIdle, 8000);
          caseRecord.appearance.body = "PASS";

          // 窗口移动：同一屏幕点在旧位置是身体、移动后是透明。
          const movedPosition = {
            x: position.x + probe.results["hu-stable"].body.x - probe.results["hu-stable"].transparent.x,
            y: position.y + probe.results["hu-stable"].body.y - probe.results["hu-stable"].transparent.y,
          };
          sendState(
            canvas,
            presentationState(hu, "s07c-move-transparent", { position: movedPosition }),
          );
          await delay(450);
          const movedBounds = latestBounds(canvas);
          assert.ok(
            Math.abs(movedBounds.x - movedPosition.x) <= 2
              && Math.abs(movedBounds.y - movedPosition.y) <= 2,
            "窗口未移动到预期位置",
          );
          const moveMark = messageMark(canvas);
          const movedClick = await clickTransparentAndExpectPlate(plate, bodyPoint);
          assert.equal(movedClick.delta, 1, "窗口移动后原身体屏幕点应变为透明并到达底板");
          await waitNoWave(canvas, moveMark, huIdle);
          caseRecord.move = {
            from: { x: position.x, y: position.y },
            to: movedPosition,
            sameScreenPoint: bodyPoint,
            click: movedClick,
          };

          sendState(
            canvas,
            presentationState(hu, "s07c-restore", { position }),
          );
          await waitForSprite(canvas.page, huIdle, 8000);
          await delay(300);

          caseResults["POL-HIT-002"] = "PASS";
          writeCase("case-POL-HIT-002", null, caseRecord, {
            frame: "PASS（实际 idle 帧 0/7，指针静止）",
            switch: "PASS（Hu↔Cheng 同点透明/身体切换）",
            appearance: "PASS（窗口初现于指针下）",
            move: "PASS（窗口移动后同屏幕点重判）",
            retina: "逻辑点映射由桌面实际 bounds/display.scale 驱动；本机 scaleFactor 见 environment.log",
          });
        } catch (error) {
          caseResults["POL-HIT-002"] = "FAIL";
          caseRecord.diagnostics = await failureDiagnostics(canvas, plate);
          writeCase("case-POL-HIT-002", error, caseRecord);
          throw error;
        }
      }

      // POL-HIT-003：拖拽捕获、透明处不能起拖、全局 ignore 与错误态。
      caseResults["POL-HIT-003"] = "RUNNING";
      {
        const caseRecord = { drag: {}, globalIgnore: {}, errorState: {} };
        try {
          const hu = presentations.hu;
          const stable = probe.results["hu-stable"];
          const huIdle = animationPrefix(hu, "idle");
          const huWave = animationPrefix(hu, "wave");
          await showState(
            canvas,
            presentationState(hu, "s07c-drag-body", { position }),
            huIdle,
          );
          const bounds = latestBounds(canvas);
          const bodyPoint = screenPoint(bounds, stable.body);
          const target = { x: bodyPoint.x + 70, y: bodyPoint.y - 46 };
          await focusPlate(plate);
          await moveTo(bodyPoint.x, bodyPoint.y);
          await delay(300);
          await plateReset(plate);
          const dragMark = messageMark(canvas);
          dragFromTo(bodyPoint, target);
          await delay(500);
          const movedBounds = latestBounds(canvas);
          const dragPlate = await plateSnapshot(plate);
          const dragMessages = messagesSince(canvas, dragMark);
          assert.equal(dragPlate.pointerdown, 0, "身体拖拽不应漏到底板");
          assert.equal(
            dragMessages.some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            false,
            "拖拽不应误触招呼",
          );
          assert.ok(
            movedBounds && (Math.abs(movedBounds.x - bounds.x) > 20
              || Math.abs(movedBounds.y - bounds.y) > 20),
            "拖动后窗口位置未变化",
          );
          const newBounds = movedBounds;

          // 释放后透明区恢复穿透，身体仍可交互。
          const transparentAfterDrag = screenPoint(newBounds, stable.transparent);
          await moveTo(target.x, target.y);
          await delay(250);
          const postDragMark = messageMark(canvas);
          const postDragClick = await clickTransparentAndExpectPlate(plate, transparentAfterDrag);
          assert.equal(postDragClick.delta, 1, "释放后透明区应恢复穿透");
          await waitNoWave(canvas, postDragMark, huIdle);
          await moveTo(newBounds.x + stable.body.x, newBounds.y + stable.body.y);
          await delay(260);
          const postBodyMark = messageMark(canvas);
          await plateReset(plate);
          clickAt(newBounds.x + stable.body.x, newBounds.y + stable.body.y);
          await waitForSprite(canvas.page, huWave, 6000);
          await waitFor(
            () => messagesSince(canvas, postBodyMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "拖拽释放后身体未恢复交互",
          );
          assert.equal((await plateSnapshot(plate)).pointerdown, 0);
          await waitForSprite(canvas.page, huIdle, 8000);
          caseRecord.drag = {
            from: bodyPoint,
            to: target,
            boundsBefore: bounds,
            boundsAfter: newBounds,
            platePointerdown: dragPlate.pointerdown,
            waveNode: false,
            postDragTransparentClick: postDragClick,
            postDragBodyWave: messagesSince(canvas, postBodyMark).filter(
              (message) => message.type === "node-complete" && message.node === "wave",
            ).length,
          };

          // 透明处起拖：底板收到，角色不移动、不招呼。
          const beforeTransparentDrag = latestBounds(canvas);
          const transparentDragStart = {
            x: beforeTransparentDrag.x + stable.transparent.x,
            y: beforeTransparentDrag.y + stable.transparent.y,
          };
          await moveTo(transparentDragStart.x, transparentDragStart.y);
          await delay(250);
          await plateReset(plate);
          const transparentDragMark = messageMark(canvas);
          dragFromTo(transparentDragStart, {
            x: transparentDragStart.x + 36,
            y: transparentDragStart.y + 24,
          });
          await delay(450);
          const afterTransparentDrag = latestBounds(canvas);
          const transparentDragPlate = await plateSnapshot(plate);
          assert.equal(transparentDragPlate.pointerdown, 1, "透明处拖拽应由底板接收一次");
          assert.deepEqual(afterTransparentDrag, beforeTransparentDrag, "透明处拖拽不应移动角色窗口");
          assert.equal(
            messagesSince(canvas, transparentDragMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            false,
          );
          caseRecord.drag.transparentStart = {
            start: transparentDragStart,
            platePointerdown: transparentDragPlate.pointerdown,
            characterBounds: afterTransparentDrag,
          };

          // 拖拽中断的 4 项本地表：隐藏 / 同 displayKey 全局 ignore / 素材 error / 换角色。
          // 每项复用真实 down → dragto → 中断状态 → up，恢复 Hu 后验透明+身体双侧，
          // 再验证旧 token 不影响当前拖拽。不建立通用拖拽框架。
          const interruptionCases = [
            {
              name: "hidden",
              apply: (key) => sendState(
                canvas,
                presentationState(hu, key, { position, visible: false }),
              ),
            },
            {
              name: "ignore",
              sameKeyRecovery: true,
              apply: (key) => sendState(
                canvas,
                presentationState(hu, key, { position, ignoreMouse: true }),
              ),
            },
            {
              name: "error",
              apply: (key) => sendState(canvas, {
                ...presentationState(hu, key, { position }),
                assetState: "error",
                animations: null,
                assetNote: "角色素材加载失败",
              }),
            },
            {
              name: "switch",
              apply: (key) => sendState(
                canvas,
                presentationState(presentations.cheng, `${key}-cheng`, { position }),
              ),
            },
          ];
          const interruptionFacts = {};
          for (const item of interruptionCases) {
            const key = `s07c-interrupt-${item.name}`;
            await showState(canvas, presentationState(hu, key, { position }), huIdle);
            const interruptBounds = latestBounds(canvas);
            const interruptBody = screenPoint(interruptBounds, stable.body);
            const interruptTarget = {
              x: interruptBody.x + 50,
              y: interruptBody.y - 30,
            };
            await focusPlate(plate);
            await moveTo(interruptBody.x, interruptBody.y);
            await delay(300);
            await plateReset(plate);
            const interruptMark = messageMark(canvas);
            pressAt(interruptBody);
            await delay(120);
            dragTo(interruptTarget);
            await delay(300);
            item.apply(key);
            await delay(450);
            releaseAt(interruptTarget);
            await delay(500);
            const interruptPlate = await plateSnapshot(plate);
            assert.equal(
              messagesSince(canvas, interruptMark).some(
                (message) => message.type === "node-complete" && message.node === "wave",
              ),
              false,
              `${item.name} 中断拖拽取消后不应触发招呼`,
            );
            assert.equal(
              interruptPlate.pointerdown,
              0,
              `${item.name} 中断拖拽的按下不应漏到底板`,
            );

            const recoverKey = item.sameKeyRecovery ? key : `${key}-recover`;
            sendState(
              canvas,
              presentationState(hu, recoverKey, { position, ignoreMouse: false }),
            );
            await waitForSprite(canvas.page, huIdle, 8000);
            await delay(420);
            const recoverBounds = latestBounds(canvas);
            const recoverTransparent = screenPoint(recoverBounds, stable.transparent);
            const recoverBody = screenPoint(recoverBounds, stable.body);
            const rendererState = await canvas.page.evaluate(() => ({
              dragging: document.getElementById("stage")?.classList.contains("dragging") ?? true,
              spriteHidden: document.getElementById("sprite")?.hidden ?? true,
            }));
            assert.equal(
              rendererState.dragging,
              false,
              `${item.name} 恢复后仍残留拖拽 class/capture`,
            );
            assert.equal(rendererState.spriteHidden, false, `${item.name} 恢复后角色未显示`);
            const recoverMark = messageMark(canvas);
            const recoverClick = await clickTransparentAndExpectPlate(plate, recoverTransparent);
            assert.equal(recoverClick.delta, 1, `${item.name} 恢复后透明区应到达底板`);
            await waitNoWave(canvas, recoverMark, huIdle);

            await moveTo(recoverBody.x, recoverBody.y);
            await delay(260);
            await plateReset(plate);
            const recoverBodyMark = messageMark(canvas);
            clickAt(recoverBody.x, recoverBody.y);
            await waitForSprite(canvas.page, huWave, 6000);
            await waitFor(
              () => messagesSince(canvas, recoverBodyMark).some(
                (message) => message.type === "node-complete" && message.node === "wave",
              ),
              8000,
              `${item.name} 恢复后身体未恢复招呼`,
            );
            assert.equal(
              (await plateSnapshot(plate)).pointerdown,
              0,
              `${item.name} 恢复后身体点击不应到达底板`,
            );
            await waitForSprite(canvas.page, huIdle, 8000);
            const recoveredBodyWave = messagesSince(canvas, recoverBodyMark).filter(
              (message) => message.type === "node-complete" && message.node === "wave",
            ).length;
            assert.equal(recoveredBodyWave, 1, `${item.name} 恢复后一次身体点击应只有一个 wave`);

            // 旧/伪造 token 的 drag-move 不能移动当前拖拽窗口。
            const staleBounds = latestBounds(canvas);
            const staleBody = screenPoint(staleBounds, stable.body);
            const staleTarget = {
              x: staleBody.x + 28,
              y: staleBody.y - 18,
            };
            await moveTo(staleBody.x, staleBody.y);
            await delay(260);
            const staleMark = messageMark(canvas);
            pressAt(staleBody);
            await delay(120);
            dragTo(staleTarget);
            await delay(280);
            await canvas.page.evaluate(() => window.desktop.dragMove(9999, 9999, 999999));
            await delay(220);
            releaseAt(staleTarget);
            await delay(500);
            const staleAfter = latestBounds(canvas);
            assert.equal(
              messagesSince(canvas, staleMark).some(
                (message) => message.type === "node-complete" && message.node === "wave",
              ),
              false,
              `${item.name} 旧 token 拖拽释放不应招呼`,
            );
            assert.ok(
              Math.abs(staleAfter.x - (staleBounds.x + 28)) <= 2
                && Math.abs(staleAfter.y - (staleBounds.y - 18)) <= 2,
              `${item.name} 旧 token 改变了窗口位置：${JSON.stringify(staleAfter)}`,
            );

            interruptionFacts[item.name] = {
              cancelWave: false,
              cancelPlatePointerdown: interruptPlate.pointerdown,
              recoveredStageDragging: rendererState.dragging,
              recoveredTransparentClick: recoverClick,
              recoveredBodyWave,
              staleToken: {
                from: staleBounds,
                after: staleAfter,
                expected: { x: staleBounds.x + 28, y: staleBounds.y - 18 },
                rejected: true,
              },
            };
          }
          caseRecord.drag.interruptions = interruptionFacts;

          // 全局 ignore 优先于局部命中：身体也不接收。
          await showState(
            canvas,
            presentationState(hu, "s07c-global-ignore", { position }),
            huIdle,
          );
          const ignoreBounds = latestBounds(canvas);
          const ignoreBody = screenPoint(ignoreBounds, stable.body);
          await moveTo(ignoreBody.x, ignoreBody.y);
          await delay(250);
          sendState(
            canvas,
            presentationState(hu, "s07c-global-ignore", {
              position,
              ignoreMouse: true,
            }),
          );
          await delay(450);
          await plateReset(plate);
          const ignoreMark = messageMark(canvas);
          clickAt(ignoreBody.x, ignoreBody.y);
          await delay(500);
          const ignorePlate = await plateSnapshot(plate);
          assert.equal(ignorePlate.pointerdown, 1, "全局 ignore 时身体点击也应到达底板");
          assert.equal(
            messagesSince(canvas, ignoreMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            false,
          );
          sendState(
            canvas,
            presentationState(hu, "s07c-global-restore", { position, ignoreMouse: false }),
          );
          await delay(450);
          const restoreMark = messageMark(canvas);
          await plateReset(plate);
          clickAt(ignoreBody.x, ignoreBody.y);
          await waitForSprite(canvas.page, huWave, 6000);
          await waitFor(
            () => messagesSince(canvas, restoreMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            8000,
            "关闭全局 ignore 后身体未恢复招呼",
          );
          assert.equal((await plateSnapshot(plate)).pointerdown, 0);
          await waitForSprite(canvas.page, huIdle, 8000);
          caseRecord.globalIgnore = {
            clickWhileIgnored: ignorePlate.pointerdown,
            waveWhileIgnored: false,
            waveAfterRestore: messagesSince(canvas, restoreMark).filter(
              (message) => message.type === "node-complete" && message.node === "wave",
            ).length,
          };

          // 资源错误/状态卡：窗口仍可见，但透明区域不能吞点击。
          const errorState = {
            ...presentationState(hu, "s07c-asset-error", { position }),
            assetState: "error",
            animations: null,
            assetNote: "角色素材加载失败",
          };
          sendState(canvas, errorState);
          await waitForStatus(canvas.page);
          await delay(450);
          const errorBounds = latestBounds(canvas);
          const errorPoint = screenPoint(errorBounds, stable.body);
          await moveTo(errorPoint.x, errorPoint.y);
          await delay(250);
          await plateReset(plate);
          const errorMark = messageMark(canvas);
          clickAt(errorPoint.x, errorPoint.y);
          await delay(500);
          const errorPlate = await plateSnapshot(plate);
          assert.equal(errorPlate.pointerdown, 1, "错误状态卡不应吞掉下方点击");
          assert.equal(
            messagesSince(canvas, errorMark).some(
              (message) => message.type === "node-complete" && message.node === "wave",
            ),
            false,
          );
          const statusText = await canvas.page.evaluate(
            () => document.getElementById("status-note")?.textContent ?? "",
          );
          assert.match(statusText, /加载失败|素材/);
          const statusVisible = await canvas.page.evaluate(
            () => document.getElementById("status")?.hidden === false,
          );
          caseRecord.errorState = {
            click: errorPlate.pointerdown,
            waveNode: false,
            statusText,
            statusCardVisible: statusVisible,
          };

          sendState(
            canvas,
            presentationState(hu, "s07c-final", { position }),
          );
          await waitForSprite(canvas.page, huIdle, 8000);

          caseResults["POL-HIT-003"] = "PASS";
          writeCase("case-POL-HIT-003", null, caseRecord, {
            drag: "PASS（真实系统拖拽，捕获期底板 0 次，释放后恢复）",
            transparentStart: "PASS（透明处起拖由底板接收）",
            interruptions: "PASS（隐藏/同 displayKey 全局 ignore/素材 error/换角色 4 项真实按住中断；恢复无残留 capture）",
            staleToken: "PASS（每项中断后旧 token 不影响当前拖拽）",
            globalIgnore: "PASS（全局忽略优先，关闭后恢复）",
            errorState: "PASS（错误状态不吞点击）",
            notificationWindow: "未在本轮重跑；canvas IPC 的 sender/generation 校验由单测覆盖，通知窗口不能控制命中",
            naturalNodes: "本用例只检查一次点击一个 wave 节点；既有日常暂停/恢复由受影响回归另行复验",
          });
        } catch (error) {
          caseResults["POL-HIT-003"] = "FAIL";
          caseRecord.diagnostics = await failureDiagnostics(canvas, plate);
          writeCase("case-POL-HIT-003", error, caseRecord);
          throw error;
        }
      }

      const screenshot = await canvas.page.screenshot({ omitBackground: true }).catch(() => null);
      writeScreenshot("canvas-final.png", screenshot);
      const plateScreenshot = await plate.page.screenshot().catch(() => null);
      writeScreenshot("plate-final.png", plateScreenshot);
    } catch (error) {
      failure = error;
    } finally {
      /* 只清理本轮自建窗口与临时目录；先确认退出，再删除。 */
      const cleanupFacts = {
        canvasPid: null,
        canvasExited: false,
        plateExited: false,
        cursorRestored: false,
        directoriesRemoved: false,
      };
      try {
        if (canvas) {
          fs.writeFileSync(
            path.join(EVIDENCE_DIR, "canvas-output.log"),
            canvas.outputLines.join(""),
          );
          fs.writeFileSync(
            path.join(EVIDENCE_DIR, "renderer-errors.log"),
            JSON.stringify(canvas.pageErrors, null, 2),
          );
          cleanupFacts.canvasPid = canvas.child.pid;
          try {
            canvas.child.stdin.write(`${JSON.stringify({ type: "quit" })}\n`);
            canvas.child.stdin.end();
          } catch {
            // 进程可能已退出。
          }
          const exited = await waitForExit(canvas.child, 6000);
          if (!exited && isAlive(canvas.child.pid)) {
            canvas.child.kill("SIGTERM");
            await waitForExit(canvas.child, 2000);
          }
          if (isAlive(canvas.child.pid)) {
            canvas.child.kill("SIGKILL");
            await waitForExit(canvas.child, 2000);
          }
          cleanupFacts.canvasExited = !isAlive(canvas.child.pid);
          await canvas.browser.close().catch(() => {});
          if (fs.existsSync(canvas.root)) {
            fs.rmSync(canvas.root, { recursive: true, force: true });
          }
          cleanupFacts.canvasProfileRemoved = cleanupFacts.canvasExited
            && !fs.existsSync(canvas.root);
        }
        if (plate) {
          const plateProcess = plate.app.process();
          await Promise.race([
            plate.app.close().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 6000)),
          ]);
          const plateExited = await waitForExit(plateProcess, 3000);
          if (!plateExited && plateProcess && isAlive(plateProcess.pid)) {
            plateProcess.kill("SIGKILL");
            await waitForExit(plateProcess, 2000);
          }
          cleanupFacts.plateExited = !plateProcess || !isAlive(plateProcess.pid);
          if (fs.existsSync(plate.root)) {
            fs.rmSync(plate.root, { recursive: true, force: true });
          }
          cleanupFacts.plateProfileRemoved = cleanupFacts.plateExited
            && !fs.existsSync(plate.root);
        }
        if (inputState.trusted && inputState.cursor) {
          runSystem("restore", inputState.cursor.x, inputState.cursor.y);
          cleanupFacts.cursorRestored = true;
        }
        cleanupFacts.directoriesRemoved = cleanupFacts.canvasProfileRemoved === true
          && cleanupFacts.plateProfileRemoved === true;
      } catch (error) {
        cleanupFacts.error = error.message;
      }
      cleanup = cleanupFacts;
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "summary.log"),
        [
          `# S07c summary`,
          `batch: ${BATCH_ID}`,
          `time: ${new Date().toISOString()}`,
          `overall: ${failure ? "FAIL" : "PASS"}`,
          `cases: ${JSON.stringify(caseResults, null, 2)}`,
          `failure: ${failure ? failure.stack || failure.message : "none"}`,
          `cleanup: ${JSON.stringify(cleanup, null, 2)}`,
          `screenshots: ${JSON.stringify(screenshots)}`,
          `source sha256: source.sha256`,
          `cursor: ${JSON.stringify(inputState.cursor)}`,
          "",
          "## facts",
          JSON.stringify(facts, null, 2),
          "",
          "## coverage boundaries",
          "- 真实系统路由只覆盖本轮自建底板与角色窗口；不点击用户应用。",
          "- 未重跑通知窗口/日常暂停恢复的完整验收；由受影响回归与 IPC 单测负责。",
          "- 本机显示屏缩放与实际逻辑点映射见 environment.log；未在第二块 Retina 屏重复测量。",
          "",
        ].join("\n"),
      );
    }

    if (failure) {
      // 清理失败也写入但不覆盖原始失败。
      if (!cleanup?.canvasExited || !cleanup?.plateExited) {
        failure.message = `${failure.message}；清理未见全部进程退出`;
      }
      throw failure;
    }
    assert.equal(cleanup?.canvasExited, true, "角色画布进程未确认退出");
    assert.equal(cleanup?.plateExited, true, "底板进程未确认退出");
    assert.equal(cleanup?.cursorRestored, true, "用户光标未恢复");
    assert.equal(cleanup?.directoriesRemoved, true, "本轮临时目录未全部删除");
  },
);
