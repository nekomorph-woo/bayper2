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
