/* S06e 作者故事节点与持久线索进度。
   只消费已真实完成的活动事实，保存稳定故事进度、事实来源与低频额度结果；
   作者目录由调用方提供，模块不生成节点、不写记忆、不改变名单或同屏。 */
const { AppError } = require("./errors.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const STORY_TYPES = ["character", "outfit"];
const ACTIVITY_KINDS = ["daily", "exploration"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS story_progress (
    story_id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('character', 'outfit')),
    target_id TEXT NOT NULL,
    owner_character_id TEXT,
    theme_id TEXT NOT NULL,
    next_node_index INTEGER NOT NULL CHECK (next_node_index >= 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'mature')),
    started_at INTEGER NOT NULL,
    matured_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS story_facts (
    fact_id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES story_progress(story_id),
    node_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    learned_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS story_facts_learned ON story_facts(learned_at);

  CREATE TABLE IF NOT EXISTS story_fact_sources (
    fact_id TEXT NOT NULL REFERENCES story_facts(fact_id),
    activity_id TEXT NOT NULL REFERENCES character_activities(activity_id),
    narrator_id TEXT NOT NULL REFERENCES relationships(character_id),
    learned_at INTEGER NOT NULL,
    PRIMARY KEY (fact_id, activity_id)
  );

  CREATE TABLE IF NOT EXISTS story_activity_results (
    activity_id TEXT PRIMARY KEY REFERENCES character_activities(activity_id),
    narrator_id TEXT NOT NULL REFERENCES relationships(character_id),
    story_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'merged', 'skipped')),
    fact_id TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
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

function normalizeCatalog(catalog) {
  const stories = Array.isArray(catalog?.stories) ? catalog.stories : null;
  if (!stories) {
    throw new AppError("STORY_CATALOG_INVALID", "作者故事目录格式无效。");
  }

  const storyIds = new Set();
  const factIds = new Set();
  const normalized = stories.map((story) => {
    const storyId = text(story?.storyId, "storyId");
    if (storyIds.has(storyId)) {
      throw new AppError("STORY_CATALOG_INVALID", `故事 ID 重复：${storyId}`);
    }
    storyIds.add(storyId);
    if (!STORY_TYPES.includes(story?.type)) {
      throw new AppError("STORY_CATALOG_INVALID", `故事类型无效：${storyId}`);
    }
    const targetId = text(story.targetId, "targetId");
    const themeId = text(story.themeId, "themeId");
    if (typeof story.assetAvailable !== "boolean") {
      throw new AppError("STORY_CATALOG_INVALID", `素材状态无效：${storyId}`);
    }
    const ownerCharacterId =
      story.type === "outfit"
        ? text(story.ownerCharacterId, "ownerCharacterId")
        : null;
    if (!Array.isArray(story.nodes) || story.nodes.length === 0) {
      throw new AppError("STORY_CATALOG_INVALID", `故事没有节点：${storyId}`);
    }

    const nodeIds = new Set();
    const nodes = story.nodes.map((node) => {
      const nodeId = text(node?.nodeId, "nodeId");
      const factId = text(node?.factId, "factId");
      if (nodeIds.has(nodeId)) {
        throw new AppError("STORY_CATALOG_INVALID", `节点 ID 重复：${nodeId}`);
      }
      if (factIds.has(factId)) {
        throw new AppError("STORY_CATALOG_INVALID", `事实 ID 重复：${factId}`);
      }
      nodeIds.add(nodeId);
      factIds.add(factId);
      const body = typeof node.body === "string" ? node.body.trim() : "";
      if (!body) {
        throw new AppError("STORY_CATALOG_INVALID", `节点缺少作者正文：${nodeId}`);
      }
      return Object.freeze({ nodeId, factId, body });
    });

    return Object.freeze({
      storyId,
      type: story.type,
      targetId,
      ownerCharacterId,
      themeId,
      assetAvailable: story.assetAvailable,
      nodes: Object.freeze(nodes),
      nodeIndex: new Map(nodes.map((node, index) => [node.nodeId, index])),
    });
  });

  return {
    stories: Object.freeze(normalized),
    byId: new Map(normalized.map((story) => [story.storyId, story])),
  };
}

function createStoryProgress({ db, catalog, now = () => new Date() }) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "故事进度需要 SQLite 连接。");
  }
  const content = normalizeCatalog(catalog);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const statements = {
    getActivity: db.prepare("SELECT * FROM character_activities WHERE activity_id = ?"),
    getProgress: db.prepare("SELECT * FROM story_progress WHERE story_id = ?"),
    listProgress: db.prepare(
      "SELECT * FROM story_progress ORDER BY started_at ASC, story_id ASC",
    ),
    activeByType: db.prepare(`
      SELECT story_id FROM story_progress
      WHERE type = ? AND status = 'active'
      ORDER BY started_at ASC, story_id ASC LIMIT 1
    `),
    getFact: db.prepare("SELECT * FROM story_facts WHERE fact_id = ?"),
    factsByStory: db.prepare(
      "SELECT * FROM story_facts WHERE story_id = ? ORDER BY rowid ASC",
    ),
    countFacts: db.prepare("SELECT COUNT(*) AS count FROM story_facts WHERE learned_at > ?"),
    insertProgress: db.prepare(`
      INSERT INTO story_progress
        (story_id, type, target_id, owner_character_id, theme_id,
         next_node_index, status, started_at, matured_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateProgress: db.prepare(`
      UPDATE story_progress
      SET next_node_index = ?, status = ?, matured_at = ?, updated_at = ?
      WHERE story_id = ?
    `),
    insertFact: db.prepare(`
      INSERT INTO story_facts (fact_id, story_id, node_id, target_id, learned_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertSource: db.prepare(`
      INSERT OR IGNORE INTO story_fact_sources
        (fact_id, activity_id, narrator_id, learned_at)
      VALUES (?, ?, ?, ?)
    `),
    getResult: db.prepare(
      "SELECT * FROM story_activity_results WHERE activity_id = ?",
    ),
    insertResult: db.prepare(`
      INSERT INTO story_activity_results
        (activity_id, narrator_id, story_id, node_id, outcome, fact_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    targetAccepted: db.prepare("SELECT 1 AS present FROM relationships WHERE character_id = ?"),
  };

  function timestamp() {
    const value = now();
    const at = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(at)) {
      throw new AppError("CLOCK_INVALID", "故事进度时钟无效。");
    }
    return at;
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

  function progressPublic(row) {
    if (!row) {
      return null;
    }
    const story = content.byId.get(row.story_id);
    const nextIndex = Number(row.next_node_index);
    let status = row.status;
    let available = true;
    let reason = null;
    let nextNodeId = story?.nodes[nextIndex]?.nodeId ?? null;
    if (!story) {
      status = "unavailable";
      available = false;
      reason = "STORY_UNAVAILABLE";
      nextNodeId = null;
    } else if (identityConflict(row, story)) {
      status = "unavailable";
      available = false;
      reason = "STORY_IDENTITY_CONFLICT";
      nextNodeId = null;
    } else if (!story.assetAvailable) {
      status = "unavailable";
      available = false;
      reason = "ASSET_UNAVAILABLE";
    }
    return {
      storyId: row.story_id,
      type: row.type,
      targetId: row.target_id,
      ownerCharacterId: row.owner_character_id,
      themeId: row.theme_id,
      nextNodeIndex: nextIndex,
      nextNodeId,
      status,
      progressStatus: row.status,
      available,
      reason,
      startedAt: Number(row.started_at),
      maturedAt: row.matured_at === null ? null : Number(row.matured_at),
      updatedAt: Number(row.updated_at),
    };
  }

  function resultPublic(row, duplicate) {
    if (!row) {
      return null;
    }
    const progress = statements.getProgress.get(row.story_id);
    return {
      activityId: row.activity_id,
      narratorId: row.narrator_id,
      storyId: row.story_id,
      nodeId: row.node_id,
      factId: row.fact_id ?? null,
      outcome:
        row.outcome === "skipped" && row.reason === "ASSET_UNAVAILABLE"
          ? "unavailable"
          : row.outcome,
      reason: row.reason ?? null,
      duplicate: Boolean(duplicate),
      merged: row.outcome === "merged",
      storyStatus: progress?.status ?? null,
      mature: progress?.status === "mature",
    };
  }

  function recordSkip({ activityId, narratorId, storyId, nodeId, reason, at }) {
    statements.insertResult.run(
      activityId,
      narratorId,
      storyId,
      nodeId,
      "skipped",
      null,
      reason,
      at,
    );
    return resultPublic(statements.getResult.get(activityId), false);
  }

  function targetEligible(story) {
    if (story.type === "character") {
      return !statements.targetAccepted.get(story.targetId);
    }
    return Boolean(statements.targetAccepted.get(story.ownerCharacterId));
  }

  function identityConflict(progress, story) {
    if (
      progress.type !== story.type ||
      progress.target_id !== story.targetId ||
      (progress.owner_character_id ?? null) !== (story.ownerCharacterId ?? null) ||
      progress.theme_id !== story.themeId
    ) {
      return true;
    }
    const facts = statements.factsByStory.all(story.storyId);
    const acquired = Number(progress.next_node_index);
    if (facts.length !== acquired) {
      return true;
    }
    return facts.some((fact, index) => {
      const node = story.nodes[index];
      return (
        !node ||
        fact.node_id !== node.nodeId ||
        fact.fact_id !== node.factId ||
        fact.target_id !== story.targetId
      );
    });
  }

  function storyCandidate(story, nodeIndex, continued) {
    const node = story.nodes[nodeIndex];
    return {
      storyId: story.storyId,
      type: story.type,
      targetId: story.targetId,
      ownerCharacterId: story.ownerCharacterId,
      themeId: story.themeId,
      nodeId: node.nodeId,
      factId: node.factId,
      nodeIndex,
      body: node.body,
      status: "ready",
      available: true,
      continued,
    };
  }

  function unavailableCandidate(progress, story, reason) {
    const index = Number(progress.next_node_index);
    const node = story?.nodes[index] ?? null;
    return {
      storyId: progress.story_id,
      type: progress.type,
      targetId: progress.target_id,
      ownerCharacterId: progress.owner_character_id,
      themeId: progress.theme_id,
      nodeId: node?.nodeId ?? null,
      factId: node?.factId ?? null,
      nodeIndex: index,
      body: node?.body ?? null,
      status: "unavailable",
      available: false,
      reason,
      continued: true,
    };
  }

  function storyAllowed(story, options) {
    if (story.type !== "character") {
      return Boolean(statements.targetAccepted.get(story.ownerCharacterId));
    }
    if (statements.targetAccepted.get(story.targetId)) {
      return false;
    }
    if (options.pendingInvitationTargetId !== null) {
      return false;
    }
    return !options.rejectedTargetIds.has(story.targetId);
  }

  function selectionOptions(options = {}) {
    const rejected = options.rejectedTargetIds ?? [];
    if (!Array.isArray(rejected)) {
      throw new AppError("INVALID_INPUT", "rejectedTargetIds 必须是数组。");
    }
    const pending = options.pendingInvitationTargetId ?? null;
    return {
      pendingInvitationTargetId:
        pending === null ? null : text(pending, "pendingInvitationTargetId"),
      rejectedTargetIds: new Set(rejected.map((id) => text(id, "rejectedTargetId"))),
    };
  }

  function selectNextStories(options = {}) {
    const filters = selectionOptions(options);
    const progresses = statements.listProgress.all();
    const progressByStory = new Map(progresses.map((row) => [row.story_id, row]));
    const selected = [];

    for (const type of STORY_TYPES) {
      const active = progresses.find(
        (row) => row.type === type && row.status === "active",
      );
      if (active) {
        const story = content.byId.get(active.story_id);
        if (!story) {
          selected.push(unavailableCandidate(active, null, "STORY_UNAVAILABLE"));
          continue;
        }
        if (identityConflict(active, story)) {
          selected.push(unavailableCandidate(active, null, "STORY_IDENTITY_CONFLICT"));
          continue;
        }
        if (!storyAllowed(story, filters)) {
          continue;
        }
        if (!story.assetAvailable) {
          selected.push(unavailableCandidate(active, story, "ASSET_UNAVAILABLE"));
          continue;
        }
        const index = Number(active.next_node_index);
        if (story.nodes[index]) {
          selected.push(storyCandidate(story, index, true));
        }
        continue;
      }

      const story = content.stories.find((candidate) => {
        if (candidate.type !== type || progressByStory.has(candidate.storyId)) {
          return false;
        }
        return (
          candidate.assetAvailable &&
          storyAllowed(candidate, filters)
        );
      });
      if (story) {
        selected.push(storyCandidate(story, 0, false));
      }
    }
    return selected;
  }

  function recordNode({ activityId, narratorId, storyId, nodeId } = {}) {
    const activityKey = text(activityId, "activityId");
    const narrator = text(narratorId, "narratorId");
    const storyKey = text(storyId, "storyId");
    const nodeKey = text(nodeId, "nodeId");
    const activity = statements.getActivity.get(activityKey);
    if (!activity) {
      throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在。");
    }
    if (activity.status !== "completed") {
      throw new AppError("ACTIVITY_NOT_COMPLETED", "只有已完成活动能记录故事节点。");
    }
    if (!ACTIVITY_KINDS.includes(activity.kind)) {
      throw new AppError("ACTIVITY_KIND_INVALID", "该活动类型不能产生故事节点。");
    }
    if (activity.character_id !== narrator) {
      throw new AppError("NARRATOR_MISMATCH", "讲述者与活动角色不一致。");
    }
    const at = timestamp();

    return transaction(() => {
      const previous = statements.getResult.get(activityKey);
      if (previous) {
        return resultPublic(previous, true);
      }

      const story = content.byId.get(storyKey);
      if (!story) {
        throw new AppError("STORY_NOT_FOUND", "作者故事不存在。");
      }
      const nodeIndex = story.nodeIndex.get(nodeKey);
      if (nodeIndex === undefined) {
        throw new AppError("STORY_NODE_NOT_FOUND", "作者故事节点不存在。");
      }
      const progress = statements.getProgress.get(storyKey);
      if (progress && identityConflict(progress, story)) {
        throw new AppError("STORY_IDENTITY_CONFLICT", "故事身份或历史节点与当前目录冲突。");
      }
      if (!targetEligible(story)) {
        throw new AppError("STORY_TARGET_INELIGIBLE", "故事目标当前没有发现资格。");
      }

      const nextIndex = progress ? Number(progress.next_node_index) : 0;
      if (nodeIndex > nextIndex) {
        throw new AppError("STORY_OUT_OF_ORDER", "必须按作者顺序推进故事节点。");
      }
      if (nodeIndex < nextIndex) {
        const fact = statements.getFact.get(story.nodes[nodeIndex].factId);
        if (!fact) {
          throw new AppError("FACT_CONFLICT", "已有故事进度与事实记录不一致。");
        }
        statements.insertSource.run(
          fact.fact_id,
          activityKey,
          narrator,
          at,
        );
        statements.insertResult.run(
          activityKey,
          narrator,
          storyKey,
          nodeKey,
          "merged",
          fact.fact_id,
          null,
          at,
        );
        return resultPublic(statements.getResult.get(activityKey), false);
      }

      const node = story.nodes[nodeIndex];
      if (statements.getFact.get(node.factId)) {
        throw new AppError("FACT_CONFLICT", "事实身份已被其他节点占用。");
      }
      if (!story.assetAvailable) {
        return recordSkip({
          activityId: activityKey,
          narratorId: narrator,
          storyId: storyKey,
          nodeId: nodeKey,
          reason: "ASSET_UNAVAILABLE",
          at,
        });
      }
      if (Number(statements.countFacts.get(at - DAY_MS).count) >= 1) {
        return recordSkip({
          activityId: activityKey,
          narratorId: narrator,
          storyId: storyKey,
          nodeId: nodeKey,
          reason: "QUOTA",
          at,
        });
      }
      if (!progress && statements.activeByType.get(story.type)) {
        return recordSkip({
          activityId: activityKey,
          narratorId: narrator,
          storyId: storyKey,
          nodeId: nodeKey,
          reason: "STORY_TYPE_BUSY",
          at,
        });
      }

      const next = nodeIndex + 1;
      const status = next >= story.nodes.length ? "mature" : "active";
      if (progress) {
        statements.updateProgress.run(
          next,
          status,
          status === "mature" ? at : null,
          at,
          storyKey,
        );
      } else {
        statements.insertProgress.run(
          storyKey,
          story.type,
          story.targetId,
          story.ownerCharacterId,
          story.themeId,
          next,
          status,
          at,
          status === "mature" ? at : null,
          at,
        );
      }
      statements.insertFact.run(node.factId, storyKey, node.nodeId, story.targetId, at);
      statements.insertSource.run(node.factId, activityKey, narrator, at);
      statements.insertResult.run(
        activityKey,
        narrator,
        storyKey,
        nodeKey,
        "applied",
        node.factId,
        null,
        at,
      );
      return resultPublic(statements.getResult.get(activityKey), false);
    });
  }

  function getProgress(storyId) {
    const key = text(storyId, "storyId");
    return progressPublic(statements.getProgress.get(key));
  }

  return { selectNextStories, recordNode, getProgress };
}

module.exports = { createStoryProgress };
