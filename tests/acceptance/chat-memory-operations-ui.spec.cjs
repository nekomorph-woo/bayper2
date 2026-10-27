/* S03f 正式聊天窗口验收：真实 Electron main/preload/renderer/SQLite，
   模型使用本机受控 HTTP；不读 .env、不调用真实服务、不直接 IPC 代发送。
   唯一证据批次保存安全 messages、截图、DB 快照、源 SHA 与清理结果。 */
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
const batchName = process.env.S03F_CHATMEM_UI_BATCH ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
const batchDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03f-chat-memory-ui", batchName);
const sourceFiles = [
  "app/chat.cjs", "app/chat-memory-operations.cjs", "app/memory.cjs", "app/chat-store.cjs",
  "app/memory-store.cjs", "app/main.cjs", "app/renderer/chat-panel.js",
  "app/renderer/memory-panel.js", "tests/acceptance/chat-memory-operations-ui.spec.cjs",
];
const FACTS = [
  { factKey: "pref.drink", body: "用户喜欢茶", kind: "preference", sourceId: "seed:drink" },
  { factKey: "detail.address", body: "用户的住址是杭州市西湖区", kind: "detail", sourceId: "seed:address" },
  { factKey: "pref.travel", body: "用户喜欢一个人旅行", kind: "preference", sourceId: "seed:travel" },
  { factKey: "detail.job", body: "用户的工作是设计师", kind: "detail", sourceId: "seed:job" },
];
const evidence = {
  case: "POL-CHATMEM-UI-001", batch: path.relative(repoRoot, batchDir),
  executedAt: new Date().toISOString(), seeded: FACTS, stages: [], requests: [],
  sourceSha: {}, cleanup: { apps: [], errors: [], httpClosed: false, tempDirRemoved: false },
  businessError: null, machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX",
};
function sendStructured(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }));
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
      Promise.resolve(responder ? responder({ body, response }) : sendStructured(response, { reply: "连接正常。", memoryCandidates: [] }))
        .catch(() => { if (!response.destroyed && !response.writableEnded) response.destroy(); });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    enqueue(responder) { responders.push(responder); },
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
async function launchApp(dataDir) {
  const app = await electron.launch({ executablePath: electronPath, args: [repoRoot, `--data-dir=${dataDir}`] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}
async function waitForExit(proc, timeoutMs = 10000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.off("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    proc.once("exit", onExit);
  });
}
async function closeApp(app, label, cleanup) {
  if (!app) return true;
  const proc = app.process();
  let closeError = null;
  try { await app.close(); } catch (error) { closeError = String(error?.message ?? error); }
  const exited = await waitForExit(proc);
  cleanup.apps.push({ label, closeError, exited });
  if (closeError || !exited) cleanup.errors.push(`${label}: close=${closeError ?? "none"} exited=${exited}`);
  return exited;
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
async function openChat(page) {
  await page.locator("#chat-current").click();
  await page.locator("#chat-panel").waitFor({ state: "visible" });
  await page.locator("#chat-form").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#chat-title")?.textContent?.includes("凛"));
}
async function send(page, text) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
  await waitForUser(page, text);
}
async function waitForUser(page, text) {
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll(".chat-bubble-user")).some((node) => node.textContent.includes(expected)), text);
}
async function waitForAssistant(page, text) {
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((node) => node.textContent.includes(expected)), text);
}
async function openMemory(page) {
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  await page.waitForFunction(() => { const notice = document.querySelector("#memory-notice"); return Boolean(notice) && notice.dataset.state !== "loading"; });
}
async function selectRin(page) {
  await page.locator("#memory-character").selectOption("rin");
  await page.waitForFunction(() => {
    const select = document.querySelector("#memory-character");
    const notice = document.querySelector("#memory-notice");
    return select?.value === "rin" && notice?.dataset.state !== "loading";
  });
  await page.waitForFunction(() => document.querySelectorAll(".memory-entry").length > 0);
}
async function memoryCards(page) {
  return page.locator(".memory-entry").evaluateAll((nodes) => nodes.map((node) => ({
    body: node.querySelector(".memory-entry-body")?.textContent ?? "",
    meta: node.querySelector(".memory-entry-meta")?.textContent ?? "",
  })));
}
async function closeMemory(page) {
  await page.locator("#memory-close").click();
  await page.locator("#memory-overlay").waitFor({ state: "hidden" });
}
function openDb(dataDir, readOnly = false) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}
function readBase(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return {
      relationships: db.prepare("SELECT character_id FROM relationships ORDER BY character_id").all(),
      roster: db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
      stats: db.prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id").all(),
    };
  } finally { db.close(); }
}
function readMemoryRows(dataDir, characterId) {
  const db = openDb(dataDir, true);
  try {
    return db.prepare(`SELECT fact_key, body, kind, version, expires_at,
      CASE WHEN origin_character_id <> character_id OR EXISTS (SELECT 1 FROM memory_derivations d WHERE d.entry_id = memory_entries.id) THEN 1 ELSE 0 END AS derived
      FROM memory_entries WHERE character_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY importance DESC, updated_at DESC, id ASC`).all(characterId, Date.now());
  } finally { db.close(); }
}
function readShareCount(dataDir) {
  const db = openDb(dataDir, true);
  try { return db.prepare("SELECT COUNT(*) AS count FROM memory_share_identity_controls").get().count; }
  finally { db.close(); }
}
function withStore(dataDir, fn) {
  const store = createStore(dataDir);
  try { return fn(store); } finally { store.close(); }
}
function targetFromRequest(body, needle) {
  const text = (body?.messages ?? []).filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const line = text.split("\n").find((item) => /^\[M\d+\]/u.test(item) && item.includes(needle));
  const match = line?.match(/^\[(M\d+)\]/u);
  assert.ok(match, `本轮候选缺少 ${needle}`);
  return match[1];
}
function sendOperation(response, body, operation) {
  sendStructured(response, { reply: "模型回复不应直接作为完成", memoryCandidates: [], memoryOperation: operation(body) });
}
async function capture(page, name) {
  fs.mkdirSync(batchDir, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(batchDir, name) });
}
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(path.join(repoRoot, file))).digest("hex"); }
function safeError(error) { return String(error?.message ?? error).slice(0, 400); }
function writeEvidence() {
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const source = Object.entries(evidence.sourceSha).map(([file, hash]) => `${hash}  ${file}`).join("\n");
  fs.writeFileSync(path.join(batchDir, "source.sha256"), `${source}\n`, "utf8");
}
test("POL-CHATMEM-UI-001 真实聊天纠正、禁分享、删除追问、记忆页与重启", { timeout: 180000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-memory-ui-"));
  const server = await startServer();
  const cleanup = evidence.cleanup;
  let app = null;
  let businessError = null;
  console.log(`S03F_UI_BATCH ${evidence.batch}`);
  try {
    for (const file of sourceFiles) evidence.sourceSha[file] = sha256File(file);
    let launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    if (!(await closeApp(app, "onboarding", cleanup))) throw new Error("首次配置窗口未确认退出");
    app = null;
    withStore(dataDir, (store) => {
      store.db.prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)")
        .run("hu", "2026-01-01T00:00:00.000Z");
      store.db.prepare("INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)")
        .run("hu");
      for (const fact of FACTS) store.memory.remember({ characterId: "rin", ...fact });
    });
    evidence.baseline = readBase(dataDir);
    launched = await launchApp(dataDir);
    app = launched.app;
    let page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openChat(page);
    server.enqueue(({ body, response }) => sendOperation(response, body, (request) => ({
      action: "correct", target: targetFromRequest(request, "用户喜欢茶"),
      excerpt: "我喜欢咖啡，不是茶", evidence: "请纠正一下",
    })));
    await send(page, "我喜欢咖啡，不是茶，请纠正一下。");
    await waitForAssistant(page, "我喜欢咖啡，不是茶");
    let rows = readMemoryRows(dataDir, "rin");
    assert.equal(rows.find((row) => row.fact_key === "pref.drink")?.body, "我喜欢咖啡，不是茶");
    assert.equal(rows.find((row) => row.fact_key === "pref.travel")?.body, "用户喜欢一个人旅行");
    assert.equal(rows.find((row) => row.fact_key === "detail.address")?.body, "用户的住址是杭州市西湖区");
    assert.equal(rows.find((row) => row.fact_key === "detail.job")?.body, "用户的工作是设计师");
    evidence.stages.push({ id: "correct", rows });
    await capture(page, "01-correction.png");
    server.enqueue(({ body, response }) => sendOperation(response, body, (request) => ({
      action: "restrictSharing", target: targetFromRequest(request, "用户喜欢一个人旅行"),
      evidence: "我喜欢一个人旅行这件事不要再告诉其他角色了。",
    })));
    await send(page, "我喜欢一个人旅行这件事不要再告诉其他角色了。");
    await waitForAssistant(page, "之后我不会再把这件事分享");
    assert.equal(readShareCount(dataDir), 1);
    rows = readMemoryRows(dataDir, "rin");
    assert.equal(rows.find((row) => row.fact_key === "pref.travel")?.body, "用户喜欢一个人旅行");
    assert.equal(rows.find((row) => row.fact_key === "pref.drink")?.body, "我喜欢咖啡，不是茶");
    evidence.stages.push({ id: "restrict", rows, shareControls: readShareCount(dataDir) });
    await capture(page, "02-restrict.png");
    server.enqueue(({ body, response }) => sendOperation(response, body, (request) => ({
      action: "forget", target: targetFromRequest(request, "用户的住址是杭州市西湖区"),
      evidence: "能帮我忘记之前说的住址吗？",
    })));
    await send(page, "能帮我忘记之前说的住址吗？");
    await waitForAssistant(page, "我已删除这件事的已有记录");
    rows = readMemoryRows(dataDir, "rin");
    assert.equal(rows.some((row) => row.fact_key === "detail.address"), false);
    assert.equal(rows.find((row) => row.fact_key === "detail.job")?.body, "用户的工作是设计师");
    evidence.stages.push({ id: "delete", rows });
    await capture(page, "03-delete.png");
    const beforeFollow = server.requests.length;
    server.enqueue(({ response }) => sendStructured(response, { reply: "这个我现在想不起来了，能再跟我说说吗？", memoryCandidates: [] }));
    await send(page, "我住在哪里？");
    await waitForAssistant(page, "想不起来了");
    assert.equal(server.requests.length, beforeFollow + 1);
    const followMessages = server.requests.at(-1)?.messages ?? [];
    const followJson = JSON.stringify(followMessages);
    assert.equal(followJson.includes("杭州市西湖区"), false);
    assert.equal(followJson.includes("能帮我忘记之前说的住址吗"), false);
    assert.equal(followJson.includes("我住在哪里？"), true);
    evidence.followupMessages = followMessages;
    evidence.stages.push({ id: "followup", messages: followMessages });
    await capture(page, "04-followup.png");

    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectRin(page);
    let cards = await memoryCards(page);
    assert.ok(cards.some((card) => card.body === "我喜欢咖啡，不是茶"));
    assert.ok(cards.some((card) => card.body === "用户喜欢一个人旅行" && card.meta.includes("已禁止分享")));
    assert.ok(cards.some((card) => card.body === "用户的工作是设计师"));
    assert.equal(cards.some((card) => card.body.includes("杭州市西湖区")), false);
    assert.equal(cards.some((card) => card.body === "用户喜欢茶"), false);
    evidence.memoryPage = cards;
    await capture(page, "05-memory-page.png");
    await closeMemory(page);

    if (!(await closeApp(app, "after-operations", cleanup))) throw new Error("聊天窗口未确认退出");
    app = null;
    const relay = withStore(dataDir, (store) => {
      const travel = store.memory.listMemories("rin").find((entry) => entry.factKey === "pref.travel");
      try {
        store.memory.relay({ fromCharacterId: "rin", toCharacterId: "hu", entries: [{ entryId: travel.id, expectedVersion: travel.version }] });
        return "ALLOWED";
      } catch (error) { return error?.code ?? "ERROR"; }
    });
    assert.equal(relay, "SHARE_BLOCKED");
    evidence.afterClose = { memory: readMemoryRows(dataDir, "rin"), shareControls: readShareCount(dataDir), relay };

    launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(page);
    await selectRin(page);
    cards = await memoryCards(page);
    assert.ok(cards.some((card) => card.body === "我喜欢咖啡，不是茶"));
    assert.ok(cards.some((card) => card.body === "用户喜欢一个人旅行" && card.meta.includes("已禁止分享")));
    assert.equal(cards.some((card) => card.body.includes("杭州市西湖区")), false);
    evidence.restartMemory = cards;
    await capture(page, "06-restart-memory.png");
    await closeMemory(page);
    evidence.afterBase = readBase(dataDir);
    assert.deepEqual(evidence.afterBase.relationships, evidence.baseline.relationships);
    assert.deepEqual(evidence.afterBase.roster, evidence.baseline.roster);
    for (const beforeRow of evidence.baseline.stats) {
      const afterRow = evidence.afterBase.stats.find((row) => row.character_id === beforeRow.character_id);
      assert.equal(afterRow.intimacy, beforeRow.intimacy);
      assert.equal(afterRow.mood, beforeRow.mood);
      assert.ok(afterRow.energy >= beforeRow.energy - 0.01);
    }
    if (!(await closeApp(app, "restart", cleanup))) throw new Error("重启窗口未确认退出");
    app = null;
    evidence.machineVerdict = "PASS";
  } catch (error) {
    businessError = error;
    evidence.businessError = safeError(error);
  } finally {
    if (app) await closeApp(app, "finally", cleanup);
    try { await server.close(); cleanup.httpClosed = true; } catch (error) { cleanup.errors.push(`http:${safeError(error)}`); }
    const appsExited = cleanup.apps.every((record) => record.exited);
    if (appsExited) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        cleanup.tempDirRemoved = !fs.existsSync(dataDir);
        if (!cleanup.tempDirRemoved) cleanup.errors.push("temp dir still exists");
      } catch (error) { cleanup.errors.push(`rm:${safeError(error)}`); }
    } else {
      cleanup.tempDirRemoved = false;
      cleanup.errors.push("app exit unconfirmed; fixture kept");
    }
    evidence.requests = server.requests.map((body, index) => ({ index, messages: body?.messages ?? null }));
    if (businessError || cleanup.errors.length > 0) evidence.machineVerdict = "FAIL";
    try { writeEvidence(); } catch (error) { cleanup.errors.push(`evidence:${safeError(error)}`); }
  }
  if (businessError) {
    if (cleanup.errors.length > 0) businessError.message += `；清理错误：${cleanup.errors.join(" | ")}`;
    throw businessError;
  }
  assert.deepEqual(cleanup.errors, [], `清理失败：${cleanup.errors.join(" | ")}`);
});
