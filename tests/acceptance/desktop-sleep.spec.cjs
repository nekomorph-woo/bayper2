/* S07 睡眠运行验收：真实 Electron、真实 SQLite、正式休息/聊天/换人按钮与真实画布帧。
   本批 GUI 由 Claude Code 独占执行，master 随后独立复验；自动记录不冒充人类体验。
   本机 P0 事件与 powerMonitor.emit 是构造边界，不冒充真实 Herdr/物理锁屏。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { fileURLToPath } = require("node:url");
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
  "s07-sleep-runtime",
);
const DB_FILE = "bayper.sqlite3";
const SIT = "sit-pixel-v2-canvas256";
const DROWSY = "drowsy-pixel-v2-canvas256";
const SLEEP = "sleep-pixel-v2-canvas256";
const QUIET_MS = 20000;
const SLEEP_CYCLE_MS = 350 * 8;

function reserveEvidenceBatch(requested) {
  const fallback = `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const base = requested || fallback;
  if (path.basename(base) !== base || base === "." || base === "..") {
    throw new Error(`S07_SLEEP_EVIDENCE_BATCH 必须是单层目录名：${base}`);
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

const reservedBatch = reserveEvidenceBatch(process.env.S07_SLEEP_EVIDENCE_BATCH);
const BATCH_ID = reservedBatch.name;
const EVIDENCE_DIR = reservedBatch.directory;
const SOURCE_FILES = [
  "app/main.cjs",
  "app/desktop-assets.cjs",
  "app/desktop/main.cjs",
  "app/desktop/renderer/canvas-app.js",
  "app/desktop-host.cjs",
  "app/presence-boundary.cjs",
  "app/companionship.cjs",
  "tests/acceptance/desktop-sleep.spec.cjs",
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

fs.writeFileSync(path.join(EVIDENCE_DIR, "source.sha256"), `${sourceDigest()}\n`);
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    "gui: Claude Code 本批独占执行；master 随后独立复验，不冒充人类体验",
    "notification: 本机 SQLite 受控 P0 行，非真实 Herdr",
    "pause: powerMonitor.emit 构造事件，非物理锁屏",
    "frames: 只记录画布真实 sprite.src，不使用测试接口启动睡眠",
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-sleep-"));
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
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
  assert.equal(result.ok, true, JSON.stringify(result));
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

async function waitRestSettled(page, timeout = 10000) {
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
  const started = Date.now();
  await page
    .locator('.roster-row[data-character-id="rin"] button[data-action="chat"]')
    .click();
  await page.locator("#chat-panel").waitFor({ state: "visible", timeout: 10000 });
  const visibleMs = Date.now() - started;
  await waitForSnapshot(
    page,
    (value) => value.companionship?.current?.mode === "interacting",
    10000,
  );
  return visibleMs;
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

function installTrace(canvasPage) {
  return canvasPage.evaluate(
    (directories) => {
      const sprite = document.getElementById("sprite");
      const trace = [];
      const pattern = new RegExp(`/(${directories.join("|")})/frame-(\\d+)\\.png$`);
      const record = () => {
        const match = pattern.exec(sprite?.src ?? "");
        if (!match) return;
        const entry = { dir: match[1], index: Number(match[2]), at: Date.now() };
        const last = trace[trace.length - 1];
        if (last && last.dir === entry.dir && last.index === entry.index) return;
        trace.push(entry);
      };
      new MutationObserver(record).observe(sprite, {
        attributes: true,
        attributeFilter: ["src"],
      });
      record();
      window.__sleepTrace = trace;
    },
    [SIT, DROWSY, SLEEP],
  );
}

async function readTrace(canvasPage) {
  return canvasPage.evaluate(() => [...(window.__sleepTrace ?? [])]);
}

async function waitTrace(canvasPage, predicate, timeout, message) {
  return waitFor(
    async () => {
      const trace = await readTrace(canvasPage);
      return predicate(trace) ? trace : null;
    },
    timeout,
    message,
  );
}

function traceSince(trace, at) {
  return trace.filter((entry) => entry.at >= at);
}

function indicesOf(trace, dir) {
  return trace.filter((entry) => entry.dir === dir).map((entry) => entry.index);
}

async function spriteSrc(page) {
  return page.evaluate(() => document.getElementById("sprite")?.src ?? "");
}

async function readCanvasDom(page) {
  return page.evaluate(() => {
    const sprite = document.getElementById("sprite");
    return {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      width: Number.parseFloat(sprite.style.width),
      height: Number.parseFloat(sprite.style.height),
      src: sprite.src,
      hidden: sprite.hidden,
    };
  });
}

function statsOf(snapshot) {
  const stats = snapshot.companionship?.current?.stats ?? {};
  return {
    energy: Number(stats.energy),
    intimacy: Number(stats.intimacy),
    mood: Number(stats.mood),
  };
}

function expectedRestEnergy(deltaMs) {
  return (deltaMs / 1000) * (20 / 3600);
}

function assertRestEnergy(before, after, deltaMs, label) {
  const expected = expectedRestEnergy(deltaMs);
  assert.ok(after.energy >= before.energy - 0.001, `${label}：休息精力不得下降`);
  assert.ok(
    Math.abs(after.energy - before.energy - expected) <= Math.max(0.06, expected * 0.4),
    `${label}：精力恢复 ${after.energy - before.energy} 与 +20/h 预期 ${expected} 不符`,
  );
  assert.equal(after.intimacy, before.intimacy, `${label}：亲密不应变化`);
  assert.equal(after.mood, before.mood, `${label}：心情不应变化`);
}

function readPersisted(dataDir) {
  const db = openDb(dataDir);
  try {
    return {
      currentMode:
        db.prepare("SELECT value FROM app_state WHERE key = 'current_mode'").get()?.value ?? null,
      runtime: db
        .prepare("SELECT character_id, mode, exploring FROM character_runtime ORDER BY character_id")
        .all(),
      stats: db
        .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
        .all(),
      activities: db
        .prepare("SELECT activity_id, character_id, kind, status, started_at FROM character_activities ORDER BY activity_id")
        .all(),
      notifications: db
        .prepare("SELECT id, instance_id, agent_id, priority, notification_status FROM connector_events ORDER BY received_at")
        .all(),
    };
  } finally {
    db.close();
  }
}

function seedHuCompanion(dataDir) {
  const db = openDb(dataDir);
  try {
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

function seedRinEnergy(dataDir, energy) {
  const db = openDb(dataDir);
  try {
    db.prepare("UPDATE character_stats SET energy = ? WHERE character_id = 'rin'").run(energy);
  } finally {
    db.close();
  }
}

let notificationSeq = 0;
function insertFactNotification(dataDir) {
  notificationSeq += 1;
  const db = openDb(dataDir);
  try {
    const now = Date.now();
    const agentId = `sleep-p0-${notificationSeq}`;
    const result = db.prepare(`
      INSERT INTO connector_events (
        app_run_id, instance_id, run_id, agent_id, kind, state, raw_state,
        priority, original_priority, historical, notification_status, received_at, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'pending', ?, ?)
    `).run(
      `app-sleep-${BATCH_ID}`,
      `sleep-fixture-${notificationSeq}`,
      `run-sleep-${notificationSeq}`,
      agentId,
      "state",
      "needs_attention",
      "needs_attention",
      now,
      now,
    );
    return { id: Number(result.lastInsertRowid), agentId };
  } finally {
    db.close();
  }
}

function notificationAck(dataDir, eventId) {
  const db = openDb(dataDir);
  try {
    return db.prepare(`
      SELECT event_id, acknowledged_at, hold_until
      FROM notification_presentation_items WHERE event_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(eventId) ?? null;
  } finally {
    db.close();
  }
}

function snapshotHasUrgentEvent(snapshot, eventId) {
  return (snapshot.desktop?.notifications?.panels ?? []).some(
    (panel) => panel.channel === "urgent"
      && (panel.eventIds ?? []).includes(eventId),
  );
}

async function connectNotificationPage(dataDir) {
  return waitFor(async () => {
    const portFile = path.join(dataDir, "desktop-profile", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) return null;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    if (!port) return null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((item) => item.url().includes("notification.html"));
    if (!page) {
      await browser.close();
      return null;
    }
    return { browser, page };
  }, 15000, "notification CDP page");
}

function insertScheduledExploration(dataDir, characterId = "rin") {
  const db = openDb(dataDir);
  try {
    const now = Date.now();
    db.prepare(`
      INSERT INTO character_activities
        (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms, created_at, updated_at)
      VALUES (?, ?, 'exploration', 'scheduled', ?, 0, ?, ?)
    `).run(`sleep-exploration-${BATCH_ID}`, characterId, 15 * 60 * 1000, now, now);
  } finally {
    db.close();
  }
}

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
  assert.ok(point, "未能在当前帧找到身体采样点");
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
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
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
      facts.persisted = readPersisted(dataDir);
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

async function setupContext(resources, { withHu = false, rinEnergy = null } = {}) {
  const dataDir = makeDataDir();
  resources.dataDir = dataDir;
  const server = await startModelServer();
  resources.server = server;
  let { app, page } = await launchApp(dataDir);
  resources.app = app;
  await completeOnboarding(page, server.baseUrl);
  await waitDesktopReady(page);
  if (withHu || Number.isFinite(rinEnergy)) {
    await app.close();
    resources.app = null;
    if (withHu) {
      seedHuCompanion(dataDir);
    }
    if (Number.isFinite(rinEnergy)) {
      seedRinEnergy(dataDir, rinEnergy);
    }
    ({ app, page } = await launchApp(dataDir));
    resources.app = app;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin"
        && value.desktop?.assetState === "ready"
        && (!withHu
          || value.companionship?.roster?.some((entry) => entry.characterId === "hu")),
      15000,
    );
  }
  const canvas = await connectCanvas(dataDir);
  resources.browser = canvas.browser;
  return { app, page, server, dataDir, canvas };
}

async function enterRest(page, canvasPage) {
  await installTrace(canvasPage);
  await page.locator("#rest-companion").click();
  await waitResting(page);
  const settled = await waitRestSettled(page);
  return { settled, settledAt: Date.now() };
}

async function waitDrowsyStart(canvasPage, timeout = 28000) {
  return waitTrace(
    canvasPage,
    (trace) => trace.some((entry) => entry.dir === DROWSY && entry.index === 0),
    timeout,
    "困倦未开始",
  );
}

/* 同一轮已有旧 drowsy 0 时，必须等到某个明确时刻之后的新困倦，不得立即返回。 */
async function waitDrowsySince(canvasPage, since, timeout = 28000) {
  return waitTrace(
    canvasPage,
    (trace) => trace.some(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= since,
    ),
    timeout,
    "指定时刻后未出现新困倦",
  );
}

async function waitSleepLoop(canvasPage, timeout = 15000) {
  return waitTrace(
    canvasPage,
    (trace) => {
      const sleep = trace.filter((entry) => entry.dir === SLEEP);
      const zeros = sleep.filter((entry) => entry.index === 0).length;
      const unique = new Set(sleep.map((entry) => entry.index)).size;
      return zeros >= 2 && unique === 8;
    },
    timeout,
    "sleep 未形成完整循环",
  );
}

test("POL-SLEEPUI-001 20s 静默后一次困倦并进入 sleep 循环", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-001";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources, { rinEnergy: 90 });
    const { page, server } = ctx;
    const canvasPage = ctx.canvas.page;
    const { settled, settledAt } = await enterRest(page, canvasPage);
    const before = statsOf(settled);
    const requestsBefore = server.requests.length;

    await delay(4000);
    const quietTrace = traceSince(await readTrace(canvasPage), settledAt);
    assert.equal(
      quietTrace.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "前 20s 不得出现困倦/睡眠帧",
    );
    const quietSnapshot = await getSnapshot(page);
    assert.match(quietSnapshot.desktop.displayedFrame, /sit-pixel-v2-canvas256\/frame-07\.png$/);
    assert.equal(quietSnapshot.companionship.current.mode, "resting");

    const trace = await waitDrowsyStart(canvasPage);
    const drowsyFirst = trace.find((entry) => entry.dir === DROWSY && entry.index === 0);
    const startDelay = drowsyFirst.at - settledAt;
    facts.drowsyStart = { settledAt, drowsyAt: drowsyFirst.at, startDelay };
    assert.ok(startDelay >= QUIET_MS - 1200, `困倦开始过早：${startDelay}ms`);

    const withSleep = await waitSleepLoop(canvasPage);
    const drowsyIndices = indicesOf(
      withSleep.filter((entry) => {
        const firstSleep = withSleep.find((item) => item.dir === SLEEP);
        return firstSleep ? entry.at < firstSleep.at : true;
      }),
      DROWSY,
    );
    assert.deepEqual(drowsyIndices, [0, 1, 2, 3, 4, 5, 6, 7], "困倦必须按 0…7 播放一次");
    facts.drowsy = drowsyIndices;
    facts.sleep = indicesOf(withSleep, SLEEP);

    const after = statsOf(await getSnapshot(page));
    const elapsed = Date.now() - settledAt;
    assertRestEnergy(before, after, elapsed, "睡眠期间");
    const final = await getSnapshot(page);
    assert.equal(final.companionship.current.mode, "resting", "睡眠不得改变行为状态种类");
    assert.equal(final.desktop.restToken, settled.desktop.restToken, "restToken 不应变化");
    assert.equal(
      final.desktop.restSettledToken,
      settled.desktop.restSettledToken,
      "不得伪造新的 rest-settled",
    );
    assert.equal(server.requests.length, requestsBefore, "睡眠不得调用模型");
    facts.energy = { before, after, elapsed, expected: expectedRestEnergy(elapsed) };
    facts.finalFrame = final.desktop.displayedFrame;
    facts.serverRequests = server.requests.length;
    await capture(page, canvasPage, `${name}-sleep-loop.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-002 困倦手在嘴边时聊天，完成短段后唤醒并重等 20s", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-002";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page } = ctx;
    const canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);

    await waitTrace(
      canvasPage,
      (trace) => trace.some((entry) => entry.dir === DROWSY && entry.index >= 2),
      30000,
      "困倦未到抬手段",
    );
    const frameAtClick = await spriteSrc(canvasPage);
    const clickMatch = /\/(drowsy-pixel-v2-canvas256)\/frame-(\d+)\.png$/.exec(frameAtClick);
    assert.ok(clickMatch, "点击聊天时必须正处于真实困倦帧");
    const indexAtClick = Number(clickMatch[2]);
    assert.ok(indexAtClick >= 2 && indexAtClick <= 5, `点击时应为抬手段：${indexAtClick}`);
    const chatStartedAt = Date.now();
    const chatVisibleMs = await openChat(page);
    facts.chat = { visibleMs: chatVisibleMs, drowsyIndexAtOpen: indexAtClick, frameAtClick };

    const awake = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.mode === "interacting"
        && /sit-pixel-v2-canvas256\/frame-07\.png$/.test(value.desktop?.displayedFrame ?? ""),
      15000,
    );
    const trace = await readTrace(canvasPage);
    const afterOpen = traceSince(trace, chatStartedAt);
    const firstSleep = afterOpen.find((entry) => entry.dir === SLEEP);
    assert.equal(firstSleep, undefined, "聊天期间不得进入 sleep");
    const drowsyAfter = indicesOf(afterOpen, DROWSY);
    const firstSeven = drowsyAfter.indexOf(7);
    // 点击时可能刚推进一帧，因此允许从当前帧或下一帧开始；但必须连续到 7。
    if (indexAtClick < 7) {
      assert.ok(firstSeven !== -1, `聊天后困倦必须实际完成到 7，实际 ${JSON.stringify(drowsyAfter)}`);
      const natural = drowsyAfter.slice(0, firstSeven + 1);
      assert.ok(natural.length > 0, "自然段不得为空");
      assert.ok(
        natural[0] === indexAtClick || natural[0] === indexAtClick + 1,
        `自然段必须从点击帧继续：click=${indexAtClick}, natural=${JSON.stringify(natural)}`,
      );
      for (let index = 1; index < natural.length; index += 1) {
        assert.equal(natural[index], natural[index - 1] + 1, "困倦短段必须连续完成");
      }
    }
    const wake = firstSeven === -1 ? drowsyAfter : drowsyAfter.slice(firstSeven + 1);
    assert.ok(wake.length > 0, `必须发生真实唤醒，实际帧 ${JSON.stringify(drowsyAfter)}`);
    assert.ok(wake.includes(0), `唤醒必须到达睁眼帧 0，实际 ${JSON.stringify(wake)}`);
    for (const index of wake) {
      assert.ok([6, 0].includes(index), `唤醒只能复用 7/6/0，实际出现 ${index}`);
    }
    assert.equal(wake[wake.length - 1], 0, "唤醒必须停在 0 后再回 sit 末帧");
    assert.equal(
      await spriteSrc(canvasPage),
      awake.desktop.displayedFrame,
      "唤醒结束后应停在 sit 末帧",
    );
    assert.match(await spriteSrc(canvasPage), /sit-pixel-v2-canvas256\/frame-07\.png$/);
    facts.sequence = { indexAtClick, drowsyAfter, wake };

    const beforeIdle = (await readTrace(canvasPage)).length;
    await delay(2500);
    const idleTrace = (await readTrace(canvasPage)).slice(beforeIdle);
    assert.equal(
      idleTrace.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "聊天期间不得再出现困倦/睡眠帧",
    );

    const closeAt = Date.now();
    await closeChat(page);
    await delay(4000);
    const afterClose = traceSince(await readTrace(canvasPage), closeAt);
    assert.equal(
      afterClose.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "聊天关闭后 4s 内不得立即困倦",
    );
    const secondTrace = await waitDrowsySince(canvasPage, closeAt);
    const secondDrowsy = secondTrace.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= closeAt,
    );
    assert.ok(secondDrowsy, "关闭后应重新等待并再次困倦");
    assert.ok(
      secondDrowsy.at - closeAt >= QUIET_MS - 1200,
      `关闭后重新等待不足：${secondDrowsy.at - closeAt}ms`,
    );
    facts.reWait = { closeAt, drowsyAt: secondDrowsy.at, delayMs: secondDrowsy.at - closeAt };
    await capture(page, canvasPage, `${name}-wake-and-requiet.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-003 静默与睡眠中真正 P0 通知独立显示且不叫醒", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-003";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let notificationBrowser = null;
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page, dataDir, server } = ctx;
    const canvasPage = ctx.canvas.page;
    const requestsBefore = server.requests.length;
    const { settledAt } = await enterRest(page, canvasPage);

    await delay(3000);
    const firstEvent = insertFactNotification(dataDir);
    const first = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.notifications?.window?.visible === true
        && snapshotHasUrgentEvent(value, firstEvent.id),
      15000,
    );
    const firstAck = await waitFor(
      () => notificationAck(dataDir, firstEvent.id)?.acknowledged_at != null
        ? notificationAck(dataDir, firstEvent.id) : null,
      15000,
      "P0 首条未回执",
    );
    assert.equal(firstAck.hold_until - firstAck.acknowledged_at, 6000, "P0 阅读期应为 6s");
    const notificationPage = await connectNotificationPage(dataDir);
    notificationBrowser = notificationPage.browser;
    const firstUrgentText = await waitFor(
      async () => {
        const text = await notificationPage.page
          .locator('.card[data-channel="urgent"]').innerText();
        return text.includes(firstEvent.agentId) ? text : null;
      },
      8000,
      "P0 首条未进入 urgent DOM",
    );
    facts.firstNotification = {
      eventId: firstEvent.id,
      agentId: firstEvent.agentId,
      visible: first.desktop.notifications.window.visible,
      focusable: first.desktop.notifications.window.focusable ?? null,
      urgentText: firstUrgentText,
      acknowledgedAt: firstAck.acknowledged_at,
      holdMs: firstAck.hold_until - firstAck.acknowledged_at,
    };
    assert.equal(first.desktop.notifications.window.visible, true);
    assert.notEqual(first.desktop.notifications.window.focusable, true, "P0 不得抢焦点");
    const persisted = readPersisted(dataDir);
    assert.ok(
      persisted.notifications.some(
        (item) => item.id === firstEvent.id && item.priority === 0,
      ),
      "P0 必须为 priority=0",
    );

    const trace = await waitDrowsyStart(canvasPage);
    const drowsyFirst = trace.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= settledAt,
    );
    assert.ok(drowsyFirst, "通知后仍未出现困倦");
    const quietDelay = drowsyFirst.at - settledAt;
    assert.ok(quietDelay >= QUIET_MS - 1200, `通知不得提前：${quietDelay}ms`);
    assert.ok(quietDelay <= QUIET_MS + 1600, `通知不得重置/延后 20s：${quietDelay}ms`);
    facts.quietDelay = quietDelay;
    await waitSleepLoop(canvasPage);

    const beforeSecond = (await readTrace(canvasPage)).length;
    const secondEvent = insertFactNotification(dataDir);
    const second = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.notifications?.window?.visible === true
        && snapshotHasUrgentEvent(value, secondEvent.id),
      15000,
    );
    const secondAck = await waitFor(
      () => notificationAck(dataDir, secondEvent.id)?.acknowledged_at != null
        ? notificationAck(dataDir, secondEvent.id) : null,
      15000,
      "P0 第二条未回执",
    );
    assert.equal(secondAck.hold_until - secondAck.acknowledged_at, 6000);
    const secondUrgentText = await waitFor(
      async () => {
        const text = await notificationPage.page
          .locator('.card[data-channel="urgent"]').innerText();
        return text.includes(secondEvent.agentId) ? text : null;
      },
      8000,
      "P0 第二条未进入 urgent DOM",
    );
    facts.secondNotification = {
      eventId: secondEvent.id,
      agentId: secondEvent.agentId,
      visible: second.desktop.notifications.window.visible,
      focusable: second.desktop.notifications.window.focusable ?? null,
      urgentText: secondUrgentText,
      acknowledgedAt: secondAck.acknowledged_at,
      holdMs: secondAck.hold_until - secondAck.acknowledged_at,
    };
    await delay(1500);
    const afterTrace = (await readTrace(canvasPage)).slice(beforeSecond);
    assert.ok(
      afterTrace.some((entry) => entry.dir === SLEEP),
      "睡眠通知期间应继续 sleep 循环",
    );
    assert.equal(
      afterTrace.filter((entry) => entry.dir === SIT).length,
      0,
      "通知不得把角色叫醒回坐姿",
    );
    const final = await getSnapshot(page);
    assert.match(final.desktop.displayedFrame, /sleep-pixel-v2-canvas256\/frame-\d+\.png$/);
    assert.equal(final.companionship.current.mode, "resting");
    assert.equal(server.requests.length, requestsBefore, "通知不得增加模型调用");
    facts.finalFrame = final.desktop.displayedFrame;
    facts.serverRequests = server.requests.length;
    await capture(page, canvasPage, `${name}-p0-over-sleep.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await notificationBrowser?.close().catch(() => {});
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-004A sleep 中手动换人在有限循环边界完成", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-004A";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources, { withHu: true });
    const { page } = ctx;
    const canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    const switchAt = Date.now();
    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    const switched = await waitForSnapshot(
      page,
      (value) => value.desktop?.characterId === "hu",
      15000,
    );
    const elapsed = Date.now() - switchAt;
    facts.switch = { elapsedMs: elapsed, characterId: switched.desktop.characterId };
    assert.ok(elapsed <= 5000, `换人等待超过有限边界：${elapsed}ms`);
    await waitForSnapshot(
      page,
      (value) => String(value.desktop?.displayedFrame).includes("/idle-pixel-v2-canvas320/frame-"),
      10000,
    );
    const afterSwitch = traceSince(await readTrace(canvasPage), switchAt + elapsed);
    assert.equal(
      afterSwitch.filter((entry) => entry.dir === SIT || entry.dir === DROWSY || entry.dir === SLEEP)
        .length,
      0,
      "换人后旧坐姿/困倦/睡眠帧不得继续写入",
    );
    const hu = buildDesktopPresentation("hu", "琥珀");
    assert.equal(hu.animations.drowsy ?? null, null);
    assert.equal(hu.animations.sleep ?? null, null);
    facts.huFrames = {
      drowsy: hu.animations.drowsy ?? null,
      sleep: hu.animations.sleep ?? null,
    };
    await capture(page, canvasPage, `${name}-switch-during-sleep.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-004B 已排队探索在 sleep 有限边界出发并换人", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-004B";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources, { withHu: true });
    const { page, dataDir } = ctx;
    const canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    const before = readPersisted(dataDir);
    const energyBefore = before.stats.find((row) => row.character_id === "rin")?.energy;
    insertScheduledExploration(dataDir, "rin");
    const startedAt = Date.now();
    const switched = await waitForSnapshot(
      page,
      (value) => value.desktop?.characterId === "hu",
      15000,
    );
    const elapsed = Date.now() - startedAt;
    const after = readPersisted(dataDir);
    const activity = after.activities.find(
      (row) => row.character_id === "rin" && row.kind === "exploration",
    );
    const energyAfter = after.stats.find((row) => row.character_id === "rin")?.energy;
    facts.exploration = {
      elapsedMs: elapsed,
      activity,
      energyBefore,
      energyAfter,
      characterId: switched.desktop.characterId,
    };
    assert.ok(elapsed <= 6000, `探索离桌超过有限边界：${elapsed}ms`);
    assert.equal(activity?.status, "running", "探索应在有限边界真实开始");
    assert.equal(
      after.runtime.find((row) => row.character_id === "rin")?.exploring,
      1,
      "探索者应标记离桌",
    );
    assert.ok(
      Math.abs(energyAfter - (energyBefore - 8)) <= 0.12,
      `探索应只扣一次 8：${energyBefore} -> ${energyAfter}`,
    );
    await delay(2500);
    const stable = readPersisted(dataDir);
    const stableEnergy = stable.stats.find((row) => row.character_id === "rin")?.energy;
    assert.ok(Math.abs(stableEnergy - energyAfter) <= 0.06, "探索开始后不得重复扣精力");
    assert.match(
      (await getSnapshot(page)).desktop.displayedFrame,
      /idle-pixel-v2-canvas320\/frame-/,
    );
    await capture(page, canvasPage, `${name}-exploration-departure.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-005 锁屏立即停表停帧，恢复后重新 20s", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-005";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page, app } = ctx;
    const canvasPage = ctx.canvas.page;
    const { settled } = await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    const lockAt = Date.now();
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    const locked = await waitForSnapshot(page, (value) => value.system?.paused === true, 8000);
    await waitFor(
      async () => /sit-pixel-v2-canvas256\/frame-07\.png$/.test(await spriteSrc(canvasPage)),
      8000,
      "锁屏后未停到合法坐姿",
    );
    const afterLock = await readTrace(canvasPage);
    const lockTrace = traceSince(afterLock, lockAt);
    await delay(1200);
    const settledTrace = (await readTrace(canvasPage)).slice(afterLock.length);
    assert.equal(
      settledTrace.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "锁屏后不得继续播放困倦/睡眠帧",
    );
    assert.equal(locked.desktop.restSettledToken, settled.desktop.restSettledToken);
    facts.lock = {
      paused: locked.system.paused,
      framesAfterLock: lockTrace,
      restSettledToken: locked.desktop.restSettledToken,
    };

    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const resumeAt = Date.now();
    await waitForSnapshot(page, (value) => value.system?.paused === false, 8000);
    await delay(4000);
    const afterResume = traceSince(await readTrace(canvasPage), resumeAt);
    assert.equal(
      afterResume.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "恢复后 4s 内不得立即重播或继续旧困倦",
    );
    const again = await waitDrowsySince(canvasPage, resumeAt);
    const second = again.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= resumeAt,
    );
    assert.ok(second, "恢复后应重新等待并允许新一次困倦");
    assert.ok(
      second.at - resumeAt >= QUIET_MS - 1200,
      `恢复后重新等待不足：${second.at - resumeAt}ms`,
    );
    facts.resume = { resumeAt, drowsyAt: second.at, delayMs: second.at - resumeAt };
    await capture(page, canvasPage, `${name}-resume-requiet.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-005B 隐藏/子进程退出清除睡眠计时，恢复重新 20s", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-005B";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page, app } = ctx;
    let canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    // 真实托盘菜单回调（程序化触发，非原生鼠标）；入口与 main onToggleVisible 相同。
    const hidden = await app.evaluate(() => globalThis.__bayperTray?.trigger("隐藏桌面角色"));
    assert.equal(hidden, true, "应能执行真实“隐藏桌面角色”菜单回调");
    await waitFor(
      async () => /sit-pixel-v2-canvas256\/frame-07\.png$/.test(await spriteSrc(canvasPage)),
      8000,
      "隐藏后未停到合法坐姿",
    );
    const afterHide = (await readTrace(canvasPage)).length;
    await delay(1200);
    const hiddenTrace = (await readTrace(canvasPage)).slice(afterHide);
    assert.equal(
      hiddenTrace.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "隐藏后不得继续播放困倦/睡眠帧",
    );
    facts.hide = { menuCallback: true, framesAfterHide: hiddenTrace };

    const shown = await app.evaluate(() => globalThis.__bayperTray?.trigger("显示桌面角色"));
    assert.equal(shown, true, "应能执行真实“显示桌面角色”菜单回调");
    const showAt = Date.now();
    await delay(4000);
    const afterShow = traceSince(await readTrace(canvasPage), showAt);
    assert.equal(
      afterShow.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "恢复显示后不得续播旧睡眠",
    );
    const again = await waitDrowsySince(canvasPage, showAt);
    const second = again.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= showAt,
    );
    assert.ok(second, "显示恢复后应重新等待并允许新一次困倦");
    assert.ok(
      second.at - showAt >= QUIET_MS - 1200,
      `显示恢复后重新等待不足：${second.at - showAt}ms`,
    );
    facts.show = { showAt, drowsyAt: second.at, delayMs: second.at - showAt };

    // 子进程退出通过真实 PID 终止构造；不修改素材，重启后先回到坐姿而非旧睡眠。
    const beforeExit = await getSnapshot(page);
    const pid = beforeExit.desktop?.pid;
    assert.ok(Number.isInteger(pid) && pid > 0, "缺少画布子进程 PID");
    process.kill(pid, "SIGTERM");
    await waitForSnapshot(
      page,
      (value) => value.desktop?.state !== "running" || value.desktop?.pid !== pid,
      10000,
    );
    await waitForSnapshot(
      page,
      (value) => value.desktop?.state === "running" && value.desktop?.assetState === "ready",
      15000,
    );
    // 子进程重启会重建画布 CDP 连接；重新连接后只按新画布真实帧判断，不复用旧页。
    await resources.browser?.close().catch(() => {});
    const nextCanvas = await connectCanvas(ctx.dataDir);
    resources.browser = nextCanvas.browser;
    canvasPage = nextCanvas.page;
    await waitForSnapshot(
      page,
      (value) => /sit-pixel-v2-canvas256\/frame-\d+\.png$/.test(value.desktop?.displayedFrame ?? ""),
      15000,
    );
    await installTrace(canvasPage);
    const restartSettled = await waitRestSettled(page, 15000);
    const restartSettledAt = restartSettled.desktop.restSettledAt;
    const exitAt = Date.now();
    await delay(1500);
    const afterExit = traceSince(await readTrace(canvasPage), exitAt);
    assert.equal(
      afterExit.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "子进程退出/重启不得复活旧困倦或睡眠帧",
    );
    const restartTrace = await waitDrowsySince(canvasPage, restartSettledAt);
    const restartDrowsy = restartTrace.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= restartSettledAt,
    );
    assert.ok(restartDrowsy, "子进程重启后应重新等待并出现新困倦");
    assert.ok(
      restartDrowsy.at - restartSettledAt >= QUIET_MS - 1200,
      `重启后重新等待不足：${restartDrowsy.at - restartSettledAt}ms`,
    );
    assert.ok(
      restartDrowsy.at - restartSettledAt <= QUIET_MS + 2000,
      `重启后等待异常延长：${restartDrowsy.at - restartSettledAt}ms`,
    );
    facts.exit = {
      pid,
      framesAfterExit: afterExit,
      restartSettledAt,
      drowsyAt: restartDrowsy.at,
      delayMs: restartDrowsy.at - restartSettledAt,
    };

    await capture(page, canvasPage, `${name}-hide-exit.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-007 继续陪伴从睡眠自然唤醒并逆坐起身", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-007";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page } = ctx;
    const canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    const clickAt = Date.now();
    await page.locator("#rest-companion").click();
    const woke = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.mode === "companion"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2/frame-"),
      20000,
    );
    const trace = traceSince(await readTrace(canvasPage), clickAt);
    const awakeDrowsy = indicesOf(trace, DROWSY);
    const awakeSit = indicesOf(trace, SIT);
    facts.continue = { drowsy: awakeDrowsy, sit: awakeSit, frame: woke.desktop.displayedFrame };
    assert.ok(awakeDrowsy.length > 0, "继续陪伴必须先播放真实唤醒，不能直接 idle");
    assert.ok(awakeDrowsy.includes(0), "唤醒必须到达睁眼帧 0");
    const firstSit = awakeSit.indexOf(7);
    assert.ok(firstSit !== -1, "唤醒后必须回到 sit 末帧");
    const stand = awakeSit.slice(firstSit);
    for (let index = 1; index < stand.length; index += 1) {
      assert.equal(stand[index], stand[index - 1] - 1, "起身必须复用 sit 逆序");
    }
    assert.equal(stand[stand.length - 1], 0, "逆坐起身必须完成到 sit 0");
    assert.match(woke.desktop.displayedFrame, /idle-pixel-v2\/frame-\d+\.png$/);
    await capture(page, canvasPage, `${name}-continue-wake-stand.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-005C 素材加载失败停表停帧，恢复后重新 20s", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-005C";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources);
    const { page, app } = ctx;
    let canvasPage = ctx.canvas.page;
    const { settled } = await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    await waitSleepLoop(canvasPage);

    // 不触碰共享素材：在真实 renderer 加载中拦截一个 sleep 帧，构造加载失败。
    const blockedFrame = "**/sleep-pixel-v2-canvas256/frame-03.png";
    await canvasPage.route(blockedFrame, (route) => route.abort());
    await canvasPage.reload();
    const errored = await waitForSnapshot(
      page,
      (value) => value.desktop?.assetState === "error",
      15000,
    );
    await installTrace(canvasPage);
    const errorAt = Date.now();
    await delay(1500);
    const afterError = traceSince(await readTrace(canvasPage), errorAt);
    assert.equal(
      afterError.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "素材错误后不得继续播放困倦/睡眠帧",
    );
    assert.equal(
      errored.desktop.restToken,
      settled.desktop.restToken,
      "素材错误不得改写本次 restToken",
    );
    assert.equal(
      errored.desktop.restSettledToken,
      settled.desktop.restSettledToken,
      "素材错误不得伪造 rest-settled",
    );
    facts.assetError = {
      state: errored.desktop.assetState,
      restToken: errored.desktop.restToken,
      restSettledToken: errored.desktop.restSettledToken,
      framesAfterError: afterError,
    };

    await canvasPage.unroute(blockedFrame);
    const oldPid = errored.desktop?.pid;
    fs.rmSync(path.join(ctx.dataDir, "desktop-profile", "DevToolsActivePort"), { force: true });
    const restarted = await app.evaluate(() => globalThis.__bayperTray?.trigger("重新启动角色画布"));
    assert.equal(restarted, true, "应能执行真实“重新启动角色画布”菜单回调");
    await resources.browser?.close().catch(() => {});
    await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.state === "running"
        && value.desktop?.assetState === "ready"
        && Number.isInteger(value.desktop?.pid)
        && value.desktop.pid !== oldPid,
      25000,
    );
    const nextCanvas = await connectCanvas(ctx.dataDir);
    resources.browser = nextCanvas.browser;
    canvasPage = nextCanvas.page;
    await installTrace(canvasPage);
    const recovered = await waitRestSettled(page, 15000);
    const recoveredAt = recovered.desktop.restSettledAt;
    await delay(1500);
    const afterRecover = traceSince(await readTrace(canvasPage), Date.now() - 1500);
    assert.equal(
      afterRecover.filter((entry) => entry.dir === DROWSY || entry.dir === SLEEP).length,
      0,
      "恢复后不得续播旧困倦/睡眠",
    );
    const newTrace = await waitDrowsySince(canvasPage, recoveredAt);
    const newDrowsy = newTrace.find(
      (entry) => entry.dir === DROWSY && entry.index === 0 && entry.at >= recoveredAt,
    );
    assert.ok(newDrowsy, "素材恢复后应重新等待并出现新困倦");
    assert.ok(
      newDrowsy.at - recoveredAt >= QUIET_MS - 1200,
      `素材恢复后重新等待不足：${newDrowsy.at - recoveredAt}ms`,
    );
    assert.ok(
      newDrowsy.at - recoveredAt <= QUIET_MS + 2000,
      `素材恢复后等待异常延长：${newDrowsy.at - recoveredAt}ms`,
    );
    facts.recovery = {
      restToken: recovered.desktop.restToken,
      restSettledAt: recoveredAt,
      drowsyAt: newDrowsy.at,
      delayMs: newDrowsy.at - recoveredAt,
    };
    await capture(page, canvasPage, `${name}-asset-error-recovery.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

test("POL-SLEEPUI-006 睡眠帧进入尺度/预载/命中，Hu 不借素材", { timeout: 180000 }, async (t) => {
  const name = "POL-SLEEPUI-006";
  const facts = { case: name, batch: BATCH_ID, screenshots: [] };
  const resources = { dataDir: null, server: null, app: null, browser: null };
  let error = null;
  try {
    const ctx = await setupContext(resources, { withHu: true });
    const { page, app } = ctx;
    const canvasPage = ctx.canvas.page;
    await enterRest(page, canvasPage);
    await waitDrowsyStart(canvasPage);
    const sleepTrace = await waitSleepLoop(canvasPage);
    const seen = new Set(indicesOf(sleepTrace, SLEEP));
    assert.equal(seen.size, 8, "sleep 八帧都应实际显示");

    const snapshot = await getSnapshot(page);
    const bounds = snapshot.desktop.bounds;
    assert.equal(bounds.width, 89, "共同窗口宽度应为 89pt");
    assert.equal(bounds.height, 128, "共同窗口高度应为 128pt");
    const dom = await readCanvasDom(canvasPage);
    const plan = buildDesktopPresentation("rin", "凛").animations.display;
    assert.ok(Math.abs(dom.width - plan.canvasWidth) < 0.05, "画布宽度应与共同 scale 一致");
    assert.ok(Math.abs(dom.height - plan.canvasHeight) < 0.05, "画布高度应与共同 scale 一致");
    assert.ok(Math.abs(plan.scale - 128 / 314) < 1e-12, "scale 必须保持 128/314");
    facts.scale = {
      bounds,
      dom: { width: dom.width, height: dom.height },
      scale: plan.scale,
      visibleBox: plan.visibleBox,
    };

    const frame = snapshot.desktop.displayedFrame;
    assert.match(frame, /sleep-pixel-v2-canvas256\/frame-\d+\.png$/);
    const body = await findBodyPoint(app, frame, plan);
    const beforeDrag = snapshot.desktop.bounds;
    await canvasPage.mouse.move(body.x, body.y);
    await canvasPage.mouse.down();
    await canvasPage.mouse.move(body.x + 16, body.y + 7, { steps: 4 });
    await canvasPage.mouse.up();
    const dragged = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.bounds?.x !== beforeDrag.x
        || value.desktop?.bounds?.y !== beforeDrag.y,
      8000,
    );
    facts.hitDrag = { point: body, before: beforeDrag, after: dragged.desktop.bounds };
    assert.notEqual(dragged.desktop.bounds.x, beforeDrag.x, "睡眠帧身体 alpha 应可拖拽");

    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    const hu = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "hu"
        && String(value.desktop?.displayedFrame).includes("/idle-pixel-v2-canvas320/frame-"),
      15000,
    );
    const huPresentation = buildDesktopPresentation("hu", "琥珀");
    assert.equal(huPresentation.animations.drowsy ?? null, null);
    assert.equal(huPresentation.animations.sleep ?? null, null);
    facts.hu = {
      displayedFrame: hu.desktop.displayedFrame,
      drowsy: huPresentation.animations.drowsy ?? null,
      sleep: huPresentation.animations.sleep ?? null,
    };
    await capture(page, canvasPage, `${name}-scale-hit-hu.png`);
    facts.screenshots = screenshots.slice();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await teardown({ ...resources, name, facts, error });
  }
});

process.on("exit", () => {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "summary.json"),
    `${JSON.stringify({ batch: BATCH_ID, cases: caseResults, screenshots }, null, 2)}\n`,
  );
});
