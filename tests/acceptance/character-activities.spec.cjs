/* S06c 正式验收：真实 createStore/SQLite/companionship，仅注入时间与随机数。
   覆盖 POL-ACTIVITY-001～008；不覆盖 GUI、真实模型、主进程定时器或故事生成。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const LATE_START = new Date(2026, 9, 26, 23, 50, 0).getTime();
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const CANDIDATES = ["a", "b", "c", "d"].map((id) => ({
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

function openDb(file, readOnly = false) {
  return readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function near(actual, expected, epsilon = 0.002) {
  assert.ok(
    Math.abs(Number(actual) - expected) <= epsilon,
    `预期 ${expected}，实际 ${actual}`,
  );
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-activity-"));
  const dbFile = path.join(dir, "bayper.sqlite3");
  const ids = options.ids ?? ["a", "b"];
  const start = options.start ?? START;
  const currentId = options.currentId ?? ids[0];
  const rosterIds = options.rosterIds ?? ids.slice(0, 5);
  const clock = { ms: start };

  createStore(dir).close();
  const seed = openDb(dbFile);
  try {
    seed.exec("PRAGMA foreign_keys = ON");
    for (const characterId of ids) {
      seed.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        characterId,
        new Date(start).toISOString(),
      );
      seed.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(characterId, options.energy?.[characterId] ?? 100);
    }
    setState(seed, "fixed_character_id", ids[0]);
    setState(seed, "current_character_id", currentId);
    setState(seed, "current_mode", "companion");
    setState(seed, "pending_rotation", "0");
    setState(seed, "last_active_at", clock.ms);
    rosterIds.forEach((characterId, index) => {
      seed.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(start),
        SLOTS[index],
        characterId,
      );
    });
    for (const characterId of ids) {
      seed.prepare(`
        INSERT INTO character_runtime
          (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, 0)
      `).run(characterId, characterId === currentId ? "companion" : "waiting", clock.ms);
    }
  } finally {
    seed.close();
  }

  const harness = { dir, dbFile, clock, ids, currentId };

  function open() {
    harness.store = createStore(dir);
    harness.service = createCompanionshipService({
      store: harness.store,
      candidates: CANDIDATES,
      now: () => new Date(clock.ms),
      random: () => 0.5,
    });
  }

  harness.open = open;
  harness.advance = (ms) => {
    clock.ms += ms;
  };
  harness.setClock = (ms) => {
    clock.ms = ms;
  };
  harness.snapshot = () => harness.service.getSnapshot();
  harness.stats = (characterId) =>
    harness.store.listCompanions().find((item) => item.characterId === characterId).stats;
  harness.runtime = (characterId) =>
    harness.store.getCompanion(characterId).runtime;
  harness.reopen = (options = {}) => {
    if (options.markClosed) {
      harness.service.markClosed();
    }
    harness.store.close();
    open();
  };
  harness.rows = (sql, ...params) => {
    const db = openDb(dbFile, true);
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };
  harness.one = (sql, ...params) => harness.rows(sql, ...params)[0];
  harness.exec = (sql) => {
    const db = openDb(dbFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  harness.activity = (activityId) =>
    harness.one("SELECT * FROM character_activities WHERE activity_id = ?", activityId);
  harness.startedCount = (kind, since) =>
    Number(
      harness.one(
        `SELECT COUNT(*) AS count FROM character_activities
         WHERE kind = ? AND started_at IS NOT NULL AND started_at > ?`,
        kind,
        since,
      ).count,
    );

  open();
  t.after(() => {
    try {
      harness.store?.close();
    } catch {
      // 测试已主动关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return harness;
}

function startRunningDaily(h, activityId, characterId = "a") {
  h.snapshot();
  assert.equal(
    h.service.requestActivity({
      activityId,
      characterId,
      kind: "daily",
    }).requested,
    true,
  );
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(3 * 1000);
  const snap = h.snapshot();
  assert.equal(snap.current.activity.status, "running");
  assert.equal(snap.current.activity.activeElapsedMs, 3 * 1000);
  near(h.stats(characterId).energy, 98);
  return snap;
}

function pauseDailyBySwitch(h, activityId) {
  h.snapshot();
  h.service.requestActivity({
    activityId,
    characterId: "a",
    kind: "daily",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(3 * 1000);
  h.service.switchTo("b");
  assert.equal(h.activity(activityId).status, "paused");
  h.advance(61 * MINUTE);
  h.service.switchTo("a");
  assert.equal(h.snapshot().current.characterId, "a");
  return h.activity(activityId);
}

test("POL-ACTIVITY-001 同屏探索待自然节点交接、唯一ID与启动门槛", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();

  const requested = h.service.requestActivity({
    activityId: "exp-a-1",
    characterId: "a",
    kind: "exploration",
  });
  assert.equal(requested.requested, true);
  assert.equal(requested.duplicate, false);
  assert.equal(requested.activity.status, "scheduled");
  near(h.stats("a").energy, 100);
  assert.equal(h.activity("exp-a-1").started_at, null);
  assert.equal(h.runtime("a").exploring, false);
  assert.equal(h.snapshot().roster.find((item) => item.characterId === "a").activity.status, "scheduled");

  // 请求与自然节点前都不扣精力；重复请求只回放同一事实。
  const duplicate = h.service.requestActivity({
    activityId: "exp-a-1",
    characterId: "a",
    kind: "exploration",
  });
  assert.equal(duplicate.duplicate, true);
  near(h.stats("a").energy, 100);
  assert.equal(h.snapshot().current.characterId, "a");

  const started = h.service.completeNaturalNode();
  assert.equal(started.started, true);
  assert.equal(started.fromCharacterId, "a");
  assert.equal(started.toCharacterId, "b");
  const after = h.snapshot();
  assert.equal(after.current.characterId, "b");
  assert.equal(after.current.mode, "companion");
  assert.equal(after.roster.find((item) => item.characterId === "a").exploring, true);
  assert.equal(after.characters.find((item) => item.characterId === "a").mode, "exploring");
  near(h.stats("a").energy, 92);
  assert.equal(h.activity("exp-a-1").status, "running");
  assert.equal(h.activity("exp-a-1").started_at, START);

  // 重复自然节点与同ID请求都不能二次开始或扣精力。
  const replay = h.service.completeNaturalNode();
  assert.equal(replay.reason, "no-pending");
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-a-1",
      characterId: "a",
      kind: "exploration",
    }).duplicate,
    true,
  );
  near(h.stats("a").energy, 92);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM character_activities").count, 1);

  // 没有合资格接替者时不启动，也不扣精力。
  const solo = makeHarness(t, { ids: ["a"] });
  assert.equal(
    solo.service.requestActivity({
      activityId: "exp-solo",
      characterId: "a",
      kind: "exploration",
    }).requested,
    true,
  );
  const noSuccessor = solo.service.completeNaturalNode();
  assert.equal(noSuccessor.started, false);
  assert.equal(noSuccessor.reason, "NO_SUCCESSOR");
  assert.equal(solo.activity("exp-solo").status, "cancelled");
  assert.equal(solo.snapshot().current.characterId, "a");
  near(solo.stats("a").energy, 100);

  const outsider = makeHarness(t, { ids: ["a", "b"], rosterIds: ["a"] });
  const outside = outsider.service.requestActivity({
    activityId: "exp-outside",
    characterId: "b",
    kind: "exploration",
  });
  assert.equal(outside.requested, false);
  assert.equal(outside.reason, "NOT_IN_ROSTER");
  assert.equal(outsider.activity("exp-outside"), undefined);
  near(outsider.stats("b").energy, 100);

  const tired = makeHarness(t, { ids: ["a", "b"], energy: { b: 59 } });
  const tiredResult = tired.service.requestActivity({
    activityId: "exp-tired",
    characterId: "b",
    kind: "exploration",
  });
  assert.equal(tiredResult.requested, false);
  assert.equal(tiredResult.reason, "LOW_ENERGY");

  const chatting = makeHarness(t, { ids: ["a", "b"] });
  chatting.service.requestActivity({
    activityId: "exp-chat",
    characterId: "b",
    kind: "exploration",
  });
  chatting.service.startInteraction("b");
  const deferred = chatting.service.completeNaturalNode();
  assert.equal(deferred.started, false);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.reason, "INTERACTION");
  assert.equal(chatting.activity("exp-chat").status, "scheduled");
  near(chatting.stats("b").energy, 100);
  chatting.service.endInteraction();
  assert.equal(chatting.service.completeNaturalNode().started, true);
  near(chatting.stats("b").energy, 92);
});

test("POL-ACTIVITY-002 日常零耗时执行、完成后回真实模式与滚动额度", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();

  h.advance(30 * MINUTE);
  h.snapshot();
  near(h.stats("a").energy, 97); // 30 分钟陪伴：-3

  assert.equal(
    h.service.requestActivity({
      activityId: "daily-a-1",
      characterId: "a",
      kind: "daily",
    }).activity.status,
    "scheduled",
  );
  near(h.stats("a").energy, 97);
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("a").energy, 95); // 旧时段先结算，日常只扣 2
  assert.equal(h.runtime("a").mode, "daily");

  h.advance(5 * 1000);
  let snap = h.snapshot();
  assert.equal(snap.current.mode, "daily");
  assert.equal(snap.current.activity.status, "running");
  assert.equal(snap.current.activity.activeElapsedMs, 5000);
  near(h.stats("a").energy, 95);

  // 重复自然节点不会把运行中的日常再扣一次。
  assert.equal(h.service.completeNaturalNode().reason, "no-pending");
  near(h.stats("a").energy, 95);

  // 真实伸展完成只记录动作事实；有效时长未满仍不能收束。
  assert.equal(h.service.completeDailyAction("daily-a-1").completed, true);
  assert.equal(h.service.completeNaturalNode().completedDaily, 0);
  assert.equal(h.activity("daily-a-1").status, "running");
  assert.equal(h.snapshot().current.activity.actionComplete, true);
  h.advance(5 * 1000);
  snap = h.snapshot();
  assert.equal(snap.current.mode, "daily");
  assert.equal(snap.current.activity.status, "running");
  assert.equal(snap.current.activity.actionComplete, true);
  assert.equal(snap.current.activity.activeElapsedMs, 10000);
  near(h.stats("a").energy, 95);

  // 动作与时长都满足后，才在自然节点收束。
  assert.equal(h.service.completeNaturalNode().completedDaily, 1);
  snap = h.snapshot();
  assert.equal(snap.current.mode, "companion");
  assert.equal(h.activity("daily-a-1").status, "completed");
  assert.equal(h.activity("daily-a-1").active_elapsed_ms, 10000);
  near(h.stats("a").energy, 95);
  h.service.advanceActivities();
  near(h.stats("a").energy, 95);

  // 完成后的余下时间按真实陪伴模式结算，而不是按日常零耗时。
  h.advance(10 * MINUTE);
  h.snapshot();
  near(h.stats("a").energy, 94);

  // 滚动 1 小时：自然节点后的新日常被拒；重启不重置。
  h.advance(48 * MINUTE + 50 * 1000);
  h.snapshot();
  const blocked = h.service.requestActivity({
    activityId: "daily-a-2",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(blocked.requested, false);
  assert.equal(blocked.reason, "DAILY_LIMIT");
  assert.equal(h.activity("daily-a-2"), undefined);

  h.reopen({ markClosed: true });
  h.advance(1);
  assert.equal(
    h.service.requestActivity({
      activityId: "daily-a-2",
      characterId: "a",
      kind: "daily",
    }).reason,
    "DAILY_LIMIT",
  );
  h.advance(MINUTE);
  assert.equal(
    h.service.requestActivity({
      activityId: "daily-a-2",
      characterId: "a",
      kind: "daily",
    }).requested,
    true,
  );

  // 跨自然日但仍在滚动小时内，额度不因日期变化清零。
  const late = makeHarness(t, { ids: ["a", "b"], start: LATE_START });
  late.snapshot();
  late.service.requestActivity({
    activityId: "daily-late-1",
    characterId: "a",
    kind: "daily",
  });
  late.service.completeNaturalNode();
  late.service.completeDailyAction("daily-late-1");
  late.setClock(new Date(2026, 9, 27, 0, 1, 0).getTime());
  // 跨自然日仍在滚动小时内：先让已完成时长的日常在自然节点收束，额度不因日期变化清零。
  assert.equal(late.service.completeNaturalNode().completedDaily, 1);
  late.snapshot();
  assert.equal(
    late.service.requestActivity({
      activityId: "daily-late-2",
      characterId: "a",
      kind: "daily",
    }).reason,
    "DAILY_LIMIT",
  );
  late.setClock(new Date(2026, 9, 27, 0, 50, 1).getTime());
  assert.equal(
    late.service.requestActivity({
      activityId: "daily-late-2",
      characterId: "a",
      kind: "daily",
    }).requested,
    true,
  );
});

test("POL-ACTIVITY-003 探索中聊天暂停、结束不挤人、切换后同ID恢复", (t) => {
  const h = makeHarness(t, { ids: ["a", "b", "c"] });
  h.snapshot();
  const rosterBefore = h.snapshot().roster.map((entry) => entry.characterId);

  h.service.requestActivity({
    activityId: "exp-b-1",
    characterId: "b",
    kind: "exploration",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("b").energy, 92);
  const startedAt = h.activity("exp-b-1").started_at;

  h.advance(5 * MINUTE);
  let snap = h.snapshot();
  assert.equal(snap.current.characterId, "a");
  assert.equal(
    snap.characters.find((item) => item.characterId === "b").activity.activeElapsedMs,
    5 * MINUTE,
  );

  h.service.startInteraction("b");
  snap = h.snapshot();
  assert.equal(snap.interaction.characterId, "b");
  assert.equal(snap.current.characterId, "b");
  assert.equal(snap.current.mode, "interacting");
  assert.equal(h.activity("exp-b-1").status, "paused");
  assert.equal(h.activity("exp-b-1").active_elapsed_ms, 5 * MINUTE);
  near(h.stats("b").energy, 92);
  assert.deepEqual(
    snap.roster.map((entry) => entry.characterId),
    rosterBefore,
    "聊天只改变同屏，不改变名单",
  );

  h.advance(10 * MINUTE);
  snap = h.snapshot();
  assert.equal(h.activity("exp-b-1").status, "paused");
  assert.equal(h.activity("exp-b-1").active_elapsed_ms, 5 * MINUTE);
  near(h.stats("b").energy, 92);

  const ended = h.service.endInteraction();
  assert.equal(ended.ended, true);
  assert.equal(ended.returnedCharacterId, "a");
  snap = h.snapshot();
  assert.equal(snap.current.characterId, "a");
  assert.equal(h.activity("exp-b-1").status, "paused");
  near(h.stats("b").energy, 92, 0.01);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM relationship_events").count, 0);

  // 暂停仍占全局探索并发；请求其他角色失败。
  const busy = h.service.requestActivity({
    activityId: "exp-c-blocked",
    characterId: "c",
    kind: "exploration",
  });
  assert.equal(busy.requested, false);
  assert.equal(busy.reason, "EXPLORATION_ACTIVE");

  assert.throws(
    () => h.service.switchTo("b"),
    (error) => error.code === "CHARACTER_EXPLORING",
    "探索中的角色不能直接占回同屏",
  );
  h.service.switchTo("c");
  assert.equal(h.snapshot().current.characterId, "c");
  const resumed = h.service.resumeActivity("exp-b-1");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.activity.activityId, "exp-b-1");
  near(h.stats("b").energy, 92, 0.01); // 恢复不再扣 8
  assert.equal(h.activity("exp-b-1").started_at, startedAt);
  assert.equal(h.startedCount("exploration", START - HOUR), 1);

  h.advance(10 * MINUTE);
  snap = h.snapshot();
  assert.equal(
    snap.characters.find((item) => item.characterId === "b").activity.activeElapsedMs,
    15 * MINUTE,
  );
  near(h.stats("b").energy, 92);

  h.advance(5 * MINUTE);
  snap = h.snapshot();
  assert.equal(h.activity("exp-b-1").status, "completed");
  assert.equal(h.activity("exp-b-1").active_elapsed_ms, 20 * MINUTE);
  assert.equal(h.runtime("b").mode, "waiting");
  assert.equal(h.runtime("b").exploring, false);
  assert.equal(snap.current.characterId, "c", "探索回来不挤走当前角色");
  assert.equal(h.one("SELECT COUNT(*) AS count FROM relationship_events").count, 0);
});

test("POL-ACTIVITY-004 锁屏/关库/回拨/跨日退出名单都不推进离线活动", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();
  h.service.requestActivity({
    activityId: "exp-b-close",
    characterId: "b",
    kind: "exploration",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(5 * MINUTE);
  h.snapshot();
  assert.equal(h.activity("exp-b-close").active_elapsed_ms, 5 * MINUTE);

  // 时钟回拨不产生负进度，也不刷新额度窗口。
  h.setClock(START - 5 * MINUTE);
  let snap = h.snapshot();
  assert.equal(h.activity("exp-b-close").active_elapsed_ms, 5 * MINUTE);
  assert.equal(h.startedCount("exploration", START - HOUR), 1);
  near(h.stats("b").energy, 92);
  h.setClock(START + 5 * MINUTE);

  // 真正关库重建：活动只能先暂停，离线只恢复精力。
  h.store.close();
  h.setClock(START + 5 * MINUTE + 2 * HOUR);
  h.open();
  snap = h.snapshot();
  assert.equal(h.activity("exp-b-close").status, "paused");
  assert.equal(h.activity("exp-b-close").active_elapsed_ms, 5 * MINUTE);
  assert.equal(h.runtime("b").exploring, true);
  near(h.stats("b").energy, 100);
  assert.equal(h.snapshot().current.characterId, "a");

  const resumed = h.service.resumeActivity("exp-b-close");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.activity.activityId, "exp-b-close");
  assert.equal(h.activity("exp-b-close").started_at, START);
  assert.equal(h.startedCount("exploration", START - HOUR), 1);
  near(h.stats("b").energy, 100);

  // 锁屏恢复入口同样先暂停运行中的活动，不补做 10 分钟。
  h.advance(10 * MINUTE);
  h.service.resumeAfterPause();
  assert.equal(h.activity("exp-b-close").status, "paused");
  assert.equal(h.activity("exp-b-close").active_elapsed_ms, 5 * MINUTE);

  // 跨日换出名单：仍在运行的探索暂停，已暂停的活动不能借恢复绕过资格。
  const cross = makeHarness(t, { ids: ["a", "b"], start: LATE_START });
  cross.snapshot();
  cross.service.requestActivity({
    activityId: "exp-cross",
    characterId: "b",
    kind: "exploration",
  });
  cross.service.completeNaturalNode();
  cross.advance(2 * MINUTE);
  cross.snapshot();
  const nextDay = new Date(2026, 9, 27, 0, 1, 0).getTime();
  const rosterDb = openDb(cross.dbFile);
  try {
    rosterDb
      .prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', 'a')")
      .run(localDay(nextDay));
  } finally {
    rosterDb.close();
  }
  cross.setClock(nextDay);
  snap = cross.snapshot();
  assert.equal(cross.activity("exp-cross").status, "paused");
  assert.equal(cross.activity("exp-cross").active_elapsed_ms, 11 * MINUTE);
  const rejected = cross.service.resumeActivity("exp-cross");
  assert.equal(rejected.resumed, false);
  assert.equal(rejected.reason, "NOT_IN_ROSTER");
  assert.equal(cross.activity("exp-cross").active_elapsed_ms, 11 * MINUTE);
  near(cross.stats("b").energy, 92);
});

test("POL-ACTIVITY-005 全局并发/滚动上限与开始事务故障回滚", (t) => {
  const h = makeHarness(t, { ids: ["a", "b", "c"] });
  h.snapshot();
  h.service.requestActivity({
    activityId: "exp-first",
    characterId: "b",
    kind: "exploration",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("b").energy, 92);

  h.advance(MINUTE);
  assert.equal(h.service.pauseActivity("exp-first").paused, true);
  assert.equal(h.activity("exp-first").status, "paused");
  assert.equal(h.runtime("b").exploring, true);
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-c-paused",
      characterId: "c",
      kind: "exploration",
    }).reason,
    "EXPLORATION_ACTIVE",
  );

  h.service.cancelActivity("exp-first");
  assert.equal(h.activity("exp-first").status, "cancelled");
  assert.equal(h.startedCount("exploration", START - HOUR), 1);
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-c-quota",
      characterId: "c",
      kind: "exploration",
    }).reason,
    "EXPLORATION_4H_LIMIT",
  );

  // 恰好到 4 小时边界，旧启动滑出窗口；再次启动后立刻占住 4 小时额度。
  h.setClock(START + 4 * HOUR);
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-second",
      characterId: "c",
      kind: "exploration",
    }).requested,
    true,
  );
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("c").energy, 92);
  h.advance(1);
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-b-blocked",
      characterId: "b",
      kind: "exploration",
    }).reason,
    "EXPLORATION_ACTIVE",
  );
  h.service.cancelActivity("exp-second");
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-b-r4h",
      characterId: "b",
      kind: "exploration",
    }).reason,
    "EXPLORATION_4H_LIMIT",
  );

  // 两条启动都仍在 24 小时内，但都已滑出 4 小时窗口：只能命中 24 小时上限。
  h.setClock(START + 8 * HOUR + 2);
  assert.equal(
    h.service.requestActivity({
      activityId: "exp-b-r24h",
      characterId: "b",
      kind: "exploration",
    }).reason,
    "EXPLORATION_24H_LIMIT",
  );
  assert.equal(h.startedCount("exploration", START - DAY), 2);

  const fault = makeHarness(t, { ids: ["a", "b"] });
  fault.snapshot();
  fault.service.requestActivity({
    activityId: "exp-fault",
    characterId: "a",
    kind: "exploration",
  });
  fault.exec(`
    CREATE TRIGGER fail_activity_start
    BEFORE UPDATE ON character_activities
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  assert.throws(() => fault.service.completeNaturalNode(), /forced failure/);

  // 开始事务中的精力、位置、模式、活动记录和额度全部保持原状。
  near(fault.stats("a").energy, 100);
  assert.equal(fault.runtime("a").mode, "companion");
  assert.equal(fault.runtime("a").exploring, false);
  assert.equal(fault.runtime("b").mode, "waiting");
  assert.equal(fault.one("SELECT value FROM app_state WHERE key = 'current_character_id'").value, "a");
  assert.equal(fault.activity("exp-fault").status, "scheduled");
  assert.equal(fault.activity("exp-fault").started_at, null);
  assert.equal(fault.startedCount("exploration", START - HOUR), 0);
  assert.equal(fault.snapshot().current.characterId, "a");

  fault.exec("DROP TRIGGER fail_activity_start");
  const retried = fault.service.completeNaturalNode();
  assert.equal(retried.started, true);
  assert.equal(retried.fromCharacterId, "a");
  assert.equal(retried.toCharacterId, "b");
  near(fault.stats("a").energy, 92);
  assert.equal(fault.activity("exp-fault").status, "running");
  assert.equal(fault.startedCount("exploration", START - HOUR), 1);

  assert.equal(fault.service.completeNaturalNode().reason, "no-pending");
  near(fault.stats("a").energy, 92);
  assert.equal(fault.startedCount("exploration", START - HOUR), 1);
});

test("POL-ACTIVITY-006 日常运行中切换或聊天必须真实暂停且不重复扣", (t) => {
  const switched = makeHarness(t, { ids: ["a", "b"] });
  startRunningDaily(switched, "daily-switch-other");
  switched.service.switchTo("b");
  let snap = switched.snapshot();
  let row = switched.activity("daily-switch-other");
  assert.equal(row.status, "paused");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  assert.equal(row.completed_at, null);
  assert.equal(switched.runtime("a").mode, "waiting");
  assert.equal(snap.current.characterId, "b");
  near(switched.stats("a").energy, 98);

  switched.advance(10 * MINUTE);
  snap = switched.snapshot();
  row = switched.activity("daily-switch-other");
  assert.equal(row.status, "paused");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  near(switched.stats("a").energy, 98 + (10 / 60) * 10);
  assert.equal(switched.startedCount("daily", START - HOUR), 1);

  // 对同一角色切换：暂停后按真实陪伴模式结算，恢复也不重复扣 -2。
  const same = makeHarness(t, { ids: ["a", "b"] });
  startRunningDaily(same, "daily-switch-self");
  same.service.switchTo("a");
  snap = same.snapshot();
  row = same.activity("daily-switch-self");
  assert.equal(row.status, "paused");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  assert.equal(snap.current.characterId, "a");
  assert.equal(snap.current.mode, "companion");
  assert.equal(same.runtime("a").mode, "companion");
  near(same.stats("a").energy, 98);

  same.advance(10 * MINUTE);
  snap = same.snapshot();
  row = same.activity("daily-switch-self");
  assert.equal(row.status, "paused");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  near(same.stats("a").energy, 97);
  const resumed = same.service.resumeActivity("daily-switch-self");
  assert.equal(resumed.resumed, true);
  near(same.stats("a").energy, 97);
  assert.equal(same.service.completeDailyAction("daily-switch-self").completed, true);
  same.advance(7 * 1000);
  const finished = same.service.completeNaturalNode();
  assert.equal(finished.completedDaily, 1);
  snap = same.snapshot();
  row = same.activity("daily-switch-self");
  assert.equal(row.status, "completed");
  assert.equal(row.active_elapsed_ms, 10 * 1000);
  near(same.stats("a").energy, 97);
  assert.equal(same.startedCount("daily", START - HOUR), 1);

  // 找另一位聊天：先暂停原同屏者的日常，再切换互动。
  const chatting = makeHarness(t, { ids: ["a", "b"] });
  startRunningDaily(chatting, "daily-chat-other");
  chatting.service.startInteraction("b");
  chatting.advance(5 * MINUTE);
  snap = chatting.snapshot();
  row = chatting.activity("daily-chat-other");
  assert.equal(
    row.status,
    "paused",
    `聊天后活动仍为 ${row.status}，mode=${chatting.runtime("a").mode}，` +
      `active=${row.active_elapsed_ms}ms，energy=${chatting.stats("a").energy}`,
  );
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  assert.equal(row.completed_at, null);
  assert.equal(chatting.runtime("a").mode, "waiting");
  assert.equal(snap.current.characterId, "b");
  assert.equal(snap.interaction.characterId, "b");
  near(chatting.stats("a").energy, 98 + (5 / 60) * 10);
  assert.equal(chatting.startedCount("daily", START - HOUR), 1);

  const ended = chatting.service.endInteraction();
  assert.equal(ended.returnedCharacterId, "a");
  row = chatting.activity("daily-chat-other");
  assert.equal(row.status, "paused");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  near(chatting.stats("a").energy, 98 + (5 / 60) * 10);
});

test("POL-ACTIVITY-007 低精力轮换等待日常收束后有接班再交接", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"], energy: { a: 32 } });
  h.snapshot();
  h.service.requestActivity({
    activityId: "daily-auto-switch",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("a").energy, 30);
  h.advance(3 * 1000);
  assert.equal(h.service.completeDailyAction("daily-auto-switch").completed, true);

  const rotation = h.service.requestAutoRotation();
  assert.equal(rotation.requested, true);
  assert.equal(rotation.pending, true);
  const node = h.service.completeNaturalNode();
  let row = h.activity("daily-auto-switch");
  let snap = h.snapshot();
  assert.equal(
    snap.current.characterId,
    "a",
    `活动=${row.status}，aMode=${h.runtime("a").mode}，pending=${snap.pendingRotation}`,
  );
  assert.equal(row.status, "running");
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  assert.equal(h.runtime("a").mode, "daily");
  assert.equal(snap.pendingRotation, true);
  assert.equal(node.switched, false);
  assert.equal(node.deferred, true);
  assert.equal(node.pending, true);
  assert.equal(rotation.deferred, true);
  near(h.stats("a").energy, 30);

  // 只有真实推进到 10 秒，日常完成后的自然节点才能交接。
  h.advance(7 * 1000);
  const finished = h.service.completeNaturalNode();
  assert.equal(finished.switched, true);
  assert.equal(finished.toCharacterId, "b");
  snap = h.snapshot();
  row = h.activity("daily-auto-switch");
  assert.equal(row.status, "completed");
  assert.equal(row.active_elapsed_ms, 10 * 1000);
  assert.equal(row.completed_at, START + 10 * 1000);
  assert.equal(snap.current.characterId, "b");
  assert.equal(h.runtime("a").mode, "waiting");
  assert.equal(snap.pendingRotation, false);
  near(h.stats("a").energy, 30);
  assert.equal(h.startedCount("daily", START - HOUR), 1);
});

test("POL-ACTIVITY-007 低精力轮换等待日常收束后无接班则休息", (t) => {
  const h = makeHarness(t, { ids: ["a"], energy: { a: 32 } });
  h.snapshot();
  h.service.requestActivity({
    activityId: "daily-auto-rest",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  near(h.stats("a").energy, 30);
  h.advance(3 * 1000);
  assert.equal(h.service.completeDailyAction("daily-auto-rest").completed, true);

  const rotation = h.service.requestAutoRotation();
  assert.equal(rotation.requested, true);
  const node = h.service.completeNaturalNode();
  let row = h.activity("daily-auto-rest");
  let snap = h.snapshot();
  assert.equal(row.status, "running");
  assert.equal(
    h.runtime("a").mode,
    "daily",
    `活动=${row.status}，aMode=${h.runtime("a").mode}，pending=${snap.pendingRotation}`,
  );
  assert.equal(row.active_elapsed_ms, 3 * 1000);
  assert.equal(snap.current.characterId, "a");
  assert.equal(snap.pendingRotation, true);
  assert.equal(node.deferred, true);
  assert.equal(node.pending, true);
  assert.equal(rotation.deferred, true);
  near(h.stats("a").energy, 30);

  h.advance(7 * 1000);
  const finished = h.service.completeNaturalNode();
  assert.equal(finished.switched, false);
  assert.equal(finished.resting, true);
  snap = h.snapshot();
  row = h.activity("daily-auto-rest");
  assert.equal(row.status, "completed");
  assert.equal(row.active_elapsed_ms, 10 * 1000);
  assert.equal(snap.current.characterId, "a");
  assert.equal(snap.current.source, "resting");
  assert.equal(h.runtime("a").mode, "resting");
  assert.equal(snap.pendingRotation, false);
  near(h.stats("a").energy, 30);
  assert.equal(h.startedCount("daily", START - HOUR), 1);
});

test("POL-ACTIVITY-008 同角色暂停日常后额度过期不能创建第二个未完成活动", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  const old = pauseDailyBySwitch(h, "daily-paused");
  const beforeEnergy = h.stats("a").energy;
  const startedBefore = Number(
    h.one(
      `SELECT COUNT(*) AS count FROM character_activities
       WHERE character_id = 'a' AND started_at IS NOT NULL`,
    ).count,
  );

  const replay = h.service.requestActivity({
    activityId: "daily-paused",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.activity.activityId, "daily-paused");
  assert.equal(replay.activity.status, "paused");

  const blocked = h.service.requestActivity({
    activityId: "daily-second",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(blocked.requested, false);
  assert.equal(blocked.reason, "ACTIVITY_ACTIVE");
  assert.equal(blocked.activity.activityId, "daily-paused");
  assert.equal(blocked.activity.status, "paused");
  assert.equal(h.activity("daily-second"), undefined);
  assert.equal(old.status, "paused");
  assert.equal(old.active_elapsed_ms, 3 * 1000);
  assert.equal(
    h.one(
      `SELECT COUNT(*) AS count FROM character_activities
       WHERE character_id = 'a' AND status IN ('scheduled', 'running', 'paused')`,
    ).count,
    1,
  );
  near(h.stats("a").energy, beforeEnergy);
  assert.equal(
    Number(
      h.one(
        `SELECT COUNT(*) AS count FROM character_activities
         WHERE character_id = 'a' AND started_at IS NOT NULL`,
      ).count,
    ),
    startedBefore,
  );

  const cancelled = h.service.cancelActivity("daily-paused");
  assert.equal(cancelled.cancelled, true);
  assert.equal(h.activity("daily-paused").status, "cancelled");
  assert.equal(
    h.one(
      `SELECT COUNT(*) AS count FROM character_activities
       WHERE character_id = 'a' AND status IN ('scheduled', 'running', 'paused')`,
    ).count,
    0,
  );
  const next = h.service.requestActivity({
    activityId: "daily-second",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(next.requested, true);
  assert.equal(next.activity.status, "scheduled");
  near(h.stats("a").energy, beforeEnergy);
});

test("POL-ACTIVITY-008 同角色暂停日常后探索请求同样被单一活动门拦截", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  pauseDailyBySwitch(h, "daily-paused-exploration");
  const beforeEnergy = h.stats("a").energy;

  const blocked = h.service.requestActivity({
    activityId: "exploration-second",
    characterId: "a",
    kind: "exploration",
  });
  assert.equal(blocked.requested, false);
  assert.equal(blocked.reason, "ACTIVITY_ACTIVE");
  assert.equal(blocked.activity.activityId, "daily-paused-exploration");
  assert.equal(blocked.activity.status, "paused");
  assert.equal(h.activity("exploration-second"), undefined);
  assert.equal(
    h.one(
      `SELECT COUNT(*) AS count FROM character_activities
       WHERE character_id = 'a' AND status IN ('scheduled', 'running', 'paused')`,
    ).count,
    1,
  );
  near(h.stats("a").energy, beforeEnergy);
  assert.equal(h.startedCount("exploration", START - HOUR), 0);
});

test("POL-ACTIVITY-002 daily 有效时长先到但真实动作未到不收束", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();
  assert.equal(
    h.service.requestActivity({
      activityId: "daily-duration-first",
      characterId: "a",
      kind: "daily",
    }).requested,
    true,
  );
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(10 * 1000);

  let snap = h.snapshot();
  let row = h.activity("daily-duration-first");
  assert.equal(row.status, "running");
  assert.equal(row.active_elapsed_ms, 10 * 1000);
  assert.equal(row.action_completed_at, null);
  assert.equal(row.action_frame, 0);
  assert.equal(snap.current.mode, "daily");

  // 计时已满但无真实动作：自然节点也不能宣称完成。
  assert.equal(h.service.completeNaturalNode().completedDaily, 0);
  assert.equal(h.activity("daily-duration-first").status, "running");

  // 进度只记录播放事实；完成回报后才允许收束。
  assert.equal(h.service.recordDailyActionProgress("daily-duration-first", 8).recorded, true);
  assert.equal(h.activity("daily-duration-first").action_frame, 8);
  assert.equal(h.activity("daily-duration-first").action_completed_at, null);
  assert.equal(
    h.service.completeDailyAction("daily-duration-first", { characterId: "a" }).completed,
    true,
  );
  assert.equal(h.service.completeNaturalNode().completedDaily, 1);
  snap = h.snapshot();
  row = h.activity("daily-duration-first");
  assert.equal(row.status, "completed");
  assert.equal(row.active_elapsed_ms, 10 * 1000);
  assert.equal(row.action_frame, 8);
  assert.equal(snap.current.mode, "companion");
});

test("POL-ACTIVITY-002 daily 完成与暂停相邻两种顺序都保留真实完成事实", (t) => {
  // 完成回报先到，随后暂停。
  const first = makeHarness(t, { ids: ["a", "b"] });
  first.snapshot();
  first.service.requestActivity({
    activityId: "daily-complete-then-pause",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(first.service.completeNaturalNode().started, true);
  first.advance(3 * 1000);
  assert.equal(
    first.service.completeDailyAction("daily-complete-then-pause", { characterId: "a" })
      .completed,
    true,
  );
  first.service.switchTo("b");
  assert.equal(first.activity("daily-complete-then-pause").status, "paused");
  assert.notEqual(first.activity("daily-complete-then-pause").action_completed_at, null);
  assert.equal(first.service.switchTo("a").currentCharacterId, "a");
  assert.equal(first.service.resumeActivity("daily-complete-then-pause").resumed, true);
  first.advance(7 * 1000);
  assert.equal(first.service.completeNaturalNode().completedDaily, 1);
  assert.equal(first.activity("daily-complete-then-pause").status, "completed");

  // 暂停回报先到，动作随后真实播完。
  const second = makeHarness(t, { ids: ["a", "b"] });
  second.snapshot();
  second.service.requestActivity({
    activityId: "daily-pause-then-complete",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(second.service.completeNaturalNode().started, true);
  second.advance(3 * 1000);
  second.service.switchTo("b");
  assert.equal(second.activity("daily-pause-then-complete").status, "paused");
  assert.equal(
    second.service.completeDailyAction("daily-pause-then-complete", { characterId: "a" })
      .completed,
    true,
  );
  assert.equal(second.activity("daily-pause-then-complete").status, "paused");
  assert.notEqual(
    second.activity("daily-pause-then-complete").action_completed_at,
    null,
  );
  second.service.switchTo("a");
  assert.equal(second.service.resumeActivity("daily-pause-then-complete").resumed, true);
  second.advance(7 * 1000);
  assert.equal(second.service.completeNaturalNode().completedDaily, 1);
  assert.equal(second.activity("daily-pause-then-complete").status, "completed");
});

test("POL-ACTIVITY-002 daily 进度/完成回报按活动 ID 与角色归属，旧和取消活动不串写", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();
  h.service.requestActivity({
    activityId: "daily-identity",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(3 * 1000);

  // 角色不符的迟到消息不得记录到当前活动。
  assert.equal(
    h.service.completeDailyAction("daily-identity", { characterId: "b" }).completed,
    false,
  );
  assert.equal(
    h.service.recordDailyActionProgress("daily-identity", 5, { characterId: "b" }).recorded,
    false,
  );
  let row = h.activity("daily-identity");
  assert.equal(row.action_completed_at, null);
  assert.equal(row.action_frame, 0);

  // 取消后的旧活动回报不得写到仍处于同角色的活动事实之外。
  h.service.switchTo("b");
  h.service.switchTo("a");
  h.service.resumeActivity("daily-identity");
  assert.equal(h.service.cancelActivity("daily-identity").cancelled, true);
  assert.equal(
    h.service.completeDailyAction("daily-identity", { characterId: "a" }).completed,
    false,
  );
  assert.equal(
    h.service.recordDailyActionProgress("daily-identity", 7, { characterId: "a" }).recorded,
    false,
  );
  row = h.activity("daily-identity");
  assert.equal(row.status, "cancelled");
  assert.equal(row.action_completed_at, null);
  assert.equal(row.action_frame, 0);

  // 额度过期后启动新活动；旧 ID 的迟到回报不能完成或推进新活动。
  h.advance(61 * MINUTE);
  h.snapshot();
  assert.equal(
    h.service.requestActivity({
      activityId: "daily-identity-next",
      characterId: "a",
      kind: "daily",
    }).requested,
    true,
  );
  assert.equal(h.service.completeNaturalNode().started, true);
  assert.equal(
    h.service.completeDailyAction("daily-identity", { characterId: "a" }).completed,
    false,
  );
  assert.equal(
    h.service.recordDailyActionProgress("daily-identity", 8, { characterId: "a" }).recorded,
    false,
  );
  const next = h.activity("daily-identity-next");
  assert.equal(next.status, "running");
  assert.equal(next.action_completed_at, null);
  assert.equal(next.action_frame, 0);
});

test("POL-ACTIVITY-002 daily 动作进度/完成保存失败不得假确认", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();
  h.service.requestActivity({
    activityId: "daily-write-failure",
    characterId: "a",
    kind: "daily",
  });
  assert.equal(h.service.completeNaturalNode().started, true);
  h.advance(3 * 1000);

  h.exec(`
    CREATE TRIGGER fail_action_frame BEFORE UPDATE OF action_frame ON character_activities
    BEGIN SELECT RAISE(ABORT, 'forced action frame failure'); END;
  `);
  assert.throws(
    () => h.service.recordDailyActionProgress("daily-write-failure", 4),
    /forced action frame failure/,
  );
  assert.equal(h.activity("daily-write-failure").action_frame, 0);

  h.exec(`
    CREATE TRIGGER fail_action_complete BEFORE UPDATE OF action_completed_at
    ON character_activities
    BEGIN SELECT RAISE(ABORT, 'forced action complete failure'); END;
  `);
  assert.throws(
    () => h.service.completeDailyAction("daily-write-failure", { characterId: "a" }),
    /forced action complete failure/,
  );
  assert.equal(h.activity("daily-write-failure").action_completed_at, null);
  assert.equal(h.activity("daily-write-failure").status, "running");

  h.exec("DROP TRIGGER fail_action_frame");
  h.exec("DROP TRIGGER fail_action_complete");
  assert.equal(h.service.recordDailyActionProgress("daily-write-failure", 4).recorded, true);
  assert.equal(
    h.service.completeDailyAction("daily-write-failure", { characterId: "a" }).completed,
    true,
  );
  assert.equal(h.service.completeNaturalNode().completedDaily, 0, "时长未满仍不收束");
  assert.equal(h.activity("daily-write-failure").action_frame, 4);
  assert.notEqual(h.activity("daily-write-failure").action_completed_at, null);
});

test("POL-ACTIVITY-002 旧活动表缺动作列可原位迁移", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-activity-migrate-"));
  const dbFile = path.join(dir, "bayper.sqlite3");
  try {
    createStore(dir).close();
    const seed = openDb(dbFile);
    try {
      seed.exec("ALTER TABLE character_activities DROP COLUMN action_completed_at");
      seed.exec("ALTER TABLE character_activities DROP COLUMN action_frame");
    } finally {
      seed.close();
    }
    createStore(dir).close();
    const check = openDb(dbFile, true);
    try {
      const names = new Set(
        check.prepare("PRAGMA table_info(character_activities)").all().map((row) => row.name),
      );
      assert.equal(names.has("action_completed_at"), true);
      assert.equal(names.has("action_frame"), true);
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
