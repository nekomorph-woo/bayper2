/* S06a 全应用自动模型发送预算。
   统一限制来源分析、故事与共享等自动用途的发送尝试；显式聊天不经过本模块。
   工厂显式接收现有 SQLite 连接，所有判断与状态变化都在事务内完成，不做
   内存假状态、自动重试、补发或定时器。本模块只负责预算与占位生命周期，
   名单、优先级、抽签和实际网络取消仍由上层负责。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");

const HOUR = 60 * 60 * 1000;
const LIMITS = Object.freeze({ hour: 1, eightHours: 4, day: 6 });
const CHARACTER_COOLDOWN = 2 * HOUR;

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout", "cancelled", "interrupted"]);
const OUTCOMES = new Set(["success", "failed", "timeout"]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS automatic_budget_attempts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    character_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (
      status IN ('reserved', 'in_flight', 'success', 'failed', 'timeout', 'cancelled', 'interrupted')
    ),
    sent INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0, 1)),
    sent_at INTEGER,
    finished_at INTEGER,
    CHECK ((sent = 0 AND sent_at IS NULL) OR (sent = 1 AND sent_at IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS automatic_budget_sent_at
    ON automatic_budget_attempts (sent, sent_at);
  CREATE INDEX IF NOT EXISTS automatic_budget_character
    ON automatic_budget_attempts (character_id, sent, sent_at);

  /* 数据库层再保证全局最多一个预留/在途记录，避免多实例绕过应用检查。 */
  CREATE UNIQUE INDEX IF NOT EXISTS automatic_budget_one_active
    ON automatic_budget_attempts ((1))
    WHERE status IN ('reserved', 'in_flight');

  CREATE TABLE IF NOT EXISTS automatic_budget_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function cleanText(value, field, max = 200) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new AppError("INVALID_INPUT", `${field} 长度无效。`);
  }
  return text;
}

function createAutomaticBudget({ db, now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "自动预算需要显式传入 SQLite 连接。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    getState: db.prepare("SELECT value FROM automatic_budget_state WHERE key = 'logical_time'"),
    setState: db.prepare(`
      INSERT INTO automatic_budget_state (key, value) VALUES ('logical_time', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    byRequest: db.prepare("SELECT * FROM automatic_budget_attempts WHERE request_id = ?"),
    byId: db.prepare("SELECT * FROM automatic_budget_attempts WHERE id = ?"),
    active: db.prepare(`
      SELECT id, character_id, status FROM automatic_budget_attempts
      WHERE status IN ('reserved', 'in_flight')
      LIMIT 1
    `),
    insert: db.prepare(`
      INSERT INTO automatic_budget_attempts
        (id, request_id, character_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    interruptActive: db.prepare(`
      UPDATE automatic_budget_attempts
      SET status = 'interrupted', finished_at = ?, updated_at = ?
      WHERE status IN ('reserved', 'in_flight')
    `),
    start: db.prepare(`
      UPDATE automatic_budget_attempts
      SET sent = 1, sent_at = ?, status = 'in_flight', updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `),
    finish: db.prepare(`
      UPDATE automatic_budget_attempts
      SET status = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'in_flight'
    `),
    cancel: db.prepare(`
      UPDATE automatic_budget_attempts
      SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('reserved', 'in_flight')
    `),
    counts: db.prepare(`
      SELECT
        SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS hour,
        SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS eight,
        SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS day
      FROM automatic_budget_attempts
      WHERE sent = 1 AND sent_at <= ?
    `),
    lastForCharacter: db.prepare(`
      SELECT MAX(sent_at) AS last FROM automatic_budget_attempts
      WHERE sent = 1 AND character_id = ?
    `),
  };

  function observedNow() {
    const value = typeof now === "function" ? now() : now;
    const ms = value instanceof Date ? value.getTime() : Math.trunc(Number(value));
    if (!Number.isFinite(ms)) {
      throw new AppError("INVALID_TIME", "时间必须是有效数字。");
    }
    return ms;
  }

  /* 逻辑时间只取持久化最大值与注入时钟的较大者，不修改系统时钟。
     回拨时旧记录与冷却仍按原时间生效；时钟恢复到更高值后按实际时间继续。
     构造恢复与每次写操作都会持久化该值，避免回拨抹掉未来记录。 */
  function logicalNow() {
    const row = statements.getState.get();
    const stored = row ? Number(row.value) : 0;
    return Math.max(Number.isFinite(stored) ? stored : 0, observedNow());
  }

  function persistLogicalTime(at) {
    statements.setState.run(String(at));
  }

  function transact(work) {
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败不覆盖原始业务错误。
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("BUDGET_STORAGE_FAILED", "自动预算存储操作失败，请稍后重试。");
    }
  }

  function countsAt(at) {
    const row = statements.counts.get(at - HOUR, at - 8 * HOUR, at - 24 * HOUR, at);
    return {
      hour: Number(row.hour ?? 0),
      eight: Number(row.eight ?? 0),
      day: Number(row.day ?? 0),
    };
  }

  function lastSentFor(characterId) {
    const value = statements.lastForCharacter.get(characterId).last;
    return value === null ? null : Number(value);
  }

  function budgetBlock(counts, lastSentAt, at) {
    if (counts.hour >= LIMITS.hour) {
      return "HOURLY_LIMIT";
    }
    if (counts.eight >= LIMITS.eightHours) {
      return "EIGHT_HOUR_LIMIT";
    }
    if (counts.day >= LIMITS.day) {
      return "DAILY_LIMIT";
    }
    if (lastSentAt !== null && lastSentAt > at - CHARACTER_COOLDOWN) {
      return "CHARACTER_COOLDOWN";
    }
    return null;
  }

  /* 构造时恢复上次未终结记录：已发送的保留消耗，未发送的保持 sent=0，
     两者都释放全局占位。约定每个运行实例只构造一次；不能用构造恢复去
     主动释放另一个仍在运行的实例。 */
  transact(() => {
    const at = logicalNow();
    statements.interruptActive.run(at, at);
    persistLogicalTime(at);
  });

  function reserve({ requestId, characterId } = {}) {
    const request = cleanText(requestId, "requestId");
    const character = cleanText(characterId, "characterId");
    return transact(() => {
      const at = logicalNow();
      persistLogicalTime(at);

      const existing = statements.byRequest.get(request);
      if (existing) {
        return {
          reserved: false,
          token: existing.id,
          reason: "DUPLICATE_REQUEST",
          status: existing.status,
        };
      }
      const active = statements.active.get();
      if (active) {
        return { reserved: false, token: null, reason: "BUSY", status: active.status };
      }
      const blocked = budgetBlock(countsAt(at), lastSentFor(character), at);
      if (blocked) {
        return { reserved: false, token: null, reason: blocked };
      }

      const token = crypto.randomUUID();
      statements.insert.run(token, request, character, at, at);
      return { reserved: true, token, reason: null };
    });
  }

  /* 首次 begin 才返回 canSend=true；重复调用或已结束令牌一律 false。
     预算复核失败会取消未发送预留并释放占位，调用方不得再发网络。 */
  function beginAttempt(tokenValue) {
    const token = cleanText(tokenValue, "token");
    return transact(() => {
      const at = logicalNow();
      persistLogicalTime(at);
      const row = statements.byId.get(token);
      if (!row) {
        throw new AppError("ATTEMPT_NOT_FOUND", "自动发送预留不存在。");
      }
      if (row.status !== "reserved") {
        return { canSend: false, status: row.status, reason: "ALREADY_STARTED" };
      }
      const blocked = budgetBlock(countsAt(at), lastSentFor(row.character_id), at);
      if (blocked) {
        statements.cancel.run(at, at, row.id);
        return { canSend: false, status: "cancelled", reason: blocked };
      }
      const result = statements.start.run(at, at, row.id);
      if (Number(result.changes) !== 1) {
        return { canSend: false, status: "reserved", reason: "NOT_RESERVED" };
      }
      return { canSend: true, status: "in_flight", sentAt: at };
    });
  }

  function finish(tokenValue, outcome) {
    const token = cleanText(tokenValue, "token");
    if (!OUTCOMES.has(outcome)) {
      throw new AppError("INVALID_INPUT", "发送结果无效。");
    }
    return transact(() => {
      const at = logicalNow();
      persistLogicalTime(at);
      const row = statements.byId.get(token);
      if (!row) {
        throw new AppError("ATTEMPT_NOT_FOUND", "自动发送预留不存在。");
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        return { finished: true, status: row.status, sent: row.sent === 1, duplicate: true };
      }
      if (row.status === "reserved") {
        // 未发送尝试不能宣称发送结果；由 cancel 结束并释放占位。
        return { finished: false, status: "reserved", sent: false, reason: "NOT_SENT" };
      }
      const result = statements.finish.run(outcome, at, at, row.id);
      if (Number(result.changes) !== 1) {
        const current = statements.byId.get(token);
        return { finished: true, status: current.status, sent: current.sent === 1, duplicate: true };
      }
      return { finished: true, status: outcome, sent: true, duplicate: false };
    });
  }

  /* 发送前取消不消耗次数；发送后取消保留已消耗尝试，二者都释放占位。 */
  function cancel(tokenValue) {
    const token = cleanText(tokenValue, "token");
    return transact(() => {
      const at = logicalNow();
      persistLogicalTime(at);
      const row = statements.byId.get(token);
      if (!row) {
        throw new AppError("ATTEMPT_NOT_FOUND", "自动发送预留不存在。");
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        return { cancelled: true, status: row.status, sent: row.sent === 1, duplicate: true };
      }
      statements.cancel.run(at, at, row.id);
      return { cancelled: true, status: "cancelled", sent: row.sent === 1, duplicate: false };
    });
  }

  function status(characterIdValue) {
    const character = cleanText(characterIdValue, "characterId");
    const at = logicalNow();
    const counts = countsAt(at);
    const lastSentAt = lastSentFor(character);
    const active = statements.active.get();
    return {
      now: at,
      characterId: character,
      sentLastHour: counts.hour,
      sentLast8Hours: counts.eight,
      sentLast24Hours: counts.day,
      characterLastSentAt: lastSentAt,
      characterCooldownUntil:
        lastSentAt === null ? null : lastSentAt + CHARACTER_COOLDOWN,
      activeAttempt: active
        ? { characterId: active.character_id, status: active.status }
        : null,
      canReserve: !active && budgetBlock(counts, lastSentAt, at) === null,
    };
  }

  return { reserve, beginAttempt, finish, cancel, status };
}

module.exports = { createAutomaticBudget };
