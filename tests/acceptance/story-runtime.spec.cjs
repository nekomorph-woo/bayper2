/* S06i 正式验收：真实 SQLite、正式 companionship 完成活动、store 组装的故事/
   发现入口与小故事运行入口。作者目录均为构造 fixture；测试内“已发布”副本只
   存在于内存，不写回 app/content/maid-stories.json。不启动 GUI 或真实模型。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createStore, INITIAL_STATS } = require("../../app/store.cjs");
const { INITIAL_STATS: INITIAL_STATS_SOURCE } = require("../../app/initial-stats.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");
const { createStoryRuntime } = require("../../app/story-runtime.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const CONTENT_PATH = path.join(__dirname, "..", "..", "app", "content", "maid-stories.json");
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

function fixtureCatalog(stories) {
  return { schemaVersion: 1, theme: { id: "fixture-theme", name: "测试主题" }, stories };
}

function publishedOfficial(assetAvailable = true) {
  const catalog = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8"));
  catalog.stories.forEach((story) => {
    story.assetAvailable = assetAvailable;
  });
  return catalog;
}

function throwsCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-story-runtime-"));
  const clock = { ms: options.start ?? START };
  let catalog = options.catalog ?? fixtureCatalog([]);
  let store;
  let service;
  let runtime = null;
  let seeded = false;
  let runtimeEnabled = options.runtime !== false;
  const acceptedId = options.acceptedId ?? "a";

  function open() {
    store = createStore(dir, {
      storyCatalog: catalog,
      now: () => clock.ms,
    });
    if (!seeded) {
      store.acceptCharacter({
        characterId: acceptedId,
        day: localDay(clock.ms),
        acceptedAt: new Date(clock.ms).toISOString(),
      });
      if (options.withPartner) {
        seedPartner();
      }
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

  function seedPartner() {
    store.db
      .prepare("INSERT INTO relationships (character_id, accepted_at) VALUES ('b', ?)")
      .run(new Date(clock.ms).toISOString());
    store.db
      .prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES ('b', 10, 100, 0)
      `)
      .run();
    store.db
      .prepare(`
        INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
        VALUES ('b', 'waiting', ?, 0)
      `)
      .run(clock.ms);
    store.db
      .prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'random_1', 'b')")
      .run(localDay(clock.ms));
  }

  function startRuntime() {
    runtime = createStoryRuntime({
      db: store.db,
      store,
      storyProgress: store.storyProgress,
      discoveryOutcomes: store.discoveryOutcomes,
      now: () => clock.ms,
    });
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
    exec: (sql) => store.db.exec(sql),
    advance: (ms) => {
      clock.ms += ms;
    },
    setClock: (ms) => {
      clock.ms = ms;
    },
    activity: (activityId) =>
      store.db
        .prepare("SELECT * FROM character_activities WHERE activity_id = ?")
        .get(activityId),
    useCatalog: (next) => {
      catalog = next;
    },
    startRuntime: () => {
      runtimeEnabled = true;
      startRuntime();
    },
    evaluate: () => runtime.evaluate(),
    reopen: () => {
      store.close();
      open();
    },
    snapshot: () => ({
      state: h.all("SELECT * FROM app_state ORDER BY key"),
      relationships: h.all("SELECT * FROM relationships ORDER BY character_id"),
      stats: h.all("SELECT * FROM character_stats ORDER BY character_id"),
      runtime: h.all("SELECT * FROM character_runtime ORDER BY character_id"),
      roster: h.all("SELECT * FROM roster ORDER BY day, slot"),
      interactions: h.all("SELECT * FROM interactions"),
    }),
    switchTo: (characterId = acceptedId) => service.switchTo(characterId),
    // 跨日沿用陪伴既有规则：休息恢复精力后回到同一角色，避免把低精力当成故事差异。
    nextDay: (characterId = acceptedId) => {
      service.rest();
      clock.ms += DAY;
      service.switchTo(characterId);
    },
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
      // 探索启动时若主角仍在同屏，需要有可接班角色；切换后主角不在同屏即可。
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
  };

  open();
  t.after(() => {
    try {
      store?.close();
    } catch {
      // store 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("POL-STORYRUN-001 日常/探索经同一入口各消费一次，重启续接且无额外变化", (t) => {
  const story = fixtureStory("char-run", "character", "u1", ["fact-run-1", "fact-run-2"]);
  const h = makeHarness(t, {
    catalog: fixtureCatalog([story]),
    withPartner: true,
  });

  // 未开始/取消的活动不进入故事；也不会被后续心跳补算。
  const scheduled = h.service.requestActivity({
    activityId: "run-cancelled",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(scheduled.requested, true);
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.service.cancelActivity("run-cancelled").cancelled, true);
  assert.deepEqual(h.evaluate(), []);

  h.completeDaily("run-daily-1");
  const afterComplete = h.snapshot();
  const first = h.evaluate();
  assert.equal(first.length, 1);
  assert.equal(first[0].activityId, "run-daily-1");
  assert.equal(first[0].outcome, "applied");
  assert.equal(first[0].storyId, "char-run");
  assert.equal(h.store.storyProgress.getProgress("char-run").nextNodeIndex, 1);
  assert.equal(h.store.storyProgress.getProgress("char-run").progressStatus, "active");
  assert.deepEqual(
    h.all("SELECT fact_id, activity_id FROM story_fact_sources ORDER BY fact_id").map((row) => ({
      ...row,
    })),
    [{ fact_id: "fact-run-1", activity_id: "run-daily-1" }],
  );
  // 故事运行本身不改名单、数值、当前角色或互动。
  assert.deepEqual(h.snapshot(), afterComplete);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u1'").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);

  // 同一心跳重复以及真正重启都不重复推进。
  assert.deepEqual(h.evaluate(), []);
  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.store.storyProgress.getProgress("char-run").nextNodeIndex, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);

  // 合法跨日后的探索仍是同一故事的第二节点来源。
  h.nextDay();
  h.completeExploration("run-exploration-1");
  const afterExploration = h.snapshot();
  const second = h.evaluate();
  assert.equal(second.length, 1);
  assert.equal(second[0].activityId, "run-exploration-1");
  assert.equal(second[0].outcome, "applied");
  const progress = h.store.storyProgress.getProgress("char-run");
  assert.equal(progress.progressStatus, "mature");
  assert.deepEqual(
    h.all("SELECT fact_id, activity_id FROM story_fact_sources ORDER BY fact_id").map((row) => ({
      ...row,
    })),
    [
      { fact_id: "fact-run-1", activity_id: "run-daily-1" },
      { fact_id: "fact-run-2", activity_id: "run-exploration-1" },
    ],
  );
  assert.deepEqual(h.snapshot(), afterExploration);
});

test("POL-STORYRUN-002 跨日两类故事复用冷却、过滤与内容耗尽，不重复事实", (t) => {
  const catalog = fixtureCatalog([
    fixtureStory("char-one", "character", "u1", ["fact-c1-1", "fact-c1-2"]),
    fixtureStory("char-two", "character", "u2", ["fact-c2-1"]),
    fixtureStory("outfit-one", "outfit", "outfit-1", ["fact-o1"], {
      ownerCharacterId: "a",
    }),
  ]);
  const h = makeHarness(t, { catalog });

  h.completeDaily("c1-a1");
  assert.equal(h.evaluate()[0].outcome, "applied");
  h.nextDay();
  h.completeDaily("c1-a2");
  assert.equal(h.evaluate()[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("char-one").progressStatus, "mature");

  // 仅 prepare 即形成待邀请过滤，不调用显示 ACK。
  const prepared = h.store.discoveryOutcomes.prepareInvitation({ storyId: "char-one" });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.invitation.displayedAt, null);
  assert.deepEqual(h.store.discoveryOutcomes.getStorySelectionFilters(), {
    pendingInvitationTargetId: "u1",
    rejectedTargetIds: [],
  });

  // 待邀请阻止新角色故事，但服装故事仍可推进且不改变角色目标。
  h.nextDay();
  h.completeDaily("c1-a3");
  const outfitResult = h.evaluate();
  assert.equal(outfitResult[0].outcome, "applied");
  assert.equal(outfitResult[0].storyId, "outfit-one");
  assert.equal(h.store.storyProgress.getProgress("char-one").nextNodeIndex, 2);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress WHERE story_id = 'char-two'").n, 0);

  // 拒绝后同目标不再自动成为候选，但仍不立即替补；下一天按目录顺序开下一个角色。
  h.store.discoveryOutcomes.rejectInvitation({
    invitationId: prepared.invitation.invitationId,
  });
  assert.deepEqual(h.store.discoveryOutcomes.getStorySelectionFilters(), {
    pendingInvitationTargetId: null,
    rejectedTargetIds: ["u1"],
  });
  h.nextDay();
  h.completeDaily("c1-a4");
  const next = h.evaluate();
  assert.equal(next[0].storyId, "char-two");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress WHERE story_id = 'char-one'").n, 1);

  // 重复心跳不新增事实，也不改变已选目标。
  const factsBefore = h.all("SELECT * FROM story_facts ORDER BY fact_id");
  const resultsBefore = h.all("SELECT * FROM story_runtime_activity_results ORDER BY activity_id");
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(h.all("SELECT * FROM story_facts ORDER BY fact_id"), factsBefore);
  assert.deepEqual(
    h.all("SELECT * FROM story_runtime_activity_results ORDER BY activity_id"),
    resultsBefore,
  );

  // 所有故事成熟后安静跳过，不捏造内容。
  h.nextDay();
  h.completeDaily("c1-a5");
  const exhausted = h.evaluate();
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].outcome, "skipped");
  assert.equal(exhausted[0].reason, "NO_STORY_CANDIDATE");
  assert.deepEqual(h.all("SELECT * FROM story_facts ORDER BY fact_id"), factsBefore);
});

test("POL-STORYRUN-003 正式目录不发布、测试内发布与资源下架恢复均明确", (t) => {
  const official = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8"));
  assert.equal(official.stories.every((story) => story.assetAvailable === false), true);

  const blocked = makeHarness(t, { catalog: official });
  blocked.completeDaily("official-a1");
  const skipped = blocked.evaluate();
  assert.equal(skipped[0].outcome, "skipped");
  assert.equal(skipped[0].reason, "NO_STORY_CANDIDATE");
  assert.equal(blocked.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
  assert.equal(blocked.one("SELECT COUNT(*) AS n FROM story_facts").n, 0);
  assert.equal(blocked.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);
  assert.equal(blocked.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);

  // 测试内“已发布”副本只存在内存，正式文件仍为 false。
  const published = publishedOfficial(true);
  assert.equal(JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8")).stories
    .every((story) => story.assetAvailable === false), true);

  const h = makeHarness(t, { catalog: published, acceptedId: "rin" });
  h.completeDaily("pub-a1");
  const applied = h.evaluate();
  assert.equal(applied[0].outcome, "applied");
  assert.equal(applied[0].storyId, "maid.meet.hu");
  assert.equal(h.store.storyProgress.getProgress("maid.meet.hu").nextNodeIndex, 1);

  // 资源下架：旧进度保留但不再推进，也不换目标。
  const unavailable = publishedOfficial(false);
  h.useCatalog(unavailable);
  h.reopen();
  const retained = h.store.storyProgress.getProgress("maid.meet.hu");
  assert.equal(retained.available, false);
  assert.equal(retained.reason, "ASSET_UNAVAILABLE");
  assert.equal(retained.nextNodeIndex, 1);
  h.nextDay();
  h.completeDaily("pub-a2");
  const blockedByAsset = h.evaluate();
  assert.equal(blockedByAsset[0].outcome, "skipped");
  assert.equal(blockedByAsset[0].reason, "ASSET_UNAVAILABLE");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts WHERE story_id = 'maid.meet.hu'").n, 1);

  // 恢复后继续同一 story/node，不重新分配历史。
  h.useCatalog(published);
  h.reopen();
  assert.equal(h.store.storyProgress.getProgress("maid.meet.hu").reason, null);
  h.nextDay();
  h.completeDaily("pub-a3");
  const resumed = h.evaluate();
  assert.equal(resumed[0].outcome, "applied");
  assert.equal(resumed[0].nodeId, "return");
  assert.equal(h.store.storyProgress.getProgress("maid.meet.hu").progressStatus, "mature");

  // 准备邀请不等于展示或接纳。
  const invite = h.store.discoveryOutcomes.prepareInvitation({
    storyId: "maid.meet.hu",
  });
  assert.equal(invite.prepared, true);
  assert.equal(invite.invitation.status, "prepared");
  assert.equal(invite.invitation.displayedAt, null);
  assert.equal(invite.invitation.quotaAt, null);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'hu'").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);

  // 服装目录单独构造，确认成熟后在当次运行自动归属，不会被角色故事饿死。
  const outfitOnly = fixtureCatalog([
    fixtureStory("outfit-run", "outfit", "outfit-1", ["fact-of-1"], {
      ownerCharacterId: "a",
    }),
  ]);
  const o = makeHarness(t, { catalog: outfitOnly });
  o.completeDaily("of-a1");
  assert.equal(o.evaluate()[0].storyId, "outfit-run");
  assert.equal(o.store.storyProgress.getProgress("outfit-run").progressStatus, "mature");
  const stateBefore = o.snapshot();
  const ownership = o.store.discoveryOutcomes.getOutfitOwnership({
    storyId: "outfit-run",
  });
  assert.equal(ownership.outfitId, "outfit-1");
  assert.equal(ownership.notificationPending, true);
  // 已自动解锁，手动再调用不重复占额，也不改状态。
  assert.deepEqual(o.store.discoveryOutcomes.unlockNextOutfit(), {
    unlocked: false,
    reason: "OUTFIT_QUOTA",
    outfit: null,
  });
  assert.deepEqual(o.snapshot(), stateBefore);
});

test("POL-STORYRUN-004 首次接线基线、重启/回拨与写入失败重试保持幂等", (t) => {
  const catalog = fixtureCatalog([
    fixtureStory("char-base", "character", "u1", ["fact-b1", "fact-b2"]),
    fixtureStory("char-fault", "character", "u2", ["fact-f1"]),
  ]);
  const h = makeHarness(t, { catalog, runtime: false });

  // 升级前已存在的完成活动只记为历史跳过，不补线索。
  h.completeDaily("old-a1");
  h.startRuntime();
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 0);
  assert.deepEqual(
    { ...h.one("SELECT story_id, node_id, outcome, reason FROM story_runtime_activity_results WHERE activity_id = 'old-a1'") },
    { story_id: null, node_id: null, outcome: "skipped", reason: "HISTORICAL_BASELINE" },
  );

  // 接线后真实完成的活动产生一次新机会（间隔满足既有 daily 频率）。
  h.advance(HOUR);
  h.completeDaily("new-a1");
  assert.equal(h.evaluate()[0].outcome, "applied");
  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);

  // 回拨时钟不会重置额度：先完成再回拨，活动被消费为额度跳过且无新事实。
  h.advance(HOUR);
  h.completeDaily("rollback-a1");
  h.setClock(START - HOUR);
  const rolled = h.evaluate();
  assert.equal(rolled[0].outcome, "skipped");
  assert.equal(rolled[0].reason, "QUOTA");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(
    h.one("SELECT outcome, reason FROM story_runtime_activity_results WHERE activity_id = 'rollback-a1'").outcome,
    "skipped",
  );

  // 回到合法间隔后继续原故事节点；休息恢复精力，避免把低精力误判成故事规则。
  h.service.rest();
  h.setClock(START + 25 * HOUR + MINUTE);
  h.switchTo("a");
  h.completeDaily("new-a2");
  assert.equal(h.evaluate()[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("char-base").progressStatus, "mature");

  // 写入故障回滚活动评估；修复后同活动重试一次成功并留下证据。
  h.nextDay();
  h.advance(MINUTE);
  h.completeDaily("fault-a1");
  h.exec(`
    CREATE TRIGGER fail_story_fact
    BEFORE INSERT ON story_facts
    BEGIN SELECT RAISE(ABORT, 'forced story failure'); END
  `);
  assert.throws(() => h.evaluate(), /forced story failure/);
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_runtime_activity_results WHERE activity_id = 'fault-a1'").n,
    0,
  );
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_activity_results WHERE activity_id = 'fault-a1'").n,
    0,
  );
  assert.equal(h.activity("fault-a1").status, "completed");
  h.exec("DROP TRIGGER fail_story_fact");
  const retried = h.evaluate();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].activityId, "fault-a1");
  assert.equal(retried[0].outcome, "applied");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_runtime_activity_results WHERE activity_id = 'fault-a1'").n,
    1,
  );
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_fact_sources WHERE activity_id = 'fault-a1'").n,
    1,
  );
  assert.deepEqual(h.evaluate(), []);
});

test("POL-STORYRUN-004B 单节点最后故事的运行结果写入失败整笔回滚，重开重试保持同一结果", (t) => {
  const h = makeHarness(t, {
    catalog: fixtureCatalog([
      fixtureStory("char-last", "character", "u9", ["fact-last"]),
    ]),
  });
  // 临时触发器只作用于当前连接：制造最后一笔运行结果写入失败，关库后自然消失。
  h.exec(`
    CREATE TEMP TRIGGER fail_runtime_result
    BEFORE INSERT ON story_runtime_activity_results
    BEGIN SELECT RAISE(ABORT, 'forced runtime result failure'); END
  `);
  h.completeDaily("atomic-a1");
  assert.throws(() => h.evaluate(), /forced runtime result failure/);

  // 故事进度、事实、来源、领域评估与运行结果必须一起回滚。
  for (const table of [
    "story_progress",
    "story_facts",
    "story_fact_sources",
    "story_activity_results",
  ]) {
    assert.equal(h.one(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM story_runtime_activity_results WHERE activity_id = 'atomic-a1'").n,
    0,
  );

  // 关库重开后临时触发器消失；同一活动重试仍选中同一故事与节点。
  h.reopen();
  const retried = h.evaluate();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].activityId, "atomic-a1");
  assert.equal(retried[0].outcome, "applied");
  assert.equal(retried[0].storyId, "char-last");
  assert.equal(retried[0].nodeId, "char-last-node-1");
  const progress = h.store.storyProgress.getProgress("char-last");
  assert.equal(progress.targetId, "u9");
  assert.equal(progress.progressStatus, "mature");
  assert.equal(progress.nextNodeIndex, 1);
  assert.deepEqual(
    h.all("SELECT fact_id, activity_id FROM story_fact_sources ORDER BY fact_id").map((row) => ({
      ...row,
    })),
    [{ fact_id: "fact-last", activity_id: "atomic-a1" }],
  );
  assert.deepEqual(
    {
      ...h.one(`
        SELECT story_id, node_id, outcome, reason
        FROM story_runtime_activity_results WHERE activity_id = 'atomic-a1'
      `),
    },
    {
      story_id: "char-last",
      node_id: "char-last-node-1",
      outcome: "applied",
      reason: null,
    },
  );
  assert.equal(
    h.one("SELECT outcome FROM story_activity_results WHERE activity_id = 'atomic-a1'").outcome,
    "applied",
  );
  assert.deepEqual(h.evaluate(), []);
});

test("POL-STORYRUN-005 成熟后准备邀请/解锁归属不等于展示、接纳或穿用", (t) => {
  // 默认数值仍只有一个来源，store 导出与独立常量是同一对象。
  assert.equal(INITIAL_STATS, INITIAL_STATS_SOURCE);
  const catalog = fixtureCatalog([
    fixtureStory("char-meet", "character", "u1", ["fact-m1", "fact-m2"]),
    fixtureStory("outfit-meet", "outfit", "outfit-1", ["fact-mo1", "fact-mo2"], {
      ownerCharacterId: "a",
    }),
  ]);
  const h = makeHarness(t, { catalog });

  // 角色故事两节点成熟。
  h.completeDaily("meet-a1");
  assert.equal(h.evaluate()[0].outcome, "applied");
  h.nextDay();
  h.completeDaily("meet-a2");
  assert.equal(h.evaluate()[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("char-meet").progressStatus, "mature");

  // 服装故事两节点成熟（角色故事成熟后按目录继续推进服装）。
  h.nextDay();
  h.completeDaily("meet-a3");
  const outfitFirst = h.evaluate();
  assert.equal(outfitFirst[0].storyId, "outfit-meet");
  h.nextDay();
  h.completeDaily("meet-a4");
  assert.equal(h.evaluate()[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("outfit-meet").progressStatus, "mature");

  const beforePrepare = h.snapshot();
  const invite = h.store.discoveryOutcomes.prepareInvitation({ storyId: "char-meet" });
  assert.equal(invite.prepared, true);
  assert.equal(invite.invitation.status, "prepared");
  assert.equal(invite.invitation.displayedAt, null);
  assert.equal(invite.invitation.quotaAt, null);
  // 未展示不能接纳，且不写关系、数值、运行态或名单。
  throwsCode(
    () =>
      h.store.discoveryOutcomes.acceptInvitation({
        invitationId: invite.invitation.invitationId,
      }),
    "INVITATION_NOT_DISPLAYED",
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'u1'").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_stats WHERE character_id = 'u1'").n, 0);

  // 成熟当次运行已自动归属；手动再调用不重复占额。
  const ownership = h.store.discoveryOutcomes.getOutfitOwnership({
    storyId: "outfit-meet",
  });
  assert.equal(ownership.outfitId, "outfit-1");
  assert.equal(ownership.notificationPending, true);
  const beforeUnlock = h.snapshot();
  assert.deepEqual(h.store.discoveryOutcomes.unlockNextOutfit(), {
    unlocked: false,
    reason: "OUTFIT_QUOTA",
    outfit: null,
  });
  // 解锁不写当前服装、不改名单或陪伴安排。
  assert.deepEqual(h.snapshot(), beforeUnlock);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM app_state WHERE key LIKE '%outfit%'").n, 0);
  assert.deepEqual(h.snapshot().roster, beforePrepare.roster);

  // 重启后已准备/已归属结果保留，故事不重复推进。
  h.reopen();
  const duplicates = h.evaluate();
  assert.deepEqual(duplicates, []);
  assert.equal(
    h.store.discoveryOutcomes.prepareInvitation({ storyId: "char-meet" }).duplicate,
    true,
  );
  assert.equal(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-meet" })
      .notificationPending,
    true,
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 4);
});

test("POL-OUTFITRUN-001 服装成熟当次运行自动归属一次，不改关系/名单/数值", (t) => {
  const h = makeHarness(t, {
    catalog: fixtureCatalog([
      fixtureStory("outfit-auto", "outfit", "outfit-auto-1", ["fact-auto-1", "fact-auto-2"], {
        ownerCharacterId: "a",
      }),
    ]),
  });

  // 未成熟的故事不产生归属。
  h.completeDaily("auto-a1");
  assert.equal(h.evaluate()[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("outfit-auto").progressStatus, "active");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);

  h.nextDay();
  h.completeDaily("auto-a2");
  // 用正式记忆入口种入一条既有内容，确认自动归属不会静默改写已有记忆。
  const seeded = h.store.memory.remember({
    characterId: "a",
    factKey: "fixture.outfit-keepsake",
    body: "用户喜欢在雨后整理衣橱。",
    kind: "preference",
    sourceId: "chat:s06k-001",
  });
  assert.equal(seeded.created, true);
  assert.equal(h.store.memory.listMemories("a")[0].body, "用户喜欢在雨后整理衣橱。");
  const beforeEvaluate = h.snapshot();
  // 既有 snapshot 只覆盖陪伴状态；对全部 memory 表比较完整行内容，而非只比条数。
  const memorySnapshot = () =>
    Object.fromEntries(
      h
        .all(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'memory%' ORDER BY name
        `)
        .map(({ name }) => {
          // WITHOUT ROWID 的 FTS 影子表没有 rowid，统一按全部列排序保证稳定。
          const columns = h
            .all(`PRAGMA table_info("${name}")`)
            .map((column) => `"${column.name}"`);
          const order = columns.length ? ` ORDER BY ${columns.join(", ")}` : "";
          return [
            name,
            h.all(`SELECT * FROM "${name}"${order}`).map((row) => ({ ...row })),
          ];
        }),
    );
  const memoryBefore = memorySnapshot();
  const matured = h.evaluate();
  assert.equal(matured.length, 1);
  assert.equal(matured[0].outcome, "applied");
  assert.equal(h.store.storyProgress.getProgress("outfit-auto").progressStatus, "mature");

  // 同一次运行自动写入唯一归属，来源活动与所属角色正确；没有手动 unlock 调用。
  const ownership = h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-auto" });
  assert.equal(ownership.outfitId, "outfit-auto-1");
  assert.equal(ownership.ownerCharacterId, "a");
  assert.equal(ownership.sourceActivityId, "auto-a2");
  assert.equal(ownership.notificationPending, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 1);
  // 自动归属不改关系、数值、运行态、名单、互动、当前角色或任何记忆表。
  assert.deepEqual(h.snapshot(), beforeEvaluate);
  assert.deepEqual(memorySnapshot(), memoryBefore);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = 'a'").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);

  // 重复评估与重开不重复归属，也不改解锁时间或既有记忆内容。
  assert.deepEqual(h.evaluate(), []);
  h.reopen();
  assert.deepEqual(memorySnapshot(), memoryBefore);
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(memorySnapshot(), memoryBefore);
  assert.deepEqual(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-auto" }),
    ownership,
  );
});

test("POL-OUTFITRUN-002 72 小时额度边界前不重复解锁，边界后无新活动也解锁一次", (t) => {
  const catalog = fixtureCatalog([
    fixtureStory("outfit-wheel-1", "outfit", "outfit-wheel-1-i", ["fact-wheel-1"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("outfit-wheel-2", "outfit", "outfit-wheel-2-i", ["fact-wheel-2"], {
      ownerCharacterId: "a",
    }),
  ]);
  const h = makeHarness(t, { catalog });

  h.completeDaily("wheel-a1");
  assert.equal(h.evaluate()[0].storyId, "outfit-wheel-1");
  const firstOwned = h.store.discoveryOutcomes.getOutfitOwnership({
    storyId: "outfit-wheel-1",
  });
  assert.equal(firstOwned.notificationPending, true);

  // 第二个故事成熟时滚动窗口内已有一次归属，不能连续解锁。
  h.nextDay();
  h.completeDaily("wheel-a2");
  assert.equal(h.evaluate()[0].storyId, "outfit-wheel-2");
  assert.equal(h.store.storyProgress.getProgress("outfit-wheel-2").progressStatus, "mature");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 1);

  const activitiesBefore = h.one("SELECT COUNT(*) AS n FROM character_activities").n;
  const factsBefore = h.one("SELECT COUNT(*) AS n FROM story_facts").n;

  // 边界前 1ms 仍受额度限制；没有新增活动。
  h.setClock(firstOwned.unlockedAt + 72 * HOUR - 1);
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 1);

  // 恰好到 72 小时边界后，无新增活动也会补解锁一次。
  h.setClock(firstOwned.unlockedAt + 72 * HOUR);
  assert.deepEqual(h.evaluate(), []);
  const secondOwned = h.store.discoveryOutcomes.getOutfitOwnership({
    storyId: "outfit-wheel-2",
  });
  assert.equal(secondOwned.unlockedAt, firstOwned.unlockedAt + 72 * HOUR);
  assert.equal(secondOwned.notificationPending, true);

  // 重复、重开与再次评估不重复解锁、不改时间、不补活动或线索。
  assert.deepEqual(h.evaluate(), []);
  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-wheel-2" }),
    secondOwned,
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 2);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_activities").n, activitiesBefore);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, factsBefore);
});

test("POL-OUTFITRUN-003A 素材下架时成熟进度保留且不解锁，恢复后下一心跳解锁", (t) => {
  const base = fixtureStory("outfit-gate", "outfit", "outfit-gate-i", ["fact-gate-1"], {
    ownerCharacterId: "b",
  });
  const h = makeHarness(t, {
    catalog: fixtureCatalog([base]),
    runtime: false,
    withPartner: true,
  });
  // 先按正式进度入口形成成熟故事；归属角色 b 已有完整关系状态。
  const activity = h.completeDaily("gate-a1");
  h.store.storyProgress.recordNode({
    activityId: activity.activity_id,
    narratorId: "a",
    storyId: "outfit-gate",
    nodeId: "outfit-gate-node-1",
  });
  assert.equal(h.store.storyProgress.getProgress("outfit-gate").progressStatus, "mature");

  // 素材下架：成熟故事保留，但下一心跳不解锁。
  h.useCatalog(fixtureCatalog([{ ...base, assetAvailable: false }]));
  h.reopen();
  h.startRuntime();
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.equal(h.store.storyProgress.getProgress("outfit-gate").progressStatus, "mature");
  assert.equal(h.store.storyProgress.getProgress("outfit-gate").available, false);

  // 素材恢复后的下一次正常运行解锁，无需新增活动。
  h.useCatalog(fixtureCatalog([base]));
  h.reopen();
  assert.equal(h.store.storyProgress.getProgress("outfit-gate").available, true);
  assert.deepEqual(h.evaluate(), []);
  const owned = h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-gate" });
  assert.equal(owned.ownerCharacterId, "b");
  assert.equal(owned.sourceActivityId, "gate-a1");
  assert.equal(owned.notificationPending, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_activities").n, 1);
});

test("POL-OUTFITRUN-003B 归属写入失败不丢成熟进度，下次心跳只重试一次", (t) => {
  const h = makeHarness(t, {
    catalog: fixtureCatalog([
      fixtureStory("outfit-fault", "outfit", "outfit-fault-i", ["fact-ofault-1"], {
        ownerCharacterId: "a",
      }),
    ]),
  });
  h.exec(`
    CREATE TEMP TRIGGER fail_ownership
    BEFORE INSERT ON discovery_outfit_ownership
    BEGIN SELECT RAISE(ABORT, 'forced ownership failure'); END
  `);
  h.completeDaily("ofault-a1");
  assert.throws(() => h.evaluate(), /forced ownership failure/);

  // 活动评估与成熟进度照常落库，归属没有半记录。
  assert.equal(h.store.storyProgress.getProgress("outfit-fault").progressStatus, "mature");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(
    h.one(
      "SELECT outcome FROM story_runtime_activity_results WHERE activity_id = 'ofault-a1'",
    ).outcome,
    "applied",
  );
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);

  // 故障消失后，不消耗新活动，下一次心跳补做一次归属。
  h.exec("DROP TRIGGER fail_ownership");
  assert.deepEqual(h.evaluate(), []);
  const owned = h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-fault" });
  assert.equal(owned.notificationPending, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.deepEqual(h.evaluate(), []);
  h.reopen();
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-fault" }),
    owned,
  );
});

test("POL-OUTFITRUN-003C 归属角色未结识时不解锁，恢复资格后无新活动下一心跳解锁", (t) => {
  const base = fixtureStory("outfit-unmet", "outfit", "outfit-unmet-i", ["fact-unmet-1"], {
    ownerCharacterId: "b",
  });
  const h = makeHarness(t, { catalog: fixtureCatalog([base]), runtime: false });

  // 合法构造：活动先由已接纳的 a 完成，再临时补上 owner b 的关系行让故事
  // 按正式入口成熟，随后移除该关系行，模拟“故事已成熟但归属角色当前未结识”。
  // b 没有数值、运行态、名单或记忆等子行，所以删除关系行不触发外键约束。
  const activity = h.completeDaily("unmet-a1");
  h.exec(
    "INSERT INTO relationships (character_id, accepted_at) VALUES ('b', '2026-10-26T12:00:00.000Z')",
  );
  h.store.storyProgress.recordNode({
    activityId: activity.activity_id,
    narratorId: "a",
    storyId: "outfit-unmet",
    nodeId: "outfit-unmet-node-1",
  });
  assert.equal(h.store.storyProgress.getProgress("outfit-unmet").progressStatus, "mature");
  h.exec("DELETE FROM relationships WHERE character_id = 'b'");
  h.startRuntime();

  // 没有新活动：成熟进度保留，但归属角色未结识时不解锁。
  assert.deepEqual(h.evaluate(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  const progress = h.store.storyProgress.getProgress("outfit-unmet");
  assert.equal(progress.progressStatus, "mature");
  assert.equal(progress.available, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_activities").n, 1);

  // 资格恢复后，下一次正常运行即解锁，不需要新活动或手动 unlock。
  h.exec(
    "INSERT INTO relationships (character_id, accepted_at) VALUES ('b', '2026-10-28T12:00:00.000Z')",
  );
  assert.deepEqual(h.evaluate(), []);
  const owned = h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-unmet" });
  assert.equal(owned.ownerCharacterId, "b");
  assert.equal(owned.sourceActivityId, "unmet-a1");
  assert.equal(owned.notificationPending, true);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM character_activities").n, 1);

  // 重复评估不重复解锁、不改变归属时间。
  assert.deepEqual(h.evaluate(), []);
  assert.deepEqual(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: "outfit-unmet" }),
    owned,
  );
});
