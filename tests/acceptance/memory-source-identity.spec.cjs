/* S03l 来源身份保护验收：真实 SQLite、正式 store/chat/memory/SQLite 与来源
   上下文入口，只有聊天模型 HTTP 由本机 fixture 构造。覆盖 POL-SOURCE-ID-001～
   004；独立来源同文不再复用身份，显式 share/relay 与 associateFacts 才建立
   关联。不启动 GUI，不调用真实模型，也不证明关系语义判断。 */
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
const MODEL_NAME = "fixture-source-identity";
const API_KEY = "sk-fixture-source-identity";
const EXCERPT = "她喜欢蓝色";
const SISTER_TEXT = "我姐姐下个月要搬去杭州，她说她喜欢蓝色。";
const SISTER_EQUIVALENT_TEXT = "我姐姐说她喜欢蓝色，下个月要搬去杭州。";
const COLLEAGUE_TEXT = "我同事小林说她喜欢蓝色。";

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

const countRows = (dbPath, table) =>
  withDatabase(dbPath, (db) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
const readOne = (dbPath, sql, ...params) =>
  withDatabase(dbPath, (db) => db.prepare(sql).get(...params));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-identity-"));
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
    get store() {
      return store;
    },
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
const identityOf = (dbPath, characterId, factKey) =>
  readOne(
    dbPath,
    `SELECT fact_identity_id FROM memory_entries
     WHERE character_id = ? AND fact_key = ?`,
    characterId,
    factKey,
  )?.fact_identity_id ?? null;
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const snapshot = (store, entry) =>
  store.memorySourceContext.resolve({
    characterId: entry.characterId,
    entryId: entry.id,
    expectedVersion: entry.version,
  });

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

/* 旧记录：没有身份列值，正文直接构成；真实派生关系单独写入。 */
function insertLegacyEntry(db, entry) {
  db.prepare(`
    INSERT INTO memory_entries (
      id, character_id, fact_key, fact_identity_id, origin_character_id,
      derived_from_entry_id, kind, body, trust, source_kind, importance, expires_at,
      source_id, source_version, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stated', 'user', 60, NULL, ?, 1, 1, ?, ?)
  `).run(
    entry.id,
    entry.characterId,
    entry.factKey,
    entry.factIdentityId ?? null,
    entry.originCharacterId ?? entry.characterId,
    entry.derivedFromEntryId ?? null,
    entry.kind ?? "preference",
    entry.body,
    entry.sourceId,
    START,
    START,
  );
}

function insertLegacyDerivation(db, { entryId, parentEntryId, originCharacterId, narratorCharacterId }) {
  db.prepare(`
    INSERT INTO memory_derivations (
      entry_id, parent_entry_id, origin_character_id, narrator_character_id,
      source_id, source_version, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
  `).run(entryId, parentEntryId, originCharacterId, narratorCharacterId, START);
}

test("POL-SOURCE-ID-001 同角色独立 chat 同片段各自建条目与身份，管理一个不影响另一个", async (t) => {
  const ctx = await setupContext(t, ["a"]);
  const sisterConversation = openConversation(ctx.store);
  const colleagueConversation = openConversation(ctx.store);
  await turn(ctx, sisterConversation, SISTER_TEXT, [
    fact("pref.sisterColor", EXCERPT, "preference"),
  ]);
  await turn(ctx, colleagueConversation, COLLEAGUE_TEXT, [
    fact("pref.colleagueColor", EXCERPT, "preference"),
  ]);

  const sister = entryOf(ctx.store, "a", "pref.sisterColor");
  const colleague = entryOf(ctx.store, "a", "pref.colleagueColor");
  assert.ok(sister, "姐姐来源必须创建独立条目");
  assert.ok(colleague, "同事来源必须创建独立条目，不能复用另一个键的首次条目");
  const sisterIdentity = identityOf(ctx.store.dbPath, "a", "pref.sisterColor");
  const colleagueIdentity = identityOf(ctx.store.dbPath, "a", "pref.colleagueColor");
  assert.ok(sisterIdentity && colleagueIdentity);
  assert.notEqual(sisterIdentity, colleagueIdentity);
  assert.notEqual(sister.sourceId, colleague.sourceId);

  const sisterBefore = snapshot(ctx.store, sister);
  const colleagueBefore = snapshot(ctx.store, colleague);
  assert.equal(sisterBefore.status, "ok");
  assert.equal(colleagueBefore.status, "ok");
  assert.deepEqual(
    [sisterBefore.sourceMessage.content, sisterBefore.excerpt],
    [SISTER_TEXT, EXCERPT],
  );
  assert.deepEqual(
    [colleagueBefore.sourceMessage.content, colleagueBefore.excerpt],
    [COLLEAGUE_TEXT, EXCERPT],
  );
  assert.deepEqual([sisterBefore.messages, colleagueBefore.messages], [[], []]);
  assert.notEqual(sisterBefore.sourceMessage.id, colleagueBefore.sourceMessage.id);

  const colleagueSourceId = colleague.sourceId;
  ctx.store.memory.correct({
    characterId: "a",
    entryId: sister.id,
    expectedVersion: 1,
    body: "姐姐说她更喜欢蓝色",
    nowMs: ctx.nowMs(),
  });
  let colleagueHeld = entryOf(ctx.store, "a", "pref.colleagueColor");
  assert.equal(colleagueHeld.id, colleague.id);
  assert.equal(colleagueHeld.body, EXCERPT);
  assert.equal(colleagueHeld.version, 1);
  assert.equal(colleagueHeld.sourceId, colleagueSourceId);
  assert.equal(identityOf(ctx.store.dbPath, "a", "pref.colleagueColor"), colleagueIdentity);

  ctx.store.memory.forget({
    characterId: "a",
    entryId: sister.id,
    expectedVersion: 2,
    nowMs: ctx.nowMs(),
  });
  assert.equal(entryOf(ctx.store, "a", "pref.sisterColor"), null);
  colleagueHeld = entryOf(ctx.store, "a", "pref.colleagueColor");
  assert.equal(colleagueHeld.body, EXCERPT);
  assert.equal(colleagueHeld.version, 1);
  assert.equal(colleagueHeld.sourceId, colleagueSourceId);

  ctx.reopen();
  assert.equal(entryOf(ctx.store, "a", "pref.sisterColor"), null);
  const colleagueAfter = entryOf(ctx.store, "a", "pref.colleagueColor");
  assert.equal(colleagueAfter.id, colleague.id);
  assert.equal(colleagueAfter.body, EXCERPT);
  assert.equal(colleagueAfter.version, 1);
  assert.equal(colleagueAfter.sourceId, colleagueSourceId);
  assert.equal(identityOf(ctx.store.dbPath, "a", "pref.colleagueColor"), colleagueIdentity);
  const reopened = snapshot(ctx.store, colleagueAfter);
  assert.equal(reopened.status, "ok");
  assert.equal(reopened.sourceMessage.content, COLLEAGUE_TEXT);
  assert.equal(ctx.store.memorySourceContext.isCurrent(reopened), true);
  assert.equal(ctx.store.memory.searchMemories({ characterId: "a", query: "蓝色" }).length, 1);
});

test("POL-SOURCE-ID-002 两角色独立 chat 同片段未显式关联，管理 A 不改 B", async (t) => {
  const ctx = await setupContext(t, ["a", "b", "c"]);
  const aConversation = openConversation(ctx.store, "a");
  const bConversation = openConversation(ctx.store, "b");
  await turn(ctx, aConversation, SISTER_TEXT, [
    fact("pref.a.sister", EXCERPT, "preference"),
  ]);
  await turn(ctx, bConversation, COLLEAGUE_TEXT, [
    fact("pref.b.colleague", EXCERPT, "preference"),
  ], "b");

  const aEntry = entryOf(ctx.store, "a", "pref.a.sister");
  const bEntry = entryOf(ctx.store, "b", "pref.b.colleague");
  assert.ok(aEntry, "A 的独立 chat 来源必须创建条目");
  assert.ok(bEntry, "B 的独立 chat 来源必须创建条目");
  const aIdentity = identityOf(ctx.store.dbPath, "a", "pref.a.sister");
  const bIdentity = identityOf(ctx.store.dbPath, "b", "pref.b.colleague");
  assert.ok(aIdentity && bIdentity);
  assert.notEqual(aIdentity, bIdentity);
  const bSourceId = bEntry.sourceId;

  // 管理 A 不能按字面同文把 B 纳入同一禁分享组。
  const restricted = ctx.store.memory.restrictSharing({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: 1,
    nowMs: ctx.nowMs(),
  });
  assert.deepEqual(restricted.holders, ["a"]);

  ctx.store.memory.correct({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: 1,
    body: "姐姐说她更喜欢蓝色",
    nowMs: ctx.nowMs(),
  });
  let bHeld = entryOf(ctx.store, "b", "pref.b.colleague");
  assert.equal(bHeld.id, bEntry.id);
  assert.equal(bHeld.body, EXCERPT);
  assert.equal(bHeld.version, 1);
  assert.equal(bHeld.sourceId, bSourceId);
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.b.colleague"), bIdentity);
  assert.equal(ctx.store.memory.searchMemories({ characterId: "b", query: "蓝色" }).length, 1);
  const bSnapshot = snapshot(ctx.store, bHeld);
  assert.equal(bSnapshot.status, "ok");
  assert.equal(bSnapshot.sourceMessage.content, COLLEAGUE_TEXT);

  ctx.store.memory.forget({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: 2,
    nowMs: ctx.nowMs(),
  });
  assert.equal(entryOf(ctx.store, "a", "pref.a.sister"), null);
  bHeld = entryOf(ctx.store, "b", "pref.b.colleague");
  assert.equal(bHeld.body, EXCERPT);
  assert.equal(bHeld.version, 1);
  assert.equal(bHeld.sourceId, bSourceId);

  ctx.reopen();
  const bAfter = entryOf(ctx.store, "b", "pref.b.colleague");
  assert.equal(bAfter.id, bEntry.id);
  assert.equal(bAfter.body, EXCERPT);
  assert.equal(bAfter.version, 1);
  assert.equal(bAfter.sourceId, bSourceId);
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.b.colleague"), bIdentity);
  assert.equal(ctx.store.memory.searchMemories({ characterId: "b", query: "蓝色" }).length, 1);
  assert.equal(countRows(ctx.store.dbPath, "memory_derivations"), 0);
  assert.deepEqual(ctx.store.memory.listMemories("c"), []);
});

test("POL-SOURCE-ID-003 独立同文条目经正式 associateFacts 显式同组，share/relay 派生继续传播", async (t) => {
  const ctx = await setupContext(t, ["a", "b", "c", "d", "e"]);
  const aConversation = openConversation(ctx.store, "a");
  const bConversation = openConversation(ctx.store, "b");
  await turn(ctx, aConversation, SISTER_TEXT, [
    fact("pref.a.color", EXCERPT, "preference"),
  ]);
  await turn(ctx, bConversation, SISTER_EQUIVALENT_TEXT, [
    fact("pref.b.color", EXCERPT, "preference"),
  ], "b");

  const aEntry = entryOf(ctx.store, "a", "pref.a.color");
  const bEntry = entryOf(ctx.store, "b", "pref.b.color");
  assert.ok(aEntry && bEntry);
  assert.notEqual(
    identityOf(ctx.store.dbPath, "a", "pref.a.color"),
    identityOf(ctx.store.dbPath, "b", "pref.b.color"),
  );

  // 显式证据路径：调用方核验等价后才关联，本用例不冒充模型判断。
  const associated = ctx.store.memory.associateFacts({
    left: { entryId: aEntry.id, expectedVersion: aEntry.version },
    right: { entryId: bEntry.id, expectedVersion: bEntry.version },
  });
  assert.equal(associated.associated, true);
  const groupIdentity = identityOf(ctx.store.dbPath, "a", "pref.a.color");
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.b.color"), groupIdentity);

  // 关联后的管理仍按共享身份传播；校正的版本从被操作的 a 条目读取。
  const aVersionAfterAssociation = entryOf(ctx.store, "a", "pref.a.color").version;
  ctx.store.memory.correct({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: aVersionAfterAssociation,
    body: "姐姐说她喜欢蓝色",
    nowMs: ctx.nowMs(),
  });
  assert.equal(entryOf(ctx.store, "b", "pref.b.color").body, "姐姐说她喜欢蓝色");
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.b.color"), groupIdentity);

  // 真实 share/relay 派生继承同一身份组，未知角色不新增。
  ctx.store.memory.share({
    fromCharacterId: "a",
    toCharacterId: "c",
    entryIds: [aEntry.id],
  });
  const cEntry = entryOf(ctx.store, "c", "pref.a.color");
  assert.ok(cEntry);
  assert.equal(cEntry.derived, true);
  assert.equal(cEntry.originCharacterId, "a");
  ctx.store.memory.relay({
    fromCharacterId: "c",
    toCharacterId: "d",
    entries: [{ entryId: cEntry.id, expectedVersion: cEntry.version }],
  });
  const dEntry = entryOf(ctx.store, "d", "pref.a.color");
  assert.ok(dEntry);
  assert.equal(dEntry.derived, true);
  assert.equal(dEntry.narratorCharacterId, "c");
  for (const entry of [cEntry, dEntry]) {
    assert.equal(identityOf(ctx.store.dbPath, entry.characterId, entry.factKey), groupIdentity);
  }
  assert.deepEqual(ctx.store.memory.listMemories("e"), []);

  ctx.reopen();
  assert.equal(identityOf(ctx.store.dbPath, "a", "pref.a.color"), groupIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.b.color"), groupIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "c", "pref.a.color"), groupIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "d", "pref.a.color"), groupIdentity);
  assert.equal(entryOf(ctx.store, "b", "pref.b.color").body, "姐姐说她喜欢蓝色");
  assert.equal(entryOf(ctx.store, "d", "pref.a.color").derived, true);
  assert.deepEqual(ctx.store.memory.listMemories("e"), []);
});

test("POL-SOURCE-ID-004 缺身份旧库迁移：同文独立分组、派生存续、旧控制保留", async (t) => {
  const ctx = await setupContext(t, ["a", "b", "c", "d", "e"]);
  const db = ctx.store.db;
  // 已持久化的旧身份组：本批不拆解，保留为下一批迁移缺口。
  db.prepare(
    "INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)",
  ).run("persisted-group", START);
  insertLegacyEntry(db, {
    id: "legacy-indep-a",
    characterId: "a",
    factKey: "pref.a.color",
    body: EXCERPT,
    sourceId: "legacy-indep-a",
  });
  insertLegacyEntry(db, {
    id: "legacy-indep-b",
    characterId: "b",
    factKey: "pref.b.color",
    body: EXCERPT,
    sourceId: "legacy-indep-b",
  });
  insertLegacyEntry(db, {
    id: "legacy-parent",
    characterId: "c",
    factKey: "pref.c.color",
    body: "用户喜欢绿色",
    sourceId: "legacy-parent-c",
  });
  for (const [id, characterId] of [["legacy-child-d", "d"], ["legacy-child-e", "e"]]) {
    insertLegacyEntry(db, {
      id,
      characterId,
      factKey: `pref.${characterId}.color`,
      body: "用户喜欢绿色",
      sourceId: `share:legacy-parent:${characterId}`,
      derivedFromEntryId: "legacy-parent",
      originCharacterId: "c",
    });
    insertLegacyDerivation(db, {
      entryId: id,
      parentEntryId: "legacy-parent",
      originCharacterId: "c",
      narratorCharacterId: "c",
    });
  }
  for (const [id, characterId] of [["legacy-group-a", "a"], ["legacy-group-b", "b"]]) {
    insertLegacyEntry(db, {
      id,
      characterId,
      factKey: `pref.persisted.${characterId}`,
      body: "用户喜欢橙色",
      sourceId: id,
      factIdentityId: "persisted-group",
    });
  }
  // 旧控制不带身份：迁移时应定位到现存身份，定位不到才保留孤儿键保护。
  db.prepare(`
    INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at)
    VALUES (?, ?, ?)
  `).run("a", sha256("pref.a.color"), START);
  db.prepare(`
    INSERT INTO memory_share_controls (fact_key_hash, created_at) VALUES (?, ?)
  `).run(sha256("pref.c.color"), START);

  ctx.reopen();

  // 缺身份的同文独立来源各自建身份，不按正文归组。
  assert.notEqual(
    identityOf(ctx.store.dbPath, "a", "pref.a.color"),
    identityOf(ctx.store.dbPath, "b", "pref.b.color"),
  );
  // 明确派生父来源保留同组，正文与来源不被迁移改写。
  const parentIdentity = identityOf(ctx.store.dbPath, "c", "pref.c.color");
  assert.ok(parentIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "d", "pref.d.color"), parentIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "e", "pref.e.color"), parentIdentity);
  const dEntry = entryOf(ctx.store, "d", "pref.d.color");
  assert.equal(dEntry.body, "用户喜欢绿色");
  assert.equal(dEntry.sourceId, "share:legacy-parent:d");
  assert.equal(dEntry.derived, true);

  // 旧控制迁入身份后仍生效，孤儿键保护逻辑未被移除。
  const forgetControl = readOne(
    ctx.store.dbPath,
    `SELECT identity_id, identity_migrated FROM memory_forget_controls
     WHERE character_id = 'a' AND fact_key_hash = ?`,
    sha256("pref.a.color"),
  );
  assert.equal(forgetControl.identity_migrated, 1);
  assert.equal(
    forgetControl.identity_id,
    identityOf(ctx.store.dbPath, "a", "pref.a.color"),
  );
  assert.equal(
    readOne(
      ctx.store.dbPath,
      `SELECT COUNT(*) AS count FROM memory_forget_identity_controls
       WHERE character_id = 'a' AND identity_id = ?`,
      forgetControl.identity_id,
    ).count,
    1,
  );
  const shareControl = readOne(
    ctx.store.dbPath,
    "SELECT identity_id, identity_migrated FROM memory_share_controls WHERE fact_key_hash = ?",
    sha256("pref.c.color"),
  );
  assert.equal(shareControl.identity_migrated, 1);
  assert.equal(shareControl.identity_id, parentIdentity);
  assert.equal(
    readOne(
      ctx.store.dbPath,
      "SELECT COUNT(*) AS count FROM memory_share_identity_controls WHERE identity_id = ?",
      parentIdentity,
    ).count,
    1,
  );
  const parentEntry = entryOf(ctx.store, "c", "pref.c.color");
  assert.throws(
    () => ctx.store.memory.share({
      fromCharacterId: "c",
      toCharacterId: "a",
      entryIds: [parentEntry.id],
    }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  const relearned = ctx.store.memory.remember({
    characterId: "a",
    factKey: "pref.a.color.copy",
    body: EXCERPT,
    kind: "preference",
    sourceId: "new-copy-source",
  });
  assert.equal(relearned.created, false);
  assert.equal(relearned.blocked, "forget");

  // 已持久旧身份组保持原样：本批只修新独立来源与缺身份迁移。
  assert.equal(identityOf(ctx.store.dbPath, "a", "pref.persisted.a"), "persisted-group");
  assert.equal(identityOf(ctx.store.dbPath, "b", "pref.persisted.b"), "persisted-group");

  // 再次重启：迁移幂等，独立/派生分组与旧控制结果不变。
  ctx.reopen();
  assert.notEqual(
    identityOf(ctx.store.dbPath, "a", "pref.a.color"),
    identityOf(ctx.store.dbPath, "b", "pref.b.color"),
  );
  assert.equal(identityOf(ctx.store.dbPath, "d", "pref.d.color"), parentIdentity);
  assert.equal(identityOf(ctx.store.dbPath, "e", "pref.e.color"), parentIdentity);
  assert.equal(entryOf(ctx.store, "d", "pref.d.color").body, "用户喜欢绿色");
  assert.equal(entryOf(ctx.store, "d", "pref.d.color").sourceId, "share:legacy-parent:d");
  assert.equal(
    readOne(
      ctx.store.dbPath,
      "SELECT COUNT(*) AS count FROM memory_share_identity_controls WHERE identity_id = ?",
      parentIdentity,
    ).count,
    1,
  );
  assert.equal(identityOf(ctx.store.dbPath, "a", "pref.persisted.a"), "persisted-group");
});
