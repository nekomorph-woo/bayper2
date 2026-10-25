/* S02c 关系数值事件与心情自然恢复。
   只处理显式可信事件的亲密/心情结算；不生成事件、不读聊天、不调用模型。
   数值仍以 character_stats 为唯一真相；本模块只新增事件去重、每日额度、
   分类冷却与心情恢复锚点。所有事件写入与数值/额度/锚点更新在同一事务内。 */
const { AppError } = require("./errors.cjs");

const KINDS = new Set([
  "meaningful_interaction",
  "shared_activity",
  "pleasant_interaction",
  "interesting_activity",
  "activity_setback",
]);
const INTIMACY_KINDS = new Set(["meaningful_interaction", "shared_activity"]);
const MOOD_KINDS = new Set([
  "pleasant_interaction",
  "interesting_activity",
  "activity_setback",
]);
const RECOVERY_MS = 30 * 60 * 1000;
const POSITIVE_COOLDOWN_MS = 30 * 60 * 1000;
const NEGATIVE_COOLDOWN_MS = 60 * 60 * 1000;
const INTIMACY_MIN = 0;
const INTIMACY_MAX = 100;
const MOOD_MIN = -2;
const MOOD_MAX = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS relationship_events (
    event_id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'meaningful_interaction',
        'shared_activity',
        'pleasant_interaction',
        'interesting_activity',
        'activity_setback'
      )
    ),
    event_at INTEGER NOT NULL,
    intimacy_delta INTEGER NOT NULL,
    mood_delta INTEGER NOT NULL,
    result TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS relationship_events_character
    ON relationship_events (character_id, event_at);

  CREATE TABLE IF NOT EXISTS relationship_daily (
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    day TEXT NOT NULL,
    meaningful_interaction INTEGER NOT NULL DEFAULT 0,
    shared_activity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, day)
  );

  CREATE TABLE IF NOT EXISTS relationship_mood_state (
    character_id TEXT PRIMARY KEY REFERENCES relationships(character_id),
    anchor_at INTEGER NOT NULL,
    pleasant_at INTEGER,
    interesting_at INTEGER,
    setback_at INTEGER
  );
`;

function localDay(at) {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("INVALID_TIME", "事件时间必须是有效整数。");
  }
  return value;
}

function textOf(value, field, max = 200) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new AppError("INVALID_INPUT", `${field} 无效。`);
  }
  return text;
}

function createRelationshipEffects(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "关系数值事件需要 SQLite 连接。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    hasCharacter: db.prepare("SELECT 1 AS present FROM relationships WHERE character_id = ?"),
    listCharacters: db.prepare("SELECT character_id FROM relationships ORDER BY character_id"),
    getStats: db.prepare(
      "SELECT intimacy, mood FROM character_stats WHERE character_id = ?",
    ),
    setIntimacy: db.prepare("UPDATE character_stats SET intimacy = ? WHERE character_id = ?"),
    setMood: db.prepare("UPDATE character_stats SET mood = ? WHERE character_id = ?"),
    getEvent: db.prepare("SELECT * FROM relationship_events WHERE event_id = ?"),
    insertEvent: db.prepare(`
      INSERT INTO relationship_events
        (event_id, character_id, kind, event_at, intimacy_delta, mood_delta, result, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countEvents: db.prepare(
      "SELECT COUNT(*) AS count FROM relationship_events WHERE character_id = ?",
    ),
    getDaily: db.prepare(
      "SELECT * FROM relationship_daily WHERE character_id = ? AND day = ?",
    ),
    insertDaily: db.prepare(`
      INSERT INTO relationship_daily (character_id, day) VALUES (?, ?)
    `),
    setDailyMeaningful: db.prepare(`
      UPDATE relationship_daily SET meaningful_interaction = 1
      WHERE character_id = ? AND day = ?
    `),
    setDailyShared: db.prepare(`
      UPDATE relationship_daily SET shared_activity = 1
      WHERE character_id = ? AND day = ?
    `),
    getMoodState: db.prepare(
      "SELECT * FROM relationship_mood_state WHERE character_id = ?",
    ),
    insertMoodState: db.prepare(`
      INSERT INTO relationship_mood_state (character_id, anchor_at) VALUES (?, ?)
    `),
    setMoodAnchor: db.prepare(`
      UPDATE relationship_mood_state SET anchor_at = ? WHERE character_id = ?
    `),
    setMoodCooldown: db.prepare(`
      UPDATE relationship_mood_state
      SET pleasant_at = CASE WHEN ? = 'pleasant_interaction' THEN ? ELSE pleasant_at END,
          interesting_at = CASE WHEN ? = 'interesting_activity' THEN ? ELSE interesting_at END,
          setback_at = CASE WHEN ? = 'activity_setback' THEN ? ELSE setback_at END
      WHERE character_id = ?
    `),
  };

  function transact(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败不覆盖原始业务错误。
      }
      throw error;
    }
  }

  function requireCharacter(characterId) {
    if (!statements.hasCharacter.get(characterId)) {
      throw new AppError("CHARACTER_UNKNOWN", "角色不存在。");
    }
  }

  function statsOf(characterId) {
    const row = statements.getStats.get(characterId);
    if (!row) {
      throw new AppError("CHARACTER_UNKNOWN", "角色不存在。");
    }
    return { intimacy: Number(row.intimacy), mood: Number(row.mood) };
  }

  /* 首次看见角色时建立锚点，不臆测过去心情；回拨时不回退锚点。 */
  function moodStateOf(characterId, at) {
    let state = statements.getMoodState.get(characterId);
    if (!state) {
      statements.insertMoodState.run(characterId, at);
      state = statements.getMoodState.get(characterId);
    }
    return state;
  }

  function settleOne(characterId, at) {
    const stats = statsOf(characterId);
    const state = moodStateOf(characterId, at);
    if (at <= state.anchor_at) {
      return stats.mood;
    }
    const steps = Math.floor((at - state.anchor_at) / RECOVERY_MS);
    if (steps <= 0 || stats.mood === 0) {
      return stats.mood;
    }
    const mood =
      stats.mood > 0
        ? Math.max(0, stats.mood - steps)
        : Math.min(0, stats.mood + steps);
    if (mood !== stats.mood) {
      statements.setMood.run(mood, characterId);
      statements.setMoodAnchor.run(state.anchor_at + steps * RECOVERY_MS, characterId);
    }
    return mood;
  }

  /* companion 的 start/prepare/恢复等真实入口调用；同一时刻重复调用无额外收益。 */
  function settleMoods(atValue) {
    const at = validTime(atValue);
    return transact(() => {
      for (const row of statements.listCharacters.all()) {
        settleOne(row.character_id, at);
      }
    });
  }

  function cooldownAllows(lastAt, at, interval) {
    return lastAt === null || at >= Number(lastAt) + interval;
  }

  function applyMoodEvent(characterId, kind, at) {
    settleOne(characterId, at);
    const stats = statsOf(characterId);
    const state = statements.getMoodState.get(characterId);
    let lastAt = null;
    let delta = 0;
    let interval = POSITIVE_COOLDOWN_MS;
    if (kind === "pleasant_interaction") {
      lastAt = state.pleasant_at;
    } else if (kind === "interesting_activity") {
      lastAt = state.interesting_at;
    } else {
      lastAt = state.setback_at;
      delta = -1;
      interval = NEGATIVE_COOLDOWN_MS;
    }
    if (kind !== "activity_setback") {
      delta = 1;
    }
    if (!cooldownAllows(lastAt, at, interval)) {
      return { moodDelta: 0, result: "cooldown", stats };
    }
    const target = Math.min(MOOD_MAX, Math.max(MOOD_MIN, stats.mood + delta));
    const actual = target - stats.mood;
    if (actual === 0) {
      return { moodDelta: 0, result: "capped", stats };
    }
    statements.setMood.run(target, characterId);
    statements.setMoodAnchor.run(Math.max(Number(state.anchor_at), at), characterId);
    statements.setMoodCooldown.run(kind, at, kind, at, kind, at, characterId);
    return {
      moodDelta: actual,
      result: "applied",
      stats: { intimacy: stats.intimacy, mood: target },
    };
  }

  function applyIntimacyEvent(characterId, kind, at) {
    const day = localDay(at);
    let daily = statements.getDaily.get(characterId, day);
    if (!daily) {
      statements.insertDaily.run(characterId, day);
      daily = statements.getDaily.get(characterId, day);
    }
    const column =
      kind === "meaningful_interaction" ? "meaningful_interaction" : "shared_activity";
    if (daily[column] === 1) {
      return { intimacyDelta: 0, result: "daily_already", stats: statsOf(characterId) };
    }
    if (kind === "meaningful_interaction") {
      statements.setDailyMeaningful.run(characterId, day);
    } else {
      statements.setDailyShared.run(characterId, day);
    }
    const stats = statsOf(characterId);
    if (stats.intimacy >= INTIMACY_MAX) {
      return { intimacyDelta: 0, result: "capped", stats };
    }
    const intimacy = Math.min(INTIMACY_MAX, Math.max(INTIMACY_MIN, stats.intimacy + 1));
    statements.setIntimacy.run(intimacy, characterId);
    return {
      intimacyDelta: intimacy - stats.intimacy,
      result: "applied",
      stats: { intimacy, mood: stats.mood },
    };
  }

  function recordRelationshipEvent(input = {}) {
    const eventId = textOf(input.eventId, "eventId", 200);
    const characterId = textOf(input.characterId, "characterId", 200);
    if (!KINDS.has(input.kind)) {
      throw new AppError("INVALID_INPUT", "事件类别无效。");
    }
    const at = validTime(input.at);

    return transact(() => {
      requireCharacter(characterId);
      const existing = statements.getEvent.get(eventId);
      if (existing) {
        if (existing.character_id !== characterId || existing.kind !== input.kind) {
          throw new AppError("EVENT_CONFLICT", "同一事件ID不能对应不同角色或类别。");
        }
        return {
          eventId,
          characterId,
          kind: input.kind,
          at: Number(existing.event_at),
          duplicate: true,
          intimacyDelta: Number(existing.intimacy_delta),
          moodDelta: Number(existing.mood_delta),
          result: existing.result,
          stats: statsOf(characterId),
        };
      }

      let delta;
      if (INTIMACY_KINDS.has(input.kind)) {
        const outcome = applyIntimacyEvent(characterId, input.kind, at);
        delta = {
          intimacyDelta: outcome.intimacyDelta,
          moodDelta: 0,
          result: outcome.result,
          stats: outcome.stats,
        };
      } else {
        const outcome = applyMoodEvent(characterId, input.kind, at);
        delta = {
          intimacyDelta: 0,
          moodDelta: outcome.moodDelta,
          result: outcome.result,
          stats: outcome.stats,
        };
      }

      statements.insertEvent.run(
        eventId,
        characterId,
        input.kind,
        at,
        delta.intimacyDelta,
        delta.moodDelta,
        delta.result,
        at,
      );
      return {
        eventId,
        characterId,
        kind: input.kind,
        at,
        duplicate: false,
        intimacyDelta: delta.intimacyDelta,
        moodDelta: delta.moodDelta,
        result: delta.result,
        stats: statsOf(characterId),
      };
    });
  }

  return { recordRelationshipEvent, settleMoods };
}

module.exports = { createRelationshipEffects, KINDS, localDay };
