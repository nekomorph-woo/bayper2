/* S06l 换装协调：全局只允许一个自然节点等待。
   不做队列或重试循环；聊天/暂停保留意图，由既有心跳、聊天结束、系统恢复、
   换人与桌面就绪事件再次触发。当前角色有可见动画时等待真实边界；无可见动画
   或非在屏角色直接校验并提交自己的意图，不拉人上桌、不结束探索。 */
const { AppError } = require("./errors.cjs");

function createOutfitRuntime({
  outfits,
  getCurrentCharacterId,
  getPresentation,
  canWaitForCurrent,
  isBlocked,
  waitForBoundary,
  onStatus = () => {},
  onApplied = () => {},
  onError = () => {},
} = {}) {
  if (!outfits || typeof outfits.listPending !== "function") {
    throw new AppError("OUTFITS_REQUIRED", "换装协调需要衣装入口。");
  }
  if (typeof getCurrentCharacterId !== "function" || typeof isBlocked !== "function") {
    throw new AppError("CONTEXT_REQUIRED", "换装协调需要当前角色与阻断状态。");
  }
  if (typeof waitForBoundary !== "function") {
    throw new AppError("BOUNDARY_REQUIRED", "换装协调需要自然节点入口。");
  }

  let inflight = false;
  let disposed = false;

  function status(characterId, phase, message) {
    onStatus({ characterId, phase, message });
  }

  function commit(state) {
    const { characterId, pending } = state;
    if (!pending || pending.available !== true) {
      status(characterId, "unavailable", "这套衣装当前不可用；已保留待穿。");
      return false;
    }
    try {
      outfits.commitPending({
        characterId,
        token: pending.token,
        version: pending.version,
      });
    } catch (error) {
      const unavailable = [
        "OUTFIT_UNAVAILABLE",
        "OUTFIT_ASSET_UNAVAILABLE",
        "OUTFIT_NOT_OWNED",
      ].includes(error?.code);
      status(
        characterId,
        unavailable ? "unavailable" : "error",
        unavailable
          ? "这套衣装已不可用；已保留待穿，可改选原本的衣装。"
          : "换装没有完成，已保留待穿，可重试。",
      );
      return false;
    }
    onStatus(null);
    onApplied({ characterId });
    return true;
  }

  /* 只处理一个待穿意图；当前角色优先，其余角色按请求时间顺序。 */
  async function processOne() {
    if (disposed || isBlocked()) {
      return;
    }
    let states;
    try {
      states = outfits.listPending();
    } catch (error) {
      onError(error);
      return;
    }
    if (states.length === 0) {
      return;
    }
    const currentId = getCurrentCharacterId();
    const currentState = states.find((item) => item.characterId === currentId);
    // 当前角色优先，但不能让一个不可用意图饿死其他合法意图。
    const ordered = currentState
      ? [currentState, ...states.filter((item) => item !== currentState)]
      : states;
    const state = ordered.find((item) => item.pending?.available === true);
    if (!state) {
      if (currentState?.pending && currentState.pending.available !== true) {
        status(currentState.characterId, "unavailable", "这套衣装当前不可用；已保留待穿。");
      }
      return;
    }
    const { characterId, pending } = state;
    if (!pending) {
      return;
    }

    // 非在屏角色不等待不相关节点，也不改变名单/探索；直接保存其意图。
    if (characterId !== currentId) {
      commit(state);
      return;
    }

    let presentation = null;
    try {
      presentation = getPresentation();
    } catch (error) {
      onError(error);
    }
    // 可见动画才需要收束；失效旧衣装/无画布时允许直接恢复合法目标。
    const visible = presentation?.assetState === "ready" && presentation?.visible !== false;
    const mustWait = visible && canWaitForCurrent();
    if (!mustWait) {
      commit(state);
      return;
    }

    status(characterId, "waiting", "正在等待安全节点换装…");
    const restingBefore = presentation.resting === true;
    const restTokenBefore = presentation.restToken ?? 0;
    try {
      await waitForBoundary();
    } catch (error) {
      status(
        characterId,
        error?.code === "NODE_TIMEOUT" ? "timeout" : "error",
        error?.code === "NODE_TIMEOUT"
          ? "等待自然节点超时，已保留待穿，可重试。"
          : "等待换装节点失败，已保留待穿。",
      );
      return;
    }

    // 等待期间的新聊天、暂停、换人、退出或新 token 都使旧回调失效。
    if (disposed || isBlocked() || getCurrentCharacterId() !== characterId) {
      return;
    }
    // 等待期间新进入/结束休息或睡眠换了一轮，旧节点不再代表当前动作。
    let after;
    try {
      after = getPresentation();
    } catch (error) {
      onError(error);
      return;
    }
    if (
      after
      && (after.resting !== restingBefore || (after.restToken ?? 0) !== restTokenBefore)
    ) {
      return;
    }
    let latest;
    try {
      latest = outfits.list({ characterId });
    } catch (error) {
      onError(error);
      return;
    }
    if (
      !latest.pending
      || latest.pending.token !== pending.token
      || latest.pending.version !== pending.version
    ) {
      return;
    }
    commit(latest);
  }

  function schedule() {
    if (disposed || inflight) {
      return;
    }
    inflight = true;
    processOne()
      .catch((error) => onError(error))
      .finally(() => {
        inflight = false;
      });
  }

  function dispose() {
    disposed = true;
  }

  return { schedule, dispose };
}

module.exports = { createOutfitRuntime };
