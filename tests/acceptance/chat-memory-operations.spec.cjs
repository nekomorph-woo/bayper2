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
