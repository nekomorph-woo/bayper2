/* S03l-a 事实身份与传播范围验收：真实 SQLite、正式 memory 服务入口，
   不启动 GUI、不调用模型。覆盖 POL-FACTID-001~006；不同措辞的同义自动
   关联属于下一片，本文件只验证无需模型即可确认的严格同文身份、明确派生
   继承与旧库迁移。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryError, createMemoryService } = require("../../app/memory.cjs");
const { strictFactFingerprint } = require("../../app/memory-fact-identity.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);

const LEGACY_MEMORY_SCHEMA = `
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fact_key TEXT NOT NULL,
    origin_character_id TEXT NOT NULL REFERENCES relationships(character_id),
    derived_from_entry_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('identity', 'preference', 'experience', 'detail')),
    body TEXT NOT NULL CHECK (length(body) > 0),
    trust TEXT NOT NULL CHECK (trust IN ('stated', 'inferred')),
    source_kind TEXT NOT NULL DEFAULT 'user' CHECK (source_kind IN ('user', 'theme')),
    importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
    expires_at INTEGER,
    source_id TEXT NOT NULL,
    source_version INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (character_id, fact_key)
  );
  CREATE INDEX memory_entries_fact_key ON memory_entries (fact_key);
  CREATE INDEX memory_entries_character
    ON memory_entries (character_id, kind, importance DESC, updated_at DESC);
  CREATE TABLE memory_forget_controls (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fact_key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, fact_key_hash)
  );
  CREATE TABLE memory_source_controls (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    source_id_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash)
  );
  CREATE TABLE memory_share_controls (
    fact_key_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE memory_derivations (
    entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
    parent_entry_id TEXT NOT NULL,
    origin_character_id TEXT NOT NULL REFERENCES relationships(character_id),
    narrator_character_id TEXT,
    source_id TEXT,
    source_version INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE memory_extraction_batches (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    source_id_hash TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash, source_version)
  );
  CREATE TABLE memory_context_versions (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE memory_fts USING fts5(
    entry_id UNINDEXED,
    char_tokens,
    segment_tokens,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

function makeContext(t, characters = ["a", "b", "c", "d"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-fact-identity-"));
  createMemoryDatabase(dir, characters).db.close();
  let nowMs = START;
  const current = { db: openMemoryDatabase(dir), service: null };
  current.service = createMemoryService({ db: current.db, now: () => nowMs });

  const ctx = {
    dir,
    get db() {
      return current.db;
    },
    get service() {
      return current.service;
    },
    nowMs: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
    reopen() {
      current.db.close();
      current.db = openMemoryDatabase(dir);
      current.service = createMemoryService({ db: current.db, now: () => nowMs });
    },
  };
  closeAfter(t, ctx);
  return ctx;
}

function closeAfter(t, ctx) {
  t.after(() => {
    try {
      ctx.db.close();
    } catch {
      // 测试已主动关闭时仍要清理临时目录。
    }
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
}

function makeLegacyDirectory(t, characters, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-fact-identity-legacy-"));
  createMemoryDatabase(dir, characters).db.close();
  const db = openMemoryDatabase(dir);
  db.exec(LEGACY_MEMORY_SCHEMA);
  seed(db);
  db.close();
  return dir;
}

/* 旧库直接构造：没有身份表/列，只有既有正文、派生关系与旧控制。 */
function makeLegacyContext(t, seed, characters = ["a", "b", "c", "d"]) {
  const dir = makeLegacyDirectory(t, characters, seed);
  let nowMs = START;
  const current = { db: openMemoryDatabase(dir), service: null };
  current.service = createMemoryService({ db: current.db, now: () => nowMs });
  const ctx = {
    dir,
    get db() {
      return current.db;
    },
    get service() {
      return current.service;
    },
    nowMs: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
    reopen() {
      current.db.close();
      current.db = openMemoryDatabase(dir);
      current.service = createMemoryService({ db: current.db, now: () => nowMs });
    },
  };
  closeAfter(t, ctx);
  return ctx;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function identityOf(db, characterId, factKey) {
  return db
    .prepare(
      `SELECT fact_identity_id FROM memory_entries
       WHERE character_id = ? AND fact_key = ?`,
    )
    .get(characterId, factKey)?.fact_identity_id ?? null;
}

function entryOf(service, characterId, factKey) {
  return service.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function insertLegacyEntry(db, entry) {
  db.prepare(`
    INSERT INTO memory_entries (
      id, character_id, fact_key, origin_character_id, derived_from_entry_id,
      kind, body, trust, source_kind, importance, expires_at,
      source_id, source_version, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.characterId,
    entry.factKey,
    entry.originCharacterId ?? entry.characterId,
    entry.derivedFromEntryId ?? null,
    entry.kind ?? "preference",
    entry.body,
    entry.trust ?? "stated",
    entry.sourceKind ?? "user",
    entry.importance ?? 60,
    entry.expiresAt ?? null,
    entry.sourceId,
    entry.sourceVersion ?? 1,
    entry.version ?? 1,
    entry.createdAt ?? START,
    entry.updatedAt ?? START,
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

function hasCode(code) {
  return (error) => error instanceof MemoryError && error.code === code;
}

test("POL-FACTID-001 同键不同主体或性质：纠正删除只触达实际身份", (t) => {
  const ctx = makeContext(t);
  const aCoffee = ctx.service.remember({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢甜咖啡",
    kind: "preference",
    sourceId: "a-coffee",
  });
  const bSister = ctx.service.remember({
    characterId: "b",
    factKey: "pref.coffee",
    body: "用户的姐姐喜欢甜咖啡",
    kind: "preference",
    sourceId: "b-sister",
  });
  const cCurrent = ctx.service.remember({
    characterId: "c",
    factKey: "pref.weekend",
    body: "用户喜欢周末去爬山",
    kind: "preference",
    sourceId: "c-weekend",
  });
  const dHistory = ctx.service.remember({
    characterId: "d",
    factKey: "pref.weekend",
    body: "用户去年和朋友爬过山",
    kind: "experience",
    sourceId: "d-history",
  });
  assert.notEqual(
    identityOf(ctx.db, "a", "pref.coffee"),
    identityOf(ctx.db, "b", "pref.coffee"),
  );
  assert.notEqual(
    identityOf(ctx.db, "c", "pref.weekend"),
    identityOf(ctx.db, "d", "pref.weekend"),
  );

  const bContextBefore = ctx.service.getContextVersion("b");
  const dContextBefore = ctx.service.getContextVersion("d");
  const corrected = ctx.service.correct({
    characterId: "a",
    entryId: aCoffee.entry.id,
    expectedVersion: 1,
    body: "用户现在只喝纯黑咖啡",
    sourceId: "a-coffee-new",
  });
  assert.equal(corrected.updated, 1);
  assert.deepEqual(corrected.affectedCharacters, ["a"]);
  assert.equal(entryOf(ctx.service, "a", "pref.coffee").body, "用户现在只喝纯黑咖啡");
  assert.equal(entryOf(ctx.service, "b", "pref.coffee").body, "用户的姐姐喜欢甜咖啡");
  assert.equal(entryOf(ctx.service, "b", "pref.coffee").version, 1);
  assert.equal(ctx.service.searchMemories({ characterId: "b", query: "姐姐" }).length, 1);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "纯黑" }), []);
  assert.equal(ctx.service.getContextVersion("b"), bContextBefore);
  assert.equal(entryOf(ctx.service, "d", "pref.weekend").body, "用户去年和朋友爬过山");
  assert.equal(entryOf(ctx.service, "d", "pref.weekend").version, 1);
  assert.equal(ctx.service.getContextVersion("d"), dContextBefore);
  assert.equal(entryOf(ctx.service, "d", "pref.weekend").id, dHistory.entry.id);

  const deleted = ctx.service.forget({ characterId: "a", factKey: "pref.coffee" });
  assert.equal(deleted.deleted, 1);
  assert.deepEqual(deleted.affectedCharacters, ["a"]);
  assert.equal(entryOf(ctx.service, "a", "pref.coffee"), null);
  assert.equal(entryOf(ctx.service, "b", "pref.coffee").id, bSister.entry.id);
  assert.equal(entryOf(ctx.service, "c", "pref.weekend").id, cCurrent.entry.id);
  assert.equal(entryOf(ctx.service, "d", "pref.weekend").id, dHistory.entry.id);
});

test("POL-FACTID-002 严格相同明确偏好可跨键复用身份；旧库迁移后同样生效", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.a.coffee",
    body: "用户喜欢无糖咖啡",
    kind: "preference",
    sourceId: "a-coffee",
  });
  ctx.service.remember({
    characterId: "b",
    factKey: "pref.b.coffee",
    body: "用户喜欢无糖咖啡",
    kind: "preference",
    sourceId: "b-coffee",
  });
  assert.equal(identityOf(ctx.db, "a", "pref.a.coffee"), identityOf(ctx.db, "b", "pref.b.coffee"));
  const bHeld = entryOf(ctx.service, "b", "pref.b.coffee");
  assert.equal(bHeld.originCharacterId, "b");
  assert.equal(bHeld.derived, false);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);

  ctx.service.correct({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
    body: "用户只喝纯黑咖啡",
    sourceId: "a-coffee-new",
  });
  const bCorrected = entryOf(ctx.service, "b", "pref.b.coffee");
  assert.equal(bCorrected.body, "用户只喝纯黑咖啡");
  assert.equal(bCorrected.version, 2);
  assert.equal(bCorrected.derived, false);
  assert.equal(bCorrected.originCharacterId, "b");
  assert.deepEqual(ctx.service.listMemories("c"), []);

  const deleted = ctx.service.forget({ characterId: "a", factKey: "pref.a.coffee" });
  assert.equal(deleted.deleted, 2);
  assert.deepEqual(deleted.affectedCharacters, ["a", "b"]);
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.listMemories("c"), []);

  // experience/detail 同文跨角色不自动合并。
  const cHistory = ctx.service.remember({
    characterId: "c",
    factKey: "exp.c.rain",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "c-rain",
  });
  const dHistory = ctx.service.remember({
    characterId: "d",
    factKey: "exp.d.rain",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "d-rain",
  });
  assert.notEqual(
    identityOf(ctx.db, "c", "exp.c.rain"),
    identityOf(ctx.db, "d", "exp.d.rain"),
  );
  ctx.service.correct({
    characterId: "c",
    entryId: cHistory.entry.id,
    expectedVersion: 1,
    body: "我们雨夜走过另一座桥",
  });
  assert.equal(entryOf(ctx.service, "d", "exp.d.rain").body, "我们一起在雨夜走过桥");
  assert.equal(entryOf(ctx.service, "d", "exp.d.rain").id, dHistory.entry.id);

  // 正文比较只做 trim/NFC：组合与分解形式视为同一正文，不额外删词或改否定。
  ctx.service.remember({
    characterId: "a",
    factKey: "pref.cafe",
    body: "用户喜欢 café",
    kind: "preference",
    sourceId: "a-cafe",
  });
  ctx.service.remember({
    characterId: "b",
    factKey: "pref.cafe.other",
    body: "用户喜欢 café",
    kind: "preference",
    sourceId: "b-cafe",
  });
  assert.equal(identityOf(ctx.db, "a", "pref.cafe"), identityOf(ctx.db, "b", "pref.cafe.other"));
});

test("POL-FACTID-002 旧库迁移：严格同文不同键同组，同键不同正文不合并", (t) => {
  const ctx = makeLegacyContext(t, (db) => {
    insertLegacyEntry(db, {
      id: "legacy-a-coffee",
      characterId: "a",
      factKey: "pref.a.coffee",
      body: "用户喜欢无糖咖啡",
      kind: "preference",
      sourceId: "legacy-a",
    });
    insertLegacyEntry(db, {
      id: "legacy-b-coffee",
      characterId: "b",
      factKey: "pref.b.coffee",
      body: "用户喜欢无糖咖啡",
      kind: "preference",
      sourceId: "legacy-b",
    });
    insertLegacyEntry(db, {
      id: "legacy-a-same",
      characterId: "a",
      factKey: "pref.same",
      body: "用户喜欢甜咖啡",
      kind: "preference",
      sourceId: "legacy-same-a",
    });
    insertLegacyEntry(db, {
      id: "legacy-b-same",
      characterId: "b",
      factKey: "pref.same",
      body: "用户的姐姐喜欢甜咖啡",
      kind: "preference",
      sourceId: "legacy-same-b",
    });
  });

  assert.equal(identityOf(ctx.db, "a", "pref.a.coffee"), identityOf(ctx.db, "b", "pref.b.coffee"));
  assert.notEqual(identityOf(ctx.db, "a", "pref.same"), identityOf(ctx.db, "b", "pref.same"));

  const corrected = ctx.service.correct({
    characterId: "a",
    factKey: "pref.a.coffee",
    body: "用户只喝纯黑咖啡",
    sourceId: "legacy-a-new",
  });
  assert.equal(corrected.updated, 2);
  assert.deepEqual(corrected.affectedCharacters, ["a", "b"]);
  assert.equal(entryOf(ctx.service, "b", "pref.b.coffee").body, "用户只喝纯黑咖啡");

  ctx.reopen();
  assert.equal(identityOf(ctx.db, "a", "pref.a.coffee"), identityOf(ctx.db, "b", "pref.b.coffee"));
  assert.equal(entryOf(ctx.service, "a", "pref.same").body, "用户喜欢甜咖啡");
  assert.equal(entryOf(ctx.service, "b", "pref.same").body, "用户的姐姐喜欢甜咖啡");

  const deleted = ctx.service.forget({ characterId: "a", factKey: "pref.a.coffee" });
  assert.equal(deleted.deleted, 2);
  assert.deepEqual(ctx.service.listMemories("a").map((entry) => entry.factKey), ["pref.same"]);
  assert.deepEqual(ctx.service.listMemories("b").map((entry) => entry.factKey), ["pref.same"]);
  assert.equal(entryOf(ctx.service, "a", "pref.same").body, "用户喜欢甜咖啡");
  assert.equal(entryOf(ctx.service, "b", "pref.same").body, "用户的姐姐喜欢甜咖啡");
});

test("POL-FACTID-003 真实分享/转告多跳继承身份，删除源条目后剩余持有者仍同步", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.cold-brew",
    body: "用户喜欢冷萃咖啡",
    kind: "preference",
    sourceId: "a-cold-brew",
  });
  ctx.service.share({ fromCharacterId: "a", toCharacterId: "b", entryIds: [aEntry.entry.id] });
  const bEntry = entryOf(ctx.service, "b", "pref.cold-brew");
  ctx.service.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: bEntry.id, expectedVersion: 1 }],
  });
  const cEntry = entryOf(ctx.service, "c", "pref.cold-brew");
  assert.equal(cEntry.originCharacterId, "a");
  assert.equal(cEntry.narratorCharacterId, "b");
  assert.equal(cEntry.derivedFromEntryId, bEntry.id);

  ctx.reopen();
  const aIdentity = identityOf(ctx.db, "a", "pref.cold-brew");
  assert.equal(identityOf(ctx.db, "b", "pref.cold-brew"), aIdentity);
  assert.equal(identityOf(ctx.db, "c", "pref.cold-brew"), aIdentity);

  // 源条目仅自己忘记后，派生副本仍保留身份与讲述链。
  const selfForget = ctx.service.forget({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  assert.deepEqual(selfForget.affectedCharacters, ["a"]);
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.equal(entryOf(ctx.service, "b", "pref.cold-brew").derived, true);
  assert.equal(entryOf(ctx.service, "c", "pref.cold-brew").narratorCharacterId, "b");

  // 重启后由剩余的 B 发起纠正，C 同步；A 不会被恢复。
  ctx.reopen();
  const bCurrent = entryOf(ctx.service, "b", "pref.cold-brew");
  const corrected = ctx.service.correct({
    characterId: "b",
    entryId: bCurrent.id,
    expectedVersion: 1,
    body: "用户改喝气泡冷萃",
    sourceId: "b-correction",
  });
  assert.equal(corrected.updated, 2);
  assert.deepEqual(corrected.affectedCharacters, ["b", "c"]);
  assert.equal(entryOf(ctx.service, "c", "pref.cold-brew").body, "用户改喝气泡冷萃");
  assert.equal(entryOf(ctx.service, "c", "pref.cold-brew").derived, true);
  assert.equal(entryOf(ctx.service, "c", "pref.cold-brew").originCharacterId, "a");
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.deepEqual(ctx.service.listMemories("d"), []);

  // 由 C 默认删除同一身份，仅清理实际持有者，未知角色不新增。
  const cCurrent = entryOf(ctx.service, "c", "pref.cold-brew");
  const deleted = ctx.service.forget({
    characterId: "c",
    entryId: cCurrent.id,
    expectedVersion: cCurrent.version,
  });
  assert.equal(deleted.deleted, 2);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.equal(countRows(ctx.db, "memory_fts"), 0);
});

test("POL-FACTID-004 禁分享与解除按身份生效；同键不同主体不受影响", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.share",
    body: "用户喜欢冷萃咖啡",
    kind: "preference",
    sourceId: "a-share",
  });
  const bEntry = ctx.service.remember({
    characterId: "b",
    factKey: "pref.share.other",
    body: "用户喜欢冷萃咖啡",
    kind: "preference",
    sourceId: "b-share",
  });
  const cEntry = ctx.service.remember({
    characterId: "c",
    factKey: "pref.share",
    body: "用户的姐姐喜欢冷萃咖啡",
    kind: "preference",
    sourceId: "c-sister",
  });
  assert.equal(identityOf(ctx.db, "a", "pref.share"), identityOf(ctx.db, "b", "pref.share.other"));
  assert.notEqual(identityOf(ctx.db, "a", "pref.share"), identityOf(ctx.db, "c", "pref.share"));

  const restricted = ctx.service.restrictSharing({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
  });
  assert.deepEqual(restricted.holders, ["a", "b"]);
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "b",
        toCharacterId: "d",
        entries: [{ entryId: bEntry.entry.id, expectedVersion: 1 }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("d"), []);

  // 同键但不同身份（姐姐偏好）不属于禁分享范围。
  ctx.service.relay({
    fromCharacterId: "c",
    toCharacterId: "d",
    entries: [{ entryId: cEntry.entry.id, expectedVersion: 1 }],
  });
  assert.equal(entryOf(ctx.service, "d", "pref.share").body, "用户的姐姐喜欢冷萃咖啡");

  // 任一持有者都能独立解除；解除后原身份可继续转告。
  const bCurrent = entryOf(ctx.service, "b", "pref.share.other");
  const lifted = ctx.service.allowSharing({
    characterId: "b",
    entryId: bCurrent.id,
    expectedVersion: 1,
  });
  assert.equal(lifted.lifted, true);
  assert.deepEqual(lifted.holders, ["a", "b"]);
  ctx.service.relay({
    fromCharacterId: "b",
    toCharacterId: "d",
    entries: [{ entryId: bEntry.entry.id, expectedVersion: 1 }],
  });
  assert.equal(entryOf(ctx.service, "d", "pref.share.other").body, "用户喜欢冷萃咖啡");
});

test("POL-FACTID-004 自忘后同正文换键、旧来源改写与批量重学仍被阻断", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.forget",
    body: "用户喜欢海盐咖啡",
    kind: "preference",
    sourceId: "a-forget-old",
  });
  const bEntry = ctx.service.remember({
    characterId: "b",
    factKey: "pref.forget.other",
    body: "用户喜欢海盐咖啡",
    kind: "preference",
    sourceId: "b-forget",
  });
  ctx.service.forget({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.equal(entryOf(ctx.service, "b", "pref.forget.other").id, bEntry.entry.id);

  const newKey = ctx.service.remember({
    characterId: "a",
    factKey: "pref.forget.new",
    body: "用户喜欢海盐咖啡",
    kind: "preference",
    sourceId: "a-new-source",
  });
  assert.equal(newKey.created, false);
  assert.equal(newKey.blocked, "forget");

  const batch = ctx.service.applyExtractionBatch({
    characterId: "a",
    sourceId: "a-batch-source",
    sourceVersion: 1,
    facts: [
      {
        factKey: "pref.forget.batch",
        body: "用户喜欢海盐咖啡",
        kind: "preference",
      },
    ],
  });
  assert.equal(batch.applied, true);
  assert.equal(batch.facts[0].created, false);
  assert.equal(batch.facts[0].blocked, "forget");

  // 同一旧来源即使显式同意也不能作为新许可；改写正文也不能回流。
  const oldSource = ctx.service.remember({
    characterId: "a",
    factKey: "pref.forget.rewrite",
    body: "用户喜欢另一种咖啡",
    kind: "preference",
    sourceId: "a-forget-old",
    explicitConsent: true,
  });
  assert.equal(oldSource.created, false);
  assert.equal(oldSource.blocked, "source");
  assert.deepEqual(ctx.service.listMemories("a"), []);

  // 原角色 a 从全新来源获知同键的另一主体：不能被已删除的旧事实误拦。
  const aSister = ctx.service.remember({
    characterId: "a",
    factKey: "pref.forget",
    body: "用户的姐姐喜欢海盐咖啡",
    kind: "preference",
    sourceId: "a-forget-sister-new",
  });
  assert.equal(aSister.created, true);
  assert.deepEqual(
    ctx.service.listMemories("a").map((entry) => entry.body),
    ["用户的姐姐喜欢海盐咖啡"],
  );

  // 重启后新主体仍在；原已忘事实换键重学仍被阻断。
  ctx.reopen();
  assert.deepEqual(
    ctx.service.listMemories("a").map((entry) => entry.body),
    ["用户的姐姐喜欢海盐咖啡"],
  );
  const afterRestart = ctx.service.remember({
    characterId: "a",
    factKey: "pref.forget.restart",
    body: "用户喜欢海盐咖啡",
    kind: "preference",
    sourceId: "a-restart-source",
  });
  assert.equal(afterRestart.created, false);
  assert.equal(afterRestart.blocked, "forget");

  // 同键不同正文的独立主体仍可学习和转告。
  const sister = ctx.service.remember({
    characterId: "c",
    factKey: "pref.forget",
    body: "用户的姐姐喜欢海盐咖啡",
    kind: "preference",
    sourceId: "c-forget-sister",
  });
  assert.equal(sister.created, true);
  ctx.service.relay({
    fromCharacterId: "c",
    toCharacterId: "d",
    entries: [{ entryId: sister.entry.id, expectedVersion: 1 }],
  });
  assert.equal(entryOf(ctx.service, "d", "pref.forget").body, "用户的姐姐喜欢海盐咖啡");
  assert.equal(entryOf(ctx.service, "b", "pref.forget.other").body, "用户喜欢海盐咖啡");
});

test("POL-FACTID-004 experience/detail 只按本角色删除原文防回流，不封锁同键新正文", (t) => {
  const ctx = makeContext(t);
  const rain = ctx.service.remember({
    characterId: "a",
    factKey: "exp.rain",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "a-rain-old",
  });
  const detail = ctx.service.remember({
    characterId: "a",
    factKey: "detail.cup",
    body: "用户有一只青色杯子",
    kind: "detail",
    sourceId: "a-cup-old",
  });
  ctx.service.forget({
    characterId: "a",
    entryId: rain.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  ctx.service.forget({
    characterId: "a",
    entryId: detail.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("a"), []);

  // 同键不同正文是新事实，不受旧删除操作按 key 误拦。
  const otherRain = ctx.service.remember({
    characterId: "a",
    factKey: "exp.rain",
    body: "我们上个月在河边散了很久的步",
    kind: "experience",
    sourceId: "a-rain-new",
  });
  assert.equal(otherRain.created, true);
  const otherCup = ctx.service.remember({
    characterId: "a",
    factKey: "detail.cup",
    body: "用户换了一只白色杯子",
    kind: "detail",
    sourceId: "a-cup-new",
  });
  assert.equal(otherCup.created, true);

  // 原文从全新来源、新 key 重学仍被本角色删除指纹拦下。
  const reflowRain = ctx.service.remember({
    characterId: "a",
    factKey: "exp.rain.relearn",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "a-rain-never-seen",
  });
  assert.equal(reflowRain.created, false);
  assert.equal(reflowRain.blocked, "forget");
  const reflowCup = ctx.service.applyExtractionBatch({
    characterId: "a",
    sourceId: "a-cup-never-seen",
    sourceVersion: 1,
    facts: [
      {
        factKey: "detail.cup.relearn",
        body: "用户有一只青色杯子",
        kind: "detail",
      },
    ],
  });
  assert.equal(reflowCup.applied, true);
  assert.equal(reflowCup.facts[0].created, false);
  assert.equal(reflowCup.facts[0].blocked, "forget");

  // 删除指纹只属于该角色；另一角色同文经历仍可独立存在。
  const bRain = ctx.service.remember({
    characterId: "b",
    factKey: "exp.rain",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "b-rain",
  });
  assert.equal(bRain.created, true);
  assert.notEqual(
    identityOf(ctx.db, "a", "exp.rain"),
    identityOf(ctx.db, "b", "exp.rain"),
  );

  ctx.reopen();
  assert.equal(
    ctx.service.listMemories("a").find((entry) => entry.factKey === "exp.rain").body,
    "我们上个月在河边散了很久的步",
  );
  const afterRestart = ctx.service.remember({
    characterId: "a",
    factKey: "exp.rain.after-restart",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "a-rain-after-restart",
  });
  assert.equal(afterRestart.created, false);
  assert.equal(afterRestart.blocked, "forget");

  // 控制表不保存原文或事实键。
  const controlText = JSON.stringify(
    ctx.db.prepare("SELECT * FROM memory_deleted_fact_fingerprints").all(),
  );
  assert.equal(controlText.includes("雨夜"), false);
  assert.equal(controlText.includes("exp.rain"), false);
});

test("POL-FACTID-004 share/relay 不能把他人同文经历送回已删除原文的角色", (t) => {
  const ctx = makeContext(t);
  const aRain = ctx.service.remember({
    characterId: "a",
    factKey: "exp.rain.a",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "a-rain",
  });
  const bRain = ctx.service.remember({
    characterId: "b",
    factKey: "exp.rain.b",
    body: "我们一起在雨夜走过桥",
    kind: "experience",
    sourceId: "b-rain",
  });
  assert.notEqual(
    identityOf(ctx.db, "a", "exp.rain.a"),
    identityOf(ctx.db, "b", "exp.rain.b"),
  );
  ctx.service.forget({
    characterId: "a",
    entryId: aRain.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("a"), []);

  // 两角色身份不同，但 B 的原文正是 A 已删除的内容：share/relay 都必须拒绝。
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "b",
        toCharacterId: "a",
        entries: [{ entryId: bRain.entry.id, expectedVersion: 1 }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "b",
        toCharacterId: "a",
        entryIds: [bRain.entry.id],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("a"), []);

  // 同键但不同正文仍是新事实，可以正常送达。
  const bOther = ctx.service.remember({
    characterId: "b",
    factKey: "exp.rain.a",
    body: "我们后来在山里看过雾",
    kind: "experience",
    sourceId: "b-other-rain",
  });
  assert.equal(bOther.created, true);
  ctx.service.share({
    fromCharacterId: "b",
    toCharacterId: "a",
    entryIds: [bOther.entry.id],
  });
  assert.deepEqual(
    ctx.service.listMemories("a").map((entry) => entry.body),
    ["我们后来在山里看过雾"],
  );

  ctx.reopen();
  assert.deepEqual(
    ctx.service.listMemories("a").map((entry) => entry.body),
    ["我们后来在山里看过雾"],
  );
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "b",
        toCharacterId: "a",
        entries: [{ entryId: bRain.entry.id, expectedVersion: 1 }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
});

test("POL-FACTID-004 独属按身份清除其他持有者，未关联主体保持可分享", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.exclusive",
    body: "用户喜欢桂花乌龙",
    kind: "preference",
    sourceId: "a-exclusive",
  });
  ctx.service.remember({
    characterId: "b",
    factKey: "pref.exclusive.b",
    body: "用户喜欢桂花乌龙",
    kind: "preference",
    sourceId: "b-exclusive",
  });
  ctx.service.remember({
    characterId: "d",
    factKey: "pref.exclusive.d",
    body: "用户喜欢桂花乌龙",
    kind: "preference",
    sourceId: "d-exclusive",
  });
  const cEntry = ctx.service.remember({
    characterId: "c",
    factKey: "pref.exclusive",
    body: "用户的姐姐喜欢桂花乌龙",
    kind: "preference",
    sourceId: "c-exclusive-sister",
  });

  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
  });
  assert.equal(result.cleared, 2);
  assert.deepEqual(result.clearedCharacters, ["b", "d"]);
  assert.equal(result.version, 2);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.deepEqual(ctx.service.listMemories("c").map((entry) => entry.id), [cEntry.entry.id]);
  assert.equal(entryOf(ctx.service, "a", "pref.exclusive").body, "用户喜欢桂花乌龙");

  const bRecall = ctx.service.remember({
    characterId: "b",
    factKey: "pref.exclusive.recall",
    body: "用户喜欢桂花乌龙",
    kind: "preference",
    sourceId: "b-new-source",
  });
  assert.equal(bRecall.created, false);
  assert.equal(bRecall.blocked, "forget");

  ctx.service.relay({
    fromCharacterId: "c",
    toCharacterId: "d",
    entries: [{ entryId: cEntry.entry.id, expectedVersion: 1 }],
  });
  assert.equal(entryOf(ctx.service, "d", "pref.exclusive").body, "用户的姐姐喜欢桂花乌龙");
});

test("POL-FACTID-004 指纹歧义不挑首项绕过忘记与禁分享控制", (t) => {
  const ctx = makeContext(t);
  // D 先持有并只让自己忘记，留下无正文的身份控制与严格同文别名。
  const dEntry = ctx.service.remember({
    characterId: "d",
    factKey: "pref.lime.d",
    body: "用户喜欢青柠茶",
    kind: "preference",
    sourceId: "d-lime",
  });
  ctx.service.forget({
    characterId: "d",
    entryId: dEntry.entry.id,
    expectedVersion: 1,
    scope: "self",
  });

  // A、C 先后纠正到同一正文，使该指纹同时指向多个身份。
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.grapefruit",
    body: "用户喜欢柚子茶",
    kind: "preference",
    sourceId: "a-grapefruit",
  });
  ctx.service.correct({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 1,
    body: "用户喜欢青柠茶",
    sourceId: "a-lime",
  });
  const cEntry = ctx.service.remember({
    characterId: "c",
    factKey: "pref.peach",
    body: "用户喜欢蜜桃茶",
    kind: "preference",
    sourceId: "c-peach",
  });
  ctx.service.correct({
    characterId: "c",
    entryId: cEntry.entry.id,
    expectedVersion: 1,
    body: "用户喜欢青柠茶",
    sourceId: "c-lime",
  });
  assert.ok(
    countRows(ctx.db, "memory_fact_alias_conflicts") > 0,
    "纠正后同一指纹应记录为多身份歧义",
  );

  // 歧义组里有一个身份已被 D 忘记，不能用新分配身份绕过。
  const bypass = ctx.service.remember({
    characterId: "d",
    factKey: "pref.lime.d.again",
    body: "用户喜欢青柠茶",
    kind: "preference",
    sourceId: "d-lime-again",
  });
  assert.equal(bypass.created, false);
  assert.equal(bypass.blocked, "forget");
  assert.deepEqual(ctx.service.listMemories("d"), []);

  // 组内任一身份被禁分享时，同指纹的其它身份副本也不能转告。
  const aCurrent = entryOf(ctx.service, "a", "pref.grapefruit");
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: aCurrent.id,
    expectedVersion: aCurrent.version,
  });
  const cCurrent = entryOf(ctx.service, "c", "pref.peach");
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "c",
        toCharacterId: "b",
        entries: [{ entryId: cCurrent.id, expectedVersion: cCurrent.version }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("b"), []);

  // 无法判断该解除哪个身份时保守不解除，避免顺手放宽另一组隐私限制。
  const lifted = ctx.service.allowSharing({
    characterId: "c",
    entryId: cCurrent.id,
    expectedVersion: cCurrent.version,
  });
  assert.equal(lifted.lifted, false);
  assert.equal(countRows(ctx.db, "memory_share_identity_controls"), 1);
});

test("POL-FACTID-005 旧库迁移保留派生链、正文与旧控制，且可重复迁移", (t) => {
  const ctx = makeLegacyContext(t, (db) => {
    insertLegacyEntry(db, {
      id: "legacy-chain-a",
      characterId: "a",
      factKey: "exp.chain",
      body: "我们一起在雨夜走过桥",
      kind: "experience",
      sourceId: "legacy-chain-a",
    });
    insertLegacyEntry(db, {
      id: "legacy-chain-b",
      characterId: "b",
      factKey: "exp.chain",
      body: "我们一起在雨夜走过桥",
      kind: "experience",
      sourceId: "share:legacy-chain-a:b",
      derivedFromEntryId: "legacy-chain-a",
      originCharacterId: "a",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-chain-b",
      parentEntryId: "legacy-chain-a",
      originCharacterId: "a",
      narratorCharacterId: "a",
    });
    insertLegacyEntry(db, {
      id: "legacy-chain-c",
      characterId: "c",
      factKey: "exp.chain",
      body: "我们一起在雨夜走过桥",
      kind: "experience",
      sourceId: "relay:legacy-chain-b:c",
      derivedFromEntryId: "legacy-chain-b",
      originCharacterId: "a",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-chain-c",
      parentEntryId: "legacy-chain-b",
      originCharacterId: "a",
      narratorCharacterId: "b",
    });
    insertLegacyEntry(db, {
      id: "legacy-share-a",
      characterId: "a",
      factKey: "pref.secret",
      body: "用户喜欢薄荷糖",
      kind: "preference",
      sourceId: "legacy-secret",
    });
    insertLegacyEntry(db, {
      id: "legacy-kept-a",
      characterId: "a",
      factKey: "pref.kept",
      body: "用户记得旧暗号是青石",
      kind: "preference",
      sourceId: "legacy-kept",
    });
    // 父条目已删除、但剩余派生条目仍引用同一个 parent_entry_id：
    // 这是可证明的共同来源，不能按正文缺失拆成不同身份。
    insertLegacyEntry(db, {
      id: "legacy-orphan-exp-c",
      characterId: "c",
      factKey: "exp.orphan.c",
      body: "用户和角色曾在山里看过雾",
      kind: "experience",
      sourceId: "share:legacy-deleted-exp:c",
      originCharacterId: "a",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-orphan-exp-c",
      parentEntryId: "legacy-deleted-exp",
      originCharacterId: "a",
      narratorCharacterId: "a",
    });
    insertLegacyEntry(db, {
      id: "legacy-orphan-exp-d",
      characterId: "d",
      factKey: "exp.orphan.d",
      body: "听来的另一段山雾回忆",
      kind: "experience",
      sourceId: "relay:legacy-deleted-exp:d",
      originCharacterId: "a",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-orphan-exp-d",
      parentEntryId: "legacy-deleted-exp",
      originCharacterId: "a",
      narratorCharacterId: "c",
    });
    insertLegacyEntry(db, {
      id: "legacy-orphan-detail-c",
      characterId: "c",
      factKey: "detail.orphan.c",
      body: "用户提过一只铜铃",
      kind: "detail",
      sourceId: "share:legacy-deleted-detail:c",
      originCharacterId: "b",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-orphan-detail-c",
      parentEntryId: "legacy-deleted-detail",
      originCharacterId: "b",
      narratorCharacterId: "b",
    });
    insertLegacyEntry(db, {
      id: "legacy-orphan-detail-d",
      characterId: "d",
      factKey: "detail.orphan.d",
      body: "后来听说铜铃已经收起来了",
      kind: "detail",
      sourceId: "relay:legacy-deleted-detail:d",
      originCharacterId: "b",
    });
    insertLegacyDerivation(db, {
      entryId: "legacy-orphan-detail-d",
      parentEntryId: "legacy-deleted-detail",
      originCharacterId: "b",
      narratorCharacterId: "c",
    });
    db.prepare(`
      INSERT INTO memory_share_controls (fact_key_hash, created_at) VALUES (?, ?)
    `).run(sha256("pref.secret"), START);
    db.prepare(`
      INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256("pref.kept"), START);
    // 没有对应条目的历史控制：只能按旧键保留，不能猜造身份。
    db.prepare(`
      INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256("pref.orphan"), START);
    db.prepare(`
      INSERT INTO memory_source_controls (character_id, source_id_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256("legacy-source"), START);
  });

  const aIdentity = identityOf(ctx.db, "a", "exp.chain");
  assert.ok(aIdentity);
  assert.equal(identityOf(ctx.db, "b", "exp.chain"), aIdentity);
  assert.equal(identityOf(ctx.db, "c", "exp.chain"), aIdentity);
  // 父条目已删除的共同来源仍同组；没有虚构父条目。
  const orphanExpIdentity = identityOf(ctx.db, "c", "exp.orphan.c");
  assert.ok(orphanExpIdentity);
  assert.equal(identityOf(ctx.db, "d", "exp.orphan.d"), orphanExpIdentity);
  const orphanDetailIdentity = identityOf(ctx.db, "c", "detail.orphan.c");
  assert.ok(orphanDetailIdentity);
  assert.equal(identityOf(ctx.db, "d", "detail.orphan.d"), orphanDetailIdentity);
  assert.equal(
    ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE id IN ('legacy-deleted-exp', 'legacy-deleted-detail')",
    ).get().count,
    0,
  );
  assert.equal(entryOf(ctx.service, "b", "exp.chain").derived, true);
  assert.equal(entryOf(ctx.service, "c", "exp.chain").narratorCharacterId, "b");

  // 正文与版本不因迁移改变；旧来源控制仍在。
  assert.equal(entryOf(ctx.service, "a", "pref.secret").body, "用户喜欢薄荷糖");
  assert.equal(entryOf(ctx.service, "a", "pref.secret").version, 1);
  assert.ok(ctx.service.listExcludedSources("a").includes(sha256("legacy-source")));

  // 旧禁分享控制迁入身份：换键后的同身份副本也不能绕过。
  const secretCopy = ctx.service.remember({
    characterId: "b",
    factKey: "pref.secret.copy",
    body: "用户喜欢薄荷糖",
    kind: "preference",
    sourceId: "b-secret-copy",
  });
  assert.equal(identityOf(ctx.db, "b", "pref.secret.copy"), identityOf(ctx.db, "a", "pref.secret"));
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "b",
        toCharacterId: "d",
        entries: [{ entryId: secretCopy.entry.id, expectedVersion: 1 }],
      }),
    hasCode("SHARE_BLOCKED"),
  );

  // 旧忘记控制迁入身份（历史库中可能对应显式重学后仍在的条目）：
  // 先按同身份幂等复用，不重复插入。
  const keptEntry = entryOf(ctx.service, "a", "pref.kept");
  const keptIdentity = identityOf(ctx.db, "a", "pref.kept");
  assert.equal(
    ctx.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_forget_identity_controls
      WHERE character_id = 'a' AND identity_id = ?
    `).get(keptIdentity).count,
    1,
  );
  const keptRecall = ctx.service.remember({
    characterId: "a",
    factKey: "pref.kept.new",
    body: "用户记得旧暗号是青石",
    kind: "preference",
    sourceId: "kept-new-source",
  });
  assert.equal(keptRecall.created, false);
  assert.equal(keptRecall.conflict, undefined);
  assert.equal(keptRecall.entry.id, keptEntry.id);
  assert.equal(entryOf(ctx.service, "a", "pref.kept.new"), null);

  // 该条目真正删除后，同正文换键重学仍被身份控制与删除指纹阻断。
  ctx.service.forget({
    characterId: "a",
    entryId: keptEntry.id,
    expectedVersion: keptEntry.version,
    scope: "self",
  });
  const keptAfterForget = ctx.service.remember({
    characterId: "a",
    factKey: "pref.kept.after",
    body: "用户记得旧暗号是青石",
    kind: "preference",
    sourceId: "kept-after-source",
  });
  assert.equal(keptAfterForget.created, false);
  assert.equal(keptAfterForget.blocked, "forget");

  // 无对应条目的旧控制保留为键级兼容保护。
  const orphanControl = ctx.db.prepare(`
    SELECT identity_id FROM memory_forget_controls
    WHERE character_id = 'a' AND fact_key_hash = ?
  `).get(sha256("pref.orphan"));
  assert.equal(orphanControl.identity_id, null);
  const orphanRecall = ctx.service.remember({
    characterId: "a",
    factKey: "pref.orphan",
    body: "用户想重新说起旧暗号",
    kind: "preference",
    sourceId: "orphan-new-source",
  });
  assert.equal(orphanRecall.created, false);
  assert.equal(orphanRecall.blocked, "forget");

  // 重复迁移不新增身份，也不改变条目归属。
  const identitiesBefore = countRows(ctx.db, "memory_fact_identities");
  const assignmentsBefore = ctx.db.prepare(`
    SELECT id, fact_identity_id FROM memory_entries ORDER BY id
  `).all();
  ctx.reopen();
  assert.equal(countRows(ctx.db, "memory_fact_identities"), identitiesBefore);
  assert.deepEqual(
    ctx.db.prepare("SELECT id, fact_identity_id FROM memory_entries ORDER BY id").all(),
    assignmentsBefore,
  );
  assert.equal(identityOf(ctx.db, "b", "exp.chain"), aIdentity);

  // 删除后身份相关表不保留明文正文或事实键。
  ctx.service.rebuildSearchIndex();
  ctx.service.forget({ characterId: "a", factKey: "pref.secret" });
  const identityTableText = JSON.stringify(
    [
      "memory_fact_identities",
      "memory_fact_aliases",
      "memory_fact_alias_conflicts",
      "memory_forget_identity_controls",
      "memory_share_identity_controls",
      "memory_deleted_fact_fingerprints",
      "memory_forget_controls",
      "memory_share_controls",
      "memory_source_controls",
    ].map((table) => ctx.db.prepare(`SELECT * FROM ${table}`).all()),
  );
  assert.equal(identityTableText.includes("薄荷糖"), false);
  assert.equal(identityTableText.includes("pref.secret"), false);
  assert.equal(identityTableText.includes("用户喜欢薄荷糖"), false);
});

test("POL-FACTID-005 迁移中途失败完整回滚 DDL 与业务行，调用者事务可回滚", (t) => {
  const dir = makeLegacyDirectory(t, ["a", "b"], (db) => {
    insertLegacyEntry(db, {
      id: "legacy-a",
      characterId: "a",
      factKey: "pref.a",
      body: "用户喜欢旧茶",
      kind: "preference",
      sourceId: "legacy-a",
    });
    insertLegacyEntry(db, {
      id: "legacy-b",
      characterId: "b",
      factKey: "pref.b",
      body: "用户喜欢旧茶",
      kind: "preference",
      sourceId: "legacy-b",
    });
    db.prepare(`
      INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256("pref.a"), START);
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let db = openMemoryDatabase(dir);
  const schemaBefore = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name
  `).all();
  const rowsBefore = db.prepare(`
    SELECT id, character_id, fact_key, body, version, source_id
    FROM memory_entries ORDER BY id
  `).all();
  function columnNames(table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  }
  const columnsBefore = {
    entries: columnNames("memory_entries"),
    forget: columnNames("memory_forget_controls"),
    share: columnNames("memory_share_controls"),
  };

  const IDENTITY_TABLES = [
    "memory_fact_identities",
    "memory_fact_aliases",
    "memory_fact_alias_conflicts",
    "memory_forget_identity_controls",
    "memory_share_identity_controls",
    "memory_deleted_fact_fingerprints",
  ];
  function selectEntryRows() {
    return db.prepare(`
      SELECT id, character_id, fact_key, body, version, source_id
      FROM memory_entries ORDER BY id
    `).all();
  }
  function assertIdentityDdlAbsent() {
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name IN (${IDENTITY_TABLES.map(() => "?").join(", ")})
      `).get(...IDENTITY_TABLES).count,
      0,
    );
    assert.equal(columnNames("memory_entries").includes("fact_identity_id"), false);
    for (const table of ["memory_forget_controls", "memory_share_controls"]) {
      const columns = columnNames(table);
      assert.equal(columns.includes("identity_id"), false);
      assert.equal(columns.includes("identity_migrated"), false);
    }
  }
  const createFailingTrigger = () => db.exec(`
    CREATE TRIGGER fail_legacy_identity BEFORE UPDATE ON memory_entries
    WHEN OLD.id = 'legacy-b' AND OLD.fact_identity_id IS NULL
      AND NEW.fact_identity_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'injected legacy identity failure'); END;
  `);

  // 调用者已有事务时，先在外层事务仍活跃时验证内层保存点已回滚 DDL 与
  // 业务行，而外层探针仍在；之后再由调用者整体回滚。
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)")
    .run("migration_probe", "present");
  createFailingTrigger();
  assert.throws(
    () => createMemoryService({ db, now: () => START }),
    /injected legacy identity failure/u,
  );
  assertIdentityDdlAbsent();
  assert.deepEqual(selectEntryRows(), rowsBefore);
  assert.equal(
    db.prepare("SELECT value FROM app_state WHERE key = 'migration_probe'").get().value,
    "present",
  );
  db.exec("ROLLBACK");

  // 外层回滚后，schema、列清单、业务行与外层探针全部恢复。
  assert.deepEqual(
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    schemaBefore,
  );
  assert.deepEqual(
    {
      entries: columnNames("memory_entries"),
      forget: columnNames("memory_forget_controls"),
      share: columnNames("memory_share_controls"),
    },
    columnsBefore,
  );
  assert.deepEqual(selectEntryRows(), rowsBefore);
  assert.equal(
    db.prepare("SELECT value FROM app_state WHERE key = 'migration_probe'").get(),
    undefined,
  );

  // 没有外层事务时同样整体回滚；故障移除后可完整重试。
  createFailingTrigger();
  assert.throws(
    () => createMemoryService({ db, now: () => START }),
    /injected legacy identity failure/u,
  );
  assertIdentityDdlAbsent();
  assert.deepEqual(selectEntryRows(), rowsBefore);
  db.exec("DROP TRIGGER fail_legacy_identity");

  const service = createMemoryService({ db, now: () => START });
  assert.ok(identityOf(db, "a", "pref.a"));
  assert.equal(identityOf(db, "a", "pref.a"), identityOf(db, "b", "pref.b"));
  assert.equal(service.listMemories("a")[0].body, "用户喜欢旧茶");
  db.close();
});

test("POL-FACTID-005 已处理旧控制不会重启后重新归因到同键新身份", (t) => {
  const ctx = makeLegacyContext(t, (db) => {
    insertLegacyEntry(db, {
      id: "legacy-slot-a",
      characterId: "a",
      factKey: "pref.slot",
      body: "用户记得旧内容",
      kind: "preference",
      sourceId: "legacy-slot",
    });
    db.prepare(`
      INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at)
      VALUES (?, ?, ?)
    `).run("a", sha256("pref.slot"), START);
  });
  const migratedIdentity = identityOf(ctx.db, "a", "pref.slot");
  assert.ok(migratedIdentity);

  // 旧控制已迁入身份；显式新许可可重新学习完全不同的正文，得到新身份。
  const legacyEntry = entryOf(ctx.service, "a", "pref.slot");
  ctx.service.forget({
    characterId: "a",
    entryId: legacyEntry.id,
    expectedVersion: legacyEntry.version,
  });
  const relearned = ctx.service.remember({
    characterId: "a",
    factKey: "pref.slot",
    body: "用户后来改说另一种内容",
    kind: "preference",
    sourceId: "new-slot-source",
    explicitConsent: true,
  });
  assert.equal(relearned.created, true);
  const newIdentity = identityOf(ctx.db, "a", "pref.slot");
  assert.notEqual(newIdentity, migratedIdentity);

  const controlsBefore = ctx.db.prepare(`
    SELECT identity_id FROM memory_forget_identity_controls
    WHERE character_id = 'a' ORDER BY identity_id
  `).all();
  assert.deepEqual(
    controlsBefore.map((row) => row.identity_id),
    [migratedIdentity],
  );

  // 重启时旧控制已标记处理，不能按当前键把新身份也纳入旧忘记范围。
  ctx.reopen();
  assert.deepEqual(
    ctx.db.prepare(`
      SELECT identity_id FROM memory_forget_identity_controls
      WHERE character_id = 'a' ORDER BY identity_id
    `).all().map((row) => row.identity_id),
    [migratedIdentity],
  );
});

test("POL-FACTID-006 同键冲突明确且零覆盖，同身份异键幂等不重复", (t) => {
  const ctx = makeContext(t);
  const aEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.dup",
    body: "用户喜欢桂花茶",
    kind: "preference",
    sourceId: "a-dup",
  });
  const conflict = ctx.service.remember({
    characterId: "a",
    factKey: "pref.dup",
    body: "用户喜欢乌龙茶",
    kind: "preference",
    sourceId: "a-dup-conflict",
  });
  assert.equal(conflict.created, false);
  assert.equal(conflict.conflict, "fact_key_body");
  assert.equal(conflict.entry.id, aEntry.entry.id);
  assert.equal(conflict.entry.body, "用户喜欢桂花茶");
  assert.equal(entryOf(ctx.service, "a", "pref.dup").body, "用户喜欢桂花茶");
  assert.equal(entryOf(ctx.service, "a", "pref.dup").version, 1);
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "桂花" }).length, 1);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "a", query: "乌龙" }), []);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE character_id = 'a'").get().count,
    1,
  );

  // 批量提炼同样保留旧内容，只写入不冲突的部分。
  const batch = ctx.service.applyExtractionBatch({
    characterId: "a",
    sourceId: "a-batch",
    sourceVersion: 1,
    facts: [
      { factKey: "pref.dup", body: "用户喜欢乌龙茶", kind: "preference" },
      { factKey: "detail.cup", body: "用户有一只青色杯子", kind: "detail" },
    ],
  });
  assert.equal(batch.applied, true);
  assert.equal(batch.facts[0].created, false);
  assert.equal(batch.facts[0].conflict, "fact_key_body");
  assert.equal(batch.facts[1].created, true);
  assert.equal(entryOf(ctx.service, "a", "pref.dup").body, "用户喜欢桂花茶");

  // 同键同正文但元数据不同：明确冲突，保留旧条目，不静默当作已持有。
  const metaEntry = ctx.service.remember({
    characterId: "a",
    factKey: "pref.meta",
    body: "用户喜欢洛神花茶",
    kind: "preference",
    sourceId: "a-meta",
  });
  const metadataConflicts = [
    ctx.service.remember({
      characterId: "a",
      factKey: "pref.meta",
      body: "用户喜欢洛神花茶",
      kind: "detail",
      sourceId: "a-meta-kind",
    }),
    ctx.service.remember({
      characterId: "a",
      factKey: "pref.meta",
      body: "用户喜欢洛神花茶",
      kind: "preference",
      sourceKind: "theme",
      sourceId: "a-meta-source-kind",
    }),
    ctx.service.remember({
      characterId: "a",
      factKey: "pref.meta",
      body: "用户喜欢洛神花茶",
      kind: "preference",
      expiresAt: ctx.nowMs() + 60_000,
      sourceId: "a-meta-expiry",
    }),
    ctx.service.remember({
      characterId: "a",
      factKey: "pref.meta",
      body: "用户喜欢洛神花茶",
      kind: "preference",
      trust: "inferred",
      sourceId: "a-meta-trust",
    }),
  ];
  for (const conflictResult of metadataConflicts) {
    assert.equal(conflictResult.created, false);
    assert.equal(conflictResult.conflict, "fact_key_metadata");
    assert.equal(conflictResult.entry.id, metaEntry.entry.id);
  }
  const duplicateMeta = ctx.service.remember({
    characterId: "a",
    factKey: "pref.meta",
    body: "用户喜欢洛神花茶",
    kind: "preference",
    sourceId: "a-meta-duplicate",
  });
  assert.equal(duplicateMeta.created, false);
  assert.equal(duplicateMeta.conflict, undefined);
  assert.equal(duplicateMeta.entry.id, metaEntry.entry.id);
  assert.equal(
    ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE character_id = 'a' AND fact_key = 'pref.meta'",
    ).get().count,
    1,
  );
  const metadataBatch = ctx.service.applyExtractionBatch({
    characterId: "a",
    sourceId: "a-meta-batch",
    sourceVersion: 1,
    facts: [{ factKey: "pref.meta", body: "用户喜欢洛神花茶", kind: "detail" }],
  });
  assert.equal(metadataBatch.applied, true);
  assert.equal(metadataBatch.facts[0].created, false);
  assert.equal(metadataBatch.facts[0].conflict, "fact_key_metadata");
  assert.equal(entryOf(ctx.service, "a", "pref.meta").kind, "preference");

  // 接收者同键不同身份：不能声称 alreadyHeld 或覆盖。
  const bEntry = ctx.service.remember({
    characterId: "b",
    factKey: "pref.dup",
    body: "用户的姐姐喜欢玫瑰花茶",
    kind: "preference",
    sourceId: "b-dup",
  });
  assert.notEqual(identityOf(ctx.db, "a", "pref.dup"), identityOf(ctx.db, "b", "pref.dup"));
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "a",
        toCharacterId: "b",
        entries: [{ entryId: aEntry.entry.id, expectedVersion: 1 }],
      }),
    hasCode("SHARE_CONFLICT"),
  );
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "a",
        toCharacterId: "b",
        entryIds: [aEntry.entry.id],
      }),
    hasCode("SHARE_CONFLICT"),
  );
  assert.equal(entryOf(ctx.service, "b", "pref.dup").id, bEntry.entry.id);
  assert.equal(entryOf(ctx.service, "b", "pref.dup").body, "用户的姐姐喜欢玫瑰花茶");
  assert.equal(entryOf(ctx.service, "b", "pref.dup").version, 1);

  // 同角色同身份不同 key 的新 remember/extraction 复用已有条目，不重复插入。
  const second = ctx.service.remember({
    characterId: "a",
    factKey: "pref.dup.two",
    body: "用户喜欢桂花茶",
    kind: "preference",
    sourceId: "a-dup-two",
  });
  assert.equal(second.created, false);
  assert.equal(second.conflict, undefined);
  assert.equal(second.entry.id, aEntry.entry.id);
  assert.equal(entryOf(ctx.service, "a", "pref.dup.two"), null);
  const duplicateBatch = ctx.service.applyExtractionBatch({
    characterId: "a",
    sourceId: "a-dup-batch",
    sourceVersion: 1,
    facts: [
      { factKey: "pref.dup.three", body: "用户喜欢桂花茶", kind: "preference" },
    ],
  });
  assert.equal(duplicateBatch.applied, true);
  assert.equal(duplicateBatch.facts[0].created, false);
  assert.equal(entryOf(ctx.service, "a", "pref.dup.three"), null);

  // 接收者已在异键持有同一身份：复用已有副本，不重复插入。
  const cEntry = ctx.service.remember({
    characterId: "c",
    factKey: "pref.dup.other",
    body: "用户喜欢桂花茶",
    kind: "preference",
    sourceId: "c-dup",
  });
  assert.equal(cEntry.created, true);
  assert.equal(identityOf(ctx.db, "a", "pref.dup"), identityOf(ctx.db, "c", "pref.dup.other"));
  const shared = ctx.service.share({
    fromCharacterId: "a",
    toCharacterId: "c",
    entryIds: [aEntry.entry.id],
  });
  assert.equal(shared.shared[0].alreadyHeld, true);
  assert.equal(shared.shared[0].entryId, cEntry.entry.id);
  assert.equal(
    ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE character_id = 'c'",
    ).get().count,
    1,
  );

  // 普通聊天/批量保存后，既有管理页投影仍按条目工作。
  const page = ctx.service.listMemoriesPage("a");
  assert.equal(page.hasMore, false);
  assert.equal(page.entries.some((entry) => entry.body === "用户喜欢乌龙茶"), false);
  assert.equal(page.entries.some((entry) => entry.body === "用户喜欢桂花茶"), true);
  assert.equal(JSON.stringify(page).includes("玫瑰花茶"), false);
  for (const entry of page.entries) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.version, "number");
    assert.equal(typeof entry.sharingRestricted, "boolean");
  }
});

test("POL-FACTID-006 身份写入失败与业务写入同事务回滚", (t) => {
  const ctx = makeContext(t);
  ctx.db.exec(`
    CREATE TRIGGER fail_new_identity BEFORE INSERT ON memory_fact_identities
    BEGIN SELECT RAISE(ABORT, 'injected identity insert failure'); END;
  `);
  assert.throws(
    () =>
      ctx.service.remember({
        characterId: "a",
        factKey: "pref.atomic",
        body: "用户喜欢陈皮茶",
        kind: "preference",
        sourceId: "a-atomic",
      }),
    /injected identity insert failure/u,
  );
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 0);
  assert.equal(countRows(ctx.db, "memory_fact_identities"), 0);
  assert.equal(countRows(ctx.db, "memory_fact_aliases"), 0);

  ctx.db.exec("DROP TRIGGER fail_new_identity");
  const created = ctx.service.remember({
    characterId: "a",
    factKey: "pref.atomic",
    body: "用户喜欢陈皮茶",
    kind: "preference",
    sourceId: "a-atomic",
  });
  assert.equal(created.created, true);
  assert.ok(identityOf(ctx.db, "a", "pref.atomic"));
  assert.equal(entryOf(ctx.service, "a", "pref.atomic").body, "用户喜欢陈皮茶");
});

test("POL-FACTID-004 迁移三派生同指纹歧义不遗漏第三身份", (t) => {
  const sharedBody = "用户喜欢洛神花茶";
  const ctx = makeLegacyContext(
    t,
    (db) => {
      const parents = [
        ["legacy-parent-1", "用户和角色在春日爬过山"],
        ["legacy-parent-2", "用户和角色在夏夜看过海"],
        ["legacy-parent-3", "用户和角色在秋天走过长街"],
      ];
      for (const [id, body] of parents) {
        insertLegacyEntry(db, {
          id,
          characterId: "d",
          factKey: `exp.${id}`,
          body,
          kind: "experience",
          sourceId: id,
        });
      }
      const children = [
        ["legacy-child-a", "a", "pref.child.a", "legacy-parent-1"],
        ["legacy-child-b", "b", "pref.child.b", "legacy-parent-2"],
        ["legacy-child-c", "c", "pref.child.c", "legacy-parent-3"],
      ];
      for (const [id, characterId, factKey, parentEntryId] of children) {
        insertLegacyEntry(db, {
          id,
          characterId,
          factKey,
          body: sharedBody,
          kind: "preference",
          sourceId: `share:${parentEntryId}:${characterId}`,
          derivedFromEntryId: parentEntryId,
          originCharacterId: "d",
        });
        insertLegacyDerivation(db, {
          entryId: id,
          parentEntryId,
          originCharacterId: "d",
          narratorCharacterId: "d",
        });
      }
    },
    ["a", "b", "c", "d", "e", "f"],
  );

  const childKeys = [
    ["a", "pref.child.a"],
    ["b", "pref.child.b"],
    ["c", "pref.child.c"],
  ];
  const identities = childKeys.map(([characterId, factKey]) =>
    identityOf(ctx.db, characterId, factKey),
  );
  assert.ok(identities.every(Boolean));
  assert.equal(new Set(identities).size, 3, "三条不同父派生链不得被强合并");

  const fingerprint = strictFactFingerprint({
    kind: "preference",
    trust: "stated",
    sourceKind: "user",
    expiresAt: null,
    body: sharedBody,
  });
  const relatedAtMigration = new Set([
    ctx.db.prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(fingerprint)?.identity_id,
    ...ctx.db.prepare("SELECT identity_id FROM memory_fact_alias_conflicts WHERE fingerprint = ?")
      .all(fingerprint)
      .map((row) => row.identity_id),
  ].filter(Boolean));

  // 运行时新持有者会因别名歧义获得新身份，但仍属于同一指纹组。
  const fCopy = ctx.service.remember({
    characterId: "f",
    factKey: "pref.shared-copy",
    body: sharedBody,
    kind: "preference",
    sourceId: "f-shared-copy",
  });
  assert.equal(fCopy.created, true);

  // 限制第三身份后，其他同指纹身份的 relay/share 都必须拒绝。
  const cEntry = entryOf(ctx.service, "c", "pref.child.c");
  ctx.service.restrictSharing({
    characterId: "c",
    entryId: cEntry.id,
    expectedVersion: 1,
  });
  const aEntry = entryOf(ctx.service, "a", "pref.child.a");
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "a",
        toCharacterId: "e",
        entries: [{ entryId: aEntry.id, expectedVersion: aEntry.version }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "f",
        toCharacterId: "e",
        entryIds: [fCopy.entry.id],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("e"), []);

  // 迁移必须把第三个身份也登记进同一指纹的歧义组。
  for (const identityId of identities) {
    assert.ok(
      relatedAtMigration.has(identityId),
      "三派生身份都应出现在同一指纹的歧义组",
    );
  }

  // 纠正第一条派生只沿自己的身份传播，另外两条保持原样。
  const corrected = ctx.service.correct({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: 1,
    body: "用户后来改说喜欢白茶",
    sourceId: "a-child-correction",
  });
  assert.ok(corrected.updated >= 1);
  assert.equal(entryOf(ctx.service, "a", "pref.child.a").body, "用户后来改说喜欢白茶");
  assert.equal(entryOf(ctx.service, "b", "pref.child.b").body, sharedBody);
  assert.equal(entryOf(ctx.service, "c", "pref.child.c").body, sharedBody);
  assert.equal(entryOf(ctx.service, "b", "pref.child.b").version, 1);
  assert.equal(entryOf(ctx.service, "c", "pref.child.c").version, 1);

  // 重启后第三身份的禁分享仍覆盖同指纹的其它身份。
  ctx.reopen();
  const bEntry = entryOf(ctx.service, "b", "pref.child.b");
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "b",
        toCharacterId: "e",
        entries: [{ entryId: bEntry.id, expectedVersion: bEntry.version }],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("e"), []);
});
