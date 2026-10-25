/* S06e 正式验收：真实 SQLite、真实 companionship 完成入口，作者目录仅为 fixture。
   覆盖 POL-STORY-001～005；不覆盖邀请、服装解锁、GUI、网络或正式发布目录。
   为让故事模块与活动服务共用同一连接，先用 createStore 建 schema，再由同一
   DatabaseSync 构造正式 companionship；活动完成仍走正式 service 入口。 */
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const CANDIDATES = ["a", "b"].map((id) => ({
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-story-"));
  const dbPath = path.join(dir, "bayper.sqlite3");
  const ids = options.ids ?? ["a", "b"];
  const clock = { ms: options.start ?? START };
  let currentStories = options.stories ?? [];
  let db;
  let store;
  let service;
  let story;
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
    story = createStoryProgress({
      db,
      catalog: { version: "fixture-1", stories: currentStories },
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
    }
    const set = (key, value) =>
      db.prepare(`
        INSERT INTO app_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    set("fixed_character_id", ids[0]);
    set("current_character_id", ids[0]);
    set("current_mode", "companion");
    set("pending_rotation", "0");
    set("last_active_at", clock.ms);
    ids.slice(0, 5).forEach((characterId, index) => {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(clock.ms),
        SLOTS[index],
        characterId,
      );
      db.prepare(`
        INSERT INTO character_runtime
          (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, 0)
      `).run(characterId, characterId === ids[0] ? "companion" : "waiting", clock.ms);
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
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get story() {
      return story;
    },
    advance: (ms) => {
      clock.ms += ms;
    },
    setClock: (ms) => {
      clock.ms = ms;
    },
    useCatalog: (stories) => {
      currentStories = stories;
      story = createStoryProgress({
        db,
        catalog: { version: "fixture-2", stories },
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
    activity: (activityId) =>
      db.prepare("SELECT * FROM character_activities WHERE activity_id = ?").get(activityId),
    stats: (characterId) =>
      store.listCompanions().find((item) => item.characterId === characterId).stats,
    completeActivity: (characterId, kind, activityId) => {
      const requested = service.requestActivity({
        activityId,
        characterId,
        kind,
      });
      assert.equal(requested.requested, true, JSON.stringify(requested));
      const started = service.completeNaturalNode();
      assert.equal(started.started, true, JSON.stringify(started));
      clock.ms += kind === "daily" ? 10 * 1000 : 20 * MINUTE;
      service.advanceActivities();
      const activity = h.activity(activityId);
      assert.equal(activity.status, "completed");
      return activity;
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

function loadIdentityStory(h, storyId, activityId) {
  h.completeActivity("a", "daily", activityId);
  const result = h.story.recordNode({
    activityId,
    narratorId: "a",
    storyId,
    nodeId: `${storyId}-node-1`,
  });
  assert.equal(result.outcome, "applied");
}

function identitySelection(h, type, targetId, ownerCharacterId = null) {
  const item = h.story.selectNextStories().find((candidate) => candidate.type === type);
  assert.ok(item);
  assert.equal(item.status, "unavailable");
  assert.equal(item.reason, "STORY_IDENTITY_CONFLICT");
  assert.equal(item.targetId, targetId);
  assert.equal(item.ownerCharacterId, ownerCharacterId);
  assert.equal(item.nodeId, null);
  return item;
}

function assertUnavailableProgress(h, storyId, reason, targetId, nextNodeId = null) {
  const progress = h.story.getProgress(storyId);
  assert.equal(progress.status, "unavailable");
  assert.equal(progress.progressStatus, "active");
  assert.equal(progress.available, false);
  assert.equal(progress.reason, reason);
  assert.equal(progress.targetId, targetId);
  assert.equal(progress.nextNodeId, nextNodeId);
  return progress;
}

function assertRecordConflict(h, activityId, storyId, nodeId) {
  throwsCode(
    () => h.story.recordNode({ activityId, narratorId: "a", storyId, nodeId }),
    "STORY_IDENTITY_CONFLICT",
  );
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_activity_results WHERE activity_id = ?", activityId).n,
    0,
  );
}

function sourceRows(h, factId) {
  return h.all(
    `SELECT activity_id, narrator_id FROM story_fact_sources
     WHERE fact_id = ? ORDER BY activity_id`,
    factId,
  );
}

test("POL-STORY-001 实际活动完成第一节点、24h 后第二节点成熟", (t) => {
  const story = fixtureStory("story-u1", "character", "u1", [
    "fact-u1-1",
    "fact-u1-2",
  ]);
  const h = makeHarness(t, { stories: [story] });

  h.service.requestActivity({
    activityId: "story-act-1",
    characterId: "a",
    kind: "daily",
  });
  throwsCode(
    () =>
      h.story.recordNode({
        activityId: "story-act-1",
        narratorId: "a",
        storyId: "story-u1",
        nodeId: "story-u1-node-1",
      }),
    "ACTIVITY_NOT_COMPLETED",
  );
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(10 * 1000);
  h.service.advanceActivities();

  const base = {
    activityId: "story-act-1",
    narratorId: "a",
    storyId: "story-u1",
    nodeId: "story-u1-node-1",
  };
  throwsCode(
    () => h.story.recordNode({ ...base, activityId: "activity-missing" }),
    "ACTIVITY_NOT_FOUND",
  );
  throwsCode(() => h.story.recordNode({ ...base, storyId: "story-missing" }), "STORY_NOT_FOUND");
  throwsCode(() => h.story.recordNode({ ...base, nodeId: "node-missing" }), "STORY_NODE_NOT_FOUND");
  throwsCode(
    () => h.story.recordNode({ ...base, nodeId: "story-u1-node-2" }),
    "STORY_OUT_OF_ORDER",
  );
  throwsCode(() => h.story.recordNode({ ...base, narratorId: "b" }), "NARRATOR_MISMATCH");

  const first = h.story.recordNode(base);
  assert.equal(first.outcome, "applied");
  assert.equal(first.duplicate, false);
  assert.equal(first.storyStatus, "active");
  assert.equal(first.mature, false);
  assert.equal(first.factId, "fact-u1-1");
  assert.deepEqual(h.story.getProgress("story-u1").nextNodeIndex, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, 1);
  assert.equal(sourceRows(h, "fact-u1-1")[0].narrator_id, "a");
  const replay = h.story.recordNode(base);
  assert.equal(replay.duplicate, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, 1);

  // 第一节点后让 a 候场恢复；24h 后由完成的活动提交第二节点。
  h.service.switchTo("b");
  h.advance(24 * HOUR);
  h.completeActivity("a", "exploration", "story-act-2");
  const second = h.story.recordNode({
    activityId: "story-act-2",
    narratorId: "a",
    storyId: "story-u1",
    nodeId: "story-u1-node-2",
  });
  assert.equal(second.outcome, "applied");
  assert.equal(second.storyStatus, "mature");
  assert.equal(second.mature, true);
  assert.equal(h.story.getProgress("story-u1").status, "mature");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 2);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, 2);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships").n, 2);
  assert.equal(h.service.getSnapshot().current.characterId, "b");
});

test("POL-STORY-002 重放、事实来源合并、额度跳过与重开回拨", (t) => {
  const firstStory = fixtureStory("story-u1", "character", "u1", [
    "fact-u1-1",
    "fact-u1-2",
  ]);
  const secondStory = fixtureStory("story-u2", "character", "u2", ["fact-u2-1"]);
  const h = makeHarness(t, { stories: [firstStory, secondStory] });

  h.completeActivity("a", "daily", "story-act-1");
  const first = h.story.recordNode({
    activityId: "story-act-1",
    narratorId: "a",
    storyId: "story-u1",
    nodeId: "story-u1-node-1",
  });
  assert.equal(first.outcome, "applied");
  assert.equal(h.story.recordNode({
    activityId: "story-act-1",
    narratorId: "a",
    storyId: "story-u1",
    nodeId: "story-u1-node-2",
  }).duplicate, true);
  assert.equal(h.story.getProgress("story-u1").nextNodeIndex, 1);
  h.advance(HOUR);
  h.completeActivity("b", "exploration", "story-act-2");
  const merged = h.story.recordNode({
    activityId: "story-act-2",
    narratorId: "b",
    storyId: "story-u1",
    nodeId: "story-u1-node-1",
  });
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.merged, true);
  assert.deepEqual(
    sourceRows(h, "fact-u1-1").map((row) => row.narrator_id),
    ["a", "b"],
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.story.getProgress("story-u1").nextNodeIndex, 1);

  h.reopen();
  assert.equal(h.story.recordNode({
    activityId: "story-act-1",
    narratorId: "a",
    storyId: "story-u1",
    nodeId: "story-u1-node-1",
  }).duplicate, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);

  h.advance(40 * MINUTE);
  h.completeActivity("a", "daily", "story-act-3");
  const skipped = h.story.recordNode({
    activityId: "story-act-3",
    narratorId: "a",
    storyId: "story-u2",
    nodeId: "story-u2-node-1",
  });
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.reason, "QUOTA");
  assert.equal(h.story.getProgress("story-u2"), null);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);

  h.advance(HOUR);
  h.completeActivity("a", "daily", "story-act-4");
  h.setClock(START + 2 * HOUR + 30 * MINUTE);
  const rolled = h.story.recordNode({
    activityId: "story-act-4",
    narratorId: "a",
    storyId: "story-u2",
    nodeId: "story-u2-node-1",
  });
  assert.equal(rolled.outcome, "skipped");
  assert.equal(rolled.reason, "QUOTA");
  assert.equal(
    h.story.recordNode({
      activityId: "story-act-3",
      narratorId: "a",
      storyId: "story-u2",
      nodeId: "story-u2-node-1",
    }).duplicate,
    true,
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 1);

  // 超过 24 小时也不能把旧跳过活动补成欠账。
  h.setClock(START + 25 * HOUR);
  const oldSkip = h.story.recordNode({
    activityId: "story-act-3",
    narratorId: "a",
    storyId: "story-u2",
    nodeId: "story-u2-node-1",
  });
  assert.equal(oldSkip.duplicate, true);
  assert.equal(oldSkip.reason, "QUOTA");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 1);
});

test("POL-STORY-003 选择资格、续旧、素材下架恢复与空目录", (t) => {
  const c1 = fixtureStory("story-c1", "character", "u1", ["fact-c1-1", "fact-c1-2"]);
  const c2 = fixtureStory("story-c2", "character", "u2", ["fact-c2-1"]);
  const c3 = fixtureStory("story-c3", "character", "a", ["fact-c3-1"]);
  const c4 = fixtureStory("story-c4", "character", "u4", ["fact-c4-1"], {
    assetAvailable: false,
  });
  const o1 = fixtureStory("story-o1", "outfit", "outfit-1", ["fact-o1-1", "fact-o1-2"], {
    ownerCharacterId: "a",
  });
  const o2 = fixtureStory("story-o2", "outfit", "outfit-2", ["fact-o2-1"], {
    ownerCharacterId: "nobody",
  });
  const stories = [c1, c2, c3, c4, o1, o2];
  const h = makeHarness(t, { stories });
  let selected = h.story.selectNextStories();
  assert.deepEqual(selected.map((item) => item.storyId), ["story-c1", "story-o1"]);
  assert.deepEqual(selected.map((item) => item.type), ["character", "outfit"]);
  assert.equal(selected[0].nodeId, "story-c1-node-1");
  assert.equal(selected[1].ownerCharacterId, "a");
  selected = h.story.selectNextStories({ pendingInvitationTargetId: "u1" });
  assert.deepEqual(selected.map((item) => item.type), ["outfit"]);
  selected = h.story.selectNextStories({ rejectedTargetIds: ["u1"] });
  assert.deepEqual(selected.map((item) => item.storyId), ["story-c2", "story-o1"]);
  selected = h.story.selectNextStories({ rejectedTargetIds: ["u1", "u2"] });
  assert.deepEqual(selected.map((item) => item.type), ["outfit"]);

  h.completeActivity("a", "daily", "story-c1-act");
  assert.equal(
    h.story.recordNode({
      activityId: "story-c1-act",
      narratorId: "a",
      storyId: "story-c1",
      nodeId: "story-c1-node-1",
    }).outcome,
    "applied",
  );
  selected = h.story.selectNextStories();
  assert.deepEqual(selected.map((item) => item.storyId), ["story-c1", "story-o1"]);
  assert.equal(selected[0].continued, true);
  assert.equal(selected[0].nodeId, "story-c1-node-2");

  // 24h 后让服装故事也开始，验证角色与服装各一条续旧。
  h.service.switchTo("b");
  h.advance(24 * HOUR);
  h.completeActivity("a", "exploration", "story-o1-act");
  assert.equal(
    h.story.recordNode({
      activityId: "story-o1-act",
      narratorId: "a",
      storyId: "story-o1",
      nodeId: "story-o1-node-1",
    }).outcome,
    "applied",
  );
  selected = h.story.selectNextStories();
  assert.deepEqual(selected.map((item) => item.storyId), ["story-c1", "story-o1"]);
  assert.equal(selected[0].continued, true);
  assert.equal(selected[0].nodeId, "story-c1-node-2");
  assert.equal(selected[1].continued, true);
  assert.equal(selected[1].nodeId, "story-o1-node-2");
  h.useCatalog(stories.map((item) => item.storyId === "story-c1"
    ? { ...item, assetAvailable: false }
    : item));
  selected = h.story.selectNextStories();
  const unavailable = selected.find((item) => item.storyId === "story-c1");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "ASSET_UNAVAILABLE");
  assert.equal(unavailable.nodeId, "story-c1-node-2");
  assert.equal(selected.some((item) => item.storyId === "story-c2"), false);
  assertUnavailableProgress(
    h,
    "story-c1",
    "ASSET_UNAVAILABLE",
    "u1",
    "story-c1-node-2",
  );
  h.useCatalog(stories);
  selected = h.story.selectNextStories();
  assert.equal(selected[0].storyId, "story-c1");
  assert.equal(selected[0].nodeId, "story-c1-node-2");
  const restoredProgress = h.story.getProgress("story-c1");
  assert.equal(restoredProgress.status, "active");
  assert.equal(restoredProgress.available, true);
  assert.equal(restoredProgress.reason, null);
  assert.equal(restoredProgress.nextNodeId, "story-c1-node-2");
  assert.equal(restoredProgress.nextNodeIndex, 1);

  const none = makeHarness(t, { stories: [c3, o2] });
  assert.deepEqual(none.story.selectNextStories(), []);
  const empty = makeHarness(t, { stories: [] });
  assert.deepEqual(empty.story.selectNextStories(), []);
  assert.equal(empty.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
});

test("POL-STORY-004 进度、来源与评估写入故障整笔回滚后同活动重试", (t) => {
  const story = fixtureStory("story-fault", "character", "u1", ["fact-fault-1"]);
  const failures = [
    ["progress", "story_progress", "INSERT"],
    ["source", "story_fact_sources", "INSERT"],
    ["evaluation", "story_activity_results", "INSERT"],
  ];

  for (const [name, table, action] of failures) {
    const h = makeHarness(t, { stories: [story] });
    const activityId = `fault-act-${name}`;
    h.completeActivity("a", "daily", activityId);
    h.exec(`
      CREATE TRIGGER fail_${name}
      BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'forced ${name} failure'); END
    `);
    assert.throws(
      () =>
        h.story.recordNode({
          activityId,
          narratorId: "a",
          storyId: "story-fault",
          nodeId: "story-fault-node-1",
        }),
      new RegExp(`forced ${name} failure`),
    );
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 0);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, 0);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_activity_results").n, 0);
    assert.equal(h.activity(activityId).status, "completed");

    h.exec(`DROP TRIGGER fail_${name}`);
    const retried = h.story.recordNode({
      activityId,
      narratorId: "a",
      storyId: "story-fault",
      nodeId: "story-fault-node-1",
    });
    assert.equal(retried.outcome, "applied");
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 1);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, 1);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_activity_results").n, 1);

    const before = {
      progress: h.one("SELECT * FROM story_progress").next_node_index,
      facts: h.one("SELECT COUNT(*) AS n FROM story_facts").n,
    };
    throwsCode(
      () =>
        createStoryProgress({
          db: h.db,
          catalog: {
            version: "fixture-broken",
            stories: [
              story,
              fixtureStory("story-conflict", "character", "u9", ["fact-fault-1"]),
            ],
          },
          now: () => new Date(h.clock.ms),
        }),
      "STORY_CATALOG_INVALID",
    );
    assert.equal(h.one("SELECT * FROM story_progress").next_node_index, before.progress);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, before.facts);
  }
});

test("POL-STORY-005 关库后目录身份或已记录节点冲突不挪用旧进度", (t) => {
  const base = fixtureStory("story-identity", "character", "u1", [
    "fact-i-1",
    "fact-i-2",
  ], { themeId: "theme-i" });
  const h = makeHarness(t, { stories: [base] });
  loadIdentityStory(h, "story-identity", "identity-act-1");
  h.reopenWith([{ ...base, targetId: "u2" }]);
  assertUnavailableProgress(
    h,
    "story-identity",
    "STORY_IDENTITY_CONFLICT",
    "u1",
  );
  const before = {
    target: h.one("SELECT target_id FROM story_progress").target_id,
    next: h.one("SELECT next_node_index FROM story_progress").next_node_index,
    facts: h.one("SELECT COUNT(*) AS n FROM story_facts").n,
    sources: h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n,
  };

  identitySelection(h, "character", "u1");
  h.advance(HOUR);
  h.completeActivity("a", "daily", "identity-act-2");
  assertRecordConflict(h, "identity-act-2", "story-identity", "story-identity-node-1");
  assert.equal(h.one("SELECT target_id FROM story_progress").target_id, before.target);
  assert.equal(h.one("SELECT next_node_index FROM story_progress").next_node_index, before.next);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, before.facts);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_fact_sources").n, before.sources);

  h.useCatalog([{ ...base, nodes: [base.nodes[1], base.nodes[0]] }]);
  identitySelection(h, "character", "u1");
  h.useCatalog([{ ...base, nodes: [{ ...base.nodes[0], factId: "fact-i-1-changed" }, base.nodes[1]] }]);
  identitySelection(h, "character", "u1");
  h.useCatalog([{ ...base, type: "outfit", ownerCharacterId: "b" }]);
  identitySelection(h, "character", "u1");
  h.useCatalog([{ ...base, themeId: "theme-i-changed" }]);
  identitySelection(h, "character", "u1");
  h.useCatalog([]);
  assertUnavailableProgress(h, "story-identity", "STORY_UNAVAILABLE", "u1");

  // 仅追加未经历节点并润色正文，不改变已记录事实身份，可以继续。
  const appended = {
    ...base,
    nodes: [
      { ...base.nodes[0], body: "fixture revised node 1" },
      { ...base.nodes[1], body: "fixture revised node 2" },
      {
        nodeId: "story-identity-node-3",
        factId: "fact-i-3",
        body: "fixture appended node 3",
      },
    ],
  };
  h.useCatalog([appended]);
  const readyProgress = h.story.getProgress("story-identity");
  assert.equal(readyProgress.status, "active");
  assert.equal(readyProgress.available, true);
  assert.equal(readyProgress.reason, null);
  assert.equal(readyProgress.nextNodeId, "story-identity-node-2");
  let selected = h.story.selectNextStories().find((item) => item.type === "character");
  assert.equal(selected.status, "ready");
  assert.equal(selected.storyId, "story-identity");
  assert.equal(selected.nodeId, "story-identity-node-2");
  h.setClock(START + 24 * HOUR + 10 * 1000);
  const continued = h.story.recordNode({
    activityId: "identity-act-2",
    narratorId: "a",
    storyId: "story-identity",
    nodeId: "story-identity-node-2",
  });
  assert.equal(continued.outcome, "applied");
  assert.equal(h.one("SELECT next_node_index FROM story_progress").next_node_index, 2);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 2);

  const outfitBase = fixtureStory("story-outfit-identity", "outfit", "outfit-i-1", [
    "fact-oi-1",
    "fact-oi-2",
  ], { ownerCharacterId: "a", themeId: "theme-oi" });
  const outfit = makeHarness(t, { stories: [outfitBase] });
  loadIdentityStory(outfit, "story-outfit-identity", "outfit-identity-act-1");
  outfit.reopenWith([{ ...outfitBase, ownerCharacterId: "b" }]);
  identitySelection(outfit, "outfit", "outfit-i-1", "a");
  assertUnavailableProgress(
    outfit,
    "story-outfit-identity",
    "STORY_IDENTITY_CONFLICT",
    "outfit-i-1",
  );
});
