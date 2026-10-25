/* S03b 聊天服务验收：真实 SQLite + 受控 HTTP，不启动 GUI、不调用真实模型。
   覆盖 POL-CHAT-001～005/007 的服务核心；UI、陪伴互动生命周期和真实 DeepSeek 仍为后续边界。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");

const START = Date.UTC(2026, 9, 26, 10, 0, 0);
const MODEL_NAME = "fixture-chat";
const API_KEY = "sk-fixture-chat";

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

function sendRawContent(res, content, status = 200) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
  );
}

function sendReply(res, content, status = 200) {
  sendRawContent(
    res,
    JSON.stringify({ reply: content, memoryCandidates: [] }),
    status,
  );
}

function sendEnvelope(res, envelope, status = 200) {
  sendRawContent(res, JSON.stringify(envelope), status);
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
        responder ? responder({ body, res }) : sendReply(res, "收到。"),
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

async function setupChatTest(
  t,
  { timeoutMs = 1000, credentials = true, fixedClock = false, recoverInterrupted = false } = {},
) {
  const server = await startModelServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-"));
  let tick = START;
  let frozen = fixedClock;
  const now = () => (frozen ? tick : tick++);
  let store;
  const open = (overrides = {}) =>
    createStore(dir, {
      now,
      chat: {
        timeoutMs,
        fetchImpl: fetch,
        recoverInterrupted: overrides.recoverInterrupted ?? recoverInterrupted,
        getCredentials: credentials
          ? () => ({ baseUrl: server.baseUrl, modelName: MODEL_NAME, apiKey: API_KEY })
          : () => null,
      },
    });
  store = open();
  seedRelationships(store.dbPath, ["rin", "hu", "cheng"]);

  const ctx = {
    dir,
    server,
    get store() {
      return store;
    },
    advance(ms) {
      tick += ms;
    },
    freezeClock(ms) {
      tick = ms;
      frozen = true;
    },
    reopen(overrides = {}) {
      try {
        store.close();
      } catch {
        // 崩溃恢复测试可能已主动关闭连接。
      }
      store = open(overrides);
    },
  };
  t.after(async () => {
    try {
      store.close();
    } catch {
      // 测试已主动关闭时仍继续清理。
    }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

test("POL-CHAT-001 同一 SQLite、已结识角色隔离与名单不变", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  store.memory.remember({
    characterId: "rin",
    factKey: "secret.rin",
    body: "用户单独告诉凛暗号蓝鲸",
    kind: "identity",
    sourceId: "seed-rin",
  });
  store.memory.remember({
    characterId: "hu",
    factKey: "pref.hu",
    body: "用户单独告诉琥珀喜欢热茶",
    kind: "preference",
    sourceId: "seed-hu",
  });
  const rosterBefore = countRows(store.dbPath, "roster");
  const stateBefore = countRows(store.dbPath, "app_state");
  const rinConversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const huConversation = store.chat.openConversation({ characterId: "hu" }).conversation;

  const rinResult = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: rinConversation.id,
    text: "今天好。\n你在吗？",
  });
  const huResult = await store.chat.sendMessage({
    characterId: "hu",
    conversationId: huConversation.id,
    text: "今天好。",
  });
  assert.equal(rinResult.status, "completed");
  assert.equal(huResult.status, "completed");
  assert.equal(server.requests.length, 2);
  const systemPrompt = server.requests[0].messages.find(
    (message) => message.role === "system",
  ).content;
  for (const kind of ["identity", "preference", "experience", "detail"]) {
    assert.ok(systemPrompt.includes(kind));
  }
  assert.ok(systemPrompt.includes("用户长期偏好"));
  assert.ok(systemPrompt.includes("真实共同经历"));
  assert.ok(systemPrompt.includes("factKey"));
  assert.ok(systemPrompt.includes("稳定"));
  assert.ok(systemPrompt.includes("主体"));
  assert.ok(systemPrompt.includes("否定"));
  assert.ok(systemPrompt.includes("来源归因边界"));
  assert.ok(systemPrompt.includes("用户明确告知"));
  assert.ok(systemPrompt.includes("推断"));
  assert.ok(systemPrompt.includes("转述"));
  assert.ok(systemPrompt.includes("当前有效记忆或最近对话"));
  assert.ok(systemPrompt.includes("过去从未说过"));
  assert.ok(systemPrompt.includes("角色设定与特征只用于角色自己的语气"));
  const rinMemory = server.requests[0].messages.filter(
    (message) => message.role === "system",
  )[1].content;
  const huMemory = server.requests[1].messages.filter(
    (message) => message.role === "system",
  )[1].content;
  assert.ok(rinMemory.includes("用户明确告知"));
  assert.ok(rinMemory.includes("身份"));
  assert.ok(huMemory.includes("偏好"));
  assert.ok(huMemory.includes("用户明确告知"));

  const rinBody = JSON.stringify(server.requests[0]);
  const huBody = JSON.stringify(server.requests[1]);
  assert.ok(rinBody.includes("凛"));
  assert.ok(rinBody.includes("蓝鲸"));
  assert.equal(rinBody.includes("热茶"), false);
  assert.equal(rinBody.includes("琥珀"), false);
  assert.ok(huBody.includes("琥珀"));
  assert.ok(huBody.includes("热茶"));
  assert.equal(huBody.includes("蓝鲸"), false);
  assert.equal(huBody.includes("凛"), false);
  assert.equal(countRows(store.dbPath, "roster"), rosterBefore);
  assert.equal(countRows(store.dbPath, "app_state"), stateBefore);
  assert.throws(
    () => store.chat.openConversation({ characterId: "ghost" }),
    (error) => error.code === "CHARACTER_UNKNOWN",
  );

  ctx.reopen();
  const reopened = ctx.store.chat.getConversation({
    characterId: "rin",
    conversationId: rinConversation.id,
  });
  assert.equal(reopened.messages.length, 2);
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "rin", query: "蓝鲸" })[0]?.body,
    "用户单独告诉凛暗号蓝鲸",
  );
});

test("POL-CHAT-008 无记忆时标注检索边界，对照例不进入记忆且不落库", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  // 模拟模型把提示里的对照例误当作用户信息：证据不在用户原话中，必须被拒绝。
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "这个我现在想不起来了，能再跟我说说吗？",
      memoryCandidates: [
        {
          factKey: "pref.example",
          body: "用户常喝酸梅汤",
          kind: "preference",
          trust: "stated",
          evidence: "你还记得我上次喝的酸梅汤吗",
        },
      ],
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "今天好。",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 0);
  assert.equal(store.memory.listMemories("rin").length, 0);

  const systems = server.requests[0].messages.filter((message) => message.role === "system");
  assert.equal(systems.length, 2);
  const memoryContext = systems[1].content;
  assert.ok(memoryContext.includes("暂无有效记忆。"));
  assert.ok(memoryContext.includes("不是全部人生记录"));
  assert.ok(memoryContext.includes("现在没有可用记录"));
  assert.ok(memoryContext.includes("从未交流"));
  assert.ok(memoryContext.includes("删除过记录或关闭过来源"));
  assert.ok(memoryContext.includes("历史断言"));
  // 对照例只出现在系统提示，不得混入本轮记忆数据。
  assert.equal(memoryContext.includes("酸梅汤"), false);
  const prompt = systems[0].content;
  assert.ok(prompt.includes("未知表达对照例"));
  assert.ok(prompt.includes("不是用户信息、不是可用记忆"));
  assert.ok(prompt.includes("酸梅汤"));
  assert.ok(prompt.includes("想不起来"));
});

test("POL-CHAT-002 用户明确事实写一次，助手建议与模型授权不写入", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const userText = "我喜欢无糖咖啡，请记住。";
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "温茶，知道了。",
      memoryCandidates: [
        {
          factKey: "pref.coffee",
          body: "用户喜欢无糖咖啡",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢无糖咖啡",
        },
        {
          factKey: "pref.guess",
          body: "用户喜欢拿铁",
          kind: "preference",
          trust: "stated",
          evidence: "用户喜欢拿铁",
        },
      ],
      action: "forget",
      shareTo: "hu",
      authorization: "grant-all",
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: userText,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reply, "温茶，知道了。");
  assert.equal(result.memoryApplied, 1);

  const messages = store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  const userSource = messages.find((message) => message.role === "user").sourceId;
  const memories = store.memory.listMemories("rin");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].factKey, "pref.coffee");
  assert.equal(memories[0].sourceId, userSource);
  assert.equal(memories[0].trust, "stated");
  assert.equal(countRows(store.dbPath, "memory_forget_controls"), 0);
  assert.equal(countRows(store.dbPath, "memory_derivations"), 0);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 1);

  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [
        {
          factKey: "pref.rejected",
          body: "用户喜欢拿铁",
          kind: "preference",
          trust: "stated",
          evidence: "用户喜欢拿铁",
        },
      ],
    }),
  );
  const rejectedCandidate = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "今天呢？",
  });
  assert.equal(rejectedCandidate.status, "completed");
  assert.equal(rejectedCandidate.reply, "好的。");
  assert.equal(rejectedCandidate.memoryApplied, 0);
  assert.equal(store.memory.listMemories("rin").length, 1);

  server.enqueue(({ res }) => sendReply(res, "我觉得你可以试试拿铁。"));
  const suggestion = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "那你推荐什么？",
  });
  assert.equal(suggestion.status, "completed");
  assert.equal(suggestion.reply, "我觉得你可以试试拿铁。");
  assert.equal(suggestion.memoryApplied, 0);
  assert.equal(store.memory.listMemories("rin").length, 1);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 1);

  ctx.reopen();
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "rin", query: "无糖咖啡" })[0]?.factKey,
    "pref.coffee",
  );
  assert.equal(
    ctx.store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.length,
    6,
  );
});

test("POL-CHAT-002 纯文本宣称记住但未返回结构不得作为完成", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  server.enqueue(({ res }) =>
    sendRawContent(res, "温茶。好，我记着了。"),
  );
  const result = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "请记住，我喜欢温茶。",
    requestId: "plain-claim",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "INVALID_RESPONSE");
  assert.equal(result.reply, null);
  assert.equal(result.retryable, true);
  const messages = store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(store.memory.listMemories("rin").length, 0);
});

test("POL-CHAT-003 取消与关闭对话丢弃迟到回复", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  server.enqueue(async ({ res }) => {
    await delay(150);
    sendReply(res, "迟到的回复");
  });
  const first = store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "第一句",
    requestId: "cancel-1",
  });
  await waitFor(() => server.requests.length === 1);
  const cancelled = store.chat.cancelRequest({
    characterId: "rin",
    requestId: "cancel-1",
  });
  assert.equal(cancelled.cancelled, true);
  const firstResult = await first;
  assert.equal(firstResult.status, "cancelled");
  assert.equal(firstResult.reply, null);
  assert.equal(store.chat.getRequest({ characterId: "rin", requestId: "cancel-1" }).status, "cancelled");

  server.enqueue(async ({ res }) => {
    await delay(150);
    sendReply(res, "关闭后的迟到回复");
  });
  const second = store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "第二句",
    requestId: "cancel-2",
  });
  await waitFor(() => server.requests.length === 2);
  const closed = store.chat.closeConversation({
    characterId: "rin",
    conversationId: conversation.id,
  });
  assert.deepEqual(closed.cancelledRequestIds, ["cancel-2"]);
  const secondResult = await second;
  assert.equal(secondResult.status, "cancelled");
  assert.equal(secondResult.reply, null);

  const messages = store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages.every((message) => message.role === "user"), true);
  assert.equal(store.memory.listMemories("rin").length, 0);
  await assert.rejects(
    () =>
      store.chat.sendMessage({
        characterId: "rin",
        conversationId: conversation.id,
        text: "关闭后继续",
      }),
    (error) => error.code === "CONVERSATION_CLOSED",
  );
});

test("POL-CHAT-003 超时/结构失败可重试且不重复消息与记忆", async (t) => {
  const ctx = await setupChatTest(t, { timeoutMs: 200 });
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  server.enqueue(async ({ res }) => {
    await delay(500);
    sendReply(res, "迟到回复");
  });
  const userText = "我喜欢茉莉花茶，请记住。";
  const first = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: userText,
    requestId: "retry-1",
  });
  assert.equal(first.status, "failed");
  assert.equal(first.errorCode, "TIMEOUT");
  assert.equal(first.retryable, true);
  await delay(60);
  assert.equal(server.requests.length, 1);
  assert.equal(
    store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.filter((message) => message.role === "user").length,
    1,
  );

  server.enqueue(({ res }) => sendRawContent(res, '{"reply":'));
  const invalid = await store.chat.retryRequest({
    characterId: "rin",
    requestId: "retry-1",
  });
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.errorCode, "INVALID_RESPONSE");
  assert.equal(server.requests.length, 2);

  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "这次收到了。",
      memoryCandidates: [
        {
          factKey: "pref.jasmine",
          body: "用户喜欢茉莉花茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢茉莉花茶",
        },
      ],
    }),
  );
  const retried = await store.chat.retryRequest({
    characterId: "rin",
    requestId: "retry-1",
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.reply, "这次收到了。");
  assert.equal(retried.memoryApplied, 1);
  assert.equal(server.requests.length, 3);
  assert.equal(
    store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.length,
    2,
  );
  assert.equal(store.memory.listMemories("rin").length, 1);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 1);

  const repeated = await store.chat.retryRequest({
    characterId: "rin",
    requestId: "retry-1",
  });
  assert.equal(repeated.status, "completed");
  assert.equal(server.requests.length, 3);
});

test("POL-CHAT-004/005 在途纠正与删除使迟到回复失效", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const sharedFact = store.memory.remember({
    characterId: "rin",
    factKey: "pref.review-chat",
    body: "用户喜欢旧茶",
    kind: "preference",
    sourceId: "seed-review",
  });
  store.memory.share({
    fromCharacterId: "rin",
    toCharacterId: "hu",
    entryIds: [sharedFact.entry.id],
  });

  server.enqueue(async ({ res }) => {
    await delay(150);
    sendEnvelope(res, {
      reply: "按旧理解回答。",
      memoryCandidates: [
        {
          factKey: "pref.candidate",
          body: "用户喜欢新茶",
          kind: "preference",
          trust: "stated",
          evidence: "喜欢新茶",
        },
      ],
    });
  });
  const correcting = store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "我其实喜欢新茶",
    requestId: "inflight-correct",
  });
  await waitFor(() => server.requests.length === 1);
  const corrected = store.memory.correct({
    characterId: "rin",
    factKey: "pref.review-chat",
    body: "用户喜欢新茶",
    sourceId: "correct-user-source",
  });
  assert.equal(corrected.updated, 2);
  const correctedResult = await correcting;
  assert.equal(correctedResult.status, "stale");
  assert.equal(correctedResult.reply, null);
  assert.equal(
    store.chat.getRequest({ characterId: "rin", requestId: "inflight-correct" }).status,
    "stale",
  );
  assert.equal(store.memory.listMemories("rin").some((entry) => entry.factKey === "pref.candidate"), false);

  const huConversation = store.chat.openConversation({ characterId: "hu" }).conversation;
  const huResult = await store.chat.sendMessage({
    characterId: "hu",
    conversationId: huConversation.id,
    text: "现在呢？",
  });
  assert.equal(huResult.status, "completed");
  const huBody = JSON.stringify(server.requests[1]);
  const huMemory = server.requests[1].messages.filter(
    (message) => message.role === "system",
  )[1].content;
  assert.ok(huMemory.includes("转述"));
  assert.ok(huMemory.includes("听rin说"));
  assert.ok(huBody.includes("用户喜欢新茶"));
  assert.equal(huBody.includes("用户喜欢旧茶"), false);

  server.enqueue(async ({ res }) => {
    await delay(150);
    sendEnvelope(res, { reply: "删除后的迟到回复。", memoryCandidates: [] });
  });
  const deleting = store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "再说一次",
    requestId: "inflight-delete",
  });
  await waitFor(() => server.requests.length === 3);
  store.memory.forget({
    characterId: "rin",
    factKey: "pref.review-chat",
    scope: "self",
  });
  const deletedResult = await deleting;
  assert.equal(deletedResult.status, "stale");
  assert.equal(deletedResult.reply, null);
  assert.equal(store.memory.listMemories("rin").length, 0);
  assert.ok(
    store.memory
      .listMemories("hu")
      .some((entry) => entry.factKey === "pref.review-chat" && entry.body === "用户喜欢新茶"),
  );
  assert.equal(store.memory.listMemories("cheng").length, 0);

  const messages = store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages.every((message) => message.role === "user"), true);
});

test("POL-CHAT-005 删除来源后重启不再拼接旧聊天片段", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const firstText = "我喜欢无糖咖啡，请记住。";
  const firstReply = "第一次回复。";
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: firstReply,
      memoryCandidates: [
        {
          factKey: "pref.exclude",
          body: "用户喜欢无糖咖啡",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢无糖咖啡",
        },
      ],
    }),
  );
  const first = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: firstText,
  });
  assert.equal(first.status, "completed");
  assert.equal(first.memoryApplied, 1);
  store.memory.forget({
    characterId: "rin",
    factKey: "pref.exclude",
    scope: "all",
  });

  ctx.reopen();
  server.enqueue(({ res }) => sendReply(res, "第二次回复。"));
  const second = await ctx.store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "后来呢？",
  });
  assert.equal(second.status, "completed");
  const secondBody = JSON.stringify(server.requests[1]);
  assert.equal(secondBody.includes(firstText), false);
  assert.equal(secondBody.includes(firstReply), false);
  assert.equal(secondBody.includes("无糖咖啡"), false);
  assert.ok(secondBody.includes("后来呢？"));

  const messages = ctx.store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 4);
  assert.equal(
    ctx.store.memory.searchMemories({ characterId: "rin", query: "无糖咖啡" }).length,
    0,
  );
});

test("POL-CHAT-003 重试前核验来源，来源排除后不外发旧事实", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  server.enqueue(({ res }) => sendReply(res, "服务失败", 500));
  const first = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "我喜欢冰咖啡",
    requestId: "source-retry",
  });
  assert.equal(first.status, "failed");
  const userMessage = store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages[0];
  store.memory.remember({
    characterId: "rin",
    factKey: "pref.ice",
    body: "用户喜欢冰咖啡",
    kind: "preference",
    sourceId: userMessage.sourceId,
  });
  store.memory.forget({
    characterId: "rin",
    factKey: "pref.ice",
    scope: "self",
  });

  const before = server.requests.length;
  const retried = await store.chat.retryRequest({
    characterId: "rin",
    requestId: "source-retry",
  });
  assert.equal(retried.status, "stale");
  assert.equal(retried.errorCode, "SOURCE_EXCLUDED");
  assert.equal(server.requests.length, before);
  assert.equal(store.memory.listMemories("rin").length, 0);
  assert.equal(
    store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.every((message) => message.role === "user"),
    true,
  );
});

test("POL-CHAT-003 助手写入失败时记忆与聊天原子回滚", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const db = new DatabaseSync(store.dbPath);
  db.exec(`
    CREATE TRIGGER fail_assistant_insert BEFORE INSERT ON chat_messages
    WHEN NEW.role = 'assistant'
    BEGIN SELECT RAISE(ABORT, 'injected assistant failure'); END;
  `);
  db.close();

  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "本来要保存。",
      memoryCandidates: [
        {
          factKey: "pref.atomic",
          body: "用户喜欢温茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
      ],
    }),
  );
  const failed = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "我喜欢温茶，请记住。",
    requestId: "atomic-1",
  });
  assert.equal(failed.status, "failed");
  assert.equal(countRows(store.dbPath, "memory_entries"), 0);
  assert.equal(countRows(store.dbPath, "memory_extraction_batches"), 0);
  assert.equal(
    countRows(store.dbPath, "chat_messages"),
    1,
  );
  assert.equal(store.chat.getRequest({ characterId: "rin", requestId: "atomic-1" }).status, "failed");
  assert.equal(store.memory.getContextVersion("rin"), 0);

  const cleanup = new DatabaseSync(store.dbPath);
  cleanup.exec("DROP TRIGGER fail_assistant_insert");
  cleanup.close();
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "这次保存。",
      memoryCandidates: [
        {
          factKey: "pref.atomic",
          body: "用户喜欢温茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
      ],
    }),
  );
  const retried = await store.chat.retryRequest({
    characterId: "rin",
    requestId: "atomic-1",
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.memoryApplied, 1);
  assert.equal(countRows(store.dbPath, "memory_entries"), 1);
  assert.equal(countRows(store.dbPath, "chat_messages"), 2);
});

test("POL-CHAT-003 完成时间使用真实时钟，发起时间不变", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  server.enqueue(async ({ res }) => {
    await gate;
    sendEnvelope(res, {
      reply: "完成回复",
      memoryCandidates: [
        {
          factKey: "pref.clock",
          body: "用户喜欢温茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
      ],
    });
  });
  const pending = store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "我喜欢温茶",
    requestId: "clock-1",
  });
  await waitFor(() => server.requests.length === 1);
  ctx.advance(5000);
  release();
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 1);

  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    const request = db
      .prepare("SELECT created_at, completed_at FROM chat_requests WHERE id = ?")
      .get("clock-1");
    const memory = db
      .prepare("SELECT created_at FROM memory_entries WHERE fact_key = ?")
      .get("pref.clock");
    const assistant = db
      .prepare("SELECT created_at FROM chat_messages WHERE role = 'assistant'")
      .get();
    assert.ok(request.completed_at - request.created_at >= 5000);
    assert.equal(memory.created_at, request.completed_at);
    assert.equal(assistant.created_at, request.completed_at);
  } finally {
    db.close();
  }
});

test("POL-CHAT-001 同一 requestId 只重放完全相同输入", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const firstConversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const secondConversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  const first = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: firstConversation.id,
    text: "第一句",
    requestId: "idem-1",
  });
  assert.equal(first.status, "completed");
  assert.equal(server.requests.length, 1);

  const replay = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: firstConversation.id,
    text: "第一句",
    requestId: "idem-1",
  });
  assert.equal(replay.status, "completed");
  assert.equal(server.requests.length, 1);

  await assert.rejects(
    () =>
      store.chat.sendMessage({
        characterId: "rin",
        conversationId: firstConversation.id,
        text: "不同的第二句",
        requestId: "idem-1",
      }),
    (error) => error.code === "REQUEST_CONFLICT",
  );
  await assert.rejects(
    () =>
      store.chat.sendMessage({
        characterId: "rin",
        conversationId: secondConversation.id,
        text: "第一句",
        requestId: "idem-1",
      }),
    (error) => error.code === "REQUEST_CONFLICT",
  );
  assert.equal(server.requests.length, 1);
});

test("POL-CHAT-002 证据必须覆盖事实，宽泛引用不写入", async (t) => {
  const ctx = await setupChatTest(t);
  const { store, server } = ctx;
  const conversation = store.chat.openConversation({ characterId: "rin" }).conversation;
  server.enqueue(({ res }) =>
    sendEnvelope(res, {
      reply: "好的。",
      memoryCandidates: [
        {
          factKey: "pref.broad",
          body: "用户喜欢冰茶",
          kind: "preference",
          trust: "stated",
          evidence: "我",
        },
        {
          factKey: "pref.unrelated",
          body: "用户喜欢咖啡",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
        {
          factKey: "pref.opposite",
          body: "用户不喜欢温茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
        {
          factKey: "pref.reverse-opposite",
          body: "用户喜欢冰茶",
          kind: "preference",
          trust: "stated",
          evidence: "不喜欢冰茶",
        },
        {
          factKey: "pref.tea",
          body: "用户喜欢温茶",
          kind: "preference",
          trust: "stated",
          evidence: "我喜欢温茶",
        },
      ],
    }),
  );
  const result = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "我喜欢温茶，也不喜欢冰茶，请记住。",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 1);
  const memories = store.memory.listMemories("rin");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].factKey, "pref.tea");
  assert.equal(memories[0].body, "我喜欢温茶");
  assert.equal(memories[0].trust, "stated");
});

test("POL-CHAT-001 同毫秒消息按插入顺序而非 UUID 排序", async (t) => {
  const ctx = await setupChatTest(t, { fixedClock: true });
  const originalRandomUUID = crypto.randomUUID;
  const ids = [
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "00000000-0000-4000-8000-000000000001",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "11111111-1111-4111-8111-111111111111",
  ];
  crypto.randomUUID = () => ids.shift() ?? originalRandomUUID();
  try {
    const conversation = ctx.store.chat.openConversation({ characterId: "rin" }).conversation;
    const first = await ctx.store.chat.sendMessage({
      characterId: "rin",
      conversationId: conversation.id,
      text: "第一问",
      requestId: "order-1",
    });
    const second = await ctx.store.chat.sendMessage({
      characterId: "rin",
      conversationId: conversation.id,
      text: "第二问",
      requestId: "order-2",
    });
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(ctx.server.requests.length, 2);

    const history = ctx.store.chat.getConversation({
      characterId: "rin",
      conversationId: conversation.id,
    }).messages;
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.deepEqual(
      history.map((message) => message.content),
      ["第一问", "收到。", "第二问", "收到。"],
    );
    const contextMessages = ctx.server.requests[1].messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => message.content);
    assert.deepEqual(contextMessages, ["第一问", "收到。", "第二问"]);

    ctx.reopen();
    const reopened = ctx.store.chat.getConversation({
      characterId: "rin",
      conversationId: conversation.id,
    }).messages;
    assert.deepEqual(
      reopened.map((message) => message.content),
      ["第一问", "收到。", "第二问", "收到。"],
    );
  } finally {
    crypto.randomUUID = originalRandomUUID;
  }
});

test("POL-CHAT-001 启动恢复遗留 pending，普通重开不误伤", async (t) => {
  const ctx = await setupChatTest(t);
  const conversation = ctx.store.chat.openConversation({ characterId: "rin" }).conversation;
  let release;
  t.after(() => release?.());
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ctx.server.enqueue(async ({ res }) => {
    await gate;
    sendReply(res, "旧回复");
  });
  const pending = ctx.store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "第一句",
    requestId: "recover-1",
  });
  pending.catch(() => {});
  await waitFor(() => ctx.server.requests.length === 1);
  ctx.store.close();

  ctx.reopen();
  assert.equal(
    ctx.store.chat.getRequest({ characterId: "rin", requestId: "recover-1" }).status,
    "pending",
  );
  assert.equal(ctx.server.requests.length, 1);

  ctx.reopen({ recoverInterrupted: true });
  const recovered = ctx.store.chat.getRequest({
    characterId: "rin",
    requestId: "recover-1",
  });
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.errorCode, "INTERRUPTED");
  assert.equal(recovered.retryable, true);
  assert.equal(ctx.server.requests.length, 1);
  const recoveredMessages = ctx.store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(recoveredMessages.length, 1);
  assert.equal(recoveredMessages[0].role, "user");
  assert.equal(ctx.store.memory.listMemories("rin").length, 0);

  const replayed = await ctx.store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "第一句",
    requestId: "recover-1",
  });
  assert.equal(replayed.status, "failed");
  assert.equal(replayed.errorCode, "INTERRUPTED");
  assert.equal(ctx.server.requests.length, 1);

  ctx.server.enqueue(({ res }) => sendReply(res, "恢复成功。"));
  const retried = await ctx.store.chat.retryRequest({
    characterId: "rin",
    requestId: "recover-1",
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.reply, "恢复成功。");
  assert.equal(ctx.server.requests.length, 2);
  assert.equal(
    ctx.store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.length,
    2,
  );
  const repeated = await ctx.store.chat.retryRequest({
    characterId: "rin",
    requestId: "recover-1",
  });
  assert.equal(repeated.status, "completed");
  assert.equal(ctx.server.requests.length, 2);

  release();
  await pending.catch(() => {});
  assert.equal(ctx.server.requests.length, 2);
  assert.equal(
    ctx.store.chat.getConversation({ characterId: "rin", conversationId: conversation.id })
      .messages.length,
    2,
  );
  assert.equal(ctx.store.memory.listMemories("rin").length, 0);
});

test("POL-CHAT-003 dispose 取消在途请求后可安全关闭数据库", async (t) => {
  const ctx = await setupChatTest(t);
  const conversation = ctx.store.chat.openConversation({ characterId: "rin" }).conversation;
  let release;
  t.after(() => release?.());
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ctx.server.enqueue(async ({ res }) => {
    await gate;
    sendReply(res, "迟到的退出回复");
  });
  const pending = ctx.store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "退出前",
    requestId: "dispose-1",
  });
  await waitFor(() => ctx.server.requests.length === 1);
  const disposed = await ctx.store.chat.dispose();
  assert.equal(disposed.cancelled, 1);
  ctx.store.close();
  release();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reply, null);

  ctx.reopen();
  assert.equal(
    ctx.store.chat.getRequest({ characterId: "rin", requestId: "dispose-1" }).status,
    "cancelled",
  );
  const messages = ctx.store.chat.getConversation({
    characterId: "rin",
    conversationId: conversation.id,
  }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(ctx.store.memory.listMemories("rin").length, 0);
  assert.equal(ctx.server.requests.length, 1);
});

test("POL-CHAT-001 旧消息表补 seq 后保持原插入顺序", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-legacy-"));
  const bootstrap = createStore(dir);
  bootstrap.close();
  const dbPath = path.join(dir, "bayper.sqlite3");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    DROP TABLE chat_requests;
    DROP TABLE chat_messages;
    DROP TABLE chat_conversations;
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO relationships (character_id, accepted_at) VALUES ('rin', '2026-01-01');
    INSERT INTO chat_conversations (id, character_id, created_at, updated_at)
      VALUES ('conv-legacy', 'rin', 1000, 1000);
    INSERT INTO chat_messages
      (id, conversation_id, character_id, role, content, source_id, created_at)
      VALUES
      ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'conv-legacy', 'rin', 'user', '旧问题', 'old-user', 1000),
      ('00000000-0000-4000-8000-000000000001', 'conv-legacy', 'rin', 'assistant', '旧回复', 'old-user', 1000);
  `);
  db.close();

  const store = createStore(dir);
  t.after(() => {
    try {
      store.close();
    } catch {
      // 已关闭时继续清理。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const messages = store.chat.getConversation({
    characterId: "rin",
    conversationId: "conv-legacy",
  }).messages;
  assert.deepEqual(
    messages.map((message) => message.content),
    ["旧问题", "旧回复"],
  );
  assert.deepEqual(
    messages.map((message) => message.seq),
    [1, 2],
  );
});
