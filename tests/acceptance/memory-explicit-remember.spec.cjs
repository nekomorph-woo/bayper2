/* S03r 用户明确要求记住的直接事实优先级验收。
   真实 chat.sendMessage/SQLite；模型只由本地 HTTP 构造；不读取 .env、不启动
   GUI/Herdr、不调用真实 API。覆盖 POL-REMEMBER-001～005。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");
const { strictFactFingerprint } = require("../../app/memory-fact-identity.cjs");
const {
  analyzeExplicitRemember,
  resolveExplicitRemember,
} = require("../../app/memory-explicit-remember.cjs");

const START = Date.UTC(2026, 9, 28, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MODEL_NAME = "fixture-explicit-remember";
const API_KEY = "sk-fixture-explicit-remember";
const IMPORTANT = 80;
const DEFAULT_DETAIL = 20;

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
          : sendEnvelope(res, modelReply()),
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

async function setupContext(t, characterIds = ["a", "b"]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-explicit-remember-"));
  let tick = START;
  let store = null;
  const open = () => createStore(dir, {
    now: () => tick,
    chat: {
      timeoutMs: 1000,
      fetchImpl: fetch,
      getCredentials: () => ({
        baseUrl: server.baseUrl,
        modelName: MODEL_NAME,
        apiKey: API_KEY,
      }),
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
  };
}

const openConversation = (store, characterId = "a") =>
  store.chat.openConversation({ characterId }).conversation;

function candidate({
  factKey, body, kind = "detail", evidence = body, importance,
}) {
  return {
    factKey,
    body,
    kind,
    trust: "stated",
    evidence,
    ...(importance === undefined ? {} : { importance }),
  };
}

function resolveFor(text, body, factKey = "probe.fact") {
  const plan = analyzeExplicitRemember(text);
  return resolveExplicitRemember(plan, [
    { factKey, body, kind: "detail", trust: "stated" },
  ]);
}

function modelReply({ reply = "嗯，我记下了。", candidates = [], operation = null } = {}) {
  return {
    reply,
    memoryCandidates: candidates,
    memoryOperation: operation,
    memoryRelay: null,
  };
}

async function sendChat(ctx, {
  text, requestId, envelope, responder, characterId = "a",
}) {
  const conversation = openConversation(ctx.store, characterId);
  ctx.server.enqueue(responder ?? (({ res }) => sendEnvelope(res, envelope)));
  const result = await ctx.store.chat.sendMessage({
    characterId,
    conversationId: conversation.id,
    text,
    requestId,
  });
  return { result, request: ctx.server.requests.at(-1) };
}

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

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function rowByFact(ctx, characterId, factKey) {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare(`
      SELECT id, character_id, fact_key, body, kind, importance, source_id,
             source_version, version, created_at, updated_at, expires_at,
             fact_identity_id
      FROM memory_entries WHERE character_id = ? AND fact_key = ?
    `).get(characterId, factKey) ?? null);
}

function rowsFor(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare(`
      SELECT id, character_id, fact_key, body, kind, importance, source_id,
             version, created_at, updated_at, expires_at
      FROM memory_entries WHERE character_id = ? ORDER BY id
    `).all(characterId));
}

function contextVersionOf(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("SELECT version FROM memory_context_versions WHERE character_id = ?")
      .get(characterId)?.version ?? 0);
}

function assistantCount(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare(`
      SELECT COUNT(*) AS count FROM chat_messages
      WHERE character_id = ? AND role = 'assistant'
    `).get(characterId).count);
}

function sourceControlCount(ctx, characterId = "a") {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM memory_source_controls WHERE character_id = ?")
      .get(characterId).count);
}

function requestRow(ctx, requestId) {
  return withDatabase(ctx.store.dbPath, (db) =>
    db.prepare(`
      SELECT status, error_code, memory_applied, assistant_message_id,
             verification_status
      FROM chat_requests WHERE id = ?
    `).get(requestId));
}

function seedRemember(ctx, {
  characterId = "a", factKey, body, kind = "detail", importance, sourceId, createdAt,
}) {
  return ctx.store.memory.remember({
    characterId,
    factKey,
    body,
    kind,
    ...(importance === undefined ? {} : { importance }),
    sourceId: sourceId ?? `seed:${factKey}`,
    createdAt: createdAt ?? ctx.nowMs(),
  }).entry;
}

test("POL-REMEMBER-001 明确记住的新细节至少80，且不被年龄淡化淘汰", async (t) => {
  const ctx = await setupContext(t);
  const beforeRequests = ctx.server.requests.length;

  // Given/When：用户明确要求记住一个新细节，模型恶意附带 importance 100。
  const { result } = await sendChat(ctx, {
    text: "请记住，这个门牌是307。",
    requestId: "s03r-001-new",
    envelope: modelReply({
      reply: "嗯，我记住了。",
      candidates: [
        candidate({ factKey: "detail.door", body: "这个门牌是307", importance: 100 }),
      ],
    }),
  });

  // Result：本地只信自己的授权，取至少80；正文和来源仍是用户原话/本轮消息。
  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 1);
  assert.equal(ctx.server.requests.length, beforeRequests + 1, "普通回合只应发送一次模型请求");
  const door = rowByFact(ctx, "a", "detail.door");
  assert.ok(door, "明确要求记住的新事实应落库");
  assert.equal(door.body, "这个门牌是307");
  assert.equal(door.kind, "detail");
  assert.equal(door.importance, IMPORTANT, "不得采用模型 importance 100");
  assert.equal(door.source_id, latestChatSourceId(ctx, "a"));

  // When：时间前进300天，另有3条同主题新普通细节竞争细节名额。
  ctx.advance(300 * DAY);
  for (let index = 0; index < 3; index += 1) {
    seedRemember(ctx, {
      factKey: `detail.door.fresh.${index}`,
      body: `这个门牌是307号，位于老街尽头，这是第${index + 1}次提到`,
    });
  }
  const hits = ctx.store.memory.searchMemories({
    characterId: "a", query: "门牌", limit: 20,
  });
  assert.equal(hits[0].id, door.id, "前提：正式检索应把这条旧细节排在最前");

  // Result：80 的旧细节不因年龄被新普通细节挤出上下文；读取不写库。
  const context = ctx.store.memory.buildContext({
    characterId: "a", query: "门牌", nowMs: ctx.nowMs(),
  });
  assert.ok(
    context.sections.details.some((entry) => entry.id === door.id),
    "明确记住的重要细节不应因年龄被淘汰",
  );
  assert.equal(rowByFact(ctx, "a", "detail.door").version, door.version);
  assert.equal(ctx.server.requests.length, beforeRequests + 1, "后续读取不应再请求模型");

  await t.test("无候选时本地澄清且不写库", async (t2) => {
    const isolated = await setupContext(t2);
    const empty = await sendChat(isolated, {
      text: "请记住，这个门牌是307。",
      requestId: "s03r-001-empty",
      envelope: modelReply({ reply: "我记住了。", candidates: [] }),
    });
    assert.equal(empty.result.status, "completed");
    assert.match(empty.result.reply, /不能确定/u);
    assert.equal(empty.result.reply.includes("我记住了"), false);
    assert.equal(rowsFor(isolated, "a").length, 0);
    assert.equal(assistantCount(isolated), 1, "只应写本地澄清，不写假确认");
  });
});

test("POL-REMEMBER-002 引用命令、假设、转述、助手话、陈述和问能力不提升；明确不要记住不保存", async (t) => {
  const ctx = await setupContext(t);
  const negatives = [
    ["引用中的命令", "他说“请记住，门牌是307”。", "门牌是307", "neg.quoted-command", false],
    ["假设", "如果你能记住，门牌是308。", "门牌是308", "neg.hypothetical", false],
    ["否定记住", "别记住，门牌是309。", "门牌是309", "neg.negated", true],
    ["否定保存", "不要保存，门牌是316。", "门牌是316", "neg.no-save", true],
    ["请求否定记住", "请不要记住，门牌是317。", "门牌是317", "neg.please-no-remember", true],
    ["请求否定保存", "麻烦你不要保存，门牌是318。", "门牌是318", "neg.please-no-save", true],
    ["尾随请求否定", "门牌是319，请不要记住。", "门牌是319", "neg.tail-please-no-remember", true],
    ["转述", "你之前说请记住，门牌是310。", "门牌是310", "neg.reported", false],
    ["助手话", "助手说请记住，门牌是311。", "门牌是311", "neg.assistant", false],
    ["陈述", "我记得门牌是312。", "门牌是312", "neg.statement", false],
    ["询问能力", "你能记住门牌是313吗？", "门牌是313", "neg.ability", false],
  ];

  for (const [name, text, body, factKey, blocks] of negatives) {
    await t.test(name, async () => {
      const { result } = await sendChat(ctx, {
        text,
        requestId: `s03r-002-${factKey}`,
        envelope: modelReply({
          reply: "好的。",
          candidates: [candidate({ factKey, body, importance: 100 })],
        }),
      });
      assert.equal(result.status, "completed");
      const row = rowByFact(ctx, "a", factKey);
      if (blocks) {
        // 明确不要记住/保存：本轮不得新建，也不得借既有条目提升。
        assert.equal(row, null, "明确不要保存的事实本轮不得新建");
        assert.match(result.reply, /没有保存/u, "否定命令应如实说明未保存");
        assert.equal(result.reply.includes("已经记住"), false);
      } else {
        // 引用/假设/转述等负例不强制产生条目；若既有 grounding 保存，也只按普通值。
        if (row) {
          assert.equal(row.importance, DEFAULT_DETAIL, "负例不得被本地提升，也不得采用模型100");
        }
        assert.equal(result.reply, "好的。", "非否定的负例不应触发本地澄清");
      }
    });
  }

  await t.test("否定只限定所指事实：既有条目不删除，其他独立普通事实不受牵连", async (t2) => {
    const scoped = await setupContext(t2);
    const existing = seedRemember(scoped, {
      factKey: "neg.scope.door",
      body: "门牌是309",
      sourceId: "seed:neg-scope-door",
    });
    const before = rowByFact(scoped, "a", existing.factKey);
    const { result } = await sendChat(scoped, {
      text: "别记住，门牌是309，另外我喜欢喝咖啡。",
      requestId: "s03r-002-scope",
      envelope: modelReply({
        reply: "好的。",
        candidates: [
          candidate({ factKey: existing.factKey, body: "门牌是309" }),
          candidate({ factKey: "neg.scope.coffee", body: "我喜欢喝咖啡" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /没有保存/u);
    // 已有条目保留，不删除、不改版本、不提升；不是 forget。
    const after = rowByFact(scoped, "a", existing.factKey);
    assert.equal(after.id, before.id);
    assert.equal(after.body, before.body);
    assert.equal(after.importance, before.importance);
    assert.equal(after.version, before.version);
    // 同轮其他独立普通事实仍按既有规则保存。
    assert.equal(rowByFact(scoped, "a", "neg.scope.coffee").importance, DEFAULT_DETAIL);
  });

  await t.test("否定不影响同轮另一条明确授权的提升", async (t2) => {
    const mixed = await setupContext(t2);
    const { result } = await sendChat(mixed, {
      text: "别记住，门牌是309。请记住，猫叫团子。",
      requestId: "s03r-002-mixed",
      envelope: modelReply({
        reply: "好的。",
        candidates: [
          candidate({ factKey: "neg.mixed.door", body: "门牌是309" }),
          candidate({ factKey: "neg.mixed.cat", body: "猫叫团子" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(mixed, "a", "neg.mixed.door"), null);
    assert.equal(rowByFact(mixed, "a", "neg.mixed.cat").importance, IMPORTANT);
    assert.match(result.reply, /没有保存/u);
  });

  await t.test("请求框架否定只拦所指事实，独立普通事实不受牵连", async (t2) => {
    const scoped = await setupContext(t2);
    const { result } = await sendChat(scoped, {
      text: "请不要记住，门牌是309，另外我喜欢咖啡。",
      requestId: "s03r-002-polite-scope",
      envelope: modelReply({
        reply: "好的。",
        candidates: [
          candidate({ factKey: "neg.polite.door", body: "门牌是309" }),
          candidate({ factKey: "neg.polite.coffee", body: "我喜欢咖啡" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(scoped, "a", "neg.polite.door"), null);
    assert.equal(
      rowByFact(scoped, "a", "neg.polite.coffee").importance,
      DEFAULT_DETAIL,
    );
    assert.match(result.reply, /没有保存/u);
  });

  // 正例：同一句里外部命令明确指向被引用的内容，引用事实可被提升。
  const quotedFact = await sendChat(ctx, {
    text: "请记住“我的门牌是315”。",
    requestId: "s03r-002-quoted-fact",
    envelope: modelReply({
      reply: "嗯。",
      candidates: [candidate({ factKey: "pos.quoted-fact", body: "我的门牌是315" })],
    }),
  });
  assert.equal(quotedFact.result.status, "completed");
  assert.equal(rowByFact(ctx, "a", "pos.quoted-fact").importance, IMPORTANT);

  // 正例：模型附带的100不能覆盖本地“至少80”的结果。
  const malicious = await sendChat(ctx, {
    text: "请记住，我的门牌是314。",
    requestId: "s03r-002-malicious-importance",
    envelope: modelReply({
      reply: "嗯。",
      candidates: [
        candidate({ factKey: "pos.malicious", body: "我的门牌是314", importance: 100 }),
      ],
    }),
  });
  assert.equal(malicious.result.status, "completed");
  assert.equal(rowByFact(ctx, "a", "pos.malicious").importance, IMPORTANT);
});

test("POL-REMEMBER-003 授权只落到事实段，两个独立命令分别处理，歧义如实澄清", async (t) => {
  const ctx = await setupContext(t);

  // When：一句里有授权事实，另有“另外”无关事实。
  const unrelated = await sendChat(ctx, {
    text: "请记住，这个门牌是307，另外我最近睡不好。",
    requestId: "s03r-003-unrelated",
    envelope: modelReply({
      reply: "嗯。",
      candidates: [
        candidate({ factKey: "detail.door", body: "这个门牌是307" }),
        candidate({ factKey: "detail.sleep", body: "我最近睡不好" }),
      ],
    }),
  });
  assert.equal(unrelated.result.status, "completed");
  assert.equal(rowByFact(ctx, "a", "detail.door").importance, IMPORTANT);
  assert.equal(
    rowByFact(ctx, "a", "detail.sleep").importance,
    DEFAULT_DETAIL,
    "“另外”后的无关事实不得连带提升",
  );

  // When：两个独立、各自带内容的明确命令。
  const twoCommands = await sendChat(ctx, {
    text: "请记住，门牌是307。帮我记下来，猫叫团子。",
    requestId: "s03r-003-two-commands",
    envelope: modelReply({
      reply: "嗯。",
      candidates: [
        candidate({ factKey: "detail.door.two", body: "门牌是307" }),
        candidate({ factKey: "detail.cat", body: "猫叫团子" }),
      ],
    }),
  });
  assert.equal(twoCommands.result.status, "completed");
  assert.equal(rowByFact(ctx, "a", "detail.door.two").importance, IMPORTANT);
  assert.equal(rowByFact(ctx, "a", "detail.cat").importance, IMPORTANT);

  // When：命令只指向“刚才那件事”，没有可定位的事实内容。
  const vague = await sendChat(ctx, {
    text: "请记住刚才那件事。",
    requestId: "s03r-003-vague",
    envelope: modelReply({
      reply: "我记住了。",
      candidates: [candidate({ factKey: "detail.vague", body: "刚才那件事" })],
    }),
  });
  assert.equal(vague.result.status, "completed");
  assert.match(vague.result.reply, /不能确定/u);
  assert.equal(vague.result.reply.includes("我记住了"), false);
  assert.equal(rowByFact(ctx, "a", "detail.vague"), null, "歧义时不得把指代词当事实保存");

  await t.test("组合候选不得借授权段把另外事实一起提升", async (t2) => {
    const combined = await setupContext(t2);
    const { result } = await sendChat(combined, {
      text: "请记住，门牌是307，另外我喜欢咖啡。",
      requestId: "s03r-003-combined",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [candidate({
          factKey: "detail.combined",
          body: "门牌是307，另外我喜欢咖啡",
          importance: 100,
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(
      rowByFact(combined, "a", "detail.combined"),
      null,
      "混合授权与未授权事实的单一候选不得落库",
    );
    assert.match(result.reply, /不能确定/u);
    assert.equal(result.reply.includes("我记住了"), false);
  });

  await t.test("否定宽候选包含被拒绝事实时整条不落库", async (t2) => {
    const broad = await setupContext(t2);
    const { result } = await sendChat(broad, {
      text: "别记住，门牌是307，另外我喜欢咖啡。",
      requestId: "s03r-003-negative-broad",
      envelope: modelReply({
        reply: "好的。",
        candidates: [candidate({
          factKey: "detail.negative-broad",
          body: "门牌是307，另外我喜欢咖啡",
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(
      rowByFact(broad, "a", "detail.negative-broad"),
      null,
      "包含被拒绝事实的宽候选不得落库",
    );
    assert.match(result.reply, /没有保存/u);
  });

  await t.test("歧义命令旁的独立新事实保存并如实反馈部分完成", async (t2) => {
    const mixed = await setupContext(t2);
    const { result } = await sendChat(mixed, {
      text: "请记住，我喜欢咖啡。请记住刚才那件事。",
      requestId: "s03r-003-clarify-new",
      envelope: modelReply({
        reply: "我记住了。",
        candidates: [
          candidate({ factKey: "detail.coffee", body: "我喜欢咖啡" }),
          candidate({ factKey: "detail.vague", body: "刚才那件事" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(mixed, "a", "detail.coffee").importance, IMPORTANT);
    assert.equal(rowByFact(mixed, "a", "detail.vague"), null);
    assert.match(result.reply, /能确认的那部分/u);
    assert.match(result.reply, /不能确定/u);
    assert.equal(result.reply.includes("没有改动任何记忆"), false);
  });

  await t.test("歧义旁的独立事实提升也如实反馈部分完成", async (t2) => {
    const promotedCtx = await setupContext(t2);
    const before = seedRemember(promotedCtx, {
      factKey: "detail.coffee.promote",
      body: "我喜欢咖啡",
      sourceId: "seed:coffee-promote",
    });
    const beforeRow = rowByFact(promotedCtx, "a", "detail.coffee.promote");
    const { result } = await sendChat(promotedCtx, {
      text: "请记住，我喜欢咖啡。请记住刚才那件事。",
      requestId: "s03r-003-clarify-promote",
      envelope: modelReply({
        reply: "我记住了。",
        candidates: [
          candidate({ factKey: "detail.coffee.promote", body: "我喜欢咖啡" }),
          candidate({ factKey: "detail.vague.promote", body: "刚才那件事" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    const after = rowByFact(promotedCtx, "a", "detail.coffee.promote");
    assert.equal(after.importance, IMPORTANT);
    assert.equal(after.version, beforeRow.version + 1);
    assert.equal(rowByFact(promotedCtx, "a", "detail.vague.promote"), null);
    assert.match(result.reply, /能确认的那部分/u);
    assert.match(result.reply, /不能确定/u);
    assert.equal(before.id, after.id);
  });
});

test("POL-REMEMBER-004 同键同正文只提升本角色优先级，冲突不覆盖，更高值不降", async (t) => {
  const ctx = await setupContext(t);
  const seeded = seedRemember(ctx, {
    factKey: "detail.door",
    body: "这个门牌是307",
    sourceId: "seed:door",
    createdAt: START - 10 * DAY,
  });
  const before = rowByFact(ctx, "a", "detail.door");
  const contextBefore = contextVersionOf(ctx);
  const sourcesBefore = sourceControlCount(ctx);

  // When：同键同正文旧值20再次被明确要求记住。
  const promoted = await sendChat(ctx, {
    text: "请记住，这个门牌是307。",
    requestId: "s03r-004-promote",
    envelope: modelReply({
      reply: "嗯，我记住了。",
      candidates: [
        candidate({ factKey: "detail.door", body: "这个门牌是307", importance: 100 }),
      ],
    }),
  });

  // Result：只升 importance；正文/来源/时间/身份不变；version/contextVersion 各一次。
  assert.equal(promoted.result.status, "completed");
  assert.equal(promoted.result.memoryApplied, 0, "提升不是新建，不得伪造 memoryApplied");
  const after = rowByFact(ctx, "a", "detail.door");
  assert.equal(after.id, before.id);
  assert.equal(after.body, before.body);
  assert.equal(after.kind, before.kind);
  assert.equal(after.source_id, "seed:door");
  assert.equal(after.created_at, before.created_at);
  assert.equal(after.updated_at, before.updated_at, "提升不得刷新年龄时间");
  assert.equal(after.fact_identity_id, before.fact_identity_id);
  assert.equal(after.importance, IMPORTANT);
  assert.equal(after.version, before.version + 1);
  assert.equal(contextVersionOf(ctx), contextBefore + 1);
  assert.equal(sourceControlCount(ctx), sourcesBefore, "不得改写来源控制");
  assert.equal(rowsFor(ctx, "a").length, 1, "不得新建重复条目");

  // When：再次发送同一请求。
  const repeated = await sendChat(ctx, {
    text: "请记住，这个门牌是307。",
    requestId: "s03r-004-repeat",
    envelope: modelReply({
      reply: "嗯，我记住了。",
      candidates: [candidate({ factKey: "detail.door", body: "这个门牌是307" })],
    }),
  });
  assert.equal(repeated.result.status, "completed");
  assert.equal(repeated.result.reply, "嗯，我记住了。", "已达标时应保留普通回复");
  assert.equal(rowByFact(ctx, "a", "detail.door").version, after.version, "重复请求不得重复递增");
  assert.equal(rowByFact(ctx, "a", "detail.door").importance, IMPORTANT);
  assert.equal(contextVersionOf(ctx), contextBefore + 1, "无实际变化不得递增上下文版本");

  // When：同键但正文不同，冲突不覆盖。
  const conflict = await sendChat(ctx, {
    text: "请记住，这个门牌是308。",
    requestId: "s03r-004-conflict-body",
    envelope: modelReply({
      reply: "我记住了。",
      candidates: [candidate({ factKey: "detail.door", body: "这个门牌是308" })],
    }),
  });
  assert.equal(conflict.result.status, "completed");
  assert.match(conflict.result.reply, /没有保存成长期记忆/u);
  assert.equal(conflict.result.reply.includes("我记住了"), false, "冲突不假确认");
  assert.equal(rowByFact(ctx, "a", "detail.door").body, "这个门牌是307");
  assert.equal(rowByFact(ctx, "a", "detail.door").version, after.version);
  assert.equal(rowsFor(ctx, "a").length, 1);

  // When：同键同正文但 metadata 不同，同样不覆盖。
  const metadataConflict = await sendChat(ctx, {
    text: "请记住，这个门牌是307。",
    requestId: "s03r-004-conflict-metadata",
    envelope: modelReply({
      reply: "我记住了。",
      candidates: [
        candidate({ factKey: "detail.door", body: "这个门牌是307", kind: "identity" }),
      ],
    }),
  });
  assert.equal(metadataConflict.result.status, "completed");
  assert.match(metadataConflict.result.reply, /没有保存成长期记忆/u);
  assert.equal(rowByFact(ctx, "a", "detail.door").kind, "detail");
  assert.equal(rowByFact(ctx, "a", "detail.door").importance, IMPORTANT);
  assert.equal(rowByFact(ctx, "a", "detail.door").version, after.version);

  // Given：已有条目的重要性高于80。When：再次明确要求记住。Result：不降低。
  seedRemember(ctx, {
    factKey: "detail.allergy",
    body: "我对花生严重过敏",
    importance: 90,
    sourceId: "seed:allergy",
  });
  const allergy = rowByFact(ctx, "a", "detail.allergy");
  const higher = await sendChat(ctx, {
    text: "请记住，我对花生严重过敏。",
    requestId: "s03r-004-higher",
    envelope: modelReply({
      reply: "嗯，我记着。",
      candidates: [
        candidate({ factKey: "detail.allergy", body: "我对花生严重过敏" }),
      ],
    }),
  });
  assert.equal(higher.result.status, "completed");
  assert.equal(rowByFact(ctx, "a", "detail.allergy").importance, 90);
  assert.equal(rowByFact(ctx, "a", "detail.allergy").version, allergy.version, "更高值不降也不升版本");
  assert.equal(higher.result.reply, "嗯，我记着。");

  // Given：A 的事实已分享给 B。When：A 明确要求记住。Result：B 的副本不变。
  const sharedCtx = await setupContext(t);
  const shared = seedRemember(sharedCtx, {
    factKey: "detail.door.shared",
    body: "这个门牌是307",
    sourceId: "seed:shared-door",
  });
  sharedCtx.store.memory.share({
    fromCharacterId: "a",
    toCharacterId: "b",
    entryIds: [shared.id],
  });
  const bBefore = rowsFor(sharedCtx, "b").find((row) => row.body === "这个门牌是307");
  assert.ok(bBefore, "分享后 B 应持有副本");
  await sendChat(sharedCtx, {
    text: "请记住，这个门牌是307。",
    requestId: "s03r-004-shared",
    envelope: modelReply({
      reply: "嗯。",
      candidates: [candidate({ factKey: "detail.door.shared", body: "这个门牌是307" })],
    }),
  });
  assert.equal(rowByFact(sharedCtx, "a", "detail.door.shared").importance, IMPORTANT);
  const bAfter = rowsFor(sharedCtx, "b").find((row) => row.body === "这个门牌是307");
  assert.equal(bAfter.importance, DEFAULT_DETAIL, "重视决定不得跨角色传播");
  assert.equal(bAfter.version, bBefore.version);
  assert.equal(bAfter.source_id, bBefore.source_id);
  assert.equal(bAfter.updated_at, bBefore.updated_at);
});

test("POL-REMEMBER-005 来源、临时、删除、管理操作和事务失败边界", async (t) => {
  await t.test("本轮来源被排除时不得提升", async (t2) => {
    const ctx = await setupContext(t2);
    seedRemember(ctx, {
      factKey: "detail.door",
      body: "这个门牌是307",
      sourceId: "seed:door",
    });
    const before = rowByFact(ctx, "a", "detail.door");
    const contextBefore = contextVersionOf(ctx);

    const { result } = await sendChat(ctx, {
      text: "请记住，这个门牌是307。",
      requestId: "s03r-005-source",
      responder: ({ res }) => {
        const sourceId = latestChatSourceId(ctx, "a");
        withDatabase(ctx.store.dbPath, (db) => {
          db.prepare(`
            INSERT OR IGNORE INTO memory_source_controls
              (character_id, source_id_hash, created_at) VALUES (?, ?, ?)
          `).run("a", hashText(sourceId), ctx.nowMs());
        });
        sendEnvelope(res, modelReply({
          reply: "我记住了。",
          candidates: [candidate({ factKey: "detail.door", body: "这个门牌是307" })],
        }));
      },
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /没有保存成长期记忆/u);
    assert.equal(rowByFact(ctx, "a", "detail.door").importance, before.importance);
    assert.equal(rowByFact(ctx, "a", "detail.door").version, before.version);
    assert.equal(contextVersionOf(ctx), contextBefore);
  });

  await t.test("已到期临时事实不因明确记住复活或永久化", async (t2) => {
    const ctx = await setupContext(t2);
    const anchor = seedRemember(ctx, {
      factKey: "detail.tea.anchor",
      body: "用户今天想喝红茶",
      sourceId: "seed:tea-anchor",
    });
    await sendChat(ctx, {
      text: "我今天想喝燕麦红茶。",
      requestId: "s03r-005-temp-source",
      envelope: modelReply({ reply: "嗯。", candidates: [] }),
    });
    const temporary = ctx.store.memory.applyTemporaryUnderstanding({
      characterId: "a",
      entryId: anchor.id,
      expectedVersion: anchor.version,
      body: "我今天想喝燕麦红茶",
      trust: "stated",
      expiresAt: ctx.nowMs() + HOUR,
      sourceId: latestChatSourceId(ctx, "a"),
      nowMs: ctx.nowMs(),
    });
    assert.equal(temporary.mode, "temporary");
    const temporaryRow = rowsFor(ctx, "a").find(
      (row) => row.body === "我今天想喝燕麦红茶",
    );
    assert.ok(temporaryRow, "应存在临时理解行");

    ctx.advance(2 * HOUR);
    const { result } = await sendChat(ctx, {
      text: "请记住，我今天想喝燕麦红茶。",
      requestId: "s03r-005-temp-expired",
      envelope: modelReply({
        reply: "我记住了。",
        candidates: [
          candidate({
            factKey: temporaryRow.fact_key,
            body: "我今天想喝燕麦红茶",
          }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /没有保存成长期记忆/u);
    const after = rowsFor(ctx, "a").find((row) => row.id === temporaryRow.id);
    assert.equal(after.importance, temporaryRow.importance);
    assert.equal(after.expires_at, temporaryRow.expires_at);
    assert.equal(after.version, temporaryRow.version);
    assert.equal(
      rowsFor(ctx, "a").filter((row) => row.body === "我今天想喝燕麦红茶").length,
      1,
      "不得为同一临时内容另建长期条目",
    );
    assert.equal(
      ctx.store.memory.searchMemories({ characterId: "a", query: "燕麦红茶" })
        .some((entry) => entry.body === "我今天想喝燕麦红茶"),
      false,
      "到期临时内容不得进入检索",
    );
  });

  await t.test("删除控制阻止新事实回流", async (t2) => {
    const ctx = await setupContext(t2);
    const fingerprint = strictFactFingerprint({
      kind: "detail",
      trust: "stated",
      sourceKind: "user",
      expiresAt: null,
      body: "门牌是307",
    });
    withDatabase(ctx.store.dbPath, (db) => {
      db.prepare(`
        INSERT OR IGNORE INTO memory_deleted_fact_fingerprints
          (character_id, fingerprint, created_at) VALUES (?, ?, ?)
      `).run("a", fingerprint, ctx.nowMs());
    });
    const { result } = await sendChat(ctx, {
      text: "请记住，门牌是307。",
      requestId: "s03r-005-deleted",
      envelope: modelReply({
        reply: "我记住了。",
        candidates: [candidate({ factKey: "detail.deleted-door", body: "门牌是307" })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /没有保存成长期记忆/u);
    assert.equal(rowByFact(ctx, "a", "detail.deleted-door"), null);
    assert.equal(rowsFor(ctx, "a").length, 0);
  });

  await t.test("已有管理操作优先，不在操作回合偷偷保存记住内容", async (t2) => {
    const ctx = await setupContext(t2);
    const seeded = seedRemember(ctx, {
      factKey: "detail.door.op",
      body: "用户的门牌是307",
      sourceId: "seed:op-door",
    });
    const before = rowByFact(ctx, "a", "detail.door.op");

    const { result } = await sendChat(ctx, {
      text: "不要分享门牌307，请记住，门牌是307。",
      requestId: "s03r-005-operation",
      responder: ({ body, res }) => sendEnvelope(res, modelReply({
        reply: "已经更新。",
        candidates: [candidate({ factKey: "detail.door.op", body: "门牌是307" })],
        operation: {
          action: "restrictSharing",
          target: targetFromRequest(body, "门牌"),
          evidence: "不要分享门牌307",
        },
      })),
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /没有另外保存“记住”的内容/u);
    assert.match(result.reply, /不会再/u);
    const after = rowByFact(ctx, "a", "detail.door.op");
    assert.equal(after.id, seeded.id);
    assert.equal(after.importance, before.importance, "操作回合不得顺带提升记住内容");
    assert.equal(after.version, before.version);
    assert.equal(rowsFor(ctx, "a").filter((row) => row.body === "门牌是307").length, 0);
  });

  await t.test("保存/提升与确认同事务，失败回滚且重试幂等", async (t2) => {
    const ctx = await setupContext(t2);
    seedRemember(ctx, {
      factKey: "detail.door",
      body: "这个门牌是307",
      sourceId: "seed:door",
    });
    const before = rowByFact(ctx, "a", "detail.door");
    const contextBefore = contextVersionOf(ctx);
    const assistantBefore = assistantCount(ctx);
    const memory = ctx.store.memory;
    const originalApply = memory.applyExtractionBatch;
    // 故障注入：先执行真实 applyExtractionBatch，再由测试抛出异常；只验证
    // 同一事务内的提升/确认整笔回滚与重试幂等，不代表生产故障路径。
    memory.applyExtractionBatch = (input) => {
      originalApply(input);
      throw new Error("injected transaction failure");
    };
    let failed;
    try {
      failed = await sendChat(ctx, {
        text: "请记住，这个门牌是307。",
        requestId: "s03r-005-tx",
        envelope: modelReply({
          reply: "我记住了。",
          candidates: [candidate({ factKey: "detail.door", body: "这个门牌是307" })],
        }),
      });
    } finally {
      memory.applyExtractionBatch = originalApply;
    }
    assert.equal(failed.result.status, "failed");
    assert.equal(requestRow(ctx, "s03r-005-tx").status, "failed");
    assert.equal(rowByFact(ctx, "a", "detail.door").importance, before.importance);
    assert.equal(rowByFact(ctx, "a", "detail.door").version, before.version);
    assert.equal(contextVersionOf(ctx), contextBefore);
    assert.equal(assistantCount(ctx), assistantBefore, "失败时不得留下成功回复");

    ctx.server.enqueue(({ res }) => sendEnvelope(res, modelReply({
      reply: "嗯，我记住了。",
      candidates: [candidate({ factKey: "detail.door", body: "这个门牌是307" })],
    })));
    const retried = await ctx.store.chat.retryRequest({
      characterId: "a",
      requestId: "s03r-005-tx",
    });
    assert.equal(retried.status, "completed");
    assert.equal(requestRow(ctx, "s03r-005-tx").status, "completed");
    assert.equal(rowByFact(ctx, "a", "detail.door").importance, IMPORTANT);
    assert.equal(rowByFact(ctx, "a", "detail.door").version, before.version + 1);
    assert.equal(contextVersionOf(ctx), contextBefore + 1);
    assert.equal(assistantCount(ctx), assistantBefore + 1);
    assert.equal(rowsFor(ctx, "a").length, 1);
  });
});

test("POL-REMEMBER-006 明确记住只容忍末尾中文句号", async (t) => {
  await t.test("自然提炼后句号差异可提升且旧字段保持不变", async (t2) => {
    const ctx = await setupContext(t2);
    const natural = await sendChat(ctx, {
      text: "我家的门牌是307。",
      requestId: "s03s-006-natural",
      envelope: modelReply({
        reply: "记下了。",
        candidates: [candidate({
          factKey: "home_door_number",
          body: "我家的门牌是307。",
        })],
      }),
    });
    assert.equal(natural.result.status, "completed");
    assert.equal(natural.result.memoryApplied, 1);
    const before = rowByFact(ctx, "a", "home_door_number");
    assert.ok(before, "自然提炼应写入门牌");
    assert.equal(before.body, "我家的门牌是307。");
    assert.equal(before.importance, DEFAULT_DETAIL);
    assert.equal(before.version, 1);
    const contextBefore = contextVersionOf(ctx);
    ctx.advance(HOUR);

    const explicit = await sendChat(ctx, {
      text: "请记住，我家的门牌是307。",
      requestId: "s03s-006-explicit",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [candidate({
          factKey: "home_door_number",
          body: "我家的门牌是307",
        })],
      }),
    });
    assert.equal(explicit.result.status, "completed");
    assert.equal(explicit.result.memoryApplied, 0, "提升不是新建");
    assert.doesNotMatch(explicit.result.reply, /没有保存成长期记忆/u);
    const after = rowByFact(ctx, "a", "home_door_number");
    assert.equal(after.id, before.id);
    assert.equal(after.fact_identity_id, before.fact_identity_id);
    assert.equal(after.body, before.body);
    assert.equal(after.kind, before.kind);
    assert.equal(after.source_id, before.source_id);
    assert.equal(after.source_version, before.source_version);
    assert.equal(after.created_at, before.created_at);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.importance, IMPORTANT);
    assert.equal(after.version, before.version + 1);
    assert.equal(contextVersionOf(ctx), contextBefore + 1);

    const repeat = await sendChat(ctx, {
      text: "请记住，我家的门牌是307。",
      requestId: "s03s-006-repeat",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [candidate({
          factKey: "home_door_number",
          body: "我家的门牌是307",
        })],
      }),
    });
    assert.equal(repeat.result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home_door_number").version, after.version);
    assert.equal(rowByFact(ctx, "a", "home_door_number").importance, IMPORTANT);
    assert.equal(contextVersionOf(ctx), contextBefore + 1);
  });

  await t.test("反向句号差异同样提升", async (t2) => {
    const ctx = await setupContext(t2);
    seedRemember(ctx, {
      factKey: "home_door_number",
      body: "我家的门牌是307",
      sourceId: "seed:reverse-period",
    });
    const rowBefore = rowByFact(ctx, "a", "home_door_number");
    ctx.advance(HOUR);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307。",
      requestId: "s03s-006-reverse",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [candidate({
          factKey: "home_door_number",
          body: "我家的门牌是307。",
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.memoryApplied, 0);
    const after = rowByFact(ctx, "a", "home_door_number");
    assert.equal(after.id, rowBefore.id);
    assert.equal(after.body, rowBefore.body);
    assert.equal(after.source_id, rowBefore.source_id);
    assert.equal(after.created_at, rowBefore.created_at);
    assert.equal(after.updated_at, rowBefore.updated_at);
    assert.equal(after.importance, IMPORTANT);
    assert.equal(after.version, rowBefore.version + 1);
  });

  await t.test("数值/内部标点/否定/主体差异不误合", async (t2) => {
    const ctx = await setupContext(t2);
    const cases = [
      {
        key: "eq.number.3070",
        existing: "我家的门牌是307",
        candidate: "我家的门牌是3070",
        text: "请记住，我家的门牌是3070。",
      },
      {
        key: "eq.number.30",
        existing: "我家的门牌是307",
        candidate: "我家的门牌是30",
        text: "请记住，我家的门牌是30。",
      },
      {
        key: "eq.decimal.12",
        existing: "我家的门牌是1.2",
        candidate: "我家的门牌是12",
        text: "请记住，我家的门牌是12。",
      },
      {
        key: "eq.decimal.1.2",
        existing: "我家的门牌是12",
        candidate: "我家的门牌是1.2",
        text: "请记住，我家的门牌是1.2。",
      },
      {
        key: "eq.negation",
        existing: "我家的门牌是307",
        candidate: "我家的门牌不是307",
        text: "请记住，我家的门牌不是307。",
      },
      {
        key: "eq.subject",
        existing: "我家的门牌是307",
        candidate: "她家的门牌是307",
        text: "请记住，她家的门牌是307。",
      },
    ];
    for (const item of cases) {
      seedRemember(ctx, {
        factKey: item.key,
        body: item.existing,
        sourceId: `seed:${item.key}`,
      });
      const before = rowByFact(ctx, "a", item.key);
      ctx.advance(HOUR);
      const { result } = await sendChat(ctx, {
        text: item.text,
        requestId: `s03s-006-${item.key}`,
        envelope: modelReply({
          reply: "我记住了。",
          candidates: [candidate({ factKey: item.key, body: item.candidate })],
        }),
      });
      assert.equal(result.status, "completed");
      assert.equal(result.memoryApplied, 0);
      assert.match(result.reply, /没有保存成长期记忆/u, `${item.key} 不得假确认`);
      const after = rowByFact(ctx, "a", item.key);
      assert.equal(after.id, before.id);
      assert.equal(after.body, before.body);
      assert.equal(after.source_id, before.source_id);
      assert.equal(after.created_at, before.created_at);
      assert.equal(after.updated_at, before.updated_at);
      assert.equal(after.importance, DEFAULT_DETAIL);
      assert.equal(after.version, 1);
    }
  });

  await t.test("普通提炼仍使用严格正文比较", async (t2) => {
    const ctx = await setupContext(t2);
    seedRemember(ctx, {
      factKey: "ordinary.period",
      body: "我家的门牌是307。",
      sourceId: "seed:ordinary-period",
    });
    const before = rowByFact(ctx, "a", "ordinary.period");
    ctx.advance(HOUR);
    const { result } = await sendChat(ctx, {
      text: "我家的门牌是307。",
      requestId: "s03s-006-ordinary",
      envelope: modelReply({
        reply: "记下了。",
        candidates: [candidate({
          factKey: "ordinary.period",
          body: "我家的门牌是307",
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.memoryApplied, 0);
    assert.equal(result.reply, "记下了。");
    const after = rowByFact(ctx, "a", "ordinary.period");
    assert.equal(after.body, before.body);
    assert.equal(after.importance, DEFAULT_DETAIL);
    assert.equal(after.version, 1);
    assert.equal(after.updated_at, before.updated_at);
  });
});

test("POL-REMEMBER-007 明确记住完整授权段与宽候选", async (t) => {
  await t.test("带主语宽候选被拦截", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307，另外我的盆栽叫小叶。",
      requestId: "s03s-007-wide",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [candidate({
          factKey: "home.mixed",
          body: "我家的门牌是307，另外我的盆栽叫小叶",
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home.mixed"), null, "宽候选不得落库");
    assert.match(result.reply, /不能确定/u);
    assert.equal(result.reply.includes("我记住了"), false);
  });

  await t.test("窄+宽+独立盆栽", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307，另外我的盆栽叫小叶。",
      requestId: "s03s-007-mixed",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [
          candidate({ factKey: "home.doorplate", body: "我家的门牌是307" }),
          candidate({ factKey: "home.plant", body: "我的盆栽叫小叶" }),
          candidate({
            factKey: "home.mixed",
            body: "我家的门牌是307，另外我的盆栽叫小叶",
          }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home.doorplate").importance, IMPORTANT);
    assert.equal(rowByFact(ctx, "a", "home.plant").importance, DEFAULT_DETAIL);
    assert.equal(rowByFact(ctx, "a", "home.mixed"), null);
    assert.match(result.reply, /能确认的那部分/u);
  });

  await t.test("请不要记住的完整候选被拦", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请不要记住，我家的备用钥匙放在鞋柜左侧。",
      requestId: "s03s-007-negative",
      envelope: modelReply({
        reply: "好的。",
        candidates: [candidate({
          factKey: "home.key",
          body: "我家的备用钥匙放在鞋柜左侧",
        })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home.key"), null);
    assert.match(result.reply, /没有保存/u);
  });

  await t.test("授权匹配拒绝部分子串、主体差异与内部标点误合", async () => {
    const exact = resolveFor("请记住，我家的门牌是307。", "我家的门牌是307");
    assert.equal(exact.boosted.has("probe.fact"), true);
    assert.equal(exact.blockedKeys.has("probe.fact"), false);

    const wideComma = resolveFor(
      "请记住，我家的门牌是307，另外我的盆栽叫小叶。",
      "我家的门牌是307，另外我的盆栽叫小叶",
    );
    assert.equal(wideComma.boosted.has("probe.fact"), false);
    assert.equal(wideComma.blockedKeys.has("probe.fact"), true);

    const wideNoComma = resolveFor(
      "请记住，我家的门牌是307，另外我的盆栽叫小叶。",
      "我家的门牌是307另外我的盆栽叫小叶",
    );
    assert.equal(wideNoComma.boosted.has("probe.fact"), false);
    assert.equal(wideNoComma.blockedKeys.has("probe.fact"), true);

    // 完整授权段之外的窄候选暂不授权；旧“引用事实”用例因此成为已知冲突。
    const narrow = resolveFor("请记住，我家的门牌是307。", "门牌是307");
    assert.equal(narrow.boosted.has("probe.fact"), false);
    assert.equal(narrow.blockedKeys.has("probe.fact"), false);

    for (const [label, body] of [
      ["3070", "我家的门牌是3070"],
      ["30", "我家的门牌是30"],
      ["negation", "我家的门牌不是307"],
      ["subject-她", "她家的门牌是307"],
      ["subject-我们", "我们家的门牌是307"],
      ["subject-角色", "角色家的门牌是307"],
      ["subject-用户", "用户家的门牌是307"],
    ]) {
      const result = resolveFor("请记住，我家的门牌是307。", body);
      assert.equal(result.boosted.has("probe.fact"), false, `${label} 不得获得明确记住提升`);
      assert.equal(result.blockedKeys.has("probe.fact"), false, `${label} 不应被当成宽候选`);
    }

    for (const [label, text, body] of [
      ["1.2-vs-12", "请记住，我家的门牌是1.2。", "我家的门牌是12"],
      ["12-vs-1.2", "请记住，我家的门牌是12。", "我家的门牌是1.2"],
      ["307-vs-3070", "请记住，我家的门牌是3070。", "我家的门牌是307"],
    ]) {
      const result = resolveFor(text, body);
      assert.equal(result.boosted.has("probe.fact"), false, `${label} 不得获得明确记住提升`);
      assert.equal(result.blockedKeys.has("probe.fact"), false, `${label} 不应被当成宽候选`);
    }

    const negative = resolveFor(
      "请不要记住，我家的备用钥匙放在鞋柜左侧。",
      "我家的备用钥匙放在鞋柜左侧",
    );
    assert.equal(negative.boosted.has("probe.fact"), false);
    assert.equal(negative.blockedKeys.has("probe.fact"), true);

    const negativeWide = resolveFor(
      "请不要记住，我家的备用钥匙放在鞋柜左侧。",
      "我家的备用钥匙放在鞋柜左侧，另外我喜欢咖啡",
    );
    assert.equal(negativeWide.blockedKeys.has("probe.fact"), true);

    const negativeSubject = resolveFor(
      "请不要记住，我家的备用钥匙放在鞋柜左侧。",
      "她家的备用钥匙放在鞋柜左侧",
    );
    assert.equal(negativeSubject.blockedKeys.has("probe.fact"), false);

    const quotedFact = resolveFor("请记住“我的门牌是315”。", "我的门牌是315");
    assert.equal(quotedFact.boosted.has("probe.fact"), true);
    const quotedCommand = resolveFor("请记住“请记住，门牌是307”。", "门牌是307");
    assert.equal(quotedCommand.boosted.has("probe.fact"), false);
    const quotedReport = resolveFor("请记住“他说门牌是307”。", "门牌是307");
    assert.equal(quotedReport.boosted.has("probe.fact"), false);
  });

  await t.test("否定窄候选仍拒绝保存", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请不要记住，我家的门牌是307。",
      requestId: "s03s-007-negative-narrow",
      envelope: modelReply({
        reply: "好的。",
        candidates: [candidate({ factKey: "home.narrow.door", body: "门牌是307" })],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home.narrow.door"), null, "否定窄候选不得普通保存");
    assert.match(result.reply, /没有保存/u);
  });

  await t.test("否定窄候选区分数值/内部标点与第三人主体", async (t2) => {
    const ctx = await setupContext(t2);
    const turns = [
      {
        text: "请不要记住，我家的门牌是307。",
        rejected: [
          ["neg.rejected.307", "门牌是307"],
          ["neg.invalid.30", "门牌是30"],
        ],
      },
      {
        text: "请不要记住，我家的门牌是3070。",
        rejected: [
          ["neg.rejected.3070", "门牌是3070"],
          ["neg.invalid.307prefix", "门牌是307"],
        ],
      },
      {
        text: "请不要记住，我家的门牌是1.2。",
        rejected: [
          ["neg.rejected.decimal", "门牌是1.2"],
          ["neg.invalid.integer", "门牌是12"],
        ],
      },
      {
        text: "请不要记住，我家的门牌是307，另外她家的门牌是308。",
        rejected: [["neg.rejected.mine", "门牌是307"]],
        independent: ["neg.saved.other", "她家的门牌是308"],
      },
    ];
    for (const [index, turn] of turns.entries()) {
      const candidates = turn.rejected.map(([factKey, body]) =>
        candidate({ factKey, body }));
      if (turn.independent) {
        candidates.push(candidate({
          factKey: turn.independent[0],
          body: turn.independent[1],
        }));
      }
      const { result } = await sendChat(ctx, {
        text: turn.text,
        requestId: `s03s-007-negative-values-${index}`,
        envelope: modelReply({ reply: "好的。", candidates }),
      });
      assert.equal(result.status, "completed");
      for (const [factKey] of turn.rejected) {
        assert.equal(rowByFact(ctx, "a", factKey), null, `${factKey} 不得落库`);
      }
      if (turn.independent) {
        const saved = rowByFact(ctx, "a", turn.independent[0]);
        assert.ok(saved, `${turn.independent[0]} 应正常保存`);
        assert.equal(saved.importance, DEFAULT_DETAIL);
      }
    }
  });

  await t.test("授权反例经真实 chat 落库后 importance 不越权", async (t2) => {
    const ctx = await setupContext(t2);
    const turns = [
      {
        text: "请记住，我家的门牌是307。",
        candidates: [
          ["auth.exact.307", "我家的门牌是307", IMPORTANT],
          ["auth.invalid.30", "我家的门牌是30", null],
        ],
      },
      {
        text: "请记住，我家的门牌是3070。",
        candidates: [
          ["auth.exact.3070", "我家的门牌是3070", IMPORTANT],
          ["auth.invalid.307prefix", "我家的门牌是307", null],
        ],
      },
      {
        text: "请记住，我家的门牌是1.2。",
        candidates: [
          ["auth.exact.decimal", "我家的门牌是1.2", IMPORTANT],
          ["auth.invalid.integer", "我家的门牌是12", null],
        ],
      },
      {
        text: "请记住，我家的门牌是12。",
        candidates: [
          ["auth.exact.integer", "我家的门牌是12", IMPORTANT],
          ["auth.invalid.decimal", "我家的门牌是1.2", null],
        ],
      },
      {
        text: "请记住，我家的门牌是A-12。",
        candidates: [
          ["auth.exact.identifier", "我家的门牌是A-12", IMPORTANT],
          ["auth.invalid.identifier", "我家的门牌是A12", null],
        ],
      },
      {
        text: "请记住，我家的门牌不是307。",
        candidates: [
          ["auth.exact.negated", "我家的门牌不是307", IMPORTANT],
          ["auth.invalid.dropped-negation", "我家的门牌是307", null],
        ],
      },
      {
        text: "请记住，我家的门牌是307，另外她家的门牌是308。",
        candidates: [
          // Part D 起，同一上下文里再次明确记住同一第一人称事实会复用
          // 前文的 auth.exact.307；这里保留 importance 与不重复的双重断言。
          ["auth.subject.mine", "我家的门牌是307", IMPORTANT, "auth.exact.307"],
          ["auth.subject.other", "她家的门牌是308", DEFAULT_DETAIL],
        ],
      },
    ];
    for (const [index, turn] of turns.entries()) {
      const { result } = await sendChat(ctx, {
        text: turn.text,
        requestId: `s03s-007-auth-values-${index}`,
        envelope: modelReply({
          reply: "嗯，我记住了。",
          candidates: turn.candidates.map(([factKey, body]) =>
            candidate({ factKey, body })),
        }),
      });
      assert.equal(result.status, "completed");
      for (const [factKey, , importance, heldKey] of turn.candidates) {
        const row = rowByFact(ctx, "a", heldKey ?? factKey);
        if (importance === null) {
          assert.equal(row, null, `${factKey} 不得落库`);
          continue;
        }
        assert.ok(row, `${factKey} 应经业务入口落库`);
        assert.equal(row.importance, importance, `${factKey} importance`);
        if (heldKey) {
          assert.equal(
            rowByFact(ctx, "a", factKey),
            null,
            `${factKey} 应复用既有条目，不得新增重复`,
          );
        }
      }
    }
  });

  await t.test("无主语前缀的宽候选同样拦截，独立事实正常保存", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307，另外我喜欢咖啡。",
      requestId: "s03s-007-wide-narrow-prefix",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [
          candidate({ factKey: "home.mixed.narrow", body: "门牌是307，另外我喜欢咖啡" }),
          candidate({ factKey: "home.coffee", body: "我喜欢咖啡" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "home.mixed.narrow"), null, "无主语宽候选不得落库");
    assert.equal(rowByFact(ctx, "a", "home.coffee").importance, DEFAULT_DETAIL);
    assert.match(result.reply, /能确认的那部分/u);
  });

  await t.test("否定窄候选带额外内容仍拒绝保存，独立事实正常保存", async (t2) => {
    const ctx = await setupContext(t2);
    const { result } = await sendChat(ctx, {
      text: "请不要记住，我家的门牌是307，另外我喜欢咖啡。",
      requestId: "s03s-007-negative-narrow-extra",
      envelope: modelReply({
        reply: "好的。",
        candidates: [
          candidate({ factKey: "neg.mixed.narrow", body: "门牌是307，另外我喜欢咖啡" }),
          candidate({ factKey: "neg.coffee", body: "我喜欢咖啡" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(rowByFact(ctx, "a", "neg.mixed.narrow"), null, "否定窄+额外候选不得落库");
    assert.equal(rowByFact(ctx, "a", "neg.coffee").importance, DEFAULT_DETAIL);
    assert.match(result.reply, /没有保存/u);
  });
});

async function naturalFact(ctx, {
  text, factKey, body, kind = "detail", characterId = "a", requestId,
}) {
  const { result } = await sendChat(ctx, {
    characterId,
    text,
    requestId,
    envelope: modelReply({
      reply: "记下了。",
      candidates: [candidate({ factKey, body, kind })],
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 1, `${factKey} 自然提炼应新建一条`);
  return result;
}

async function explicitRemember(ctx, {
  text, factKey, body, kind = "detail", characterId = "a", requestId,
}) {
  const { result } = await sendChat(ctx, {
    characterId,
    text,
    requestId,
    envelope: modelReply({
      reply: "嗯，我记住了。",
      candidates: [candidate({ factKey, body, kind })],
    }),
  });
  assert.equal(result.status, "completed");
  return result;
}

test("POL-REMEMBER-008 明确记住的异键唯一定位", async (t) => {
  await t.test("不同 key 命中同角色同来源事实，原地提升且重复幂等", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "user_home_door_number",
      body: "我家的门牌是307。",
      requestId: "s03s-008-natural",
    });
    const before = rowByFact(ctx, "a", "user_home_door_number");
    const contextBefore = contextVersionOf(ctx);
    const requestsBefore = ctx.server.requests.length;
    ctx.advance(HOUR);

    const result = await explicitRemember(ctx, {
      text: "请记住，我家的门牌是307。",
      factKey: "home_door_number",
      body: "我家的门牌是307。",
      requestId: "s03s-008-remember",
    });
    assert.equal(ctx.server.requests.length, requestsBefore + 1, "异键定位不得额外调用模型");
    assert.equal(result.memoryApplied, 0, "异键定位应是提升而不是新建");
    assert.doesNotMatch(result.reply, /没有保存成长期记忆/u);
    assert.equal(rowsFor(ctx, "a").length, 1, "不得因换 key 新增重复条目");
    assert.equal(rowByFact(ctx, "a", "home_door_number"), null, "模型新 key 不落库");
    const after = rowByFact(ctx, "a", "user_home_door_number");
    for (const field of [
      "id", "fact_key", "fact_identity_id", "body", "kind",
      "source_id", "source_version", "created_at", "updated_at",
    ]) {
      assert.equal(after[field], before[field], `${field} 应保持原条目`);
    }
    assert.equal(after.importance, IMPORTANT);
    assert.equal(after.version, before.version + 1);
    assert.equal(contextVersionOf(ctx), contextBefore + 1);

    ctx.advance(HOUR);
    const repeat = await explicitRemember(ctx, {
      text: "请记住，我家的门牌是307",
      factKey: "home_door_number_third",
      body: "我家的门牌是307",
      requestId: "s03s-008-repeat",
    });
    assert.equal(repeat.memoryApplied, 0);
    assert.equal(rowsFor(ctx, "a").length, 1);
    assert.equal(rowByFact(ctx, "a", "home_door_number_third"), null);
    assert.equal(rowByFact(ctx, "a", "user_home_door_number").version, after.version);
    assert.equal(rowByFact(ctx, "a", "user_home_door_number").importance, IMPORTANT);
    assert.equal(contextVersionOf(ctx), contextBefore + 1, "重复提升不得再次递增上下文");
  });

  await t.test("detail/preference/identity 的直接第一人称单人事实均可定位", async (t2) => {
    const ctx = await setupContext(t2);
    const cases = [
      {
        kind: "detail",
        naturalKey: "detail.door",
        newKey: "detail.door.renamed",
        text: "我家的门牌是307。",
        importance: IMPORTANT,
        versionDelta: 1,
      },
      {
        kind: "preference",
        naturalKey: "preference.coffee",
        newKey: "preference.coffee.renamed",
        text: "我喜欢无糖咖啡。",
        importance: IMPORTANT,
        versionDelta: 1,
      },
      {
        kind: "identity",
        naturalKey: "identity.birthday",
        newKey: "identity.birthday.renamed",
        text: "我的生日是十月一日。",
        importance: 90,
        versionDelta: 0,
      },
    ];
    for (const item of cases) {
      await naturalFact(ctx, {
        text: item.text,
        factKey: item.naturalKey,
        body: item.text,
        kind: item.kind,
        requestId: `s03s-008-${item.kind}-natural`,
      });
      const before = rowByFact(ctx, "a", item.naturalKey);
      const contextBefore = contextVersionOf(ctx);
      ctx.advance(HOUR);
      const result = await explicitRemember(ctx, {
        text: `请记住，${item.text}`,
        factKey: item.newKey,
        body: item.text,
        kind: item.kind,
        requestId: `s03s-008-${item.kind}-remember`,
      });
      assert.equal(result.memoryApplied, 0, `${item.kind} 不得新建重复`);
      assert.equal(rowByFact(ctx, "a", item.newKey), null);
      const after = rowByFact(ctx, "a", item.naturalKey);
      assert.equal(after.id, before.id, item.kind);
      assert.equal(after.fact_identity_id, before.fact_identity_id, item.kind);
      assert.equal(after.source_id, before.source_id, item.kind);
      assert.equal(after.importance, item.importance, item.kind);
      assert.equal(after.version, before.version + item.versionDelta, item.kind);
      assert.equal(
        contextVersionOf(ctx),
        contextBefore + item.versionDelta,
        `${item.kind} 只随实际提升递增`,
      );
    }
  });

  await t.test("同正文多条相关条目零写入并澄清", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door.one",
      body: "我家的门牌是307。",
      requestId: "s03s-008-multiple-one",
    });
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door.two",
      body: "我家的门牌是307。",
      requestId: "s03s-008-multiple-two",
    });
    const beforeRows = rowsFor(ctx, "a");
    const contextBefore = contextVersionOf(ctx);
    ctx.advance(HOUR);
    const result = await explicitRemember(ctx, {
      text: "请记住，我家的门牌是307。",
      factKey: "detail.door.three",
      body: "我家的门牌是307。",
      requestId: "s03s-008-multiple-remember",
    });
    assert.equal(result.memoryApplied, 0);
    assert.match(result.reply, /不能确定/u);
    assert.equal(rowsFor(ctx, "a").length, 2);
    assert.deepEqual(rowsFor(ctx, "a"), beforeRows, "多条既有条目不得被挑选提升");
    assert.equal(rowByFact(ctx, "a", "detail.door.three"), null);
    assert.equal(contextVersionOf(ctx), contextBefore);
  });

  await t.test("同正文 metadata 冲突零写入并澄清", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door",
      body: "我家的门牌是307。",
      requestId: "s03s-008-metadata-natural",
    });
    const before = rowByFact(ctx, "a", "detail.door");
    const contextBefore = contextVersionOf(ctx);
    ctx.advance(HOUR);
    const result = await explicitRemember(ctx, {
      text: "请记住，我家的门牌是307。",
      factKey: "preference.door",
      body: "我家的门牌是307。",
      kind: "preference",
      requestId: "s03s-008-metadata-remember",
    });
    assert.equal(result.memoryApplied, 0);
    assert.match(result.reply, /不能确定/u);
    assert.equal(rowsFor(ctx, "a").length, 1);
    assert.equal(rowByFact(ctx, "a", "preference.door"), null);
    const after = rowByFact(ctx, "a", "detail.door");
    assert.equal(after.id, before.id);
    assert.equal(after.kind, "detail");
    assert.equal(after.importance, DEFAULT_DETAIL);
    assert.equal(after.version, 1);
    assert.equal(contextVersionOf(ctx), contextBefore);
  });

  await t.test("不同数值不因同角色同来源跨键合并", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door",
      body: "我家的门牌是307。",
      requestId: "s03s-008-number-natural",
    });
    const before = rowByFact(ctx, "a", "detail.door");
    ctx.advance(HOUR);
    const result = await explicitRemember(ctx, {
      text: "请记住，我家的门牌是3070。",
      factKey: "detail.door.3070",
      body: "我家的门牌是3070。",
      requestId: "s03s-008-number-remember",
    });
    assert.equal(result.memoryApplied, 1, "307 与 3070 不得仅同文合并");
    const after = rowByFact(ctx, "a", "detail.door");
    assert.equal(after.id, before.id);
    assert.equal(after.importance, DEFAULT_DETAIL);
    assert.equal(after.version, before.version);
    assert.equal(rowByFact(ctx, "a", "detail.door.3070").importance, IMPORTANT);
  });

  await t.test("异键歧义旁的独立事实仍部分完成", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door.one",
      body: "我家的门牌是307。",
      requestId: "s03s-008-partial-one",
    });
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door.two",
      body: "我家的门牌是307。",
      requestId: "s03s-008-partial-two",
    });
    const contextBefore = contextVersionOf(ctx);
    ctx.advance(HOUR);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307，另外我喜欢咖啡。",
      requestId: "s03s-008-partial-remember",
      envelope: modelReply({
        reply: "嗯，我记住了。",
        candidates: [
          candidate({ factKey: "detail.door.new", body: "我家的门牌是307" }),
          candidate({ factKey: "detail.coffee", body: "我喜欢咖啡" }),
        ],
      }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.memoryApplied, 1, "只有独立事实应新建");
    assert.match(result.reply, /能确认的那部分/u);
    assert.equal(rowsFor(ctx, "a").length, 3);
    assert.equal(rowByFact(ctx, "a", "detail.coffee").importance, DEFAULT_DETAIL);
    assert.equal(rowByFact(ctx, "a", "detail.door.new"), null);
    assert.equal(contextVersionOf(ctx), contextBefore + 1);
  });

  await t.test("其他角色的同正文条目不参与定位", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "b.door",
      body: "我家的门牌是307。",
      characterId: "b",
      requestId: "s03s-008-other-natural",
    });
    const otherBefore = rowByFact(ctx, "b", "b.door");
    ctx.advance(HOUR);
    await explicitRemember(ctx, {
      text: "请记住，我家的门牌是307。",
      factKey: "a.door",
      body: "我家的门牌是307。",
      requestId: "s03s-008-other-remember",
    });
    const own = rowByFact(ctx, "a", "a.door");
    assert.ok(own, "当前角色仍应保存自己的事实");
    assert.equal(own.importance, IMPORTANT);
    assert.notEqual(own.fact_identity_id, otherBefore.fact_identity_id);
    const otherAfter = rowByFact(ctx, "b", "b.door");
    assert.equal(otherAfter.id, otherBefore.id);
    assert.equal(otherAfter.importance, DEFAULT_DETAIL);
    assert.equal(otherAfter.version, otherBefore.version);
    assert.equal(otherAfter.source_id, otherBefore.source_id);
    assert.equal(rowsFor(ctx, "b").length, 1);
  });

  await t.test("删除后换 key 或末尾句号都不能回流", async (t2) => {
    const cases = [
      { deletedBody: "我家的门牌是307。", candidateBody: "我家的门牌是307" },
      { deletedBody: "我家的门牌是307", candidateBody: "我家的门牌是307。" },
      { deletedBody: "我家的门牌是307。", candidateBody: "我家的门牌是307。" },
    ];
    for (const { deletedBody, candidateBody } of cases) {
      const ctx = await setupContext(t2);
      await naturalFact(ctx, {
        text: deletedBody,
        factKey: "user_home_door_number",
        body: deletedBody,
        requestId: "s03s-008-delete-natural",
      });
      ctx.store.memory.forget({
        characterId: "a",
        factKey: "user_home_door_number",
        nowMs: ctx.nowMs(),
      });
      assert.equal(rowsFor(ctx, "a").length, 0);
      const contextAfterForget = contextVersionOf(ctx);
      ctx.advance(HOUR);
      const result = await explicitRemember(ctx, {
        text: `请记住，${candidateBody}`,
        factKey: "home_door_number",
        body: candidateBody,
        requestId: "s03s-008-delete-remember",
      });
      assert.equal(result.memoryApplied, 0);
      assert.match(result.reply, /没有保存成长期记忆/u);
      assert.equal(rowsFor(ctx, "a").length, 0, "删除后不得以新 key 回流");
      assert.equal(rowByFact(ctx, "a", "home_door_number"), null);
      assert.equal(contextVersionOf(ctx), contextAfterForget);
    }
  });

  await t.test("原来源被排除时零写入且不退回新建", async (t2) => {
    const ctx = await setupContext(t2);
    await naturalFact(ctx, {
      text: "我家的门牌是307。",
      factKey: "detail.door",
      body: "我家的门牌是307。",
      requestId: "s03s-008-source-natural",
    });
    const before = rowByFact(ctx, "a", "detail.door");
    const contextBefore = contextVersionOf(ctx);
    ctx.advance(HOUR);
    const { result } = await sendChat(ctx, {
      text: "请记住，我家的门牌是307。",
      requestId: "s03s-008-source-remember",
      responder: ({ res }) => {
        withDatabase(ctx.store.dbPath, (db) => {
          db.prepare(`
            INSERT OR IGNORE INTO memory_source_controls
              (character_id, source_id_hash, created_at) VALUES (?, ?, ?)
          `).run("a", hashText(before.source_id), ctx.nowMs());
        });
        sendEnvelope(res, modelReply({
          reply: "嗯，我记住了。",
          candidates: [candidate({ factKey: "home_door_number", body: "我家的门牌是307。" })],
        }));
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.memoryApplied, 0);
    assert.match(result.reply, /不能确定/u);
    assert.equal(rowsFor(ctx, "a").length, 1);
    assert.equal(rowByFact(ctx, "a", "home_door_number"), null);
    assert.equal(rowByFact(ctx, "a", "detail.door").importance, before.importance);
    assert.equal(rowByFact(ctx, "a", "detail.door").version, before.version);
    assert.equal(contextVersionOf(ctx), contextBefore);
  });

  await t.test("非第一人称与 experience 不因同文合并", async (t2) => {
    const ctx = await setupContext(t2);
    const cases = [
      {
        kind: "detail",
        naturalKey: "detail.other.door",
        newKey: "detail.other.door.new",
        text: "她家的门牌是307。",
      },
      {
        kind: "detail",
        naturalKey: "detail.our.door",
        newKey: "detail.our.door.new",
        text: "我们家的门牌是307。",
      },
      {
        kind: "experience",
        naturalKey: "experience.sea",
        newKey: "experience.sea.new",
        text: "我们上次去海边。",
      },
    ];
    for (const item of cases) {
      await naturalFact(ctx, {
        text: item.text,
        factKey: item.naturalKey,
        body: item.text,
        kind: item.kind,
        requestId: `s03s-008-subject-${item.naturalKey}-natural`,
      });
      const before = rowByFact(ctx, "a", item.naturalKey);
      ctx.advance(HOUR);
      const result = await explicitRemember(ctx, {
        text: `请记住，${item.text}`,
        factKey: item.newKey,
        body: item.text,
        kind: item.kind,
        requestId: `s03s-008-subject-${item.naturalKey}-remember`,
      });
      assert.equal(result.memoryApplied, 1, `${item.text} 不得仅同文复用`);
      assert.ok(rowByFact(ctx, "a", item.newKey), `${item.text} 应保留为新条目`);
      const after = rowByFact(ctx, "a", item.naturalKey);
      assert.equal(after.id, before.id);
      assert.equal(after.importance, before.importance);
      assert.equal(after.version, before.version);
      assert.equal(after.source_id, before.source_id);
    }
  });
});
