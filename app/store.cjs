/* S01 的本地持久化。数据库文件位于显式数据目录（生产为用户应用目录，
   测试由 --data-dir 注入），只保存配置密文、关系、初始数值和安排。 */
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createCompanionStore } = require("./companion-store.cjs");
const { createConnectorLedger } = require("./connector-ledger.cjs");
const { createMemoryService } = require("./memory.cjs");
const { createChatService } = require("./chat.cjs");
const { createExternalSources } = require("./external-sources.cjs");
const { createAutomaticBudget } = require("./automatic-budget.cjs");
const { createSessionSourceReader } = require("./session-sources.cjs");
const { createSourceAnalysis } = require("./source-analysis.cjs");

const DB_FILE_NAME = "bayper.sqlite3";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key_cipher BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS relationships (
    character_id TEXT PRIMARY KEY,
    accepted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS character_stats (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    intimacy INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    mood INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roster (
    day TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot = 'fixed'),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    PRIMARY KEY (day, slot)
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const INITIAL_STATS = Object.freeze({ intimacy: 10, energy: 100, mood: 0 });

function createStore(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DB_FILE_NAME);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // 工具有时会短暂打开同一 SQLite 读取；等待其释放锁，超时仍返回真实错误。
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(SCHEMA);
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const now = () => {
    const value = clock();
    return value instanceof Date ? value.getTime() : value;
  };
  // S05i 连接账本复用唯一 SQLite 连接；appRunId 只在本次进程内稳定。
  const appRunId = `app-${crypto.randomUUID()}`;
  const connectorLedger = createConnectorLedger({ db, now, appRunId });

  // S02a 迁移与陪伴方法共用这一条连接，关闭仍由 store 统一负责。
  const companion = createCompanionStore(db);
  // S03 记忆与聊天共用同一连接；不另建生产数据库。
  const memory = createMemoryService({ db, now });
  const chat = createChatService({
    db,
    memory,
    now,
    characters: options.characters,
    getCredentials: options.chat?.getCredentials,
    fetchImpl: options.chat?.fetchImpl,
    timeoutMs: options.chat?.timeoutMs,
    recoverInterrupted: options.chat?.recoverInterrupted,
  });
  // 来源授权与记忆/聊天共用同一 SQLite 连接；候选路径由主进程按已核实约定传入。
  const externalSources = createExternalSources({
    db,
    candidates: options.sources?.candidates ?? [],
    now,
  });
  // S04e 只在主进程提供分析依赖时组装；不把 db、Key 或许可暴露给 renderer。
  let automaticBudget = null;
  let sessionSources = null;
  let sourceAnalysis = null;
  if (options.sourceAnalysis) {
    automaticBudget = createAutomaticBudget({ db, now });
    sessionSources = createSessionSourceReader({ permissions: externalSources });
    sourceAnalysis = createSourceAnalysis({
      db,
      memory,
      permissions: externalSources,
      reader: sessionSources,
      budget: automaticBudget,
      getCredentials: options.sourceAnalysis.getCredentials,
      isEligible: options.sourceAnalysis.isEligible,
      now,
    });
  }

  const statements = {
    getModel: db.prepare(
      "SELECT base_url, model_name, api_key_cipher FROM model_config WHERE id = 1",
    ),
    saveModel: db.prepare(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        model_name = excluded.model_name,
        api_key_cipher = excluded.api_key_cipher,
        updated_at = excluded.updated_at
    `),
    getRelationship: db.prepare(`
      SELECT r.character_id, r.accepted_at, s.intimacy, s.energy, s.mood
      FROM relationships r
      JOIN character_stats s ON s.character_id = r.character_id
      LIMIT 1
    `),
    insertRelationship: db.prepare(
      "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    ),
    insertStats: db.prepare(
      "INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, ?, ?, ?)",
    ),
    insertRoster: db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', ?)"),
    setState: db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    getState: db.prepare("SELECT value FROM app_state WHERE key = ?"),
    getRoster: db.prepare("SELECT slot, character_id FROM roster WHERE day = ? ORDER BY slot"),
  };

  function getModelConfig() {
    const row = statements.getModel.get();
    if (!row) {
      return null;
    }
    return {
      baseUrl: row.base_url,
      modelName: row.model_name,
      keyCipher: row.api_key_cipher,
    };
  }

  function saveModelConfig({ baseUrl, modelName, keyCipher, updatedAt }) {
    statements.saveModel.run(baseUrl, modelName, keyCipher, updatedAt);
  }

  function getRelationship() {
    const row = statements.getRelationship.get();
    if (!row) {
      return null;
    }
    return {
      characterId: row.character_id,
      acceptedAt: row.accepted_at,
      stats: { intimacy: row.intimacy, energy: row.energy, mood: row.mood },
    };
  }

  /* 接纳是单个事务：关系、初始数值、固定位、当日名单和当前角色要么一起写入，
     要么完全不写入。重复调用返回已有关系，不重复创建。 */
  function acceptCharacter({ characterId, day, acceptedAt }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = getRelationship();
      if (existing) {
        db.exec("COMMIT");
        return { created: false, ...existing };
      }

      statements.insertRelationship.run(characterId, acceptedAt);
      statements.insertStats.run(
        characterId,
        INITIAL_STATS.intimacy,
        INITIAL_STATS.energy,
        INITIAL_STATS.mood,
      );
      statements.insertRoster.run(day, characterId);
      statements.setState.run("current_character_id", characterId);
      statements.setState.run("fixed_character_id", characterId);
      db.exec("COMMIT");

      return {
        created: true,
        characterId,
        acceptedAt,
        stats: { ...INITIAL_STATS },
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getAppState(key) {
    return statements.getState.get(key)?.value ?? null;
  }

  function setAppState(key, value) {
    statements.setState.run(key, value);
  }

  function getTodayRoster(day) {
    return statements.getRoster.all(day).map((row) => ({
      slot: row.slot,
      characterId: row.character_id,
    }));
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    appRunId,
    connectorLedger,
    ...companion,
    memory,
    chat,
    externalSources,
    automaticBudget,
    sessionSources,
    sourceAnalysis,
    getModelConfig,
    saveModelConfig,
    getRelationship,
    acceptCharacter,
    getAppState,
    setAppState,
    getTodayRoster,
    close,
  };
}

module.exports = { createStore, INITIAL_STATS, DB_FILE_NAME };
