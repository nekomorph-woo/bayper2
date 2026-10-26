/* S06i 已完成活动到作者故事的最小运行入口。
   只在既有心跳/自然节点落定活动事实后消费已完成活动，不抽新活动、不调用模型、
   不改变名单、数值、当前角色或互动。首次接入把此前已完成活动标为历史跳过，
   避免升级后替用户补发“刚刚发现”的线索；每个活动最多留下一次评估事实。 */
const { AppError } = require("./errors.cjs");

const BASELINE_KEY = "story_runtime_baseline_at";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS story_runtime_activity_results (
    activity_id TEXT PRIMARY KEY REFERENCES character_activities(activity_id),
    story_id TEXT,
    node_id TEXT,
    outcome TEXT NOT NULL CHECK (
      outcome IN ('applied', 'merged', 'unavailable', 'skipped')
    ),
    reason TEXT,
    evaluated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS story_runtime_evaluated
    ON story_runtime_activity_results (evaluated_at);
`;

function createStoryRuntime({
  db,
  store,
  storyProgress,
  discoveryOutcomes,
  now = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "故事运行需要 SQLite 连接。");
  }
  if (!store?.activities || typeof store.activities.listCompletedSince !== "function") {
    throw new AppError("ACTIVITY_STORE_REQUIRED", "故事运行需要活动事实入口。");
  }
  if (
    !storyProgress ||
    typeof storyProgress.selectNextStories !== "function" ||
    typeof storyProgress.recordNode !== "function"
  ) {
    throw new AppError("STORY_PROGRESS_REQUIRED", "故事运行需要故事进度入口。");
  }
  if (
    !discoveryOutcomes ||
    typeof discoveryOutcomes.getStorySelectionFilters !== "function"
  ) {
    throw new AppError("DISCOVERY_REQUIRED", "故事运行需要发现结果入口。");
  }

  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    getBaseline: db.prepare("SELECT value FROM app_state WHERE key = ?"),
    saveBaseline: db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    listEvaluated: db.prepare(
      "SELECT activity_id FROM story_runtime_activity_results",
    ),
    insertResult: db.prepare(`
      INSERT OR IGNORE INTO story_runtime_activity_results
        (activity_id, story_id, node_id, outcome, reason, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
  };

  function nowMs() {
    const value = now();
    const at = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(at)) {
      throw new AppError("CLOCK_INVALID", "故事运行时钟无效。");
    }
    return at;
  }

  /* 首次接线只记录“这些旧活动已被评估为历史跳过”，不生成线索、事实或额度。
     标记与跳过记录同事务写入；时间回拨不会让运行时重新纳入更早的活动。 */
  function applyBaseline(at) {
    if (statements.getBaseline.get(BASELINE_KEY)) {
      return false;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const activity of store.activities.listCompletedSince(0)) {
        statements.insertResult.run(
          activity.activityId,
          null,
          null,
          "skipped",
          "HISTORICAL_BASELINE",
          at,
        );
      }
      statements.saveBaseline.run(BASELINE_KEY, String(at));
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function insertEvaluation(activityId, { storyId = null, nodeId = null, outcome, reason = null }, at) {
    statements.insertResult.run(activityId, storyId, nodeId, outcome, reason, at);
  }

  function publicResult(activityId, result, at) {
    return {
      activityId,
      storyId: result.storyId ?? null,
      nodeId: result.nodeId ?? null,
      outcome: result.outcome,
      reason: result.reason ?? null,
      evaluatedAt: at,
    };
  }

  function record(activityId, result, at) {
    insertEvaluation(activityId, result, at);
    return publicResult(activityId, result, at);
  }

  function evaluateActivity(activity, at) {
    try {
      const candidates = storyProgress.selectNextStories(
        discoveryOutcomes.getStorySelectionFilters(),
      );
      const ready = candidates.filter(
        (candidate) => candidate.status === "ready" && candidate.available === true,
      );
      // 已有进度优先，避免每次机会都重新开一条故事。
      const candidate = ready.find((item) => item.continued) ?? ready[0] ?? null;
      if (!candidate) {
        const unavailable = candidates.find((item) => item.status === "unavailable");
        return record(
          activity.activityId,
          {
            outcome: "skipped",
            reason: unavailable?.reason ?? "NO_STORY_CANDIDATE",
          },
          at,
        );
      }

      const result = storyProgress.recordNode({
        activityId: activity.activityId,
        narratorId: activity.characterId,
        storyId: candidate.storyId,
        nodeId: candidate.nodeId,
        // 运行结果与故事进度同一事务：最后一笔写入失败时整笔回滚，重试仍选中同一故事。
        onResult: (recorded) => insertEvaluation(activity.activityId, recorded, at),
      });
      return publicResult(activity.activityId, result, at);
    } catch (error) {
      // 领域拒绝是可确定的本次评估结果：记下跳过，避免同活动无限重试；
      // SQLite/事务故障不写评估，保留活动供下一次心跳安全重试。
      if (error instanceof AppError) {
        return record(
          activity.activityId,
          { outcome: "skipped", reason: error.code },
          at,
        );
      }
      throw error;
    }
  }

  /* 同步评估所有尚未消费的已完成活动；活动本身仍由既有生命周期管理。 */
  function evaluate() {
    const at = nowMs();
    const evaluated = new Set(
      statements.listEvaluated.all().map((row) => row.activity_id),
    );
    const results = [];
    for (const activity of store.activities.listCompletedSince(0)) {
      if (evaluated.has(activity.activityId)) {
        continue;
      }
      results.push(evaluateActivity(activity, at));
    }
    return results;
  }

  // 启动即固定保守基线；之后只处理基线之后真实完成的活动。
  applyBaseline(nowMs());

  return { evaluate };
}

module.exports = { createStoryRuntime };
