/* S06m 自动衣装告知与相遇准备。
   复用真实 storyProgress/storyWindow/discoveryOutcomes 的内容与状态，只选出
   “最早未告知/成熟”的一条内容作为唯一活跃待显示卡。准备只创建内存 token，
   不写收据；只有真实可见 ACK 才在同一 SQLite 事务内写显示收据并确认发现结果。
   本模块不换装、不接纳、不改名单，也不调用模型。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { createAutomaticNoticeBudget } = require("./automatic-notice-budget.cjs");

const NOTICE_PREFIX = "notice:";
const ACK_SAVEPOINT = "automatic_notice_ack";

function cleanText(value, field, max = 200) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new AppError("INVALID_INPUT", `${field} 无效。`);
  }
  return result;
}

function requireMethods(target, methods, code, message) {
  if (!target || methods.some((name) => typeof target[name] !== "function")) {
    throw new AppError(code, message);
  }
}

function createAutomaticNotices({
  db,
  storyProgress,
  storyWindow,
  discoveryOutcomes,
  isAssetAvailable,
  now = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "自动告知需要 SQLite 连接。");
  }
  requireMethods(
    storyProgress,
    ["getProgress", "listProgress"],
    "STORY_PROGRESS_REQUIRED",
    "自动告知需要故事进度入口。",
  );
  requireMethods(storyWindow, ["getStory"], "STORY_WINDOW_REQUIRED", "自动告知需要故事回看入口。");
  requireMethods(
    discoveryOutcomes,
    [
      "prepareInvitation",
      "acknowledgeInvitation",
      "getInvitationByStory",
      "getOutfitOwnership",
      "acknowledgeOutfitNotice",
    ],
    "DISCOVERY_REQUIRED",
    "自动告知需要发现结果入口。",
  );
  if (typeof isAssetAvailable !== "function") {
    throw new AppError("ASSET_CHECK_REQUIRED", "自动告知需要实际素材资格回调。");
  }
  if (typeof now !== "function") {
    throw new AppError("INVALID_INPUT", "自动告知需要时间接口。");
  }

  const budget = createAutomaticNoticeBudget({ db, now });
  const statements = {
    pendingOutfits: db.prepare(`
      SELECT story_id, unlocked_at FROM discovery_outfit_ownership
      WHERE notification_pending = 1
      ORDER BY unlocked_at ASC, story_id ASC
    `),
  };

  let active = null;
  let disposed = false;

  function ensureActive() {
    if (disposed) {
      throw new AppError("NOTICES_DISPOSED", "自动告知入口已释放。");
    }
  }

  function sourceKeyFor(kind, storyId) {
    return `${kind}:${storyId}`;
  }

  function noticeIdFor(kind, storyId) {
    return `${NOTICE_PREFIX}${kind}:${storyId}`;
  }

  function parseNoticeId(value) {
    if (!value.startsWith(NOTICE_PREFIX)) {
      return null;
    }
    const rest = value.slice(NOTICE_PREFIX.length);
    const separator = rest.indexOf(":");
    if (separator <= 0) {
      return null;
    }
    const kind = rest.slice(0, separator);
    const storyId = rest.slice(separator + 1);
    if (!["outfit", "invitation"].includes(kind) || !storyId) {
      return null;
    }
    return { kind, storyId, sourceKey: sourceKeyFor(kind, storyId) };
  }

  function descriptorFor(kind, storyId, speakerId, progress) {
    const base = { kind, storyId, sourceKey: sourceKeyFor(kind, storyId), speakerId };
    return kind === "outfit"
      ? { ...base, ownerCharacterId: progress.ownerCharacterId, outfitId: progress.targetId }
      : { ...base, targetCharacterId: progress.targetId };
  }

  function assetAvailable(descriptor) {
    try {
      // 上层素材/发布门禁必须明确返回 true；缺省或 truthy 都不放行。
      return isAssetAvailable(descriptor) === true;
    } catch {
      return false;
    }
  }

  function storyReadable(storyId) {
    try {
      const story = storyWindow.getStory(storyId);
      return Boolean(story && story.available === true && Number(story.factCount) > 0);
    } catch {
      return false;
    }
  }

  function resolveSource(kind, storyId, speakerId) {
    const progress = storyProgress.getProgress(storyId);
    if (!progress || progress.type !== (kind === "outfit" ? "outfit" : "character")) {
      return { ok: false, reason: "STORY_NOT_FOUND" };
    }
    if (progress.progressStatus !== "mature") {
      return { ok: false, reason: "STORY_NOT_MATURE" };
    }
    if (progress.available !== true) {
      return { ok: false, reason: progress.reason ?? "STORY_UNAVAILABLE" };
    }
    if (kind === "outfit") {
      const ownership = discoveryOutcomes.getOutfitOwnership({ storyId });
      if (!ownership || ownership.notificationPending !== true) {
        return { ok: false, reason: "OUTFIT_NOTICE_NOT_PENDING" };
      }
    }
    if (!storyReadable(storyId)) {
      return { ok: false, reason: "STORY_UNAVAILABLE" };
    }
    const descriptor = descriptorFor(kind, storyId, speakerId, progress);
    if (!assetAvailable(descriptor)) {
      return { ok: false, reason: "ASSET_UNAVAILABLE" };
    }
    return { ok: true, descriptor, progress };
  }

  function resolveInvitationForAck(storyId, speakerId) {
    const resolved = resolveSource("invitation", storyId, speakerId);
    if (!resolved.ok) {
      return resolved;
    }
    const invitation = discoveryOutcomes.getInvitationByStory({ storyId });
    if (!invitation || invitation.status !== "prepared" || invitation.displayedAt !== null) {
      return { ok: false, reason: "INVITATION_NOT_PREPARED" };
    }
    return { ...resolved, invitation };
  }

  /* 最早未告知衣装与最早成熟相遇统一排序；同刻按类型、ID 保持稳定。 */
  function candidateSources() {
    const outfits = statements.pendingOutfits.all().map((row) => ({
      kind: "outfit",
      storyId: row.story_id,
      since: Number(row.unlocked_at),
    }));
    const invitations = storyProgress
      .listProgress()
      .filter((progress) => progress.type === "character" && progress.progressStatus === "mature")
      .map((progress) => ({
        kind: "invitation",
        storyId: progress.storyId,
        since: Number(progress.maturedAt ?? progress.startedAt),
      }));
    return [...outfits, ...invitations].sort(
      (left, right) =>
        left.since - right.since ||
        left.kind.localeCompare(right.kind) ||
        left.storyId.localeCompare(right.storyId),
    );
  }

  function prepareInvitationSource(storyId, speakerId) {
    const resolved = resolveSource("invitation", storyId, speakerId);
    if (!resolved.ok) {
      return null;
    }
    // 邀请允许在准备阶段落 prepared；已 pending/later/rejected 的目标不会重发。
    const prepared = discoveryOutcomes.prepareInvitation({ storyId });
    if (
      !prepared.prepared ||
      !prepared.invitation ||
      prepared.invitation.status !== "prepared" ||
      prepared.invitation.displayedAt !== null
    ) {
      return null;
    }
    return resolved;
  }

  function prepare({ speakerId } = {}) {
    ensureActive();
    const speaker =
      speakerId === undefined || speakerId === null
        ? null
        : cleanText(speakerId, "speakerId");
    if (active) {
      return { prepared: false, reason: "NOTICE_ACTIVE", notice: { ...active } };
    }
    const quota = budget.status();
    if (!quota.canPresent) {
      return { prepared: false, reason: quota.reason, notice: null };
    }

    for (const candidate of candidateSources()) {
      const resolved =
        candidate.kind === "outfit"
          ? resolveSource("outfit", candidate.storyId, speaker)
          : prepareInvitationSource(candidate.storyId, speaker);
      if (!resolved?.ok) {
        continue;
      }
      active = {
        noticeId: noticeIdFor(candidate.kind, candidate.storyId),
        token: crypto.randomUUID(),
        ...resolved.descriptor,
        preparedAt: budget.logicalNow(),
      };
      return { prepared: true, notice: { ...active } };
    }
    return { prepared: false, reason: "NO_NOTICE_CONTENT", notice: null };
  }

  function getView() {
    return active ? { ...active } : null;
  }

  function withAckTransaction(work) {
    db.exec(`SAVEPOINT ${ACK_SAVEPOINT}`);
    try {
      const result = work();
      db.exec(`RELEASE ${ACK_SAVEPOINT}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${ACK_SAVEPOINT}`);
        db.exec(`RELEASE ${ACK_SAVEPOINT}`);
      } catch {
        // 回滚失败不覆盖原始业务错误；连接层问题由调用方处理。
      }
      throw error;
    }
  }

  /* 只有当前窗口、当前 token 与实际来源都成立时才写。发现结果确认、收据
     与邀请状态同属一个 SAVEPOINT，任一失败全部回滚。 */
  function acknowledge({ noticeId, token } = {}) {
    ensureActive();
    const noticeKey = cleanText(noticeId, "noticeId", 300);
    const tokenKey = cleanText(token, "token", 200);
    const parsed = parseNoticeId(noticeKey);
    if (!parsed) {
      return { acknowledged: false, reason: "NOTICE_UNKNOWN" };
    }
    const notice = { noticeId: noticeKey, ...parsed };

    const existing = budget.getReceipt(parsed.sourceKey);
    if (existing) {
      if (active && active.noticeId === noticeKey) {
        active = null;
      }
      return { acknowledged: true, duplicate: true, receipt: existing, notice };
    }
    if (!active) {
      return { acknowledged: false, reason: "NOTICE_UNKNOWN" };
    }
    if (active.noticeId !== noticeKey || active.token !== tokenKey) {
      return { acknowledged: false, reason: "STALE_TOKEN" };
    }

    const quota = budget.status();
    if (!quota.canPresent) {
      return { acknowledged: false, reason: quota.reason };
    }
    const current =
      active.kind === "outfit"
        ? resolveSource("outfit", active.storyId, active.speakerId)
        : resolveInvitationForAck(active.storyId, active.speakerId);
    if (!current.ok) {
      return { acknowledged: false, reason: current.reason };
    }

    const outcome = withAckTransaction(() => {
      const duplicate = budget.getReceipt(parsed.sourceKey);
      if (duplicate) {
        return { acknowledged: true, duplicate: true, receipt: duplicate };
      }
      const recorded = budget.record({
        sourceKey: parsed.sourceKey,
        kind: parsed.kind,
        storyId: parsed.storyId,
      });
      if (!recorded.recorded) {
        return { acknowledged: true, duplicate: true, receipt: recorded.receipt };
      }
      const confirmed =
        parsed.kind === "outfit"
          ? discoveryOutcomes.acknowledgeOutfitNotice({ storyId: parsed.storyId })
          : discoveryOutcomes.acknowledgeInvitation({
              invitationId: current.invitation.invitationId,
              source: "automatic",
            });
      if (!confirmed.acknowledged || confirmed.duplicate) {
        throw new AppError("NOTICE_ACK_CONFLICT", "自动告知确认状态不一致。");
      }
      return { acknowledged: true, duplicate: false, receipt: recorded.receipt };
    });

    active = null;
    return { ...outcome, notice };
  }

  /* ACK 前关闭/被抢占只丢弃本次内存展示，不删已保存内容或收据。 */
  function cancel() {
    ensureActive();
    if (!active) {
      return { cancelled: false };
    }
    active = null;
    return { cancelled: true };
  }

  function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    active = null;
    return true;
  }

  return { prepare, getView, acknowledge, cancel, dispose };
}

module.exports = { createAutomaticNotices };
