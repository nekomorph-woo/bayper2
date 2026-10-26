/* S03a 本地独属记忆的 SQLite 表与最小数据操作。
   工厂显式接收现有连接，不创建第二个生产数据库；表结构可重复执行。
   FTS5 只是可重建索引，正文与权限控制的唯一事实来源仍是 memory_entries
   和无正文的控制/关系表。派生身份保存在 memory_derivations，不依赖父条目
   是否还存在；这样 A 仅自己忘记时不会抹掉 B 的派生性质。 */
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

  /* 用户明确“不要再分享这件事”的最小控制：按事实键摘要跨持有者生效，
     不保存正文，也不因某位持有者删除或纠正而自动解除。 */
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
    originCharacterId: row.origin_character_id,
    derived,
    derivedFromEntryId,
    narratorCharacterId: row.derived_narrator_id ?? null,
    derivationSourceId: row.derived_source_id ?? null,
    derivationSourceVersion: row.derived_source_version ?? null,
    kind: row.kind,
    body: row.body,
    trust: row.trust,
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
        id, character_id, fact_key, origin_character_id, derived_from_entry_id,
        kind, body, trust, importance, expires_at,
        source_id, source_version, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertDerivation: db.prepare(`
      INSERT INTO memory_derivations (
        entry_id, parent_entry_id, origin_character_id, narrator_character_id,
        source_id, source_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateEntry: db.prepare(`
      UPDATE memory_entries SET
        body = ?, trust = ?, importance = ?, expires_at = ?,
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
    hasForgetControl: db.prepare(`
      SELECT 1 AS found FROM memory_forget_controls
      WHERE character_id = ? AND fact_key_hash = ?
    `),
    addForgetControl: db.prepare(`
      INSERT OR IGNORE INTO memory_forget_controls (character_id, fact_key_hash, created_at)
      VALUES (?, ?, ?)
    `),
    hasSourceControl: db.prepare(`
      SELECT 1 AS found FROM memory_source_controls
      WHERE character_id = ? AND source_id_hash = ?
    `),
    addSourceControl: db.prepare(`
      INSERT OR IGNORE INTO memory_source_controls (character_id, source_id_hash, created_at)
      VALUES (?, ?, ?)
    `),
    hasShareControl: db.prepare(
      "SELECT 1 AS found FROM memory_share_controls WHERE fact_key_hash = ?",
    ),
    addShareControl: db.prepare(`
      INSERT OR IGNORE INTO memory_share_controls (fact_key_hash, created_at)
      VALUES (?, ?)
    `),
    removeShareControl: db.prepare(
      "DELETE FROM memory_share_controls WHERE fact_key_hash = ?",
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
      entry.originCharacterId,
      entry.derivedFromEntryId,
      entry.kind,
      entry.body,
      entry.trust,
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

  function hasForgetControl(characterId, factKeyHash) {
    return Boolean(statements.hasForgetControl.get(characterId, factKeyHash));
  }

  function addForgetControl(characterId, factKeyHash, createdAt) {
    statements.addForgetControl.run(characterId, factKeyHash, createdAt);
  }

  function hasSourceControl(characterId, sourceIdHash) {
    return Boolean(statements.hasSourceControl.get(characterId, sourceIdHash));
  }

  function addSourceControl(characterId, sourceIdHash, createdAt) {
    statements.addSourceControl.run(characterId, sourceIdHash, createdAt);
  }

  function hasShareControl(factKeyHash) {
    return Boolean(statements.hasShareControl.get(factKeyHash));
  }

  function addShareControl(factKeyHash, createdAt) {
    statements.addShareControl.run(factKeyHash, createdAt);
  }

  function removeShareControl(factKeyHash) {
    return statements.removeShareControl.run(factKeyHash).changes > 0;
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
    listActiveEntries,
    listActiveEntriesPage,
    listEntriesPage,
    isDerivedEntry,
    search,
    hasForgetControl,
    addForgetControl,
    hasSourceControl,
    addSourceControl,
    hasShareControl,
    addShareControl,
    removeShareControl,
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
