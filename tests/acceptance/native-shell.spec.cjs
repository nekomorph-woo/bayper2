/* S08a 原生管理窗整合验收：真实 Electron/SQLite/本机模型 fixture。
   覆盖三页导航、两尺寸无整页滚动、角色浏览/临时聊天/记忆归属、长内容局部滚动与连接失败。
   不覆盖真实模型语义、来源授权、故事/连接页或桌面动画。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const { createStore } = require("../../app/store.cjs");
const { dbPath, localDay } = require("./s02-fixtures.cjs");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const EVIDENCE_DIR = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s08a-native-shell",
);
const MODEL_NAME = "fixture-shell";
const OK_KEY = "sk-fixture-shell";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendStructured(response, payload) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
    }),
  );
}

async function startFixtureServer() {
  const responders = [];
  let closed = false;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const responder = responders.shift();
      Promise.resolve(
        responder
          ? responder({ response })
          : sendStructured(response, { reply: "连接正常。", memoryCandidates: [] }),
      ).catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    enqueue(responder) {
      responders.push(responder);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-native-shell-"));
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const logs = [];
  const consoleLines = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  page.on("console", (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`[pageerror] ${error?.stack || error?.message || error}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs, consoleLines };
}

async function closeApp(app) {
  if (!app) {
    return;
  }
  try {
    await app.close();
  } catch {
    // 清理继续。
  }
}

async function waitForStep(page, name, timeout = 20000) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout });
}

async function openPage(page, name) {
  const button = page.locator(`[data-nav="${name}"]`);
  await button.click();
  await page.locator(`[data-page="${name}"]`).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await button.getAttribute("aria-current"), "page", `导航应高亮 ${name}`);
  assert.equal(
    await page.locator('#primary-nav [aria-current="page"]').count(),
    1,
    "导航同时只能有一个当前入口",
  );
}

async function openArrange(page) {
  await openPage(page, "characters");
  await page.locator('[data-character-tab="arrange"]').click();
  await page.locator("#fixed-select").waitFor({ state: "visible", timeout: 10000 });
}

async function completeOnboarding(page, baseUrl, wish = "想找安静陪着我的伙伴") {
  await waitForStep(page, "config");
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill(MODEL_NAME);
  await page.locator("#api-key").fill(OK_KEY);
  await page.locator("#config-submit").click();
  await waitForStep(page, "wish");
  await page.locator("#wish-input").fill(wish);
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await waitForStep(page, "home");
}

async function setOuterSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(220);
}

async function readSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function waitForSnapshot(page, predicate, timeout = 12000) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeout) {
    snapshot = await readSnapshot(page);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await delay(50);
  }
  assert.fail("等待真实快照超时");
}

function openDb(dataDir, readOnly = false) {
  return new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
}

function seedCompanions(dataDir, ids) {
  const db = openDb(dataDir);
  try {
    const acceptedAt = new Date().toISOString();
    for (const id of ids) {
      db.prepare(
        "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
      ).run(id, acceptedAt);
      db.prepare(`
        INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 18, 86, 2)
      `).run(id);
    }
  } finally {
    db.close();
  }
}

function seedRoster(dataDir, entries) {
  const db = openDb(dataDir);
  try {
    db.prepare("DELETE FROM roster WHERE day = ?").run(localDay(new Date()));
    const insert = db.prepare(
      "INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(localDay(new Date()), entry.slot, entry.characterId);
    }
  } finally {
    db.close();
  }
}

function seedMemories(dataDir, count) {
  const store = createStore(dataDir);
  try {
    for (let index = 0; index < count; index += 1) {
      store.memory.remember({
        characterId: "rin",
        factKey: `seed.native.${index}`,
        body: `分页记忆 ${String(index).padStart(3, "0")}：用于验证局部滚动与分页。`,
        kind: "detail",
        sourceId: `seed:native:${index}`,
      });
    }
    store.memory.remember({
      characterId: "rin",
      factKey: "seed.native.long",
      body: `长记忆：${"这是一段很长的记忆正文，用来检查编辑区是否仍可到达。".repeat(18)}`,
      kind: "experience",
      sourceId: "seed:native:long",
    });
  } finally {
    store.close();
  }
}

function readDbState(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return {
      model: db.prepare("SELECT model_name, base_url FROM model_config WHERE id = 1").get(),
      relationships: db
        .prepare("SELECT character_id, nickname FROM relationships ORDER BY character_id")
        .all(),
      roster: db
        .prepare("SELECT slot, character_id FROM roster WHERE day = ? ORDER BY slot")
        .all(localDay(new Date())),
      fixed: db
        .prepare("SELECT value FROM app_state WHERE key = 'fixed_character_id'")
        .get()?.value,
    };
  } finally {
    db.close();
  }
}

async function documentMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
  }));
}

async function assertNoDocumentScroll(page, label) {
  const metrics = await documentMetrics(page);
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label} 不应出现横向整页滚动：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.scrollHeight <= metrics.clientHeight + 1,
    `${label} 不应出现纵向整页滚动：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.bodyScrollWidth <= metrics.clientWidth + 1,
    `${label} body 不应横向溢出：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.bodyScrollHeight <= metrics.clientHeight + 1,
    `${label} body 不应纵向溢出：${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function assertInViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} 应有可点击尺寸`);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  assert.ok(box.x >= 0 && box.y >= 0, `${selector} 不应位于窗口外`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${selector} 不应横向被裁切`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${selector} 不应纵向被裁切`);
}

async function capture(page, name) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

function writeLog(name, context, launched, failure) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const lines = [
    `# ${name}`,
    `time: ${new Date().toISOString()}`,
    `failure: ${failure ? failure.stack || failure.message || String(failure) : "none"}`,
    "",
    "## renderer console",
    ...(launched?.consoleLines ?? context.consoleLines ?? []),
    "",
    "## application stdout/stderr",
    ...(launched?.logs ?? []),
    "",
  ];
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.log`), lines.join("\n"));
}

async function captureFailure(page, name) {
  if (!page) {
    return;
  }
  try {
    await capture(page, `${name}-failure.png`);
  } catch {
    // 失败现场截图不是主证据；失败日志仍会保留。
  }
}

/* 首次配置后写入真实 SQLite：三名已结识角色，今日名单只放凛与琥珀，澄保持名单外。 */
async function bootstrapData(dataDir, server, { memories = 0 } = {}) {
  const first = await launchApp(dataDir);
  try {
    await completeOnboarding(first.page, server.baseUrl);
  } finally {
    await closeApp(first.app);
  }
  seedCompanions(dataDir, ["hu", "cheng"]);
  seedRoster(dataDir, [
    { slot: "fixed", characterId: "rin" },
    { slot: "random_1", characterId: "hu" },
  ]);
  if (memories > 0) {
    seedMemories(dataDir, memories);
  }
}

test("POL-NATIVE-001 三页导航、两尺寸无整页滚动与真实 SQLite 状态", { timeout: 60000 }, async (t) => {
  const dataDir = makeDataDir();
  const server = await startFixtureServer();
  let launched = null;
  let failure = null;
  try {
    await bootstrapData(dataDir, server);
    launched = await launchApp(dataDir);
    const { app, page } = launched;
    await waitForStep(page, "home");
    await assertNoDocumentScroll(page, "小窝初始");

    assert.equal(await page.locator("[data-nav]").count(), 3, "只提供三个真实入口");
    const navTexts = await page.locator("[data-nav]").allTextContents();
    assert.deepEqual(navTexts.map((text) => text.trim()), ["小窝", "角色", "设置"]);

    const snapshot = await readSnapshot(page);
    assert.equal(snapshot.state, "accepted");
    assert.equal(snapshot.model.modelName, MODEL_NAME);
    assert.equal(snapshot.companionship.current.characterId, "rin");
    assert.equal(snapshot.companionship.roster.length, 2);
    assert.ok(snapshot.companionship.roster.length <= 5);
    assert.equal(snapshot.companionship.characters.length, 3);

    const dbState = readDbState(dataDir);
    assert.equal(dbState.model.model_name, snapshot.model.modelName);
    assert.equal(dbState.model.base_url, snapshot.model.baseUrl);
    assert.equal(dbState.relationships.length, 3);
    assert.deepEqual(
      dbState.roster.map((entry) => [entry.slot, entry.character_id]),
      snapshot.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      "名单 DOM/快照必须来自同一 SQLite 状态",
    );

    // 小窝数据由真实快照渲染，不是原型静态文案。
    assert.equal(await page.locator("#home-name").textContent(), snapshot.companionship.current.displayName);
    assert.equal(
      await page.locator("#stat-intimacy").textContent(),
      String(Math.round(snapshot.companionship.current.stats.intimacy)),
    );
    assert.equal(
      await page.locator("#stat-energy").textContent(),
      String(Math.round(snapshot.companionship.current.stats.energy)),
    );
    assert.equal(
      await page.locator("#stat-mood").textContent(),
      String(Math.round(snapshot.companionship.current.stats.mood)),
    );
    assert.equal(await page.locator("#roster-list .roster-row").count(), 2);

    for (const size of [
      { width: 1200, height: 800, label: "1200x800" },
      { width: 960, height: 680, label: "960x680" },
    ]) {
      await setOuterSize(app, size.width, size.height);
      for (const pageName of ["home", "characters", "settings"]) {
        await openPage(page, pageName);
        await assertNoDocumentScroll(page, `${pageName} ${size.label}`);
        await capture(page, `native-${pageName}-${size.label}.png`);
      }

      await openPage(page, "home");
      await assertInViewport(page, "#chat-current");
      assert.equal(await page.locator("#chat-current").isEnabled(), true);
      await assertInViewport(page, "#rest-companion");

      await openPage(page, "characters");
      await assertInViewport(page, "#character-chat");
      assert.equal(await page.locator("#character-chat").isEnabled(), true);
      assert.equal(await page.locator(".character-item").count(), 3);

      await openPage(page, "settings");
      await assertInViewport(page, "#check-model");
      assert.equal(await page.locator("#check-model").isEnabled(), true);
      const settingsText = await page.locator('[data-page="settings"]').innerText();
      assert.match(settingsText, /fixture-shell/);
      assert.match(settingsText, new RegExp(snapshot.model.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(settingsText.includes(OK_KEY), false, "设置页不得显示 Key");
      assert.equal(await page.locator('[data-page="settings"] input[type="password"]').count(), 0);
    }

    const afterBrowse = await readSnapshot(page);
    assert.equal(afterBrowse.companionship.current.characterId, "rin", "浏览页面不得切换当前角色");
    assert.deepEqual(
      afterBrowse.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      snapshot.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      "浏览页面不得改动今日名单",
    );
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "native-shell-001");
    throw error;
  } finally {
    writeLog("native-shell-001", { consoleLines: launched?.consoleLines ?? [] }, launched, failure);
    await closeApp(launched?.app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-NATIVE-002 浏览不改安排、昵称/固定持久化、临时聊天与记忆归属", { timeout: 60000 }, async (t) => {
  const dataDir = makeDataDir();
  const server = await startFixtureServer();
  let launched = null;
  let failure = null;
  try {
    await bootstrapData(dataDir, server);
    launched = await launchApp(dataDir);
    let { app, page } = launched;
    await waitForStep(page, "home");
    await setOuterSize(app, 960, 680);
    const before = await readSnapshot(page);
    const rosterBefore = before.companionship.roster.map((entry) => [
      entry.slot,
      entry.characterId,
    ]);

    // 选中名单外的澄：只改变详情，不切换在场角色或名单。
    await openPage(page, "characters");
    const chengItem = page.locator('.character-item[data-character-id="cheng"]');
    await chengItem.click();
    await page.locator('.character-item[data-character-id="cheng"][aria-current="true"]').waitFor();
    assert.equal(await page.locator("#character-name").textContent(), "澄");
    assert.match(await page.locator('.character-item[data-character-id="cheng"]').innerText(), /名单外/);
    const afterSelect = await readSnapshot(page);
    assert.equal(afterSelect.companionship.current.characterId, "rin");
    assert.deepEqual(
      afterSelect.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      rosterBefore,
    );

    // 改昵称：真实持久化，不改当前与名单。
    await page.locator('[data-character-tab="arrange"]').click();
    assert.equal(await page.locator("#nickname-character").inputValue(), "cheng");
    await page.locator("#nickname-input").fill("小澄");
    await page.locator("#nickname-save").click();
    await page.waitForFunction(
      () => document.querySelector("#arrange-status")?.textContent === "昵称已保存。",
    );
    const afterNickname = await readSnapshot(page);
    assert.equal(
      afterNickname.companionship.characters.find((entry) => entry.characterId === "cheng")
        .displayName,
      "小澄",
    );
    assert.equal(readDbState(dataDir).relationships.find((row) => row.character_id === "cheng").nickname, "小澄");

    // 设置固定陪伴：显式改动名单与固定位，但不切换当前角色。
    await page.locator("#fixed-select").selectOption("hu");
    await page.locator("#fixed-save").click();
    await page.waitForFunction(
      () => document.querySelector("#arrange-status")?.textContent === "固定陪伴已更新。",
    );
    const afterFixed = await readSnapshot(page);
    assert.equal(afterFixed.companionship.fixedCharacterId, "hu");
    assert.equal(readDbState(dataDir).fixed, "hu");
    assert.equal(afterFixed.companionship.current.characterId, "rin");
    const rosterAfterFixed = afterFixed.companionship.roster.map((entry) => [
      entry.slot,
      entry.characterId,
    ]);

    // 名单外角色可以临时聊天；导航不关闭聊天、不丢草稿、不改名单。
    await chengItem.click();
    await page.locator("#character-chat").click();
    await page.locator("#chat-panel").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.querySelector("#chat-title")?.textContent?.includes("澄"),
    );
    const temporary = await waitForSnapshot(
      page,
      (value) => value.companionship.interaction?.temporary === true,
    );
    assert.equal(temporary.companionship.current.characterId, "cheng");
    assert.deepEqual(
      temporary.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      rosterAfterFixed,
      "临时聊天不改名单；此前固定位显式改成了琥珀",
    );
    await page.locator("#chat-input").fill("这是一段还没发送的草稿");
    await openPage(page, "settings");
    assert.equal(await page.locator("#chat-panel").isVisible(), true, "导航不得关闭在途聊天");
    assert.equal(await page.locator("#chat-input").inputValue(), "这是一段还没发送的草稿");
    await capture(page, "native-chat-draft-settings-960x680.png");
    await page.keyboard.press("Escape");
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.nav),
      "settings",
      "发起按钮已隐藏时，关闭聊天应回到当前导航入口",
    );
    await waitForSnapshot(
      page,
      (value) => value.companionship.current.characterId === "rin" && !value.companionship.interaction,
    );

    await openPage(page, "characters");
    await chengItem.click();
    await page.locator("#character-chat").click();
    await page.locator("#chat-panel").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "character-chat",
      "Escape 后焦点应回到真实发起按钮",
    );
    await waitForSnapshot(
      page,
      (value) => value.companionship.current.characterId === "rin" && !value.companionship.interaction,
    );

    // 角色页记忆入口明确归属当前选中角色；模态覆盖时背景导航不可点击，Tab 不逃逸。
    await page.locator("#character-memory").click();
    await page.locator("#memory-overlay").waitFor({ state: "visible" });
    assert.equal(await page.locator("#memory-character").inputValue(), "cheng");
    const backgroundBlocked = await page.evaluate(() => {
      const selectors = ['#primary-nav [data-nav="settings"]', '.character-item[data-character-id="hu"]'];
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return Boolean(hit?.closest("#memory-overlay"));
      });
    });
    assert.deepEqual(backgroundBlocked, [true, true], "记忆面板打开时背景导航与角色入口不可点击");
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => Boolean(document.activeElement?.closest(".memory-dialog"))),
      true,
      "Shift+Tab 不应把焦点移出记忆面板",
    );
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => Boolean(document.activeElement?.closest(".memory-dialog"))),
        true,
        "Tab 不应把焦点移出记忆面板",
      );
    }
    await capture(page, "native-memory-owner-960x680.png");
    await page.keyboard.press("Escape");
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "character-memory",
      "Escape 后焦点应回到记忆发起按钮",
    );

    // 重启验证昵称与固定陪伴来自真实 SQLite。
    await closeApp(app);
    launched = null;
    launched = await launchApp(dataDir);
    ({ app, page } = launched);
    await waitForStep(page, "home");
    await openArrange(page);
    assert.equal(await page.locator("#fixed-select").inputValue(), "hu");
    await page.locator('.character-item[data-character-id="cheng"]').click();
    await page.locator('[data-character-tab="arrange"]').click();
    assert.equal(await page.locator("#nickname-input").inputValue(), "小澄");
    const persisted = await readSnapshot(page);
    assert.equal(persisted.companionship.fixedCharacterId, "hu");
    assert.equal(
      persisted.companionship.characters.find((entry) => entry.characterId === "cheng")
        .displayName,
      "小澄",
    );
    await assertNoDocumentScroll(page, "角色页重启后");
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "native-shell-002");
    throw error;
  } finally {
    writeLog("native-shell-002", { consoleLines: launched?.consoleLines ?? [] }, launched, failure);
    await closeApp(launched?.app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-NATIVE-003 长昵称、长聊天、分页记忆与模型连接失败均局部可达", { timeout: 90000 }, async (t) => {
  const dataDir = makeDataDir();
  const server = await startFixtureServer();
  let launched = null;
  let failure = null;
  try {
    await bootstrapData(dataDir, server, { memories: 35 });
    launched = await launchApp(dataDir);
    const { app, page } = launched;
    await waitForStep(page, "home");
    await setOuterSize(app, 960, 680);

    // 长昵称：标题省略但不撑破页面，详情仍可达。
    await openArrange(page);
    await page.locator('.character-item[data-character-id="cheng"]').click();
    await page.locator('[data-character-tab="arrange"]').click();
    const longName = "这是一段很长很长的角色昵称测试壹贰叁肆伍";
    assert.ok(longName.length <= 20);
    await page.locator("#nickname-input").fill(longName);
    await page.locator("#nickname-save").click();
    await page.waitForFunction(
      () => document.querySelector("#arrange-status")?.textContent === "昵称已保存。",
    );
    assert.equal(await page.locator("#character-name").textContent(), longName);
    await assertNoDocumentScroll(page, "长昵称角色页 960x680");

    // 长聊天：消息区局部滚动，输入与发送始终可见。
    await openPage(page, "home");
    await page.locator("#chat-current").click();
    await page.locator("#chat-panel").waitFor({ state: "visible" });
    const longReply = `长回复：${"这是一段较长的角色回复，用来检查消息区滚动。".repeat(40)}`;
    server.enqueue(({ response }) =>
      sendStructured(response, { reply: longReply, memoryCandidates: [] }),
    );
    await page.locator("#chat-input").fill("长消息".repeat(60));
    await page.locator("#chat-send").click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
          element.textContent.includes("长回复："),
        ),
      null,
      { timeout: 20000 },
    );
    assert.equal(
      await page.locator("#chat-history").evaluate((element) => element.scrollHeight > element.clientHeight),
      true,
      "长聊天应在消息区内滚动",
    );
    await assertInViewport(page, "#chat-input");
    await assertInViewport(page, "#chat-send");
    await assertNoDocumentScroll(page, "长聊天 960x680");
    await capture(page, "native-long-chat-960x680.png");
    await page.keyboard.press("Escape");
    await page.locator("#chat-panel").waitFor({ state: "hidden" });

    // 分页记忆：超过一页可翻页，编辑器与保存按钮在 960×680 仍可达。
    await openPage(page, "characters");
    await page.locator('.character-item[data-character-id="rin"]').click();
    await page.locator("#character-memory").click();
    await page.locator("#memory-overlay").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.querySelectorAll(".memory-entry").length > 0,
    );
    assert.equal(await page.locator("#memory-next").isEnabled(), true, "35 条记忆应可分页");
    const label = await page.locator("#memory-page-label").textContent();
    await page.locator("#memory-next").click();
    await page.waitForFunction(
      (previous) => document.querySelector("#memory-page-label")?.textContent !== previous,
      label,
    );
    assert.match(await page.locator("#memory-page-label").textContent(), /第 2 页/);
    await page.locator(".memory-entry").first().click();
    await assertInViewport(page, "#memory-save");
    await assertInViewport(page, "#memory-delete");
    assert.equal(
      await page.locator("#memory-list").evaluate((element) => element.scrollHeight > element.clientHeight),
      true,
      "超过一页记忆应在列表内滚动",
    );
    await assertNoDocumentScroll(page, "分页记忆 960x680");
    await capture(page, "native-long-memory-960x680.png");
    await page.keyboard.press("Escape");
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    // 连接检查：先成功，再关停本机服务验证错误可见且不被裁切。
    await openPage(page, "settings");
    await page.locator("#check-model").click();
    await page.waitForFunction(
      () => document.querySelector("#check-model-status")?.dataset.state === "ok",
    );
    assert.match(await page.locator("#check-model-status").textContent(), /正常/);
    await server.close();
    await page.locator("#check-model").click();
    await page.waitForFunction(
      () => document.querySelector("#check-model-status")?.dataset.state === "error",
    );
    assert.ok((await page.locator("#check-model-status").textContent()).length > 0);
    await assertInViewport(page, "#check-model-status");
    await assertNoDocumentScroll(page, "模型连接失败 960x680");
    await capture(page, "native-model-error-960x680.png");

    await setOuterSize(app, 1200, 800);
    await assertInViewport(page, "#check-model-status");
    await assertNoDocumentScroll(page, "模型连接失败 1200x800");
    await capture(page, "native-model-error-1200x800.png");
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "native-shell-003");
    throw error;
  } finally {
    writeLog("native-shell-003", { consoleLines: launched?.consoleLines ?? [] }, launched, failure);
    await closeApp(launched?.app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
