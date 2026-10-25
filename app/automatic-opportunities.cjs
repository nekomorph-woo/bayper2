/* S06b 低频自动机会入口。
   只负责 30 分钟一次的应用级机会、25% 抽签和名单资格门；不管理预算、不调度
   多角色、不自行定时。主进程现有心跳调用 evaluate；用户聊天由主进程调用
   pause，恢复时 resume。执行器 runActivity 由上层注入，本模块只调用一次。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");

const WINDOW_MS = 30 * 60 * 1000;
const CHANCE = 0.25;
const MIN_ENERGY = 30;
const LAST_KEY = "automatic_opportunity_last_eval_at";
const NEXT_KEY = "automatic_opportunity_next_at";

function createAutomaticOpportunities({
  store,
  companionship,
  now = () => Date.now(),
  random = Math.random,
  runActivity,
  cancelActivity = () => {},
} = {}) {
  if (
    !store ||
    typeof store.getAppState !== "function" ||
    typeof store.setAppState !== "function" ||
    typeof store.runInTransaction !== "function"
  ) {
    throw new AppError(
      "DEPENDENCY_REQUIRED",
      "自动机会需要 store 状态接口与事务能力。",
    );
  }
  if (!companionship || typeof companionship.getSnapshot !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "自动机会需要陪伴快照。");
  }
  if (typeof runActivity !== "function" || typeof cancelActivity !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "自动机会需要执行与取消接口。");
  }
  if (typeof now !== "function" || typeof random !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "自动机会需要时间与随机接口。");
  }

  let paused = false;
  let disposed = false;
  let busy = false;
  let active = null;

  function transact(work) {
    return store.runInTransaction(work);
  }

  function clockNow() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Math.trunc(Number(value));
    if (!Number.isFinite(ms)) {
      throw new AppError("INVALID_TIME", "时间必须是有效数字。");
    }
    return ms;
  }

  function readTime(key) {
    const raw = store.getAppState(key);
    if (raw === null || raw === undefined) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function writeState(entries) {
    transact(() => {
      for (const [key, value] of entries) {
        store.setAppState(key, String(value));
      }
    });
  }

  /* 不把下一次机会提前到：当前 +30 分钟、已有 next、或上次评估 +30 分钟
     之前。重启/恢复因此不会立即补做旧到期工作，也不会因时钟回拨提前。 */
  function nextTarget(at) {
    const next = readTime(NEXT_KEY);
    const last = readTime(LAST_KEY);
    let target = at + WINDOW_MS;
    if (next !== null) {
      target = Math.max(target, next);
    }
    if (last !== null) {
      target = Math.max(target, last + WINDOW_MS);
    }
    return target;
  }

  // 首次启动与重启恢复都从当前之后至少 30 分钟开始；已有更晚 next 不提前。
  const initialNow = clockNow();
  const initialNext = readTime(NEXT_KEY);
  const initialTarget = nextTarget(initialNow);
  if (initialNext === null || initialTarget !== initialNext) {
    try {
      writeState([[NEXT_KEY, initialTarget]]);
    } catch {
      throw new AppError("STATE_PERSIST_FAILED", "自动机会初始化失败。");
    }
  }

  function nextDraw() {
    const value = Number(random());
    return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
  }

  function eligibleIds(snapshot) {
    if (!snapshot || snapshot.interaction || snapshot.pendingRotation) {
      return [];
    }
    if (!Array.isArray(snapshot.roster) || !Array.isArray(snapshot.characters)) {
      return [];
    }
    const characters = new Map(
      snapshot.characters.map((character) => [character.characterId, character]),
    );
    const ids = [];
    for (const entry of snapshot.roster) {
      const characterId = entry?.characterId;
      if (typeof characterId !== "string" || ids.includes(characterId)) {
        continue;
      }
      const character = characters.get(characterId);
      const energy = Number(character?.stats?.energy);
      if (
        !character ||
        character.inRoster !== true ||
        !Number.isFinite(energy) ||
        energy <= MIN_ENERGY ||
        character.exploring === true ||
        character.mode === "resting" ||
        character.mode === "interacting"
      ) {
        continue;
      }
      ids.push(characterId);
    }
    return ids;
  }

  function snapshotNow() {
    return companionship.getSnapshot();
  }

  function cancelActive() {
    if (!active) {
      return;
    }
    active.cancelled = true;
    active.controller.abort();
    try {
      cancelActivity();
    } catch {
      // 取消失败不改变已暂停/释放状态。
    }
  }

  async function evaluate() {
    if (disposed) {
      return { status: "disposed" };
    }
    if (paused) {
      return { status: "paused" };
    }
    if (busy) {
      return { status: "busy" };
    }

    const at = clockNow();
    const last = readTime(LAST_KEY);
    const next = readTime(NEXT_KEY);
    if (last !== null && at < last) {
      return { status: "not_due", reason: "CLOCK_ROLLBACK", nextAt: next };
    }
    if (next === null || at < next) {
      return { status: "not_due", nextAt: next };
    }

    busy = true;
    let current = null;
    try {
      // 到合法时刻先消费机会并安排下一次；持久化失败不执行活动。
      try {
        writeState([
          [LAST_KEY, at],
          [NEXT_KEY, at + WINDOW_MS],
        ]);
      } catch {
        return { status: "failed", code: "STATE_PERSIST_FAILED" };
      }

      let snapshot;
      try {
        snapshot = snapshotNow();
      } catch {
        return { status: "failed", code: "SNAPSHOT_FAILED" };
      }
      if (disposed) {
        return { status: "disposed" };
      }
      if (paused) {
        return { status: "paused" };
      }
      if (snapshot.interaction) {
        return { status: "skipped", reason: "INTERACTION" };
      }
      if (snapshot.pendingRotation) {
        return { status: "skipped", reason: "PENDING_ROTATION" };
      }

      const candidates = eligibleIds(snapshot);
      if (candidates.length === 0) {
        return { status: "skipped", reason: "NO_ELIGIBLE" };
      }
      if (nextDraw() >= CHANCE) {
        return { status: "skipped", reason: "CHANCE" };
      }
      const selected =
        candidates.length === 1
          ? candidates[0]
          : candidates[Math.floor(nextDraw() * candidates.length)];

      if (disposed) {
        return { status: "disposed" };
      }
      if (paused) {
        return { status: "paused" };
      }
      let latest;
      try {
        latest = snapshotNow();
      } catch {
        return { status: "failed", code: "SNAPSHOT_FAILED" };
      }
      if (latest.interaction || latest.pendingRotation) {
        return { status: "skipped", reason: "INELIGIBLE" };
      }
      if (!eligibleIds(latest).includes(selected)) {
        return { status: "skipped", reason: "INELIGIBLE" };
      }

      current = {
        cancelled: false,
        controller: new AbortController(),
        characterId: selected,
        requestId: crypto.randomUUID(),
      };
      active = current;

      const isEligible = (characterId) => {
        if (
          characterId !== selected ||
          current.cancelled ||
          paused ||
          disposed ||
          active !== current
        ) {
          return false;
        }
        try {
          return eligibleIds(snapshotNow()).includes(selected);
        } catch {
          return false;
        }
      };

      let activity;
      try {
        activity = await runActivity({
          characterId: selected,
          requestId: current.requestId,
          signal: current.controller.signal,
          isEligible,
        });
      } catch (error) {
        activity = {
          status: "failed",
          code: typeof error?.code === "string" ? error.code : "ACTIVITY_FAILED",
        };
      }

      if (current.cancelled || paused || disposed) {
        return {
          status: "cancelled",
          characterId: selected,
          requestId: current.requestId,
          activity,
        };
      }
      return {
        status:
          typeof activity?.status === "string" ? activity.status : "completed",
        characterId: selected,
        requestId: current.requestId,
        activity,
      };
    } finally {
      if (active === current) {
        active = null;
      }
      busy = false;
    }
  }

  function pause() {
    if (paused || disposed) {
      return false;
    }
    paused = true;
    cancelActive();
    return true;
  }

  function resume() {
    if (disposed || !paused) {
      return false;
    }
    const target = nextTarget(clockNow());
    const currentNext = readTime(NEXT_KEY);
    if (currentNext === null || target !== currentNext) {
      try {
        writeState([[NEXT_KEY, target]]);
      } catch {
        throw new AppError("STATE_PERSIST_FAILED", "自动机会恢复失败。");
      }
    }
    paused = false;
    return true;
  }

  function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    paused = true;
    cancelActive();
    return true;
  }

  return { evaluate, pause, resume, dispose };
}

module.exports = { createAutomaticOpportunities, WINDOW_MS };
