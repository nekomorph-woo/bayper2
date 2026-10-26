/* S06j 故事回看只读展示。只读取已经记录的故事进度、事实、讲述者与来源，
   再从作者目录补全对应节点正文；不生成事实、不准备邀请、不改变邀请状态或额度。 */
const { AppError } = require("./errors.cjs");

function createStoryWindow({
  db,
  storyProgress,
  discoveryOutcomes,
  catalog,
  characterNames = {},
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "故事回看需要 SQLite 连接。");
  }
  if (!storyProgress || typeof storyProgress.listProgress !== "function") {
    throw new AppError("STORY_PROGRESS_REQUIRED", "故事回看需要故事进度入口。");
  }
  if (!discoveryOutcomes || typeof discoveryOutcomes.getInvitationByStory !== "function") {
    throw new AppError("DISCOVERY_REQUIRED", "故事回看需要发现结果入口。");
  }

  const stories = new Map(
    (Array.isArray(catalog?.stories) ? catalog.stories : []).map((story) => [
      story.storyId,
      story,
    ]),
  );
  const themeName = typeof catalog?.theme?.name === "string" ? catalog.theme.name : null;

  const statements = {
    countFacts: db.prepare(
      "SELECT COUNT(*) AS count FROM story_facts WHERE story_id = ?",
    ),
    facts: db.prepare(`
      SELECT * FROM story_facts
      WHERE story_id = ?
      ORDER BY learned_at ASC, rowid ASC
    `),
    sources: db.prepare(`
      SELECT s.activity_id, s.narrator_id, s.learned_at, a.kind
      FROM story_fact_sources s
      LEFT JOIN character_activities a ON a.activity_id = s.activity_id
      WHERE s.fact_id = ?
      ORDER BY s.learned_at ASC, s.rowid ASC
    `),
  };

  function nameOf(characterId) {
    return characterId ? characterNames[characterId] ?? characterId : null;
  }

  function bodyOf(storyId, nodeId) {
    const node = stories
      .get(storyId)
      ?.nodes?.find((item) => item.nodeId === nodeId);
    return typeof node?.body === "string" ? node.body : null;
  }

  function summary(progress) {
    return {
      storyId: progress.storyId,
      type: progress.type,
      targetId: progress.targetId,
      // 角色故事的目标可能是尚未结识的角色；衣装故事展示所属角色。
      targetName:
        progress.type === "character" ? nameOf(progress.targetId) : progress.targetId,
      ownerCharacterId: progress.ownerCharacterId,
      ownerName: nameOf(progress.ownerCharacterId),
      themeName: themeName ?? progress.themeId,
      status: progress.status,
      progressStatus: progress.progressStatus,
      available: progress.available,
      reason: progress.reason,
      startedAt: progress.startedAt,
      maturedAt: progress.maturedAt,
      factCount: Number(statements.countFacts.get(progress.storyId).count),
      invitation: discoveryOutcomes.getInvitationByStory({
        storyId: progress.storyId,
      }),
    };
  }

  /* 只有至少留下一条真实事实的故事才进入回看列表；作者目录本身不算经历。 */
  function listStories() {
    return storyProgress
      .listProgress()
      .filter((progress) => Number(statements.countFacts.get(progress.storyId).count) > 0)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(summary);
  }

  function getStory(storyId) {
    const progress = storyProgress.getProgress(storyId);
    if (!progress) {
      throw new AppError("STORY_NOT_FOUND", "这段故事还没有发生。");
    }
    const nodes = statements.facts.all(progress.storyId).map((fact) => ({
      nodeId: fact.node_id,
      body: bodyOf(progress.storyId, fact.node_id),
      learnedAt: Number(fact.learned_at),
      sources: statements.sources.all(fact.fact_id).map((source) => ({
        activityId: source.activity_id,
        kind: source.kind ?? null,
        narratorId: source.narrator_id,
        narratorName: nameOf(source.narrator_id),
        learnedAt: Number(source.learned_at),
      })),
    }));
    return { ...summary(progress), factCount: nodes.length, nodes };
  }

  return { listStories, getStory };
}

module.exports = { createStoryWindow };
