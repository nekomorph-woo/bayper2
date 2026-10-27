/* S03m 2a 最小正式 GUI 验收：真实 Electron/preload/renderer/SQLite，
   模型使用本机受控 HTTP。只验证阶段 1 先显示、阶段 2 原位刷新同一 assistant、
   输入恢复；不读真实用户数据，不调用真实服务。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
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

/* 只收集本 Case dataDir 对应的 helper、桌面 overlay 主进程和带精确
   --data-dir 的管理主进程。helper/管理进程只读命令行；桌面进程无法从
   命令行识别目录，才对候选 PID 单独读环境并匹配完整 token。 */
function collectVerificationUiPids(dataDir) {
  const profileDir = path.join(dataDir, "desktop-profile");
  const profileArg = `--user-data-dir=${profileDir}`;
  const profileEnv = `BAYPER_DESKTOP_PROFILE=${profileDir}`;
  const dataDirArg = `--data-dir=${dataDir}`;
  const electronRoot = path.join(
    repoRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "Frameworks",
  );
  const desktopCommand = `${electronPath} ${path.join(repoRoot, "app", "desktop")}`;
  const tokensOf = (command) => command.split(/\s+/u).filter(Boolean);
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[3] }));
  const helperPids = rows.filter((row) =>
    row.command.startsWith(path.join(electronRoot, "Electron Helper")) &&
    tokensOf(row.command).includes(profileArg),
  ).map((row) => row.pid);
  const managementPids = rows.filter((row) =>
    row.command.startsWith(`${electronPath} `) &&
    tokensOf(row.command).includes(dataDirArg),
  ).map((row) => row.pid);
  const desktopPids = rows
    .filter((row) => row.command === desktopCommand)
    .filter((row) => {
      try {
        return tokensOf(execFileSync(
          "ps", ["eww", "-p", String(row.pid), "-o", "command="], { encoding: "utf8" },
        )).includes(profileEnv);
      } catch {
        return false; // 候选在读取环境前已退出。
      }
    })
    .map((row) => row.pid);
  return [...new Set([...helperPids, ...managementPids, ...desktopPids])];
}

/* 异常退出 Case 的收尾：先 TERM 精确 PID，等进程消失后删除 dataDir，
   并把“无活进程、目录已删除”作为 Case 断言，不依赖正常关闭规避。 */
async function cleanupVerificationUiProcesses(dataDir) {
  const deadline = Date.now() + 3000;
  let remaining = collectVerificationUiPids(dataDir);
  while (remaining.length > 0 && Date.now() < deadline) {
    // 桌面 host 可能短暂重启 overlay；每轮对当前精确 PID 重新 TERM。
    for (const pid of remaining) {
      try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = collectVerificationUiPids(dataDir);
  }
  assert.deepEqual(remaining, [], `异常退出测试残留进程: ${remaining.join(",")}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dataDir), false, "异常退出测试目录必须删除");
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

function readTemporaryRows(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    return db.prepare(`
      SELECT id, character_id, body, fact_identity_id, expires_at, source_id
      FROM memory_entries WHERE expires_at IS NOT NULL
      ORDER BY character_id ASC, id ASC
    `).all();
  } finally {
    db.close();
  }
}

/* 失效标签超时时保留 DB 命中、临时 link、IPC 投影与 DOM 文本；只诊断，不改变断言。 */
async function dumpS03pPanelDiagnostics({ ui, page, shotDir, tempId }) {
  const db = new DatabaseSync(path.join(ui.dataDir, DB_FILE));
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    const row = db.prepare(
      "SELECT id, character_id, source_id, expires_at, fact_identity_id " +
      "FROM memory_entries WHERE id = ?",
    ).get(tempId);
    const entryLinks = db.prepare(
      "SELECT * FROM memory_temporary_entry_links WHERE entry_id = ?",
    ).all(tempId);
    console.log("S03P_DIAG_DB", JSON.stringify({ row, entryLinks }));
  } finally {
    db.close();
  }
  const ipc = await page.evaluate(async () => (
    window.bayperMemory
      ? window.bayperMemory.listMemories({ characterId: "rin", page: 0 })
      : { missing: "bayperMemory" }
  ));
  console.log("S03P_DIAG_IPC", JSON.stringify(ipc));
  const dom = await page.locator(".memory-entry-meta").allTextContents();
  console.log("S03P_DIAG_DOM", JSON.stringify(dom));
  await page.screenshot({ path: path.join(shotDir, "time-memory-invalid-label-timeout.png") });
}

function readLatestRequestStatus(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    return db.prepare(
      "SELECT verification_status FROM chat_requests ORDER BY rowid DESC LIMIT 1",
    ).get()?.verification_status ?? null;
  } finally {
    db.close();
  }
}

function candidateTarget(body, needle) {
  const systemText = body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content).join("\n");
  const line = systemText.split("\n").find((item) =>
    /^\[M\d+\]/u.test(item) && item.includes(needle));
  const target = line?.match(/^\[(M\d+)\]/u)?.[1];
  assert.ok(target, `候选列表缺少${needle}目标`);
  return target;
}

const isVerificationRequest = (body) => Boolean(body?.messages?.some((message) =>
  message.role === "system" && message.content.includes("记忆事实关系判定器")));

function createShotDir() {
  const shotDir = path.join(
    repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03m-lifecycle",
    "gui-shots", `${new Date().toISOString().replace(/[.:]/gu, "-")}-${process.pid}`,
  );
  fs.mkdirSync(shotDir, { recursive: true });
  return shotDir;
}

function createS03pShotDir() {
  const shotDir = path.join(
    repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence",
    "s03p-temporal-clarification", "gui-shots",
    `${new Date().toISOString().replace(/[.:]/gu, "-")}-${process.pid}`,
  );
  fs.mkdirSync(shotDir, { recursive: true });
  return shotDir;
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
        sendStructured(response, {
          reply: "好的。",
          memoryCandidates: [],
          memoryOperation: {
            action: "correct",
            target: candidateTarget(body, "我喜欢咖啡"),
            excerpt: "我更喜欢茶",
            evidence: "请帮我改过来",
          },
        });
      };
    },
    temporaryCorrectionResponder() {
      return ({ body, response }) => {
        sendStructured(response, {
          reply: "好的。",
          memoryCandidates: [],
          memoryOperation: {
            action: "correct",
            target: candidateTarget(body, "我喜欢咖啡"),
            excerpt: "我今天想喝茶",
            evidence: "请帮我改过来",
          },
        });
      };
    },
    forgetResponder() {
      return ({ body, response }) => {
        sendStructured(response, {
          reply: "好的。",
          memoryCandidates: [],
          memoryOperation: {
            action: "forget",
            target: candidateTarget(body, "我喜欢咖啡"),
            scope: "all",
            evidence: "请忘记我喜欢咖啡这件事",
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

async function openForgetClarifyUi(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-forget-clarify-ui-"));
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
    for (const [characterId, text, factKey] of [
      ["hu", "我的咖啡都要甜的。", "pref.coffeeB"],
    ]) {
      const conversation = store.chat.openConversation({ characterId }).conversation;
      server.enqueue(({ response }) => sendStructured(response, {
        reply: "我记下了。",
        memoryCandidates: [{
          factKey, body: text.replace(/。$/u, ""), kind: "preference",
          trust: "stated", evidence: text.replace(/。$/u, ""),
        }],
        memoryOperation: null,
      }));
      const result = await store.chat.sendMessage({
        characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
      });
      assert.equal(result.status, "completed");
    }
  } finally {
    store.close();
  }

  launched = await launchApp(dataDir);
  app = launched.app;
  const page = launched.page;
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await openChat(page);
  server.enqueue(({ response }) => sendStructured(response, {
    reply: "我记下了。",
    memoryCandidates: [{
      factKey: "pref.coffee", body: "我平时喝咖啡一定要加糖",
      kind: "preference", trust: "stated", evidence: "我平时喝咖啡一定要加糖",
    }],
    memoryOperation: null,
  }));
  await page.locator("#chat-input").fill("我平时喝咖啡一定要加糖。");
  await page.locator("#chat-send").click();
  await waitForAssistantText(page, "我记下了");
  return {
    app,
    page,
    server,
    dataDir,
    equivalentResponder(delayMs = 500) {
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
  };
}

test("POL-CHATMEM-FORGET-CLARIFY-GUI-001 本地提问后可选择并两阶段删除", { timeout: 180000 }, async (t) => {
  const shotDir = createShotDir();
  const ui = await openForgetClarifyUi(t);
  const bLong = readEntry(ui.dataDir, "hu", "pref.coffeeB");
  assert.ok(readEntry(ui.dataDir, "rin", "pref.coffee"));

  ui.server.enqueue(({ response }) => sendStructured(response, {
    reply: "模型说已经删除了。", memoryCandidates: [], memoryOperation: null,
  }));
  await ui.page.locator("#chat-input").fill("请忘记我喜欢咖啡这件事。");
  await ui.page.locator("#chat-send").click();
  await waitForAssistantText(ui.page, "要忘记这条吗");
  await ui.page.screenshot({ path: path.join(shotDir, "clarify-question.png") });
  assert.equal(await ui.page.locator("#chat-input").isDisabled(), false);
  assert.ok(readEntry(ui.dataDir, "rin", "pref.coffee"), "提问阶段不得删除");
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);

  ui.server.enqueue(ui.equivalentResponder(500));
  await ui.page.locator("#chat-input").fill("第 1 条");
  await ui.page.locator("#chat-send").click();
  await waitForAssistantText(ui.page, "正在核对");
  await ui.page.screenshot({ path: path.join(shotDir, "clarify-phase1-pending.png") });
  const during = await ui.page.locator(".chat-bubble-assistant").count();
  assert.equal(await ui.page.locator("#chat-input").isDisabled(), true);
  assert.equal(readEntry(ui.dataDir, "rin", "pref.coffee"), null, "阶段1删除A");
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong, "独立B阶段1不变");

  await waitForAssistantText(ui.page, "一并删除");
  await ui.page.screenshot({ path: path.join(shotDir, "clarify-phase2-final.png") });
  assert.equal(
    await ui.page.locator(".chat-bubble-assistant").count(),
    during,
    "阶段2必须原位更新同一 assistant",
  );
  await ui.page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    return input && !input.disabled;
  });
  assert.equal(readEntry(ui.dataDir, "rin", "pref.coffee"), null);
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB"), null);
  const finalText = await ui.page.locator(".chat-bubble-assistant").last().textContent();
  assert.equal(finalText.includes("更正"), false);
  console.log(`S03O_B_GUI_SHOTS ${shotDir}`);
});

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

test("POL-SEMOP-003c GUI 模拟 suspend 取消核验：本地完成且不传播", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  ui.server.enqueue(ui.correctionResponder());
  ui.server.enqueue(({ body }) => {
    void pairsOf(body);
    return new Promise(() => {});
  });
  await ui.sendCorrection();
  await waitForAssistantText(ui.page, "正在核对");
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB").body, "我也爱喝咖啡");
  // 这里只是向 powerMonitor 发出 suspend 事件，模拟系统挂起；不是真实锁屏或休眠。
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

test("POL-SEMOP-001d/003a GUI 临时理解阶段1先显示，阶段2原位刷新且长期不变", { timeout: 180000 }, async (t) => {
  const shotDir = createShotDir();
  const ui = await openSeededUi(t);
  const aLong = readEntry(ui.dataDir, "rin", "pref.coffee");
  const bLong = readEntry(ui.dataDir, "hu", "pref.coffeeB");

  ui.server.enqueue(ui.temporaryCorrectionResponder());
  ui.server.enqueue(ui.equivalentResponder(500));
  await ui.page.locator("#chat-input").fill("不是咖啡，我今天想喝茶，请帮我改过来。");
  await ui.page.locator("#chat-send").click();

  await waitForAssistantText(ui.page, "正在核对");
  await ui.page.screenshot({ path: path.join(shotDir, "temporary-phase1-pending.png") });
  const during = await ui.page.locator(".chat-bubble-assistant").count();
  assert.equal(await ui.page.locator("#chat-input").isDisabled(), true);
  const stage1 = readTemporaryRows(ui.dataDir);
  assert.equal(stage1.length, 1, "阶段1只给发起人写当日理解");
  assert.equal(stage1[0].character_id, "rin");
  assert.match(stage1[0].body, /茶/u);
  assert.notEqual(stage1[0].body, aLong.body);
  assert.deepEqual(readEntry(ui.dataDir, "rin", "pref.coffee"), aLong, "长期事实不变");
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);

  await waitForAssistantText(ui.page, "一并更正");
  await ui.page.screenshot({ path: path.join(shotDir, "temporary-phase2-final.png") });
  assert.equal(
    await ui.page.locator(".chat-bubble-assistant").count(),
    during,
    "阶段2必须原位更新同一 assistant",
  );
  await ui.page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    return input && !input.disabled;
  });
  const rows = readTemporaryRows(ui.dataDir);
  assert.equal(rows.length, 2, "已确认的另一角色也应有当日 current");
  const rinRow = rows.find((row) => row.character_id === "rin");
  const huRow = rows.find((row) => row.character_id === "hu");
  assert.ok(rinRow && huRow);
  assert.equal(huRow.fact_identity_id, rinRow.fact_identity_id);
  assert.equal(huRow.body, rinRow.body);
  assert.equal(huRow.expires_at, rinRow.expires_at);
  assert.match(huRow.source_id, /^chat-current-copy:/u);
  assert.deepEqual(readEntry(ui.dataDir, "rin", "pref.coffee"), aLong, "临时理解不合并长期");
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);
  assert.equal(await ui.page.locator("#chat-status").textContent(), "");
  console.log(`S03M_LIFECYCLE_GUI_SHOTS ${shotDir}`);
});

test("POL-SEMOP-002a/003a GUI forget 阶段1可见，阶段2原位删除且不说更正", { timeout: 180000 }, async (t) => {
  const shotDir = createShotDir();
  const ui = await openSeededUi(t);
  const bLong = readEntry(ui.dataDir, "hu", "pref.coffeeB");

  ui.server.enqueue(ui.forgetResponder());
  ui.server.enqueue(ui.equivalentResponder(500));
  await ui.page.locator("#chat-input").fill("请忘记我喜欢咖啡这件事。");
  await ui.page.locator("#chat-send").click();

  await waitForAssistantText(ui.page, "正在核对");
  await ui.page.screenshot({ path: path.join(shotDir, "forget-phase1-pending.png") });
  const during = await ui.page.locator(".chat-bubble-assistant").count();
  assert.equal(await ui.page.locator("#chat-input").isDisabled(), true);
  assert.equal(readEntry(ui.dataDir, "rin", "pref.coffee"), null, "阶段1先删除本地锚");
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);

  await waitForAssistantText(ui.page, "一并删除");
  await ui.page.screenshot({ path: path.join(shotDir, "forget-phase2-final.png") });
  assert.equal(
    await ui.page.locator(".chat-bubble-assistant").count(),
    during,
    "阶段2必须原位更新同一 assistant",
  );
  await ui.page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    return input && !input.disabled;
  });
  assert.equal(readEntry(ui.dataDir, "rin", "pref.coffee"), null);
  assert.equal(readEntry(ui.dataDir, "hu", "pref.coffeeB"), null);
  const finalText = await ui.page.locator(".chat-bubble-assistant").last().textContent();
  assert.match(finalText, /一并删除/u);
  assert.equal(finalText.includes("更正"), false, "forget 收口不能沿用更正文案");
  console.log(`S03M_LIFECYCLE_GUI_SHOTS ${shotDir}`);
});

test("POL-SEMOP-003c GUI 临时关闭后迟到核验不复活会话也不传播", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  const aLong = readEntry(ui.dataDir, "rin", "pref.coffee");
  const bLong = readEntry(ui.dataDir, "hu", "pref.coffeeB");
  ui.server.enqueue(ui.temporaryCorrectionResponder());
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  ui.server.enqueue(({ body, response }) => {
    const pairs = pairsOf(body);
    startedResolve();
    return new Promise((resolve) => {
      release = () => {
        sendStructured(response, { results: pairs.map((pair) => relationResult(pair)) });
        resolve();
      };
    });
  });
  await ui.page.locator("#chat-input").fill("不是咖啡，我今天想喝茶，请帮我改过来。");
  await ui.page.locator("#chat-send").click();
  await waitForAssistantText(ui.page, "正在核对");
  await started;
  assert.equal(readTemporaryRows(ui.dataDir).length, 1);

  await ui.page.locator("#chat-close").click();
  await ui.page.locator("#chat-panel").waitFor({ state: "hidden" });
  release();
  await ui.page.waitForTimeout(500);
  assert.equal(await ui.page.locator("#chat-panel").isVisible(), false);
  const bodyText = await ui.page.locator("body").innerText();
  assert.equal(bodyText.includes("正在核对"), false);
  const rows = readTemporaryRows(ui.dataDir);
  assert.equal(rows.length, 1, "阶段1的A当日理解保留，迟到结果不得给B建副本");
  assert.equal(rows[0].character_id, "rin");
  assert.deepEqual(readEntry(ui.dataDir, "rin", "pref.coffee"), aLong);
  assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);
});

test("POL-SEMOP-003c GUI 真实异常退出遗留 pending：重开 interrupted、不重试、保留阶段1", { timeout: 180000 }, async (t) => {
  const shotDir = createShotDir();
  const ui = await openSeededUi(t);
  const aLong = readEntry(ui.dataDir, "rin", "pref.coffee");
  const bLong = readEntry(ui.dataDir, "hu", "pref.coffeeB");
  ui.server.enqueue(ui.temporaryCorrectionResponder());
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  ui.server.enqueue(() => {
    startedResolve();
    return new Promise(() => {});
  });
  await ui.page.locator("#chat-input").fill("不是咖啡，我今天想喝茶，请帮我改过来。");
  await ui.page.locator("#chat-send").click();
  await waitForAssistantText(ui.page, "正在核对");
  await started;
  assert.equal(readTemporaryRows(ui.dataDir).length, 1);
  const requestsBeforeKill = ui.server.requests.filter(isVerificationRequest).length;
  assert.equal(requestsBeforeKill, 1);

  // 模拟真实异常退出：SIGKILL 主进程，保留已提交的阶段1与 pending 核验状态。
  const child = ui.app.process();
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));

  let relaunched = null;
  try {
    relaunched = await launchApp(ui.dataDir);
    const page = relaunched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#chat-current").click();
    await page.locator("#chat-panel").waitFor({ state: "visible" });
    await waitForAssistantText(page, "本地这次更正已完成");
    await page.screenshot({ path: path.join(shotDir, "recovery-chat.png") });
    assert.equal(
      (await page.locator("body").innerText()).includes("正在核对"),
      false,
    );
    await page.waitForTimeout(500);
    assert.equal(
      ui.server.requests.filter(isVerificationRequest).length,
      requestsBeforeKill,
      "重开不得重试核验",
    );
    assert.equal(readLatestRequestStatus(ui.dataDir), "interrupted");
    const rows = readTemporaryRows(ui.dataDir);
    assert.equal(rows.length, 1, "阶段1的A当日理解保留，未向B传播");
    assert.equal(rows[0].character_id, "rin");
    assert.deepEqual(readEntry(ui.dataDir, "rin", "pref.coffee"), aLong);
    assert.deepEqual(readEntry(ui.dataDir, "hu", "pref.coffeeB"), bLong);
    console.log(`S03M_LIFECYCLE_GUI_SHOTS ${shotDir}`);
  } finally {
    if (relaunched) {
      try { await relaunched.app.close(); } catch { /* 已在退出 */ }
    }
    await cleanupVerificationUiProcesses(ui.dataDir);
  }
});

/* S03p 最小 GUI：真实 Electron/SQLite，聊天与关系模型为本机构造 HTTP。
   只验证两轮时间澄清、今日临时、长期不变与面板失效标签；不运行人类体验、
   不调用真实模型。面板失效来源由协议 fixture 制造，不是公开撤权入口。 */
test("POL-CHATMEM-CORRECT-TIME-GUI-001 两轮时间澄清与面板失效标签", { timeout: 180000 }, async (t) => {
  const ui = await openSeededUi(t);
  const shotDir = createS03pShotDir();
  const page = ui.page;
  const longBefore = readEntry(ui.dataDir, "rin", "pref.coffee");
  assert.ok(longBefore, "种子长期偏好必须存在");

  ui.server.enqueue(({ response }) => sendStructured(response, {
    reply: "你想把咖啡改成什么？",
    memoryCandidates: [],
    memoryOperation: null,
  }));
  await page.locator("#chat-input").fill("不是咖啡，我最近想喝茶，请帮我改过来。");
  await page.locator("#chat-send").click();
  await waitForAssistantText(page, "就今天");
  await page.screenshot({ path: path.join(shotDir, "time-clarify-question.png") });
  assert.equal(
    readTemporaryRows(ui.dataDir).filter((row) => row.character_id === "rin").length,
    0,
    "本地提问阶段不得写临时",
  );
  assert.deepEqual(readEntry(ui.dataDir, "rin", "pref.coffee"), longBefore);
  assert.equal(await page.locator("#chat-input").isDisabled(), false);

  ui.server.enqueue(ui.equivalentResponder(0));
  await page.locator("#chat-input").fill("就今天");
  await page.locator("#chat-send").click();
  await waitForAssistantText(page, "只到今天结束有效");
  await page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    return input && !input.disabled;
  });
  await page.screenshot({ path: path.join(shotDir, "time-clarify-final.png") });

  const longAfter = readEntry(ui.dataDir, "rin", "pref.coffee");
  assert.equal(longAfter.body, longBefore.body, "长期偏好正文不得改");
  assert.equal(longAfter.version, longBefore.version, "长期偏好版本不得改");
  const aTemps = readTemporaryRows(ui.dataDir).filter((row) => row.character_id === "rin");
  assert.equal(aTemps.length, 1, "A 必须只有一条今日临时");
  assert.equal(aTemps[0].body, "不是咖啡，我最近想喝茶", "正文保留原话，不拼接今天");
  assert.equal(
    new Date(aTemps[0].expires_at).toDateString(),
    new Date().toDateString(),
    "今日临时应在当天结束到期",
  );
  const bTemps = readTemporaryRows(ui.dataDir).filter((row) => row.character_id === "hu");
  assert.equal(bTemps.length, 1, "同主题 B 在 equivalent 下应同步今日临时");
  assert.equal(bTemps[0].body, aTemps[0].body);

  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  await page.locator("#memory-character").selectOption("rin");
  await page.locator(".memory-entry").first().waitFor({ state: "visible" });
  const panelText = await page.locator("#memory-list").textContent();
  assert.match(panelText, /不是咖啡，我最近想喝茶/u);
  await page.screenshot({ path: path.join(shotDir, "time-memory-panel.png") });

  // 协议 fixture：只把来源改坏以验证“已失效”标签，不声称存在聊天撤权入口。
  assert.ok(aTemps[0].id, "夹具更新前必须存在临时条目ID");
  const db = new DatabaseSync(path.join(ui.dataDir, DB_FILE));
  db.exec("PRAGMA busy_timeout = 2000");
  db.prepare("UPDATE memory_entries SET source_id = ? WHERE id = ?")
    .run(`${aTemps[0].source_id}:garbage`, aTemps[0].id);
  db.close();
  const updatedTemp = readTemporaryRows(ui.dataDir).find((row) => row.id === aTemps[0].id);
  assert.equal(
    updatedTemp?.source_id,
    `${aTemps[0].source_id}:garbage`,
    "SQLite 更新必须命中临时条目",
  );
  await page.locator("#memory-close").click();
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  await page.locator("#memory-character").selectOption("rin");
  try {
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll(".memory-entry-meta"),
    ).some((node) => node.textContent.includes("已失效（来源已变化）")));
  } catch (error) {
    try {
      await dumpS03pPanelDiagnostics({ ui, page, shotDir, tempId: aTemps[0].id });
    } catch (diagnosticError) {
      console.log("S03P_DIAG_FAILED", diagnosticError?.message ?? diagnosticError);
    }
    throw error;
  }
  await page.screenshot({ path: path.join(shotDir, "time-memory-invalid-label.png") });
  console.log(`S03P_GUI_SHOTS ${shotDir}`);
});
