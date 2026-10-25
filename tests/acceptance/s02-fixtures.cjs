/* S02a 验收夹具：独立实现日期与旧库结构，避免用被测代码生成 Oracle。 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE = "bayper.sqlite3";

const LEGACY_SCHEMA = `
  CREATE TABLE model_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key_cipher BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE relationships (
    character_id TEXT PRIMARY KEY,
    accepted_at TEXT NOT NULL
  );
  CREATE TABLE character_stats (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    intimacy INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    mood INTEGER NOT NULL
  );
  CREATE TABLE roster (
    day TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot = 'fixed'),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    PRIMARY KEY (day, slot)
  );
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function localDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dbPath(dataDir) {
  return path.join(dataDir, DB_FILE);
}

/* 构造 S01 版本的数据库文件，不经过 createStore，以便真实覆盖迁移。 */
function createLegacyDatabase(dataDir, options) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.exec(LEGACY_SCHEMA);
    db.prepare(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(
      options.baseUrl ?? "https://legacy.example.com/v1",
      options.modelName ?? "legacy-model",
      options.modelCipher ?? Buffer.from([1, 2, 3, 4]),
      options.updatedAt ?? "2026-10-20T00:00:00.000Z",
    );

    for (const character of options.characters) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        character.id,
        character.acceptedAt,
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, ?, ?, ?)
      `).run(
        character.id,
        character.intimacy ?? 10,
        character.energy ?? 100,
        character.mood ?? 0,
      );
    }

    const fixedId = options.fixedId ?? options.characters[0]?.id;
    const currentId = options.currentId ?? fixedId;
    if (fixedId) {
      setState(db, "fixed_character_id", fixedId);
      setState(db, "current_character_id", currentId);
    }
    if (options.rosterDay && fixedId) {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', ?)").run(
        options.rosterDay,
        fixedId,
      );
    }
  } finally {
    db.close();
  }
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function readRelationships(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
  try {
    return db
      .prepare(`
        SELECT r.character_id, r.accepted_at, r.nickname,
               s.intimacy, s.energy, s.mood
        FROM relationships r
        JOIN character_stats s ON s.character_id = r.character_id
        ORDER BY r.character_id
      `)
      .all();
  } finally {
    db.close();
  }
}

module.exports = {
  DB_FILE,
  LEGACY_SCHEMA,
  localDay,
  dbPath,
  createLegacyDatabase,
  readRelationships,
};
