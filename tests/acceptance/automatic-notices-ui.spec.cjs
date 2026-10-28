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

async function teardown(resources, cleanupErrors) {
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
