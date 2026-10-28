/* S06l Part B 最小正常路径 GUI 验收：真实 Electron 管理窗、真实桌面子进程、
   临时 data-dir、loopback 模型与隔离 story 目录。正式目录仍 assetAvailable=false。
   只覆盖 001/002/007 的正常路径；003/005/006 的真实协调仍待后续批次。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { startModelServer } = require("./fixture-server.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.now() - 10 * DAY;
const CHARACTER_ID = "rin";
const OUTFIT_ID = "rin.warm-tea";
const STORY_ID = "ui.outfit.warm-tea";
const NAMES = { base: "原本的衣装", [OUTFIT_ID]: "温茶围裙" };
const BASE_ANIMATIONS = [
  "idle-pixel-v2",
  "wave-pixel-v1",
  "stretch-pixel-v2-canvas256",
  "sit-pixel-v2-canvas256",
  "drowsy-pixel-v2-canvas256",
  "sleep-pixel-v2-canvas256",
  "happy-pixel-v4",
];
const OUTFIT_ANIMATIONS = [
  "idle-pixel-v2",
  "wave-pixel-v1",
  "stretch-pixel-v2-canvas320",
];
const SOURCE_FILES = [
  "app/outfits.cjs",
  "app/outfit-runtime.cjs",
  "app/desktop-assets.cjs",
  "app/main.cjs",
  "app/preload.cjs",
  "app/desktop/main.cjs",
  "app/renderer/app.js",
  "app/renderer/index.html",
  "app/renderer/outfit-panel.js",
  "app/renderer/styles.css",
];
const SOURCE_SHA = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unavailable";
  }
})();
const RUN_ID = `run-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")
  .slice(0, 17)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const EVIDENCE_DIR =
  process.env.BAYPER_S06L_UI_EVIDENCE_DIR
  ?? path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s06l-ui", RUN_ID);
fs.mkdirSync(path.dirname(EVIDENCE_DIR), { recursive: true });
try {
  fs.mkdirSync(EVIDENCE_DIR);
} catch (error) {
  throw new Error(`证据目录已存在，拒绝覆盖：${EVIDENCE_DIR}`);
}
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "meta.json"),
  `${JSON.stringify(
    {
      runId: RUN_ID,
      sourceSha: SOURCE_SHA,
      sourceFiles: SOURCE_FILES,
      sourceDigest: crypto
        .createHash("sha256")
        .update(
          SOURCE_FILES.map((file) =>
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(repoRoot, file)))
              .digest("hex"),
          ).join("\n"),
        )
        .digest("hex"),
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);

function localDay(at = Date.now()) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  assert.fail(message);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitGone(pids, timeoutMs = 15000) {
  const targets = pids.filter(Number.isInteger);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!targets.some(processAlive)) return true;
    await delay(100);
  }
  return !targets.some(processAlive);
}

function writeEvidence(name, data) {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, name),
    `${JSON.stringify(data, null, 2)}\n`,
    { flag: "wx" },
  );
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
}

function outfitStory(options = {}) {
  return {
    storyId: STORY_ID,
    type: "outfit",
    targetId: OUTFIT_ID,
    ownerCharacterId: CHARACTER_ID,
    themeId: "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: [
      { nodeId: "pocket-plan", factId: "ui.rin.pocket-plan", body: "想给围裙缝个口袋。" },
      { nodeId: "pocket-ready", factId: "ui.rin.pocket-ready", body: "口袋缝好了。" },
    ],
  };
}

function catalog(options = {}) {
  return {
    schemaVersion: 1,
    theme: { id: "fixture-theme", name: "测试主题" },
    stories: [outfitStory(options)],
  };
}

function writeCatalog(dataDir, options = {}) {
  const file = path.join(dataDir, "fixture-catalog.json");
  fs.writeFileSync(file, JSON.stringify(catalog(options), null, 2));
  return file;
}

function seedPeer(store, characterId, at) {
  store.db
    .prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)")
    .run(characterId, new Date(at).toISOString());
  store.db
    .prepare(`
      INSERT INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `)
    .run(characterId);
  store.db
    .prepare(`
      INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
      VALUES (?, 'waiting', ?, 0)
    `)
    .run(characterId, at);
}

function insertActivity(db, activityId, at) {
  db.prepare(`
    INSERT INTO character_activities
      (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
       started_at, completed_at, action_completed_at, action_frame, created_at, updated_at)
    VALUES (?, ?, 'daily', 'completed', 10000, 10000, ?, ?, ?, 8, ?, ?)
  `).run(activityId, CHARACTER_ID, at, at, at, at, at);
}

function memorySnapshot(db) {
  return Object.fromEntries(
    db
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'memory%' ORDER BY name
      `)
      .all()
      .map(({ name }) => {
        const columns = db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((column) => `"${column.name}"`);
        const order = columns.length ? ` ORDER BY ${columns.join(", ")}` : "";
        return [
          name,
          db.prepare(`SELECT * FROM "${name}"${order}`).all().map((row) => ({ ...row })),
        ];
      }),
  );
}

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

/* 仅用于复用既有 activity-runtime Runner 的自动机会时钟注入；
   不新增生产入口，正式 reason/活动仍由 heartbeat/activity-runtime 执行。 */
function setAppState(dataDir, key, value) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  } finally {
    db.close();
  }
}

async function patchClock(app, offsetMs, randomValue = 0.1) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__outfitTestClock) {
        const RealDate = Date;
        const realNow = RealDate.now.bind(RealDate);
        globalThis.__outfitTestClock = { base: realNow(), now: realNow() };
        globalThis.Date = class extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(globalThis.__outfitTestClock.now);
            else super(...args);
          }
          static now() {
            return globalThis.__outfitTestClock.now;
          }
        };
      }
      globalThis.__outfitTestClock.now = globalThis.__outfitTestClock.base + input.offset;
      Math.random = () => input.random;
    },
    { offset: offsetMs, random: randomValue },
  );
}

async function patchClockAt(app, epochMs, randomValue = 0.1) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__outfitTestClock) {
        const RealDate = Date;
        const realNow = RealDate.now.bind(RealDate);
        globalThis.__outfitTestClock = { base: realNow(), now: realNow() };
        globalThis.Date = class extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(globalThis.__outfitTestClock.now);
            else super(...args);
          }
          static now() {
            return globalThis.__outfitTestClock.now;
          }
        };
      }
      globalThis.__outfitTestClock.now = input.at;
      Math.random = () => input.random;
    },
    { at: epochMs, random: randomValue },
  );
}

function configurePresence(dataDir, { currentId, roster }) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  const slots = ["fixed", "random_1", "random_2", "random_3", "random_4"];
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("BEGIN IMMEDIATE");
    const setState = db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setState.run("current_character_id", currentId);
    setState.run("current_mode", "companion");
    setState.run("fixed_character_id", roster[0]);
    setState.run("pending_rotation", "0");
    setState.run("last_active_at", String(Date.now()));
    db.prepare("DELETE FROM roster").run();
    roster.forEach((characterId, index) => {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(Date.now()),
        slots[index],
        characterId,
      );
    });
    db.prepare("UPDATE character_runtime SET mode = 'waiting', exploring = 0").run();
    db.prepare(`
      UPDATE character_runtime SET mode = 'companion', exploring = 0
      WHERE character_id = ?
    `).run(currentId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function readActivities(dataDir) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT * FROM character_activities ORDER BY created_at, activity_id")
      .all();
  } finally {
    db.close();
  }
}

function readBusinessState(dataDir) {
  const db = openDb(dataDir);
  try {
    return {
      relationships: db.prepare("SELECT * FROM relationships ORDER BY character_id").all(),
      stats: db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
      roster: db.prepare("SELECT * FROM roster ORDER BY day, slot").all(),
      ownership: db
        .prepare("SELECT * FROM discovery_outfit_ownership ORDER BY story_id")
        .all(),
      invitations: db
        .prepare("SELECT * FROM discovery_invitations ORDER BY invitation_id")
        .all(),
      memory: memorySnapshot(db),
    };
  } finally {
    db.close();
  }
}

/* 精力会按既有陪伴时间规则持续结算；换装本身不得改亲密/心情/身份/名单。
   允许边界由实际 elapsed 与 app/companionship.cjs 的最高速率 20/小时推导，
   另加每次三位小数结算的舍入余量；不采用无依据的固定 0.2。 */
function assertNoBusinessChange(before, after, elapsedMs, label) {
  const normalize = (snapshot) => ({
    ...snapshot,
    stats: snapshot.stats.map((row) => ({ ...row, energy: 0 })),
  });
  assert.deepEqual(normalize(after), normalize(before), label);
  const bound = (20 / (60 * 60 * 1000)) * elapsedMs + 0.02;
  const beforeById = new Map(before.stats.map((row) => [row.character_id, row.energy]));
  for (const row of after.stats) {
    const delta = Math.abs(row.energy - (beforeById.get(row.character_id) ?? row.energy));
    assert.ok(
      delta <= bound,
      `${label}：精力变化 ${delta} 超出 ${elapsedMs}ms 内既有结算上限 ${bound}`,
    );
  }
}

function readOutfitDb(dataDir) {
  const db = openDb(dataDir);
  try {
    const value = (key) =>
      db.prepare("SELECT value FROM app_state WHERE key = ?").get(key)?.value ?? null;
    return {
      worn: value(`outfit_worn:${CHARACTER_ID}`)
        ? JSON.parse(value(`outfit_worn:${CHARACTER_ID}`))
        : null,
      pending: value(`outfit_pending:${CHARACTER_ID}`)
        ? JSON.parse(value(`outfit_pending:${CHARACTER_ID}`))
        : null,
    };
  } finally {
    db.close();
  }
}

function readAppStateValue(dataDir, key) {
  const db = openDb(dataDir);
  try {
    return db.prepare("SELECT value FROM app_state WHERE key = ?").get(key)?.value ?? null;
  } finally {
    db.close();
  }
}

function seedOutfitData(dataDir, storyCatalog) {
  const clock = { ms: START };
  const store = createStore(dataDir, {
    storyCatalog,
    now: () => clock.ms,
  });
  try {
    for (const [index, node] of storyCatalog.stories[0].nodes.entries()) {
      const activityId = `ui-seed-outfit-${index + 1}`;
      insertActivity(store.db, activityId, clock.ms);
      const result = store.storyProgress.recordNode({
        activityId,
        narratorId: CHARACTER_ID,
        storyId: STORY_ID,
        nodeId: node.nodeId,
      });
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      clock.ms += DAY;
    }
    const unlocked = store.discoveryOutcomes.unlockNextOutfit();
    assert.equal(unlocked.unlocked, true, JSON.stringify(unlocked));
    const remembered = store.memory.remember({
      characterId: CHARACTER_ID,
      factKey: "ui.s06l-keepsake",
      body: "用户喜欢在雨后整理衣橱。",
      kind: "preference",
      sourceId: "chat:s06l-ui-001",
    });
    assert.equal(remembered.created, true);
    store.setNickname(CHARACTER_ID, "小凛");
    // 第二个已结识角色只用于角色页预览切换，不加入名单、不切换当前角色。
    seedPeer(store, "hu", clock.ms);
  } finally {
    store.close();
  }
}

async function launchApp(dataDir, catalogPath) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`, `--story-catalog=${catalogPath}`],
    env: {
      ...process.env,
      BAYPER_HEARTBEAT_MS: "500",
      BAYPER_NOTIFICATION_TICK_MS: "600000",
      BAYPER_DESKTOP_DEBUG_PORT: "1",
      CLAUDE_CONFIG_DIR: path.join(dataDir, "no-claude-config"),
      CODEX_HOME: path.join(dataDir, "no-codex-home"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function closeApp(launched) {
  if (!launched) return { parentAlive: false, desktopAlive: false };
  let desktopPid = null;
  try {
    const result = await launched.page.evaluate(() => window.bayper.getSnapshot());
    desktopPid = result?.snapshot?.desktop?.pid ?? null;
  } catch {
    // 页面已关闭时只能按父进程核验。
  }
  const parentPid = launched.app.process()?.pid ?? null;
  try {
    await launched.app.close();
  } catch {
    // 关闭失败由进程存活核验收口。
  }
  let gone = await waitGone([parentPid, desktopPid], 15000);
  if (!gone) {
    for (const pid of [parentPid, desktopPid]) {
      if (processAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // 已退出。
        }
      }
    }
    gone = await waitGone([parentPid, desktopPid], 5000);
  }
  return {
    parentAlive: processAlive(parentPid),
    desktopAlive: processAlive(desktopPid),
    gone,
  };
}

async function completeOnboarding(page, baseUrl) {
  await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-s06l-ui");
  await page.locator("#api-key").fill("sk-fixture-ok");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible", timeout: 20000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = await page.locator("#candidate-name").textContent();
    if (name?.includes("凛")) break;
    await page.locator("#next-candidate").click();
  }
  assert.match(await page.locator("#candidate-name").textContent(), /凛/);
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function snapshotOf(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function waitForSnapshot(page, predicate, timeoutMs, message) {
  let snapshot = null;
  await waitFor(
    async () => {
      snapshot = await snapshotOf(page);
      return predicate(snapshot);
    },
    timeoutMs,
    `${message}：${JSON.stringify(snapshot?.desktop ?? null)}`,
  );
  return snapshot;
}

async function openCharacters(page, minOptions = 2) {
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('[data-nav="characters"]').click();
  await page.locator('[data-page="characters"]').waitFor({ state: "visible" });
  await page.locator("#outfit-block").waitFor({ state: "visible", timeout: 20000 });
  await waitFor(
    async () => (await page.locator("#outfit-options .outfit-option").count()) >= minOptions,
    20000,
    "衣装列表没有出现",
  );
}

function outfitName(outfitId) {
  return NAMES[outfitId] ?? outfitId;
}

async function currentOutfitText(page) {
  return page.locator("#outfit-current").textContent();
}

async function waitForWorn(page, outfitId, timeoutMs = 30000) {
  await waitFor(
    async () => {
      const text = await currentOutfitText(page);
      return text.includes(outfitName(outfitId))
        && (await page.locator(`#outfit-options [data-outfit-id="${outfitId}"].is-worn`).count()) === 1;
    },
    timeoutMs,
    `界面没有显示已穿 ${outfitName(outfitId)}`,
  );
}

async function waitForPending(page, outfitId, timeoutMs = 20000) {
  await waitFor(
    async () => {
      const text = await page.locator("#outfit-status").textContent();
      return text.includes("待穿")
        && (await page.locator(`#outfit-options [data-outfit-id="${outfitId}"].is-pending`).count()) === 1;
    },
    timeoutMs,
    `界面没有显示 ${outfitName(outfitId)} 待穿`,
  );
}

async function clickOutfit(page, outfitId) {
  await page.evaluate((id) => {
    const button = document.querySelector(`#outfit-options [data-outfit-id="${id}"]`);
    if (!button) {
      throw new Error(`缺少衣装按钮 ${id}`);
    }
    button.click();
  }, outfitId);
}

async function waitForBaseDesktop(page, timeoutMs = 30000) {
  return waitForSnapshot(
    page,
    (snapshot) =>
      snapshot.desktop?.state === "running"
      && snapshot.desktop?.assetState === "ready"
      && snapshot.desktop?.bounds
      && snapshot.desktop?.displayedFrame?.includes("/characters/rin/animations/idle-pixel-v2/frame-")
      && !snapshot.desktop.displayedFrame.includes("/outfits/"),
    timeoutMs,
    "基础衣装桌面没有就绪",
  );
}

async function waitForOutfitDesktop(page, timeoutMs = 30000) {
  return waitForSnapshot(
    page,
    (snapshot) =>
      snapshot.desktop?.state === "running"
      && snapshot.desktop?.assetState === "ready"
      && snapshot.desktop?.bounds
      && snapshot.desktop?.displayedFrame?.includes(
        "/characters/rin/outfits/warm-tea/animations/idle-pixel-v2/frame-",
      ),
    timeoutMs,
    "温茶衣装桌面没有就绪",
  );
}

function screenFoot(bounds, plan) {
  return {
    x: bounds.x + plan.footAnchor.x,
    y: bounds.y + plan.footAnchor.y,
  };
}

function frameResourceDirectory(frame) {
  const match = String(frame ?? "").match(
    /\/characters\/([^/]+)\/(?:outfits\/([^/]+)\/)?animations\/([^/]+)\//,
  );
  return match ? `${match[1]}|${match[2] ?? "base"}|${match[3]}` : null;
}

/* 独立 Oracle：直接读真实 manifest 的 paste/scaled_size/frame_size/脚锚，
   不调用被测 buildDesktopPresentation，避免用实现自证布局。 */
function animationPlan(characterId, animationNames, outfit = null) {
  const root = path.join(repoRoot, "assets", "characters", characterId);
  const directory = outfit
    ? path.join(root, "outfits", outfit, "animations")
    : path.join(root, "animations");
  const frames = [];
  let frameSize = null;
  for (const name of animationNames) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, name, "manifest.json"), "utf8"),
    );
    if (!frameSize) frameSize = manifest.atlas.frame_size;
    frames.push(...manifest.frames);
  }
  const minX = Math.min(...frames.map((frame) => frame.paste.x));
  const minY = Math.min(...frames.map((frame) => frame.paste.y));
  const maxX = Math.max(
    ...frames.map((frame) => frame.paste.x + frame.scaled_size.width),
  );
  const maxY = Math.max(
    ...frames.map((frame) => frame.paste.y + frame.scaled_size.height),
  );
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = 128 / Math.max(width, height);
  const anchor =
    frames[0].output_foot_anchor ?? frames[0].output_ground_anchor;
  return {
    scale,
    windowWidth: Math.ceil(width * scale - 1e-6),
    windowHeight: Math.ceil(height * scale - 1e-6),
    offsetX: minX * scale,
    offsetY: minY * scale,
    visibleBox: { x: minX, y: minY, width, height },
    footAnchor: {
      x: anchor.x * scale - minX * scale,
      y: anchor.y * scale - minY * scale,
    },
  };
}

async function connectDesktopPage(dataDir) {
  const profileDir = path.join(dataDir, "desktop-profile");
  let port = null;
  await waitFor(
    () => {
      const file = path.join(profileDir, "DevToolsActivePort");
      if (!fs.existsSync(file)) return false;
      const value = Number(fs.readFileSync(file, "utf8").split("\n")[0]);
      if (!Number.isInteger(value) || value <= 0) return false;
      port = value;
      return true;
    },
    20000,
    "桌面子进程没有开放调试端口",
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await waitFor(
    () => {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("/desktop/renderer/index.html"));
      return Boolean(page);
    },
    15000,
    "没有找到桌宠画布页面",
  );
  return { browser, page };
}

async function spriteFrame(page) {
  return page.evaluate(() => document.getElementById("sprite")?.src ?? "");
}

async function sampleFrames(desktopPage, durationMs = 2400) {
  const frames = [];
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const frame = await spriteFrame(desktopPage);
    if (frame && frames.at(-1) !== frame) frames.push(frame);
    await delay(100);
  }
  return frames;
}

async function tryWave(desktopPage, plan, onWave = async () => {}) {
  const points = [0.55, 0.62, 0.7].map((ratio) => ({
    x: Math.round(
      (plan.visibleBox.x + plan.visibleBox.width / 2) * plan.scale - plan.offsetX,
    ),
    y: Math.round(
      (plan.visibleBox.y + plan.visibleBox.height * ratio) * plan.scale - plan.offsetY,
    ),
  }));
  for (const point of points) {
    await desktopPage.mouse.click(point.x, point.y);
    const waveFrames = [];
    const started = Date.now();
    while (Date.now() - started < 3200) {
      const frame = await spriteFrame(desktopPage);
      if (frame.includes("/outfits/warm-tea/animations/wave-pixel-v1/frame-")) {
        if (waveFrames.length === 0) await onWave(frame);
        if (!waveFrames.includes(frame)) waveFrames.push(frame);
      } else if (
        waveFrames.length > 0
        && frame.includes("/outfits/warm-tea/animations/idle-pixel-v2/frame-")
      ) {
        return { triggered: true, point, waveFrames, afterWave: frame };
      }
      await delay(60);
    }
  }
  return { triggered: false, waveFrames: [], afterWave: null };
}

async function readOutfitDbAndWait(dataDir, predicate, timeoutMs = 20000) {
  let value;
  await waitFor(
    () => {
      value = readOutfitDb(dataDir);
      return predicate(value);
    },
    timeoutMs,
    `SQLite 衣装状态未满足：${JSON.stringify(value)}`,
  );
  return value;
}

/* 每个 Case 独立 data-dir；setup 只用于真实首次配置与作者数据播种。 */
async function makeCase(t, name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-s06l-${name}-`));
  const catalogPath = writeCatalog(dataDir);
  const server = await startModelServer();
  const launched = [];
  t.after(async () => {
    for (const item of launched.reverse()) {
      await closeApp(item).catch(() => {});
    }
    await server.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, catalogPath, server, launched };
}

async function setupAccepted(context) {
  const setup = await launchApp(context.dataDir, context.catalogPath);
  context.launched.push(setup);
  await completeOnboarding(setup.page, context.server.baseUrl);
  const snapshot = await waitForSnapshot(
    setup.page,
    (value) =>
      value.state === "accepted"
      && value.companionship?.current?.characterId === CHARACTER_ID,
    20000,
    "首次配置没有接纳凛",
  );
  const closed = await closeApp(setup);
  context.launched.pop();
  assert.equal(closed.gone, true, "首次配置应用没有完全退出");
  seedOutfitData(context.dataDir, catalog());
  const serviceRequests = context.server.requests.length;
  return { snapshot, serviceRequests };
}

async function openApp(context) {
  const launched = await launchApp(context.dataDir, context.catalogPath);
  context.launched.push(launched);
  await launched.page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  return launched;
}

test("POL-OUTFIT-001 角色页选择→聊天保留待穿→安全节点换装→桌面温茶帧", {
  timeout: 240000,
}, async (t) => {
  const context = await makeCase(t, "001");
  const facts = {};
  try {
    const setup = await setupAccepted(context);
    facts.serviceRequestsAfterSetup = setup.serviceRequests;
    const beforeOutfit = readOutfitDb(context.dataDir);
    assert.equal(beforeOutfit.worn, null);
    assert.equal(beforeOutfit.pending, null);

    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    assert.match(await currentOutfitText(page), /原本的衣装/);
    const base = await waitForBaseDesktop(page);
    const beforeAt = Date.now();
    const beforeBusiness = readBusinessState(context.dataDir);
    const basePlan = animationPlan("rin", BASE_ANIMATIONS);
    const outfitPlan = animationPlan("rin", OUTFIT_ANIMATIONS, "warm-tea");
    facts.base = {
      bounds: base.desktop.bounds,
      displayedFrame: base.desktop.displayedFrame,
      foot: screenFoot(base.desktop.bounds, basePlan),
      plan: basePlan,
    };
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
    );
    await capture(page, "001-base");

    // 聊天中点击只保存待穿，不切帧，也不拒绝选择。
    const opened = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.companionship?.current?.mode === "interacting",
      10000,
      "聊天互动没有开始",
    );
    await clickOutfit(page, OUTFIT_ID);
    await waitForPending(page, OUTFIT_ID);
    const pending = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    facts.pendingDuringChat = pending;
    const duringChat = await snapshotOf(page);
    assert.match(duringChat.desktop.displayedFrame, /\/characters\/rin\/animations\/idle-pixel-v2\/frame-/);
    assert.equal(duringChat.desktop.displayedFrame.includes("/outfits/"), false);
    await capture(page, "001-pending-chat");
    await delay(2200);
    assert.equal(readOutfitDb(context.dataDir).worn, null, "聊天期间不得提交已穿");
    assert.match((await currentOutfitText(page)), /原本的衣装/);
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
      "待穿期间角色页仍应显示旧已穿图",
    );

    const closed = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-00\.png$/,
      "已穿温茶时角色页大图必须显示温茶预览",
    );
    facts.worn = {
      bounds: worn.desktop.bounds,
      displayedFrame: worn.desktop.displayedFrame,
      foot: screenFoot(worn.desktop.bounds, outfitPlan),
      plan: outfitPlan,
    };
    const afterOutfit = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    facts.afterOutfit = afterOutfit;
    assert.equal(worn.desktop.bounds.width, outfitPlan.windowWidth);
    assert.equal(worn.desktop.bounds.height, outfitPlan.windowHeight);
    assert.ok(
      Math.abs(facts.worn.foot.x - facts.base.foot.x) <= 1,
      `屏幕脚位 x 偏差 ${facts.worn.foot.x - facts.base.foot.x}`,
    );
    assert.ok(
      Math.abs(facts.worn.foot.y - facts.base.foot.y) <= 1,
      `屏幕脚位 y 偏差 ${facts.worn.foot.y - facts.base.foot.y}`,
    );

    // 切换角色后预览各自独立；快速切回不能残留旧异步结果。
    await page.locator('#character-list [data-character-id="hu"]').click();
    await page.locator('#character-list [data-character-id="rin"]').click();
    await waitFor(
      async () =>
        (await page.locator("#character-image").getAttribute("src"))?.includes(
          "/rin/outfits/warm-tea/animations/idle-pixel-v2/frame-00.png",
        ),
      10000,
      "快速切换角色后没有恢复凛的已穿预览",
    );
    await page.locator('#character-list [data-character-id="hu"]').click();
    await waitFor(
      async () =>
        (await page.locator("#character-image").getAttribute("src"))?.includes(
          "/hu/source/master-pixel-v2.png",
        ),
      10000,
      "切换到琥珀后没有显示其基础预览",
    );
    await page.locator('#character-list [data-character-id="rin"]').click();
    await waitForWorn(page, OUTFIT_ID);
    assert.equal(
      (await snapshotOf(page)).companionship.current.characterId,
      CHARACTER_ID,
      "浏览角色不得切换当前在场角色",
    );
    await capture(page, "001-worn");

    const afterAt = Date.now();
    const afterBusiness = readBusinessState(context.dataDir);
    assertNoBusinessChange(
      beforeBusiness,
      afterBusiness,
      afterAt - beforeAt,
      "记忆/关系/数值/名单/归属不得改变",
    );
    assert.deepEqual(
      afterBusiness.ownership,
      beforeBusiness.ownership,
      "换装不得新增归属或改变提示状态",
    );
    assert.equal(context.server.requests.length, setup.serviceRequests, "不得调用新模型请求");
    const ownership = readBusinessState(context.dataDir).ownership[0];
    assert.equal(ownership.notification_pending, 1);
    assert.equal(ownership.notification_shown_at, null);

    // 调整后的位置必须持久化；后续心跳不能把窗口移回旧 position。
    const settledBounds = worn.desktop.bounds;
    await delay(1600);
    const afterHeartbeat = await snapshotOf(page);
    assert.deepEqual(afterHeartbeat.desktop.bounds, settledBounds, "心跳不得覆盖换装后位置");
    assert.match(
      afterHeartbeat.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    writeEvidence("case-001.json", {
      ...facts,
      afterHeartbeat: afterHeartbeat.desktop,
      modelRequests: context.server.requests.length,
    });
  } catch (error) {
    writeEvidence("case-001-failure.json", { error: error?.stack ?? String(error), facts });
    throw error;
  }
});

test("POL-OUTFIT-002 重复选择幂等、选回基础、重启保持最后选择", {
  timeout: 240000,
}, async (t) => {
  const context = await makeCase(t, "002");
  const facts = {};
  try {
    await setupAccepted(context);
    const beforeBusiness = readBusinessState(context.dataDir);
    const beforeOwnership = beforeBusiness.ownership;

    let app = await openApp(context);
    let page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);
    await clickOutfit(page, OUTFIT_ID);
    await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const afterFirstWear = readOutfitDb(context.dataDir);
    assert.equal(afterFirstWear.worn.outfitId, OUTFIT_ID);
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-00\.png$/,
    );

    // 已穿温茶再次选择：不产生待穿，也不新归属。
    await clickOutfit(page, OUTFIT_ID);
    await delay(400);
    assert.equal((await page.locator("#outfit-status").textContent()).includes("待穿"), false);
    assert.equal(readOutfitDb(context.dataDir).worn.outfitId, OUTFIT_ID);
    assert.deepEqual(readBusinessState(context.dataDir).ownership, beforeOwnership);

    await clickOutfit(page, "base");
    await waitForBaseDesktop(page, 30000);
    await waitForWorn(page, "base");
    const afterBase = readOutfitDb(context.dataDir);
    assert.equal(afterBase.worn.outfitId, "base");
    assert.equal(afterBase.pending, null);
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
    );
    await capture(page, "002-base");

    // 重启保留基础衣装、昵称与独属记忆。
    let closed = await closeApp(app);
    context.launched.pop();
    assert.equal(closed.gone, true);
    app = await openApp(context);
    page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page, 30000);
    await waitForWorn(page, "base");
    assert.equal(readOutfitDb(context.dataDir).worn.outfitId, "base");
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
    );
    const db = openDb(context.dataDir);
    try {
      assert.equal(
        db.prepare("SELECT nickname FROM relationships WHERE character_id = ?").get(CHARACTER_ID).nickname,
        "小凛",
      );
      assert.deepEqual(memorySnapshot(db), beforeBusiness.memory);
    } finally {
      db.close();
    }
    await capture(page, "002-restart-base");

    // 再穿温茶并重启，最后一次选择保持。
    await clickOutfit(page, OUTFIT_ID);
    await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    closed = await closeApp(app);
    context.launched.pop();
    assert.equal(closed.gone, true);
    app = await openApp(context);
    page = app.page;
    await openCharacters(page);
    const restarted = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    assert.equal(readOutfitDb(context.dataDir).worn.outfitId, OUTFIT_ID);
    assert.deepEqual(readBusinessState(context.dataDir).ownership, beforeOwnership);
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-00\.png$/,
    );
    await capture(page, "002-restart-outfit");
    facts.final = {
      worn: readOutfitDb(context.dataDir),
      bounds: restarted.desktop.bounds,
      displayedFrame: restarted.desktop.displayedFrame,
    };

    // 正式目录仍为不可用状态时，已穿身份保留但角色页不得冒充基础图；
    // 显式选回基础后允许恢复。
    closed = await closeApp(app);
    context.launched.pop();
    assert.equal(closed.gone, true);
    writeCatalog(context.dataDir, { assetAvailable: false });
    app = await openApp(context);
    page = app.page;
    await openCharacters(page);
    await waitFor(
      async () => (await currentOutfitText(page)).includes("不可用"),
      20000,
      "失效已穿没有显示不可用",
    );
    assert.equal(await page.locator("#character-image").isHidden(), true);
    assert.equal(
      await page.locator("#character-preview-unavailable").isVisible(),
      true,
    );
    assert.equal(
      await page.locator("#character-image").getAttribute("src"),
      null,
      "不可用时不得保留基础图 src",
    );
    facts.unavailable = {
      worn: readOutfitDb(context.dataDir),
      current: await currentOutfitText(page),
    };
    await capture(page, "002-unavailable");

    await clickOutfit(page, "base");
    await waitForBaseDesktop(page, 30000);
    await waitForWorn(page, "base");
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
    );
    assert.equal(await page.locator("#character-preview-unavailable").isVisible(), false);
    assert.equal(readOutfitDb(context.dataDir).worn.outfitId, "base");
    facts.recovered = readOutfitDb(context.dataDir);
    writeEvidence("case-002.json", facts);
  } catch (error) {
    writeEvidence("case-002-failure.json", { error: error?.stack ?? String(error), facts });
    throw error;
  }
});

test("POL-OUTFIT-003 聊天中选择、取消、再选，结束前不提交且旧意图失效", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "003-chat");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);

    const opened = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.companionship?.current?.mode === "interacting",
      10000,
      "聊天互动没有开始",
    );

    await clickOutfit(page, OUTFIT_ID);
    await waitForPending(page, OUTFIT_ID);
    const first = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    facts.firstPending = first.pending;

    // 选回当前已穿衣装（基础）取消待穿。
    await clickOutfit(page, "base");
    const cancelled = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending === null && value.worn === null,
    );
    assert.equal(cancelled.pending, null);
    assert.match(await currentOutfitText(page), /原本的衣装/);
    assert.equal((await page.locator("#outfit-status").textContent()).includes("待穿"), false);

    await clickOutfit(page, OUTFIT_ID);
    await waitForPending(page, OUTFIT_ID);
    const second = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    assert.notEqual(second.pending.token, first.pending.token, "再选必须产生新 token");
    facts.secondPending = second.pending;

    // 聊天结束前不得提交；旧待穿已取消，新意图保持待穿。
    await delay(2200);
    const duringChat = readOutfitDb(context.dataDir);
    assert.equal(duringChat.worn, null, "聊天期间不得写已穿");
    assert.equal(duringChat.pending.token, second.pending.token);
    const chatSnapshot = await snapshotOf(page);
    assert.match(
      chatSnapshot.desktop.displayedFrame,
      /\/characters\/rin\/animations\/idle-pixel-v2\/frame-/,
    );
    assert.match(
      await page.locator("#character-image").getAttribute("src"),
      /\/rin\/source\/master-pixel-v2\.png$/,
    );
    await capture(page, "003-chat-pending");

    const closed = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const final = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    assert.equal(final.worn.outfitId, OUTFIT_ID);
    assert.match(
      worn.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    await capture(page, "003-chat-worn");
    facts.final = final;
    writeEvidence("case-003-chat.json", facts);
  } catch (error) {
    writeEvidence("case-003-chat-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-003 基础休息坐下过渡中选择温茶，安全节点后应用且保持休息意图", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "003-rest");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);

    const resting = await page.evaluate(() => window.bayper.restCompanion());
    assert.equal(resting.ok, true, JSON.stringify(resting));
    const duringSit = await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship?.current?.mode === "resting"
        && /\/sit-pixel-v2-canvas256\/frame-0[0-3]\.png$/.test(
          snapshot.desktop?.displayedFrame ?? "",
        ),
      10000,
      "基础休息没有进入坐下过渡",
    );
    assert.ok(
      duringSit.desktop.restToken > 0
      && duringSit.desktop.restSettledToken !== duringSit.desktop.restToken,
      "选择时不得已有旧 rest-settled 节点",
    );
    facts.selectionNode = {
      restToken: duringSit.desktop.restToken,
      restSettledToken: duringSit.desktop.restSettledToken,
      displayedFrame: duringSit.desktop.displayedFrame,
    };
    await capture(page, "003-rest-sit");

    await clickOutfit(page, OUTFIT_ID);
    await waitForPending(page, OUTFIT_ID);
    const pending = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    facts.pending = pending.pending;

    // 坐下尚未收束前不得提前写已穿，也不得提前结束休息。
    await delay(400);
    assert.equal(readOutfitDb(context.dataDir).worn, null, "坐下安全节点前不得提交");
    const beforeSettle = await snapshotOf(page);
    assert.equal(beforeSettle.companionship.current.mode, "resting");

    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const after = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    const afterSnapshot = await snapshotOf(page);
    assert.equal(afterSnapshot.companionship.current.mode, "resting", "换装不得结束休息");
    assert.ok(afterSnapshot.desktop.restToken > 0, "休息代次应保持");
    assert.equal(after.worn.outfitId, OUTFIT_ID);
    assert.match(
      worn.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    await capture(page, "003-rest-worn");
    facts.after = {
      worn: after.worn,
      mode: afterSnapshot.companionship.current.mode,
      restToken: afterSnapshot.desktop.restToken,
      displayedFrame: worn.desktop.displayedFrame,
    };
    writeEvidence("case-003-rest.json", facts);
  } catch (error) {
    writeEvidence("case-003-rest-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-005 系统暂停中选择待穿不应用，恢复后完成", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "005-pause");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);

    // powerMonitor.emit 是构造的系统暂停事件，不是物理锁屏/休眠。
    await app.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.system?.paused === true,
      10000,
      "构造系统暂停没有生效",
    );

    await clickOutfit(page, OUTFIT_ID);
    await waitForPending(page, OUTFIT_ID);
    const pending = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    await delay(2200);
    assert.equal(readOutfitDb(context.dataDir).worn, null, "暂停期间不得提交");
    assert.equal((await snapshotOf(page)).system.paused, true);
    facts.pending = pending.pending;
    await capture(page, "005-paused-pending");

    await app.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.system?.paused === false,
      10000,
      "构造系统恢复没有生效",
    );
    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const final = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    assert.equal(final.worn.outfitId, OUTFIT_ID);
    assert.match(
      worn.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    await capture(page, "005-resumed-worn");
    facts.final = final;
    writeEvidence("case-005-pause.json", facts);
  } catch (error) {
    writeEvidence("case-005-pause-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-005 等待节点中锁屏保持待穿，解锁后恢复提交", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "005-pause-wait");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.desktop?.lastNode === "idle-loop",
      10000,
      "没有等到可用的 idle 节点",
    );
    await clickOutfit(page, OUTFIT_ID);
    const waiting = await waitForSnapshot(
      page,
      (snapshot) => snapshot.outfit?.runtime?.phase === "waiting",
      5000,
      "换装没有进入节点等待",
    );
    facts.waiting = waiting.outfit.runtime;

    // 构造锁屏只用于系统暂停语义；不是物理锁屏。
    await app.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.system?.paused === true,
      10000,
      "构造系统暂停没有生效",
    );
    const pendingBefore = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    await delay(2200);
    const duringPause = readOutfitDb(context.dataDir);
    assert.equal(duringPause.worn, null, "暂停期间等待回调不得提交");
    assert.equal(duringPause.pending.token, pendingBefore.pending.token);
    facts.paused = duringPause.pending;
    await capture(page, "005-pause-during-wait");

    await app.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.system?.paused === false,
      10000,
      "构造系统恢复没有生效",
    );
    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const final = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    assert.equal(final.worn.outfitId, OUTFIT_ID);
    assert.match(
      worn.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    facts.final = final;
    writeEvidence("case-005-pause-wait.json", facts);
  } catch (error) {
    writeEvidence("case-005-pause-wait-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-005 待穿退出后重启恢复选择，不丢失意图", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "005-exit");
  const facts = {};
  try {
    await setupAccepted(context);
    const beforeBusiness = readBusinessState(context.dataDir);
    let app = await openApp(context);
    let page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);

    await page.evaluate(() => window.bayperChat.openChat("rin"));
    await waitForSnapshot(
      page,
      (snapshot) => snapshot.companionship?.current?.mode === "interacting",
      10000,
      "聊天互动没有开始",
    );
    await clickOutfit(page, OUTFIT_ID);
    const pending = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === OUTFIT_ID && value.worn === null,
    );
    facts.pending = pending.pending;

    const closed = await closeApp(app);
    context.launched.pop();
    assert.equal(closed.gone, true);
    const persisted = readOutfitDb(context.dataDir);
    assert.equal(persisted.worn, null);
    assert.equal(persisted.pending.outfitId, OUTFIT_ID);
    facts.persisted = persisted;

    app = await openApp(context);
    page = app.page;
    await openCharacters(page);
    const worn = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const final = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    assert.equal(final.worn.outfitId, OUTFIT_ID);
    assert.match(
      worn.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    const db = openDb(context.dataDir);
    try {
      assert.equal(
        db.prepare("SELECT nickname FROM relationships WHERE character_id = ?").get(CHARACTER_ID).nickname,
        "小凛",
      );
      assert.deepEqual(memorySnapshot(db), beforeBusiness.memory);
      assert.deepEqual(
        db.prepare("SELECT * FROM discovery_outfit_ownership ORDER BY story_id").all(),
        beforeBusiness.ownership,
      );
    } finally {
      db.close();
    }
    await capture(page, "005-restart-worn");
    facts.final = final;
    writeEvidence("case-005-exit.json", facts);
  } catch (error) {
    writeEvidence("case-005-exit-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-005 等待中换人不误改新角色", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "005-switch");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);

    await waitForSnapshot(
      page,
      (snapshot) => snapshot.desktop?.lastNode === "idle-loop",
      10000,
      "没有等到可用的 idle 节点",
    );
    await clickOutfit(page, OUTFIT_ID);
    const waiting = await waitForSnapshot(
      page,
      (snapshot) => snapshot.outfit?.runtime?.phase === "waiting",
      5000,
      "换装没有进入节点等待",
    );
    facts.waitingPhase = waiting.outfit.runtime;
    const switched = await page.evaluate(() => window.bayper.switchCompanion("hu"));
    assert.equal(switched.ok, true, JSON.stringify(switched));
    const huSnapshot = await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship?.current?.characterId === "hu"
        && snapshot.desktop?.characterId === "hu"
        && snapshot.desktop?.assetState === "ready"
        && snapshot.desktop?.displayedFrame?.includes(
          "/characters/hu/animations/idle-pixel-v2-canvas320/frame-",
        ),
      30000,
      "换人后没有显示琥珀基础衣装",
    );
    const huWorn = await readAppStateValue(context.dataDir, "outfit_worn:hu");
    const huPending = await readAppStateValue(context.dataDir, "outfit_pending:hu");
    assert.equal(huWorn, null, "不得把凛的衣装写给琥珀");
    assert.equal(huPending, null, "不得给琥珀留下凛的待穿");
    const rin = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
      30000,
    );
    assert.equal(rin.worn.outfitId, OUTFIT_ID);
    assert.equal(
      huSnapshot.desktop.displayedFrame.includes("/outfits/warm-tea/"),
      false,
      "新角色不得播放凛的温茶帧",
    );
    await capture(page, "005-switch-hu");
    facts.hu = {
      current: huSnapshot.companionship.current.characterId,
      displayedFrame: huSnapshot.desktop.displayedFrame,
      worn: huWorn,
      pending: huPending,
    };
    facts.rin = rin;
    writeEvidence("case-005-switch.json", facts);
  } catch (error) {
    writeEvidence("case-005-switch-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-006 名单外凛选择温茶不入场，正式切换后穿温茶出现", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "006-outside");
  const facts = {};
  try {
    await setupAccepted(context);
    configurePresence(context.dataDir, { currentId: "hu", roster: ["hu"] });
    const app = await openApp(context);
    const page = app.page;
    await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship?.current?.characterId === "hu"
        && snapshot.desktop?.displayedFrame?.includes(
          "/characters/hu/animations/idle-pixel-v2-canvas320/frame-",
        ),
      30000,
      "名单外场景没有显示琥珀",
    );
    const before = await snapshotOf(page);
    await openCharacters(page, 1);
    await page.locator('#character-list [data-character-id="rin"]').click();
    await waitFor(
      async () => (await page.locator("#outfit-options .outfit-option").count()) >= 2,
      10000,
      "凛的衣装列表没有出现",
    );
    await waitForWorn(page, "base");
    await clickOutfit(page, OUTFIT_ID);
    const worn = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    const afterSelect = await snapshotOf(page);
    assert.equal(afterSelect.companionship.current.characterId, "hu");
    assert.deepEqual(afterSelect.companionship.roster, before.companionship.roster);
    assert.deepEqual(afterSelect.desktop.bounds, before.desktop.bounds, "名单外选择不得移动琥珀");
    assert.equal(afterSelect.desktop.characterId, before.desktop.characterId);
    assert.equal(afterSelect.desktop.assetState, before.desktop.assetState);
    assert.equal(
      frameResourceDirectory(afterSelect.desktop.displayedFrame),
      frameResourceDirectory(before.desktop.displayedFrame),
      "名单外选择不得改变当前琥珀资源目录",
    );
    assert.equal(frameResourceDirectory(afterSelect.desktop.displayedFrame), "hu|base|idle-pixel-v2-canvas320");
    assert.equal(
      afterSelect.companionship.characters.find((item) => item.characterId === "rin")
        .exploring,
      false,
    );
    assert.equal(worn.worn.outfitId, OUTFIT_ID);
    await capture(page, "006-outside-selected");

    const switched = await page.evaluate(() => window.bayper.switchCompanion("rin"));
    assert.equal(switched.ok, true, JSON.stringify(switched));
    const appeared = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const final = await readOutfitDb(context.dataDir);
    assert.equal(final.worn.outfitId, OUTFIT_ID);
    assert.equal((await snapshotOf(page)).companionship.current.characterId, "rin");
    facts.selected = worn;
    facts.appeared = {
      current: (await snapshotOf(page)).companionship.current.characterId,
      displayedFrame: appeared.desktop.displayedFrame,
    };
    writeEvidence("case-006-outside.json", facts);
  } catch (error) {
    writeEvidence("case-006-outside-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-006 探索中的凛选择温茶不结束探索，探索结束后正式出现", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "006-exploring");
  const facts = {};
  try {
    await setupAccepted(context);
    configurePresence(context.dataDir, { currentId: "hu", roster: ["rin", "hu"] });
    const app = await openApp(context);
    const page = app.page;
    await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship?.current?.characterId === "hu"
        && snapshot.desktop?.displayedFrame?.includes(
          "/characters/hu/animations/idle-pixel-v2-canvas320/frame-",
        ),
      30000,
      "探索场景没有显示琥珀",
    );

    setAppState(context.dataDir, "automatic_purpose_cursor", "exploration");
    await patchClock(app.app, 31 * 60 * 1000, 0.1);
    await waitFor(
      () =>
        readActivities(context.dataDir).some(
          (activity) =>
            activity.kind === "exploration" && activity.status === "running",
        ),
      10000,
      "正式自动机会没有启动探索",
    );
    const exploration = readActivities(context.dataDir).find(
      (activity) => activity.kind === "exploration" && activity.status === "running",
    );
    assert.ok(exploration);
    await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship.characters.find((item) => item.characterId === "rin")
          ?.exploring === true,
      10000,
      "凛没有进入探索状态",
    );
    const beforeSelect = await snapshotOf(page);
    assert.equal(beforeSelect.companionship.current.characterId, "hu");
    await openCharacters(page, 1);
    await page.locator('#character-list [data-character-id="rin"]').click();
    await waitFor(
      async () => (await page.locator("#outfit-options .outfit-option").count()) >= 2,
      10000,
      "凛的衣装列表没有出现",
    );
    await waitForWorn(page, "base");
    await clickOutfit(page, OUTFIT_ID);
    const selected = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === OUTFIT_ID && value.pending === null,
    );
    const duringExplore = await snapshotOf(page);
    assert.equal(duringExplore.companionship.current.characterId, "hu");
    assert.equal(
      duringExplore.companionship.characters.find((item) => item.characterId === "rin")
        .exploring,
      true,
      "选择衣装不得提前结束探索",
    );
    assert.deepEqual(duringExplore.companionship.roster, beforeSelect.companionship.roster);
    assert.deepEqual(
      duringExplore.desktop.bounds,
      beforeSelect.desktop.bounds,
      "探索中选择不得移动当前琥珀",
    );
    assert.equal(duringExplore.desktop.characterId, beforeSelect.desktop.characterId);
    assert.equal(duringExplore.desktop.assetState, beforeSelect.desktop.assetState);
    assert.equal(
      frameResourceDirectory(duringExplore.desktop.displayedFrame),
      frameResourceDirectory(beforeSelect.desktop.displayedFrame),
      "探索中选择不得改变当前琥珀资源目录",
    );
    assert.equal(
      frameResourceDirectory(duringExplore.desktop.displayedFrame),
      "hu|base|idle-pixel-v2-canvas320",
    );
    await capture(page, "006-exploring-selected");

    await patchClockAt(
      app.app,
      exploration.started_at + 21 * 60 * 1000,
      0.1,
    );
    await waitFor(
      () => {
        const row = readActivities(context.dataDir).find(
          (activity) => activity.activity_id === exploration.activity_id,
        );
        return row?.status === "completed";
      },
      10000,
      "探索没有正式结束",
    );
    await waitForSnapshot(
      page,
      (snapshot) =>
        snapshot.companionship.characters.find((item) => item.characterId === "rin")
          ?.exploring === false,
      10000,
      "探索结束后凛仍在探索状态",
    );
    const switched = await page.evaluate(() => window.bayper.switchCompanion("rin"));
    assert.equal(switched.ok, true, JSON.stringify(switched));
    const appeared = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    assert.equal((await snapshotOf(page)).companionship.current.characterId, "rin");
    facts.explored = {
      activity: exploration.activity_id,
      duringExplore: duringExplore.companionship.current.characterId,
      roster: duringExplore.companionship.roster,
    };
    facts.selected = selected;
    facts.appeared = appeared.desktop.displayedFrame;
    writeEvidence("case-006-exploring.json", facts);
  } catch (error) {
    writeEvidence("case-006-exploring-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-003 温茶日常伸展中选择基础，活动完整结束前不切基础帧", {
  timeout: 180000,
}, async (t) => {
  const context = await makeCase(t, "003-daily");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    await waitForBaseDesktop(page);
    await clickOutfit(page, OUTFIT_ID);
    await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);

    const desktop = await connectDesktopPage(context.dataDir);
    setAppState(context.dataDir, "automatic_purpose_cursor", "daily");
    await patchClock(app.app, 31 * 60 * 1000, 0.1);
    await waitFor(
      () =>
        readActivities(context.dataDir).some(
          (activity) => activity.kind === "daily" && activity.status === "running",
        ),
      10000,
      "正式自动机会没有启动日常",
    );
    const activity = readActivities(context.dataDir).find(
      (item) => item.kind === "daily" && item.status === "running",
    );
    assert.ok(activity);

    await waitFor(
      async () =>
        (await spriteFrame(desktop.page)).includes(
          "/characters/rin/outfits/warm-tea/animations/stretch-pixel-v2-canvas320/frame-",
        ),
      10000,
      "没有观察到温茶伸展帧",
    );
    await clickOutfit(page, "base");
    await waitForPending(page, "base");
    const pending = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.pending?.outfitId === "base" && value.worn?.outfitId === OUTFIT_ID,
    );
    facts.pending = pending.pending;
    await capture(page, "003-daily-base-pending");

    // 动作帧完成不等于活动完整收束；在 activity 仍 running 时不得出现基础帧。
    const forbiddenFrames = [];
    const observeDeadline = Date.now() + 3500;
    while (Date.now() < observeDeadline) {
      const frame = await spriteFrame(desktop.page);
      const active = readActivities(context.dataDir).find(
        (item) => item.activity_id === activity.activity_id,
      );
      if (
        active?.status === "running"
        && (
          frame.includes("/characters/rin/animations/")
          || frame.includes("/characters/rin/outfits/warm-tea/animations/stretch-pixel-v2-canvas256/")
        )
      ) {
        forbiddenFrames.push(frame);
      }
      if (
        active?.action_completed_at !== null
        && (await snapshotOf(page)).desktop?.lastNode === "daily-action-complete"
      ) {
        break;
      }
      await delay(60);
    }
    assert.deepEqual(forbiddenFrames, [], "活动未结束前出现了基础帧");
    assert.equal(
      readOutfitDb(context.dataDir).worn.outfitId,
      OUTFIT_ID,
      "活动完整结束前不得写基础",
    );
    assert.equal(readOutfitDb(context.dataDir).pending.outfitId, "base");
    facts.beforeComplete = readActivities(context.dataDir).find(
      (item) => item.activity_id === activity.activity_id,
    );

    await patchClockAt(app.app, activity.started_at + 11000, 0.1);
    await waitFor(
      () => {
        const row = readActivities(context.dataDir).find(
          (item) => item.activity_id === activity.activity_id,
        );
        return row?.status === "completed";
      },
      10000,
      "日常活动没有完整收束",
    );
    await waitForBaseDesktop(page, 30000);
    const after = await readOutfitDbAndWait(
      context.dataDir,
      (value) => value.worn?.outfitId === "base" && value.pending === null,
    );
    const snapshot = await snapshotOf(page);
    assert.equal(snapshot.companionship.current.mode, "companion");
    assert.equal(snapshot.companionship.current.activity ?? null, null);
    assert.equal(after.worn.outfitId, "base");
    await capture(page, "003-daily-base-after");
    facts.after = {
      worn: after.worn,
      mode: snapshot.companionship.current.mode,
      displayedFrame: snapshot.desktop.displayedFrame,
      activity: readActivities(context.dataDir).find(
        (item) => item.activity_id === activity.activity_id,
      ),
    };
    writeEvidence("case-003-daily.json", facts);
  } catch (error) {
    writeEvidence("case-003-daily-failure.json", {
      error: error?.stack ?? String(error),
      facts,
    });
    throw error;
  }
});

test("POL-OUTFIT-007 温茶 idle 连续帧与招呼wave实际播放，脚位/尺度保持", {
  timeout: 240000,
}, async (t) => {
  const context = await makeCase(t, "007");
  const facts = {};
  try {
    await setupAccepted(context);
    const app = await openApp(context);
    const page = app.page;
    await openCharacters(page);
    const base = await waitForBaseDesktop(page);
    await clickOutfit(page, OUTFIT_ID);
    const ready = await waitForOutfitDesktop(page, 30000);
    await waitForWorn(page, OUTFIT_ID);
    const plan = animationPlan("rin", OUTFIT_ANIMATIONS, "warm-tea");
    const basePlan = animationPlan("rin", BASE_ANIMATIONS);
    const baseFoot = screenFoot(base.desktop.bounds, basePlan);
    const outfitState = readOutfitDb(context.dataDir);
    assert.equal(outfitState.worn.outfitId, OUTFIT_ID);

    const desktop = await connectDesktopPage(context.dataDir);
    await waitFor(
      async () => {
        const frame = await spriteFrame(desktop.page);
        return frame.includes("/outfits/warm-tea/animations/idle-pixel-v2/frame-");
      },
      15000,
      "桌宠画布没有载入温茶 idle 帧",
    );
    const idleFrames = await sampleFrames(desktop.page, 2800);
    assert.ok(idleFrames.length >= 3, `idle 帧数不足：${idleFrames.length}`);
    for (const frame of idleFrames) {
      assert.match(
        frame,
        /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
        `idle 混入非温茶帧：${frame}`,
      );
    }
    const beforeNode = (await snapshotOf(page)).desktop.lastNodeAt;
    await delay(2200);
    const afterNode = await snapshotOf(page);
    assert.ok(
      Number.isFinite(beforeNode) && Number.isFinite(afterNode.desktop.lastNodeAt),
      "缺少 idle-loop 节点时间",
    );
    assert.ok(afterNode.desktop.lastNodeAt > beforeNode, "idle-loop 节点没有继续推进");
    assert.match(
      afterNode.desktop.displayedFrame,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
    );
    assert.equal(afterNode.desktop.bounds.width, plan.windowWidth);
    assert.equal(afterNode.desktop.bounds.height, plan.windowHeight);
    assert.ok(Math.abs(afterNode.desktop.bounds.height - 128) <= 1, "本体高度应约 128pt");
    const outfitFoot = screenFoot(afterNode.desktop.bounds, plan);
    assert.ok(
      Math.abs(outfitFoot.x - baseFoot.x) <= 1,
      `屏幕脚位 x 偏差 ${outfitFoot.x - baseFoot.x}`,
    );
    assert.ok(
      Math.abs(outfitFoot.y - baseFoot.y) <= 1,
      `屏幕脚位 y 偏差 ${outfitFoot.y - baseFoot.y}`,
    );

    await desktop.page.screenshot({
      path: path.join(EVIDENCE_DIR, "007-outfit-idle.png"),
      omitBackground: true,
    });
    const wave = await tryWave(desktop.page, plan, async () => {
      await desktop.page.screenshot({
        path: path.join(EVIDENCE_DIR, "007-outfit-wave.png"),
        omitBackground: true,
      });
    });
    facts.wave = wave;
    assert.equal(wave.triggered, true, "真实点击没有触发温茶 wave");
    assert.ok(wave.waveFrames.length >= 2, `wave 帧数不足：${wave.waveFrames.length}`);
    assert.match(
      wave.afterWave,
      /\/characters\/rin\/outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-/,
      "wave 后没有回到温茶 idle",
    );

    // 复用既有 activity-runtime Runner 的自动机会时钟注入，走正式
    // heartbeat → automaticOpportunities → activityRuntime → 日常 stretch 入口。
    setAppState(context.dataDir, "automatic_purpose_cursor", "daily");
    await patchClock(app.app, 31 * 60 * 1000, 0.1);
    await waitFor(
      () =>
        readActivities(context.dataDir).some(
          (activity) =>
            activity.kind === "daily"
            && ["scheduled", "running"].includes(activity.status),
        ),
      10000,
      "自动机会没有建立日常活动",
    );
    await waitFor(
      () =>
        readActivities(context.dataDir).some(
          (activity) => activity.kind === "daily" && activity.status === "running",
        ),
      10000,
      "日常活动没有在自然节点开始",
    );

    const stretchFrames = [];
    let stretchShot = false;
    let peakShot = false;
    const stretchDeadline = Date.now() + 6000;
    while (Date.now() < stretchDeadline) {
      const frame = await spriteFrame(desktop.page);
      if (
        frame.includes(
          "/characters/rin/outfits/warm-tea/animations/stretch-pixel-v2-canvas320/frame-",
        )
      ) {
        if (!stretchFrames.includes(frame)) stretchFrames.push(frame);
        if (!stretchShot) {
          stretchShot = true;
          await desktop.page.screenshot({
            path: path.join(EVIDENCE_DIR, "007-outfit-stretch.png"),
            omitBackground: true,
          });
        }
        if (!peakShot && /frame-0[4-7]\.png$/.test(frame)) {
          peakShot = true;
          await desktop.page.screenshot({
            path: path.join(EVIDENCE_DIR, "007-outfit-stretch-peak.png"),
            omitBackground: true,
          });
        }
      }
      const state = await snapshotOf(page);
      if (
        stretchFrames.length >= 4
        && state.desktop?.lastNode === "daily-action-complete"
      ) {
        break;
      }
      await delay(60);
    }
    assert.ok(
      stretchFrames.length >= 4,
      `实际只观察到 ${stretchFrames.length} 个温茶伸展帧`,
    );
    assert.ok(
      stretchFrames.every((frame) =>
        frame.includes(
          "/characters/rin/outfits/warm-tea/animations/stretch-pixel-v2-canvas320/",
        ),
      ),
      "日常伸展不得混入基础衣装或其他动作帧",
    );
    const stretchActivity = readActivities(context.dataDir).find(
      (activity) => activity.kind === "daily" && activity.status === "running",
    );
    assert.ok(stretchActivity, "缺少正在运行的日常活动事实");
    await patchClockAt(app.app, stretchActivity.started_at + 11000, 0.1);
    await waitFor(
      () => {
        const activity = readActivities(context.dataDir).find(
          (item) => item.activity_id === stretchActivity.activity_id,
        );
        return activity?.status === "completed";
      },
      10000,
      "日常活动没有在完整动作与时长后收束",
    );
    const postActivitySnapshot = await snapshotOf(page);
    const postActivityFrame = await spriteFrame(desktop.page);
    facts.stretch = {
      activity: stretchActivity.activity_id,
      frames: stretchFrames,
      shot: stretchShot,
      peakShot,
      postActivityFrame,
      postActivityMode: postActivitySnapshot.companionship?.current?.mode ?? null,
      postActivityCurrent: postActivitySnapshot.companionship?.current?.activity ?? null,
      postActivityDb: readActivities(context.dataDir).map((activity) => ({
        activity_id: activity.activity_id,
        status: activity.status,
        action_frame: activity.action_frame,
        active_elapsed_ms: activity.active_elapsed_ms,
      })),
    };
    writeEvidence("007-stretch-phase.json", facts.stretch);
    await waitFor(
      async () => {
        const frame = await spriteFrame(desktop.page);
        const state = await snapshotOf(page);
        return (
          frame.includes(
            "/characters/rin/outfits/warm-tea/animations/idle-pixel-v2/frame-",
          )
          && state.companionship?.current?.mode === "companion"
          && !state.companionship?.current?.activity
        );
      },
      10000,
      "日常伸展后没有回到同衣装 idle",
    );
    facts.stretch.after = await spriteFrame(desktop.page);
    facts.idleFrames = idleFrames;
    facts.ready = {
      bounds: ready.desktop.bounds,
      displayedFrame: ready.desktop.displayedFrame,
      plan,
    };
    facts.lastNode = {
      before: beforeNode,
      after: afterNode.desktop.lastNodeAt,
      displayedFrame: afterNode.desktop.displayedFrame,
    };
    writeEvidence("case-007.json", facts);
  } catch (error) {
    writeEvidence("case-007-failure.json", { error: error?.stack ?? String(error), facts });
    throw error;
  }
});
