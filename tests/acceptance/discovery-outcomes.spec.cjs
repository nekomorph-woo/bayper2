/* S06f 正式验收：真实 SQLite、正式活动与 story-progress 成熟结果。
   覆盖 POL-DISCOVERY-001～005；作者目录、时间和内容均为构造 fixture。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createStore } = require("../../app/store.cjs");
const { createCompanionStore } = require("../../app/companion-store.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");
const { createStoryProgress } = require("../../app/story-progress.cjs");
const { createDiscoveryOutcomes } = require("../../app/discovery-outcomes.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const CANDIDATES = ["a", "b", "c"].map((id) => ({
  id,
  name: `角色${id}`,
  tagline: "",
  intro: "",
  traits: [],
}));

function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function throwsCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function fixtureStory(storyId, type, targetId, factIds, options = {}) {
  return {
    storyId,
    type,
    targetId,
    ownerCharacterId: options.ownerCharacterId ?? null,
    themeId: options.themeId ?? "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: factIds.map((factId, index) => ({
      nodeId: `${storyId}-node-${index + 1}`,
      factId,
      body: `fixture ${storyId} node ${index + 1}`,
    })),
  };
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-discovery-"));
  const dbPath = path.join(dir, "bayper.sqlite3");
  const ids = options.ids ?? ["a", "b", "c"];
  const rosterIds = options.rosterIds ?? ["a", "b"];
  const clock = { ms: options.start ?? START };
  let currentStories = options.stories ?? [];
  let db;
  let store;
  let service;
  let storyProgress;
  let discovery;
  let seeded = false;

  createStore(dir).close();

  function open() {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const base = createCompanionStore(db);
    const getState = db.prepare("SELECT value FROM app_state WHERE key = ?");
    const saveState = db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    store = {
      ...base,
      getAppState: (key) => getState.get(key)?.value ?? null,
      setAppState: (key, value) => saveState.run(key, String(value)),
    };
    if (!seeded) {
      seed();
      seeded = true;
    }
    service = createCompanionshipService({
      store,
      candidates: CANDIDATES,
      now: () => new Date(clock.ms),
      random: () => 0.5,
    });
    storyProgress = createStoryProgress({
      db,
      catalog: { version: "fixture-1", stories: currentStories },
      now: () => new Date(clock.ms),
    });
    discovery = createDiscoveryOutcomes({
      db,
      storyProgress,
      now: () => new Date(clock.ms),
    });
  }

  function seed() {
    for (const characterId of ids) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        characterId,
        new Date(clock.ms).toISOString(),
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(characterId, options.energy?.[characterId] ?? 100);
      db.prepare(`
        INSERT INTO character_runtime
          (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, 0)
      `).run(characterId, characterId === "a" ? "companion" : "waiting", clock.ms);
    }
    const set = (key, value) =>
      db.prepare(`
        INSERT INTO app_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    set("fixed_character_id", "a");
    set("current_character_id", "a");
    set("current_mode", "companion");
    set("pending_rotation", "0");
    set("last_active_at", clock.ms);
    rosterIds.forEach((characterId, index) => {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(clock.ms),
        SLOTS[index],
        characterId,
      );
    });
  }

  const h = {
    dir,
    dbPath,
    clock,
    ids,
    get db() {
      return db;
    },
    get service() {
      return service;
    },
    get story() {
      return storyProgress;
    },
    get discovery() {
      return discovery;
    },
    advance: (ms) => {
      clock.ms += ms;
    },
    setClock: (ms) => {
      clock.ms = ms;
    },
    currentId: () =>
      db.prepare("SELECT value FROM app_state WHERE key = 'current_character_id'").get()
        .value,
    useCatalog: (stories) => {
      currentStories = stories;
      storyProgress = createStoryProgress({
        db,
        catalog: { version: "fixture-2", stories },
        now: () => new Date(clock.ms),
      });
      discovery = createDiscoveryOutcomes({
        db,
        storyProgress,
        now: () => new Date(clock.ms),
      });
    },
    reopen: () => {
      db.close();
      open();
    },
    reopenWith: (stories) => {
      currentStories = stories;
      db.close();
      open();
    },
    one: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    exec: (sql) => db.exec(sql),
    activity: (id) =>
      db.prepare("SELECT * FROM character_activities WHERE activity_id = ?").get(id),
    completeDaily: (activityId, characterId = "a") => {
      if (h.currentId() !== characterId) {
        service.switchTo(characterId);
      }
      const requested = service.requestActivity({
        activityId,
        characterId,
        kind: "daily",
      });
      assert.equal(requested.requested, true, JSON.stringify(requested));
      assert.equal(service.completeNaturalNode().started, true);
      // S06h 起日常必须由真实动作完成与自然节点收束，不能只推进计时。
      assert.equal(
        service.completeDailyAction(activityId, { characterId }).completed,
        true,
      );
      clock.ms += 10 * 1000;
      assert.equal(service.completeNaturalNode().completedDaily, 1);
      const activity = h.activity(activityId);
      assert.equal(activity.status, "completed");
      return activity;
    },
    nextDayForA: () => {
      if (h.currentId() !== "b") {
        service.switchTo("b");
      }
      clock.ms += DAY;
      service.switchTo("a");
    },
    record: (activityId, storyId, nodeId, narratorId = "a") =>
      storyProgress.recordNode({
        activityId,
        narratorId,
        storyId,
        nodeId,
      }),
    deleteRelationship: (characterId) => {
      for (const table of [
        "roster",
        "character_stats",
        "character_runtime",
        "relationship_mood_state",
        "relationship_daily",
        "relationship_events",
        "memory_entries",
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE character_id = ?`).run(characterId);
      }
      db.prepare("DELETE FROM relationships WHERE character_id = ?").run(characterId);
    },
  };

  open();
  t.after(() => {
    try {
      db?.close();
    } catch {
      // 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("POL-DISCOVERY-001 成熟邀请延迟展示、7日额度与第二故事阻塞", (t) => {
  const storyOne = fixtureStory("char-one", "character", "u1", ["fact-c1-1", "fact-c1-2"]);
  const storyTwo = fixtureStory("char-two", "character", "u2", ["fact-c2-1"]);
  const storyThree = fixtureStory("char-three", "character", "u3", ["fact-c3-1"]);
  const outfitOpen = fixtureStory("outfit-open", "outfit", "outfit-open-1", ["fact-open-1"], {
    ownerCharacterId: "a",
  });
  const h = makeHarness(t, {
    stories: [storyOne, storyTwo, storyThree, outfitOpen],
  });

  h.completeDaily("c1-a1");
  assert.equal(h.record("c1-a1", "char-one", "char-one-node-1").outcome, "applied");
  h.nextDayForA();
  h.completeDaily("c1-a2");
  assert.equal(h.record("c1-a2", "char-one", "char-one-node-2").outcome, "applied");
  h.nextDayForA();
  h.completeDaily("c2-a1");
  assert.equal(h.record("c2-a1", "char-two", "char-two-node-1").outcome, "applied");
  assert.equal(h.story.getProgress("char-one").status, "mature");
  assert.equal(h.story.getProgress("char-two").status, "mature");

  const prepared = h.discovery.prepareInvitation({ storyId: "char-one" });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.duplicate, false);
  assert.equal(prepared.invitation.status, "prepared");
  assert.equal(prepared.invitation.quotaAt, null);
  assert.equal(prepared.invitation.sourceActivityId, "c1-a2");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 1);
  assert.equal(
    h.discovery.getPendingInvitation().invitationId,
    prepared.invitation.invitationId,
  );
  assert.equal(
    h.discovery.getInvitation({ invitationId: prepared.invitation.invitationId }).status,
    "prepared",
  );
  const blockedByPending = h.discovery.prepareInvitation({ storyId: "char-two" });
  assert.equal(blockedByPending.prepared, false);
  assert.equal(blockedByPending.reason, "INVITATION_ACTIVE");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 1);

  h.advance(2 * HOUR);
  const displayed = h.discovery.acknowledgeInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.equal(displayed.acknowledged, true);
  assert.equal(displayed.invitation.status, "pending");
  assert.equal(displayed.invitation.quotaAt, h.clock.ms);
  const pendingFilters = h.discovery.getStorySelectionFilters();
  assert.deepEqual(pendingFilters, {
    pendingInvitationTargetId: "u1",
    rejectedTargetIds: [],
  });
  assert.deepEqual(
    h.story.selectNextStories(pendingFilters).map((item) => item.storyId),
    ["outfit-open"],
    "待邀请阻止新角色故事但不阻塞服装故事",
  );
  assert.equal(
    h.discovery.prepareInvitation({ storyId: "char-two" }).reason,
    "INVITATION_ACTIVE",
  );

  h.reopen();
  const reopenedAck = h.discovery.acknowledgeInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.equal(reopenedAck.duplicate, true);
  assert.equal(reopenedAck.invitation.quotaAt, displayed.invitation.quotaAt);
  throwsCode(
    () => h.discovery.acknowledgeInvitation({ invitationId: "invite:missing" }),
    "INVITATION_NOT_FOUND",
  );

  h.discovery.rejectInvitation({ invitationId: prepared.invitation.invitationId });
  throwsCode(
    () =>
      h.discovery.acknowledgeInvitation({
        invitationId: prepared.invitation.invitationId,
      }),
    "INVITATION_NOT_DISPLAYABLE",
  );
  h.setClock(displayed.invitation.quotaAt - HOUR);
  const blockedByQuota = h.discovery.prepareInvitation({ storyId: "char-two" });
  assert.equal(blockedByQuota.prepared, false);
  assert.equal(blockedByQuota.reason, "INVITATION_QUOTA");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-two'").n,
    0,
  );
  assert.equal(h.story.getProgress("char-two").status, "mature");
  assert.equal(h.discovery.getPendingInvitation(), null);
  assert.deepEqual(h.discovery.getStorySelectionFilters(), {
    pendingInvitationTargetId: null,
    rejectedTargetIds: ["u1"],
  });
});

test("POL-DISCOVERY-002 稍后、拒绝、手动重开与接纳不改变既有陪伴", (t) => {
  const story = fixtureStory("char-decision", "character", "u3", ["fact-d1"]);
  const h = makeHarness(t, { stories: [story] });
  h.completeDaily("decision-a1");
  assert.equal(h.record("decision-a1", "char-decision", "char-decision-node-1").outcome, "applied");
  const prepared = h.discovery.prepareInvitation({ storyId: "char-decision" });
  const invitationId = prepared.invitation.invitationId;
  const displayed = h.discovery.acknowledgeInvitation({ invitationId });

  h.service.setNickname("a", "old-a");
  h.exec(`
    INSERT INTO memory_entries
      (id, character_id, fact_key, origin_character_id, derived_from_entry_id,
       kind, body, trust, importance, expires_at, source_id, source_version,
       version, created_at, updated_at)
    VALUES ('mem-fixture', 'a', 'fixture-key', 'a', NULL,
            'detail', 'fixture memory', 'stated', 20, NULL, 'fixture',
            1, 1, ${START}, ${START})
  `);

  const deferred = h.discovery.deferInvitation({ invitationId });
  assert.equal(deferred.invitation.status, "later");
  const laterAt = h.clock.ms;
  h.advance(DAY);
  const later = h.one("SELECT * FROM discovery_invitations WHERE invitation_id = ?", invitationId);
  assert.equal(later.status, "later");
  assert.equal(later.displayed_at, displayed.invitation.displayedAt);
  assert.equal(later.quota_at, displayed.invitation.quotaAt);
  assert.equal(later.updated_at, laterAt);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 1);

  const rejected = h.discovery.rejectInvitation({ invitationId });
  assert.equal(rejected.invitation.status, "rejected");
  assert.equal(h.story.getProgress("char-decision").status, "mature");
  assert.deepEqual(h.discovery.getStorySelectionFilters(), {
    pendingInvitationTargetId: null,
    rejectedTargetIds: ["u3"],
  });
  assert.equal(
    h.discovery.prepareInvitation({ storyId: "char-decision" }).reason,
    "INVITATION_REJECTED",
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 1);

  h.advance(HOUR);
  const reopened = h.discovery.reopenInvitation({ invitationId });
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.invitation.status, "pending");
  assert.equal(reopened.invitation.displayedAt, displayed.invitation.displayedAt);
  assert.equal(reopened.invitation.quotaAt, displayed.invitation.quotaAt);
  assert.equal(reopened.invitation.reopenedAt, h.clock.ms);
  assert.equal(reopened.invitation.quotaAt, displayed.invitation.quotaAt);

  const before = {
    roster: h.all("SELECT * FROM roster ORDER BY day, slot"),
    state: h.all("SELECT * FROM app_state ORDER BY key"),
    interactions: h.all("SELECT * FROM interactions"),
    model: h.all("SELECT * FROM model_config"),
    memories: h.all("SELECT * FROM memory_entries ORDER BY id"),
    relationships: h.all(
      "SELECT * FROM relationships WHERE character_id IN ('a', 'b') ORDER BY character_id",
    ),
    stats: h.all(
      "SELECT * FROM character_stats WHERE character_id IN ('a', 'b') ORDER BY character_id",
    ),
    runtime: h.all(
      "SELECT * FROM character_runtime WHERE character_id IN ('a', 'b') ORDER BY character_id",
    ),
  };
  const accepted = h.discovery.acceptInvitation({ invitationId });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.alreadyAccepted, false);
  assert.equal(accepted.invitation.status, "accepted");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships").n, 4);
  assert.deepEqual(
    { ...h.one("SELECT intimacy, energy, mood FROM character_stats WHERE character_id = 'u3'") },
    { intimacy: 10, energy: 100, mood: 0 },
  );
  assert.deepEqual(
    { ...h.one("SELECT mode, exploring FROM character_runtime WHERE character_id = 'u3'") },
    { mode: "waiting", exploring: 0 },
  );
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM roster WHERE character_id = 'u3'").n,
    0,
  );
  assert.equal(h.currentId(), "a");
  assert.deepEqual(
    h.all("SELECT * FROM roster ORDER BY day, slot"),
    before.roster,
  );
  assert.deepEqual(h.all("SELECT * FROM app_state ORDER BY key"), before.state);
  assert.deepEqual(h.all("SELECT * FROM interactions"), before.interactions);
  assert.deepEqual(h.all("SELECT * FROM model_config"), before.model);
  assert.deepEqual(h.all("SELECT * FROM memory_entries ORDER BY id"), before.memories);
  assert.deepEqual(
    h.all("SELECT * FROM relationships WHERE character_id IN ('a', 'b') ORDER BY character_id"),
    before.relationships,
  );
  assert.deepEqual(
    h.all("SELECT * FROM character_stats WHERE character_id IN ('a', 'b') ORDER BY character_id"),
    before.stats,
  );
  assert.deepEqual(
    h.all("SELECT * FROM character_runtime WHERE character_id IN ('a', 'b') ORDER BY character_id"),
    before.runtime,
  );
  assert.equal(h.story.getProgress("char-decision").status, "mature");

  const duplicate = h.discovery.acceptInvitation({ invitationId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u3'").n, 1);
  assert.deepEqual(
    { ...h.one("SELECT intimacy, energy, mood FROM character_stats WHERE character_id = 'u3'") },
    { intimacy: 10, energy: 100, mood: 0 },
  );
  assert.deepEqual(h.discovery.getStorySelectionFilters(), {
    pendingInvitationTargetId: null,
    rejectedTargetIds: [],
  });
});

test("POL-DISCOVERY-003 衣装素材、72小时额度与独立所有权", (t) => {
  const stories = [
    fixtureStory("outfit-one", "outfit", "outfit-1", ["fact-o1"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("outfit-two", "outfit", "outfit-2", ["fact-o2"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("outfit-three", "outfit", "outfit-3", ["fact-o3"], {
      ownerCharacterId: "c",
    }),
  ];
  const h = makeHarness(t, { stories });
  h.completeDaily("outfit-a1");
  assert.equal(h.record("outfit-a1", "outfit-one", "outfit-one-node-1").outcome, "applied");
  h.nextDayForA();
  h.completeDaily("outfit-a2");
  assert.equal(h.record("outfit-a2", "outfit-two", "outfit-two-node-1").outcome, "applied");
  h.nextDayForA();
  h.completeDaily("outfit-a3");
  assert.equal(h.record("outfit-a3", "outfit-three", "outfit-three-node-1").outcome, "applied");
  assert.equal(h.story.getProgress("outfit-one").progressStatus, "mature");
  assert.equal(h.story.getProgress("outfit-two").progressStatus, "mature");
  assert.equal(h.story.getProgress("outfit-three").progressStatus, "mature");
  const stateBefore = h.all("SELECT * FROM app_state ORDER BY key");

  h.useCatalog(stories.map((story) => ({ ...story, assetAvailable: false })));
  assert.equal(h.story.getProgress("outfit-one").status, "unavailable");
  assert.equal(h.story.getProgress("outfit-one").reason, "ASSET_UNAVAILABLE");
  assert.equal(h.story.getProgress("outfit-one").nextNodeIndex, 1);
  let result = h.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, false);
  assert.equal(result.reason, "OUTFIT_UNAVAILABLE");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  h.useCatalog(stories);

  h.deleteRelationship("c");
  result = h.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, true);
  assert.equal(result.outfit.storyId, "outfit-one");
  assert.equal(result.outfit.ownerCharacterId, "a");
  assert.equal(result.outfit.notificationPending, true);
  assert.equal(result.outfit.sourceActivityId, "outfit-a1");
  assert.equal(
    h.discovery.getOutfitOwnership({ storyId: "outfit-one" }).notificationPending,
    true,
  );
  const firstUnlockedAt = result.outfit.unlockedAt;
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership WHERE story_id = 'outfit-two'").n,
    0,
  );
  h.reopen();
  assert.equal(
    h.one("SELECT notification_pending FROM discovery_outfit_ownership WHERE story_id = 'outfit-one'")
      .notification_pending,
    1,
  );
  const ack = h.discovery.acknowledgeOutfitNotice({ storyId: "outfit-one" });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.duplicate, false);
  assert.equal(ack.outfit.notificationPending, false);
  assert.equal(ack.outfit.notificationShownAt, h.clock.ms);
  const ackAgain = h.discovery.acknowledgeOutfitNotice({ storyId: "outfit-one" });
  assert.equal(ackAgain.duplicate, true);
  assert.equal(ackAgain.outfit.notificationShownAt, ack.outfit.notificationShownAt);
  assert.equal(
    h.discovery.getOutfitOwnership({ storyId: "outfit-one" }).notificationPending,
    false,
  );

  assert.equal(
    h.discovery.unlockNextOutfit().reason,
    "OUTFIT_QUOTA",
  );
  h.setClock(firstUnlockedAt - HOUR);
  assert.equal(h.discovery.unlockNextOutfit().reason, "OUTFIT_QUOTA");
  h.setClock(firstUnlockedAt + 71 * HOUR);
  assert.equal(h.discovery.unlockNextOutfit().reason, "OUTFIT_QUOTA");
  h.setClock(firstUnlockedAt + 72 * HOUR);
  result = h.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, true);
  assert.equal(result.outfit.storyId, "outfit-two");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n,
    2,
  );
  h.discovery.acknowledgeOutfitNotice({ storyId: "outfit-two" });
  h.setClock(firstUnlockedAt + 144 * HOUR);
  result = h.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, false);
  assert.equal(result.reason, "NO_ELIGIBLE_OUTFIT");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership WHERE owner_character_id = 'c'").n,
    0,
  );
  assert.deepEqual(h.all("SELECT * FROM app_state ORDER BY key"), stateBefore);
});

test("POL-DISCOVERY-004 目录身份冲突或资源下架不错误接纳或解锁", (t) => {
  const characterStory = fixtureStory("char-conflict", "character", "u4", ["fact-x1"]);
  const h = makeHarness(t, { stories: [characterStory] });
  h.completeDaily("conflict-a1");
  assert.equal(h.record("conflict-a1", "char-conflict", "char-conflict-node-1").outcome, "applied");
  const prepared = h.discovery.prepareInvitation({ storyId: "char-conflict" });
  const invitationId = prepared.invitation.invitationId;
  const duplicatePrepare = h.discovery.prepareInvitation({ storyId: "char-conflict" });
  assert.equal(duplicatePrepare.duplicate, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 1);
  const displayed = h.discovery.acknowledgeInvitation({ invitationId });
  assert.equal(h.discovery.acknowledgeInvitation({ invitationId }).duplicate, true);
  assert.equal(
    h.discovery.acknowledgeInvitation({ invitationId }).invitation.quotaAt,
    displayed.invitation.quotaAt,
  );

  h.reopenWith([{ ...characterStory, targetId: "u5" }]);
  assert.equal(h.story.getProgress("char-conflict").status, "unavailable");
  assert.equal(h.story.getProgress("char-conflict").reason, "STORY_IDENTITY_CONFLICT");
  throwsCode(
    () => h.discovery.acceptInvitation({ invitationId }),
    "INVITATION_SOURCE_UNAVAILABLE",
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id IN ('u4', 'u5')").n, 0);
  assert.equal(
    h.one("SELECT status FROM discovery_invitations WHERE invitation_id = ?", invitationId).status,
    "pending",
  );
  h.useCatalog([characterStory]);
  assert.equal(h.discovery.acceptInvitation({ invitationId }).accepted, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u4'").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u5'").n, 0);

  const outfitStory = fixtureStory("outfit-conflict", "outfit", "outfit-x", ["fact-x2"], {
    ownerCharacterId: "a",
  });
  const outfit = makeHarness(t, { stories: [outfitStory] });
  outfit.completeDaily("outfit-x1");
  assert.equal(outfit.record("outfit-x1", "outfit-conflict", "outfit-conflict-node-1").outcome, "applied");
  outfit.reopenWith([{ ...outfitStory, assetAvailable: false }]);
  let result = outfit.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, false);
  assert.equal(result.reason, "OUTFIT_UNAVAILABLE");
  assert.equal(outfit.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.equal(outfit.story.getProgress("outfit-conflict").nextNodeIndex, 1);
  outfit.reopenWith([{ ...outfitStory, ownerCharacterId: "b" }]);
  result = outfit.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, false);
  assert.equal(result.reason, "OUTFIT_UNAVAILABLE");
  assert.equal(outfit.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  outfit.reopenWith([outfitStory]);
  result = outfit.discovery.unlockNextOutfit();
  assert.equal(result.unlocked, true);
  assert.equal(result.outfit.storyId, "outfit-conflict");
  const ack = outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-conflict" });
  assert.equal(ack.duplicate, false);
  outfit.reopen();
  const reopenedAck = outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-conflict" });
  assert.equal(reopenedAck.duplicate, true);
  assert.equal(reopenedAck.outfit.notificationShownAt, ack.outfit.notificationShownAt);
  assert.equal(outfit.discovery.unlockNextOutfit().reason, "OUTFIT_QUOTA");
});

test("POL-DISCOVERY-005 故障回滚、dispose、既有角色与内容耗尽", (t) => {
  const faultStory = fixtureStory("char-fault", "character", "u6", ["fact-f1"]);
  const fault = makeHarness(t, { stories: [faultStory] });
  fault.completeDaily("fault-a1");
  assert.equal(fault.record("fault-a1", "char-fault", "char-fault-node-1").outcome, "applied");
  const prepared = fault.discovery.prepareInvitation({ storyId: "char-fault" });
  fault.discovery.acknowledgeInvitation({ invitationId: prepared.invitation.invitationId });
  fault.exec(`
    CREATE TRIGGER fail_accept
    BEFORE UPDATE ON discovery_invitations
    BEGIN SELECT RAISE(ABORT, 'forced accept failure'); END
  `);
  assert.throws(
    () =>
      fault.discovery.acceptInvitation({
        invitationId: prepared.invitation.invitationId,
      }),
    /forced accept failure/,
  );
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u6'").n, 0);
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM character_stats WHERE character_id = 'u6'").n, 0);
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM character_runtime WHERE character_id = 'u6'").n, 0);
  assert.equal(
    fault.one("SELECT status FROM discovery_invitations WHERE invitation_id = ?", prepared.invitation.invitationId).status,
    "pending",
  );
  fault.exec("DROP TRIGGER fail_accept");
  const retried = fault.discovery.acceptInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.equal(retried.accepted, true);
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u6'").n, 1);
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM character_stats WHERE character_id = 'u6'").n, 1);
  assert.equal(fault.one("SELECT COUNT(*) AS n FROM character_runtime WHERE character_id = 'u6'").n, 1);

  const outfitStory = fixtureStory("outfit-fault", "outfit", "outfit-f", ["fact-f2"], {
    ownerCharacterId: "a",
  });
  const outfit = makeHarness(t, { stories: [outfitStory] });
  outfit.completeDaily("outfit-f1");
  assert.equal(outfit.record("outfit-f1", "outfit-fault", "outfit-fault-node-1").outcome, "applied");
  outfit.exec(`
    CREATE TRIGGER fail_ownership
    BEFORE INSERT ON discovery_outfit_ownership
    BEGIN SELECT RAISE(ABORT, 'forced ownership failure'); END
  `);
  assert.throws(() => outfit.discovery.unlockNextOutfit(), /forced ownership failure/);
  assert.equal(outfit.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  outfit.exec("DROP TRIGGER fail_ownership");
  assert.equal(outfit.discovery.unlockNextOutfit().unlocked, true);
  outfit.exec(`
    CREATE TRIGGER fail_notice
    BEFORE UPDATE ON discovery_outfit_ownership
    BEGIN SELECT RAISE(ABORT, 'forced notice failure'); END
  `);
  assert.throws(
    () => outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-fault" }),
    /forced notice failure/,
  );
  assert.equal(
    outfit.one("SELECT notification_pending, notification_shown_at FROM discovery_outfit_ownership")
      .notification_pending,
    1,
  );
  assert.equal(
    outfit.one("SELECT notification_shown_at FROM discovery_outfit_ownership").notification_shown_at,
    null,
  );
  outfit.exec("DROP TRIGGER fail_notice");
  outfit.discovery.dispose();
  throwsCode(
    () => outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-fault" }),
    "OUTCOMES_DISPOSED",
  );
  assert.equal(
    outfit.one("SELECT notification_pending, notification_shown_at FROM discovery_outfit_ownership")
      .notification_pending,
    1,
  );
  outfit.reopen();
  assert.equal(
    outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-fault" }).acknowledged,
    true,
  );
  assert.equal(
    outfit.discovery.acknowledgeOutfitNotice({ storyId: "outfit-fault" }).duplicate,
    true,
  );

  const existingStory = fixtureStory("char-existing", "character", "u7", ["fact-f3"]);
  const existing = makeHarness(t, { stories: [existingStory] });
  existing.completeDaily("existing-a1");
  assert.equal(existing.record("existing-a1", "char-existing", "char-existing-node-1").outcome, "applied");
  const existingInvite = existing.discovery.prepareInvitation({ storyId: "char-existing" });
  existing.discovery.acknowledgeInvitation({
    invitationId: existingInvite.invitation.invitationId,
  });
  existing.exec(`
    INSERT INTO relationships (character_id, accepted_at)
    VALUES ('u7', 'fixture-existing')
  `);
  existing.exec(`
    INSERT INTO character_stats (character_id, intimacy, energy, mood)
    VALUES ('u7', 42, 55, 1)
  `);
  existing.exec(`
    INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
    VALUES ('u7', 'resting', ${existing.clock.ms}, 0)
  `);
  const acceptedExisting = existing.discovery.acceptInvitation({
    invitationId: existingInvite.invitation.invitationId,
  });
  assert.equal(acceptedExisting.accepted, true);
  assert.equal(acceptedExisting.alreadyAccepted, true);
  assert.equal(existing.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u7'").n, 1);
  assert.deepEqual(
    { ...existing.one("SELECT intimacy, energy, mood FROM character_stats WHERE character_id = 'u7'") },
    { intimacy: 42, energy: 55, mood: 1 },
  );
  assert.deepEqual(
    { ...existing.one("SELECT mode FROM character_runtime WHERE character_id = 'u7'") },
    { mode: "resting" },
  );
  assert.equal(
    existing.discovery.acceptInvitation({
      invitationId: existingInvite.invitation.invitationId,
    }).duplicate,
    true,
  );

  const disposedStory = fixtureStory("char-disposed", "character", "u8", ["fact-f4"]);
  const disposed = makeHarness(t, { stories: [disposedStory] });
  disposed.completeDaily("disposed-a1");
  assert.equal(disposed.record("disposed-a1", "char-disposed", "char-disposed-node-1").outcome, "applied");
  const disposedInvite = disposed.discovery.prepareInvitation({ storyId: "char-disposed" });
  disposed.discovery.dispose();
  throwsCode(
    () =>
      disposed.discovery.acknowledgeInvitation({
        invitationId: disposedInvite.invitation.invitationId,
      }),
    "OUTCOMES_DISPOSED",
  );
  assert.equal(
    disposed.one("SELECT status, displayed_at, quota_at FROM discovery_invitations WHERE invitation_id = ?", disposedInvite.invitation.invitationId).status,
    "prepared",
  );
  assert.equal(
    disposed.one("SELECT displayed_at FROM discovery_invitations WHERE invitation_id = ?", disposedInvite.invitation.invitationId).displayed_at,
    null,
  );

  const empty = makeHarness(t, { stories: [] });
  assert.equal(
    empty.discovery.prepareInvitation({ storyId: "missing-story" }).reason,
    "STORY_NOT_FOUND",
  );
  assert.equal(empty.discovery.unlockNextOutfit().reason, "NO_ELIGIBLE_OUTFIT");
  assert.equal(empty.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);
  assert.equal(empty.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.deepEqual(empty.discovery.getStorySelectionFilters(), {
    pendingInvitationTargetId: null,
    rejectedTargetIds: [],
  });
});

test("POL-DISCOVERY-006 未展示邀请重开不得伪造展示或绕过ack", (t) => {
  const deferredStory = fixtureStory("char-unshown-defer", "character", "v1", ["fact-v1"]);
  const deferred = makeHarness(t, { stories: [deferredStory] });
  deferred.completeDaily("unshown-d1");
  assert.equal(
    deferred.record("unshown-d1", "char-unshown-defer", "char-unshown-defer-node-1").outcome,
    "applied",
  );
  const deferredInvite = deferred.discovery.prepareInvitation({
    storyId: "char-unshown-defer",
  });
  const deferredId = deferredInvite.invitation.invitationId;
  assert.equal(deferred.discovery.deferInvitation({ invitationId: deferredId }).invitation.status, "later");
  const reopenedDeferred = deferred.discovery.reopenInvitation({ invitationId: deferredId });
  assert.equal(reopenedDeferred.invitation.status, "prepared");
  assert.equal(reopenedDeferred.invitation.displayedAt, null);
  assert.equal(reopenedDeferred.invitation.quotaAt, null);
  assert.equal(reopenedDeferred.invitation.reopenedAt, deferred.clock.ms);
  throwsCode(
    () => deferred.discovery.acceptInvitation({ invitationId: deferredId }),
    "INVITATION_NOT_DISPLAYED",
  );
  assert.equal(
    deferred.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'v1'").n,
    0,
  );
  const deferredAck = deferred.discovery.acknowledgeInvitation({ invitationId: deferredId });
  assert.equal(deferredAck.invitation.status, "pending");
  assert.equal(deferredAck.invitation.quotaAt, deferred.clock.ms);
  assert.equal(deferred.discovery.acceptInvitation({ invitationId: deferredId }).accepted, true);

  const rejectedStory = fixtureStory("char-unshown-reject", "character", "v2", ["fact-v2"]);
  const rejected = makeHarness(t, { stories: [rejectedStory] });
  rejected.completeDaily("unshown-r1");
  assert.equal(
    rejected.record("unshown-r1", "char-unshown-reject", "char-unshown-reject-node-1").outcome,
    "applied",
  );
  const rejectedInvite = rejected.discovery.prepareInvitation({
    storyId: "char-unshown-reject",
  });
  const rejectedId = rejectedInvite.invitation.invitationId;
  rejected.discovery.rejectInvitation({ invitationId: rejectedId });
  const reopenedRejected = rejected.discovery.reopenInvitation({ invitationId: rejectedId });
  assert.equal(reopenedRejected.invitation.status, "prepared");
  assert.equal(reopenedRejected.invitation.displayedAt, null);
  assert.equal(reopenedRejected.invitation.quotaAt, null);
  throwsCode(
    () => rejected.discovery.acceptInvitation({ invitationId: rejectedId }),
    "INVITATION_NOT_DISPLAYED",
  );
  rejected.discovery.acknowledgeInvitation({ invitationId: rejectedId });
  assert.equal(rejected.discovery.acceptInvitation({ invitationId: rejectedId }).accepted, true);

  const assetStory = fixtureStory("char-asset-ack", "character", "v3", ["fact-v3"]);
  const asset = makeHarness(t, { stories: [assetStory] });
  asset.completeDaily("asset-a1");
  assert.equal(asset.record("asset-a1", "char-asset-ack", "char-asset-ack-node-1").outcome, "applied");
  const assetInvite = asset.discovery.prepareInvitation({ storyId: "char-asset-ack" });
  const assetId = assetInvite.invitation.invitationId;
  asset.useCatalog([{ ...assetStory, assetAvailable: false }]);
  throwsCode(
    () => asset.discovery.acknowledgeInvitation({ invitationId: assetId }),
    "INVITATION_SOURCE_UNAVAILABLE",
  );
  const assetPending = asset.discovery.getInvitation({ invitationId: assetId });
  assert.equal(assetPending.status, "prepared");
  assert.equal(assetPending.displayedAt, null);
  assert.equal(assetPending.quotaAt, null);
  asset.useCatalog([assetStory]);
  assert.equal(asset.discovery.acknowledgeInvitation({ invitationId: assetId }).acknowledged, true);

  const conflictStory = fixtureStory("char-target-ack", "character", "v4", ["fact-v4"]);
  const conflict = makeHarness(t, { stories: [conflictStory] });
  conflict.completeDaily("target-a1");
  assert.equal(
    conflict.record("target-a1", "char-target-ack", "char-target-ack-node-1").outcome,
    "applied",
  );
  const conflictInvite = conflict.discovery.prepareInvitation({ storyId: "char-target-ack" });
  const conflictId = conflictInvite.invitation.invitationId;
  conflict.useCatalog([{ ...conflictStory, targetId: "v5" }]);
  throwsCode(
    () => conflict.discovery.acknowledgeInvitation({ invitationId: conflictId }),
    "INVITATION_SOURCE_UNAVAILABLE",
  );
  const conflictPending = conflict.discovery.getInvitation({ invitationId: conflictId });
  assert.equal(conflictPending.status, "prepared");
  assert.equal(conflictPending.displayedAt, null);
  assert.equal(conflictPending.quotaAt, null);
  conflict.useCatalog([conflictStory]);
  assert.equal(
    conflict.discovery.acknowledgeInvitation({ invitationId: conflictId }).acknowledged,
    true,
  );
});
