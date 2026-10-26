/* S07b 三角色基础表现验收：真实 Electron 画布与正式主进程、SQLite 活动事实。
   只构造本地数据；不读取 .env、不使用真实模型或来源。 */
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { buildDesktopPresentation } = require("../../app/desktop-assets.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const EVIDENCE_ROOT = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s07b-three-character",
);
function reserveEvidenceBatch(requested) {
  const fallback = `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const base = requested || fallback;
  if (path.basename(base) !== base || base === "." || base === "..") {
    throw new Error(`S07B_EVIDENCE_BATCH 必须是单层目录名：${base}`);
  }
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-r${attempt + 1}`;
    const directory = path.join(EVIDENCE_ROOT, name);
    try {
      // 目录名由调用方指定时也排他创建，不得覆盖历史截图或日志。
      fs.mkdirSync(directory, { recursive: false });
      return { name, directory, requested: requested ?? null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`无法为证据批次生成唯一目录：${base}`);
}

const reservedBatch = reserveEvidenceBatch(process.env.S07B_EVIDENCE_BATCH);
const BATCH_DIR_NAME = reservedBatch.name;
const BATCH_ID = BATCH_DIR_NAME.replace(/^run-/, "");
const EVIDENCE_DIR = reservedBatch.directory;
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    `requested-batch: ${reservedBatch.requested ?? "auto"}`,
    `exclusive-directory: true`,
    `source: tests/acceptance/s07b-three-character.spec.cjs`,
    "http: not-started（仅构造本地数据，不读取 .env）",
    "",
  ].join("\n"),
);

const DB_FILE = "bayper.sqlite3";
const STRETCH_PATTERN = /stretch-pixel-v2-canvas320\/frame-(\d+)\.png/;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 12000, message = "等待条件超时") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) {
      return;
    }
    await delay(30);
  }
  assert.fail(message);
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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

async function closeElectronApp(app, childPid = null) {
  const processHandle = app?.process?.() ?? null;
  let timedOut = false;
  let timeoutTimer = null;
  try {
    await Promise.race([
      app?.close().catch(() => {}),
      new Promise((resolve) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 10000);
      }),
    ]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
  if (timedOut) {
    processHandle?.kill("SIGKILL");
  }
  const exited = await waitForExit(processHandle, 3000);
  const appAlive = Boolean(processHandle && isAlive(processHandle.pid));
  const desktopChildAlive = isAlive(childPid);
  return {
    appPid: processHandle?.pid ?? null,
    desktopPid: Number.isInteger(childPid) ? childPid : null,
    appExitCode: processHandle?.exitCode ?? null,
    appExited: exited && !appAlive && !timedOut,
    desktopChildAlive,
  };
}

function writeCaseLog(
  name,
  failure,
  facts,
  cleanup,
  screenshots,
  consoleLines = [],
  outcome = "PASS",
  coverage = null,
) {
  const cleanupPassed =
    cleanup?.appExited === true
    && cleanup?.appExitCode === 0
    && cleanup?.processesStopped === true
    && cleanup?.desktopChildAlive === false
    && cleanup?.directoryRemoved === true
    && cleanup?.http === "not-started";
  const result = !failure && cleanupPassed ? outcome : "FAIL";
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.log`),
    [
      `# ${name}`,
      `batch: ${BATCH_ID}`,
      `time: ${new Date().toISOString()}`,
      `result: ${result}`,
      `failure: ${failure ? failure.stack || failure.message || String(failure) : "none"}`,
      `cleanup: ${JSON.stringify(cleanup)}`,
      `screenshots: ${JSON.stringify(screenshots)}`,
      ...(coverage ? ["coverage:", JSON.stringify(coverage, null, 2)] : []),
      "",
      "## facts",
      JSON.stringify(facts, null, 2),
      "",
      "## renderer console",
      ...consoleLines,
      "",
    ].join("\n"),
  );
  return result;
}

function removeAndVerify(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    return false;
  }
  return !fs.existsSync(directory);
}

/* ---------- 直接画布：真实 Electron renderer、实际帧路径与窗口几何 ---------- */

async function launchCanvas() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s07b-canvas-"));
  const profileDir = path.join(root, "profile");
  const child = spawn(
    electronPath,
    ["--remote-debugging-port=0", "--remote-allow-origins=*", path.join(repoRoot, "app", "desktop")],
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
    () => outputLines.join("").includes('"type":"channel-ready"'),
    10000,
    "画布通道未就绪",
  );
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 5000 });
  await delay(500);
  return { root, profileDir, child, browser, page, outputLines, pageErrors };
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

async function waitForSprite(page, needle, timeout = 10000) {
  try {
    await page.waitForFunction(
      (expected) => {
        const sprite = document.getElementById("sprite");
        return Boolean(sprite?.src.includes(expected) && sprite?.complete);
      },
      needle,
      { timeout },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      src: document.getElementById("sprite")?.src ?? "",
      complete: document.getElementById("sprite")?.complete ?? false,
      hidden: document.getElementById("sprite")?.hidden ?? true,
      status: document.getElementById("status-note")?.textContent ?? "",
    })).catch(() => ({}));
    throw new Error(`${error.message}；等待 ${needle}；实际 ${JSON.stringify(state)}`);
  }
}

async function canvasMetrics(page) {
  return page.evaluate(() => {
    const sprite = document.getElementById("sprite");
    const status = document.getElementById("status");
    const rect = sprite.getBoundingClientRect();
    return {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      imageWidth: rect.width,
      imageHeight: rect.height,
      left: rect.left,
      top: rect.top,
      src: sprite.src,
      spriteHidden: sprite.hidden,
      statusVisible: !status.hidden,
      statusText: document.getElementById("status-note").textContent,
    };
  });
}

async function captureCanvas(page, name, background) {
  await page.evaluate((color) => {
    document.body.style.background = color;
  }, background);
  await delay(30);
  const file = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: file, omitBackground: background === "transparent" });
  await page.evaluate(() => {
    document.body.style.background = "";
  });
  return file;
}

async function collectFrames(page, segment, durationMs) {
  return page.evaluate(
    ({ expected, duration }) =>
      new Promise((resolve) => {
        const sprite = document.getElementById("sprite");
        const seen = new Set();
        const collect = () => {
          if (!sprite.src.includes(expected)) return;
          const match = /frame-(\d+)\.png/.exec(sprite.src);
          if (match) seen.add(Number(match[1]));
        };
        collect();
        const started = performance.now();
        const timer = setInterval(() => {
          collect();
          if (performance.now() - started >= duration) {
            clearInterval(timer);
            resolve([...seen].sort((a, b) => a - b));
          }
        }, 8);
      }),
    { expected: segment, duration: durationMs },
  );
}

function presentationState(presentation, displayKey, extra = {}) {
  return {
    ...presentation,
    displayKey,
    mode: "companion",
    visible: false,
    ignoreMouse: false,
    position: null,
    ...extra,
  };
}

test("POL-ASSET3-001/002/004/005 三角色真实画布导入、招呼、切换、缺帧与尺寸（透明命中未覆盖）", { timeout: 120000 }, async () => {
  let canvas = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  let cleanup = null;
  try {
    canvas = await launchCanvas();
    const { page } = canvas;
    const presentations = {
      hu: buildDesktopPresentation("hu", "琥珀"),
      cheng: buildDesktopPresentation("cheng", "澄"),
      rin: buildDesktopPresentation("rin", "凛"),
    };
    const expected = {
      hu: { width: 96, height: 128, idle: "idle-pixel-v2-canvas320", wave: "wave-pixel-v3" },
      cheng: {
        width: 100,
        height: 128,
        idle: "idle-pixel-v2-canvas320",
        wave: "wave-pixel-v1-canvas320",
      },
      rin: { width: 88, height: 128, idle: "idle-pixel-v2", wave: "wave-pixel-v1" },
    };

    for (const characterId of ["hu", "cheng", "rin"]) {
      const presentation = presentations[characterId];
      const plan = expected[characterId];
      const idlePath = `characters/${characterId}/animations/${plan.idle}`;
      const wavePath = `characters/${characterId}/animations/${plan.wave}`;
      sendState(canvas, presentationState(presentation, `s07b-${characterId}`));
      await waitForSprite(page, idlePath);
      const metrics = await canvasMetrics(page);
      assert.equal(metrics.windowWidth, plan.width, `${characterId} 窗口宽度`);
      assert.equal(metrics.windowHeight, plan.height, `${characterId} 窗口高度`);
      assert.ok(metrics.imageWidth > metrics.windowWidth, `${characterId} 完整画布应大于窗口可见范围`);
      assert.ok(
        Math.abs(metrics.imageWidth - presentation.animations.display.canvasWidth) < 0.6,
        `${characterId} 图片宽度`,
      );
      assert.ok(
        Math.abs(metrics.imageHeight - presentation.animations.display.canvasHeight) < 0.6,
        `${characterId} 图片高度`,
      );
      assert.ok(metrics.windowHeight <= 128, `${characterId} 本体高度约 128pt`);
      assert.match(metrics.src, new RegExp(`${idlePath}/frame-`));
      assert.equal(metrics.spriteHidden, false);
      screenshots.push(await captureCanvas(page, `canvas-${characterId}-idle-light.png`, "#f2efe7"));
      screenshots.push(await captureCanvas(page, `canvas-${characterId}-idle-dark.png`, "#252525"));

      const before = parsedMessages(canvas).length;
      const framesPromise = collectFrames(page, wavePath, characterId === "hu" ? 1300 : 1800);
      await page.locator("#stage").click({ position: { x: plan.width / 2, y: plan.height / 2 } });
      await page.locator("#stage").click({ position: { x: plan.width / 2, y: plan.height / 2 } });
      await waitForSprite(page, `${wavePath}/frame-01.png`);
      screenshots.push(await captureCanvas(page, `canvas-${characterId}-wave-light.png`, "#f2efe7"));
      screenshots.push(await captureCanvas(page, `canvas-${characterId}-wave-dark.png`, "#252525"));
      const frames = await framesPromise;
      await waitForSprite(page, `${idlePath}/frame-`);
      await waitFor(
        () => parsedMessages(canvas).slice(before).some(
          (message) => message.type === "node-complete" && message.node === "wave",
        ),
        5000,
        `${characterId} 未产生 wave 自然节点`,
      );
      const waveMessages = parsedMessages(canvas).slice(before);
      assert.deepEqual(
        frames,
        Array.from({ length: presentations[characterId].animations.wave.frames.length }, (_, i) => i),
        `${characterId} 未按完整帧序列播放`,
      );
      assert.equal(
        waveMessages.filter((message) => message.node === "wave").length,
        1,
        `${characterId} 不应堆积 wave 节点`,
      );
      facts[characterId] = {
        plan: presentations[characterId].animations.display,
        window: { width: metrics.windowWidth, height: metrics.windowHeight },
        imageCss: { width: metrics.imageWidth, height: metrics.imageHeight },
        idleSrc: metrics.src,
        waveFramePrefix: `${wavePath}/frame-`,
        waveFrames: frames,
        bodyClickStartedWave: true,
      };
    }

    // 播放途中切换角色：旧 wave 回调不得写入新身份。
    sendState(canvas, presentationState(presentations.hu, "s07b-hu-switch"));
    await waitForSprite(page, "characters/hu/animations/idle-pixel-v2-canvas320");
    await page.locator("#stage").click({ position: { x: 48, y: 64 } });
    await waitForSprite(page, "characters/hu/animations/wave-pixel-v3/frame-01.png");
    const switchIndex = parsedMessages(canvas).length;
    sendState(canvas, presentationState(presentations.cheng, "s07b-cheng-switch"));
    await waitForSprite(page, "characters/cheng/animations/idle-pixel-v2-canvas320");
    await delay(1200);
    const afterSwitch = parsedMessages(canvas).slice(switchIndex);
    assert.equal(
      afterSwitch.every(
        (message) => !(message.type === "node-complete" && message.displayKey === "s07b-hu-switch"),
      ),
      true,
      "切换后旧角色不得继续发送自然节点",
    );
    assert.match((await canvasMetrics(page)).src, /cheng\/animations\/idle-pixel-v2-canvas320/);
    facts.switchMidWave = { staleMessages: afterSwitch.length, passed: true };
    screenshots.push(await captureCanvas(page, "canvas-switch-cheng-idle.png", "#f2efe7"));

    // 缺帧：明确进入错误状态，不把 idle 当作完成，也不发送日常完成。
    const broken = structuredClone(presentations.cheng);
    const missingFrame = pathToFileURL(path.join(canvas.root, "missing-frame.png")).href;
    broken.animations.idle.frames[broken.animations.idle.frames.length - 1] = missingFrame;
    const beforeBroken = parsedMessages(canvas).length;
    sendState(canvas, presentationState(broken, "s07b-cheng-broken"));
    await waitFor(
      async () => {
        const metrics = await canvasMetrics(page);
        return metrics.spriteHidden && metrics.statusVisible;
      },
      5000,
      "缺帧时未进入明确错误状态",
    );
    const brokenMetrics = await canvasMetrics(page);
    const brokenMessages = parsedMessages(canvas).slice(beforeBroken);
    assert.match(brokenMetrics.statusText, /加载失败/);
    assert.equal(
      brokenMessages.some(
        (message) => message.type === "node-complete" && message.node === "daily-action-complete",
      ),
      false,
      "缺帧不得冒充日常完成",
    );
    assert.equal(
      brokenMessages.some((message) => message.type === "asset-error"),
      true,
      "缺帧未上报 asset-error",
    );
    facts.missingFrame = {
      statusText: brokenMetrics.statusText,
      spriteHidden: brokenMetrics.spriteHidden,
      assetError: true,
    };
    screenshots.push(await captureCanvas(page, "canvas-cheng-missing-frame.png", "#f2efe7"));

    sendState(canvas, presentationState(presentations.cheng, "s07b-cheng-recover"));
    await waitForSprite(page, "characters/cheng/animations/idle-pixel-v2-canvas320");
    const recovered = await canvasMetrics(page);
    assert.equal(recovered.spriteHidden, false);
    assert.match(recovered.src, /cheng\/animations\/idle-pixel-v2-canvas320/);
    facts.recovered = { src: recovered.src, spriteHidden: recovered.spriteHidden };

    assert.equal(canvas.pageErrors.length, 0, canvas.pageErrors.join("\n"));
    facts.coverage = {
      "POL-ASSET3-001": {
        result: "INCONCLUSIVE",
        import: "PASS",
        "window-crop": "PASS",
        "body-click": "PASS",
        "transparent-hit": "NOT_COVERED",
      },
      "POL-ASSET3-002": { result: "PASS" },
      "POL-ASSET3-004": { result: "PASS" },
      "POL-ASSET3-005": { result: "PASS" },
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (canvas) {
      const appPid = canvas.child.pid;
      await canvas.browser.close().catch(() => {});
      canvas.child.stdin.end();
      const exited = await waitForExit(canvas.child, 3000);
      if (!exited) canvas.child.kill("SIGKILL");
      await waitForExit(canvas.child, 2000);
      await delay(300);
      const childAlive = isAlive(appPid);
      const processesStopped = exited && !childAlive;
      const exitCode = canvas.child.exitCode ?? null;
      const cleanExit = processesStopped && exitCode === 0;
      // 只有确认本轮进程正常退出后才删除临时目录；否则保留现场并 FAIL。
      const directoryRemoved = cleanExit ? removeAndVerify(canvas.root) : false;
      cleanup = {
        appPid,
        desktopPid: null,
        appExitCode: exitCode,
        appExited: processesStopped,
        desktopChildAlive: childAlive,
        processesStopped,
        directoryRemoved,
        directoryRetained: !directoryRemoved && fs.existsSync(canvas.root),
        http: "not-started",
      };
    } else {
      cleanup = {
        appPid: null,
        desktopPid: null,
        appExitCode: 0,
        appExited: true,
        desktopChildAlive: false,
        processesStopped: true,
        directoryRemoved: true,
        directoryRetained: false,
        http: "not-started",
      };
    }
    writeCaseLog(
      "POL-ASSET3-001-002-004-005-canvas",
      failure,
      facts,
      cleanup,
      screenshots,
      canvas?.pageErrors ?? [],
      "INCONCLUSIVE",
      {
        "POL-ASSET3-001": {
          result: "INCONCLUSIVE",
          import: "PASS",
          "window-crop": "PASS",
          "body-click": "PASS",
          "transparent-hit": "NOT_COVERED",
        },
        "POL-ASSET3-002": { result: "PASS" },
        "POL-ASSET3-004": { result: "PASS" },
        "POL-ASSET3-005": { result: "PASS" },
        note: "组合 Case 尚缺透明命中，整体记 INCONCLUSIVE；历史日志不覆写。",
      },
    );
    if (
      !failure
      && (
        !cleanup.processesStopped
        || !cleanup.directoryRemoved
        || !cleanup.appExited
        || cleanup.appExitCode !== 0
        || cleanup.desktopChildAlive
      )
    ) {
      throw new Error(`画布清理失败：${JSON.stringify(cleanup)}`);
    }
  }
});

/* ---------- 正式主进程：真实日常、暂停恢复、退出重开与自然节点 ---------- */

function seedApp(characterId) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s07b-daily-"));
  createStore(dataDir, {
    sourceAnalysis: { getCredentials: async () => null, isEligible: () => true },
  }).close();
  const now = Date.now();
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, 'http://127.0.0.1:9/v1', 's07b-fixture', ?, ?)
    `).run(Buffer.from([1, 2, 3, 4]), new Date(now).toISOString());
    db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
      characterId,
      new Date(now).toISOString(),
    );
    db.prepare(`
      INSERT INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `).run(characterId);
    db.prepare(`
      INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
      VALUES (?, 'companion', ?, 0)
    `).run(characterId, now);
    const state = db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    state.run("fixed_character_id", characterId);
    state.run("current_character_id", characterId);
    state.run("current_mode", "companion");
    state.run("pending_rotation", "0");
    state.run("last_active_at", String(now));
    state.run("desktop_visible", "1");
    state.run("automatic_purpose_cursor", "daily");
    db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', ?)").run(
      localDay(),
      characterId,
    );
  } finally {
    db.close();
  }
  return dataDir;
}

function readDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return {
      activities: db.prepare("SELECT * FROM character_activities ORDER BY created_at").all(),
      stats: db.prepare("SELECT character_id, energy FROM character_stats").all(),
      moments: db
        .prepare(`
          SELECT s.character_id, s.energy, r.last_settled_at, r.mode
          FROM character_stats s JOIN character_runtime r USING (character_id)
          ORDER BY s.character_id
        `)
        .all(),
      relationships: Number(
        db.prepare("SELECT COUNT(*) AS count FROM relationships").get()?.count ?? 0,
      ),
      memory: Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get()?.count ?? 0,
      ),
      energyOf(characterId) {
        return Number(this.stats.find((row) => row.character_id === characterId)?.energy ?? NaN);
      },
    };
  } finally {
    db.close();
  }
}

function setPurpose(dataDir, purpose) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.prepare(`
      INSERT INTO app_state (key, value) VALUES ('automatic_purpose_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(purpose);
  } finally {
    db.close();
  }
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: {
      ...process.env,
      BAYPER_HEARTBEAT_MS: "400",
      CLAUDE_CONFIG_DIR: path.join(dataDir, "no-claude-config"),
      CODEX_HOME: path.join(dataDir, "no-codex-home"),
    },
  });
  const page = await app.firstWindow();
  const consoleLines = [];
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error?.stack || error}`));
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  return { app, page, consoleLines };
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.snapshot;
}

async function installClock(app) {
  await app.evaluate(() => {
    if (globalThis.__s07bClock) return;
    const RealDate = Date;
    globalThis.__s07bClock = { base: RealDate.now(), now: RealDate.now() };
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(globalThis.__s07bClock.now);
        else super(...args);
      }
      static now() {
        return globalThis.__s07bClock.now;
      }
    };
  });
}

async function patchClock(app, offsetMs, randomValue = 0.1) {
  await installClock(app);
  await app.evaluate(
    (_electron, input) => {
      globalThis.__s07bClock.now = globalThis.__s07bClock.base + input.offset;
      Math.random = () => input.random;
    },
    { offset: offsetMs, random: randomValue },
  );
}

async function patchClockAt(app, epochMs, randomValue = 0.1) {
  await installClock(app);
  await app.evaluate(
    (_electron, input) => {
      globalThis.__s07bClock.now = input.at;
      Math.random = () => input.random;
    },
    { at: epochMs, random: randomValue },
  );
}

async function waitDesktopReady(page, characterId, activityId = null) {
  await waitFor(
    async () => {
      const snapshot = await getSnapshot(page);
      return (
        snapshot.desktop?.state === "running"
        && snapshot.desktop?.assetState === "ready"
        && snapshot.desktop?.characterId === characterId
        && (!activityId || snapshot.desktop?.activity?.activityId === activityId)
      );
    },
    20000,
    `${characterId} 桌面未就绪`,
  );
}

function stretchFrameIndex(snapshot) {
  const match = STRETCH_PATTERN.exec(snapshot.desktop?.displayedFrame ?? "");
  return match ? Number(match[1]) : null;
}

async function waitStretchFrame(page, minimum, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const index = stretchFrameIndex(await getSnapshot(page));
    if (index !== null && index >= minimum) return index;
    await delay(20);
  }
  return null;
}

function captureDesktop(snapshot, name) {
  const bounds = snapshot.desktop?.bounds;
  if (!bounds) return null;
  const file = path.join(EVIDENCE_DIR, name);
  try {
    execFileSync("screencapture", ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, file], {
      timeout: 5000,
    });
    return file;
  } catch (error) {
    fs.writeFileSync(`${file}.error.txt`, String(error?.message || error));
    return null;
  }
}

async function runDailyCase(characterId, pauseKind, screenshots, facts) {
  const dataDir = seedApp(characterId);
  let launched = null;
  let app = null;
  let page = null;
  let desktopPid = null;
  let exit = null;
  let failure = null;
  const processRounds = [];
  const recordRound = (phase) => {
    const round = {
      phase,
      appPid: app?.process?.()?.pid ?? null,
      desktopPid,
      exit: null,
    };
    processRounds.push(round);
    return round;
  };
  try {
    launched = await launchApp(dataDir);
    ({ app, page } = launched);
    await waitDesktopReady(page, characterId);
    const initialSnapshot = await getSnapshot(page);
    desktopPid = initialSnapshot.desktop?.pid ?? null;
    const initialRound = recordRound("initial");
    const beforeDaily = readDb(dataDir);
    const energyBefore = beforeDaily.energyOf(characterId);
    const momentBefore = beforeDaily.moments.find((row) => row.character_id === characterId);
    const homeImage = await page.evaluate(() => {
      const image = document.getElementById("home-image");
      return { src: image.src, loaded: image.complete && image.naturalWidth > 0 };
    });
    const assetLabel = (await getSnapshot(page)).desktop?.assetLabel ?? "";
    assert.equal(assetLabel, "idle/wave/stretch 候选");
    assert.match(homeImage.src, /characters\/hu\/source\/master-pixel-v2|characters\/cheng\/source\/master-pixel-v1/);
    assert.equal(homeImage.loaded, true, "主窗口角色预览未加载");
    const homeShot = path.join(EVIDENCE_DIR, `daily-${characterId}-home.png`);
    await page.screenshot({ path: homeShot });
    screenshots.push(homeShot);

    await waitFor(
      async () => (await getSnapshot(page)).desktop?.lastNode === "idle-loop",
      12000,
      "画布未产生待机自然节点",
    );
    setPurpose(dataDir, "daily");
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await waitFor(
      () => readDb(dataDir).activities.some((activity) => activity.status === "running"),
      15000,
      `${characterId} 日常未开始`,
    );
    const started = readDb(dataDir);
    assert.equal(started.activities.length, 1, "只应建立一个日常活动");
    const activityId = started.activities[0].activity_id;
    const startedAt = started.activities[0].started_at;
    const energyAfterStart = started.energyOf(characterId);
    const momentAfterStart = started.moments.find((row) => row.character_id === characterId);
    const normalHours = (Number(momentAfterStart.last_settled_at) - Number(momentBefore.last_settled_at)) / 3600000;
    const expectedAfterStart = Math.round(
      Math.max(0, Math.min(100, energyBefore + -6 * normalHours - 2)) * 1000,
    ) / 1000;
    assert.ok(
      Math.abs(energyAfterStart - expectedAfterStart) <= 0.02,
      `首次日常精力应只扣一次并结算正常陪伴：实际 ${energyAfterStart}，预期 ${expectedAfterStart}`,
    );
    await waitDesktopReady(page, characterId, activityId);
    await waitFor(
      async () => {
        const index = stretchFrameIndex(await getSnapshot(page));
        return index !== null && index >= 2;
      },
      8000,
      `${characterId} 未播放自身伸展`,
    );
    let snapshot = await getSnapshot(page);
    assert.match(snapshot.desktop.displayedFrame, new RegExp(`characters/${characterId}/.*stretch-pixel-v2-canvas320/frame-`));
    const stretchFramePath = snapshot.desktop.displayedFrame;
    const stretchShot = path.join(EVIDENCE_DIR, `daily-${characterId}-stretch.png`);
    await page.screenshot({ path: stretchShot });
    screenshots.push(stretchShot);
    screenshots.push(captureDesktop(snapshot, `daily-${characterId}-stretch-native.png`));

    if (pauseKind === "chat") {
      const opened = await page.evaluate((id) => window.bayperChat.openChat(id), characterId);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      await waitFor(
        () => readDb(dataDir).activities[0]?.status === "paused",
        4000,
        "聊天未暂停日常",
      );
    } else {
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
      await waitFor(
        () => readDb(dataDir).activities[0]?.status === "paused",
        4000,
        "锁屏未暂停日常",
      );
    }
    const paused1 = readDb(dataDir).activities[0];
    assert.equal(paused1.activity_id, activityId);
    assert.ok(paused1.action_frame >= 2);
    assert.equal(paused1.action_completed_at, null);

    if (pauseKind === "chat") {
      await page.evaluate(() => window.bayperChat.closeChat());
    } else {
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    }
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running"
        && readDb(dataDir).activities[0]?.activity_id === activityId,
      6000,
      "首次恢复未回到同 ID",
    );
    const firstResume = await waitStretchFrame(page, paused1.action_frame);
    assert.notEqual(firstResume, null, "首次恢复后未观察到续播帧");
    assert.ok(firstResume >= paused1.action_frame);
    const firstResumePath = (await getSnapshot(page)).desktop?.displayedFrame ?? "";

    // 第二次中断后退出：进程清理后重开，仍沿同 ID 与持久帧续播。
    if (pauseKind === "chat") {
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    } else {
      const opened = await page.evaluate((id) => window.bayperChat.openChat(id), characterId);
      assert.equal(opened.ok, true, JSON.stringify(opened));
    }
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      5000,
      "第二次中断未暂停",
    );
    const paused2 = readDb(dataDir).activities[0];
    assert.equal(paused2.activity_id, activityId);
    assert.ok(paused2.action_frame > 0 && paused2.action_frame < 8);
    desktopPid = (await getSnapshot(page)).desktop.pid;
    exit = await closeElectronApp(app, desktopPid);
    app = null;
    initialRound.exit = exit;
    launched.exit = exit;
    assert.equal(exit.appExited, true, "应用未退出");
    assert.equal(exit.appExitCode, 0, `应用退出码 ${exit.appExitCode}`);
    assert.equal(exit.desktopChildAlive, false, "桌面子进程未退出");
    const exitedActivity = readDb(dataDir).activities[0];
    assert.equal(exitedActivity.activity_id, activityId);
    assert.equal(exitedActivity.status, "paused");
    const resumeProgress = exitedActivity.action_frame;
    assert.ok(resumeProgress > 0 && resumeProgress < 8);

    launched = await launchApp(dataDir);
    ({ app, page } = launched);
    await waitDesktopReady(page, characterId, activityId);
    desktopPid = (await getSnapshot(page)).desktop?.pid ?? null;
    recordRound("restart");
    await waitFor(
      async () => stretchFrameIndex(await getSnapshot(page)) !== null,
      12000,
      "重开后未恢复伸展",
    );
    const restartFrame = await waitStretchFrame(page, resumeProgress, 8000);
    assert.notEqual(restartFrame, null, "重开未从持久帧续播");
    assert.ok(restartFrame >= resumeProgress);
    const restartFramePath = (await getSnapshot(page)).desktop?.displayedFrame ?? "";
    await patchClockAt(app, startedAt + 9000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.action_completed_at !== null,
      8000,
      "动作未在真实播放后完成",
    );
    assert.equal(readDb(dataDir).activities[0].status, "running", "动作完成但有效时长未满不得收束");
    await patchClockAt(app, startedAt + 20000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "completed",
      8000,
      "动作与时长满足后未收束",
    );
    const completed = readDb(dataDir).activities[0];
    assert.equal(completed.activity_id, activityId);
    assert.equal(completed.action_frame, 8);
    assert.equal(completed.active_elapsed_ms, 10000);
    assert.equal(completed.character_id, characterId);
    assert.equal(readDb(dataDir).activities.length, 1, "暂停/重开不得创建第二个活动");
    const finalDb = readDb(dataDir);
    const energyAfterComplete = finalDb.energyOf(characterId);
    assert.ok(
      Math.abs(energyAfterComplete - energyAfterStart) <= 0.001,
      `暂停/重启不得重复扣除或凭空增加精力：开始 ${energyAfterStart}，完成 ${energyAfterComplete}`,
    );
    assert.equal(finalDb.relationships, 1, "恢复不得重建关系");
    assert.equal(finalDb.memory, 0, "恢复不得新增记忆");
    await waitFor(
      async () => (await getSnapshot(page)).desktop?.lastNode === "idle-loop",
      8000,
      "活动结束后未回待机",
    );
    snapshot = await getSnapshot(page);
    assert.equal(snapshot.companionship.current.characterId, characterId);
    assert.equal(snapshot.companionship.current.activity ?? null, null);
    const completedShot = path.join(EVIDENCE_DIR, `daily-${characterId}-completed.png`);
    await page.screenshot({ path: completedShot });
    screenshots.push(completedShot);
    screenshots.push(captureDesktop(snapshot, `daily-${characterId}-completed-native.png`));
    facts[characterId] = {
      activityId,
      pauseKind,
      paused1,
      stretchFramePath,
      firstResume,
      firstResumePath,
      paused2,
      resumeProgress,
      restartFrame,
      restartFramePath,
      completed,
      homeImage,
      assetLabel,
      energyBefore,
      expectedAfterStart,
      energyAfterStart,
      energyAfterComplete,
      processRounds,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (app) {
      const current = await getSnapshot(page).catch(() => null);
      if (current?.desktop?.pid) desktopPid = current.desktop.pid;
      exit = await closeElectronApp(app, desktopPid).catch((error) => ({
        appPid: app?.process?.()?.pid ?? null,
        desktopPid,
        appExitCode: null,
        appExited: false,
        desktopChildAlive: isAlive(desktopPid),
        error: error?.message,
      }));
      launched.exit = exit;
    }
    const lastRound = processRounds[processRounds.length - 1] ?? null;
    if (lastRound) {
      lastRound.appPid = exit?.appPid ?? lastRound.appPid;
      lastRound.desktopPid = exit?.desktopPid ?? desktopPid;
      lastRound.exit = exit ?? lastRound.exit;
    }
    const processesStopped =
      exit?.appExited === true
      && exit?.appExitCode === 0
      && exit?.desktopChildAlive === false;
    // 只有当前父子进程均确认退出且退出码为 0 才清理目录；失败保留现场。
    const directoryRemoved = processesStopped ? removeAndVerify(dataDir) : false;
    const cleanup = {
      appPid: exit?.appPid ?? lastRound?.appPid ?? null,
      desktopPid: exit?.desktopPid ?? desktopPid,
      appExitCode: exit?.appExitCode ?? null,
      appExited: exit?.appExited === true,
      desktopChildAlive: exit?.desktopChildAlive === true,
      processesStopped,
      directoryRemoved,
      directoryRetained: !directoryRemoved && fs.existsSync(dataDir),
      processRounds,
      http: "not-started",
    };
    const caseFacts = {
      ...(facts[characterId] ?? {}),
      processRounds,
    };
    writeCaseLog(
      `POL-ASSET3-003-${characterId}`,
      failure,
      caseFacts,
      cleanup,
      screenshots,
      launched?.consoleLines ?? [],
    );
    if (
      !failure
      && (
        !cleanup.processesStopped
        || !cleanup.appExited
        || cleanup.appExitCode !== 0
        || cleanup.desktopChildAlive
        || !directoryRemoved
      )
    ) {
      throw new Error(`日常 ${characterId} 清理失败：${JSON.stringify(cleanup)}`);
    }
  }
}

test("POL-ASSET3-003 琥珀与澄真实日常伸展、暂停恢复与退出重开", { timeout: 240000 }, async () => {
  const screenshots = [];
  const facts = {};
  await runDailyCase("hu", "chat", screenshots, facts);
  await runDailyCase("cheng", "system", screenshots, facts);
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "POL-ASSET3-003-summary.json"),
    `${JSON.stringify({ batch: BATCH_ID, screenshots, facts }, null, 2)}\n`,
  );
});
