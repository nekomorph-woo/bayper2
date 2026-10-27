/* S03l-b 有界聊天来源上下文验收：真实 SQLite、正式 store/chat/memory 入口，
   模型仅用本机 HTTP 构造响应。覆盖 POL-SOURCECTX-001～005；不启动 GUI，
   不调用真实模型服务，也不证明主体语义正确。 */
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
const MODEL_NAME = "fixture-source-context";
const API_KEY = "sk-fixture-source-context";
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

async function startModelServer() {
  const requests = [];
  const responders = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
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
    enqueue(responder) { responders.push(responder); },
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

const countRows = (dbPath, table) =>
  withDatabase(dbPath, (db) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
const readOne = (dbPath, sql, ...params) =>
  withDatabase(dbPath, (db) => db.prepare(sql).get(...params));
const tableNames = (dbPath) =>
  withDatabase(dbPath, (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((row) => row.name));

function seedRelationships(dbPath, characterIds) {
  withDatabase(dbPath, (db) => {
    const insertRelationship = db.prepare(`
      INSERT OR IGNORE INTO relationships (character_id, accepted_at, nickname)
      VALUES (?, '2026-01-01T00:00:00.000Z', NULL)
    `);
    const insertStats = db.prepare(`
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `);
    for (const characterId of characterIds) {
      insertRelationship.run(characterId);
      insertStats.run(characterId);
    }
  });
}

async function setupContext(t, characterIds = ["a", "b", "c"]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-context-"));
  let tick = START;
  let store;
  const open = () => createStore(dir, {
    now: () => tick,
    chat: {
      timeoutMs: 1000,
      fetchImpl: fetch,
      getCredentials: () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY }),
    },
  });
  store = open();
  seedRelationships(store.dbPath, characterIds);
  t.after(async () => {
    try {
      store.close();
    } catch {
      // 崩溃/重启用例可能已主动关闭连接。
    }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    server,
    get store() { return store; },
    nowMs: () => tick,
    reopen() {
      store.close();
      store = open();
    },
  };
}

const openConversation = (store, characterId = "a") =>
  store.chat.openConversation({ characterId }).conversation;
const fact = (factKey, body, kind = "detail") =>
  ({ factKey, body, kind, trust: "stated", evidence: body });
const entryOf = (store, characterId, factKey) =>
  store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
const snapshot = (ctx, characterId, entry, overrides = {}) =>
  ctx.store.memorySourceContext.resolve({
    characterId, entryId: entry.id, expectedVersion: entry.version, ...overrides,
  });

function assertUnavailable(result, reason) {
  assert.deepEqual(result, { status: "unavailable", reason });
}

function assertOk(result) {
  assert.equal(result.status, "ok");
  assert.equal(result.speaker, "user");
  assert.equal(result.holderCharacterId, result.characterId);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
}

async function turn(ctx, conversation, text, candidates = [], characterId = "a") {
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "我记下了。", memoryCandidates: candidates,
    memoryOperation: null, memoryRelay: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  return result;
}

test("POL-SOURCECTX-001 真实聊天记忆返回原话、来源时间与角色，重启后仍可核验", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const text = "我喜欢冰美式，而且不加糖。";
  await turn(ctx, conversation, text, [fact("pref.coffee", text, "preference")]);
  const entry = entryOf(ctx.store, "a", "pref.coffee");
  const before = {
    requests: ctx.server.requests.length,
    entries: countRows(ctx.store.dbPath, "memory_entries"),
    messages: countRows(ctx.store.dbPath, "chat_messages"),
    tables: tableNames(ctx.store.dbPath),
  };
  const result = snapshot(ctx, "a", entry);
  assertOk(result);
  assert.deepEqual(
    [result.entryId, result.entryVersion, result.sourceId, result.sourceVersion],
    [entry.id, entry.version, entry.sourceId, 1],
  );
  assert.deepEqual(
    [result.excerpt, result.sourceMessage.content, result.sourceCreatedAt],
    [text, text, result.sourceMessage.createdAt],
  );
  assert.equal(result.sourceMessage.id, entry.sourceId.slice("chat:".length));
  assert.equal(result.contextVersion, ctx.store.memory.getContextVersion("a"));
  assert.deepEqual(result.messages, []);
  assert.equal(result.contextIncomplete, false);
  assert.deepEqual(
    [ctx.server.requests.length, countRows(ctx.store.dbPath, "memory_entries"),
      countRows(ctx.store.dbPath, "chat_messages"), tableNames(ctx.store.dbPath)],
    [before.requests, before.entries, before.messages, before.tables],
  );

  ctx.reopen();
  const reopened = snapshot(ctx, "a", entry);
  assert.deepEqual(reopened, result);
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);
  assert.equal(ctx.store.memorySourceContext.isCurrent(reopened), true);
});

test("POL-SOURCECTX-002 只返回同角色同会话前文，拒绝跨角色与派生/合成来源", async (t) => {
  const ctx = await setupContext(t);
  const conversation = openConversation(ctx.store);
  const otherConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  const first = "我喜欢冰美式。";
  const second = "我昨天去了海边。";
  const current = "我养了一只叫团子的猫。";
  await turn(ctx, conversation, first, [fact("pref.coffee", first, "preference")]);
  await turn(ctx, conversation, second);
  await turn(ctx, conversation, current, [fact("detail.cat", current)]);
  await turn(ctx, conversation, "这是之后说的话。");
  await turn(ctx, otherConversation, "另一个会话里的秘密。");
  const bText = "我也有自己的冰美式偏好。";
  await turn(ctx, bConversation, bText, [fact("pref.coffee", bText, "preference")], "b");
  const aCat = entryOf(ctx.store, "a", "detail.cat");
  const bCoffee = entryOf(ctx.store, "b", "pref.coffee");
  const result = snapshot(ctx, "a", aCat);
  assertOk(result);
  assert.equal(result.sourceMessage.content, current);
  assert.deepEqual(result.messages.map((message) => message.content), [first, second]);
  assert.equal(result.messages.every((message) => message.createdAt <= result.sourceCreatedAt), true);
  assert.equal(
    result.messages.some((message) => /我记下了|之后|另一个会话/u.test(message.content)),
    false,
  );
  assert.equal(result.contextIncomplete, false);
  assertUnavailable(snapshot(ctx, "b", aCat), "entry_unavailable");
  assertUnavailable(snapshot(ctx, "a", bCoffee), "entry_unavailable");

  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: aCat.id, expectedVersion: aCat.version }],
  });
  assertUnavailable(snapshot(ctx, "b", entryOf(ctx.store, "b", "detail.cat")), "relay_source");
  ctx.store.memory.share({ fromCharacterId: "a", toCharacterId: "c", entryIds: [aCat.id] });
  assertUnavailable(snapshot(ctx, "c", entryOf(ctx.store, "c", "detail.cat")), "share_source");

  const theme = ctx.store.memory.remember({
    characterId: "a", factKey: "theme.lighthouse", body: "主题故事里的灯塔很旧",
    kind: "detail", sourceKind: "theme", sourceId: 'theme-source:["t1","s1","f1"]',
  });
  assertUnavailable(snapshot(ctx, "a", theme.entry), "unsupported_source");
  for (const [factKey, body, sourceId] of [
    ["external.weather", "外部来源写着明天有雨", `external:${sha256("allowed/file")}`],
    ["panel.weekend", "面板来源写着周末会下雨", "claude:root:path:id:1"],
  ]) {
    const synthetic = ctx.store.memory.remember({
      characterId: "a", factKey, body, kind: "detail", sourceId,
    });
    assertUnavailable(snapshot(ctx, "a", synthetic.entry), "unsupported_source");
  }
});

test("POL-SOURCECTX-003 纠正、删除、独属与同源删除使旧快照失效且不返回正文", async (t) => {
  const ctx = await setupContext(t, ["a", "b"]);
  const conversation = openConversation(ctx.store);
  const coffeeText = "我喜欢冰美式。";
  await turn(ctx, conversation, coffeeText, [fact("pref.coffee", coffeeText, "preference")]);
  const coffee = entryOf(ctx.store, "a", "pref.coffee");
  const coffeeSnapshot = snapshot(ctx, "a", coffee);
  ctx.store.memory.correct({
    characterId: "a", entryId: coffee.id, expectedVersion: coffee.version,
    body: "用户喜欢无糖汽水", nowMs: ctx.nowMs(),
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(coffeeSnapshot), false);
  assertUnavailable(
    snapshot(ctx, "a", { id: coffee.id, version: coffee.version + 1 }),
    "unsupported_source",
  );
  assert.equal(
    readOne(ctx.store.dbPath, "SELECT content FROM chat_messages WHERE source_id = ?", coffee.sourceId)
      .content,
    coffeeText,
  );

  const seaText = "我昨天去了海边。";
  await turn(ctx, conversation, seaText, [fact("detail.sea", seaText)]);
  const sea = entryOf(ctx.store, "a", "detail.sea");
  const seaSnapshot = snapshot(ctx, "a", sea);
  ctx.store.memory.forget({
    characterId: "a", entryId: sea.id, expectedVersion: sea.version, nowMs: ctx.nowMs(),
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(seaSnapshot), false);
  assertUnavailable(snapshot(ctx, "a", sea), "entry_unavailable");

  const petsText = "我喜欢猫。我喜欢狗。";
  await turn(ctx, conversation, petsText, [
    fact("detail.catLike", "我喜欢猫"), fact("detail.dogLike", "我喜欢狗"),
  ]);
  const catLike = entryOf(ctx.store, "a", "detail.catLike");
  const dogLike = entryOf(ctx.store, "a", "detail.dogLike");
  assert.equal(catLike.sourceId, dogLike.sourceId);
  const dogSnapshot = snapshot(ctx, "a", dogLike);
  assertOk(dogSnapshot);
  ctx.store.memory.forget({
    characterId: "a", entryId: catLike.id, expectedVersion: catLike.version,
    scope: "self", nowMs: ctx.nowMs(),
  });
  assert.equal(entryOf(ctx.store, "a", "detail.catLike"), null);
  assert.ok(entryOf(ctx.store, "a", "detail.dogLike"));
  assert.equal(ctx.store.memorySourceContext.isCurrent(dogSnapshot), false);
  assertUnavailable(snapshot(ctx, "a", dogLike), "source_excluded");

  const teaText = "我喜欢热茶。";
  await turn(ctx, conversation, teaText, [fact("pref.tea", teaText, "preference")]);
  const tea = entryOf(ctx.store, "a", "pref.tea");
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: tea.id, expectedVersion: tea.version }],
  });
  const teaAtB = entryOf(ctx.store, "b", "pref.tea");
  const teaSnapshot = snapshot(ctx, "a", tea);
  ctx.store.memory.keepExclusive({
    characterId: "a", entryId: tea.id, expectedVersion: tea.version, nowMs: ctx.nowMs(),
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(teaSnapshot), false);
  assert.equal(entryOf(ctx.store, "b", "pref.tea"), null);
  assertUnavailable(snapshot(ctx, "b", teaAtB), "entry_unavailable");
  assert.equal(countRows(ctx.store.dbPath, "memory_share_identity_controls"), 1);
});

test("POL-SOURCECTX-004 版本、过期、来源归属、缺失与正文不符均无正文，非法参数明确报错", async (t) => {
  const ctx = await setupContext(t, ["a", "b"]);
  const conversation = openConversation(ctx.store);
  async function freshEntry(text, factKey) {
    await turn(ctx, conversation, text, [fact(factKey, text)]);
    return entryOf(ctx.store, "a", factKey);
  }
  const update = (sql, ...params) =>
    withDatabase(ctx.store.dbPath, (db) => db.prepare(sql).run(...params));

  const versioned = await freshEntry("我喜欢冰美式。", "v.mismatch");
  assertUnavailable(snapshot(ctx, "a", versioned, { expectedVersion: 2 }), "version_mismatch");
  const expired = await freshEntry("我昨天去了海边。", "v.expired");
  update("UPDATE memory_entries SET expires_at = ? WHERE id = ?", ctx.nowMs() - 1, expired.id);
  assertUnavailable(snapshot(ctx, "a", expired), "expired");
  const badSourceVersion = await freshEntry("我养了一只叫团子的猫。", "v.sourceVersion");
  update("UPDATE memory_entries SET source_version = 2 WHERE id = ?", badSourceVersion.id);
  assertUnavailable(snapshot(ctx, "a", badSourceVersion), "source_version_mismatch");
  const assistantRole = await freshEntry("我周末常去公园。", "v.role");
  update("UPDATE chat_messages SET role = 'assistant' WHERE id = ?",
    assistantRole.sourceId.slice("chat:".length));
  assertUnavailable(snapshot(ctx, "a", assistantRole), "source_mismatch");
  const wrongConversation = await freshEntry("我喜欢热茶。", "v.conversation");
  update("UPDATE chat_messages SET conversation_id = ? WHERE id = ?",
    openConversation(ctx.store, "b").id, wrongConversation.sourceId.slice("chat:".length));
  assertUnavailable(snapshot(ctx, "a", wrongConversation), "source_mismatch");

  const missing = ctx.store.memory.remember({
    characterId: "a", factKey: "v.missing", body: "用户说过一句没有来源的话",
    kind: "detail", sourceId: `chat:missing-${crypto.randomUUID()}`,
  });
  assertUnavailable(snapshot(ctx, "a", missing.entry), "source_missing");
  const bodyMismatch = await freshEntry("我喜欢无糖汽水。", "v.body");
  update("UPDATE memory_entries SET body = ? WHERE id = ?", "用户喜欢含糖汽水", bodyMismatch.id);
  assertUnavailable(snapshot(ctx, "a", bodyMismatch), "body_not_in_source");

  const context = ctx.store.memorySourceContext;
  for (const call of [
    () => context.resolve(),
    () => context.resolve({ characterId: "a", entryId: versioned.id }),
    () => context.resolve({ characterId: "a", entryId: versioned.id, expectedVersion: 0 }),
    () => context.resolve({ characterId: "a", entryId: "bad\u0000id", expectedVersion: 1 }),
  ]) {
    assert.throws(call, (error) => error.code === "INVALID_INPUT");
  }
  assert.throws(
    () => context.resolve({ characterId: "missing", entryId: versioned.id, expectedVersion: 1 }),
    (error) => error.code === "CHARACTER_UNKNOWN",
  );
});

test("POL-SOURCECTX-005 长原话、前文预算、受限省略、消息修改与同时间按 seq 排序", async (t) => {
  const ctx = await setupContext(t, ["a"]);
  const insertMessage = (conversationId, content, id = crypto.randomUUID()) => {
    withDatabase(ctx.store.dbPath, (db) => db.prepare(`
      INSERT INTO chat_messages (
        id, conversation_id, character_id, role, content, source_id, created_at, seq
      ) VALUES (?, ?, 'a', 'user', ?, ?, ?, (
        SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages
      ))
    `).run(id, conversationId, content, `chat:${id}`, ctx.nowMs()));
    return id;
  };

  // chat.send 上限 2000 字符；超过 3000 的边界用明确数据库夹具构造。
  const longPriorConversation = openConversation(ctx.store);
  insertMessage(longPriorConversation.id, "长".repeat(3001));
  await turn(ctx, longPriorConversation, "我喜欢冰美式。", [
    fact("long.prior", "我喜欢冰美式。", "preference"),
  ]);
  const longPrior = snapshot(ctx, "a", entryOf(ctx.store, "a", "long.prior"));
  assertOk(longPrior);
  assert.deepEqual(longPrior.messages, []);
  assert.equal(longPrior.contextIncomplete, true);

  const longCurrentConversation = openConversation(ctx.store);
  const longMessageId = insertMessage(longCurrentConversation.id, "长".repeat(3001));
  const longCurrent = ctx.store.memory.remember({
    characterId: "a", factKey: "long.current", body: "长".repeat(2000),
    kind: "detail", sourceId: `chat:${longMessageId}`,
  });
  assertUnavailable(snapshot(ctx, "a", longCurrent.entry), "source_too_long");

  // 同一逻辑时间下按 seq 判断先后；正常前文有界且顺序正确。
  const budgetConversation = openConversation(ctx.store);
  const budgetPrior = ["甲".repeat(1000), "乙".repeat(1000)];
  for (const text of budgetPrior) insertMessage(budgetConversation.id, text);
  const budgetCurrent = "丙".repeat(100);
  await turn(ctx, budgetConversation, budgetCurrent, [fact("budget.current", budgetCurrent)]);
  const budget = snapshot(ctx, "a", entryOf(ctx.store, "a", "budget.current"));
  assertOk(budget);
  assert.deepEqual(budget.messages.map((message) => message.content), budgetPrior);
  assert.equal(budget.messages.every((message) => message.createdAt === START), true);
  assert.equal(budget.sourceCreatedAt, START);
  assert.equal(budget.messages[0].seq < budget.messages[1].seq, true);
  assert.equal(budget.messages[1].seq < budget.sourceMessage.seq, true);
  assert.equal(budget.contextIncomplete, false);

  // 当前原话加两条 3000 字前文超 6000 总预算：只留较近一条并标不完整。
  const overBudgetConversation = openConversation(ctx.store);
  const overBudgetPrior = ["丁".repeat(3000), "戊".repeat(3000)];
  for (const text of overBudgetPrior) insertMessage(overBudgetConversation.id, text);
  const overBudgetCurrent = "己".repeat(100);
  await turn(ctx, overBudgetConversation, overBudgetCurrent, [
    fact("overbudget.current", overBudgetCurrent),
  ]);
  const overBudget = snapshot(ctx, "a", entryOf(ctx.store, "a", "overbudget.current"));
  assertOk(overBudget);
  assert.deepEqual(overBudget.messages.map((message) => message.content), [overBudgetPrior[1]]);
  assert.equal(overBudget.contextIncomplete, true);
  assert.equal(
    overBudget.sourceMessage.content.length +
      overBudget.messages.reduce((sum, message) => sum + message.content.length, 0) <= 6000,
    true,
  );

  // 受限前文省略并标记不完整；来源消息被修改使旧快照失效。
  const restrictedConversation = openConversation(ctx.store);
  const firstText = "我喜欢喝热茶。";
  await turn(ctx, restrictedConversation, firstText, [
    fact("restricted.tea", firstText, "preference"),
  ]);
  const tea = entryOf(ctx.store, "a", "restricted.tea");
  await turn(ctx, restrictedConversation, "我昨天去了海边。");
  const currentText = "我养了一只叫团子的猫。";
  await turn(ctx, restrictedConversation, currentText, [fact("restricted.cat", currentText)]);
  const cat = entryOf(ctx.store, "a", "restricted.cat");
  const beforeForget = snapshot(ctx, "a", cat);
  assert.deepEqual(
    beforeForget.messages.map((message) => message.content),
    [firstText, "我昨天去了海边。"],
  );
  assert.equal(beforeForget.contextIncomplete, false);
  ctx.store.memory.forget({
    characterId: "a", entryId: tea.id, expectedVersion: tea.version,
    scope: "self", nowMs: ctx.nowMs(),
  });
  assert.equal(ctx.store.memorySourceContext.isCurrent(beforeForget), false);
  const afterForget = snapshot(ctx, "a", cat);
  assert.deepEqual(afterForget.messages.map((message) => message.content), ["我昨天去了海边。"]);
  assert.equal(afterForget.contextIncomplete, true);

  withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(
      `${currentText}（修改）`, cat.sourceId.slice("chat:".length),
    ));
  assert.equal(ctx.store.memorySourceContext.isCurrent(afterForget), false);
  const modified = snapshot(ctx, "a", cat);
  assert.equal(modified.status, "ok");
  assert.equal(modified.sourceMessage.content, `${currentText}（修改）`);
  assert.notEqual(modified.digest, afterForget.digest);
  withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(
      "完全无关的修改", cat.sourceId.slice("chat:".length),
    ));
  assertUnavailable(snapshot(ctx, "a", cat), "body_not_in_source");
});

test("POL-SOURCECTX-006 快照摘要自校验，并保留完整原话与短片段区别", async (t) => {
  const ctx = await setupContext(t, ["a"]);
  const conversation = openConversation(ctx.store);
  const fullText = "我姐姐下个月要搬去杭州，她说她喜欢蓝色。";
  const excerpt = "她喜欢蓝色";
  await turn(ctx, conversation, fullText, [fact("pref.sisterColor", excerpt, "preference")]);
  const entry = entryOf(ctx.store, "a", "pref.sisterColor");
  const result = snapshot(ctx, "a", entry);
  assertOk(result);
  assert.equal(result.sourceMessage.content, fullText);
  assert.equal(result.excerpt, excerpt);
  assert.notEqual(result.sourceMessage.content, result.excerpt);
  assert.equal(result.sourceMessage.content.includes(result.excerpt), true);
  // speaker=user 只表示这句话由用户说出，不在本片判断偏好主体是谁。
  assert.equal(result.speaker, "user");
  assert.equal(result.holderCharacterId, "a");
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);

  const mutations = [
    ["excerpt", (value) => {
      value.excerpt = "她喜欢红色";
    }],
    ["speaker", (value) => {
      value.speaker = "assistant";
    }],
    ["holderCharacterId", (value) => {
      value.holderCharacterId = "b";
    }],
    ["sourceCreatedAt", (value) => {
      value.sourceCreatedAt += 86400000;
    }],
    ["contextVersion", (value) => {
      value.contextVersion += 1;
    }],
    ["entryVersion", (value) => {
      value.entryVersion += 1;
    }],
    ["messages", (value) => {
      value.messages = [{
        id: "forged-message",
        conversationId: "forged-conversation",
        seq: 1,
        createdAt: 0,
        content: "伪造的前文",
      }];
    }],
    ["sourceMessage.content", (value) => {
      value.sourceMessage.content = "被改写的完整原话";
    }],
    ["sourceMessage.createdAt", (value) => {
      value.sourceMessage.createdAt += 1;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = JSON.parse(JSON.stringify(result));
    mutate(changed);
    assert.equal(
      ctx.store.memorySourceContext.isCurrent(changed),
      false,
      `保留旧摘要的 ${name} 修改必须失效`,
    );
  }
  // 未修改的原快照仍通过，且修改副本不回流影响原快照。
  assert.equal(ctx.store.memorySourceContext.isCurrent(result), true);
  assert.equal(result.excerpt, excerpt);
});
