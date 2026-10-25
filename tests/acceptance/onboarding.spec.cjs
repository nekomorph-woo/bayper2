/* S01 业务验收：通过 Playwright 启动真实 Electron 应用，使用独立临时数据目录、
   本机兼容模型服务与本机 SQLite。受控服务只验证协议与失败流程。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const { startModelServer, startRedirectServer } = require("./fixture-server.cjs");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence");
const DB_FILE = "bayper.sqlite3";
const OK_KEY = "sk-fixture-ok";

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s01-"));
  const server = await startModelServer();
  return { dataDir, server };
}

async function launchApp(ctx) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${ctx.dataDir}`],
  });
  const logs = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs };
}

async function teardown(ctx, app) {
  if (app) {
    try {
      await app.close();
    } catch {
      // 应用可能已由测试关闭；清理仍需继续。
    }
  }
  if (ctx.server) {
    await ctx.server.close();
  }
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

async function waitForStep(page, name) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout: 20000 });
}

async function waitForAlert(page, selector, code, timeout = 15000) {
  await page.waitForFunction(
    ({ target, expected }) => {
      const element = document.querySelector(target);
      return Boolean(element && !element.hidden && element.dataset.code === expected);
    },
    { target: selector, expected: code },
    { timeout },
  );
}

async function fillConfig(page, baseUrl, key, modelName = "fixture-model") {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill(modelName);
  await page.locator("#api-key").fill(key);
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function completeOnboarding(page, baseUrl, wish = "") {
  await fillConfig(page, baseUrl, OK_KEY);
  await page.locator("#config-submit").click();
  await waitForStep(page, "wish");
  await page.locator("#wish-input").fill(wish);
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await waitForStep(page, "home");
}

function openReadOnlyDb(dataDir) {
  return new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
}

function readState(dataDir) {
  const db = openReadOnlyDb(dataDir);
  try {
    const count = (sql) => db.prepare(sql).get().n;
    return {
      model: count("SELECT count(*) AS n FROM model_config"),
      relationships: count("SELECT count(*) AS n FROM relationships"),
      stats: db.prepare("SELECT intimacy, energy, mood FROM character_stats").get() ?? null,
      roster: db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
      current: db.prepare("SELECT value FROM app_state WHERE key = 'current_character_id'").get()?.value ?? null,
      fixed: db.prepare("SELECT value FROM app_state WHERE key = 'fixed_character_id'").get()?.value ?? null,
    };
  } finally {
    db.close();
  }
}

function readModelRow(dataDir) {
  const db = openReadOnlyDb(dataDir);
  try {
    return db.prepare("SELECT base_url, model_name, api_key_cipher FROM model_config WHERE id = 1").get() ?? null;
  } finally {
    db.close();
  }
}

function assertNoPlaintextKey(dataDir, key) {
  const raw = fs.readFileSync(path.join(dataDir, DB_FILE));
  assert.equal(raw.includes(Buffer.from(key, "utf8")), false, "数据库文件中不应出现明文 Key");
}

function localDay() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function assertSingleRelationship(dataDir, expectedId) {
  const state = readState(dataDir);
  assert.equal(state.relationships, 1);
  assert.deepEqual(
    state.stats ? { ...state.stats } : null,
    { intimacy: 10, energy: 100, mood: 0 },
  );
  assert.equal(state.roster.length, 1);
  assert.equal(state.roster[0].slot, "fixed");
  assert.equal(state.roster[0].day, localDay(), "名单应属于当日");
  assert.equal(state.roster[0].character_id, expectedId);
  assert.equal(state.current, expectedId);
  assert.equal(state.fixed, expectedId);
  return state;
}

test("POL-ONBOARD-001 首次配置：一次真实请求后进入许愿，Key 不进入快照/数据库明文", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const launched = await launchApp(ctx);
    app = launched.app;
    const page = launched.page;
    await waitForStep(page, "config");

    await fillConfig(page, ctx.server.baseUrl, "");
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "MISSING_KEY");
    assert.equal(ctx.server.requests.length, 0, "空 Key 不应发送请求");

    await page.locator("#model-name").fill("");
    await page.locator("#api-key").fill(OK_KEY);
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "INVALID_MODEL");
    assert.equal(ctx.server.requests.length, 0, "空模型名不应发送请求");

    await page.locator("#model-name").fill("fixture-model");
    await page.locator("#config-submit").click();
    await waitForStep(page, "wish");

    assert.equal(ctx.server.requests.length, 1, "一次提交只应发送一次连通检查");
    const request = ctx.server.requests[0];
    assert.match(request.url, /\/v1\/chat\/completions$/);
    assert.equal(request.hasAuthorization, true);
    assert.equal(request.body.model, "fixture-model");
    assert.equal(request.body.messages.length, 1);
    assert.equal(request.body.messages[0].role, "user");
    assert.match(request.body.messages[0].content, /连通检查/);
    assert.equal("thinking" in request.body, false, "通用兼容服务不应收到供应商私有字段");
    assert.equal(JSON.stringify(request.body).includes(OK_KEY), false, "请求体不应携带 Key");

    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.state, "configured");
    assert.equal(snapshot.model.configured, true);
    assert.equal(snapshot.model.modelName, "fixture-model");
    assert.equal("apiKey" in snapshot.model, false);
    assert.equal("keyCipher" in snapshot.model, false);
    assert.equal(JSON.stringify(snapshot).includes(OK_KEY), false);
    assert.equal(await page.locator("#api-key").inputValue(), "", "成功后应从 DOM 清除 Key");
    assert.equal((await page.content()).includes(OK_KEY), false);
    const browserStorage = await page.evaluate(() =>
      JSON.stringify(Object.keys(localStorage).map((name) => [name, localStorage.getItem(name)])),
    );
    assert.equal(browserStorage.includes(OK_KEY), false, "不应把配置或 Key 写入 localStorage");

    await app.close();
    app = null;

    const state = readState(ctx.dataDir);
    assert.equal(state.model, 1);
    assert.equal(state.relationships, 0);
    const modelRow = readModelRow(ctx.dataDir);
    assert.equal(modelRow.base_url, ctx.server.baseUrl);
    assert.equal(Buffer.from(modelRow.api_key_cipher).includes(Buffer.from(OK_KEY)), false);
    assertNoPlaintextKey(ctx.dataDir, OK_KEY);
    assert.equal(launched.logs.join("").includes(OK_KEY), false, "主进程日志不应包含 Key");
  } finally {
    await teardown(ctx, app);
  }
});

test("POL-ONBOARD-002 验证失败：401、非助手文本、超时都保留可编辑内容且可修正", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const launched = await launchApp(ctx);
    app = launched.app;
    const page = launched.page;
    await waitForStep(page, "config");
    await page.locator("#base-url").fill(ctx.server.baseUrl);
    await page.locator("#model-name").fill("fixture-model");

    const attempts = [
      ["sk-fixture-401", "AUTH_FAILED"],
      ["sk-fixture-role", "INVALID_RESPONSE"],
      ["sk-fixture-timeout", "TIMEOUT"],
    ];

    for (const [key, code] of attempts) {
      await page.locator("#api-key").fill(key);
      await page.locator("#config-submit").click();
      await waitForAlert(page, "#config-alert", code, code === "TIMEOUT" ? 15000 : 10000);
      assert.equal(await page.locator("#config-submit").isEnabled(), true);
      assert.equal(await page.locator("#base-url").inputValue(), ctx.server.baseUrl);
      assert.equal(await page.locator("#model-name").inputValue(), "fixture-model");
      assert.equal(await page.locator("#api-key").inputValue(), key, "失败后应保留可编辑内容");
    }

    assert.equal(ctx.server.requests.length, 3, "每次提交一次请求，不应自动重试风暴");
    assert.equal(readState(ctx.dataDir).model, 0, "失败不应保存配置");
    assert.equal(readState(ctx.dataDir).relationships, 0, "失败不应创建关系");

    await page.locator("#api-key").fill(OK_KEY);
    await page.locator("#config-submit").click();
    await waitForStep(page, "wish");
    assert.equal(ctx.server.requests.length, 4);
    await page.waitForTimeout(600);
    assert.equal(ctx.server.requests.length, 4, "成功后不应追加重复检查请求");

    await app.close();
    app = null;
    assert.equal(readState(ctx.dataDir).model, 1);
    assert.equal(readState(ctx.dataDir).relationships, 0);
  } finally {
    await teardown(ctx, app);
  }
});

test("POL-ONBOARD-003 愿望与接纳：推荐稳定、确认前零关系、重复接纳只创建一次", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx);
    app = first.app;
    const page = first.page;
    await fillConfig(page, ctx.server.baseUrl, OK_KEY);
    await page.locator("#config-submit").click();
    await waitForStep(page, "wish");

    const configured = await getSnapshot(page);
    assert.equal(configured.state, "configured");
    assert.equal(configured.relationship, null);
    assert.equal(readState(ctx.dataDir).relationships, 0);

    await page.locator("#wish-input").fill("想找安静陪着我的伙伴");
    await page.locator("#wish-submit").click();
    await page.locator("#candidate-card").waitFor({ state: "visible" });
    assert.equal(await page.locator("#candidate-name").textContent(), "凛");
    assert.match(await page.locator("#candidate-position").textContent(), /推荐/);
    assert.match(await page.locator("#candidate-reason").textContent(), /安静/);

    await page.locator("#next-candidate").click();
    assert.equal(await page.locator("#candidate-name").textContent(), "琥珀");
    await page.locator("#next-candidate").click();
    assert.equal(await page.locator("#candidate-name").textContent(), "澄");
    await page.locator("#next-candidate").click();
    assert.equal(await page.locator("#candidate-name").textContent(), "凛");

    await page.locator("#wish-input").fill("想要活泼一点，能聊天的");
    await page.locator("#wish-submit").click();
    await page.waitForFunction(
      () => document.querySelector("#candidate-name")?.textContent === "琥珀",
      null,
      { timeout: 5000 },
    );
    assert.equal(ctx.server.requests.length, 1, "愿望排序不应调用模型");

    await app.close();
    app = null;
    const beforeAccept = readState(ctx.dataDir);
    assert.equal(beforeAccept.relationships, 0);
    assert.equal(beforeAccept.roster.length, 0);
    assert.equal(beforeAccept.current, null);
    assert.equal(beforeAccept.model, 1);

    const second = await launchApp(ctx);
    app = second.app;
    const page2 = second.page;
    await waitForStep(page2, "wish");
    assert.equal(await page2.locator('[data-step="config"]').isVisible(), false);

    await page2.locator("#wish-submit").click();
    await page2.locator("#candidate-card").waitFor({ state: "visible" });
    assert.equal(await page2.locator("#candidate-name").textContent(), "凛", "空愿望使用默认顺序");

    await page2.evaluate(() => {
      const button = document.querySelector("#accept-button");
      button.click();
      button.click();
    });
    await waitForStep(page2, "home");
    assert.equal(await page2.locator("#home-name").textContent(), "凛");
    assert.equal(await page2.locator("#stat-intimacy").textContent(), "10");
    assert.equal(await page2.locator("#stat-energy").textContent(), "100");
    assert.equal(await page2.locator("#stat-mood").textContent(), "0");

    const again = await page2.evaluate(() => window.bayper.acceptCharacter("rin"));
    assert.equal(again.ok, true);
    assert.equal(again.alreadyAccepted, true);
    assert.equal(again.acceptedCharacterId, "rin");

    await app.close();
    app = null;
    assertSingleRelationship(ctx.dataDir, "rin");
    const state = readState(ctx.dataDir);
    assert.equal(state.model, 1);
    assert.equal(new Set(state.roster.map((row) => row.character_id)).size, 1);
  } finally {
    await teardown(ctx, app);
  }
});

test("POL-ONBOARD-004 重启恢复：模型服务不可达仍直接进入小窝并保留同一角色", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx);
    app = first.app;
    await completeOnboarding(first.page, ctx.server.baseUrl, "安静一点就好");
    const before = await getSnapshot(first.page);
    assert.equal(before.state, "accepted");
    const requestCount = ctx.server.requests.length;
    await app.close();
    app = null;

    await ctx.server.close();
    ctx.server = null;

    const second = await launchApp(ctx);
    app = second.app;
    const page = second.page;
    await waitForStep(page, "home");
    assert.equal(await page.locator('[data-step="config"]').isVisible(), false);
    assert.equal(await page.locator('[data-step="wish"]').isVisible(), false);
    assert.equal(await page.locator("#home-name").textContent(), before.currentCharacter.name);
    assert.equal(await page.locator("#stat-intimacy").textContent(), String(before.relationship.stats.intimacy));
    assert.equal(await page.locator("#stat-energy").textContent(), String(before.relationship.stats.energy));
    assert.equal(await page.locator("#stat-mood").textContent(), String(before.relationship.stats.mood));

    const after = await getSnapshot(page);
    assert.equal(after.state, "accepted");
    assert.equal(after.relationship.characterId, before.relationship.characterId);
    assert.equal(after.relationship.acceptedAt, before.relationship.acceptedAt);
    assert.deepEqual(
      { ...after.relationship.stats },
      { ...before.relationship.stats },
    );
    assert.equal(after.model.modelName, "fixture-model");
    assert.equal(requestCount, 1, "重启时不应再发连通检查");

    await app.close();
    app = null;
    const state = assertSingleRelationship(ctx.dataDir, before.relationship.characterId);
    assert.equal(state.model, 1);
  } finally {
    await teardown(ctx, app);
  }
});

test("POL-ONBOARD-005 配置与隔离边界：拒绝不安全配置与重定向，无 Key 外发/日志泄漏/外部页面", async () => {
  const ctx = await setup();
  let app = null;
  let redirect = null;
  try {
    const launched = await launchApp(ctx);
    app = launched.app;
    const page = launched.page;
    const consoleLines = [];
    page.on("console", (message) => consoleLines.push(message.text()));
    await waitForStep(page, "config");

    const key = "sk-fixture-boundary-005";

    await fillConfig(page, "http://example.com/v1", key);
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "INSECURE_URL");

    await fillConfig(page, "https://user:pass@example.com/v1", key);
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "INVALID_URL");

    await fillConfig(page, "file:///etc/passwd", key);
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "INVALID_URL");

    await fillConfig(page, ctx.server.baseUrl, key, "bad model");
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "INVALID_MODEL");

    redirect = await startRedirectServer(`${ctx.server.baseUrl}/chat/completions`);
    await fillConfig(page, redirect.baseUrl, key);
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "REDIRECT_BLOCKED");
    assert.equal(redirect.requests.length, 1, "重定向服务应收到一次初始请求");
    assert.equal(redirect.requests[0].hasAuthorization, true);
    assert.equal(ctx.server.allRequests.length, 0, "不得跟随重定向产生下游请求");

    assert.equal(ctx.server.requests.length, 0, "不安全或非法配置不应外发 Key");
    assert.equal(readState(ctx.dataDir).model, 0);

    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.state, "unconfigured");
    assert.equal(JSON.stringify(snapshot).includes(key), false);

    const surface = await page.evaluate(() => ({
      keys: Object.keys(window.bayper).sort(),
      requireType: typeof window.require,
      moduleType: typeof window.module,
      hasIpcRenderer: "ipcRenderer" in window,
    }));
    assert.deepEqual(surface.keys, [
      "acceptCharacter",
      "checkStoredModel",
      "getSnapshot",
      "recommendCharacters",
      "restCompanion",
      "setFixedCompanion",
      "setNickname",
      "switchCompanion",
      "validateAndSaveModel",
    ]);
    assert.equal(surface.requireType, "undefined");
    assert.equal(surface.moduleType, "undefined");
    assert.equal(surface.hasIpcRenderer, false);

    const rendererNetworkBlocked = await page.evaluate(async (baseUrl) => {
      try {
        await fetch(`${baseUrl}/chat/completions`, { method: "POST" });
        return false;
      } catch {
        return true;
      }
    }, ctx.server.baseUrl);
    assert.equal(rendererNetworkBlocked, true, "renderer 不应拥有任意网络能力");
    assert.equal(ctx.server.requests.length, 0);

    const urlBefore = page.url();
    const windowCountBefore = app.windows().length;
    const popupBlocked = await page.evaluate(() => window.open("https://example.com") === null);
    assert.equal(popupBlocked, true);

    await page.evaluate(() => {
      window.location.href = "https://example.com/";
    });
    await page.waitForTimeout(800);
    assert.equal(page.url(), urlBefore, "外部导航应被阻止");
    assert.equal(app.windows().length, windowCountBefore, "不应打开新窗口");

    const allLogs = [...consoleLines, ...launched.logs].join("\n");
    assert.equal(allLogs.includes(key), false, "日志不应包含 Key");

    await app.close();
    app = null;
    const state = readState(ctx.dataDir);
    assert.equal(state.model, 0);
    assert.equal(state.relationships, 0);
    assertNoPlaintextKey(ctx.dataDir, key);
  } finally {
    if (redirect) {
      await redirect.close();
    }
    await teardown(ctx, app);
  }
});

test("S01 视觉证据：三个步骤在 1200×800 与 960×680 下截图", async () => {
  const ctx = await setup();
  let app = null;
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const launched = await launchApp(ctx);
    app = launched.app;
    const page = launched.page;
    await waitForStep(page, "config");

    await fillConfig(page, ctx.server.baseUrl, "sk-fixture-401");
    await page.locator("#config-submit").click();
    await waitForAlert(page, "#config-alert", "AUTH_FAILED");

    await capture(app, page, "s02-r2-s01-01-config-error-1200x800.png");
    await capture(app, page, "s02-r2-s01-01-config-error-960x680.png", 960, 680);

    await page.locator("#api-key").fill(OK_KEY);
    await page.locator("#config-submit").click();
    await waitForStep(page, "wish");
    await page.locator("#wish-input").fill("想找安静陪着我的伙伴");
    await page.locator("#wish-submit").click();
    await page.locator("#candidate-card").waitFor({ state: "visible" });

    await capture(app, page, "s02-r2-s01-02-wish-960x680.png", 960, 680);
    await capture(app, page, "s02-r2-s01-02-wish-1200x800.png");

    await page.locator("#accept-button").click();
    await waitForStep(page, "home");
    await capture(app, page, "s02-r2-s01-03-home-960x680.png", 960, 680);
    await capture(app, page, "s02-r2-s01-03-home-1200x800.png");

    for (const name of [
      "s02-r2-s01-01-config-error-1200x800.png",
      "s02-r2-s01-01-config-error-960x680.png",
      "s02-r2-s01-02-wish-960x680.png",
      "s02-r2-s01-02-wish-1200x800.png",
      "s02-r2-s01-03-home-960x680.png",
      "s02-r2-s01-03-home-1200x800.png",
    ]) {
      const stat = fs.statSync(path.join(evidenceDir, name));
      assert.ok(stat.size > 10000, `${name} 应为有效截图`);
    }
  } finally {
    await teardown(ctx, app);
  }
});

async function capture(app, page, name, width = 1200, height = 800) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(evidenceDir, name) });
}
