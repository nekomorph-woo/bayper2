/* S02a 陪伴数据。与 S01 共用同一个 SQLite 连接，负责名单、运行时状态与互动会话。
   迁移只做当前需要的结构：旧 S01 库保留模型密文、关系、数值和 fixed 名单，
   名单表扩展为 fixed + random_1..4，由 UNIQUE(day, character_id) 保证不重复。 */
const SCHEMA_VERSION = 1;
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];

const RUNTIME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS character_runtime (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    mode TEXT NOT NULL DEFAULT 'waiting' CHECK (mode IN ('companion', 'interacting', 'waiting', 'resting', 'offline')),
    last_settled_at INTEGER,
    last_participated_at INTEGER,
    last_auto_exit_at INTEGER,
    exploring INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    return_character_id TEXT REFERENCES relationships(character_id),
    temporary INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL
  );
`;

const ROSTER_SCHEMA = `
  CREATE TABLE roster_v2 (
    day TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('fixed', 'random_1', 'random_2', 'random_3', 'random_4')),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    PRIMARY KEY (day, slot),
    UNIQUE (day, character_id)
  )
`;

function createCompanionStore(db) {
  migrate(db);

  const statements = {
    listCompanions: db.prepare(`
      SELECT r.character_id, r.accepted_at, r.nickname,
             s.intimacy, s.energy, s.mood,
             c.mode, c.last_settled_at, c.last_participated_at,
             c.last_auto_exit_at, c.exploring
      FROM relationships r
      JOIN character_stats s ON s.character_id = r.character_id
      LEFT JOIN character_runtime c ON c.character_id = r.character_id
      ORDER BY r.accepted_at ASC, r.character_id ASC
    `),
    setNickname: db.prepare("UPDATE relationships SET nickname = ? WHERE character_id = ?"),
    getRoster: db.prepare(`
      SELECT day, slot, character_id
      FROM roster
      WHERE day = ?
      ORDER BY CASE slot
        WHEN 'fixed' THEN 0
        WHEN 'random_1' THEN 1
        WHEN 'random_2' THEN 2
        WHEN 'random_3' THEN 3
        WHEN 'random_4' THEN 4
        ELSE 9 END
    `),
    previousRosterDay: db.prepare(
      "SELECT day FROM roster WHERE day < ? ORDER BY day DESC LIMIT 1",
    ),
    deleteRosterDay: db.prepare("DELETE FROM roster WHERE day = ?"),
    insertRoster: db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)"),
    ensureRuntime: db.prepare(`
      INSERT OR IGNORE INTO character_runtime (character_id, mode, last_settled_at)
      VALUES (?, 'waiting', ?)
    `),
    fillRuntimeSettled: db.prepare(
      "UPDATE character_runtime SET last_settled_at = ? WHERE character_id = ? AND last_settled_at IS NULL",
    ),
    getRuntime: db.prepare("SELECT * FROM character_runtime WHERE character_id = ?"),
    setMode: db.prepare("UPDATE character_runtime SET mode = ? WHERE character_id = ?"),
    setSettled: db.prepare("UPDATE character_runtime SET last_settled_at = ? WHERE character_id = ?"),
    setParticipated: db.prepare(
      "UPDATE character_runtime SET last_participated_at = ? WHERE character_id = ?",
    ),
    setAutoExit: db.prepare(
      "UPDATE character_runtime SET last_auto_exit_at = ? WHERE character_id = ?",
    ),
    setEnergy: db.prepare("UPDATE character_stats SET energy = ? WHERE character_id = ?"),
    getInteraction: db.prepare("SELECT * FROM interactions WHERE id = 1"),
    saveInteraction: db.prepare(`
      INSERT INTO interactions (id, character_id, return_character_id, temporary, started_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        character_id = excluded.character_id,
        return_character_id = excluded.return_character_id,
        temporary = excluded.temporary,
        started_at = excluded.started_at
    `),
    clearInteraction: db.prepare("DELETE FROM interactions WHERE id = 1"),
  };

  function listCompanions() {
    return statements.listCompanions.all().map((row) => ({
      characterId: row.character_id,
      acceptedAt: row.accepted_at,
      nickname: row.nickname ?? null,
      stats: {
        intimacy: row.intimacy,
        energy: row.energy,
        mood: row.mood,
      },
      runtime: {
        mode: row.mode ?? "waiting",
        lastSettledAt: row.last_settled_at ?? null,
        lastParticipatedAt: row.last_participated_at ?? null,
        lastAutoExitAt: row.last_auto_exit_at ?? null,
        exploring: Boolean(row.exploring),
      },
    }));
  }

  function getCompanion(characterId) {
    return listCompanions().find((row) => row.characterId === characterId) ?? null;
  }

  function setNickname(characterId, nickname) {
    statements.setNickname.run(nickname, characterId);
  }

  function getRoster(day) {
    return statements.getRoster.all(day).map((row) => ({
      day: row.day,
      slot: row.slot,
      characterId: row.character_id,
    }));
  }

  function getPreviousRoster(day) {
    const previous = statements.previousRosterDay.get(day);
    return previous ? getRoster(previous.day) : [];
  }

  /* 陪伴业务的轻量事务入口。调用方把同一次业务动作的多个写入放在同一回调内；
     这里不实现 unit-of-work 或嵌套事务。 */
  function runInTransaction(fn) {
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

  function replaceRoster(day, entries) {
    statements.deleteRosterDay.run(day);
    for (const entry of entries) {
      statements.insertRoster.run(day, entry.slot, entry.characterId);
    }
  }

  function ensureRuntime(characterId, nowMs) {
    statements.ensureRuntime.run(characterId, nowMs);
    statements.fillRuntimeSettled.run(nowMs, characterId);
  }

  function getRuntime(characterId) {
    const row = statements.getRuntime.get(characterId);
    if (!row) {
      return null;
    }
    return {
      mode: row.mode,
      lastSettledAt: row.last_settled_at,
      lastParticipatedAt: row.last_participated_at,
      lastAutoExitAt: row.last_auto_exit_at,
      exploring: Boolean(row.exploring),
    };
  }

  function applySettlement(characterId, { energy, lastSettledAt }) {
    statements.setEnergy.run(energy, characterId);
    statements.setSettled.run(lastSettledAt, characterId);
  }

  function setMode(characterId, mode) {
    statements.setMode.run(mode, characterId);
  }

  function setLastSettled(characterId, at) {
    statements.setSettled.run(at, characterId);
  }

  function setLastParticipated(characterId, at) {
    statements.setParticipated.run(at, characterId);
  }

  function setLastAutoExit(characterId, at) {
    statements.setAutoExit.run(at, characterId);
  }

  function getInteraction() {
    const row = statements.getInteraction.get();
    if (!row) {
      return null;
    }
    return {
      characterId: row.character_id,
      returnCharacterId: row.return_character_id,
      temporary: Boolean(row.temporary),
      startedAt: row.started_at,
    };
  }

  function saveInteraction({ characterId, returnCharacterId, temporary, startedAt }) {
    statements.saveInteraction.run(characterId, returnCharacterId, temporary ? 1 : 0, startedAt);
  }

  function clearInteraction() {
    statements.clearInteraction.run();
  }

  return {
    listCompanions,
    getCompanion,
    setNickname,
    getRoster,
    getPreviousRoster,
    runInTransaction,
    replaceRoster,
    ensureRuntime,
    getRuntime,
    applySettlement,
    setMode,
    setLastSettled,
    setLastParticipated,
    setLastAutoExit,
    getInteraction,
    saveInteraction,
    clearInteraction,
  };
}

function migrate(db) {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version >= SCHEMA_VERSION) {
    db.exec(RUNTIME_SCHEMA);
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    ensureNicknameColumn(db);
    ensureRosterSchema(db);
    db.exec(RUNTIME_SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureNicknameColumn(db) {
  const columns = db.prepare("PRAGMA table_info(relationships)").all();
  if (!columns.some((column) => column.name === "nickname")) {
    db.exec("ALTER TABLE relationships ADD COLUMN nickname TEXT");
  }
}

function ensureRosterSchema(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roster'")
    .get();
  if (table?.sql?.includes("random_1")) {
    return;
  }

  db.exec("DROP TABLE IF EXISTS roster_v2");
  db.exec(ROSTER_SCHEMA);
  if (table) {
    db.exec(`
      INSERT OR IGNORE INTO roster_v2 (day, slot, character_id)
      SELECT day, slot, character_id FROM roster WHERE slot = 'fixed'
    `);
    db.exec("DROP TABLE roster");
  }
  db.exec("ALTER TABLE roster_v2 RENAME TO roster");
}

module.exports = { createCompanionStore, SCHEMA_VERSION, SLOTS };
