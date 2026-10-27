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

async function correctViaChat(ctx, conversation, text, { needle, excerpt, evidence }) {
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
    characterId: "a", conversationId: conversation.id, text, requestId: crypto.randomUUID(),
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
