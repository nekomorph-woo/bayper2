/* S06m Part B 自动告知展示状态。
   持有当前一条已准备的只读展示副本与 token，负责可见证明、ACK/action 路由、
   6 秒保留与 10 秒未确认上限；机会抽取仍由 automaticOpportunities 驱动。
   本模块不写通知账本、不抽定时机会、不切换角色或自动穿衣/接纳。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");

/* 与 outfit-panel 的固定白名单保持一致；未知衣装不生成文案，也不展示。 */
const OUTFIT_NAMES = Object.freeze({
  base: "原本的衣装",
  "rin.warm-tea": "温茶围裙",
});

const VISIBLE_MS = 350;
const ACK_HOLD_MS = 6000;
const UNACKED_MAX_MS = 10000;
const EXCERPT_MAX = 64;

function createAutomaticNoticeRuntime({
  notices,
  storyWindow,
  characterNames = {},
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onUpdate = () => {},
  onAction = () => {},
} = {}) {
  if (
    !notices ||
    typeof notices.prepare !== "function" ||
    typeof notices.getView !== "function" ||
    typeof notices.acknowledge !== "function" ||
    typeof notices.cancel !== "function"
  ) {
    throw new AppError("NOTICES_REQUIRED", "自动告知运行时需要领域入口。");
  }
  if (!storyWindow || typeof storyWindow.getStory !== "function") {
    throw new AppError("STORY_WINDOW_REQUIRED", "自动告知运行时需要故事回看入口。");
  }

  let current = null;
  let timer = null;
  let disposed = false;

  function clockNow() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Math.trunc(Number(value));
    if (!Number.isFinite(ms)) {
      throw new AppError("CLOCK_INVALID", "自动告知时钟无效。");
    }
    return ms;
  }

  function nameOf(characterId) {
    if (typeof characterId !== "string" || !characterId) return null;
    const name = characterNames[characterId];
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }

  function excerptOf(story) {
    const body = story?.nodes?.[0]?.body;
    if (typeof body !== "string") return "";
    const text = body.replace(/\s+/gu, " ").trim();
    if (!text) return "";
    return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;
  }

  /* 文稿只来自已保存故事与固定角色/衣装名；任一名称缺失就不展示。 */
  function describe(view) {
    const story = storyWindow.getStory(view.storyId);
    const excerpt = excerptOf(story);
    if (!story || story.available !== true || !excerpt) {
      return null;
    }
    const speaker = nameOf(view.speakerId) ?? "同行的角色";
    if (view.kind === "outfit") {
      const owner = nameOf(view.ownerCharacterId);
      const outfit = OUTFIT_NAMES[view.outfitId];
      if (!owner || !outfit) return null;
      return {
        title: speaker === owner
          ? `${owner}带来了${outfit}故事`
          : `${speaker}提起${owner}的${outfit}`,
        body: `“${excerpt}”`,
        source: `${owner} · ${outfit} · 已记录的衣装故事`,
        actionLabel: "查看衣装",
        action: {
          type: "outfit",
          characterId: view.ownerCharacterId,
          outfitId: view.outfitId,
        },
      };
    }
    const target = nameOf(view.targetCharacterId);
    if (!target) return null;
    return {
      title: `${speaker}带来了${target}的相遇线索`,
      body: `“${excerpt}”`,
      source: `引荐来源：${speaker} · 目标：${target}`,
      actionLabel: "看看邀请",
      action: { type: "invitation", storyId: view.storyId },
    };
  }

  function payload() {
    if (!current) return null;
    return {
      noticeId: current.noticeId,
      noticeToken: current.noticeToken,
      kind: current.kind,
      storyId: current.storyId,
      title: current.title,
      body: current.body,
      source: current.source,
      actionLabel: current.actionLabel,
      actionType: current.action.type,
      presentedAt: current.presentedAt,
    };
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function schedule(at) {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      expire();
    }, Math.max(0, at - clockNow()));
    timer?.unref?.();
  }

  function notify() {
    try {
      onUpdate(payload());
    } catch {
      // 视图推送失败不影响已确认的收据或展示状态。
    }
  }

  function remove({ cancelNotice }) {
    const previous = current;
    clearTimer();
    current = null;
    if (cancelNotice && previous) {
      try {
        notices.cancel();
      } catch {
        // 内容保留或已释放由领域入口决定；运行时不伪造收据。
      }
    }
    notify();
    return previous;
  }

  function expire() {
    if (!current) return;
    if (current.ackedAt !== null) {
      remove({ cancelNotice: false });
      return;
    }
    // 未在 10 秒内真实确认：撤下本次展示，内容留给下一次正常机会。
    remove({ cancelNotice: true });
  }

  function tryPresent({ speakerId } = {}) {
    if (disposed) return { presented: false, reason: "DISPOSED" };
    if (current) return { presented: false, reason: "NOTICE_ACTIVE" };
    const prepared = notices.prepare({ speakerId });
    if (!prepared?.prepared) {
      return { presented: false, reason: prepared?.reason ?? "NOTICE_UNAVAILABLE" };
    }
    const view = notices.getView();
    let copy = null;
    try {
      copy = view ? describe(view) : null;
    } catch {
      copy = null;
    }
    if (!copy) {
      // 准备阶段不写收据；文案/名称不可用时只释放本次内存展示，保留内容。
      try {
        notices.cancel();
      } catch {
        // 领域入口已释放时不补写任何状态。
      }
      return { presented: false, reason: "NOTICE_COPY_UNAVAILABLE" };
    }
    const presentedAt = clockNow();
    current = {
      noticeId: view.noticeId,
      token: view.token,
      noticeToken: crypto.randomUUID(),
      kind: view.kind,
      storyId: view.storyId,
      title: copy.title,
      body: copy.body,
      source: copy.source,
      actionLabel: copy.actionLabel,
      action: copy.action,
      presentedAt,
      visibleAt: null,
      visibleProven: false,
      ackedAt: null,
      ackPending: false,
    };
    schedule(presentedAt + UNACKED_MAX_MS);
    notify();
    return { presented: true, noticeId: view.noticeId, kind: view.kind };
  }

  function sameNotice({ noticeId, noticeToken }) {
    return Boolean(
      current
      && noticeId === current.noticeId
      && noticeToken === current.noticeToken,
    );
  }

  /* renderer 在完整可见满 350ms 后上报；complete=false 会撤销可见证明。 */
  function markVisible({ noticeId, noticeToken, visible, visibleMs } = {}) {
    if (!sameNotice({ noticeId, noticeToken })) return false;
    const ms = Number(visibleMs);
    if (visible !== true || !Number.isFinite(ms) || ms < VISIBLE_MS) {
      current.visibleAt = null;
      current.visibleProven = false;
      return false;
    }
    if (current.visibleAt === null) current.visibleAt = clockNow();
    current.visibleProven = true;
    return true;
  }

  /* 通知窗一旦隐藏，旧可见证明作废；重新显示必须重新满足 350ms。 */
  function markWindowHidden() {
    if (!current) return false;
    current.visibleAt = null;
    current.visibleProven = false;
    return true;
  }

  function visibilityProven() {
    return Boolean(
      current
      && current.visibleProven
      && current.visibleAt !== null
      && clockNow() - current.presentedAt >= VISIBLE_MS,
    );
  }

  function acknowledge({ noticeId, noticeToken } = {}) {
    if (!sameNotice({ noticeId, noticeToken })) {
      return { accepted: false, reason: "STALE_NOTICE" };
    }
    if (current.ackedAt !== null) {
      // 重复 ACK 不续命、不再计数。
      return { accepted: true, duplicate: true, noticeId: current.noticeId };
    }
    if (!visibilityProven()) {
      return { accepted: false, reason: "NOT_VISIBLE" };
    }
    if (current.ackPending) {
      return { accepted: false, reason: "ACK_PENDING" };
    }
    current.ackPending = true;
    let result;
    try {
      result = notices.acknowledge({
        noticeId: current.noticeId,
        token: current.token,
      });
    } catch (error) {
      return {
        accepted: false,
        reason: typeof error?.code === "string" ? error.code : "ACK_FAILED",
        noticeId: current.noticeId,
      };
    } finally {
      current.ackPending = false;
    }
    if (!result?.acknowledged) {
      return {
        accepted: false,
        reason: result?.reason ?? "ACK_REJECTED",
        noticeId: current.noticeId,
      };
    }
    current.ackedAt = clockNow();
    schedule(current.ackedAt + ACK_HOLD_MS);
    notify();
    return {
      accepted: true,
      duplicate: result.duplicate === true,
      noticeId: current.noticeId,
    };
  }

  /* 用户有效点击：先按当前可见证明完成真实 ACK，再导航；未证明不跳转。 */
  function action({ noticeId, noticeToken, actionType } = {}) {
    if (!sameNotice({ noticeId, noticeToken })) {
      return { accepted: false, reason: "STALE_NOTICE" };
    }
    // 子进程只发送具名 open；运行时不接受指向其他内容类型的跳转。
    if (actionType !== "open" && actionType !== current.action.type) {
      return { accepted: false, reason: "ACTION_MISMATCH" };
    }
    if (!visibilityProven()) {
      return { accepted: false, reason: "NOT_VISIBLE" };
    }
    if (current.ackedAt === null) {
      const result = acknowledge({ noticeId, noticeToken });
      if (!result.accepted) return result;
    }
    const target = { ...current.action };
    remove({ cancelNotice: false });
    try {
      onAction(target);
    } catch {
      // 导航失败不回滚已实际显示的收据。
    }
    return { accepted: true, navigated: true, noticeId };
  }

  /* 收起：仅在已满足可见证明时计为实际显示，否则撤下并保留内容。 */
  function close({ noticeId, noticeToken } = {}) {
    if (!sameNotice({ noticeId, noticeToken })) {
      return { accepted: false, reason: "STALE_NOTICE" };
    }
    let acknowledged = current.ackedAt !== null;
    if (!acknowledged && visibilityProven()) {
      const result = acknowledge({ noticeId, noticeToken });
      acknowledged = result.accepted === true;
    }
    remove({ cancelNotice: !acknowledged });
    return { accepted: true, acknowledged, noticeId };
  }

  /* 工作通知/门禁抢占：ACK 前取消并保留内容；ACK 后只撤下展示副本。 */
  function cancel() {
    if (!current) return false;
    remove({ cancelNotice: current.ackedAt === null });
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    remove({ cancelNotice: current?.ackedAt === null });
    return true;
  }

  return {
    tryPresent,
    getPayload: payload,
    hasCurrent: () => Boolean(current),
    markVisible,
    markWindowHidden,
    acknowledge,
    action,
    close,
    cancel,
    dispose,
  };
}

module.exports = {
  createAutomaticNoticeRuntime,
  OUTFIT_NAMES,
  VISIBLE_MS,
  ACK_HOLD_MS,
  UNACKED_MAX_MS,
};
