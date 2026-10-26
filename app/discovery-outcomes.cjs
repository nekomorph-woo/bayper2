/* S06f 相遇邀请与衣装归属。只消费 story-progress 已成熟的结果，
   使用同一 SQLite 连接保持邀请、关系、所有权与展示回执的事务一致。
   本模块不生成故事、不调用模型、不改变名单、固定位、当前角色或互动。 */
const { AppError } = require("./errors.cjs");
const { INITIAL_STATS } = require("./store.cjs");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OUTFIT_WINDOW_MS = 72 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS discovery_invitations (
    invitation_id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL UNIQUE,
    target_character_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('prepared', 'pending', 'later', 'rejected', 'accepted')
    ),
    prepared_at INTEGER NOT NULL,
    displayed_at INTEGER,
    quota_at INTEGER,
    resolution_at INTEGER,
    reopened_at INTEGER,
    source_activity_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS discovery_invitations_open
    ON discovery_invitations (status, prepared_at);

  CREATE TABLE IF NOT EXISTS discovery_outfit_ownership (
    story_id TEXT PRIMARY KEY,
    outfit_id TEXT NOT NULL,
    owner_character_id TEXT NOT NULL,
    source_activity_id TEXT,
    unlocked_at INTEGER NOT NULL,
    notification_pending INTEGER NOT NULL DEFAULT 1
      CHECK (notification_pending IN (0, 1)),
    notification_shown_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_character_id, outfit_id)
  );
  CREATE INDEX IF NOT EXISTS discovery_outfit_unlocked
    ON discovery_outfit_ownership (unlocked_at);
`;

function text(value, field) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const result = value.trim();
  if (!result || result.length > 200 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new AppError("INVALID_INPUT", `${field} 无效。`);
  }
  return result;
}

function createDiscoveryOutcomes({ db, storyProgress, now = () => new Date() }) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "发现结果需要 SQLite 连接。");
  }
  if (!storyProgress || typeof storyProgress.getProgress !== "function") {
    throw new AppError("STORY_PROGRESS_REQUIRED", "发现结果需要故事进度入口。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    invitation: db.prepare(
      "SELECT * FROM discovery_invitations WHERE invitation_id = ?",
    ),
    invitationByStory: db.prepare(
      "SELECT * FROM discovery_invitations WHERE story_id = ?",
    ),
    outstanding: db.prepare(`
      SELECT * FROM discovery_invitations
      WHERE status IN ('prepared', 'pending', 'later')
      ORDER BY prepared_at ASC, invitation_id ASC
    `),
    rejectedTargets: db.prepare(`
      SELECT target_character_id FROM discovery_invitations
      WHERE status = 'rejected'
      ORDER BY prepared_at ASC, invitation_id ASC
    `),
    rejectedByTarget: db.prepare(`
      SELECT * FROM discovery_invitations
      WHERE target_character_id = ? AND status = 'rejected'
      ORDER BY prepared_at ASC, invitation_id ASC LIMIT 1
    `),
    quota: db.prepare(`
      SELECT COUNT(*) AS count FROM discovery_invitations
      WHERE quota_at IS NOT NULL AND quota_at > ?
    `),
    insertInvitation: db.prepare(`
      INSERT INTO discovery_invitations
        (invitation_id, story_id, target_character_id, status,
         prepared_at, source_activity_id, created_at, updated_at)
      VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?)
    `),
    setInvitationStatus: db.prepare(`
      UPDATE discovery_invitations
      SET status = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    displayInvitation: db.prepare(`
      UPDATE discovery_invitations
      SET status = 'pending', displayed_at = ?, quota_at = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    setResolution: db.prepare(`
      UPDATE discovery_invitations
      SET status = ?, resolution_at = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    reopenInvitation: db.prepare(`
      UPDATE discovery_invitations
      SET status = 'pending', reopened_at = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    reopenUnshownInvitation: db.prepare(`
      UPDATE discovery_invitations
      SET status = 'prepared', reopened_at = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    acceptInvitation: db.prepare(`
      UPDATE discovery_invitations
      SET status = 'accepted', resolution_at = ?, updated_at = ?
      WHERE invitation_id = ?
    `),
    relationship: db.prepare(
      "SELECT 1 AS present FROM relationships WHERE character_id = ?",
    ),
    sourceActivity: db.prepare(`
      SELECT s.activity_id
      FROM story_fact_sources s
      JOIN story_facts f ON f.fact_id = s.fact_id
      WHERE f.story_id = ?
      ORDER BY s.learned_at DESC, s.rowid DESC LIMIT 1
    `),
    insertRelationship: db.prepare(
      "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    ),
    insertStats: db.prepare(`
      INSERT INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, ?, ?, ?)
    `),
    insertRuntime: db.prepare(`
      INSERT INTO character_runtime
        (character_id, mode, last_settled_at, exploring)
      VALUES (?, 'waiting', ?, 0)
    `),
    outfitQuota: db.prepare(`
      SELECT COUNT(*) AS count FROM discovery_outfit_ownership
      WHERE unlocked_at > ?
    `),
    ownershipByStory: db.prepare(
      "SELECT * FROM discovery_outfit_ownership WHERE story_id = ?",
    ),
    ownershipByOutfit: db.prepare(`
      SELECT * FROM discovery_outfit_ownership
      WHERE owner_character_id = ? AND outfit_id = ?
    `),
    insertOwnership: db.prepare(`
      INSERT INTO discovery_outfit_ownership
        (story_id, outfit_id, owner_character_id, source_activity_id,
         unlocked_at, notification_pending, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `),
    ackOwnership: db.prepare(`
      UPDATE discovery_outfit_ownership
      SET notification_pending = 0, notification_shown_at = ?, updated_at = ?
      WHERE story_id = ? AND notification_pending = 1
    `),
  };

  let disposed = false;

  function nowMs() {
    const value = now();
    const at = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(at)) {
      throw new AppError("CLOCK_INVALID", "发现结果时钟无效。");
    }
    return at;
  }

  function ensureActive() {
    if (disposed) {
      throw new AppError("OUTCOMES_DISPOSED", "发现结果入口已释放。");
    }
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function invitationPublic(row) {
    if (!row) {
      return null;
    }
    return {
      invitationId: row.invitation_id,
      storyId: row.story_id,
      targetCharacterId: row.target_character_id,
      status: row.status,
      preparedAt: Number(row.prepared_at),
      displayedAt: row.displayed_at === null ? null : Number(row.displayed_at),
      quotaAt: row.quota_at === null ? null : Number(row.quota_at),
      resolutionAt: row.resolution_at === null ? null : Number(row.resolution_at),
      reopenedAt: row.reopened_at === null ? null : Number(row.reopened_at),
      sourceActivityId: row.source_activity_id,
    };
  }

  function ownershipPublic(row) {
    if (!row) {
      return null;
    }
    return {
      storyId: row.story_id,
      outfitId: row.outfit_id,
      ownerCharacterId: row.owner_character_id,
      sourceActivityId: row.source_activity_id,
      unlockedAt: Number(row.unlocked_at),
      notificationPending: Boolean(row.notification_pending),
      notificationShownAt:
        row.notification_shown_at === null ? null : Number(row.notification_shown_at),
    };
  }

  function sourceActivityFor(storyId) {
    return statements.sourceActivity.get(storyId)?.activity_id ?? null;
  }

  function invitationSourceError(invitation) {
    const progress = storyProgress.getProgress(invitation.story_id);
    if (!progress) {
      return "STORY_NOT_FOUND";
    }
    if (progress.type !== "character") {
      return "STORY_TYPE_INVALID";
    }
    if (progress.targetId !== invitation.target_character_id) {
      return "STORY_TARGET_CHANGED";
    }
    if (progress.progressStatus !== "mature") {
      return "STORY_NOT_MATURE";
    }
    return progress.available ? null : progress.reason ?? "STORY_UNAVAILABLE";
  }

  function storyState(progress, type) {
    if (!progress) {
      return "STORY_NOT_FOUND";
    }
    if (progress.type !== type) {
      return "STORY_TYPE_INVALID";
    }
    if (progress.progressStatus !== "mature") {
      return "STORY_NOT_MATURE";
    }
    if (!progress.available) {
      return progress.reason ?? "STORY_UNAVAILABLE";
    }
    return null;
  }

  function outstandingInvitation(excludeId = null) {
    return statements.outstanding
      .all()
      .find((row) => row.invitation_id !== excludeId) ?? null;
  }

  function prepareInvitation({ storyId } = {}) {
    ensureActive();
    const storyKey = text(storyId, "storyId");
    const at = nowMs();
    return transaction(() => {
      const progress = storyProgress.getProgress(storyKey);
      const state = storyState(progress, "character");
      if (state) {
        return { prepared: false, reason: state, invitation: null };
      }

      const existing = statements.invitationByStory.get(storyKey);
      if (existing) {
        if (existing.status === "accepted") {
          return {
            prepared: false,
            reason: "ALREADY_ACCEPTED",
            invitation: invitationPublic(existing),
          };
        }
        if (existing.status === "rejected") {
          return {
            prepared: false,
            reason: "INVITATION_REJECTED",
            invitation: invitationPublic(existing),
          };
        }
        if (existing.status !== "prepared") {
          return {
            prepared: false,
            reason: "INVITATION_ACTIVE",
            duplicate: true,
            invitation: invitationPublic(existing),
          };
        }
        return {
          prepared: true,
          duplicate: true,
          invitation: invitationPublic(existing),
        };
      }

      if (statements.relationship.get(progress.targetId)) {
        return { prepared: false, reason: "ALREADY_ACCEPTED", invitation: null };
      }
      const outstanding = outstandingInvitation();
      if (outstanding) {
        return {
          prepared: false,
          reason: "INVITATION_ACTIVE",
          invitation: invitationPublic(outstanding),
        };
      }
      const rejected = statements.rejectedByTarget.get(progress.targetId);
      if (rejected) {
        return {
          prepared: false,
          reason: "TARGET_REJECTED",
          invitation: invitationPublic(rejected),
        };
      }
      if (Number(statements.quota.get(at - WEEK_MS).count) >= 1) {
        return { prepared: false, reason: "INVITATION_QUOTA", invitation: null };
      }

      const invitationId = `invite:${storyKey}`;
      statements.insertInvitation.run(
        invitationId,
        storyKey,
        progress.targetId,
        at,
        sourceActivityFor(storyKey),
        at,
        at,
      );
      return {
        prepared: true,
        duplicate: false,
        invitation: invitationPublic(statements.invitation.get(invitationId)),
      };
    });
  }

  function acknowledgeInvitation({ invitationId } = {}) {
    ensureActive();
    const key = text(invitationId, "invitationId");
    const at = nowMs();
    return transaction(() => {
      const invitation = statements.invitation.get(key);
      if (!invitation) {
        throw new AppError("INVITATION_NOT_FOUND", "邀请不存在。");
      }
      if (invitation.status === "pending") {
        return {
          acknowledged: true,
          duplicate: true,
          invitation: invitationPublic(invitation),
        };
      }
      if (invitation.status !== "prepared") {
        throw new AppError("INVITATION_NOT_DISPLAYABLE", "邀请当前不能确认展示。");
      }
      const sourceError = invitationSourceError(invitation);
      if (sourceError) {
        throw new AppError("INVITATION_SOURCE_UNAVAILABLE", sourceError);
      }
      if (Number(statements.quota.get(at - WEEK_MS).count) >= 1) {
        throw new AppError("INVITATION_QUOTA", "当前滚动周期不能展示新邀请。");
      }
      statements.displayInvitation.run(at, at, at, key);
      return {
        acknowledged: true,
        duplicate: false,
        invitation: invitationPublic(statements.invitation.get(key)),
      };
    });
  }

  function deferInvitation({ invitationId } = {}) {
    ensureActive();
    const key = text(invitationId, "invitationId");
    const at = nowMs();
    return transaction(() => {
      const invitation = statements.invitation.get(key);
      if (!invitation) {
        throw new AppError("INVITATION_NOT_FOUND", "邀请不存在。");
      }
      if (invitation.status === "later") {
        return { deferred: true, duplicate: true, invitation: invitationPublic(invitation) };
      }
      if (!["prepared", "pending"].includes(invitation.status)) {
        throw new AppError("INVITATION_NOT_OPEN", "邀请当前不能稍后处理。");
      }
      statements.setResolution.run("later", at, at, key);
      return {
        deferred: true,
        duplicate: false,
        invitation: invitationPublic(statements.invitation.get(key)),
      };
    });
  }

  function rejectInvitation({ invitationId } = {}) {
    ensureActive();
    const key = text(invitationId, "invitationId");
    const at = nowMs();
    return transaction(() => {
      const invitation = statements.invitation.get(key);
      if (!invitation) {
        throw new AppError("INVITATION_NOT_FOUND", "邀请不存在。");
      }
      if (invitation.status === "rejected") {
        return { rejected: true, duplicate: true, invitation: invitationPublic(invitation) };
      }
      if (!["prepared", "pending", "later"].includes(invitation.status)) {
        throw new AppError("INVITATION_NOT_OPEN", "邀请当前不能拒绝。");
      }
      statements.setResolution.run("rejected", at, at, key);
      return {
        rejected: true,
        duplicate: false,
        invitation: invitationPublic(statements.invitation.get(key)),
      };
    });
  }

  function reopenInvitation({ invitationId } = {}) {
    ensureActive();
    const key = text(invitationId, "invitationId");
    const at = nowMs();
    return transaction(() => {
      const invitation = statements.invitation.get(key);
      if (!invitation) {
        throw new AppError("INVITATION_NOT_FOUND", "邀请不存在。");
      }
      if (invitation.status === "pending") {
        return {
          reopened: false,
          duplicate: true,
          invitation: invitationPublic(invitation),
        };
      }
      if (invitation.status === "accepted") {
        throw new AppError("INVITATION_ACCEPTED", "已接纳的邀请不能重新展示。");
      }
      if (!["later", "rejected"].includes(invitation.status)) {
        return { reopened: false, reason: "INVITATION_OPEN", invitation: invitationPublic(invitation) };
      }
      const outstanding = outstandingInvitation(key);
      if (outstanding) {
        return {
          reopened: false,
          reason: "INVITATION_ACTIVE",
          invitation: invitationPublic(outstanding),
        };
      }
      if (invitation.displayed_at === null) {
        statements.reopenUnshownInvitation.run(at, at, key);
      } else {
        statements.reopenInvitation.run(at, at, key);
      }
      return {
        reopened: true,
        invitation: invitationPublic(statements.invitation.get(key)),
      };
    });
  }

  function acceptInvitation({ invitationId } = {}) {
    ensureActive();
    const key = text(invitationId, "invitationId");
    const at = nowMs();
    return transaction(() => {
      const invitation = statements.invitation.get(key);
      if (!invitation) {
        throw new AppError("INVITATION_NOT_FOUND", "邀请不存在。");
      }
      if (invitation.status === "accepted") {
        return {
          accepted: true,
          duplicate: true,
          alreadyAccepted: true,
          invitation: invitationPublic(invitation),
        };
      }
      if (invitation.status === "rejected" || invitation.displayed_at === null) {
        throw new AppError("INVITATION_NOT_DISPLAYED", "邀请尚未实际展示或已结束。");
      }
      if (invitation.status !== "pending" && invitation.status !== "later") {
        throw new AppError("INVITATION_NOT_OPEN", "邀请当前不能接纳。");
      }

      const sourceError = invitationSourceError(invitation);
      if (sourceError) {
        throw new AppError("INVITATION_SOURCE_UNAVAILABLE", sourceError);
      }

      const existing = statements.relationship.get(invitation.target_character_id);
      if (!existing) {
        statements.insertRelationship.run(
          invitation.target_character_id,
          new Date(at).toISOString(),
        );
        statements.insertStats.run(
          invitation.target_character_id,
          INITIAL_STATS.intimacy,
          INITIAL_STATS.energy,
          INITIAL_STATS.mood,
        );
        statements.insertRuntime.run(invitation.target_character_id, at);
      }
      statements.acceptInvitation.run(at, at, key);
      return {
        accepted: true,
        duplicate: false,
        alreadyAccepted: Boolean(existing),
        invitation: invitationPublic(statements.invitation.get(key)),
      };
    });
  }

  function getInvitation({ invitationId } = {}) {
    const key = text(invitationId, "invitationId");
    return invitationPublic(statements.invitation.get(key));
  }

  function getPendingInvitation() {
    return invitationPublic(outstandingInvitation());
  }

  function getStorySelectionFilters() {
    const outstanding = outstandingInvitation();
    const rejectedTargetIds = [
      ...new Set(statements.rejectedTargets.all().map((row) => row.target_character_id)),
    ];
    return {
      pendingInvitationTargetId: outstanding?.target_character_id ?? null,
      rejectedTargetIds,
    };
  }

  function unlockNextOutfit() {
    ensureActive();
    const at = nowMs();
    return transaction(() => {
      if (Number(statements.outfitQuota.get(at - OUTFIT_WINDOW_MS).count) >= 1) {
        return { unlocked: false, reason: "OUTFIT_QUOTA", outfit: null };
      }
      const progresses = storyProgress
        .listProgress()
        .filter((item) => item.type === "outfit" && item.progressStatus === "mature");
      let sawUnavailable = false;
      for (const progress of progresses) {
        if (!progress.available) {
          sawUnavailable = true;
          continue;
        }
        if (!statements.relationship.get(progress.ownerCharacterId)) {
          continue;
        }
        if (
          statements.ownershipByStory.get(progress.storyId) ||
          statements.ownershipByOutfit.get(
            progress.ownerCharacterId,
            progress.targetId,
          )
        ) {
          continue;
        }
        const ownership = {
          storyId: progress.storyId,
          outfitId: progress.targetId,
          ownerCharacterId: progress.ownerCharacterId,
          sourceActivityId: sourceActivityFor(progress.storyId),
          at,
        };
        statements.insertOwnership.run(
          ownership.storyId,
          ownership.outfitId,
          ownership.ownerCharacterId,
          ownership.sourceActivityId,
          at,
          at,
          at,
        );
        return {
          unlocked: true,
          reason: null,
          outfit: ownershipPublic(
            statements.ownershipByStory.get(ownership.storyId),
          ),
        };
      }
      return {
        unlocked: false,
        reason: sawUnavailable ? "OUTFIT_UNAVAILABLE" : "NO_ELIGIBLE_OUTFIT",
        outfit: null,
      };
    });
  }

  function getOutfitOwnership({ storyId } = {}) {
    const key = text(storyId, "storyId");
    return ownershipPublic(statements.ownershipByStory.get(key));
  }

  function acknowledgeOutfitNotice({ storyId } = {}) {
    ensureActive();
    const key = text(storyId, "storyId");
    const at = nowMs();
    return transaction(() => {
      const ownership = statements.ownershipByStory.get(key);
      if (!ownership) {
        throw new AppError("OUTFIT_NOT_OWNED", "衣装尚未属于该角色。");
      }
      if (!ownership.notification_pending) {
        return { acknowledged: true, duplicate: true, outfit: ownershipPublic(ownership) };
      }
      statements.ackOwnership.run(at, at, key);
      return {
        acknowledged: true,
        duplicate: false,
        outfit: ownershipPublic(statements.ownershipByStory.get(key)),
      };
    });
  }

  function dispose() {
    disposed = true;
  }

  return {
    prepareInvitation,
    acknowledgeInvitation,
    deferInvitation,
    rejectInvitation,
    reopenInvitation,
    acceptInvitation,
    getInvitation,
    getPendingInvitation,
    getStorySelectionFilters,
    unlockNextOutfit,
    getOutfitOwnership,
    acknowledgeOutfitNotice,
    dispose,
  };
}

module.exports = { createDiscoveryOutcomes };
