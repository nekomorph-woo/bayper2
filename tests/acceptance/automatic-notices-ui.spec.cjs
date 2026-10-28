/* S06m Part B 首批真实 GUI 验收：正式 automaticOpportunities 机会 → 通知子进程
   自动告知卡 → 350ms 可见回执 → 用户点击正确衣装/故事。
   使用真实 Electron/SQLite、隔离 data-dir、loopback 模型与构造作者目录；
   不通过 runtime 私有方法制造成功，也不写入 connector 账本冒充自动告知。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { createLegacyDatabase, dbPath, localDay } = require("./s02-fixtures.cjs");
const { startModelServer } = require("./fixture-server.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const OUT_OWNER = "rin";
const OUTFIT_ID = "rin.warm-tea";
const OUTFIT_STORY = "ui.notice.outfit";
const INVITE_STORY = "ui.notice.invite";
const INVITE_TARGET = "hu";
const RUN_ID = `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${
  process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const EVIDENCE_DIR = process.env.BAYPER_S06M_UI_EVIDENCE_DIR
  ?? path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s06m-automatic-notices-ui", RUN_ID);
fs.mkdirSync(path.dirname(EVIDENCE_DIR), { recursive: true });
try {
  fs.mkdirSync(EVIDENCE_DIR);
} catch (error) {
  throw new Error(`证据目录已存在，拒绝覆盖：${EVIDENCE_DIR}`);
}
fs.writeFileSync(path.join(EVIDENCE_DIR, "meta.json"), `${JSON.stringify({
  runId: RUN_ID,
  at: new Date().toISOString(),
  boundary: "真实 Electron/SQLite；构造作者目录与 loopback 模型；机会由正式 heartbeat/automaticOpportunities 驱动。",
}, null, 2)}\n`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? `（${last.message}）` : ""}`);
}

function writeCase(id, record) {
  fs.writeFileSync(path.join(EVIDENCE_DIR, `case-${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(EVIDENCE_DIR, `case-${id}.log`), [
    `case: ${id}`,
    `status: ${record.failure ? "fail" : "pass"}`,
    `failure: ${record.failure?.stack ?? record.failure?.message ?? "none"}`,
    `cleanup: ${record.cleanupErrors?.length ? "failed" : "ok"}`,
    ...(record.cleanupErrors ?? []).map((error, index) =>
      `  cleanup-${index + 1}: ${error?.stack ?? error?.message ?? error}`),
    `screenshots: ${JSON.stringify(record.screenshots ?? [])}`,
    "",
    "## facts",
    JSON.stringify(record.facts ?? {}, null, 2),
    "",
  ].join("\n"));
}

function catalogFor(kind) {
  const stories = [];
  if (kind !== "invite") {
    stories.push({
      storyId: OUTFIT_STORY,
      type: "outfit",
      targetId: OUTFIT_ID,
      ownerCharacterId: OUT_OWNER,
      themeId: "fixture-theme",
      assetAvailable: true,
      nodes: [{
        nodeId: "outfit-node-1",
        factId: "ui.notice.fact.outfit",
        body: "凛想在围裙前面缝个口袋。她说线团已经比她更熟悉桌子底下。",
      }],
    });
  }
  if (kind !== "outfit") {
    stories.push({
      storyId: INVITE_STORY,
      type: "character",
      targetId: INVITE_TARGET,
      ownerCharacterId: null,
      themeId: "fixture-theme",
      assetAvailable: true,
      nodes: [{
        nodeId: "invite-node-1",
        factId: "ui.notice.fact.invite",
        body: "琥珀口袋里装着一颗圆石头。她还记得在哪条路边捡到。",
      }],
    });
  }
  return {
    schemaVersion: 1,
    theme: { id: "fixture-theme", name: "测试主题" },
    stories,
  };
}

function seedStories(db, catalog, at) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES
      ('current_mode', 'companion'),
      ('pending_rotation', '0'),
      ('last_active_at', ?),
      ('automatic_purpose_cursor', 'source')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(at));
  for (const story of catalog.stories) {
    db.prepare(`
      INSERT INTO story_progress
        (story_id, type, target_id, owner_character_id, theme_id,
         next_node_index, status, started_at, matured_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mature', ?, ?, ?)
    `).run(
      story.storyId,
      story.type,
      story.targetId,
      story.ownerCharacterId,
      story.themeId,
      story.nodes.length,
      at,
      at,
      at,
    );
    for (const node of story.nodes) {
      db.prepare(`
        INSERT INTO story_facts (fact_id, story_id, node_id, target_id, learned_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(node.factId, story.storyId, node.nodeId, story.targetId, at);
    }
  }
  const outfit = catalog.stories.find((story) => story.type === "outfit");
  if (outfit) {
    db.prepare(`
      INSERT INTO discovery_outfit_ownership
        (story_id, outfit_id, owner_character_id, source_activity_id,
         unlocked_at, notification_pending, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 1, ?, ?)
    `).run(outfit.storyId, outfit.targetId, outfit.ownerCharacterId, at, at, at);
  }
}

async function setupCase(t, kind) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-s06m-${kind}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-s06m-${kind}-home-`));
  const server = await startModelServer();
  const catalog = catalogFor(kind);
  const catalogPath = path.join(dataDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  createLegacyDatabase(dataDir, {
    characters: [{ id: OUT_OWNER, acceptedAt: new Date().toISOString() }],
    modelCipher: Buffer.from(`s06m-${kind}-cipher`),
    baseUrl: server.baseUrl,
    modelName: "s06m-loopback",
    fixedId: OUT_OWNER,
    currentId: OUT_OWNER,
    rosterDay: localDay(new Date()),
  });
  const store = createStore(dataDir, { storyCatalog: catalog });
  try {
    seedStories(store.db, catalog, Date.now() - 60 * 60 * 1000);
  } finally {
    store.close();
  }
  return { dataDir, home, server, catalog, catalogPath };
}

async function launchApp(context) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      repoRoot,
      `--data-dir=${context.dataDir}`,
      `--story-catalog=${context.catalogPath}`,
    ],
    env: {
      ...process.env,
      HOME: context.home,
      XDG_CONFIG_HOME: path.join(context.home, ".config"),
      XDG_DATA_HOME: path.join(context.home, ".local/share"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      BAYPER_DESKTOP_DEBUG_PORT: "1",
      BAYPER_HEARTBEAT_MS: "200",
      BAYPER_NOTIFICATION_TICK_MS: "50",
    },
  });
  const logs = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 30000 });
  return { app, page, logs };
}

async function closeApp(launched) {
  if (!launched?.app) return null;
  const handle = launched.app.process?.();
  await launched.app.close().catch(() => {});
  await waitFor(
    () => !handle || handle.exitCode !== null || handle.signalCode !== null,
    8000,
    "应用退出",
  ).catch(() => {});
  return handle?.exitCode ?? null;
}

async function snapshotOf(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.snapshot;
}

async function waitDesktop(page) {
  return waitFor(async () => {
    const snapshot = await snapshotOf(page);
    return snapshot.desktop?.state === "running"
      && snapshot.desktop?.assetState === "ready"
      && snapshot.desktop?.displayedKind === "character"
      ? snapshot : null;
  }, 30000, "桌面角色就绪");
}

async function waitCompanion(page, { expect = true } = {}) {
  return waitFor(async () => {
    const notice = (await snapshotOf(page)).desktop?.notifications?.companionNotice ?? null;
    if (expect) return notice;
    return notice === null ? true : null;
  }, 15000, expect ? "自动告知卡" : "自动告知卡撤下");
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
  }, 15000, "通知子进程 CDP");
}

async function forceOpportunity(app, dataDir) {
  await app.evaluate(() => {
    Math.random = () => 0.1;
  });
  execDb(dataDir, `
    INSERT INTO app_state (key, value) VALUES ('automatic_opportunity_next_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [String(Date.now() - 1000)]);
}

/* 受控测试注入：预先在 preload 隔离上下文设好断点，随后把结果包
   投递到实际 companion-notice renderer；不新增生产测试入口。 */
async function createCompanionResultInjector(page) {
  const session = await page.context().newCDPSession(page);
  const scripts = [];
  session.on("Debugger.scriptParsed", (event) => scripts.push(event));
  await session.send("Debugger.enable");
  for (let attempt = 0; attempt < 60 && !scripts.some(
    (item) => item.url.includes("notification-preload.cjs"),
  ); attempt += 1) {
    await delay(25);
  }
  const script = scripts.find((item) => item.url.includes("notification-preload.cjs"));
  if (!script) throw new Error("找不到 notification-preload 脚本");
  const source = await session.send("Debugger.getScriptSource", { scriptId: script.scriptId });
  const lineNumber = source.scriptSource.split("\n")
    .findIndex((line) => line.includes("onCompanionResult"));
  if (lineNumber < 0) throw new Error("找不到 onCompanionResult 行");
  const breakpoint = await session.send("Debugger.setBreakpoint", {
    location: { scriptId: script.scriptId, lineNumber, columnNumber: 0 },
  });
  return {
    async inject(payload) {
      const pausedPromise = new Promise((resolve) => {
        session.once("Debugger.paused", resolve);
      });
      const trigger = session.send("Runtime.evaluate", {
        expression: "window.notifications.onCompanionResult(() => {})",
      }).catch(() => null);
      const paused = await Promise.race([pausedPromise, delay(3000).then(() => null)]);
      if (!paused) throw new Error("preload 结果注入未暂停到目标函数");
      const frame = paused.callFrames[0];
      const expression = `ipcRenderer.emit("companion-notice:result", {}, ${
        JSON.stringify(payload)
      })`;
      const emitted = await session.send("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
      }).catch((error) => ({ error: error.message }));
      await session.send("Debugger.resume").catch(() => {});
      await trigger;
      if (emitted.error) throw new Error(`结果注入失败：${emitted.error}`);
      await delay(120);
      return emitted;
    },
    async dispose() {
      await session.send("Debugger.removeBreakpoint", {
        breakpointId: breakpoint.breakpointId,
      }).catch(() => {});
      await session.detach().catch(() => {});
    },
  };
}

/* 测试侧延迟初始 snapshot 响应，复现管理窗冷启动时目标早于数据到达。 */
async function delayInitialSnapshot(app, ms) {
  const patched = await app.evaluate(({ ipcMain }, delayMs) => {
    const handlers = ipcMain._invokeHandlers;
    if (!handlers || typeof handlers.get !== "function") return false;
    const original = handlers.get("bayper:snapshot");
    if (!original) return false;
    const trace = { calls: 0, enteredAt: null, returnedAt: null };
    globalThis.__s06mSnapshotDelay = trace;
    handlers.set("bayper:snapshot", async (event, ...args) => {
      trace.calls += 1;
      if (trace.enteredAt === null) trace.enteredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await original(event, ...args);
      trace.returnedAt = Date.now();
      return result;
    });
    return true;
  }, ms);
  assert.equal(patched, true, "无法延迟管理窗初始 snapshot");
}

async function readSnapshotDelay(app) {
  return app.evaluate(() => globalThis.__s06mSnapshotDelay ?? null);
}

function queryDb(dataDir, sql, params = []) {
  const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function execDb(dataDir, sql, params = []) {
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function receipts(dataDir) {
  return queryDb(dataDir, "SELECT * FROM automatic_notice_receipts ORDER BY source_key");
}

function ownership(dataDir, storyId) {
  return queryDb(
    dataDir,
    "SELECT * FROM discovery_outfit_ownership WHERE story_id = ?",
    [storyId],
  )[0] ?? null;
}

async function screenshotNotification(notifyPage, name) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  await notifyPage.screenshot({ path: file }).catch(() => {});
  return file;
}

function collectPageErrors(page, bucket) {
  page.on("pageerror", (error) => {
    bucket.push(error?.stack ?? error?.message ?? String(error));
  });
}

async function setupCaseAndApp(t, kind) {
  const context = await setupCase(t, kind);
  const launched = await launchApp(context);
  await waitDesktop(launched.page);
  const pageErrors = [];
  collectPageErrors(launched.page, pageErrors);
  return { context, launched, cdp: null, pageErrors };
}

function watchNotificationPage(resources) {
  collectPageErrors(resources.cdp.page, resources.pageErrors);
}

/* 用隔离业务表构造阻塞状态；不触碰自动告知 runtime 私有字段。 */
function insertRunningActivity(dataDir, activityId, kind) {
  const now = Date.now();
  const duration = kind === "exploration" ? 20 * 60 * 1000 : 10000;
  execDb(dataDir, `
    INSERT INTO character_activities
      (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
       started_at, last_progress_at, completed_at, action_completed_at,
       action_frame, created_at, updated_at)
    VALUES (?, 'rin', ?, 'running', ?, 0, ?, ?, NULL, NULL, 0, ?, ?)
  `, [activityId, kind, duration, now, now, now, now]);
  execDb(dataDir,
    "UPDATE character_runtime SET mode = ?, exploring = ? WHERE character_id = 'rin'",
    [kind === "exploration" ? "exploring" : "daily", kind === "exploration" ? 1 : 0]);
}

function clearRunningActivity(dataDir, activityId) {
  const now = Date.now();
  execDb(dataDir, `
    UPDATE character_activities
    SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE activity_id = ?
  `, [now, now, activityId]);
  execDb(dataDir,
    "UPDATE character_runtime SET mode = 'companion', exploring = 0 WHERE character_id = 'rin'");
}

function seedBackgroundExploration(dataDir, characterId) {
  const now = Date.now();
  execDb(dataDir,
    "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    [characterId, new Date(now).toISOString()]);
  execDb(dataDir,
    "INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)",
    [characterId]);
  execDb(dataDir, `
    INSERT OR REPLACE INTO character_runtime
      (character_id, mode, last_settled_at, exploring)
    VALUES (?, 'exploring', ?, 1)
  `, [characterId, now]);
  execDb(dataDir,
    "INSERT OR IGNORE INTO roster (day, slot, character_id) VALUES (?, 'random_1', ?)",
    [localDay(new Date()), characterId]);
  const now2 = Date.now();
  execDb(dataDir, `
    INSERT INTO character_activities
      (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
       started_at, last_progress_at, completed_at, action_completed_at,
       action_frame, created_at, updated_at)
    VALUES (?, ?, 'exploration', 'running', ?, 0, ?, ?, NULL, NULL, 0, ?, ?)
  `, [`ui-notice-bg-${characterId}`, characterId, 20 * 60 * 1000,
    now2, now2, now2, now2]);
}

async function connectCharacterPage(dataDir) {
  return waitFor(async () => {
    const portFile = path.join(dataDir, "desktop-profile", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) return null;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    if (!port) return null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((item) => item.url().includes("/renderer/index.html"));
    if (!page) {
      await browser.close();
      return null;
    }
    return { browser, page };
  }, 15000, "角色画布 CDP 页面");
}

function seedReadyCompanion(dataDir, characterId) {
  const now = Date.now();
  execDb(dataDir,
    "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    [characterId, new Date(now).toISOString()]);
  execDb(dataDir,
    "INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)",
    [characterId]);
  execDb(dataDir, `
    INSERT OR REPLACE INTO character_runtime
      (character_id, mode, last_settled_at, exploring)
    VALUES (?, 'waiting', ?, 0)
  `, [characterId, now]);
  execDb(dataDir,
    "INSERT OR IGNORE INTO roster (day, slot, character_id) VALUES (?, 'random_1', ?)",
    [localDay(new Date()), characterId]);
}

async function prepareOffscreenNotificationPage(resources, launched, context) {
  execDb(context.dataDir, `
    INSERT INTO connector_events
      (app_run_id, instance_id, run_id, kind, state, priority,
       notification_status, received_at)
    VALUES ('s06m-ui-work', 's06m-ui-work', 's06m-ui-work', 'online', 'idle', 2,
            'pending', ?)
  `, [Date.now()]);
  resources.cdp = await connectNotificationPage(context.dataDir);
  watchNotificationPage(resources);
  await waitFor(async () =>
    (await snapshotOf(launched.page)).desktop?.notifications?.panels.length > 0,
  10000, "工作通知预建呈现");
  await waitFor(async () =>
    (await snapshotOf(launched.page)).desktop?.notifications?.panels.length === 0,
  12000, "工作通知自然消散");
  await resources.cdp.page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".companion-card{transform:translateY(1200px)!important}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    window.__s06mNoticeSheet = sheet;
  });
}

async function clearOffscreenNotificationPage(resources) {
  await resources.cdp.page.evaluate(() => {
    document.adoptedStyleSheets = document.adoptedStyleSheets
      .filter((sheet) => sheet !== window.__s06mNoticeSheet);
    delete window.__s06mNoticeSheet;
  });
}

async function teardown(resources, cleanupErrors) {
  try {
    if (resources.characterPaused && resources.characterSession) {
      await resources.characterSession.send("Debugger.resume").catch(() => {});
      resources.characterPaused = false;
    }
    if (resources.characterSession) {
      await resources.characterSession.detach().catch(() => {});
      resources.characterSession = null;
    }
    if (resources.characterBrowser) {
      await resources.characterBrowser.close().catch(() => {});
      resources.characterBrowser = null;
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (resources.cdp) await resources.cdp.browser.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (resources.launched) await closeApp(resources.launched);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await resources.context?.server?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const target of [resources.context?.dataDir, resources.context?.home]) {
    if (!target) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error(`临时目录未清理：${target}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

test("POL-AUTONOTICE-UI-001 衣装卡真实可见350ms、单收据并点击正确角色", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "outfit");
    assert.equal(notice.storyId, OUTFIT_STORY);
    assert.equal(receipts(context.dataDir).length, 0, "准备不写收据");
    const idleWindow = (await snapshotOf(launched.page)).desktop.notifications.window;
    assert.equal(idleWindow.focusable, false, "自动告知窗口不得可聚焦");
    assert.notEqual(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      "characters",
      "展示自动卡不得自动打开管理窗目标",
    );

    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.evaluate(() => {
      window.__s06mResults = [];
      window.notifications.onCompanionResult((result) => window.__s06mResults.push(result));
    });
    const card = resources.cdp.page.locator(".companion-card");
    await card.waitFor({ state: "visible", timeout: 10000 });
    const cardText = await card.innerText();
    assert.match(cardText, /凛/);
    assert.match(cardText, /温茶围裙/);
    assert.match(cardText, /围裙前面缝个口袋/);
    assert.match(cardText, /已记录的衣装故事/);
    const cardIdentity = await card.evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
      transportToken: node.dataset.transportToken,
      generation: node.dataset.generation,
    }));
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "001-visible"));
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "实际显示收据");
    const receipt = receipts(context.dataDir)[0];
    const shownAt = (await snapshotOf(launched.page)).desktop.notifications.window.shownAt;
    assert.ok(Number.isFinite(shownAt));
    assert.ok(receipt.presented_at - shownAt >= 350, "收据必须晚于真实可见 350ms");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal((await snapshotOf(launched.page)).companionship.current.characterId, "rin");

    const ackResult = await waitFor(async () => {
      const results = await resources.cdp.page.evaluate(() => window.__s06mResults);
      return results.find((result) => result.accepted === true) ?? null;
    }, 10000, "ACK 原始结果");
    assert.equal(ackResult.noticeId, cardIdentity.noticeId);
    assert.equal(ackResult.noticeToken, cardIdentity.noticeToken, "结果必须回显原 noticeToken");
    assert.equal(ackResult.token, Number(cardIdentity.transportToken), "结果必须回显原 transport token");
    assert.equal(ackResult.generation, cardIdentity.generation);

    // 真实 Playwright 鼠标输入，不用 DOM.click 伪造点击。
    const actionButton = resources.cdp.page.locator(".companion-card .companion-action");
    await actionButton.waitFor({ state: "visible", timeout: 5000 });
    await actionButton.evaluate((button) => {
      if (button.disabled) throw new Error("action button still disabled");
    });
    const actionBox = await actionButton.boundingBox();
    assert.ok(actionBox && actionBox.width > 0 && actionBox.height > 0);
    await resources.cdp.page.mouse.click(
      actionBox.x + actionBox.width / 2,
      actionBox.y + actionBox.height / 2,
    );
    await delay(1200);
    record.facts.action = {
      results: await resources.cdp.page.evaluate(() => window.__s06mResults),
      ackResult,
      cardIdentity,
      cardCount: await resources.cdp.page.locator(".companion-card").count(),
      activePage: await launched.page.evaluate(() => document.body.dataset.activePage),
      title: await launched.page.locator("#page-title").innerText().catch(() => null),
      managementVisible: await launched.page.locator('[data-page="characters"]').isVisible().catch(() => false),
    };
    await waitFor(
      () => launched.page.locator('[data-page="characters"]').isVisible(),
      10000,
      "管理窗进入角色页",
    );
    await waitFor(
      async () => (await launched.page.locator("#character-name").innerText()).includes("凛"),
      10000,
      "衣装所属角色",
    );
    assert.equal(
      await launched.page.locator('[data-character-tab="overview"]').getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await launched.page.locator("#outfit-block").isVisible(), true);
    const worn = queryDb(
      context.dataDir,
      "SELECT value FROM app_state WHERE key = 'outfit_worn:rin'",
    )[0];
    const pending = queryDb(
      context.dataDir,
      "SELECT value FROM app_state WHERE key = 'outfit_pending:rin'",
    )[0];
    assert.equal(worn, undefined, "告知不得自动穿用衣装");
    assert.equal(pending, undefined);
    assert.equal(context.server.allRequests.length, 0, "自动告知不得调用模型");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      ...record.facts,
      receipt,
      shownAt,
      visibleDelayMs: receipt.presented_at - shownAt,
      cardIdentity,
      ackResult,
      cardText,
      character: await launched.page.locator("#character-name").innerText(),
      modelRequests: context.server.allRequests.length,
      pageErrors: resources.pageErrors,
    };
    await launched.page.screenshot({ path: path.join(EVIDENCE_DIR, "001-character-outfit.png") });
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("001", record);
  }
});

test("POL-AUTONOTICE-UI-002 相遇卡点击正确故事，稍后不再催促", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "invite");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "invitation");
    assert.equal(notice.storyId, INVITE_STORY);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    const card = resources.cdp.page.locator(".companion-card");
    await card.waitFor({ state: "visible", timeout: 10000 });
    const cardText = await card.innerText();
    assert.match(cardText, /琥珀/);
    assert.match(cardText, /引荐来源/);
    assert.match(cardText, /圆石头/);
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "002-visible"));

    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "邀请实际显示收据");
    const invitation = queryDb(
      context.dataDir,
      "SELECT * FROM discovery_invitations WHERE story_id = ?",
      [INVITE_STORY],
    )[0];
    assert.equal(invitation.status, "pending");
    assert.ok(invitation.quota_at > 0, "自动 ACK 同落 7 日额度");

    await resources.cdp.page.locator(".companion-card .companion-action").click();
    await waitFor(
      async () => (await launched.page.locator("#story-title").innerText()).includes("琥珀"),
      12000,
      "故事详情目标角色",
    );
    assert.equal(
      await launched.page.locator(`[data-story-id="${INVITE_STORY}"]`).getAttribute("aria-current"),
      "true",
    );
    await launched.page.locator("#story-later").click();
    await waitFor(
      () => queryDb(
        context.dataDir,
        "SELECT status FROM discovery_invitations WHERE story_id = ?",
        [INVITE_STORY],
      )[0]?.status === "later",
      10000,
      "稍后落定",
    );
    const rosterBefore = queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot");

    await forceOpportunity(launched.app, context.dataDir);
    await delay(1800);
    const laterNotice = (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null;
    assert.equal(laterNotice, null, "稍后邀请不得自动催促");
    assert.equal(receipts(context.dataDir).length, 1);
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot"),
      rosterBefore,
      "告知与稍后不得改名单",
    );
    assert.equal(context.server.allRequests.length, 0);
    assert.equal(
      queryDb(context.dataDir, "SELECT COUNT(*) AS count FROM relationships WHERE character_id = ?", [INVITE_TARGET])[0].count,
      0,
      "告知点击不得自动接纳",
    );
    assert.equal((await snapshotOf(launched.page)).companionship.current.characterId, "rin");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      receipt: receipts(context.dataDir)[0],
      invitation: queryDb(context.dataDir, "SELECT * FROM discovery_invitations WHERE story_id = ?", [INVITE_STORY])[0],
      cardText,
      noRushAfterLater: true,
      relationshipCreated: false,
      current: "rin",
      modelRequests: context.server.allRequests.length,
      pageErrors: resources.pageErrors,
    };
    await launched.page.screenshot({ path: path.join(EVIDENCE_DIR, "002-story-later.png") });
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("002", record);
  }
});

test("POL-AUTONOTICE-UI-010 邀请自动显示→不接纳→下一机会不催促→重开同一邀请→接纳隔离", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "invite");
  const { context, launched } = resources;
  try {
    execDb(context.dataDir, `
      INSERT INTO memory_entries
        (id, character_id, fact_key, origin_character_id, derived_from_entry_id,
         kind, body, trust, importance, expires_at, source_id, source_version,
         version, created_at, updated_at)
      VALUES ('ui-notice-rin-memory', 'rin', 'ui-notice-private', 'rin', NULL,
              'detail', '凛独属的窗边记忆', 'stated', 20, NULL, 'fixture', 1, 1, ?, ?)
    `, [Date.now(), Date.now()]);
    const stableOf = () => ({
      memories: queryDb(context.dataDir, "SELECT * FROM memory_entries ORDER BY id"),
      relationships: queryDb(context.dataDir,
        "SELECT * FROM relationships WHERE character_id = 'rin'"),
      stats: queryDb(context.dataDir,
        "SELECT * FROM character_stats WHERE character_id = 'rin'"),
      // last_settled_at 由正式 heartbeat 自然推进，不属于角色切换或接纳副作用。
      runtime: queryDb(context.dataDir, `
        SELECT character_id, mode, exploring, last_participated_at, last_auto_exit_at
        FROM character_runtime WHERE character_id = 'rin'
      `),
      roster: queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot"),
      interactions: queryDb(context.dataDir, "SELECT * FROM interactions"),
      state: queryDb(context.dataDir, `
        SELECT * FROM app_state
        WHERE key IN ('current_character_id', 'fixed_character_id', 'current_mode')
        ORDER BY key
      `),
      allRelationships: queryDb(context.dataDir,
        "SELECT * FROM relationships ORDER BY character_id"),
    });
    const stableBefore = stableOf();
    assert.ok(stableBefore.memories.length > 0, "原角色记忆必须非空");
    const charactersBefore = (await snapshotOf(launched.page)).companionship.characters;
    assert.equal(charactersBefore.some((item) => item.characterId === INVITE_TARGET), false);
    const modelRequestsBefore = context.server.allRequests.length;

    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "invitation");
    assert.equal(notice.storyId, INVITE_STORY);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "邀请自动真实ACK");
    const invitationBefore = queryDb(context.dataDir,
      "SELECT * FROM discovery_invitations WHERE story_id = ?", [INVITE_STORY])[0];
    assert.equal(invitationBefore.status, "pending");
    assert.ok(invitationBefore.quota_at > 0);
    const invitationId = invitationBefore.invitation_id;

    const actionButton = resources.cdp.page.locator(".companion-card .companion-action");
    await actionButton.waitFor({ state: "visible", timeout: 5000 });
    const box = await actionButton.boundingBox();
    await resources.cdp.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await waitFor(
      async () => (await launched.page.locator("#story-title").innerText()).includes("琥珀"),
      12000,
      "点击进入正确故事",
    );
    assert.equal(
      await launched.page.locator(`[data-story-id="${INVITE_STORY}"]`).getAttribute("aria-current"),
      "true",
    );
    await launched.page.locator("#story-reject").click();
    await waitFor(() => queryDb(context.dataDir,
      "SELECT status FROM discovery_invitations WHERE invitation_id = ?", [invitationId])[0]
      ?.status === "rejected", 10000, "不接纳落定");
    assert.equal(receipts(context.dataDir).length, 1);

    await forceOpportunity(launched.app, context.dataDir);
    await delay(2000);
    assert.equal(
      (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
      "不接纳后下一正式机会不催促",
    );
    const noRushReceipts = receipts(context.dataDir).length;
    const noRushStatus = queryDb(context.dataDir,
      "SELECT status FROM discovery_invitations WHERE invitation_id = ?", [invitationId])[0]
      ?.status;
    assert.equal(noRushReceipts, 1);
    assert.equal(noRushStatus, "rejected");

    await launched.page.locator("#story-reopen").click();
    await waitFor(() => queryDb(context.dataDir,
      "SELECT status FROM discovery_invitations WHERE invitation_id = ?", [invitationId])[0]
      ?.status === "pending", 10000, "手动重新开启");
    const reopened = queryDb(context.dataDir,
      "SELECT * FROM discovery_invitations WHERE invitation_id = ?", [invitationId])[0];
    assert.equal(reopened.invitation_id, invitationId, "重开必须复用原邀请ID");
    assert.equal(reopened.quota_at, invitationBefore.quota_at, "重开不得重记7日额度");
    assert.equal(reopened.displayed_at, invitationBefore.displayed_at, "重开不得重记自动显示");
    assert.equal(receipts(context.dataDir).length, 1);
    assert.equal(queryDb(context.dataDir,
      "SELECT COUNT(*) AS count FROM discovery_invitations WHERE story_id = ?", [INVITE_STORY])[0]
      .count, 1, "重开不得另造邀请");

    await launched.page.locator("#story-accept").click();
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship?.characters
        ?.some((item) => item.characterId === INVITE_TARGET) ? snapshot : null;
    }, 12000, "明确接纳后已结识列表新增目标");
    const stateAfter = await snapshotOf(launched.page);
    assert.equal(stateAfter.companionship.current.characterId, "rin", "接纳不得切换当前在屏角色");
    assert.equal(queryDb(context.dataDir,
      "SELECT COUNT(*) AS count FROM relationships WHERE character_id = ?", [INVITE_TARGET])[0]
      .count, 1);
    assert.equal(queryDb(context.dataDir,
      "SELECT COUNT(*) AS count FROM roster WHERE character_id = ?", [INVITE_TARGET])[0]
      .count, 0);
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM relationships WHERE character_id = 'rin'"),
      stableBefore.relationships,
    );
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM character_stats WHERE character_id = 'rin'"),
      stableBefore.stats,
    );
    assert.deepEqual(
      queryDb(context.dataDir, `
        SELECT character_id, mode, exploring, last_participated_at, last_auto_exit_at
        FROM character_runtime WHERE character_id = 'rin'
      `),
      stableBefore.runtime,
    );
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM memory_entries ORDER BY id"),
      stableBefore.memories,
      "原角色独属记忆必须保持不变",
    );
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot"),
      stableBefore.roster,
    );
    assert.deepEqual(
      queryDb(context.dataDir, `
        SELECT * FROM app_state
        WHERE key IN ('current_character_id', 'fixed_character_id', 'current_mode')
        ORDER BY key
      `),
      stableBefore.state,
      "当前在屏、固定位与模式不得改变",
    );
    assert.deepEqual(
      queryDb(context.dataDir,
        "SELECT * FROM relationships WHERE character_id != ? ORDER BY character_id",
        [INVITE_TARGET]),
      stableBefore.allRelationships,
      "除目标外不得新增关系",
    );
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM interactions"),
      stableBefore.interactions,
      "接纳不得自动开始聊天",
    );
    assert.equal(queryDb(context.dataDir,
      "SELECT COUNT(*) AS count FROM chat_conversations")[0].count, 0,
    "接纳不得新建聊天会话");
    assert.equal(context.server.allRequests.length, modelRequestsBefore, "接纳不得调用模型");
    assert.deepEqual(
      { ...queryDb(context.dataDir,
        "SELECT intimacy, energy, mood FROM character_stats WHERE character_id = ?", [INVITE_TARGET])[0] },
      { intimacy: 10, energy: 100, mood: 0 },
    );
    assert.equal(queryDb(context.dataDir,
      "SELECT mode FROM character_runtime WHERE character_id = ?", [INVITE_TARGET])[0].mode,
    "waiting");

    const repeat = await launched.page.evaluate(
      (id) => window.bayperStories.acceptInvitation(id),
      invitationId,
    );
    assert.equal(repeat.ok, true, JSON.stringify(repeat));
    assert.equal(repeat.duplicate, true);
    assert.equal(queryDb(context.dataDir,
      "SELECT COUNT(*) AS count FROM relationships WHERE character_id = ?", [INVITE_TARGET])[0]
      .count, 1, "再次接纳不得重复关系");
    assert.equal(
      (await snapshotOf(launched.page)).companionship.characters
        .filter((item) => item.characterId === INVITE_TARGET).length,
      1,
    );
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      invitationBefore,
      reopened,
      invitationId,
      noRushAfterReject: {
        companionNotice: null,
        receipts: noRushReceipts,
        status: noRushStatus,
      },
      invitationRows: queryDb(context.dataDir,
        "SELECT COUNT(*) AS count FROM discovery_invitations WHERE story_id = ?",
        [INVITE_STORY])[0].count,
      receiptsFinal: receipts(context.dataDir).length,
      acceptedCharacter: INVITE_TARGET,
      currentAfterAccept: stateAfter.companionship.current.characterId,
      stableBefore,
      repeatAccepted: repeat.duplicate === true,
      modelRequests: context.server.allRequests.length,
      pageErrors: resources.pageErrors,
    };
    const storyEvidencePath = path.join(EVIDENCE_DIR, "010-accepted-story.png");
    await launched.page.screenshot({ path: storyEvidencePath });
    record.screenshots.push(storyEvidencePath);
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("010", record);
  }
});

test("POL-AUTONOTICE-UI-011 持久状态门禁：当前活动/探索阻塞撤卡，旧消息无效，解除后只显示一次", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    // 本 Case 用隔离业务表持久状态 fixture 验证门禁，不声称通过真实活动/探索启动入口。
    const modelRequestsBefore = context.server.allRequests.length;
    await prepareOffscreenNotificationPage(resources, launched, context);
    const blockedAttempt = async (activityId, kind) => {
      await forceOpportunity(launched.app, context.dataDir);
      const notice = await waitCompanion(launched.page);
      assert.equal(notice.kind, "outfit");
      await resources.cdp.page.locator(".companion-card").waitFor({ state: "attached", timeout: 10000 });
      const identity = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
        noticeId: node.dataset.noticeId,
        noticeToken: node.dataset.noticeToken,
      }));
      insertRunningActivity(context.dataDir, activityId, kind);
      const blockedSnapshot = await waitFor(async () => {
        const snapshot = await snapshotOf(launched.page);
        return snapshot.companionship?.current?.activity?.status === "running"
          && (kind !== "exploration" || snapshot.companionship.current.exploring === true)
          ? snapshot : null;
      }, 5000, `${kind} 阻塞状态`);
      const pageBefore = await launched.page.evaluate(() => document.body.dataset.activePage);
      await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
        window.notifications.companionAck(noticeId, noticeToken);
        window.notifications.companionAction(noticeId, noticeToken, "open");
      }, identity);
      await waitCompanion(launched.page, { expect: false });
      await waitFor(
        () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
        5000,
        `${kind} 阻塞后撤卡`,
      );
      const receiptsAfterBlock = receipts(context.dataDir).length;
      const pendingAfterBlock = ownership(context.dataDir, OUTFIT_STORY).notification_pending;
      const pageAfter = await launched.page.evaluate(() => document.body.dataset.activePage);
      assert.equal(receiptsAfterBlock, 0, `${kind} 阻塞不得写收据`);
      assert.equal(pendingAfterBlock, 1);
      assert.equal(pageAfter, pageBefore, `${kind} 旧 action 不得导航`);
      clearRunningActivity(context.dataDir, activityId);
      await delay(1000);
      assert.equal(
        (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
        null,
        `${kind} 解除后不得立即补发`,
      );
      return {
        identity,
        kind,
        activity: blockedSnapshot.companionship.current.activity,
        exploring: blockedSnapshot.companionship.current.exploring,
        receiptsAfterBlock,
        pendingAfterBlock,
        pageUnchanged: pageAfter === pageBefore,
      };
    };

    const daily = await blockedAttempt("ui-notice-block-daily", "daily");
    const exploring = await blockedAttempt("ui-notice-block-exploring", "exploration");
    await clearOffscreenNotificationPage(resources);
    await forceOpportunity(launched.app, context.dataDir);
    const recovered = await waitCompanion(launched.page);
    assert.equal(recovered.kind, "outfit");
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "解除后下一机会真实ACK");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal(receipts(context.dataDir).length, 1, "解除后只显示确认一次");
    assert.equal(context.server.allRequests.length, modelRequestsBefore, "门禁恢复不得新增模型请求");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      daily,
      exploring,
      recovered,
      receipts: receipts(context.dataDir).length,
      current: (await snapshotOf(launched.page)).companionship.current,
      window: (await snapshotOf(launched.page)).desktop.notifications.window,
      modelRequests: context.server.allRequests.length,
      fixtures: {
        daily: "running daily character_activities row + runtime mode daily",
        exploring: "running exploration row + runtime exploring=1",
      },
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("011", record);
  }
});

test("POL-AUTONOTICE-UI-012 持久状态门禁：背景探索不阻塞，pendingRotation 等待撤卡并可恢复", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    // 本 Case 用隔离业务表持久状态 fixture；pendingRotation 不等同 hasBoundaryWaiters。
    seedBackgroundExploration(context.dataDir, "hu");
    const modelRequestsBefore = context.server.allRequests.length;
    await prepareOffscreenNotificationPage(resources, launched, context);
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "outfit", "背景探索不得阻塞前台自动告知");
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "attached", timeout: 10000 });
    const identity = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
    }));
    const background = (await snapshotOf(launched.page)).companionship;
    assert.equal(background.current.characterId, "rin");
    assert.equal(background.current.exploring, false);
    assert.equal(background.characters.find((item) => item.characterId === "hu")?.exploring, true);

    execDb(context.dataDir,
      "UPDATE character_stats SET energy = 20 WHERE character_id = 'rin'");
    execDb(context.dataDir, `
      INSERT INTO app_state (key, value) VALUES ('pending_rotation', 'low_energy')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    await waitFor(async () =>
      (await snapshotOf(launched.page)).companionship?.pendingRotation === true,
    5000, "pendingRotation 阻塞状态");
    const pageBefore = await launched.page.evaluate(() => document.body.dataset.activePage);
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
    }, identity);
    await waitCompanion(launched.page, { expect: false });
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      5000,
      "pendingRotation 后撤卡",
    );
    const receiptsAfterBlock = receipts(context.dataDir).length;
    const pendingAfterBlock = ownership(context.dataDir, OUTFIT_STORY).notification_pending;
    const pageAfter = await launched.page.evaluate(() => document.body.dataset.activePage);
    assert.equal(receiptsAfterBlock, 0, "pendingRotation 阻塞不得写收据");
    assert.equal(pendingAfterBlock, 1);
    assert.equal(pageAfter, pageBefore, "旧 action 不得导航");
    const pendingReason = (await snapshotOf(launched.page)).companionship.pendingRotationReason;
    assert.equal(pendingReason, "low_energy");

    execDb(context.dataDir,
      "UPDATE character_stats SET energy = 100 WHERE character_id = 'rin'");
    execDb(context.dataDir,
      "UPDATE app_state SET value = '0' WHERE key = 'pending_rotation'");
    await waitFor(async () =>
      (await snapshotOf(launched.page)).companionship?.pendingRotation === false,
    5000, "pendingRotation 解除");
    await delay(1000);
    assert.equal(
      (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
      "解除后不得立即补发",
    );
    await clearOffscreenNotificationPage(resources);
    await forceOpportunity(launched.app, context.dataDir);
    const recovered = await waitCompanion(launched.page);
    assert.equal(recovered.kind, "outfit");
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "恢复后真实ACK");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal(receipts(context.dataDir).length, 1, "恢复后只显示确认一次");
    const final = (await snapshotOf(launched.page)).companionship;
    assert.equal(final.current.characterId, "rin");
    assert.equal(
      final.characters.find((item) => item.characterId === "hu")?.exploring,
      true,
      "背景探索保持不受影响",
    );
    assert.equal(context.server.allRequests.length, modelRequestsBefore, "门禁恢复不得新增模型请求");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      notice,
      identity,
      background: {
        current: background.current.characterId,
        huExploring: background.characters.find((item) => item.characterId === "hu")?.exploring,
      },
      pendingReason,
      pendingBlock: {
        receipts: receiptsAfterBlock,
        notificationPending: pendingAfterBlock,
        pageUnchanged: pageAfter === pageBefore,
      },
      recovered,
      receipts: receipts(context.dataDir).length,
      final: {
        current: final.current.characterId,
        huExploring: final.characters.find((item) => item.characterId === "hu")?.exploring,
      },
      window: (await snapshotOf(launched.page)).desktop.notifications.window,
      modelRequests: context.server.allRequests.length,
      fixtures: {
        background: "hu accepted + roster row + running exploration + runtime exploring=1",
        pending: "rin energy=20 + app_state pending_rotation=low_energy",
      },
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("012", record);
  }
});

test("POL-AUTONOTICE-UI-013 正式companion:switch自然节点等待时撤卡，节点后完成并可恢复", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    seedReadyCompanion(context.dataDir, "hu");
    const modelRequestsBefore = context.server.allRequests.length;
    await prepareOffscreenNotificationPage(resources, launched, context);
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "outfit");
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "attached", timeout: 10000 });
    const identity = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
    }));

    // 仅在本轮自建角色渲染进程内暂停自然帧，保证 switch 的 boundary waiter
    // 有可观测等待窗口；恢复后仍走真实自然节点完成，不注入私有 waiter。
    const character = await connectCharacterPage(context.dataDir);
    resources.characterBrowser = character.browser;
    collectPageErrors(character.page, resources.pageErrors);
    resources.characterSession = await character.page.context().newCDPSession(character.page);
    await resources.characterSession.send("Debugger.enable");
    const pausedEvent = new Promise((resolve) => {
      resources.characterSession.once("Debugger.paused", resolve);
    });
    await resources.characterSession.send("Debugger.pause");
    const pauseConfirmed = await Promise.race([
      pausedEvent.then(() => true),
      delay(2000).then(() => false),
    ]);
    assert.equal(pauseConfirmed, true, "角色渲染进程未进入受控暂停");
    resources.characterPaused = true;

    let switchSettled = false;
    const switchStartedAt = Date.now();
    const switchPromise = launched.page.evaluate(
      () => window.bayper.switchCompanion("hu"),
    ).then((result) => {
      switchSettled = true;
      return result;
    });
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      const companion = snapshot.desktop?.notifications?.companionNotice ?? null;
      return companion === null
        && snapshot.companionship?.current?.characterId === "rin"
        && switchSettled === false
        ? snapshot : null;
    }, 8000, "switch 等待期间撤卡");
    const switchPendingAtCancelMs = Date.now() - switchStartedAt;
    const pageBefore = await launched.page.evaluate(() => document.body.dataset.activePage);
    await resources.cdp.page.locator(".companion-card").count().then((count) =>
      assert.equal(count, 0, "边界等待后 DOM 自动卡必须撤下"));
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
    }, identity);
    await delay(500);
    assert.equal(receipts(context.dataDir).length, 0, "边界等待不得写收据");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      pageBefore,
      "旧 action 不得导航",
    );

    await resources.characterSession.send("Debugger.resume");
    resources.characterPaused = false;
    const switched = await Promise.race([
      switchPromise,
      delay(12000).then(() => null),
    ]);
    assert.ok(switched, "自然节点后切换未完成");
    assert.equal(switched.ok, true, JSON.stringify(switched));
    const switchedSnapshot = await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship?.current?.characterId === "hu"
        && snapshot.desktop?.characterId === "hu"
        ? snapshot : null;
    }, 8000, "切换完成到 hu");
    assert.equal(receipts(context.dataDir).length, 0);

    await delay(1000);
    const postSwitchSnapshot = await snapshotOf(launched.page);
    const postSwitchCheckedAt = Date.now();
    assert.equal(
      postSwitchSnapshot.desktop?.notifications?.companionNotice ?? null,
      null,
      "边界完成后不得立即补发",
    );
    const postSwitchReceipts = receipts(context.dataDir).length;
    assert.equal(postSwitchReceipts, 0, "等待期内不得写入收据");
    await clearOffscreenNotificationPage(resources);
    await forceOpportunity(launched.app, context.dataDir);
    const recovered = await waitCompanion(launched.page);
    assert.equal(recovered.kind, "outfit");
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "恢复后真实ACK");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal(receipts(context.dataDir).length, 1, "恢复后只确认一次");
    assert.equal(context.server.allRequests.length, modelRequestsBefore, "边界与恢复不得新增模型请求");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      notice,
      identity,
      switchPendingAtCancelMs,
      switchResult: switched,
      currentAfterSwitch: switchedSnapshot.companionship.current.characterId,
      desktopAfterSwitch: switchedSnapshot.desktop.characterId,
      postSwitchCheckedAt,
      postSwitchCompanionNotice:
        postSwitchSnapshot.desktop?.notifications?.companionNotice ?? null,
      postSwitchReceipts,
      receiptsAtCancel: 0,
      pendingAtCancel: 1,
      recovered,
      receiptsFinal: receipts(context.dataDir).length,
      window: (await snapshotOf(launched.page)).desktop.notifications.window,
      modelRequests: context.server.allRequests.length,
      boundary: "real companion:switch IPC; character renderer paused only in this test process; resumed to complete a real natural node.",
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("013", record);
  }
});

test("POL-AUTONOTICE-UI-005 门禁失效旧消息无副作用，同源新token拒绝旧消息，真实收起", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const noticeA = await waitCompanion(launched.page);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    const identityA = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
      transportToken: node.dataset.transportToken,
      generation: node.dataset.generation,
    }));
    const injector = await createCompanionResultInjector(resources.cdp.page);
    assert.equal(receipts(context.dataDir).length, 0);

    // 聊天是真实上层门禁：准备后的机会被关闭，自动卡撤下。
    const chat = await launched.page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chat.ok, true, JSON.stringify(chat));
    await waitCompanion(launched.page, { expect: false });
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      5000,
      "聊天开始后自动卡撤下",
    );
    const pageBefore = await launched.page.evaluate(() => document.body.dataset.activePage);
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
      window.notifications.companionClose(noticeId, noticeToken);
    }, identityA);
    await delay(700);
    assert.equal(receipts(context.dataDir).length, 0, "门禁失效后的旧ACK不计数");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      pageBefore,
      "门禁失效后的旧action不导航",
    );
    assert.equal(
      await resources.cdp.page.locator(".companion-card").count(),
      0,
      "门禁失效后的旧close不复活卡片",
    );

    const closedChat = await launched.page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(closedChat.ok, true, JSON.stringify(closedChat));
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship?.current?.mode !== "interacting" ? snapshot : null;
    }, 10000, "聊天关闭");

    await forceOpportunity(launched.app, context.dataDir);
    const noticeB = await waitCompanion(launched.page);
    assert.equal(noticeB.noticeId, identityA.noticeId, "同一来源复用 noticeId");
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    const identityB = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
      transportToken: node.dataset.transportToken,
      generation: node.dataset.generation,
    }));
    assert.equal(identityB.noticeId, identityA.noticeId);
    assert.notEqual(identityB.noticeToken, identityA.noticeToken, "新展示必须使用新 noticeToken");

    // 旧结果包方向：同 noticeId、旧 noticeToken/transport token/generation，
    // 即使声称 accepted/navigated/acknowledged 也不得清新卡、抑制真实ACK或导航。
    assert.equal(receipts(context.dataDir).length, 0, "注入旧结果前新卡尚未回执");
    const injectionStartedAt = Date.now();
    const injected = await injector.inject({
      noticeId: identityB.noticeId,
      noticeToken: identityA.noticeToken,
      token: Number(identityA.transportToken),
      generation: identityA.generation,
      accepted: true,
      navigated: true,
      acknowledged: true,
      reason: null,
    });
    assert.equal(receipts(context.dataDir).length, 0, "旧结果不得写收据");
    assert.equal(
      await resources.cdp.page.locator(".companion-card").count(),
      1,
      "旧 accepted 结果不得清除新卡",
    );
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      pageBefore,
      "旧 navigated 结果不得导航",
    );

    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "新卡真实回执");
    assert.ok(
      receipts(context.dataDir)[0].presented_at >= injectionStartedAt,
      "真实ACK必须发生在旧结果注入之后",
    );
    await injector.dispose();

    // 新卡已真实回执后，旧 token 的 ACK/action/close 仍不得影响新卡或计数。
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
      window.notifications.companionClose(noticeId, noticeToken);
    }, identityA);
    await delay(700);
    assert.equal(receipts(context.dataDir).length, 1, "旧 noticeToken 不得新增收据");
    assert.equal(
      await resources.cdp.page.locator(".companion-card").count(),
      1,
      "旧 close 不得撤下新卡",
    );
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      pageBefore,
      "旧 action 不得导航",
    );
    await resources.cdp.page.locator(".companion-card .companion-close").click();
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      5000,
      "真实收起撤下卡片",
    );
    await delay(800);
    assert.equal(receipts(context.dataDir).length, 1, "收起不得重复计数");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      identityA,
      identityB,
      injected,
      injectionStartedAt,
      realAckPresentedAt: receipts(context.dataDir)[0].presented_at,
      oldMessagesAfterGate: { receipts: 0, pending: 1, cardCount: 0 },
      oldTokenOnNewCard: { receipts: 1, cardCount: 1, activePage: pageBefore },
      closeReceipts: receipts(context.dataDir).length,
      pageErrors: resources.pageErrors,
    };
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "005-closed"));
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("005", record);
  }
});

test("POL-AUTONOTICE-UI-006 休息与桌面未就绪撤卡，恢复后下一机会重试", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    await waitCompanion(launched.page);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    const card = resources.cdp.page.locator(".companion-card");
    await card.waitFor({ state: "visible", timeout: 10000 });
    const restingIdentity = await card.evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
    }));

    // 休息由正式入口改变，当前卡在下一次 tick 因门禁失效撤下。
    const rest = await launched.page.evaluate(() => window.bayper.restCompanion());
    assert.equal(rest.ok, true, JSON.stringify(rest));
    assert.equal(rest.mode, "resting");
    await waitCompanion(launched.page, { expect: false });
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      5000,
      "进入休息后自动卡撤下",
    );
    assert.equal(receipts(context.dataDir).length, 0);
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
      window.notifications.companionClose(noticeId, noticeToken);
    }, restingIdentity);
    await delay(500);
    assert.equal(receipts(context.dataDir).length, 0, "休息后的旧回执不计数");

    const wake = await launched.page.evaluate(() => window.bayper.switchCompanion("rin"));
    assert.equal(wake.ok, true, JSON.stringify(wake));
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship?.current?.mode !== "resting" ? snapshot : null;
    }, 10000, "唤醒");

    // 桌面子进程未就绪：任何非 ready 状态都撤下当前卡。
    await forceOpportunity(launched.app, context.dataDir);
    await waitCompanion(launched.page);
    const beforeKill = await snapshotOf(launched.page);
    const pid = beforeKill.desktop.pid;
    assert.ok(Number.isInteger(pid));
    process.kill(pid, "SIGKILL");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.desktop?.state !== "running"
        && (snapshot.desktop?.notifications?.companionNotice ?? null) === null
        ? snapshot : null;
    }, 15000, "子进程退出后撤卡");
    assert.equal(receipts(context.dataDir).length, 0);
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);

    const restored = await waitDesktop(launched.page);
    assert.ok(restored.desktop.pid !== pid);
    try {
      await resources.cdp.browser.close();
    } catch {
      // 旧窗口已随子进程销毁。
    }
    resources.cdp = null;
    await forceOpportunity(launched.app, context.dataDir);
    const resumed = await waitCompanion(launched.page);
    assert.equal(resumed.noticeId, restingIdentity.noticeId, "恢复后同一来源");
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    const resumedIdentity = await resources.cdp.page.locator(".companion-card").evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
    }));
    assert.notEqual(resumedIdentity.noticeToken, restingIdentity.noticeToken);
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "恢复后真实回执");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      restingIdentity,
      resumedIdentity,
      killPid: pid,
      restoredPid: restored.desktop.pid,
      receipts: receipts(context.dataDir).length,
      pageErrors: resources.pageErrors,
    };
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "006-resumed"));
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("006", record);
  }
});

test("POL-AUTONOTICE-UI-007 管理窗冷启动延迟初始快照仍应用告知目标", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    await waitCompanion(launched.page);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "实际显示收据");

    await delayInitialSnapshot(launched.app, 2000);
    const reloadPromise = launched.page.reload({ waitUntil: "domcontentloaded" });
    const actionButton = resources.cdp.page.locator(".companion-card .companion-action");
    await actionButton.waitFor({ state: "visible", timeout: 5000 });
    const actionBox = await actionButton.boundingBox();
    assert.ok(actionBox && actionBox.width > 0 && actionBox.height > 0);
    await resources.cdp.page.mouse.click(
      actionBox.x + actionBox.width / 2,
      actionBox.y + actionBox.height / 2,
    );
    await reloadPromise.catch(() => {});
    // 真实入口制造 snapshot-updated 先于被延迟的初始 getSnapshot 返回。
    const fixed = await launched.page.evaluate(() => window.bayper.setFixedCompanion("rin"));
    assert.equal(fixed.ok, true, JSON.stringify(fixed));

    await waitFor(
      () => launched.page.locator('[data-page="characters"]').isVisible(),
      8000,
      "snapshot-updated 后应应用衣装目标",
    );
    const targetAppliedAt = Date.now();
    const delayTrace = await waitFor(async () => {
      const trace = await readSnapshotDelay(launched.app);
      return trace?.returnedAt ? trace : null;
    }, 8000, "延迟初始 snapshot 返回");
    assert.ok(delayTrace.enteredAt <= delayTrace.returnedAt);
    assert.ok(
      delayTrace.returnedAt - delayTrace.enteredAt >= 1800,
      `初始 snapshot 实际延迟不足：${JSON.stringify(delayTrace)}`,
    );
    assert.ok(
      targetAppliedAt <= delayTrace.returnedAt,
      "目标应由先到的 snapshot-updated 应用",
    );

    // 等迟到 init 响应真正进入 renderer 并完成后，再验证没有被 home 覆盖。
    await delay(300);
    const finalCheckedAt = Date.now();
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      "characters",
      "迟到初始 snapshot 不得把目标覆盖为小窝",
    );
    await waitFor(
      async () => (await launched.page.locator("#character-name").innerText()).includes("凛"),
      8000,
      "冷启动目标角色",
    );
    assert.equal(await launched.page.locator("#outfit-block").isVisible(), true);
    const worn = queryDb(
      context.dataDir,
      "SELECT value FROM app_state WHERE key = 'outfit_worn:rin'",
    )[0];
    assert.equal(worn, undefined, "冷启动跳转不得自动穿用");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      activePage: "characters",
      character: await launched.page.locator("#character-name").innerText(),
      outfitVisible: true,
      wornAutoApplied: false,
      targetAppliedAt,
      finalCheckedAt,
      snapshotDelayTrace: delayTrace,
      pageErrors: resources.pageErrors,
    };
    await launched.page.screenshot({ path: path.join(EVIDENCE_DIR, "007-cold-target.png") });
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("007", record);
  }
});

test("POL-AUTONOTICE-UI-008 ACK后真实保持6秒、重复ACK不续命、重启不重播", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "outfit");
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    const card = resources.cdp.page.locator(".companion-card");
    await card.waitFor({ state: "visible", timeout: 10000 });
    const identity = await card.evaluate((node) => ({
      noticeId: node.dataset.noticeId,
      noticeToken: node.dataset.noticeToken,
    }));
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "首次真实ACK");
    const receipt = receipts(context.dataDir)[0];
    const windowFact = (await snapshotOf(launched.page)).desktop.notifications.window;
    const desktopBefore = (await snapshotOf(launched.page)).desktop;
    const appProcessBefore = resources.launched.app.process();
    const appPidBefore = appProcessBefore.pid;
    const rosterBefore = queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot");
    const outfitStateBefore = queryDb(context.dataDir,
      "SELECT * FROM app_state WHERE key LIKE 'outfit_%' ORDER BY key");
    const modelRequestsBefore = context.server.allRequests.length;
    const waitUntil = (target) => delay(Math.max(0, target - Date.now()));

    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.__s06mDuplicate = null;
      window.notifications.onCompanionResult((result) => {
        if (result.noticeId === noticeId
          && result.noticeToken === noticeToken
          && result.duplicate === true) {
          window.__s06mDuplicate = result;
        }
      });
    }, identity);
    // 首次收据后绝对 3 秒再发真实重复 ACK，确保落在 6 秒持有期内。
    await waitUntil(receipt.presented_at + 3000);
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
    }, identity);
    const duplicateSentAt = Date.now();
    const duplicate = await waitFor(
      () => resources.cdp.page.evaluate(() => window.__s06mDuplicate),
      3000,
      "重复ACK结果",
    );
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    const duplicateAt = Date.now();
    assert.ok(duplicateAt >= receipt.presented_at + 2800, `重复ACK过早：${duplicateAt - receipt.presented_at}ms`);
    assert.ok(duplicateAt <= receipt.presented_at + 3800, `重复ACK过晚：${duplicateAt - receipt.presented_at}ms`);
    assert.equal(receipts(context.dataDir).length, 1, "重复ACK不得新增收据");

    // 绝对 4.5 秒时卡必须仍在；截图作为持有期证据。
    await waitUntil(receipt.presented_at + 4500);
    const observedHoldAt = Date.now();
    const stillThere = (await snapshotOf(launched.page)).desktop.notifications.companionNotice;
    assert.ok(stillThere, "ACK后约4.5秒仍应保留展示副本");
    assert.equal(
      await resources.cdp.page.locator(".companion-card").count(),
      1,
      "ACK后约4.5秒 DOM 卡仍应存在",
    );
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "008-hold"));
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      6000,
      "ACK后6秒撤下展示副本",
    );
    const removedAt = Date.now();
    const holdMs = removedAt - receipt.presented_at;
    assert.ok(holdMs >= 5500, `ACK后保持不足6秒：${holdMs}ms`);
    assert.ok(holdMs <= 7500, `ACK后超过预期持有：${holdMs}ms`);
    assert.ok(
      removedAt + 1000 < duplicateAt + 6000,
      `撤下必须明显早于重复ACK+6秒：removed=${removedAt} duplicate=${duplicateAt}`,
    );
    assert.equal(receipts(context.dataDir).length, 1);
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);

    await resources.cdp.browser.close().catch(() => {});
    resources.cdp = null;
    await closeApp(resources.launched);
    await waitFor(
      () => {
        try {
          process.kill(appPidBefore, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      },
      8000,
      "管理应用主进程未真实退出",
    );
    assert.ok(
      appProcessBefore.exitCode !== null || appProcessBefore.signalCode !== null,
      "closeApp 未产生真实退出状态",
    );
    resources.launched = await launchApp(context);
    const appPidAfter = resources.launched.app.process().pid;
    assert.notEqual(appPidAfter, appPidBefore, "重启应产生新的管理应用主进程 PID");
    collectPageErrors(resources.launched.page, resources.pageErrors);
    await waitDesktop(resources.launched.page);
    const restartedDesktop = (await snapshotOf(resources.launched.page)).desktop;
    assert.notEqual(restartedDesktop.pid, desktopBefore.pid, "重启应产生新桌面子进程");
    await forceOpportunity(resources.launched.app, context.dataDir);
    await delay(2000);
    assert.equal(
      (await snapshotOf(resources.launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
      "已确认来源重启后不得重播",
    );
    assert.equal(receipts(context.dataDir).length, 1, "重启不得新增收据");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal(context.server.allRequests.length, modelRequestsBefore, "重启机会不得新增模型请求");
    assert.deepEqual(queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot"), rosterBefore);
    assert.deepEqual(
      queryDb(context.dataDir, "SELECT * FROM app_state WHERE key LIKE 'outfit_%' ORDER BY key"),
      outfitStateBefore,
      "重启不得改变换装意图或穿着",
    );
    const worn = queryDb(context.dataDir,
      "SELECT value FROM app_state WHERE key = 'outfit_worn:rin'")[0];
    assert.equal(worn, undefined, "告知与重启不得自动穿用");
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      identity,
      receipt,
      duplicate,
      holdMs,
      duplicateSentAt,
      duplicateAt,
      observedHoldAt,
      removedAt,
      shownAt: windowFact.shownAt,
      windowFocusable: windowFact.focusable,
      appPidBefore,
      appPidAfter,
      appExitCode: appProcessBefore.exitCode,
      appExitSignal: appProcessBefore.signalCode,
      desktopPidBefore: desktopBefore.pid,
      desktopPidAfter: restartedDesktop.pid,
      modelRequests: context.server.allRequests.length,
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("008", record);
  }
});

test("POL-AUTONOTICE-UI-009 不完整可见时10秒撤下、无收据、下一机会恢复", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    // 先用受控工作事件预建真实通知页；它不使用自动告知通道，也不占用气泡额度。
    execDb(context.dataDir, `
      INSERT INTO connector_events
        (app_run_id, instance_id, run_id, kind, state, priority,
         notification_status, received_at)
      VALUES ('s06m-ui-work', 's06m-ui-work', 's06m-ui-work', 'online', 'idle', 2,
              'pending', ?)
    `, [Date.now()]);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await waitFor(async () =>
      (await snapshotOf(launched.page)).desktop?.notifications?.panels.length > 0,
    10000, "工作通知呈现");
    await waitFor(async () =>
      (await snapshotOf(launched.page)).desktop?.notifications?.panels.length === 0,
    12000, "工作通知自然消散");
    assert.equal(receipts(context.dataDir).length, 0, "工作通知不得产生自动告知收据");
    assert.equal(
      (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
    );
    // 受控几何：用 CSSOM 构造样式把后续自动卡移出真实视口；不触发 CSP inline，
    // 也不调用 runtime 私有方法或伪造 ACK。
    await resources.cdp.page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".companion-card{transform:translateY(1200px)!important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.__s06mNoticeSheet = sheet;
    });
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    assert.equal(notice.kind, "outfit");
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "attached", timeout: 10000 });
    const geometry = await resources.cdp.page.locator(".companion-card").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        rect: rect.toJSON(),
        innerHeight: window.innerHeight,
        fullyVisible: rect.top >= -0.5 && rect.bottom <= window.innerHeight + 0.5,
      };
    });
    assert.equal(geometry.fullyVisible, false, "受控几何下卡不得完整可见");
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "009-offscreen"));
    const observedAt = Date.now();
    await delay(5000);
    assert.equal(receipts(context.dataDir).length, 0, "不可见卡不得写收据");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);
    await waitCompanion(launched.page, { expect: false });
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      8000,
      "不可见卡10秒撤下",
    );
    const removedAt = Date.now();
    const waitMs = removedAt - observedAt;
    assert.ok(waitMs >= 8000, `不可见卡撤下过早：${waitMs}ms`);
    assert.ok(waitMs <= 11000, `不可见卡超过10秒未撤下：${waitMs}ms`);
    const receiptsAfterCancel = receipts(context.dataDir).length;
    const pendingAfterCancel = ownership(context.dataDir, OUTFIT_STORY).notification_pending;
    assert.equal(receiptsAfterCancel, 0, "10秒撤下后仍不得有收据");
    assert.equal(pendingAfterCancel, 1, "未确认内容必须保留");
    assert.equal(
      (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
    );

    await resources.cdp.page.evaluate(() => {
      document.adoptedStyleSheets = document.adoptedStyleSheets
        .filter((sheet) => sheet !== window.__s06mNoticeSheet);
      delete window.__s06mNoticeSheet;
    });
    await forceOpportunity(launched.app, context.dataDir);
    const recovered = await waitCompanion(launched.page);
    assert.equal(recovered.kind, "outfit", "下一合法机会重试保留内容");
    await waitFor(() => receipts(context.dataDir).length === 1, 10000, "恢复后真实ACK");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 0);
    assert.equal(receipts(context.dataDir).length, 1, "恢复后只确认一次");
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "009-recovered"));
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    const rosterAfter = queryDb(context.dataDir, "SELECT * FROM roster ORDER BY day, slot");
    assert.ok(rosterAfter.length > 0);
    const worn = queryDb(context.dataDir,
      "SELECT value FROM app_state WHERE key = 'outfit_worn:rin'")[0];
    assert.equal(worn, undefined, "不可见撤卡与恢复不得自动穿用");
    record.facts = {
      notice,
      geometry,
      observedAt,
      removedAt,
      waitMs,
      receiptsAfterCancel,
      pendingAfterCancel,
      workFixture: "constructed connector_events row; no automatic-notice receipt",
      receiptsFinal: receipts(context.dataDir).length,
      pendingFinal: ownership(context.dataDir, OUTFIT_STORY).notification_pending,
      recovered,
      rosterRows: rosterAfter.length,
      wornAutoApplied: Boolean(worn),
      window: (await snapshotOf(launched.page)).desktop.notifications.window,
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    try {
      const snapshot = await snapshotOf(launched.page);
      record.facts.debug = {
        appState: queryDb(context.dataDir,
          "SELECT key, value FROM app_state WHERE key LIKE 'automatic_%' OR key LIKE 'outfit_%' OR key = 'current_mode' ORDER BY key"),
        ownership: queryDb(context.dataDir, "SELECT * FROM discovery_outfit_ownership"),
        receipts: receipts(context.dataDir),
        current: snapshot.companionship?.current ?? null,
        notifications: snapshot.desktop?.notifications ?? null,
        cardGeometry: await resources.cdp?.page.locator(".companion-card").evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return {
            transform: getComputedStyle(node).transform,
            rect: rect.toJSON(),
            innerHeight: window.innerHeight,
          };
        }).catch(() => null),
      };
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.facts.pageErrors = resources.pageErrors;
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("009", record);
  }
});


test("POL-AUTONOTICE-UI-003 工作通知抢占自动卡，旧ACK/action不生效", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    const oldToken = await resources.cdp.page.locator(".companion-card").getAttribute("data-notice-token");
    assert.ok(oldToken);
    // 受控工作事件进入正式 connector_events/notificationPresentation 链路。
    const receivedAt = Date.now();
    execDb(context.dataDir, `
      INSERT INTO connector_events
        (app_run_id, instance_id, run_id, kind, state, priority,
         notification_status, received_at)
      VALUES ('s06m-ui-run', 's06m-ui-instance', 's06m-ui-run', 'online', 'idle', 2,
              'pending', ?)
    `, [receivedAt]);
    await waitCompanion(launched.page, { expect: false });
    const workView = await waitFor(async () => {
      const view = (await snapshotOf(launched.page)).desktop?.notifications;
      return view?.panels?.length > 0 && view.companionNotice === null ? view : null;
    }, 5000, "工作通知呈现");
    assert.equal(receipts(context.dataDir).length, 0, "抢占前未确认不得写收据");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);
    await waitFor(async () => {
      const text = await resources.cdp.page.locator("#stack").innerText();
      return /已连接/.test(text) ? text : null;
    }, 8000, "工作通知可见");
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      3000,
      "工作通知到达后自动卡撤下",
    );
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "003-work-priority"));

    const pageBefore = await launched.page.evaluate(() => document.body.dataset.activePage);
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
      window.notifications.companionClose(noticeId, noticeToken);
    }, { noticeId: notice.noticeId, noticeToken: oldToken });
    await delay(700);
    assert.equal(
      await resources.cdp.page.locator(".companion-card").count(),
      0,
      "旧自动卡不得残留",
    );
    assert.equal(receipts(context.dataDir).length, 0, "旧自动ACK不得生效");
    assert.equal(
      await launched.page.evaluate(() => document.body.dataset.activePage),
      pageBefore,
      "旧自动 action 不得打开管理窗目标",
    );
    assert.equal(context.server.allRequests.length, 0);
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      ...record.facts,
      oldNoticeId: notice.noticeId,
      oldToken,
      workPresentations: workView.panels.map((item) => item.presentationId),
      workText: await resources.cdp.page.locator("#stack").innerText(),
      receipts: receipts(context.dataDir).length,
      pending: ownership(context.dataDir, OUTFIT_STORY).notification_pending,
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    try {
      record.facts.debug = {
        events: queryDb(context.dataDir,
          "SELECT id, kind, state, priority, historical, notification_status FROM connector_events ORDER BY id"),
        presentations: queryDb(context.dataDir,
          "SELECT presentation_id, channel, state FROM notification_presentations ORDER BY rowid"),
        notifications: (await snapshotOf(launched.page)).desktop?.notifications ?? null,
        logs: launched.logs.slice(-30),
      };
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("003", record);
  }
});

test("POL-AUTONOTICE-UI-004 隐藏/暂停不假ACK，恢复不立即补发", {
  timeout: 180000,
}, async (t) => {
  const record = { facts: {}, screenshots: [], cleanupErrors: [] };
  const resources = await setupCaseAndApp(t, "outfit");
  const { context, launched } = resources;
  try {
    await forceOpportunity(launched.app, context.dataDir);
    const notice = await waitCompanion(launched.page);
    resources.cdp = await connectNotificationPage(context.dataDir);
    watchNotificationPage(resources);
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 10000 });
    const oldToken = await resources.cdp.page.locator(".companion-card").getAttribute("data-notice-token");

    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(launched.page)).system.paused === true, 5000, "系统暂停");
    await waitCompanion(launched.page, { expect: false });
    await waitFor(
      () => resources.cdp.page.locator(".companion-card").count().then((count) => count === 0),
      3000,
      "暂停时自动卡撤下",
    );
    await resources.cdp.page.evaluate(({ noticeId, noticeToken }) => {
      window.notifications.companionAck(noticeId, noticeToken);
      window.notifications.companionAction(noticeId, noticeToken, "open");
      window.notifications.companionClose(noticeId, noticeToken);
    }, { noticeId: notice.noticeId, noticeToken: oldToken });
    await delay(500);
    const visible = (await snapshotOf(launched.page)).desktop.notifications.window;
    assert.notEqual(visible.visible, true, "暂停时通知窗口不得可见");
    assert.equal(visible.actualVisible, false);
    assert.equal(receipts(context.dataDir).length, 0, "隐藏/暂停不得假ACK");
    assert.equal(ownership(context.dataDir, OUTFIT_STORY).notification_pending, 1);

    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitFor(async () => (await snapshotOf(launched.page)).system.paused === false, 5000, "系统恢复");
    await delay(1500);
    assert.equal(
      (await snapshotOf(launched.page)).desktop?.notifications?.companionNotice ?? null,
      null,
      "恢复不得立即补发积压",
    );
    assert.equal(receipts(context.dataDir).length, 0);

    await forceOpportunity(launched.app, context.dataDir);
    const resumed = await waitCompanion(launched.page);
    assert.equal(resumed.storyId, OUTFIT_STORY, "下一次正常机会重试保留内容");
    await resources.cdp.page.locator(".companion-card").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(receipts(context.dataDir).length, 0, "重新展示前仍不计数");
    record.screenshots.push(await screenshotNotification(resources.cdp.page, "004-resumed"));
    assert.equal(context.server.allRequests.length, 0);
    assert.deepEqual(resources.pageErrors, [], "管理窗与通知窗不得有 pageerror");
    record.facts = {
      ...record.facts,
      noticeId: notice.noticeId,
      pausedWindow: visible,
      receiptAfterPause: 0,
      noImmediateResend: true,
      resumedNotice: resumed,
      pageErrors: resources.pageErrors,
    };
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    await teardown(resources, record.cleanupErrors);
    writeCase("004", record);
  }
});
