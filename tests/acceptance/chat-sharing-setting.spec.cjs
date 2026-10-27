/* S03k 聊天中的全局自动分享设置领域验收：真实 SQLite + 真实 store/chat/memory。
   不启动 GUI、不连接真实模型；fetch 与凭据读取都只是可计数的受控替身。
   覆盖 POL-SHARESETTING-001～004；正式 Electron 全链见 chat-sharing-setting-ui.spec.cjs。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { LOCAL_SHARING_SETTING_ERROR } = require("../../app/chat.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);
const AUTO_SHARE_KEY = "memory_auto_share_enabled";
const CREDENTIALS = {
  baseUrl: "https://example.invalid/v1",
  modelName: "fixture-sharing-setting",
  apiKey: "sk-fixture-sharing-setting",
};

function modelEnvelope(reply) {
  return JSON.stringify({ reply, memoryCandidates: [] });
}

function makeContext(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-sharing-setting-"));
  const counts = { fetch: 0, credentials: 0 };
  let tick = START;
  const fetchImpl = async () => {
    counts.fetch += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: modelEnvelope("模型回复。") } }],
      }),
    };
  };
  const getCredentials = () => {
    counts.credentials += 1;
    return CREDENTIALS;
  };
  const open = () =>
    createStore(dir, { now: () => tick++, chat: { fetchImpl, getCredentials } });
  let store = open();

  const ctx = {
    dir,
    counts,
    get store() {
      return store;
    },
    resetCounts() {
      counts.fetch = 0;
      counts.credentials = 0;
    },
    reopen() {
      store.close();
      store = open();
    },
    stateValue() {
      return (
        store.db
          .prepare("SELECT value FROM app_state WHERE key = ?")
          .get(AUTO_SHARE_KEY)?.value ?? null
      );
    },
    count(table) {
      return store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    },
    snapshot() {
      return {
        memories: store.db
          .prepare("SELECT id, character_id, fact_key, body, version FROM memory_entries ORDER BY id")
          .all(),
        fts: ctx.count("memory_fts"),
        shareControls: ctx.count("memory_share_controls"),
        stats: store.db
          .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
          .all(),
        relationships: store.db
          .prepare("SELECT character_id, accepted_at FROM relationships ORDER BY character_id")
          .all(),
        roster: store.db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
      };
    },
  };

  seedRelationships(store, ["rin", "hu", "cheng"]);
  t.after(() => {
    try {
      store.close();
    } catch {
      // 测试可能已主动关闭连接。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function seedRelationships(store, characterIds) {
  const insertRelationship = store.db.prepare(
    "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
  );
  const insertStats = store.db.prepare(
    "INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)",
  );
  for (const characterId of characterIds) {
    insertRelationship.run(characterId, "2026-01-01T00:00:00.000Z");
    insertStats.run(characterId);
  }
}

function remember(store, input) {
  return store.memory.remember({
    characterId: "rin",
    kind: "preference",
    sourceId: `src-${input.factKey}`,
    ...input,
  });
}

function openConversation(store, characterId = "rin") {
  return store.chat.openConversation({ characterId }).conversation;
}

function messagesOf(store, conversationId, characterId = "rin") {
  return store.chat.getConversation({ characterId, conversationId }).messages;
}

function requestOf(store, conversationId, characterId = "rin", requestId) {
  return store.chat.getRequest({ characterId, requestId });
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test("POL-SHARESETTING-001 聊天关闭写库一次确认、零模型调用且同request幂等", async (t) => {
  const ctx = makeContext(t);
  const { store } = ctx;
  remember(store, { factKey: "pref.tea", body: "用户喜欢热茶" });
  remember(store, { factKey: "exp.hike", body: "用户周末去爬山", kind: "experience" });
  const before = ctx.snapshot();
  const contextVersion = store.memory.getContextVersion("rin");
  const conversation = openConversation(store);
  const text = "以后不要自动互相讲我的事。请关闭角色之间的自动分享。";
  const requestId = "req-share-off";
  ctx.resetCounts();

  const result = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text,
    requestId,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.memoryApplied, 0);
  assert.ok(result.reply.includes("已经关闭"));
  // 确认语保持“用户明确要求当前角色转告”的授权含义，不改成角色自发转告。
  assert.ok(result.reply.includes("当前角色转告"));
  assert.equal(ctx.stateValue(), "false");
  assert.equal(store.memory.isAutoShareEnabled(), false);
  // 本地完成不读取凭据、不发网络请求。
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
  assert.equal(store.memory.getContextVersion("rin"), contextVersion);

  const after = messagesOf(store, conversation.id);
  assert.deepEqual(
    after.map((message) => [message.role, message.content]),
    [
      ["user", text],
      ["assistant", result.reply],
    ],
  );
  const request = requestOf(store, conversation.id, "rin", requestId);
  assert.equal(request.status, "completed");
  assert.equal(request.memoryApplied, 0);
  // 命令文本不成为记忆；名单、数值、关系、FTS 与分享控制都不变。
  assert.deepEqual(ctx.snapshot(), before);

  // 同 requestId 与同一原话只返回既有完成结果，不重复回复或再写一次。
  const replay = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text,
    requestId,
  });
  assert.deepEqual(replay, result);
  assert.deepEqual(messagesOf(store, conversation.id), after);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);

  // 另一个单独关闭表达仍由本地处理，确认次数按请求各一次。
  const second = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "请停止自动分享。",
    requestId: "req-share-off-2",
  });
  assert.equal(second.status, "completed");
  assert.equal(second.memoryApplied, 0);
  assert.equal(ctx.stateValue(), "false");
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
  assert.equal(messagesOf(store, conversation.id).length, 4);

  // 重启后开关与聊天记录保持；没有额外分享或记忆写入。
  ctx.reopen();
  assert.equal(ctx.store.memory.isAutoShareEnabled(), false);
  assert.equal(ctx.stateValue(), "false");
  assert.equal(messagesOf(ctx.store, conversation.id).length, 4);
});

test("POL-SHARESETTING-002 恢复只重开自动分享，逐事实限制与既有内容不变", async (t) => {
  const ctx = makeContext(t);
  const { store } = ctx;
  const tea = remember(store, { factKey: "pref.tea", body: "用户喜欢热茶" });
  const secret = remember(store, {
    factKey: "secret.plan",
    body: "用户准备了惊喜",
    kind: "detail",
  });
  const removable = remember(store, {
    factKey: "detail.old",
    body: "用户以前提过的一件小事",
    kind: "detail",
  });
  store.memory.forget({
    characterId: "rin",
    entryId: removable.entry.id,
    expectedVersion: removable.entry.version,
    scope: "self",
  });
  const conversation = openConversation(store);
  ctx.resetCounts();
  const closed = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "关闭角色之间的自动分享。",
    requestId: "req-close-before-enable",
  });
  assert.equal(closed.status, "completed");
  assert.equal(ctx.stateValue(), "false");
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);

  store.memory.restrictSharing({
    characterId: "rin",
    entryId: secret.entry.id,
    expectedVersion: secret.entry.version,
  });
  const memoriesBefore = store.memory.listMemories("rin");
  const controlsBefore = {
    share: ctx.count("memory_share_controls"),
    forget: ctx.count("memory_forget_controls"),
    source: ctx.count("memory_source_controls"),
  };

  const restored = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "恢复角色之间的自动分享。",
    requestId: "req-share-on",
  });
  assert.equal(restored.status, "completed");
  assert.equal(restored.memoryApplied, 0);
  assert.equal(ctx.stateValue(), "true");
  assert.equal(store.memory.isAutoShareEnabled(), true);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
  // 恢复确认说明只回到窄范围，不声称全员开放或清除旧限制。
  assert.ok(restored.reply.includes("窄范围") || restored.reply.includes("主题见闻"));
  assert.ok(restored.reply.includes("逐条限制"));
  assert.deepEqual(store.memory.listMemories("rin"), memoriesBefore);
  assert.deepEqual(
    {
      share: ctx.count("memory_share_controls"),
      forget: ctx.count("memory_forget_controls"),
      source: ctx.count("memory_source_controls"),
    },
    controlsBefore,
  );
  // 恢复只重开自动分享；已遗忘的事实不会因重新开启自动分享而回流。
  assert.equal(store.memory.listMemories("rin").some((entry) => entry.factKey === "detail.old"), false);
  const relearn = store.memory.remember({
    characterId: "rin",
    factKey: "detail.old",
    body: "旧来源之外的新说法",
    kind: "detail",
    sourceId: "src-detail-relearn",
  });
  assert.equal(relearn.created, false);
  assert.equal(relearn.blocked, "forget");

  // 逐事实禁分享仍然拒绝 share 与 relay。
  assert.throws(
    () =>
      store.memory.share({
        fromCharacterId: "rin",
        toCharacterId: "hu",
        entryIds: [secret.entry.id],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () =>
      store.memory.relay({
        fromCharacterId: "rin",
        toCharacterId: "cheng",
        entries: [{ entryId: secret.entry.id, expectedVersion: secret.entry.version }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  // 未受限事实仍走原分享路径；恢复不会额外自动分享其他内容。
  const shared = store.memory.share({
    fromCharacterId: "rin",
    toCharacterId: "hu",
    entryIds: [tea.entry.id],
  });
  assert.equal(shared.shared[0].alreadyHeld, false);
  assert.equal(store.memory.listMemories("cheng").length, 0);
});

test("POL-SHARESETTING-003 问句/引用/假设/否定/过去/混合输入不执行，其他自动设置与单事实限制仍走原路径", async (t) => {
  const ctx = makeContext(t);
  const { store } = ctx;
  remember(store, { factKey: "pref.coffee", body: "用户喜欢热咖啡" });
  const before = ctx.snapshot();
  const conversation = openConversation(store);
  const inputs = [
    "能关闭自动分享吗？",
    "她说“关闭自动分享”。",
    "她说关闭自动分享。",
    "如果关闭自动分享会怎样？",
    "不要关闭自动分享。",
    "关闭自动分享，恢复自动分享。",
    "关闭自动分享，然后告诉我今天天气。",
    "明天再关闭自动分享。",
    "我昨天关闭了自动分享。",
    // 引号不能删除后再拼成命令；含引用的完整句只保守澄清。
    "关闭自动分享“是错误的”。",
    "请关闭角色之间的自动分享，因为“太吵了”。",
    // 没有明确“自动”的范围，不能静默当成自动分享设置。
    "关闭角色之间的转告。",
  ];

  for (const [index, text] of inputs.entries()) {
    ctx.resetCounts();
    const result = await store.chat.sendMessage({
      characterId: "rin",
      conversationId: conversation.id,
      text,
      requestId: `req-negative-${index}`,
    });
    assert.equal(result.status, "completed", text);
    assert.equal(result.memoryApplied, 0, text);
    assert.equal(ctx.counts.fetch, 0, text);
    assert.equal(ctx.counts.credentials, 0, text);
    assert.equal(ctx.stateValue(), null, text);
    assert.equal(store.memory.isAutoShareEnabled(), true, text);
    assert.ok(result.reply.includes("没有更改"), `应本地说明未更改：${text} -> ${result.reply}`);
    assert.equal(result.reply.includes("已经关闭"), false, text);
    assert.equal(result.reply.includes("已经恢复"), false, text);
  }
  // 这些输入不产生记忆，也不改名单/数值/FTS/分享控制。
  assert.deepEqual(ctx.snapshot(), before);

  // 其他“自动设置”没有分享语义，不能被本地分享澄清接管；继续走模型路径。
  const otherAutomaticSettings = [
    "关闭自动更新会有什么影响？",
    "请打开自动保存",
  ];
  for (const [index, text] of otherAutomaticSettings.entries()) {
    ctx.resetCounts();
    const result = await store.chat.sendMessage({
      characterId: "rin",
      conversationId: conversation.id,
      text,
      requestId: `req-other-auto-${index}`,
    });
    assert.equal(result.status, "completed", text);
    assert.equal(result.reply, "模型回复。", text);
    assert.equal(ctx.counts.fetch, 1, text);
    assert.equal(ctx.counts.credentials, 1, text);
    assert.equal(ctx.stateValue(), null, text);
    assert.equal(store.memory.isAutoShareEnabled(), true, text);
    assert.deepEqual(ctx.snapshot(), before, text);
  }

  // “这件事别分享”不能被全局设置接管，继续走既有模型与记忆操作路径。
  ctx.resetCounts();
  const singleFact = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "这件事别分享。",
    requestId: "req-single-fact",
  });
  assert.equal(singleFact.status, "completed");
  assert.equal(ctx.counts.fetch, 1);
  assert.equal(ctx.counts.credentials, 1);
  assert.equal(ctx.stateValue(), null);
  assert.equal(store.memory.isAutoShareEnabled(), true);
  assert.deepEqual(ctx.snapshot(), before);

  // 普通闲聊同样不被全局设置误接管。
  ctx.resetCounts();
  const chitchat = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text: "今天有点累。",
    requestId: "req-chitchat",
  });
  assert.equal(chitchat.status, "completed");
  assert.equal(chitchat.reply, "模型回复。");
  assert.equal(ctx.counts.fetch, 1);
  assert.equal(ctx.counts.credentials, 1);
  assert.equal(ctx.stateValue(), null);
  assert.deepEqual(ctx.snapshot(), before);
});

test("POL-SHARESETTING-004 保存失败同事务回滚，显式重试本地成功且不重复回复", async (t) => {
  const ctx = makeContext(t);
  const { store } = ctx;
  const conversation = openConversation(store);
  const requestId = "req-local-failure";
  const text = "关闭角色之间的自动分享。";
  ctx.resetCounts();

  // 真实 SQLite 触发器让开关写入失败；用户消息/请求已先行记录，便于显式重试。
  store.db.exec(`
    CREATE TRIGGER fail_auto_share BEFORE INSERT ON app_state
    WHEN NEW.key = '${AUTO_SHARE_KEY}'
    BEGIN SELECT RAISE(ABORT, 'injected auto share failure'); END;
  `);
  const failed = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation.id,
    text,
    requestId,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reply, null);
  assert.equal(failed.errorCode, LOCAL_SHARING_SETTING_ERROR);
  assert.equal(failed.retryable, true);
  assert.equal(ctx.stateValue(), null);
  assert.equal(store.memory.isAutoShareEnabled(), true);
  assert.equal(requestOf(store, conversation.id, "rin", requestId).status, "failed");
  assert.equal(
    requestOf(store, conversation.id, "rin", requestId).errorCode,
    LOCAL_SHARING_SETTING_ERROR,
  );
  let messages = messagesOf(store, conversation.id);
  assert.deepEqual(messages.map((message) => message.role), ["user"]);
  assert.equal(messages.some((message) => message.content.includes("已经关闭")), false);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);

  store.db.exec("DROP TRIGGER fail_auto_share");
  ctx.resetCounts();
  const retried = await store.chat.retryRequest({ characterId: "rin", requestId });
  assert.equal(retried.status, "completed");
  assert.equal(retried.memoryApplied, 0);
  assert.equal(ctx.stateValue(), "false");
  assert.equal(store.memory.isAutoShareEnabled(), false);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
  messages = messagesOf(store, conversation.id);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.ok(messages[1].content.includes("已经关闭"));

  // 确认消息写入失败时，开关写入与确认回复一起回滚，不留下半完成状态。
  store.memory.setAutoShareEnabled({ enabled: true });
  const conversation2 = openConversation(store);
  const requestId2 = "req-reply-failure";
  store.db.exec(`
    CREATE TRIGGER fail_assistant BEFORE INSERT ON chat_messages
    WHEN NEW.role = 'assistant'
    BEGIN SELECT RAISE(ABORT, 'injected reply failure'); END;
  `);
  const failedReply = await store.chat.sendMessage({
    characterId: "rin",
    conversationId: conversation2.id,
    text,
    requestId: requestId2,
  });
  assert.equal(failedReply.status, "failed");
  assert.equal(failedReply.errorCode, LOCAL_SHARING_SETTING_ERROR);
  assert.equal(failedReply.retryable, true);
  assert.equal(ctx.stateValue(), "true");
  assert.equal(store.memory.isAutoShareEnabled(), true);
  messages = messagesOf(store, conversation2.id);
  assert.deepEqual(messages.map((message) => message.role), ["user"]);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);

  store.db.exec("DROP TRIGGER fail_assistant");
  ctx.resetCounts();
  const retriedReply = await store.chat.retryRequest({ characterId: "rin", requestId: requestId2 });
  assert.equal(retriedReply.status, "completed");
  assert.equal(ctx.stateValue(), "false");
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
  messages = messagesOf(store, conversation2.id);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);

  // 已完成请求再次重试不再变更设置或追加回复。
  const afterRetry = await store.chat.retryRequest({ characterId: "rin", requestId: requestId2 });
  assert.equal(afterRetry.status, "completed");
  assert.equal(messagesOf(store, conversation2.id).length, 2);
  assert.equal(ctx.stateValue(), "false");

  // 同 requestId 换成不同原话属于冲突，不执行任何一侧。
  await assert.rejects(
    () =>
      store.chat.sendMessage({
        characterId: "rin",
        conversationId: conversation2.id,
        text: "恢复角色之间的自动分享。",
        requestId: requestId2,
      }),
    hasCode("REQUEST_CONFLICT"),
  );
  assert.equal(ctx.stateValue(), "false");
  assert.equal(messagesOf(store, conversation2.id).length, 2);

  // 已取消的请求同样不再触达开关。
  store.db
    .prepare("UPDATE chat_requests SET status = 'cancelled' WHERE id = ?")
    .run(requestId2);
  const cancelledRetry = await store.chat.retryRequest({
    characterId: "rin",
    requestId: requestId2,
  });
  assert.equal(cancelledRetry.status, "cancelled");
  assert.equal(ctx.stateValue(), "false");
  assert.equal(messagesOf(store, conversation2.id).length, 2);
  assert.equal(ctx.counts.fetch, 0);
  assert.equal(ctx.counts.credentials, 0);
});
