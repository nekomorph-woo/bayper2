/* S03j 已完成主题活动结果的定向记忆共享。
   只在 storyProgress.recordNode 的 onResult 事务内、针对本次新 applied 节点工作：
   正文来自已发布作者节点，不读取聊天、来源分析或模型自由文本。讲述者片段与接收者
   派生记忆、共享结果记录、24h 逻辑时钟都写入同一个 SQLite 事务；业务拒绝只记
   skipped/ already_held，SQLite 故障向调用方抛出，由故事事务整笔回滚。
   快照由调用方在故事事务外读取并通过 context 传入，本模块不调用 companionship、
   不抽选新机会、不请求模型、不改名单或数值。 */
const crypto = require("node:crypto");
const { MemoryError } = require("./memory.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_ENERGY = 30;
const BODY_PREFIX = "主题故事见闻：";
const FACT_KEY_PREFIX = "theme-fact";
const SOURCE_ID_PREFIX = "theme-source";
const MAX_KEY_LENGTH = 200;
const LAST_SUCCESS_KEY = "theme_memory_share_last_success_at";
const MAX_LOGICAL_KEY = "theme_memory_share_max_logical_at";
const SAVEPOINT = "theme_memory_share";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS theme_memory_shares (
    activity_id TEXT PRIMARY KEY REFERENCES character_activities(activity_id),
    story_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    narrator_id TEXT NOT NULL REFERENCES relationships(character_id),
    recipient_id TEXT REFERENCES relationships(character_id),
    outcome TEXT NOT NULL CHECK (outcome IN ('shared', 'already_held', 'skipped')),
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`;

/* 稳定身份只由主题/故事/事实构成；使用 JSON 元组避免分隔符碰撞，
   超长时对同一无歧义元组取完整 SHA-256。 */
function identityKey(prefix, { themeId, storyId, factId }) {
  const raw = JSON.stringify([themeId, storyId, factId]);
  const key = `${prefix}:${raw}`;
  if (key.length <= MAX_KEY_LENGTH) {
    return key;
  }
  return `${prefix}:sha256:${crypto.createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function createThemeMemorySharing({ db, memory } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new MemoryError("DATABASE_REQUIRED", "主题记忆分享需要 SQLite 连接。");
  }
  if (
    !memory ||
    typeof memory.remember !== "function" ||
    typeof memory.share !== "function"
  ) {
    throw new MemoryError("MEMORY_REQUIRED", "主题记忆分享需要记忆服务。");
  }

  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    getShare: db.prepare("SELECT * FROM theme_memory_shares WHERE activity_id = ?"),
    insertShare: db.prepare(`
      INSERT INTO theme_memory_shares (
        activity_id, story_id, node_id, narrator_id, recipient_id,
        outcome, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getState: db.prepare("SELECT value FROM app_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    isKnownCharacter: db.prepare(
      "SELECT 1 AS found FROM relationships WHERE character_id = ?",
    ),
  };

  function publicShare(row) {
    if (!row) {
      return null;
    }
    return {
      activityId: row.activity_id,
      storyId: row.story_id,
      nodeId: row.node_id,
      narratorId: row.narrator_id,
      recipientId: row.recipient_id ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      createdAt: Number(row.created_at),
    };
  }

  function readNumber(key) {
    const value = Number(statements.getState.get(key)?.value);
    return Number.isFinite(value) ? value : null;
  }

  /* 持久最大逻辑时钟：时间回拨不会让已观察到的窗口位置倒退。 */
  function advanceClock(at) {
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new MemoryError("INVALID_INPUT", "分享时间无效。");
    }
    const stored = readNumber(MAX_LOGICAL_KEY);
    const logicalAt = stored === null ? at : Math.max(at, stored);
    statements.setState.run(MAX_LOGICAL_KEY, String(logicalAt));
    return logicalAt;
  }

  function record({
    activityId,
    storyId,
    nodeId,
    narratorId,
    recipientId = null,
    outcome,
    reason = null,
    at,
  }) {
    statements.insertShare.run(
      activityId,
      storyId,
      nodeId,
      narratorId,
      recipientId,
      outcome,
      reason,
      at,
    );
    return publicShare(statements.getShare.get(activityId));
  }

  function rollbackSavepoint() {
    db.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    db.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
  }

  function skip(base, reason) {
    return record({ ...base, outcome: "skipped", reason });
  }

  /* 只在本次新 applied 节点上评估一次；merged/skipped/重复 activity 不进入分享。 */
  function shareActivityResult({ activity, result, context, at } = {}) {
    if (!result || result.outcome !== "applied" || result.duplicate === true) {
      return null;
    }
    const activityId = result.activityId;
    const existing = statements.getShare.get(activityId);
    if (existing) {
      return publicShare(existing);
    }

    const logicalAt = advanceClock(at);
    const base = {
      activityId,
      storyId: result.storyId,
      nodeId: result.nodeId,
      narratorId: result.narratorId,
      at: logicalAt,
    };
    const themeId = result.themeId;
    const factId = result.factId;
    const body = typeof result.body === "string" ? result.body.trim() : "";
    const shareWith = Array.isArray(result.shareWithCharacterIds)
      ? result.shareWithCharacterIds
      : [];

    if (
      !activity ||
      activity.activityId !== activityId ||
      activity.characterId !== result.narratorId ||
      activity.status !== "completed"
    ) {
      return skip(base, "ACTIVITY_INVALID");
    }
    if (!themeId || !factId || !body) {
      return skip(base, "SOURCE_UNAVAILABLE");
    }
    if (shareWith.length === 0) {
      return skip(base, "NO_ASSOCIATED_CHARACTER");
    }
    if (!context || context.blocked === true) {
      return skip(base, "PAUSED");
    }
    const snapshot = context.snapshot;
    if (
      !snapshot ||
      !Array.isArray(snapshot.characters) ||
      !Array.isArray(snapshot.roster)
    ) {
      return skip(base, "SNAPSHOT_UNAVAILABLE");
    }
    if (snapshot.pendingRotation === true) {
      return skip(base, "PENDING_ROTATION");
    }
    if (snapshot.interaction) {
      return skip(base, "INTERACTION");
    }

    const narrator = snapshot.characters.find(
      (item) => item.characterId === result.narratorId,
    );
    if (!narrator || narrator.inRoster !== true) {
      return skip(base, "NARRATOR_NOT_IN_ROSTER");
    }
    if (!narrator.stats || narrator.stats.energy <= LOW_ENERGY) {
      return skip(base, "NARRATOR_LOW_ENERGY");
    }
    if (narrator.exploring === true || narrator.mode === "exploring") {
      return skip(base, "NARRATOR_EXPLORING");
    }
    if (narrator.mode === "resting") {
      return skip(base, "NARRATOR_RESTING");
    }
    if (narrator.mode === "daily" || narrator.mode === "interacting") {
      return skip(base, "NARRATOR_BUSY");
    }
    if (narrator.activity) {
      return skip(base, "NARRATOR_BUSY");
    }

    const rosterIds = new Set(snapshot.roster.map((entry) => entry.characterId));
    const recipientId =
      shareWith.find(
        (characterId) =>
          characterId !== result.narratorId &&
          rosterIds.has(characterId) &&
          Boolean(statements.isKnownCharacter.get(characterId)),
      ) ?? null;
    if (!recipientId) {
      return skip(base, "NO_ELIGIBLE_RECIPIENT");
    }

    const lastSuccess = readNumber(LAST_SUCCESS_KEY);
    if (lastSuccess !== null && logicalAt - lastSuccess < DAY_MS) {
      return skip(base, "SHARE_WINDOW");
    }

    const factKey = identityKey(FACT_KEY_PREFIX, { themeId, storyId: result.storyId, factId });
    const sourceId = identityKey(SOURCE_ID_PREFIX, { themeId, storyId: result.storyId, factId });
    const shareBody = `${BODY_PREFIX}${body}`;

    db.exec(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const remembered = memory.remember({
        characterId: result.narratorId,
        factKey,
        body: shareBody,
        kind: "experience",
        sourceKind: "theme",
        sourceId,
        inTransaction: true,
      });
      if (!remembered.created) {
        if (remembered.blocked) {
          rollbackSavepoint();
          return skip(
            base,
            remembered.blocked === "forget" ? "FORGET_BLOCKED" : "SOURCE_BLOCKED",
          );
        }
        const existingEntry = remembered.entry;
        if (!existingEntry || existingEntry.body !== shareBody) {
          // 用户纠正后的正文优先；旧作者文案不覆盖、也不再传播。
          rollbackSavepoint();
          return skip(base, "AUTHOR_BODY_CONFLICT");
        }
        if (
          existingEntry.originCharacterId !== result.narratorId ||
          existingEntry.derived === true
        ) {
          rollbackSavepoint();
          return skip(base, "DERIVED_SOURCE");
        }
      }

      const shared = memory.share({
        fromCharacterId: result.narratorId,
        toCharacterId: recipientId,
        entryIds: [remembered.entry.id],
        sourceId,
        inTransaction: true,
      });
      const delivery = shared.shared[0] ?? null;
      if (!delivery || delivery.alreadyHeld === true) {
        // 目标已持有同一事实：不新增、不占 24h 成功额度。
        rollbackSavepoint();
        return record({
          ...base,
          recipientId,
          outcome: "already_held",
        });
      }

      db.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      const sharedRecord = record({
        ...base,
        recipientId,
        outcome: "shared",
      });
      statements.setState.run(LAST_SUCCESS_KEY, String(logicalAt));
      return sharedRecord;
    } catch (error) {
      if (error instanceof MemoryError) {
        rollbackSavepoint();
        return skip(base, error.code ?? "SHARE_REJECTED");
      }
      throw error;
    }
  }

  function getShareResult(activityId) {
    return publicShare(statements.getShare.get(activityId));
  }

  return { shareActivityResult, getShareResult };
}

module.exports = { createThemeMemorySharing, DAY_MS, BODY_PREFIX };
