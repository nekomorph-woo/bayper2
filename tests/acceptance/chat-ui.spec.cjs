/* S03b 聊天窗口切片一：真实 Electron、临时 data-dir、本地受控 HTTP。
   只验证管理窗聊天链路；真实模型语义、有效互动耗时和记忆管理列表不在本轮。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createChatViewGate } = require("../../app/renderer/chat-view-gate.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待测试条件超时。");
    }
    await delay(10);
  }
}

function sendStructured(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify(payload),
          },
        },
      ],
    }),
  );
}

function sendText(response, text, status = 200) {
  sendStructured(response, { reply: text, memoryCandidates: [] }, status);
}

async function startChatServer() {
  const requests = [];
  const responders = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({
        body,
        hasAuthorization: Boolean(request.headers.authorization),
      });
      const responder = responders.shift();
      Promise.resolve(
        responder ? responder({ body, response }) : sendText(response, "连接正常。"),
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
    requests,
    enqueue(responder) {
      responders.push(responder);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-ui-"));
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const logs = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs };
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

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-chat");
  await page.locator("#api-key").fill("sk-fixture-chat");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function waitForChatTitle(page, text) {
  await page.locator("#chat-panel").waitFor({ state: "visible" });
  await page.waitForFunction(
    (expected) => document.querySelector("#chat-title")?.textContent?.includes(expected),
    text,
  );
}

async function openCurrentChat(page, displayName) {
  await page.locator("#chat-current").click();
  await waitForChatTitle(page, displayName);
}

async function waitForAssistant(page, text) {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes(expected),
      ),
    text,
    15000,
  );
}

async function waitForUser(page, text) {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".chat-bubble-user")).some((element) =>
        element.textContent.includes(expected),
      ),
    text,
    15000,
  );
}

async function setWindowSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(120);
}

function openDb(dataDir, readOnly = false) {
  return new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
}

function readChatState(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return {
      roster: db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
      relationships: db
        .prepare("SELECT character_id FROM relationships ORDER BY character_id")
        .all(),
      interactions: db.prepare("SELECT * FROM interactions").all(),
      messages: db
        .prepare(
          "SELECT role, content, character_id, conversation_id FROM chat_messages ORDER BY seq",
        )
        .all(),
      requests: db
        .prepare(
          "SELECT id, status, error_code, character_id, conversation_id, memory_applied FROM chat_requests ORDER BY created_at, id",
        )
        .all(),
      conversations: db
        .prepare("SELECT id, character_id, closed_at FROM chat_conversations ORDER BY created_at")
        .all(),
    };
  } finally {
    db.close();
  }
}

function seedCompanion(dataDir, characterId) {
  const db = openDb(dataDir);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    ).run(characterId, new Date().toISOString());
    db.prepare(`
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `).run(characterId);
  } finally {
    db.close();
  }
}

test("S03b view gate 拒绝倒序历史与继续新聊天后的迟到结果", () => {
  const gate = createChatViewGate();
  gate.beginOpen();
  const slowX = gate.beginHistory();
  const fastY = gate.beginHistory();
  assert.equal(gate.current(slowX), false);
  assert.equal(gate.current(fastY), true);

  const switched = gate.beginOpen();
  assert.equal(gate.current(slowX), false);
  assert.equal(gate.current(fastY), false);
  assert.equal(gate.current(switched), true);

  const archived = gate.beginHistory();
  const continued = gate.invalidateView();
  assert.equal(gate.current(archived), false);
  assert.equal(gate.current(continued), true);

  const nextOpen = gate.beginOpen();
  assert.equal(gate.current(continued), false);
  assert.equal(gate.current(nextOpen), true);
  gate.reset();
  assert.equal(gate.current(nextOpen), false);
});

test("POL-CHAT-001 UI 聊天归属、历史关闭重开与尺寸", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    const baseline = server.requests.length;
    const rosterBefore = readChatState(dataDir).roster;
    const surface = await page.evaluate(() => ({
      keys: Object.keys(window.bayperChat).sort(),
      hasIpcRenderer: "ipcRenderer" in window,
    }));
    assert.deepEqual(surface.keys, [
      "cancelChatMessage",
      "closeChat",
      "getChatConversation",
      "onChatClosed",
      "openChat",
      "retryChatMessage",
      "sendChatMessage",
    ]);
    assert.equal(surface.hasIpcRenderer, false);

    await openCurrentChat(page, "凛");
    assert.equal(await page.locator("#chat-form").isVisible(), true);
    await setWindowSize(app, 960, 680);
    assert.equal(await page.locator("#chat-panel").isVisible(), true);
    assert.equal(await page.locator("#chat-input").isVisible(), true);
    const smallBox = await page.locator("#chat-input").boundingBox();
    assert.ok(smallBox && smallBox.y + smallBox.height <= 680);
    await setWindowSize(app, 1200, 800);
    const largeBox = await page.locator("#chat-input").boundingBox();
    assert.ok(largeBox && largeBox.y + largeBox.height <= 800);

    server.enqueue(({ response }) => sendText(response, "第一回复。"));
    await page.locator("#chat-input").fill("第一句");
    await page.locator("#chat-send").click();
    await waitForAssistant(page, "第一回复。");
    assert.equal(server.requests.length, baseline + 1);

    let state = readChatState(dataDir);
    assert.deepEqual(
      state.messages.map((message) => [message.character_id, message.role, message.content]),
      [
        ["rin", "user", "第一句"],
        ["rin", "assistant", "第一回复。"],
      ],
    );
    assert.equal(state.requests[0].status, "completed");
    assert.deepEqual(state.roster, rosterBefore);

    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await openCurrentChat(page, "凛");
    await page.locator("#chat-history-bar").waitFor({ state: "visible" });
    assert.equal(await page.locator("#chat-form").isVisible(), false);
    await waitForUser(page, "第一句");
    await waitForAssistant(page, "第一回复。");

    await closeApp(app);
    app = null;
    const relaunched = await launchApp(dataDir);
    app = relaunched.app;
    const page2 = relaunched.page;
    await page2.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openCurrentChat(page2, "凛");
    await page2.locator("#chat-history-bar").waitFor({ state: "visible" });
    await waitForUser(page2, "第一句");
    await waitForAssistant(page2, "第一回复。");
    assert.deepEqual(readChatState(dataDir).roster, rosterBefore);

    await page2.locator("#chat-continue").click();
    assert.equal(await page2.locator("#chat-form").isVisible(), true);
    assert.equal(await page2.locator("#chat-history .chat-bubble").count(), 0);

    await page2.keyboard.press("Escape");
    await page2.locator("#chat-panel").waitFor({ state: "hidden" });
    const focused = await page2.evaluate(() => ({
      id: document.activeElement?.id,
      action: document.activeElement?.getAttribute("data-action"),
    }));
    assert.ok(focused.id === "chat-current" || focused.action === "chat");
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 只显示当前请求的本地记忆保存反馈", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    await openCurrentChat(page, "凛");

    server.enqueue(({ response }) =>
      sendStructured(response, {
        reply: "记住了。",
        memoryCandidates: [
          {
            factKey: "pref.white-tea",
            body: "用户喜欢白茶",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢白茶",
          },
        ],
      }),
    );
    await page.locator("#chat-input").fill("我喜欢白茶。");
    await page.locator("#chat-send").click();
    await waitForAssistant(page, "记住了。");
    await page.waitForFunction(() => {
      const status = document.querySelector("#chat-memory-status");
      return Boolean(status && !status.hidden && status.textContent.includes("已保存1条记忆"));
    });
    let state = readChatState(dataDir);
    assert.equal(state.requests[0].memory_applied, 1);
    assert.equal(await page.locator("#chat-error").isVisible(), false);

    server.enqueue(({ response }) => sendText(response, "我已记住你的白茶。"));
    await page.locator("#chat-input").fill("随便聊聊");
    await page.locator("#chat-send").click();
    await waitForAssistant(page, "我已记住你的白茶。");
    await page.waitForFunction(
      () => document.querySelector("#chat-memory-status")?.hidden === true,
    );
    state = readChatState(dataDir);
    assert.equal(state.requests[1].memory_applied, 0);
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 取消在途回复且保留输入", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  let release;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    await openCurrentChat(page, "凛");
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendText(response, "迟到的取消回复");
    });
    await page.locator("#chat-input").fill("取消我");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length >= 2);
    await page.locator("#chat-cancel").waitFor({ state: "visible" });
    await page.locator("#chat-cancel").click();
    await waitForUser(page, "取消我");
    await page.waitForFunction(
      () => document.querySelector("#chat-status")?.textContent?.includes("已取消"),
      undefined,
      { timeout: 10000 },
    );
    release();
    const state = readChatState(dataDir);
    assert.equal(state.messages.some((message) => message.role === "assistant"), false);
    assert.equal(state.requests[0].status, "cancelled");
    assert.equal(await page.locator("#chat-input").inputValue(), "取消我");
  } finally {
    release?.();
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 关闭在途回复后焦点回发起按钮且迟到不回写", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  let release;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    const baseline = server.requests.length;
    await openCurrentChat(page, "凛");
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendText(response, "关闭后的迟到回复");
    });
    await page.locator("#chat-input").fill("关闭前");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length >= baseline + 1);
    await page.locator("#chat-cancel").waitFor({ state: "visible" });
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    const focused = await page.evaluate(() => ({
      id: document.activeElement?.id,
      action: document.activeElement?.getAttribute("data-action"),
    }));
    assert.ok(focused.id === "chat-current" || focused.action === "chat");

    release();
    await delay(120);
    assert.equal(await page.locator("#chat-panel").isVisible(), false);
    const stillFocused = await page.evaluate(() => ({
      id: document.activeElement?.id,
      action: document.activeElement?.getAttribute("data-action"),
    }));
    assert.ok(stillFocused.id === "chat-current" || stillFocused.action === "chat");
    const state = readChatState(dataDir);
    assert.equal(state.requests[0].status, "cancelled");
    assert.equal(state.interactions.length, 0);
    assert.equal(
      state.messages.some((message) => message.content.includes("关闭后的迟到回复")),
      false,
    );
  } finally {
    release?.();
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 失败保留输入并可显式重试一次", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    const baseline = server.requests.length;
    await openCurrentChat(page, "凛");
    server.enqueue(({ response }) => sendText(response, "服务失败", 500));
    await page.locator("#chat-input").fill("失败重试");
    await page.locator("#chat-send").click();
    await page.locator("#chat-retry").waitFor({ state: "visible" });
    await waitForUser(page, "失败重试");
    await delay(80);
    assert.equal(server.requests.length, baseline + 1);
    let state = readChatState(dataDir);
    assert.equal(state.requests[0].status, "failed");
    assert.equal(state.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(state.messages.some((message) => message.role === "assistant"), false);
    assert.equal(await page.locator("#chat-input").inputValue(), "失败重试");

    server.enqueue(({ response }) => sendText(response, "重试成功。"));
    await page.locator("#chat-retry").click();
    await waitForAssistant(page, "重试成功。");
    assert.equal(server.requests.length, baseline + 2);
    state = readChatState(dataDir);
    assert.equal(state.requests[0].status, "completed");
    assert.equal(state.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(state.messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(await page.locator("#chat-retry").isVisible(), false);
    assert.equal(await page.locator("#chat-input").inputValue(), "");
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-001 UI 切换聊天目标，旧迟到回复不串线", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  let release;
  try {
    let launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const before = readChatState(dataDir);
    const rinRequests = server.requests.length;

    await openCurrentChat(page, "凛");
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendText(response, "给凛的迟到回复");
    });
    await page.locator("#chat-input").fill("凛的问题");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length >= rinRequests + 1);

    await page.locator("#chat-target-select").selectOption("hu");
    await waitForChatTitle(page, "琥珀");
    assert.equal(await page.locator("#chat-form").isVisible(), true);
    server.enqueue(({ response }) => sendText(response, "给琥珀的回复"));
    await page.locator("#chat-input").fill("琥珀的问题");
    await page.locator("#chat-send").click();
    await waitForAssistant(page, "给琥珀的回复");
    release();
    await delay(120);
    assert.equal((await page.locator("#chat-history").textContent()).includes("给凛的迟到回复"), false);

    const state = readChatState(dataDir);
    assert.deepEqual(
      state.messages.map((message) => [message.character_id, message.role, message.content]),
      [
        ["rin", "user", "凛的问题"],
        ["hu", "user", "琥珀的问题"],
        ["hu", "assistant", "给琥珀的回复"],
      ],
    );
    assert.equal(state.requests.find((request) => request.character_id === "rin").status, "cancelled");
    assert.equal(state.requests.find((request) => request.character_id === "hu").status, "completed");
    assert.deepEqual(state.roster, before.roster);
    assert.deepEqual(state.relationships, before.relationships);
    assert.equal(state.roster.some((row) => row.character_id === "hu"), false);
  } finally {
    release?.();
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 关闭持久失败不假报成功", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    await openCurrentChat(page, "凛");
    server.enqueue(({ response }) => sendText(response, "先有一条回复。"));
    await page.locator("#chat-input").fill("先说话");
    await page.locator("#chat-send").click();
    await waitForAssistant(page, "先有一条回复。");

    let db = openDb(dataDir);
    db.exec(`
      CREATE TRIGGER fail_chat_close
      BEFORE UPDATE OF closed_at ON chat_conversations
      BEGIN
        SELECT RAISE(ABORT, 'injected close failure');
      END;
    `);
    db.close();

    await page.locator("#chat-close").click();
    await page.locator("#chat-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#chat-panel").isVisible(), true);
    assert.match(await page.locator("#chat-status").textContent(), /关闭失败/);
    assert.match(await page.locator("#chat-error").textContent(), /没有完全关闭/);
    assert.equal(readChatState(dataDir).interactions.length, 1);

    db = openDb(dataDir);
    db.exec("DROP TRIGGER fail_chat_close;");
    db.close();
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    const state = readChatState(dataDir);
    assert.equal(state.interactions.length, 0);
    assert.ok(state.conversations[0]?.closed_at);
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-CHAT-003 UI 主进程退出取消在途并结束互动", async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  let release;
  let logs = [];
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    logs = launched.logs;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    const rosterBefore = readChatState(dataDir).roster;
    await openCurrentChat(page, "凛");
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendText(response, "退出后的迟到回复");
    });
    await page.locator("#chat-input").fill("退出前");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length >= 2);
    await closeApp(app);
    app = null;
    release();
    await delay(120);
    const state = readChatState(dataDir);
    assert.equal(state.requests[0].status, "cancelled");
    assert.equal(state.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(state.messages.some((message) => message.role === "assistant"), false);
    assert.equal(state.interactions.length, 0);
    assert.deepEqual(state.roster, rosterBefore);
    const output = logs.join("");
    assert.equal(/UnhandledPromiseRejection|未处理的拒绝|database is not open/i.test(output), false);
  } finally {
    release?.();
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
