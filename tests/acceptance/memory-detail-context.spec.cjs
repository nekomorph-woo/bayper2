/* S03q 普通细节上下文与年龄淡化验收。真实 SQLite、正式 store/memory/chat 入口，
   模型只用本机 HTTP 构造；不读取用户 .env、不启动 GUI/Herdr，也不证明真实模型语义。
   覆盖 POL-DETAIL-001～005；细节候选必须来自正式检索与现有角色/来源门禁。 */
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
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MODEL_NAME = "fixture-detail-context";
const API_KEY = "sk-fixture-detail-context";

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
          : sendEnvelope(res, { reply: "嗯，我在这里。", memoryCandidates: [] }),
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

function rowState(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare(`
      SELECT id, body, kind, importance, updated_at, version
      FROM memory_entries WHERE character_id = ? ORDER BY id
    `).all(characterId));
}

async function setupContext(t, characterIds = ["a", "b"]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-detail-context-"));
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
  store = open();
  seedRelationships(store.dbPath, characterIds);
  t.after(async () => {
    try {
      store?.close();
    } catch {
      // 用例可能已主动关闭连接。
    }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    server,
    nowMs: () => tick,
    advance(ms) {
      tick += ms;
    },
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = open();
    },
  };
}

const openConversation = (store, characterId = "a") =>
  store.chat.openConversation({ characterId }).conversation;

function remember(ctx, {
  characterId = "a", factKey, body, kind = "detail", importance, ageDays = 0, sourceId,
}) {
  return ctx.store.memory.remember({
    characterId,
    factKey,
    body,
    kind,
    importance,
    sourceId: sourceId ?? `fixture:${factKey}`,
    createdAt: ctx.nowMs() - Math.round(ageDays * DAY),
  }).entry;
}

function memorySection(request) {
  assert.ok(request, "本轮应有模型请求");
  const memory = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .find((content) => content.includes("以下为本角色本轮可用的记忆"));
  assert.ok(memory, "真实聊天请求应包含记忆上下文");
  return memory;
}

async function chatMemory(ctx, text, characterId = "a") {
  const before = ctx.server.requests.length;
  ctx.server.enqueue(({ res }) =>
    sendEnvelope(res, { reply: "嗯，我记下了。", memoryCandidates: [] }));
  const result = await ctx.store.chat.sendMessage({
    characterId,
    conversationId: openConversation(ctx.store, characterId).id,
    text,
    requestId: crypto.randomUUID(),
  });
  assert.equal(result.status, "completed");
  assert.equal(ctx.server.requests.length, before + 1, "普通回合只应发送一次模型请求");
  return memorySection(ctx.server.requests.at(-1));
}

function contextOf(ctx, options = {}) {
  return ctx.store.memory.buildContext({
    characterId: "a",
    nowMs: ctx.nowMs(),
    ...options,
  });
}

const detailIds = (context) => context.sections.details.map((entry) => entry.id);
const allBodies = (context) =>
  Object.values(context.sections).flat().map((entry) => entry.body);
const allIds = (context) =>
  Object.values(context.sections).flat().map((entry) => entry.id);

function latestChatSourceId(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) => {
    const row = db.prepare(`
      SELECT id FROM chat_messages WHERE character_id = ? AND role = 'user'
      ORDER BY seq DESC, id DESC LIMIT 1
    `).get(characterId);
    assert.ok(row, "应存在刚发出的聊天消息");
    return `chat:${row.id}`;
  });
}

test("POL-DETAIL-001 真实聊天按本轮问题注入相关细节并保持来源边界", async (t) => {
  const ctx = await setupContext(t);
  const related = remember(ctx, {
    factKey: "detail.records",
    body: "用户喜欢在周末去旧书店淘黑胶唱片",
  });
  const unrelated = remember(ctx, {
    factKey: "detail.cat",
    body: "用户养了一只叫团子的橘猫",
  });

  const memory = await chatMemory(ctx, "你还记得我周末去旧书店淘黑胶唱片吗？");

  assert.match(memory, /相关细节:/u, "聊天记忆段应有中文“相关细节”标签");
  assert.ok(memory.includes("明确标为重要的细节仍按事实对待"), "细节边界不得否定标重要条目");
  assert.ok(memory.includes(related.body), "相关问题应召回本角色真实细节");
  assert.ok(memory.includes("来源:用户明确告知"), "细节仍应保留来源边界");
  assert.ok(memory.includes("引用:fixture:detail.records"), "细节仍应保留引用标识");
  assert.equal(memory.includes(unrelated.body), false, "无关细节不得灌入聊天上下文");
  assert.equal(memory.includes("团子"), false);
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "a", query: "黑胶唱片" })[0].id,
    related.id,
  );
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "a", query: "橘猫" })[0].id,
    unrelated.id,
  );
});

test("POL-DETAIL-002 年龄只让普通细节相对降位，管理层仍可检索全部", async (t) => {
  const ctx = await setupContext(t);
  const old = remember(ctx, {
    factKey: "detail.salt.old",
    body: "用户喜欢海盐",
    ageDays: 300,
  });
  const freshA = remember(ctx, {
    factKey: "detail.salt.a",
    body: "用户喜欢海盐苏打饼干，常在周末下午茶时吃。",
    ageDays: 2,
  });
  const freshB = remember(ctx, {
    factKey: "detail.salt.b",
    body: "用户喜欢海盐苏打饼干，常在周末下午茶时吃！",
    ageDays: 5,
  });
  const freshC = remember(ctx, {
    factKey: "detail.salt.c",
    body: "用户喜欢海盐苏打饼干，常在周末下午茶时吃？",
    ageDays: 10,
  });

  // Given：四条同主题细节，旧条目的正式检索 rank 最靠前。
  const hits = ctx.store.memory.searchMemories({
    characterId: "a", query: "海盐", limit: 20,
  });
  assert.deepEqual(hits.map((entry) => entry.id), [old.id, freshA.id, freshB.id, freshC.id]);

  // When/Result：禁衰减基线保留旧条目，生产排序让新鲜细节进入 3 条预算。
  const baseline = contextOf(ctx, { query: "海盐", detailDecay: false });
  const decayed = contextOf(ctx, { query: "海盐" });
  assert.deepEqual(detailIds(baseline), [old.id, freshA.id, freshB.id]);
  assert.deepEqual(detailIds(decayed), [freshA.id, freshB.id, freshC.id]);
  assert.equal(decayed.sections.details.some((entry) => entry.id === old.id), false);

  // 年龄策略不作用于管理检索与列表。
  assert.equal(hits.length, 4);
  assert.deepEqual(
    new Set(ctx.store.memory.listMemories("a").map((entry) => entry.id)),
    new Set([old.id, freshA.id, freshB.id, freshC.id]),
  );

  // 混合类别：原 20 条检索会被经历挤满时，正式检索的有界 detail 候选池
  // 仍保留 3 条；这里只主张 detail 候选内部的相对顺序，不声称混全量下标。
  for (let index = 0; index < 30; index += 1) {
    remember(ctx, {
      factKey: `exp.salt.${index}`,
      body: "用户喜欢海盐汽水",
      kind: "experience",
    });
  }
  const mixedHits = ctx.store.memory.searchMemories({
    characterId: "a", query: "海盐", limit: 20,
  });
  assert.equal(mixedHits.length, 20);
  assert.equal(
    mixedHits.filter((entry) => [freshA.id, freshB.id, freshC.id].includes(entry.id)).length,
    0,
    "20 条混合检索挤掉了全部 fresh 细节",
  );
  assert.deepEqual(
    detailIds(contextOf(ctx, { query: "海盐" })),
    [freshA.id, freshB.id, freshC.id],
  );
});

test("POL-DETAIL-003 重要与长期类别不降权，回拨不放大权重且读取不写库", async (t) => {
  const ctx = await setupContext(t);
  const important = remember(ctx, {
    factKey: "detail.allergy",
    body: "用户对花生严重过敏，必须避免",
    importance: 80,
    ageDays: 900,
  });
  remember(ctx, {
    factKey: "pref.coffee.long",
    body: "用户长期喜欢淡咖啡",
    kind: "preference",
    ageDays: 900,
  });
  remember(ctx, {
    factKey: "exp.kyoto",
    body: "用户去年在京都看过枫叶",
    kind: "experience",
    ageDays: 900,
  });
  const rainOld = remember(ctx, {
    factKey: "detail.rain.old",
    body: "用户喜欢雨天散步",
    ageDays: 25,
  });
  const rainFuture = remember(ctx, {
    factKey: "detail.rain.future",
    body: "用户喜欢雨天散步时听旧唱片",
    ageDays: -10,
  });
  const lone = remember(ctx, {
    factKey: "detail.pinecone",
    body: "用户收藏了一枚松果书签",
    ageDays: 900,
  });
  const rowsBefore = rowState(ctx);

  // 重要细节即使远期仍受保护；长期偏好/经历不进入年龄策略。
  const importantContext = contextOf(ctx, { query: "花生过敏" });
  assert.ok(detailIds(importantContext).includes(important.id));
  const longTerm = contextOf(ctx);
  assert.ok(longTerm.sections.preferences.some((entry) => entry.body === "用户长期喜欢淡咖啡"));
  assert.ok(longTerm.sections.experiences.some((entry) => entry.body === "用户去年在京都看过枫叶"));

  // updatedAt 未来时 ageDays 归零，不能让 rank 1 的条目反超 rank 0。
  const rollback = contextOf(ctx, { query: "雨天散步" });
  assert.deepEqual(detailIds(rollback), [rainOld.id, rainFuture.id]);

  // 无竞争时旧细节仍能召回。
  assert.ok(detailIds(contextOf(ctx, { query: "松果书签" })).includes(lone.id));

  // 保护必须有竞争：旧条目在正式检索 rank 0，三条新普通细节竞争 3 个名额。
  for (const importance of [79, 80]) {
    await t.test(`importance ${importance} 与三条新细节竞争`, async (t2) => {
      const isolated = await setupContext(t2);
      const aged = remember(isolated, {
        factKey: "detail.spice.old",
        body: "用户喜欢海盐",
        importance,
        ageDays: 300,
      });
      const fresh = [1, 2, 3].map((ageDays, index) => remember(isolated, {
        factKey: `detail.spice.fresh.${index}`,
        body: `用户喜欢海盐苏打饼干，常在周末下午茶时吃${["。", "！", "？"][index]}`,
        ageDays,
      }));
      const rowsBefore = rowState(isolated);

      // 前提：正式检索把旧条目排在第一，三条新细节紧随其后。
      const hits = isolated.store.memory.searchMemories({
        characterId: "a", query: "海盐", limit: 20,
      });
      assert.equal(hits.length, 4);
      assert.equal(hits[0].id, aged.id);
      assert.deepEqual(hits.slice(1).map((entry) => entry.id), fresh.map((entry) => entry.id));

      // 79 的旧条目失去保护后落选；80 仍入选且排在第一。
      assert.deepEqual(
        detailIds(contextOf(isolated, { query: "海盐" })),
        importance === 79
          ? fresh.map((entry) => entry.id)
          : [aged.id, fresh[0].id, fresh[1].id],
      );
      assert.ok(isolated.store.memory.listMemories("a").some((entry) => entry.id === aged.id));

      // 读取与重复构造不改行。
      detailIds(contextOf(isolated, { query: "海盐" }));
      assert.deepEqual(rowState(isolated), rowsBefore);
    });
  }

  // 读取、排序与失败重试都不写记忆行，也不改版本或重要性。
  assert.deepEqual(rowState(ctx), rowsBefore);
});

test("POL-DETAIL-004 年龄策略不绕过角色、分享、纠正、删除与临时来源门禁", async (t) => {
  const ctx = await setupContext(t);
  const scarf = remember(ctx, {
    factKey: "detail.scarf",
    body: "用户把蓝色围巾落在画室",
  });

  // Given/When：B 尚未获得该事实。
  const bBefore = await chatMemory(ctx, "我的围巾落在哪里了？", "b");
  assert.equal(bBefore.includes(scarf.body), false);
  assert.deepEqual(
    ctx.store.memory.buildContext({ characterId: "b", query: "蓝色围巾" }).sections.details,
    [],
  );

  // 分享派生后，B 可以按来源边界看到合法副本。
  ctx.store.memory.share({ fromCharacterId: "a", toCharacterId: "b", entryIds: [scarf.id] });
  const bShared = await chatMemory(ctx, "我的围巾落在哪里了？", "b");
  assert.ok(bShared.includes(scarf.body));
  assert.ok(bShared.includes("转述"), "派生细节应保留转述来源边界");

  // 纠正后旧正文在 A/B 的新上下文中都失效。
  ctx.store.memory.correct({
    characterId: "a",
    entryId: scarf.id,
    expectedVersion: scarf.version,
    body: "用户把灰色围巾落在画室",
    sourceId: "fixture:detail.scarf.corrected",
    nowMs: ctx.nowMs(),
  });
  for (const characterId of ["a", "b"]) {
    const memory = await chatMemory(ctx, "我的围巾落在哪里了？", characterId);
    assert.ok(memory.includes("灰色围巾"), `${characterId} 应看到纠正正文`);
    assert.equal(memory.includes("蓝色围巾"), false, `${characterId} 不得残留旧正文`);
  }

  // 删除后 A/B 都不能再召回，年龄下限不能复活条目。
  const corrected = ctx.store.memory.listMemories("a")
    .find((entry) => entry.factKey === "detail.scarf");
  ctx.store.memory.forget({
    characterId: "a",
    entryId: corrected.id,
    expectedVersion: corrected.version,
    scope: "all",
    nowMs: ctx.nowMs(),
  });
  for (const characterId of ["a", "b"]) {
    const memory = await chatMemory(ctx, "我的围巾落在哪里了？", characterId);
    assert.equal(memory.includes("灰色围巾"), false);
    assert.equal(memory.includes("蓝色围巾"), false);
    assert.equal(allBodies(ctx.store.memory.buildContext({
      characterId, query: "围巾",
    })).some((body) => body.includes("围巾")), false);
  }

  // 临时理解到期后正文不再进入上下文；长期锚本身仍合法。
  const anchor = remember(ctx, {
    factKey: "detail.tea.today",
    body: "用户今天想喝红茶",
  });
  await chatMemory(ctx, "我今天想喝燕麦红茶。", "a");
  const temporaryBody = "我今天想喝燕麦红茶";
  const temporary = ctx.store.memory.applyTemporaryUnderstanding({
    characterId: "a",
    entryId: anchor.id,
    expectedVersion: anchor.version,
    body: temporaryBody,
    trust: "stated",
    expiresAt: ctx.nowMs() + HOUR,
    sourceId: latestChatSourceId(ctx, "a"),
    nowMs: ctx.nowMs(),
  });
  assert.equal(temporary.mode, "temporary");
  assert.ok((await chatMemory(ctx, "燕麦红茶还喝吗？", "a")).includes(temporaryBody));
  ctx.advance(2 * HOUR);
  const expired = await chatMemory(ctx, "燕麦红茶还喝吗？", "a");
  assert.equal(expired.includes(temporaryBody), false, "到期临时正文不得进入聊天上下文");
  const expiredBodies = allBodies(ctx.store.memory.buildContext({
    characterId: "a", query: "红茶",
  }));
  assert.equal(expiredBodies.includes(temporaryBody), false, "到期临时正文不得进入 buildContext");
  assert.ok(expiredBodies.includes("用户今天想喝红茶"), "临时到期不得连带清除合法长期锚");
});

test("POL-DETAIL-004b 有效期内来源正文变更或删除使临时细节失效", async (t) => {
  for (const mutation of ["content", "delete"]) {
    await t.test(mutation, async (t2) => {
      const ctx = await setupContext(t2);
      const anchor = remember(ctx, {
        factKey: "detail.source.anchor",
        body: "用户今天想喝红茶",
      });
      const temporaryBody = "我今天想喝燕麦红茶";
      const conversation = openConversation(ctx.store);
      const before = ctx.server.requests.length;
      ctx.server.enqueue(({ res }) => sendEnvelope(res, {
        reply: "嗯，我记下了。", memoryCandidates: [],
      }));
      const sent = await ctx.store.chat.sendMessage({
        characterId: "a",
        conversationId: conversation.id,
        text: "我今天想喝燕麦红茶。",
        requestId: crypto.randomUUID(),
      });
      assert.equal(sent.status, "completed");
      assert.equal(ctx.server.requests.length, before + 1);
      const sourceId = latestChatSourceId(ctx, "a");
      const temporary = ctx.store.memory.applyTemporaryUnderstanding({
        characterId: "a",
        entryId: anchor.id,
        expectedVersion: anchor.version,
        body: temporaryBody,
        trust: "stated",
        expiresAt: ctx.nowMs() + 30 * DAY,
        sourceId,
        nowMs: ctx.nowMs(),
      });
      assert.equal(temporary.mode, "temporary");
      assert.ok(allBodies(contextOf(ctx, { query: "燕麦红茶" })).includes(temporaryBody));
      assert.ok((await chatMemory(ctx, "燕麦红茶还喝吗？", "a")).includes(temporaryBody));

      // When：有效期未变，只改动或删除权威来源消息。
      withDatabase(ctx.store.dbPath, (db) => {
        const messageId = sourceId.slice("chat:".length);
        if (mutation === "content") {
          db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?")
            .run("完全不同的原话", messageId);
        } else {
          db.prepare("DELETE FROM chat_requests WHERE user_message_id = ?").run(messageId);
          db.prepare("DELETE FROM chat_messages WHERE id = ?").run(messageId);
        }
      });

      // Result：来源核验失败，临时正文不进入 buildContext 或真实聊天；长期锚仍合法。
      const source = ctx.store.memorySourceContext.resolve({
        characterId: "a",
        entryId: temporary.originEntryId,
        expectedVersion: temporary.originVersion,
        nowMs: ctx.nowMs(),
      });
      assert.equal(source.status, "unavailable", `${mutation}: ${source.reason}`);
      assert.equal(
        allBodies(contextOf(ctx, { query: "燕麦红茶" })).includes(temporaryBody),
        false,
        `${mutation}: 失效来源不得进入 buildContext`,
      );
      assert.equal(
        ctx.store.memory.searchMemories({ characterId: "a", query: "燕麦红茶" })
          .some((entry) => entry.id === temporary.originEntryId),
        false,
      );
      assert.ok(allBodies(contextOf(ctx, { query: "红茶" })).includes("用户今天想喝红茶"));
      assert.equal(
        (await chatMemory(ctx, "燕麦红茶还喝吗？", "a")).includes(temporaryBody),
        false,
      );
    });
  }
});

test("POL-DETAIL-005 小预算、重开与重复读取稳定且不刷新日期", async (t) => {
  const ctx = await setupContext(t);
  remember(ctx, { factKey: "identity.name", body: "用户叫小雨", kind: "identity" });
  remember(ctx, {
    factKey: "pref.tea.long", body: "用户长期喝淡咖啡", kind: "preference",
  });
  for (let index = 0; index < 4; index += 1) {
    remember(ctx, {
      factKey: `detail.blueberry.${index}`,
      body: `用户喜欢蓝莓酸奶，这是第${index + 1}次提到`,
      ageDays: index * 3,
    });
  }
  const rowsBefore = rowState(ctx);
  const requestsBefore = ctx.server.requests.length;

  // Given/When：预算只够核心与偏好，细节最后让位。
  const context = contextOf(ctx, { query: "蓝莓酸奶", maxChars: 14 });
  assert.ok(context.charCount <= 14, "总字符预算必须保持");
  assert.ok(context.sections.core.some((entry) => entry.body === "用户叫小雨"));
  assert.ok(context.sections.preferences.some((entry) => entry.body === "用户长期喝淡咖啡"));
  assert.deepEqual(context.sections.details, [], "预算不足时细节不得挤掉核心段");
  assert.equal(context.truncated, true);

  // 重复构造稳定，读取不触发模型请求，也不改行日期或版本。
  const repeated = contextOf(ctx, { query: "蓝莓酸奶", maxChars: 14 });
  assert.deepEqual(allIds(repeated), allIds(context));
  assert.equal(ctx.server.requests.length, requestsBefore);
  assert.deepEqual(rowState(ctx), rowsBefore);

  // 重开 SQLite 后同一时钟下结果一致。
  ctx.reopen();
  const reopened = contextOf(ctx, { query: "蓝莓酸奶", maxChars: 14 });
  assert.deepEqual(allIds(reopened), allIds(context));
  assert.deepEqual(rowState(ctx), rowsBefore);

  // 读取不阻塞后续保存。
  const saved = remember(ctx, {
    factKey: "detail.blueberry.new",
    body: "用户喜欢蓝莓贝果",
  });
  assert.ok(saved.id, "读取后保存应返回新条目");
  assert.equal(rowState(ctx).length, rowsBefore.length + 1);
});
