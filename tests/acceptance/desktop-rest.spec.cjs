/* S07 休息运行时验收：真实桌面应用、真实子窗口和真实控件。
   本文件只允许 Codex 排他执行 GUI；Claude 仅做语法与非 GUI 检查。
   事实通知由本机 SQLite 受控行驱动正式通知队列，不冒充 Herdr 来源。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { startModelServer } = require("./fixture-server.cjs");
const { buildDesktopPresentation } = require("../../app/desktop-assets.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceRoot = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s07-rest-runtime",
);
const DB_FILE = "bayper.sqlite3";
const SIT_DIRECTORY = "sit-pixel-v2-canvas256";

function reserveEvidenceBatch(requested) {
  const fallback = `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const base = requested || fallback;
  if (path.basename(base) !== base || base === "." || base === "..") {
    throw new Error(`S07_REST_EVIDENCE_BATCH 必须是单层目录名：${base}`);
  }
  fs.mkdirSync(evidenceRoot, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-r${attempt + 1}`;
    const directory = path.join(evidenceRoot, name);
    try {
      fs.mkdirSync(directory, { recursive: false });
      return { name, directory };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`无法为证据批次生成唯一目录：${base}`);
}

const reservedBatch = reserveEvidenceBatch(process.env.S07_REST_EVIDENCE_BATCH);
const BATCH_ID = reservedBatch.name;
const EVIDENCE_DIR = reservedBatch.directory;
const SOURCE_FILES = [
  "app/main.cjs",
  "app/desktop-assets.cjs",
  "app/desktop/main.cjs",
  "app/desktop/renderer/canvas-app.js",
  "tests/acceptance/desktop-rest.spec.cjs",
  "tests/unit/desktop-assets.test.cjs",
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
  path.join(EVIDENCE_DIR, "source.sha256"),
  `${sourceDigest()}\n`,
);
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    "source: tests/acceptance/desktop-rest.spec.cjs",
    "gui: 仅由 Codex 排他执行；本文件不替代用户人工体验",
    "notification: 本机 SQLite 受控事件行，驱动正式通知队列；非真实 Herdr 来源",
    "rest-settled: 本次 restToken + displayKey + generation + 末帧匹配才视为收束",
    "no-sit: Hu/Cheng 休息继续 idle 循环，换人沿既有自然节点，不等 rest-settled",
    "rest-stand: 复用 sit-pixel-v2-canvas256 逆序，不是新绘制起身素材",
    "transparent-hit: 由既有 s07c-transparent-input 回归覆盖，不重复物理点击",
    "",
    "## source sha256",
    sourceDigest(),
    "",
  ].join("\n"),
);

const caseResults = {};
const screenshots = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout, message) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await predicate();
    if (last) return last;
    await delay(30);
  }
  assert.fail(`${message}：${JSON.stringify(last)}`);
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-rest-"));
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function launchApp(dataDir) {
  const profilePort = path.join(dataDir, "desktop-profile", "DevToolsActivePort");
  fs.rmSync(profilePort, { force: true });
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: {
      ...process.env,
      BAYPER_HEARTBEAT_MS: "400",
      BAYPER_DESKTOP_DEBUG_PORT: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function connectCanvas(dataDir) {
  const profileDir = path.join(dataDir, "desktop-profile");
  const portFile = path.join(profileDir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile), 15000, "画布调试端口未生成");
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await waitFor(() => {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("/app/desktop/renderer/index.html"));
    return Boolean(page);
  }, 15000, "未找到画布 renderer");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 5000 });
  await delay(300);
  return { browser, page };
}

async function completeOnboarding(page, baseUrl) {
  await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-model");
  await page.locator("#api-key").fill("sk-fixture-ok");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function waitForSnapshot(page, predicate, timeout = 15000) {
  return waitFor(
    async () => {
      const snapshot = await getSnapshot(page);
      return predicate(snapshot) ? snapshot : null;
    },
    timeout,
    "快照条件超时",
  );
}

async function waitDesktopReady(page) {
  return waitForSnapshot(
    page,
    (value) =>
      value.desktop?.state === "running"
      && value.desktop?.assetState === "ready"
      && value.desktop?.lastNode === "idle-loop",
    15000,
  );
}

async function waitResting(page) {
  return waitForSnapshot(
    page,
    (value) =>
      value.companionship?.current?.source === "resting"
      && value.companionship?.current?.mode === "resting",
    15000,
  );
}

async function waitRestSettled(page, timeout = 8000) {
  return waitForSnapshot(
    page,
    (value) => {
      const token = value.desktop?.restToken;
      return Number.isInteger(token)
        && token > 0
        && value.desktop?.restSettledToken === token
        && Number.isInteger(value.desktop?.restSettledAt);
    },
    timeout,
  );
}

async function openChat(page) {
  await page
    .locator('.roster-row[data-character-id="rin"] button[data-action="chat"]')
    .click();
  await page.locator("#chat-panel").waitFor({ state: "visible", timeout: 10000 });
  return waitForSnapshot(
    page,
    (value) => value.companionship?.current?.mode === "interacting",
    10000,
  );
}

async function closeChat(page) {
  await page.locator("#chat-close").click();
  await page.locator("#chat-panel").waitFor({ state: "hidden", timeout: 10000 });
  return waitForSnapshot(
    page,
    (value) => value.companionship?.current?.mode === "resting",
    15000,
  );
}

function installSitRecorder(page) {
  return page.evaluate((directory) => {
    const sprite = document.getElementById("sprite");
    const frames = [];
    const record = () => {
      const match = new RegExp(`/${directory}/frame-(\\d+)\\.png$`).exec(sprite?.src ?? "");
      if (!match) return;
      const index = Number(match[1]);
      if (frames[frames.length - 1] !== index) frames.push(index);
    };
    new MutationObserver(record).observe(sprite, {
      attributes: true,
      attributeFilter: ["src"],
    });
    record();
    window.__sitFrames = frames;
  }, SIT_DIRECTORY);
}

async function sitFrames(page) {
  return page.evaluate(() => [...(window.__sitFrames ?? [])]);
}

async function resetSitRecorder(page) {
  await page.evaluate(() => {
    if (Array.isArray(window.__sitFrames)) window.__sitFrames.length = 0;
  });
}

async function spriteSrc(page) {
  return page.evaluate(() => document.getElementById("sprite")?.src ?? "");
}

async function waitSitSettled(page) {
  return waitFor(
    async () => {
      const frames = await sitFrames(page);
      const src = await spriteSrc(page);
      return frames[frames.length - 1] === 7 && src.includes(`/${SIT_DIRECTORY}/frame-07.png`)
        ? frames
        : null;
    },
    12000,
    "坐姿未停在第 8 帧",
  );
}

async function readCanvasDom(page) {
  return page.evaluate(() => {
    const sprite = document.getElementById("sprite");
    return {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      width: Number.parseFloat(sprite.style.width),
      height: Number.parseFloat(sprite.style.height),
      left: Number.parseFloat(sprite.style.left),
      top: Number.parseFloat(sprite.style.top),
      src: sprite.src,
      hidden: sprite.hidden,
    };
  });
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${label}：${actual} != ${expected}`);
}

function readPersistedState(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    const currentMode = db
      .prepare("SELECT value FROM app_state WHERE key = 'current_mode'")
      .get()?.value ?? null;
    const rin = db
      .prepare("SELECT mode FROM character_runtime WHERE character_id = 'rin'")
      .get()?.mode ?? null;
    const pendingEvents = db
      .prepare("SELECT COUNT(*) AS count FROM connector_events WHERE notification_status = 'pending'")
      .get()?.count ?? 0;
    return { currentMode, rin, pendingEvents };
  } finally {
    db.close();
  }
}

function seedHuCompanion(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("UPDATE character_stats SET energy = 100 WHERE character_id = 'rin'").run();
    db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
      "hu",
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES ('hu', 10, 100, 0)",
    ).run();
    const day = localDay();
    db.prepare("DELETE FROM roster WHERE day = ?").run(day);
    db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', 'rin')").run(day);
    db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'random_1', 'hu')").run(day);
  } finally {
    db.close();
  }
}

/* 只插入一条受控事实行，走正式 pending→presentation→子窗口链路。 */
function insertFactNotification(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const now = Date.now();
    db.prepare(`
      INSERT INTO connector_events (
        app_run_id, instance_id, run_id, agent_id, kind, state, raw_state,
        priority, original_priority, historical, notification_status, received_at, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
    `).run(
      "app-s07-rest-fixture",
      "s07-rest-fixture",
      "run-s07-rest",
      null,
      "state",
      "working",
      "working",
      1,
      1,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

/* 从当前真实帧 alpha 找身体内点；不使用 DOM 点击冒充透明穿透证据。 */
async function findBodyPoint(app, displayedFrame, display) {
  const framePath = fileURLToPath(new URL(displayedFrame));
  const point = await app.evaluate(({ nativeImage }, input) => {
    const image = nativeImage.createFromPath(input.framePath);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const { scale, offsetX, offsetY, windowWidth, windowHeight } = input.display;
    for (let y = Math.floor(size.height * 0.4); y < size.height * 0.82; y += 2) {
      for (let x = Math.floor(size.width * 0.3); x < size.width * 0.7; x += 2) {
        if (bitmap[(y * size.width + x) * 4 + 3] < 200) continue;
        const localX = (x + 0.5) * scale - offsetX;
        const localY = (y + 0.5) * scale - offsetY;
        if (localX > 4 && localX < windowWidth - 4 && localY > 4 && localY < windowHeight - 4) {
          return { x: localX, y: localY };
        }
      }
    }
    return null;
  }, { framePath, display });
  assert.ok(point, "未能在当前坐姿帧中找到身体采样点");
  return point;
}

function desktopProcesses() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(electronPath) && line.endsWith("/app/desktop"))
    .map((line) => {
      const [pid, ppid] = line.split(/\s+/, 3);
      return { pid: Number(pid), ppid: Number(ppid) };
    });
}

async function capture(page, canvasPage, name) {
  const target = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: target });
  screenshots.push(name);
  if (canvasPage) {
    const canvasName = name.replace(/\.png$/, "-canvas.png");
    await canvasPage.screenshot({ path: path.join(EVIDENCE_DIR, canvasName) });
    screenshots.push(canvasName);
  }
}

function writeCase(name, facts) {
  caseResults[name] = facts;
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.json`),
    `${JSON.stringify(facts, null, 2)}\n`,
  );
}

async function teardown({ app, browser, server, dataDir, name, facts, error }) {
  const cleanup = { appClosed: false, browserClosed: false, httpClosed: false, tempRemoved: false };
  if (dataDir) {
    try {
      facts.persisted = readPersistedState(dataDir);
    } catch (readError) {
      facts.persisted = { error: readError.message };
    }
  }
  if (app) {
    await app.close().catch(() => {});
    cleanup.appClosed = true;
  }
  if (browser) {
    await browser.close().catch(() => {});
    cleanup.browserClosed = true;
  }
  if (server) {
    facts.http = {
      baseUrl: server.baseUrl,
      completions: server.requests.length,
      requests: server.allRequests.length,
    };
    await server.close().catch(() => {});
    cleanup.httpClosed = true;
  }
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    cleanup.tempRemoved = !fs.existsSync(dataDir);
  }
  facts.cleanup = cleanup;
  facts.processesAfterClose = desktopProcesses();
  if (error) facts.failure = error.stack || String(error);
  writeCase(name, facts);
}

async function setupContext(resources, { withHu = false } = {}) {
  const dataDir = makeDataDir();
  resources.dataDir = dataDir;
  const server = await startModelServer();
  resources.server = server;
  let { app, page } = await launchApp(dataDir);
  resources.app = app;
  await completeOnboarding(page, server.baseUrl);
  await waitDesktopReady(page);
  if (withHu) {
    await app.close();
    resources.app = null;
    seedHuCompanion(dataDir);
    ({ app, page } = await launchApp(dataDir));
    resources.app = app;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin"
        && value.desktop?.assetState === "ready"
        && value.companionship?.roster?.some((entry) => entry.characterId === "hu"),
      15000,
    );
  }
  const canvas = await connectCanvas(dataDir);
  resources.browser = canvas.browser;
  return { app, page, server, dataDir, canvas };
}

test("POL-RESTUI-001 真实点击安静休息播放 8 坐帧并停末帧", { timeout: 180000 }, async (t) => {
  const name = "POL-RESTUI-001";
  const facts = { case: name, batch: BATCH_ID, frames: [], screenshots: [] };
  const shotStart = screenshots.length;
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let canvasPage = null;
  let error = null;
  try {
    const ctx = await setupContext(resources);
    canvasPage = ctx.canvas.page;
    const { page, app } = ctx;

    const plan = buildDesktopPresentation("rin", "凛").animations.display;
    const before = await getSnapshot(page);
    assert.equal(before.companionship.current.mode, "companion");
    assert.notEqual(before.companionship.current.source, "resting");
    await installSitRecorder(canvasPage);
    await page.locator("#rest-companion").click();
    const resting = await waitResting(page);
    const frames = await waitSitSettled(canvasPage);
    // 以本次 token 的真实播放收束节点而非固定延时判定稳定静坐。
    const settled = await waitRestSettled(page);
    facts.frames = frames;
    facts.processes = desktopProcesses();
    facts.presentation = plan;
    facts.resting = {
      source: resting.companionship.current.source,
      mode: resting.companionship.current.mode,
      activity: resting.companionship.current.activity ?? null,
    };
    assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7], "必须逐帧播放全部坐下帧");

    const status = settled.desktop;
    assert.equal(status.bounds.width, plan.windowWidth);
    assert.equal(status.bounds.height, plan.windowHeight);
    assert.ok(status.bounds.width <= 128 && status.bounds.height <= 128);
    assert.equal(status.windowType, "panel");
    assert.equal(status.focusable, false);
    assert.equal(status.transparent, true);
    assert.match(status.displayedFrame, /sit-pixel-v2-canvas256\/frame-07\.png$/);
    const dom = await readCanvasDom(canvasPage);
    assert.equal(dom.hidden, false);
    assertClose(dom.width, plan.canvasWidth, "画布宽");
    assertClose(dom.height, plan.canvasHeight, "画布高");
    assertClose(dom.left, -plan.offsetX, "画布左偏移");
    assertClose(dom.top, -plan.offsetY, "画布上偏移");
    assertClose(dom.windowWidth, plan.windowWidth, "窗口宽");
    assertClose(dom.windowHeight, plan.windowHeight, "窗口高");
    facts.geometry = { dom, bounds: status.bounds };

    // 2 秒以上保持静坐：不回 idle、不伸展、不再产生自然节点。
    const nodeAt = status.lastNodeAt;
    await delay(2400);
    const held = await getSnapshot(page);
    facts.held = {
      lastNode: held.desktop.lastNode,
      lastNodeAt: held.desktop.lastNodeAt,
      displayedFrame: held.desktop.displayedFrame,
      mode: held.companionship.current.mode,
    };
    assert.equal(held.desktop.lastNodeAt, nodeAt, "静坐期间不应产生新的 idle/伸展节点");
    assert.match(held.desktop.displayedFrame, /sit-pixel-v2-canvas256\/frame-07\.png$/);
    assert.equal(held.companionship.current.mode, "resting");
    assert.equal(await spriteSrc(canvasPage), held.desktop.displayedFrame);
    assert.deepEqual(await sitFrames(canvasPage), [0, 1, 2, 3, 4, 5, 6, 7]);

    await capture(page, canvasPage, `${name}-rest-settled.png`);
    facts.screenshots = screenshots.slice(shotStart);
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-RESTUI-002 坐下过渡中聊天并关闭后保持静坐原意", { timeout: 180000 }, async (t) => {
  const name = "POL-RESTUI-002";
  const facts = { case: name, batch: BATCH_ID, frames: [], screenshots: [] };
  const shotStart = screenshots.length;
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let canvasPage = null;
  let error = null;
  try {
    const ctx = await setupContext(resources, { withHu: true });
    canvasPage = ctx.canvas.page;
    const { page, app } = ctx;

    await installSitRecorder(canvasPage);
    await page.locator("#rest-companion").click();
    await waitResting(page);
    // 过渡中触发聊天，而不是等坐姿完全结束。
    await waitFor(
      async () => (await sitFrames(canvasPage)).length >= 2,
      8000,
      "坐下过渡未开始",
    );
    const duringTransition = await sitFrames(canvasPage);
    const chat = await openChat(page);
    facts.transition = {
      framesAtChatOpen: duringTransition,
      chatMode: chat.companionship.current.mode,
      desktopMode: chat.desktop.mode,
    };
    assert.equal(chat.companionship.current.mode, "interacting");
    assert.equal(chat.desktop.mode, "interacting");

    const frames = await waitSitSettled(canvasPage);
    assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7], "聊天期间坐姿应自然完成");
    await capture(page, canvasPage, `${name}-chat-during-rest.png`);

    const resumed = await closeChat(page);
    await waitSitSettled(canvasPage);
    // 退出互动后也等本次 token 的真实收束，避免下面读取旧完成时间。
    await waitRestSettled(page);
    const countAtClose = (await sitFrames(canvasPage)).length;
    const frameAtClose = await spriteSrc(canvasPage);
    await delay(1600);
    const after = await getSnapshot(page);
    const countAfter = (await sitFrames(canvasPage)).length;
    facts.afterChat = {
      mode: resumed.companionship.current.mode,
      source: resumed.companionship.current.source,
      activity: after.companionship.current.activity ?? null,
      pendingRotation: after.companionship.pendingRotation,
      framesAtClose: countAtClose,
      framesAfter: countAfter,
      displayedFrame: after.desktop.displayedFrame,
    };
    assert.equal(after.companionship.current.mode, "resting", "退出聊天必须恢复休息原意");
    assert.equal(after.companionship.current.source, "resting");
    assert.equal(after.companionship.current.activity ?? null, null, "休息不得伪造成活动完成");
    assert.equal(after.companionship.pendingRotation, false, "休息不应造成永久交接等待");
    assert.equal(countAfter, countAtClose, "退出聊天不得重新从第 0 帧坐下");
    assert.equal(await spriteSrc(canvasPage), frameAtClose);
    assert.match(after.desktop.displayedFrame, /sit-pixel-v2-canvas256\/frame-07\.png$/);
    assert.equal(after.desktop.displayedFrame, frameAtClose);

    await capture(page, canvasPage, `${name}-rest-resumed.png`);

    // 继续陪伴：复用坐下帧逆序作为起身过渡，短节点完成后回待机；不是新素材。
    await waitRestSettled(page);
    await page.waitForFunction(
      () => document.getElementById("rest-companion")?.dataset.action === "wake",
      null,
      { timeout: 5000 },
    );
    await page.locator("#rest-companion").click();
    const standNode = await waitForSnapshot(
      page,
      (value) => value.desktop?.lastNode === "rest-stand",
      15000,
    );
    const woke = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.mode === "companion"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2/frame-"),
      15000,
    );
    const standFrames = (await sitFrames(canvasPage)).slice(countAtClose);
    facts.standUp = {
      reuse: "sit-pixel-v2-canvas256 逆序",
      newArt: false,
      node: standNode.desktop.lastNode,
      nodeAt: standNode.desktop.lastNodeAt,
      frames: standFrames,
    };
    assert.ok(standFrames.length >= 6, "起身过渡应复用完整坐下帧");
    assert.deepEqual(
      [...standFrames].sort((a, b) => b - a),
      standFrames,
      "起身必须按坐下帧逆序播放",
    );
    assert.equal(standFrames[standFrames.length - 1], 0);
    await capture(page, canvasPage, `${name}-stand-up.png`);

    // 再次休息必须使用新 token；旧 settled 不能放行本次过渡。
    const tokenBeforeWake = after.desktop.restToken;
    const settledBeforeWake = after.desktop.restSettledToken;
    await page.locator("#rest-companion").click();
    await waitResting(page);
    await waitFor(
      async () => /sit-pixel-v2-canvas256\/frame-0[1-3]\.png$/.test(await spriteSrc(canvasPage)),
      8000,
      "二次坐下过渡未开始",
    );
    const second = await getSnapshot(page);
    facts.reRest = {
      tokenBeforeWake,
      settledBeforeWake,
      tokenAfterWake: woke.desktop.restToken,
      tokenSecondRest: second.desktop.restToken,
      settledDuringSecondRest: second.desktop.restSettledToken,
    };
    assert.equal(woke.desktop.restToken, 0);
    assert.equal(settledBeforeWake, tokenBeforeWake, "上一轮 settled 应属于上一轮 token");
    assert.ok(second.desktop.restToken > tokenBeforeWake, "再次休息必须使用新 token");
    assert.notEqual(second.desktop.restSettledToken, second.desktop.restToken);
    assert.notEqual(second.desktop.restSettledToken, settledBeforeWake);

    // 过渡中请求换人：旧 settled 已存在但属于上一轮，必须等本次 rest-settled。
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    await delay(200);
    const midSecond = await getSnapshot(page);
    facts.reRest.midSwitch = {
      characterId: midSecond.desktop.characterId,
      settledToken: midSecond.desktop.restSettledToken,
      frames: await sitFrames(canvasPage),
    };
    assert.equal(
      midSecond.desktop.characterId,
      "rin",
      "再次休息的过渡未完成前不得换人",
    );
    assert.notEqual(
      midSecond.desktop.restSettledToken,
      midSecond.desktop.restToken,
      "本次休息尚未收束，不能拿旧 settled 放行",
    );

    // 换人等待期间锁屏/恢复：仍以本次坐下完成节点收束。
    const beforeLock = (await sitFrames(canvasPage)).length;
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    const locked = await waitForSnapshot(page, (value) => value.system?.paused === true, 8000);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitForSnapshot(page, (value) => value.system?.paused === false, 8000);
    assert.equal(locked.system?.paused, true, "锁屏应进入暂停");
    facts.resume = {
      lockedPaused: locked.system?.paused ?? null,
      framesBeforeLock: beforeLock,
      framesAfterResume: (await sitFrames(canvasPage)).length,
    };

    const switched = await waitForSnapshot(
      page,
      (value) => value.desktop?.characterId === "hu",
      15000,
    );
    const framesAtSwitch = (await sitFrames(canvasPage)).length;
    await delay(1300);
    facts.reRest.switchedTo = switched.desktop.characterId;
    facts.reRest.framesAtSwitch = framesAtSwitch;
    facts.reRest.framesAfterSwitch = (await sitFrames(canvasPage)).length;
    assert.equal((await sitFrames(canvasPage)).length, framesAtSwitch, "旧坐帧回调写入了换人后的身份");
    assert.match((await getSnapshot(page)).desktop.displayedFrame, /idle-pixel-v2-canvas320\/frame-/);
    await capture(page, canvasPage, `${name}-second-rest-switch.png`);
    facts.screenshots = screenshots.slice(shotStart);
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-RESTUI-003 通知与点击/拖动期间保持静坐，换人回凛不写旧帧", { timeout: 180000 }, async (t) => {
  const name = "POL-RESTUI-003";
  const facts = {
    case: name,
    batch: BATCH_ID,
    frames: [],
    screenshots: [],
    transparentHit: "由既有 tests/acceptance/s07c-transparent-input.spec.cjs 回归覆盖",
  };
  const shotStart = screenshots.length;
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let canvasPage = null;
  let error = null;
  try {
    const ctx = await setupContext(resources, { withHu: true });
    canvasPage = ctx.canvas.page;
    const { page, app } = ctx;

    await installSitRecorder(canvasPage);
    // 过渡中请求换人：必须等真实坐下播放收束后才能切走，不能被 mode 提前放行。
    await page.locator("#rest-companion").click();
    await waitResting(page);
    await waitFor(
      async () => (await sitFrames(canvasPage)).length >= 2,
      8000,
      "坐下过渡未开始",
    );
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    await delay(250);
    const midSwitch = await getSnapshot(page);
    facts.transitionSwitch = {
      characterId: midSwitch.desktop.characterId,
      mode: midSwitch.companionship.current.mode,
      frames: await sitFrames(canvasPage),
    };
    assert.equal(
      midSwitch.desktop.characterId,
      "rin",
      "坐下过渡未完成前不得提前换人",
    );
    await waitForSnapshot(
      page,
      (value) => value.desktop?.characterId === "hu",
      15000,
    );
    await page
      .locator('.roster-row[data-character-id="rin"] button[data-action="switch"]')
      .click();
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2/frame-"),
      15000,
    );
    await resetSitRecorder(canvasPage);

    await page.locator("#rest-companion").click();
    await waitResting(page);
    const frames = await waitSitSettled(canvasPage);
    assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7]);
    facts.frames = frames;
    facts.processes = desktopProcesses();

    insertFactNotification(ctx.dataDir);
    const notified = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.notifications?.window?.visible === true
        && /sit-pixel-v2-canvas256\/frame-07\.png$/.test(value.desktop?.displayedFrame ?? ""),
      15000,
    );
    facts.notification = {
      visible: notified.desktop.notifications.window.visible,
      focusable: notified.desktop.notifications.window.focusable ?? null,
      panels: notified.desktop.notifications.panels?.length ?? 0,
    };
    assert.equal(notified.desktop.notifications.window.visible, true, "事实通知应独立显示");
    assert.notEqual(notified.desktop.notifications.window.focusable, true, "通知不得抢焦点");
    assert.equal(await spriteSrc(canvasPage), notified.desktop.displayedFrame);
    assert.match(await spriteSrc(canvasPage), /sit-pixel-v2-canvas256\/frame-07\.png$/);
    await capture(page, canvasPage, `${name}-notification-over-rest.png`);

    // 点击身体不得变成招呼；通知也不应打断坐姿。
    const plan = buildDesktopPresentation("rin", "凛").animations.display;
    const body = await findBodyPoint(app, notified.desktop.displayedFrame, plan);
    // 末帧显示后还有 600ms 播放才收束；必须等本次 token 的真实完成事实，
    // 不能把“已显示末帧”当成已完成，否则 lastNodeAt 会取到上一节点。
    const settledForClick = await waitRestSettled(page);
    const nodeBeforeClick = settledForClick.desktop.lastNodeAt;
    await canvasPage.mouse.click(body.x, body.y);
    await delay(600);
    const clicked = await getSnapshot(page);
    facts.bodyClick = {
      point: body,
      lastNode: clicked.desktop.lastNode,
      lastNodeAt: clicked.desktop.lastNodeAt,
      displayedFrame: clicked.desktop.displayedFrame,
    };
    assert.notEqual(clicked.desktop.lastNode, "wave", "静坐时点击身体不应触发招呼");
    assert.equal(clicked.desktop.lastNodeAt, nodeBeforeClick);
    assert.match(clicked.desktop.displayedFrame, /sit-pixel-v2-canvas256\/frame-07\.png$/);

    // 拖动仍按真实窗口移动，透明命中不在此重复物理取证。
    const beforeDrag = clicked.desktop.bounds;
    await canvasPage.mouse.move(body.x, body.y);
    await canvasPage.mouse.down();
    await canvasPage.mouse.move(body.x + 18, body.y + 8, { steps: 4 });
    await canvasPage.mouse.up();
    const dragged = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.bounds?.x !== beforeDrag.x
        || value.desktop?.bounds?.y !== beforeDrag.y,
      8000,
    );
    facts.drag = { before: beforeDrag, after: dragged.desktop.bounds };
    assert.match(await spriteSrc(canvasPage), /sit-pixel-v2-canvas256\/frame-07\.png$/);
    await capture(page, canvasPage, `${name}-drag-over-rest.png`);

    // 临时聊天角色不能继承稳定角色的休息姿势；A 的意图只属于 A。
    const framesBeforeHuChat = (await sitFrames(canvasPage)).length;
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="chat"]')
      .click();
    await page.locator("#chat-panel").waitFor({ state: "visible", timeout: 10000 });
    const huChat = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.characterId === "hu"
        && value.desktop?.characterId === "hu"
        && value.companionship?.current?.mode === "interacting",
      10000,
    );
    await delay(900);
    const huChatAfter = await getSnapshot(page);
    facts.otherChat = {
      characterId: huChat.companionship.current.characterId,
      mode: huChat.companionship.current.mode,
      displayedFrame: huChatAfter.desktop.displayedFrame,
      sitFramesBefore: framesBeforeHuChat,
      sitFramesAfter: (await sitFrames(canvasPage)).length,
    };
    assert.equal(huChatAfter.desktop.characterId, "hu");
    assert.match(huChatAfter.desktop.displayedFrame, /idle-pixel-v2-canvas320\/frame-/);
    assert.equal(
      (await sitFrames(canvasPage)).length,
      framesBeforeHuChat,
      "临时聊天角色继承了凛的坐姿",
    );
    await capture(page, canvasPage, `${name}-chat-other-character.png`);

    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden", timeout: 10000 });
    await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.characterId === "rin"
        && value.companionship?.current?.mode === "resting",
      15000,
    );
    // 返回凛后重新进入真实坐下播放。
    await waitSitSettled(canvasPage);
    await waitRestSettled(page);

    // 手动换角色：旧坐帧计时器不得写入 Hu；先确认真实坐下播放已收束。
    const framesBeforeSwitch = (await sitFrames(canvasPage)).length;
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "hu"
        && value.desktop?.assetState === "ready"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2-canvas320/frame-"),
      15000,
    );
    await delay(1400);
    const huAfter = await getSnapshot(page);
    facts.switchToHu = {
      framesBeforeSwitch,
      framesAfter: (await sitFrames(canvasPage)).length,
      displayedFrame: huAfter.desktop.displayedFrame,
      mode: huAfter.companionship.current.mode,
    };
    assert.equal(huAfter.desktop.characterId, "hu");
    assert.match(huAfter.desktop.displayedFrame, /idle-pixel-v2-canvas320\/frame-/);
    assert.equal((await sitFrames(canvasPage)).length, framesBeforeSwitch, "旧坐帧回调写入了新角色");
    await capture(page, canvasPage, `${name}-switch-hu.png`);

    // 回凛时沿既有手动切换规则回到待机，不复活旧坐姿。
    await page
      .locator('.roster-row[data-character-id="rin"] button[data-action="switch"]')
      .click();
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin"
        && value.desktop?.assetState === "ready"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2/frame-"),
      15000,
    );
    await delay(1400);
    const rinAfter = await getSnapshot(page);
    facts.switchBack = {
      frames: (await sitFrames(canvasPage)).length,
      displayedFrame: rinAfter.desktop.displayedFrame,
      mode: rinAfter.companionship.current.mode,
    };
    assert.equal(rinAfter.companionship.current.mode, "companion");
    assert.match(rinAfter.desktop.displayedFrame, /idle-pixel-v2\/frame-/);
    assert.equal((await sitFrames(canvasPage)).length, framesBeforeSwitch);
    await capture(page, canvasPage, `${name}-back-rin-idle.png`);

    // Hu 没有 sit：休息时继续 idle 循环，换人必须沿既有自然节点成功，
    // 不能等待永远不会来的 rest-settled。
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "hu"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2-canvas320/frame-"),
      15000,
    );
    await page.locator("#rest-companion").click();
    const huRest = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.characterId === "hu"
        && value.companionship?.current?.mode === "resting"
        && value.desktop?.characterId === "hu",
      15000,
    );
    await page
      .locator('.roster-row[data-character-id="rin"] button[data-action="switch"]')
      .click();
    const switchedBack = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin"
        && value.companionship?.current?.mode === "companion"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2/frame-"),
      15000,
    );
    facts.huRestSwitch = {
      restMode: huRest.companionship.current.mode,
      restToken: huRest.desktop.restToken,
      restSettledToken: huRest.desktop.restSettledToken,
      switchedTo: switchedBack.desktop.characterId,
      switchedMode: switchedBack.companionship.current.mode,
    };
    assert.equal(huRest.desktop.restSettledToken, 0, "Hu 无坐姿不应产生 rest-settled");
    assert.equal(switchedBack.companionship.current.mode, "companion");
    await capture(page, canvasPage, `${name}-hu-rest-switch.png`);
    facts.screenshots = screenshots.slice(shotStart);
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test.after(() => {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "summary.json"),
    `${JSON.stringify({ batch: BATCH_ID, screenshots, cases: caseResults }, null, 2)}\n`,
  );
});
