/* S06c 日常与探索的活动事实存储。
   只保存活动身份、种类、生命周期状态、时长与有效进度；角色数值、名单、
   当前同屏与精力结算仍由既有 companionship/store 维护。写操作沿用同一
   SQLite 连接，由 companionship 组织事务边界，不另建定时器或 workflow。 */
const { AppError } = require("./errors.cjs");

const DURATIONS = Object.freeze({
  daily: 10 * 1000,
  exploration: 20 * 60 * 1000,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS character_activities (
    activity_id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    kind TEXT NOT NULL CHECK (kind IN ('daily', 'exploration')),
    status TEXT NOT NULL CHECK (
      status IN ('scheduled', 'running', 'paused', 'completed', 'cancelled')
    ),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_elapsed_ms >= 0),
    started_at INTEGER,
    last_progress_at INTEGER,
    completed_at INTEGER,
    action_completed_at INTEGER,
    action_frame INTEGER NOT NULL DEFAULT 0 CHECK (action_frame >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS character_activities_open
    ON character_activities (status, character_id);
  CREATE INDEX IF NOT EXISTS character_activities_started
    ON character_activities (kind, started_at);
`;

function createCharacterActivities(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "活动存储需要 SQLite 连接。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // 旧库补列：daily 的真实动作完成与播放进度只增列，不另建活动系统。
  const columns = db.prepare("PRAGMA table_info(character_activities)").all();
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("action_completed_at")) {
    db.exec("ALTER TABLE character_activities ADD COLUMN action_completed_at INTEGER");
  }
  if (!columnNames.has("action_frame")) {
    db.exec(
      "ALTER TABLE character_activities ADD COLUMN action_frame INTEGER NOT NULL DEFAULT 0",
    );
  }

  const statements = {
    get: db.prepare("SELECT * FROM character_activities WHERE activity_id = ?"),
    openForCharacter: db.prepare(`
      SELECT * FROM character_activities
      WHERE character_id = ? AND status IN ('scheduled', 'running', 'paused')
      ORDER BY created_at DESC, activity_id DESC LIMIT 1
    `),
    scheduled: db.prepare(`
      SELECT * FROM character_activities
      WHERE status = 'scheduled'
      ORDER BY created_at ASC, activity_id ASC LIMIT 1
    `),
    listOpen: db.prepare(`
      SELECT * FROM character_activities
      WHERE status IN ('scheduled', 'running', 'paused')
      ORDER BY created_at ASC, activity_id ASC
    `),
    listRunning: db.prepare(`
      SELECT * FROM character_activities WHERE status = 'running'
      ORDER BY last_progress_at ASC, activity_id ASC
    `),
    listCompletedSince: db.prepare(`
      SELECT * FROM character_activities
      WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at > ?
      ORDER BY completed_at ASC, activity_id ASC
    `),
    countStarted: db.prepare(`
      SELECT COUNT(*) AS count FROM character_activities
      WHERE kind = ? AND started_at IS NOT NULL AND started_at > ?
    `),
    insert: db.prepare(`
      INSERT INTO character_activities
        (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms, created_at, updated_at)
      VALUES (?, ?, ?, 'scheduled', ?, 0, ?, ?)
    `),
    start: db.prepare(`
      UPDATE character_activities
      SET status = 'running', started_at = ?, last_progress_at = ?, updated_at = ?
      WHERE activity_id = ? AND status = 'scheduled'
    `),
    advance: db.prepare(`
      UPDATE character_activities
      SET active_elapsed_ms = active_elapsed_ms + ?, last_progress_at = ?, updated_at = ?
      WHERE activity_id = ? AND status = 'running'
    `),
    pause: db.prepare(`
      UPDATE character_activities
      SET status = 'paused', updated_at = ?
      WHERE activity_id = ? AND status = 'running'
    `),
    resume: db.prepare(`
      UPDATE character_activities
      SET status = 'running', last_progress_at = ?, updated_at = ?
      WHERE activity_id = ? AND status = 'paused'
    `),
    markActionComplete: db.prepare(`
      UPDATE character_activities
      SET action_completed_at = ?, updated_at = ?
      WHERE activity_id = ? AND kind = 'daily' AND status IN ('running', 'paused')
        AND action_completed_at IS NULL
    `),
    recordActionProgress: db.prepare(`
      UPDATE character_activities
      SET action_frame = MAX(action_frame, ?), updated_at = ?
      WHERE activity_id = ? AND kind = 'daily' AND status IN ('running', 'paused')
        AND action_completed_at IS NULL
    `),
    complete: db.prepare(`
      UPDATE character_activities
      SET status = 'completed', active_elapsed_ms = duration_ms,
          last_progress_at = NULL, completed_at = ?, updated_at = ?
      WHERE activity_id = ? AND status IN ('running', 'paused')
    `),
    cancel: db.prepare(`
      UPDATE character_activities
      SET status = 'cancelled', last_progress_at = NULL, completed_at = ?, updated_at = ?
      WHERE activity_id = ? AND status IN ('scheduled', 'running', 'paused')
    `),
    pauseAllRunning: db.prepare(`
      UPDATE character_activities SET status = 'paused', updated_at = ?
      WHERE status = 'running'
    `),
  };

  function map(row) {
    if (!row) {
      return null;
    }
    return {
      activityId: row.activity_id,
      characterId: row.character_id,
      kind: row.kind,
      status: row.status,
      durationMs: Number(row.duration_ms),
      activeElapsedMs: Number(row.active_elapsed_ms),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      lastProgressAt: row.last_progress_at === null ? null : Number(row.last_progress_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      actionCompletedAt:
        row.action_completed_at === null ? null : Number(row.action_completed_at),
      actionFrame: Number(row.action_frame ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  function get(activityId) {
    return map(statements.get.get(activityId));
  }

  function getOpenForCharacter(characterId) {
    return map(statements.openForCharacter.get(characterId));
  }

  function getScheduled() {
    return map(statements.scheduled.get());
  }

  function listOpen() {
    return statements.listOpen.all().map(map);
  }

  function listRunning() {
    return statements.listRunning.all().map(map);
  }

  /* S06i 只读：按真实完成时间读取已完成活动，供故事运行入口消费。 */
  function listCompletedSince(after) {
    return statements.listCompletedSince.all(Number(after)).map(map);
  }

  function countStarted(kind, since) {
    return Number(statements.countStarted.get(kind, since).count);
  }

  /* 以下写方法由 companionship 放在活动/数值/位置/额度所需事务中调用。 */
  function insertScheduled({ activityId, characterId, kind, at, durationMs }) {
    statements.insert.run(activityId, characterId, kind, durationMs, at, at);
    return get(activityId);
  }

  function start(activityId, at) {
    const result = statements.start.run(at, at, at, activityId);
    if (Number(result.changes) !== 1) {
      throw new AppError("ACTIVITY_NOT_STARTABLE", "活动当前不能开始。");
    }
    return get(activityId);
  }

  function advance(activityId, elapsedMs, at) {
    statements.advance.run(elapsedMs, at, at, activityId);
    return get(activityId);
  }

  function pause(activityId, at) {
    statements.pause.run(at, activityId);
    return get(activityId);
  }

  function resume(activityId, at) {
    const result = statements.resume.run(at, at, activityId);
    if (Number(result.changes) !== 1) {
      throw new AppError("ACTIVITY_NOT_RESUMABLE", "活动当前不能恢复。");
    }
    return get(activityId);
  }

  /* 只记录真实播放完成；是否收束仍由 companionship 同时核对有效时长与自然节点。 */
  function markActionComplete(activityId, at) {
    statements.markActionComplete.run(at, at, activityId);
    return get(activityId);
  }

  /* 只记录已完成帧数，不按墙钟推导；MAX 保证迟到/重放消息不回退进度。 */
  function recordActionProgress(activityId, frame, at) {
    statements.recordActionProgress.run(frame, at, activityId);
    return get(activityId);
  }

  function complete(activityId, at) {
    statements.complete.run(at, at, activityId);
    return get(activityId);
  }

  function cancel(activityId, at) {
    statements.cancel.run(at, at, activityId);
    return get(activityId);
  }

  function pauseAllRunning(at) {
    statements.pauseAllRunning.run(at);
  }

  return {
    DURATIONS,
    get,
    getOpenForCharacter,
    getScheduled,
    listOpen,
    listRunning,
    listCompletedSince,
    countStarted,
    insertScheduled,
    start,
    advance,
    pause,
    resume,
    markActionComplete,
    recordActionProgress,
    complete,
    cancel,
    pauseAllRunning,
  };
}

module.exports = { createCharacterActivities, DURATIONS };
