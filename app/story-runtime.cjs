/* S06i 已完成活动到作者故事的最小运行入口。
   只在既有心跳/自然节点落定活动事实后消费已完成活动，不抽新活动、不调用模型、
   不改变名单、数值、当前角色或互动。首次接入把此前已完成活动标为历史跳过，
   避免升级后替用户补发“刚刚发现”的线索；每个活动最多留下一次评估事实。
   S06k 在活动评估后固定检查一次成熟服装归属，使 72 小时到期无需新活动或点击领取。 */
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
  themeMemorySharing = null,
  getShareContext = null,
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
    typeof discoveryOutcomes.getStorySelectionFilters !== "function" ||
    typeof discoveryOutcomes.unlockNextOutfit !== "function"
  ) {
    throw new AppError("DISCOVERY_REQUIRED", "故事运行需要发现结果入口。");
  }
  if (
    themeMemorySharing !== null &&
    typeof themeMemorySharing.shareActivityResult !== "function"
  ) {
    throw new AppError("THEME_SHARING_REQUIRED", "主题分享入口无效。");
  }
  if (getShareContext !== null && typeof getShareContext !== "function") {
    throw new AppError("THEME_SHARING_REQUIRED", "分享快照入口无效。");
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

  /* 快照由主进程在故事事务外读取；随后同步进入 recordNode，中间没有 await。
     读取失败属于基础设施错误，原样上抛，下一次心跳再评估同一活动。 */
  function readShareContext() {
    if (!themeMemorySharing || typeof getShareContext !== "function") {
      return null;
    }
    return getShareContext();
  }

  function evaluateActivity(activity, at) {
    // 显式阶段标记：只有进入 recordNode 后的 AppError 才是可确定的领域拒绝。
    // 读取快照失败属于暂时基础设施错误，不能写评估结果消费活动。
    let phase = "candidate";
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

      phase = "share-context";
      const shareContext = readShareContext();
      phase = "record";
      const result = storyProgress.recordNode({
        activityId: activity.activityId,
        narratorId: activity.characterId,
        storyId: candidate.storyId,
        nodeId: candidate.nodeId,
        // 运行结果、主题分享与故事进度同一事务：最后一笔写入失败时整笔回滚。
        onResult: (recorded) => {
          insertEvaluation(activity.activityId, recorded, at);
          // 只处理本次新 applied 节点；merged、skipped 与重复 activity 不分享。
          if (recorded.outcome === "applied" && recorded.duplicate !== true) {
            themeMemorySharing?.shareActivityResult({
              activity,
              result: recorded,
              context: shareContext,
              at,
            });
          }
        },
      });
      return publicResult(activity.activityId, result, at);
    } catch (error) {
      // 快照暂时不可读：不写任何故事/运行/分享结果，下一次心跳重试同一活动。
      if (phase === "share-context") {
        throw error;
      }
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

  /* 同步评估所有尚未消费的已完成活动；活动本身仍由既有生命周期管理。
     活动评估完成后固定检查一次成熟服装归属，即使本次没有新活动也执行，
     使 72 小时额度到期后由正常心跳补解锁。解锁是独立事务：失败时已提交的
     活动评估保留，下一次心跳只重试解锁；返回值仍是活动结果数组，不混入归属。 */
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
    discoveryOutcomes.unlockNextOutfit();
    return results;
  }

  // 启动即固定保守基线；之后只处理基线之后真实完成的活动。
  applyBaseline(nowMs());

  return { evaluate };
}

module.exports = { createStoryRuntime };
