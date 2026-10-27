/* S03j 定向主题记忆共享验收：真实 SQLite/store/companionship/storyProgress/
   storyRuntime/memory。作者目录均构造在内存，正式 maid-stories.json 仍保持
   assetAvailable=false。只跑 Node 领域链，不启动 GUI、不读取 .env、不请求网络
   或模型。24h 窗口用例通过可控时钟推进；故事自身的每日事实额度用“把既有事实
   学习时间调旧”隔离，新节点仍由真实活动 + storyProgress.recordNode 应用。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createStore } = require("../../app/store.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");
const { createStoryRuntime } = require("../../app/story-runtime.cjs");
const { BODY_PREFIX } = require("../../app/theme-memory-sharing.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 27, 12, 0, 0).getTime();
const CONTENT_PATH = path.join(__dirname, "..", "..", "app", "content", "maid-stories.json");
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

function fixtureStory(storyId, factIds, options = {}) {
  const story = {
    storyId,
    type: options.type ?? "character",
    targetId: options.targetId ?? "u1",
    ownerCharacterId: options.ownerCharacterId ?? null,
    themeId: options.themeId ?? "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: factIds.map((factId, index) => ({
      nodeId: `${storyId}-node-${index + 1}`,
      factId,
      body: `fixture ${storyId} node ${index + 1}`,
    })),
  };
  if (options.shareWithCharacterIds !== undefined) {
    story.shareWithCharacterIds = options.shareWithCharacterIds;
  }
  return story;
}

function fixtureCatalog(stories) {
  return { schemaVersion: 1, theme: { id: "fixture-theme", name: "测试主题" }, stories };
}

function storyFor(storyId, factId, shareWithCharacterIds = ["b"]) {
  return fixtureStory(storyId, [factId], { shareWithCharacterIds });
}

function themeFactKey(story, factId) {
  return `theme-fact:${JSON.stringify([story.themeId, story.storyId, factId])}`;
}

function themeBody(story, nodeIndex) {
  return `${BODY_PREFIX}${story.nodes[nodeIndex].body}`;
}

function appliedResult(story, nodeIndex, activityId) {
  const node = story.nodes[nodeIndex];
  return {
    activityId,
    narratorId: "a",
    storyId: story.storyId,
    nodeId: node.nodeId,
    factId: node.factId,
    outcome: "applied",
    duplicate: false,
    themeId: story.themeId,
    shareWithCharacterIds: story.shareWithCharacterIds ?? [],
    body: node.body,
  };
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-theme-share-"));
  const clock = { ms: options.start ?? START };
  let catalog = options.catalog ?? fixtureCatalog([]);
  let store;
  let service;
  let runtime = null;
  let seeded = false;
  let runtimeEnabled = options.runtime !== false;
  let blocked = false;
  let shareContextFailures = 0;
  const acceptedId = options.acceptedId ?? "a";
  const knownIds = options.known ?? ["b", "c"];
  const rosterIds = options.roster ?? ["b"];

  function open() {
    store = createStore(dir, { storyCatalog: catalog, now: () => clock.ms });
    if (!seeded) {
      store.acceptCharacter({
        characterId: acceptedId,
        day: localDay(clock.ms),
        acceptedAt: new Date(clock.ms).toISOString(),
      });
      for (const characterId of knownIds.filter((id) => id !== acceptedId)) {
        store.db
          .prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)")
          .run(characterId, new Date(clock.ms).toISOString());
        store.db
          .prepare(`
            INSERT INTO character_stats (character_id, intimacy, energy, mood)
            VALUES (?, 10, 100, 0)
          `)
          .run(characterId);
        store.db
          .prepare(`
            INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
            VALUES (?, 'waiting', ?, 0)
          `)
          .run(characterId, clock.ms);
      }
      rosterIds.forEach((characterId, index) => {
        store.db
          .prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)")
          .run(localDay(clock.ms), `random_${index + 1}`, characterId);
      });
      seeded = true;
    }
    service = createCompanionshipService({
      store,
      candidates: CANDIDATES,
      now: () => new Date(clock.ms),
      random: () => 0.5,
    });
    service.start();
    if (runtimeEnabled) {
      startRuntime();
    }
  }

  function startRuntime() {
    runtime = createStoryRuntime({
      db: store.db,
      store,
      storyProgress: store.storyProgress,
      discoveryOutcomes: store.discoveryOutcomes,
      themeMemorySharing: store.themeMemorySharing,
      getShareContext: () => shareContext(),
      now: () => clock.ms,
    });
  }

  function shareContext() {
    // 构造一次快照 AppError：验证运行时不会把它当成领域拒绝而永久消费活动。
    if (shareContextFailures > 0) {
      shareContextFailures -= 1;
      throw new AppError("SNAPSHOT_UNAVAILABLE", "构造快照读取失败。");
    }
    if (blocked) {
      return { blocked: true, snapshot: null };
    }
    return { blocked: false, snapshot: service.getSnapshot() };
  }

  const h = {
    dir,
    clock,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get runtime() {
      return runtime;
    },
    currentId: () =>
      store.db
        .prepare("SELECT value FROM app_state WHERE key = 'current_character_id'")
        .get().value,
    one: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    run: (sql, ...params) => store.db.prepare(sql).run(...params),
    exec: (sql) => store.db.exec(sql),
    setClock: (ms) => {
      clock.ms = ms;
    },
    setBlocked: (value) => {
      blocked = value === true;
    },
    failNextShareContext: () => {
      shareContextFailures = 1;
    },
    activity: (activityId) => store.activities.get(activityId),
    startRuntime: () => {
      runtimeEnabled = true;
      startRuntime();
    },
    evaluate: () => runtime.evaluate(),
    reopen: () => {
      store.close();
      open();
    },
    shareRow: (activityId) =>
      h.one("SELECT * FROM theme_memory_shares WHERE activity_id = ?", activityId),
    shareCount: () =>
      Number(h.one("SELECT COUNT(*) AS n FROM theme_memory_shares").n),
    stateValue: (key) =>
      h.one("SELECT value FROM app_state WHERE key = ?", key)?.value ?? null,
    entries: (characterId) =>
      h.all(
        "SELECT * FROM memory_entries WHERE character_id = ? ORDER BY created_at, id",
        characterId,
      ),
    themeEntry: (characterId) =>
      h.all(
        "SELECT * FROM memory_entries WHERE character_id = ? ORDER BY created_at, id",
        characterId,
      ).find((entry) => entry.body.startsWith(BODY_PREFIX)) ?? null,
    memorySummary: () => ({
      a: h.entries("a"),
      b: h.entries("b"),
      c: h.entries("c"),
      fts: h.one("SELECT COUNT(*) AS n FROM memory_fts").n,
    }),
    controlSnapshot: () => ({
      roster: h.all("SELECT * FROM roster ORDER BY day, slot"),
      stats: h.all("SELECT character_id, energy, intimacy, mood FROM character_stats ORDER BY character_id"),
      relationships: h.all("SELECT * FROM relationships ORDER BY character_id"),
    }),
    ageStoryFacts: () => {
      h.run("UPDATE story_facts SET learned_at = ?", clock.ms - 25 * HOUR);
    },
    setEnergy: (characterId, energy) => {
      h.run("UPDATE character_stats SET energy = ? WHERE character_id = ?", energy, characterId);
    },
    switchTo: (characterId = acceptedId) => service.switchTo(characterId),
    completeDaily: (activityId, characterId = acceptedId) => {
      h.switchTo(characterId);
      const requested = service.requestActivity({
        activityId,
        characterId,
        kind: "daily",
      });
      assert.equal(requested.requested, true, JSON.stringify(requested));
      const started = service.completeNaturalNode();
      assert.equal(started.started, true, JSON.stringify(started));
      assert.equal(
        service.completeDailyAction(activityId, { characterId }).completed,
        true,
      );
      clock.ms += 10 * 1000;
      const completed = service.completeNaturalNode();
      assert.equal(completed.completedDaily, 1);
      const activity = h.activity(activityId);
      assert.equal(activity.status, "completed");
      return activity;
    },
    completeExploration: (activityId, characterId = acceptedId, partnerId = "b") => {
      if (h.currentId() === characterId) {
        h.switchTo(partnerId);
      }
      const requested = service.requestActivity({
        activityId,
        characterId,
        kind: "exploration",
      });
      assert.equal(requested.requested, true, JSON.stringify(requested));
      assert.equal(service.completeNaturalNode().started, true);
      clock.ms += 20 * MINUTE;
      service.advanceActivities();
      const activity = h.activity(activityId);
      assert.equal(activity.status, "completed");
      return activity;
    },
    laterDaily: (activityId) => {
      service.rest();
      clock.ms += DAY;
      return h.completeDaily(activityId);
    },
    manualRepeat: (activityId, result) => {
      // 直接走正式主题分享入口重复旧源；活动本身仍由真实 companionship 完成。
      return store.themeMemorySharing.shareActivityResult({
        activity: h.activity(activityId),
        result: { ...result, activityId },
        context: shareContext(),
        at: clock.ms,
      });
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

function assertRolledBack(h, activityId) {
  for (const table of [
    "story_progress",
    "story_facts",
    "story_fact_sources",
    "story_activity_results",
    "story_runtime_activity_results",
    "memory_entries",
    "memory_derivations",
    "memory_context_versions",
    "theme_memory_shares",
  ]) {
    assert.equal(h.one(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(h.one("SELECT COUNT(*) AS n FROM memory_fts").n, 0);
  assert.equal(h.activity(activityId).status, "completed");
  assert.equal(h.stateValue("theme_memory_share_last_success_at"), null);
  assert.equal(h.stateValue("theme_memory_share_max_logical_at"), null);
}

test("POL-THEME-SHARE-001 正式活动结果在故事事务内写入讲述者与接收者记忆", (t) => {
  const story = fixtureStory("story-main", ["fact-main-1"], {
    shareWithCharacterIds: ["b"],
  });
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });

  h.completeDaily("main-a1");
  const before = h.controlSnapshot();
  const applied = h.evaluate();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].outcome, "applied");
  assert.equal(applied[0].storyId, "story-main");
  assert.equal(applied[0].nodeId, "story-main-node-1");

  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  const share = h.shareRow("main-a1");
  assert.equal(share.outcome, "shared");
  assert.equal(share.narrator_id, "a");
  assert.equal(share.recipient_id, "b");
  assert.equal(share.story_id, "story-main");
  assert.equal(share.node_id, "story-main-node-1");

  const factKey = themeFactKey(story, "fact-main-1");
  const aEntry = h.themeEntry("a");
  const bEntry = h.themeEntry("b");
  assert.ok(aEntry);
  assert.ok(bEntry);
  assert.equal(aEntry.fact_key, factKey);
  assert.equal(bEntry.fact_key, factKey);
  assert.equal(aEntry.body, themeBody(story, 0));
  assert.equal(bEntry.body, themeBody(story, 0));
  assert.equal(aEntry.origin_character_id, "a");
  assert.equal(aEntry.derived_from_entry_id, null);
  assert.equal(bEntry.origin_character_id, "a");
  assert.equal(bEntry.derived_from_entry_id, aEntry.id);
  assert.equal(
    bEntry.source_id,
    `theme-source:${JSON.stringify(["fixture-theme", "story-main", "fact-main-1"])}`,
  );
  assert.equal(aEntry.source_kind, "theme");
  assert.equal(bEntry.source_kind, "theme");

  const derivation = h.one(
    "SELECT * FROM memory_derivations WHERE entry_id = ?",
    bEntry.id,
  );
  assert.equal(derivation.parent_entry_id, aEntry.id);
  assert.equal(derivation.origin_character_id, "a");
  assert.equal(derivation.narrator_character_id, "a");

  // 现有管理列表可直接读到“听谁说的”与派生性质。
  const bList = h.store.memory.listMemories("b");
  assert.equal(bList.length, 1);
  assert.equal(bList[0].factKey, factKey);
  assert.equal(bList[0].narratorCharacterId, "a");
  assert.equal(bList[0].originCharacterId, "a");
  assert.equal(bList[0].derived, true);
  assert.equal(bList[0].sourceKind, "theme");
  assert.equal(h.store.memory.searchMemories({ characterId: "b", query: "fixture" }).length, 1);

  // 未知/未参与角色 C 不获得记忆、检索或上下文；分享不额外改名单和数值。
  assert.deepEqual(h.entries("c"), []);
  assert.deepEqual(h.store.memory.searchMemories({ characterId: "c", query: "fixture" }), []);
  assert.equal(h.store.memory.getContextVersion("c"), 0);
  assert.equal(h.store.memory.getContextVersion("a"), 1);
  assert.equal(h.store.memory.getContextVersion("b"), 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM memory_fts").n, 2);
  assert.deepEqual(h.controlSnapshot(), before);
});

test("POL-THEME-SHARE-002 重启、回拨与满24h边界最多投递一次且不补发", (t) => {
  const story = fixtureStory(
    "story-window",
    ["fact-window-1", "fact-window-2", "fact-window-3", "fact-window-4"],
    { shareWithCharacterIds: ["b"] },
  );
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });

  h.completeDaily("win-a1");
  assert.equal(h.evaluate()[0].outcome, "applied");
  const firstShare = h.shareRow("win-a1");
  assert.equal(firstShare.outcome, "shared");
  const firstAt = Number(firstShare.created_at);
  const afterFirst = h.memorySummary();
  assert.equal(h.shareCount(), 1);

  // 重复心跳、重复 activity 与重启都不重复投递或占额度。
  assert.deepEqual(h.evaluate(), []);
  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(h.memorySummary(), afterFirst);
  assert.equal(h.shareCount(), 1);
  assert.equal(Number(h.stateValue("theme_memory_share_last_success_at")), firstAt);

  // 间隔不足24h的新合法节点：只记跳过，不新增记忆、不占用成功额度。
  h.ageStoryFacts();
  h.setClock(firstAt + HOUR);
  h.completeDaily("win-a2");
  const tooSoon = h.evaluate();
  assert.equal(tooSoon[0].outcome, "applied");
  assert.equal(h.shareRow("win-a2").outcome, "skipped");
  assert.equal(h.shareRow("win-a2").reason, "SHARE_WINDOW");
  assert.deepEqual(h.memorySummary(), afterFirst);
  assert.equal(Number(h.stateValue("theme_memory_share_last_success_at")), firstAt);
  const afterTooSoonLogical = Number(h.stateValue("theme_memory_share_max_logical_at"));

  // 时间回拨不能把已观察到的逻辑时钟改小，也不能重置24h窗口。
  h.ageStoryFacts();
  h.setClock(firstAt + 30 * MINUTE);
  h.completeExploration("win-a3");
  const rolled = h.evaluate();
  assert.equal(rolled[0].outcome, "applied");
  assert.equal(h.shareRow("win-a3").reason, "SHARE_WINDOW");
  assert.equal(
    Number(h.stateValue("theme_memory_share_max_logical_at")),
    afterTooSoonLogical,
  );
  assert.deepEqual(h.memorySummary(), afterFirst);

  // 满24h边界允许一次新的成功投递；旧跳过记录不补发。
  h.ageStoryFacts();
  h.setClock(firstAt + DAY - 10 * 1000);
  h.completeDaily("win-a4");
  assert.equal(h.clock.ms, firstAt + DAY);
  const boundary = h.evaluate();
  assert.equal(boundary[0].outcome, "applied");
  const boundaryShare = h.shareRow("win-a4");
  assert.equal(boundaryShare.outcome, "shared");
  assert.equal(boundaryShare.recipient_id, "b");
  assert.equal(h.shareCount(), 4);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM memory_entries").n, 4);
  assert.deepEqual(
    h.store.memory
      .listMemories("b")
      .map((entry) => entry.factKey)
      .sort(),
    [
      themeFactKey(story, "fact-window-1"),
      themeFactKey(story, "fact-window-4"),
    ].sort(),
  );

  // 首次接线前已完成的活动只记为历史基线，不补发旧结果。
  const baseline = makeHarness(t, {
    catalog: fixtureCatalog([story]),
    runtime: false,
  });
  baseline.completeDaily("old-a1");
  baseline.startRuntime();
  assert.deepEqual(baseline.evaluate(), []);
  assert.equal(baseline.shareCount(), 0);
  assert.deepEqual(baseline.entries("a"), []);
  assert.deepEqual(baseline.entries("b"), []);
  assert.equal(
    baseline.one(
      "SELECT reason FROM story_runtime_activity_results WHERE activity_id = 'old-a1'",
    ).reason,
    "HISTORICAL_BASELINE",
  );
});

test("POL-THEME-SHARE-003 未发布、无关联、名单外、低精力、互动与开关均安全跳过", (t) => {
  const official = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8"));
  const officialIds = ["rin", "hu", "cheng"];
  assert.equal(official.stories.every((story) => story.assetAvailable === false), true);
  for (const story of official.stories) {
    assert.ok(Array.isArray(story.shareWithCharacterIds));
    assert.ok(story.shareWithCharacterIds.every((id) => officialIds.includes(id)));
  }

  // 正式目录未发布：故事不推进，也就不产生分享记录或记忆。
  const unpublished = makeHarness(t, { catalog: official });
  unpublished.completeDaily("official-a1");
  const blocked = unpublished.evaluate();
  assert.equal(blocked[0].reason, "NO_STORY_CANDIDATE");
  assert.equal(unpublished.shareCount(), 0);
  assert.deepEqual(unpublished.entries("a"), []);
  assert.deepEqual(unpublished.entries("b"), []);
  assert.equal(JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8")).stories.every(
    (story) => story.assetAvailable === false,
  ), true);

  // 没有作者关联：不按整份主题推断，也不为分享生成记忆。
  const noTarget = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-no-target", "fact-none", [])]),
  });
  noTarget.completeDaily("none-a1");
  assert.equal(noTarget.evaluate()[0].outcome, "applied");
  assert.equal(noTarget.shareRow("none-a1").reason, "NO_ASSOCIATED_CHARACTER");
  assert.deepEqual(noTarget.entries("a"), []);
  assert.deepEqual(noTarget.entries("b"), []);

  // 作者顺序中跳过讲述者、未知角色与名单外角色，只取第一位自然对象。
  const ordered = makeHarness(t, {
    catalog: fixtureCatalog([
      storyFor("story-order", "fact-order-1", ["a", "ghost", "c", "b"]),
    ]),
  });
  ordered.completeDaily("order-a1");
  assert.equal(ordered.evaluate()[0].outcome, "applied");
  assert.equal(ordered.shareRow("order-a1").recipient_id, "b");

  // 名单外已结识角色仍不能接收。
  const outside = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-outside", "fact-outside-1", ["c"])]),
  });
  outside.completeDaily("outside-a1");
  assert.equal(outside.evaluate()[0].outcome, "applied");
  assert.equal(outside.shareRow("outside-a1").reason, "NO_ELIGIBLE_RECIPIENT");
  assert.deepEqual(outside.entries("c"), []);

  // 低精力、互动、休息、待轮换、暂停与全局关闭各自跳过；恢复后不补发旧结果。
  const lowEnergy = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-energy", "fact-energy-1")]),
  });
  lowEnergy.completeDaily("energy-a1");
  lowEnergy.setEnergy("a", 30);
  assert.equal(lowEnergy.evaluate()[0].outcome, "applied");
  assert.equal(lowEnergy.shareRow("energy-a1").reason, "NARRATOR_LOW_ENERGY");
  assert.deepEqual(lowEnergy.entries("a"), []);

  const interacting = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-chat", "fact-chat-1")]),
  });
  interacting.completeDaily("chat-a1");
  interacting.service.startInteraction("b");
  assert.equal(interacting.evaluate()[0].outcome, "applied");
  assert.equal(interacting.shareRow("chat-a1").reason, "INTERACTION");
  assert.deepEqual(interacting.entries("a"), []);
  interacting.service.endInteraction();
  assert.deepEqual(interacting.evaluate(), []);
  assert.deepEqual(interacting.entries("a"), []);

  const resting = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-rest", "fact-rest-1")]),
  });
  resting.completeDaily("rest-a1");
  resting.service.rest();
  assert.equal(resting.evaluate()[0].outcome, "applied");
  assert.equal(resting.shareRow("rest-a1").reason, "NARRATOR_RESTING");
  assert.deepEqual(resting.entries("a"), []);

  const pending = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-pending", "fact-pending-1")]),
  });
  pending.completeDaily("pending-a1");
  pending.setEnergy("b", 20);
  pending.switchTo("b");
  assert.equal(pending.service.requestAutoRotation().pending, true);
  assert.equal(pending.evaluate()[0].outcome, "applied");
  assert.equal(pending.shareRow("pending-a1").reason, "PENDING_ROTATION");
  assert.deepEqual(pending.entries("a"), []);

  const paused = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-paused", "fact-paused-1")]),
  });
  paused.setBlocked(true);
  paused.completeDaily("paused-a1");
  assert.equal(paused.evaluate()[0].outcome, "applied");
  assert.equal(paused.shareRow("paused-a1").reason, "PAUSED");
  assert.deepEqual(paused.entries("a"), []);
  paused.setBlocked(false);
  assert.deepEqual(paused.evaluate(), []);
  assert.deepEqual(paused.entries("a"), []);

  const switched = makeHarness(t, {
    catalog: fixtureCatalog([storyFor("story-switch", "fact-switch-1")]),
  });
  switched.store.memory.setAutoShareEnabled({ enabled: false });
  switched.completeDaily("switch-a1");
  const afterActivity = switched.controlSnapshot();
  assert.equal(switched.evaluate()[0].outcome, "applied");
  assert.equal(switched.shareRow("switch-a1").reason, "AUTO_SHARE_DISABLED");
  assert.deepEqual(switched.entries("a"), []);
  assert.deepEqual(switched.entries("b"), []);
  assert.equal(switched.stateValue("theme_memory_share_last_success_at"), null);
  // 分享尝试不额外改名单或数值；活动本身的精力消耗已在 afterActivity 中。
  assert.deepEqual(switched.controlSnapshot(), afterActivity);
  switched.store.memory.setAutoShareEnabled({ enabled: true });
  assert.deepEqual(switched.evaluate(), []);
  assert.deepEqual(switched.entries("a"), []);
});

test("POL-THEME-SHARE-004 私人内容不随主题外泄，禁分享/forget/source 阻止旧源回流", (t) => {
  const story = fixtureStory("story-private", ["fact-private-1"], {
    shareWithCharacterIds: ["b"],
  });
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });
  h.store.memory.remember({
    characterId: "a",
    factKey: "private.chat",
    body: "用户私下说过窗边的事，只告诉凛。",
    kind: "detail",
    sourceId: "chat:private",
  });
  h.store.memory.remember({
    characterId: "a",
    factKey: "analysis.work",
    body: "来源分析里的工作细节，不应转给角色。",
    kind: "detail",
    sourceId: "analysis:work",
  });

  h.completeDaily("private-a1");
  const applied = h.evaluate();
  assert.equal(applied[0].outcome, "applied");
  const aTheme = h.themeEntry("a");
  assert.ok(aTheme);
  assert.equal(h.entries("b").length, 1);
  assert.deepEqual(h.store.memory.searchMemories({ characterId: "b", query: "私下" }), []);
  assert.deepEqual(h.store.memory.searchMemories({ characterId: "b", query: "来源分析" }), []);
  assert.equal(h.entries("b")[0].fact_key, themeFactKey(story, "fact-private-1"));

  // 用户禁止分享该主题事实后，旧源重复投递被拒绝。
  h.store.memory.restrictSharing({
    characterId: "a",
    entryId: aTheme.id,
    expectedVersion: aTheme.version,
  });
  h.laterDaily("private-repeat-1");
  const restricted = h.manualRepeat(
    "private-repeat-1",
    appliedResult(story, 0, "private-repeat-1"),
  );
  assert.equal(restricted.outcome, "skipped");
  assert.equal(restricted.reason, "SHARE_BLOCKED");
  assert.equal(h.entries("b").length, 1);

  // 讲述者删除该事实后，来源控制阻止旧源重新学习；接收者副本一并清除。
  h.store.memory.forget({
    characterId: "a",
    entryId: aTheme.id,
    expectedVersion: aTheme.version,
  });
  assert.equal(h.themeEntry("a"), null);
  assert.deepEqual(h.entries("b"), []);
  h.laterDaily("private-repeat-2");
  const forgotten = h.manualRepeat(
    "private-repeat-2",
    appliedResult(story, 0, "private-repeat-2"),
  );
  assert.equal(forgotten.outcome, "skipped");
  assert.equal(forgotten.reason, "SOURCE_BLOCKED");
  assert.equal(h.themeEntry("a"), null);
  assert.deepEqual(h.entries("b"), []);

  // 派生记忆不能作为自动再转发源。
  const derivedStory = fixtureStory("story-derived", ["fact-derived-1"], {
    shareWithCharacterIds: ["b"],
  });
  const derived = makeHarness(t, { catalog: fixtureCatalog([derivedStory]) });
  const factKey = themeFactKey(derivedStory, "fact-derived-1");
  const shareBody = themeBody(derivedStory, 0);
  const seeded = derived.store.memory.remember({
    characterId: "b",
    factKey,
    body: shareBody,
    kind: "experience",
    sourceId: "seed:b",
  });
  derived.store.memory.share({
    fromCharacterId: "b",
    toCharacterId: "a",
    entryIds: [seeded.entry.id],
  });
  derived.completeDaily("derived-a1");
  assert.equal(derived.evaluate()[0].outcome, "applied");
  assert.equal(derived.shareRow("derived-a1").reason, "DERIVED_SOURCE");
  assert.equal(derived.entries("a").length, 1);
  assert.equal(derived.entries("a")[0].origin_character_id, "b");
  assert.equal(derived.entries("b").length, 1);
});

test("POL-THEME-SHARE-004B 用户纠正与接收者遗忘不被旧作者文案覆盖或再生", (t) => {
  // 既有同 factKey 已被用户纠正为不同正文：保守跳过，不删除用户正文。
  const correctedStory = fixtureStory("story-corrected", ["fact-corrected-1"], {
    shareWithCharacterIds: ["b"],
  });
  const corrected = makeHarness(t, { catalog: fixtureCatalog([correctedStory]) });
  const correctedKey = themeFactKey(correctedStory, "fact-corrected-1");
  corrected.store.memory.remember({
    characterId: "a",
    factKey: correctedKey,
    body: "用户纠正：凛现在更喜欢靠窗的软垫。",
    kind: "experience",
    sourceId: "user:correction",
  });
  corrected.completeDaily("corrected-a1");
  assert.equal(corrected.evaluate()[0].outcome, "applied");
  assert.equal(corrected.shareRow("corrected-a1").reason, "AUTHOR_BODY_CONFLICT");
  assert.equal(corrected.entries("a")[0].body, "用户纠正：凛现在更喜欢靠窗的软垫。");
  assert.deepEqual(corrected.entries("b"), []);
  assert.equal(corrected.stateValue("theme_memory_share_last_success_at"), null);

  // 分享后用户纠正：双方正文同步更新；旧源重复投递不覆盖、不再传播。
  const story = fixtureStory("story-receiver", ["fact-receiver-1"], {
    shareWithCharacterIds: ["b"],
  });
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });
  h.completeDaily("receiver-a1");
  const applied = h.evaluate();
  assert.equal(applied[0].outcome, "applied");
  const aEntry = h.themeEntry("a");
  const bEntry = h.themeEntry("b");
  h.store.memory.correct({
    characterId: "a",
    entryId: aEntry.id,
    expectedVersion: aEntry.version,
    body: "用户重新说明：凛只是把窗边留给来客。",
  });
  assert.equal(h.entries("a")[0].body, "用户重新说明：凛只是把窗边留给来客。");
  assert.equal(h.entries("b")[0].body, "用户重新说明：凛只是把窗边留给来客。");
  assert.equal(h.entries("a")[0].source_kind, "user");
  assert.equal(h.entries("b")[0].source_kind, "user");

  h.laterDaily("receiver-repeat-1");
  const repeat = h.manualRepeat(
    "receiver-repeat-1",
    appliedResult(story, 0, "receiver-repeat-1"),
  );
  assert.equal(repeat.outcome, "skipped");
  assert.ok(["SOURCE_BLOCKED", "AUTHOR_BODY_CONFLICT"].includes(repeat.reason));
  assert.equal(h.entries("a")[0].body, "用户重新说明：凛只是把窗边留给来客。");
  assert.equal(h.entries("b")[0].body, "用户重新说明：凛只是把窗边留给来客。");
  assert.equal(h.entries("b").length, 1);

  // 接收者只忘记自己的副本后，旧源也不能再次投递给她。
  const forgetStory = fixtureStory("story-recv-forget", ["fact-recv-forget-1"], {
    shareWithCharacterIds: ["b"],
  });
  const f = makeHarness(t, { catalog: fixtureCatalog([forgetStory]) });
  f.completeDaily("recv-forget-a1");
  const forgetApplied = f.evaluate();
  assert.equal(forgetApplied[0].outcome, "applied");
  const bCopy = f.themeEntry("b");
  f.store.memory.forget({
    characterId: "b",
    entryId: bCopy.id,
    expectedVersion: bCopy.version,
    scope: "self",
  });
  assert.deepEqual(f.entries("b"), []);
  assert.equal(f.entries("a").length, 1);
  f.laterDaily("recv-forget-repeat-1");
  const blocked = f.manualRepeat(
    "recv-forget-repeat-1",
    appliedResult(forgetStory, 0, "recv-forget-repeat-1"),
  );
  assert.equal(blocked.outcome, "skipped");
  assert.equal(blocked.reason, "SHARE_BLOCKED");
  assert.deepEqual(f.entries("b"), []);
  assert.equal(f.entries("a").length, 1);
});

test("POL-THEME-SHARE-004C 主题/故事/事实元组无歧义，不同合法组合不共用事实键", (t) => {
  // 旧分隔符拼接会让 a/b + c 与 a + b/c 生成同一 raw；JSON 元组必须保持不同。
  const first = fixtureStory("a/b", ["fact"], {
    themeId: "x",
    shareWithCharacterIds: ["b"],
  });
  const second = fixtureStory("b", ["fact"], {
    themeId: "x/a",
    shareWithCharacterIds: ["b"],
  });
  const h1 = makeHarness(t, { catalog: fixtureCatalog([first]) });
  h1.completeDaily("tuple-a1");
  h1.evaluate();
  const h2 = makeHarness(t, { catalog: fixtureCatalog([second]) });
  h2.completeDaily("tuple-a2");
  h2.evaluate();
  const key1 = h1.themeEntry("a").fact_key;
  const key2 = h2.themeEntry("a").fact_key;
  assert.ok(key1);
  assert.ok(key2);
  assert.notEqual(key1, key2);
});

test("POL-THEME-SHARE-004D 明确转告保留主题见闻性质与最初来源", (t) => {
  const story = storyFor("story-relay-theme", "fact-relay-theme");
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });
  h.completeDaily("relay-theme-a1");
  h.evaluate();
  const bEntry = h.themeEntry("b");
  assert.equal(bEntry.source_kind, "theme");
  const relayed = h.store.memory.relay({
    fromCharacterId: "b",
    toCharacterId: "c",
    entries: [{ entryId: bEntry.id, expectedVersion: bEntry.version }],
  });
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = h.themeEntry("c");
  assert.equal(cEntry.source_kind, "theme");
  const cList = h.store.memory.listMemories("c")[0];
  assert.equal(cList.sourceKind, "theme");
  assert.equal(cList.originCharacterId, "a");
  assert.equal(cList.narratorCharacterId, "b");
});

test("POL-THEME-SHARE-005 接收者写入与共享额度落库失败时整笔回滚，恢复后只成功一次", (t) => {
  const story = fixtureStory("story-fault", ["fact-fault-1"], {
    shareWithCharacterIds: ["b"],
  });
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });
  h.completeDaily("fault-a1");

  // 接收者写入阶段失败：故事进度、双方记忆/FTS/上下文与运行结果一起回滚。
  h.exec(`
    CREATE TEMP TRIGGER fail_theme_recipient
    BEFORE INSERT ON memory_entries
    WHEN NEW.character_id = 'b'
    BEGIN SELECT RAISE(ABORT, 'forced recipient failure'); END
  `);
  assert.throws(() => h.evaluate(), /forced recipient failure/);
  assertRolledBack(h, "fault-a1");
  h.exec("DROP TRIGGER fail_theme_recipient");

  // 共享成功记录落库阶段失败：同样整笔回滚，不留下故事已成功的半状态。
  h.exec(`
    CREATE TEMP TRIGGER fail_theme_quota
    BEFORE INSERT ON theme_memory_shares
    BEGIN SELECT RAISE(ABORT, 'forced quota failure'); END
  `);
  assert.throws(() => h.evaluate(), /forced quota failure/);
  assertRolledBack(h, "fault-a1");
  h.exec("DROP TRIGGER fail_theme_quota");

  // 恢复后同活动重试一次成功；再评估不重复投递。
  const recovered = h.evaluate();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "applied");
  assert.equal(h.shareRow("fault-a1").outcome, "shared");
  assert.equal(h.entries("a").length, 1);
  assert.equal(h.entries("b").length, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM memory_fts").n, 2);
  assert.equal(h.store.memory.getContextVersion("a"), 1);
  assert.equal(h.store.memory.getContextVersion("b"), 1);
  assert.ok(h.stateValue("theme_memory_share_last_success_at"));
  assert.ok(h.stateValue("theme_memory_share_max_logical_at"));

  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.shareCount(), 1);
  assert.equal(h.entries("a").length, 1);
  assert.equal(h.entries("b").length, 1);

  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.shareCount(), 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM memory_entries").n, 2);
});

test("POL-THEME-SHARE-006 快照AppError不消费活动，恢复后同活动只成功一次", (t) => {
  const story = storyFor("story-snapshot", "fact-snapshot-1");
  const h = makeHarness(t, { catalog: fixtureCatalog([story]) });
  h.completeDaily("snapshot-a1");

  // 快照读取抛出 AppError：不能落入 recordNode 的领域拒绝分支永久消费活动。
  h.failNextShareContext();
  assert.throws(
    () => h.evaluate(),
    (error) => error instanceof AppError && error.code === "SNAPSHOT_UNAVAILABLE",
  );
  assertRolledBack(h, "snapshot-a1");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_runtime_activity_results").n, 0);

  // 快照恢复后同一活动只成功一次；再次心跳不重复。
  const recovered = h.evaluate();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].activityId, "snapshot-a1");
  assert.equal(recovered[0].outcome, "applied");
  assert.equal(h.shareRow("snapshot-a1").outcome, "shared");
  assert.equal(h.shareRow("snapshot-a1").recipient_id, "b");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_runtime_activity_results").n, 1);
  assert.equal(h.entries("a").length, 1);
  assert.equal(h.entries("b").length, 1);

  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.shareCount(), 1);
  assert.equal(h.entries("a").length, 1);
  assert.equal(h.entries("b").length, 1);
});
