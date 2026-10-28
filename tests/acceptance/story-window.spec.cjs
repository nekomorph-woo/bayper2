/* S06j 故事回看与相遇邀请：真实 SQLite、正式 story-progress/discovery-outcomes。
   作者目录、活动与时间均为构造 fixture；不启动 GUI，不读用户数据。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createStore } = require("../../app/store.cjs");
const { createStoryWindow } = require("../../app/story-window.cjs");

const DAY = 24 * 60 * 60 * 1000;
const START = new Date(2026, 9, 27, 12, 0, 0).getTime();
const CHARACTER_NAMES = { a: "讲述者A", u1: "目标一", u2: "目标二", u3: "目标三" };

function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function story(storyId, targetId, nodeCount = 1, options = {}) {
  return {
    storyId,
    type: options.type ?? "character",
    targetId,
    ownerCharacterId: options.ownerCharacterId ?? null,
    themeId: "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      nodeId: `${storyId}-node-${index + 1}`,
      factId: `${storyId}-fact-${index + 1}`,
      body: `fixture ${storyId} node ${index + 1}`,
    })),
  };
}

function throwsCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function makeHarness(t, { stories }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-story-window-"));
  const clock = { ms: START };
  let catalog = { theme: { id: "fixture-theme", name: "测试主题" }, stories };
  let store = null;
  let window = null;
  let activitySeq = 0;

  function open() {
    store = createStore(dir, {
      storyCatalog: catalog,
      now: () => clock.ms,
    });
    store.acceptCharacter({
      characterId: "a",
      day: localDay(clock.ms),
      acceptedAt: new Date(clock.ms).toISOString(),
    });
    window = createStoryWindow({
      db: store.db,
      storyProgress: store.storyProgress,
      discoveryOutcomes: store.discoveryOutcomes,
      catalog,
      characterNames: CHARACTER_NAMES,
    });
  }

  function insertActivity(activityId, narratorId, at) {
    store.db
      .prepare(`
        INSERT INTO character_activities
          (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
           started_at, completed_at, action_completed_at, action_frame, created_at, updated_at)
        VALUES (?, ?, 'daily', 'completed', 10000, 10000, ?, ?, ?, 8, ?, ?)
      `)
      .run(activityId, narratorId, at, at, at, at, at);
  }

  const h = {
    clock,
    get store() {
      return store;
    },
    get window() {
      return window;
    },
    get discovery() {
      return store.discoveryOutcomes;
    },
    get storyProgress() {
      return store.storyProgress;
    },
    advance: (ms) => {
      clock.ms += ms;
    },
    record: (storyId, nodeId, narratorId = "a") => {
      const activityId = `act-${++activitySeq}`;
      insertActivity(activityId, narratorId, clock.ms);
      return store.storyProgress.recordNode({
        activityId,
        narratorId,
        storyId,
        nodeId,
      });
    },
    one: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    exec: (sql) => store.db.exec(sql),
    counts: () => {
      const count = (sql) => Number(store.db.prepare(sql).get().n);
      return {
        facts: count("SELECT COUNT(*) AS n FROM story_facts"),
        activities: count("SELECT COUNT(*) AS n FROM character_activities"),
        invitations: count("SELECT COUNT(*) AS n FROM discovery_invitations"),
        displayed: count(
          "SELECT COUNT(*) AS n FROM discovery_invitations WHERE displayed_at IS NOT NULL",
        ),
        quota: count(
          "SELECT COUNT(*) AS n FROM discovery_invitations WHERE quota_at IS NOT NULL",
        ),
      };
    },
    currentId: () =>
      store.getAppState("current_character_id"),
    roster: () => store.db.prepare("SELECT * FROM roster ORDER BY day, slot").all(),
    relationshipIds: () =>
      store.db
        .prepare("SELECT character_id FROM relationships ORDER BY character_id")
        .all()
        .map((row) => row.character_id),
    reopenWith: (nextStories) => {
      catalog = { theme: { id: "fixture-theme", name: "测试主题" }, stories: nextStories };
      store.close();
      open();
    },
  };

  open();
  t.after(() => {
    try {
      store?.close();
    } catch {
      // 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("POL-STORYUI-001 只显示已发生节点，查看不增加事实/活动/额度", (t) => {
  const h = makeHarness(t, {
    stories: [
      story("char-one", "u1", 2),
      story("outfit-one", "outfit-1", 1, { type: "outfit", ownerCharacterId: "a" }),
    ],
  });

  assert.deepEqual(h.window.listStories(), []);
  assert.equal(h.counts().facts, 0);
  assert.equal(h.counts().invitations, 0);

  assert.equal(h.record("char-one", "char-one-node-1").outcome, "applied");
  const before = h.counts();
  const list = h.window.listStories();
  const detail = h.window.getStory("char-one");
  assert.deepEqual(h.counts(), before, "读取列表/详情不得生成事实、活动或邀请");

  assert.equal(list.length, 1);
  assert.equal(list[0].storyId, "char-one");
  assert.equal(list[0].targetName, "目标一");
  assert.equal(list[0].themeName, "测试主题");
  assert.equal(list[0].factCount, 1);
  assert.equal(list[0].available, true);
  assert.equal(detail.factCount, 1);
  assert.equal(detail.nodes.length, 1);
  assert.equal(detail.nodes[0].nodeId, "char-one-node-1");
  assert.equal(detail.nodes[0].body, "fixture char-one node 1");
  assert.equal(detail.nodes[0].sources.length, 1);
  assert.equal(detail.nodes[0].sources[0].narratorId, "a");
  assert.equal(detail.nodes[0].sources[0].narratorName, "讲述者A");
  assert.equal(detail.nodes[0].sources[0].activityId, "act-1");
  assert.equal(detail.nodes[0].sources[0].kind, "daily");
  assert.equal(
    JSON.stringify(detail).includes("fixture char-one node 2"),
    false,
    "未发生的作者节点不能泄露",
  );
  assert.equal(
    JSON.stringify(detail).includes("outfit-one"),
    false,
    "未发生的目录故事不能出现在详情",
  );
  throwsCode(() => h.window.getStory("char-missing"), "STORY_NOT_FOUND");
});

test("POL-STORYUI-002 manual 首次展示不受自动额度阻止，自动ACK不补扣", (t) => {
  const h = makeHarness(t, {
    stories: [story("char-one", "u1"), story("char-two", "u2"), story("char-three", "u3")],
  });
  h.record("char-one", "char-one-node-1");
  h.advance(DAY);
  h.record("char-two", "char-two-node-1");
  h.advance(DAY);
  h.record("char-three", "char-three-node-1");

  const first = h.discovery.prepareInvitation({ storyId: "char-one" });
  const firstShown = h.discovery.acknowledgeInvitation({
    invitationId: first.invitation.invitationId,
  });
  assert.equal(firstShown.invitation.quotaAt, h.clock.ms);
  assert.equal(h.counts().quota, 1);
  h.discovery.rejectInvitation({ invitationId: first.invitation.invitationId });

  const manual = h.discovery.prepareInvitation({
    storyId: "char-two",
    source: "manual",
  });
  assert.equal(manual.prepared, true, "自动额度满时主动查看仍应可达");
  assert.equal(manual.invitation.quotaAt, null);
  assert.equal(h.counts().quota, 1);
  const beforeRead = h.counts();
  assert.equal(h.window.getStory("char-two").invitation.displayedAt, null);
  assert.equal(h.window.listStories().length, 3);
  assert.deepEqual(h.counts(), beforeRead, "读列表/详情不得自动确认展示");

  const shown = h.discovery.acknowledgeInvitation({
    invitationId: manual.invitation.invitationId,
    source: "manual",
  });
  assert.equal(shown.acknowledged, true);
  assert.equal(shown.invitation.status, "pending");
  assert.equal(shown.invitation.displayedAt, h.clock.ms);
  assert.equal(shown.invitation.quotaAt, null);
  assert.equal(h.counts().quota, 1);

  const lateAutomatic = h.discovery.acknowledgeInvitation({
    invitationId: manual.invitation.invitationId,
  });
  assert.equal(lateAutomatic.duplicate, true);
  assert.equal(lateAutomatic.invitation.displayedAt, shown.invitation.displayedAt);
  assert.equal(lateAutomatic.invitation.quotaAt, null, "手动已展示不得补记自动额度");
  assert.equal(h.counts().quota, 1);

  h.discovery.rejectInvitation({ invitationId: manual.invitation.invitationId });
  const blocked = h.discovery.prepareInvitation({ storyId: "char-three" });
  assert.equal(blocked.prepared, false);
  assert.equal(blocked.reason, "INVITATION_QUOTA");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-three'").n,
    0,
  );

  const manualThree = h.discovery.prepareInvitation({
    storyId: "char-three",
    source: "manual",
  });
  assert.equal(manualThree.prepared, true);
  h.discovery.acknowledgeInvitation({
    invitationId: manualThree.invitation.invitationId,
    source: "manual",
  });
  assert.equal(h.counts().quota, 1);
  assert.equal(
    h.discovery.getInvitationByStory({ storyId: "char-three" }).quotaAt,
    null,
  );
  throwsCode(
    () => h.discovery.prepareInvitation({ storyId: "char-three", source: "renderer" }),
    "INVALID_INPUT",
  );
});

test("POL-STORYUI-003 稍后、重启、重开保持同一邀请身份且不催促", (t) => {
  const h = makeHarness(t, { stories: [story("char-one", "u1")] });
  h.record("char-one", "char-one-node-1");
  const prepared = h.discovery.prepareInvitation({
    storyId: "char-one",
    source: "manual",
  });
  const invitationId = prepared.invitation.invitationId;
  const shown = h.discovery.acknowledgeInvitation({
    invitationId,
    source: "manual",
  });
  const currentBefore = h.currentId();
  const rosterBefore = h.roster();

  assert.equal(h.discovery.deferInvitation({ invitationId }).invitation.status, "later");
  h.advance(DAY);
  const later = h.discovery.getInvitation({ invitationId });
  assert.equal(later.status, "later");
  assert.equal(later.displayedAt, shown.invitation.displayedAt);
  assert.equal(later.quotaAt, null);
  assert.equal(h.counts().invitations, 1);
  assert.equal(h.counts().facts, 1, "稍后与回看不得推进故事或生成提醒");

  h.reopenWith([story("char-one", "u1")]);
  const reopened = h.discovery.reopenInvitation({ invitationId });
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.invitation.invitationId, invitationId);
  assert.equal(reopened.invitation.status, "pending");
  assert.equal(reopened.invitation.displayedAt, shown.invitation.displayedAt);
  assert.equal(reopened.invitation.quotaAt, null);
  assert.equal(reopened.invitation.reopenedAt, h.clock.ms);
  assert.equal(h.counts().invitations, 1);

  assert.equal(h.discovery.rejectInvitation({ invitationId }).invitation.status, "rejected");
  h.advance(DAY);
  const replayed = h.discovery.reopenInvitation({ invitationId });
  assert.equal(replayed.invitation.invitationId, invitationId);
  assert.equal(replayed.invitation.status, "pending");
  assert.equal(replayed.invitation.displayedAt, shown.invitation.displayedAt);
  assert.equal(h.currentId(), currentBefore, "重开邀请不得切换当前角色");
  assert.deepEqual(h.roster(), rosterBefore, "重开邀请不得改名单");
});

test("POL-STORYUI-004 素材下架保留故事与邀请身份，且不能接纳", (t) => {
  const available = story("char-one", "u1");
  const h = makeHarness(t, { stories: [available, story("char-two", "u2")] });
  h.record("char-one", "char-one-node-1");
  const prepared = h.discovery.prepareInvitation({
    storyId: "char-one",
    source: "manual",
  });
  const shown = h.discovery.acknowledgeInvitation({
    invitationId: prepared.invitation.invitationId,
    source: "manual",
  });
  h.advance(DAY);
  h.record("char-two", "char-two-node-1");
  const before = h.counts();

  h.reopenWith([
    { ...available, assetAvailable: false },
    { ...story("char-two", "u2"), assetAvailable: false },
  ]);
  const detail = h.window.getStory("char-one");
  assert.equal(detail.available, false);
  assert.equal(detail.reason, "ASSET_UNAVAILABLE");
  assert.equal(detail.nodes.length, 1, "素材下架不丢已经发生的故事");
  assert.equal(detail.invitation.invitationId, shown.invitation.invitationId);
  assert.equal(detail.invitation.status, "pending");
  assert.equal(detail.invitation.displayedAt, shown.invitation.displayedAt);
  assert.equal(detail.invitation.quotaAt, null);
  throwsCode(
    () => h.discovery.acceptInvitation({ invitationId: detail.invitation.invitationId }),
    "INVITATION_SOURCE_UNAVAILABLE",
  );
  assert.deepEqual(h.relationshipIds(), ["a"]);
  assert.deepEqual(h.counts(), {
    ...before,
    displayed: before.displayed,
  });

  h.advance(DAY);
  const manualUnavailable = h.discovery.prepareInvitation({
    storyId: "char-two",
    source: "manual",
  });
  assert.equal(manualUnavailable.prepared, false);
  assert.equal(manualUnavailable.reason, "ASSET_UNAVAILABLE");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-two'").n,
    0,
  );

  h.reopenWith([available, story("char-two", "u2")]);
  assert.equal(
    h.discovery.acceptInvitation({ invitationId: shown.invitation.invitationId }).accepted,
    true,
  );
  assert.deepEqual(h.relationshipIds(), ["a", "u1"]);
});

test("POL-STORYUI-005 接纳写失败回滚、重复操作只有一个关系与初始数值", (t) => {
  const h = makeHarness(t, { stories: [story("char-one", "u1")] });
  h.record("char-one", "char-one-node-1");
  const prepared = h.discovery.prepareInvitation({
    storyId: "char-one",
    source: "manual",
  });
  h.discovery.acknowledgeInvitation({
    invitationId: prepared.invitation.invitationId,
    source: "manual",
  });
  const currentBefore = h.currentId();
  const rosterBefore = h.roster();
  h.exec(`
    CREATE TRIGGER fail_accept
    BEFORE INSERT ON character_stats
    BEGIN SELECT RAISE(ABORT, 'forced accept failure'); END
  `);
  assert.throws(
    () =>
      h.discovery.acceptInvitation({
        invitationId: prepared.invitation.invitationId,
      }),
    /forced accept failure/,
  );
  assert.deepEqual(h.relationshipIds(), ["a"], "事务失败不得留下半个关系");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_stats WHERE character_id = 'u1'").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_runtime WHERE character_id = 'u1'").n, 0);
  assert.equal(
    h.discovery.getInvitation({ invitationId: prepared.invitation.invitationId }).status,
    "pending",
  );
  h.exec("DROP TRIGGER fail_accept");

  const accepted = h.discovery.acceptInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.alreadyAccepted, false);
  assert.deepEqual(
    { ...h.one("SELECT intimacy, energy, mood FROM character_stats WHERE character_id = 'u1'") },
    { intimacy: 10, energy: 100, mood: 0 },
  );
  const duplicate = h.discovery.acceptInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u1'").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_stats WHERE character_id = 'u1'").n, 1);
  assert.equal(h.currentId(), currentBefore, "接纳不得偷偷切换当前角色");
  assert.deepEqual(h.roster(), rosterBefore, "接纳不得改固定位或今日名单");
});

test("POL-OUTFITRUN-004 列表/详情只读展示服装归属，读取不解锁不确认", (t) => {
  const h = makeHarness(t, {
    stories: [
      story("char-read", "u1"),
      story("outfit-read", "outfit-read-1", 1, { type: "outfit", ownerCharacterId: "a" }),
    ],
  });
  h.record("char-read", "char-read-node-1");
  h.advance(DAY);
  h.record("outfit-read", "outfit-read-node-1");

  // 未解锁时服装故事返回 null；读取不会触发解锁。
  const before = h.counts();
  const unowned = h.window.listStories().find((item) => item.storyId === "outfit-read");
  assert.equal(unowned.outfitOwnership, null);
  assert.equal(h.window.getStory("outfit-read").outfitOwnership, null);
  assert.equal(
    h.window.listStories().find((item) => item.storyId === "char-read").outfitOwnership,
    null,
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.deepEqual(h.counts(), before);

  const unlocked = h.discovery.unlockNextOutfit();
  assert.equal(unlocked.unlocked, true);
  const ownershipRow = h.one(
    "SELECT * FROM discovery_outfit_ownership WHERE story_id = 'outfit-read'",
  );
  const afterUnlock = h.counts();

  // 已解锁后无需重启即可查询；角色故事仍为 null。
  const listed = h.window.listStories().find((item) => item.storyId === "outfit-read");
  assert.deepEqual(listed.outfitOwnership, {
    storyId: "outfit-read",
    outfitId: "outfit-read-1",
    ownerCharacterId: "a",
    sourceActivityId: "act-2",
    unlockedAt: unlocked.outfit.unlockedAt,
    notificationPending: true,
    notificationShownAt: null,
  });
  assert.deepEqual(h.window.getStory("outfit-read").outfitOwnership, listed.outfitOwnership);
  assert.equal(
    h.window.listStories().find((item) => item.storyId === "char-read").outfitOwnership,
    null,
  );
  // 读取不 ACK、不改展示时间或额度，也不产生新事实/活动/邀请。
  assert.deepEqual(h.counts(), afterUnlock);
  assert.deepEqual(
    h.one("SELECT * FROM discovery_outfit_ownership WHERE story_id = 'outfit-read'"),
    ownershipRow,
  );
});
