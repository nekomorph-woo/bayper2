const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../app/store.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");
const {
  dbPath,
  localDay,
  createLegacyDatabase,
  readRelationships,
} = require("./s02-fixtures.cjs");

const CANDIDATE_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
const CANDIDATES = CANDIDATE_IDS.map((id, index) => ({
  id,
  name: `角色${index + 1}`,
  tagline: "",
  intro: "",
  traits: [],
}));

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s02-"));
}

function makeClock(initial) {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    set: (date) => {
      current = new Date(date.getTime());
    },
    advanceHours: (hours) => {
      current = new Date(current.getTime() + hours * 60 * 60 * 1000);
    },
  };
}

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

function openDb(dataDir, readOnly = false) {
  return new DatabaseSync(dbPath(dataDir), { readOnly });
}

function execSql(dataDir, sql) {
  const db = openDb(dataDir);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function runSql(dataDir, sql, ...params) {
  const db = openDb(dataDir);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function seedModern(dataDir, options = {}) {
  const bootstrap = createStore(dataDir);
  bootstrap.close();

  const ids = options.ids ?? CANDIDATE_IDS.slice(0, 6);
  const db = openDb(dataDir);
  try {
    ids.forEach((id, index) => {
      const acceptedAt = new Date(2026, 9, 20, 9, index).toISOString();
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        id,
        acceptedAt,
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(id, options.energies?.[id] ?? 100);
    });

    const fixedId = options.fixedId ?? ids[0];
    setState(db, "fixed_character_id", fixedId);
    setState(db, "current_character_id", options.currentId ?? fixedId);
    if (options.currentMode) {
      setState(db, "current_mode", options.currentMode);
    }
    if (options.lastActiveAt) {
      setState(db, "last_active_at", options.lastActiveAt);
    }

    for (const [characterId, runtime] of Object.entries(options.runtimes ?? {})) {
      db.prepare(`
        INSERT INTO character_runtime
          (character_id, mode, last_settled_at, last_participated_at, last_auto_exit_at, exploring)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        characterId,
        runtime.mode ?? "waiting",
        runtime.lastSettledAt ?? null,
        runtime.lastParticipatedAt ?? null,
        runtime.lastAutoExitAt ?? null,
        runtime.exploring ? 1 : 0,
      );
    }

    if (options.rosterDay) {
      for (const entry of options.roster ?? []) {
        db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
          options.rosterDay,
          entry.slot,
          entry.characterId,
        );
      }
    }
  } finally {
    db.close();
  }
}

function startHarness(dataDir, clock, randomValues = []) {
  const store = createStore(dataDir);
  const service = createCompanionshipService({
    store,
    candidates: CANDIDATES,
    now: clock.now,
    random: sequenceRandom(randomValues),
  });
  service.start();
  return { store, service };
}

/* 当前同屏 c5 在旧名单中；下一天名单按较少参与优先会把它换出。 */
function seedRosterExitData(dataDir, rosterDate) {
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4", "c5", "c6"],
    fixedId: "c1",
    currentId: "c5",
    energies: { c1: 100, c2: 90, c3: 90, c4: 90, c5: 90, c6: 100 },
    runtimes: {
      c2: { lastParticipatedAt: rosterDate.getTime() },
      c3: { lastParticipatedAt: rosterDate.getTime() },
      c4: { lastParticipatedAt: rosterDate.getTime() },
      c5: { lastParticipatedAt: rosterDate.getTime() },
    },
    rosterDay: localDay(rosterDate),
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
      { slot: "random_4", characterId: "c5" },
    ],
  });
}

function returnScenario(options) {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  const rosterIds = options.rosterIds ?? options.ids;
  seedModern(dataDir, {
    ids: options.ids,
    fixedId: "c1",
    currentId: "c1",
    energies: options.energies,
    runtimes: options.runtimes,
    rosterDay,
    roster: rosterIds.map((characterId, index) => ({
      slot: index === 0 ? "fixed" : `random_${index}`,
      characterId,
    })),
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const started = harness.service.startInteraction(options.interactWith ?? "c1");
    if (options.requestRotation) {
      harness.service.requestAutoRotation();
    }
    const ended = harness.service.endInteraction();
    return { started, ended, snapshot: harness.service.getSnapshot() };
  } finally {
    cleanup(dataDir, harness.store);
  }
}

function rosterPairs(snapshot) {
  return snapshot.roster.map((entry) => [entry.slot, entry.characterId]);
}

function readRosterRows(dataDir, day) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare(`
        SELECT day, slot, character_id
        FROM roster WHERE day = ?
        ORDER BY CASE slot
          WHEN 'fixed' THEN 0 WHEN 'random_1' THEN 1 WHEN 'random_2' THEN 2
          WHEN 'random_3' THEN 3 WHEN 'random_4' THEN 4 ELSE 9 END
      `)
      .all(day)
      .map((row) => [row.day, row.slot, row.character_id]);
  } finally {
    db.close();
  }
}

function cleanup(dataDir, store) {
  try {
    store?.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("POL-COMPANION-001 每日名单：同日复用、跨日保留固定并优先较少参与", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(dataDir, {
    ids: CANDIDATE_IDS.slice(0, 6),
    fixedId: "c1",
    currentId: "c1",
  });
  let harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const first = harness.service.getSnapshot();
    assert.equal(first.roster.length, 5);
    assert.deepEqual(rosterPairs(first), [
      ["fixed", "c1"],
      ["random_1", "c2"],
      ["random_2", "c3"],
      ["random_3", "c4"],
      ["random_4", "c5"],
    ]);
    assert.equal(new Set(first.roster.map((entry) => entry.characterId)).size, 5);
    assert.equal(first.day, localDay(clock.now()));
    assert.deepEqual(readRosterRows(dataDir, first.day), [
      [first.day, "fixed", "c1"],
      [first.day, "random_1", "c2"],
      [first.day, "random_2", "c3"],
      [first.day, "random_3", "c4"],
      [first.day, "random_4", "c5"],
    ]);

    harness.service.markClosed();
    harness.store.close();
    clock.advanceHours(1);
    harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
    const second = harness.service.getSnapshot();
    assert.deepEqual(rosterPairs(second), rosterPairs(first), "同日重开应完全复用名单");

    runSql(
      dataDir,
      "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
      "c7",
      new Date(2026, 9, 25, 10, 0, 0).toISOString(),
    );
    runSql(
      dataDir,
      "INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES ('c7', 10, 100, 0)",
    );
    const afterAccept = harness.service.getSnapshot();
    assert.deepEqual(rosterPairs(afterAccept), rosterPairs(second), "新接纳不得重抽当日名单");
    assert.equal(afterAccept.roster.some((entry) => entry.characterId === "c7"), false);
    assert.equal(afterAccept.characters.some((entry) => entry.characterId === "c7"), true);

    clock.advanceHours(23);
    const nextDay = harness.service.getSnapshot();
    assert.equal(nextDay.day, localDay(clock.now()));
    assert.deepEqual(rosterPairs(nextDay), [
      ["fixed", "c1"],
      ["random_1", "c6"],
      ["random_2", "c7"],
      ["random_3", "c2"],
      ["random_4", "c3"],
    ]);
    assert.equal(nextDay.roster.length, 5);
    assert.equal(new Set(nextDay.roster.map((entry) => entry.characterId)).size, 5);
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-002 固定位与昵称：只补必要空位，不改身份与数值", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4", "c5"],
    fixedId: "c1",
    currentId: "c1",
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
      { slot: "random_4", characterId: "c5" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const result = harness.service.setFixed("c3");
    assert.equal(result.changed, true);
    assert.deepEqual(rosterPairs(harness.service.getSnapshot()), [
      ["fixed", "c3"],
      ["random_1", "c2"],
      ["random_2", "c1"],
      ["random_3", "c4"],
      ["random_4", "c5"],
    ]);

    const before = readRelationships(dataDir);
    const nickname = harness.service.setNickname("c3", "小澄");
    assert.equal(nickname.displayName, "小澄");
    const after = readRelationships(dataDir);
    const beforeC3 = before.find((row) => row.character_id === "c3");
    const afterC3 = after.find((row) => row.character_id === "c3");
    assert.equal(afterC3.accepted_at, beforeC3.accepted_at);
    assert.equal(afterC3.energy, beforeC3.energy);
    assert.equal(afterC3.intimacy, beforeC3.intimacy);
    assert.equal(afterC3.nickname, "小澄");
    assert.equal(
      harness.service.getSnapshot().characters.find((entry) => entry.characterId === "c3").displayName,
      "小澄",
    );

    harness.service.setNickname("c3", "");
    assert.equal(
      harness.service.getSnapshot().characters.find((entry) => entry.characterId === "c3").displayName,
      "角色3",
    );

    const rosterBeforeInvalid = readRosterRows(dataDir, rosterDay);
    assert.throws(
      () => harness.service.setFixed("ghost"),
      (error) => error.code === "INVALID_CHARACTER",
    );
    assert.throws(
      () => harness.service.setNickname("ghost", "无名"),
      (error) => error.code === "INVALID_CHARACTER",
    );
    assert.deepEqual(readRosterRows(dataDir, rosterDay), rosterBeforeInvalid);
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-003 临时互动与跨日：名单不变，结束返回原同屏角色", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4", "c5", "c6"],
    fixedId: "c1",
    currentId: "c1",
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
      { slot: "random_4", characterId: "c5" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const before = harness.service.getSnapshot();
    assert.equal(before.current.characterId, "c1");

    const started = harness.service.startInteraction("c6");
    assert.equal(started.temporary, true);
    const during = harness.service.getSnapshot();
    assert.equal(during.current.characterId, "c6");
    assert.equal(during.interaction.characterId, "c6");
    assert.equal(during.interaction.temporary, true);
    assert.deepEqual(
      during.roster.map((entry) => entry.characterId),
      before.roster.map((entry) => entry.characterId),
      "临时互动不得改变名单",
    );
    assert.equal(during.roster.some((entry) => entry.characterId === "c6"), false);

    harness.service.endInteraction();
    const returned = harness.service.getSnapshot();
    assert.equal(returned.current.characterId, "c1");
    assert.equal(returned.interaction, null);
    assert.deepEqual(
      returned.roster.map((entry) => entry.characterId),
      before.roster.map((entry) => entry.characterId),
    );

    harness.service.startInteraction("c6");
    clock.advanceHours(24);
    const acrossDay = harness.service.getSnapshot();
    assert.equal(acrossDay.interaction.characterId, "c6");
    assert.equal(acrossDay.current.characterId, "c6", "跨日不得打断当前对话归属");
    assert.equal(acrossDay.day, localDay(clock.now()));
    harness.service.endInteraction();
    const afterDay = harness.service.getSnapshot();
    assert.equal(afterDay.interaction, null);
    assert.equal(afterDay.current.characterId, "c1");
    assert.deepEqual(
      afterDay.roster.map((entry) => entry.characterId),
      acrossDay.roster.map((entry) => entry.characterId),
    );
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-003 临时聊天返回：前任精力不足或冷却中改选合格候场", () => {
  const lowEnergy = returnScenario({
    ids: ["c1", "c2", "c3"],
    rosterIds: ["c1", "c2"],
    interactWith: "c3",
    energies: { c1: 40, c2: 70, c3: 80 },
  });
  assert.equal(lowEnergy.started.temporary, true);
  assert.equal(lowEnergy.ended.returnedCharacterId, "c2");
  assert.equal(lowEnergy.snapshot.current.characterId, "c2");
  assert.equal(lowEnergy.snapshot.pendingRotation, false);

  const cooling = returnScenario({
    ids: ["c1", "c2", "c3"],
    rosterIds: ["c1", "c2"],
    interactWith: "c3",
    energies: { c1: 70, c2: 70, c3: 80 },
    runtimes: {
      c1: { lastAutoExitAt: new Date(2026, 9, 25, 8, 50, 0).getTime() },
    },
  });
  assert.equal(cooling.started.temporary, true);
  assert.equal(cooling.ended.returnedCharacterId, "c2");
  assert.equal(cooling.snapshot.current.characterId, "c2");

  const noCandidate = returnScenario({
    ids: ["c1", "c2", "c3"],
    rosterIds: ["c1", "c2"],
    interactWith: "c3",
    energies: { c1: 40, c2: 50, c3: 80 },
  });
  assert.equal(noCandidate.started.temporary, true);
  assert.equal(noCandidate.ended.returnedCharacterId, "c1");
  assert.equal(noCandidate.ended.resting, true);
  assert.equal(noCandidate.snapshot.current.characterId, "c1");
  assert.equal(noCandidate.snapshot.current.source, "resting");
});

test("POL-COMPANION-003 同角色结束：精力 55 不换，<=30 仍交接，暂离返回仍守 60", () => {
  const sameAt55 = returnScenario({
    ids: ["c1", "c2"],
    energies: { c1: 55, c2: 70 },
  });
  assert.equal(sameAt55.started.temporary, false);
  assert.equal(sameAt55.ended.returnedCharacterId, "c1");
  assert.equal(sameAt55.snapshot.current.characterId, "c1");
  assert.equal(sameAt55.snapshot.pendingRotation, false);

  const lowSame = returnScenario({
    ids: ["c1", "c2"],
    energies: { c1: 25, c2: 70 },
    requestRotation: true,
  });
  assert.equal(lowSame.started.temporary, false);
  assert.equal(lowSame.ended.returnedCharacterId, "c1");
  assert.equal(lowSame.ended.rotation.switched, true);
  assert.equal(lowSame.ended.rotation.toCharacterId, "c2");
  assert.equal(lowSame.snapshot.current.characterId, "c2");

  const awayAt55 = returnScenario({
    ids: ["c1", "c2", "c3"],
    rosterIds: ["c1", "c2"],
    interactWith: "c3",
    energies: { c1: 55, c2: 70, c3: 80 },
  });
  assert.equal(awayAt55.started.temporary, true);
  assert.equal(awayAt55.ended.returnedCharacterId, "c2");
  assert.equal(awayAt55.snapshot.current.characterId, "c2");
});

test("POL-COMPANION-001 跨日换出高精力旧同屏：节点后交接且不再有自动资格", () => {
  const dataDir = makeDataDir();
  const yesterday = new Date(2026, 9, 24, 9, 0, 0);
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedRosterExitData(dataDir, yesterday);
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const generated = harness.service.getSnapshot();
    assert.equal(generated.pendingRotation, true);
    assert.equal(generated.pendingRotationReason, "roster_exit");
    assert.equal(generated.current.characterId, "c5");
    assert.equal(generated.current.inRoster, false);
    assert.equal(generated.roster.some((entry) => entry.characterId === "c5"), false);

    const rotation = harness.service.completeNaturalNode();
    assert.equal(rotation.switched, true);
    assert.equal(rotation.reason, "roster_exit");
    assert.equal(rotation.toCharacterId, "c1");
    const after = harness.service.getSnapshot();
    assert.equal(after.current.characterId, "c1");
    assert.equal(after.pendingRotation, false);
    assert.equal(after.roster.some((entry) => entry.characterId === "c5"), false);
    assert.equal(
      after.characters.find((entry) => entry.characterId === "c5").inRoster,
      false,
      "被换出的角色不得继续拥有自动资格",
    );
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-003 跨日聊天：旧同屏离开名单不打断，结束再交接", () => {
  const dataDir = makeDataDir();
  const yesterday = new Date(2026, 9, 24, 9, 0, 0);
  const clock = makeClock(yesterday);
  seedRosterExitData(dataDir, yesterday);
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    harness.service.startInteraction("c5");
    clock.advanceHours(24);
    const during = harness.service.getSnapshot();
    assert.equal(during.interaction.characterId, "c5");
    assert.equal(during.current.characterId, "c5");
    assert.equal(during.pendingRotationReason, "roster_exit");
    assert.equal(during.roster.some((entry) => entry.characterId === "c5"), false);

    assert.equal(harness.service.completeNaturalNode().deferred, true);
    const ended = harness.service.endInteraction();
    assert.equal(ended.returnedCharacterId, "c1");
    const after = harness.service.getSnapshot();
    assert.equal(after.interaction, null);
    assert.equal(after.current.characterId, "c1");
    assert.equal(after.pendingRotation, false);
    assert.equal(after.roster.some((entry) => entry.characterId === "c5"), false);
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-004 时间结算：陪伴、候场、休息按整段互斥计算", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 100, c2: 40 },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    clock.advanceHours(1);
    let snapshot = harness.service.getSnapshot();
    assert.equal(snapshot.characters.find((entry) => entry.characterId === "c1").stats.energy, 94);
    assert.equal(snapshot.characters.find((entry) => entry.characterId === "c2").stats.energy, 50);

    harness.service.switchTo("c2");
    clock.advanceHours(1);
    snapshot = harness.service.getSnapshot();
    assert.equal(
      snapshot.characters.find((entry) => entry.characterId === "c2").stats.energy,
      44,
      "候场转为陪伴后不得继续按候场恢复",
    );

    harness.service.rest();
    clock.advanceHours(1);
    snapshot = harness.service.getSnapshot();
    assert.equal(snapshot.characters.find((entry) => entry.characterId === "c2").stats.energy, 64);
    assert.equal(snapshot.current.source, "resting");
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-004 休息：精力 40 经一小时恢复到 60", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(dataDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 40 },
  });
  const harness = startHarness(dataDir, clock, [0]);
  try {
    harness.service.rest();
    clock.advanceHours(1);
    const snapshot = harness.service.getSnapshot();
    assert.equal(snapshot.characters[0].stats.energy, 60);
    assert.equal(snapshot.current.source, "resting");
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-004 离线恢复、重开去重、回拨与 clamp", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(dataDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 40 },
  });
  let harness = startHarness(dataDir, clock, [0]);
  try {
    harness.service.markClosed();
    harness.store.close();
    clock.advanceHours(2);
    harness = startHarness(dataDir, clock, [0]);
    let snapshot = harness.service.getSnapshot();
    assert.equal(snapshot.characters[0].stats.energy, 60);
    assert.equal(snapshot.characters[0].stats.intimacy, 10);
    assert.equal(harness.service.getSnapshot().characters[0].stats.energy, 60);

    harness.service.markClosed();
    harness.store.close();
    harness = startHarness(dataDir, clock, [0]);
    snapshot = harness.service.getSnapshot();
    assert.equal(snapshot.characters[0].stats.energy, 60, "同一离线区间不得重复恢复");
  } finally {
    cleanup(dataDir, harness.store);
  }

  const rollbackDir = makeDataDir();
  const rollbackClock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(rollbackDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 40 },
  });
  const rollback = startHarness(rollbackDir, rollbackClock, [0]);
  try {
    rollbackClock.advanceHours(1);
    assert.equal(rollback.service.getSnapshot().characters[0].stats.energy, 34);
    rollbackClock.set(new Date(2026, 9, 25, 8, 0, 0));
    assert.equal(rollback.service.getSnapshot().characters[0].stats.energy, 34);
    rollbackClock.set(new Date(2026, 9, 25, 10, 0, 0));
    assert.equal(rollback.service.getSnapshot().characters[0].stats.energy, 34);
    rollbackClock.advanceHours(1);
    assert.equal(rollback.service.getSnapshot().characters[0].stats.energy, 28);
  } finally {
    cleanup(rollbackDir, rollback.store);
  }

  const clampDir = makeDataDir();
  const clampClock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(clampDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 2 },
  });
  const clamp = startHarness(clampDir, clampClock, [0]);
  try {
    clampClock.advanceHours(1);
    assert.equal(clamp.service.getSnapshot().characters[0].stats.energy, 0);
    clamp.service.rest();
    clampClock.advanceHours(10);
    assert.equal(clamp.service.getSnapshot().characters[0].stats.energy, 100);
  } finally {
    cleanup(clampDir, clamp.store);
  }
});

test("POL-COMPANION-005 低精力交接：节点后切换一次，聊天中等待", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4", "c5"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 25, c2: 70, c3: 65, c4: 80, c5: 59 },
    runtimes: { c4: { exploring: true } },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
      { slot: "random_4", characterId: "c5" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const request = harness.service.requestAutoRotation();
    assert.equal(request.requested, true);
    assert.equal(request.deferred, false);
    assert.equal(harness.service.getSnapshot().current.characterId, "c1", "节点前不得切换");
    assert.equal(harness.service.getSnapshot().pendingRotation, true);

    const switched = harness.service.completeNaturalNode();
    assert.equal(switched.switched, true);
    assert.equal(switched.toCharacterId, "c2");
    const after = harness.service.getSnapshot();
    assert.equal(after.current.characterId, "c2");
    assert.equal(after.pendingRotation, false);
    assert.equal(harness.store.getCompanion("c1").runtime.lastAutoExitAt, clock.now().getTime());
    assert.equal(harness.service.completeNaturalNode().switched, false, "重复完成信号应幂等");
    assert.equal(harness.service.getSnapshot().current.characterId, "c2");
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-005 低精力交接：聊天结束才换人，无候选则休息", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 25, c2: 70, c3: 80, c4: 59 },
    runtimes: {
      c2: { lastAutoExitAt: clock.now().getTime() - 10 * 60 * 1000 },
      c3: { exploring: true },
    },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    harness.service.startInteraction("c1");
    const request = harness.service.requestAutoRotation();
    assert.equal(request.requested, true);
    assert.equal(request.deferred, true);
    const inChat = harness.service.completeNaturalNode();
    assert.equal(inChat.switched, false);
    assert.equal(inChat.deferred, true);
    assert.equal(harness.service.getSnapshot().current.characterId, "c1");

    const ended = harness.service.endInteraction();
    assert.equal(ended.rotation.switched, false);
    assert.equal(ended.rotation.resting, true);
    const rested = harness.service.getSnapshot();
    assert.equal(rested.current.characterId, "c1");
    assert.equal(rested.current.source, "resting");
    assert.equal(rested.pendingRotation, false);
    assert.equal(harness.store.getCompanion("c2").runtime.lastAutoExitAt, clock.now().getTime() - 10 * 60 * 1000);
  } finally {
    cleanup(dataDir, harness.store);
  }

  const chatDir = makeDataDir();
  const chatClock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const chatDay = localDay(chatClock.now());
  seedModern(chatDir, {
    ids: ["c1", "c2"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 25, c2: 70 },
    rosterDay: chatDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
    ],
  });
  const chat = startHarness(chatDir, chatClock, [0, 0]);
  try {
    chat.service.startInteraction("c1");
    chat.service.requestAutoRotation();
    assert.equal(chat.service.completeNaturalNode().deferred, true);
    const ended = chat.service.endInteraction();
    assert.equal(ended.returnedCharacterId, "c1", "同角色结束先继续原陪伴");
    assert.equal(ended.rotation.switched, true, "低精力待办仍应按 <=30 规则交接");
    assert.equal(ended.rotation.toCharacterId, "c2");
    const afterChat = chat.service.getSnapshot();
    assert.equal(afterChat.current.characterId, "c2");
    assert.equal(afterChat.pendingRotation, false);
  } finally {
    cleanup(chatDir, chat.store);
  }
});

test("POL-COMPANION-005 低精力交接：精力回升不闪换", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 25, c2: 70 },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0]);
  try {
    harness.service.requestAutoRotation();
    const db = openDb(dataDir);
    try {
      db.prepare("UPDATE character_stats SET energy = 50 WHERE character_id = 'c1'").run();
    } finally {
      db.close();
    }
    const result = harness.service.completeNaturalNode();
    assert.equal(result.switched, false);
    assert.equal(result.reason, "recovered");
    assert.equal(harness.service.getSnapshot().current.characterId, "c1");
    assert.equal(harness.service.getSnapshot().pendingRotation, false);
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-002 固定位写入失败时名单与固定状态一起回滚", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2", "c3", "c4", "c5"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 100, c2: 90, c3: 80, c4: 70, c5: 60 },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
      { slot: "random_2", characterId: "c3" },
      { slot: "random_3", characterId: "c4" },
      { slot: "random_4", characterId: "c5" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const before = readRosterRows(dataDir, rosterDay);
    execSql(
      dataDir,
      `CREATE TRIGGER fail_roster_insert BEFORE INSERT ON roster
       BEGIN SELECT RAISE(ABORT, 'simulated roster failure'); END;`,
    );

    assert.throws(
      () => harness.service.setFixed("c3"),
      (error) => /simulated roster failure/.test(error.message),
    );
    assert.deepEqual(readRosterRows(dataDir, rosterDay), before);
    assert.equal(harness.store.getAppState("fixed_character_id"), "c1");

    execSql(dataDir, "DROP TRIGGER fail_roster_insert");
    harness.service.setFixed("c3");
    assert.equal(harness.store.getAppState("fixed_character_id"), "c3");
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-004 结算写入失败时精力与时间锚点一起回滚", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(dataDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 100 },
  });
  const harness = startHarness(dataDir, clock, [0]);
  try {
    const settledAt = harness.store.getRuntime("c1").lastSettledAt;
    execSql(
      dataDir,
      `CREATE TRIGGER fail_settlement BEFORE UPDATE OF last_settled_at ON character_runtime
       BEGIN SELECT RAISE(ABORT, 'simulated settlement failure'); END;`,
    );

    clock.advanceHours(1);
    assert.throws(
      () => harness.service.getSnapshot(),
      (error) => /simulated settlement failure/.test(error.message),
    );
    assert.equal(harness.store.getCompanion("c1").stats.energy, 100);
    assert.equal(harness.store.getRuntime("c1").lastSettledAt, settledAt);

    execSql(dataDir, "DROP TRIGGER fail_settlement");
    assert.equal(harness.service.getSnapshot().characters[0].stats.energy, 94);
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-005 交接写入失败时保留原同屏与待办", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const rosterDay = localDay(clock.now());
  seedModern(dataDir, {
    ids: ["c1", "c2"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 25, c2: 70 },
    rosterDay,
    roster: [
      { slot: "fixed", characterId: "c1" },
      { slot: "random_1", characterId: "c2" },
    ],
  });
  const harness = startHarness(dataDir, clock, [0, 0]);
  try {
    harness.service.requestAutoRotation();
    execSql(
      dataDir,
      `CREATE TRIGGER fail_handoff_update BEFORE UPDATE OF value ON app_state
       WHEN NEW.key = 'current_character_id'
       BEGIN SELECT RAISE(ABORT, 'simulated handoff failure'); END;
       CREATE TRIGGER fail_handoff_insert BEFORE INSERT ON app_state
       WHEN NEW.key = 'current_character_id'
       BEGIN SELECT RAISE(ABORT, 'simulated handoff failure'); END;`,
    );

    assert.throws(
      () => harness.service.completeNaturalNode(),
      (error) => /simulated handoff failure/.test(error.message),
    );
    assert.equal(harness.store.getAppState("current_character_id"), "c1");
    assert.equal(harness.store.getAppState("pending_rotation"), "low_energy");
    assert.equal(harness.store.getCompanion("c1").runtime.mode, "companion");
    assert.equal(harness.store.getCompanion("c1").runtime.lastAutoExitAt, null);
    assert.equal(harness.store.getCompanion("c2").runtime.mode, "waiting");

    execSql(dataDir, "DROP TRIGGER fail_handoff_update");
    execSql(dataDir, "DROP TRIGGER fail_handoff_insert");
    const result = harness.service.completeNaturalNode();
    assert.equal(result.switched, true);
    assert.equal(harness.store.getAppState("current_character_id"), "c2");
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-004 重复 start 先结算旧模式，不吞掉已运行区间", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  seedModern(dataDir, {
    ids: ["c1"],
    fixedId: "c1",
    currentId: "c1",
    energies: { c1: 100 },
  });
  const harness = startHarness(dataDir, clock, [0]);
  try {
    clock.advanceHours(1);
    runSql(
      dataDir,
      "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
      "c2",
      new Date(2026, 9, 25, 10, 0, 0).toISOString(),
    );
    runSql(
      dataDir,
      "INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES ('c2', 10, 100, 0)",
    );

    harness.service.start();
    assert.equal(
      harness.service.getSnapshot().characters.find((entry) => entry.characterId === "c1").stats
        .energy,
      94,
      "重复 start 必须先结算旧陪伴区间",
    );
    harness.service.start();
    assert.equal(
      harness.service.getSnapshot().characters.find((entry) => entry.characterId === "c1").stats
        .energy,
      94,
      "同锚点重复 start 不得重复结算",
    );
  } finally {
    cleanup(dataDir, harness.store);
  }
});

test("POL-COMPANION-006 旧 S01 schema 迁移：保留密文/关系/数值并可重复启动", () => {
  const dataDir = makeDataDir();
  const clock = makeClock(new Date(2026, 9, 25, 9, 0, 0));
  const yesterday = new Date(2026, 9, 24, 9, 0, 0);
  const cipher = Buffer.from([9, 8, 7, 6, 5]);
  const characters = CANDIDATE_IDS.slice(0, 6).map((id, index) => ({
    id,
    acceptedAt: new Date(2026, 9, 20, 9, index).toISOString(),
    energy: id === "c1" ? 55 : 100,
  }));
  createLegacyDatabase(dataDir, {
    characters,
    modelCipher: cipher,
    baseUrl: "https://legacy.example.com/v1",
    modelName: "legacy-model",
    fixedId: "c1",
    currentId: "c1",
    rosterDay: localDay(yesterday),
  });

  let harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
  try {
    const model = harness.store.getModelConfig();
    assert.equal(model.baseUrl, "https://legacy.example.com/v1");
    assert.equal(model.modelName, "legacy-model");
    assert.equal(Buffer.from(model.keyCipher).equals(cipher), true, "模型密文必须保留");

    const relationships = readRelationships(dataDir);
    assert.equal(relationships.length, 6);
    const c1 = relationships.find((row) => row.character_id === "c1");
    assert.equal(c1.accepted_at, characters[0].acceptedAt);
    assert.equal(c1.energy, 55);
    assert.equal(c1.intimacy, 10);
    assert.equal(c1.mood, 0);
    assert.equal(harness.store.getRoster(localDay(yesterday)).length, 1);
    assert.equal(harness.store.getRoster(localDay(yesterday))[0].characterId, "c1");

    const today = localDay(clock.now());
    const todayRoster = harness.store.getRoster(today);
    assert.equal(todayRoster.length, 5);
    assert.equal(todayRoster[0].slot, "fixed");
    assert.equal(todayRoster[0].characterId, "c1");
    assert.equal(new Set(todayRoster.map((entry) => entry.characterId)).size, 5);
    assert.deepEqual(
      todayRoster.slice(1).map((entry) => entry.characterId),
      ["c2", "c3", "c4", "c5"],
    );

    const db = openDb(dataDir, true);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
      const rosterSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roster'")
        .get().sql;
      assert.match(rosterSql, /random_1/);
      assert.match(rosterSql, /UNIQUE/);
      assert.equal(db.prepare("SELECT count(*) AS n FROM relationships").get().n, 6);
      assert.equal(db.prepare("SELECT count(*) AS n FROM character_stats").get().n, 6);
    } finally {
      db.close();
    }

    harness.service.markClosed();
    harness.store.close();
    harness = startHarness(dataDir, clock, [0, 0, 0, 0]);
    const modelAgain = harness.store.getModelConfig();
    assert.equal(Buffer.from(modelAgain.keyCipher).equals(cipher), true);
    assert.equal(readRelationships(dataDir).length, 6);
    assert.deepEqual(
      harness.store.getRoster(today).map((entry) => [entry.slot, entry.characterId]),
      todayRoster.map((entry) => [entry.slot, entry.characterId]),
      "迁移与再次启动不得重抽或编造记录",
    );
  } finally {
    cleanup(dataDir, harness.store);
  }
});
