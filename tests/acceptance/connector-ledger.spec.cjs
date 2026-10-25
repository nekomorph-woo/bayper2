/* S05a 正式验收：真实临时 SQLite、可控时钟与来源事实 fixture。
   覆盖 POL-CONNECTOR-001～006；不联网、不启动 GUI、不连接真实 Herdr、
   不读取真实 HOME/.env。SQL 查询与对外读取共同作为 Oracle。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createConnectorLedger } = require("../../app/connector-ledger.cjs");

const START = Date.UTC(2026, 9, 26, 12, 0, 0);
const SOURCE = "source";
const RUN = "run-1";

function makeContext(t, appRunId = "app-1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-connector-"));
  const dbPath = path.join(dir, "connector.sqlite3");
  let clock = START;
  let db = new DatabaseSync(dbPath);
  let ledger = createConnectorLedger({ db, now: () => clock, appRunId });
  const ctx = {
    dir,
    dbPath,
    get db() {
      return db;
    },
    get ledger() {
      return ledger;
    },
    setNow(value) {
      clock = value;
    },
    rebuildSameApp() {
      ledger = createConnectorLedger({ db, now: () => clock, appRunId: ledger.appRunId });
    },
    restartApp(nextAppRunId) {
      db.close();
      db = new DatabaseSync(dbPath);
      ledger = createConnectorLedger({ db, now: () => clock, appRunId: nextAppRunId });
    },
  };
  t.after(() => {
    try {
      db.close();
    } catch {
      // 测试主动重启后仍要清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

const A = (agentId, state, sequence, extra = {}) => ({ agentId, state, sequence, ...extra });

function register(ctx, instanceId, runId, label = null) {
  return ctx.ledger.registerInstance({ instanceId, runId, label });
}

function snap(ctx, instanceId, runId, agents, extra = {}) {
  return ctx.ledger.applySnapshot({ instanceId, runId, complete: true, agents, ...extra });
}

function change(ctx, instanceId, runId, agentId, state, sequence, eventId, extra = {}) {
  return ctx.ledger.recordAgentChange({
    instanceId, runId, agentId, state, sequence, eventId, ...extra,
  });
}

function base(ctx, agents = [A("A", "working", 1)], instanceId = SOURCE, runId = RUN) {
  register(ctx, instanceId, runId);
  return snap(ctx, instanceId, runId, agents);
}

function countEvents(ctx, where = "1=1", ...params) {
  return ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM connector_events WHERE ${where}`)
    .get(...params).count;
}

function eventsWhere(ctx, where = "1=1", ...params) {
  return ctx.db
    .prepare(`SELECT * FROM connector_events WHERE ${where} ORDER BY id ASC`)
    .all(...params);
}

function agentRow(ctx, instanceId, runId, agentId) {
  return ctx.db.prepare(`
    SELECT effective_state, last_known_state, max_sequence, in_snapshot
    FROM connector_agents WHERE instance_id = ? AND run_id = ? AND agent_id = ?
  `).get(instanceId, runId, agentId);
}

test("POL-CONNECTOR-001 同名来源与同名局部 Agent 各自独立，初始快照不冒充变化", (t) => {
  const ctx = makeContext(t);
  const [a, b] = ["install-a", "install-b"];
  const runId = "source-run-1";
  const localAgent = "terminal-1";

  // Given：两个来源使用相同展示名、相同 runId 与相同局部 agentId。
  const firstA = register(ctx, a, runId, "队长的 Mac");
  const firstB = register(ctx, b, runId, "队长的 Mac");

  // Result：首次可用各产生一次 online(P2)。
  assert.deepEqual([firstA.online, firstA.notified], [true, true]);
  assert.deepEqual([firstB.online, firstB.notified], [true, true]);

  // When：重复登记/握手，然后各自提交首份权威快照。
  assert.equal(register(ctx, a, runId, "队长的 Mac").notified, false);
  assert.equal(register(ctx, b, runId, "队长的 Mac").notified, false);
  const snapA = snap(ctx, a, runId, [A(localAgent, "working", 1)]);
  const snapB = snap(ctx, b, runId, [A(localAgent, "idle", 1)]);

  // Expected：每个来源一次 online，Agent 状态互不干扰，初始快照零变化通知。
  assert.deepEqual([snapA.baseline, snapB.baseline], [true, true]);
  assert.equal(countEvents(ctx, "kind = 'online'"), 2);
  assert.equal(countEvents(ctx, "kind IN ('agent_change', 'reconciled')"), 0);
  assert.equal(ctx.ledger.listPending().length, 2);
  assert.deepEqual(
    ctx.ledger.listAgents({ instanceId: a }).map((row) => [row.agentId, row.effectiveState, row.sequence]),
    [[localAgent, "working", 1]],
  );
  assert.deepEqual(
    ctx.ledger.listAgents({ instanceId: b }).map((row) => [row.agentId, row.effectiveState, row.sequence]),
    [[localAgent, "idle", 1]],
  );

  // 展示标签不是身份：online 事实分别落在两个 instanceId 上。
  const online = eventsWhere(ctx, "kind = 'online'");
  assert.deepEqual(online.map((row) => row.instance_id).sort(), [a, b]);
  assert.deepEqual(online.map((row) => row.notification_status), ["pending", "pending"]);
});

test("POL-CONNECTOR-002 真实状态过程、重复事件、后续 episode 与迟到低 sequence", (t) => {
  const ctx = makeContext(t);
  base(ctx);
  // 基线 working 作为当前状态入账，但不产生变化通知。
  assert.equal(ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN })[0].effectiveState, "working");

  // Given/When：真实过程 working → needs_attention → working，再进入新的 attention episode。
  const attention1 = change(ctx, SOURCE, RUN, "A", "needs_attention", 2, "evt-2", { rawState: "waiting" });
  const duplicate = change(ctx, SOURCE, RUN, "A", "needs_attention", 2, "evt-2", { rawState: "waiting" });
  const working = change(ctx, SOURCE, RUN, "A", "working", 3, "evt-3");
  const attention2 = change(ctx, SOURCE, RUN, "A", "needs_attention", 4, "evt-4");

  // When：一个真实但晚到的低 sequence 事件，以及同 sequence 的状态冲突。
  const late = change(ctx, SOURCE, RUN, "A", "idle", 0, "evt-late");
  const conflict = change(ctx, SOURCE, RUN, "A", "working", 4, "evt-conflict");

  // Result：三条真实变化入账；重复 eventId 不入账；后续 episode 仍通知。
  assert.equal(attention1.notified, true);
  assert.deepEqual([duplicate.accepted, duplicate.reason], [false, "DUPLICATE_EVENT"]);
  assert.deepEqual([working.notified, attention2.notified], [true, true]);
  assert.equal(countEvents(ctx, "source_event_id = 'evt-2'"), 1);

  // Expected：当前状态不倒退，历史条目可区分，冲突不覆盖当前。
  const [current] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });
  assert.deepEqual(
    [current.effectiveState, current.lastKnownState, current.sequence, current.rawState],
    ["needs_attention", "needs_attention", 4, null],
  );
  assert.deepEqual([late.accepted, late.historical, late.notified], [true, true, true]);
  assert.deepEqual([conflict.accepted, conflict.reason], [false, "SEQUENCE_CONFLICT"]);
  assert.equal(countEvents(ctx, "source_event_id = 'evt-conflict'"), 0);

  assert.deepEqual(
    ctx.ledger.listPending().map((row) => [row.eventId, row.priority, row.historical]),
    [
      [null, 2, false], ["evt-2", 0, false], ["evt-3", 2, false],
      ["evt-4", 0, false], ["evt-late", 2, true],
    ],
  );
  assert.equal(countEvents(ctx, "historical = 1 AND source_event_id = 'evt-late'"), 1);
});

test("POL-CONNECTOR-003 短断无闪动、长断一次、恢复一次、停止一次且不批量完成 Agent", (t) => {
  const ctx = makeContext(t);
  base(ctx);

  // Given/When：1 秒短断后在 3 秒内恢复。
  ctx.setNow(START + 1000);
  const short = ctx.ledger.markDisconnected({ instanceId: SOURCE, runId: RUN });
  ctx.setNow(START + 2000);
  const shortBack = register(ctx, SOURCE, RUN);

  // Expected：短断不产生 disconnected/recovered/online 闪动。
  assert.equal(short.first, true);
  assert.deepEqual([shortBack.recovered, shortBack.notified], [false, false]);
  assert.equal(countEvents(ctx, "kind IN ('disconnected', 'recovered')"), 0);

  // Given/When：从 3000ms 起的断联、重复 EOF，并在 3000ms 边界前后推进时钟。
  ctx.setNow(START + 3000);
  ctx.ledger.markDisconnected({ instanceId: SOURCE, runId: RUN });
  ctx.setNow(START + 4000);
  const eofAgain = ctx.ledger.markDisconnected({ instanceId: SOURCE, runId: RUN });
  ctx.setNow(START + 5999);
  assert.equal(ctx.ledger.tick().notified.length, 0);
  assert.equal(countEvents(ctx, "kind = 'disconnected'"), 0);
  ctx.setNow(START + 6000);
  assert.equal(ctx.ledger.tick().notified.length, 1);
  ctx.setNow(START + 10000);
  const eofLate = ctx.ledger.markDisconnected({ instanceId: SOURCE, runId: RUN });
  ctx.ledger.tick();

  // Expected：首次断联时间不被重复 EOF 延后，满 3000ms 只有一条 P1。
  assert.deepEqual([eofAgain.disconnectedAt, eofLate.disconnectedAt], [START + 3000, START + 3000]);
  assert.equal(countEvents(ctx, "kind = 'disconnected'"), 1);
  assert.deepEqual(
    eventsWhere(ctx, "kind = 'disconnected'").map((row) => [row.priority, row.notification_status]),
    [[1, "pending"]],
  );

  // When/Result：恢复一次 P2，重复登记不再追加。
  const recovered = register(ctx, SOURCE, RUN);
  const duplicateRecover = register(ctx, SOURCE, RUN);
  assert.deepEqual([recovered.recovered, recovered.notified, duplicateRecover.recovered], [true, false, false]);
  assert.deepEqual(
    eventsWhere(ctx, "kind = 'recovered'").map((row) => [row.priority, row.notification_status]),
    [[2, "pending"]],
  );

  // When/Result：明确停止一次 P1；重复停止不追加，也不批量伪造 Agent 终态。
  ctx.setNow(START + 11000);
  const stopped = ctx.ledger.confirmStopped({ instanceId: SOURCE, runId: RUN });
  const stoppedAgain = ctx.ledger.confirmStopped({ instanceId: SOURCE, runId: RUN });
  assert.deepEqual([stopped.stopped, stopped.recorded, stoppedAgain.recorded], [true, true, false]);
  assert.equal(countEvents(ctx, "kind = 'offline'"), 1);
  assert.equal(countEvents(ctx, "kind IN ('agent_change', 'reconciled')"), 0);

  const [current] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });
  assert.deepEqual([current.effectiveState, current.lastKnownState], ["unknown", "working"]);
  assert.equal(ctx.ledger.getInstance({ instanceId: SOURCE }).state, "offline");
});

test("POL-CONNECTOR-004 断档两种到达顺序、同 episode 去重、缺口留痕与缺 Agent unknown", (t) => {
  const ctx = makeContext(t);
  base(ctx, [A("A", "working", 1), A("B", "idle", 1)]);

  // Given/When：事件先于快照到达；快照读到同一 Agent/sequence/state。
  const eventFirst = change(ctx, SOURCE, RUN, "A", "needs_attention", 3, "evt-a3");
  const sameFactSnapshot = snap(ctx, SOURCE, RUN, [A("A", "needs_attention", 3), A("B", "idle", 1)]);

  // Expected：同一事实只有一个 P0 通知项。
  assert.equal(eventFirst.notified, true);
  assert.equal(sameFactSnapshot.reconciled, 0);
  assert.equal(
    countEvents(ctx, "agent_id = 'A' AND sequence = 3 AND state = 'needs_attention' AND notification_status = 'pending'"),
    1,
  );

  // When：两次带 gapped 的恢复快照读到更高 sequence 的新状态。
  const gappedFirst = snap(ctx, SOURCE, RUN, [A("A", "working", 4), A("B", "idle", 1)], { gapped: true });
  const gappedRepeat = snap(ctx, SOURCE, RUN, [A("A", "working", 4), A("B", "idle", 1)], { gapped: true });

  // Expected：只记一条 reconciled 和一条可追溯缺口，重复批次不刷屏。
  assert.deepEqual([gappedFirst.reconciled, gappedFirst.gapRecorded], [1, true]);
  assert.deepEqual([gappedRepeat.reconciled, gappedRepeat.gapRecorded], [0, false]);
  assert.equal(countEvents(ctx, "kind = 'gap'"), 1);
  assert.equal(countEvents(ctx, "kind = 'gap' AND notification_status = 'none'"), 1);

  // Given/When：快照先记录 B 的 finished，随后同一事实的事件才迟到。
  const snapshotFirst = snap(ctx, SOURCE, RUN, [A("A", "working", 4), A("B", "finished", 5)]);
  const eventAfterSnapshot = change(ctx, SOURCE, RUN, "B", "finished", 5, "evt-b5");

  // Expected：同一事实仍只有一个通知，后来补上的事件身份关联到既有条目。
  assert.equal(snapshotFirst.reconciled, 1);
  assert.deepEqual([eventAfterSnapshot.notified, eventAfterSnapshot.reason], [false, "SAME_EPISODE"]);
  const [bRow] = eventsWhere(ctx, "agent_id = 'B' AND sequence = 5 AND state = 'finished'");
  assert.deepEqual(
    [bRow.source_event_id, bRow.notification_status, bRow.priority],
    ["evt-b5", "pending", 1],
  );

  // When：旧快照、完整快照缺少 B、同一 episode 再读一次。
  const stale = snap(ctx, SOURCE, RUN, [A("A", "needs_attention", 2), A("B", "finished", 5)]);
  const missing = snap(ctx, SOURCE, RUN, [A("A", "working", 4)]);
  assert.deepEqual([stale.stale, missing.missing], [["A"], ["B"]]);
  const afterMissing = Object.fromEntries(
    ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN }).map((row) => [row.agentId, row]),
  );

  // Expected：缺 Agent 只标 unknown，不伪造 stopped/finished。
  assert.deepEqual(
    [afterMissing.B.effectiveState, afterMissing.B.lastKnownState, afterMissing.B.inSnapshot],
    ["unknown", "finished", false],
  );

  // When：同一 episode 的权威事件也重新读到该 Agent。
  const restoredByEvent = change(ctx, SOURCE, RUN, "B", "finished", 5, "evt-b5-restore");
  const reRead = snap(ctx, SOURCE, RUN, [A("A", "working", 4), A("B", "finished", 5)]);

  // Expected：恢复已知状态但不重复通知；旧 sequence 不回滚，相同 episode 不再入账。
  assert.deepEqual([restoredByEvent.notified, restoredByEvent.reason], [false, "RESTORED"]);
  assert.equal(reRead.reconciled, 0);
  const byId = Object.fromEntries(
    ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN }).map((row) => [row.agentId, row]),
  );
  assert.deepEqual(
    [byId.A.effectiveState, byId.A.sequence, byId.B.effectiveState, byId.B.inSnapshot],
    ["working", 4, "finished", true],
  );
  assert.equal(countEvents(ctx, "agent_id = 'B' AND state IN ('stopped', 'failed')"), 0);
  assert.equal(countEvents(ctx, "kind = 'reconciled'"), 2);
});

test("POL-CONNECTOR-005 新 runId 隔离旧代次；停用不自动复活，明确启用后才可连接", (t) => {
  const ctx = makeContext(t);
  const firstRun = "run-1";
  base(ctx, [A("A", "working", 1)], SOURCE, firstRun);
  change(ctx, SOURCE, firstRun, "A", "needs_attention", 2, "evt-attention");

  // When：来源进程真重启，以新 runId 登记。
  const secondRun = "run-2";
  const restarted = register(ctx, SOURCE, secondRun);

  // Expected：新生命周期一次 online，当前对象切换到新代次，旧历史仍保留。
  assert.deepEqual([restarted.newRun, restarted.notified], [true, true]);
  assert.equal(ctx.ledger.getInstance({ instanceId: SOURCE }).runId, secondRun);
  assert.equal(countEvents(ctx, "kind = 'online'"), 2);
  assert.deepEqual(
    ctx.ledger.listAgents({ instanceId: SOURCE, runId: firstRun }).map((row) => row.effectiveState),
    ["needs_attention"],
  );
  snap(ctx, SOURCE, secondRun, [A("A", "idle", 1)]);

  // When：旧代次的事件、登记、断线和停止全部迟到。
  const lateEvent = change(ctx, SOURCE, firstRun, "A", "finished", 99, "evt-late-old");
  const lateRegister = register(ctx, SOURCE, firstRun);
  const lateDisconnect = ctx.ledger.markDisconnected({ instanceId: SOURCE, runId: firstRun });
  const lateStop = ctx.ledger.confirmStopped({ instanceId: SOURCE, runId: firstRun });

  // Expected：旧代次不能污染新代次，也不自动切回旧 runId。
  assert.deepEqual(
    [lateEvent.reason, lateRegister.reason, lateDisconnect.reason, lateStop.reason],
    ["STALE_RUN", "STALE_RUN", "STALE_RUN", "STALE_RUN"],
  );
  assert.equal(ctx.ledger.getInstance({ instanceId: SOURCE }).state, "online");
  assert.equal(ctx.ledger.listAgents({ instanceId: SOURCE })[0].effectiveState, "idle");

  // When：主动停用来源，然后在停用状态下自动登记。
  const disabled = ctx.ledger.disableInstance({ instanceId: SOURCE });
  const disabledAgain = ctx.ledger.disableInstance({ instanceId: SOURCE });
  const blocked = register(ctx, SOURCE, "run-3");

  // Expected：停用持久化、不伪造 server stop、不自动复活。
  assert.deepEqual([disabled.disabled, disabled.changed], [true, true]);
  assert.deepEqual([disabledAgain.disabled, disabledAgain.changed], [true, false]);
  assert.deepEqual([blocked.online, blocked.reason], [false, "DISABLED"]);
  assert.equal(ctx.ledger.getInstance({ instanceId: SOURCE }).state, "offline");
  assert.equal(countEvents(ctx, "kind = 'offline'"), 0);
  assert.equal(countEvents(ctx, "kind = 'disabled' AND notification_status = 'none'"), 1);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM connector_runs WHERE run_id = 'run-3'").get().count,
    0,
  );
  assert.equal(countEvents(ctx, "kind = 'online'"), 2);

  // When/Result：只有明确启用后重新登记才恢复连接。
  assert.deepEqual(ctx.ledger.enableInstance({ instanceId: SOURCE }), { disabled: false, changed: true });
  const enabled = register(ctx, SOURCE, "run-3");
  assert.deepEqual([enabled.online, enabled.notified], [true, true]);
  assert.equal(countEvents(ctx, "kind = 'online'"), 3);
});

test("POL-CONNECTOR-006 待呈现持久化、服务/应用重启去重与事务回滚", (t) => {
  const ctx = makeContext(t);
  base(ctx);
  change(ctx, SOURCE, RUN, "A", "needs_attention", 2, "evt-2");
  change(ctx, SOURCE, RUN, "A", "finished", 3, "evt-3");

  // Given/When：pending 已入库，读取分页并标记部分已呈现。
  const pendingBefore = ctx.ledger.listPending();
  const firstPage = ctx.ledger.listEvents({ limit: 2 });
  const secondPage = ctx.ledger.listEvents({ after: firstPage.nextCursor, limit: 2 });
  const presented = ctx.ledger.markPresented([pendingBefore[0].id, pendingBefore[1].id]);
  const presentedAgain = ctx.ledger.markPresented([pendingBefore[1].id]);

  // Expected：顺序稳定、上限有界、呈现标记只迁移 pending。
  // 初始 baseline 现在作为不通知的 episode 入账，分页明细包含该行；pending
  // 仍只含 online 与两次状态变化，不能把 baseline 当成用户通知。
  assert.deepEqual(
    pendingBefore.map((row) => [row.kind, row.priority, row.notificationStatus]),
    [["online", 2, "pending"], ["agent_change", 0, "pending"], ["agent_change", 1, "pending"]],
  );
  assert.deepEqual(firstPage.items.map((row) => row.id), [1, 2]);
  assert.deepEqual(secondPage.items.map((row) => row.id), [3, 4]);
  assert.deepEqual([firstPage.nextCursor, secondPage.nextCursor], [2, null]);
  assert.deepEqual([presented.updated, presentedAgain.updated], [2, 0]);
  assert.equal(ctx.ledger.listPending().length, 1);

  // When：同 appRunId 重建服务，再以新 appRunId 模拟应用重启。
  ctx.rebuildSameApp();
  assert.equal(ctx.ledger.listPending().length, 1);
  assert.equal(register(ctx, SOURCE, RUN).notified, false);
  assert.equal(countEvents(ctx, "kind = 'online'"), 1);

  ctx.restartApp("app-2");
  const beforeReconnect = ctx.ledger.getInstance({ instanceId: SOURCE });
  const [beforeReconnectAgent] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });
  const pendingAcrossRestart = ctx.ledger.listPending();
  const reconnected = register(ctx, SOURCE, RUN);
  const replayed = change(ctx, SOURCE, RUN, "A", "needs_attention", 2, "evt-2");
  const [afterReplay] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });

  // Expected：重启不把上次 online 或旧 Agent 状态当已确认事实；重新登记本身
  // 也不能恢复旧状态，只有新权威快照才能恢复。
  assert.deepEqual([beforeReconnect.online, beforeReconnect.state], [false, "reconnecting"]);
  assert.deepEqual(
    [beforeReconnectAgent.effectiveState, beforeReconnectAgent.lastKnownState, beforeReconnectAgent.inSnapshot],
    ["unknown", "finished", false],
  );
  assert.equal(pendingAcrossRestart.length, 1);
  assert.deepEqual([reconnected.adopted, reconnected.notified], [true, true]);
  assert.equal(countEvents(ctx, "kind = 'online'"), 2);
  assert.deepEqual([replayed.accepted, replayed.reason], [false, "DUPLICATE_EVENT"]);
  assert.deepEqual([afterReplay.effectiveState, afterReplay.lastKnownState], ["unknown", "finished"]);

  const pendingAfterReconnect = ctx.ledger.listPending().length;
  const restored = snap(ctx, SOURCE, RUN, [A("A", "finished", 3)]);
  const [afterRestore] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });

  // Expected：同一 episode 的新快照恢复为 finished，不重复发通知。
  assert.equal(restored.reconciled, 0);
  assert.equal(ctx.ledger.listPending().length, pendingAfterReconnect);
  assert.deepEqual(
    [afterRestore.effectiveState, afterRestore.lastKnownState, afterRestore.inSnapshot],
    ["finished", "finished", true],
  );

  // Given/When：用 SQLite trigger 制造事件写入失败。
  ctx.db.exec(`
    CREATE TRIGGER fail_agent_event BEFORE INSERT ON connector_events
    WHEN NEW.source_event_id = 'boom-event'
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;
  `);
  assert.throws(
    () => change(ctx, SOURCE, RUN, "A", "idle", 9, "boom-event"),
    /fixture failure/,
  );
  ctx.db.exec("DROP TRIGGER fail_agent_event");

  // Expected：Agent 状态、sequence 与事件都没有半个结果。
  assert.equal(countEvents(ctx, "source_event_id = 'boom-event'"), 0);
  const [afterFailure] = ctx.ledger.listAgents({ instanceId: SOURCE, runId: RUN });
  assert.deepEqual([afterFailure.effectiveState, afterFailure.sequence], ["finished", 3]);

  // Given/When：来源登记在写入 online 事件时失败。
  ctx.db.exec(`
    CREATE TRIGGER fail_register BEFORE INSERT ON connector_events
    WHEN NEW.instance_id = 'rollback-install'
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;
  `);
  assert.throws(
    () => register(ctx, "rollback-install", "rollback-run"),
    /fixture failure/,
  );
  ctx.db.exec("DROP TRIGGER fail_register");

  // Expected：来源、运行代次与事件一起回滚，不留半条记录。
  assert.equal(ctx.db.prepare(
    "SELECT COUNT(*) AS count FROM connector_instances WHERE instance_id = 'rollback-install'",
  ).get().count, 0);
  assert.equal(ctx.db.prepare(
    "SELECT COUNT(*) AS count FROM connector_runs WHERE instance_id = 'rollback-install'",
  ).get().count, 0);
  assert.equal(countEvents(ctx, "instance_id = 'rollback-install'"), 0);
});

test("POL-CONNECTOR-007 重启/停止/断联后旧状态不可复活，baseline 与历史优先级按契约", (t) => {
  const ctx = makeContext(t);

  // Given/When：来源在 app-1 留下 finished 状态，然后应用以新 appRunId 重启。
  const restartId = "restart-src";
  const restartRun = "restart-run";
  base(ctx, [A("R", "working", 1)], restartId, restartRun);
  change(ctx, restartId, restartRun, "R", "needs_attention", 2, "restart-attn");
  change(ctx, restartId, restartRun, "R", "finished", 3, "restart-fin");
  ctx.restartApp("app-2");

  const [restartBefore] = ctx.ledger.listAgents({ instanceId: restartId, runId: restartRun });
  const instanceBefore = ctx.ledger.getInstance({ instanceId: restartId });
  assert.deepEqual(
    [restartBefore.effectiveState, restartBefore.lastKnownState, restartBefore.inSnapshot],
    ["unknown", "finished", false],
  );
  const restartSql = agentRow(ctx, restartId, restartRun, "R");
  assert.deepEqual(
    [restartSql.effective_state, restartSql.last_known_state, restartSql.in_snapshot],
    ["unknown", "finished", 0],
  );
  assert.deepEqual([instanceBefore.online, instanceBefore.state], [false, "reconnecting"]);

  // When：重新登记同一 runId，但不提供新快照。
  const restartRegister = register(ctx, restartId, restartRun);
  const [restartAfterRegister] = ctx.ledger.listAgents({ instanceId: restartId, runId: restartRun });
  assert.deepEqual([restartRegister.adopted, restartRegister.notified], [true, true]);
  assert.deepEqual(
    [restartAfterRegister.effectiveState, restartAfterRegister.lastKnownState],
    ["unknown", "finished"],
  );

  // Expected：只有新的权威快照能恢复 finished，且不重复通知。
  const pendingAfterRegister = ctx.ledger.listPending().length;
  const restartSnap = snap(ctx, restartId, restartRun, [A("R", "finished", 3)]);
  const [restartAfterSnap] = ctx.ledger.listAgents({ instanceId: restartId, runId: restartRun });
  assert.equal(restartSnap.reconciled, 0);
  assert.equal(ctx.ledger.listPending().length, pendingAfterRegister);
  assert.deepEqual(
    [restartAfterSnap.effectiveState, restartAfterSnap.lastKnownState, restartAfterSnap.inSnapshot],
    ["finished", "finished", true],
  );

  // Given/When：明确停止后收到迟到事件，并尝试提交旧代次新快照。
  const stopId = "stop-src";
  const stopRun = "stop-run";
  base(ctx, [A("S", "working", 1)], stopId, stopRun);
  assert.equal(ctx.ledger.confirmStopped({ instanceId: stopId, runId: stopRun }).recorded, true);
  const pendingBeforeStopLate = ctx.ledger.listPending().length;
  const stopLate = change(ctx, stopId, stopRun, "S", "needs_attention", 2, "stop-late-attn");
  const [stopLateRow] = eventsWhere(ctx, "source_event_id = 'stop-late-attn'");
  const [stopCurrent] = ctx.ledger.listAgents({ instanceId: stopId, runId: stopRun });

  // Expected：迟到包只入历史且按已结束待介入 P1，不修改当前 Agent。
  assert.deepEqual(
    [stopLate.accepted, stopLate.historical, stopLate.appliedCurrent, stopLate.reason],
    [true, true, false, "STOPPED_HISTORY"],
  );
  assert.deepEqual(
    [stopLateRow.historical, stopLateRow.notification_status, stopLateRow.priority],
    [1, "pending", 1],
  );
  assert.deepEqual(
    [stopCurrent.effectiveState, stopCurrent.lastKnownState, stopCurrent.sequence],
    ["unknown", "working", 1],
  );
  const stopSql = agentRow(ctx, stopId, stopRun, "S");
  assert.deepEqual(
    [stopSql.effective_state, stopSql.last_known_state, stopSql.max_sequence],
    ["unknown", "working", 1],
  );
  assert.equal(
    countEvents(ctx, "instance_id = 'stop-src' AND run_id = 'stop-run' AND kind = 'online'"),
    1,
  );
  assert.equal(
    countEvents(ctx, "instance_id = 'stop-src' AND run_id = 'stop-run' AND kind = 'recovered'"),
    0,
  );
  assert.equal(ctx.ledger.listPending().length, pendingBeforeStopLate + 1);

  const stopSnap = snap(ctx, stopId, stopRun, [A("S", "working", 2)]);
  assert.deepEqual([stopSnap.accepted, stopSnap.reason], [false, "STOPPED"]);
  assert.equal(
    ctx.ledger.listAgents({ instanceId: stopId, runId: stopRun })[0].effectiveState,
    "unknown",
  );
  assert.equal(register(ctx, stopId, stopRun).reason, "STOPPED_RUN");

  // Expected：新 run 正常接受，并拥有独立基线。
  const stopNewRun = "stop-run-2";
  assert.equal(register(ctx, stopId, stopNewRun).online, true);
  snap(ctx, stopId, stopNewRun, [A("S", "working", 1)]);
  assert.equal(
    ctx.ledger.listAgents({ instanceId: stopId }).find((row) => row.agentId === "S").effectiveState,
    "working",
  );

  // Given/When：断联但尚未重新登记时收到迟到事件和快照。
  const dropId = "drop-src";
  const dropRun = "drop-run";
  base(ctx, [A("D", "working", 1)], dropId, dropRun);
  assert.equal(ctx.ledger.markDisconnected({ instanceId: dropId, runId: dropRun }).first, true);
  const pendingBeforeDropLate = ctx.ledger.listPending().length;
  const dropLate = change(ctx, dropId, dropRun, "D", "working", 2, "drop-late");
  const [dropLateRow] = eventsWhere(ctx, "source_event_id = 'drop-late'");
  const [dropCurrent] = ctx.ledger.listAgents({ instanceId: dropId, runId: dropRun });

  // Expected：断联回包只入历史，不把 unknown 改写成在线当前事实。
  assert.deepEqual(
    [dropLate.accepted, dropLate.historical, dropLate.appliedCurrent, dropLate.reason],
    [true, true, false, "DISCONNECTED_HISTORY"],
  );
  assert.deepEqual(
    [dropLateRow.historical, dropLateRow.notification_status, dropLateRow.priority],
    [1, "pending", 2],
  );
  assert.deepEqual(
    [dropCurrent.effectiveState, dropCurrent.lastKnownState, dropCurrent.sequence],
    ["unknown", "working", 1],
  );
  const dropSql = agentRow(ctx, dropId, dropRun, "D");
  assert.deepEqual(
    [dropSql.effective_state, dropSql.last_known_state, dropSql.max_sequence],
    ["unknown", "working", 1],
  );
  assert.equal(
    countEvents(ctx, "instance_id = 'drop-src' AND run_id = 'drop-run' AND kind = 'online'"),
    1,
  );
  assert.equal(
    countEvents(ctx, "instance_id = 'drop-src' AND run_id = 'drop-run' AND kind = 'recovered'"),
    0,
  );
  assert.equal(ctx.ledger.listPending().length, pendingBeforeDropLate + 1);
  const dropSnap = snap(ctx, dropId, dropRun, [A("D", "working", 2)]);
  assert.deepEqual([dropSnap.accepted, dropSnap.reason], [false, "NOT_CONNECTED"]);

  // When：重新登记后由新权威快照对账。
  const dropReconnect = register(ctx, dropId, dropRun);
  assert.deepEqual([dropReconnect.recovered, dropReconnect.notified], [false, false]);
  const pendingBeforeDropSnap = ctx.ledger.listPending().length;
  const dropRestored = snap(ctx, dropId, dropRun, [A("D", "working", 2)]);
  const [dropAfter] = ctx.ledger.listAgents({ instanceId: dropId, runId: dropRun });

  // Expected：迟到历史事实参与对账，快照恢复当前状态但不重复通知。
  assert.deepEqual([dropRestored.accepted, dropRestored.reconciled], [true, 1]);
  assert.equal(ctx.ledger.listPending().length, pendingBeforeDropSnap);
  assert.deepEqual(
    [dropAfter.effectiveState, dropAfter.lastKnownState, dropAfter.sequence, dropAfter.inSnapshot],
    ["working", "working", 2, true],
  );
  const dropAfterSql = agentRow(ctx, dropId, dropRun, "D");
  assert.deepEqual(
    [dropAfterSql.effective_state, dropAfterSql.last_known_state, dropAfterSql.max_sequence,
      dropAfterSql.in_snapshot],
    ["working", "working", 2, 1],
  );
  const [dropAfterEvent] = eventsWhere(ctx, "source_event_id = 'drop-late'");
  assert.deepEqual(
    [dropAfterEvent.historical, dropAfterEvent.reconciled, dropAfterEvent.priority,
      dropAfterEvent.notification_status],
    [0, 1, 2, "pending"],
  );

  // Given/When：断联期间留下 needs_attention 历史，重连快照确认它仍是当前。
  const dropAttnId = "drop-attn-src";
  const dropAttnRun = "drop-attn-run";
  base(ctx, [A("X", "working", 1)], dropAttnId, dropAttnRun);
  ctx.ledger.markDisconnected({ instanceId: dropAttnId, runId: dropAttnRun });
  change(ctx, dropAttnId, dropAttnRun, "X", "needs_attention", 2, "drop-attn-late");
  const [dropAttnBefore] = eventsWhere(ctx, "source_event_id = 'drop-attn-late'");
  assert.deepEqual([dropAttnBefore.historical, dropAttnBefore.priority], [1, 1]);

  // When：重新登记并用同一事实的新权威快照确认。
  register(ctx, dropAttnId, dropAttnRun);
  const pendingBeforeDropAttnSnap = ctx.ledger.listPending().length;
  const dropAttnSnap = snap(ctx, dropAttnId, dropAttnRun, [A("X", "needs_attention", 2)]);
  const [dropAttnAfter] = eventsWhere(ctx, "source_event_id = 'drop-attn-late'");

  // Expected：当前仍需介入，升级同一条通知到 P0，不新增第二条。
  assert.deepEqual([dropAttnSnap.accepted, dropAttnSnap.reconciled], [true, 1]);
  assert.deepEqual(
    [dropAttnAfter.historical, dropAttnAfter.reconciled, dropAttnAfter.priority,
      dropAttnAfter.notification_status],
    [0, 1, 0, "pending"],
  );
  assert.equal(ctx.ledger.listPending().length, pendingBeforeDropAttnSnap);
  assert.equal(
    ctx.ledger.listAgents({ instanceId: dropAttnId, runId: dropAttnRun })[0].effectiveState,
    "needs_attention",
  );

  // Given/When：初始 baseline seq10 working 后进入 seq11 attention，旧 baseline 事件迟到。
  const baseId = "base-src";
  const baseRun = "base-run";
  base(ctx, [A("E", "working", 10)], baseId, baseRun);
  const [baseline] = eventsWhere(
    ctx, "instance_id = ? AND run_id = ? AND kind = 'baseline'", baseId, baseRun,
  );
  assert.deepEqual(
    [baseline.state, baseline.sequence, baseline.notification_status],
    ["working", 10, "none"],
  );
  assert.equal(change(ctx, baseId, baseRun, "E", "needs_attention", 11, "base-attn").notified, true);
  const pendingAfterBaseAttention = ctx.ledger.listPending().length;
  const oldBaseline = change(ctx, baseId, baseRun, "E", "working", 10, "base-old");
  const [baselineAfter] = eventsWhere(
    ctx, "instance_id = ? AND run_id = ? AND kind = 'baseline'", baseId, baseRun,
  );

  // Expected：旧 baseline 事实只附事件身份，不复活通知，也不改当前状态。
  assert.deepEqual(
    [oldBaseline.accepted, oldBaseline.historical, oldBaseline.notified],
    [true, true, false],
  );
  assert.equal(baselineAfter.source_event_id, "base-old");
  assert.equal(baselineAfter.notification_status, "none");
  assert.equal(ctx.ledger.listPending().length, pendingAfterBaseAttention);
  assert.equal(
    ctx.ledger.listAgents({ instanceId: baseId, runId: baseRun })[0].effectiveState,
    "needs_attention",
  );

  // When：当前恢复到 working 后，迟到低 seq 的 needs_attention 才入历史。
  assert.equal(change(ctx, baseId, baseRun, "E", "working", 12, "base-work").notified, true);
  const pendingAfterHistory = ctx.ledger.listPending().length;
  const histAttention = change(ctx, baseId, baseRun, "E", "needs_attention", 9, "hist-attn");
  const [histRow] = eventsWhere(ctx, "source_event_id = 'hist-attn'");

  // Expected：已结束的历史待介入按 P1，不升级成当前 P0 催促。
  assert.deepEqual([histAttention.historical, histAttention.notified], [true, true]);
  assert.deepEqual(
    [histRow.priority, histRow.historical, histRow.notification_status],
    [1, 1, "pending"],
  );
  assert.equal(ctx.ledger.listPending().length, pendingAfterHistory + 1);
  assert.equal(
    ctx.ledger.listAgents({ instanceId: baseId, runId: baseRun })[0].effectiveState,
    "working",
  );

  // Given/When：快照推进 sequence 但不改状态，随后同一 episode 事件迟到。
  const sameSnap = snap(ctx, baseId, baseRun, [A("E", "working", 13)]);
  const pendingAfterSameSnap = ctx.ledger.listPending().length;
  const sameEvent = change(ctx, baseId, baseRun, "E", "working", 13, "base-snap-same");
  const [sameRow] = eventsWhere(ctx, "source_event_id = 'base-snap-same'");

  // Expected：同 episode 去重，不新增通知。
  assert.equal(sameSnap.reconciled, 0);
  assert.deepEqual([sameEvent.notified, sameEvent.reason], [false, "SAME_EPISODE"]);
  assert.equal(sameRow.notification_status, "none");
  assert.equal(ctx.ledger.listPending().length, pendingAfterSameSnap);

  // Given/When：快照以 reconciled 记录新状态，随后同一事实事件才到。
  const changedSnap = snap(ctx, baseId, baseRun, [A("E", "needs_attention", 14)]);
  const pendingAfterChangedSnap = ctx.ledger.listPending().length;
  const changedEvent = change(ctx, baseId, baseRun, "E", "needs_attention", 14, "base-snap-attn");
  const reconciledRows = eventsWhere(
    ctx,
    "instance_id = ? AND run_id = ? AND agent_id = 'E' AND sequence = 14 AND state = 'needs_attention'",
    baseId,
    baseRun,
  );

  // Expected：快照事实只保留一个通知项，后来事件身份附到同一行。
  assert.equal(changedSnap.reconciled, 1);
  assert.deepEqual([changedEvent.notified, changedEvent.reason], [false, "SAME_EPISODE"]);
  assert.equal(reconciledRows.length, 1);
  assert.equal(reconciledRows[0].source_event_id, "base-snap-attn");
  assert.equal(ctx.ledger.listPending().length, pendingAfterChangedSnap);
});
