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

async function openCharacters(page) {
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('[data-nav="characters"]').click();
  await page.locator('[data-page="characters"]').waitFor({ state: "visible" });
  await page.locator("#outfit-block").waitFor({ state: "visible", timeout: 20000 });
  await waitFor(
    async () => (await page.locator("#outfit-options .outfit-option").count()) >= 2,
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
