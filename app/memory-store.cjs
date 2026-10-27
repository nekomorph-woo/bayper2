/* S03a 本地独属记忆的 SQLite 表与最小数据操作。
   工厂显式接收现有连接，不创建第二个生产数据库；表结构可重复执行。
   FTS5 只是可重建索引，正文与权限控制的唯一事实来源仍是 memory_entries
   和无正文的控制/关系表。派生身份保存在 memory_derivations，不依赖父条目
   是否还存在；这样 A 仅自己忘记时不会抹掉 B 的派生性质。 */
const crypto = require("node:crypto");
const { factKeyHash, identityFingerprint } = require("./memory-fact-identity.cjs");
const { migrateLegacyIdentityGroups } = require("./memory-identity-migration.cjs");

const FACT_IDENTITY_MIGRATION_SAVEPOINT = "memory_fact_identity_migration";

/* S03l 事实身份与 factKey 分离：身份表只保存不透明标识，别名表只保存严格
   同文指纹的 SHA-256；正文与控制语义仍以 memory_entries 为唯一来源。
   身份相关 DDL 与回填、旧控制迁移都在同一保存点内执行，失败时旧库原状保留。 */
const FACT_IDENTITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_fact_identities (
    identity_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  /* 指纹 -> 身份；同一指纹指向多个身份时记入歧义表，保守拒绝自动复用。 */
  CREATE TABLE IF NOT EXISTS memory_fact_aliases (
    fingerprint TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES memory_fact_identities(identity_id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_fact_alias_conflicts (
    fingerprint TEXT NOT NULL,
    identity_id TEXT NOT NULL REFERENCES memory_fact_identities(identity_id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (fingerprint, identity_id)
  );

  CREATE TABLE IF NOT EXISTS memory_forget_identity_controls (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    identity_id TEXT NOT NULL REFERENCES memory_fact_identities(identity_id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, identity_id)
  );

  CREATE TABLE IF NOT EXISTS memory_share_identity_controls (
    identity_id TEXT PRIMARY KEY REFERENCES memory_fact_identities(identity_id),
    created_at INTEGER NOT NULL
  );

  /* 本角色已删除内容的严格正文指纹。只用于阻止同一角色从任意新旧来源
     学回同一原文，不保存正文/事实键，也不用于跨角色身份合并。 */
  CREATE TABLE IF NOT EXISTS memory_deleted_fact_fingerprints (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, fingerprint)
  );

  /* 分享/转告/显式关联的最小无正文关系边；无外键，条目删除后仍保留以
     支撑断根/多跳证明，不保存正文、来源内容或模型解释。 */
  CREATE TABLE IF NOT EXISTS memory_fact_relation_edges (
    from_entry_id TEXT NOT NULL,
    to_entry_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('share', 'relay', 'explicit')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_entry_id, to_entry_id, kind)
  );
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fact_key TEXT NOT NULL,
    origin_character_id TEXT NOT NULL REFERENCES relationships(character_id),
    -- 仅保留分享时的父条目提示；ON DELETE SET NULL 不影响派生身份，
    -- 派生性质以 memory_derivations 为准。
    derived_from_entry_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('identity', 'preference', 'experience', 'detail')),
    body TEXT NOT NULL CHECK (length(body) > 0),
    trust TEXT NOT NULL CHECK (trust IN ('stated', 'inferred')),
    -- 来源种类用于区分用户事实与可信作者主题见闻；旧记录和新用户路径默认 user。
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

  CREATE INDEX IF NOT EXISTS memory_entries_fact_key
    ON memory_entries (fact_key);
  CREATE INDEX IF NOT EXISTS memory_entries_character
    ON memory_entries (character_id, kind, importance DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS memory_forget_controls (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    fact_key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, fact_key_hash)
  );

  CREATE TABLE IF NOT EXISTS memory_source_controls (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    source_id_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash)
  );

  /* 用户明确“不要再分享这件事”的最小控制。新控制按身份写入
     memory_share_identity_controls；这里的旧行只承担迁移与历史兼容。 */
  CREATE TABLE IF NOT EXISTS memory_share_controls (
    fact_key_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  /* 派生身份与父条目分离：parent_entry_id 不设外键，父条目删除后仍保留
     “这条记忆是听来的”这一无正文关系。narrator_character_id 记录直接讲述者
    的角色身份，父条目删除后仍可说明“听谁说的”；origin_character_id 保留
     最初来源。source_id/source_version 记录最初分享来源；后续纠正更新正文时
     仍可追溯原分享来源。entry_id 删除时级联清理。 */
  CREATE TABLE IF NOT EXISTS memory_derivations (
    entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
    parent_entry_id TEXT NOT NULL,
    origin_character_id TEXT NOT NULL REFERENCES relationships(character_id),
    narrator_character_id TEXT,
    source_id TEXT,
    source_version INTEGER,
    created_at INTEGER NOT NULL
  );

  /* 一次提炼批次的幂等标记：同一角色、来源哈希和来源版本只应用一次。
     不保存正文或事实清单，事实本身仍在 memory_entries。 */
  CREATE TABLE IF NOT EXISTS memory_extraction_batches (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    source_id_hash TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id_hash, source_version)
  );

  CREATE TABLE IF NOT EXISTS memory_context_versions (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  /* S03i 全局自动分享开关复用正式 app_state；这里补建只是为了工具和独立记忆
     测试能直接打开本模块，生产库仍由 store.cjs 作为唯一 schema 入口创建。 */
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    entry_id UNINDEXED,
    char_tokens,
    segment_tokens,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

function mapEntry(row) {
  if (!row) {
    return null;
  }
  const derivedFromEntryId = row.derived_parent_id ?? row.derived_from_entry_id ?? null;
  const derived = derivedFromEntryId !== null || row.origin_character_id !== row.character_id;
  return {
    id: row.id,
    characterId: row.character_id,
    factKey: row.fact_key,
    factIdentityId: row.fact_identity_id ?? null,
    originCharacterId: row.origin_character_id,
    derived,
    derivedFromEntryId,
    narratorCharacterId: row.derived_narrator_id ?? null,
    derivationSourceId: row.derived_source_id ?? null,
    derivationSourceVersion: row.derived_source_version ?? null,
    kind: row.kind,
    body: row.body,
    trust: row.trust,
    sourceKind: row.source_kind ?? "user",
    importance: row.importance,
    expiresAt: row.expires_at ?? null,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createMemoryStore(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  ensureSourceKindColumn(db);
  ensureDerivationColumns(db);
  // 兼容首版关系表：补齐派生关系与可直接判定的来源/讲述者，不猜测已删除父条目的身份。
  db.exec(`
    INSERT OR IGNORE INTO memory_derivations (
      entry_id, parent_entry_id, origin_character_id, narrator_character_id,
      source_id, source_version, created_at
    )
    SELECT e.id, e.derived_from_entry_id, e.origin_character_id,
           (SELECT p.character_id FROM memory_entries p WHERE p.id = e.derived_from_entry_id),
           e.source_id, e.source_version, e.created_at
    FROM memory_entries e
    WHERE e.derived_from_entry_id IS NOT NULL
  `);
  db.exec(`
    UPDATE memory_derivations
    SET source_id = (SELECT e.source_id FROM memory_entries e WHERE e.id = memory_derivations.entry_id),
        source_version = (SELECT e.source_version FROM memory_entries e WHERE e.id = memory_derivations.entry_id)
    WHERE source_id IS NULL
  `);
  // 旧转述若父条目仍在，可由父条目持有者确定直接讲述者；父条目已删则保持 NULL。
  db.exec(`
    UPDATE memory_derivations
    SET narrator_character_id = (
      SELECT p.character_id FROM memory_entries p WHERE p.id = memory_derivations.parent_entry_id
    )
    WHERE narrator_character_id IS NULL
      AND EXISTS (
        SELECT 1 FROM memory_entries p WHERE p.id = memory_derivations.parent_entry_id
      )
  `);

  // 身份相关 DDL、回填与旧控制迁移必须同一保存点；失败时旧库原状保留。
  db.exec(`SAVEPOINT ${FACT_IDENTITY_MIGRATION_SAVEPOINT}`);
  try {
    db.exec(FACT_IDENTITY_SCHEMA);
    ensureFactIdentityColumns(db);
    migrateFactIdentities(db);
    migrateLegacyIdentityGroups(db, { nowMs: Date.now() });
    db.exec(`RELEASE SAVEPOINT ${FACT_IDENTITY_MIGRATION_SAVEPOINT}`);
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${FACT_IDENTITY_MIGRATION_SAVEPOINT}`);
    db.exec(`RELEASE SAVEPOINT ${FACT_IDENTITY_MIGRATION_SAVEPOINT}`);
    throw error;
  }

  const DERIVED_FIELDS = `
    (SELECT d.parent_entry_id FROM memory_derivations d WHERE d.entry_id = e.id) AS derived_parent_id,
    (SELECT d.narrator_character_id FROM memory_derivations d WHERE d.entry_id = e.id) AS derived_narrator_id,
    (SELECT d.source_id FROM memory_derivations d WHERE d.entry_id = e.id) AS derived_source_id,
    (SELECT d.source_version FROM memory_derivations d WHERE d.entry_id = e.id) AS derived_source_version
  `;

  const statements = {
    isKnownCharacter: db.prepare("SELECT 1 AS found FROM relationships WHERE character_id = ?"),
    insertEntry: db.prepare(`
      INSERT INTO memory_entries (
        id, character_id, fact_key, fact_identity_id, origin_character_id,
        derived_from_entry_id, kind, body, trust, source_kind, importance,
        expires_at, source_id, source_version, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertDerivation: db.prepare(`
      INSERT INTO memory_derivations (
        entry_id, parent_entry_id, origin_character_id, narrator_character_id,
        source_id, source_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateEntry: db.prepare(`
      UPDATE memory_entries SET
        body = ?, trust = ?, source_kind = ?, importance = ?, expires_at = ?,
        source_id = ?, source_version = ?, version = ?, updated_at = ?
      WHERE id = ?
    `),
    getEntryById: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.id = ?
    `),
    getEntryByFact: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.character_id = ? AND e.fact_key = ?
    `),
    listEntriesByFact: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.fact_key = ?
      ORDER BY e.character_id ASC, e.created_at ASC, e.id ASC
    `),
    listEntriesByIdentity: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.fact_identity_id = ?
      ORDER BY e.character_id ASC, e.created_at ASC, e.id ASC
    `),
    getEntryByCharacterIdentity: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.character_id = ? AND e.fact_identity_id = ?
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT 1
    `),
    setEntryIdentity: db.prepare(`
      UPDATE memory_entries SET fact_identity_id = ? WHERE id = ?
    `),
    /* 关联迁移不重写正文、factKey、来源或派生记录，只换身份并递增版本，
       使在途的旧版本选择失效；FTS 因此不需要重建。 */
    reassignEntryIdentity: db.prepare(`
      UPDATE memory_entries
      SET fact_identity_id = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `),
    reassignAliases: db.prepare(`
      UPDATE memory_fact_aliases SET identity_id = ? WHERE identity_id = ?
    `),
    listConflictFingerprints: db.prepare(`
      SELECT DISTINCT fingerprint FROM memory_fact_alias_conflicts
      WHERE identity_id = ?
    `),
    listConflictIdentityIds: db.prepare(`
      SELECT identity_id FROM memory_fact_alias_conflicts WHERE fingerprint = ?
    `),
    deleteConflictsForFingerprint: db.prepare(`
      DELETE FROM memory_fact_alias_conflicts WHERE fingerprint = ?
    `),
    copyAliasConflicts: db.prepare(`
      INSERT OR IGNORE INTO memory_fact_alias_conflicts (
        fingerprint, identity_id, created_at
      )
      SELECT fingerprint, ?, created_at
      FROM memory_fact_alias_conflicts
      WHERE identity_id = ?
    `),
    deleteAliasConflicts: db.prepare(`
      DELETE FROM memory_fact_alias_conflicts WHERE identity_id = ?
    `),
    copyShareIdentityControl: db.prepare(`
      INSERT OR IGNORE INTO memory_share_identity_controls (identity_id, created_at)
      SELECT ?, created_at
      FROM memory_share_identity_controls
      WHERE identity_id = ?
    `),
    reassignLegacyShareControls: db.prepare(`
      UPDATE memory_share_controls SET identity_id = ? WHERE identity_id = ?
    `),
    copyForgetIdentityControls: db.prepare(`
      INSERT OR IGNORE INTO memory_forget_identity_controls (
        character_id, identity_id, created_at
      )
      SELECT character_id, ?, created_at
      FROM memory_forget_identity_controls
      WHERE identity_id = ?
    `),
    getIdentityLegacy: db.prepare(`
      SELECT legacy_identity_id FROM memory_fact_identities WHERE identity_id = ?
    `),
    setIdentityLegacyIfNull: db.prepare(`
      UPDATE memory_fact_identities
      SET legacy_identity_id = ?
      WHERE identity_id = ? AND legacy_identity_id IS NULL
    `),
    insertRelationEdge: db.prepare(`
      INSERT OR IGNORE INTO memory_fact_relation_edges (
        from_entry_id, to_entry_id, kind, created_at
      ) VALUES (?, ?, ?, ?)
    `),
    insertFactIdentity: db.prepare(`
      INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at)
      VALUES (?, ?)
    `),
    getAliasIdentity: db.prepare(
      "SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?",
    ),
    listAliasIdentityIds: db.prepare(`
      SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?
      UNION
      SELECT identity_id FROM memory_fact_alias_conflicts WHERE fingerprint = ?
      ORDER BY identity_id ASC
    `),
    insertAlias: db.prepare(`
      INSERT OR IGNORE INTO memory_fact_aliases (fingerprint, identity_id, created_at)
      VALUES (?, ?, ?)
    `),
    insertAliasConflict: db.prepare(`
      INSERT OR IGNORE INTO memory_fact_alias_conflicts (
        fingerprint, identity_id, created_at
      ) VALUES (?, ?, ?)
    `),
    listActiveEntries: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.character_id = ?
        AND (e.expires_at IS NULL OR e.expires_at > ?)
      ORDER BY e.importance DESC, e.updated_at DESC, e.id ASC
      LIMIT ?
    `),
    listActiveEntriesPage: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE e.character_id = ?
        AND (e.expires_at IS NULL OR e.expires_at > ?)
      ORDER BY e.importance DESC, e.updated_at DESC, e.id ASC
      LIMIT ? OFFSET ?
    `),
    listEntriesFirst: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      ORDER BY e.character_id ASC, e.created_at ASC, e.id ASC
      LIMIT ?
    `),
    listEntriesAfter: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}
      FROM memory_entries e
      WHERE (e.character_id, e.created_at, e.id) > (?, ?, ?)
      ORDER BY e.character_id ASC, e.created_at ASC, e.id ASC
      LIMIT ?
    `),
    isDerivedEntry: db.prepare(`
      SELECT 1 AS found FROM memory_entries e
      WHERE e.id = ?
        AND (
          e.origin_character_id <> e.character_id
          OR EXISTS (SELECT 1 FROM memory_derivations d WHERE d.entry_id = e.id)
        )
    `),
    deleteEntry: db.prepare("DELETE FROM memory_entries WHERE id = ?"),
    deleteDerivation: db.prepare("DELETE FROM memory_derivations WHERE entry_id = ?"),
    insertFts: db.prepare(
      "INSERT INTO memory_fts (entry_id, char_tokens, segment_tokens) VALUES (?, ?, ?)",
    ),
    deleteFts: db.prepare("DELETE FROM memory_fts WHERE entry_id = ?"),
    clearFts: db.prepare("DELETE FROM memory_fts"),
    hasExtractionBatch: db.prepare(`
      SELECT 1 AS found FROM memory_extraction_batches
      WHERE character_id = ? AND source_id_hash = ? AND source_version = ?
    `),
    addExtractionBatch: db.prepare(`
      INSERT INTO memory_extraction_batches (
        character_id, source_id_hash, source_version, applied_at
      ) VALUES (?, ?, ?, ?)
    `),
    searchByChar: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}, bm25(memory_fts) AS score
      FROM memory_fts
      JOIN memory_entries e ON e.id = memory_fts.entry_id
      WHERE memory_fts MATCH ?
        AND e.character_id = ?
        AND (e.expires_at IS NULL OR e.expires_at > ?)
      ORDER BY score ASC, e.importance DESC, e.updated_at DESC, e.id ASC
      LIMIT ?
    `),
    searchBySegment: db.prepare(`
      SELECT e.*, ${DERIVED_FIELDS}, bm25(memory_fts) AS score
      FROM memory_fts
      JOIN memory_entries e ON e.id = memory_fts.entry_id
      WHERE memory_fts MATCH ?
        AND e.character_id = ?
        AND (e.expires_at IS NULL OR e.expires_at > ?)
      ORDER BY score ASC, e.importance DESC, e.updated_at DESC, e.id ASC
      LIMIT ?
    `),
    getForgetControl: db.prepare(`
      SELECT * FROM memory_forget_controls
      WHERE character_id = ? AND fact_key_hash = ?
    `),
    hasForgetIdentityControl: db.prepare(`
      SELECT 1 AS found FROM memory_forget_identity_controls
      WHERE character_id = ? AND identity_id = ?
    `),
    /* 身份级删除限制可能由已不再持有条目的角色留下；关联前保守拒绝，
       因此同时检查旧控制行中指向该身份的引用。 */
    hasForgetIdentityReference: db.prepare(`
      SELECT 1 AS found FROM memory_forget_identity_controls
      WHERE identity_id = ?
      UNION ALL
      SELECT 1 AS found FROM memory_forget_controls
      WHERE identity_id = ?
      LIMIT 1
    `),
    addForgetIdentityControl: db.prepare(`
      INSERT OR IGNORE INTO memory_forget_identity_controls (
        character_id, identity_id, created_at
      ) VALUES (?, ?, ?)
    `),
    hasDeletedFactFingerprint: db.prepare(`
      SELECT 1 AS found FROM memory_deleted_fact_fingerprints
      WHERE character_id = ? AND fingerprint = ?
    `),
    addDeletedFactFingerprint: db.prepare(`
      INSERT OR IGNORE INTO memory_deleted_fact_fingerprints (
        character_id, fingerprint, created_at
      ) VALUES (?, ?, ?)
    `),
    hasSourceControl: db.prepare(`
      SELECT 1 AS found FROM memory_source_controls
      WHERE character_id = ? AND source_id_hash = ?
    `),
    addSourceControl: db.prepare(`
      INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at)
      VALUES (?, ?, ?)
    `),
    getShareControl: db.prepare(
      "SELECT * FROM memory_share_controls WHERE fact_key_hash = ?",
    ),
    hasShareIdentityControl: db.prepare(
      "SELECT 1 AS found FROM memory_share_identity_controls WHERE identity_id = ?",
    ),
    addShareIdentityControl: db.prepare(`
      INSERT OR IGNORE INTO memory_share_identity_controls (identity_id, created_at)
      VALUES (?, ?)
    `),
    removeShareIdentityControl: db.prepare(
      "DELETE FROM memory_share_identity_controls WHERE identity_id = ?",
    ),
    listSourceControls: db.prepare(`
      SELECT source_id_hash FROM memory_source_controls
      WHERE character_id = ?
      ORDER BY source_id_hash ASC
    `),
    getContextVersion: db.prepare(
      "SELECT version FROM memory_context_versions WHERE character_id = ?",
    ),
    bumpContextVersion: db.prepare(`
      INSERT INTO memory_context_versions (character_id, version, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        version = version + 1,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare("SELECT value FROM app_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };

  function isKnownCharacter(characterId) {
    return Boolean(statements.isKnownCharacter.get(characterId));
  }

  function insertEntry(entry, indexTokens) {
    statements.insertEntry.run(
      entry.id,
      entry.characterId,
      entry.factKey,
      entry.factIdentityId,
      entry.originCharacterId,
      entry.derivedFromEntryId,
      entry.kind,
      entry.body,
      entry.trust,
      entry.sourceKind ?? "user",
      entry.importance,
      entry.expiresAt,
      entry.sourceId,
      entry.sourceVersion,
      entry.version,
      entry.createdAt,
      entry.updatedAt,
    );
    statements.insertFts.run(entry.id, indexTokens.charTokens, indexTokens.segmentTokens);
    if (entry.derivedFromEntryId !== null) {
      statements.insertDerivation.run(
        entry.id,
        entry.derivedFromEntryId,
        entry.originCharacterId,
        entry.narratorCharacterId ?? null,
        entry.sourceId,
        entry.sourceVersion,
        entry.createdAt,
      );
    }
  }

  function replaceIndex(entryId, indexTokens) {
    statements.deleteFts.run(entryId);
    statements.insertFts.run(entryId, indexTokens.charTokens, indexTokens.segmentTokens);
  }

  function updateEntry(entry, indexTokens) {
    statements.updateEntry.run(
      entry.body,
      entry.trust,
      entry.sourceKind ?? "user",
      entry.importance,
      entry.expiresAt,
      entry.sourceId,
      entry.sourceVersion,
      entry.version,
      entry.updatedAt,
      entry.id,
    );
    replaceIndex(entry.id, indexTokens);
  }

  function deleteEntry(entryId) {
    statements.deleteDerivation.run(entryId);
    statements.deleteFts.run(entryId);
    statements.deleteEntry.run(entryId);
  }

  function isDerivedEntry(entryId) {
    return Boolean(statements.isDerivedEntry.get(entryId));
  }

  function getEntryById(entryId) {
    return mapEntry(statements.getEntryById.get(entryId));
  }

  function getEntryByFact(characterId, factKey) {
    return mapEntry(statements.getEntryByFact.get(characterId, factKey));
  }

  function listEntriesByFact(factKey) {
    return statements.listEntriesByFact.all(factKey).map(mapEntry);
  }

  function listEntriesByIdentity(identityId) {
    return statements.listEntriesByIdentity.all(identityId).map(mapEntry);
  }

  function getEntryByCharacterIdentity(characterId, identityId) {
    return mapEntry(statements.getEntryByCharacterIdentity.get(characterId, identityId));
  }

  function setEntryIdentity(entryId, identityId) {
    statements.setEntryIdentity.run(identityId, entryId);
  }

  function reassignEntryIdentity(entryId, identityId, updatedAt) {
    statements.reassignEntryIdentity.run(identityId, updatedAt, entryId);
  }

  /* 把 from 身份的严格指纹别名、歧义引用与禁分享限制并入 to。
     只迁移 from 的引用；同一指纹下其他第三方身份保持原样，不消除歧义。
     若某指纹在合并后只剩 canonical，则本次合并实际消除了该歧义，删除冲突行，
     让精确正文别名重新可用；仍有第三方身份时保留 canonical 与第三方的冲突。 */
  function mergeFactIdentities(fromIdentityId, toIdentityId) {
    const resolvedConflictFingerprints = statements.listConflictFingerprints
      .all(fromIdentityId)
      .map((row) => row.fingerprint)
      .filter((fingerprint) => {
        const otherIdentityIds = statements.listConflictIdentityIds
          .all(fingerprint)
          .map((row) => row.identity_id)
          .filter((identityId) => identityId !== fromIdentityId);
        return otherIdentityIds.every((identityId) => identityId === toIdentityId);
      });
    statements.reassignAliases.run(toIdentityId, fromIdentityId);
    statements.copyAliasConflicts.run(toIdentityId, fromIdentityId);
    statements.deleteAliasConflicts.run(fromIdentityId);
    for (const fingerprint of resolvedConflictFingerprints) {
      statements.deleteConflictsForFingerprint.run(fingerprint);
    }
    statements.copyShareIdentityControl.run(toIdentityId, fromIdentityId);
    statements.removeShareIdentityControl.run(fromIdentityId);
    statements.reassignLegacyShareControls.run(toIdentityId, fromIdentityId);
    statements.copyForgetIdentityControls.run(toIdentityId, fromIdentityId);
    const canonicalLegacy = statements.getIdentityLegacy.get(toIdentityId)?.legacy_identity_id ?? null;
    const mergedLegacy = statements.getIdentityLegacy.get(fromIdentityId)?.legacy_identity_id ?? null;
    if (canonicalLegacy === null && mergedLegacy !== null) {
      statements.setIdentityLegacyIfNull.run(mergedLegacy, toIdentityId);
    }
  }

  function insertFactIdentity(identityId, createdAt) {
    statements.insertFactIdentity.run(identityId, createdAt);
  }

  function insertRelationEdge(fromEntryId, toEntryId, kind, createdAt) {
    statements.insertRelationEdge.run(fromEntryId, toEntryId, kind, createdAt);
  }

  function getIdentityLegacyId(identityId) {
    return statements.getIdentityLegacy.get(identityId)?.legacy_identity_id ?? null;
  }

  function isSplitIdentity(identityId) {
    return getIdentityLegacyId(identityId) !== null;
  }

  /* 与某指纹相关的全部身份（含歧义组）；控制检查必须逐个覆盖。 */
  function listAliasIdentityIds(fingerprint) {
    return statements.listAliasIdentityIds
      .all(fingerprint, fingerprint)
      .map((row) => row.identity_id);
  }

  function registerAlias(fingerprint, identityId, createdAt) {
    const existing = statements.getAliasIdentity.get(fingerprint)?.identity_id ?? null;
    if (existing === null) {
      statements.insertAlias.run(fingerprint, identityId, createdAt);
      return;
    }
    if (existing === identityId) {
      return;
    }
    // 不覆盖已登记身份，也不默默合并；记录歧义后自动复用会保守停止。
    statements.insertAliasConflict.run(fingerprint, existing, createdAt);
    statements.insertAliasConflict.run(fingerprint, identityId, createdAt);
  }

  function listActiveEntries(characterId, nowMs, limit) {
    return statements.listActiveEntries.all(characterId, nowMs, limit).map(mapEntry);
  }

  function listActiveEntriesPage(characterId, nowMs, limit, offset) {
    return statements.listActiveEntriesPage
      .all(characterId, nowMs, limit, offset)
      .map(mapEntry);
  }

  /* 按稳定游标分页读取全部条目；limit 是有界批大小，不是总量上限。 */
  function listEntriesPage(after, limit) {
    const rows = after
      ? statements.listEntriesAfter.all(
          after.characterId,
          after.createdAt,
          after.id,
          limit,
        )
      : statements.listEntriesFirst.all(limit);
    return rows.map(mapEntry);
  }

  function search(column, ftsQuery, characterId, nowMs, limit) {
    if (column !== "char_tokens" && column !== "segment_tokens") {
      throw new Error(`未知 FTS 列：${column}`);
    }
    const statement =
      column === "char_tokens" ? statements.searchByChar : statements.searchBySegment;
    return statement.all(ftsQuery, characterId, nowMs, limit).map((row) => ({
      entry: mapEntry(row),
      score: row.score,
    }));
  }

  function getForgetControl(characterId, factKeyHashValue) {
    return statements.getForgetControl.get(characterId, factKeyHashValue) ?? null;
  }

  function hasForgetIdentityControl(characterId, identityId) {
    return Boolean(statements.hasForgetIdentityControl.get(characterId, identityId));
  }

  function hasForgetIdentityReference(identityId) {
    return Boolean(
      statements.hasForgetIdentityReference.get(identityId, identityId),
    );
  }

  function addForgetIdentityControl(characterId, identityId, createdAt) {
    statements.addForgetIdentityControl.run(characterId, identityId, createdAt);
  }

  function hasDeletedFactFingerprint(characterId, fingerprint) {
    return Boolean(statements.hasDeletedFactFingerprint.get(characterId, fingerprint));
  }

  function addDeletedFactFingerprint(characterId, fingerprint, createdAt) {
    statements.addDeletedFactFingerprint.run(characterId, fingerprint, createdAt);
  }

  function hasSourceControl(characterId, sourceIdHash) {
    return Boolean(statements.hasSourceControl.get(characterId, sourceIdHash));
  }

  function addSourceControl(characterId, sourceIdHash, createdAt) {
    statements.addSourceControl.run(characterId, sourceIdHash, createdAt);
  }

  function getShareControl(factKeyHashValue) {
    return statements.getShareControl.get(factKeyHashValue) ?? null;
  }

  function hasShareIdentityControl(identityId) {
    return Boolean(statements.hasShareIdentityControl.get(identityId));
  }

  function addShareIdentityControl(identityId, createdAt) {
    statements.addShareIdentityControl.run(identityId, createdAt);
  }

  function removeShareIdentityControl(identityId) {
    return statements.removeShareIdentityControl.run(identityId).changes > 0;
  }

  function listSourceControls(characterId) {
    return statements.listSourceControls.all(characterId).map((row) => row.source_id_hash);
  }

  function hasExtractionBatch(characterId, sourceIdHashValue, sourceVersion) {
    return Boolean(
      statements.hasExtractionBatch.get(characterId, sourceIdHashValue, sourceVersion),
    );
  }

  function addExtractionBatch(characterId, sourceIdHashValue, sourceVersion, appliedAt) {
    statements.addExtractionBatch.run(characterId, sourceIdHashValue, sourceVersion, appliedAt);
  }

  function getContextVersion(characterId) {
    return statements.getContextVersion.get(characterId)?.version ?? 0;
  }

  function bumpContextVersion(characterId, at) {
    statements.bumpContextVersion.run(characterId, at);
    return getContextVersion(characterId);
  }

  function getState(key) {
    return statements.getState.get(key)?.value ?? null;
  }

  function setState(key, value) {
    statements.setState.run(key, value);
  }

  function clearIndex() {
    statements.clearFts.run();
  }

  function insertIndex(entryId, indexTokens) {
    statements.insertFts.run(entryId, indexTokens.charTokens, indexTokens.segmentTokens);
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    isKnownCharacter,
    insertEntry,
    updateEntry,
    deleteEntry,
    getEntryById,
    getEntryByFact,
    listEntriesByFact,
    listEntriesByIdentity,
    getEntryByCharacterIdentity,
    setEntryIdentity,
    reassignEntryIdentity,
    mergeFactIdentities,
    insertFactIdentity,
    insertRelationEdge,
    getIdentityLegacyId,
    isSplitIdentity,
    listAliasIdentityIds,
    registerAlias,
    listActiveEntries,
    listActiveEntriesPage,
    listEntriesPage,
    isDerivedEntry,
    search,
    getForgetControl,
    hasForgetIdentityControl,
    hasForgetIdentityReference,
    addForgetIdentityControl,
    hasDeletedFactFingerprint,
    addDeletedFactFingerprint,
    hasSourceControl,
    addSourceControl,
    getShareControl,
    hasShareIdentityControl,
    addShareIdentityControl,
    removeShareIdentityControl,
    listSourceControls,
    hasExtractionBatch,
    addExtractionBatch,
    getContextVersion,
    bumpContextVersion,
    getState,
    setState,
    clearIndex,
    insertIndex,
    transaction,
  };
}

module.exports = { createMemoryStore, SCHEMA };

function ensureSourceKindColumn(db) {
  const columns = db.prepare("PRAGMA table_info(memory_entries)").all();
  if (!columns.some((column) => column.name === "source_kind")) {
    // 旧库没有可信主题标识；已有记录保守按用户来源处理。
    db.exec("ALTER TABLE memory_entries ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'user'");
  }
}

function ensureDerivationColumns(db) {
  const columns = db.prepare("PRAGMA table_info(memory_derivations)").all();
  if (!columns.some((column) => column.name === "source_id")) {
    db.exec("ALTER TABLE memory_derivations ADD COLUMN source_id TEXT");
  }
  if (!columns.some((column) => column.name === "source_version")) {
    db.exec("ALTER TABLE memory_derivations ADD COLUMN source_version INTEGER");
  }
  if (!columns.some((column) => column.name === "narrator_character_id")) {
    db.exec("ALTER TABLE memory_derivations ADD COLUMN narrator_character_id TEXT");
  }
}

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/* 旧库补列：新表由 FACT_IDENTITY_SCHEMA 在迁移保存点内创建。历史控制行
   用 identity_migrated 标记是否已处理，避免每次打开按当前键重新归因。 */
function ensureFactIdentityColumns(db) {
  ensureColumn(db, "memory_entries", "fact_identity_id", "TEXT");
  ensureColumn(db, "memory_fact_identities", "legacy_identity_id", "TEXT");
  ensureColumn(db, "memory_forget_controls", "identity_id", "TEXT");
  ensureColumn(
    db,
    "memory_forget_controls",
    "identity_migrated",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "memory_share_controls", "identity_id", "TEXT");
  ensureColumn(
    db,
    "memory_share_controls",
    "identity_migrated",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

/* 幂等身份迁移：
   1. 可证明的派生链继承父条目身份（父条目已删则退回共同缺失父标识或新身份）；
   2. 其余缺身份条目一律新建独立身份，同文也不归组；正文指纹只登记为歧义
      别名，供删除/禁分享控制覆盖，不用于推断事实身份；
   3. 能把旧 factKey 控制定位到现存身份时补写身份级控制，孤儿旧控制保留。
   已持久化的身份（含旧版本按同文建立的组）保持原样，不在本批拆解。 */
function migrateFactIdentities(db) {
  const rows = db.prepare(`
    SELECT e.id, e.fact_key, e.kind, e.body, e.trust, e.source_kind,
           e.expires_at, e.created_at, e.fact_identity_id,
           COALESCE(d.parent_entry_id, e.derived_from_entry_id) AS parent_entry_id
    FROM memory_entries e
    LEFT JOIN memory_derivations d ON d.entry_id = e.id
    ORDER BY e.created_at ASC, e.id ASC
  `).all();
  const entriesById = new Map(rows.map((row) => [row.id, row]));
  const aliases = new Map(
    db.prepare("SELECT fingerprint, identity_id FROM memory_fact_aliases").all()
      .map((row) => [row.fingerprint, row.identity_id]),
  );
  const insertIdentity = db.prepare(`
    INSERT OR IGNORE INTO memory_fact_identities (identity_id, created_at)
    VALUES (?, ?)
  `);
  const setEntryIdentity = db.prepare(`
    UPDATE memory_entries SET fact_identity_id = ?
    WHERE id = ? AND fact_identity_id IS NULL
  `);
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO memory_fact_aliases (fingerprint, identity_id, created_at)
    VALUES (?, ?, ?)
  `);
  const insertConflict = db.prepare(`
    INSERT OR IGNORE INTO memory_fact_alias_conflicts (
      fingerprint, identity_id, created_at
    ) VALUES (?, ?, ?)
  `);
  const memo = new Map();

  function registerAlias(fingerprint, identityId, createdAt) {
    if (!fingerprint) {
      return;
    }
    const existing = aliases.get(fingerprint);
    if (existing === undefined) {
      insertAlias.run(fingerprint, identityId, createdAt);
      aliases.set(fingerprint, identityId);
      return;
    }
    if (existing === identityId) {
      return;
    }
    // 已歧义时仍要把后续身份追加进同一指纹组；否则第三个派生身份可能
    // 逃过该组的忘记/禁分享检查。
    insertConflict.run(fingerprint, existing, createdAt);
    insertConflict.run(fingerprint, identityId, createdAt);
  }

  function resolve(entry, stack) {
    if (entry.fact_identity_id) {
      return entry.fact_identity_id;
    }
    if (memo.has(entry.id)) {
      return memo.get(entry.id);
    }
    // 派生链异常成环时不猜测身份，返回 null 交由调用方新建独立身份。
    if (stack.has(entry.id)) {
      return null;
    }
    stack.add(entry.id);
    const parent = entry.parent_entry_id
      ? entriesById.get(entry.parent_entry_id)
      : null;
    let identityId = parent ? resolve(parent, stack) : null;
    stack.delete(entry.id);

    // 没有明确派生父来源时不按正文归组：同一句话可能来自不同主体。
    if (!identityId) {
      identityId = crypto.randomUUID();
      insertIdentity.run(identityId, entry.created_at);
    }
    const fingerprint = identityFingerprint({
      kind: entry.kind,
      trust: entry.trust,
      sourceKind: entry.source_kind ?? "user",
      expiresAt: entry.expires_at ?? null,
      body: entry.body,
    });
    registerAlias(fingerprint, identityId, entry.created_at);
    setEntryIdentity.run(identityId, entry.id);
    memo.set(entry.id, identityId);
    return identityId;
  }

  /* 父条目已删除、但多个派生条目仍保留同一个 parent_entry_id 时，这是可
     证明的共同来源，不能因父正文不存在就拆成不同身份；也不虚构父条目。 */
  const missingParentGroups = new Map();
  for (const entry of rows) {
    if (
      entry.fact_identity_id === null &&
      entry.parent_entry_id &&
      !entriesById.has(entry.parent_entry_id)
    ) {
      if (!missingParentGroups.has(entry.parent_entry_id)) {
        missingParentGroups.set(entry.parent_entry_id, []);
      }
      missingParentGroups.get(entry.parent_entry_id).push(entry);
    }
  }
  for (const group of missingParentGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    // 迁移在单一保存点内完成，组内条目此时都还没有身份；共同父标识即
    // 共同来源，分配同一个新身份，不按正文猜测也不合并其它组。
    const identityId = crypto.randomUUID();
    insertIdentity.run(identityId, group[0].created_at);
    for (const entry of group) {
      setEntryIdentity.run(identityId, entry.id);
      entry.fact_identity_id = identityId;
      const fingerprint = identityFingerprint({
        kind: entry.kind,
        trust: entry.trust,
        sourceKind: entry.source_kind ?? "user",
        expiresAt: entry.expires_at ?? null,
        body: entry.body,
      });
      registerAlias(fingerprint, identityId, entry.created_at);
    }
  }

  for (const entry of rows) {
    resolve(entry, new Set());
  }
  migrateLegacyControls(db);
}

function migrateLegacyControls(db) {
  const entries = db.prepare(`
    SELECT character_id, fact_key, fact_identity_id
    FROM memory_entries
    WHERE fact_identity_id IS NOT NULL
  `).all();
  const identitiesByCharacterKey = new Map();
  const identitiesByKey = new Map();
  for (const entry of entries) {
    const hash = factKeyHash(entry.fact_key);
    addToSetMap(identitiesByCharacterKey, `${entry.character_id}\u0000${hash}`, entry.fact_identity_id);
    addToSetMap(identitiesByKey, hash, entry.fact_identity_id);
  }

  const addForgetIdentityControl = db.prepare(`
    INSERT OR IGNORE INTO memory_forget_identity_controls (
      character_id, identity_id, created_at
    ) VALUES (?, ?, ?)
  `);
  const addShareIdentityControl = db.prepare(`
    INSERT OR IGNORE INTO memory_share_identity_controls (identity_id, created_at)
    VALUES (?, ?)
  `);
  const markForgetControl = db.prepare(`
    UPDATE memory_forget_controls SET identity_id = ?, identity_migrated = 1
    WHERE character_id = ? AND fact_key_hash = ?
  `);
  const markShareControl = db.prepare(`
    UPDATE memory_share_controls SET identity_id = ?, identity_migrated = 1
    WHERE fact_key_hash = ?
  `);

  // 只处理尚未迁移的旧行；已处理行不再按当前键重新归因。
  const forgetRows = db.prepare(`
    SELECT character_id, fact_key_hash, created_at FROM memory_forget_controls
    WHERE identity_migrated = 0
  `).all();
  for (const row of forgetRows) {
    const identities = identitiesByCharacterKey.get(
      `${row.character_id}\u0000${row.fact_key_hash}`,
    );
    if (!identities || identities.size === 0) {
      // 没有现存条目可定位身份：保留旧键兼容保护，不猜造事实。
      markForgetControl.run(null, row.character_id, row.fact_key_hash);
      continue;
    }
    const identityIds = [...identities].sort();
    for (const identityId of identityIds) {
      addForgetIdentityControl.run(row.character_id, identityId, row.created_at);
    }
    markForgetControl.run(identityIds[0], row.character_id, row.fact_key_hash);
  }

  const shareRows = db.prepare(`
    SELECT fact_key_hash, created_at FROM memory_share_controls
    WHERE identity_migrated = 0
  `).all();
  for (const row of shareRows) {
    const identities = identitiesByKey.get(row.fact_key_hash);
    if (!identities || identities.size === 0) {
      markShareControl.run(null, row.fact_key_hash);
      continue;
    }
    const identityIds = [...identities].sort();
    for (const identityId of identityIds) {
      addShareIdentityControl.run(identityId, row.created_at);
    }
    // 多个身份共用旧键时逐个写入身份控制，并标记为已处理；不挑一个冒充全部。
    markShareControl.run(identityIds[0], row.fact_key_hash);
  }
}

function addToSetMap(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}
