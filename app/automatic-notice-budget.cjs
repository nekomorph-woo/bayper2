/* S06m 自动告知的实际显示收据与全局滚动额度。
   只有真实可见回执才写收据；全部来源共享 1 小时最多 1 次、8 小时最多 3 次。
   逻辑时间取注入时钟与已有收据最大时间的较大者，时钟回拨不会提前重开额度。
   本模块只读写收据，不判断内容资格，也不开启自己的事务。 */
const { AppError } = require("./errors.cjs");

const HOUR_MS = 60 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * HOUR_MS;
const LIMITS = Object.freeze({ hour: 1, eightHours: 3 });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS automatic_notice_receipts (
    source_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('outfit', 'invitation')),
    story_id TEXT NOT NULL,
    presented_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automatic_notice_receipts_presented
    ON automatic_notice_receipts (presented_at);
`;

function createAutomaticNoticeBudget({ db, now = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "自动告知额度需要 SQLite 连接。");
  }
  db.exec(SCHEMA);

  const statements = {
    bySource: db.prepare(
      "SELECT * FROM automatic_notice_receipts WHERE source_key = ?",
    ),
    latest: db.prepare("SELECT MAX(presented_at) AS at FROM automatic_notice_receipts"),
    counts: db.prepare(`
      SELECT
        SUM(CASE WHEN presented_at > ? THEN 1 ELSE 0 END) AS hour,
        SUM(CASE WHEN presented_at > ? THEN 1 ELSE 0 END) AS eight
      FROM automatic_notice_receipts
      WHERE presented_at <= ?
    `),
    insert: db.prepare(`
      INSERT OR IGNORE INTO automatic_notice_receipts
        (source_key, kind, story_id, presented_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
  };

  function observedNow() {
    const value = now();
    const at = value instanceof Date ? value.getTime() : Math.trunc(Number(value));
    if (!Number.isFinite(at)) {
      throw new AppError("CLOCK_INVALID", "自动告知时钟无效。");
    }
    return at;
  }

  function logicalNow() {
    const latest = Number(statements.latest.get()?.at ?? 0);
    return Math.max(Number.isFinite(latest) ? latest : 0, observedNow());
  }

  function receiptPublic(row) {
    if (!row) {
      return null;
    }
    return {
      sourceKey: row.source_key,
      kind: row.kind,
      storyId: row.story_id,
      presentedAt: Number(row.presented_at),
    };
  }

  function getReceipt(sourceKey) {
    return receiptPublic(statements.bySource.get(sourceKey));
  }

  function statusAt(at) {
    const row = statements.counts.get(at - HOUR_MS, at - EIGHT_HOURS_MS, at);
    const shownLastHour = Number(row.hour ?? 0);
    const shownLast8Hours = Number(row.eight ?? 0);
    let reason = null;
    if (shownLastHour >= LIMITS.hour) {
      reason = "HOURLY_LIMIT";
    } else if (shownLast8Hours >= LIMITS.eightHours) {
      reason = "EIGHT_HOUR_LIMIT";
    }
    return {
      now: at,
      shownLastHour,
      shownLast8Hours,
      canPresent: reason === null,
      reason,
    };
  }

  function status() {
    return statusAt(logicalNow());
  }

  /* 由 ACK 在外层事务内调用；重复来源不覆盖首次实际显示时间。 */
  function record({ sourceKey, kind, storyId } = {}) {
    if (!["outfit", "invitation"].includes(kind)) {
      throw new AppError("INVALID_INPUT", "自动告知类型无效。");
    }
    const at = logicalNow();
    const result = statements.insert.run(sourceKey, kind, storyId, at, at);
    return {
      recorded: Number(result.changes) === 1,
      duplicate: Number(result.changes) !== 1,
      receipt: getReceipt(sourceKey),
    };
  }

  return { getReceipt, record, status, statusAt, logicalNow };
}

module.exports = { createAutomaticNoticeBudget };
