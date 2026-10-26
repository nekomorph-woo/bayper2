/* S06d 正式应用中的自动用途路由与本地活动执行。
   一个 automatic-opportunities 机会只执行一种用途：来源分析、日常或探索。
   本模块只保存最小用途游标，并把活动请求交给既有 companionship；
   不复制名单、额度、精力或活动事实，不自行建立第二个抽签器。 */
const { AppError } = require("./errors.cjs");

const PURPOSES = Object.freeze(["source", "daily", "exploration"]);
const PURPOSE_KEY = "automatic_purpose_cursor";

function createActivityRuntime({
  store,
  companionship,
  sourceAutomation,
  isDesktopReady = () => true,
  activitySupport = () => ({ available: true }),
  isBlocked = () => false,
} = {}) {
  if (
    !store ||
    typeof store.getAppState !== "function" ||
    typeof store.setAppState !== "function"
  ) {
    throw new AppError("DEPENDENCY_REQUIRED", "活动运行时需要 store 状态接口。");
  }
  if (
    !companionship ||
    typeof companionship.requestActivity !== "function" ||
    typeof companionship.getSnapshot !== "function" ||
    typeof companionship.resumeActivity !== "function"
  ) {
    throw new AppError("DEPENDENCY_REQUIRED", "活动运行时需要陪伴活动接口。");
  }

  let disposed = false;

  function blockedNow() {
    try {
      return isBlocked() === true;
    } catch {
      return true;
    }
  }

  function readPurpose() {
    let value = null;
    try {
      value = store.getAppState(PURPOSE_KEY);
    } catch {
      value = null;
    }
    return PURPOSES.includes(value) ? value : "source";
  }

  /* 在分发前推进用途游标：选中的用途失败也不在同一机会改选另一项。 */
  function advancePurpose(current) {
    const next = PURPOSES[(PURPOSES.indexOf(current) + 1) % PURPOSES.length];
    try {
      store.setAppState(PURPOSE_KEY, next);
    } catch (error) {
      console.error("自动用途游标保存失败：", error?.message ?? error);
    }
  }

  function openActivities() {
    const snapshot = companionship.getSnapshot();
    return (snapshot.characters ?? [])
      .map((character) => character.activity)
      .filter((activity) => activity && typeof activity.activityId === "string");
  }

  function runningActivityIds() {
    return openActivities()
      .filter((activity) => activity.status === "running")
      .map((activity) => activity.activityId);
  }

  function pausedActivityIds() {
    return openActivities()
      .filter(
        (activity) =>
          activity.status === "paused" &&
          activitySupport(activity.characterId, activity.kind)?.available !== false,
      )
      .map((activity) => activity.activityId);
  }

  function cancelScheduledDaily({ onlyUnsupported = false } = {}) {
    const cancelled = [];
    for (const activity of openActivities()) {
      if (activity.status !== "scheduled" || activity.kind !== "daily") {
        continue;
      }
      if (
        onlyUnsupported &&
        activitySupport(activity.characterId, activity.kind)?.available !== false
      ) {
        continue;
      }
      try {
        const result = companionship.cancelActivity(activity.activityId);
        if (result?.cancelled) {
          cancelled.push(activity.activityId);
        }
      } catch (error) {
        console.error("取消待开始日常失败：", error?.message ?? error);
      }
    }
    return cancelled;
  }

  function pauseRunningActivities() {
    const paused = [];
    for (const activityId of runningActivityIds()) {
      try {
        const result = companionship.pauseActivity(activityId);
        if (result?.paused) {
          paused.push(activityId);
        }
      } catch (error) {
        console.error("暂停可见故障活动失败：", error?.message ?? error);
      }
    }
    return paused;
  }

  /* 画布不可见或素材失败：待开始 daily 取消；运行活动暂停并保留事实。 */
  function handleDesktopUnavailable() {
    const cancelled = cancelScheduledDaily();
    const paused = pauseRunningActivities();
    return { cancelled, paused };
  }

  /* 从持久活动事实扫描所有暂停项；资格不足的保持暂停，不无限重试。
     调用方只在聊天/系统/画布等一个暂停原因解除时调用。 */
  function resumePausedActivities() {
    if (disposed || blockedNow() || !isDesktopReady()) {
      return [];
    }
    return resumeActivities(pausedActivityIds());
  }

  function handleDesktopReady() {
    // 旧版本可能留下动作未发布的 scheduled daily；恢复画布时先取消，避免节点扣费。
    cancelScheduledDaily({ onlyUnsupported: true });
    return resumePausedActivities();
  }

  function resumeActivities(activityIds) {
    const results = [];
    for (const activityId of activityIds ?? []) {
      if (typeof activityId !== "string" || activityId.length === 0) {
        continue;
      }
      try {
        results.push(companionship.resumeActivity(activityId));
      } catch (error) {
        console.error("恢复活动失败：", error?.message ?? error);
      }
    }
    return results;
  }

  async function runActivity({ characterId, requestId, isEligible: opportunityEligible } = {}) {
    if (disposed) {
      return { status: "skipped", reason: "DISPOSED" };
    }
    if (blockedNow()) {
      return { status: "skipped", reason: "BLOCKED" };
    }
    const purpose = readPurpose();
    advancePurpose(purpose);

    if (purpose === "source") {
      if (!sourceAutomation || typeof sourceAutomation.runActivity !== "function") {
        return { status: "skipped", reason: "SOURCE_EXECUTOR_MISSING" };
      }
      return sourceAutomation.runActivity({
        characterId,
        requestId,
        isEligible: opportunityEligible,
      });
    }

    if (
      typeof opportunityEligible === "function" &&
      !opportunityEligible(characterId)
    ) {
      return { status: "skipped", reason: "NOT_ELIGIBLE", purpose };
    }
    const support = activitySupport(characterId, purpose);
    if (!support?.available) {
      const reason = support?.reason ?? "ACTIVITY_ACTION_UNAVAILABLE";
      console.warn(`自动${purpose}跳过：${reason}`);
      return { status: "skipped", reason, purpose };
    }
    if (!isDesktopReady()) {
      return { status: "skipped", reason: "DESKTOP_UNAVAILABLE", purpose };
    }

    let requested;
    try {
      requested = companionship.requestActivity({
        activityId: `auto-${requestId}`,
        characterId,
        kind: purpose,
      });
    } catch (error) {
      return {
        status: "failed",
        code: typeof error?.code === "string" ? error.code : "ACTIVITY_FAILED",
        purpose,
      };
    }
    if (!requested?.requested) {
      return {
        status: "skipped",
        reason: requested?.reason ?? "ACTIVITY_REJECTED",
        purpose,
      };
    }
    return {
      status: "scheduled",
      purpose,
      activity: requested.activity,
    };
  }

  function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    return true;
  }

  return {
    runActivity,
    runningActivityIds,
    pausedActivityIds,
    resumeActivities,
    resumePausedActivities,
    handleDesktopUnavailable,
    handleDesktopReady,
    dispose,
  };
}

module.exports = { createActivityRuntime, PURPOSES, PURPOSE_KEY };
