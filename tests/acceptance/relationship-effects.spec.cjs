/* S02c 正式验收：真实 createStore/SQLite/companionship；仅时间用 fixture。
   覆盖 POL-RELATION-001～004，不覆盖聊天/活动事件生成、模型或 UI。 */
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
const DAY2 = new Date(2026, 9, 27, 12, 0, 0).getTime();
const DAY3 = new Date(2026, 9, 28, 12, 0, 0).getTime();
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

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function openDb(file, readOnly = false) {
  return readOnly
    ? new DatabaseSync(file, { readOnly: true })
    : new DatabaseSync(file);
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-relation-"));
  const dbFile = path.join(dir, "bayper.sqlite3");
  const ids = options.ids ?? ["a", "b"];
  const clock = { ms: options.start ?? START };
  createStore(dir).close();

  const seed = openDb(dbFile);
  try {
    seed.exec("PRAGMA foreign_keys = ON");
    for (const characterId of ids) {
      seed.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        characterId,
        new Date(START).toISOString(),
      );
      seed.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, ?, 100, ?)
      `).run(
        characterId,
        options.intimacy?.[characterId] ?? 10,
        options.mood?.[characterId] ?? 0,
      );
    }
    setState(seed, "fixed_character_id", ids[0]);
    setState(seed, "current_character_id", ids[0]);
    setState(seed, "current_mode", "companion");
    setState(seed, "pending_rotation", "0");
    setState(seed, "last_active_at", clock.ms);
    ids.slice(0, 5).forEach((characterId, index) => {
      seed.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(START),
        SLOTS[index],
        characterId,
      );
    });
    ids.forEach((characterId, index) => {
      seed.prepare(`
        INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, 0)
      `).run(characterId, index === 0 ? "companion" : "waiting", clock.ms);
    });
  } finally {
    seed.close();
  }

  const harness = { dir, dbFile, clock, ids };
  function open() {
    harness.store = createStore(dir);
    harness.companionship = createCompanionshipService({
      store: harness.store,
      candidates: CANDIDATES,
      now: () => new Date(clock.ms),
      random: () => 0.5,
    });
  }
  harness.snapshot = () => harness.companionship.getSnapshot();
  harness.stats = (characterId) =>
    harness.store.listCompanions().find((item) => item.characterId === characterId).stats;
  harness.record = (input) => harness.store.recordRelationshipEvent(input);
  harness.reopen = () => {
    harness.store.close();
    open();
  };
  open();
  t.after(() => {
    try {
      harness.store?.close();
    } catch {
      // 测试已关闭时仍清理目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return harness;
}

function rows(harness, sql, ...params) {
  const db = openDb(harness.dbFile, true);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function exec(harness, sql) {
  const db = openDb(harness.dbFile);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function one(harness, sql, ...params) {
  return rows(harness, sql, ...params)[0];
}

function eventCount(harness, characterId) {
  return one(
    harness,
    "SELECT COUNT(*) AS count FROM relationship_events WHERE character_id = ?",
    characterId,
  ).count;
}

test("POL-RELATION-001 每日亲密类别、总额、重放与更名", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();

  let result = h.record({
    eventId: "a-meaningful-1",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START,
  });
  assert.equal(result.result, "applied");
  assert.equal(result.intimacyDelta, 1);
  assert.equal(result.stats.intimacy, 11);
  assert.equal(h.stats("a").intimacy, 11);

  result = h.record({
    eventId: "a-meaningful-1",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + MINUTE,
  });
  assert.equal(result.duplicate, true);
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(eventCount(h, "a"), 1);

  result = h.record({
    eventId: "a-meaningful-2",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START,
  });
  assert.equal(result.result, "daily_already");
  assert.equal(result.intimacyDelta, 0);
  assert.equal(h.stats("a").intimacy, 11);

  result = h.record({
    eventId: "a-shared-1",
    characterId: "a",
    kind: "shared_activity",
    at: START,
  });
  assert.equal(result.result, "applied");
  assert.equal(h.stats("a").intimacy, 12);
  result = h.record({
    eventId: "a-shared-2",
    characterId: "a",
    kind: "shared_activity",
    at: START,
  });
  assert.equal(result.result, "daily_already");
  assert.equal(h.stats("a").intimacy, 12);

  result = h.record({
    eventId: "b-meaningful-1",
    characterId: "b",
    kind: "meaningful_interaction",
    at: START,
  });
  assert.equal(result.result, "applied");
  assert.equal(h.stats("b").intimacy, 11);
  assert.equal(h.stats("a").intimacy, 12);
  result = h.record({
    eventId: "b-shared-1",
    characterId: "b",
    kind: "shared_activity",
    at: START,
  });
  assert.equal(result.result, "applied");
  assert.equal(h.stats("b").intimacy, 12);

  h.companionship.setNickname("a", "新昵称");
  assert.equal(
    h.store.listCompanions().find((item) => item.characterId === "a").nickname,
    "新昵称",
  );
  assert.equal(h.stats("a").intimacy, 12);
  result = h.record({
    eventId: "a-setback-1",
    characterId: "a",
    kind: "activity_setback",
    at: START,
  });
  assert.equal(result.moodDelta, -1);
  assert.equal(h.stats("a").intimacy, 12);
  assert.equal(h.stats("a").mood, -1);

  h.clock.ms = DAY2;
  result = h.record({
    eventId: "a-meaningful-1",
    characterId: "a",
    kind: "meaningful_interaction",
    at: DAY2,
  });
  assert.equal(result.duplicate, true);
  assert.equal(h.stats("a").intimacy, 12);
  result = h.record({
    eventId: "a-meaningful-3",
    characterId: "a",
    kind: "meaningful_interaction",
    at: DAY2,
  });
  assert.equal(result.result, "applied");
  assert.equal(h.stats("a").intimacy, 13);
  result = h.record({
    eventId: "a-shared-3",
    characterId: "a",
    kind: "shared_activity",
    at: DAY2,
  });
  assert.equal(result.result, "applied");
  assert.equal(h.stats("a").intimacy, 14);
  result = h.record({
    eventId: "a-meaningful-4",
    characterId: "a",
    kind: "meaningful_interaction",
    at: DAY2,
  });
  assert.equal(result.result, "daily_already");
  assert.equal(h.stats("a").intimacy, 14);

  h.clock.ms = DAY3;
  exec(h, "UPDATE character_stats SET intimacy = 100 WHERE character_id = 'a'");
  result = h.record({
    eventId: "a-meaningful-5",
    characterId: "a",
    kind: "meaningful_interaction",
    at: DAY3,
  });
  assert.equal(result.result, "capped");
  assert.equal(result.intimacyDelta, 0);
  result = h.record({
    eventId: "a-shared-4",
    characterId: "a",
    kind: "shared_activity",
    at: DAY3,
  });
  assert.equal(result.result, "capped");
  assert.equal(h.stats("a").intimacy, 100);
  result = h.record({
    eventId: "a-setback-2",
    characterId: "a",
    kind: "activity_setback",
    at: DAY3,
  });
  assert.equal(h.stats("a").intimacy, 100);

  const day1 = localDay(START);
  const day2 = localDay(DAY2);
  const day3 = localDay(DAY3);
  const dailyRows = rows(
    h,
    "SELECT character_id, day, meaningful_interaction, shared_activity FROM relationship_daily ORDER BY character_id, day",
  );
  assert.deepEqual(
    dailyRows.map((row) => [
      row.character_id,
      row.day,
      row.meaningful_interaction,
      row.shared_activity,
    ]),
    [
      ["a", day1, 1, 1],
      ["a", day2, 1, 1],
      ["a", day3, 1, 1],
      ["b", day1, 1, 1],
    ],
  );
  const event = one(
    h,
    "SELECT intimacy_delta, mood_delta, result FROM relationship_events WHERE event_id = 'a-meaningful-1'",
  );
  assert.deepEqual(
    [event.intimacy_delta, event.mood_delta, event.result],
    [1, 0, "applied"],
  );
  assert.equal(h.stats("a").intimacy, 100);
  assert.equal(h.stats("b").intimacy, 12);
});

test("POL-RELATION-002 心情冷却、触顶与自然恢复", (t) => {
  const h = makeHarness(t, { ids: ["a"] });
  h.snapshot();
  assert.equal(h.record({
    eventId: "pleasant-1",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START,
  }).moodDelta, 1);
  assert.equal(h.record({
    eventId: "interesting-1",
    characterId: "a",
    kind: "interesting_activity",
    at: START,
  }).moodDelta, 1);
  assert.equal(h.stats("a").mood, 2);

  // 30 分钟内同类别再事件不生效；重复事件也不推进恢复锚点。
  const cooldown = h.record({
    eventId: "pleasant-2",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 10 * MINUTE,
  });
  assert.equal(cooldown.result, "cooldown");
  assert.equal(cooldown.moodDelta, 0);
  assert.equal(h.record({
    eventId: "pleasant-1",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 10 * MINUTE,
  }).duplicate, true);

  h.clock.ms = START + 30 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 1);
  h.clock.ms = START + 45 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 1);
  h.clock.ms = START + 60 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 0);

  assert.equal(h.record({
    eventId: "setback-1",
    characterId: "a",
    kind: "activity_setback",
    at: START + 60 * MINUTE,
  }).moodDelta, -1);
  assert.equal(h.stats("a").mood, -1);
  const rejected = h.record({
    eventId: "setback-2",
    characterId: "a",
    kind: "activity_setback",
    at: START + 75 * MINUTE,
  });
  assert.equal(rejected.result, "cooldown");
  h.clock.ms = START + 90 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 0);

  const capped = makeHarness(t, { ids: ["a"], mood: { a: 2 } });
  capped.snapshot();
  const capResult = capped.record({
    eventId: "pleasant-cap",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 10 * MINUTE,
  });
  assert.equal(capResult.result, "capped");
  assert.equal(capResult.moodDelta, 0);
  capped.clock.ms = START + 30 * MINUTE;
  capped.snapshot();
  assert.equal(capped.stats("a").mood, 1);
});

test("POL-RELATION-003 关闭重开、长离线、回拨与无锚点库", (t) => {
  const h = makeHarness(t, { ids: ["a"] });
  h.snapshot();
  h.record({
    eventId: "m-1",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START,
  });
  h.record({
    eventId: "p-1",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START,
  });
  h.record({
    eventId: "i-1",
    characterId: "a",
    kind: "interesting_activity",
    at: START,
  });
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(h.stats("a").mood, 2);

  h.clock.ms = START + 10 * MINUTE;
  h.reopen();
  h.snapshot();
  assert.equal(h.stats("a").mood, 2);
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(h.record({
    eventId: "m-1",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + 10 * MINUTE,
  }).duplicate, true);
  assert.equal(h.record({
    eventId: "m-2",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + 10 * MINUTE,
  }).result, "daily_already");
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(h.record({
    eventId: "p-2",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 10 * MINUTE,
  }).result, "cooldown");

  h.clock.ms = START + 4 * HOUR;
  h.reopen();
  h.snapshot();
  assert.equal(h.stats("a").mood, 0);
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(h.record({
    eventId: "m-3",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + 4 * HOUR,
  }).result, "daily_already");
  assert.equal(h.stats("a").intimacy, 11);

  assert.equal(h.record({
    eventId: "p-3",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 4 * HOUR,
  }).moodDelta, 1);
  const anchorBefore = Number(one(
    h,
    "SELECT anchor_at FROM relationship_mood_state WHERE character_id = 'a'",
  ).anchor_at);
  assert.equal(anchorBefore, START + 4 * HOUR);

  h.clock.ms = START + 10 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 1);
  assert.equal(
    Number(one(h, "SELECT anchor_at FROM relationship_mood_state WHERE character_id = 'a'").anchor_at),
    anchorBefore,
  );
  assert.equal(h.record({
    eventId: "m-4",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + 10 * MINUTE,
  }).result, "daily_already");
  assert.equal(h.stats("a").intimacy, 11);

  h.clock.ms = START + 4 * HOUR + 30 * MINUTE;
  h.snapshot();
  assert.equal(h.stats("a").mood, 0);

  const noAnchor = makeHarness(t, { ids: ["b"], mood: { b: 1 } });
  assert.equal(
    one(noAnchor, "SELECT COUNT(*) AS count FROM relationship_mood_state").count,
    0,
  );
  noAnchor.snapshot();
  assert.equal(noAnchor.stats("b").mood, 1);
  assert.equal(
    Number(one(noAnchor, "SELECT anchor_at FROM relationship_mood_state WHERE character_id = 'b'").anchor_at),
    START,
  );
  noAnchor.clock.ms = START + 30 * MINUTE;
  noAnchor.snapshot();
  assert.equal(noAnchor.stats("b").mood, 0);
});

test("POL-RELATION-004 写入故障、冲突与非法输入原子回滚", (t) => {
  const h = makeHarness(t, { ids: ["a", "b"] });
  h.snapshot();
  exec(h, `
    CREATE TRIGGER fail_relationship_event BEFORE INSERT ON relationship_events
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  assert.throws(() =>
    h.record({
      eventId: "fail-meaningful",
      characterId: "a",
      kind: "meaningful_interaction",
      at: START,
    }),
  );
  assert.equal(h.stats("a").intimacy, 10);
  assert.equal(
    one(h, "SELECT COUNT(*) AS count FROM relationship_daily WHERE character_id = 'a'").count,
    0,
  );
  assert.equal(eventCount(h, "a"), 0);

  const anchorBeforeFail = Number(
    one(h, "SELECT anchor_at FROM relationship_mood_state WHERE character_id = 'a'").anchor_at,
  );
  assert.throws(() =>
    h.record({
      eventId: "fail-pleasant",
      characterId: "a",
      kind: "pleasant_interaction",
      at: START + 10 * MINUTE,
    }),
  );
  assert.equal(h.stats("a").mood, 0);
  assert.equal(eventCount(h, "a"), 0);
  assert.equal(
    Number(one(h, "SELECT anchor_at FROM relationship_mood_state WHERE character_id = 'a'").anchor_at),
    anchorBeforeFail,
  );
  exec(h, "DROP TRIGGER fail_relationship_event");

  assert.equal(h.record({
    eventId: "fail-meaningful",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START,
  }).result, "applied");
  assert.equal(h.record({
    eventId: "fail-pleasant",
    characterId: "a",
    kind: "pleasant_interaction",
    at: START + 10 * MINUTE,
  }).result, "applied");
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(h.stats("a").mood, 1);

  h.record({
    eventId: "conflict",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START,
  });
  assert.throws(
    () =>
      h.record({
        eventId: "conflict",
        characterId: "b",
        kind: "meaningful_interaction",
        at: START,
      }),
    (error) => error?.code === "EVENT_CONFLICT",
  );
  assert.throws(
    () =>
      h.record({
        eventId: "conflict",
        characterId: "a",
        kind: "shared_activity",
        at: START,
      }),
    (error) => error?.code === "EVENT_CONFLICT",
  );
  assert.equal(h.stats("b").intimacy, 10);
  assert.equal(h.stats("a").intimacy, 11);

  assert.throws(
    () =>
      h.record({
        eventId: "unknown",
        characterId: "z",
        kind: "meaningful_interaction",
        at: START,
      }),
    (error) => error?.code === "CHARACTER_UNKNOWN",
  );
  assert.throws(
    () =>
      h.record({
        eventId: "bad-kind",
        characterId: "a",
        kind: "free_intimacy",
        at: START,
      }),
    (error) => error?.code === "INVALID_INPUT",
  );
  assert.throws(
    () =>
      h.record({
        eventId: "bad-time",
        characterId: "a",
        kind: "meaningful_interaction",
        at: -1,
      }),
    (error) => error?.code === "INVALID_TIME",
  );

  const duplicate = h.record({
    eventId: "fail-meaningful",
    characterId: "a",
    kind: "meaningful_interaction",
    at: START + HOUR,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.stats("a").intimacy, 11);
  assert.equal(eventCount(h, "a"), 3);
  assert.equal(h.stats("b").intimacy, 10);
});
