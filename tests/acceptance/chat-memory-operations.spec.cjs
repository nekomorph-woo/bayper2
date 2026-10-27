/* S03f 聊天中明确记忆操作验收：真实 SQLite + 构造 HTTP 模型响应。
   覆盖 POL-CHATMEM-001～006 的服务与事务核心；不启动 Electron/GUI，
   不调用真实模型服务，也不证明真实模型的自然语言识别能力。 */
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
const MODEL_NAME = "fixture-chat-memory-operations";
const API_KEY = "sk-fixture-chat-memory-operations";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待测试条件超时。");
    }
    await delay(5);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sendEnvelope(res, envelope) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }],
    }),
  );
}

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

function seedRelationships(dbPath, characterIds) {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    );
    for (const characterId of characterIds) {
      insert.run(characterId, "2026-01-01T00:00:00.000Z");
    }
  } finally {
    db.close();
  }
}

function countRows(dbPath, table) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  } finally {
    db.close();
  }
}

function readOne(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function withDatabase(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function setupContext(t, name, { timeoutMs = 1000 } = {}) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-memory-"));
  let tick = START;
  let store;
  const open = (overrides = {}) =>
    createStore(dir, {
      now: () => tick++,
      chat: {
        timeoutMs,
        fetchImpl: fetch,
        recoverInterrupted: overrides.recoverInterrupted ?? false,
        getCredentials: () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY }),
      },
    });
  store = open();
  seedRelationships(store.dbPath, ["a", "b", "c"]);

  const cleanup = { dbClosed: false, httpClosed: false, tempDirRemoved: false };
  const ctx = {
    dir,
    server,
    get store() {
      return store;
    },
    nowMs: () => tick,
    advance(ms) {
      tick += ms;
    },
    reopen(overrides = {}) {
      try {
        store.close();
      } catch {
        // 崩溃/重启测试可能已主动关闭连接。
      }
      store = open(overrides);
    },
    closeStore() {
      store.close();
    },
  };
  t.after(async () => {
    try {
      store.close();
      cleanup.dbClosed = true;
    } catch {
      cleanup.dbClosed = false;
    }
    try {
      await server.close();
      cleanup.httpClosed = true;
    } catch {
      cleanup.httpClosed = false;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      cleanup.tempDirRemoved = !fs.existsSync(dir);
    } catch {
      cleanup.tempDirRemoved = false;
    }
    console.log(
      `S03F_CLEANUP ${name} dbClosed=${cleanup.dbClosed} ` +
        `httpClosed=${cleanup.httpClosed} tempDirRemoved=${cleanup.tempDirRemoved}`,
    );
    assert.equal(cleanup.httpClosed, true);
    assert.equal(cleanup.tempDirRemoved, true);
  });
  return ctx;
}

function openConversation(store, characterId = "a") {
  return store.chat.openConversation({ characterId }).conversation;
}

/* 构造模型响应时从本轮实际发出的候选列表里选目标，
   不依赖测试自己重排记忆或猜测短 ID。 */
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

function candidateBlockOf(body) {
  return body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .find((content) => content.includes("管理候选")) ?? null;
}

function entryOf(store, characterId, factKey) {
  return store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function entryOfAt(store, characterId, factKey, nowMs) {
  return (
    store.memory
      .listMemories(characterId, { nowMs })
      .find((entry) => entry.factKey === factKey) ?? null
  );
}

/* 只按来源形状取今日临时理解，不依赖实现内部的 T 或 factKey 猜测。 */
function temporaryEntryOf(store, characterId) {
  return (
    store.memory
      .listMemories(characterId)
      .find((entry) => /^(chat-current:|chat-current-copy:|temporary-edit:)/u.test(entry.sourceId)) ??
    null
  );
}

function lastSystemContext(server) {
  return server.requests.at(-1).messages
    .filter((message) => message.role === "system")[1].content;
}

function temporaryRow(store, entryId) {
  return withDatabase(store.dbPath, (db) =>
    db.prepare(
      "SELECT id, fact_identity_id, body, source_id, version, expires_at FROM memory_entries WHERE id = ?",
    ).get(entryId),
  );
}

function endOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function snapshotBusinessRows(store) {
  return {
    roster: countRows(store.dbPath, "roster"),
    appState: countRows(store.dbPath, "app_state"),
    storyProgress: countRows(store.dbPath, "story_progress"),
    storyFacts: countRows(store.dbPath, "story_facts"),
    stats: withDatabase(store.dbPath, (db) =>
      db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    ),
  };
}

function assertBusinessRowsUnchanged(store, before) {
  assert.equal(countRows(store.dbPath, "roster"), before.roster);
  assert.equal(countRows(store.dbPath, "app_state"), before.appState);
  assert.equal(countRows(store.dbPath, "story_progress"), before.storyProgress);
  assert.equal(countRows(store.dbPath, "story_facts"), before.storyFacts);
  assert.deepEqual(
    withDatabase(store.dbPath, (db) =>
      db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    ),
    before.stats,
  );
}

function seedTea(ctx, { withUnrelated = true } = {}) {
  const { store } = ctx;
  const tea = store.memory.remember({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢热茶",
    kind: "preference",
    sourceId: "seed-a-tea",
  });
  store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: tea.entry.id, expectedVersion: tea.entry.version }],
  });
  if (withUnrelated) {
    store.memory.remember({
      characterId: "a",
      factKey: "exp.qingdao",
      body: "用户曾在青岛吃蛤蜊",
      kind: "experience",
      sourceId: "seed-a-qingdao",
    });
    store.memory.remember({
      characterId: "a",
      factKey: "detail.city",
      body: "用户住在杭州",
      kind: "detail",
      sourceId: "seed-a-city",
    });
  }
  return {
    tea,
    bEntry: entryOf(store, "b", "pref.tea"),
  };
}

function requestRow(store, requestId) {
  return readOne(
    store.dbPath,
    "SELECT status, completed_at, memory_applied, error_code FROM chat_requests WHERE id = ?",
    requestId,
  );
}

test("POL-CHATMEM-001 聊天纠正更新 A/B、排除旧来源并保留过去经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001");
  const { store, server } = ctx;
  const { tea } = seedTea(ctx);
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);
  const aContextBefore = store.memory.getContextVersion("a");
  const bContextBefore = store.memory.getContextVersion("b");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的，已经更新完成。",
      memoryCandidates: [
        {
          factKey: "pref.tea",
          body: "用户喜欢无糖咖啡",
          kind: "preference",
          trust: "stated",
          evidence: "我其实喜欢无糖咖啡",
        },
      ],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "热茶"),
        excerpt: "我其实喜欢无糖咖啡",
        evidence: "请帮我改过来",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。",
    requestId: "correct-1",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 0);
  assert.equal(
    result.reply,
    "好，这条记忆已按你给的原话更新为“不是热茶，我其实喜欢无糖咖啡”；原来源不会自动恢复。",
  );
  assert.equal(result.reply.includes("已经更新完成"), false);

  const aEntry = entryOf(store, "a", "pref.tea");
  const bEntry = entryOf(store, "b", "pref.tea");
  assert.equal(aEntry.body, "不是热茶，我其实喜欢无糖咖啡");
  assert.equal(bEntry.body, "不是热茶，我其实喜欢无糖咖啡");
  assert.ok(aEntry.body.includes("不是热茶"), "纠正正文要保留完整否定上下文");
  assert.equal(aEntry.version, 2);
  assert.equal(bEntry.version, 2);
  assert.match(aEntry.sourceId, /^chat-correct:/u);
  assert.match(bEntry.sourceId, /^corrected:/u);
  assert.equal(entryOf(store, "c", "pref.tea"), null);
  assert.equal(store.memory.listMemories("c").length, 0);
  assert.ok(store.memory.getContextVersion("a") > aContextBefore);
  assert.ok(store.memory.getContextVersion("b") > bContextBefore);

  const hotHits = store.memory.searchMemories({ characterId: "a", query: "热茶" });
  assert.equal(hotHits.length, 1);
  assert.equal(hotHits[0].body, "不是热茶，我其实喜欢无糖咖啡");
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "无糖咖啡" }).length, 1);
  assert.equal(
    store.memory.searchMemories({ characterId: "b", query: "无糖咖啡" })[0].body,
    "不是热茶，我其实喜欢无糖咖啡",
  );
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "蛤蜊" }).length, 1);
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "杭州" }).length, 1);
  const context = store.memory.buildContext({ characterId: "a" });
  assert.equal(
    context.sections.preferences.some((entry) => entry.body === "用户喜欢热茶"),
    false,
  );
  assert.ok(
    context.sections.preferences.some((entry) => entry.body === "不是热茶，我其实喜欢无糖咖啡"),
  );

  assert.ok(
    store.memory.listExcludedSources("a").includes(sha256("seed-a-tea")),
  );
  assert.ok(
    store.memory.listExcludedSources("b").includes(sha256(`relay:${tea.entry.id}:b`)),
  );
  const reimport = store.memory.applyExtractionBatch({
    characterId: "a",
    sourceId: "seed-a-tea",
    sourceVersion: 1,
    appliedAt: ctx.nowMs(),
    facts: [{ factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference" }],
  });
  assert.equal(reimport.applied, false);
  assert.equal(reimport.reason, "blocked_source");
  const bReimport = store.memory.applyExtractionBatch({
    characterId: "b",
    sourceId: `relay:${tea.entry.id}:b`,
    sourceVersion: 1,
    appliedAt: ctx.nowMs(),
    facts: [{ factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference" }],
  });
  assert.equal(bReimport.applied, false);
  assert.equal(bReimport.reason, "blocked_source");
  assert.equal(entryOf(store, "a", "pref.tea").body, "不是热茶，我其实喜欢无糖咖啡");

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, result.reply);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  const request = requestRow(store, "correct-1");
  assert.equal(request.status, "completed");
  assert.equal(request.memory_applied, 0);
  const memoryRow = readOne(
    store.dbPath,
    "SELECT updated_at FROM memory_entries WHERE character_id = 'a' AND fact_key = 'pref.tea'",
  );
  const assistantRow = readOne(
    store.dbPath,
    "SELECT created_at FROM chat_messages WHERE role = 'assistant'",
  );
  assert.equal(memoryRow.updated_at, request.completed_at);
  assert.equal(assistantRow.created_at, request.completed_at);
  assertBusinessRowsUnchanged(store, businessBefore);

  ctx.reopen();
  assert.equal(ctx.store.memory.searchMemories({ characterId: "a", query: "热茶" }).length, 1);
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "a", query: "无糖咖啡" })[0].body,
    "不是热茶，我其实喜欢无糖咖啡",
  );
  assert.equal(ctx.store.memory.searchMemories({ characterId: "a", query: "蛤蜊" }).length, 1);
  assert.equal(ctx.store.chat.getRequest({ characterId: "a", requestId: "correct-1" }).status, "completed");
});

test("POL-CHATMEM-001 真实文本对照：不是茶但喜欢咖啡", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-live-one");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢茶",
    kind: "preference",
    sourceId: "seed-live-tea",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "detail.cat",
    body: "用户有一只叫团子的猫",
    kind: "detail",
    sourceId: "seed-live-cat",
  });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢茶"),
        excerpt: "我喜欢咖啡，不是茶",
        evidence: "请纠正一下",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我喜欢咖啡，不是茶，请纠正一下。",
    requestId: "live-one-correction",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /不是茶/u);
  const preference = entryOf(store, "a", "pref.tea");
  assert.equal(preference.body, "我喜欢咖啡，不是茶");
  assert.equal(preference.body.includes("咖啡"), true);
  assert.equal(entryOf(store, "a", "detail.cat").body, "用户有一只叫团子的猫");
});

test("POL-CHATMEM-001 真实文本对照：不是喜欢茶而是喜欢咖啡", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-live-two");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢茶",
    kind: "preference",
    sourceId: "seed-live-tea",
  });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢茶"),
        excerpt: "而是喜欢咖啡",
        evidence: "我不是喜欢茶，而是喜欢咖啡。",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我不是喜欢茶，而是喜欢咖啡。",
    requestId: "live-two-correction",
  });
  assert.equal(result.status, "completed");
  assert.equal(entryOf(store, "a", "pref.tea").body, "我不是喜欢茶，而是喜欢咖啡");
});

test("POL-CHATMEM-001 纯否定翻转不需要新对象词", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-polarity");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.hot-tea",
    body: "用户喜欢热茶",
    kind: "preference",
    sourceId: "seed-polarity-tea",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "detail.cat",
    body: "用户有一只叫团子的猫",
    kind: "detail",
    sourceId: "seed-polarity-cat",
  });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢热茶"),
        excerpt: "我不喜欢热茶",
        evidence: "请纠正一下",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请纠正一下，我不喜欢热茶。",
    requestId: "polarity-correction",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /不喜欢热茶/u);
  assert.equal(entryOf(store, "a", "pref.hot-tea").body, "我不喜欢热茶");
  assert.equal(entryOf(store, "a", "detail.cat").body, "用户有一只叫团子的猫");
});

test("POL-CHATMEM-001 独立不确定分句不能被提升为确定事实", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-independent-uncertain");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢茶",
    kind: "preference",
    sourceId: "seed-uncertain-tea",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "detail.cat",
    body: "用户有一只叫团子的猫",
    kind: "detail",
    sourceId: "seed-uncertain-cat",
  });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢茶"),
        excerpt: "我喜欢咖啡",
        evidence: "请纠正一下",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请纠正一下，可能，我喜欢咖啡，不是茶。",
    requestId: "independent-uncertain",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /不确定/u);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢茶");
  assert.equal(entryOf(store, "a", "detail.cat").body, "用户有一只叫团子的猫");
});

test("POL-CHATMEM-001 今天临时情况保留长期事实并按当天结束失效", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-today");
  const { store, server } = ctx;
  const coffee = store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "exp.qingdao",
    body: "用户曾在青岛吃蛤蜊",
    kind: "experience",
    sourceId: "seed-a-qingdao",
  });
  const conversation = openConversation(store);
  const expiresAt = endOfLocalDay(START);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const corrected = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    requestId: "today-corrected",
  });
  assert.equal(corrected.status, "completed");
  assert.equal(
    corrected.reply,
    "好，我记下了你今天的这条情况；它只到今天结束有效，原来的长期内容仍然保留。",
  );

  const longTerm = entryOfAt(store, "a", "pref.coffee", START);
  assert.equal(longTerm.body, "用户喜欢咖啡");
  assert.equal(longTerm.version, 1);
  assert.equal(longTerm.expiresAt, null);
  const tempKey = `pref.coffee.current.${coffee.entry.id}`;
  const temporary = entryOfAt(store, "a", tempKey, START);
  assert.ok(temporary, "今天的当前理解应写入独立临时事实");
  assert.equal(temporary.body, "不是咖啡，我今天想喝茶");
  assert.equal(temporary.trust, "stated");
  assert.equal(temporary.expiresAt, expiresAt);
  assert.match(temporary.sourceId, /^chat-current:/u);
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
  const coffeeHits = store.memory.searchMemories({ characterId: "a", query: "咖啡", nowMs: START });
  // C2 只改变上下文/当前状态：searchMemories 仍是管理定位入口，合法长期偏好可被找到和编辑。
  assert.ok(coffeeHits.some((entry) => entry.factKey === "pref.coffee"));
  assert.ok(coffeeHits.some((entry) => entry.factKey === tempKey));
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "喝茶", nowMs: START }).length, 1);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "今天先喝茶也很好。", memoryCandidates: [] }),
  );
  const beforeExpiry = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "现在呢？",
    requestId: "today-live",
  });
  assert.equal(beforeExpiry.status, "completed");
  const liveContext = server.requests.at(-1).messages.filter(
    (message) => message.role === "system",
  )[1].content;
  // C2：今天有效时只注入今天理解，长期偏好仍保留在库中但不在本轮冒充今日状态。
  assert.equal(liveContext.includes("用户喜欢咖啡"), false);
  assert.ok(liveContext.includes("我今天想喝茶"));
  assert.ok(liveContext.includes("时效:有效至"));

  ctx.advance(expiresAt - ctx.nowMs() + 1);
  assert.equal(entryOfAt(store, "a", tempKey, ctx.nowMs()), null);
  assert.equal(entryOfAt(store, "a", "pref.coffee", ctx.nowMs()).body, "用户喜欢咖啡");
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "喝茶" }).length, 0);
  const persisted = readOne(
    store.dbPath,
    "SELECT body, expires_at FROM memory_entries WHERE character_id = 'a' AND fact_key = ?",
    tempKey,
  );
  assert.equal(persisted.body, "不是咖啡，我今天想喝茶");
  assert.equal(persisted.expires_at, expiresAt);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "后来也可以再说。", memoryCandidates: [] }),
  );
  const afterExpiry = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "后来呢？",
    requestId: "today-expired",
  });
  assert.equal(afterExpiry.status, "completed");
  const expiredContext = server.requests.at(-1).messages.filter(
    (message) => message.role === "system",
  )[1].content;
  assert.ok(expiredContext.includes("用户喜欢咖啡"));
  assert.equal(expiredContext.includes("我今天想喝茶"), false);
  assert.equal(expiredContext.includes("时效:有效至"), false);
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
});

test("POL-SEMOP-001d/S5 同日改口复用同一临时身份，原地更新已同步副本", async (t) => {
  const ctx = await setupContext(t, "S5-same-day-rewrite");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  const aLong = entryOf(store, "a", "pref.coffee");
  store.memory.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: aLong.id, expectedVersion: aLong.version }],
  });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢咖啡"),
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const first = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    requestId: "s5-first",
  });
  assert.equal(first.status, "completed");

  const aBefore = temporaryEntryOf(store, "a");
  const bBefore = temporaryEntryOf(store, "b");
  assert.ok(aBefore, "发起人应有今日临时理解");
  assert.ok(bBefore, "已证明同一长期事实的B应同步今日理解");
  assert.equal(aBefore.factIdentityId, bBefore.factIdentityId);
  const bSnapshotBefore = store.memorySourceContext.resolve({
    characterId: "b",
    entryId: bBefore.id,
    expectedVersion: bBefore.version,
  });
  assert.equal(bSnapshotBefore.status, "ok");

  // 再改口只针对今天的当前理解；必须复用 T，而不是另造一组或写 corrected:。
  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "我今天想喝茶"),
        excerpt: "我今天想喝乌龙茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const second = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我刚才说错了，我今天想喝乌龙茶，请帮我改过来。",
    requestId: "s5-second",
  });
  assert.equal(second.status, "completed");

  const aAfter = temporaryEntryOf(store, "a");
  const bAfter = temporaryEntryOf(store, "b");
  assert.equal(aAfter.id, aBefore.id, "A 的今日理解应原地更新");
  assert.equal(bAfter.id, bBefore.id, "B 的同步副本应原地更新");
  assert.equal(aAfter.version, aBefore.version + 1);
  assert.equal(bAfter.version, bBefore.version + 1);
  assert.equal(aAfter.factIdentityId, aBefore.factIdentityId);
  assert.equal(bAfter.factIdentityId, aBefore.factIdentityId);
  assert.equal(bAfter.body, aAfter.body);
  assert.equal(aAfter.expiresAt, aBefore.expiresAt);
  assert.equal(/^(chat-correct:|corrected:)/u.test(aAfter.sourceId), false);
  assert.equal(/^(chat-correct:|corrected:)/u.test(bAfter.sourceId), false);
  assert.equal(store.memorySourceContext.isCurrent(bSnapshotBefore), false);
  const longAfter = entryOf(store, "a", "pref.coffee");
  assert.equal(longAfter.body, "用户喜欢咖啡");
  assert.equal(longAfter.version, aLong.version);
});

test("POL-SEMOP-001d/S10 到期恢复长期语境，次日新建临时身份且旧T不复活", async (t) => {
  const ctx = await setupContext(t, "S10-expiry-new-temporary");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  const aLong = entryOf(store, "a", "pref.coffee");
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢咖啡"),
        excerpt: "我今天想喝茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const first = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    requestId: "s10-first",
  });
  assert.equal(first.status, "completed");
  const firstTemp = temporaryEntryOf(store, "a");
  assert.ok(firstTemp);
  const firstRow = temporaryRow(store, firstTemp.id);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "现在先喝茶。", memoryCandidates: [] }),
  );
  const beforeExpiry = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "现在呢？",
    requestId: "s10-live",
  });
  assert.equal(beforeExpiry.status, "completed");
  const liveContext = lastSystemContext(server);
  assert.equal(
    liveContext.includes("用户喜欢咖啡"),
    false,
    "有效今日理解应抑制长期锚进入本轮上下文",
  );
  assert.ok(liveContext.includes("我今天想喝茶"));

  const expiresAt = endOfLocalDay(ctx.nowMs());
  ctx.advance(expiresAt - ctx.nowMs() + 1);
  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "之后再聊。", memoryCandidates: [] }),
  );
  const afterExpiry = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "后来呢？",
    requestId: "s10-expired",
  });
  assert.equal(afterExpiry.status, "completed");
  const expiredContext = lastSystemContext(server);
  assert.ok(expiredContext.includes("用户喜欢咖啡"));
  assert.equal(expiredContext.includes("我今天想喝茶"), false);
  assert.equal(temporaryEntryOf(store, "a"), null);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "用户喜欢咖啡"),
        excerpt: "我今天想喝奶茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const nextDay = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝奶茶，请帮我改过来。",
    requestId: "s10-next-day",
  });
  assert.equal(nextDay.status, "completed");

  const secondTemp = temporaryEntryOf(store, "a");
  assert.ok(secondTemp);
  assert.notEqual(secondTemp.id, firstTemp.id, "次日应新建临时条目，不复活旧条目");
  assert.notEqual(secondTemp.factIdentityId, firstTemp.factIdentityId, "次日应使用新的临时身份");
  const oldRow = temporaryRow(store, firstTemp.id);
  assert.equal(oldRow.body, firstRow.body);
  assert.equal(oldRow.expires_at, firstRow.expires_at);
  assert.equal(entryOf(store, "a", "pref.coffee").version, aLong.version);
});

test("POL-CHATMEM-001 “最近”期限不明确时最小澄清，不发明天数", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-vague");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "exp.qingdao",
    body: "用户曾在青岛吃蛤蜊",
    kind: "experience",
    sourceId: "seed-a-qingdao",
  });
  const conversation = openConversation(store);
  const entriesBefore = countRows(store.dbPath, "memory_entries");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我最近想喝茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我最近想喝茶，请帮我改过来。",
    requestId: "vague-temporal",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /时间范围我还不确定/u);
  assert.equal(result.reply.includes("已经更新"), false);
  assert.equal(countRows(store.dbPath, "memory_entries"), entriesBefore);
  assert.equal(entryOf(store, "a", "pref.coffee").body, "用户喜欢咖啡");
  assert.equal(entryOf(store, "a", "pref.coffee").version, 1);
  assert.equal(
    store.memory.listMemories("a").some((entry) => entry.factKey.includes(".current.")),
    false,
  );
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);

  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "我不知道。",
      memoryCandidates: [],
      memoryOperation: null,
    }),
  );
  const noSuggestion = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我最近想喝茶，请帮我改过来。",
    requestId: "vague-no-suggestion",
  });
  assert.equal(noSuggestion.status, "completed");
  assert.match(noSuggestion.reply, /时间范围我还不确定/u);
  assert.equal(entryOf(store, "a", "pref.coffee").body, "用户喜欢咖啡");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我明天想喝茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const tomorrow = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我明天想喝茶，请帮我改过来。",
    requestId: "unsupported-temporal",
  });
  assert.equal(tomorrow.status, "completed");
  assert.match(tomorrow.reply, /时间范围我还不确定/u);
  assert.equal(entryOf(store, "a", "pref.coffee").body, "用户喜欢咖啡");
  assert.equal(countRows(store.dbPath, "memory_entries"), entriesBefore);
});

function seedOperationFact(store, { factKey, body, kind }) {
  store.memory.remember({ characterId: "a", factKey, body, kind, sourceId: `seed-${factKey}` });
}

async function sendOperation(
  ctx,
  {
    factKey,
    text,
    excerpt,
    needle,
    target,
    requestId,
    operation = true,
    evidence = "请帮我改过来",
  },
) {
  const { store, server } = ctx;
  const conversation = openConversation(store);
  if (operation) {
    server.enqueue(({ body, res }) => sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: target ?? targetFromRequest(body, needle),
        excerpt,
        evidence,
      },
    }));
  } else {
    server.enqueue(({ res }) => sendEnvelope(res, {
      reply: "我记下了。", memoryCandidates: [], memoryOperation: null,
    }));
  }
  const before = entryOf(store, "a", factKey);
  const result = await store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id, text, requestId,
  });
  return { result, before, after: entryOf(store, "a", factKey) };
}

test("POL-CHATMEM-001 昨日已完成经历更正走 replace，不进入临时偏好", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-yesterday-experience");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, before, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "不是看流星，我们昨天去看烟花了，请帮我改过来。",
    excerpt: "我们昨天去看烟花了",
    needle: "流星",
    requestId: "yesterday-experience",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("时间范围我还不确定"), false);
  assert.match(after.body, /烟花/u);
  assert.equal(after.kind, "experience");
  assert.ok(after.version > before.version);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(
    ctx.store.memory.listMemories("a").some((entry) => entry.factKey.includes(".current.")),
    false,
  );
});

test("POL-CHATMEM-001 今日已完成经历走 replace，不当作今日临时偏好", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-today-experience");
  seedOperationFact(ctx.store, { factKey: "exp.today", body: "今天我去看了流星", kind: "experience" });
  const { result, before, after } = await sendOperation(ctx, {
    factKey: "exp.today",
    text: "不是流星，今天我去看了烟花，请帮我改过来。",
    excerpt: "今天我去看了烟花",
    needle: "流星",
    requestId: "today-experience",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("时间范围我还不确定"), false);
  assert.match(after.body, /烟花/u);
  assert.ok(after.version > before.version);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 今日偏好仍进入 temporary，长期不变", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-today-preference");
  seedOperationFact(ctx.store, { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference" });
  const { result, after } = await sendOperation(ctx, {
    factKey: "pref.coffee",
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    excerpt: "我今天想喝茶",
    needle: "咖啡",
    requestId: "today-preference",
  });
  assert.equal(result.status, "completed");
  const temp = temporaryEntryOf(ctx.store, "a");
  assert.ok(temp, "今日偏好仍应写入临时 current");
  assert.match(temp.body, /茶/u);
  assert.equal(after.body, "用户喜欢咖啡");
  assert.equal(after.version, 1);
});

test("POL-CHATMEM-001 模糊/未来时间与未来年份仍澄清，不永久改写", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-future-temporal");
  seedOperationFact(ctx.store, { factKey: "pref.coffee", body: "用户喜欢咖啡", kind: "preference" });
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我在2023年看过流星雨", kind: "experience" });
  const cases = [
    { text: "不是咖啡，我以后想喝茶，请帮我改过来。", excerpt: "我以后想喝茶", needle: "咖啡", factKey: "pref.coffee" },
    { text: "不是咖啡，我最近想喝茶，请帮我改过来。", excerpt: "我最近想喝茶", needle: "咖啡", factKey: "pref.coffee" },
    { text: "不是流星雨，我在2027年看的是烟花，请帮我改过来。", excerpt: "我在2027年看的是烟花", needle: "流星雨", factKey: "exp.meteor" },
    { text: "不是流星雨，今天我们已经约好明天去看烟花，请帮我改过来。", excerpt: "今天我们已经约好明天去看烟花", needle: "流星雨", factKey: "exp.meteor" },
    { text: "不是流星雨，今天我们已经约好2027年去看烟花，请帮我改过来。", excerpt: "今天我们已经约好2027年去看烟花", needle: "流星雨", factKey: "exp.meteor" },
    { text: "不是流星雨，昨天我们约好2027年去看烟花，请帮我改过来。", excerpt: "昨天我们约好2027年去看烟花", needle: "流星雨", factKey: "exp.meteor" },
  ];
  for (const [index, item] of cases.entries()) {
    const { result } = await sendOperation(ctx, {
      factKey: item.factKey, text: item.text, excerpt: item.excerpt, needle: item.needle,
      requestId: `future-temporal-${index}`,
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /时间范围我还不确定/u);
  }
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "用户喜欢咖啡");
  assert.equal(entryOf(ctx.store, "a", "exp.meteor").body, "我在2023年看过流星雨");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 非明确纠正即使模型提出 correct 也不执行", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-not-explicit");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "我们昨天去看烟花了",
    excerpt: "我们昨天去看烟花了",
    evidence: "我们昨天去看烟花了",
    needle: "流星",
    target: "M1",
    requestId: "not-explicit-correction",
  });
  assert.equal(result.status, "completed");
  assert.equal(after.body, "我们昨天去看流星了");
  assert.equal(after.version, 1);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 不同主体不写用户经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-different-subject");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "我姐姐昨天去看烟花了，请帮我改过来。",
    excerpt: "我姐姐昨天去看烟花了",
    needle: "流星",
    requestId: "different-subject",
  });
  assert.equal(result.status, "completed");
  assert.equal(after.body, "我们昨天去看流星了");
  assert.equal(after.version, 1);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 其他主体表达同样不写用户经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-other-subjects");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const cases = [
    { text: "我同事昨天去看烟花了，请帮我改过来。", excerpt: "我同事昨天去看烟花了" },
    { text: "她昨天去看烟花了，请帮我改过来。", excerpt: "她昨天去看烟花了" },
  ];
  for (const [index, item] of cases.entries()) {
    const { result, after } = await sendOperation(ctx, {
      factKey: "exp.meteor",
      text: item.text,
      excerpt: item.excerpt,
      needle: "流星",
      requestId: `other-subject-${index}`,
    });
    assert.equal(result.status, "completed");
    assert.equal(after.body, "我们昨天去看流星了");
    assert.equal(after.version, 1);
    assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  }
});

test("POL-CHATMEM-001 明确纠正主体时允许更新用户经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-explicit-subject");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, before, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "不是我，是我姐姐昨天去看烟花了，请帮我改过来。",
    excerpt: "我姐姐昨天去看烟花了",
    needle: "流星",
    requestId: "explicit-subject-correction",
  });
  assert.equal(result.status, "completed");
  assert.match(after.body, /烟花/u);
  assert.ok(after.version > before.version);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 改话题不覆盖已证实的用户经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-topic-change");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "不是我之前说的那件事，是我姐姐昨天去看烟花了，请帮我改过来。",
    excerpt: "我姐姐昨天去看烟花了",
    needle: "流星",
    requestId: "topic-change-subject",
  });
  assert.equal(result.status, "completed");
  assert.equal(after.body, "我们昨天去看流星了");
  assert.equal(after.version, 1);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(result.reply.includes("已按你给的原话更新"), false);
});

test("POL-CHATMEM-001 未知主体不覆盖已证实的用户经历", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-unknown-subject");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "用户昨天去看流星了", kind: "experience" });
  const { result, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "小明昨天去看烟花了，请帮我改过来。",
    excerpt: "小明昨天去看烟花了",
    needle: "流星",
    requestId: "unknown-subject-guard",
  });
  assert.equal(result.status, "completed");
  assert.equal(after.body, "用户昨天去看流星了");
  assert.equal(after.version, 1);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(result.reply.includes("已按你给的原话更新"), false);
});

test("POL-CHATMEM-001 省略主语的同类事件更正仍可更新", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-elliptical-correction");
  seedOperationFact(ctx.store, { factKey: "exp.meteor", body: "我们昨天去看流星了", kind: "experience" });
  const { result, before, after } = await sendOperation(ctx, {
    factKey: "exp.meteor",
    text: "不是看流星，是看烟花，请帮我改过来。",
    excerpt: "是看烟花",
    needle: "流星",
    requestId: "elliptical-correction",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("别人的事"), false);
  assert.match(after.body, /烟花/u);
  assert.ok(after.version > before.version);
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
});

test("POL-CHATMEM-001 同主体我/用户经历更正保持 replace", async (t) => {
  const cases = [
    {
      name: "self",
      factKey: "exp.meteorSelf",
      body: "我昨天去看流星了",
      text: "不是流星，我昨天去看烟花了，请帮我改过来。",
      excerpt: "我昨天去看烟花了",
    },
    {
      name: "user",
      factKey: "exp.meteorUser",
      body: "用户昨天去看了极光",
      text: "不是极光，用户昨天去看烟花了，请帮我改过来。",
      excerpt: "用户昨天去看烟花了",
      needle: "极光",
    },
  ];
  for (const item of cases) {
    const ctx = await setupContext(t, `POL-CHATMEM-001-self-subject-${item.name}`);
    seedOperationFact(ctx.store, { factKey: item.factKey, body: item.body, kind: "experience" });
    const { result, before, after } = await sendOperation(ctx, {
      factKey: item.factKey,
      text: item.text,
      excerpt: item.excerpt,
      needle: item.needle ?? "流星",
      requestId: `self-subject-${item.name}`,
    });
    assert.equal(result.status, "completed");
    assert.match(after.body, /烟花/u);
    assert.ok(after.version > before.version);
    assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  }
});

test("POL-CHATMEM-002 默认忘记删除 A/B、旧来源与 FTS 不能恢复，无关记录不变", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-002-all");
  const { store, server } = ctx;
  const { tea, bEntry } = seedTea(ctx);
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);
  const aContextBefore = store.memory.getContextVersion("a");
  const bContextBefore = store.memory.getContextVersion("b");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [
        {
          factKey: "pref.leak",
          body: "用户喜欢热茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢热茶",
        },
      ],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        // 模型试图缩成 self；用户原话没有“只你”，本地必须按默认 all 执行。
        scope: "self",
        evidence: "请忘记我喜欢热茶这件事。",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "forget-all",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    result.reply,
    "好，我已删除这件事的已有记录；旧来源不会自动恢复，如果以后你重新告诉我，我会按新的内容重新理解。",
  );
  assert.equal(result.reply.includes("已经删除。"), false);
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  assert.equal(entryOf(store, "b", "pref.tea"), null);
  assert.equal(store.memory.listMemories("c").length, 0);
  assert.ok(store.memory.getContextVersion("a") > aContextBefore);
  assert.ok(store.memory.getContextVersion("b") > bContextBefore);
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
  assert.equal(entryOf(store, "a", "detail.city").body, "用户住在杭州");
  assert.deepEqual(store.memory.searchMemories({ characterId: "a", query: "热茶" }), []);
  assert.deepEqual(store.memory.searchMemories({ characterId: "b", query: "热茶" }), []);
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "蛤蜊" }).length, 1);
  assert.equal(store.memory.buildContext({ characterId: "a" }).sections.preferences.length, 0);

  assert.equal(
    countRows(store.dbPath, "memory_forget_identity_controls"),
    2,
    "A 与 B 都应留下无正文的忘记控制",
  );
  assert.ok(store.memory.listExcludedSources("a").includes(sha256("seed-a-tea")));
  assert.ok(
    store.memory.listExcludedSources("b").includes(sha256(`relay:${tea.entry.id}:b`)),
  );
  for (const [characterId, sourceId] of [
    ["a", "seed-a-tea"],
    ["b", `relay:${tea.entry.id}:b`],
  ]) {
    const reimport = store.memory.applyExtractionBatch({
      characterId,
      sourceId,
      sourceVersion: 1,
      appliedAt: ctx.nowMs(),
      facts: [{ factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference" }],
    });
    assert.equal(reimport.applied, false);
    assert.equal(reimport.reason, "blocked_source");
  }
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  assert.equal(entryOf(store, "b", "pref.tea"), null);
  store.memory.rebuildSearchIndex();
  assert.deepEqual(store.memory.searchMemories({ characterId: "a", query: "热茶" }), []);
  assert.equal(entryOf(store, "a", "pref.leak"), null);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assert.equal(
    readOne(
      store.dbPath,
      "SELECT COUNT(*) AS count FROM memory_forget_identity_controls",
    ).count,
    2,
  );
  assert.equal(bEntry.version, 1);
  assertBusinessRowsUnchanged(store, businessBefore);

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(requestRow(store, "forget-all").status, "completed");
  const commandSource = messages.find((message) => message.role === "user").sourceId;
  assert.ok(store.memory.listExcludedSources("a").includes(sha256(commandSource)));
  const commandReimport = store.memory.applyExtractionBatch({
    characterId: "a",
    sourceId: commandSource,
    sourceVersion: 1,
    appliedAt: ctx.nowMs(),
    facts: [{ factKey: "pref.tea", body: "用户喜欢热茶", kind: "preference" }],
  });
  assert.equal(commandReimport.applied, false);
  assert.equal(commandReimport.reason, "blocked_source");

  ctx.reopen();
  assert.equal(ctx.store.memory.searchMemories({ characterId: "a", query: "热茶" }).length, 0);
  assert.equal(ctx.store.memory.searchMemories({ characterId: "a", query: "蛤蜊" }).length, 1);
  assert.equal(
    readOne(ctx.store.dbPath, "SELECT COUNT(*) AS count FROM memory_forget_identity_controls").count,
    2,
  );
});

test("POL-CHATMEM-002 明确“只你忘记”按 self 删除，B 内容与上下文保持准确", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-002-self");
  const { store, server } = ctx;
  seedTea(ctx);
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "你喜欢热茶。", memoryCandidates: [] }),
  );
  const first = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我喜欢热茶。",
    requestId: "self-context",
  });
  assert.equal(first.status, "completed");
  const aContextBefore = store.memory.getContextVersion("a");
  const bContextBefore = store.memory.getContextVersion("b");
  const bBefore = entryOf(store, "b", "pref.tea");

  // 模型即使返回 all，也只能按用户原话的“只你”执行 self。
  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经全部删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        scope: "all",
        evidence: "只你忘记这件事。",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "只你忘记这件事。",
    requestId: "forget-self",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    result.reply,
    "好，这件事我只在自己这里忘记；其他角色已知的内容不会因此改变。",
  );
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  const bAfter = entryOf(store, "b", "pref.tea");
  assert.equal(bAfter.body, "用户喜欢热茶");
  assert.equal(bAfter.version, bBefore.version);
  assert.equal(bAfter.derived, true);
  assert.equal(bAfter.narratorCharacterId, "a");
  assert.ok(store.memory.getContextVersion("a") > aContextBefore);
  assert.equal(store.memory.getContextVersion("b"), bContextBefore);
  assert.equal(store.memory.searchMemories({ characterId: "b", query: "热茶" }).length, 1);
  assert.equal(
    store.memory
      .buildContext({ characterId: "b" })
      .sections.preferences.some((entry) => entry.body === "用户喜欢热茶"),
    true,
  );
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
  assert.equal(entryOf(store, "a", "detail.city").body, "用户住在杭州");
  assert.deepEqual(store.memory.searchMemories({ characterId: "a", query: "热茶" }), []);
  assert.equal(store.memory.listMemories("c").length, 0);
  assertBusinessRowsUnchanged(store, businessBefore);

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 4);
  assert.equal(requestRow(store, "forget-self").status, "completed");

  ctx.reopen();
  assert.equal(entryOf(ctx.store, "a", "pref.tea"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.tea").body, "用户喜欢热茶");
});

test("POL-CHATMEM-003 聊天中禁止分享跨持有者持久生效且保留已有内容", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-003");
  const { store, server } = ctx;
  const { tea, bEntry } = seedTea(ctx);
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);
  const aContextBefore = store.memory.getContextVersion("a");
  const bContextBefore = store.memory.getContextVersion("b");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已撤回并阻止分享。",
      memoryCandidates: [],
      memoryOperation: {
        action: "restrictSharing",
        target: targetFromRequest(body, "热茶"),
        evidence: "不要再分享给别人了。",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我喜欢热茶这件事，不要再分享给别人了。",
    requestId: "restrict-share",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    result.reply,
    "好，之后我不会再把这件事分享或转告给其他角色；已经知道的内容不会因此撤回。",
  );
  assert.equal(result.reply.includes("撤回并阻止"), false);
  assert.equal(result.reply.includes("删除"), false);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢热茶");
  assert.equal(bEntry.body, "用户喜欢热茶");
  assert.equal(entryOf(store, "b", "pref.tea").version, 1);
  assert.equal(store.memory.getContextVersion("a"), aContextBefore);
  assert.equal(store.memory.getContextVersion("b"), bContextBefore);
  assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);
  assert.equal(
    readOne(
      store.dbPath,
      "SELECT identity_id FROM memory_share_identity_controls",
    ).identity_id,
    entryOf(store, "a", "pref.tea").factIdentityId,
  );
  assert.equal(store.memory.listMemories("c").length, 0);

  const aEntry = entryOf(store, "a", "pref.tea");
  assert.throws(
    () =>
      store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "c",
        entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
      }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  assert.throws(
    () =>
      store.memory.relay({
        fromCharacterId: "b",
        toCharacterId: "c",
        entries: [{ entryId: bEntry.id, expectedVersion: bEntry.version }],
      }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  assert.throws(
    () => store.memory.share({ fromCharacterId: "a", toCharacterId: "c", entryIds: [aEntry.id] }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  assert.equal(store.memory.listMemories("c").length, 0);
  assert.equal(store.memory.getContextVersion("c"), 0);
  assert.equal(entryOf(store, "a", "exp.qingdao").body, "用户曾在青岛吃蛤蜊");
  assertBusinessRowsUnchanged(store, businessBefore);

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(requestRow(store, "restrict-share").status, "completed");

  ctx.reopen();
  assert.equal(countRows(ctx.store.dbPath, "memory_share_identity_controls"), 1);
  const reopenedA = entryOf(ctx.store, "a", "pref.tea");
  assert.equal(reopenedA.body, "用户喜欢热茶");
  assert.equal(entryOf(ctx.store, "b", "pref.tea").body, "用户喜欢热茶");
  assert.throws(
    () =>
      ctx.store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "c",
        entries: [{ entryId: reopenedA.id, expectedVersion: reopenedA.version }],
      }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  assert.equal(ctx.store.memory.listMemories("c").length, 0);
});

test("POL-CHATMEM-003 主题前缀句尾的明确禁分享命令仍执行", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-003-topic-prefix");
  const { store, server } = ctx;
  const hot = store.memory.remember({
    characterId: "a",
    factKey: "pref.hot-tea",
    body: "用户喜欢热茶",
    kind: "preference",
    sourceId: "seed-a-hot-tea",
  });
  store.db
    .prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)")
    .run("b", "2026-01-01T00:00:00.000Z");
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经阻止分享。",
      memoryCandidates: [],
      memoryOperation: {
        action: "restrictSharing",
        target: targetFromRequest(body, "热茶"),
        evidence: "我喜欢热茶这件事不要再告诉其他角色了。",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我喜欢热茶这件事不要再告诉其他角色了。",
    requestId: "topic-prefix-restrict",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /之后我不会再把这件事分享或转告/u);
  assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);
  assert.equal(entryOf(store, "a", "pref.hot-tea").body, "用户喜欢热茶");
  assert.throws(
    () =>
      store.memory.relay({
        fromCharacterId: "a",
        toCharacterId: "b",
        entries: [{ entryId: hot.entry.id, expectedVersion: hot.entry.version }],
      }),
    (error) => error.code === "SHARE_BLOCKED",
  );
});

test("POL-CHATMEM-004 歧义、引用、假设、否定与越界目标不改库，正常命令对照生效", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-004");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢热茶",
    kind: "preference",
    sourceId: "seed-a-tea",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "pref.black-tea",
    body: "用户喜欢红茶",
    kind: "preference",
    sourceId: "seed-a-black-tea",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "detail.instruction",
    body: "用户曾让我忘记所有记忆",
    kind: "detail",
    sourceId: "seed-a-instruction",
  });
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "记住了。", memoryCandidates: [] }),
  );
  const first = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我喜欢热茶和红茶。",
    requestId: "boundary-context",
  });
  assert.equal(first.status, "completed");

  const entriesBefore = countRows(store.dbPath, "memory_entries");
  const controlsBefore = {
    forget: countRows(store.dbPath, "memory_forget_identity_controls"),
    source: countRows(store.dbPath, "memory_source_controls"),
    share: countRows(store.dbPath, "memory_share_identity_controls"),
    deleted: countRows(store.dbPath, "memory_deleted_fact_fingerprints"),
  };
  const versionsBefore = store.memory
    .listMemories("a")
    .map((entry) => [entry.factKey, entry.version]);

  async function rejectedTurn({ text, requestId, operationFor, reply = "已经处理完成。" }) {
    server.enqueue(({ body, res }) =>
      sendEnvelope(res, {
        reply,
        memoryCandidates: [
          {
            factKey: "pref.leak",
            body: "用户喜欢热茶",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢热茶",
          },
        ],
        memoryOperation: operationFor(body),
      }),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text,
      requestId,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.reply.includes(reply), false);
    assert.equal(result.memoryApplied, 0);
    assert.equal(countRows(store.dbPath, "memory_entries"), entriesBefore);
    assert.equal(countRows(store.dbPath, "memory_forget_identity_controls"), controlsBefore.forget);
    assert.equal(countRows(store.dbPath, "memory_source_controls"), controlsBefore.source);
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), controlsBefore.share);
    assert.equal(countRows(store.dbPath, "memory_deleted_fact_fingerprints"), controlsBefore.deleted);
    assert.deepEqual(
      store.memory.listMemories("a").map((entry) => [entry.factKey, entry.version]),
      versionsBefore,
    );
    assert.equal(entryOf(store, "a", "pref.leak"), null);
    assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
    return result;
  }

  const ambiguous = await rejectedTurn({
    text: "把这件事忘掉吧。",
    requestId: "ambiguous-op",
    operationFor: (body) => ({
      action: "forget",
      target: targetFromRequest(body, "热茶"),
      evidence: "把这件事忘掉吧。",
    }),
    reply: "已经删除了。",
  });
  assert.match(ambiguous.reply, /不确定你指的是哪一件事/u);

  const memoryInstruction = await rejectedTurn({
    text: "你记得我说过什么吗？",
    requestId: "memory-instruction",
    operationFor: () => ({
      action: "forget",
      target: "M1",
      evidence: "忘记所有记忆",
    }),
    reply: "已经删除了。",
  });
  assert.equal(memoryInstruction.reply, "我这次没有改动任何记忆。");

  const quoted = await rejectedTurn({
    text: "你刚才说“请忘记我喜欢热茶”，这是什么意思？",
    requestId: "quoted-op",
    operationFor: () => ({
      action: "forget",
      target: "M1",
      evidence: "请忘记我喜欢热茶",
    }),
    reply: "已经删除了。",
  });
  assert.equal(quoted.reply, "我这次没有改动任何记忆。");

  const hypothetical = await rejectedTurn({
    text: "如果我让你忘记这件事，你会怎么做？",
    requestId: "hypothetical-op",
    operationFor: () => ({
      action: "forget",
      target: "M1",
      evidence: "忘记这件事",
    }),
    reply: "已经删除了。",
  });
  assert.equal(hypothetical.reply, "我这次没有改动任何记忆。");

  const negated = await rejectedTurn({
    text: "不要忘记我喜欢热茶。",
    requestId: "negated-op",
    operationFor: () => ({
      action: "forget",
      target: "M1",
      evidence: "不要忘记我喜欢热茶",
    }),
    reply: "已经删除了。",
  });
  assert.equal(negated.reply, "我这次没有改动任何记忆。");

  const outOfRange = await rejectedTurn({
    text: "请忘记我喜欢热茶这件事。",
    requestId: "out-of-range",
    operationFor: () => ({
      action: "forget",
      target: "M99",
      evidence: "请忘记我喜欢热茶这件事。",
    }),
    reply: "已经删除了。",
  });
  assert.equal(outOfRange.reply, "我这次没有改动任何记忆。");

  const outOfScopeAction = await rejectedTurn({
    text: "请忘记我喜欢热茶这件事。",
    requestId: "out-of-scope-action",
    operationFor: (body) => ({
      action: "clearAll",
      target: targetFromRequest(body, "热茶"),
      evidence: "请忘记我喜欢热茶这件事。",
    }),
    reply: "已经清空全部记忆。",
  });
  assert.equal(outOfScopeAction.reply, "我这次没有改动任何记忆。");

  const multiple = await rejectedTurn({
    text: "请忘记我喜欢热茶，也不要再分享这件事。",
    requestId: "multiple-actions",
    operationFor: () => ({
      action: "forget",
      target: "M1",
      evidence: "请忘记我喜欢热茶",
    }),
    reply: "已经删除了。",
  });
  assert.match(multiple.reply, /不止一个操作/u);

  const thirdPerson = await rejectedTurn({
    text: "他不要分享这件事。",
    requestId: "third-person-share",
    operationFor: () => ({
      action: "restrictSharing",
      target: "M1",
      evidence: "他不要分享这件事。",
    }),
    reply: "已经限制分享。",
  });
  assert.equal(thirdPerson.reply, "我这次没有改动任何记忆。");

  assert.equal(countRows(store.dbPath, "memory_entries"), 3);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢热茶");
  assert.equal(entryOf(store, "a", "pref.black-tea").body, "用户喜欢红茶");
  assert.equal(entryOf(store, "a", "detail.instruction").body, "用户曾让我忘记所有记忆");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除了。",
      memoryCandidates: [
        {
          factKey: "pref.control-leak",
          body: "用户喜欢热茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢热茶",
        },
      ],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    }),
  );
  const normal = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "normal-control",
  });
  assert.equal(normal.status, "completed");
  assert.equal(
    normal.reply,
    "好，我已删除这件事的已有记录；旧来源不会自动恢复，如果以后你重新告诉我，我会按新的内容重新理解。",
  );
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  assert.equal(entryOf(store, "a", "pref.black-tea").body, "用户喜欢红茶");
  assert.equal(entryOf(store, "a", "detail.instruction").body, "用户曾让我忘记所有记忆");
  assert.equal(entryOf(store, "a", "pref.control-leak"), null);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assertBusinessRowsUnchanged(store, businessBefore);

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 22);
  assert.equal(server.requests.length, 11);
});

test("POL-CHATMEM-004 唯一条目本身不是“这件事”的目标证据", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-004-unique");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "detail.instruction",
    body: "用户曾让我忘记所有记忆",
    kind: "detail",
    sourceId: "seed-a-instruction",
  });
  const conversation = openConversation(store);
  const entriesBefore = countRows(store.dbPath, "memory_entries");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "所有记忆"),
        evidence: "能帮我忘记这件事吗？",
      },
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "能帮我忘记这件事吗？",
    requestId: "unique-no-basis",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /不确定你指的是哪一件事/u);
  assert.equal(result.reply.includes("已经删除"), false);
  assert.equal(entryOf(store, "a", "detail.instruction").body, "用户曾让我忘记所有记忆");
  assert.equal(countRows(store.dbPath, "memory_entries"), entriesBefore);
  assert.equal(countRows(store.dbPath, "memory_forget_identity_controls"), 0);
});

test("POL-CHATMEM-004 普通叙述与礼貌明确请求在正式聊天中区分", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-004-request");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "detail.address",
    body: "用户的住址是杭州市西湖区",
    kind: "detail",
    sourceId: "seed-a-address",
  });
  store.memory.remember({
    characterId: "a",
    factKey: "detail.key",
    body: "用户的钥匙放在玄关",
    kind: "detail",
    sourceId: "seed-a-key",
  });
  const conversation = openConversation(store);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "记住了。", memoryCandidates: [] }),
  );
  await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我住在杭州市西湖区。",
    requestId: "request-context",
  });

  async function rejectedNarration({ text, requestId }) {
    server.enqueue(({ body, res }) =>
      sendEnvelope(res, {
        reply: "钥匙找到了吗？",
        memoryCandidates: [],
        memoryOperation: {
          action: "forget",
          target: "M1",
          evidence: text,
        },
      }),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text,
      requestId,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.reply, "我这次没有改动任何记忆。");
    assert.equal(candidateBlockOf(bodyForLastRequest(server)), null);
    assert.equal(entryOf(store, "a", "detail.address").body, "用户的住址是杭州市西湖区");
    return result;
  }

  await rejectedNarration({ text: "我忘了带钥匙。", requestId: "narrative-only" });
  await rejectedNarration({
    text: "我忘了带钥匙，能帮我拿一下吗？",
    requestId: "narrative-plus-other-request",
  });
  await rejectedNarration({
    text: "我能忘记这件事吗？",
    requestId: "ability-question",
  });
  await rejectedNarration({
    text: "你能忘记这件事吗？",
    requestId: "second-person-ability-question",
  });

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "住址"),
        evidence: "能帮我忘记之前说的住址吗？",
      },
    }),
  );
  const polite = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "能帮我忘记之前说的住址吗？",
    requestId: "polite-forget",
  });
  assert.equal(polite.status, "completed");
  assert.match(polite.reply, /旧来源不会自动恢复/u);
  assert.equal(entryOf(store, "a", "detail.address"), null);
  assert.equal(entryOf(store, "a", "detail.key").body, "用户的钥匙放在玄关");
});

function bodyForLastRequest(server) {
  return server.requests.at(-1);
}

test("POL-CHATMEM-001 不确定词保留为 inferred，不接受模型删词", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-001-uncertain");
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "seed-a-coffee",
  });
  const conversation = openConversation(store);
  const text = "不是咖啡，我可能更喜欢茶，请帮我改过来。";

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我更喜欢茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const rejected = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text,
    requestId: "uncertain-dropped",
  });
  assert.equal(rejected.status, "completed");
  assert.equal(rejected.reply, "我这次没有改动任何记忆。");
  assert.equal(entryOf(store, "a", "pref.coffee").body, "用户喜欢咖啡");

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经更新。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我可能更喜欢茶",
        evidence: "请帮我改过来",
      },
    }),
  );
  const corrected = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text,
    requestId: "uncertain-kept",
  });
  assert.equal(corrected.status, "completed");
  assert.equal(
    corrected.reply,
    "好，我按你不确定的说法把这条记为“不是咖啡，我可能更喜欢茶”；原来源不会自动恢复。",
  );
  const entry = entryOf(store, "a", "pref.coffee");
  assert.equal(entry.body, "不是咖啡，我可能更喜欢茶");
  assert.equal(entry.trust, "inferred");
  assert.equal(entry.body.includes("可能"), true);
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "茶" }).length, 1);
});

test("POL-CHATMEM-002 超过20条时按话题检索，普通闲聊不发送候选", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-002-retrieval");
  const { store, server } = ctx;
  const original = store.memory.remember({
    characterId: "b",
    factKey: "detail.address",
    body: "用户的旧住址是杭州市西湖区",
    kind: "detail",
    importance: 1,
    sourceId: "seed-b-address",
  });
  store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "a",
    entries: [{ entryId: original.entry.id, expectedVersion: original.entry.version }],
  });
  for (let index = 1; index <= 25; index += 1) {
    store.memory.remember({
      characterId: "a",
      factKey: `detail.filler.${index}`,
      body: `用户保存了第${index}条测试记录`,
      kind: "detail",
      importance: 1,
      sourceId: `seed-a-filler-${index}`,
    });
  }
  const entriesBefore = countRows(store.dbPath, "memory_entries");
  const addressIndex = store.memory
    .listMemories("a")
    .findIndex((entry) => entry.factKey === "detail.address");
  assert.ok(addressIndex >= 20, "相关旧条目应位于旧候选前20条之外");
  const conversation = openConversation(store);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "今天也不错。", memoryCandidates: [] }),
  );
  await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "今天天气不错。",
    requestId: "plain-chat-no-candidates",
  });
  const plainBody = server.requests.at(-1);
  assert.equal(candidateBlockOf(plainBody), null);
  const plainMessages = JSON.stringify(plainBody.messages);
  assert.equal(plainMessages.includes("用户的旧住址是杭州市西湖区"), false);
  assert.equal(plainMessages.includes("第1条测试记录"), false);

  server.enqueue(({ body, res }) => {
    const block = candidateBlockOf(body);
    assert.ok(block, "管理回合应发送有预算的候选");
    assert.ok(block.length <= 600);
    assert.ok(block.includes("转述"));
    assert.ok(block.includes("听b说"));
    assert.equal(block.includes("第1条测试记录"), false);
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "旧住址"),
        evidence: "能帮我忘记之前说的旧住址吗？",
      },
    });
  });
  const forgotten = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "能帮我忘记之前说的旧住址吗？",
    requestId: "retrieved-old-entry",
  });
  assert.equal(forgotten.status, "completed");
  assert.equal(entryOf(store, "a", "detail.address"), null);
  assert.equal(entryOf(store, "b", "detail.address"), null);
  assert.equal(entryOf(store, "a", "detail.filler.1").body, "用户保存了第1条测试记录");
  assert.equal(entryOf(store, "a", "detail.filler.25").body, "用户保存了第25条测试记录");
  assert.equal(countRows(store.dbPath, "memory_entries"), entriesBefore - 2);

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "好，聊点别的。", memoryCandidates: [] }),
  );
  await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我们聊点别的。",
    requestId: "after-forget-chat",
  });
  assert.equal(
    JSON.stringify(server.requests.at(-1).messages).includes("旧住址"),
    false,
  );
});

test("POL-CHATMEM-002 删除命令来源不进入下一轮实际 messages，重启仍排除", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-002-command-source");
  const { store, server } = ctx;
  seedTea(ctx, { withUnrelated: false });
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    }),
  );
  const forgotten = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "command-source-forget",
  });
  assert.equal(forgotten.status, "completed");
  const history = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "请忘记我喜欢热茶这件事。");
  assert.equal(history[1].content, forgotten.reply);
  const commandSource = history[0].sourceId;
  assert.ok(store.memory.listExcludedSources("a").includes(sha256(commandSource)));

  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "好，聊点别的。", memoryCandidates: [] }),
  );
  await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "我们聊点别的。",
    requestId: "command-source-next",
  });
  const nextBody = JSON.stringify(server.requests.at(-1).messages);
  assert.equal(nextBody.includes("请忘记我喜欢热茶这件事"), false);
  assert.equal(nextBody.includes("热茶"), false);
  assert.equal(nextBody.includes("旧来源不会自动恢复"), false);

  ctx.reopen();
  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "还在。", memoryCandidates: [] }),
  );
  await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "还在吗？",
    requestId: "command-source-reopen",
  });
  const reopenedBody = JSON.stringify(server.requests.at(-1).messages);
  assert.equal(reopenedBody.includes("请忘记我喜欢热茶这件事"), false);
  assert.equal(reopenedBody.includes("热茶"), false);
  assert.equal(reopenedBody.includes("旧来源不会自动恢复"), false);
  assert.equal(
    ctx.store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.length,
    6,
  );
});

test("POL-CHATMEM-005 在途本地修改、取消与同 requestId 重复不执行旧操作", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-005");
  const { store, server } = ctx;
  seedTea(ctx);
  const conversation = openConversation(store);

  let releaseStale;
  const staleGate = new Promise((resolve) => {
    releaseStale = resolve;
  });
  server.enqueue(async ({ body, res }) => {
    await staleGate;
    sendEnvelope(res, {
      reply: "按旧目标删除。",
      memoryCandidates: [
        {
          factKey: "pref.stale-leak",
          body: "用户喜欢热茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢热茶",
        },
      ],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    });
  });
  const stalePending = store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "stale-target",
  });
  await waitFor(() => server.requests.length === 1);
  store.memory.correct({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢乌龙茶",
    sourceId: "local-correction",
  });
  releaseStale();
  const stale = await stalePending;
  assert.equal(stale.status, "stale");
  assert.equal(stale.reply, null);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢乌龙茶");
  assert.equal(entryOf(store, "b", "pref.tea").body, "用户喜欢乌龙茶");
  assert.equal(requestRow(store, "stale-target").status, "stale");
  assert.equal(entryOf(store, "a", "pref.stale-leak"), null);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assert.equal(
    store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.length,
    1,
  );

  let releaseCancel;
  const cancelGate = new Promise((resolve) => {
    releaseCancel = resolve;
  });
  server.enqueue(async ({ body, res }) => {
    await cancelGate;
    sendEnvelope(res, {
      reply: "取消后的迟到回复。",
      memoryCandidates: [
        {
          factKey: "pref.cancel-leak",
          body: "用户喜欢乌龙茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢乌龙茶",
        },
      ],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "乌龙茶"),
        evidence: "请忘记我喜欢乌龙茶这件事。",
      },
    });
  });
  const cancelledPending = store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢乌龙茶这件事。",
    requestId: "cancel-target",
  });
  await waitFor(() => server.requests.length === 2);
  const cancelled = store.chat.cancelRequest({
    characterId: "a",
    requestId: "cancel-target",
  });
  assert.equal(cancelled.cancelled, true);
  releaseCancel();
  const cancelledResult = await cancelledPending;
  assert.equal(cancelledResult.status, "cancelled");
  assert.equal(cancelledResult.reply, null);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢乌龙茶");
  assert.equal(requestRow(store, "cancel-target").status, "cancelled");
  assert.equal(entryOf(store, "a", "pref.cancel-leak"), null);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assert.equal(
    store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.filter((message) => message.role === "assistant").length,
    0,
  );

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "乌龙茶"),
        evidence: "请忘记我喜欢乌龙茶这件事。",
      },
    }),
  );
  const completed = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢乌龙茶这件事。",
    requestId: "idem-op",
  });
  assert.equal(completed.status, "completed");
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  assert.equal(entryOf(store, "b", "pref.tea"), null);
  const requestsAfter = server.requests.length;
  const messagesAfter = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages.length;
  const replay = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢乌龙茶这件事。",
    requestId: "idem-op",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.reply, completed.reply);
  assert.equal(server.requests.length, requestsAfter);
  assert.equal(
    store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.length,
    messagesAfter,
  );
});

test("POL-CHATMEM-005 重启遗留 pending 不执行操作，恢复后仍保留记忆", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-005-restart");
  const { store, server } = ctx;
  seedTea(ctx, { withUnrelated: false });
  const conversation = openConversation(store);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release?.());
  server.enqueue(async ({ body, res }) => {
    await gate;
    sendEnvelope(res, {
      reply: "重启前的迟到回复。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    });
  });
  const pending = store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "restart-target",
  });
  pending.catch(() => {});
  await waitFor(() => server.requests.length === 1);
  ctx.closeStore();
  ctx.reopen({ recoverInterrupted: true });
  assert.equal(
    ctx.store.chat.getRequest({ characterId: "a", requestId: "restart-target" }).status,
    "failed",
  );
  assert.equal(
    ctx.store.chat.getRequest({ characterId: "a", requestId: "restart-target" }).errorCode,
    "INTERRUPTED",
  );
  release();
  await pending.catch(() => {});
  await delay(50);
  assert.equal(entryOf(ctx.store, "a", "pref.tea").body, "用户喜欢热茶");
  assert.equal(entryOf(ctx.store, "b", "pref.tea").body, "用户喜欢热茶");
  assert.equal(
    ctx.store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.filter((message) => message.role === "assistant").length,
    0,
  );
});

async function runRollbackCase(t, { triggerSql, requestId, expectedStatus }) {
  const ctx = await setupContext(t, `POL-CHATMEM-006-${requestId}`);
  const { store, server } = ctx;
  seedTea(ctx);
  const conversation = openConversation(store);
  const contextVersionBefore = store.memory.getContextVersion("a");
  withDatabase(store.dbPath, (db) => db.exec(triggerSql));

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "本来要保存。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "热茶"),
        excerpt: "我其实喜欢无糖咖啡",
        evidence: "请帮我改过来",
      },
    }),
  );
  const failed = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是热茶，我其实喜欢无糖咖啡，请帮我改过来。",
    requestId,
  });
  assert.equal(failed.status, expectedStatus);
  assert.equal(failed.reply, null);
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢热茶");
  assert.equal(entryOf(store, "b", "pref.tea").body, "用户喜欢热茶");
  assert.equal(entryOf(store, "a", "pref.tea").version, 1);
  assert.equal(entryOf(store, "b", "pref.tea").version, 1);
  assert.equal(store.memory.getContextVersion("a"), contextVersionBefore);
  assert.equal(countRows(store.dbPath, "memory_source_controls"), 0);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assert.equal(requestRow(store, requestId).status, "failed");
  assert.equal(
    store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.filter((message) => message.role === "assistant").length,
    0,
  );

  withDatabase(store.dbPath, (db) => db.exec("DROP TRIGGER fail_chat_write"));
  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "这次保存。",
      memoryCandidates: [],
      memoryOperation: {
        action: "correct",
        target: targetFromRequest(body, "热茶"),
        excerpt: "我其实喜欢无糖咖啡",
        evidence: "请帮我改过来",
      },
    }),
  );
  const retried = await store.chat.retryRequest({ characterId: "a", requestId });
  assert.equal(retried.status, "completed");
  assert.equal(
    retried.reply,
    "好，这条记忆已按你给的原话更新为“不是热茶，我其实喜欢无糖咖啡”；原来源不会自动恢复。",
  );
  assert.equal(entryOf(store, "a", "pref.tea").body, "不是热茶，我其实喜欢无糖咖啡");
  assert.equal(entryOf(store, "b", "pref.tea").body, "不是热茶，我其实喜欢无糖咖啡");
  assert.equal(entryOf(store, "a", "pref.tea").version, 2);
  assert.equal(requestRow(store, requestId).status, "completed");
  assert.equal(
    store.chat.getConversation({ characterId: "a", conversationId: conversation.id })
      .messages.length,
    2,
  );
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "热茶" }).length, 1);
  assert.equal(
    store.memory.searchMemories({ characterId: "a", query: "热茶" })[0].body,
    "不是热茶，我其实喜欢无糖咖啡",
  );
  const requestCount = server.requests.length;
  const repeated = await store.chat.retryRequest({ characterId: "a", requestId });
  assert.equal(repeated.status, "completed");
  assert.equal(server.requests.length, requestCount);

  const oldBodyRows = readOne(
    store.dbPath,
    "SELECT COUNT(*) AS count FROM memory_entries WHERE body = '用户喜欢热茶'",
  );
  assert.equal(oldBodyRows.count, 0);
}

test("POL-CHATMEM-006 助手回复写入失败时记忆整笔回滚，解除后同请求一次成功", async (t) => {
  await runRollbackCase(t, {
    requestId: "rollback-assistant",
    expectedStatus: "failed",
    triggerSql: `
      CREATE TRIGGER fail_chat_write BEFORE INSERT ON chat_messages
      WHEN NEW.role = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'injected assistant write failure'); END;
    `,
  });
});

test("POL-CHATMEM-006 request 最后一写失败时记忆与回复整笔回滚", async (t) => {
  await runRollbackCase(t, {
    requestId: "rollback-request",
    expectedStatus: "failed",
    triggerSql: `
      CREATE TRIGGER fail_chat_write BEFORE UPDATE ON chat_requests
      WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'injected request write failure'); END;
    `,
  });
});

test("POL-CHATMEM-006 删除失败时命令来源排除与记忆一起回滚", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-006-forget-source");
  const { store, server } = ctx;
  seedTea(ctx, { withUnrelated: false });
  const conversation = openConversation(store);
  withDatabase(store.dbPath, (db) =>
    db.exec(`
      CREATE TRIGGER fail_chat_write BEFORE INSERT ON chat_messages
      WHEN NEW.role = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'injected assistant write failure'); END;
    `),
  );

  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "已经删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    }),
  );
  const failed = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我喜欢热茶这件事。",
    requestId: "forget-source-rollback",
  });
  assert.equal(failed.status, "failed");
  assert.equal(entryOf(store, "a", "pref.tea").body, "用户喜欢热茶");
  const failedHistory = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(failedHistory.length, 1);
  const commandSource = failedHistory[0].sourceId;
  assert.equal(
    store.memory.listExcludedSources("a").includes(sha256(commandSource)),
    false,
  );
  assert.equal(countRows(store.dbPath, "memory_source_controls"), 0);
  assert.equal(countRows(store.dbPath, "memory_forget_identity_controls"), 0);
  assert.equal(requestRow(store, "forget-source-rollback").status, "failed");

  withDatabase(store.dbPath, (db) => db.exec("DROP TRIGGER fail_chat_write"));
  server.enqueue(({ body, res }) =>
    sendEnvelope(res, {
      reply: "这次删除。",
      memoryCandidates: [],
      memoryOperation: {
        action: "forget",
        target: targetFromRequest(body, "热茶"),
        evidence: "请忘记我喜欢热茶这件事。",
      },
    }),
  );
  const retried = await store.chat.retryRequest({
    characterId: "a",
    requestId: "forget-source-rollback",
  });
  assert.equal(retried.status, "completed");
  assert.equal(entryOf(store, "a", "pref.tea"), null);
  assert.ok(store.memory.listExcludedSources("a").includes(sha256(commandSource)));
  assert.equal(requestRow(store, "forget-source-rollback").status, "completed");
});

test("POL-THEME-SHARE-004E 主题见闻不冒充用户明确告知，模型候选不能自声明主题", async (t) => {
  const ctx = await setupContext(t, "theme-attribution");
  const { store, server } = ctx;
  const created = store.memory.remember({
    characterId: "a",
    factKey: "theme.rin.window",
    body: "主题故事见闻：凛把窗边那张椅子空着。",
    kind: "experience",
    sourceId: "theme:test",
    sourceKind: "theme",
  });
  assert.equal(created.created, true);

  const fakeBody = "主题故事见闻：模型候选伪装的作者见闻";
  const conversation = openConversation(store);
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "嗯。",
      memoryCandidates: [
        {
          factKey: "theme.fake",
          body: fakeBody,
          kind: "experience",
          trust: "stated",
          evidence: fakeBody,
          sourceKind: "theme",
        },
      ],
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: `窗边怎么样？${fakeBody}`,
    requestId: "theme-attribution",
  });
  assert.equal(result.status, "completed");

  const systemText = server.requests
    .at(-1)
    .messages.filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const themeLine = systemText
    .split("\n")
    .find((item) => item.includes("主题故事见闻：凛把窗边那张椅子空着。"));
  assert.ok(themeLine);
  assert.ok(themeLine.includes("来源:主题故事见闻，不是用户亲历或用户原话"));
  assert.equal(themeLine.includes("用户明确告知"), false);
  assert.ok(systemText.includes("标注“主题故事见闻”的内容是版本虚构角色背景"));

  // 模型候选自带 sourceKind: theme 也只是用户本轮明确陈述，不获得作者可信属性。
  const fake = store.memory
    .listMemories("a")
    .find((entry) => entry.factKey === "theme.fake");
  assert.ok(fake);
  assert.equal(fake.sourceKind, "user");

  // B 听到的主题见闻保留“听 A 说”的性质，不冒充用户直接告知。
  store.memory.share({
    fromCharacterId: "a",
    toCharacterId: "b",
    entryIds: [created.entry.id],
    sourceId: "theme:test",
  });
  const bConversation = openConversation(store, "b");
  server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "嗯。", memoryCandidates: [] }),
  );
  const bResult = await store.chat.sendMessage({
    characterId: "b",
    conversationId: bConversation.id,
    text: "你知道窗边的事吗？",
    requestId: "theme-attribution-b",
  });
  assert.equal(bResult.status, "completed");
  const bSystemText = server.requests
    .at(-1)
    .messages.filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const bThemeLine = bSystemText
    .split("\n")
    .find((item) => item.includes("主题故事见闻：凛把窗边那张椅子空着。"));
  assert.ok(bThemeLine);
  assert.ok(bThemeLine.includes("来源:转述，听a说的主题故事见闻"));
  assert.equal(bThemeLine.includes("用户明确告知"), false);
});

/* S03o-A：显式 memoryOperation:null 的单轮明确 correct 本地补全。
   测试不启用关系核验；两阶段与 B 传播由 memory-semantic-operations 覆盖。 */
test("POL-CHATMEM-CLARIFY-002a 显式null单轮本地补全，不采用模型成功/澄清文案", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-CLARIFY-002a-null");
  seedOperationFact(ctx.store, {
    factKey: "pref.coffee",
    body: "我平时喝咖啡一定要加糖",
    kind: "preference",
  });
  const conversation = openConversation(ctx.store);
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "已经改好了。",
    // 该候选能通过 parse（正文/证据在本轮原话内），但操作回合不得再学习成新事实。
    memoryCandidates: [{
      factKey: "pref.null-answer",
      body: "我今天想喝茶",
      kind: "preference",
      trust: "stated",
      evidence: "我今天想喝茶",
    }],
    memoryOperation: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，请帮我改过来。",
    requestId: "clarify-null-temporary",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("已经改好了"), false);
  assert.match(result.reply, /^好，我记下了你今天的这条情况/u);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我平时喝咖啡一定要加糖");
  assert.match(temporaryEntryOf(ctx.store, "a").body, /茶/u);
  assert.equal(entryOf(ctx.store, "a", "pref.null-answer"), null);
  assert.equal(countRows(ctx.store.dbPath, "memory_extraction_batches"), 0);
});

test("POL-CHATMEM-CLARIFY-002f 非法operation与缺少operation字段均不触发本地补全", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-CLARIFY-002f-no-fallback");
  seedOperationFact(ctx.store, {
    factKey: "pref.coffee",
    body: "我平时喝咖啡一定要加糖",
    kind: "preference",
  });
  const conversation = openConversation(ctx.store);
  const entriesBefore = countRows(ctx.store.dbPath, "memory_entries");

  for (const envelope of [
    {
      reply: "已经改好了。",
      memoryCandidates: [],
      memoryOperation: { action: "clearAll", target: "M1", evidence: "请帮我改过来" },
    },
    {
      reply: "已经改好了。",
      memoryCandidates: [],
      // 缺少 memoryOperation 字段，不是显式 null，不进入本地补全。
    },
  ]) {
    ctx.server.enqueue(({ res }) => sendEnvelope(res, envelope));
    const result = await ctx.store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "不是咖啡，我今天想喝茶，请帮我改过来。",
      requestId: crypto.randomUUID(),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.reply, "我这次没有改动任何记忆。");
    assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我平时喝咖啡一定要加糖");
    assert.equal(temporaryEntryOf(ctx.store, "a"), null);
    assert.equal(countRows(ctx.store.dbPath, "memory_entries"), entriesBefore);
  }
});

test("POL-CHATMEM-CLARIFY-002g1 显式null纯提问命令零写", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-CLARIFY-002g1-question");
  seedOperationFact(ctx.store, {
    factKey: "pref.coffee",
    body: "我平时喝咖啡一定要加糖",
    kind: "preference",
  });
  const conversation = openConversation(ctx.store);
  const entriesBefore = countRows(ctx.store.dbPath, "memory_entries");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "已经改好了。",
    memoryCandidates: [],
    memoryOperation: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我今天想喝茶，你会帮我改过来吗？",
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("已经改好了"), false);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我平时喝咖啡一定要加糖");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(countRows(ctx.store.dbPath, "memory_entries"), entriesBefore);
});

/* S03o-B forget 目标澄清：真实 chat/SQLite + 构造 chat/关系 HTTP。 */
function relationDescription() {
  return { subject: "用户", subjectQuote: "我", scope: "current", time: null, timeQuote: null };
}

function relationResponder(relation = "equivalent", delayMs = 0) {
  return ({ body, res }) => {
    const pairs = JSON.parse(body.messages.find((message) => message.role === "user").content).pairs;
    const results = pairs.map((pair) => ({
      pair: pair.id, relation, left: relationDescription(), right: relationDescription(),
    }));
    const send = () => sendEnvelope(res, { results });
    if (!delayMs) return send();
    return new Promise((resolve) => setTimeout(() => { send(); resolve(); }, delayMs));
  };
}

const isRelationRequest = (body) => Boolean(body?.messages?.some((message) =>
  message.role === "system" && message.content.includes("记忆事实关系判定器")));
const relationRequests = (ctx) => ctx.server.requests.filter(isRelationRequest);
const chatRequests = (ctx) => ctx.server.requests.filter((body) => !isRelationRequest(body));

async function seedChatFact(ctx, conversation, {
  characterId = "a", text, factKey, kind = "preference",
}) {
  const evidence = text.replace(/[。！!]+$/u, "");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "我记下了。",
    memoryCandidates: [{ factKey, body: evidence, kind, trust: "stated", evidence }],
    memoryOperation: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  const entry = entryOf(ctx.store, characterId, factKey);
  assert.ok(entry, `种子记忆未写入 ${factKey}`);
  return entry;
}

async function askForget(ctx, conversation, {
  text = "请忘记我喜欢咖啡这件事。", requestId, reply = "模型说已经删除了。",
} = {}) {
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply, memoryCandidates: [], memoryOperation: null,
  }));
  return ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id, text,
    requestId: requestId ?? crypto.randomUUID(),
  });
}

async function answerForget(ctx, conversation, text, requestId, relation = null, relationDelayMs = 0) {
  if (relation) ctx.server.enqueue(relationResponder(relation, relationDelayMs));
  return ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id, text, requestId,
  });
}

function requestRowFull(dbPath, requestId) {
  return readOne(
    dbPath,
    "SELECT status, error_code, memory_applied, verification_status, operation_proof FROM chat_requests WHERE id = ?",
    requestId,
  );
}

async function waitVerification(ctx, requestId) {
  await waitFor(() => requestRowFull(ctx.store.dbPath, requestId).verification_status !== "pending");
  return requestRowFull(ctx.store.dbPath, requestId).verification_status;
}

function conversationMessages(ctx, conversationId, characterId = "a") {
  return ctx.store.chat.getConversation({ characterId, conversationId }).messages;
}

function candidateLinesOf(body) {
  return body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")
    .split("\n")
    .filter((line) => /^\[M\d+\]/u.test(line));
}

function questionLines(reply) {
  return [...reply.matchAll(/\[第 (\d+) 条\] ([^\n]+)/gu)].map((match) => ({
    display: Number(match[1]), body: match[2],
  }));
}

test("POL-CHATMEM-FORGET-CLARIFY-001/010 本地提问不透传模型reply且不改记忆", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-001-question");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  const result = await askForget(ctx, conversation, {
    requestId: "clarify-question", reply: "我已经删除了你喜欢咖啡的记忆。",
  });
  assert.equal(result.status, "completed");
  assert.match(result.reply, /我只找到一条可能相关的记忆/u);
  assert.match(result.reply, /\[第 1 条\] 我平时喝咖啡一定要加糖/u);
  assert.equal(result.reply.includes("我已经删除了"), false, "不得透传模型成功文案");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我平时喝咖啡一定要加糖");
  assert.equal(relationRequests(ctx).length, 0);
  const row = requestRowFull(ctx.store.dbPath, "clarify-question");
  assert.equal(row.status, "completed");
  assert.equal(row.memory_applied, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-001b 第1条承接原命令并双source防回流", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-001b-number");
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedChatFact(ctx, aConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await seedChatFact(ctx, bConversation, {
    characterId: "b", text: "我的咖啡都要甜的。", factKey: "pref.coffeeB",
  });
  const question = await askForget(ctx, aConversation, { requestId: "clarify-number-q" });
  assert.match(question.reply, /\[第 1 条\]/u);
  const chatBefore = chatRequests(ctx).length;
  const relationBefore = relationRequests(ctx).length;

  const answer = await answerForget(
    ctx, aConversation, "第 1 条", "clarify-number-a", "equivalent", 300,
  );
  assert.equal(answer.status, "completed");
  const duringAssistants = conversationMessages(ctx, aConversation.id)
    .filter((message) => message.role === "assistant").length;
  assert.equal(await waitVerification(ctx, "clarify-number-a"), "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffeeB"), null);
  assert.equal(relationRequests(ctx).length, relationBefore + 1);
  assert.equal(chatRequests(ctx).length, chatBefore, "回答回合不得再调用聊天模型");
  assert.equal(
    conversationMessages(ctx, aConversation.id).filter((message) => message.role === "assistant").length,
    duringAssistants,
    "阶段2必须原位更新同一 assistant",
  );

  const messages = conversationMessages(ctx, aConversation.id);
  const command = messages.find((message) => message.role === "user" && message.content.includes("请忘记"));
  const answerMessage = messages.find((message) => message.role === "user" && message.content === "第 1 条");
  const excluded = ctx.store.memory.listExcludedSources("a");
  assert.ok(excluded.includes(sha256(command.sourceId)), "原命令 source 应被排除");
  assert.ok(excluded.includes(sha256(answerMessage.sourceId)), "回答 source 应被排除");
  const proof = JSON.parse(requestRowFull(ctx.store.dbPath, "clarify-number-a").operation_proof);
  assert.equal(proof.commandSourceHash, sha256(command.sourceId), "commandSourceHash 只对应原命令");
  assert.equal(proof.commandSourceId, command.sourceId);
  assert.ok(proof.sourceControls.a.includes(sha256(command.sourceId)));
  assert.ok(proof.sourceControls.a.includes(sha256(answerMessage.sourceId)));
  assert.equal(answer.reply.includes("更正"), false);
});

test("POL-CHATMEM-FORGET-CLARIFY-001c 描述式选择只接受原候选快照", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-001c-description");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-desc-q" });
  const answer = await answerForget(ctx, conversation, "加糖那条", "clarify-desc-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-002 多候选按显示第2条删除对应内部目标", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-002-multi");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee1",
  });
  await seedChatFact(ctx, conversation, {
    text: "我喜欢在下午喝咖啡。", factKey: "pref.coffee2",
  });
  const question = await askForget(ctx, conversation, { requestId: "clarify-multi-q" });
  const lines = questionLines(question.reply);
  assert.equal(lines.length, 2, "两条 topic 匹配候选都应显示");
  const chosen = lines.find((line) => line.display === 2);
  assert.ok(chosen, "缺少第2条");
  const chosenFactKey = chosen.body.includes("下午") ? "pref.coffee2" : "pref.coffee1";
  const otherFactKey = chosenFactKey === "pref.coffee1" ? "pref.coffee2" : "pref.coffee1";
  const answer = await answerForget(
    ctx, conversation, "第 2 条", "clarify-multi-a", "different",
  );
  assert.equal(answer.status, "completed");
  assert.equal(await waitVerification(ctx, "clarify-multi-a"), "completed");
  assert.equal(entryOf(ctx.store, "a", chosenFactKey), null);
  assert.ok(entryOf(ctx.store, "a", otherFactKey), "未选候选必须保留");
  assert.equal(relationRequests(ctx).length, 1, "独立候选只做一次关系核验");
});

test("POL-CHATMEM-FORGET-CLARIFY-003 无效/否定/引用/假设/新事实选择均本地未操作", async (t) => {
  const answers = [
    "加糖那条不要删",
    "加糖那条？",
    "“加糖那条”",
    "如果加糖那条",
    "加糖那条是我朋友的",
    "第 9 条",
  ];
  for (const [index, text] of answers.entries()) {
    const ctx = await setupContext(t, `FORGET-CLARIFY-003-${index}`);
    const conversation = openConversation(ctx.store);
    await seedChatFact(ctx, conversation, {
      text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
    });
    await askForget(ctx, conversation, { requestId: `clarify-invalid-q-${index}` });
    const chatBefore = chatRequests(ctx).length;
    const relationBefore = relationRequests(ctx).length;
    const answer = await answerForget(ctx, conversation, text, `clarify-invalid-a-${index}`);
    assert.equal(answer.status, "completed");
    assert.match(answer.reply, /没有改动任何记忆/u);
    assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "旧 forget 不得执行");
    assert.equal(chatRequests(ctx).length, chatBefore, "拒绝回合不得调用聊天模型");
    assert.equal(relationRequests(ctx).length, relationBefore);
  }
});

test("POL-CHATMEM-FORGET-CLARIFY-004 新明确命令优先并清旧pending", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-004-new-command");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await seedChatFact(ctx, conversation, {
    text: "我住在杭州。", factKey: "detail.city", kind: "detail",
  });
  await askForget(ctx, conversation, { requestId: "clarify-old-q" });
  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, {
    reply: "好的。",
    memoryCandidates: [],
    memoryOperation: {
      action: "forget",
      target: targetFromRequest(body, "杭州"),
      scope: "all",
      evidence: "请忘记我住在杭州这件事",
    },
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "请忘记我住在杭州这件事。",
    requestId: "clarify-new-a",
  });
  assert.equal(result.status, "completed");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "旧目标不得被删除");
  assert.equal(entryOf(ctx.store, "a", "detail.city"), null);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-005 context变化阻止旧pending执行", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005-stale-context");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-stale-q" });
  ctx.store.memory.remember({
    characterId: "a", factKey: "detail.city", body: "用户住在杭州",
    kind: "detail", sourceId: "seed-city-between",
  });
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-stale-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /已经变化/u);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-005b 目标被外部删除阻止旧pending", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005b-target-deleted");
  const conversation = openConversation(ctx.store);
  const coffee = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-target-q" });
  ctx.store.memory.forget({
    characterId: "a", entryId: coffee.id, expectedVersion: coffee.version,
  });
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-target-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /已经变化/u);
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-005c 目标来源被排除阻止旧pending", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005c-source-excluded");
  const conversation = openConversation(ctx.store);
  const coffee = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  const city = await seedChatFact(ctx, conversation, {
    text: "我住在杭州。", factKey: "detail.city", kind: "detail",
  });
  await askForget(ctx, conversation, { requestId: "clarify-source-q" });
  ctx.store.memory.forget({
    characterId: "a", entryId: city.id, expectedVersion: city.version,
    scope: "all", sourceIdsToExclude: [coffee.sourceId],
  });
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-source-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /已经变化/u);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "来源失效不得执行旧删除");
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

function latestUserSourceId(ctx, characterId = "a") {
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

async function failSelectionWithTrigger(ctx, conversation, entry, requestId) {
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_forget_selection BEFORE DELETE ON memory_entries
    WHEN old.id = '${entry.id}'
    BEGIN SELECT RAISE(ABORT, 'fixture forget failure'); END;
  `));
  const result = await answerForget(ctx, conversation, "第 1 条", requestId);
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_forget_selection"));
  assert.equal(result.status, "failed");
  assert.equal(
    requestRowFull(ctx.store.dbPath, requestId).error_code,
    "FORGET_SELECTION_FAILED",
  );
  return result;
}

function advanceToLocalTime(ctx, hours, minutes, seconds) {
  const date = new Date(ctx.nowMs());
  date.setHours(hours, minutes, seconds, 0);
  let target = date.getTime();
  if (target <= ctx.nowMs()) {
    target += 24 * 60 * 60 * 1000;
  }
  ctx.advance(target - ctx.nowMs());
}

test("POL-CHATMEM-FORGET-CLARIFY-005d 未过期临时理解可作为删除目标", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005d-temporary-target");
  const conversation = openConversation(ctx.store);
  const coffee = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "我今天想喝茶。", requestId: "temporary-source-message",
  });
  const nowMs = ctx.nowMs();
  ctx.store.memory.applyTemporaryUnderstanding({
    characterId: "a",
    entryId: coffee.id,
    expectedVersion: coffee.version,
    body: "我今天想喝茶",
    trust: "stated",
    expiresAt: endOfLocalDay(nowMs),
    sourceId: latestUserSourceId(ctx, "a"),
    nowMs,
  });
  assert.ok(temporaryEntryOf(ctx.store, "a"), "应存在未过期临时理解");
  const question = await askForget(ctx, conversation, {
    text: "请忘记我今天喝茶这件事。", requestId: "clarify-temp-q",
  });
  assert.match(question.reply, /我今天想喝茶/u);
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-temp-a");
  assert.equal(answer.status, "completed");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null, "未过期临时理解应被删除");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "长期事实不得被临时目标删除");
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-005e 仅source控制变化阻止旧pending且context不变", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005e-source-only");
  const conversation = openConversation(ctx.store);
  const coffee = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-source-only-q" });
  const contextBefore = ctx.store.memory.getContextVersion("a");
  withDatabase(ctx.store.dbPath, (db) => {
    db.prepare(`
      INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256(coffee.sourceId), ctx.nowMs());
  });
  assert.equal(ctx.store.memory.getContextVersion("a"), contextBefore, "fixture 只改来源控制");
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-source-only-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /已经变化/u);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "来源控制变化不得执行旧删除");
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-005f 过期临时理解不被提问或删除", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-005f-expired-temporary");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "我今天想喝茶。", requestId: "expired-temp-source",
  });
  const nowMs = ctx.nowMs();
  ctx.store.memory.applyTemporaryUnderstanding({
    characterId: "a",
    entryId: entryOf(ctx.store, "a", "pref.coffee").id,
    expectedVersion: entryOf(ctx.store, "a", "pref.coffee").version,
    body: "我今天想喝茶",
    trust: "stated",
    expiresAt: nowMs + 1000,
    sourceId: latestUserSourceId(ctx, "a"),
    nowMs,
  });
  ctx.advance(2000);
  const result = await askForget(ctx, conversation, {
    text: "请忘记我今天喝茶这件事。", requestId: "clarify-expired-temp-q",
  });
  assert.equal(result.reply, "我这次没有改动任何记忆。");
  assert.equal(result.reply.includes("[第 1 条]"), false, "过期临时项不得成为候选");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  const expiredRows = withDatabase(ctx.store.dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS count FROM memory_entries
    WHERE character_id = 'a' AND expires_at IS NOT NULL
  `).get().count);
  assert.ok(expiredRows > 0, "过期行仍在存储中，但检索排除");
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-006 pending按角色+会话隔离", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-006-isolation");
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedChatFact(ctx, aConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, aConversation, { requestId: "clarify-isolation-q" });
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  const bAnswer = await ctx.store.chat.sendMessage({
    characterId: "b", conversationId: bConversation.id,
    text: "第 1 条", requestId: "clarify-isolation-b",
  });
  assert.equal(bAnswer.status, "completed");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "B会话不得承接A的pending");
  const aAnswer = await answerForget(ctx, aConversation, "第 1 条", "clarify-isolation-a");
  assert.equal(aAnswer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "A原会话仍应可执行");
});

test("POL-CHATMEM-FORGET-CLARIFY-006b 普通闲聊清pending且不执行旧forget", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-006b-ordinary-chat");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-topic-q" });
  const chatBefore = chatRequests(ctx).length;
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "今天天气不错。", memoryCandidates: [], memoryOperation: null,
  }));
  const ordinary = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "今天天气怎么样？", requestId: "clarify-topic-chat",
  });
  assert.equal(ordinary.status, "completed");
  assert.equal(ordinary.reply, "今天天气不错。");
  assert.equal(chatRequests(ctx).length, chatBefore + 1, "普通闲聊走正常聊天路径");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  const after = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "第 1 条", requestId: "clarify-topic-after",
  });
  assert.equal(after.status, "completed");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "pending已清，不得执行旧forget");
  assert.equal(chatRequests(ctx).length, chatBefore + 2);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-006c 普通假设闲聊不被选择语法拦截", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-006c-hypothetical-chat");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-hypo-q" });
  const chatBefore = chatRequests(ctx).length;
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "那就聊聊雨天。", memoryCandidates: [], memoryOperation: null,
  }));
  const ordinary = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "如果明天下雨，我们聊点什么？", requestId: "clarify-hypo-chat",
  });
  assert.equal(ordinary.status, "completed");
  assert.equal(ordinary.reply, "那就聊聊雨天。");
  assert.equal(chatRequests(ctx).length, chatBefore + 1, "普通假设闲聊应走正常模型");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "旧forget不得执行");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  const after = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "第 1 条", requestId: "clarify-hypo-after",
  });
  assert.equal(after.status, "completed");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "pending已清，后续选择式文本不得执行");
  assert.equal(chatRequests(ctx).length, chatBefore + 2);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-006d 同角色不同会话不承接pending", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-006d-same-character");
  const first = openConversation(ctx.store);
  const second = openConversation(ctx.store);
  await seedChatFact(ctx, first, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, first, { requestId: "clarify-char-q" });
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  const other = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: second.id,
    text: "第 1 条", requestId: "clarify-char-other",
  });
  assert.equal(other.status, "completed");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "另一会话不得承接");
  const answer = await answerForget(ctx, first, "第 1 条", "clarify-char-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "原会话仍应执行");
});

test("POL-CHATMEM-FORGET-CLARIFY-007 同identity阶段1直接删除且关系0次", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-007-same-identity");
  const conversation = openConversation(ctx.store);
  const aEntry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
  });
  const bEntry = entryOf(ctx.store, "b", "pref.coffee");
  assert.ok(bEntry);
  assert.equal(bEntry.factIdentityId, aEntry.factIdentityId, "fixture 必须同 identity");
  await askForget(ctx, conversation, { requestId: "clarify-same-q" });
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-same-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.store, "b", "pref.coffee"), null);
  assert.equal(relationRequests(ctx).length, 0);
  assert.equal(answer.reply.includes("核对"), false);
});

test("POL-CHATMEM-FORGET-CLARIFY-007b scope self 同identity不删B", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-007b-self-same");
  const conversation = openConversation(ctx.store);
  const aEntry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  ctx.store.memory.relay({
    fromCharacterId: "a", toCharacterId: "b",
    entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
  });
  const bBefore = entryOf(ctx.store, "b", "pref.coffee");
  assert.ok(bBefore);
  const question = await askForget(ctx, conversation, {
    text: "只你忘记我喜欢咖啡这件事。", requestId: "clarify-self-same-q",
  });
  assert.match(question.reply, /\[第 1 条\]/u);
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-self-same-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  const bAfter = entryOf(ctx.store, "b", "pref.coffee");
  assert.equal(bAfter.body, bBefore.body);
  assert.equal(bAfter.version, bBefore.version);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-008c scope self 独立identity不删B", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-008c-self-independent");
  const aConversation = openConversation(ctx.store);
  const bConversation = openConversation(ctx.store, "b");
  await seedChatFact(ctx, aConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await seedChatFact(ctx, bConversation, {
    characterId: "b", text: "我的咖啡都要甜的。", factKey: "pref.coffeeB",
  });
  const bBefore = entryOf(ctx.store, "b", "pref.coffeeB");
  await askForget(ctx, aConversation, {
    text: "只你忘记我喜欢咖啡这件事。", requestId: "clarify-self-ind-q",
  });
  const answer = await answerForget(ctx, aConversation, "第 1 条", "clarify-self-ind-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  const bAfter = entryOf(ctx.store, "b", "pref.coffeeB");
  assert.equal(bAfter.body, bBefore.body);
  assert.equal(bAfter.version, bBefore.version);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-009 无关候选不提问不执行", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-009-unrelated");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我最近一直住在杭州。", factKey: "detail.city", kind: "detail",
  });
  const result = await askForget(ctx, conversation, { requestId: "clarify-unrelated-q" });
  assert.equal(result.status, "completed");
  assert.equal(result.reply, "我这次没有改动任何记忆。");
  assert.equal(result.reply.includes("[第 1 条]"), false);
  assert.ok(entryOf(ctx.store, "a", "detail.city"));
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-009b 原M2重排为第1条且拒绝未授权杭州候选", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-009b-renumber");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我最近一直住在杭州。", factKey: "detail.city", kind: "detail",
  });
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  const questionRequest = chatRequests(ctx).length;
  const question = await askForget(ctx, conversation, {
    text: "请忘记我喜欢咖啡这件事，我最近一直住在杭州。",
    requestId: "clarify-renumber-q",
  });
  assert.equal(chatRequests(ctx).length, questionRequest + 1);
  const modelBody = ctx.server.requests.at(-1);
  const lines = candidateLinesOf(modelBody);
  const hangzhou = lines.find((line) => line.includes("杭州"));
  const coffee = lines.find((line) => line.includes("我平时喝咖啡"));
  assert.ok(hangzhou && coffee, "模型候选必须同时包含杭州与咖啡");
  assert.match(hangzhou, /^\[M1\]/u, "fixture 需要杭州为原 M1");
  assert.match(coffee, /^\[M2\]/u, "fixture 需要咖啡为原 M2");
  const shown = questionLines(question.reply);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].display, 1, "原 M2 咖啡应显示为第 1 条");
  assert.match(shown[0].body, /我平时喝咖啡/u);
  assert.equal(question.reply.includes("杭州"), false, "未授权候选不得出现在提问里");
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "杭州那条", "clarify-renumber-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /没有改动任何记忆/u);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.ok(entryOf(ctx.store, "a", "detail.city"));
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-009c 重排第1条真正删除原M2", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-009c-renumber-execute");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我最近一直住在杭州。", factKey: "detail.city", kind: "detail",
  });
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  const question = await askForget(ctx, conversation, {
    text: "请忘记我喜欢咖啡这件事，我最近一直住在杭州。",
    requestId: "clarify-renumber-exec-q",
  });
  const modelBody = ctx.server.requests.at(-1);
  const lines = candidateLinesOf(modelBody);
  assert.match(lines.find((line) => line.includes("杭州")), /^\[M1\]/u);
  assert.match(lines.find((line) => line.includes("我平时喝咖啡")), /^\[M2\]/u);
  const shown = questionLines(question.reply);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].display, 1);
  assert.match(shown[0].body, /我平时喝咖啡/u);
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-renumber-exec-a");
  assert.equal(answer.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null, "必须删除原M2咖啡");
  assert.ok(entryOf(ctx.store, "a", "detail.city"), "未授权杭州必须保留");
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-011 事务失败保留快照并同request重试", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011-retry");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-retry-q" });
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_forget_selection BEFORE DELETE ON memory_entries
    WHEN old.id = '${entry.id}'
    BEGIN SELECT RAISE(ABORT, 'fixture forget failure'); END;
  `));
  const first = await answerForget(ctx, conversation, "第 1 条", "clarify-retry-a");
  assert.equal(first.status, "failed");
  const failed = requestRowFull(ctx.store.dbPath, "clarify-retry-a");
  assert.equal(failed.error_code, "FORGET_SELECTION_FAILED");
  assert.equal(JSON.parse(failed.operation_proof).kind, "forget-selection");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"), "失败必须零写");
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_forget_selection"));
  const userMessagesBefore = conversationMessages(ctx, conversation.id)
    .filter((message) => message.role === "user").length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-retry-a",
  });
  assert.equal(retry.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
  assert.equal(
    conversationMessages(ctx, conversation.id).filter((message) => message.role === "user").length,
    userMessagesBefore,
    "重试不得追加用户消息",
  );
  assert.equal(requestRowFull(ctx.store.dbPath, "clarify-retry-a").status, "completed");
});

test("POL-CHATMEM-FORGET-CLARIFY-011b 重启丢快照时retry诚实失败", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011b-restart");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-restart-q" });
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_forget_selection BEFORE DELETE ON memory_entries
    WHEN old.id = '${entry.id}'
    BEGIN SELECT RAISE(ABORT, 'fixture forget failure'); END;
  `));
  const first = await answerForget(ctx, conversation, "第 1 条", "clarify-restart-a");
  assert.equal(first.status, "failed");
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_forget_selection"));
  ctx.reopen();
  const chatBefore = chatRequests(ctx).length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-restart-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore, "不得退回普通聊天");
});

test("POL-CHATMEM-FORGET-CLARIFY-011c 失败后context变化retry不重放旧快照", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011c-retry-stale");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-retry-stale-q" });
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_forget_selection BEFORE DELETE ON memory_entries
    WHEN old.id = '${entry.id}'
    BEGIN SELECT RAISE(ABORT, 'fixture forget failure'); END;
  `));
  const first = await answerForget(ctx, conversation, "第 1 条", "clarify-retry-stale-a");
  assert.equal(first.status, "failed");
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_forget_selection"));
  ctx.store.memory.remember({
    characterId: "a", factKey: "detail.city", body: "用户住在杭州",
    kind: "detail", sourceId: "seed-city-retry-stale",
  });
  const chatBefore = chatRequests(ctx).length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-retry-stale-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore, "不得重放旧快照或退回普通聊天");
});

test("POL-CHATMEM-FORGET-CLARIFY-011d 失败后新话题再retry不复活", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011d-new-topic");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-011d-q" });
  await failSelectionWithTrigger(ctx, conversation, entry, "clarify-011d-a");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "今天天气不错。", memoryCandidates: [], memoryOperation: null,
  }));
  const topic = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "今天天气怎么样？", requestId: "clarify-011d-topic",
  });
  assert.equal(topic.reply, "今天天气不错。");
  assert.equal(requestRowFull(ctx.store.dbPath, "clarify-011d-a").status, "stale");
  const chatBefore = chatRequests(ctx).length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-011d-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore);
});

test("POL-CHATMEM-FORGET-CLARIFY-011e 失败后新命令再retry不复活", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011e-new-command");
  const conversation = openConversation(ctx.store);
  const coffee = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await seedChatFact(ctx, conversation, {
    text: "我住在杭州。", factKey: "detail.city", kind: "detail",
  });
  await askForget(ctx, conversation, { requestId: "clarify-011e-q" });
  await failSelectionWithTrigger(ctx, conversation, coffee, "clarify-011e-a");
  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, {
    reply: "好的。",
    memoryCandidates: [],
    memoryOperation: {
      action: "forget", target: targetFromRequest(body, "杭州"),
      scope: "all", evidence: "请忘记我住在杭州这件事",
    },
  }));
  const command = await ctx.store.chat.sendMessage({
    characterId: "a", conversationId: conversation.id,
    text: "请忘记我住在杭州这件事。", requestId: "clarify-011e-new",
  });
  assert.equal(command.status, "completed");
  assert.equal(entryOf(ctx.store, "a", "detail.city"), null);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  const chatBefore = chatRequests(ctx).length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-011e-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore);
});

test("POL-CHATMEM-FORGET-CLARIFY-011f 失败后取消再retry不复活", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011f-cancel");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-011f-q" });
  await failSelectionWithTrigger(ctx, conversation, entry, "clarify-011f-a");
  const cancelled = ctx.store.chat.cancelRequest({
    characterId: "a", requestId: "clarify-011f-a",
  });
  assert.equal(cancelled.cancelled, false);
  assert.equal(requestRowFull(ctx.store.dbPath, "clarify-011f-a").status, "stale");
  const chatBefore = chatRequests(ctx).length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-011f-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore);
});

test("POL-CHATMEM-FORGET-CLARIFY-011g 失败后关闭会话再retry不复活", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-011g-close");
  const conversation = openConversation(ctx.store);
  const entry = await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-011g-q" });
  await failSelectionWithTrigger(ctx, conversation, entry, "clarify-011g-a");
  ctx.store.chat.closeConversation({
    characterId: "a", conversationId: conversation.id,
  });
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "clarify-011g-a",
  });
  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "FORGET_SELECTION_EXPIRED");
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
});

test("POL-CHATMEM-FORGET-CLARIFY-012 同requestId幂等不重复删除", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-012-duplicate");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(ctx, conversation, { requestId: "clarify-dup-q" });
  const first = await answerForget(ctx, conversation, "第 1 条", "clarify-dup-a");
  assert.equal(first.status, "completed");
  const userMessages = conversationMessages(ctx, conversation.id)
    .filter((message) => message.role === "user").length;
  const relations = relationRequests(ctx).length;
  const again = await answerForget(ctx, conversation, "第 1 条", "clarify-dup-a");
  assert.equal(again.status, "completed");
  assert.equal(again.assistantMessageId, first.assistantMessageId);
  assert.equal(
    conversationMessages(ctx, conversation.id).filter((message) => message.role === "user").length,
    userMessages,
  );
  assert.equal(relationRequests(ctx).length, relations);
});

test("POL-CHATMEM-FORGET-CLARIFY-013 取消/过期/取消回答均不执行旧forget", async (t) => {
  const cancelCtx = await setupContext(t, "FORGET-CLARIFY-013-cancel");
  const cancelConversation = openConversation(cancelCtx.store);
  await seedChatFact(cancelCtx, cancelConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(cancelCtx, cancelConversation, { requestId: "clarify-cancel-q" });
  const cancelled = cancelCtx.store.chat.cancelRequest({
    characterId: "a", requestId: "clarify-cancel-q",
  });
  assert.equal(cancelled.cancelled, false);
  assert.equal(cancelled.status, "completed");
  cancelCtx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "好的。", memoryCandidates: [], memoryOperation: null,
  }));
  const afterCancel = await cancelCtx.store.chat.sendMessage({
    characterId: "a", conversationId: cancelConversation.id,
    text: "第 1 条", requestId: "clarify-cancel-a",
  });
  assert.equal(afterCancel.status, "completed");
  assert.ok(entryOf(cancelCtx.store, "a", "pref.coffee"));

  const timeoutCtx = await setupContext(t, "FORGET-CLARIFY-013-timeout");
  const timeoutConversation = openConversation(timeoutCtx.store);
  await seedChatFact(timeoutCtx, timeoutConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(timeoutCtx, timeoutConversation, { requestId: "clarify-timeout-q" });
  timeoutCtx.advance(11 * 60 * 1000);
  const chatBeforeTimeout = chatRequests(timeoutCtx).length;
  const expired = await answerForget(timeoutCtx, timeoutConversation, "第 1 条", "clarify-timeout-a");
  assert.equal(expired.status, "completed");
  assert.match(expired.reply, /已经过期/u);
  assert.ok(entryOf(timeoutCtx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(timeoutCtx).length, chatBeforeTimeout);
  assert.equal(relationRequests(timeoutCtx).length, 0);

  const cancelAnswerCtx = await setupContext(t, "FORGET-CLARIFY-013-cancel-answer");
  const cancelAnswerConversation = openConversation(cancelAnswerCtx.store);
  await seedChatFact(cancelAnswerCtx, cancelAnswerConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(cancelAnswerCtx, cancelAnswerConversation, { requestId: "clarify-skip-q" });
  const chatBeforeSkip = chatRequests(cancelAnswerCtx).length;
  const skipped = await answerForget(
    cancelAnswerCtx, cancelAnswerConversation, "算了", "clarify-skip-a",
  );
  assert.equal(skipped.status, "completed");
  assert.match(skipped.reply, /没有删除任何记忆/u);
  assert.ok(entryOf(cancelAnswerCtx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(cancelAnswerCtx).length, chatBeforeSkip);
  assert.equal(relationRequests(cancelAnswerCtx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-013c 跨本地午夜未满10分钟即过期", async (t) => {
  const ctx = await setupContext(t, "FORGET-CLARIFY-013c-midnight");
  const conversation = openConversation(ctx.store);
  await seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  advanceToLocalTime(ctx, 23, 59, 30);
  await askForget(ctx, conversation, { requestId: "clarify-midnight-q" });
  ctx.advance(40 * 1000);
  const chatBefore = chatRequests(ctx).length;
  const answer = await answerForget(ctx, conversation, "第 1 条", "clarify-midnight-a");
  assert.equal(answer.status, "completed");
  assert.match(answer.reply, /已经过期/u);
  assert.ok(entryOf(ctx.store, "a", "pref.coffee"));
  assert.equal(chatRequests(ctx).length, chatBefore);
  assert.equal(relationRequests(ctx).length, 0);
});

test("POL-CHATMEM-FORGET-CLARIFY-013b close/dispose清理pending", async (t) => {
  const closeCtx = await setupContext(t, "FORGET-CLARIFY-013b-close");
  const closeConversation = openConversation(closeCtx.store);
  await seedChatFact(closeCtx, closeConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(closeCtx, closeConversation, { requestId: "clarify-close-q" });
  const closed = closeCtx.store.chat.closeConversation({
    characterId: "a", conversationId: closeConversation.id,
  });
  assert.ok(closed.conversation.closedAt);
  assert.ok(entryOf(closeCtx.store, "a", "pref.coffee"));

  const disposeCtx = await setupContext(t, "FORGET-CLARIFY-013b-dispose");
  const disposeConversation = openConversation(disposeCtx.store);
  await seedChatFact(disposeCtx, disposeConversation, {
    text: "我平时喝咖啡一定要加糖。", factKey: "pref.coffee",
  });
  await askForget(disposeCtx, disposeConversation, { requestId: "clarify-dispose-q" });
  await disposeCtx.store.chat.dispose();
  assert.ok(entryOf(disposeCtx.store, "a", "pref.coffee"));
  await assert.rejects(
    () => disposeCtx.store.chat.sendMessage({
      characterId: "a", conversationId: disposeConversation.id,
      text: "第 1 条", requestId: "clarify-dispose-a",
    }),
    /聊天服务已关闭/u,
  );
});

test("POL-CHATMEM-CLARIFY-002g2 显式null第三方内容零写", async (t) => {
  const ctx = await setupContext(t, "POL-CHATMEM-CLARIFY-002g2-third-party");
  seedOperationFact(ctx.store, {
    factKey: "pref.coffee",
    body: "我平时喝咖啡一定要加糖",
    kind: "preference",
  });
  const conversation = openConversation(ctx.store);
  const entriesBefore = countRows(ctx.store.dbPath, "memory_entries");
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "已经改好了。",
    memoryCandidates: [],
    memoryOperation: null,
  }));
  const result = await ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "不是咖啡，我姐姐今天去看烟花了，请帮我改过来。",
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply.includes("已经改好了"), false);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "我平时喝咖啡一定要加糖");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(countRows(ctx.store.dbPath, "memory_entries"), entriesBefore);
});

/* S03p correct 时间澄清承接：真实 chat/SQLite，模型 HTTP 构造。
   基线先在旧生产执行，验证失败后再实现；不改旧 Case/Expected。 */
const S03P_MEM_TABLES = [
  "memory_entries",
  "memory_fact_identities",
  "memory_fact_relation_edges",
  "memory_temporary_links",
  "memory_temporary_entry_links",
  "memory_derivations",
  "memory_source_controls",
  "memory_context_versions",
];

function s03pMemoryRows(store) {
  return withDatabase(store.dbPath, (db) => Object.fromEntries(
    S03P_MEM_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  ));
}

async function askS03pTime(ctx, conversation, {
  text = "不是咖啡，我最近想喝茶，请帮我改过来。",
  requestId,
  mode = "null",
  reply = "已经改好了。",
} = {}) {
  ctx.server.enqueue(({ body, res }) => sendEnvelope(res, {
    reply,
    memoryCandidates: [],
    memoryOperation: mode === "null"
      ? null
      : {
        action: "correct",
        target: targetFromRequest(body, "咖啡"),
        excerpt: "我最近想喝茶",
        evidence: "请帮我改过来",
      },
  }));
  return ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text,
    requestId: requestId ?? crypto.randomUUID(),
  });
}

async function answerS03pTime(ctx, conversation, text, requestId) {
  return ctx.store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text,
    requestId,
  });
}

async function seedS03pCoffee(ctx, conversation) {
  return seedChatFact(ctx, conversation, {
    text: "我平时喝咖啡一定要加糖。",
    factKey: "pref.coffee",
  });
}

test("POL-CHATMEM-CORRECT-TIME-001 明确偏好+最近先本地提问，不写记忆", async (t) => {
  for (const mode of ["operation", "null"]) {
    await t.test(mode, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-001-${mode}`);
      const conversation = openConversation(ctx.store);
      const seeded = await seedS03pCoffee(ctx, conversation);
      const memBefore = s03pMemoryRows(ctx.store);
      const chatBefore = chatRequests(ctx).length;

      const result = await askS03pTime(ctx, conversation, { mode });

      assert.equal(result.status, "completed");
      assert.match(result.reply, /时间范围我还不确定/u);
      assert.match(result.reply, /就今天/u);
      assert.equal(result.reply.includes("已经改好了"), false, "不得透传模型成功文案");
      assert.equal(result.memoryApplied, 0);
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.deepEqual(s03pMemoryRows(ctx.store), memBefore, "澄清不得改动记忆业务表");
      assert.equal(chatRequests(ctx).length, chatBefore + 1);
      assert.equal(relationRequests(ctx).length, 0);
      assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version);
      assert.equal(
        conversationMessages(ctx, conversation.id).filter((message) => message.role === "assistant").at(-1).content,
        result.reply,
      );
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-004 时间式无效回答本地未操作，普通问题不被误拒", async (t) => {
  for (const answer of ["就今天？", "“就今天”", "明天吧", "长期吧"]) {
    await t.test(`invalid ${answer}`, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-004-invalid-${answer}`);
      const conversation = openConversation(ctx.store);
      const seeded = await seedS03pCoffee(ctx, conversation);
      await askS03pTime(ctx, conversation, { requestId: `s03p-004-q-${answer}` });
      const memBefore = s03pMemoryRows(ctx.store);
      const chatBefore = chatRequests(ctx).length;

      const result = await answerS03pTime(ctx, conversation, answer, `s03p-004-a-${answer}`);

      assert.equal(result.status, "completed");
      assert.match(result.reply, /没有改动任何记忆/u);
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.deepEqual(s03pMemoryRows(ctx.store), memBefore);
      assert.equal(chatRequests(ctx).length, chatBefore, "时间式无效回答不得调用聊天模型");
      assert.equal(relationRequests(ctx).length, 0);
      assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version);

      // pending 已清除：下一次“就今天”按普通聊天处理，不执行旧 correct。
      ctx.server.enqueue(({ res }) => sendEnvelope(res, {
        reply: "我记下了。", memoryCandidates: [], memoryOperation: null,
      }));
      const followUp = await answerS03pTime(ctx, conversation, "就今天", `s03p-004-f-${answer}`);
      assert.equal(followUp.status, "completed");
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version);
    });
  }

  for (const answer of ["如果是今天呢？", "就今天，而且我要加糖"]) {
    await t.test(`ordinary ${answer}`, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-004-ordinary-${answer}`);
      const conversation = openConversation(ctx.store);
      const seeded = await seedS03pCoffee(ctx, conversation);
      await askS03pTime(ctx, conversation, { requestId: `s03p-004o-q-${answer}` });
      const memBefore = s03pMemoryRows(ctx.store);
      const chatBefore = chatRequests(ctx).length;
      ctx.server.enqueue(({ res }) => sendEnvelope(res, {
        reply: "我记下了。", memoryCandidates: [], memoryOperation: null,
      }));

      const result = await answerS03pTime(ctx, conversation, answer, `s03p-004o-a-${answer}`);

      assert.equal(result.status, "completed");
      assert.equal(chatRequests(ctx).length, chatBefore + 1, "普通问题应走正常聊天");
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.deepEqual(s03pMemoryRows(ctx.store), memBefore);
      assert.equal(relationRequests(ctx).length, 0);
      assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version);
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-004b 普通换话题允许 grounded 新事实提炼", async (t) => {
  const ctx = await setupContext(t, "CORRECT-TIME-004b-ordinary-extraction");
  const conversation = openConversation(ctx.store);
  const seeded = await seedS03pCoffee(ctx, conversation);
  await askS03pTime(ctx, conversation, { requestId: "s03p-004b-q" });
  const chatBefore = chatRequests(ctx).length;
  ctx.server.enqueue(({ res }) => sendEnvelope(res, {
    reply: "杭州很好。",
    memoryCandidates: [{
      factKey: "detail.city",
      body: "用户住在杭州",
      kind: "detail",
      trust: "stated",
      evidence: "我住在杭州",
    }],
    memoryOperation: null,
  }));

  const result = await answerS03pTime(
    ctx, conversation, "今天天气不错，我住在杭州。", "s03p-004b-a",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 1, "普通聊天的新事实应正常提炼");
  assert.ok(entryOf(ctx.store, "a", "detail.city"));
  assert.equal(temporaryEntryOf(ctx.store, "a"), null);
  assert.equal(relationRequests(ctx).length, 0);
  assert.equal(chatRequests(ctx).length, chatBefore + 1);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version, "旧 correct 不得发生");
});

test("POL-CHATMEM-CORRECT-TIME-005 原内容不完整/模糊/非偏好不建 pending", async (t) => {
  const cases = [
    {
      name: "two-anchors",
      seed: { factKey: "pref.coffee", text: "我平时喝咖啡一定要加糖。" },
      text: "不是咖啡，我最近想喝茶，我最近想喝咖啡，请帮我改过来。",
      excerpt: "我最近想喝茶",
      needle: "咖啡",
      kind: "preference",
    },
    {
      name: "uncertain",
      seed: { factKey: "pref.coffee", text: "我平时喝咖啡一定要加糖。" },
      text: "不是咖啡，我最近可能想喝茶，请帮我改过来。",
      excerpt: "我最近可能想喝茶",
      needle: "咖啡",
      kind: "preference",
    },
    {
      name: "future",
      seed: { factKey: "pref.coffee", text: "我平时喝咖啡一定要加糖。" },
      text: "不是咖啡，我明天想喝茶，请帮我改过来。",
      excerpt: "我明天想喝茶",
      needle: "咖啡",
      kind: "preference",
    },
    {
      name: "experience",
      seed: { factKey: "exp.meteor", text: "我们昨天去看流星了。", kind: "experience" },
      text: "不是流星，我最近去看烟花了，请帮我改过来。",
      excerpt: "我最近去看烟花了",
      needle: "流星",
      kind: "experience",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-005-${item.name}`);
      const conversation = openConversation(ctx.store);
      await seedChatFact(ctx, conversation, {
        text: item.seed.text, factKey: item.seed.factKey, kind: item.seed.kind,
      });
      ctx.server.enqueue(({ body, res }) => sendEnvelope(res, {
        reply: "已经改好了。",
        memoryCandidates: [],
        memoryOperation: {
          action: "correct",
          target: targetFromRequest(body, item.needle),
          excerpt: item.excerpt,
          evidence: "请帮我改过来",
        },
      }));
      const question = await ctx.store.chat.sendMessage({
        characterId: "a",
        conversationId: conversation.id,
        text: item.text,
        requestId: `s03p-005-q-${item.name}`,
      });
      assert.equal(question.status, "completed");
      assert.equal(question.reply.includes("就今天"), false, "不完整/模糊/非偏好不得建时间 pending");
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      const memBefore = s03pMemoryRows(ctx.store);
      ctx.server.enqueue(({ res }) => sendEnvelope(res, {
        reply: "我记下了。", memoryCandidates: [], memoryOperation: null,
      }));
      const answer = await answerS03pTime(ctx, conversation, "就今天", `s03p-005-a-${item.name}`);
      assert.equal(answer.status, "completed");
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.deepEqual(s03pMemoryRows(ctx.store), memBefore);
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-006 TTL 与跨日本地过期", async (t) => {
  for (const [name, advanceMs] of [["ttl", 11 * 60 * 1000], ["cross-day", 24 * 60 * 60 * 1000]]) {
    await t.test(name, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-006-${name}`);
      const conversation = openConversation(ctx.store);
      await seedS03pCoffee(ctx, conversation);
      await askS03pTime(ctx, conversation, { requestId: `s03p-006-q-${name}` });
      const memBefore = s03pMemoryRows(ctx.store);
      const chatBefore = chatRequests(ctx).length;
      ctx.advance(advanceMs);

      const result = await answerS03pTime(ctx, conversation, "就今天", `s03p-006-a-${name}`);

      assert.equal(result.status, "completed");
      assert.match(result.reply, /过期/u);
      assert.match(result.reply, /没有改动/u);
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.deepEqual(s03pMemoryRows(ctx.store), memBefore);
      assert.equal(chatRequests(ctx).length, chatBefore);
      assert.equal(relationRequests(ctx).length, 0);
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-007 公开更正/删除目标后回答失效", async (t) => {
  for (const action of ["correct", "delete"]) {
    await t.test(action, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-007-${action}`);
      const conversation = openConversation(ctx.store);
      await seedS03pCoffee(ctx, conversation);
      await askS03pTime(ctx, conversation, { requestId: `s03p-007-q-${action}` });
      const target = entryOf(ctx.store, "a", "pref.coffee");
      if (action === "correct") {
        ctx.store.memory.correct({
          characterId: "a",
          entryId: target.id,
          expectedVersion: target.version,
          body: "用户平时只喝红茶",
        });
      } else {
        ctx.store.memory.forget({
          characterId: "a",
          entryId: target.id,
          expectedVersion: target.version,
          scope: "all",
        });
      }
      const chatBefore = chatRequests(ctx).length;

      const result = await answerS03pTime(ctx, conversation, "就今天", `s03p-007-a-${action}`);

      assert.equal(result.status, "completed");
      assert.match(result.reply, /已经变化|没有改动/u);
      assert.equal(temporaryEntryOf(ctx.store, "a"), null);
      assert.equal(chatRequests(ctx).length, chatBefore);
      assert.equal(relationRequests(ctx).length, 0);
      if (action === "correct") {
        assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, "用户平时只喝红茶");
      } else {
        assert.equal(entryOf(ctx.store, "a", "pref.coffee"), null);
      }
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-010 事务失败保留授权标记并同 request 重试", async (t) => {
  const ctx = await setupContext(t, "CORRECT-TIME-010-retry");
  const conversation = openConversation(ctx.store);
  await seedS03pCoffee(ctx, conversation);
  await askS03pTime(ctx, conversation, { requestId: "s03p-010-q" });
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_s03p_temp BEFORE INSERT ON memory_entries
    WHEN NEW.source_id LIKE 'chat-current:%'
    BEGIN SELECT RAISE(ABORT, 'fixture s03p failure'); END;
  `));
  const first = await answerS03pTime(ctx, conversation, "就今天", "s03p-010-a");

  assert.equal(first.status, "failed");
  const failed = requestRowFull(ctx.store.dbPath, "s03p-010-a");
  assert.equal(failed.error_code, "CORRECT_TIME_SELECTION_FAILED");
  assert.equal(JSON.parse(failed.operation_proof).kind, "correct-time-selection");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null, "失败必须零写");

  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_s03p_temp"));
  const usersBefore = conversationMessages(ctx, conversation.id)
    .filter((message) => message.role === "user").length;
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "s03p-010-a",
  });
  assert.equal(retry.status, "completed");
  assert.ok(temporaryEntryOf(ctx.store, "a"), "重试应只执行一次并生成临时");
  assert.equal(
    conversationMessages(ctx, conversation.id).filter((message) => message.role === "user").length,
    usersBefore,
    "重试不得追加用户消息",
  );
  const retried = requestRowFull(ctx.store.dbPath, "s03p-010-a");
  assert.equal(retried.status, "completed");
  assert.equal(JSON.parse(retried.operation_proof).kind, "correct-time-selection",
    "成功后仍须保留回答的授权/审计标记");
});

test("POL-CHATMEM-CORRECT-TIME-010b 目标变化/重启后重试返回 expired", async (t) => {
  for (const change of ["target", "restart"]) {
    await t.test(change, async (t2) => {
      const ctx = await setupContext(t2, `CORRECT-TIME-010b-${change}`);
      const conversation = openConversation(ctx.store);
      await seedS03pCoffee(ctx, conversation);
      await askS03pTime(ctx, conversation, { requestId: `s03p-010b-q-${change}` });
      withDatabase(ctx.store.dbPath, (db) => db.exec(`
        CREATE TRIGGER fail_s03p_temp BEFORE INSERT ON memory_entries
        WHEN NEW.source_id LIKE 'chat-current:%'
        BEGIN SELECT RAISE(ABORT, 'fixture s03p failure'); END;
      `));
      const first = await answerS03pTime(ctx, conversation, "就今天", `s03p-010b-a-${change}`);
      assert.equal(first.status, "failed");
      withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_s03p_temp"));
      if (change === "target") {
        const target = entryOf(ctx.store, "a", "pref.coffee");
        ctx.store.memory.correct({
          characterId: "a",
          entryId: target.id,
          expectedVersion: target.version,
          body: "用户平时只喝红茶",
        });
      } else {
        ctx.reopen();
      }
      const retry = await ctx.store.chat.retryRequest({
        characterId: "a", requestId: `s03p-010b-a-${change}`,
      });
      assert.equal(retry.status, "stale");
      assert.equal(retry.errorCode, "CORRECT_TIME_SELECTION_EXPIRED");
      assert.equal(temporaryEntryOf(ctx.store, "a"), null, "不得重放旧授权");
    });
  }
});

test("POL-CHATMEM-CORRECT-TIME-010c 失败后跨本地日同 request retry 仍 expired", async (t) => {
  const ctx = await setupContext(t, "CORRECT-TIME-010c-cross-day-retry");
  const conversation = openConversation(ctx.store);
  const seeded = await seedS03pCoffee(ctx, conversation);
  await askS03pTime(ctx, conversation, { requestId: "s03p-010c-q" });
  withDatabase(ctx.store.dbPath, (db) => db.exec(`
    CREATE TRIGGER fail_s03p_temp BEFORE INSERT ON memory_entries
    WHEN NEW.source_id LIKE 'chat-current:%'
    BEGIN SELECT RAISE(ABORT, 'fixture s03p failure'); END;
  `));
  const first = await answerS03pTime(ctx, conversation, "就今天", "s03p-010c-a");
  assert.equal(first.status, "failed");
  withDatabase(ctx.store.dbPath, (db) => db.exec("DROP TRIGGER fail_s03p_temp"));
  const usersBefore = conversationMessages(ctx, conversation.id)
    .filter((message) => message.role === "user").length;
  const assistantsBefore = conversationMessages(ctx, conversation.id)
    .filter((message) => message.role === "assistant").length;

  ctx.advance(24 * 60 * 60 * 1000);
  const retry = await ctx.store.chat.retryRequest({
    characterId: "a", requestId: "s03p-010c-a",
  });

  assert.equal(retry.status, "stale");
  assert.equal(retry.errorCode, "CORRECT_TIME_SELECTION_EXPIRED");
  assert.equal(temporaryEntryOf(ctx.store, "a"), null, "跨日重试不得重放旧授权");
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").body, seeded.body);
  assert.equal(entryOf(ctx.store, "a", "pref.coffee").version, seeded.version);
  assert.equal(
    conversationMessages(ctx, conversation.id).filter((message) => message.role === "user").length,
    usersBefore,
    "跨日重试不得追加用户消息",
  );
  assert.equal(
    conversationMessages(ctx, conversation.id)
      .filter((message) => message.role === "assistant").length,
    assistantsBefore,
    "跨日重试不得追加回答",
  );
  const row = requestRowFull(ctx.store.dbPath, "s03p-010c-a");
  assert.equal(row.status, "stale");
  assert.equal(row.error_code, "CORRECT_TIME_SELECTION_EXPIRED");
  assert.equal(row.operation_proof, null, "失效重试后清除授权标记");
});
