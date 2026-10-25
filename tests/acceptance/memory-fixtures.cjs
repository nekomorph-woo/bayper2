/* S03a 验收夹具：用真实 SQLite 文件和 S01 基础 schema 打开连接，
   不经过 createStore，也不 Mock 记忆服务。角色关系由测试构造。 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE = "bayper.sqlite3";

const BASE_SCHEMA = `
  CREATE TABLE relationships (
    character_id TEXT PRIMARY KEY,
    accepted_at TEXT NOT NULL,
    nickname TEXT
  );
  CREATE TABLE character_stats (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    intimacy INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    mood INTEGER NOT NULL
  );
  CREATE TABLE roster (
    day TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('fixed', 'random_1', 'random_2', 'random_3', 'random_4')),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    PRIMARY KEY (day, slot),
    UNIQUE (day, character_id)
  );
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function dbPath(dataDir) {
  return path.join(dataDir, DB_FILE);
}

function createMemoryDatabase(dataDir, characters) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath(dataDir));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  const insertRelationship = db.prepare(
    "INSERT INTO relationships (character_id, accepted_at, nickname) VALUES (?, ?, ?)",
  );
  const insertStats = db.prepare(`
    INSERT INTO character_stats (character_id, intimacy, energy, mood)
    VALUES (?, 10, 100, 0)
  `);
  for (const character of characters) {
    const id = typeof character === "string" ? character : character.id;
    const nickname = typeof character === "string" ? null : (character.nickname ?? null);
    insertRelationship.run(id, "2026-01-01T00:00:00.000Z", nickname);
    insertStats.run(id);
  }
  return { db, dbPath: dbPath(dataDir) };
}

function openMemoryDatabase(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

module.exports = { DB_FILE, BASE_SCHEMA, dbPath, createMemoryDatabase, openMemoryDatabase };
