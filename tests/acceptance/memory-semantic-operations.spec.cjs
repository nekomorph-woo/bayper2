/* S03m 2a 真实两阶段 correct 验收：真实 createStore/chat/SQLite + 本机 HTTP。
   覆盖旧事实方向、pair ID 映射、候选整组证据、取消/降级、提前返回与单消息刷新。
   关系模型响应按请求实际 pair 构造，不把 Expected 传入请求；聊天模型亦为构造。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");
const { createAutomaticBudget } = require("../../app/automatic-budget.cjs");
const { createChatMemoryVerification } = require("../../app/chat-memory-verification.cjs");
const { parseTemporarySource } = require("../../app/memory-temporary-source.cjs");

const START = Date.UTC(2026, 9, 27, 10, 0, 0);
const MODEL_NAME = "fixture-semantic-operations";
const API_KEY = "sk-fixture-semantic-operations";
const PENDING_SUFFIX = "其他相近内容我正在核对，完成后会在同一条消息里更新。";

function sendEnvelope(res, envelope) {
  if (!res || res.destroyed || res.writableEnded) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }],
  }));
}

async function startModelServer() {
  const requests = [];
  const responders = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push(body);
      const responder = responders.shift();
      Promise.resolve(
        responder
          ? responder({ body, res })
          : sendEnvelope(res, { reply: "收到。", memoryCandidates: [] }),
      ).catch(() => {
        if (!res.destroyed && !res.writableEnded) res.destroy();
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

function withDatabase(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
}

function seedRelationships(dbPath, characterIds) {
  withDatabase(dbPath, (db) => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, '2026-01-01T00:00:00.000Z')",
    );
    for (const characterId of characterIds) insert.run(characterId);
  });
}

async function setupContext(t, characterIds = ["a", "b", "c"]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-semantic-ops-"));
  let tick = START;
  let store = null;
  const credentials = { baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY };
  let gateAfterCalls = null;
  let releaseCredentials = null;
  let credentialsStartedResolve;
  const credentialsStarted = new Promise((resolve) => { credentialsStartedResolve = resolve; });
  const open = (recoverInterrupted = false) => createStore(dir, {
    now: () => tick,
    chat: {
      timeoutMs: 2000,
      fetchImpl: fetch,
      recoverInterrupted,
      getCredentials: () => {
        if (gateAfterCalls !== null) {
          if (gateAfterCalls > 0) {
            gateAfterCalls -= 1;
            return credentials;
          }
          gateAfterCalls = null;
          credentialsStartedResolve();
          return new Promise((resolve) => { releaseCredentials = () => resolve(credentials); });
        }
        return credentials;
      },
    },
  });
  t.after(async () => {
    try { store?.close(); } catch { /* 用例可能已关闭 */ }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store = open();
  seedRelationships(store.dbPath, characterIds);
  return {
    server,
    dir,
    get store() { return store; },
    nowMs: () => tick,
    setNow(value) { tick = value; },
    reopen() { store.close(); store = open(); },
    reopenWithRecover() { store.close(); store = open(true); },
    gateSecondCredentials() { gateAfterCalls = 1; },
    credentialsStarted,
    releaseCredentials() { releaseCredentials?.(); },
  };
}

function memorySnapshot(dbPath) {
  return withDatabase(dbPath, (db) => {
    const rows = (table, orderBy) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    return {
      entries: rows("memory_entries", "id"),
      identities: rows("memory_fact_identities", "identity_id"),
      relations: rows("memory_fact_relation_edges", "from_entry_id, to_entry_id, kind"),
      aliases: rows("memory_fact_aliases", "fingerprint"),
      aliasConflicts: rows("memory_fact_alias_conflicts", "fingerprint, identity_id"),
      sourceControls: rows("memory_source_controls", "character_id, source_id_hash"),
      identityControls: rows("memory_forget_identity_controls", "character_id, identity_id"),
      deletedFingerprints: rows("memory_deleted_fact_fingerprints", "character_id, fingerprint"),
      legacyForgetControls: rows("memory_forget_controls", "character_id, fact_key_hash"),
      contextVersions: rows("memory_context_versions", "character_id"),
      derivations: rows("memory_derivations", "entry_id"),
      fts: rows("memory_fts", "entry_id"),
    };
  });
}

const openConversation = (store, characterId = "a") =>
  store.chat.openConversation({ characterId }).conversation;

const entryOf = (store, characterId, factKey) =>
  store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;

function targetFromRequest(body, needle) {
  const systemText = body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const line = systemText
    .split("\n")
    .find((item) => /^\[M\d+\]/u.test(item) && item.includes(needle));
  const match = line?.match(/^\[(M\d+)\]/u);
  assert.ok(match, `候选列表没有找到 ${needle}`);
  return match[1];
}

async function chatTurn(ctx, conversation, text, candidates = [], characterId = "a") {
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "我记下了。", memoryCandidates: candidates, memoryOperation: null, memoryRelay: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result;
}

function correctionEnvelope(body, { needle, excerpt, evidence }) {
  return {
    reply: "好的。",
    memoryCandidates: [],
    memoryOperation: {
      action: "correct",
      target: targetFromRequest(body, needle),
      excerpt,
      evidence,
    },
  };
}

function pairsOf(body) {
  return JSON.parse(body.messages.find((message) => message.role === "user").content).pairs;
}

function relationResult(pair, relation) {
  const description = {
    subject: "用户", subjectQuote: "我", scope: "current", time: null, timeQuote: null,
  };
  return { pair: pair.id, relation, left: description, right: { ...description } };
}

function relationResponder(resultsOf) {
  return ({ body, res }) => {
    const pairs = pairsOf(body);
    return new Promise((resolve) => {
      setTimeout(() => {
        sendEnvelope(res, { results: resultsOf(pairs) });
        resolve();
      }, 60);
    });
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待核验完成超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const verificationRequests = (ctx) => ctx.server.requests.filter((body) =>
  body?.messages?.some((message) =>
    message.role === "system" && message.content.includes("记忆事实关系判定器")));

async function sendCorrection(ctx, conversation, text, options, { verification } = {}) {
  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, correctionEnvelope(body, options)));
  if (verification) ctx.server.enqueue(verification);
  return ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
}

function seedCoffeeA(ctx, conversation) {
  return chatTurn(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
}

/* A 的长期事实显式转告给 B，形成已证明的同一长期 identity；随后 A 的今日
   理解应同步到 B，而不是靠正文相同猜组。 */
async function seedSameFactPair(ctx) {
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: aLong.id, expectedVersion: aLong.version }],
  });
  return {
    aConversation,
    bConversation,
    aLong: entryOf(ctx.store, "a", "pref.coffee"),
    bLong: entryOf(ctx.store, "b", "pref.coffee"),
  };
}

async function tellToday(ctx, conversation, {
  text, needle, excerpt, evidence, characterId = "a",
}) {
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, correctionEnvelope(body, { needle, excerpt, evidence })));
  const result = await ctx.store.chat.sendMessage({
    characterId,
    conversationId: conversation.id,
    text,
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result;
}

function temporaryEntryOf(store, characterId, { includeLegacy = false } = {}) {
  return (
    store.memory.listMemories(characterId).find((entry) => {
      if (entry.expiresAt === null) {
        return false;
      }
      if (/^(chat-current:|chat-current-copy:|temporary-edit:)/u.test(entry.sourceId)) {
        return true;
      }
      return includeLegacy && /^(relay:|share:)/u.test(entry.sourceId);
    }) ?? null
  );
}

function temporaryRows(ctx) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT id, character_id, fact_key, fact_identity_id, body, source_id,
           version, expires_at
    FROM memory_entries
    WHERE source_id LIKE 'chat-current:%'
       OR source_id LIKE 'chat-current-copy:%'
       OR source_id LIKE 'temporary-edit:%'
    ORDER BY character_id ASC, id ASC
  `).all());
}

function temporaryLinks(ctx) {
  return withDatabase(ctx.store.dbPath, (db) => {
    const exists = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_temporary_links'",
    ).get();
    return exists
      ? db.prepare(`
        SELECT * FROM memory_temporary_links
        ORDER BY holder_character_id ASC, temp_identity_id ASC
      `).all()
      : [];
  });
}

function snapshotOf(ctx, characterId, entry) {
  return ctx.store.memorySourceContext.resolve({
    characterId,
    entryId: entry.id,
    expectedVersion: entry.version,
  });
}


function forgetEnvelope(body, { needle, evidence, modelScope = "all" }) {
  return {
    reply: "好的。",
    memoryCandidates: [],
    memoryOperation: {
      action: "forget",
      target: targetFromRequest(body, needle),
      scope: modelScope,
      evidence,
    },
  };
}

async function sendForget(ctx, conversation, text, options, {
  verification, modelScope = "all",
} = {}) {
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, forgetEnvelope(body, { ...options, modelScope })));
  if (verification) ctx.server.enqueue(verification);
  return ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
}

async function seedCoffeeB(ctx, conversation) {
  return chatTurn(ctx, conversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
}

async function seedCoffeeC(ctx, conversation) {
  return chatTurn(ctx, conversation, "我偏爱咖啡。", [
    { factKey: "pref.coffeeC", body: "用户偏爱咖啡", kind: "preference", trust: "stated", evidence: "我偏爱咖啡" },
  ], "c");
}

/* A 独立第二咖啡 identity，relay 给 B 形成同 identity 的 A/B 双持有者候选。
   B 副本来源为 relay:，没有可直接解析的来源快照；forget 模式必须仍能处理。
   候选正文用 coffee 与目标“咖啡”错开命令 token，避免聊天目标歧义。 */
async function seedSharedCoffeeCandidate(ctx, aConversation) {
  await chatTurn(ctx, aConversation, "我特别喜欢 coffee。", [
    { factKey: "pref.coffeeA2", body: "用户特别喜欢 coffee", kind: "preference", trust: "stated", evidence: "我特别喜欢 coffee" },
  ]);
  const entry = entryOf(ctx.store, "a", "pref.coffeeA2");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: entry.id, expectedVersion: entry.version }],
  });
  return {
    aEntry: entryOf(ctx.store, "a", "pref.coffeeA2"),
    bEntry: entryOf(ctx.store, "b", "pref.coffeeA2"),
  };
}

function lastAssistant(ctx, conversation, characterId = "a") {
  return ctx.store.chat.getConversation({
    characterId, conversationId: conversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
}

function proofOf(ctx, requestId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT operation_proof, verification_status FROM chat_requests WHERE id = ?",
  ).get(requestId));
}

function budgetSnapshot(ctx) {
  createAutomaticBudget({ db: ctx.store.db, now: ctx.nowMs });
  return withDatabase(ctx.store.dbPath, (db) => ({
    attempts: db.prepare("SELECT * FROM automatic_budget_attempts ORDER BY id").all(),
    state: db.prepare("SELECT * FROM automatic_budget_state ORDER BY key").all(),
  }));
}

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
async function setupForgetPair(t) {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await seedCoffeeB(ctx, bConversation);
  return { ctx, aConversation, bConversation };
}
function gatedVerification(t) {
  let release;
  let started = false;
  const gate = {
    waitStarted: () => waitFor(() => started),
    release: () => release?.(),
    responder: ({ body, res }) => {
      const pairs = pairsOf(body);
      started = true;
      return new Promise((resolve) => {
        release = () => {
          if (!res.destroyed && !res.writableEnded) {
            sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
          }
          resolve();
        };
      });
    },
  };
  // 无论测试在哪一步失败，都释放自己持有的 HTTP 核验响应，避免悬挂。
  t.after(() => gate.release());
  return gate;
}
test("POL-SEMOP-001a/b/c 旧事实核验：left 是 A 旧事实，B 旧事实确认后才传播", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const aOld = entryOf(ctx.store, "a", "pref.coffee");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");

  const chatRequestsBefore = ctx.server.requests.length;
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.verificationStatus, "pending");
  assert.match(result.reply, /正在核对/u);
  const aDuring = entryOf(ctx.store, "a", "pref.coffee");
  const bDuring = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.notEqual(aDuring.body, aOld.body);
  assert.equal(bDuring.body, bOld.body);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeB"), null);
  const aChatRequest = ctx.server.requests[chatRequestsBefore];
  assert.equal(JSON.stringify(aChatRequest).includes("我也爱喝咖啡"), false);

  await waitFor(() => verificationRequests(ctx).length === 1);
  const verificationBody = verificationRequests(ctx)[0];
  const pair = pairsOf(verificationBody)[0];
  assert.match(pair.left.text, /咖啡/u);
  assert.equal(pair.left.text.includes("茶"), false);
  assert.match(pair.right.text, /爱喝咖啡/u);

  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  const finished = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(finished.verificationStatus, "completed");
  const aFinal = entryOf(ctx.store, "a", "pref.coffee");
  const bFinal = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bFinal.body, aFinal.body);
  assert.match(bFinal.sourceId, /^corrected:/u);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeB"), null);

  const messages = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages;
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("正在核对"), false);
  assert.match(assistant.content, /一并更正/u);

  const source = ctx.store.memorySourceContext.resolve({
    characterId: "b", entryId: bFinal.id, expectedVersion: bFinal.version,
  });
  assert.equal(source.status, "ok");
  assert.equal(source.direct, false);
  assert.equal(source.via, "identity_correction");
  assert.equal(ctx.store.memorySourceContext.isCurrent(source), true);
});

test("POL-SEMOP-001a B 已喜欢茶但不是同一旧事实，不因新结果相同而合并", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我喜欢茶。", [
    { factKey: "pref.teaB", body: "用户喜欢茶", kind: "preference", trust: "stated", evidence: "我喜欢茶" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.teaB");

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) =>
      (pair.left.text.includes("咖啡") ? relationResult(pair, "different") : relationResult(pair, "equivalent")))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  const pair = pairsOf(verificationRequests(ctx)[0])[0];
  assert.equal(pair.left.text, "我喜欢咖啡");
  assert.equal(pair.left.text.includes("茶"), false);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.teaB").body, bOld.body);
  assert.equal(entryOf(ctx.store, "b", "pref.teaB").sourceId, bOld.sourceId);
});

test("POL-SEMOP-004d 多候选按 pair ID 映射，模型倒序结果只改正确候选", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  await chatTurn(ctx, bConversation, "我有一台咖啡机。", [
    { factKey: "pref.machine", body: "用户有一台咖啡机", kind: "preference", trust: "stated", evidence: "我有一台咖啡机" },
  ], "b");
  const loveOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const machineOld = entryOf(ctx.store, "b", "pref.machine");

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => {
      const results = pairs.map((pair) => ({
        pair,
        relation: pair.right.text.includes("爱喝") ? "equivalent" : "different",
      }));
      // parseRelationResponse 只保证 pair ID 对应，不保证顺序；倒序返回。
      return results.reverse().map(({ pair, relation }) => relationResult(pair, relation));
    }),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.notEqual(entryOf(ctx.store, "b", "pref.coffeeB").body, loveOld.body);
  assert.equal(entryOf(ctx.store, "b", "pref.machine").body, machineOld.body);
  assert.equal(entryOf(ctx.store, "b", "pref.machine").sourceId, machineOld.sourceId);
});

test("POL-SEMOP-004b 核验等待期间候选原消息被改，不应用旧结果", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const bMessageId = bOld.sourceId.slice("chat:".length);
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body, res }) => {
      const pairs = pairsOf(body);
      startedResolve();
      return new Promise((resolve) => {
        release = () => {
          sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
          resolve();
        };
      });
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("被改掉的原话", bMessageId);
  });
  release();
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-004b 候选消息被搬到另一会话或来源被替换，拒绝旧证据", async (t) => {
  for (const mode of ["conversation", "source"]) {
    const ctx = await setupContext(t);
    const aConversation = openConversation(ctx.store);
    const bConversation = openConversation(ctx.store, "b");
    const otherBConversation = openConversation(ctx.store, "b");
    await seedCoffeeA(ctx, aConversation);
    await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
      { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
    ], "b");
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
    const bMessageId = bOld.sourceId.slice("chat:".length);
    let release;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
      needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
    }, {
      verification: ({ body, res }) => {
        const pairs = pairsOf(body);
        startedResolve();
        return new Promise((resolve) => {
          release = () => {
            sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
            resolve();
          };
        });
      },
    });
    await started;
    withDatabase(ctx.store.dbPath, (db) => {
      if (mode === "conversation") {
        db.prepare("UPDATE chat_messages SET conversation_id = ? WHERE id = ?")
          .run(otherBConversation.id, bMessageId);
      } else {
        db.prepare("UPDATE chat_messages SET source_id = ? WHERE id = ?")
          .run("forged-source", bMessageId);
      }
    });
    release();
    await waitFor(() => {
      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      return request.verificationStatus !== "pending";
    });
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  }
});

test("POL-SEMOP-003b 阶段 1 后取消：停在阶段 2，原位收口本地完成", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body, res }) => {
      const pairs = pairsOf(body);
      startedResolve();
      return new Promise((resolve) => {
        release = () => {
          sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
          resolve();
        };
      });
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  const cancelled = ctx.store.chat.cancelRequest({
    characterId: "a", requestId: result.requestId,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.verificationStatus, "cancelled");
  release();
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus === "cancelled";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("正在核对"), false);
  assert.match(assistant.content, /本地这次更正已完成/u);
});

test("POL-SEMOP-004 候选捕获异常降级本地完成，不阻断已明确 correct", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  ctx.store.memorySourceContext.resolve = () => { throw new Error("fixture capture failure"); };

  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, correctionEnvelope(body, {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  })));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: aConversation.id,
    text: "不是咖啡，我更喜欢茶，请帮我改过来。",
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.verificationStatus, "none");
  assert.notEqual(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, "我也爱喝咖啡");
});

test("POL-SEMOP-004a 核验等待期间 A 旧原话被改，不把新结果传给 B", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const aOld = entryOf(ctx.store, "a", "pref.coffee");
  const aMessageId = aOld.sourceId.slice("chat:".length);
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body, res }) => {
      const pairs = pairsOf(body);
      startedResolve();
      return new Promise((resolve) => {
        release = () => {
          sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
          resolve();
        };
      });
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("被改掉的旧原话", aMessageId);
  });
  release();
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-006 普通聊天/无候选不发额外请求；有候选最多一次且不占自动预算", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await chatTurn(ctx, aConversation, "你好。", []);
  assert.equal(verificationRequests(ctx).length, 0);
  await seedCoffeeA(ctx, aConversation);
  await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  });
  assert.equal(verificationRequests(ctx).length, 0);
  assert.equal(ctx.store.automaticBudget, null);
});

test("POL-SEMOP-005d 候选来源被排除时不发核验请求", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bEntry = entryOf(ctx.store, "b", "pref.coffeeB");
  const sha = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("INSERT INTO memory_source_controls (character_id, source_id_hash, created_at) VALUES (?, ?, ?)")
      .run("b", sha(bEntry.sourceId), ctx.nowMs());
  });
  await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  });
  assert.equal(verificationRequests(ctx).length, 0);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bEntry.body);
});

test("POL-SEMOP-008 同角色独立同义候选：按阶段1来源增量核验并真实关联", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await chatTurn(ctx, aConversation, "我最爱饮品是咖啡。", [
    { factKey: "pref.drinkCoffee", body: "用户最爱饮品是咖啡", kind: "preference", trust: "stated", evidence: "我最爱饮品是咖啡" },
  ]);
  await chatTurn(ctx, aConversation, "我最爱饮品是 coffee。", [
    { factKey: "pref.drinkCoffeeEn", body: "用户最爱饮品是 coffee", kind: "preference", trust: "stated", evidence: "我最爱饮品是 coffee" },
  ]);
  const targetOld = entryOf(ctx.store, "a", "pref.drinkCoffee");
  const candidateOld = entryOf(ctx.store, "a", "pref.drinkCoffeeEn");

  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "最爱饮品是咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  const pair = pairsOf(verificationRequests(ctx)[0])[0];
  assert.equal(pair.left.text, targetOld.body);
  assert.match(pair.right.text, /coffee/u);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  const target = entryOf(ctx.store, "a", "pref.drinkCoffee");
  const candidate = entryOf(ctx.store, "a", "pref.drinkCoffeeEn");
  assert.equal(candidate.body, target.body);
  assert.match(candidate.sourceId, /^corrected:/u);
  const source = ctx.store.memorySourceContext.resolve({
    characterId: "a", entryId: candidate.id, expectedVersion: candidate.version,
  });
  assert.equal(source.status, "ok");
  assert.equal(source.direct, false);
  assert.equal(source.via, "identity_correction");
  assert.equal(source.sourceAnchorEntryId, target.id);
  assert.equal(ctx.store.memorySourceContext.isCurrent(source), true);
});

test("POL-SEMOP-008 B 同时持有同身份副本与独立候选：阶段1增量不误拒", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  const aEntry = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
  });
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bIndependentOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  const aFinal = entryOf(ctx.store, "a", "pref.coffee");
  const bRelayed = entryOf(ctx.store, "b", "pref.coffee");
  const bIndependent = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bRelayed.body, aFinal.body);
  assert.notEqual(bIndependent.body, bIndependentOld.body);
  assert.equal(bIndependent.body, aFinal.body);
});

test("POL-SEMOP-008 人工关联内部机制：correct 后同角色 identity 来源可解析（不标语义等价）", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, aConversation, "我特别喜欢猫。", [
    { factKey: "pref.cat", body: "用户特别喜欢猫", kind: "preference", trust: "stated", evidence: "我特别喜欢猫" },
  ]);
  const coffee = entryOf(ctx.store, "a", "pref.coffee");
  const cat = entryOf(ctx.store, "a", "pref.cat");
  ctx.store.memory.associateFacts({
    left: { entryId: coffee.id, expectedVersion: coffee.version },
    right: { entryId: cat.id, expectedVersion: cat.version },
    nowMs: ctx.nowMs(),
  });
  const associated = entryOf(ctx.store, "a", "pref.coffee");
  const associatedPeer = entryOf(ctx.store, "a", "pref.cat");
  assert.equal(associatedPeer.factIdentityId, associated.factIdentityId);

  await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "我喜欢咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  });
  const first = entryOf(ctx.store, "a", "pref.coffee");
  const peer = entryOf(ctx.store, "a", "pref.cat");
  assert.equal(peer.body, first.body);
  assert.match(first.sourceId, /^chat-correct:/u);
  assert.match(peer.sourceId, /^corrected:/u);
  assert.equal(verificationRequests(ctx).length, 0);

  for (const [entry, direct, via] of [
    [first, true, "corrected_chat"],
    [peer, false, "identity_correction"],
  ]) {
    const source = ctx.store.memorySourceContext.resolve({
      characterId: "a", entryId: entry.id, expectedVersion: entry.version,
    });
    assert.equal(source.status, "ok");
    assert.equal(source.direct, direct);
    assert.equal(source.via, via);
    assert.equal(source.holderCharacterId, "a");
    assert.equal(source.sourceAnchorEntryId, first.id);
    assert.equal(source.sourceAnchorVersion, first.version);
    assert.equal(ctx.store.memorySourceContext.isCurrent(source), true);
  }
});

test("POL-SEMOP-008 同 identity 派生副本由阶段 1 更新，不进入独立核验", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const aEntry = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
  });
  await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  });
  const bEntry = entryOf(ctx.store, "b", "pref.coffee");
  const aFinal = entryOf(ctx.store, "a", "pref.coffee");
  assert.equal(bEntry.body, aFinal.body);
  assert.match(bEntry.sourceId, /^corrected:/u);
  assert.equal(verificationRequests(ctx).length, 0);
  const source = ctx.store.memorySourceContext.resolve({
    characterId: "b", entryId: bEntry.id, expectedVersion: bEntry.version,
  });
  assert.equal(source.status, "ok");
  assert.equal(source.direct, false);
  assert.equal(source.via, "identity_correction");
  assert.equal(ctx.store.memorySourceContext.isCurrent(source), true);
});

test("POL-SEMOP-004c 阶段 2 故障整笔回滚，关联不残留", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec(`
      CREATE TRIGGER fail_b_correction
      BEFORE UPDATE OF body ON memory_entries
      WHEN OLD.id = '${bOld.id}'
      BEGIN SELECT RAISE(ABORT, 'fixture phase2 fault'); END;
    `);
  });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  const bAfter = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bAfter.body, bOld.body);
  assert.equal(bAfter.sourceId, bOld.sourceId);
  assert.equal(bAfter.factIdentityId, bOld.factIdentityId);
  const edges = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT COUNT(*) AS count FROM memory_fact_relation_edges WHERE from_entry_id = ? OR to_entry_id = ?",
  ).get(bOld.id, bOld.id).count);
  assert.equal(edges, 0);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-003c dispose 中断核验：原位收口本地完成", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body }) => {
      startedResolve();
      void body;
      return new Promise(() => {}); // 由 dispose abort；不主动返回响应。
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  await ctx.store.chat.dispose();
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.verificationStatus, "cancelled");
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("正在核对"), false);
  assert.match(assistant.content, /本地这次更正已完成/u);
});

test("POL-SEMOP-004b 候选同 identity 非代表成员来源被改，不应用旧结果", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  await chatTurn(ctx, cConversation, "我偏爱咖啡。", [
    { factKey: "pref.coffeeC", body: "用户偏爱咖啡", kind: "preference", trust: "stated", evidence: "我偏爱咖啡" },
  ], "c");
  const bEntry = entryOf(ctx.store, "b", "pref.coffeeB");
  const cEntry = entryOf(ctx.store, "c", "pref.coffeeC");
  ctx.store.memory.associateFacts({
    left: { entryId: bEntry.id, expectedVersion: bEntry.version },
    right: { entryId: cEntry.id, expectedVersion: cEntry.version },
    nowMs: ctx.nowMs(),
  });
  const bAfterAssoc = entryOf(ctx.store, "b", "pref.coffeeB");
  const cAfterAssoc = entryOf(ctx.store, "c", "pref.coffeeC");
  const cMessageId = cAfterAssoc.sourceId.slice("chat:".length);
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body, res }) => {
      const pairs = pairsOf(body);
      startedResolve();
      return new Promise((resolve) => {
        release = () => {
          sendEnvelope(res, { results: pairs.map((pair) => relationResult(pair, "equivalent")) });
          resolve();
        };
      });
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("被改掉的同身份成员原话", cMessageId);
  });
  release();
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bAfterAssoc.body);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeC").body, cAfterAssoc.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-003c closeConversation 中断核验并原位收口", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ body }) => {
      startedResolve();
      void body;
      return new Promise(() => {});
    },
  });
  assert.equal(result.verificationStatus, "pending");
  await started;
  ctx.store.chat.closeConversation({
    characterId: "a", conversationId: aConversation.id,
  });
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    const messages = ctx.store.chat.getConversation({
      characterId: "a", conversationId: aConversation.id,
    }).messages;
    const assistant = messages.find((message) => message.id === request.assistantMessageId);
    return request.verificationStatus === "cancelled" &&
      assistant && !assistant.content.includes("正在核对");
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
});

test("POL-SEMOP-003c 重启中断核验：pending 转为 interrupted 并收口", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const chat = await chatTurn(ctx, aConversation, "你好。", []);
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = content || ? WHERE id = ?")
      .run(`\n\n${PENDING_SUFFIX}`, chat.assistantMessageId);
    db.prepare("UPDATE chat_requests SET verification_status = 'pending', operation_proof = '{}' WHERE id = ?")
      .run(chat.requestId);
  });
  ctx.reopenWithRecover();
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: chat.requestId });
  assert.equal(request.verificationStatus, "interrupted");
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.find((message) => message.id === chat.assistantMessageId);
  assert.equal(assistant.content.includes("正在核对"), false);
  assert.match(assistant.content, /本地这次更正已完成/u);
});

test("POL-SEMOP-003c 老库 chat_requests 自动补 operation_proof/verification_status", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-semantic-old-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "bayper.sqlite3");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE relationships (
        character_id TEXT PRIMARY KEY,
        accepted_at TEXT NOT NULL
      );
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES relationships(character_id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
        character_id TEXT NOT NULL REFERENCES relationships(character_id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(content) > 0),
        source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        seq INTEGER
      );
      CREATE TABLE chat_requests (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
        character_id TEXT NOT NULL REFERENCES relationships(character_id),
        user_message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id),
        status TEXT NOT NULL,
        context_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        assistant_message_id TEXT REFERENCES chat_messages(id),
        error_code TEXT,
        memory_applied INTEGER NOT NULL DEFAULT 0
      );
    `);
  } finally {
    db.close();
  }
  const store = createStore(dir, { now: () => START });
  try {
    const columns = store.db.prepare("PRAGMA table_info(chat_requests)").all()
      .map((column) => column.name);
    assert.ok(columns.includes("operation_proof"));
    assert.ok(columns.includes("verification_status"));
  } finally {
    store.close();
  }
});



test("POL-SEMOP-004d 两个候选均 equivalent：两次真实合并与版本推进", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  await seedCoffeeA(ctx, aConversation);
  for (const [characterId, conversation, factKey, body, text] of [
    ["b", bConversation, "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡"],
    ["c", cConversation, "pref.coffeeC", "用户偏爱咖啡", "我偏爱咖啡"],
  ]) {
    await chatTurn(ctx, conversation, `${text}。`, [
      { factKey, body, kind: "preference", trust: "stated", evidence: text },
    ], characterId);
  }
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  const stage1Version = entryOf(ctx.store, "a", "pref.coffee").version;
  await waitFor(() => verificationRequests(ctx).length === 1);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  const anchor = entryOf(ctx.store, "a", "pref.coffee");
  const b = entryOf(ctx.store, "b", "pref.coffeeB");
  const c = entryOf(ctx.store, "c", "pref.coffeeC");
  assert.equal(b.body, anchor.body);
  assert.equal(c.body, anchor.body);
  assert.ok(anchor.version >= stage1Version + 2);
  for (const candidate of [b, c]) {
    const source = ctx.store.memorySourceContext.resolve({
      characterId: candidate.characterId,
      entryId: candidate.id,
      expectedVersion: candidate.version,
    });
    assert.equal(source.status, "ok");
    assert.equal(source.direct, false);
    assert.equal(ctx.store.memorySourceContext.isCurrent(source), true);
  }
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.match(assistant.content, /2 条/u);
});

test("POL-SEMOP-004c 第二候选更新故障：两次合并/正文/controls/aliases/versions 全部回滚", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  await seedCoffeeA(ctx, aConversation);
  for (const [characterId, conversation, factKey, body, text] of [
    ["b", bConversation, "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡"],
    ["c", cConversation, "pref.coffeeC", "用户偏爱咖啡", "我偏爱咖啡"],
  ]) {
    await chatTurn(ctx, conversation, `${text}。`, [
      { factKey, body, kind: "preference", trust: "stated", evidence: text },
    ], characterId);
  }
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const cOld = entryOf(ctx.store, "c", "pref.coffeeC");
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec(`
      CREATE TRIGGER fail_second_candidate
      BEFORE UPDATE OF body ON memory_entries
      WHEN OLD.id = '${cOld.id}'
      BEGIN SELECT RAISE(ABORT, 'fixture second candidate fault'); END;
    `);
  });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  const afterStage1 = memorySnapshot(ctx.store.dbPath);
  await waitFor(() => verificationRequests(ctx).length === 1);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.deepEqual(memorySnapshot(ctx.store.dbPath), afterStage1);
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.status, "completed");
  assert.equal(request.verificationStatus, "failed");
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.match(assistant.content, /本地这次更正已完成/u);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-004c 最终 assistant 更新失败：两候选关联/正文/控制随第二事务回滚", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  await seedCoffeeA(ctx, aConversation);
  for (const [characterId, conversation, factKey, body, text] of [
    ["b", bConversation, "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡"],
    ["c", cConversation, "pref.coffeeC", "用户偏爱咖啡", "我偏爱咖啡"],
  ]) {
    await chatTurn(ctx, conversation, `${text}。`, [
      { factKey, body, kind: "preference", trust: "stated", evidence: text },
    ], characterId);
  }
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec(`
      CREATE TRIGGER fail_final_assistant
      BEFORE UPDATE OF content ON chat_messages
      WHEN NEW.content LIKE '%一并更正%'
      BEGIN SELECT RAISE(ABORT, 'fixture final assistant fault'); END;
    `);
  });
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  const afterStage1 = memorySnapshot(ctx.store.dbPath);
  await waitFor(() => verificationRequests(ctx).length === 1);
  const pairs = pairsOf(verificationRequests(ctx)[0]);
  assert.equal(pairs.length, 2);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.deepEqual(memorySnapshot(ctx.store.dbPath), afterStage1);
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.status, "completed");
  assert.equal(request.verificationStatus, "failed");
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.match(assistant.content, /本地这次更正已完成/u);
  assert.equal(assistant.content.includes("一并更正"), false);
});

test("POL-SEMOP-006 核验 15s 超时：本地完成，不传播", { timeout: 30000 }, async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: () => new Promise(() => {}),
  });
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  }, 20000);
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.verificationStatus, "failed");
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.match(assistant.content, /本地这次更正已完成/u);
});

test("POL-SEMOP-006 核验网络失败：本地完成，不传播", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: ({ res }) => { res.destroy(); },
  });
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus !== "pending";
  });
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
});

test("POL-SEMOP-003b 阶段 1 前取消：零写且不发核验", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const aOld = entryOf(ctx.store, "a", "pref.coffee");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  ctx.server.enqueue(({ body }) => {
    startedResolve();
    void body;
    return new Promise((resolve) => {
      release = () => resolve();
    });
  });
  const requestId = "phase1-cancel";
  const pending = ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: aConversation.id,
    text: "不是咖啡，我更喜欢茶，请帮我改过来。",
    requestId,
  });
  await started;
  const cancelled = ctx.store.chat.cancelRequest({ characterId: "a", requestId });
  assert.equal(cancelled.cancelled, true);
  release();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, aOld.body);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  assert.equal(verificationRequests(ctx).length, 0);
});

test("POL-SEMOP-003b 凭据等待期间取消：不发第二次 HTTP", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
    { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
  ], "b");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  ctx.gateSecondCredentials();
  const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await ctx.credentialsStarted;
  ctx.store.chat.cancelRequest({ characterId: "a", requestId: result.requestId });
  ctx.releaseCredentials();
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    return request.verificationStatus === "cancelled";
  });
  assert.equal(verificationRequests(ctx).length, 0);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  const assistant = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").at(-1);
  assert.match(assistant.content, /本地这次更正已完成/u);
});

test("POL-SEMOP-003b 凭据等待期间候选被改或新增限制：不发第二次 HTTP", async (t) => {
  for (const mode of ["message", "control"]) {
    const ctx = await setupContext(t);
    const aConversation = openConversation(ctx.store);
    const bConversation = openConversation(ctx.store, "b");
    await seedCoffeeA(ctx, aConversation);
    await chatTurn(ctx, bConversation, "我也爱喝咖啡。", [
      { factKey: "pref.coffeeB", body: "用户也爱喝咖啡", kind: "preference", trust: "stated", evidence: "我也爱喝咖啡" },
    ], "b");
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
    const bMessageId = bOld.sourceId.slice("chat:".length);
    ctx.gateSecondCredentials();
    const result = await sendCorrection(ctx, aConversation, "不是咖啡，我更喜欢茶，请帮我改过来。", {
      needle: "咖啡", excerpt: "我更喜欢茶", evidence: "请帮我改过来",
    }, {
      verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
    });
    assert.equal(result.verificationStatus, "pending");
    await ctx.credentialsStarted;
    if (mode === "message") {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run("凭据等待期间被改", bMessageId);
      });
    } else {
      const sha = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at) VALUES (?, ?, ?)")
          .run("b", sha(bOld.sourceId), ctx.nowMs());
      });
    }
    ctx.releaseCredentials();
    await waitFor(() => {
      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      return request.verificationStatus !== "pending";
    });
    assert.equal(verificationRequests(ctx).length, 0);
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  }
});

async function awaitVerificationSettled(ctx, result) {
  await waitFor(() => ctx.store.chat.getRequest({
    characterId: "a", requestId: result.requestId,
  }).verificationStatus !== "pending");
}

test("POL-SEMOP-002a forget all 删除 A 本地锚与 B 独立同义候选，单消息原位收口", async (t) => {
  const { ctx, aConversation, bConversation } = await setupForgetPair(t);
  const aOld = entryOf(ctx.store, "a", "pref.coffee");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");

  const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.verificationStatus, "pending");
  assert.match(result.reply, /正在核对/u);
  await waitFor(() => verificationRequests(ctx).length === 1);
  const pair = pairsOf(verificationRequests(ctx)[0])[0];
  assert.equal(pair.left.text, aOld.body);
  assert.equal(pair.right.text, bOld.body);
  await awaitVerificationSettled(ctx, result);

  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB"), null);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeB"), null);
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.verificationStatus, "completed");
  const assistant = lastAssistant(ctx, aConversation);
  assert.equal(assistant.id, result.assistantMessageId);
  assert.match(assistant.content, /一并删除了/u);
  assert.equal(assistant.content.includes("更正"), false);
  const proofRow = proofOf(ctx, result.requestId);
  const proof = JSON.parse(proofRow.operation_proof);
  assert.equal(proof.action, "forget");
  assert.equal(proof.scope, "all");
  assert.equal(JSON.stringify(proof).includes(aOld.body), false);
  assert.equal(JSON.stringify(proof).includes(bOld.body), false);
  assert.equal(typeof proof.initiatorContextVersion, "number");
  assert.ok(proof.sourceControls.a.includes(sha256(aOld.sourceId)));
  assert.ok(proof.sourceControls.a.includes(sha256(`chat:${ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.find((message) => message.role === "user" && message.content.startsWith("请忘记")).id}`)));
  assert.deepEqual(ctx.store.memory.searchMemories({ characterId: "a", query: "咖啡" }), []);
  assert.deepEqual(ctx.store.memory.searchMemories({ characterId: "b", query: "咖啡" }), []);
});
test("POL-SEMOP-002a forget all 同候选 identity 有 A/B 成员时一次清除全部持有者", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const candidate = await seedSharedCoffeeCandidate(ctx, aConversation);
  assert.ok(candidate.aEntry && candidate.bEntry);

  const result = await sendForget(ctx, aConversation, "请忘记咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记咖啡这件事",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  assert.equal(pairsOf(verificationRequests(ctx)[0]).length, 1, "同一 identity 只核验一次");
  await awaitVerificationSettled(ctx, result);

  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "a", "pref.coffeeA2"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeA2"), null);
  const assistant = lastAssistant(ctx, aConversation);
  assert.match(assistant.content, /1 条/u);
  assert.match(assistant.content, /一并删除了/u);
});
test("POL-SEMOP-002b forget self 只删 A 候选成员，B 成员与 B 独有候选保持不变", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  const candidate = await seedSharedCoffeeCandidate(ctx, aConversation);
  await seedCoffeeB(ctx, bConversation);
  const bCandidateBefore = candidate.bEntry;
  const bOnlyBefore = entryOf(ctx.store, "b", "pref.coffeeB");
  const bContextBefore = ctx.store.memory.getContextVersion("b");

  const result = await sendForget(ctx, aConversation, "只你忘记咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "只你忘记咖啡这件事", modelScope: "all",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  assert.equal(pairsOf(verificationRequests(ctx)[0]).length, 1, "self 只核验 A 持有的候选");
  await awaitVerificationSettled(ctx, result);

  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "a", "pref.coffeeA2"), null);
  const bCandidateAfter = entryOf(ctx.store, "b", "pref.coffeeA2");
  assert.equal(bCandidateAfter.body, bCandidateBefore.body);
  assert.equal(bCandidateAfter.version, bCandidateBefore.version);
  assert.equal(bCandidateAfter.sourceId, bCandidateBefore.sourceId);
  const bOnlyAfter = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bOnlyAfter.body, bOnlyBefore.body);
  assert.equal(bOnlyAfter.version, bOnlyBefore.version);
  assert.equal(ctx.store.memory.getContextVersion("b"), bContextBefore);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeB"), null);
});
test("POL-SEMOP-002c forget 关系未确认/截断不删候选，如实说明未确认范围", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  for (const [factKey, body, text] of [
    ["pref.coffeeB1", "用户也爱喝咖啡", "我也爱喝咖啡"],
    ["pref.coffeeB2", "用户偏爱咖啡", "我偏爱咖啡"],
    ["pref.coffeeB3", "用户每天喝咖啡", "我每天喝咖啡"],
  ]) {
    await chatTurn(ctx, bConversation, `${text}。`, [
      { factKey, body, kind: "preference", trust: "stated", evidence: text },
    ], "b");
  }
  const bBefore = ["pref.coffeeB1", "pref.coffeeB2", "pref.coffeeB3"]
    .map((factKey) => entryOf(ctx.store, "b", factKey));

  const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "different"))),
  });
  assert.equal(result.verificationStatus, "pending");
  await waitFor(() => verificationRequests(ctx).length === 1);
  await awaitVerificationSettled(ctx, result);

  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  for (const before of bBefore) {
    const after = entryOf(ctx.store, "b", before.factKey);
    assert.equal(after.body, before.body);
    assert.equal(after.version, before.version);
  }
  const assistant = lastAssistant(ctx, aConversation);
  assert.match(assistant.content, /没有确认到可以一起删除的部分/u);
  assert.match(assistant.content, /请直接说出那条内容/u);
  assert.equal(assistant.content.includes("一并删除了"), false);
});
test("POL-SEMOP-002c/006 forget 关系 uncertain 与网络失败均不删候选且不说更正", async (t) => {
  await t.test("uncertain", async (t2) => {
    const { ctx, aConversation } = await setupForgetPair(t2);
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");

    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    }, {
      verification: relationResponder((pairs) =>
        pairs.map((pair) => relationResult(pair, "uncertain"))),
    });
    assert.equal(result.verificationStatus, "pending");
    await awaitVerificationSettled(ctx, result);

    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    assert.equal(request.verificationStatus, "completed");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "阶段1本地删除保留");
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
    const assistant = lastAssistant(ctx, aConversation);
    assert.match(assistant.content, /没有确认到可以一起删除的部分/u);
    assert.match(assistant.content, /请直接说出那条内容/u);
    assert.equal(assistant.content.includes("一并删除了"), false);
    assert.equal(assistant.content.includes("更正"), false);
  });

  await t.test("network", async (t2) => {
    const { ctx, aConversation } = await setupForgetPair(t2);
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");

    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    }, {
      verification: ({ res }) => { res.destroy(); },
    });
    await waitFor(() => ctx.store.chat.getRequest({
      characterId: "a", requestId: result.requestId,
    }).verificationStatus !== "pending");

    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    assert.equal(request.verificationStatus, "failed");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "阶段1本地删除保留");
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
    const assistant = lastAssistant(ctx, aConversation);
    assert.match(assistant.content, /本地这次删除已完成/u);
    assert.equal(assistant.content.includes("一并删除了"), false);
    assert.equal(assistant.content.includes("更正"), false);
  });
});

test("POL-SEMOP-003a forget 阶段 1 提前返回，阶段 2 同一 assistant 原位更新", async (t) => {
  const { ctx, aConversation, bConversation } = await setupForgetPair(t);
  const assistantsBefore = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").length;
  const gate = gatedVerification(t);
  const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
  }, { verification: gate.responder });
  assert.equal(result.status, "completed");
  assert.equal(result.verificationStatus, "pending");
  assert.equal(result.assistantMessageId, lastAssistant(ctx, aConversation).id);
  assert.equal(ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant").length, assistantsBefore + 1);
  await gate.waitStarted();
  gate.release();
  await awaitVerificationSettled(ctx, result);
  const messages = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.filter((message) => message.role === "assistant");
  assert.equal(messages.length, assistantsBefore + 1);
  assert.equal(messages.at(-1).id, result.assistantMessageId);
  assert.match(messages.at(-1).content, /一并删除了/u);
});

test("POL-SEMOP-003b forget 阶段 1 前取消零写，阶段 1 后取消保留本地删除", async (t) => {
  await t.test("阶段 1 前取消", async (t2) => {
    const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
    const aOld = entryOf(ctx.store, "a", "pref.coffee");
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
    let release;
    let modelStarted = false;
    ctx.server.enqueue(() => {
      modelStarted = true;
      return new Promise((resolve) => { release = resolve; });
    });
    t2.after(() => release?.());
    const requestId = "forget-phase1-cancel";
    const pending = ctx.store.chat.sendMessage({
      characterId: "a", conversationId: aConversation.id,
      text: "请忘记我喜欢咖啡这件事。", requestId,
    });
    await waitFor(() => modelStarted);
    const cancelled = ctx.store.chat.cancelRequest({ characterId: "a", requestId });
    assert.equal(cancelled.cancelled, true);
    release();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, aOld.body);
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
    assert.equal(verificationRequests(ctx).length, 0);
  });

  await t.test("阶段 1 后取消", async (t2) => {
    const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
    const gate = gatedVerification(t2);
    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    }, { verification: gate.responder });
    assert.equal(result.verificationStatus, "pending");
    await gate.waitStarted();
    const cancelled = ctx.store.chat.cancelRequest({ characterId: "a", requestId: result.requestId });
    assert.equal(cancelled.verificationStatus, "cancelled");
    gate.release();
    await waitFor(() => {
      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      return request.verificationStatus === "cancelled";
    });
    assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
    const assistant = lastAssistant(ctx, aConversation);
    assert.match(assistant.content, /本地这次删除已完成/u);
    assert.equal(assistant.content.includes("更正"), false);
  });
});

test("POL-SEMOP-003c forget dispose/close/重启均不删候选并原位删除收口", async (t) => {
  for (const mode of ["dispose", "close", "restart"]) {
    await t.test(mode, async (t2) => {
      const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
      const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
      const gate = gatedVerification(t2);
      const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
        needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
      }, { verification: gate.responder });
      assert.equal(result.verificationStatus, "pending");
      await gate.waitStarted();
      const pendingAssistant = lastAssistant(ctx, aConversation);
      if (mode === "dispose") {
        await ctx.store.chat.dispose();
      } else if (mode === "close") {
        ctx.store.chat.closeConversation({ characterId: "a", conversationId: aConversation.id });
      } else {
        await ctx.store.chat.dispose();
        withDatabase(ctx.store.dbPath, (db) => {
          db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
            .run(pendingAssistant.content, result.assistantMessageId);
          db.prepare("UPDATE chat_requests SET verification_status = 'pending' WHERE id = ?")
            .run(result.requestId);
        });
        ctx.reopenWithRecover();
      }
      await awaitVerificationSettled(ctx, result);
      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      assert.equal(request.verificationStatus, mode === "restart" ? "interrupted" : "cancelled");
      assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
      assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
      const assistant = ctx.store.chat.getConversation({
        characterId: "a", conversationId: aConversation.id,
      }).messages.find((message) => message.id === result.assistantMessageId);
      assert.match(assistant.content, /本地这次删除已完成/u);
      assert.equal(assistant.content.includes("更正"), false);
    });
  }
});

test("POL-SEMOP-004b forget 自增控制不误拒候选，等待期间 B 权限变化则拒绝该候选", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const candidate = await seedSharedCoffeeCandidate(ctx, aConversation);
  const bMember = candidate.bEntry;
  const gate = gatedVerification(t);
  const result = await sendForget(ctx, aConversation, "只你忘记咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "只你忘记咖啡这件事",
  }, { verification: gate.responder });
  assert.equal(result.verificationStatus, "pending");
  await gate.waitStarted();
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at) VALUES (?, ?, ?)")
      .run("b", sha256(bMember.sourceId), ctx.nowMs());
  });
  gate.release();
  await awaitVerificationSettled(ctx, result);

  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "a", "pref.coffeeA2").body, candidate.aEntry.body);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeA2").body, bMember.body);
  const assistant = lastAssistant(ctx, aConversation);
  assert.equal(assistant.content.includes("一并删除了"), false);
});

test("POL-SEMOP-004c forget 第二候选删除故障：阶段 2 逐表全回滚，阶段 1 保留", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  await seedCoffeeA(ctx, aConversation);
  await seedCoffeeB(ctx, bConversation);
  await seedCoffeeC(ctx, cConversation);
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const cOld = entryOf(ctx.store, "c", "pref.coffeeC");
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec(`
      CREATE TRIGGER fail_second_forget
      BEFORE DELETE ON memory_entries
      WHEN OLD.id = '${cOld.id}'
      BEGIN SELECT RAISE(ABORT, 'fixture second forget fault'); END;
    `);
  });

  const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  const afterStage1 = memorySnapshot(ctx.store.dbPath);
  await waitFor(() => verificationRequests(ctx).length === 1 ||
    ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId }).verificationStatus !== "pending");
  assert.equal(verificationRequests(ctx).length, 1, "应发出一次候选核验");
  await awaitVerificationSettled(ctx, result);

  assert.deepEqual(memorySnapshot(ctx.store.dbPath), afterStage1, "阶段 2 删除必须逐表回滚");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeC").body, cOld.body);
  const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
  assert.equal(request.status, "completed");
  assert.equal(request.verificationStatus, "failed");
  const assistant = lastAssistant(ctx, aConversation);
  assert.match(assistant.content, /本地这次删除已完成/u);
  assert.equal(assistant.content.includes("一并删除了"), false);
});

test("POL-SEMOP-004a/007c forget 删除锚后旧消息被改或新 identity 重学，旧核验失效", async (t) => {
  for (const mode of ["message", "new-identity"]) {
    await t.test(mode, async (t2) => {
      const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
      const aOld = entryOf(ctx.store, "a", "pref.coffee");
      const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
      const aMessageId = aOld.sourceId.slice("chat:".length);
      const gate = gatedVerification(t2);
      const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
        needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
      }, { verification: gate.responder });
      assert.equal(result.verificationStatus, "pending");
      await gate.waitStarted();
      const stage1Context = ctx.store.memory.getContextVersion("a");
      if (mode === "message") {
        withDatabase(ctx.store.dbPath, (db) => {
          db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
            .run("被改掉的旧咖啡原话", aMessageId);
        });
      } else {
        const created = ctx.store.memory.remember({
          characterId: "a",
          factKey: "pref.coffee.new",
          body: aOld.body,
          kind: "preference",
          sourceId: "a-new-permission",
          explicitConsent: true,
        });
        assert.equal(created.created, true);
        assert.ok(ctx.store.memory.getContextVersion("a") > stage1Context);
        assert.notEqual(created.entry.factIdentityId, aOld.factIdentityId);
        const proof = JSON.parse(proofOf(ctx, result.requestId).operation_proof);
        assert.notEqual(created.entry.factIdentityId, proof.anchorIdentityId);
      }
      gate.release();
      await awaitVerificationSettled(ctx, result);

      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      assert.equal(request.verificationStatus, "stale");
      assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
      assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
      if (mode === "new-identity") {
        assert.equal(entryOf(ctx.store, "a", "pref.coffee.new").body, aOld.body);
      }
      assert.equal(lastAssistant(ctx, aConversation).content.includes("一并删除了"), false);
    });
  }
});

test("POL-SEMOP-006 forget 无候选 0 次核验且不写 proof；有候选最多一次；超时失败", { timeout: 60000 }, async (t) => {
  await t.test("无候选", async (t2) => {
    const ctx = await setupContext(t2);
    const aConversation = openConversation(ctx.store);
    await seedCoffeeA(ctx, aConversation);
    const budgetBefore = budgetSnapshot(ctx);
    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.verificationStatus, "none");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
    assert.equal(verificationRequests(ctx).length, 0);
    assert.equal(proofOf(ctx, result.requestId).operation_proof, null);
    assert.deepEqual(budgetSnapshot(ctx), budgetBefore);
    assert.deepEqual(budgetSnapshot(ctx).attempts, []);
  });

  await t.test("有候选一次", async (t2) => {
    const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
    const budgetBefore = budgetSnapshot(ctx);
    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    }, {
      verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
    });
    await awaitVerificationSettled(ctx, result);
    assert.equal(verificationRequests(ctx).length, 1);
    assert.deepEqual(budgetSnapshot(ctx), budgetBefore);
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB"), null);
  });

  await t.test("15s 超时", async (t2) => {
    const { ctx, aConversation, bConversation } = await setupForgetPair(t2);
    const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
    const budgetBefore = budgetSnapshot(ctx);
    const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
      needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
    }, {
      verification: () => new Promise(() => {}),
    });
    await waitFor(() => {
      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      return request.verificationStatus !== "pending";
    }, 20000);
    const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
    assert.equal(request.verificationStatus, "failed");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bOld.body);
    assert.deepEqual(budgetSnapshot(ctx), budgetBefore);
    assert.match(lastAssistant(ctx, aConversation).content, /本地这次删除已完成/u);
  });
});

test("POL-SEMOP-007a/b/c forget 删除后 FTS/旧来源/relay/share 不回流，明确新同意可新建", async (t) => {
  const ctx = await setupContext(t);
  seedRelationships(ctx.store.dbPath, ["d"]);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  await seedCoffeeB(ctx, bConversation);
  const aOld = entryOf(ctx.store, "a", "pref.coffee");
  const bOld = entryOf(ctx.store, "b", "pref.coffeeB");
  const cOldSource = "seed-d-coffee";
  const dEntry = ctx.store.memory.remember({
    characterId: "d",
    factKey: "pref.coffeeD",
    body: aOld.body,
    kind: aOld.kind,
    sourceId: cOldSource,
  }).entry;

  const result = await sendForget(ctx, aConversation, "请忘记我喜欢咖啡这件事。", {
    needle: "我喜欢咖啡", evidence: "请忘记我喜欢咖啡这件事",
  }, {
    verification: relationResponder((pairs) => pairs.map((pair) => relationResult(pair, "equivalent"))),
  });
  await awaitVerificationSettled(ctx, result);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB"), null);
  assert.deepEqual(ctx.store.memory.searchMemories({ characterId: "a", query: "咖啡" }), []);
  assert.deepEqual(ctx.store.memory.searchMemories({ characterId: "b", query: "咖啡" }), []);
  ctx.store.memory.rebuildSearchIndex();
  assert.deepEqual(ctx.store.memory.searchMemories({ characterId: "a", query: "咖啡" }), []);

  for (const [characterId, old] of [["a", aOld], ["b", bOld]]) {
    const reimport = ctx.store.memory.applyExtractionBatch({
      characterId,
      sourceId: old.sourceId,
      sourceVersion: 1,
      appliedAt: ctx.nowMs(),
      facts: [{ factKey: old.factKey, body: old.body, kind: old.kind }],
    });
    assert.equal(reimport.applied, false);
    assert.equal(reimport.reason, "blocked_source");
  }
  assert.throws(() => ctx.store.memory.relay({
    fromCharacterId: "d", toCharacterId: "a",
    entries: [{ entryId: dEntry.id, expectedVersion: dEntry.version }],
  }), (error) => error?.code === "SHARE_BLOCKED");
  assert.throws(() => ctx.store.memory.share({
    fromCharacterId: "d", toCharacterId: "a",
    entryIds: [dEntry.id],
  }), (error) => error?.code === "SHARE_BLOCKED");

  const controlText = withDatabase(ctx.store.dbPath, (db) => [
    "memory_source_controls",
    "memory_forget_identity_controls",
    "memory_deleted_fact_fingerprints",
    "memory_forget_controls",
  ].map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join("\n"));
  assert.equal(controlText.includes(aOld.body), false);
  assert.equal(controlText.includes(bOld.body), false);
  const proofText = proofOf(ctx, result.requestId).operation_proof;
  assert.equal(proofText.includes(aOld.body), false);
  assert.equal(proofText.includes(bOld.body), false);

  ctx.reopen();
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB"), null);
  const reimportAfterRestart = ctx.store.memory.applyExtractionBatch({
    characterId: "a",
    sourceId: aOld.sourceId,
    sourceVersion: 1,
    appliedAt: ctx.nowMs(),
    facts: [{ factKey: aOld.factKey, body: aOld.body, kind: aOld.kind }],
  });
  assert.equal(reimportAfterRestart.applied, false);

  const newSource = "a-new-permission";
  const blockedWithoutConsent = ctx.store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee.renewed",
    body: aOld.body,
    kind: aOld.kind,
    sourceId: newSource,
  });
  assert.equal(blockedWithoutConsent.created, false);
  assert.equal(blockedWithoutConsent.blocked, "forget");

  const reconsented = ctx.store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee.renewed",
    body: aOld.body,
    kind: aOld.kind,
    sourceId: newSource,
    explicitConsent: true,
  });
  assert.equal(reconsented.created, true);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee.renewed").body, aOld.body);
  assert.notEqual(reconsented.entry.factIdentityId, aOld.factIdentityId);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "旧 factKey 不因新来源复活");
  const oldSourceAgain = ctx.store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee.old",
    body: aOld.body,
    kind: aOld.kind,
    sourceId: aOld.sourceId,
    explicitConsent: true,
  });
  assert.equal(oldSourceAgain.created, false);
  assert.equal(oldSourceAgain.blocked, "source");
});

/* S03m 2c-1 临时理解：真实 chat / memory 管理入口 + 真实 SQLite。
   本组只构造聊天模型 HTTP；不启动 GUI、不调用真实模型。 */

function memoryState(ctx) {
  return withDatabase(ctx.store.dbPath, (db) => {
    const rows = (table, orderBy) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    const hasLinks = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_temporary_links'",
    ).get();
    return {
      entries: rows("memory_entries", "id"),
      identities: rows("memory_fact_identities", "identity_id"),
      derivations: rows("memory_derivations", "entry_id"),
      sourceControls: rows("memory_source_controls", "character_id, source_id_hash"),
      forgetControls: rows("memory_forget_identity_controls", "character_id, identity_id"),
      shareControls: rows("memory_share_identity_controls", "identity_id"),
      deletedFingerprints: rows("memory_deleted_fact_fingerprints", "character_id, fingerprint"),
      contextVersions: rows("memory_context_versions", "character_id"),
      links: hasLinks
        ? db.prepare("SELECT * FROM memory_temporary_links ORDER BY temp_identity_id, holder_character_id").all()
        : [],
    };
  });
}

test("POL-SEMOP-001d/S1a 只让A忘记今天的临时理解，不误杀B已同步副本", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });

  const aEntry = temporaryEntryOf(ctx.store, "a");
  const bEntry = temporaryEntryOf(ctx.store, "b");
  assert.ok(aEntry, "A 应有今日临时理解");
  assert.ok(bEntry, "已证明同一长期事实的B应同步今日理解");
  assert.equal(aEntry.factIdentityId, bEntry.factIdentityId);
  assert.equal(snapshotOf(ctx, "b", bEntry).status, "ok");

  ctx.store.memory.forget({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: aEntry.version,
    scope: "self",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  const bAfter = snapshotOf(ctx, "b", bEntry);
  assert.equal(bAfter.status, "ok");
  assert.equal(bAfter.holderCharacterId, "b");
  assert.equal(bAfter.holderAnchorEntryId, pair.bLong.id);
  assert.equal(bAfter.direct, false);
  assert.equal(bAfter.via, "temporary_propagation");
  assert.equal(bAfter.temporaryKind, "copy");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.ok(
    temporaryLinks(ctx).some((link) => link.temp_identity_id === aEntry.factIdentityId),
    "删除正文后仍应保留无正文关联控制",
  );
});

test("POL-SEMOP-001d/S1b 删除A自己的长期锚不使B的今日副本失效", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const bEntry = temporaryEntryOf(ctx.store, "b");
  assert.ok(bEntry, "已证明同一长期事实的B应持有今日副本");
  ctx.store.memory.forget({
    characterId: "a",
    entryId: pair.aLong.id,
    expectedVersion: pair.aLong.version,
    scope: "self",
  });
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  const snapshot = snapshotOf(ctx, "b", bEntry);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.holderAnchorEntryId, pair.bLong.id);
  assert.equal(snapshot.sourceAnchorStatus, "removed");
});

test("POL-SEMOP-001d/S2 全部忘记清空今日正文/派生但保留控制与长期事实", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aEntry = temporaryEntryOf(ctx.store, "a");
  const bEntry = temporaryEntryOf(ctx.store, "b");
  assert.ok(aEntry && bEntry, "A/B 应共有今日理解");
  const temporaryId = aEntry.factIdentityId;
  const tempIds = temporaryRows(ctx).map((row) => row.id);

  const result = ctx.store.memory.forget({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: aEntry.version,
    scope: "all",
  });
  assert.equal(result.deleted, 2);
  assert.equal(temporaryRows(ctx).length, 0);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  withDatabase(ctx.store.dbPath, (db) => {
    for (const entryId of tempIds) {
      assert.equal(db.prepare("SELECT 1 AS found FROM memory_fts WHERE entry_id = ?").get(entryId), undefined);
      assert.equal(db.prepare("SELECT 1 AS found FROM memory_derivations WHERE entry_id = ?").get(entryId), undefined);
    }
  });
  assert.ok(temporaryLinks(ctx).some((link) => link.temp_identity_id === temporaryId));
  assert.ok(
    temporaryLinks(ctx).some((link) => link.holder_character_id === "b"),
    "旧 link 仍需保留，供同锚重建查控制",
  );

  ctx.reopen();
  assert.equal(temporaryRows(ctx).length, 0);
  assert.ok(temporaryLinks(ctx).some((link) => link.temp_identity_id === temporaryId));
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S3 今日限制只阻止后续分享/转告并跨重启保留", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aEntry = temporaryEntryOf(ctx.store, "a");
  const bEntry = temporaryEntryOf(ctx.store, "b");
  assert.ok(aEntry && bEntry, "A/B 应共有今日理解");
  const temporaryId = aEntry.factIdentityId;
  ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: aEntry.version,
  });
  assert.ok(
    withDatabase(ctx.store.dbPath, (db) => db.prepare(
      "SELECT 1 AS found FROM memory_share_identity_controls WHERE identity_id = ?",
    ).get(temporaryId)),
  );
  assert.ok(temporaryEntryOf(ctx.store, "a"));
  assert.ok(temporaryEntryOf(ctx.store, "b"));

  const cConversation = openConversation(ctx.store, "c");
  const blocked = () => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: temporaryEntryOf(ctx.store, "a").id, expectedVersion: temporaryEntryOf(ctx.store, "a").version }],
  });
  assert.throws(blocked, (error) => error?.code === "SHARE_BLOCKED");
  const shareBlocked = () => ctx.store.memory.share({
    fromCharacterId: "a",
    toCharacterId: "c",
    entryIds: [temporaryEntryOf(ctx.store, "a").id],
  });
  assert.throws(shareBlocked, (error) => error?.code === "SHARE_BLOCKED");
  ctx.reopen();
  assert.throws(blocked, (error) => error?.code === "SHARE_BLOCKED");
  assert.throws(shareBlocked, (error) => error?.code === "SHARE_BLOCKED");
  assert.equal(temporaryEntryOf(ctx.store, "c"), null);
  assert.equal(cConversation.characterId, "c");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S4 只留当前角色持有今日理解，其他副本失效并留控制", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aBefore = temporaryEntryOf(ctx.store, "a");
  const bBefore = temporaryEntryOf(ctx.store, "b");
  assert.ok(aBefore && bBefore, "A/B 应共有今日理解");
  const temporaryId = aBefore.factIdentityId;
  const result = ctx.store.memory.keepExclusive({
    characterId: "a",
    entryId: aBefore.id,
    expectedVersion: aBefore.version,
  });
  assert.equal(result.cleared, 1);
  assert.deepEqual(result.clearedCharacters, ["b"]);
  const aAfter = temporaryEntryOf(ctx.store, "a");
  assert.equal(aAfter.version, aBefore.version + 1);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);
  withDatabase(ctx.store.dbPath, (db) => {
    assert.ok(db.prepare(
      "SELECT 1 AS found FROM memory_forget_identity_controls WHERE character_id = ? AND identity_id = ?",
    ).get("b", temporaryId));
  });
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S6 第二发起人复用B的T，不回填已自己删除的A", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aBefore = temporaryEntryOf(ctx.store, "a");
  const bBefore = temporaryEntryOf(ctx.store, "b");
  assert.ok(aBefore && bBefore, "A/B 应共有今日理解");
  const temporaryId = aBefore.factIdentityId;
  ctx.store.memory.forget({
    characterId: "a",
    entryId: aBefore.id,
    expectedVersion: aBefore.version,
    scope: "self",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);

  await tellToday(ctx, pair.bConversation, {
    characterId: "b",
    text: "不是茶，我今天想喝奶茶，请帮我改过来。",
    needle: "我今天想喝茶",
    excerpt: "我今天想喝奶茶",
    evidence: "请帮我改过来",
  });
  const bAfter = temporaryEntryOf(ctx.store, "b");
  assert.ok(bAfter);
  assert.equal(bAfter.factIdentityId, temporaryId, "应复用B已有的临时身份");
  assert.match(bAfter.sourceId, /^chat-current:/u);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null, "A 已自己删除，不应被重新回填");
  assert.equal(temporaryRows(ctx).length, 1);
});

test("POL-SEMOP-001d/S9 无关联角色和未知角色不因今日理解新增副本", async (t) => {
  const ctx = await setupContext(t);
  const relationshipsBefore = withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("SELECT character_id FROM relationships ORDER BY character_id").all()
      .map((row) => row.character_id));
  ctx.store.memory.remember({
    characterId: "c",
    factKey: "pref.cat",
    body: "用户喜欢猫",
    kind: "preference",
    sourceId: "seed-c-cat",
  });
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  assert.ok(temporaryEntryOf(ctx.store, "a"), "发起人应有今日理解");
  assert.ok(temporaryEntryOf(ctx.store, "b"), "同一长期事实的B应同步今日理解");
  assert.equal(temporaryEntryOf(ctx.store, "c"), null);
  const holders = new Set(temporaryLinks(ctx).map((link) => link.holder_character_id));
  assert.deepEqual([...holders].sort(), ["a", "b"]);
  assert.equal(entryOf(ctx.store, "c", "pref.cat").body, "用户喜欢猫");
  const relationshipsAfter = withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("SELECT character_id FROM relationships ORDER BY character_id").all()
      .map((row) => row.character_id));
  assert.deepEqual(relationshipsAfter, relationshipsBefore, "未知角色不应被创建");
});

function endOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function assertTemporaryLinkSchema(ctx) {
  const columns = withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("PRAGMA table_info(memory_temporary_links)").all().map((column) => column.name));
  for (const required of ["temp_identity_id", "long_identity_id", "holder_character_id", "expires_at"]) {
    assert.ok(columns.includes(required), `link 表应有 ${required}`);
  }
  for (const forbidden of ["body", "excerpt", "text", "content", "source_id"]) {
    assert.equal(columns.includes(forbidden), false, `link 表不得保存 ${forbidden}`);
  }
  const links = temporaryLinks(ctx);
  assert.ok(links.length > 0);
  assert.equal(JSON.stringify(links).includes("茶"), false);
  assert.equal(JSON.stringify(links).includes("咖啡"), false);
}

function linkOf(ctx, holder, longIdentityId, expiresAt) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT * FROM memory_temporary_links
    WHERE holder_character_id = ? AND long_identity_id = ? AND expires_at = ?
    ORDER BY temp_identity_id ASC
  `).all(holder, longIdentityId, expiresAt));
}

function assertOldSourceBlocked(ctx, holder, entry) {
  const replay = ctx.store.memory.remember({
    characterId: holder,
    factKey: `replay.${crypto.randomUUID()}`,
    body: entry.body,
    kind: "preference",
    trust: "stated",
    sourceId: entry.sourceId,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.blocked, "source");
}

async function seedPairTodayWithBCopy(ctx) {
  const pair = await seedSameFactPair(ctx);
  await tellToday(ctx, pair.aConversation, {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aEntry = temporaryEntryOf(ctx.store, "a");
  assert.ok(aEntry, "发起人应有今日理解");
  let bEntry = temporaryEntryOf(ctx.store, "b");
  if (!bEntry) {
    ctx.store.memory.relay({
      fromCharacterId: "a",
      toCharacterId: "b",
      entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
    });
    bEntry = temporaryEntryOf(ctx.store, "b", { includeLegacy: true });
  }
  assert.ok(bEntry, "B 应有今日副本");
  return { pair, aEntry, bEntry };
}

async function restateEquivalentTea(ctx, pair) {
  await tellToday(ctx, pair.aConversation, {
    text: "不是茶，我今天还是想喝茶，请帮我改过来。",
    needle: "我喜欢咖啡",
    excerpt: "我今天还是想喝茶",
    evidence: "请帮我改过来",
  });
}

async function changeTodayOption(ctx, pair) {
  const current = temporaryEntryOf(ctx.store, "a");
  assert.ok(current, "改口前应有今日理解");
  await tellToday(ctx, pair.aConversation, {
    text: "不是茶，我今天想喝咖啡，请帮我改过来。",
    needle: current.body,
    excerpt: "我今天想喝咖啡",
    evidence: "请帮我改过来",
  });
}

test("POL-SEMOP-001d/S11-forget 只让B忘记后，同锚重建仍不解除B的旧forget", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedPairTodayWithBCopy(ctx);
  const oldTemporaryId = seeded.aEntry.factIdentityId;
  const bOldSource = seeded.bEntry.sourceId;
  const bOldBody = seeded.bEntry.body;
  const expiresAt = seeded.aEntry.expiresAt;

  ctx.store.memory.forget({
    characterId: "b",
    entryId: seeded.bEntry.id,
    expectedVersion: seeded.bEntry.version,
    scope: "self",
  });
  ctx.store.memory.forget({
    characterId: "a",
    entryId: seeded.aEntry.id,
    expectedVersion: seeded.aEntry.version,
    scope: "self",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);

  await restateEquivalentTea(ctx, seeded.pair);
  const aNew = temporaryEntryOf(ctx.store, "a");
  assert.ok(aNew, "发起人的明确重新告知应建立新的今日理解");
  assert.notEqual(aNew.factIdentityId, oldTemporaryId);
  assert.equal(aNew.expiresAt, expiresAt);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null, "B 的旧 forget 不应被新 T 解除");
  const bControl = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT 1 AS found FROM memory_forget_identity_controls WHERE character_id = 'b' AND identity_id = ?",
  ).get(aNew.factIdentityId));
  assert.ok(bControl, "新 T 应保留 B 的无正文 forget 控制");

  const relayToB = () => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: temporaryEntryOf(ctx.store, "a").id, expectedVersion: temporaryEntryOf(ctx.store, "a").version }],
  });
  assert.throws(relayToB, (error) => error?.code === "SHARE_BLOCKED");
  assertOldSourceBlocked(ctx, "b", { body: bOldBody, sourceId: bOldSource });
  assertTemporaryLinkSchema(ctx);
  assert.ok(linkOf(ctx, "a", seeded.pair.aLong.factIdentityId, expiresAt).length > 0);

  ctx.reopen();
  assert.throws(relayToB, (error) => error?.code === "SHARE_BLOCKED");
  assert.ok(temporaryEntryOf(ctx.store, "a"));
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);

  // 不同今日选项仍属同一有效时段：复用 T、保留到期与控制，不改长期。
  await changeTodayOption(ctx, seeded.pair);
  const changed = temporaryEntryOf(ctx.store, "a");
  assert.equal(changed.factIdentityId, aNew.factIdentityId);
  assert.equal(changed.expiresAt, expiresAt);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);
  assert.throws(relayToB, (error) => error?.code === "SHARE_BLOCKED");
});

test("POL-SEMOP-001d/S11-restrict 只禁分享后，同锚重建仍阻止向无forget的C转告", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedPairTodayWithBCopy(ctx);
  const oldTemporaryId = seeded.aEntry.factIdentityId;
  const oldSource = seeded.aEntry.sourceId;
  const oldBody = seeded.aEntry.body;

  ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: seeded.aEntry.id,
    expectedVersion: seeded.aEntry.version,
  });
  ctx.store.memory.forget({
    characterId: "a",
    entryId: temporaryEntryOf(ctx.store, "a").id,
    expectedVersion: temporaryEntryOf(ctx.store, "a").version,
    scope: "all",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);

  await restateEquivalentTea(ctx, seeded.pair);
  const aNew = temporaryEntryOf(ctx.store, "a");
  assert.ok(aNew);
  assert.notEqual(aNew.factIdentityId, oldTemporaryId);
  const shareControl = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT 1 AS found FROM memory_share_identity_controls WHERE identity_id = ?",
  ).get(aNew.factIdentityId));
  assert.ok(shareControl, "新 T 应继承旧 share 控制");

  const relayToC = () => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: temporaryEntryOf(ctx.store, "a").id, expectedVersion: temporaryEntryOf(ctx.store, "a").version }],
  });
  const shareToC = () => ctx.store.memory.share({
    fromCharacterId: "a",
    toCharacterId: "c",
    entryIds: [temporaryEntryOf(ctx.store, "a").id],
  });
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.throws(shareToC, (error) => error?.code === "SHARE_BLOCKED");
  assertOldSourceBlocked(ctx, "a", { body: oldBody, sourceId: oldSource });
  assertTemporaryLinkSchema(ctx);

  ctx.reopen();
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.throws(shareToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.ok(temporaryEntryOf(ctx.store, "a"));

  await changeTodayOption(ctx, seeded.pair);
  const changed = temporaryEntryOf(ctx.store, "a");
  assert.equal(changed.factIdentityId, aNew.factIdentityId);
  assert.equal(changed.expiresAt, aNew.expiresAt);
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S11-exclusive 独占后同锚重建仍保留无正文分享控制", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedPairTodayWithBCopy(ctx);
  const bOldSource = seeded.bEntry.sourceId;
  const bOldBody = seeded.bEntry.body;
  const exclusive = ctx.store.memory.keepExclusive({
    characterId: "a",
    entryId: seeded.aEntry.id,
    expectedVersion: seeded.aEntry.version,
  });
  assert.equal(exclusive.cleared, 1);
  assert.deepEqual(exclusive.clearedCharacters, ["b"]);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);
  const aRetained = temporaryEntryOf(ctx.store, "a");
  assert.equal(aRetained.version, seeded.aEntry.version + 1);

  ctx.store.memory.forget({
    characterId: "a",
    entryId: aRetained.id,
    expectedVersion: aRetained.version,
    scope: "self",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);

  await restateEquivalentTea(ctx, seeded.pair);
  const aNew = temporaryEntryOf(ctx.store, "a");
  assert.ok(aNew);
  assert.notEqual(aNew.factIdentityId, seeded.aEntry.factIdentityId);
  const shareControl = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT 1 AS found FROM memory_share_identity_controls WHERE identity_id = ?",
  ).get(aNew.factIdentityId));
  assert.ok(shareControl, "新 T 应继承独占产生的 share 控制");
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);

  const relayToC = () => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: temporaryEntryOf(ctx.store, "a").id, expectedVersion: temporaryEntryOf(ctx.store, "a").version }],
  });
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assertOldSourceBlocked(ctx, "b", { body: bOldBody, sourceId: bOldSource });
  assertTemporaryLinkSchema(ctx);

  ctx.reopen();
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.ok(temporaryEntryOf(ctx.store, "a"));
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);

  await changeTodayOption(ctx, seeded.pair);
  const changed = temporaryEntryOf(ctx.store, "a");
  assert.equal(changed.factIdentityId, aNew.factIdentityId);
  assert.equal(changed.expiresAt, aNew.expiresAt);
  assert.throws(relayToC, (error) => error?.code === "SHARE_BLOCKED");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S11 旧库升级建link表，link写入失败整笔回滚", async (t) => {
  const ctx = await setupContext(t);
  ctx.store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const conversation = openConversation(ctx.store);
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TABLE IF EXISTS memory_temporary_links"));
  ctx.reopen();
  const hasLinks = withDatabase(ctx.store.dbPath, (db) =>
    Boolean(db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_temporary_links'",
    ).get()));
  assert.equal(hasLinks, true, "旧库重开应补建无正文 link 表");

  const before = memoryState(ctx);
  if (hasLinks) {
    withDatabase(ctx.store.dbPath, (db) => db.exec(`
      CREATE TRIGGER fail_temporary_link
      BEFORE INSERT ON memory_temporary_links
      BEGIN
        SELECT RAISE(ABORT, 'temporary link failure');
      END
    `));
  }
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢咖啡"),
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      },
    }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    requestId: "s11-link-rollback",
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(memoryState(ctx), before, "link 写入失败时记忆/身份/控制/上下文应整笔回滚");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, aLong.version);
});

async function sendPlainUserMessage(ctx, conversation, text, characterId) {
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "嗯。", memoryCandidates: [], memoryOperation: null, memoryRelay: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId,
    conversationId: conversation.id,
    text,
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result.userMessageId;
}

/* S12 的冲突存量必须本身合法：每个 current 都由该 holder 自己的真实聊天消息
   作为 direct 来源，正文是该消息的连续片段，到期时间有效，并明确 link 到
   A 的同一长期 identity。A 的 link 行代表其此前 self 删除后保留的无正文控制，
   不携带正文；两个 T 由此成为无法唯一确定的合法今日理解。 */
test("POL-SEMOP-001d/S12 多个合法T无法唯一证明时最小澄清且零写", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const bConversation = openConversation(ctx.store, "b");
  const cConversation = openConversation(ctx.store, "c");
  for (const [from, to] of [["a", "b"], ["a", "c"]]) {
    const source = entryOf(ctx.store, from, "pref.coffee");
    ctx.store.memory.relay({
      fromCharacterId: from,
      toCharacterId: to,
      entries: [{ entryId: source.id, expectedVersion: source.version }],
    });
  }
  const bLong = entryOf(ctx.store, "b", "pref.coffee");
  const cLong = entryOf(ctx.store, "c", "pref.coffee");
  assert.equal(bLong.factIdentityId, aLong.factIdentityId);
  assert.equal(cLong.factIdentityId, aLong.factIdentityId);

  const bMessageId = await sendPlainUserMessage(ctx, bConversation, "我今天想喝普洱。", "b");
  const cMessageId = await sendPlainUserMessage(ctx, cConversation, "我今天想喝白茶。", "c");
  const expiresAt = endOfLocalDay(ctx.nowMs());
  const groups = [
    { holder: "b", longEntry: bLong, messageId: bMessageId, body: "我今天想喝普洱" },
    { holder: "c", longEntry: cLong, messageId: cMessageId, body: "我今天想喝白茶" },
  ];
  const firstTemporaryId = crypto.randomUUID();
  const secondTemporaryId = crypto.randomUUID();
  withDatabase(ctx.store.dbPath, (db) => {
    const hasLinks = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_temporary_links'",
    ).get();
    for (const [index, group] of groups.entries()) {
      const temporaryId = index === 0 ? firstTemporaryId : secondTemporaryId;
      db.prepare("INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)")
        .run(temporaryId, ctx.nowMs());
      db.prepare(`
        INSERT INTO memory_entries (
          id, character_id, fact_key, fact_identity_id, origin_character_id,
          derived_from_entry_id, kind, body, trust, source_kind, importance,
          expires_at, source_id, source_version, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'preference', ?, 'stated', 'user', 60, ?, ?, 1, 1, ?, ?)
      `).run(
        crypto.randomUUID(),
        group.holder,
        `${group.longEntry.factKey}.current.${group.longEntry.id}`,
        temporaryId,
        group.holder,
        group.body,
        expiresAt,
        `chat-current:${group.longEntry.id}:${ctx.nowMs()}:chat:${group.messageId}`,
        ctx.nowMs(),
        ctx.nowMs(),
      );
      if (hasLinks) {
        db.prepare(`
          INSERT INTO memory_temporary_links
            (temp_identity_id, long_identity_id, holder_character_id, expires_at)
          VALUES (?, ?, ?, ?), (?, ?, 'a', ?)
        `).run(
          temporaryId, aLong.factIdentityId, group.holder, expiresAt,
          temporaryId, aLong.factIdentityId, expiresAt,
        );
      }
    }
  });

  const before = memoryState(ctx);
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "我喜欢咖啡"),
        excerpt: "我今天想喝花茶",
        evidence: "请帮我改过来",
      },
    }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: aConversation.id,
    text: "不是咖啡，我今天想喝花茶，请帮我改过来。",
    requestId: "s12-ambiguous",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /哪一条|还没法确定关联/u);
  assert.deepEqual(memoryState(ctx), before, "歧义时不应写入任何记忆/身份/控制/上下文");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});


/* S03m 2c-2b 测试先行（r2）：临时当日理解进入真实 chat 阶段 2。
   所有长期候选都经真实 chat/chat source 创建，并用现有 captureCandidates 只读
   预检；聊天与关系模型均为本机构造 HTTP。阶段 2 未实现时，首个 pending 业务
   断言失败；其后的深层分支未到达，不记为已证明。 */
function candidateProbe(ctx) {
  return createChatMemoryVerification({
    memory: ctx.store.memory,
    memorySourceContext: ctx.store.memorySourceContext,
    requestChatCompletion: async () => {
      throw new Error("预检不发起网络请求");
    },
    now: ctx.nowMs,
  });
}

function captureRealCandidates(
  ctx, targetEntry, holders = ["a", "b", "c"], characterId = "a", options = {},
) {
  return candidateProbe(ctx).captureCandidates({
    characterId,
    holderCharacterIds: holders,
    targetEntry,
    nowMs: ctx.nowMs(),
    ...options,
  });
}

async function correctLongNonToday(ctx, conversation, { text, needle, excerpt, evidence }) {
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, correctionEnvelope(body, { needle, excerpt, evidence })));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text,
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  assert.notEqual(result.verificationStatus, "pending");
  return result;
}

async function rememberLongViaChat(ctx, characterId, factKey, body, text) {
  const conversation = openConversation(ctx.store, characterId);
  await chatTurn(ctx, conversation, text, [
    { factKey, body, kind: "preference", trust: "stated", evidence: text },
  ], characterId);
  const entry = entryOf(ctx.store, characterId, factKey);
  assert.ok(entry, `chat 长期夹具 ${factKey} 应存在`);
  const source = snapshotOf(ctx, characterId, entry);
  assert.equal(source.status, "ok", `${factKey} 来源必须可解析`);
  // 旧 direct 形状没有 direct 字段；direct=false 才表示传播副本。
  assert.notEqual(source.direct, false, `${factKey} 不能是传播副本`);
  assert.equal(source.format, undefined, `${factKey} 必须保持旧 direct 形状`);
  assert.match(entry.sourceId, /^chat:/u, `${factKey} 必须使用真实 chat 来源`);
  return entry;
}

async function seedAWithIndependentB(ctx) {
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const bLong = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡。",
  );
  return { aConversation, aLong, bLong };
}

function temporaryEntriesOf(ctx, characterId, tempIdentityId) {
  return ctx.store.memory.listMemories(characterId).filter((entry) =>
    entry.expiresAt !== null && entry.factIdentityId === tempIdentityId);
}

function entryLinkOf(ctx, entryId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT entry_id, temp_identity_id, holder_character_id, expires_at,
           long_identity_id, root_identity_id
    FROM memory_temporary_entry_links WHERE entry_id = ?
  `).get(entryId) ?? null);
}

function temporaryEntryLinksOf(ctx, tempIdentityId, holderCharacterId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT * FROM memory_temporary_entry_links
    WHERE temp_identity_id = ? AND holder_character_id = ?
    ORDER BY entry_id ASC
  `).all(tempIdentityId, holderCharacterId));
}

function fullTemporarySnapshot(ctx) {
  return withDatabase(ctx.store.dbPath, (db) => {
    const rows = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      entries: rows("memory_entries"),
      identities: rows("memory_fact_identities"),
      derivations: rows("memory_derivations"),
      fts: rows("memory_fts"),
      relations: rows("memory_fact_relation_edges"),
      aliases: rows("memory_fact_aliases"),
      aliasConflicts: rows("memory_fact_alias_conflicts"),
      sourceControls: rows("memory_source_controls"),
      identityForgetControls: rows("memory_forget_identity_controls"),
      identityShareControls: rows("memory_share_identity_controls"),
      deletedFingerprints: rows("memory_deleted_fact_fingerprints"),
      legacyForgetControls: rows("memory_forget_controls"),
      legacyShareControls: rows("memory_share_controls"),
      contextVersions: rows("memory_context_versions"),
      temporaryLinks: rows("memory_temporary_links"),
      temporaryEntryLinks: rows("memory_temporary_entry_links"),
    };
  });
}

function assistantMessages(ctx, conversation, characterId = "a") {
  return ctx.store.chat.getConversation({
    characterId,
    conversationId: conversation.id,
  }).messages.filter((message) => message.role === "assistant");
}

function assistantState(ctx, conversation, characterId = "a") {
  const list = ctx.store.chat.getConversation({
    characterId,
    conversationId: conversation.id,
  }).messages.filter((message) => message.role === "assistant");
  return { count: list.length, lastId: list.at(-1)?.id ?? null };
}

function quoteForSide(side) {
  const sources = [side.text];
  const context = side.sourceContext;
  if (context) {
    if (typeof context.utterance === "string") sources.push(context.utterance);
    for (const segment of context.segments ?? []) sources.push(segment);
    for (const message of context.context ?? []) sources.push(message.content);
  }
  const hit = sources.find((text) =>
    typeof text === "string" && (text.includes("用户") || text.includes("我")));
  assert.ok(hit, "关系夹具必须含可引用的主体原文");
  return hit.includes("用户") ? "用户" : "我";
}

/* 关系响应必须使用双方实际原文片段；不能固定“我”。 */
function equivalentResultForPair(pair) {
  const description = (side) => {
    const subjectQuote = quoteForSide(side);
    return {
      subject: "用户",
      subjectQuote,
      scope: "current",
      time: null,
      timeQuote: null,
    };
  };
  return {
    pair: pair.id,
    relation: "equivalent",
    left: description(pair.left),
    right: description(pair.right),
  };
}

const equivalentResponder = () =>
  relationResponder((pairs) => pairs.map(equivalentResultForPair));

async function sendTodayWithVerification(
  ctx, conversation, characterId, { text, needle, excerpt, evidence }, verification,
) {
  ctx.server.enqueue(({ body, res }) =>
    sendEnvelope(res, correctionEnvelope(body, { needle, excerpt, evidence })));
  if (verification) ctx.server.enqueue(verification);
  return ctx.store.chat.sendMessage({
    characterId,
    conversationId: conversation.id,
    text,
    requestId: crypto.randomUUID(),
  });
}

async function awaitVerificationSettled(ctx, result, characterId = "a") {
  await waitFor(() => verificationRequests(ctx).length >= 1, 5000);
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({
      characterId,
      requestId: result.requestId,
    });
    return request.verificationStatus !== "pending";
  }, 5000);
  return ctx.store.chat.getRequest({ characterId, requestId: result.requestId });
}

function assertAssistantAdvanced(before, after, result) {
  assert.equal(typeof result.assistantMessageId, "string", "请求结果必须返回 assistantMessageId");
  assert.ok(result.assistantMessageId);
  assert.equal(after.count, before.count + 1, "本次请求只新增一条 assistant");
  assert.equal(after.lastId, result.assistantMessageId, "原位更新同一个 assistant");
}

test("POL-SEMOP/D1 临时阶段2：B独立旧事实核验后建同T current，长期不合并", async (t) => {
  const ctx = await setupContext(t);
  const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
  assert.notEqual(bLong.factIdentityId, aLong.factIdentityId);
  const precheck = captureRealCandidates(ctx, aLong);
  assert.deepEqual(
    precheck.candidates.map((candidate) => candidate.identityId),
    [bLong.factIdentityId],
    "真实 captureCandidates 必须能捕获B独立候选",
  );
  const assistantBefore = assistantState(ctx, aConversation);

  const result = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(result.status, "completed");
  assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
  assertAssistantAdvanced(assistantBefore, assistantState(ctx, aConversation), result);
  const aTemp = temporaryEntryOf(ctx.store, "a");
  assert.ok(aTemp);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null, "阶段1不应猜B的独立长期");

  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  assert.equal(verificationRequests(ctx).length, 1, "一次关系核验");
  const pair = pairsOf(verificationRequests(ctx)[0])[0];
  assert.equal(pair.left.text, aLong.body, "left 必须是A旧长期，不是今日 body");
  assert.equal(pair.left.text.includes("我今天想喝茶"), false);
  assert.equal(pair.right.text, bLong.body);
  assert.equal(pair.left.holder, "a");
  assert.equal(pair.right.holder, "b");

  const bTemp = temporaryEntryOf(ctx.store, "b");
  assert.ok(bTemp, "核验通过后B应有同一当日理解");
  assert.equal(bTemp.factIdentityId, aTemp.factIdentityId);
  assert.equal(bTemp.body, aTemp.body);
  const bLink = entryLinkOf(ctx, bTemp.id);
  assert.equal(bLink.long_identity_id, bLong.factIdentityId);
  assert.equal(bLink.root_identity_id, entryLinkOf(ctx, aTemp.id).long_identity_id);
  assert.equal(snapshotOf(ctx, "b", bTemp).status, "ok");
  const bLongAfter = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bLongAfter.factIdentityId, bLong.factIdentityId);
  assert.equal(bLongAfter.body, bLong.body);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, aLong.body);
  assert.equal(temporaryEntryOf(ctx.store, "c"), null);
  const assistantAfter = assistantState(ctx, aConversation);
  assertAssistantAdvanced(assistantBefore, assistantAfter, result);
  const last = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.find((message) => message.id === result.assistantMessageId);
  assert.equal(last.content.includes("正在核对"), false);
  assert.match(last.content, /一并更正/u);
});

async function seedBMultiL(ctx) {
  const l2a = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡。",
  );
  const l2b = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB.anchor2", "用户也爱喝咖啡", "我也爱喝咖啡。",
  );
  ctx.store.memory.associateFacts({
    left: { entryId: l2a.id, expectedVersion: l2a.version },
    right: { entryId: l2b.id, expectedVersion: l2b.version },
  });
  const l3 = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB3", "用户偏爱咖啡", "我偏爱咖啡。",
  );
  const l2 = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(l2.factIdentityId, entryOf(ctx.store, "b", "pref.coffeeB.anchor2").factIdentityId);
  assert.notEqual(l3.factIdentityId, l2.factIdentityId);
  return { l2, l3 };
}

test("POL-SEMOP/D2+D10 临时阶段2：多holder/已触碰B/同L双锚/不同L不重复", async (t) => {
  const ctx = await setupContext(t);
  const pair = await seedSameFactPair(ctx);
  const prepared = await seedBMultiL(ctx);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  // 预检在 relay 之前完成，确认真实候选集合；relay 后再验证阶段2覆盖同L的C。
  const precheck = captureRealCandidates(ctx, aLong, ["a", "b", "c"]);
  const preIdentityIds = new Set(precheck.candidates.map((candidate) => candidate.identityId));
  assert.deepEqual(preIdentityIds, new Set([prepared.l2.factIdentityId, prepared.l3.factIdentityId]));
  const l2Now = entryOf(ctx.store, "b", "pref.coffeeB");
  ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: l2Now.id, expectedVersion: l2Now.version }],
  });
  const cLong = entryOf(ctx.store, "c", "pref.coffeeB");
  assert.equal(cLong.factIdentityId, prepared.l2.factIdentityId);
  const assistantBefore = assistantState(ctx, pair.aConversation);

  const result = await sendTodayWithVerification(ctx, pair.aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
  assertAssistantAdvanced(assistantBefore, assistantState(ctx, pair.aConversation), result);
  const aTemp = temporaryEntryOf(ctx.store, "a");
  const bStage1 = temporaryEntryOf(ctx.store, "b");
  assert.ok(aTemp && bStage1, "阶段1已同步B的同一L");
  const tempIdentityId = aTemp.factIdentityId;

  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  assert.equal(verificationRequests(ctx).length, 1);
  const pairs = pairsOf(verificationRequests(ctx)[0]);
  assert.equal(pairs.length, 2, "B的两个独立identity各一个候选");
  assert.ok(pairs.every((item) => item.left.text === aLong.body));
  assert.ok(pairs.every((item) => typeof item.right.holder === "string"));

  const bEntries = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(bEntries.length, 3, "阶段1的L1 + 阶段2的L2/L3，各一条");
  const links = temporaryEntryLinksOf(ctx, tempIdentityId, "b");
  assert.equal(new Set(links.map((link) => link.long_identity_id)).size, 3);
  assert.equal(
    links.filter((link) => link.long_identity_id === prepared.l2.factIdentityId).length,
    1,
    "同L双锚只建一条 current",
  );
  assert.equal(
    links.filter((link) => link.long_identity_id === prepared.l3.factIdentityId).length,
    1,
  );
  const cEntries = temporaryEntriesOf(ctx, "c", tempIdentityId);
  assert.equal(cEntries.length, 1, "同L的C也必须获得current");
  assert.equal(entryLinkOf(ctx, cEntries[0].id).long_identity_id, prepared.l2.factIdentityId);
  assert.equal(entryLinkOf(ctx, cEntries[0].id).root_identity_id, entryLinkOf(ctx, aTemp.id).long_identity_id);
  for (const entry of [...bEntries, ...cEntries]) {
    assert.equal(entry.body, aTemp.body);
    assert.equal(snapshotOf(ctx, entry.characterId, entry).status, "ok");
  }
  // 长期 identity/正文不变。
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, prepared.l2.body);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB3").body, prepared.l3.body);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeB").body, cLong.body);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").factIdentityId, prepared.l2.factIdentityId);
  assertAssistantAdvanced(assistantBefore, assistantState(ctx, pair.aConversation), result);
});

async function seedD3(ctx) {
  const pair = await seedSameFactPair(ctx);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const bL2 = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡。",
  );
  const precheck = captureRealCandidates(ctx, aLong);
  assert.deepEqual(
    precheck.candidates.map((candidate) => candidate.identityId),
    [bL2.factIdentityId],
  );
  return { pair, aLong, bL2, bConversation: pair.bConversation };
}

test("POL-SEMOP/D3 临时阶段2：已触碰B额外context变化stale，无变化对照完成", async (t) => {
  await t.test("extra-context-stale", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedD3(ctx);
    const gate = gatedVerification(t2);
    const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      needle: seeded.aLong.body,
      excerpt: "我今天想喝茶",
      evidence: "请帮我改过来",
    }, gate.responder);
    assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
    const aTemp = temporaryEntryOf(ctx.store, "a");
    const bStage1 = temporaryEntryOf(ctx.store, "b");
    assert.ok(aTemp && bStage1, "B必须是阶段1已触碰成员");
    await gate.waitStarted();
    ctx.store.memory.remember({
      characterId: "b",
      factKey: "pref.walk",
      body: "用户喜欢散步",
      kind: "preference",
      sourceId: "seed-b-walk",
    });
    gate.release();
    const finished = await awaitVerificationSettled(ctx, result);
    assert.equal(finished.verificationStatus, "stale");
    assert.equal(temporaryEntriesOf(ctx, "b", aTemp.factIdentityId).length, 1,
      "阶段2不得为B的独立L写current");
    assert.equal(temporaryEntryOf(ctx.store, "b").body, aTemp.body, "阶段1的B副本保留");
    assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, seeded.bL2.body);
  });
  await t.test("no-extra-change-control", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedD3(ctx);
    const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      needle: seeded.aLong.body,
      excerpt: "我今天想喝茶",
      evidence: "请帮我改过来",
    }, equivalentResponder());
    assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
    const finished = await awaitVerificationSettled(ctx, result);
    assert.equal(finished.verificationStatus, "completed");
    const bEntries = temporaryEntriesOf(ctx, "b", temporaryEntryOf(ctx.store, "a").factIdentityId);
    assert.equal(bEntries.length, 2, "阶段1 L1 + 阶段2 L2");
    assert.ok(bEntries.some((entry) =>
      entryLinkOf(ctx, entry.id).long_identity_id === seeded.bL2.factIdentityId));
  });
});

test("POL-SEMOP/D4 临时阶段2：第二候选写失败全回滚，阶段1保留", async (t) => {
  const ctx = await setupContext(t);
  const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
  const cLong = await rememberLongViaChat(
    ctx, "c", "pref.coffeeC", "用户偏爱咖啡", "我偏爱咖啡。",
  );
  const precheck = captureRealCandidates(ctx, aLong);
  assert.deepEqual(
    new Set(precheck.candidates.map((candidate) => candidate.identityId)),
    new Set([bLong.factIdentityId, cLong.factIdentityId]),
  );
  let triggerHits = 0;
  ctx.store.db.function("fixture_mark_stage2_trigger", () => {
    triggerHits += 1;
    return 0;
  });
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec(`
      CREATE TRIGGER fail_stage2_second_candidate
      BEFORE INSERT ON memory_entries
      WHEN NEW.character_id = 'c' AND NEW.expires_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM memory_entries b
          WHERE b.character_id = 'b'
            AND b.fact_identity_id = NEW.fact_identity_id
            AND b.expires_at IS NOT NULL
        )
      BEGIN
        SELECT fixture_mark_stage2_trigger();
        SELECT RAISE(ABORT, 'fixture temporary stage2 second candidate');
      END;
    `);
  });
  const gate = gatedVerification(t);
  const assistantBefore = assistantState(ctx, aConversation);
  const result = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, gate.responder);
  assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
  assertAssistantAdvanced(assistantBefore, assistantState(ctx, aConversation), result);
  const aTemp = temporaryEntryOf(ctx.store, "a");
  assert.ok(aTemp);
  const afterStage1 = fullTemporarySnapshot(ctx);
  await gate.waitStarted(); // 关系请求已发出但未响应，阶段1状态已捕获
  gate.release();
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "failed");
  assert.deepEqual(fullTemporarySnapshot(ctx), afterStage1, "阶段2必须整笔回滚");
  assert.ok(temporaryEntryOf(ctx.store, "a"), "阶段1的A current必须保留");
  assert.equal(temporaryEntryOf(ctx.store, "b"), null, "B阶段2 current回滚");
  assert.equal(temporaryEntryOf(ctx.store, "c"), null, "C阶段2 current回滚");
  assert.equal(triggerHits, 1, "第二候选 trigger 必须实际命中");
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bLong.body);
  assert.equal(entryOf(ctx.store, "c", "pref.coffeeC").body, cLong.body);
  const assistantAfter = assistantState(ctx, aConversation);
  assertAssistantAdvanced(assistantBefore, assistantAfter, result);
  const last = ctx.store.chat.getConversation({
    characterId: "a", conversationId: aConversation.id,
  }).messages.find((message) => message.id === result.assistantMessageId);
  assert.match(last.content, /本地这次更正已完成/u);
});

test("POL-SEMOP/003b/003c temporary 取消/关闭/dispose/重启均保留阶段1且不传播", async (t) => {
  for (const mode of ["cancel", "close", "dispose", "restart"]) {
    await t.test(mode, async (t2) => {
      const ctx = await setupContext(t2);
      const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
      const gate = gatedVerification(t2);
      const result = await sendTodayWithVerification(ctx, aConversation, "a", {
        text: "不是咖啡，我今天想喝茶，请帮我改过来。",
        needle: aLong.body,
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      }, gate.responder);
      assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
      const aTemp = temporaryEntryOf(ctx.store, "a");
      assert.ok(aTemp);
      assert.equal(temporaryEntryOf(ctx.store, "b"), null);
      await gate.waitStarted();
      const pendingAssistant = lastAssistant(ctx, aConversation);

      if (mode === "cancel") {
        const cancelled = ctx.store.chat.cancelRequest({
          characterId: "a", requestId: result.requestId,
        });
        assert.equal(cancelled.verificationStatus, "cancelled");
      } else if (mode === "close") {
        ctx.store.chat.closeConversation({
          characterId: "a", conversationId: aConversation.id,
        });
      } else if (mode === "dispose") {
        await ctx.store.chat.dispose();
      } else {
        // 先正常收尾，再把核验恢复为 pending，模拟进程异常退出遗留状态。
        await ctx.store.chat.dispose();
        withDatabase(ctx.store.dbPath, (db) => {
          db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
            .run(pendingAssistant.content, result.assistantMessageId);
          db.prepare("UPDATE chat_requests SET verification_status = 'pending' WHERE id = ?")
            .run(result.requestId);
        });
        ctx.reopenWithRecover();
      }

      if (mode === "cancel" || mode === "close") {
        gate.release();
      }
      await awaitVerificationSettled(ctx, result);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const request = ctx.store.chat.getRequest({ characterId: "a", requestId: result.requestId });
      assert.equal(
        request.verificationStatus,
        mode === "restart" ? "interrupted" : "cancelled",
      );
      const aAfter = temporaryEntryOf(ctx.store, "a");
      assert.equal(aAfter.id, aTemp.id, "阶段1的A当日理解必须保留");
      assert.equal(aAfter.body, aTemp.body);
      assert.equal(aAfter.version, aTemp.version);
      assert.equal(temporaryEntryOf(ctx.store, "b"), null, "不得向B传播");
      assert.equal(temporaryEntryOf(ctx.store, "c"), null);
      assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, aLong.body);
      assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bLong.body);
      const assistant = ctx.store.chat.getConversation({
        characterId: "a", conversationId: aConversation.id,
      }).messages.find((message) => message.id === result.assistantMessageId);
      assert.match(assistant.content, /本地这次更正已完成/u);
      assert.equal(assistant.content.includes("正在核对"), false);
      assert.equal(verificationRequests(ctx).length, 1, "不得重试核验");
    });
  }
});

test("POL-SEMOP/D5 临时阶段2：未结识角色不进入候选、不新增关系/副本", async (t) => {
  const ctx = await setupContext(t);
  const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
  // 防御夹具边界：d 先经真实 relay 持有与 B 同 L 的长期副本，再关闭外键删除
  // 关系，模拟“已核验 L 携带未知 holder”；这不是正常产品状态。
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES ('d', '2026-01-01T00:00:00.000Z')").run();
  });
  ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "d",
    entries: [{ entryId: bLong.id, expectedVersion: bLong.version }],
  });
  const dLong = entryOf(ctx.store, "d", "pref.coffeeB");
  assert.equal(dLong.factIdentityId, bLong.factIdentityId);
  withDatabase(ctx.store.dbPath, (db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM relationships WHERE character_id = 'd'").run();
  });
  const relationshipsBefore = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT character_id FROM relationships ORDER BY character_id",
  ).all());
  const precheck = captureRealCandidates(ctx, aLong, ["a", "b", "c"], "a", {
    memberSnapshotOptional: true,
    allowProvenDerivedMembers: true,
  });
  assert.deepEqual(
    precheck.candidates.map((candidate) => candidate.identityId),
    [bLong.factIdentityId],
    "同 L 的未知 holder 不改变候选代表，但必须在阶段2被过滤",
  );
  assert.equal(
    withDatabase(ctx.store.dbPath, (db) => db.prepare(
      "SELECT fact_identity_id FROM memory_entries WHERE character_id = 'd' AND fact_key = 'pref.coffeeB'",
    ).get()).fact_identity_id,
    bLong.factIdentityId,
    "d 必须与 B 同 L，用于验证阶段2 known 过滤",
  );

  const result = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(result.verificationStatus, "pending", "临时理解必须进入阶段 2");
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  const pairs = pairsOf(verificationRequests(ctx)[0]);
  assert.ok(pairs.length >= 1);
  assert.ok(pairs.every((pair) =>
    typeof pair.right.holder === "string" &&
    ["a", "b", "c"].includes(pair.right.holder)));
  assert.equal(pairs.some((pair) => pair.right.holder === "d"), false);
  const dRows = withDatabase(ctx.store.dbPath, (db) => ({
    long: db.prepare(
      "SELECT body FROM memory_entries WHERE character_id = 'd' AND fact_key = ?",
    ).get("pref.coffeeB"),
    temporary: db.prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE character_id = 'd' AND expires_at IS NOT NULL",
    ).get().count,
  }));
  assert.equal(dRows.long.body, dLong.body);
  assert.equal(dRows.temporary, 0);
  assert.deepEqual(withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT character_id FROM relationships ORDER BY character_id",
  ).all()), relationshipsBefore);
});

test("POL-SEMOP/D11 临时阶段2后再次改口：用own L长期锚且多L同步、来源有效", async (t) => {
  const ctx = await setupContext(t);
  const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
  const bConversation = openConversation(ctx.store, "b");
  const aAssistantBefore = assistantState(ctx, aConversation);

  const first = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(first.verificationStatus, "pending", "首次临时理解必须进入阶段 2");
  assertAssistantAdvanced(aAssistantBefore, assistantState(ctx, aConversation), first);
  await awaitVerificationSettled(ctx, first);
  const aTemp = temporaryEntryOf(ctx.store, "a");
  const bTemp = temporaryEntryOf(ctx.store, "b");
  assert.ok(aTemp && bTemp);
  const tempIdentityId = aTemp.factIdentityId;
  const firstBody = bTemp.body;
  const bAssistantBefore = assistantState(ctx, bConversation, "b");

  const second = await sendTodayWithVerification(ctx, bConversation, "b", {
    text: "不是茶，我今天想喝咖啡，请帮我改过来。",
    needle: firstBody,
    excerpt: "我今天想喝咖啡",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(second.verificationStatus, "pending", "再次改口也必须进入阶段 2");
  assertAssistantAdvanced(bAssistantBefore, assistantState(ctx, bConversation, "b"), second);
  const bNow = temporaryEntryOf(ctx.store, "b");
  assert.ok(bNow, "B的current必须仍是真实入口");
  const secondBody = bNow.body;
  assert.notEqual(secondBody, firstBody);
  assert.ok(secondBody.includes("咖啡"));
  await waitFor(() => verificationRequests(ctx).length === 2, 5000);
  const secondPair = pairsOf(verificationRequests(ctx)[1])[0];
  assert.equal(secondPair.left.text, bLong.body, "再次选择current时left是own L长期锚");
  assert.equal(secondPair.left.text.includes("我今天想喝茶"), false);
  assert.equal(secondPair.left.holder, "b");

  const finished = await awaitVerificationSettled(ctx, second, "b");
  assert.equal(finished.verificationStatus, "completed");
  const entries = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.ok(entries.length >= 1);
  for (const entry of entries) {
    assert.equal(entry.body, secondBody);
    assert.equal(snapshotOf(ctx, "b", entry).status, "ok");
  }
  const aAfter = temporaryEntryOf(ctx.store, "a");
  assert.equal(aAfter.body, secondBody);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").body, bLong.body);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB").factIdentityId, bLong.factIdentityId);
  assertAssistantAdvanced(aAssistantBefore, assistantState(ctx, aConversation), first);
  assertAssistantAdvanced(bAssistantBefore, assistantState(ctx, bConversation, "b"), second);
});

/* 2c-2b 审查反例：合法锚、派生链负例、同L未知holder、受限T、proof篡改。 */
async function awaitVerificationFinal(ctx, result, characterId = "a") {
  await waitFor(() => {
    const request = ctx.store.chat.getRequest({
      characterId,
      requestId: result.requestId,
    });
    return request.verificationStatus !== "pending";
  }, 5000);
  return ctx.store.chat.getRequest({ characterId, requestId: result.requestId });
}

async function seedRelayCandidateToC(ctx) {
  const pair = await seedSameFactPair(ctx);
  const bL2 = await rememberLongViaChat(
    ctx, "b", "pref.coffeeB", "用户也爱喝咖啡", "我也爱喝咖啡。",
  );
  const bNow = entryOf(ctx.store, "b", "pref.coffeeB");
  ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: bNow.id, expectedVersion: bNow.version }],
  });
  const cLong = entryOf(ctx.store, "c", "pref.coffeeB");
  assert.equal(cLong.factIdentityId, bL2.factIdentityId);
  return {
    pair,
    aLong: entryOf(ctx.store, "a", "pref.coffee"),
    bL2,
    bNow,
    cLong,
  };
}

test("POL-SEMOP/D1 合法 corrected_v2 长期锚进入临时阶段2", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  await seedCoffeeA(ctx, aConversation);
  const original = entryOf(ctx.store, "a", "pref.coffee");
  await correctLongNonToday(ctx, aConversation, {
    text: "不是咖啡，我更喜欢茶，请帮我改过来。",
    needle: original.body,
    excerpt: "我更喜欢茶",
    evidence: "请帮我改过来",
  });
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const correctedSource = snapshotOf(ctx, "a", aLong);
  assert.equal(correctedSource.status, "ok");
  assert.equal(correctedSource.format, "corrected_v2");
  assert.equal(correctedSource.direct, true);
  const bLong = await rememberLongViaChat(
    ctx, "b", "pref.teaB", "用户也爱喝茶", "我也爱喝茶。",
  );
  const precheck = captureRealCandidates(ctx, aLong);
  assert.deepEqual(
    precheck.candidates.map((candidate) => candidate.identityId),
    [bLong.factIdentityId],
  );
  const result = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是茶，我今天想喝咖啡，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝咖啡",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(result.verificationStatus, "pending", "合法 corrected_v2 锚必须进入阶段2");
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  const bTemp = temporaryEntryOf(ctx.store, "b");
  assert.ok(bTemp);
  assert.equal(entryLinkOf(ctx, bTemp.id).long_identity_id, bLong.factIdentityId);
  assert.equal(snapshotOf(ctx, "b", bTemp).status, "ok");
});

test("POL-SEMOP/D1 可解析传播长期锚进入临时阶段2", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedCoffeeA(ctx, aConversation);
  const original = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: original.id, expectedVersion: original.version }],
  });
  await correctLongNonToday(ctx, aConversation, {
    text: "不是咖啡，我更喜欢茶，请帮我改过来。",
    needle: original.body,
    excerpt: "我更喜欢茶",
    evidence: "请帮我改过来",
  });
  const bLong = entryOf(ctx.store, "b", "pref.coffee");
  const propagated = snapshotOf(ctx, "b", bLong);
  assert.equal(propagated.status, "ok");
  assert.equal(propagated.format, "corrected_v2");
  assert.equal(propagated.direct, false);
  const cLong = await rememberLongViaChat(
    ctx, "c", "pref.teaC", "用户也爱喝茶", "我也爱喝茶。",
  );
  const precheck = captureRealCandidates(ctx, bLong, ["a", "b", "c"], "b");
  assert.deepEqual(
    precheck.candidates.map((candidate) => candidate.identityId),
    [cLong.factIdentityId],
  );
  const result = await sendTodayWithVerification(ctx, bConversation, "b", {
    text: "不是茶，我今天想喝咖啡，请帮我改过来。",
    needle: bLong.body,
    excerpt: "我今天想喝咖啡",
    evidence: "请帮我改过来",
  }, equivalentResponder());
  assert.equal(result.verificationStatus, "pending", "可解析传播锚必须进入阶段2");
  const finished = await awaitVerificationSettled(ctx, result, "b");
  assert.equal(finished.verificationStatus, "completed");
  const cTemp = temporaryEntryOf(ctx.store, "c");
  assert.ok(cTemp);
  assert.equal(entryLinkOf(ctx, cTemp.id).long_identity_id, cLong.factIdentityId);
  assert.equal(snapshotOf(ctx, "c", cTemp).status, "ok");
});

test("POL-SEMOP/D2 relay成员派生链篡改必须拒绝，不宽泛放行", async (t) => {
  const mutations = {
    "narrator-mismatch": (ctx, seeded) => withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_derivations SET narrator_character_id = 'x' WHERE entry_id = ?")
        .run(seeded.cLong.id);
    }),
    "parent-orphan": (ctx, seeded) => withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_derivations SET parent_entry_id = 'orphan-parent' WHERE entry_id = ?")
        .run(seeded.cLong.id);
    }),
    "source-version-mismatch": (ctx, seeded) => withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_derivations SET source_version = 2 WHERE entry_id = ?")
        .run(seeded.cLong.id);
    }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedRelayCandidateToC(ctx);
      mutate(ctx, seeded);
      const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
        text: "不是咖啡，我今天想喝茶，请帮我改过来。",
        needle: seeded.aLong.body,
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      }, equivalentResponder());
      const finished = await awaitVerificationFinal(ctx, result);
      assert.notEqual(finished.verificationStatus, "pending");
      const aTemp = temporaryEntryOf(ctx.store, "a");
      assert.ok(aTemp, "阶段1仍应本地完成");
      assert.equal(temporaryEntryOf(ctx.store, "c"), null, `${name} 必须拒绝 C 的派生链`);
      const bL2Entries = temporaryEntryLinksOf(ctx, aTemp.factIdentityId, "b")
        .filter((link) => link.long_identity_id === seeded.bL2.factIdentityId);
      assert.equal(bL2Entries.length, 0, `${name} 不得仅凭 broad optional 写入 B 的L2`);
      assert.equal(verificationRequests(ctx).length, 0, "链不足不应发关系核验");
    });
  }
});

test("POL-SEMOP/D2 T受限时既有holder可增另一L，T外holder不新增", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedRelayCandidateToC(ctx);
  const gate = gatedVerification(t);
  const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: seeded.aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, gate.responder);
  assert.equal(result.verificationStatus, "pending");
  const aTemp = temporaryEntryOf(ctx.store, "a");
  assert.ok(aTemp);
  await gate.waitStarted();
  ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: aTemp.id,
    expectedVersion: aTemp.version,
  });
  gate.release();
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  const bL2 = temporaryEntryLinksOf(ctx, aTemp.factIdentityId, "b")
    .filter((link) => link.long_identity_id === seeded.bL2.factIdentityId);
  assert.equal(bL2.length, 1, "B 已在 T 内，受限时仍可新增另一 L");
  assert.equal(temporaryEntryOf(ctx.store, "c"), null, "C 在 T 外，受限时不得新增");
});

test("POL-SEMOP/D2 全部holder被控制跳过时本地完成且applied=0", async (t) => {
  const ctx = await setupContext(t);
  const { aConversation, aLong, bLong } = await seedAWithIndependentB(ctx);
  const gate = gatedVerification(t);
  const result = await sendTodayWithVerification(ctx, aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, gate.responder);
  assert.equal(result.verificationStatus, "pending");
  const aTemp = temporaryEntryOf(ctx.store, "a");
  assert.ok(aTemp);
  await gate.waitStarted();
  ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: aTemp.id,
    expectedVersion: aTemp.version,
  });
  gate.release();
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  assert.equal(temporaryEntryOf(ctx.store, "b"), null, "T外holder不得新增");
  const proof = JSON.parse(proofOf(ctx, result.requestId).operation_proof);
  assert.equal(proof.applied, 0, "全部跳过后 applied 必须为 0");
  const assistant = assistantMessages(ctx, aConversation)
    .find((message) => message.id === result.assistantMessageId);
  assert.equal(assistant.content.includes("一并更正"), false);
  assert.match(assistant.content, /没有确认到可以一起更正/u);
});

test("POL-SEMOP/D3 无关已知角色context变化不使阶段2 stale", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedD3(ctx);
  const gate = gatedVerification(t);
  const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    needle: seeded.aLong.body,
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  }, gate.responder);
  assert.equal(result.verificationStatus, "pending");
  await gate.waitStarted();
  ctx.store.memory.remember({
    characterId: "c",
    factKey: "pref.walkC",
    body: "用户喜欢散步",
    kind: "preference",
    sourceId: "seed-c-walk",
  });
  gate.release();
  const finished = await awaitVerificationSettled(ctx, result);
  assert.equal(finished.verificationStatus, "completed");
  const bL2 = temporaryEntriesOf(ctx, "b", temporaryEntryOf(ctx.store, "a").factIdentityId)
    .filter((entry) => entryLinkOf(ctx, entry.id).long_identity_id === seeded.bL2.factIdentityId);
  assert.equal(bL2.length, 1);
});

test("POL-SEMOP/D2 proof负例：holder集合/root/expiry/来源有效性", async (t) => {
  const cases = {
    "candidate-identifiers": (ctx, proof) => {
      assert.ok(Array.isArray(proof.candidates), "proof 必须有候选无正文标识");
      assert.ok(proof.candidates.every((candidate) =>
        candidate.identityId && candidate.entryId && candidate.version &&
        candidate.sourceIdHash));
    },
    "holder-set-removal": (ctx, proof) => {
      const tampered = JSON.parse(JSON.stringify(proof));
      const holder = Object.keys(tampered.contextVersions).find((key) => key !== "a");
      assert.ok(holder);
      delete tampered.contextVersions[holder];
      assert.equal(ctx.store.memory.verifyOperationProof({
        action: "temporary",
        controlProof: tampered,
        nowMs: ctx.nowMs(),
      }), false);
    },
    expiry: (ctx, proof) => {
      assert.equal(ctx.store.memory.verifyOperationProof({
        action: "temporary",
        controlProof: proof,
        nowMs: proof.expiresAt + 1,
      }), false);
    },
    "source-validity": (ctx, proof) => {
      const aTemp = temporaryEntryOf(ctx.store, "a");
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE chat_messages SET role = 'assistant' WHERE id = ?")
          .run(parseTemporarySource(aTemp.sourceId).messageSourceId.slice("chat:".length));
      });
      assert.equal(ctx.store.memory.verifyOperationProof({
        action: "temporary",
        controlProof: proof,
        nowMs: ctx.nowMs(),
      }), false);
    },
    "member-root-tamper": (ctx, proof) => {
      const aTemp = temporaryEntryOf(ctx.store, "a");
      const bMember = temporaryEntriesOf(ctx, "b", aTemp.factIdentityId)[0];
      assert.ok(bMember, "需要非root成员验证 root_identity_id");
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET root_identity_id = 'forged-root' WHERE entry_id = ?")
          .run(bMember.id);
      });
      assert.equal(ctx.store.memory.verifyOperationProof({
        action: "temporary",
        controlProof: proof,
        nowMs: ctx.nowMs(),
      }), false);
    },
  };
  for (const [name, check] of Object.entries(cases)) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedD3(ctx);
      const gate = gatedVerification(t2);
      const result = await sendTodayWithVerification(ctx, seeded.pair.aConversation, "a", {
        text: "不是咖啡，我今天想喝茶，请帮我改过来。",
        needle: seeded.aLong.body,
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      }, gate.responder);
      assert.equal(result.verificationStatus, "pending");
      const proof = JSON.parse(proofOf(ctx, result.requestId).operation_proof);
      assert.equal(ctx.store.memory.verifyOperationProof({
        action: "temporary",
        controlProof: proof,
        nowMs: ctx.nowMs(),
      }), true);
      check(ctx, proof);
      await gate.waitStarted();
      gate.release();
      await awaitVerificationSettled(ctx, result);
    });
  }
});
