/* S03m 首批：POL-SEMOP-008 纠正来源追溯与关系协议兼容。
   真实 SQLite、正式 store/chat/memory/source-context/关系协议；聊天模型用本机
   HTTP 构造。覆盖 008a 直接纠正（连续与多片段）、008b 已证明传播副本、
   008c 临时来源/失效/权限/篡改，以及旧 direct 请求兼容。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");
const {
  POLICY_VERSION,
  buildRelationMessages,
  parseRelationResponse,
} = require("../../app/memory-relation-protocol.cjs");
const { locateCorrectionSegments } = require("../../app/memory-correction-evidence.cjs");
const {
  copiedTemporarySource,
  parseTemporarySource,
  temporaryFactKey,
} = require("../../app/memory-temporary-source.cjs");
const { tokenizeForIndex } = require("../../app/memory-retrieval.cjs");

const START = Date.UTC(2026, 9, 27, 10, 0, 0);
const MODEL_NAME = "fixture-corrected-source";
const API_KEY = "sk-fixture-corrected-source";
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

async function startModelServer() {
  const requests = [];
  const responders = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push(body);
      const responder = responders.shift();
      Promise.resolve(
        responder
          ? responder({ body, res })
          : sendEnvelope(res, { reply: "收到。", memoryCandidates: [] }),
      ).catch(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    enqueue(responder) {
      responders.push(responder);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendEnvelope(res, envelope) {
  if (!res || res.destroyed || res.writableEnded) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }],
  }));
}

function withDatabase(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedRelationships(dbPath, characterIds) {
  withDatabase(dbPath, (db) => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, '2026-01-01T00:00:00.000Z')",
    );
    for (const characterId of characterIds) {
      insert.run(characterId);
    }
  });
}

async function setupContext(t, characterIds = ["a", "b", "c"]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-corrected-source-"));
  let tick = START;
  let store = null;
  const open = () => createStore(dir, {
    now: () => tick,
    chat: {
      timeoutMs: 1000,
      fetchImpl: fetch,
      getCredentials: () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY }),
    },
  });
  t.after(async () => {
    try {
      store?.close();
    } catch {
      // 用例可能已关闭连接。
    }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store = open();
  seedRelationships(store.dbPath, characterIds);
  return {
    server,
    get store() { return store; },
    nowMs: () => tick,
    setNow(value) { tick = value; },
    reopen() {
      store.close();
      store = open();
    },
  };
}

const openConversation = (store, characterId = "a") =>
  store.chat.openConversation({ characterId }).conversation;

function targetFromRequest(body, needle) {
  const systemText = body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const line = systemText
    .split("\n")
    .find((item) => /^\[M\d+\]/u.test(item) && item.includes(needle));
  const match = line?.match(/^\[(M\d+)\]/u);
  assert.ok(match, `本轮候选列表没有找到 ${needle}`);
  return match[1];
}

async function rememberViaChat(ctx, conversation, text, candidates, characterId = "a") {
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "我记下了。", memoryCandidates: candidates, memoryOperation: null, memoryRelay: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result;
}

async function correctViaChat(ctx, conversation, text, { needle, excerpt, evidence }, characterId = "a") {
  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, {
    reply: "好的。",
    memoryCandidates: [],
    memoryOperation: {
      action: "correct",
      target: targetFromRequest(body, needle),
      excerpt,
      evidence,
    },
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result;
}

const entryOf = (store, characterId, factKey) =>
  store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;

function snapshot(ctx, characterId, entry, overrides = {}) {
  return ctx.store.memorySourceContext.resolve({
    characterId, entryId: entry.id, expectedVersion: entry.version, ...overrides,
  });
}

function assertUnavailable(result, reason) {
  assert.equal(result.status, "unavailable");
  if (reason) assert.equal(result.reason, reason);
}

function assertSegments(snapshotValue, entry) {
  assert.equal(snapshotValue.format, "corrected_v2");
  assert.ok(Array.isArray(snapshotValue.segments) && snapshotValue.segments.length > 0);
  assert.equal(
    snapshotValue.segments.map((segment) => segment.text).join("，"),
    entry.body,
  );
  let lastEnd = 0;
  for (const segment of snapshotValue.segments) {
    assert.equal(
      snapshotValue.sourceMessage.content.slice(segment.start, segment.end),
      segment.text,
    );
    assert.equal(segment.messageId, snapshotValue.sourceMessage.id);
    assert.ok(segment.start >= lastEnd);
    lastEnd = segment.end;
  }
}

test("POL-SEMOP-008a 直接纠正：连续原话与多分句片段可追溯，篡改/消息变动失效", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const original = entryOf(ctx.store, "a", "pref.tea");
  const correctionText = "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。";
  await correctViaChat(ctx, conversation, correctionText, {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.tea");
  assert.equal(entry.body, "不是热茶，我其实喜欢无糖咖啡");
  assert.match(entry.sourceId, /^chat-correct:/u);

  const result = snapshot(ctx, "a", entry);
  assert.equal(result.status, "ok");
  assert.equal(result.direct, true);
  assert.equal(result.via, "corrected_chat");
  assert.equal(result.sourceCharacterId, "a");
  assert.equal(result.holderCharacterId, "a");
  assert.equal(result.sourceAnchorEntryId, entry.id);
  assert.equal(result.sourceAnchorVersion, entry.version);
  assert.equal(result.sourceAnchorIdentityId, entry.factIdentityId);
  assert.equal(result.expiresAt, null);
  assert.equal(result.sourceMessage.content, correctionText);
  assert.equal(result.sourceMessage.content.includes(entry.body), true);
  assertSegments(result, entry);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);

  const tamperedSegment = structuredClone(result);
  tamperedSegment.segments[0].text = "伪造片段";
  assert.equal(ctx.store.memorySourceContext.isCurrent(tamperedSegment), false);
  const tamperedDigest = structuredClone(result);
  tamperedDigest.digest = "0".repeat(64);
  assert.equal(ctx.store.memorySourceContext.isCurrent(tamperedDigest), false);

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("完全不同的原话", result.sourceMessage.id);
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), false);
  assertUnavailable(snapshot(ctx, "a", entry));
});

test("POL-SEMOP-008a 多片段：分句以逗号规范化但不是连续原话，仍可逐段核验", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const correctionText = "其实我不喜欢咖啡。我其实喜欢喝茶。请帮我改过来。";
  await correctViaChat(ctx, conversation, correctionText, {
    needle: "咖啡", excerpt: "我其实喜欢喝茶", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.coffee");
  assert.equal(entry.body, "其实我不喜欢咖啡，我其实喜欢喝茶");
  assert.equal(correctionText.includes(entry.body), false);

  const result = snapshot(ctx, "a", entry);
  assert.equal(result.status, "ok");
  assert.equal(result.segments.length, 2);
  assertSegments(result, entry);
  assert.deepEqual(result.segments.map((segment) => segment.text), [
    "其实我不喜欢咖啡", "我其实喜欢喝茶",
  ]);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);
});

test("POL-SEMOP-008 纠正来源前文不完整时，自足判断只看真实片段", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  for (let index = 1; index <= 9; index += 1) {
    await rememberViaChat(ctx, conversation, `这是第${index}条无关的旧消息。`, []);
  }
  await rememberViaChat(ctx, conversation, "我之前说过咖啡，我其实也喝茶。", []);
  await correctViaChat(ctx, conversation, "其实我不喜欢咖啡。我其实喜欢喝茶。请帮我改过来。", {
    needle: "咖啡", excerpt: "我其实喜欢喝茶", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.coffee");
  const sourceContext = snapshot(ctx, "a", entry);
  assert.equal(sourceContext.status, "ok");
  assert.equal(sourceContext.contextIncomplete, true);
  assert.ok(sourceContext.messages.some((message) => message.content.includes("咖啡，我其实")));
  assert.equal(
    sourceContext.segments.some((segment) => segment.text.includes("咖啡，我其实")),
    false,
  );

  const pair = {
    id: "incomplete-1",
    left: {
      text: entry.body, kind: "preference", sourceKind: "user", trust: "stated",
      holder: "a", participants: null, sourceContext,
    },
    right: {
      text: "用户喜欢喝茶", kind: "preference", sourceKind: "user", trust: "stated",
      holder: "b", participants: null,
    },
  };
  const response = (subjectQuote) => JSON.stringify({
    results: [{
      pair: "incomplete-1",
      relation: "equivalent",
      left: {
        subject: "用户", subjectQuote, scope: "current", time: null, timeQuote: null,
      },
      right: {
        subject: "用户", subjectQuote: "用户", scope: "current", time: null, timeQuote: null,
      },
    }],
  });

  /* 引用只在保留前文出现，同时偶然跨 canonical 拼接正文命中；不得当自足。 */
  const crossSegment = parseRelationResponse(response("咖啡，我其实"), [pair]);
  assert.equal(crossSegment.results[0].effectiveRelation, "uncertain");
  assert.ok(crossSegment.results[0].reasons.includes("左侧主体依赖不完整前文"));

  /* 同一不完整前文下，引用实际落在单个片段内仍可自足。 */
  const singleSegment = parseRelationResponse(response("我其实"), [pair]);
  assert.equal(singleSegment.results[0].effectiveRelation, "equivalent");
});

test("POL-SEMOP-008a 词内符号必须逐字：C++ 不能被归一化成 C", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我学习 C。", [
    { factKey: "pref.lang", body: "用户学习 C", kind: "detail", trust: "stated", evidence: "我学习 C" },
  ]);
  await correctViaChat(ctx, conversation, "我学习 C++。请帮我改过来。", {
    needle: "C", excerpt: "我学习 C++", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.lang");
  assert.equal(entry.body, "我学习 C++");
  assert.match(entry.sourceId, /^chat-correct:/u);
  const result = snapshot(ctx, "a", entry);
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, "我学习 C++");
  assertSegments(result, entry);
  assert.equal(locateCorrectionSegments("我喜欢 C++。请帮我改过来。", "我喜欢 C"), null);

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET body = ? WHERE id = ?").run("我学习 C", entry.id);
  });
  assertUnavailable(snapshot(ctx, "a", entry));

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET body = ? WHERE id = ?").run("我学习 C++", entry.id);
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("我学习 C。请帮我改过来。", result.sourceMessage.id);
  });
  assertUnavailable(snapshot(ctx, "a", entry));

  const forgedBody = structuredClone(result);
  forgedBody.excerpt = "我学习 C";
  const pair = {
    id: "cxx-1",
    left: {
      text: "我学习 C", kind: "detail", sourceKind: "user", trust: "stated",
      holder: "a", participants: null, sourceContext: forgedBody,
    },
    right: {
      text: "我学习 C", kind: "detail", sourceKind: "user", trust: "stated",
      holder: "b", participants: null,
    },
  };
  assert.throws(
    () => buildRelationMessages([pair]),
    (error) => error.code === "INVALID_INPUT",
  );
});

test("POL-SEMOP-008a 重复命题无法唯一重算时拒绝，不取第一个匹配", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢茶。", [
    { factKey: "pref.tea", body: "用户喜欢茶", kind: "preference", trust: "stated", evidence: "我喜欢茶" },
  ]);
  await correctViaChat(ctx, conversation, "我喜欢茶。请帮我改过来。", {
    needle: "茶", excerpt: "我喜欢茶", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.tea");
  const result = snapshot(ctx, "a", entry);
  assert.equal(result.status, "ok");
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(
      "我喜欢茶。昨天我不喜欢茶。我喜欢茶。请帮我改过来。",
      result.sourceMessage.id,
    );
  });
  assertUnavailable(snapshot(ctx, "a", entry));
});

test("POL-SEMOP-008a 内嵌 revision 必须安全且不超过当前版本", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢茶。", [
    { factKey: "pref.tea", body: "用户喜欢茶", kind: "preference", trust: "stated", evidence: "我喜欢茶" },
  ]);
  await correctViaChat(ctx, conversation, "我喜欢茶。请帮我改过来。", {
    needle: "茶", excerpt: "我喜欢茶", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.tea");
  const result = snapshot(ctx, "a", entry);
  const messageId = result.sourceMessage.id;
  const original = entry.sourceId;
  for (const revision of [entry.version + 1, "9007199254740992"]) {
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_entries SET source_id = ? WHERE id = ?").run(
        `chat-correct:${entry.id}:${revision}:chat:${messageId}`,
        entry.id,
      );
    });
    assertUnavailable(snapshot(ctx, "a", entry));
  }
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET source_id = ? WHERE id = ?").run(original, entry.id);
  });
  assert.equal(snapshot(ctx, "a", entry).status, "ok");
});

test("POL-SEMOP-008b 传播副本的未来 revision 被拒绝", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const key = entryOf(ctx.store, "a", "pref.tea");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: key.id, expectedVersion: key.version }],
  });
  await correctViaChat(ctx, conversation, "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。", {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const bEntry = entryOf(ctx.store, "b", "pref.tea");
  const messageId = snapshot(ctx, "b", bEntry).sourceMessage.id;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET source_id = ? WHERE id = ?").run(
      `corrected:${bEntry.id}:${bEntry.version + 1}`,
      bEntry.id,
    );
  });
  assertUnavailable(snapshot(ctx, "b", bEntry));
});

test("POL-SEMOP-008b 已证明传播副本：跨角色追锚且不冒充直接告知", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const key = entryOf(ctx.store, "a", "pref.tea");
  const relayed = ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: key.id, expectedVersion: key.version }],
  });
  const bEntryBefore = entryOf(ctx.store, "b", "pref.tea");
  assert.equal(relayed.shared[0].entryId, bEntryBefore.id);

  const correctionText = "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。";
  await correctViaChat(ctx, conversation, correctionText, {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const aEntry = entryOf(ctx.store, "a", "pref.tea");
  const bEntry = entryOf(ctx.store, "b", "pref.tea");
  assert.match(aEntry.sourceId, /^chat-correct:/u);
  assert.match(bEntry.sourceId, /^corrected:/u);

  const result = snapshot(ctx, "b", bEntry);
  assert.equal(result.status, "ok");
  assert.equal(result.direct, false);
  assert.equal(result.via, "identity_correction");
  assert.equal(result.sourceCharacterId, "a");
  assert.equal(result.holderCharacterId, "b");
  assert.equal(result.sourceAnchorEntryId, aEntry.id);
  assert.equal(result.sourceAnchorVersion, aEntry.version);
  assert.equal(result.sourceAnchorIdentityId, aEntry.factIdentityId);
  assert.equal(result.sourceMessage.conversationId, conversation.id);
  assertSegments(result, bEntry);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);

  /* 后续 association 会递增成员 version 但保留既有 corrected: 来源；
     新的解析必须用当前 entry version 仍能追溯，旧快照则失效。 */
  const bumpedVersion = bEntry.version + 1;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET version = version + 1 WHERE id = ?").run(bEntry.id);
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), false);
  const bumped = ctx.store.memorySourceContext.resolve({
    characterId: "b", entryId: bEntry.id, expectedVersion: bumpedVersion,
  });
  assert.equal(bumped.status, "ok");
  assert.equal(bumped.sourceAnchorVersion, aEntry.version);
});

test("POL-SEMOP-008b 锚版本变更、锚删除、锚歧义与来源控制使快照失效", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const key = entryOf(ctx.store, "a", "pref.tea");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: key.id, expectedVersion: key.version }],
  });
  await correctViaChat(ctx, conversation, "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。", {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const aEntry = entryOf(ctx.store, "a", "pref.tea");
  const bEntry = entryOf(ctx.store, "b", "pref.tea");
  const result = snapshot(ctx, "b", bEntry);
  assert.equal(result.status, "ok");

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET version = version + 1 WHERE id = ?").run(aEntry.id);
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), false);
  const versionChanged = snapshot(ctx, "b", bEntry);
  assert.equal(versionChanged.status, "ok");
  assert.equal(versionChanged.sourceAnchorVersion, aEntry.version + 1);

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_entries SET body = ? WHERE id = ?")
      .run("被篡改的锚正文", aEntry.id);
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(versionChanged), false);
  assertUnavailable(snapshot(ctx, "b", bEntry), "anchor_unavailable");
});

test("POL-SEMOP-008b 锚删除/关系不存在时传播副本不可追溯", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const key = entryOf(ctx.store, "a", "pref.tea");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: key.id, expectedVersion: key.version }],
  });
  await correctViaChat(ctx, conversation, "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。", {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const aEntry = entryOf(ctx.store, "a", "pref.tea");
  const bEntry = entryOf(ctx.store, "b", "pref.tea");
  const result = snapshot(ctx, "b", bEntry);
  assert.equal(result.status, "ok");

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("DELETE FROM memory_entries WHERE id = ?").run(aEntry.id);
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), false);
  assertUnavailable(snapshot(ctx, "b", bEntry), "anchor_unavailable");
});

test("POL-SEMOP-008b 锚歧义与来源权限控制显式拒绝", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢热茶。", [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const key = entryOf(ctx.store, "a", "pref.tea");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: key.id, expectedVersion: key.version }],
  });
  await correctViaChat(ctx, conversation, "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。", {
    needle: "热茶", excerpt: "我其实喜欢无糖咖啡", evidence: "请帮我改过来",
  });
  const aEntry = entryOf(ctx.store, "a", "pref.tea");
  const bEntry = entryOf(ctx.store, "b", "pref.tea");
  const anchorSnapshot = snapshot(ctx, "a", aEntry);
  const messageId = anchorSnapshot.sourceMessage.id;
  const cloneId = crypto.randomUUID();
  const cloneSource = `chat-correct:${cloneId}:1:chat:${messageId}`;
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare(`
      INSERT INTO memory_entries
        (id, character_id, fact_key, fact_identity_id, origin_character_id,
         derived_from_entry_id, kind, body, trust, source_kind, importance,
         expires_at, source_id, source_version, version, created_at, updated_at)
      SELECT ?, character_id, 'pref.tea.clone', fact_identity_id, origin_character_id,
             derived_from_entry_id, kind, body, trust, source_kind, importance,
             expires_at, ?, 1, 1, created_at, updated_at
      FROM memory_entries WHERE id = ?
    `).run(cloneId, cloneSource, aEntry.id);
  });
  assertUnavailable(snapshot(ctx, "b", bEntry), "anchor_ambiguous");

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("DELETE FROM memory_entries WHERE id = ?").run(cloneId);
    db.prepare(`
      INSERT INTO memory_source_controls (character_id, source_id_hash, created_at)
      VALUES ('a', ?, ?)
    `).run(sha256(aEntry.sourceId), ctx.nowMs());
  });
  assertUnavailable(snapshot(ctx, "b", bEntry), "source_excluded");
});

test("POL-SEMOP-008c 当日临时理解：真实 chat-current 来源、到期失效、长期偏好保留", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const longTerm = entryOf(ctx.store, "a", "pref.coffee");
  const longTermBody = longTerm.body;
  const longTermVersion = longTerm.version;
  await correctViaChat(ctx, conversation, "今天只想喝茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "今天只想喝茶", evidence: "请帮我改过来",
  });
  const current = ctx.store.memory.listMemories("a").find(
    (entry) => entry.factKey === `pref.coffee.current.${longTerm.id}`,
  );
  assert.ok(current);
  assert.match(current.sourceId, /^chat-current:/u);
  assert.ok(current.expiresAt > ctx.nowMs());

  const result = snapshot(ctx, "a", current);
  assert.equal(result.status, "ok");
  assert.equal(result.format, "corrected_v2");
  assert.equal(result.direct, true);
  assert.equal(result.via, "current_temporary");
  assert.equal(result.sourceCharacterId, "a");
  assert.equal(result.holderCharacterId, "a");
  assert.equal(result.sourceAnchorEntryId, longTerm.id);
  assert.equal(result.sourceAnchorVersion, longTerm.version);
  assert.equal(result.sourceAnchorIdentityId, longTerm.factIdentityId);
  assert.equal(result.expiresAt, current.expiresAt);
  assertSegments(result, current);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);

  const end = new Date(ctx.nowMs());
  end.setHours(23, 59, 59, 999);
  ctx.setNow(end.getTime() + 1);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), false);
  assertUnavailable(snapshot(ctx, "a", current), "expired");
  const after = entryOf(ctx.store, "a", "pref.coffee");
  assert.equal(after.body, longTermBody);
  assert.equal(after.version, longTermVersion);
  assert.equal(
    ctx.store.memory.listMemories("a").some((entry) => entry.factKey === current.factKey),
    false,
  );
});

test("POL-SEMOP-008c 伪造跨角色 chat-current 来源被拒绝", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const longTerm = entryOf(ctx.store, "a", "pref.coffee");
  await correctViaChat(ctx, conversation, "今天只想喝茶，请帮我改过来。", {
    needle: "咖啡", excerpt: "今天只想喝茶", evidence: "请帮我改过来",
  });
  const current = ctx.store.memory.listMemories("a").find(
    (entry) => entry.factKey === `pref.coffee.current.${longTerm.id}`,
  );
  const forged = ctx.store.memory.remember({
    characterId: "b",
    factKey: "pref.forgedCurrent",
    body: "用户今天只想喝茶",
    kind: "preference",
    sourceId: current.sourceId,
  });
  assertUnavailable(snapshot(ctx, "b", forged.entry), "source_mismatch");
});

test("POL-SEMOP-008c 旧 direct 形状不变，外部/损坏纠正来源明确拒绝", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const text = "我喜欢热茶。";
  await rememberViaChat(ctx, conversation, text, [
    { factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference", trust: "stated", evidence: "我喜欢热茶" },
  ]);
  const direct = entryOf(ctx.store, "a", "pref.tea");
  const directSnapshot = snapshot(ctx, "a", direct);
  assert.equal(directSnapshot.status, "ok");
  assert.equal(Object.hasOwn(directSnapshot, "format"), false);
  assert.equal(directSnapshot.characterId, "a");
  assert.equal(directSnapshot.holderCharacterId, "a");
  assert.equal(directSnapshot.sourceMessage.content, text);
  assert.equal(ctx.store.memorySourceContext.isCurrent(directSnapshot), true);

  const external = ctx.store.memory.remember({
    characterId: "a", factKey: "external.weather", body: "外部来源写着明天有雨",
    kind: "detail", sourceId: `external:${sha256("file")}`,
  });
  assertUnavailable(snapshot(ctx, "a", external.entry), "unsupported_source");
  const broken = ctx.store.memory.remember({
    characterId: "a", factKey: "broken.corrected", body: "坏来源",
    kind: "detail", sourceId: "chat-correct:missing:1:chat:missing",
  });
  assertUnavailable(snapshot(ctx, "a", broken.entry), "source_mismatch");
});

test("POL-SEMOP-008 协议兼容：纠正来源校验、旧 direct 请求不变、跨片段引用拒绝", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const correctionText = "其实我不喜欢咖啡。我其实喜欢喝茶。请帮我改过来。";
  await correctViaChat(ctx, conversation, correctionText, {
    needle: "咖啡", excerpt: "我其实喜欢喝茶", evidence: "请帮我改过来",
  });
  const entry = entryOf(ctx.store, "a", "pref.coffee");
  const sourceContext = snapshot(ctx, "a", entry);
  assert.equal(sourceContext.status, "ok");

  const correctedPair = {
    id: "corrected-1",
    left: {
      text: entry.body, kind: "preference", sourceKind: "user", trust: "stated",
      holder: "a", participants: null, sourceContext,
    },
    right: {
      text: "用户喜欢喝茶", kind: "preference", sourceKind: "user", trust: "stated",
      holder: "b", participants: null,
    },
  };
  const messages = buildRelationMessages([correctedPair]);
  assert.equal(messages[0].content.includes("corrected_v2"), true);
  const data = JSON.parse(messages[1].content);
  assert.equal(data.pairs[0].left.sourceContext.format, "corrected_v2");
  assert.deepEqual(
    data.pairs[0].left.sourceContext.segments,
    sourceContext.segments.map((segment) => segment.text),
  );

  const result = parseRelationResponse(JSON.stringify({
    results: [{
      pair: "corrected-1",
      relation: "equivalent",
      left: {
        subject: "用户", subjectQuote: "我", scope: "current", time: null, timeQuote: null,
      },
      right: {
        subject: "用户", subjectQuote: "用户", scope: "current", time: null, timeQuote: null,
      },
    }],
  }), [correctedPair]);
  assert.equal(result.results[0].effectiveRelation, "equivalent");

  const spanningQuote = "咖啡。我其实";
  assert.throws(
    () => parseRelationResponse(JSON.stringify({
      results: [{
        pair: "corrected-1",
        relation: "equivalent",
        left: {
          subject: "用户", subjectQuote: spanningQuote, scope: "current", time: null, timeQuote: null,
        },
        right: {
          subject: "用户", subjectQuote: "用户", scope: "current", time: null, timeQuote: null,
        },
      }],
    }), [correctedPair]),
    (error) => error.code === "INVALID_MODEL_OUTPUT",
  );

  const commaQuote = "咖啡，我其实";
  assert.throws(
    () => parseRelationResponse(JSON.stringify({
      results: [{
        pair: "corrected-1",
        relation: "equivalent",
        left: {
          subject: "用户", subjectQuote: commaQuote, scope: "current", time: null, timeQuote: null,
        },
        right: {
          subject: "用户", subjectQuote: "用户", scope: "current", time: null, timeQuote: null,
        },
      }],
    }), [correctedPair]),
    (error) => error.code === "INVALID_MODEL_OUTPUT",
  );

  const badSegments = structuredClone(sourceContext);
  badSegments.segments[0].text = "伪造片段";
  assert.throws(
    () => buildRelationMessages([{ ...correctedPair, left: { ...correctedPair.left, sourceContext: badSegments } }]),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => buildRelationMessages([{ ...correctedPair, left: { ...correctedPair.left, holder: "c" } }]),
    (error) => error.code === "INVALID_INPUT",
  );
  const badVia = structuredClone(sourceContext);
  badVia.direct = false;
  badVia.via = "corrected_chat";
  assert.throws(
    () => buildRelationMessages([{ ...correctedPair, left: { ...correctedPair.left, sourceContext: badVia } }]),
    (error) => error.code === "INVALID_INPUT",
  );
  const missingAnchor = structuredClone(sourceContext);
  delete missingAnchor.sourceAnchorEntryId;
  assert.throws(
    () => buildRelationMessages([{ ...correctedPair, left: { ...correctedPair.left, sourceContext: missingAnchor } }]),
    (error) => error.code === "INVALID_INPUT",
  );

  await rememberViaChat(ctx, conversation, "我喜欢猫。", [
    { factKey: "detail.cat", body: "用户喜欢猫", kind: "detail", trust: "stated", evidence: "我喜欢猫" },
  ]);
  const directEntry = entryOf(ctx.store, "a", "detail.cat");
  const directSource = snapshot(ctx, "a", directEntry);
  const directPair = {
    id: "direct-1",
    left: {
      text: directEntry.body, kind: "detail", sourceKind: "user", trust: "stated",
      holder: "a", participants: null, sourceContext: directSource,
    },
    right: {
      text: "用户喜欢猫", kind: "detail", sourceKind: "user", trust: "stated",
      holder: "b", participants: null,
    },
  };
  const directMessages = buildRelationMessages([directPair]);
  assert.equal(directMessages[0].content.includes("corrected_v2"), false);
  assert.equal(POLICY_VERSION, "s03l-grounded-relation-v1");
});

/* S03m 2c-1 临时来源延伸：显式转告与面板编辑仍可追溯，但不冒充聊天原话。
   真实 SQLite/chat/memory；模型响应为构造 HTTP，不覆盖 GUI 或真实模型。 */

function temporaryEntryOf(store, characterId, { includeLegacy = false } = {}) {
  return store.memory.listMemories(characterId).find((entry) => {
    if (entry.expiresAt === null) {
      return false;
    }
    if (/^(chat-current:|chat-current-copy:|temporary-edit:)/u.test(entry.sourceId)) {
      return true;
    }
    return includeLegacy && /^(relay:|share:)/u.test(entry.sourceId);
  }) ?? null;
}

function temporaryRowsOfHolder(ctx, characterId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT id, character_id, fact_key, fact_identity_id, body, source_id,
           version, expires_at
    FROM memory_entries
    WHERE character_id = ? AND expires_at IS NOT NULL
      AND (source_id LIKE 'chat-current:%'
        OR source_id LIKE 'chat-current-copy:%'
        OR source_id LIKE 'temporary-edit:%')
    ORDER BY id ASC
  `).all(characterId));
}

function temporaryLinksOf(ctx, holderCharacterId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT * FROM memory_temporary_links
    WHERE holder_character_id = ?
    ORDER BY temp_identity_id ASC, expires_at ASC
  `).all(holderCharacterId));
}

function temporaryEntryByIdentity(store, characterId, factIdentityId) {
  return store.memory.listMemories(characterId).find((entry) =>
    entry.expiresAt !== null && entry.factIdentityId === factIdentityId) ?? null;
}

function persistedTemporaryRow(ctx, entryId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT id, character_id, origin_character_id, derived_from_entry_id,
           source_id, fact_identity_id, version
    FROM memory_entries WHERE id = ?
  `).get(entryId));
}

function derivationRow(ctx, entryId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT parent_entry_id, origin_character_id, narrator_character_id,
           source_id, source_version
    FROM memory_derivations WHERE entry_id = ?
  `).get(entryId));
}

function relationEdgesToEntry(ctx, entryId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT from_entry_id, kind FROM memory_fact_relation_edges
    WHERE to_entry_id = ? ORDER BY kind ASC
  `).all(entryId));
}

async function memorySystemContent(ctx, conversation, characterId, text = "现在呢？") {
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
  return ctx.server.requests.at(-1).messages
    .filter((message) => message.role === "system")[1].content;
}

async function seedTodayForSource(ctx, conversation) {
  await rememberViaChat(ctx, conversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const longTerm = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: longTerm.id, expectedVersion: longTerm.version }],
  });
  await correctViaChat(ctx, conversation, "不是咖啡，我今天想喝茶，请帮我改过来。", {
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  return {
    longTerm: entryOf(ctx.store, "a", "pref.coffee"),
    aEntry: temporaryEntryOf(ctx.store, "a"),
    bEntry: temporaryEntryOf(ctx.store, "b"),
  };
}

async function seedSameFactPairForSource(ctx) {
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await rememberViaChat(ctx, aConversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
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

async function tellTodayForSource(ctx, conversation, { text, needle, excerpt, evidence }) {
  await correctViaChat(ctx, conversation, text, { needle, excerpt, evidence });
}

test("POL-SEMOP-001d/S7 显式转告继承到期与T，父删除后仍按origin可验证", async (t) => {
  const ctx = await setupContext(t, ["a", "b", "c", "d", "e"]);
  const conversation = openConversation(ctx.store);
  const seeded = await seedTodayForSource(ctx, conversation);
  assert.ok(seeded.aEntry);
  assert.equal(temporaryEntryOf(ctx.store, "c"), null, "私聊偏好不应默认自动分享给C");

  // C 的无关长期记忆不能被当成本次今日理解的 holder 锚。
  ctx.store.memory.remember({
    characterId: "c",
    factKey: "pref.cat",
    body: "用户喜欢猫",
    kind: "preference",
    sourceId: "seed-c-cat",
  });
  const cUnrelatedLong = entryOf(ctx.store, "c", "pref.cat");
  const longIdentityId = seeded.longTerm.factIdentityId;

  const relayToC = () => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
  });
  const relayed = relayToC();
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = temporaryEntryOf(ctx.store, "c", { includeLegacy: true });
  assert.ok(cEntry, "C 应获得显式转告的今日副本");
  assert.equal(cEntry.expiresAt, seeded.aEntry.expiresAt);
  assert.equal(cEntry.factIdentityId, seeded.aEntry.factIdentityId);
  assert.match(cEntry.sourceId, /^chat-current-copy:/u);
  const cSnapshot = snapshot(ctx, "c", cEntry);
  assert.equal(cSnapshot.status, "ok");
  assert.equal(cSnapshot.direct, false);
  assert.equal(cSnapshot.via, "temporary_relay");
  assert.equal(cSnapshot.relayFrom, "a");
  assert.equal(cSnapshot.sourceCharacterId, "a");
  assert.equal(cSnapshot.holderCharacterId, "c");
  assert.equal(cSnapshot.holderAnchorEntryId, null);
  assert.equal(cSnapshot.holderAnchorStatus, "absent");
  assert.equal(cSnapshot.temporaryIdentityId, seeded.aEntry.factIdentityId);
  assert.equal(ctx.store.memorySourceContext.isCurrent(cSnapshot), true);

  // 收件人的无关长期记忆保持不变，也不得被挂成 T 的 holder long。
  assert.equal(entryOf(ctx.store, "c", "pref.cat").body, "用户喜欢猫");
  const cLinks = temporaryLinksOf(ctx, "c");
  assert.ok(cLinks.length > 0);
  assert.ok(cLinks.every((link) => link.long_identity_id === longIdentityId));
  assert.equal(
    cLinks.some((link) => link.long_identity_id === cUnrelatedLong.factIdentityId),
    false,
  );

  // 同一转告幂等：不新增第二行，来源与版本不变。
  const again = relayToC();
  assert.equal(again.shared[0].alreadyHeld, true);
  const cRows = temporaryRowsOfHolder(ctx, "c");
  assert.equal(cRows.length, 1);
  assert.equal(cRows[0].source_id, cEntry.sourceId);
  assert.equal(cRows[0].version, cEntry.version);

  // B 已由身份同步持有今日副本，再显式转告已知 D：origin 仍是 A，讲述者是 B。
  assert.ok(seeded.bEntry, "B 应已同步今日副本");
  openConversation(ctx.store, "d");
  const relayedToD = ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "d",
    entries: [{ entryId: seeded.bEntry.id, expectedVersion: seeded.bEntry.version }],
  });
  assert.equal(relayedToD.shared[0].alreadyHeld, false);
  const dEntry = temporaryEntryOf(ctx.store, "d", { includeLegacy: true });
  assert.ok(dEntry, "D 应获得 B 的显式转告副本");
  assert.equal(dEntry.expiresAt, seeded.aEntry.expiresAt);
  assert.equal(dEntry.factIdentityId, seeded.aEntry.factIdentityId);
  const dSnapshot = snapshot(ctx, "d", dEntry);
  assert.equal(dSnapshot.status, "ok");
  assert.equal(dSnapshot.via, "temporary_relay");
  assert.equal(dSnapshot.relayFrom, "b");
  assert.equal(dSnapshot.sourceCharacterId, "a");
  assert.equal(dSnapshot.holderAnchorEntryId, null);
  assert.equal(ctx.store.memorySourceContext.isCurrent(dSnapshot), true);

  // 已知的 C 再转告已知 E：origin 仍是 A，直接讲述者是 C。
  openConversation(ctx.store, "e");
  const relayedToE = ctx.store.memory.relay({
    fromCharacterId: "c",
    toCharacterId: "e",
    entries: [{ entryId: cEntry.id, expectedVersion: cEntry.version }],
  });
  assert.equal(relayedToE.shared[0].alreadyHeld, false);
  const eEntry = temporaryEntryOf(ctx.store, "e", { includeLegacy: true });
  assert.ok(eEntry, "E 应获得链式转告副本");
  assert.equal(eEntry.expiresAt, seeded.aEntry.expiresAt);
  assert.equal(eEntry.factIdentityId, seeded.aEntry.factIdentityId);
  const eSnapshot = snapshot(ctx, "e", eEntry);
  assert.equal(eSnapshot.status, "ok");
  assert.equal(eSnapshot.direct, false);
  assert.equal(eSnapshot.via, "temporary_relay");
  assert.equal(eSnapshot.relayFrom, "c", "直接讲述者是上一跳 C，而不是最初 origin A");
  assert.equal(eSnapshot.sourceCharacterId, "a");
  assert.equal(eSnapshot.holderCharacterId, "e");
  assert.equal(eSnapshot.holderAnchorEntryId, null);
  assert.equal(eSnapshot.edited, false);
  assert.equal(ctx.store.memorySourceContext.isCurrent(eSnapshot), true);

  // 删除 C 的父副本与 A 的 origin current 后，E 仍按 origin 消息与 derivation 可验证。
  ctx.store.memory.forget({
    characterId: "c",
    entryId: cEntry.id,
    expectedVersion: cEntry.version,
    scope: "self",
  });
  const afterParentDelete = snapshot(ctx, "e", eEntry);
  assert.equal(afterParentDelete.status, "ok");
  assert.equal(afterParentDelete.relayFrom, "c");
  ctx.store.memory.forget({
    characterId: "a",
    entryId: seeded.aEntry.id,
    expectedVersion: seeded.aEntry.version,
    scope: "self",
  });
  const afterOriginDelete = snapshot(ctx, "e", eEntry);
  assert.equal(afterOriginDelete.status, "ok");
  assert.equal(afterOriginDelete.temporarySourceStatus, "removed");
  assert.equal(afterOriginDelete.sourceAnchorStatus, "live");
});

test("POL-SEMOP-001d/S7b 转告边界：限制/过期/未知/忘记/自动分享开关与写入回滚", async (t) => {
  await t.test("限制后拒绝且不写", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    ctx.store.memory.restrictSharing({
      characterId: "a",
      entryId: seeded.aEntry.id,
      expectedVersion: seeded.aEntry.version,
    });
    assert.throws(
      () => ctx.store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "c",
        entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
      }),
      (error) => error?.code === "SHARE_BLOCKED",
    );
    assert.equal(temporaryEntryOf(ctx.store, "c", { includeLegacy: true }), null);
  });

  await t.test("过期后拒绝且不写", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    ctx.setNow(seeded.aEntry.expiresAt + 1);
    assert.throws(
      () => ctx.store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "c",
        entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
      }),
      (error) => error?.code === "SHARE_NOT_ALLOWED",
    );
    assert.equal(temporaryEntryOf(ctx.store, "c", { includeLegacy: true }), null);
  });

  await t.test("未知接收者拒绝且不写", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    assert.throws(
      () => ctx.store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "unknown-character",
        entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
      }),
      (error) => error?.code === "CHARACTER_UNKNOWN",
    );
    assert.equal(temporaryRowsOfHolder(ctx, "c").length, 0);
  });

  await t.test("接收者忘记后再次转告被旧forget控制阻止", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    ctx.store.memory.relay({
      fromCharacterId: "a",
      toCharacterId: "c",
      entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
    });
    const cEntry = temporaryEntryOf(ctx.store, "c", { includeLegacy: true });
    assert.ok(cEntry);
    ctx.store.memory.forget({
      characterId: "c",
      entryId: cEntry.id,
      expectedVersion: cEntry.version,
      scope: "self",
    });
    assert.equal(temporaryEntryOf(ctx.store, "c", { includeLegacy: true }), null);
    assert.throws(
      () => ctx.store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "c",
        entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
      }),
      (error) => error?.code === "SHARE_BLOCKED",
    );
    assert.equal(temporaryEntryOf(ctx.store, "c", { includeLegacy: true }), null);
  });

  await t.test("自动分享仍受全局开关与分享资格约束", async (t2) => {
    const ctx = await setupContext(t2, ["a", "b", "c", "d"]);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    assert.equal(
      temporaryEntryOf(ctx.store, "c", { includeLegacy: true }),
      null,
      "今日私聊理解不应默认自动分享",
    );
    ctx.store.memory.setAutoShareEnabled({ enabled: false });
    assert.throws(
      () => ctx.store.memory.share({
        fromCharacterId: "a",
        toCharacterId: "c",
        entryIds: [seeded.aEntry.id],
      }),
      (error) => error?.code === "AUTO_SHARE_DISABLED",
    );
    ctx.store.memory.setAutoShareEnabled({ enabled: true });
    const shared = ctx.store.memory.share({
      fromCharacterId: "a",
      toCharacterId: "c",
      entryIds: [seeded.aEntry.id],
    });
    assert.equal(shared.shared[0].alreadyHeld, false);
    const cEntry = temporaryEntryOf(ctx.store, "c", { includeLegacy: true });
    assert.ok(cEntry);
    assert.match(cEntry.sourceId, /^chat-current-copy:/u);
    assert.equal(cEntry.factIdentityId, seeded.aEntry.factIdentityId);
    assert.equal(cEntry.expiresAt, seeded.aEntry.expiresAt);
    const cSnapshot = snapshot(ctx, "c", cEntry);
    assert.equal(cSnapshot.status, "ok");
    assert.equal(cSnapshot.via, "temporary_relay");
    assert.equal(cSnapshot.relayFrom, "a");

    ctx.store.memory.restrictSharing({
      characterId: "a",
      entryId: seeded.aEntry.id,
      expectedVersion: seeded.aEntry.version,
    });
    assert.throws(
      () => ctx.store.memory.share({
        fromCharacterId: "a",
        toCharacterId: "d",
        entryIds: [seeded.aEntry.id],
      }),
      (error) => error?.code === "SHARE_BLOCKED",
    );
    assert.equal(temporaryEntryOf(ctx.store, "d", { includeLegacy: true }), null);
  });

  await t.test("转告写入失败整笔回滚", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    const before = sourceState(ctx);
    withDatabase(ctx.store.dbPath, (db) => db.exec(`
      CREATE TRIGGER fail_temporary_relay
      BEFORE INSERT ON memory_entries
      WHEN NEW.character_id = 'c' AND NEW.source_id LIKE 'chat-current-copy:%'
      BEGIN
        SELECT RAISE(ABORT, 'temporary relay failure');
      END
    `));
    assert.throws(() => ctx.store.memory.relay({
      fromCharacterId: "a",
      toCharacterId: "c",
      entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
    }));
    assert.deepEqual(sourceState(ctx), before, "转告写入失败时不应留下条目、派生、link 或控制");
  });
});

test("POL-SEMOP-001d/S8 面板编辑同步全部持有者，来源为temporary-edit且不冒充原话", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const seeded = await seedTodayForSource(ctx, conversation);
  assert.ok(seeded.aEntry);
  let bEntry = seeded.bEntry;
  if (!bEntry) {
    ctx.store.memory.relay({
      fromCharacterId: "a",
      toCharacterId: "b",
      entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
    });
    bEntry = temporaryEntryOf(ctx.store, "b", { includeLegacy: true });
  }
  assert.ok(bEntry, "B 应有可编辑的今日副本");
  const aId = seeded.aEntry.id;
  const bId = bEntry.id;
  const aVersion = seeded.aEntry.version;
  const bVersion = bEntry.version;
  const expiresAt = bEntry.expiresAt;
  const temporaryIdentityId = bEntry.factIdentityId;
  const aLongBefore = entryOf(ctx.store, "a", "pref.coffee");
  const bLongBefore = entryOf(ctx.store, "b", "pref.coffee");

  ctx.store.memory.correct({
    characterId: "b",
    entryId: bEntry.id,
    expectedVersion: bEntry.version,
    body: "用户今天想喝奶茶",
  });
  const aEdited = ctx.store.memory.listMemories("a").find((entry) => entry.id === aId);
  const bEdited = ctx.store.memory.listMemories("b").find((entry) => entry.id === bId);
  assert.equal(aEdited.body, "用户今天想喝奶茶");
  assert.equal(bEdited.body, "用户今天想喝奶茶");
  assert.equal(aEdited.expiresAt, expiresAt);
  assert.equal(bEdited.expiresAt, expiresAt);
  assert.equal(aEdited.version, aVersion + 1);
  assert.equal(bEdited.version, bVersion + 1);
  assert.match(aEdited.sourceId, /^temporary-edit:/u);
  assert.match(bEdited.sourceId, /^temporary-edit:/u);
  assert.equal(aEdited.factIdentityId, temporaryIdentityId);
  assert.equal(bEdited.factIdentityId, temporaryIdentityId);

  // 编辑只改今日理解，长期条目正文与版本都不动。
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, aLongBefore.version);
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").version, bLongBefore.version);

  for (const [holder, entry, holderLong] of [
    ["a", aEdited, aLongBefore],
    ["b", bEdited, bLongBefore],
  ]) {
    const edited = snapshot(ctx, holder, entry);
    assert.equal(edited.status, "ok");
    assert.equal(edited.temporaryKind, "edit");
    assert.equal(edited.edited, true);
    assert.equal(edited.via, "temporary_edit");
    assert.equal(edited.direct, false);
    assert.equal(edited.expiresAt, expiresAt);
    assert.equal(edited.temporaryIdentityId, temporaryIdentityId);
    assert.equal(edited.holderAnchorEntryId, holderLong.id);
    assert.equal(edited.holderAnchorStatus, "live");
    assert.equal(edited.sourceAnchorIdentityId, aLongBefore.factIdentityId);
    assert.deepEqual(edited.segments, [], "编辑正文不冒充原话片段");
    assert.equal(edited.sourceMessage.content.includes(entry.body), false);
    assert.equal(edited.sourceMessage.content.includes("我今天想喝茶"), true);
    assert.equal(ctx.store.memorySourceContext.isCurrent(edited), true);
  }

  assert.ok(
    ctx.store.memory.searchMemories({ characterId: "b", query: "奶茶" })
      .some((entry) => entry.id === bId),
    "编辑后的今日理解应可检索",
  );
  const contextBodies = Object.values(
    ctx.store.memory.buildContext({ characterId: "b" }).sections,
  ).flat().map((entry) => entry.body);
  assert.ok(contextBodies.includes("用户今天想喝奶茶"), "编辑后的今日理解应进入上下文");
  assert.equal(contextBodies.includes("我今天想喝茶"), false, "旧今日正文不应残留");
  assert.equal(contextBodies.includes("我喜欢咖啡"), false, "有效今日理解应抑制长期锚");

  const relayed = ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: bEdited.id, expectedVersion: bEdited.version }],
  });
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = temporaryEntryOf(ctx.store, "c");
  assert.ok(cEntry);
  assert.match(cEntry.sourceId, /^temporary-edit:/u);
  assert.equal(cEntry.expiresAt, expiresAt);
  assert.equal(cEntry.factIdentityId, temporaryIdentityId);
  assert.equal(cEntry.body, "用户今天想喝奶茶");
  const cSnapshot = snapshot(ctx, "c", cEntry);
  assert.equal(cSnapshot.status, "ok");
  assert.equal(cSnapshot.edited, true);
  assert.equal(cSnapshot.via, "temporary_edit");
  assert.equal(cSnapshot.relayFrom, "b");
  assert.equal(cSnapshot.sourceCharacterId, "a");
  assert.equal(cSnapshot.holderAnchorEntryId, null);
  assert.equal(ctx.store.memorySourceContext.isCurrent(cSnapshot), true);
});

test("POL-SEMOP-001d/S8 编辑写入失败整笔回滚，不改长期/T/link", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const seeded = await seedTodayForSource(ctx, conversation);
  assert.ok(seeded.bEntry, "B 应有可编辑的今日副本");
  const before = sourceState(ctx);
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_temporary_edit
    BEFORE UPDATE ON memory_entries
    WHEN NEW.source_id LIKE 'temporary-edit:%'
    BEGIN
      SELECT RAISE(ABORT, 'temporary edit failure');
    END
  `));
  assert.throws(() => ctx.store.memory.correct({
    characterId: "b",
    entryId: seeded.bEntry.id,
    expectedVersion: seeded.bEntry.version,
    body: "用户今天想喝奶茶",
  }));
  assert.deepEqual(
    sourceState(ctx),
    before,
    "编辑写入失败时条目、派生、link、控制与上下文版本应整笔回滚",
  );
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
});

test("POL-SEMOP-001d/S13 编辑来源同样核对link，失效后恢复长期", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const seeded = await seedTodayForSource(ctx, conversation);
  assert.ok(seeded.bEntry);
  ctx.store.memory.correct({
    characterId: "b",
    entryId: seeded.bEntry.id,
    expectedVersion: seeded.bEntry.version,
    body: "用户今天想喝奶茶",
  });
  const aEdited = ctx.store.memory.listMemories("a").find((entry) => entry.id === seeded.aEntry.id);
  const bEdited = ctx.store.memory.listMemories("b").find((entry) => entry.id === seeded.bEntry.id);
  assert.equal(snapshot(ctx, "a", aEdited).status, "ok");
  assert.equal(snapshot(ctx, "b", bEdited).status, "ok");

  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare(`
      DELETE FROM memory_temporary_links
      WHERE temp_identity_id = ? AND holder_character_id = 'b'
    `).run(bEdited.factIdentityId);
  });
  assertUnavailableWithoutWrites(ctx, "b", bEdited);
  assert.equal(snapshot(ctx, "a", aEdited).status, "ok", "B 的 link 缺失不应连带 A");
  await assertTemporaryExcludedAndChatRestores(ctx, {
    holder: "b",
    entry: bEdited,
    longEntry: entryOf(ctx.store, "b", "pref.coffee"),
    longBody: "我喜欢咖啡",
    todayBody: "用户今天想喝奶茶",
  });
});

/* S03m 2c-1a 返修：临时来源有效性必须由同一权威规则贯穿 resolve、search、
   buildContext 与真实聊天请求。以下用真实 chat/SQLite 变异构造失效来源，
   再核对三处入口都不再使用旧今日正文，同时合法长期记录恢复。 */

function sourceState(ctx) {
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
      links: hasLinks
        ? db.prepare("SELECT * FROM memory_temporary_links ORDER BY temp_identity_id, holder_character_id").all()
        : [],
      sourceControls: rows("memory_source_controls", "character_id, source_id_hash"),
      forgetControls: rows("memory_forget_identity_controls", "character_id, identity_id"),
      shareControls: rows("memory_share_identity_controls", "identity_id"),
      contextVersions: rows("memory_context_versions", "character_id"),
    };
  });
}

function contextBodies(ctx, characterId) {
  const context = ctx.store.memory.buildContext({ characterId });
  return Object.values(context.sections).flat().map((entry) => entry.body);
}

async function seedSourcePair(ctx) {
  const aConversation = openConversation(ctx.store);
  await rememberViaChat(ctx, aConversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: aLong.id, expectedVersion: aLong.version }],
  });
  await correctViaChat(ctx, aConversation, "不是咖啡，我今天想喝茶，请帮我改过来。", {
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aTemp = temporaryEntryOf(ctx.store, "a");
  const bTemp = temporaryEntryOf(ctx.store, "b");
  assert.ok(aTemp, "A 应有今日临时理解");
  assert.ok(bTemp, "B 应同步今日临时理解");
  const parsed = parseTemporarySource(bTemp.sourceId);
  assert.ok(parsed && parsed.kind === "copy");
  return {
    aConversation,
    bConversation: openConversation(ctx.store, "b"),
    aLong,
    bLong: entryOf(ctx.store, "b", "pref.coffee"),
    aTemp,
    bTemp,
    parsed,
    todayBody: bTemp.body,
    longBody: "我喜欢咖啡",
  };
}

function assertUnavailableWithoutWrites(ctx, characterId, entry, reason) {
  const before = sourceState(ctx);
  const result = snapshot(ctx, characterId, entry);
  assert.equal(result.status, "unavailable");
  if (reason) assert.equal(result.reason, reason);
  assert.deepEqual(sourceState(ctx), before, "resolve 不应改变记忆状态");
  return result;
}

async function assertTemporaryExcludedAndChatRestores(ctx, {
  holder, entry, longEntry, longBody, todayBody,
}) {
  const hitsToday = ctx.store.memory.searchMemories({
    characterId: holder,
    query: todayBody,
  });
  assert.equal(
    hitsToday.some((hit) => hit.id === entry.id),
    false,
    "失效临时条目不应进入检索",
  );
  const hitsLong = ctx.store.memory.searchMemories({
    characterId: holder,
    query: longBody,
  });
  assert.ok(
    hitsLong.some((hit) => hit.id === longEntry.id),
    "合法长期记录仍应可检索",
  );
  const bodies = contextBodies(ctx, holder);
  assert.equal(bodies.includes(todayBody), false, "失效临时正文不应进入上下文");
  assert.ok(bodies.includes(longBody), "失效后长期记录应恢复");

  const versionBefore = ctx.store.memory.getContextVersion(holder);
  const conversation = openConversation(ctx.store, holder);
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "现在呢。", memoryCandidates: [], memoryOperation: null, memoryRelay: null,
  }));
  const turn = await ctx.store.chat.sendMessage({
    characterId: holder,
    conversationId: conversation.id,
    text: "现在呢？",
    requestId: crypto.randomUUID(),
  });
  assert.equal(turn.status, "completed");
  const system = ctx.server.requests.at(-1).messages
    .filter((message) => message.role === "system")[1].content;
  assert.equal(system.includes(todayBody), false, "真实聊天上下文不应含失效今日正文");
  assert.ok(system.includes(longBody), "真实聊天上下文应恢复合法长期记录");
  assert.equal(
    ctx.store.memory.getContextVersion(holder),
    versionBefore,
    "纯读取的失效过滤不应改变上下文版本",
  );
}

async function assertValidTemporaryContext(ctx, {
  holder, entry, todayBody, longBody,
}) {
  const result = snapshot(ctx, holder, entry);
  assert.equal(result.status, "ok", result.reason);
  const bodies = contextBodies(ctx, holder);
  assert.ok(bodies.includes(todayBody));
  assert.equal(bodies.includes(longBody), false, "有效今日理解应抑制同一长期锚");
  const conversation = openConversation(ctx.store, holder);
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "今天先这样。", memoryCandidates: [], memoryOperation: null, memoryRelay: null,
  }));
  const turn = await ctx.store.chat.sendMessage({
    characterId: holder,
    conversationId: conversation.id,
    text: "现在呢？",
    requestId: crypto.randomUUID(),
  });
  assert.equal(turn.status, "completed");
  const system = ctx.server.requests.at(-1).messages
    .filter((message) => message.role === "system")[1].content;
  assert.ok(system.includes(todayBody));
  assert.equal(system.includes(longBody), false);
}

test("POL-SEMOP-001d/S13 源消息被改、role或归属变化时临时来源失效", async (t) => {
  for (const mutation of ["content", "role", "ownership"]) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedSourcePair(ctx);
      withDatabase(ctx.store.dbPath, (db) => {
        if (mutation === "content") {
          db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
            .run("完全不同的原话", seeded.parsed.messageSourceId.slice("chat:".length));
        } else if (mutation === "role") {
          db.prepare("UPDATE chat_messages SET role = 'assistant' WHERE id = ?")
            .run(seeded.parsed.messageSourceId.slice("chat:".length));
        } else {
          db.prepare("UPDATE chat_messages SET source_id = ? WHERE id = ?")
            .run("chat:forged-owner", seeded.parsed.messageSourceId.slice("chat:".length));
        }
      });
      assertUnavailableWithoutWrites(ctx, "b", seeded.bTemp);
      await assertTemporaryExcludedAndChatRestores(ctx, {
        holder: "b",
        entry: seeded.bTemp,
        longEntry: seeded.bLong,
        longBody: seeded.longBody,
        todayBody: seeded.todayBody,
      });
    });
  }
});

test("POL-SEMOP-001d/S13 origin current被改版本/正文或B来源被控制时失效", async (t) => {
  for (const mutation of ["origin-version", "origin-body", "embedded-control"]) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedSourcePair(ctx);
      withDatabase(ctx.store.dbPath, (db) => {
        if (mutation === "origin-version") {
          db.prepare("UPDATE memory_entries SET version = version + 1 WHERE id = ?")
            .run(seeded.aTemp.id);
        } else if (mutation === "origin-body") {
          db.prepare("UPDATE memory_entries SET body = ? WHERE id = ?")
            .run("被篡改的今日正文", seeded.aTemp.id);
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at)
            VALUES ('b', ?, ?)
          `).run(sha256(seeded.parsed.messageSourceId), ctx.nowMs());
        }
      });
      assertUnavailableWithoutWrites(ctx, "b", seeded.bTemp);
      await assertTemporaryExcludedAndChatRestores(ctx, {
        holder: "b",
        entry: seeded.bTemp,
        longEntry: seeded.bLong,
        longBody: seeded.longBody,
        todayBody: seeded.todayBody,
      });
    });
  }
});

test("POL-SEMOP-001d/S13 derivation parent缺失/被换或link冲突时失效", async (t) => {
  for (const mutation of ["parent-deleted", "parent-replaced", "link-conflict"]) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedSourcePair(ctx);
      withDatabase(ctx.store.dbPath, (db) => {
        if (mutation === "parent-deleted") {
          db.prepare("DELETE FROM memory_derivations WHERE entry_id = ?").run(seeded.bTemp.id);
        } else if (mutation === "parent-replaced") {
          db.prepare("UPDATE memory_derivations SET parent_entry_id = 'forged-parent' WHERE entry_id = ?")
            .run(seeded.bTemp.id);
        } else {
          db.prepare(`
            INSERT INTO memory_temporary_links
              (temp_identity_id, long_identity_id, holder_character_id, expires_at)
            VALUES (?, 'forged-long-identity', 'b', ?)
          `).run(seeded.bTemp.factIdentityId, seeded.bTemp.expiresAt);
        }
      });
      assertUnavailableWithoutWrites(ctx, "b", seeded.bTemp);
      await assertTemporaryExcludedAndChatRestores(ctx, {
        holder: "b",
        entry: seeded.bTemp,
        longEntry: seeded.bLong,
        longBody: seeded.longBody,
        todayBody: seeded.todayBody,
      });
    });
  }
});

test("POL-SEMOP-001d/S13 直接临时来源的原消息变化同样失效", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedSourcePair(ctx);
  const parsed = parseTemporarySource(seeded.aTemp.sourceId);
  assert.ok(parsed && parsed.kind === "direct");
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
      .run("完全不同的原话", parsed.messageSourceId.slice("chat:".length));
  });
  assertUnavailableWithoutWrites(ctx, "a", seeded.aTemp);
  await assertTemporaryExcludedAndChatRestores(ctx, {
    holder: "a",
    entry: seeded.aTemp,
    longEntry: seeded.aLong,
    longBody: seeded.longBody,
    todayBody: seeded.todayBody,
  });
});

test("POL-SEMOP-001d/S13 正对照：A self删临时与A删长期后B仍有效", async (t) => {
  await t.test("self-delete-current", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aTemp.id,
      expectedVersion: seeded.aTemp.version,
      scope: "self",
    });
    await assertValidTemporaryContext(ctx, {
      holder: "b",
      entry: seeded.bTemp,
      todayBody: seeded.todayBody,
      longBody: seeded.longBody,
    });
  });
  await t.test("delete-origin-long", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aLong.id,
      expectedVersion: seeded.aLong.version,
      scope: "self",
    });
    await assertValidTemporaryContext(ctx, {
      holder: "b",
      entry: seeded.bTemp,
      todayBody: seeded.todayBody,
      longBody: seeded.longBody,
    });
  });
});

/* 2c-1b 权威有效性收口：direct/copy 都必须满足 T/link/holder/expiry 一致；
   失效 current 不能参与查找复用或歧义，也不能被直接选中绕过。 */
test("POL-SEMOP-001d/S13 link缺失/冲突或到期不一致时直接与副本来源不可用", async (t) => {
  for (const mutation of [
    "direct-link-missing",
    "direct-link-conflict",
    "direct-link-expiry",
    "copy-link-missing",
  ]) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedSourcePair(ctx);
      withDatabase(ctx.store.dbPath, (db) => {
        const temporaryIdentityId = seeded.aTemp.factIdentityId;
        if (mutation === "direct-link-missing") {
          db.prepare(`
            DELETE FROM memory_temporary_links
            WHERE temp_identity_id = ? AND holder_character_id = 'a'
          `).run(temporaryIdentityId);
        } else if (mutation === "direct-link-conflict") {
          db.prepare(`
            INSERT INTO memory_temporary_links
              (temp_identity_id, long_identity_id, holder_character_id, expires_at)
            VALUES (?, 'forged-long-identity', 'a', ?)
          `).run(temporaryIdentityId, seeded.aTemp.expiresAt);
        } else if (mutation === "direct-link-expiry") {
          db.prepare(`
            UPDATE memory_temporary_links SET expires_at = expires_at + 1
            WHERE temp_identity_id = ? AND holder_character_id = 'a'
          `).run(temporaryIdentityId);
        } else {
          db.prepare(`
            DELETE FROM memory_temporary_links
            WHERE temp_identity_id = ? AND holder_character_id = 'b'
          `).run(temporaryIdentityId);
        }
      });

      if (mutation.startsWith("direct")) {
        assertUnavailableWithoutWrites(ctx, "a", seeded.aTemp);
        await assertTemporaryExcludedAndChatRestores(ctx, {
          holder: "a",
          entry: seeded.aTemp,
          longEntry: seeded.aLong,
          longBody: seeded.longBody,
          todayBody: seeded.todayBody,
        });
        if (mutation === "direct-link-missing") {
          assert.equal(
            snapshot(ctx, "b", seeded.bTemp).status,
            "ok",
            "A 的 link 缺失不应连带 B 的副本",
          );
        }
      } else {
        assertUnavailableWithoutWrites(ctx, "b", seeded.bTemp);
        assert.equal(snapshot(ctx, "a", seeded.aTemp).status, "ok");
        await assertTemporaryExcludedAndChatRestores(ctx, {
          holder: "b",
          entry: seeded.bTemp,
          longEntry: seeded.bLong,
          longBody: seeded.longBody,
          todayBody: seeded.todayBody,
        });
      }
    });
  }
});

test("POL-SEMOP-001d/S13 失效 current 不参与复用/歧义，选中失效临时直接拒绝", async (t) => {
  await t.test("失效的同类T不制造歧义", async (t2) => {
    const ctx = await setupContext(t2);
    const pair = await seedSameFactPairForSource(ctx);
    await tellTodayForSource(ctx, pair.aConversation, {
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      needle: "我喜欢咖啡",
      excerpt: "我今天想喝茶",
      evidence: "请帮我改过来",
    });
    const aEntry = temporaryEntryOf(ctx.store, "a");
    const bEntry = temporaryEntryOf(ctx.store, "b");
    assert.ok(aEntry && bEntry, "A/B 应共有合法今日理解");
    const validTemporaryId = aEntry.factIdentityId;
    const longIdentityId = pair.aLong.factIdentityId;
    const expiresAt = aEntry.expiresAt;

    // A 先自己删除今日理解，使查找不再有自己的当前条目优先。
    ctx.store.memory.forget({
      characterId: "a",
      entryId: aEntry.id,
      expectedVersion: aEntry.version,
      scope: "self",
    });
    // 另一个 T 有活跃行和同一长期 link，但直接来源的消息不存在，因此不可用。
    const invalidTemporaryId = crypto.randomUUID();
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)")
        .run(invalidTemporaryId, ctx.nowMs());
      db.prepare(`
        INSERT INTO memory_entries (
          id, character_id, fact_key, fact_identity_id, origin_character_id,
          derived_from_entry_id, kind, body, trust, source_kind, importance,
          expires_at, source_id, source_version, version, created_at, updated_at
        ) VALUES (?, 'b', ?, ?, 'b', NULL, 'preference', ?, 'stated', 'user', 60, ?,
                  ?, 1, 1, ?, ?)
      `).run(
        crypto.randomUUID(),
        `${pair.bLong.factKey}.current.${pair.bLong.id}.invalid`,
        invalidTemporaryId,
        "用户今天想喝普洱",
        expiresAt,
        `chat-current:${pair.bLong.id}:${ctx.nowMs()}:chat:missing-invalid-message`,
        ctx.nowMs(),
        ctx.nowMs(),
      );
      db.prepare(`
        INSERT INTO memory_temporary_links
          (temp_identity_id, long_identity_id, holder_character_id, expires_at)
        VALUES (?, ?, 'b', ?)
      `).run(invalidTemporaryId, longIdentityId, expiresAt);
    });

    // 新的明确今日陈述应复用唯一有效的 T，而不是因失效行触发歧义。
    await tellTodayForSource(ctx, pair.aConversation, {
      text: "不是茶，我今天想喝花茶，请帮我改过来。",
      needle: "我喜欢咖啡",
      excerpt: "我今天想喝花茶",
      evidence: "请帮我改过来",
    });
    const aAfter = temporaryEntryOf(ctx.store, "a");
    assert.ok(aAfter);
    assert.equal(aAfter.factIdentityId, validTemporaryId, "应复用唯一有效 T");
    assert.equal(temporaryRowsOfHolder(ctx, "a").length, 1);
    const invalidHits = ctx.store.memory.searchMemories({
      characterId: "b",
      query: "用户今天想喝普洱",
    });
    assert.equal(invalidHits.some((entry) => entry.factIdentityId === invalidTemporaryId), false);
  });

  await t.test("唯一T全部失效时新建T而不复用", async (t2) => {
    const ctx = await setupContext(t2);
    const pair = await seedSameFactPairForSource(ctx);
    await tellTodayForSource(ctx, pair.aConversation, {
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      needle: "我喜欢咖啡",
      excerpt: "我今天想喝茶",
      evidence: "请帮我改过来",
    });
    const aBefore = temporaryEntryOf(ctx.store, "a");
    const bBefore = temporaryEntryOf(ctx.store, "b");
    assert.ok(aBefore && bBefore);
    const oldTemporaryId = aBefore.factIdentityId;
    const parsed = parseTemporarySource(aBefore.sourceId);
    assert.ok(parsed && parsed.kind === "direct");
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
        .run("完全不同的原话", parsed.messageSourceId.slice("chat:".length));
    });
    assertUnavailableWithoutWrites(ctx, "a", aBefore);
    assertUnavailableWithoutWrites(ctx, "b", bBefore);

    await tellTodayForSource(ctx, pair.aConversation, {
      text: "不是茶，我今天想喝白茶，请帮我改过来。",
      needle: "我喜欢咖啡",
      excerpt: "我今天想喝白茶",
      evidence: "请帮我改过来",
    });
    const aRows = temporaryRowsOfHolder(ctx, "a");
    const renewed = aRows.find((row) => row.fact_identity_id !== oldTemporaryId);
    assert.ok(renewed, "旧 T 全部失效时应新建 T");
    assert.equal(snapshot(ctx, "a", renewed).status, "ok");
    assert.match(renewed.source_id, /^chat-current:/u);
    assert.equal(aRows.some((row) => row.fact_identity_id === oldTemporaryId), true, "旧失效行保留但不复用");
  });

  await t.test("直接选中失效临时理解被拒绝且零写", async (t2) => {
    const ctx = await setupContext(t2);
    const pair = await seedSameFactPairForSource(ctx);
    await tellTodayForSource(ctx, pair.aConversation, {
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      needle: "我喜欢咖啡",
      excerpt: "我今天想喝茶",
      evidence: "请帮我改过来",
    });
    const aEntry = temporaryEntryOf(ctx.store, "a");
    assert.ok(aEntry);
    const parsed = parseTemporarySource(aEntry.sourceId);
    assert.ok(parsed && parsed.kind === "direct");
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
        .run("完全不同的原话", parsed.messageSourceId.slice("chat:".length));
    });
    const before = sourceState(ctx);
    assert.throws(
      () => ctx.store.memory.applyTemporaryUnderstanding({
        characterId: "a",
        entryId: aEntry.id,
        expectedVersion: aEntry.version,
        body: "用户今天想喝花茶",
        trust: "stated",
        expiresAt: aEntry.expiresAt,
        sourceId: "chat:selected-invalid",
        nowMs: ctx.nowMs(),
      }),
      (error) => error?.code === "TEMPORARY_SOURCE_UNAVAILABLE",
    );
    assert.deepEqual(sourceState(ctx), before, "选中失效临时来源时不应写入任何内容");
  });
});

/* 2c-1b 返修：临时条目转换为新的 direct/copy 时，持久来源归属必须与
   derivation 同步，不能只改内存对象。否则第二发起者仍是旧 origin，
   其他 holder 的副本也会按旧 origin 判失效。 */
test("POL-SEMOP-001d/S14 B成为第二发起者后A/B/C持久归属一致，A再发起回改", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store, "a");
  const bConversation = openConversation(ctx.store, "b");
  const seeded = await seedTodayForSource(ctx, aConversation);
  assert.ok(seeded.aEntry && seeded.bEntry);
  const temporaryIdentityId = seeded.aEntry.factIdentityId;
  const longIdentityId = seeded.longTerm.factIdentityId;
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: seeded.aEntry.id, expectedVersion: seeded.aEntry.version }],
  });
  const cBefore = temporaryEntryByIdentity(ctx.store, "c", temporaryIdentityId);
  assert.ok(cBefore, "C 应有显式转告的今日副本");
  assert.equal(relationEdgesToEntry(ctx, cBefore.id)[0]?.from_entry_id, seeded.aEntry.id);

  /* B 是身份同步副本，现在由 B 明确更改今日状态。 */
  await correctViaChat(ctx, bConversation, "不是茶，我今天想喝奶茶，请帮我改过来。", {
    needle: "我今天想喝茶",
    excerpt: "我今天想喝奶茶",
    evidence: "请帮我改过来",
  }, "b");

  const aAfter = temporaryEntryByIdentity(ctx.store, "a", temporaryIdentityId);
  const bAfter = temporaryEntryByIdentity(ctx.store, "b", temporaryIdentityId);
  const cAfter = temporaryEntryByIdentity(ctx.store, "c", temporaryIdentityId);
  assert.ok(aAfter && bAfter && cAfter, "三方仍应在同一 T");
  assert.equal(aAfter.factIdentityId, temporaryIdentityId);
  assert.equal(cAfter.factIdentityId, temporaryIdentityId);
  assert.match(bAfter.sourceId, /^chat-current:/u);
  assert.match(aAfter.sourceId, /^chat-current-copy:/u);
  assert.match(cAfter.sourceId, /^chat-current-copy:/u);

  /* 数据库列与 derivation 必须一起指向 B；旧 A 来源不能残留。 */
  const persistedB = persistedTemporaryRow(ctx, bAfter.id);
  assert.equal(persistedB.origin_character_id, "b");
  assert.equal(persistedB.derived_from_entry_id, null);
  assert.equal(derivationRow(ctx, bAfter.id), undefined);
  for (const [holder, entry] of [["a", aAfter], ["c", cAfter]]) {
    const persisted = persistedTemporaryRow(ctx, entry.id);
    assert.equal(persisted.origin_character_id, "b", `${holder} 的持久 origin 应为 B`);
    assert.equal(persisted.derived_from_entry_id, bAfter.id, `${holder} 的持久父条目应为 B 当前`);
    const derivation = derivationRow(ctx, entry.id);
    assert.equal(derivation.parent_entry_id, bAfter.id);
    assert.equal(derivation.origin_character_id, "b");
    assert.equal(derivation.narrator_character_id, "b");
    assert.equal(derivation.source_id, entry.sourceId);
    // 显式 relay 的旧边若保留，必须与新 derivation 一致；不能留下矛盾边。
    for (const edge of relationEdgesToEntry(ctx, entry.id)) {
      assert.equal(edge.from_entry_id, derivation.parent_entry_id);
    }
  }
  assert.equal(snapshot(ctx, "a", aAfter).status, "ok");
  assert.equal(snapshot(ctx, "b", bAfter).status, "ok");
  assert.equal(snapshot(ctx, "c", cAfter).status, "ok");
  assert.equal(snapshot(ctx, "a", aAfter).via, "temporary_propagation");
  assert.equal(snapshot(ctx, "c", cAfter).via, "temporary_propagation");
  assert.equal(snapshot(ctx, "a", aAfter).sourceCharacterId, "b");
  assert.equal(snapshot(ctx, "c", cAfter).sourceCharacterId, "b");

  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "a", query: seeded.aEntry.body })
      .some((entry) => entry.factIdentityId === temporaryIdentityId),
    false,
  );
  for (const holder of ["a", "b"]) {
    const bodies = Object.values(
      ctx.store.memory.buildContext({ characterId: holder }).sections,
    ).flat().map((entry) => entry.body);
    assert.ok(bodies.includes(bAfter.body), `${holder} 上下文应使用 B 的新今日正文`);
    assert.equal(bodies.includes(seeded.aEntry.body), false);
    assert.equal(bodies.includes("我喜欢咖啡"), false);
  }
  for (const holder of ["a", "b"]) {
    const system = await memorySystemContent(ctx, openConversation(ctx.store, holder), holder);
    assert.ok(system.includes(bAfter.body), `${holder} 真实聊天应使用新今日正文`);
    assert.equal(system.includes(seeded.aEntry.body), false);
    assert.equal(system.includes("我喜欢咖啡"), false);
  }

  /* A 再发起改口：持久归属回到 A，B/C 同步，仍全部有效。 */
  await correctViaChat(ctx, aConversation, "不是奶茶，我今天想喝花茶，请帮我改过来。", {
    needle: "我今天想喝奶茶",
    excerpt: "我今天想喝花茶",
    evidence: "请帮我改过来",
  });
  const aBack = temporaryEntryByIdentity(ctx.store, "a", temporaryIdentityId);
  const bBack = temporaryEntryByIdentity(ctx.store, "b", temporaryIdentityId);
  const cBack = temporaryEntryByIdentity(ctx.store, "c", temporaryIdentityId);
  assert.ok(aBack && bBack && cBack);
  assert.match(aBack.sourceId, /^chat-current:/u);
  assert.equal(persistedTemporaryRow(ctx, aBack.id).origin_character_id, "a");
  assert.equal(persistedTemporaryRow(ctx, aBack.id).derived_from_entry_id, null);
  for (const entry of [bBack, cBack]) {
    assert.equal(persistedTemporaryRow(ctx, entry.id).origin_character_id, "a");
    assert.equal(persistedTemporaryRow(ctx, entry.id).derived_from_entry_id, aBack.id);
    const derivation = derivationRow(ctx, entry.id);
    assert.equal(derivation.parent_entry_id, aBack.id);
    assert.equal(derivation.origin_character_id, "a");
    assert.equal(derivation.narrator_character_id, "a");
    assert.equal(snapshot(ctx, entry.characterId, entry).status, "ok");
    for (const edge of relationEdgesToEntry(ctx, entry.id)) {
      assert.equal(edge.from_entry_id, derivation.parent_entry_id);
    }
  }
  assert.equal(snapshot(ctx, "a", aBack).status, "ok");
  assert.equal(snapshot(ctx, "a", aBack).via, "current_temporary");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  assert.ok(
    Object.values(ctx.store.memory.buildContext({ characterId: "b" }).sections)
      .flat().some((entry) => entry.body === bBack.body),
  );
  const systemB = await memorySystemContent(ctx, bConversation, "b");
  assert.ok(systemB.includes(aBack.body));
  assert.equal(systemB.includes(bAfter.body), false);
  assert.equal(systemB.includes("我喜欢咖啡"), false);
});

/* 2c-1b 返修：编辑来源的 parent/derived 关系不能靠“parent 行不存在就跳过”
   通过；变异后必须 unavailable，并且 search/context 恢复长期。 */
test("POL-SEMOP-001d/S15 编辑来源 parent/derived 变异失效，真实父删除仍有效", async (t) => {
  const mutations = [
    "derived-from-null",
    "parent-unknown",
    "derived-from-mismatch",
    "edge-parent-mismatch",
  ];
  for (const mutation of mutations) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const conversation = openConversation(ctx.store);
      const seeded = await seedTodayForSource(ctx, conversation);
      assert.ok(seeded.bEntry);
      ctx.store.memory.correct({
        characterId: "b",
        entryId: seeded.bEntry.id,
        expectedVersion: seeded.bEntry.version,
        body: "用户今天想喝奶茶",
      });
      const aEdited = ctx.store.memory.listMemories("a")
        .find((entry) => entry.id === seeded.aEntry.id);
      const bEdited = ctx.store.memory.listMemories("b")
        .find((entry) => entry.id === seeded.bEntry.id);
      assert.equal(snapshot(ctx, "b", bEdited).status, "ok");
      withDatabase(ctx.store.dbPath, (db) => {
        if (mutation === "derived-from-null") {
          db.prepare("UPDATE memory_entries SET derived_from_entry_id = NULL WHERE id = ?")
            .run(bEdited.id);
        } else if (mutation === "parent-unknown") {
          db.prepare("UPDATE memory_derivations SET parent_entry_id = 'missing-parent' WHERE entry_id = ?")
            .run(bEdited.id);
        } else if (mutation === "derived-from-mismatch") {
          db.prepare("UPDATE memory_entries SET derived_from_entry_id = ? WHERE id = ?")
            .run(entryOf(ctx.store, "b", "pref.coffee").id, bEdited.id);
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO memory_fact_relation_edges
              (from_entry_id, to_entry_id, kind, created_at)
            VALUES (?, ?, 'relay', ?)
          `).run(entryOf(ctx.store, "b", "pref.coffee").id, bEdited.id, ctx.nowMs());
        }
      });
      assertUnavailableWithoutWrites(ctx, "b", bEdited);
      assert.equal(snapshot(ctx, "a", aEdited).status, "ok", "A 的编辑来源不应被连带");
      await assertTemporaryExcludedAndChatRestores(ctx, {
        holder: "b",
        entry: bEdited,
        longEntry: entryOf(ctx.store, "b", "pref.coffee"),
        longBody: "我喜欢咖啡",
        todayBody: "用户今天想喝奶茶",
      });
    });
  }

  await t.test("真实父删除后B编辑仍有效且A self控制不取消B", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    ctx.store.memory.correct({
      characterId: "b",
      entryId: seeded.bEntry.id,
      expectedVersion: seeded.bEntry.version,
      body: "用户今天想喝奶茶",
    });
    const aEdited = ctx.store.memory.listMemories("a")
      .find((entry) => entry.id === seeded.aEntry.id);
    const bEdited = ctx.store.memory.listMemories("b")
      .find((entry) => entry.id === seeded.bEntry.id);
    ctx.store.memory.forget({
      characterId: "a",
      entryId: aEdited.id,
      expectedVersion: aEdited.version,
      scope: "self",
    });
    assert.equal(
      ctx.store.memory.listMemories("b").some((entry) => entry.id === bEdited.id),
      true,
    );
    const bSnapshot = snapshot(ctx, "b", bEdited);
    assert.equal(bSnapshot.status, "ok");
    assert.equal(bSnapshot.temporarySourceStatus, "removed");
    await assertValidTemporaryContext(ctx, {
      holder: "b",
      entry: bEdited,
      todayBody: "用户今天想喝奶茶",
      longBody: "我喜欢咖啡",
    });
  });
});

/* 2c-1b 返修：编辑不是一次性状态。编辑后 A/B 再次聊天改口、以及 origin
   current 已删除时 B 连续编辑并转告，都必须保持有效。 */
test("POL-SEMOP-001d/S16 编辑后再次改口与无origin连续编辑仍有效", async (t) => {
  await t.test("编辑后A/B再次聊天改口", async (t2) => {
    const ctx = await setupContext(t2);
    const aConversation = openConversation(ctx.store, "a");
    const bConversation = openConversation(ctx.store, "b");
    const seeded = await seedTodayForSource(ctx, aConversation);
    ctx.store.memory.correct({
      characterId: "b",
      entryId: seeded.bEntry.id,
      expectedVersion: seeded.bEntry.version,
      body: "用户今天想喝奶茶",
    });
    const aEdited = ctx.store.memory.listMemories("a")
      .find((entry) => entry.id === seeded.aEntry.id);
    const bEdited = ctx.store.memory.listMemories("b")
      .find((entry) => entry.id === seeded.bEntry.id);
    const temporaryIdentityId = aEdited.factIdentityId;
    assert.equal(snapshot(ctx, "a", aEdited).status, "ok");
    assert.equal(snapshot(ctx, "b", bEdited).status, "ok");

    await correctViaChat(ctx, aConversation, "不是奶茶，我今天想喝花茶，请帮我改过来。", {
      needle: "用户今天想喝奶茶",
      excerpt: "我今天想喝花茶",
      evidence: "请帮我改过来",
    });
    await correctViaChat(ctx, bConversation, "不是花茶，我今天想喝乌龙茶，请帮我改过来。", {
      needle: "我今天想喝花茶",
      excerpt: "我今天想喝乌龙茶",
      evidence: "请帮我改过来",
    }, "b");

    const aAfter = temporaryEntryByIdentity(ctx.store, "a", temporaryIdentityId);
    const bAfter = temporaryEntryByIdentity(ctx.store, "b", temporaryIdentityId);
    assert.ok(aAfter && bAfter);
    assert.equal(aAfter.factIdentityId, temporaryIdentityId);
    assert.equal(persistedTemporaryRow(ctx, aAfter.id).origin_character_id, "b");
    assert.equal(persistedTemporaryRow(ctx, bAfter.id).origin_character_id, "b");
    assert.equal(persistedTemporaryRow(ctx, aAfter.id).derived_from_entry_id, bAfter.id);
    assert.equal(persistedTemporaryRow(ctx, bAfter.id).derived_from_entry_id, null);
    assert.equal(snapshot(ctx, "a", aAfter).status, "ok");
    assert.equal(snapshot(ctx, "b", bAfter).status, "ok");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
    for (const holder of ["a", "b"]) {
      const bodies = Object.values(
        ctx.store.memory.buildContext({ characterId: holder }).sections,
      ).flat().map((entry) => entry.body);
      assert.ok(bodies.includes(bAfter.body));
      assert.equal(bodies.includes("用户今天想喝奶茶"), false);
      assert.equal(bodies.includes("我喜欢咖啡"), false);
    }
    for (const holder of ["a", "b"]) {
      const system = await memorySystemContent(ctx, openConversation(ctx.store, holder), holder);
      assert.ok(system.includes(bAfter.body));
      assert.equal(system.includes("用户今天想喝奶茶"), false);
      assert.equal(system.includes("我喜欢咖啡"), false);
    }
  });

  await t.test("A self删除current后B连续编辑并转告仍有效", async (t2) => {
    const ctx = await setupContext(t2);
    const conversation = openConversation(ctx.store);
    const seeded = await seedTodayForSource(ctx, conversation);
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aEntry.id,
      expectedVersion: seeded.aEntry.version,
      scope: "self",
    });
    assert.equal(temporaryEntryOf(ctx.store, "a"), null);
    const bFirst = temporaryEntryOf(ctx.store, "b");
    assert.ok(bFirst);
    ctx.store.memory.correct({
      characterId: "b",
      entryId: bFirst.id,
      expectedVersion: bFirst.version,
      body: "用户今天想喝奶茶",
    });
    const bSecond = temporaryEntryOf(ctx.store, "b");
    assert.equal(snapshot(ctx, "b", bSecond).status, "ok");
    // origin current 已删除时再次编辑：来源锚不变，但版本必须继续推进且不误阻断。
    const firstEditSource = bSecond.sourceId;
    ctx.store.memory.correct({
      characterId: "b",
      entryId: bSecond.id,
      expectedVersion: bSecond.version,
      body: "用户今天想喝红茶",
    });
    const bThird = temporaryEntryOf(ctx.store, "b");
    assert.equal(bThird.sourceId, firstEditSource, "origin 不存在时两次编辑来源相同");
    assert.equal(bThird.version, bSecond.version + 1);
    assert.equal(bThird.body, "用户今天想喝红茶");
    const thirdSnapshot = snapshot(ctx, "b", bThird);
    assert.equal(thirdSnapshot.status, "ok");
    assert.equal(thirdSnapshot.temporarySourceStatus, "removed");
    assert.equal(thirdSnapshot.edited, true);

    const relayed = ctx.store.memory.relay({
      fromCharacterId: "b",
      toCharacterId: "c",
      entries: [{ entryId: bThird.id, expectedVersion: bThird.version }],
    });
    assert.equal(relayed.shared[0].alreadyHeld, false);
    const cEntry = temporaryEntryOf(ctx.store, "c");
    assert.ok(cEntry);
    const cSnapshot = snapshot(ctx, "c", cEntry);
    assert.equal(cSnapshot.status, "ok");
    assert.equal(cSnapshot.edited, true);
    assert.equal(cSnapshot.sourceCharacterId, "a");
    assert.equal(cSnapshot.relayFrom, "b");
  });
});

/* S03m 2c-2a（§13 已批准方案）多 L 领域切片：T 仍为当前理解组，L 是长期
   fact identity。阶段 2 尚未实现，下列 SQL 夹具明确标注为“阶段 2 准备状态”，
   只构造与真实 store/derivation/link/source 一致的合法多 L 数据；核心
   store/memory/source-context 与真实 SQLite 仍是唯一业务入口。 */
function entryLinkTableExists(ctx) {
  return withDatabase(ctx.store.dbPath, (db) => Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_temporary_entry_links'",
  ).get()));
}

function entryLinksOf(ctx, entryId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT * FROM memory_temporary_entry_links WHERE entry_id = ?",
  ).get(entryId) ?? null);
}

function entryLinkRowsOfIdentity(ctx, tempIdentityId, holderCharacterId) {
  return withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT * FROM memory_temporary_entry_links
    WHERE temp_identity_id = ? AND holder_character_id = ?
    ORDER BY entry_id ASC
  `).all(tempIdentityId, holderCharacterId));
}

function addLongForMultiL(ctx, characterId, factKey, body) {
  ctx.store.memory.remember({
    characterId,
    factKey,
    body,
    kind: "preference",
    sourceId: `seed-${characterId}-${factKey}`,
  });
  const entry = entryOf(ctx.store, characterId, factKey);
  assert.ok(entry, `长期夹具 ${factKey} 应存在`);
  return entry;
}

/* 明确标注：阶段 2 尚未实现，本夹具只模拟“已批准方案会在既有 T 内新增
   holder+候选 L 的 current”这一状态。它不是阶段 2 的核验证据，也不能代替
   proof/API 覆盖。 */
function insertPreparedMultiLMember(ctx, {
  holder, ownLong, rootLong, originCurrent, body, label,
}) {
  const originParsed = parseTemporarySource(originCurrent.sourceId);
  assert.ok(originParsed && originParsed.kind === "direct", "多 L 夹具必须以 direct current 为来源");
  assert.equal(originParsed.originLongEntryId, rootLong.id, "root 锚必须等于 origin current 的长期来源");
  const tempIdentityId = originCurrent.factIdentityId;
  const suffix = crypto.randomUUID().slice(0, 8);
  const entryId = `fixture-${holder}-${label}-${suffix}`;
  const sourceId = copiedTemporarySource({
    originLongEntryId: rootLong.id,
    originLongVersion: rootLong.version,
    originCurrentEntryId: originCurrent.id,
    originCurrentVersion: originCurrent.version,
    holderLongEntryId: ownLong.id,
    holderLongVersion: ownLong.version,
    messageSourceId: originParsed.messageSourceId,
  });
  const factKey = `${temporaryFactKey(ownLong.factKey, ownLong.id)}.${suffix}`;
  const nowMs = ctx.nowMs();
  const hasEntryLinks = entryLinkTableExists(ctx);
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare(`
      INSERT INTO memory_entries (
        id, character_id, fact_key, fact_identity_id, origin_character_id,
        derived_from_entry_id, kind, body, trust, source_kind, importance,
        expires_at, source_id, source_version, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stated', 'user', ?, ?, ?, 1, 1, ?, ?)
    `).run(
      entryId, holder, factKey, tempIdentityId, originCurrent.characterId,
      originCurrent.id, originCurrent.kind, body, originCurrent.importance,
      originCurrent.expiresAt, sourceId, nowMs, nowMs,
    );
    const tokens = tokenizeForIndex(body);
    db.prepare("INSERT INTO memory_fts (entry_id, char_tokens, segment_tokens) VALUES (?, ?, ?)")
      .run(entryId, tokens.charTokens, tokens.segmentTokens);
    db.prepare(`
      INSERT INTO memory_derivations (
        entry_id, parent_entry_id, origin_character_id, narrator_character_id,
        source_id, source_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      entryId, originCurrent.id, originCurrent.characterId,
      originCurrent.characterId, sourceId, nowMs,
    );
    db.prepare(`
      INSERT OR IGNORE INTO memory_temporary_links
        (temp_identity_id, long_identity_id, holder_character_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      tempIdentityId, ownLong.factIdentityId, holder, originCurrent.expiresAt,
    );
    // 旧生产没有新表时仍写旧控制关系，用于取得有效 AssertionError 基线。
    if (hasEntryLinks) {
      db.prepare(`
        INSERT INTO memory_temporary_entry_links (
          entry_id, temp_identity_id, holder_character_id, expires_at,
          long_identity_id, root_identity_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entryId, tempIdentityId, holder, originCurrent.expiresAt,
        ownLong.factIdentityId, rootLong.factIdentityId,
      );
    }
  });
  const entry = ctx.store.memory.listMemories(holder).find((item) => item.id === entryId);
  assert.ok(entry, "多 L 夹具条目应可读取");
  return entry;
}

/* 真实建立多 L 来源：先创建 A/B 长期事实与 B 的第二锚，用既有 associateFacts
   合并同 identity（会递增版本），再发起今日临时理解；最后按已批准阶段 2 的
   结构补一条 B 的独立 L current。这样 alias、holder 版本与 link 全部自洽，
   不依赖“同文新 factKey 自动同 identity”这一产品刻意不提供的假设。 */
async function seedMultiLSourcePair(ctx) {
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await rememberViaChat(ctx, aConversation, "我喜欢咖啡。", [
    { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference", trust: "stated", evidence: "我喜欢咖啡" },
  ]);
  const aLongBefore = entryOf(ctx.store, "a", "pref.coffee");
  ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: aLongBefore.id, expectedVersion: aLongBefore.version }],
  });
  const bLongBefore = entryOf(ctx.store, "b", "pref.coffee");
  // 让第二锚的 created_at 明确晚于 relay 锚，双锚确定性选择才可断言。
  ctx.setNow(ctx.nowMs() + 1000);
  const secondBefore = addLongForMultiL(ctx, "b", "pref.coffee.anchor2", "用户喜欢咖啡");
  ctx.store.memory.associateFacts({
    left: { entryId: bLongBefore.id, expectedVersion: bLongBefore.version },
    right: { entryId: secondBefore.id, expectedVersion: secondBefore.version },
  });
  const aLong = entryOf(ctx.store, "a", "pref.coffee");
  const bLong = entryOf(ctx.store, "b", "pref.coffee");
  const secondAnchor = entryOf(ctx.store, "b", "pref.coffee.anchor2");
  assert.equal(aLong.factIdentityId, bLong.factIdentityId);
  assert.equal(secondAnchor.factIdentityId, bLong.factIdentityId);

  const independent = addLongForMultiL(ctx, "b", "pref.tea.independent", "用户平时爱喝茶");
  assert.notEqual(independent.factIdentityId, bLong.factIdentityId);

  // 关联完成后才发起今日理解；B 已证明同一 L 的两个锚不会各建一条 current。
  await correctViaChat(ctx, aConversation, "不是咖啡，我今天想喝茶，请帮我改过来。", {
    needle: "我喜欢咖啡",
    excerpt: "我今天想喝茶",
    evidence: "请帮我改过来",
  });
  const aTemp = temporaryEntryOf(ctx.store, "a");
  const bTemp = temporaryEntryOf(ctx.store, "b");
  assert.ok(aTemp, "A 应有今日临时理解");
  assert.ok(bTemp, "B 应同步今日临时理解");
  // 加入独立 L 之前，单 L 的 A/B 今日理解必须已经合法；否则是夹具 ERROR。
  assert.equal(snapshot(ctx, "a", aTemp).status, "ok", "多 L 夹具的 A 单 L 基线应合法");
  assert.equal(snapshot(ctx, "b", bTemp).status, "ok", "多 L 夹具的 B 单 L 基线应合法");
  const member = insertPreparedMultiLMember(ctx, {
    holder: "b",
    ownLong: independent,
    rootLong: aLong,
    originCurrent: aTemp,
    body: aTemp.body,
    label: "independent-l3",
  });
  return {
    aConversation,
    bConversation,
    aLong,
    bLong,
    secondAnchor,
    independent,
    member,
    aTemp,
    bTemp,
    todayBody: aTemp.body,
    longBody: "我喜欢咖啡",
  };
}

function addAIndependentPreparedMember(ctx, seeded) {
  const independent = addLongForMultiL(ctx, "a", "pref.tea.a-independent", "用户平时爱喝红茶");
  const member = insertPreparedMultiLMember(ctx, {
    holder: "a",
    ownLong: independent,
    rootLong: seeded.aLong,
    originCurrent: seeded.aTemp,
    body: seeded.aTemp.body,
    label: "a-independent",
  });
  return { independent, member };
}

function latestChatSourceId(ctx, characterId) {
  return withDatabase(ctx.store.dbPath, (db) => {
    const row = db.prepare(`
      SELECT id FROM chat_messages
      WHERE character_id = ? AND role = 'user'
      ORDER BY seq DESC, id DESC LIMIT 1
    `).get(characterId);
    assert.ok(row, "应存在刚发出的聊天消息");
    return `chat:${row.id}`;
  });
}

async function issueTodayStatement(ctx, conversation, characterId, {
  entryId, expectedVersion, body, text, expiresAt,
}) {
  await rememberViaChat(ctx, conversation, text, [], characterId);
  return ctx.store.memory.applyTemporaryUnderstanding({
    characterId,
    entryId,
    expectedVersion,
    body,
    trust: "stated",
    expiresAt,
    sourceId: latestChatSourceId(ctx, characterId),
    nowMs: ctx.nowMs(),
  });
}

function temporaryEntriesOf(ctx, characterId, tempIdentityId) {
  return ctx.store.memory.listMemories(characterId).filter((entry) =>
    entry.expiresAt !== null && entry.factIdentityId === tempIdentityId);
}

function assertMultiLState(state) {
  const tables = ["memory_entries", "memory_derivations", "memory_temporary_links"];
  const snapshotState = withDatabase(state.store.dbPath, (db) => ({
    ...Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])),
    entryLinks: db.prepare(
      "SELECT * FROM memory_temporary_entry_links ORDER BY rowid",
    ).all(),
    sourceControls: db.prepare(
      "SELECT * FROM memory_source_controls ORDER BY rowid",
    ).all(),
    forgetControls: db.prepare(
      "SELECT * FROM memory_forget_identity_controls ORDER BY rowid",
    ).all(),
    shareControls: db.prepare(
      "SELECT * FROM memory_share_identity_controls ORDER BY rowid",
    ).all(),
  }));
  return snapshotState;
}

test("POL-SEMOP-001d/D2+D11 多 L 阶段1：全部 L 成员更新、双锚不重复、上下文去重", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  const tempIdentityId = prepared.member.factIdentityId;

  // B 从自己的 L3 current 再发起：只更新既有 T，不新建 T，不改长期 identity。
  await issueTodayStatement(ctx, bConversation, "b", {
    entryId: prepared.member.id,
    expectedVersion: prepared.member.version,
    body: "我今天想喝乌龙茶",
    text: "我今天想喝乌龙茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const bEntries = temporaryEntriesOf(ctx, "b", tempIdentityId);
  const aEntries = temporaryEntriesOf(ctx, "a", tempIdentityId);
  assert.equal(new Set(bEntries.map((entry) => entry.id)).size, bEntries.length);
  assert.equal(bEntries.length, 2, "B 的 L1 与 L3 各保留一条 current，不重复");
  assert.equal(aEntries.length, 1);
  const bOwnIdentity = prepared.independent.factIdentityId;
  const bL1 = bEntries.find((entry) => entry.id !== prepared.member.id);
  const bL3 = bEntries.find((entry) => entry.id === prepared.member.id);
  assert.ok(bL1 && bL3);
  assert.equal(entryLinksOf(ctx, bL1.id).long_identity_id, seeded.bLong.factIdentityId);
  assert.equal(entryLinksOf(ctx, bL3.id).long_identity_id, bOwnIdentity);
  assert.equal(entryLinksOf(ctx, bL3.id).root_identity_id, bOwnIdentity);
  assert.equal(entryLinksOf(ctx, bL1.id).root_identity_id, bOwnIdentity);
  assert.equal(entryLinksOf(ctx, aEntries[0].id).long_identity_id, seeded.aLong.factIdentityId);
  assert.equal(entryLinksOf(ctx, aEntries[0].id).root_identity_id, bOwnIdentity);
  for (const entry of [...aEntries, ...bEntries]) {
    assert.equal(entry.body, "我今天想喝乌龙茶");
  }
  const bL1Snapshot = snapshot(ctx, "b", bL1);
  assert.equal(bL1Snapshot.status, "ok");
  assert.equal(bL1Snapshot.sourceAnchorIdentityId, bOwnIdentity);
  assert.equal(bL1Snapshot.holderLongIdentityId, seeded.bLong.factIdentityId);
  // 同 identity 的第二锚不会生成第二条 current，holder 锚确定性取最早条目。
  assert.equal(bL1Snapshot.holderAnchorEntryId, seeded.bLong.id);
  const bL3Snapshot = snapshot(ctx, "b", bL3);
  assert.equal(bL3Snapshot.status, "ok");
  assert.equal(bL3Snapshot.direct, true);
  assert.equal(bL3Snapshot.sourceAnchorIdentityId, bOwnIdentity);
  assert.equal(bL3Snapshot.holderLongIdentityId, bOwnIdentity);
  const aSnapshot = snapshot(ctx, "a", aEntries[0]);
  assert.equal(aSnapshot.status, "ok");
  assert.equal(aSnapshot.sourceAnchorIdentityId, bOwnIdentity);
  assert.equal(aSnapshot.holderLongIdentityId, seeded.aLong.factIdentityId);

  // 长期正文与 identity 不被改写。
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.tea.independent").body, "用户平时爱喝茶");
  // 同 T 同 holder 同正文同到期只注入一次，并抑制 B 的两个 own L。
  const bBodies = contextBodies(ctx, "b");
  assert.equal(bBodies.filter((body) => body === "我今天想喝乌龙茶").length, 1);
  assert.equal(bBodies.includes("用户喜欢咖啡"), false);
  assert.equal(bBodies.includes("用户平时爱喝茶"), false);
  const aBodies = contextBodies(ctx, "a");
  assert.equal(aBodies.filter((body) => body === "我今天想喝乌龙茶").length, 1);
  assert.equal(aBodies.includes("用户喜欢咖啡"), false);
});

test("POL-SEMOP-001d/D2 exclusive：保留本人全部 L，root 版本同步，share/relay 零写", async (t) => {
  const ctx = await setupContext(t);
  const bConversation = openConversation(ctx.store, "b");
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  const tempIdentityId = prepared.member.factIdentityId;
  await issueTodayStatement(ctx, bConversation, "b", {
    entryId: prepared.member.id,
    expectedVersion: prepared.member.version,
    body: "我今天想喝乌龙茶",
    text: "我今天想喝乌龙茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const before = temporaryEntriesOf(ctx, "b", tempIdentityId);
  const rootEntry = before.find((entry) => entry.id === prepared.member.id);
  const copyEntry = before.find((entry) => entry.id !== prepared.member.id);
  assert.ok(rootEntry && copyEntry);

  const result = ctx.store.memory.keepExclusive({
    characterId: "b",
    entryId: rootEntry.id,
    expectedVersion: rootEntry.version,
  });
  assert.equal(result.clearedCharacters.includes("a"), true);
  assert.equal(temporaryEntriesOf(ctx, "a", tempIdentityId).length, 0);
  const retained = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(retained.length, 2, "exclusive 保留本人全部 L current");
  const retainedRoot = retained.find((entry) => entry.id === rootEntry.id);
  const retainedCopy = retained.find((entry) => entry.id === copyEntry.id);
  assert.equal(retainedRoot.version, rootEntry.version + 1);
  assert.equal(retainedCopy.version, copyEntry.version + 1);
  const copyParsed = parseTemporarySource(retainedCopy.sourceId);
  assert.equal(copyParsed.originCurrentEntryId, retainedRoot.id);
  assert.equal(copyParsed.originCurrentVersion, retainedRoot.version);
  const copyDerivation = derivationRow(ctx, retainedCopy.id);
  assert.equal(copyDerivation.parent_entry_id, retainedRoot.id);
  assert.equal(copyDerivation.source_id, retainedCopy.sourceId);
  assert.equal(snapshot(ctx, "b", retainedRoot).status, "ok");
  assert.equal(snapshot(ctx, "b", retainedCopy).status, "ok");
  assert.equal(contextBodies(ctx, "b").filter((body) => body === retainedRoot.body).length, 1);
  const hits = ctx.store.memory.searchMemories({ characterId: "b", query: retainedRoot.body });
  assert.equal(hits.filter((entry) => retained.some((item) => item.id === entry.id)).length, 2);

  // 保留者仍可再次编辑，但 share/relay 因 T 禁分享拒绝且零写。
  ctx.store.memory.correct({
    characterId: "b",
    entryId: retainedRoot.id,
    expectedVersion: retainedRoot.version,
    body: "用户今天想喝普洱",
  });
  const edited = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(edited.every((entry) => entry.body === "用户今天想喝普洱"), true);
  const stateBefore = assertMultiLState(ctx);
  assert.throws(() => ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: rootEntry.id, expectedVersion: retainedRoot.version + 1 }],
  }), (error) => error.code === "SHARE_BLOCKED");
  assert.deepEqual(assertMultiLState(ctx), stateBefore, "拒绝分享必须零写");

  // 只有走既有明确 allowSharing 才可转告；本对照不自动解除。
  const rooted = temporaryEntriesOf(ctx, "b", tempIdentityId)
    .find((entry) => entry.id === rootEntry.id);
  const allowed = ctx.store.memory.allowSharing({
    characterId: "b",
    entryId: rooted.id,
    expectedVersion: rooted.version,
  });
  assert.equal(allowed.lifted, true);
  const relayed = ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: rooted.id, expectedVersion: rooted.version }],
  });
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = temporaryEntryOf(ctx.store, "c");
  assert.ok(cEntry);
  assert.equal(snapshot(ctx, "c", cEntry).status, "ok");
  assert.equal(cEntry.body, "用户今天想喝普洱");
});

test("POL-SEMOP-001d/D6 root/own L 分离：root 删除仍有效，holder 锚缺失或变化失效", async (t) => {
  await t.test("root-long-removed", async (t2) => {
    const ctx = await setupContext(t2);
    const prepared = await seedMultiLSourcePair(ctx);
    const seeded = prepared;
    assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aLong.id,
      expectedVersion: seeded.aLong.version,
      scope: "self",
    });
    const result = snapshot(ctx, "b", prepared.member);
    assert.equal(result.status, "ok");
    assert.equal(result.sourceAnchorEntryId, seeded.aLong.id);
    assert.equal(result.sourceAnchorIdentityId, seeded.aLong.factIdentityId);
    assert.equal(result.holderLongIdentityId, prepared.independent.factIdentityId);
    assert.equal(result.sourceAnchorStatus, "removed");
  });
  await t.test("holder-anchor-deleted", async (t2) => {
    const ctx = await setupContext(t2);
    const prepared = await seedMultiLSourcePair(ctx);
    const seeded = prepared;
    assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
    ctx.store.memory.forget({
      characterId: "b",
      entryId: prepared.independent.id,
      expectedVersion: prepared.independent.version,
      scope: "self",
    });
    assertUnavailable(snapshot(ctx, "b", prepared.member), "holder_anchor_changed");
  });
  await t.test("holder-anchor-version-changed", async (t2) => {
    const ctx = await setupContext(t2);
    const prepared = await seedMultiLSourcePair(ctx);
    const seeded = prepared;
    assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_entries SET version = version + 1 WHERE id = ?")
        .run(prepared.independent.id);
    });
    assertUnavailable(snapshot(ctx, "b", prepared.member), "holder_anchor_changed");
  });
  await t.test("root-long-and-current-removed", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedMultiLSourcePair(ctx);
    assert.equal(snapshot(ctx, "b", seeded.member).status, "ok");
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aLong.id,
      expectedVersion: seeded.aLong.version,
      scope: "self",
    });
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aTemp.id,
      expectedVersion: seeded.aTemp.version,
      scope: "self",
    });
    const result = snapshot(ctx, "b", seeded.member);
    assert.equal(result.status, "ok", "持久 entry/derivation/消息链仍可证明 root L");
    assert.equal(result.sourceAnchorIdentityId, seeded.aLong.factIdentityId);
    assert.equal(result.holderLongIdentityId, seeded.independent.factIdentityId);
    assert.equal(result.sourceAnchorStatus, "removed");
    assert.equal(result.temporarySourceStatus, "removed");
    assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);
  });
  await t.test("relay-without-holder-anchor", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    const relayed = ctx.store.memory.relay({
      fromCharacterId: "a",
      toCharacterId: "c",
      entries: [{ entryId: seeded.aTemp.id, expectedVersion: seeded.aTemp.version }],
    });
    assert.equal(relayed.shared[0].alreadyHeld, false);
    const cEntry = temporaryEntryOf(ctx.store, "c", { includeLegacy: true });
    assert.ok(cEntry);
    const beforeDelete = snapshot(ctx, "c", cEntry);
    assert.equal(beforeDelete.status, "ok");
    assert.equal(beforeDelete.holderAnchorEntryId, null);
    assert.equal(beforeDelete.holderLongIdentityId, seeded.aLong.factIdentityId);
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aLong.id,
      expectedVersion: seeded.aLong.version,
      scope: "self",
    });
    const afterDelete = snapshot(ctx, "c", cEntry);
    assert.equal(afterDelete.status, "ok", "relay 从始无 holder 锚，root 删除仍有效");
    assert.equal(afterDelete.sourceAnchorStatus, "removed");
  });
});

test("POL-SEMOP-001d/D7 旧多 L 控制继承：restrict/forget/旧源不因新 T 解除", async (t) => {
  const ctx = await setupContext(t);
  const aConversation = openConversation(ctx.store);
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: seeded.aTemp.id,
    expectedVersion: seeded.aTemp.version,
  });
  ctx.store.memory.forget({
    characterId: "a",
    entryId: seeded.aTemp.id,
    expectedVersion: seeded.aTemp.version,
    scope: "self",
  });
  const bMembers = temporaryEntriesOf(ctx, "b", prepared.member.factIdentityId);
  assert.equal(bMembers.length, 2);
  ctx.store.memory.forget({
    characterId: "b",
    entryId: bMembers[0].id,
    expectedVersion: bMembers[0].version,
    scope: "self",
  });
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);
  const oldSourceControls = withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT COUNT(*) AS count FROM memory_source_controls WHERE character_id = 'b'",
  ).get().count);
  assert.ok(oldSourceControls > 0);

  await issueTodayStatement(ctx, aConversation, "a", {
    entryId: seeded.aLong.id,
    expectedVersion: seeded.aLong.version,
    body: "我今天想喝白茶",
    text: "我今天想喝白茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const aNew = temporaryEntryOf(ctx.store, "a");
  assert.ok(aNew);
  assert.notEqual(aNew.factIdentityId, prepared.member.factIdentityId);
  assert.equal(temporaryEntryOf(ctx.store, "b"), null, "旧 forget 不解除，B 不获副本");
  const inherited = withDatabase(ctx.store.dbPath, (db) => ({
    share: db.prepare(
      "SELECT COUNT(*) AS count FROM memory_share_identity_controls WHERE identity_id = ?",
    ).get(aNew.factIdentityId).count,
    forgetB: db.prepare(`
      SELECT COUNT(*) AS count FROM memory_forget_identity_controls
      WHERE character_id = 'b' AND identity_id = ?
    `).get(aNew.factIdentityId).count,
  }));
  assert.equal(inherited.share, 1, "旧 share 控制继承到新 T");
  assert.equal(inherited.forgetB, 1, "他人旧 forget 继承到新 T");
  assert.throws(() => ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: aNew.id, expectedVersion: aNew.version }],
  }), (error) => error.code === "SHARE_BLOCKED");

  ctx.reopen();
  assert.equal(temporaryEntryOf(ctx.store, "a")?.body, "我今天想喝白茶");
  assert.equal(temporaryEntryOf(ctx.store, "b"), null);
  assert.equal(withDatabase(ctx.store.dbPath, (db) => db.prepare(
    "SELECT COUNT(*) AS count FROM memory_source_controls WHERE character_id = 'b'",
  ).get().count), oldSourceControls);
});

test("POL-SEMOP-001d/D8 A self 删除全部 L：B 的独立 L current 保留且可检索", async (t) => {
  const ctx = await setupContext(t);
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  const aPrepared = addAIndependentPreparedMember(ctx, seeded);
  assert.equal(snapshot(ctx, "a", seeded.aTemp).status, "ok");
  assert.equal(snapshot(ctx, "a", aPrepared.member).status, "ok");
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  const tempIdentityId = prepared.member.factIdentityId;
  assert.equal(temporaryEntriesOf(ctx, "a", tempIdentityId).length, 2);
  ctx.store.memory.forget({
    characterId: "a",
    entryId: seeded.aTemp.id,
    expectedVersion: seeded.aTemp.version,
    scope: "self",
  });
  assert.equal(temporaryEntriesOf(ctx, "a", tempIdentityId).length, 0);
  const bEntries = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(bEntries.length, 2);
  for (const entry of bEntries) {
    assert.equal(snapshot(ctx, "b", entry).status, "ok");
  }
  const hits = ctx.store.memory.searchMemories({ characterId: "b", query: bEntries[0].body });
  assert.equal(hits.filter((hit) => bEntries.some((entry) => entry.id === hit.id)).length, 2);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我喜欢咖啡");
  // 正文删除后 entry 关联仍保留，供历史根证明与控制查询。
  assert.equal(entryLinkRowsOfIdentity(ctx, tempIdentityId, "a").length, 2);
});

test("POL-SEMOP-001d/D12 多 L 编辑后转告：own L/锚保留且不冒充直接告知", async (t) => {
  const ctx = await setupContext(t);
  const bConversation = openConversation(ctx.store, "b");
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  const tempIdentityId = prepared.member.factIdentityId;
  await issueTodayStatement(ctx, bConversation, "b", {
    entryId: prepared.member.id,
    expectedVersion: prepared.member.version,
    body: "我今天想喝乌龙茶",
    text: "我今天想喝乌龙茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const before = temporaryEntriesOf(ctx, "b", tempIdentityId);
  const selected = before.find((entry) => entry.id !== prepared.member.id);
  assert.ok(selected);
  ctx.store.memory.correct({
    characterId: "b",
    entryId: selected.id,
    expectedVersion: selected.version,
    body: "用户今天想喝花茶",
  });
  const after = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(after.length, 2);
  for (const entry of after) {
    assert.equal(entry.body, "用户今天想喝花茶");
    assert.equal(entry.expiresAt, seeded.aTemp.expiresAt);
    assert.equal(parseTemporarySource(entry.sourceId).kind, "edit");
    const link = entryLinksOf(ctx, entry.id);
    assert.equal(link.long_identity_id, entry === after.find((item) => item.id === prepared.member.id)
      ? prepared.independent.factIdentityId
      : seeded.bLong.factIdentityId);
    assert.equal(snapshot(ctx, "b", entry).status, "ok");
  }
  const relayed = ctx.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: prepared.member.id, expectedVersion: after.find((entry) => entry.id === prepared.member.id).version }],
  });
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = temporaryEntryOf(ctx.store, "c");
  assert.ok(cEntry);
  const cSnapshot = snapshot(ctx, "c", cEntry);
  assert.equal(cSnapshot.status, "ok");
  assert.equal(cSnapshot.edited, true);
  assert.equal(cSnapshot.relayFrom, "b");
  assert.equal(cSnapshot.sourceAnchorIdentityId, prepared.independent.factIdentityId);
  assert.equal(cSnapshot.holderLongIdentityId, prepared.independent.factIdentityId);
  assert.equal(cSnapshot.holderAnchorEntryId, null);
  // 多 L 编辑/转告不改本体长期。
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.tea.independent").body, "用户平时爱喝茶");
  // 来源失效后，B 的两个 own L 长期恢复，失效今日正文不再进入上下文。
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE chat_messages SET role = 'assistant' WHERE id = ?")
      .run(parseTemporarySource(cEntry.sourceId).messageSourceId.slice("chat:".length));
  });
  assert.equal(snapshot(ctx, "c", cEntry).status, "unavailable");
  const restored = contextBodies(ctx, "b");
  assert.equal(restored.includes("用户今天想喝花茶"), false);
  assert.ok(restored.includes("我喜欢咖啡"));
  assert.ok(restored.includes("用户平时爱喝茶"));
});

test("POL-SEMOP-001d/D13+D16 entry 关联历史：旧行保留、篡改不覆盖、新行可解析", async (t) => {
  const ctx = await setupContext(t);
  const prepared = await seedMultiLSourcePair(ctx);
  const seeded = prepared;
  assert.equal(entryLinkTableExists(ctx), true);
  assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
  const tempIdentityId = prepared.member.factIdentityId;
  const oldLink = entryLinksOf(ctx, prepared.member.id);
  const otherLBefore = entryLinkRowsOfIdentity(ctx, tempIdentityId, "b")
    .filter((row) => row.long_identity_id === seeded.bLong.factIdentityId);
  deleteOldTemporaryEntryOnly(ctx, prepared.member.id);
  const replacement = insertPreparedMultiLMember(ctx, {
    holder: "b",
    ownLong: prepared.independent,
    rootLong: seeded.aLong,
    originCurrent: seeded.aTemp,
    body: prepared.member.body,
    label: "independent-l3-new",
  });
  const history = entryLinkRowsOfIdentity(ctx, tempIdentityId, "b")
    .filter((row) => row.long_identity_id === prepared.independent.factIdentityId);
  assert.equal(history.length, 2, "同 T/holder/L 的新旧 entry 各保留一行");
  const retainedOld = history.find((row) => row.entry_id === prepared.member.id);
  assert.deepEqual(retainedOld, oldLink, "旧 entry 关联不被覆盖");
  const otherLAfter = entryLinkRowsOfIdentity(ctx, tempIdentityId, "b")
    .filter((row) => row.long_identity_id === seeded.bLong.factIdentityId);
  assert.deepEqual(otherLAfter, otherLBefore, "另一 L 的 entry 关联不得被本次历史操作改动");
  assert.equal(snapshot(ctx, "b", replacement).status, "ok");
  assert.equal(withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS count FROM memory_temporary_links
    WHERE temp_identity_id = ? AND holder_character_id = 'b' AND long_identity_id = ?
  `).get(tempIdentityId, prepared.independent.factIdentityId).count), 1,
  "旧控制关系表按 (T,L,holder,expiry) 保持一行");

  // 篡改已删除旧行的 root：新 entry 不因旧历史被篡改而改变。
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_temporary_entry_links SET root_identity_id = 'forged-root' WHERE entry_id = ?")
      .run(prepared.member.id);
  });
  assert.equal(snapshot(ctx, "b", replacement).status, "ok");
  assert.equal(entryLinkRowsOfIdentity(ctx, tempIdentityId, "b")
    .filter((row) => row.long_identity_id === prepared.independent.factIdentityId).length, 2);

  // 篡改仍存活条目的 own L：矛盾条目不可用，恢复后可用。
  const replacementLink = entryLinksOf(ctx, replacement.id);
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_temporary_entry_links SET long_identity_id = 'forged-own' WHERE entry_id = ?")
      .run(replacement.id);
  });
  assert.equal(snapshot(ctx, "b", replacement).status, "unavailable");
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("UPDATE memory_temporary_entry_links SET long_identity_id = ? WHERE entry_id = ?")
      .run(replacementLink.long_identity_id, replacement.id);
  });
  assert.equal(snapshot(ctx, "b", replacement).status, "ok");
});

function deleteOldTemporaryEntryOnly(ctx, entryId) {
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("DELETE FROM memory_fts WHERE entry_id = ?").run(entryId);
    db.prepare("DELETE FROM memory_derivations WHERE entry_id = ?").run(entryId);
    db.prepare("DELETE FROM memory_entries WHERE id = ?").run(entryId);
  });
}

test("POL-SEMOP-001d/D15 entry 关联与 source 锚矛盾时不可用", async (t) => {
  const mutations = {
    "root-identity-forged": (ctx, prepared) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET root_identity_id = 'forged-root' WHERE entry_id = ?")
          .run(prepared.member.id);
      });
    },
    "own-identity-forged": (ctx, prepared) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET long_identity_id = 'forged-own' WHERE entry_id = ?")
          .run(prepared.member.id);
      });
    },
    "source-root-forged": (ctx, prepared, seeded) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_entries SET source_id = ? WHERE id = ?")
          .run(prepared.member.sourceId.replace(seeded.aLong.id, "forged-root"), prepared.member.id);
      });
    },
    "derivation-removed": (ctx, prepared) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("DELETE FROM memory_derivations WHERE entry_id = ?").run(prepared.member.id);
      });
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2);
      const prepared = await seedMultiLSourcePair(ctx);
      const seeded = prepared;
      assert.equal(snapshot(ctx, "b", prepared.member).status, "ok");
      mutate(ctx, prepared, seeded);
      const beforeResolve = assertMultiLState(ctx);
      const result = snapshot(ctx, "b", prepared.member);
      assert.equal(result.status, "unavailable");
      assert.deepEqual(assertMultiLState(ctx), beforeResolve, "resolve 只读");
    });
  }
});

test("POL-SEMOP-001d/D9 旧单 L 行读取回退：缺 entry 关联仍可解析且读取不补齐", async (t) => {
  const ctx = await setupContext(t);
  const seeded = await seedSourcePair(ctx);
  assert.equal(entryLinkTableExists(ctx), true);
  const link = entryLinksOf(ctx, seeded.bTemp.id);
  assert.ok(link);
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare("DELETE FROM memory_temporary_entry_links WHERE entry_id = ?").run(seeded.bTemp.id);
  });
  const result = snapshot(ctx, "b", seeded.bTemp);
  assert.equal(result.status, "ok", "旧单 L 行按唯一 L 回退");
  assert.equal(result.sourceAnchorIdentityId, result.holderLongIdentityId);
  assert.equal(entryLinksOf(ctx, seeded.bTemp.id), null, "读取永不补齐 entry 关联");
});

test("POL-SEMOP-001d/D2 exclusive：root 在他人处被删后保留者多 L 仍合法", async (t) => {
  const ctx = await setupContext(t);
  const prepared = await seedMultiLSourcePair(ctx);
  const tempIdentityId = prepared.member.factIdentityId;
  const bMembers = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(bMembers.length, 2);
  const selected = bMembers.find((entry) => entry.id !== prepared.member.id);
  assert.ok(selected);
  const cleared = ctx.store.memory.keepExclusive({
    characterId: "b",
    entryId: selected.id,
    expectedVersion: selected.version,
  });
  assert.equal(cleared.clearedCharacters.includes("a"), true);
  assert.equal(temporaryEntriesOf(ctx, "a", tempIdentityId).length, 0);
  const retained = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(retained.length, 2);
  for (const entry of retained) {
    const result = snapshot(ctx, "b", entry);
    assert.equal(result.status, "ok", result.reason);
    assert.equal(result.temporarySourceStatus, "removed", "root current 已被 exclusive 删除");
    assert.equal(result.sourceAnchorStatus, "live", "root 长期仍在");
    assert.equal(result.sourceAnchorEntryId, prepared.aLong.id);
    assert.equal(result.holderAnchorStatus, "live");
  }
  const hits = ctx.store.memory.searchMemories({
    characterId: "b",
    query: retained[0].body,
  });
  assert.equal(hits.filter((hit) => retained.some((entry) => entry.id === hit.id)).length, 2);
  const bodies = contextBodies(ctx, "b");
  assert.equal(bodies.filter((body) => body === retained[0].body).length, 1);
  assert.equal(bodies.includes("我喜欢咖啡"), false);
  assert.equal(bodies.includes("用户平时爱喝茶"), false);

  ctx.store.memory.correct({
    characterId: "b",
    entryId: retained[0].id,
    expectedVersion: retained[0].version,
    body: "用户今天想喝黑茶",
  });
  const edited = temporaryEntriesOf(ctx, "b", tempIdentityId);
  assert.equal(edited.length, 2);
  for (const entry of edited) {
    assert.equal(entry.body, "用户今天想喝黑茶");
    assert.equal(snapshot(ctx, "b", entry).status, "ok");
  }
  assert.equal(entryOf(ctx.store, "b", "pref.coffee").body, "我喜欢咖啡");
  assert.equal(entryOf(ctx.store, "b", "pref.tea.independent").body, "用户平时爱喝茶");
});

function expireTemporaryIdentity(ctx, tempIdentityId, nowMs) {
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare(`
      UPDATE memory_entries SET expires_at = ?
      WHERE fact_identity_id = ? AND expires_at IS NOT NULL
    `).run(nowMs - 1, tempIdentityId);
  });
}

function temporaryControlCounts(ctx, tempIdentityId) {
  return withDatabase(ctx.store.dbPath, (db) => ({
    share: db.prepare(`
      SELECT COUNT(*) AS count FROM memory_share_identity_controls WHERE identity_id = ?
    `).get(tempIdentityId).count,
    forgetB: db.prepare(`
      SELECT COUNT(*) AS count FROM memory_forget_identity_controls
      WHERE character_id = 'b' AND identity_id = ?
    `).get(tempIdentityId).count,
  }));
}

test("POL-SEMOP-001d/D7 旧多 L 控制独立对照：forget/restrict/exclusive 不互相遮蔽", async (t) => {
  const cases = {
    "forget-only": async (ctx, seeded) => {
      const bMembers = temporaryEntriesOf(ctx, "b", seeded.member.factIdentityId);
      ctx.store.memory.forget({
        characterId: "b",
        entryId: bMembers[0].id,
        expectedVersion: bMembers[0].version,
        scope: "self",
      });
      expireTemporaryIdentity(ctx, seeded.member.factIdentityId, ctx.nowMs());
    },
    "restrict-only": async (ctx, seeded) => {
      ctx.store.memory.restrictSharing({
        characterId: "a",
        entryId: seeded.aTemp.id,
        expectedVersion: seeded.aTemp.version,
      });
      expireTemporaryIdentity(ctx, seeded.member.factIdentityId, ctx.nowMs());
    },
    exclusive: async (ctx, seeded) => {
      ctx.store.memory.keepExclusive({
        characterId: "a",
        entryId: seeded.aTemp.id,
        expectedVersion: seeded.aTemp.version,
      });
      expireTemporaryIdentity(ctx, seeded.member.factIdentityId, ctx.nowMs());
    },
    "no-control": async (ctx, seeded) => {
      expireTemporaryIdentity(ctx, seeded.member.factIdentityId, ctx.nowMs());
    },
  };
  for (const [name, prepare] of Object.entries(cases)) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedMultiLSourcePair(ctx);
      assert.equal(snapshot(ctx, "b", seeded.member).status, "ok");
      const oldIdentityId = seeded.member.factIdentityId;
      await prepare(ctx, seeded);
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.equal(temporaryEntryOf(ctx.store, "b"), null);
      await issueTodayStatement(ctx, seeded.aConversation, "a", {
        entryId: seeded.aLong.id,
        expectedVersion: seeded.aLong.version,
        body: "我今天想喝白茶",
        text: "我今天想喝白茶。",
        expiresAt: seeded.aTemp.expiresAt,
      });
      const aNew = temporaryEntryOf(ctx.store, "a");
      assert.ok(aNew);
      assert.notEqual(aNew.factIdentityId, oldIdentityId);
      const bNew = temporaryEntryOf(ctx.store, "b");
      const counts = temporaryControlCounts(ctx, aNew.factIdentityId);
      if (name === "no-control") {
        assert.ok(bNew, "无旧控制时应获得同锚 copy");
        assert.equal(snapshot(ctx, "b", bNew).status, "ok");
        assert.deepEqual(counts, { share: 0, forgetB: 0 });
        assert.equal(
          ctx.store.memory.relay({
            fromCharacterId: "a",
            toCharacterId: "c",
            entries: [{ entryId: aNew.id, expectedVersion: aNew.version }],
          }).shared[0].alreadyHeld,
          false,
        );
        return;
      }
      assert.equal(bNew, null, `${name} 不得向旧 forget/share 持有者重建副本`);
      if (name === "forget-only") {
        assert.deepEqual(counts, { share: 0, forgetB: 1 });
        // 只 forget 不阻断其他人的显式转告。
        const relayed = ctx.store.memory.relay({
          fromCharacterId: "a",
          toCharacterId: "c",
          entries: [{ entryId: aNew.id, expectedVersion: aNew.version }],
        });
        assert.equal(relayed.shared[0].alreadyHeld, false);
      } else if (name === "restrict-only") {
        assert.deepEqual(counts, { share: 1, forgetB: 0 });
        assert.throws(() => ctx.store.memory.relay({
          fromCharacterId: "a",
          toCharacterId: "c",
          entries: [{ entryId: aNew.id, expectedVersion: aNew.version }],
        }), (error) => error.code === "SHARE_BLOCKED");
      } else {
        assert.deepEqual(counts, { share: 1, forgetB: 1 });
        assert.throws(() => ctx.store.memory.relay({
          fromCharacterId: "a",
          toCharacterId: "c",
          entries: [{ entryId: aNew.id, expectedVersion: aNew.version }],
        }), (error) => error.code === "SHARE_BLOCKED");
      }
    });
  }
});

/* 旧单 L 快照没有 holderLongIdentityId；测试用它明确执行 digest/isCurrent 的
   兼容回退，而不是只看新字段是否存在。 */
function legacyTemporaryDigest(snapshotValue) {
  const base = [
    snapshotValue.status, snapshotValue.characterId, snapshotValue.holderCharacterId,
    snapshotValue.speaker, snapshotValue.entryId, snapshotValue.entryVersion,
    snapshotValue.sourceId, snapshotValue.sourceVersion, snapshotValue.contextVersion,
    snapshotValue.sourceCreatedAt, snapshotValue.excerpt, snapshotValue.contextIncomplete,
    snapshotValue.sourceMessage, snapshotValue.messages,
  ];
  if (snapshotValue.format === "corrected_v2") {
    base.push(
      snapshotValue.format, snapshotValue.sourceAnchorEntryId,
      snapshotValue.sourceAnchorVersion, snapshotValue.sourceAnchorIdentityId,
      snapshotValue.sourceCharacterId, snapshotValue.direct, snapshotValue.via,
      snapshotValue.expiresAt, snapshotValue.segments,
    );
  }
  if (snapshotValue.temporaryKind) {
    base.push(
      snapshotValue.temporaryKind, snapshotValue.temporaryIdentityId,
      snapshotValue.temporarySourceEntryId, snapshotValue.temporarySourceVersion,
      snapshotValue.temporarySourceStatus, snapshotValue.sourceAnchorStatus,
      snapshotValue.holderAnchorEntryId, snapshotValue.holderAnchorVersion,
      snapshotValue.holderAnchorIdentityId, snapshotValue.holderAnchorStatus,
      snapshotValue.edited, snapshotValue.relayFrom,
    );
  }
  return sha256(JSON.stringify(base));
}

test("POL-SEMOP-001d/D9 新旧临时快照 digest/isCurrent 兼容", async (t) => {
  const legacyOf = (value) => {
    const copy = { ...value };
    delete copy.holderLongIdentityId;
    copy.digest = legacyTemporaryDigest(copy);
    return copy;
  };
  const assertLegacyCompatible = async (ctx, current, seeded) => {
    assert.equal(current.status, "ok");
    assert.equal(ctx.store.memorySourceContext.isCurrent(current), true);
    const legacy = legacyOf(current);
    assert.equal(
      ctx.store.memorySourceContext.isCurrent(legacy),
      true,
      "旧快照必须按 94d8855 摘要算法兼容",
    );
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE chat_messages SET role = 'assistant' WHERE id = ?")
        .run(seeded.parsed.messageSourceId.slice("chat:".length));
    });
    assert.equal(ctx.store.memorySourceContext.isCurrent(current), false);
    assert.equal(ctx.store.memorySourceContext.isCurrent(legacy), false);
  };
  await t.test("legacy-direct-current", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    const current = snapshot(ctx, "a", seeded.aTemp);
    assert.equal(current.format, "corrected_v2");
    assert.equal(current.direct, true);
    assert.equal(current.temporaryKind, undefined);
    assert.equal(Object.hasOwn(current, "holderLongIdentityId"), true);
    await assertLegacyCompatible(ctx, current, { parsed: parseTemporarySource(seeded.aTemp.sourceId) });
  });
  await t.test("legacy-copy", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    await assertLegacyCompatible(ctx, snapshot(ctx, "b", seeded.bTemp), seeded);
  });
  await t.test("legacy-edit", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedSourcePair(ctx);
    ctx.store.memory.correct({
      characterId: "b",
      entryId: seeded.bTemp.id,
      expectedVersion: seeded.bTemp.version,
      body: "用户今天想喝奶茶",
    });
    const edited = temporaryEntryOf(ctx.store, "b");
    assert.equal(parseTemporarySource(edited.sourceId).kind, "edit");
    await assertLegacyCompatible(ctx, snapshot(ctx, "b", edited), seeded);
  });
  await t.test("multi-L-new-digest", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedMultiLSourcePair(ctx);
    const current = snapshot(ctx, "b", seeded.member);
    assert.equal(current.status, "ok");
    assert.equal(current.holderLongIdentityId, seeded.independent.factIdentityId);
    assert.equal(ctx.store.memorySourceContext.isCurrent(current), true);
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare("UPDATE memory_entries SET body = '被篡改' WHERE id = ?")
        .run(seeded.member.id);
    });
    assert.equal(ctx.store.memorySourceContext.isCurrent(current), false);
  });
});

/* master r44：root long 与 origin current 都删除后，不能只信本条 root_identity_id。
   必须复用 originCurrentEntryId 对应的历史 entry 关联行（T/holder/expiry/own/root）
   与持久 derivation/消息链。以下反例在当前实现应先失败。 */
test("POL-SEMOP-001d/D6 双原件删除后历史 entry 关联负例", async (t) => {
  const mutations = {
    "copy-root-forged": (ctx, seeded) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET root_identity_id = 'forged-root' WHERE entry_id = ?")
          .run(seeded.member.id);
      });
    },
    "origin-entry-link-deleted": (ctx, seeded, originId) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("DELETE FROM memory_temporary_entry_links WHERE entry_id = ?").run(originId);
      });
    },
    "origin-root-forged": (ctx, seeded, originId) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET root_identity_id = 'forged-root' WHERE entry_id = ?")
          .run(originId);
      });
    },
    "origin-holder-mismatch": (ctx, seeded, originId) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET holder_character_id = 'x' WHERE entry_id = ?")
          .run(originId);
      });
    },
    "origin-expiry-mismatch": (ctx, seeded, originId) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET expires_at = expires_at + 1 WHERE entry_id = ?")
          .run(originId);
      });
    },
    "origin-temp-mismatch": (ctx, seeded, originId) => {
      withDatabase(ctx.store.dbPath, (db) => {
        db.prepare("UPDATE memory_temporary_entry_links SET temp_identity_id = 'forged-temp' WHERE entry_id = ?")
          .run(originId);
      });
    },
  };
  await t.test("positive-both-removed", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = await seedMultiLSourcePair(ctx);
    assert.equal(snapshot(ctx, "b", seeded.member).status, "ok");
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aLong.id,
      expectedVersion: seeded.aLong.version,
      scope: "self",
    });
    ctx.store.memory.forget({
      characterId: "a",
      entryId: seeded.aTemp.id,
      expectedVersion: seeded.aTemp.version,
      scope: "self",
    });
    const result = snapshot(ctx, "b", seeded.member);
    assert.equal(result.status, "ok");
    assert.equal(result.sourceAnchorEntryId, parseTemporarySource(seeded.member.sourceId).originLongEntryId);
    assert.equal(result.sourceAnchorStatus, "removed");
    assert.equal(result.temporarySourceStatus, "removed");
    const originId = parseTemporarySource(seeded.member.sourceId).originCurrentEntryId;
    const history = entryLinksOf(ctx, originId);
    assert.ok(history, "origin current 的 entry 关联历史必须保留");
    assert.equal(history.temp_identity_id, seeded.member.factIdentityId);
    assert.equal(history.holder_character_id, "a");
    assert.equal(history.expires_at, seeded.member.expiresAt);
    assert.equal(history.root_identity_id, history.long_identity_id);
  });
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2);
      const seeded = await seedMultiLSourcePair(ctx);
      ctx.store.memory.forget({
        characterId: "a",
        entryId: seeded.aLong.id,
        expectedVersion: seeded.aLong.version,
        scope: "self",
      });
      ctx.store.memory.forget({
        characterId: "a",
        entryId: seeded.aTemp.id,
        expectedVersion: seeded.aTemp.version,
        scope: "self",
      });
      // 只保留被篡改的 B 成员，避免另一条同文 current 掩盖“长期恢复”观察。
      const otherB = temporaryEntriesOf(ctx, "b", seeded.member.factIdentityId)
        .find((entry) => entry.id !== seeded.member.id);
      if (otherB) {
        deleteOldTemporaryEntryOnly(ctx, otherB.id);
      }
      assert.equal(snapshot(ctx, "b", seeded.member).status, "ok");
      const originId = parseTemporarySource(seeded.member.sourceId).originCurrentEntryId;
      mutate(ctx, seeded, originId);
      const before = assertMultiLState(ctx);
      const result = snapshot(ctx, "b", seeded.member);
      assert.equal(result.status, "unavailable", name);
      assert.deepEqual(assertMultiLState(ctx), before, "resolve 必须零写");
      const bodies = contextBodies(ctx, "b");
      assert.equal(bodies.includes(seeded.member.body), false);
      assert.ok(bodies.includes("我喜欢咖啡"));
      assert.ok(bodies.includes("用户平时爱喝茶"));
    });
  }
});

/* master r44 澄清：relay 无 holder 锚只在首次创建时 own=root；root 轮换后
   既有关联 L 保留，无锚成员仍必须同步，不能因 own L 不同而回滚整组。 */
test("POL-SEMOP-001d/D11 relay 无锚成员 root 轮换后仍同步且可编辑/转告", async (t) => {
  const ctx = await setupContext(t, ["a", "b", "c", "d"]);
  const seeded = await seedMultiLSourcePair(ctx);
  const relayed = ctx.store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "c",
    entries: [{ entryId: seeded.aTemp.id, expectedVersion: seeded.aTemp.version }],
  });
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cFirst = temporaryEntryOf(ctx.store, "c");
  assert.ok(cFirst);
  assert.equal(snapshot(ctx, "c", cFirst).status, "ok");
  // C 的无关长期事实不能成为 holder 锚。
  addLongForMultiL(ctx, "c", "pref.cat", "用户喜欢猫");
  const tempIdentityId = seeded.member.factIdentityId;
  const cBefore = temporaryEntriesOf(ctx, "c", tempIdentityId);
  assert.equal(cBefore.length, 1);

  // B 从独立 L2 再发起：C 仍是合法 T 成员，必须同步；own L 保持 L1。
  await issueTodayStatement(ctx, seeded.bConversation, "b", {
    entryId: seeded.member.id,
    expectedVersion: seeded.member.version,
    body: "我今天想喝乌龙茶",
    text: "我今天想喝乌龙茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const cAfter = temporaryEntryOf(ctx.store, "c");
  assert.ok(cAfter, "C 必须仍在 T 中并同步");
  assert.equal(cAfter.body, "我今天想喝乌龙茶");
  const cLink = entryLinksOf(ctx, cAfter.id);
  assert.equal(cLink.long_identity_id, seeded.aLong.factIdentityId, "C own L 不得改写成新 root L");
  assert.equal(cLink.root_identity_id, seeded.independent.factIdentityId);
  const cSnapshot = snapshot(ctx, "c", cAfter);
  assert.equal(cSnapshot.status, "ok");
  assert.equal(cSnapshot.holderAnchorEntryId, null);
  assert.equal(cSnapshot.holderLongIdentityId, seeded.aLong.factIdentityId);
  assert.equal(cSnapshot.sourceAnchorIdentityId, seeded.independent.factIdentityId);

  // C 可继续编辑并转告 D。
  ctx.store.memory.correct({
    characterId: "c",
    entryId: cAfter.id,
    expectedVersion: cAfter.version,
    body: "用户今天想喝黄茶",
  });
  const cEdited = temporaryEntryOf(ctx.store, "c");
  assert.equal(cEdited.body, "用户今天想喝黄茶");
  assert.equal(snapshot(ctx, "c", cEdited).status, "ok");
  const relayedD = ctx.store.memory.relay({
    fromCharacterId: "c",
    toCharacterId: "d",
    entries: [{ entryId: cEdited.id, expectedVersion: cEdited.version }],
  });
  assert.equal(relayedD.shared[0].alreadyHeld, false);
  const dEntry = temporaryEntryOf(ctx.store, "d");
  assert.ok(dEntry);
  assert.equal(snapshot(ctx, "d", dEntry).status, "ok");

  // A 再从 L1 发起，root 再变化；C 仍可解析。
  await issueTodayStatement(ctx, seeded.aConversation, "a", {
    entryId: seeded.aLong.id,
    expectedVersion: seeded.aLong.version,
    body: "我今天想喝绿茶",
    text: "我今天想喝绿茶。",
    expiresAt: seeded.aTemp.expiresAt,
  });
  const cFinal = temporaryEntryOf(ctx.store, "c");
  assert.ok(cFinal);
  assert.equal(cFinal.body, "我今天想喝绿茶");
  const finalLink = entryLinksOf(ctx, cFinal.id);
  assert.equal(finalLink.long_identity_id, seeded.aLong.factIdentityId);
  assert.equal(finalLink.root_identity_id, seeded.aLong.factIdentityId);
  assert.equal(snapshot(ctx, "c", cFinal).status, "ok");
  // 明确声明 holder 锚后删除仍拒绝的旧规则不变由既有 D6 holder-anchor 子项覆盖。
});
