/* S03m 2a 最小正式 GUI 验收：真实 Electron/preload/renderer/SQLite，
   模型使用本机受控 HTTP。只验证阶段 1 先显示、阶段 2 原位刷新同一 assistant、
   输入恢复；不读真实用户数据，不调用真实服务。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const MODEL_NAME = "fixture-verification-ui";
const API_KEY = "sk-fixture-verification-ui";

function sendStructured(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
  }));
}

async function startServer() {
  const requests = [];
  const responders = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push(body);
      const responder = responders.shift();
      Promise.resolve(
        responder
          ? responder({ body, response })
          : sendStructured(response, { reply: "收到。", memoryCandidates: [] }),
      ).catch(() => {
        if (!response.destroyed && !response.writableEnded) response.destroy();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    enqueue(responder) { responders.push(responder); },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill(MODEL_NAME);
  await page.locator("#api-key").fill(API_KEY);
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function openChat(page) {
  await page.locator("#chat-current").click();
  await page.locator("#chat-panel").waitFor({ state: "visible" });
  await page.locator("#chat-form").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#chat-title")?.textContent?.includes("凛"));
}

async function waitForAssistantText(page, text) {
  await page.waitForFunction((expected) => Array.from(
    document.querySelectorAll(".chat-bubble-assistant"),
  ).some((node) => node.textContent.includes(expected)), text);
}

function pairsOf(body) {
  return JSON.parse(body.messages.find((message) => message.role === "user").content).pairs;
}

function relationResult(pair) {
  const description = {
    subject: "用户", subjectQuote: "我", scope: "current", time: null, timeQuote: null,
  };
  return { pair: pair.id, relation: "equivalent", left: description, right: { ...description } };
}

async function seedFacts(server, dataDir) {
  const store = createStore(dataDir, {
    now: () => Date.now(),
    chat: {
      timeoutMs: 2000,
      fetchImpl: fetch,
      recoverInterrupted: false,
      getCredentials: () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY }),
    },
  });
  try {
    store.db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    ).run("hu", "2026-01-01T00:00:00.000Z");
    store.db.prepare(
      "INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)",
    ).run("hu");
    for (const [characterId, text, factKey, body] of [
      ["hu", "我也爱喝咖啡。", "pref.coffeeB", "用户也爱喝咖啡"],
    ]) {
      const conversation = store.chat.openConversation({ characterId }).conversation;
      server.enqueue(({ response }) => sendStructured(response, {
        reply: "我记下了。",
        memoryCandidates: [{
          factKey, body, kind: "preference", trust: "stated",
          evidence: text.replace(/。$/u, ""),
        }],
      }));
      const result = await store.chat.sendMessage({
        characterId,
        conversationId: conversation.id,
        text,
        requestId: crypto.randomUUID(),
      });
      assert.equal(result.status, "completed");
    }
  } finally {
    store.close();
  }
}

function readEntry(dataDir, characterId, factKey) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    return db.prepare(
      "SELECT body, source_id, version FROM memory_entries WHERE character_id = ? AND fact_key = ?",
    ).get(characterId, factKey) ?? null;
  } finally {
    db.close();
  }
}

async function openSeededUi(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-verification-ui-"));
  const server = await startServer();
  let app = null;
  t.after(async () => {
    if (app) {
      try { await app.close(); } catch { /* 已关闭 */ }
    }
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let launched = await launchApp(dataDir);
  app = launched.app;
  await completeOnboarding(launched.page, server.baseUrl);
  await app.close();
  app = null;
  await seedFacts(server, dataDir);
  launched = await launchApp(dataDir);
  app = launched.app;
  const page = launched.page;
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await openChat(page);
  server.enqueue(({ response }) => sendStructured(response, {
    reply: "我记下了。",
    memoryCandidates: [{
      factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference",
      trust: "stated", evidence: "我喜欢咖啡",
    }],
  }));
  await page.locator("#chat-input").fill("我喜欢咖啡。");
  await page.locator("#chat-send").click();
  await waitForAssistantText(page, "我记下了");
  return {
    app,
    page,
    server,
    dataDir,
    correctionResponder() {
      return ({ body, response }) => {
        const systemText = body.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content).join("\n");
        const line = systemText.split("\n").find((item) =>
          /^\[M\d+\]/u.test(item) && item.includes("我喜欢咖啡"));
        const target = line?.match(/^\[(M\d+)\]/u)?.[1];
        assert.ok(target, "候选列表缺少咖啡目标");
        sendStructured(response, {
          reply: "好的。",
          memoryCandidates: [],
          memoryOperation: {
            action: "correct", target, excerpt: "我更喜欢茶", evidence: "请帮我改过来",
          },
        });
      };
    },
    equivalentResponder(delayMs = 60) {
      return ({ body, response }) => {
        const pairs = pairsOf(body);
        return new Promise((resolve) => {
          setTimeout(() => {
            sendStructured(response, { results: pairs.map((pair) => relationResult(pair)) });
            resolve();
          }, delayMs);
        });
      };
    },
    async sendCorrection() {
      await page.locator("#chat-input").fill("不是咖啡，我更喜欢茶，请帮我改过来。");
      await page.locator("#chat-send").click();
    },
  };
}

test("POL-SEMOP-003a GUI 阶段 1 先显示，阶段 2 原位刷新同一 assistant", { timeout: 180000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-verification-ui-"));
  const shotDir = path.join(
    repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03m-2a",
    "gui-shots", `${new Date().toISOString().replace(/[.:]/gu, "-")}-${process.pid}`,
  );
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await startServer();
  let app = null;
  try {
    let launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await app.close();
    app = null;

    await seedFacts(server, dataDir);

    launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openChat(page);

    server.enqueue(({ response }) => sendStructured(response, {
      reply: "我记下了。",
      memoryCandidates: [{
        factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference",
        trust: "stated", evidence: "我喜欢咖啡",
      }],
    }));
    await page.locator("#chat-input").fill("我喜欢咖啡。");
    await page.locator("#chat-send").click();
    await waitForAssistantText(page, "我记下了");
    assert.equal(readEntry(dataDir, "rin", "pref.coffee").body, "我喜欢咖啡");

    server.enqueue(({ body, response }) => {
      const systemText = body.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content).join("\n");
      const line = systemText.split("\n").find((item) =>
        /^\[M\d+\]/u.test(item) && item.includes("我喜欢咖啡"));
      const target = line?.match(/^\[(M\d+)\]/u)?.[1];
      assert.ok(target, "候选列表缺少咖啡目标");
      sendStructured(response, {
        reply: "好的。",
        memoryCandidates: [],
        memoryOperation: {
          action: "correct", target, excerpt: "我更喜欢茶", evidence: "请帮我改过来",
        },
      });
    });
    server.enqueue(({ body, response }) => {
      const pairs = pairsOf(body);
      return new Promise((resolve) => {
        setTimeout(() => {
          sendStructured(response, { results: pairs.map((pair) => relationResult(pair)) });
          resolve();
        }, 200);
      });
    });

    await page.locator("#chat-input").fill("不是咖啡，我更喜欢茶，请帮我改过来。");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll(".chat-bubble-assistant"),
    ).some((node) => node.textContent.includes("正在核对")), null, { timeout: 10000 });
    await page.screenshot({ path: path.join(shotDir, "phase1-pending.png") });
    const during = await page.locator(".chat-bubble-assistant").count();
    assert.equal(await page.locator("#chat-input").isDisabled(), true);
    assert.equal(readEntry(dataDir, "hu", "pref.coffeeB").body, "我也爱喝咖啡");

    await waitForAssistantText(page, "一并更正");
    await page.screenshot({ path: path.join(shotDir, "phase2-final.png") });
    const after = await page.locator(".chat-bubble-assistant").count();
    assert.equal(after, during, "阶段 2 必须原位更新同一 assistant，不能追加第二条");
    await page.waitForFunction(() => {
      const input = document.querySelector("#chat-input");
      return input && !input.disabled;
    });
    assert.equal(readEntry(dataDir, "hu", "pref.coffeeB").body, "不是咖啡，我更喜欢茶");
    assert.equal(await page.locator("#chat-status").textContent(), "");
    console.log(`S03M_GUI_SHOTS ${shotDir}`);
  } finally {
    if (app) {
      try { await app.close(); } catch { /* 已关闭 */ }
    }
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-SEMOP-003a GUI 核验早完成：原位刷新且不追加消息", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  ui.server.enqueue(ui.correctionResponder());
  ui.server.enqueue(ui.equivalentResponder(0));
  await ui.sendCorrection();
  await waitForAssistantText(ui.page, "一并更正");
  const texts = await ui.page.locator(".chat-bubble-assistant").allTextContents();
  assert.equal(texts.filter((text) => text.includes("一并更正")).length, 1);
  assert.equal(texts.some((text) => text.includes("正在核对")), false);
  assert.equal(await ui.page.locator("#chat-input").isDisabled(), false);
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB").body, "不是咖啡，我更喜欢茶");
});

test("POL-SEMOP-003c GUI 系统暂停取消核验：本地完成且不传播", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  ui.server.enqueue(ui.correctionResponder());
  ui.server.enqueue(({ body }) => {
    void pairsOf(body);
    return new Promise(() => {});
  });
  await ui.sendCorrection();
  await waitForAssistantText(ui.page, "正在核对");
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB").body, "我也爱喝咖啡");
  await ui.app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("suspend");
  });
  await waitForAssistantText(ui.page, "本地这次更正已完成");
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB").body, "我也爱喝咖啡");
});

test("POL-SEMOP-003c GUI 关闭后迟到核验事件不重启旧会话", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  ui.server.enqueue(ui.correctionResponder());
  let release;
  ui.server.enqueue(({ body, response }) => {
    const pairs = pairsOf(body);
    return new Promise((resolve) => {
      release = () => {
        sendStructured(response, { results: pairs.map((pair) => relationResult(pair)) });
        resolve();
      };
    });
  });
  await ui.sendCorrection();
  await waitForAssistantText(ui.page, "正在核对");
  await ui.page.locator("#chat-close").click();
  await ui.page.locator("#chat-panel").waitFor({ state: "hidden" });
  release();
  await ui.page.waitForTimeout(400);
  assert.equal(await ui.page.locator("#chat-panel").isVisible(), false);
  const bodyText = await ui.page.locator("body").innerText();
  assert.equal(bodyText.includes("正在核对"), false);
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB").body, "我也爱喝咖啡");
});
