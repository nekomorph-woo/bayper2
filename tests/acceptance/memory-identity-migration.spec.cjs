/* S03l 存量误合身份组迁移验收：真实 SQLite、真实 store/memory 入口，构造旧
   身份/别名/控制/派生/关系边；不启动 GUI、不调用模型。覆盖 POL-MIG-001～006。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMemoryService } = require("../../app/memory.cjs");
const {
  factKeyHash,
  identityFingerprint,
  strictFactFingerprint,
} = require("../../app/memory-fact-identity.cjs");
const { tokenizeForIndex } = require("../../app/memory-retrieval.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);
const REPORT_KEY = "memory.identity.migration.v2";

const LEGACY_MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fact_key TEXT NOT NULL,
    fact_identity_id TEXT,
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
  CREATE INDEX IF NOT EXISTS memory_entries_fact_key ON memory_entries (fact_key);
  CREATE INDEX IF NOT EXISTS memory_entries_character
    ON memory_entries (character_id, kind, importance DESC, updated_at DESC);
  CREATE TABLE IF NOT EXISTS memory_forget_controls (
    character_id TEXT NOT NULL,
    fact_key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    identity_id TEXT,
    identity_migrated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, fact_key_hash)
  );
  CREATE TABLE IF NOT EXISTS memory_source_controls (
    character_id TEXT NOT NULL,
    source_id_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash)
  );
  CREATE TABLE IF NOT EXISTS memory_share_controls (
    fact_key_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    identity_id TEXT,
    identity_migrated INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS memory_derivations (
    entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
    parent_entry_id TEXT NOT NULL,
    origin_character_id TEXT NOT NULL,
    narrator_character_id TEXT,
    source_id TEXT,
    source_version INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_extraction_batches (
    character_id TEXT NOT NULL,
    source_id_hash TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash, source_version)
  );
  CREATE TABLE IF NOT EXISTS memory_context_versions (
    character_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_fact_identities (
    identity_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_fact_aliases (
    fingerprint TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_fact_alias_conflicts (
    fingerprint TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (fingerprint, identity_id)
  );
  CREATE TABLE IF NOT EXISTS memory_forget_identity_controls (
    character_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, identity_id)
  );
  CREATE TABLE IF NOT EXISTS memory_share_identity_controls (
    identity_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_deleted_fact_fingerprints (
    character_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, fingerprint)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    entry_id UNINDEXED,
    char_tokens,
    segment_tokens,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

function ensureRelationEdgeTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_fact_relation_edges (
      from_entry_id TEXT NOT NULL,
      to_entry_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('share', 'relay', 'explicit')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_entry_id, to_entry_id, kind)
    );
  `);
}

function insertIdentity(db, identityId, createdAt = START) {
  db.prepare(
    "INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)",
  ).run(identityId, createdAt);
}

function insertEntry(db, entry) {
  const {
    id,
    characterId,
    factKey,
    body,
    factIdentityId,
    kind = "preference",
    trust = "stated",
    sourceKind = "user",
    importance = 50,
    expiresAt = null,
    sourceId,
    sourceVersion = 1,
    version = 1,
    originCharacterId = characterId,
    createdAt = START,
  } = entry;
  db.prepare(`
    INSERT INTO memory_entries (
      id, character_id, fact_key, fact_identity_id, origin_character_id,
      derived_from_entry_id, kind, body, trust, source_kind, importance,
      expires_at, source_id, source_version, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    characterId,
    factKey,
    factIdentityId,
    originCharacterId,
    kind,
    body,
    trust,
    sourceKind,
    importance,
    expiresAt,
    sourceId,
    sourceVersion,
    version,
    createdAt,
    createdAt,
  );
  const tokens = tokenizeForIndex(body);
  db.prepare(
    "INSERT INTO memory_fts (entry_id, char_tokens, segment_tokens) VALUES (?, ?, ?)",
  ).run(id, tokens.charTokens, tokens.segmentTokens);
  return { ...entry, originCharacterId };
}

function insertDerivation(db, entryId, parentEntryId, originCharacterId, narrator = null) {
  const entry = db.prepare(
    "SELECT source_id, source_version FROM memory_entries WHERE id = ?",
  ).get(entryId);
  db.prepare(`
    INSERT OR REPLACE INTO memory_derivations (
      entry_id, parent_entry_id, origin_character_id, narrator_character_id,
      source_id, source_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId,
    parentEntryId,
    originCharacterId,
    narrator,
    entry?.source_id ?? null,
    entry?.source_version ?? null,
    START,
  );
}

function insertShareControl(db, identityId) {
  db.prepare(
    "INSERT OR IGNORE INTO memory_share_identity_controls (identity_id, created_at) VALUES (?, ?)",
  ).run(identityId, START);
}

function insertForgetControl(db, characterId, identityId) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_forget_identity_controls (
      character_id, identity_id, created_at
    ) VALUES (?, ?, ?)
  `).run(characterId, identityId, START);
}

function insertAlias(db, fingerprint, identityId) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_fact_aliases (fingerprint, identity_id, created_at)
    VALUES (?, ?, ?)
  `).run(fingerprint, identityId, START);
}

function insertRelationEdge(db, fromEntryId, toEntryId, kind) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_fact_relation_edges (
      from_entry_id, to_entry_id, kind, created_at
    ) VALUES (?, ?, ?, ?)
  `).run(fromEntryId, toEntryId, kind, START);
}

function insertDeletedFingerprint(db, characterId, entry) {
  const fingerprint = strictFactFingerprint({
    kind: entry.kind ?? "preference",
    trust: entry.trust ?? "stated",
    sourceKind: entry.sourceKind ?? "user",
    expiresAt: entry.expiresAt ?? null,
    body: entry.body,
  });
  db.prepare(`
    INSERT OR IGNORE INTO memory_deleted_fact_fingerprints (
      character_id, fingerprint, created_at
    ) VALUES (?, ?, ?)
  `).run(characterId, fingerprint, START);
}

function cleanupAtEnd(t, dir, holder) {
  t.after(() => {
    try {
      holder.db?.close();
    } catch {
      // 失败路径可能已关闭。
    }
    holder.db = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function makeLegacyBase(t, seed, characters = ["a", "b", "c", "d"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-mig-legacy-"));
  const holder = { db: null };
  cleanupAtEnd(t, dir, holder);
  createMemoryDatabase(dir, characters).db.close();
  holder.db = openMemoryDatabase(dir);
  try {
    holder.db.exec(LEGACY_MEMORY_SCHEMA);
    seed(holder.db);
  } finally {
    holder.db.close();
    holder.db = null;
  }
  return { dir, holder };
}

function makeLegacyContext(t, seed, characters = ["a", "b", "c", "d"]) {
  const { dir, holder } = makeLegacyBase(t, seed, characters);
  const current = { service: null };
  const open = () => {
    holder.db = openMemoryDatabase(dir);
    current.service = createMemoryService({ db: holder.db, now: () => START });
  };
  open();
  return {
    dir,
    get db() {
      return holder.db;
    },
    get service() {
      return current.service;
    },
    reopen() {
      holder.db.close();
      holder.db = null;
      open();
    },
  };
}

function makeLegacyRaw(t, seed, characters = ["a", "b", "c", "d"]) {
  const { dir, holder } = makeLegacyBase(t, seed, characters);
  holder.db = openMemoryDatabase(dir);
  return {
    dir,
    get db() {
      return holder.db;
    },
  };
}

function makeFreshContext(t, characters = ["a", "b", "c", "d"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-mig-fresh-"));
  const holder = { db: null };
  cleanupAtEnd(t, dir, holder);
  const created = createMemoryDatabase(dir, characters);
  if (!created?.db || typeof created.db.exec !== "function") {
    throw new Error("测试夹具未返回数据库");
  }
  holder.db = created.db;
  try {
    ensureRelationEdgeTable(holder.db);
  } finally {
    holder.db.close();
    holder.db = null;
  }
  const current = { service: null };
  const open = () => {
    holder.db = openMemoryDatabase(dir);
    current.service = createMemoryService({ db: holder.db, now: () => START });
  };
  open();
  return {
    dir,
    get db() {
      return holder.db;
    },
    get service() {
      return current.service;
    },
    reopen() {
      holder.db.close();
      holder.db = null;
      open();
    },
  };
}

function entryById(db, id) {
  return db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) ?? null;
}

function identityOf(db, id) {
  return entryById(db, id)?.fact_identity_id ?? null;
}

function entryMetaById(db, id) {
  const row = entryById(db, id);
  return {
    body: row.body,
    factKey: row.fact_key,
    kind: row.kind,
    trust: row.trust,
    sourceKind: row.source_kind,
    importance: row.importance,
    expiresAt: row.expires_at,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    originCharacterId: row.origin_character_id,
    createdAt: row.created_at,
  };
}

function versionsOf(db, ids) {
  return Object.fromEntries(ids.map((id) => [id, entryById(db, id)?.version ?? null]));
}

function countRows(db, table, where = "", ...params) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` ${where}` : ""}`)
    .get(...params).count;
}

function reportOf(db) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(REPORT_KEY);
  return row ? JSON.parse(row.value) : null;
}

function relationEdges(db) {
  return db.prepare("SELECT * FROM memory_fact_relation_edges ORDER BY from_entry_id, to_entry_id, kind").all();
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
      .get(name),
  );
}

function fullSnapshot(db) {
  const tables = [
    "memory_entries",
    "memory_fact_identities",
    "memory_fact_aliases",
    "memory_fact_alias_conflicts",
    "memory_forget_identity_controls",
    "memory_share_identity_controls",
    "memory_forget_controls",
    "memory_share_controls",
    "memory_source_controls",
    "memory_deleted_fact_fingerprints",
    "memory_derivations",
    "memory_context_versions",
    "memory_extraction_batches",
    "app_state",
  ];
  if (tableExists(db, "memory_fact_relation_edges")) {
    tables.push("memory_fact_relation_edges");
  }
  for (const table of ["memory_temporary_links", "memory_temporary_entry_links"]) {
    if (tableExists(db, table)) {
      tables.push(table);
    }
  }
  const snapshot = {
    relationTableExists: tableExists(db, "memory_fact_relation_edges"),
    identityColumns: db.prepare("PRAGMA table_info(memory_fact_identities)").all(),
    ddl: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    fts: db.prepare("SELECT entry_id, char_tokens, segment_tokens FROM memory_fts ORDER BY entry_id").all(),
    tables: {},
  };
  for (const table of tables) {
    snapshot.tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  return snapshot;
}

function shareControlCount(db, identityId) {
  return countRows(db, "memory_share_identity_controls", "WHERE identity_id = ?", identityId);
}

function historicalFingerprint(body) {
  return identityFingerprint({
    kind: "preference",
    trust: "stated",
    sourceKind: "user",
    expiresAt: null,
    body,
  });
}

test("POL-MIG-001 多指纹/类别旧组拆分但正文来源FTS不变", (t) => {
  const orphanFingerprint = historicalFingerprint("孤儿历史正文");
  const ctx = makeLegacyContext(t, (db) => {
    insertIdentity(db, "old-merged");
    insertIdentity(db, "keep-d");
    insertIdentity(db, "orphan-id");
    insertShareControl(db, "orphan-id");
    insertForgetControl(db, "a", "orphan-id");
    insertAlias(db, orphanFingerprint, "orphan-id");
    insertEntry(db, {
      id: "e1", characterId: "a", factKey: "pref.a", body: "用户喜欢甜咖啡",
      factIdentityId: "old-merged", sourceId: "a-old", createdAt: START,
    });
    insertEntry(db, {
      id: "e2", characterId: "b", factKey: "pref.b", body: "用户喜欢无糖咖啡",
      factIdentityId: "old-merged", kind: "detail", sourceId: "b-old", createdAt: START + 1,
    });
    insertEntry(db, {
      id: "e3", characterId: "c", factKey: "exp.c", body: "用户去年在海边看日出",
      factIdentityId: "old-merged", kind: "experience", sourceId: "c-old", createdAt: START + 2,
    });
    insertEntry(db, {
      id: "d1", characterId: "d", factKey: "pref.d", body: "用户喜欢白茶",
      factIdentityId: "keep-d", sourceId: "d-old", createdAt: START + 3,
    });
  });

  const a = identityOf(ctx.db, "e1");
  const b = identityOf(ctx.db, "e2");
  const c = identityOf(ctx.db, "e3");
  assert.equal(a, "old-merged", "锚组件保留旧 identity");
  assert.notEqual(b, a);
  assert.notEqual(c, a);
  assert.notEqual(b, c);
  assert.equal(identityOf(ctx.db, "d1"), "keep-d");
  assert.equal(entryById(ctx.db, "e2").body, "用户喜欢无糖咖啡");
  assert.equal(entryById(ctx.db, "e2").source_id, "b-old");
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "甜咖啡" }).length, 1);
  const report = reportOf(ctx.db);
  assert.ok(report);
  for (const identity of [a, b, c]) {
    assert.ok(report.needsReverification.includes(identity));
  }
  assert.deepEqual(versionsOf(ctx.db, ["e1", "e2", "e3"]), { e1: 2, e2: 2, e3: 2 });
  assert.equal(entryById(ctx.db, "d1").version, 1);
  assert.equal(ctx.db.prepare("SELECT version FROM memory_context_versions WHERE character_id = 'a'").get().version, 1);

  // 无条目、无映射目标的孤儿 identity/控制/alias 不得因空壳被删除。
  assert.equal(
    countRows(ctx.db, "memory_fact_identities", "WHERE identity_id = ?", "orphan-id"),
    1,
  );
  assert.equal(shareControlCount(ctx.db, "orphan-id"), 1);
  assert.equal(
    countRows(
      ctx.db,
      "memory_forget_identity_controls",
      "WHERE character_id = 'a' AND identity_id = ?",
      "orphan-id",
    ),
    1,
  );
  assert.equal(
    ctx.db.prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(orphanFingerprint).identity_id,
    "orphan-id",
  );
  assert.equal(tableExists(ctx.db, "memory_fact_relation_edges"), true);

  const snapshot = {
    identities: ["e1", "e2", "e3"].map((id) => identityOf(ctx.db, id)),
    versions: versionsOf(ctx.db, ["e1", "e2", "e3", "d1"]),
  };
  ctx.reopen();
  assert.deepEqual({
    identities: ["e1", "e2", "e3"].map((id) => identityOf(ctx.db, id)),
    versions: versionsOf(ctx.db, ["e1", "e2", "e3", "d1"]),
  }, snapshot);
});

test("POL-MIG-002 断根/缺失父与持久关系边保留，删除不召回正文", (t) => {
  const ctx = makeLegacyContext(t, (db) => {
    insertIdentity(db, "old-chain");
    insertEntry(db, {
      id: "c1", characterId: "a", factKey: "exp.c", body: "用户听过山雾",
      factIdentityId: "old-chain", kind: "experience", sourceId: "c-old", createdAt: START,
    });
    insertDerivation(db, "c1", "b-deleted", "a");
    insertIdentity(db, "old-e");
    insertIdentity(db, "old-f");
    insertEntry(db, {
      id: "e1", characterId: "b", factKey: "exp.e", body: "用户和角色看过海",
      factIdentityId: "old-e", kind: "experience", sourceId: "e-old", createdAt: START + 1,
    });
    insertEntry(db, {
      id: "f1", characterId: "c", factKey: "exp.f", body: "用户和角色看过海",
      factIdentityId: "old-f", kind: "experience", sourceId: "f-old", createdAt: START + 2,
    });
    insertDerivation(db, "e1", "p-deleted", "b");
    insertDerivation(db, "f1", "p-deleted", "c");
    insertIdentity(db, "old-g");
    insertIdentity(db, "old-h");
    insertEntry(db, {
      id: "g1", characterId: "a", factKey: "pref.g", body: "用户喜欢青茶",
      factIdentityId: "old-g", sourceId: "g-old", createdAt: START + 3,
    });
    insertEntry(db, {
      id: "h1", characterId: "b", factKey: "pref.h", body: "用户喜欢青茶",
      factIdentityId: "old-h", sourceId: "h-old", createdAt: START + 4,
    });
    ensureRelationEdgeTable(db);
    insertRelationEdge(db, "g1", "h1", "explicit");
    insertShareControl(db, "old-g");
  });

  assert.equal(identityOf(ctx.db, "c1"), "old-chain");
  assert.ok(reportOf(ctx.db).needsReverification.includes("old-chain"));
  assert.equal(identityOf(ctx.db, "e1"), identityOf(ctx.db, "f1"));
  assert.equal(identityOf(ctx.db, "g1"), identityOf(ctx.db, "h1"));
  assert.notEqual(identityOf(ctx.db, "e1"), "old-chain");
  assert.equal(
    relationEdges(ctx.db).some(
      (edge) => edge.from_entry_id === "g1" && edge.to_entry_id === "h1" && edge.kind === "explicit",
    ),
    true,
  );
  assert.equal(
    ctx.db.prepare("SELECT created_at FROM memory_share_identity_controls WHERE identity_id = ?")
      .get(identityOf(ctx.db, "g1")).created_at,
    START,
  );
  const expectedMeta = {
    c1: { factKey: "exp.c", body: "用户听过山雾", kind: "experience", sourceId: "c-old", originCharacterId: "a", createdAt: START, importance: 50 },
    e1: { factKey: "exp.e", body: "用户和角色看过海", kind: "experience", sourceId: "e-old", originCharacterId: "b", createdAt: START + 1, importance: 50 },
    f1: { factKey: "exp.f", body: "用户和角色看过海", kind: "experience", sourceId: "f-old", originCharacterId: "c", createdAt: START + 2, importance: 50 },
    g1: { factKey: "pref.g", body: "用户喜欢青茶", kind: "preference", sourceId: "g-old", originCharacterId: "a", createdAt: START + 3, importance: 50 },
    h1: { factKey: "pref.h", body: "用户喜欢青茶", kind: "preference", sourceId: "h-old", originCharacterId: "b", createdAt: START + 4, importance: 50 },
  };
  for (const [id, expected] of Object.entries(expectedMeta)) {
    const meta = entryMetaById(ctx.db, id);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(meta[key], value);
    }
    assert.equal(meta.sourceVersion, 1);
    assert.equal(meta.trust, "stated");
    assert.equal(meta.sourceKind, "user");
    assert.equal(meta.expiresAt, null);
  }
  assert.throws(
    () => ctx.service.relay({
      fromCharacterId: "a", toCharacterId: "c",
      entries: [{ entryId: "g1", expectedVersion: 1 }],
    }),
    (error) => error.code === "MEMORY_CHANGED",
  );

  const aNew = ctx.service.remember({
    characterId: "a", factKey: "pref.new", body: "用户喜欢新茶",
    kind: "preference", sourceId: "a-new",
  });
  const bShared = ctx.service.share({
    fromCharacterId: "a", toCharacterId: "b", entryIds: [aNew.entry.id], sourceId: "share-a-b",
  });
  const bId = bShared.shared[0].entryId;
  const cShared = ctx.service.relay({
    fromCharacterId: "b", toCharacterId: "c",
    entries: [{ entryId: bId, expectedVersion: 1 }],
  });
  const cId = cShared.shared[0].entryId;
  assert.deepEqual(
    relationEdges(ctx.db).map((edge) => edge.kind).sort(),
    ["explicit", "relay", "share"],
  );
  const groupIdentity = identityOf(ctx.db, aNew.entry.id);
  assert.equal(identityOf(ctx.db, cId), groupIdentity);

  ctx.service.forget({ characterId: "b", entryId: bId, expectedVersion: 1, scope: "self" });
  assert.equal(entryById(ctx.db, bId), null);
  assert.equal(countRows(ctx.db, "memory_fts", "WHERE entry_id = ?", bId), 0);
  assert.deepEqual(
    relationEdges(ctx.db).map((edge) => edge.kind).sort(),
    ["explicit", "relay", "share"],
  );
  assert.equal(identityOf(ctx.db, aNew.entry.id), groupIdentity);
  assert.equal(identityOf(ctx.db, cId), groupIdentity);
  ctx.reopen();
  assert.equal(identityOf(ctx.db, aNew.entry.id), groupIdentity);
  assert.equal(identityOf(ctx.db, cId), groupIdentity);
});

test("POL-MIG-003 拆分组件控制互不放开、精确解除与forget不解除", (t) => {
  const historical = historicalFingerprint("用户以前喜欢历史桂花");
  const ctx = makeLegacyContext(t, (db) => {
    insertIdentity(db, "old-ctl");
    insertEntry(db, {
      id: "a1", characterId: "a", factKey: "pref.ctl.a", body: "用户喜欢桂花茶",
      factIdentityId: "old-ctl", sourceId: "a-old", createdAt: START,
    });
    insertEntry(db, {
      id: "b1", characterId: "b", factKey: "pref.ctl.b", body: "用户喜欢桂花茶",
      factIdentityId: "old-ctl", sourceId: "b-old", createdAt: START + 1,
    });
    insertShareControl(db, "old-ctl");
    insertForgetControl(db, "a", "old-ctl");
    insertAlias(db, historical, "old-ctl");
    insertDeletedFingerprint(db, "a", {
      kind: "preference", trust: "stated", sourceKind: "user", body: "用户喜欢桂花茶",
    });
  });

  const aId = identityOf(ctx.db, "a1");
  const bId = identityOf(ctx.db, "b1");
  assert.equal(aId, "old-ctl");
  assert.notEqual(bId, aId);
  assert.equal(shareControlCount(ctx.db, aId), 1);
  assert.equal(shareControlCount(ctx.db, bId), 1);
  assert.equal(
    countRows(ctx.db, "memory_fact_alias_conflicts", "WHERE fingerprint = ? AND identity_id = ?", historical, bId),
    1,
  );

  const aEntry = ctx.service.listMemories("a")[0];
  const liftedA = ctx.service.allowSharing({
    characterId: "a", entryId: aEntry.id, expectedVersion: aEntry.version,
  });
  assert.equal(liftedA.lifted, true);
  assert.equal(shareControlCount(ctx.db, aId), 0);
  assert.equal(shareControlCount(ctx.db, bId), 1);
  assert.throws(
    () => ctx.service.share({ fromCharacterId: "b", toCharacterId: "c", entryIds: [ctx.service.listMemories("b")[0].id] }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  ctx.service.share({ fromCharacterId: "a", toCharacterId: "d", entryIds: [aEntry.id] });

  const restated = ctx.service.restrictSharing({
    characterId: "a", entryId: aEntry.id, expectedVersion: aEntry.version,
  });
  assert.equal(restated.holders.includes("a"), true);
  assert.throws(
    () => ctx.service.share({ fromCharacterId: "a", toCharacterId: "c", entryIds: [aEntry.id] }),
    (error) => error.code === "SHARE_BLOCKED",
  );
  const liftedAgain = ctx.service.allowSharing({
    characterId: "a", entryId: aEntry.id, expectedVersion: aEntry.version,
  });
  assert.equal(liftedAgain.lifted, true);
  assert.equal(shareControlCount(ctx.db, aId), 0);
  assert.equal(shareControlCount(ctx.db, bId), 1);

  const blockedRecall = ctx.service.remember({
    characterId: "a", factKey: "pref.ctl.new", body: "用户喜欢桂花茶",
    kind: "preference", sourceId: "a-new-source",
  });
  assert.equal(blockedRecall.created, false);
  assert.equal(blockedRecall.blocked, "forget");
  const allowedRecall = ctx.service.remember({
    characterId: "a", factKey: "pref.ctl.allowed", body: "用户喜欢桂花茶",
    kind: "preference", sourceId: "a-consented", explicitConsent: true,
  });
  assert.equal(allowedRecall.created, true);

  ctx.reopen();
  assert.equal(shareControlCount(ctx.db, aId), 0);
  assert.equal(shareControlCount(ctx.db, bId), 1);
  assert.throws(
    () => ctx.service.share({ fromCharacterId: "b", toCharacterId: "c", entryIds: [ctx.service.listMemories("b")[0].id] }),
    (error) => error.code === "SHARE_BLOCKED",
  );
});

test("POL-MIG-004 新显式关联持久化，scope self 删 X 且Y/Z同组", (t) => {
  const X_BODY = "用户喜欢喝雪茶";
  const Y_BODY = "用户爱喝雪茶";
  const ctx = makeFreshContext(t, ["a", "b", "c"]);
  const x = ctx.service.remember({
    characterId: "a", factKey: "pref.x", body: X_BODY,
    kind: "preference", sourceId: "x-old",
  });
  const y = ctx.service.remember({
    characterId: "b", factKey: "pref.y", body: Y_BODY,
    kind: "preference", sourceId: "y-old",
  });
  const associated = ctx.service.associateFacts({
    left: { entryId: x.entry.id, expectedVersion: 1 },
    right: { entryId: y.entry.id, expectedVersion: 1 },
  });
  assert.equal(associated.associated, true);
  const groupIdentity = identityOf(ctx.db, x.entry.id);
  assert.equal(identityOf(ctx.db, y.entry.id), groupIdentity);
  const shared = ctx.service.share({
    fromCharacterId: "a", toCharacterId: "c", entryIds: [x.entry.id],
  });
  const zId = shared.shared[0].entryId;
  assert.equal(identityOf(ctx.db, zId), groupIdentity);
  ctx.reopen();
  assert.equal(identityOf(ctx.db, x.entry.id), groupIdentity);
  assert.equal(identityOf(ctx.db, y.entry.id), groupIdentity);

  const xVersion = entryById(ctx.db, x.entry.id).version;
  const removed = ctx.service.forget({
    characterId: "a", entryId: x.entry.id, expectedVersion: xVersion, scope: "self",
  });
  assert.equal(removed.deleted, 1);
  assert.deepEqual(removed.affectedCharacters, ["a"]);
  assert.equal(entryById(ctx.db, x.entry.id), null);
  assert.equal(countRows(ctx.db, "memory_fts", "WHERE entry_id = ?", x.entry.id), 0);
  assert.equal(identityOf(ctx.db, y.entry.id), groupIdentity);
  assert.equal(identityOf(ctx.db, zId), groupIdentity);
  assert.equal(entryById(ctx.db, y.entry.id).body, Y_BODY);
  assert.deepEqual(
    relationEdges(ctx.db).map((edge) => edge.kind).sort(),
    ["explicit", "share"],
  );
  assert.equal(ctx.service.listMemories("a").some((entry) => entry.body === X_BODY), false);
  const recall = ctx.service.remember({
    characterId: "a", factKey: "pref.x", body: X_BODY,
    kind: "preference", sourceId: "x-new",
  });
  assert.equal(recall.created, false);
  assert.equal(recall.blocked, "forget");
  ctx.reopen();
  assert.equal(identityOf(ctx.db, y.entry.id), groupIdentity);
  assert.equal(identityOf(ctx.db, zId), groupIdentity);
  assert.equal(relationEdges(ctx.db).length, 2);
});

function associateIds(ctx, left, right) {
  return ctx.service.associateFacts({
    left: { entryId: left, expectedVersion: entryById(ctx.db, left).version },
    right: { entryId: right, expectedVersion: entryById(ctx.db, right).version },
  });
}

function sourceHash(sourceId) {
  return crypto.createHash("sha256").update(sourceId, "utf8").digest("hex");
}

test("POL-MIG-004 同身份显式确认不把不合格条目变成新证据", (t) => {
  const ctx = makeFreshContext(t, ["a", "b", "c", "d", "e", "f"]);
  const edgeCount = (leftId, rightId) => countRows(
    ctx.db,
    "memory_fact_relation_edges",
    "WHERE (from_entry_id = ? AND to_entry_id = ?) OR (from_entry_id = ? AND to_entry_id = ?)",
    leftId,
    rightId,
    rightId,
    leftId,
  );
  const makePair = (leftCharacter, rightCharacter, prefix, leftBody, rightBody) => {
    const left = ctx.service.remember({
      characterId: leftCharacter, factKey: `${prefix}.x`, body: leftBody,
      kind: "preference", sourceId: `${prefix}-x`,
    });
    const right = ctx.service.remember({
      characterId: rightCharacter, factKey: `${prefix}.y`, body: rightBody,
      kind: "preference", sourceId: `${prefix}-y`,
    });
    associateIds(ctx, left.entry.id, right.entry.id);
    ctx.db.prepare(`
      DELETE FROM memory_fact_relation_edges
      WHERE (from_entry_id = ? AND to_entry_id = ?)
         OR (from_entry_id = ? AND to_entry_id = ?)
    `).run(left.entry.id, right.entry.id, right.entry.id, left.entry.id);
    return { left, right };
  };

  const expired = makePair("a", "b", "pref.expired", "用户喜欢喝雪茶", "用户爱喝雪茶");
  ctx.db.prepare("UPDATE memory_entries SET expires_at = ? WHERE id = ?")
    .run(START - 1, expired.left.entry.id);
  assert.throws(
    () => associateIds(ctx, expired.left.entry.id, expired.right.entry.id),
    (error) => error.code === "ASSOCIATION_REJECTED",
  );
  assert.equal(edgeCount(expired.left.entry.id, expired.right.entry.id), 0);

  const source = makePair("c", "d", "pref.source", "用户喜欢喝青茶", "用户爱喝青茶");
  ctx.db.prepare(`
    INSERT INTO memory_source_controls (character_id, source_id_hash, created_at)
    VALUES (?, ?, ?)
  `).run("c", sourceHash("pref.source-x"), START);
  assert.throws(
    () => associateIds(ctx, source.left.entry.id, source.right.entry.id),
    (error) => error.code === "ASSOCIATION_REJECTED",
  );
  assert.equal(edgeCount(source.left.entry.id, source.right.entry.id), 0);

  const forget = makePair("e", "f", "pref.forget", "用户喜欢喝红茶", "用户爱喝红茶");
  ctx.db.prepare(`
    INSERT INTO memory_forget_identity_controls (character_id, identity_id, created_at)
    VALUES (?, ?, ?)
  `).run("e", identityOf(ctx.db, forget.left.entry.id), START);
  assert.throws(
    () => associateIds(ctx, forget.left.entry.id, forget.right.entry.id),
    (error) => error.code === "ASSOCIATION_FORGET_RESTRICTED",
  );
  assert.equal(edgeCount(forget.left.entry.id, forget.right.entry.id), 0);
});

function seedCrossIdentity(db, { withEdge = true } = {}) {
  insertIdentity(db, "I");
  insertIdentity(db, "J");
  insertIdentity(db, "K");
  insertEntry(db, {
    id: "i1", characterId: "a", factKey: "pref.i1", body: "用户喜欢一",
    factIdentityId: "I", sourceId: "i1-src", createdAt: START,
  });
  insertEntry(db, {
    id: "i2", characterId: "b", factKey: "pref.i2", body: "用户喜欢二",
    factIdentityId: "I", sourceId: "i2-src", createdAt: START + 1,
  });
  insertEntry(db, {
    id: "j1", characterId: "c", factKey: "pref.j1", body: "用户喜欢三",
    factIdentityId: "J", sourceId: "j1-src", createdAt: START + 2,
  });
  insertEntry(db, {
    id: "j2", characterId: "d", factKey: "pref.j2", body: "用户喜欢四",
    factIdentityId: "J", sourceId: "j2-src", createdAt: START + 3,
  });
  insertEntry(db, {
    id: "k1", characterId: "a", factKey: "pref.k1", body: "用户喜欢五",
    factIdentityId: "K", sourceId: "k1-src", createdAt: START + 4,
  });
  insertEntry(db, {
    id: "k2", characterId: "b", factKey: "pref.k2", body: "用户喜欢六",
    factIdentityId: "K", sourceId: "k2-src", createdAt: START + 5,
  });
  insertDerivation(db, "k2", "k1", "a", "a");

  insertIdentity(db, "orphan-id");
  insertShareControl(db, "orphan-id");
  insertForgetControl(db, "a", "orphan-id");
  insertAlias(db, historicalFingerprint("孤儿历史正文"), "orphan-id");
  insertIdentity(db, "orphan-key-id");
  insertEntry(db, {
    id: "orphan-key-entry", characterId: "d", factKey: "pref.orphan.key",
    body: "用户说起过旧暗号", factIdentityId: "orphan-key-id",
    sourceId: "orphan-key-src", createdAt: START + 6,
  });
  const orphanKeyHash = factKeyHash("pref.orphan.key");
  db.prepare(`
    INSERT INTO memory_share_controls (
      fact_key_hash, created_at, identity_id, identity_migrated
    ) VALUES (?, ?, NULL, 1)
  `).run(orphanKeyHash, START);
  db.prepare(`
    INSERT INTO memory_forget_controls (
      character_id, fact_key_hash, created_at, identity_id, identity_migrated
    ) VALUES ('a', ?, ?, NULL, 1)
  `).run(orphanKeyHash, START);
  insertDeletedFingerprint(db, "a", {
    kind: "preference", trust: "stated", sourceKind: "user", body: "用户已删除的旧正文",
  });

  if (withEdge) {
    ensureRelationEdgeTable(db);
    insertRelationEdge(db, "i1", "j1", "explicit");
  }
}

function assertRollbackAndReopen(t, seed, triggerName, triggerSql, expected) {
  const raw = makeLegacyRaw(t, seed);
  const db = raw.db;
  db.exec(triggerSql);
  const before = fullSnapshot(db);
  assert.throws(
    () => createMemoryService({ db, now: () => START }),
    expected,
  );
  assert.equal(reportOf(db), null);
  assert.deepEqual(fullSnapshot(db), before);
  db.exec(`DROP TRIGGER ${triggerName}`);
  assert.ok(createMemoryService({ db, now: () => START }));
  assert.ok(reportOf(db));
  assert.equal(tableExists(db, "memory_fact_relation_edges"), true);
  const success = fullSnapshot(db);
  db.close();
  const reopened = openMemoryDatabase(raw.dir);
  try {
    assert.ok(createMemoryService({ db: reopened, now: () => START }));
    assert.deepEqual(fullSnapshot(reopened), success);
  } finally {
    reopened.close();
  }
}

test("POL-MIG-005 跨identity证实同组、非卷入、失败回滚与版本条件", (t) => {
  const ctx = makeLegacyContext(t, (db) => seedCrossIdentity(db));
  assert.equal(identityOf(ctx.db, "i1"), identityOf(ctx.db, "j1"));
  assert.notEqual(identityOf(ctx.db, "i2"), identityOf(ctx.db, "i1"));
  assert.notEqual(identityOf(ctx.db, "j2"), identityOf(ctx.db, "i1"));
  assert.equal(identityOf(ctx.db, "k1"), "K");
  assert.equal(identityOf(ctx.db, "k2"), "K");
  assert.deepEqual(versionsOf(ctx.db, ["i1", "j1", "i2", "j2"]), {
    i1: 2, j1: 2, i2: 2, j2: 2,
  });
  assert.deepEqual(versionsOf(ctx.db, ["k1", "k2"]), { k1: 1, k2: 1 });
  for (const characterId of ["a", "b", "c", "d"]) {
    assert.equal(
      ctx.db.prepare("SELECT version FROM memory_context_versions WHERE character_id = ?")
        .get(characterId).version,
      1,
    );
  }
  const report = reportOf(ctx.db);
  assert.ok(report.needsReverification.includes(identityOf(ctx.db, "i2")));
  assert.ok(report.needsReverification.includes(identityOf(ctx.db, "j2")));

  // 无映射目标的孤儿 identity/控制/alias 原样保留。
  assert.equal(
    countRows(ctx.db, "memory_fact_identities", "WHERE identity_id = ?", "orphan-id"),
    1,
  );
  assert.equal(shareControlCount(ctx.db, "orphan-id"), 1);
  assert.equal(
    countRows(
      ctx.db,
      "memory_forget_identity_controls",
      "WHERE character_id = 'a' AND identity_id = ?",
      "orphan-id",
    ),
    1,
  );
  assert.equal(
    ctx.db.prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(historicalFingerprint("孤儿历史正文")).identity_id,
    "orphan-id",
  );

  // 已处理孤儿旧键不按当前 factKey 重新归因；不删孤儿、不复活已删正文。
  const orphanKeyHash = factKeyHash("pref.orphan.key");
  assert.deepEqual(
    {
      ...ctx.db.prepare(`
        SELECT identity_id, identity_migrated FROM memory_share_controls
        WHERE fact_key_hash = ?
      `).get(orphanKeyHash),
    },
    { identity_id: null, identity_migrated: 1 },
  );
  assert.deepEqual(
    {
      ...ctx.db.prepare(`
        SELECT identity_id, identity_migrated FROM memory_forget_controls
        WHERE character_id = 'a' AND fact_key_hash = ?
      `).get(orphanKeyHash),
    },
    { identity_id: null, identity_migrated: 1 },
  );
  assert.equal(identityOf(ctx.db, "orphan-key-entry"), "orphan-key-id");
  assert.equal(shareControlCount(ctx.db, "orphan-key-id"), 0);
  assert.equal(
    countRows(
      ctx.db,
      "memory_forget_identity_controls",
      "WHERE identity_id = ?",
      "orphan-key-id",
    ),
    0,
  );
  assert.equal(
    countRows(ctx.db, "memory_entries", "WHERE body = ?", "用户已删除的旧正文"),
    0,
  );

  assertRollbackAndReopen(
    t,
    (db) => seedCrossIdentity(db, { withEdge: false }),
    "fail_migration_entry",
    `CREATE TRIGGER fail_migration_entry BEFORE UPDATE ON memory_entries
     WHEN OLD.id = 'i1'
     BEGIN SELECT RAISE(ABORT, 'injected migration entry'); END;`,
    /injected migration entry/u,
  );
  assertRollbackAndReopen(
    t,
    (db) => seedCrossIdentity(db, { withEdge: false }),
    "fail_migration_marker",
    `CREATE TRIGGER fail_migration_marker BEFORE INSERT ON app_state
     WHEN NEW.key = '${REPORT_KEY}'
     BEGIN SELECT RAISE(ABORT, 'injected migration marker'); END;`,
    /injected migration marker/u,
  );
});
test("POL-MIG-006 派生环剔除与单一已证明组件不变", (t) => {
  const ctx = makeLegacyContext(t, (db) => {
    insertIdentity(db, "cycle");
    insertIdentity(db, "proven");
    insertEntry(db, {
      id: "x1", characterId: "a", factKey: "pref.cycle.x", body: "用户喜欢环一",
      factIdentityId: "cycle", sourceId: "x-src", createdAt: START,
    });
    insertEntry(db, {
      id: "y1", characterId: "b", factKey: "pref.cycle.y", body: "用户喜欢环二",
      factIdentityId: "cycle", sourceId: "y-src", createdAt: START + 1,
    });
    insertDerivation(db, "x1", "y1", "a");
    insertDerivation(db, "y1", "x1", "b");
    insertEntry(db, {
      id: "p1", characterId: "c", factKey: "pref.proven.p", body: "用户喜欢链一",
      factIdentityId: "proven", sourceId: "p-src", createdAt: START + 2,
    });
    insertEntry(db, {
      id: "q1", characterId: "d", factKey: "pref.proven.q", body: "用户喜欢链二",
      factIdentityId: "proven", sourceId: "q-src", createdAt: START + 3,
    });
    insertDerivation(db, "q1", "p1", "c", "c");
  });

  assert.notEqual(identityOf(ctx.db, "x1"), identityOf(ctx.db, "y1"));
  assert.equal(identityOf(ctx.db, "p1"), "proven");
  assert.equal(identityOf(ctx.db, "q1"), "proven");
  const report = reportOf(ctx.db);
  assert.deepEqual(report.cycles.sort(), ["x1", "y1"]);
  assert.deepEqual(versionsOf(ctx.db, ["x1", "y1"]), { x1: 2, y1: 2 });
  assert.deepEqual(versionsOf(ctx.db, ["p1", "q1"]), { p1: 1, q1: 1 });
  assert.equal(
    ctx.db.prepare("SELECT version FROM memory_context_versions WHERE character_id = 'c'").get()?.version ?? 0,
    0,
  );
  ctx.reopen();
  assert.notEqual(identityOf(ctx.db, "x1"), identityOf(ctx.db, "y1"));
  assert.equal(identityOf(ctx.db, "p1"), "proven");
  assert.deepEqual(versionsOf(ctx.db, ["p1", "q1"]), { p1: 1, q1: 1 });
});

/* S03m 2c-2a：旧 2c-1 单 L 库的 entry 关联初始化迁移。只验证表/回填/回滚与
   重开一致性；多 L 读取与阶段 1 行为见 memory-corrected-source.spec.cjs。 */
function ensureLegacyTemporaryLinkTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_temporary_links (
      temp_identity_id TEXT NOT NULL,
      long_identity_id TEXT NOT NULL,
      holder_character_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (temp_identity_id, long_identity_id, holder_character_id, expires_at)
    );
  `);
}

function ensureTemporaryEntryLinkTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_temporary_entry_links (
      entry_id TEXT PRIMARY KEY,
      temp_identity_id TEXT NOT NULL,
      holder_character_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      long_identity_id TEXT NOT NULL,
      root_identity_id TEXT NOT NULL
    );
  `);
}

const TEMP_END = START + 8 * 60 * 60 * 1000;

function seedLegacyTemporaryRows(db) {
  ensureLegacyTemporaryLinkTable(db);
  insertIdentity(db, "temp-single-L");
  insertIdentity(db, "long-single-L");
  insertIdentity(db, "temp-multi-L");
  insertIdentity(db, "long-multi-1");
  insertIdentity(db, "long-multi-2");
  insertEntry(db, {
    id: "legacy-temp-a",
    characterId: "a",
    factKey: "pref.legacy.current.long-a",
    factIdentityId: "temp-single-L",
    originCharacterId: "a",
    body: "用户今天想喝茶",
    expiresAt: TEMP_END,
    sourceId: "chat-current:long-a:1:chat:legacy-a",
  });
  insertEntry(db, {
    id: "legacy-temp-b",
    characterId: "b",
    factKey: "pref.legacy.current.long-b",
    factIdentityId: "temp-single-L",
    originCharacterId: "a",
    body: "用户今天想喝茶",
    expiresAt: TEMP_END,
    sourceId: "chat-current-copy:long-a:1:legacy-temp-a:1:long-b:1:chat:legacy-a",
  });
  insertEntry(db, {
    id: "legacy-temp-multi",
    characterId: "b",
    factKey: "pref.legacy.multi.current",
    factIdentityId: "temp-multi-L",
    originCharacterId: "a",
    body: "用户今天想喝咖啡",
    expiresAt: TEMP_END,
    sourceId: "chat-current-copy:long-a:1:legacy-temp-a:1:long-multi-1:1:chat:legacy-a",
  });
  // 合法 2c-1 copy 带有持久 derivation；缺少它会被身份迁移按无证明组件拆开。
  insertDerivation(db, "legacy-temp-b", "legacy-temp-a", "a", "a");
  const insertLink = db.prepare(`
    INSERT INTO memory_temporary_links (
      temp_identity_id, long_identity_id, holder_character_id, expires_at
    ) VALUES (?, ?, ?, ?)
  `);
  insertLink.run("temp-single-L", "long-single-L", "a", TEMP_END);
  insertLink.run("temp-single-L", "long-single-L", "b", TEMP_END);
  // 同 T 两个 L：不满足“整 T 唯一 L”，迁移不得猜测。
  insertLink.run("temp-multi-L", "long-multi-1", "b", TEMP_END);
  insertLink.run("temp-multi-L", "long-multi-2", "b", TEMP_END);
}

function temporaryEntryLinks(db, entryId = null) {
  if (entryId === null) {
    return db.prepare(`
      SELECT * FROM memory_temporary_entry_links ORDER BY entry_id ASC
    `).all();
  }
  return db.prepare(
    "SELECT * FROM memory_temporary_entry_links WHERE entry_id = ?",
  ).get(entryId) ?? null;
}

test("POL-SEMOP-001d/D9 旧 2c-1 单 L 库回填 entry 关联，缺证多 L 不猜且重开幂等", (t) => {
  const ctx = makeLegacyContext(t, seedLegacyTemporaryRows);
  const backfilled = () => temporaryEntryLinks(ctx.db);
  assert.equal(tableExists(ctx.db, "memory_temporary_entry_links"), true);
  const rows = backfilled();
  assert.equal(rows.length, 2, "只回填可证明的单 L 旧行");
  for (const row of rows) {
    assert.equal(row.temp_identity_id, "temp-single-L");
    assert.equal(row.long_identity_id, "long-single-L");
    assert.equal(row.root_identity_id, "long-single-L");
  }
  assert.equal(temporaryEntryLinks(ctx.db, "legacy-temp-multi"), null, "多 L 缺证不回填");
  const before = JSON.stringify(rows);
  ctx.reopen();
  assert.equal(JSON.stringify(backfilled()), before, "重开幂等");
});

test("POL-SEMOP-001d/D9 entry 关联回填失败随迁移保存点整笔回滚，修复后重开成功", (t) => {
  const { dir } = makeLegacyBase(t, (db) => {
    seedLegacyTemporaryRows(db);
    ensureTemporaryEntryLinkTable(db);
    db.exec(`
      CREATE TRIGGER block_temporary_entry_link
      BEFORE INSERT ON memory_temporary_entry_links
      BEGIN
        SELECT RAISE(ABORT, 'temporary entry link failure');
      END;
    `);
  });
  const beforeDb = openMemoryDatabase(dir);
  const before = fullSnapshot(beforeDb);
  beforeDb.close();
  const db = openMemoryDatabase(dir);
  assert.throws(() => createMemoryService({ db, now: () => START }), /temporary entry link failure/);
  assert.deepEqual(
    fullSnapshot(db),
    before,
    "失败必须随同一迁移保存点回滚，不能残留半建表、回填或其他身份控制变化",
  );
  db.exec("DROP TRIGGER block_temporary_entry_link");
  db.close();
  const reopened = openMemoryDatabase(dir);
  const service = createMemoryService({ db: reopened, now: () => START });
  assert.ok(service);
  const after = fullSnapshot(reopened);
  try {
    assert.equal(after.tables.memory_temporary_entry_links.length, 2);
    const identityProjection = (snapshotValue) => snapshotValue.tables.memory_fact_identities
      .map((row) => ({ identity_id: row.identity_id, created_at: row.created_at }));
    assert.deepEqual(
      identityProjection(after),
      identityProjection(before),
      "回填不得改写身份记录",
    );
    for (const table of [
      "memory_entries",
      "memory_fact_aliases",
      "memory_fact_alias_conflicts",
      "memory_forget_identity_controls",
      "memory_share_identity_controls",
      "memory_derivations",
    ]) {
      assert.deepEqual(
        after.tables[table],
        before.tables[table],
        `${table} 不应被回填改写`,
      );
    }
  } finally {
    reopened.close();
  }
});
