/* S03h 聊天中“这件事只让你记得”验收：真实 SQLite + 构造 HTTP 模型响应。
   覆盖 POL-EXCLUSIVECHAT-001～005 的聊天、事务与在途失效核心；不启动 Electron/GUI，
   不调用真实模型服务，也不证明真实模型的自然语言识别能力。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");

const START = Date.UTC(2026, 9, 27, 10, 0, 0);
const DAY = "2026-10-27";
const MODEL_NAME = "fixture-chat-exclusive";
const API_KEY = "sk-fixture-chat-exclusive";

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

function sendEnvelope(res, envelope) {
  if (!res || res.destroyed || res.writableEnded) {
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

function withDatabase(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedRelationships(dbPath, definitions) {
  withDatabase(dbPath, (db) => {
    db.exec("PRAGMA foreign_keys = ON");
    const insertRelationship = db.prepare(`
      INSERT OR IGNORE INTO relationships (character_id, accepted_at, nickname)
      VALUES (?, ?, ?)
    `);
    const insertStats = db.prepare(`
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `);
    for (const definition of definitions) {
      insertRelationship.run(
        definition.id,
        "2026-01-01T00:00:00.000Z",
        definition.nickname ?? null,
      );
      insertStats.run(definition.id);
    }
    db.prepare(
      "INSERT OR IGNORE INTO roster (day, slot, character_id) VALUES (?, 'fixed', ?)",
    ).run(DAY, definitions[0].id);
  });
}

function countRows(dbPath, table) {
  return withDatabase(dbPath, (db) =>
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  );
}

function countWhere(dbPath, table, where, ...params) {
  return withDatabase(dbPath, (db) =>
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params).count,
  );
}

function readOne(dbPath, sql, ...params) {
  return withDatabase(dbPath, (db) => db.prepare(sql).get(...params));
}

function snapshotBusinessRows(store) {
  return {
    roster: countRows(store.dbPath, "roster"),
    relationships: withDatabase(store.dbPath, (db) =>
      db.prepare("SELECT * FROM relationships ORDER BY character_id").all(),
    ),
    stats: withDatabase(store.dbPath, (db) =>
      db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    ),
  };
}

function assertBusinessRowsUnchanged(store, before) {
  assert.deepEqual(snapshotBusinessRows(store), before);
}

async function setupContext(t, name, definitions = [{ id: "a" }, { id: "b" }, { id: "c" }]) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-exclusive-"));
  let tick = START;
  let store;
  const open = () =>
    createStore(dir, {
      now: () => tick,
      chat: {
        timeoutMs: 1000,
        fetchImpl: fetch,
        recoverInterrupted: false,
        getCredentials: () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY }),
      },
    });
  store = open();
  seedRelationships(store.dbPath, definitions);

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
    reopen() {
      try {
        store.close();
      } catch {
        // 崩溃/重启测试可能已主动关闭连接。
      }
      store = open();
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
      `S03H_CHAT_CLEANUP ${name} dbClosed=${cleanup.dbClosed} httpClosed=${cleanup.httpClosed} ` +
        `tempDirRemoved=${cleanup.tempDirRemoved}`,
    );
    assert.equal(cleanup.httpClosed, true);
    assert.equal(cleanup.tempDirRemoved, true);
  });
  return ctx;
}

function openConversation(store, characterId = "a") {
  return store.chat.openConversation({ characterId }).conversation;
}

function systemTextOf(body) {
  return body.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

function targetFromRequest(body, needle) {
  const line = systemTextOf(body)
    .split("\n")
    .find((item) => /^\[M\d+\]/u.test(item) && item.includes(needle));
  const match = line?.match(/^\[(M\d+)\]/u);
  assert.ok(match, `本轮候选列表没有找到 ${needle}`);
  return match[1];
}

function entryOf(store, characterId, factKey) {
  return store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function rememberDrink(store, options = {}) {
  const {
    characterId = "a",
    factKey = "pref.drink",
    body = "用户的饮品偏好是冰美式",
    sourceId = `seed-${characterId}-drink`,
  } = options;
  return store.memory.remember({
    characterId,
    factKey,
    body,
    kind: "preference",
    sourceId,
  });
}

function relayOne(store, fromCharacterId, toCharacterId, entryId, expectedVersion) {
  return store.memory.relay({
    fromCharacterId,
    toCharacterId,
    entries: [{ entryId, expectedVersion }],
  });
}

function seedSharedDrink(store) {
  const aEntry = rememberDrink(store);
  relayOne(store, "a", "b", aEntry.entry.id, aEntry.entry.version);
  return { aEntry: aEntry.entry, bEntry: entryOf(store, "b", "pref.drink") };
}

function exclusiveEnvelope(body, { needle, evidence, reply = "已经只留给你记得。" }) {
  return {
    reply,
    memoryCandidates: [],
    memoryOperation: {
      action: "keepExclusive",
      target: targetFromRequest(body, needle),
      evidence,
    },
  };
}

test("POL-EXCLUSIVECHAT-001 A 聊天保留独属，B 清除，C 无新增且业务状态不变", async (t) => {
  const ctx = await setupContext(t, "POL-EXCLUSIVECHAT-001");
  const { store, server } = ctx;
  const { aEntry, bEntry } = seedSharedDrink(store);
  assert.equal(bEntry.body, "用户的饮品偏好是冰美式");
  const businessBefore = snapshotBusinessRows(store);
  const conversation = openConversation(store);

  server.enqueue(({ body, res }) =>
    sendEnvelope(
      res,
      exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
    ),
  );
  const result = await store.chat.sendMessage({
    characterId: "a",
    conversationId: conversation.id,
    text: "饮品偏好只让你记得",
    requestId: "exclusive-001",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 0);
  assert.equal(result.reply, "好，这件事只留在我这里记得；其他角色已有的这条内容已清除，之后我也不会再分享或转告。");
  assert.equal(result.reply.includes("已经只留给你记得"), false);
  assert.equal(server.requests.length, 1);

  const retained = entryOf(store, "a", "pref.drink");
  assert.equal(retained.id, aEntry.id);
  assert.equal(retained.body, "用户的饮品偏好是冰美式");
  assert.equal(retained.version, aEntry.version + 1);
  assert.equal(retained.sourceId, "seed-a-drink");
  assert.equal(store.memory.searchMemories({ characterId: "a", query: "冰美式" }).length, 1);

  assert.equal(entryOf(store, "b", "pref.drink"), null);
  assert.equal(store.memory.searchMemories({ characterId: "b", query: "冰美式" }).length, 0);
  assert.equal(entryOf(store, "c", "pref.drink"), null);
  assert.equal(countWhere(ctx.store.dbPath, "memory_entries", "character_id = ?", "c"), 0);
  assert.equal(countRows(ctx.store.dbPath, "memory_share_identity_controls"), 1);
  assert.equal(
    countWhere(ctx.store.dbPath, "memory_forget_identity_controls", "character_id = ?", "b"),
    1,
  );
  assert.equal(
    countWhere(ctx.store.dbPath, "memory_source_controls", "character_id = ?", "b"),
    1,
  );
  assert.equal(
    countWhere(ctx.store.dbPath, "memory_forget_identity_controls", "character_id = ?", "c"),
    0,
  );
  assertBusinessRowsUnchanged(store, businessBefore);

  const messages = store.chat.getConversation({
    characterId: "a",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, "饮品偏好只让你记得");
  assert.equal(messages[1].content, result.reply);
  assert.equal(readOne(store.dbPath, "SELECT status FROM chat_requests WHERE id = 'exclusive-001'").status, "completed");

  ctx.reopen();
  assert.equal(entryOf(ctx.store, "a", "pref.drink").version, aEntry.version + 1);
  assert.equal(entryOf(ctx.store, "b", "pref.drink"), null);
  assert.equal(countRows(ctx.store.dbPath, "memory_share_identity_controls"), 1);
});

test("POL-EXCLUSIVECHAT-002 多候选不猜，唯一近期实际话题才可指代", async (t) => {
  const ambiguousCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-ambiguous");
  {
    const { store, server } = ambiguousCtx;
    const iced = rememberDrink(store, { factKey: "pref.iced", body: "用户的饮品偏好是冰美式" });
    rememberDrink(store, {
      factKey: "pref.tea",
      body: "用户的饮品偏好是热茶",
      sourceId: "seed-a-hot-tea",
    });
    relayOne(store, "a", "b", iced.entry.id, iced.entry.version);
    const conversation = openConversation(store);
    const versionsBefore = store.memory
      .listMemories("a")
      .map((entry) => [entry.factKey, entry.version]);

    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
      ),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-002-ambiguous",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /不确定你指的是哪一件事/u);
    assert.deepEqual(
      store.memory.listMemories("a").map((entry) => [entry.factKey, entry.version]),
      versionsBefore,
    );
    assert.equal(entryOf(store, "a", "pref.iced").body, "用户的饮品偏好是冰美式");
    assert.equal(entryOf(store, "a", "pref.tea").body, "用户的饮品偏好是热茶");
    assert.equal(entryOf(store, "b", "pref.iced").body, "用户的饮品偏好是冰美式");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
  }

  // 数据库里只有一条候选，但本轮原话和近期对话都没有实际话题依据：不得按唯一候选兜底。
  const noEvidenceCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-no-evidence");
  {
    const { store, server } = noEvidenceCtx;
    const only = rememberDrink(store);
    relayOne(store, "a", "b", only.entry.id, only.entry.version);
    const conversation = openConversation(store);

    server.enqueue(({ res }) =>
      sendEnvelope(res, {
        reply: "已经只留给你记得。",
        memoryCandidates: [],
        memoryOperation: {
          action: "keepExclusive",
          target: "M1",
          evidence: "这件事只让你记得",
        },
      }),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "这件事只让你记得",
      requestId: "exclusive-002-no-evidence",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.reply, "我这次没有改动任何记忆。");
    assert.equal(entryOf(store, "a", "pref.drink").version, 1);
    assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
  }

  // 近期对话唯一提到该事实时，“这件事”可以指代并执行。
  const recentCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-recent");
  {
    const { store, server } = recentCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    server.enqueue(({ res }) =>
      sendEnvelope(res, { reply: "我记下了。", memoryCandidates: [] }),
    );
    const contextTurn = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "我喜欢冰美式。",
      requestId: "exclusive-002-recent-context",
    });
    assert.equal(contextTurn.status, "completed");

    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "这件事只让你记得" }),
      ),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "这件事只让你记得",
      requestId: "exclusive-002-recent",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /只留在我这里记得/u);
    assert.equal(entryOf(store, "a", "pref.drink").version, 2);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(server.requests.length, 2);
  }

  // 请求框架加真实前文仍是明确命令，不受陈述边界收紧影响。
  const politeCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-polite");
  {
    const { store, server } = politeCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    server.enqueue(({ res }) =>
      sendEnvelope(res, { reply: "我记下了。", memoryCandidates: [] }),
    );
    await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "我喜欢冰美式。",
      requestId: "exclusive-002-polite-context",
    });
    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "请只让你记得这件事" }),
      ),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "请只让你记得这件事",
      requestId: "exclusive-002-polite",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /只留在我这里记得/u);
    assert.equal(entryOf(store, "a", "pref.drink").version, 2);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(server.requests.length, 2);
  }

  // “我的…”是所有格话题，不是叙述主语；正常保留命令应执行。
  const possessiveCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-possessive");
  {
    const { store, server } = possessiveCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "我的饮品偏好只让你记得。" }),
      ),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "我的饮品偏好只让你记得。",
      requestId: "exclusive-002-possessive",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /只留在我这里记得/u);
    assert.equal(entryOf(store, "a", "pref.drink").version, 2);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);
    assert.equal(server.requests.length, 1);
  }
});

test("POL-EXCLUSIVECHAT-002 引用、假设、否定、功能询问与伪造目标均不执行", async (t) => {
  const ctx = await setupContext(t, "POL-EXCLUSIVECHAT-002-rejections");
  const { store, server } = ctx;
  const iced = rememberDrink(store, { factKey: "pref.iced", body: "用户的饮品偏好是冰美式" });
  rememberDrink(store, {
    factKey: "pref.tea",
    body: "用户的饮品偏好是热茶",
    sourceId: "seed-a-hot-tea",
  });
  relayOne(store, "a", "b", iced.entry.id, iced.entry.version);
  const conversation = openConversation(store);
  const versionsBefore = store.memory
    .listMemories("a")
    .map((entry) => [entry.factKey, entry.version]);
  const controlsBefore = {
    forget: countRows(store.dbPath, "memory_forget_identity_controls"),
    source: countRows(store.dbPath, "memory_source_controls"),
    share: countRows(store.dbPath, "memory_share_identity_controls"),
    deleted: countRows(store.dbPath, "memory_deleted_fact_fingerprints"),
  };

  async function rejectedTurn({ text, requestId, operationFor, reply = "已经只留给你记得。" }) {
    server.enqueue(({ body, res }) =>
      sendEnvelope(res, {
        reply,
        memoryCandidates: [],
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
    assert.equal(result.reply, "我这次没有改动任何记忆。");
    assert.equal(result.memoryApplied, 0);
    assert.deepEqual(
      store.memory.listMemories("a").map((entry) => [entry.factKey, entry.version]),
      versionsBefore,
    );
    assert.equal(entryOf(store, "a", "pref.iced").body, "用户的饮品偏好是冰美式");
    assert.equal(entryOf(store, "a", "pref.tea").body, "用户的饮品偏好是热茶");
    assert.equal(entryOf(store, "b", "pref.iced").body, "用户的饮品偏好是冰美式");
    assert.deepEqual(
      {
        forget: countRows(store.dbPath, "memory_forget_identity_controls"),
        source: countRows(store.dbPath, "memory_source_controls"),
        share: countRows(store.dbPath, "memory_share_identity_controls"),
        deleted: countRows(store.dbPath, "memory_deleted_fact_fingerprints"),
      },
      controlsBefore,
    );
    return result;
  }

  await rejectedTurn({
    text: "你刚才说“饮品偏好只让你记得”，是什么意思？",
    requestId: "exclusive-002-quoted",
    operationFor: () => ({
      action: "keepExclusive",
      target: "M1",
      evidence: "饮品偏好只让你记得",
    }),
  });
  await rejectedTurn({
    text: "如果你说饮品偏好只让你记得，我会怎么理解？",
    requestId: "exclusive-002-hypothetical",
    operationFor: () => ({
      action: "keepExclusive",
      target: "M1",
      evidence: "饮品偏好只让你记得",
    }),
  });
  await rejectedTurn({
    text: "不要让饮品偏好只让你记得。",
    requestId: "exclusive-002-negated",
    operationFor: () => ({
      action: "keepExclusive",
      target: "M1",
      evidence: "饮品偏好只让你记得",
    }),
  });
  await rejectedTurn({
    text: "你能不能把饮品偏好只让你记得？",
    requestId: "exclusive-002-question",
    operationFor: () => ({
      action: "keepExclusive",
      target: "M1",
      evidence: "饮品偏好只让你记得",
    }),
  });

  await rejectedTurn({
    text: "冰美式只让你记得。",
    requestId: "exclusive-002-forged-target",
    operationFor: () => ({
      action: "keepExclusive",
      target: "M99",
      evidence: "冰美式只让你记得",
    }),
  });
  await rejectedTurn({
    text: "冰美式只让你记得。",
    requestId: "exclusive-002-wrong-target",
    operationFor: (body) => ({
      action: "keepExclusive",
      target: targetFromRequest(body, "热茶"),
      evidence: "冰美式只让你记得",
    }),
  });

  // 普通陈述不是保留命令：即使模型错误建议 keepExclusive 且 evidence 取自原句，
  // 也不能删除其他持有者或给出成功确认。
  const statementCtx = await setupContext(t, "POL-EXCLUSIVECHAT-002-statements");
  {
    const { store, server } = statementCtx;
    const aEntry = rememberDrink(store);
    relayOne(store, "a", "b", aEntry.entry.id, aEntry.entry.version);
    const conversation = openConversation(store);

    async function rejectedStatement({ text, requestId, evidence }) {
      server.enqueue(({ res }) =>
        sendEnvelope(res, {
          reply: "已经只留给你记得。",
          memoryCandidates: [],
          memoryOperation: {
            action: "keepExclusive",
            target: "M1",
            evidence,
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
      assert.equal(result.memoryApplied, 0);
      assert.equal(entryOf(store, "a", "pref.drink").version, 1);
      assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
      assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
    }

    await rejectedStatement({
      text: "只有你记得我的饮品偏好，其他人都忘了。",
      requestId: "exclusive-002-statement-only-you-full",
      evidence: "只有你记得我的饮品偏好，其他人都忘了。",
    });
    await rejectedStatement({
      text: "只有你记得我的饮品偏好，其他人都忘了。",
      requestId: "exclusive-002-statement-only-you-clause",
      evidence: "只有你记得我的饮品偏好",
    });
    await rejectedStatement({
      text: "我发现就你记得我的饮品偏好。",
      requestId: "exclusive-002-statement-just-you",
      evidence: "我发现就你记得我的饮品偏好。",
    });
    server.enqueue(({ res }) =>
      sendEnvelope(res, { reply: "我记下了。", memoryCandidates: [] }),
    );
    await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "我喜欢冰美式。",
      requestId: "exclusive-002-statement-context",
    });
    await rejectedStatement({
      text: "他认为这件事只让你记得。",
      requestId: "exclusive-002-statement-narrated-topic",
      evidence: "他认为这件事只让你记得。",
    });
  }
});

test("POL-EXCLUSIVECHAT-003 旧版本、取消、迟到与回复写失败均无半完成", async (t) => {
  const staleCtx = await setupContext(t, "POL-EXCLUSIVECHAT-003-stale");
  {
    const { store, server } = staleCtx;
    const { aEntry } = seedSharedDrink(store);
    const conversation = openConversation(store);
    let held = null;
    server.enqueue(({ res }) => {
      held = res;
    });
    const pending = store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-003-stale",
    });
    await waitFor(() => held !== null);
    store.memory.correct({
      characterId: "a",
      entryId: aEntry.id,
      expectedVersion: 1,
      body: "用户喜欢无糖汽水",
      sourceId: "manual-correct-before-response",
      nowMs: staleCtx.nowMs(),
    });
    sendEnvelope(held, {
      reply: "已经只留给你记得。",
      memoryCandidates: [],
      memoryOperation: {
        action: "keepExclusive",
        target: "M1",
        evidence: "饮品偏好只让你记得",
      },
    });
    const result = await pending;
    assert.equal(result.status, "stale");
    assert.equal(result.reply, null);
    assert.equal(entryOf(store, "a", "pref.drink").body, "用户喜欢无糖汽水");
    assert.ok(entryOf(store, "b", "pref.drink"), "纠正来源后 B 的持有关系仍在，独属保留未执行");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
  }

  const cancelCtx = await setupContext(t, "POL-EXCLUSIVECHAT-003-cancel");
  {
    const { store, server } = cancelCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    let held = null;
    server.enqueue(({ res }) => {
      held = res;
    });
    const pending = store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-003-cancel",
    });
    await waitFor(() => held !== null);
    store.chat.cancelRequest({ characterId: "a", requestId: "exclusive-003-cancel" });
    sendEnvelope(held, {
      reply: "已经只留给你记得。",
      memoryCandidates: [],
      memoryOperation: {
        action: "keepExclusive",
        target: "M1",
        evidence: "饮品偏好只让你记得",
      },
    });
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.reply, null);
    assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
  }

  const rollbackCtx = await setupContext(t, "POL-EXCLUSIVECHAT-003-rollback");
  {
    const { store, server } = rollbackCtx;
    const { aEntry } = seedSharedDrink(store);
    const conversation = openConversation(store);
    const bContextBefore = store.memory.getContextVersion("b");

    withDatabase(store.dbPath, (db) => {
      db.exec(`
        CREATE TRIGGER fail_exclusive_confirmation
        BEFORE INSERT ON chat_messages
        WHEN NEW.role = 'assistant'
        BEGIN
          SELECT RAISE(ABORT, 'fail exclusive confirmation');
        END
      `);
    });
    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
      ),
    );
    const failed = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-003-rollback",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.reply, null);
    assert.equal(entryOf(store, "a", "pref.drink").version, aEntry.version);
    assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(store.memory.getContextVersion("b"), bContextBefore);
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
    assert.equal(countRows(store.dbPath, "memory_forget_identity_controls"), 0);
    assert.equal(countRows(store.dbPath, "memory_source_controls"), 0);
    assert.equal(
      countWhere(store.dbPath, "chat_messages", "role = 'assistant'"),
      0,
    );
    const failedRow = readOne(
      store.dbPath,
      "SELECT status, error_code FROM chat_requests WHERE id = 'exclusive-003-rollback'",
    );
    assert.equal(failedRow.status, "failed");
    assert.ok(failedRow.error_code);

    withDatabase(store.dbPath, (db) => db.exec("DROP TRIGGER fail_exclusive_confirmation"));
    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
      ),
    );
    const retried = await store.chat.retryRequest({
      characterId: "a",
      requestId: "exclusive-003-rollback",
    });
    assert.equal(retried.status, "completed");
    assert.match(retried.reply, /只留在我这里记得/u);
    assert.equal(entryOf(store, "a", "pref.drink").version, 2);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);

    const replay = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-003-rollback",
    });
    assert.equal(replay.status, "completed");
    assert.equal(replay.reply, retried.reply);
    assert.equal(server.requests.length, 2);
    assert.equal(
      store.memory.listMemories("a").filter((entry) => entry.factKey === "pref.drink").length,
      1,
    );
    assert.equal(entryOf(store, "a", "pref.drink").version, 2);
  }
});

test("POL-EXCLUSIVECHAT-004 旧的接收者对话与在途转告结果失效，新对话无该记忆", async (t) => {
  const bContext = await setupContext(t, "POL-EXCLUSIVECHAT-004-receiver");
  {
    const { store, server } = bContext;
    seedSharedDrink(store);
    const aConversation = openConversation(store, "a");
    const bConversation = openConversation(store, "b");
    let heldBOld = null;
    server.enqueue(({ res }) => {
      heldBOld = res;
    });
    const bOldPending = store.chat.sendMessage({
      characterId: "b",
      conversationId: bConversation.id,
      text: "你在吗？",
      requestId: "exclusive-004-b-old",
    });
    await waitFor(() => heldBOld !== null);

    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
      ),
    );
    const exclusive = await store.chat.sendMessage({
      characterId: "a",
      conversationId: aConversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-004-a",
    });
    assert.equal(exclusive.status, "completed");
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(server.requests.length, 2);

    sendEnvelope(heldBOld, {
      reply: "旧上下文回复",
      memoryCandidates: [],
      memoryRelay: null,
    });
    const bOld = await bOldPending;
    assert.equal(bOld.status, "stale");
    assert.equal(bOld.reply, null);

    const bMessagesBefore = store.chat.getConversation({
      characterId: "b",
      conversationId: bConversation.id,
    }).messages;
    assert.equal(bMessagesBefore.some((message) => message.content === "旧上下文回复"), false);

    server.enqueue(({ res }) =>
      sendEnvelope(res, { reply: "这个我现在想不起来了。", memoryCandidates: [] }),
    );
    const bNew = await store.chat.sendMessage({
      characterId: "b",
      conversationId: bConversation.id,
      text: "你知道我喜欢的饮品吗？",
      requestId: "exclusive-004-b-new",
    });
    assert.equal(bNew.status, "completed");
    assert.equal(server.requests.length, 3);
    assert.equal(store.memory.searchMemories({ characterId: "b", query: "冰美式" }).length, 0);
    const newContext = systemTextOf(server.requests.at(-1));
    assert.equal(newContext.includes("冰美式"), false);
    const bMessagesAfter = store.chat.getConversation({
      characterId: "b",
      conversationId: bConversation.id,
    }).messages;
    assert.equal(bMessagesAfter.filter((message) => message.role === "assistant").length, 1);
    assert.equal(bMessagesAfter.at(-1).content, "这个我现在想不起来了。");
  }

  const relayCtx = await setupContext(t, "POL-EXCLUSIVECHAT-004-relay");
  {
    const { store, server } = relayCtx;
    const { aEntry } = seedSharedDrink(store);
    const conversation = openConversation(store, "a");
    let heldRelay = null;
    server.enqueue(({ res }) => {
      heldRelay = res;
    });
    const relayPending = store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "把我的饮品偏好告诉琥珀",
      requestId: "exclusive-004-relay-old",
    });
    await waitFor(() => heldRelay !== null);

    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "饮品偏好只让你记得" }),
      ),
    );
    const exclusive = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "饮品偏好只让你记得",
      requestId: "exclusive-004-a-2",
    });
    assert.equal(exclusive.status, "completed");
    assert.equal(entryOf(store, "a", "pref.drink").version, aEntry.version + 1);
    assert.equal(entryOf(store, "b", "pref.drink"), null);

    sendEnvelope(heldRelay, {
      reply: "好的，我已经告诉她了。",
      memoryCandidates: [],
      memoryRelay: { target: "M1", character: "C1" },
    });
    const relayResult = await relayPending;
    assert.equal(relayResult.status, "stale");
    assert.equal(relayResult.reply, null);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    const aMessages = store.chat.getConversation({
      characterId: "a",
      conversationId: conversation.id,
    }).messages;
    assert.equal(aMessages.some((message) => message.content === "好的，我已经告诉她了。"), false);
    assert.equal(server.requests.length, 2);
  }
});

test("POL-EXCLUSIVECHAT-005 三动作范围不混淆，派生保留不改成亲历且禁分享继续生效", async (t) => {
  const forgetCtx = await setupContext(t, "POL-EXCLUSIVECHAT-005-forget");
  {
    const { store, server } = forgetCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    server.enqueue(({ body, res }) =>
      sendEnvelope(res, {
        reply: "已经忘记。",
        memoryCandidates: [],
        memoryOperation: {
          action: "forget",
          target: targetFromRequest(body, "冰美式"),
          scope: "self",
          evidence: "只让你忘记冰美式这件事",
        },
      }),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "只让你忘记冰美式这件事",
      requestId: "exclusive-005-forget",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /只在自己这里忘记/u);
    assert.equal(entryOf(store, "a", "pref.drink"), null);
    assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 0);
  }

  const restrictCtx = await setupContext(t, "POL-EXCLUSIVECHAT-005-restrict");
  {
    const { store, server } = restrictCtx;
    seedSharedDrink(store);
    const conversation = openConversation(store);
    server.enqueue(({ body, res }) =>
      sendEnvelope(res, {
        reply: "已经禁止分享。",
        memoryCandidates: [],
        memoryOperation: {
          action: "restrictSharing",
          target: targetFromRequest(body, "冰美式"),
          evidence: "冰美式这件事以后别再分享",
        },
      }),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "冰美式这件事以后别再分享",
      requestId: "exclusive-005-restrict",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /之后我不会再把这件事分享或转告/u);
    assert.equal(entryOf(store, "a", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(entryOf(store, "b", "pref.drink").body, "用户的饮品偏好是冰美式");
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);
  }

  const derivedCtx = await setupContext(t, "POL-EXCLUSIVECHAT-005-derived", [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
  ]);
  {
    const { store, server } = derivedCtx;
    const original = rememberDrink(store, {
      characterId: "d",
      sourceId: "seed-d-drink",
    });
    relayOne(store, "d", "a", original.entry.id, original.entry.version);
    const aDerived = entryOf(store, "a", "pref.drink");
    relayOne(store, "a", "b", aDerived.id, aDerived.version);
    assert.equal(aDerived.originCharacterId, "d");
    assert.equal(aDerived.narratorCharacterId, "d");

    const conversation = openConversation(store, "a");
    server.enqueue(({ body, res }) =>
      sendEnvelope(
        res,
        exclusiveEnvelope(body, { needle: "冰美式", evidence: "冰美式只让你记得" }),
      ),
    );
    const result = await store.chat.sendMessage({
      characterId: "a",
      conversationId: conversation.id,
      text: "冰美式只让你记得",
      requestId: "exclusive-005-derived",
    });
    assert.equal(result.status, "completed");
    assert.match(result.reply, /只留在我这里记得/u);

    const retained = entryOf(store, "a", "pref.drink");
    assert.equal(retained.body, "用户的饮品偏好是冰美式");
    assert.equal(retained.derived, true);
    assert.equal(retained.originCharacterId, "d");
    assert.equal(retained.narratorCharacterId, "d");
    assert.equal(retained.derivedFromEntryId, original.entry.id);
    assert.equal(retained.version, aDerived.version + 1);
    assert.equal(entryOf(store, "d", "pref.drink"), null);
    assert.equal(entryOf(store, "b", "pref.drink"), null);
    assert.equal(entryOf(store, "c", "pref.drink"), null);
    assert.equal(store.memory.searchMemories({ characterId: "a", query: "冰美式" }).length, 1);
    assert.throws(
      () =>
        store.memory.share({
          fromCharacterId: "a",
          toCharacterId: "c",
          entryIds: [retained.id],
        }),
      (error) => error.code === "SHARE_NOT_ALLOWED" || error.code === "SHARE_BLOCKED",
    );
    assert.throws(
      () =>
        store.memory.relay({
          fromCharacterId: "a",
          toCharacterId: "c",
          entries: [{ entryId: retained.id, expectedVersion: retained.version }],
        }),
      (error) => error.code === "SHARE_BLOCKED",
    );
    assert.equal(entryOf(store, "c", "pref.drink"), null);
    assert.equal(countRows(store.dbPath, "memory_share_identity_controls"), 1);
  }
});
