/* S05f 通知排队与呈现确认验收。
   真实 SQLite + 正式 connector ledger；fake presenter 只回执实际展示，不启动 GUI。
   时间由测试时钟推进，4/6 秒与 deadline 都按注入时间计算。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createConnectorLedger } = require("../../app/connector-ledger.cjs");
const { createNotificationPresentation } = require("../../app/notification-presentation.cjs");

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.hapilon/polaris/Bayper完整交付/evidence/s05f-notification",
);
const BATCH = process.env.S05F_BATCH || `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
const WRITE_EVIDENCE = process.env.S05F_EVIDENCE !== "0";
const START = 2_000_000;

function realish(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function redact(text, roots) {
  return roots.reduce(
    (value, root) => value.split(realish(root)).join("<isolated-root>")
      .split(root).join("<isolated-root>"),
    text,
  );
}

function saveEvidence(caseId, record, roots) {
  if (!WRITE_EVIDENCE) return null;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `case-${caseId}-${BATCH}.json`);
  fs.writeFileSync(file, `${redact(JSON.stringify(record, null, 2), roots)}\n`);
  return file;
}

function tempRoot(tag) {
  return fs.mkdtempSync(`/tmp/bayper-notify-${tag}-`);
}

function createClock() {
  let value = START;
  return {
    now: () => value,
    set(next) { value = next; },
    advance(ms) { value += ms; },
  };
}

function openLedger(root, appRunId, clock) {
  const db = new DatabaseSync(path.join(root, "notify.db"));
  const ledger = createConnectorLedger({ db, appRunId, now: clock.now });
  return { db, ledger };
}

function serviceFor(db, ledger, clock, options = {}) {
  return createNotificationPresentation({ db, ledger, now: clock.now, ...options });
}

function eventBySource(ledger, sourceEventId) {
  return ledger.listEvents({ limit: 300 }).items.find((item) => item.eventId === sourceEventId);
}

function allEvents(ledger, instanceId = null, runId = null) {
  const items = [];
  let after = 0;
  for (;;) {
    const page = ledger.listEvents({ instanceId, runId, after, limit: 200 });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    after = page.nextCursor;
  }
}

function pendingEvents(ledger) {
  return allEvents(ledger).filter((item) => item.notificationStatus === "pending");
}

function presentationFor(view, eventId) {
  return view.presentations.find((item) => item.items.some((entry) => entry.eventId === eventId));
}

function itemFor(view, eventId) {
  for (const presentation of view.presentations) {
    const item = presentation.items.find((entry) => entry.eventId === eventId);
    if (item) return { presentation, item };
  }
  return null;
}

function ackOnline(ledger, instanceId, runId) {
  const online = ledger.listEvents({ instanceId, runId, limit: 20 }).items.find(
    (item) => item.kind === "online" && item.notificationStatus === "pending",
  );
  if (online) ledger.markPresented([online.id]);
}

function registerAgents(ledger, instanceId, runId, label, agents) {
  ledger.registerInstance({ instanceId, runId, label });
  ackOnline(ledger, instanceId, runId);
  ledger.applySnapshot({
    instanceId, runId, complete: true,
    agents: agents.map((agentId) => ({ agentId, state: "idle", sequence: 0, label: `Agent ${agentId}` })),
  });
}

function record(ledger, instanceId, runId, agentId, state, sequence, eventId, occurredAt = null) {
  return ledger.recordAgentChange({
    instanceId, runId, agentId, state, sequence, eventId, occurredAt,
  });
}

test("POL-NOTIFY-001 三普通位、固定deadline与独立P0；4秒从回执算", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("001");
  const clock = createClock();
  const recordEvidence = { case: "001", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-001", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    registerAgents(ledger, instanceId, runId, "来源一", ["A", "B", "C", "D", "E", "F"]);
    assert.equal(record(ledger, instanceId, runId, "A", "finished", 1, "evt-A").accepted, true);
    for (const agentId of ["B", "C", "D", "E"]) {
      assert.equal(record(ledger, instanceId, runId, agentId, "working", 1, `evt-${agentId}`).accepted, true);
    }
    clock.advance(100);
    assert.equal(record(ledger, instanceId, runId, "F", "needs_attention", 1, "evt-F").accepted, true);
    clock.advance(200);
    service = serviceFor(db, ledger, clock);
    const first = service.tick();
    assert.equal(first.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(first.presentations.filter((item) => item.channel === "urgent").length, 1);
    const eventA = eventBySource(ledger, "evt-A");
    const eventF = eventBySource(ledger, "evt-F");
    const eventB = eventBySource(ledger, "evt-B");
    const itemA = itemFor(first, eventA.id);
    const itemB = itemFor(first, eventB.id);
    const itemF = itemFor(first, eventF.id);
    assert.ok(itemA && itemB && itemF);
    assert.equal(itemA.presentation.channel, "ordinary");
    assert.equal(itemF.presentation.channel, "urgent");
    assert.equal(itemA.item.priority, 1);
    assert.equal(itemB.item.priority, 2);
    assert.equal(itemF.item.priority, 0);
    assert.equal(itemA.item.dueAt, eventA.receivedAt + 4000);
    assert.equal(itemB.item.dueAt, eventB.receivedAt + 8000);
    assert.equal(itemF.item.dueAt, eventF.receivedAt + 1000);
    assert.equal(itemA.item.aggregateBy, eventA.receivedAt + 1000);
    assert.equal(itemF.item.aggregateBy, eventF.receivedAt + 500);
    assert.match(itemA.item.text, /已结束/);
    assert.doesNotMatch(itemA.item.text, /任务成功/);
    assert.equal(itemA.item.sourceLabel, "来源一");
    assert.equal(itemA.item.agentLabel, "Agent A");
    assert.equal(itemF.item.agentLabel, "Agent F");
    assert.equal(itemF.item.currentNeedsAttention, true);
    assert.equal(itemF.item.recovered, false);
    recordEvidence.firstView = first;
    recordEvidence.initialDeadlines = {
      A: itemA.item.dueAt, B: itemB.item.dueAt, F: itemF.item.dueAt,
    };

    clock.set(START + 1000);
    const ackA = service.acknowledge({
      presentationId: itemA.presentation.presentationId, eventIds: [eventA.id],
    });
    assert.equal(ackA.accepted, true);
    assert.equal(ackA.holdUntil, START + 5000);
    recordEvidence.ackA = ackA;
    clock.set(START + 4999);
    const beforeHold = service.tick();
    assert.equal(itemFor(beforeHold, eventA.id).presentation.state, "visible");
    assert.equal(beforeHold.presentations.filter((item) => item.channel === "ordinary").length, 3);
    clock.set(START + 5000);
    const afterHold = service.tick();
    assert.equal(itemFor(afterHold, eventA.id), null);
    assert.equal(afterHold.presentations.filter((item) => item.channel === "ordinary").length, 3);
    const newNormal = afterHold.presentations
      .filter((item) => item.channel === "ordinary")
      .flatMap((item) => item.items)
      .find((item) => ![eventA.id, eventB.id, eventBySource(ledger, "evt-C").id].includes(item.eventId));
    assert.ok(newNormal);
    assert.ok(["evt-D", "evt-E"].includes(
      allEvents(ledger).find((item) => item.id === newNormal.eventId).eventId,
    ));
    const sourceOfNew = allEvents(ledger).find((item) => item.id === newNormal.eventId);
    assert.equal(newNormal.dueAt, sourceOfNew.receivedAt + 8000);
    assert.ok(itemFor(afterHold, eventF.id));
    assert.ok(afterHold.overdueCount >= 1);
    recordEvidence.afterHold = afterHold;
    recordEvidence.ackAItem = ackA;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("001", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-002 blocked恢复保留原P0 deadline、加急追加与每条6秒", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("002");
  const clock = createClock();
  const recordEvidence = { case: "002", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-002", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instanceA = "inst-A";
    const runA = "run-A";
    ledger.registerInstance({ instanceId: instanceA, runId: runA, label: "来源A" });
    ackOnline(ledger, instanceA, runA);
    ledger.applySnapshot({
      instanceId: instanceA, runId: runA, complete: true,
      agents: [{ agentId: "A", state: "working", sequence: 1, label: "Agent A" }],
    });
    clock.set(START + 100);
    const blocked = ledger.recordObservation({
      instanceId: instanceA, runId: runA, agentId: "A", state: "needs_attention",
      observationId: "obs-A-blocked", sourcePaneId: "pane-A", sourceTerminalId: "term-A",
    });
    assert.equal(blocked.notified, true);
    ledger.applySnapshot({
      instanceId: instanceA, runId: runA, complete: true,
      agents: [{ agentId: "A", state: "needs_attention", sequence: 2 }],
    });
    clock.set(START + 400);
    ledger.applySnapshot({
      instanceId: instanceA, runId: runA, complete: true,
      agents: [{ agentId: "A", state: "working", sequence: 3 }],
    });
    const blockedEvent = allEvents(ledger).find(
      (item) => item.observationId === "obs-A-blocked",
    );
    assert.ok(blockedEvent);
    assert.equal(blockedEvent.historical, true);
    assert.equal(blockedEvent.priority, 1);
    assert.equal(blockedEvent.originalPriority, 0);

    clock.set(START + 450);
    service = serviceFor(db, ledger, clock);
    const first = service.tick();
    const blockedItem = itemFor(first, blockedEvent.id);
    assert.ok(blockedItem);
    assert.equal(blockedItem.presentation.channel, "urgent");
    assert.equal(blockedItem.item.priority, 0);
    assert.equal(blockedItem.item.originalPriority, 0);
    assert.equal(blockedItem.item.dueAt, blockedEvent.receivedAt + 1000);
    assert.equal(blockedItem.item.currentState, "working");
    assert.equal(blockedItem.item.currentNeedsAttention, false);
    assert.equal(blockedItem.item.recovered, true);
    assert.match(blockedItem.item.text, /曾需要确认，现已继续工作/);
    const urgentId = blockedItem.presentation.presentationId;
    const urgentStartedAt = blockedItem.presentation.createdAt;
    const urgentBatchStart = blockedItem.presentation.batchStartedAt;
    const workingEvents = allEvents(ledger).filter(
      (item) => item.kind === "reconciled" && item.agentId === "A" && item.sequence === 3,
    );
    assert.equal(workingEvents.length, 1);
    const workingItem = itemFor(first, workingEvents[0].id);
    assert.ok(workingItem);
    assert.equal(workingItem.presentation.channel, "ordinary");

    const p0Rows = [];
    for (const [instanceId, runId, agentId, at] of [
      ["inst-B", "run-B", "B", START + 500],
      ["inst-C", "run-C", "C", START + 600],
    ]) {
      ledger.registerInstance({ instanceId, runId, label: `来源${agentId}` });
      ackOnline(ledger, instanceId, runId);
      ledger.applySnapshot({
        instanceId, runId, complete: true,
        agents: [{ agentId, state: "idle", sequence: 0, label: `Agent ${agentId}` }],
      });
      clock.set(at);
      assert.equal(record(ledger, instanceId, runId, agentId, "needs_attention", 1,
        `evt-${agentId}`).accepted, true);
      p0Rows.push(eventBySource(ledger, `evt-${agentId}`));
      clock.set(at + 50);
      const appended = service.tick();
      const item = itemFor(appended, p0Rows[p0Rows.length - 1].id);
      assert.ok(item);
      assert.equal(item.presentation.presentationId, urgentId);
      assert.equal(item.presentation.createdAt, urgentStartedAt);
      assert.equal(item.presentation.batchStartedAt, urgentBatchStart);
    }
    const eventB = p0Rows[0];
    const eventC = p0Rows[1];

    /* 断档期间补到的历史 blocked 按 P1 并明确标历史，不能和在线 blocked 恢复混同。 */
    const instanceH = "inst-H";
    const runH = "run-H";
    ledger.registerInstance({ instanceId: instanceH, runId: runH, label: "来源H" });
    ackOnline(ledger, instanceH, runH);
    ledger.markDisconnected({ instanceId: instanceH, runId: runH });
    clock.set(START + 750);
    assert.equal(record(ledger, instanceH, runH, "H", "needs_attention", 1, "evt-H").accepted, true);
    const historyEvent = eventBySource(ledger, "evt-H");
    assert.equal(historyEvent.historical, true);
    assert.equal(historyEvent.priority, 1);
    clock.set(START + 800);
    const afterHistory = service.tick();
    const historyItem = itemFor(afterHistory, historyEvent.id);
    assert.ok(historyItem);
    assert.equal(historyItem.presentation.channel, "ordinary");
    assert.equal(historyItem.item.priority, 1);
    assert.equal(historyItem.item.historical, true);
    assert.match(historyItem.item.text, /^历史：/);
    const afterCItem = itemFor(afterHistory, eventC.id);
    assert.ok(afterCItem);
    assert.equal(afterCItem.item.currentNeedsAttention, true);

    clock.set(START + 1000);
    const ackA = service.acknowledge({ presentationId: urgentId, eventIds: [blockedEvent.id] });
    assert.equal(ackA.holdUntil, START + 7000);
    const ackWorking = service.acknowledge({
      presentationId: workingItem.presentation.presentationId,
      eventIds: [workingEvents[0].id],
    });
    assert.equal(ackWorking.holdUntil, START + 5000);
    clock.set(START + 1100);
    const ackB = service.acknowledge({ presentationId: urgentId, eventIds: [eventB.id] });
    assert.equal(ackB.holdUntil, START + 7100);
    clock.set(START + 1200);
    const ackC = service.acknowledge({ presentationId: urgentId, eventIds: [eventC.id] });
    assert.equal(ackC.holdUntil, START + 7200);
    clock.set(START + 4999);
    const ordinaryStill = service.tick();
    assert.ok(itemFor(ordinaryStill, workingEvents[0].id));
    clock.set(START + 5000);
    const ordinaryGone = service.tick();
    assert.equal(itemFor(ordinaryGone, workingEvents[0].id), null);
    clock.set(START + 7199);
    const stillUrgent = service.tick();
    assert.ok(itemFor(stillUrgent, eventC.id));
    assert.equal(itemFor(stillUrgent, eventC.id).item.currentNeedsAttention, true);
    clock.set(START + 7200);
    const expired = service.tick();
    assert.equal(itemFor(expired, eventC.id), null);
    assert.equal(itemFor(expired, blockedEvent.id), null);
    const full = service.tick();
    assert.equal(full.presentations.filter((item) => item.channel === "urgent").length, 0);
    recordEvidence.firstView = first;
    recordEvidence.afterExpiry = expired;
    recordEvidence.acks = { a: ackA, b: ackB, c: ackC };
    recordEvidence.blocked = blockedEvent;
    recordEvidence.history = historyEvent;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("002", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-003 重放/重复tick/回执、重建窗口、presented后关库重开", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("003");
  const clock = createClock();
  const recordEvidence = { case: "003", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    let opened = openLedger(root, "app-notify-003", clock);
    db = opened.db;
    let ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    registerAgents(ledger, instanceId, runId, "来源一", ["A", "B"]);
    assert.equal(record(ledger, instanceId, runId, "A", "finished", 1, "evt-1").accepted, true);
    clock.advance(10);
    assert.equal(record(ledger, instanceId, runId, "B", "working", 1, "evt-2").accepted, true);
    clock.advance(10);
    service = serviceFor(db, ledger, clock);
    const initial = service.tick();
    const event1 = eventBySource(ledger, "evt-1");
    const event2 = eventBySource(ledger, "evt-2");
    const firstOne = itemFor(initial, event1.id);
    const firstTwo = itemFor(initial, event2.id);
    assert.ok(firstOne && firstTwo);
    const firstPid = firstOne.presentation.presentationId;

    assert.throws(
      () => service.acknowledge({ presentationId: firstPid, eventIds: [event2.id] }),
      (error) => error.code === "NOTIFICATION_EVENT_NOT_IN_PRESENTATION",
    );
    const replay = ledger.recordAgentChange({
      instanceId, runId, agentId: "A", state: "finished", sequence: 1,
      eventId: "evt-1",
    });
    assert.equal(replay.accepted, false);
    assert.equal(replay.reason, "DUPLICATE_EVENT");
    assert.equal(pendingEvents(ledger).length, 2);
    const repeated = service.tick();
    assert.equal(itemFor(repeated, event1.id).presentation.presentationId, firstPid);
    assert.equal(repeated.presentations.length, 2);

    const rebuilt = service.rebuildWindow();
    assert.ok(rebuilt.invalidated >= 2);
    assert.throws(
      () => service.acknowledge({ presentationId: firstPid, eventIds: [event1.id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const afterRebuild = service.tick();
    const rebuiltOne = itemFor(afterRebuild, event1.id);
    assert.ok(rebuiltOne);
    assert.notEqual(rebuiltOne.presentation.presentationId, firstPid);
    assert.equal(rebuiltOne.item.dueAt, event1.receivedAt + 4000);
    assert.equal(rebuiltOne.item.receivedAt, event1.receivedAt);

    clock.set(START + 1000);
    const ack1 = service.acknowledge({
      presentationId: rebuiltOne.presentation.presentationId, eventIds: [event1.id],
    });
    assert.equal(ack1.accepted, true);
    const hold = ack1.holdUntil;
    clock.set(START + 1001);
    const ack1Again = service.acknowledge({
      presentationId: rebuiltOne.presentation.presentationId, eventIds: [event1.id],
    });
    assert.equal(ack1Again.alreadyPresented, 1);
    const viewAfterAck = service.tick();
    assert.equal(itemFor(viewAfterAck, event1.id).item.holdUntil, hold);
    assert.equal(eventBySource(ledger, "evt-2").notificationStatus, "pending");
    const oldTwoPid = itemFor(viewAfterAck, event2.id).presentation.presentationId;

    service.dispose();
    service = null;
    db.close();
    db = null;
    opened = openLedger(root, "app-notify-003b", clock);
    db = opened.db;
    ledger = opened.ledger;
    service = serviceFor(db, ledger, clock);
    assert.throws(
      () => service.acknowledge({ presentationId: oldTwoPid, eventIds: [event2.id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const reopened = service.tick();
    assert.equal(itemFor(reopened, event1.id), null);
    const reopenedTwo = itemFor(reopened, event2.id);
    assert.ok(reopenedTwo);
    assert.equal(reopenedTwo.item.dueAt, event2.receivedAt + 8000);
    assert.equal(eventBySource(ledger, "evt-1").notificationStatus, "presented");
    assert.equal(eventBySource(ledger, "evt-2").notificationStatus, "pending");
    assert.equal(allEvents(ledger).filter((item) => item.eventId).length, 2);
    recordEvidence.initial = initial;
    recordEvidence.rebuilt = rebuilt;
    recordEvidence.afterRebuild = afterRebuild;
    recordEvidence.reopened = reopened;
    recordEvidence.acks = { ack1, ack1Again };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("003", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-004 多页积压、多实例同名Agent、不可见窗口与超期记录", {
  timeout: 30000,
}, async () => {
  const root = tempRoot("004");
  const clock = createClock();
  const recordEvidence = { case: "004", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-004", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instances = [0, 1, 2, 3].map((index) => ({
      instanceId: `inst-${index}`,
      runId: `run-${index}`,
      label: `来源${index}`,
    }));
    for (const item of instances) {
      registerAgents(ledger, item.instanceId, item.runId, item.label, ["A", "B"]);
    }
    const sequences = new Map();
    for (let index = 0; index < 205; index += 1) {
      const instance = instances[index % instances.length];
      const agentId = index % 2 === 0 ? "A" : "B";
      const key = `${instance.instanceId}/${agentId}`;
      const sequence = (sequences.get(key) || 0) + 1;
      sequences.set(key, sequence);
      const state = index === 204 ? "needs_attention" : (index % 3 === 0 ? "finished" : "working");
      assert.equal(record(ledger, instance.instanceId, instance.runId, agentId, state,
        sequence, `evt-${index}`).accepted, true);
    }
    clock.set(START + 9000);
    service = serviceFor(db, ledger, clock);
    const first = service.tick();
    assert.equal(first.scan.pages, 3);
    assert.equal(first.scan.scanned, 205);
    assert.equal(first.scan.complete, true);
    assert.equal(first.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(first.presentations.filter((item) => item.channel === "urgent").length, 1);
    assert.equal(first.presentations.length, 4);
    assert.equal(pendingEvents(ledger).length, 205);
    assert.equal(allEvents(ledger).filter((item) => item.eventId && item.notificationStatus === "presented").length, 0);
    const activeItems = first.presentations.flatMap((presentation) => presentation.items);
    assert.ok(activeItems.every((item) => item.sourceLabel && item.agentLabel));
    assert.ok(activeItems.some((item) => item.agentId === "A"));
    assert.ok(activeItems.some((item) => item.agentId === "B"));
    const sourceKeys = new Set(activeItems.map((item) => `${item.instanceId}/${item.agentId}`));
    assert.ok(sourceKeys.size >= 2);
    const overdue = service.listOverdue({ limit: 300 });
    assert.equal(overdue.length, 205);
    assert.ok(overdue.some((item) => item.reason === "QUEUED"));
    assert.ok(overdue.some((item) => item.reason === "NOT_ACKNOWLEDGED"));
    const second = service.tick();
    assert.deepEqual(
      second.presentations.map((item) => item.presentationId),
      first.presentations.map((item) => item.presentationId),
    );
    assert.equal(service.listOverdue({ limit: 300 }).length, 205);

    clock.set(START + 9000);
    for (const presentation of first.presentations) {
      const ack = service.acknowledge({
        presentationId: presentation.presentationId,
        eventIds: presentation.items.map((item) => item.eventId),
      });
      assert.equal(ack.accepted, true);
    }
    assert.equal(pendingEvents(ledger).length, 201);
    clock.set(START + 13000);
    const afterOrdinary = service.tick();
    assert.equal(afterOrdinary.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(afterOrdinary.presentations.filter((item) => item.channel === "urgent").length, 1);
    const newOrdinaryEvents = afterOrdinary.presentations
      .filter((item) => item.channel === "ordinary").flatMap((item) => item.items);
    assert.ok(newOrdinaryEvents.every(
      (item) => !activeItems.some((old) => old.eventId === item.eventId),
    ));
    assert.ok(newOrdinaryEvents.every((item) => item.dueAt <= START + 9000 + 8000));
    clock.set(START + 15000);
    const afterUrgent = service.tick();
    assert.equal(afterUrgent.presentations.filter((item) => item.channel === "urgent").length, 0);
    assert.ok(afterUrgent.presentations.length <= 3);
    assert.equal(pendingEvents(ledger).length, 201);
    assert.equal(allEvents(ledger).filter((item) => item.eventId && item.notificationStatus === "presented").length, 4);
    assert.ok(afterUrgent.presentations.length <= 3);
    recordEvidence.first = first;
    recordEvidence.afterOrdinary = afterOrdinary;
    recordEvidence.afterUrgent = afterUrgent;
    recordEvidence.overdue = {
      count: overdue.length,
      reasons: overdue.reduce((map, item) => {
        map[item.reason] = (map[item.reason] || 0) + 1;
        return map;
      }, {}),
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("004", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-005 呈现写入失败可重试、无角色/模型依赖与dispose代次", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("005");
  const clock = createClock();
  const recordEvidence = { case: "005", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-005", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    registerAgents(ledger, instanceId, runId, "来源一", ["A", "B"]);
    assert.equal(record(ledger, instanceId, runId, "A", "finished", 1, "evt-A").accepted, true);
    clock.set(START + 100);
    service = serviceFor(db, ledger, clock);
    const first = service.tick();
    const eventA = eventBySource(ledger, "evt-A");
    const itemA = itemFor(first, eventA.id);
    assert.ok(itemA);
    db.exec(`
      CREATE TRIGGER fail_notification_item
      BEFORE UPDATE ON notification_presentation_items
      BEGIN SELECT RAISE(ABORT, 'forced presentation write failure'); END;
    `);
    clock.set(START + 200);
    assert.throws(
      () => service.acknowledge({
        presentationId: itemA.presentation.presentationId, eventIds: [eventA.id],
      }),
      (error) => error.code === "NOTIFICATION_WRITE_FAILED",
    );
    /* 失败必须同时回滚账本 presented 与呈现 ack，不能把账本成功当半提交。 */
    assert.equal(eventBySource(ledger, "evt-A").notificationStatus, "pending");
    const beforeRetry = db.prepare(`
      SELECT COUNT(*) AS count FROM notification_presentation_items
      WHERE event_id = ? AND acknowledged_at IS NOT NULL
    `).get(eventA.id);
    assert.equal(beforeRetry.count, 0);
    db.exec("DROP TRIGGER fail_notification_item");
    clock.set(START + 300);
    const retry = service.acknowledge({
      presentationId: itemA.presentation.presentationId, eventIds: [eventA.id],
    });
    assert.equal(retry.accepted, true);
    assert.equal(retry.holdUntil, START + 4300);
    assert.equal(eventBySource(ledger, "evt-A").notificationStatus, "presented");
    assert.equal(allEvents(ledger).filter((item) => item.eventId === "evt-A").length, 1);
    clock.set(START + 4299);
    const beforeClose = service.tick();
    assert.ok(itemFor(beforeClose, eventA.id));
    clock.set(START + 4300);
    const closed = service.tick();
    assert.equal(itemFor(closed, eventA.id), null);
    assert.equal(pendingEvents(ledger).length, 0);
    const afterClose = service.tick();
    assert.equal(afterClose.presentations.length, 0);

    clock.set(START + 5000);
    assert.equal(record(ledger, instanceId, runId, "B", "working", 1, "evt-B").accepted, true);
    const second = service.tick();
    const eventB = eventBySource(ledger, "evt-B");
    const itemB = itemFor(second, eventB.id);
    assert.ok(itemB);
    const closedPid = itemB.presentation.presentationId;
    const userClose = service.closePresentation({ presentationId: closedPid });
    assert.equal(userClose.closed, true);
    assert.equal(eventBySource(ledger, "evt-B").notificationStatus, "pending");
    assert.throws(
      () => service.acknowledge({ presentationId: closedPid, eventIds: [eventB.id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const afterUserClose = service.tick();
    const retryB = itemFor(afterUserClose, eventB.id);
    assert.ok(retryB);
    const oldDisposePid = retryB.presentation.presentationId;
    service.dispose();
    assert.throws(
      () => service.acknowledge({ presentationId: oldDisposePid, eventIds: [eventB.id] }),
      (error) => error.code === "NOTIFICATION_DISPOSED",
    );
    service = null;
    const reopened = serviceFor(db, ledger, clock);
    assert.throws(
      () => reopened.acknowledge({
        presentationId: oldDisposePid, eventIds: [eventB.id],
      }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const reopenedView = reopened.tick();
    assert.ok(itemFor(reopenedView, eventB.id));
    assert.equal(eventBySource(ledger, "evt-B").notificationStatus, "pending");
    reopened.dispose();
    recordEvidence.first = first;
    recordEvidence.retry = retry;
    recordEvidence.beforeRetryAckRows = beforeRetry.count;
    recordEvidence.userClose = userClose;
    recordEvidence.pendingAfterClose = pendingEvents(ledger).length;
    recordEvidence.dependencies = { characterInputs: 0, modelCalls: 0 };
    recordEvidence.cleanup.service = "disposed";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("005", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-006 呈现写入失败后关库重开，账本与ack原子恢复并反向验证", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("006");
  const clock = createClock();
  const recordEvidence = { case: "006", source: "fake-presenter", cleanup: {}, failures: [] };
  let db = null;
  let ledger = null;
  let service = null;
  try {
    let opened = openLedger(root, "app-notify-006", clock);
    db = opened.db;
    ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    registerAgents(ledger, instanceId, runId, "来源一", ["A"]);
    assert.equal(record(ledger, instanceId, runId, "A", "finished", 1, "evt-A").accepted, true);
    clock.set(START + 100);
    service = serviceFor(db, ledger, clock);
    const first = service.tick();
    const eventA = eventBySource(ledger, "evt-A");
    const itemA = itemFor(first, eventA.id);
    assert.ok(itemA);
    const originalPid = itemA.presentation.presentationId;
    const readAck = () => db.prepare(`
      SELECT acknowledged_at, hold_until FROM notification_presentation_items
      WHERE presentation_id = ? AND event_id = ?
    `).get(originalPid, eventA.id);

    db.exec(`
      CREATE TRIGGER fail_ledger_present
      BEFORE UPDATE ON connector_events
      WHEN NEW.notification_status = 'presented'
      BEGIN SELECT RAISE(ABORT, 'forced ledger presented failure'); END;
    `);
    assert.throws(
      () => service.acknowledge({
        presentationId: originalPid, eventIds: [eventA.id],
      }),
      (error) => error.code === "NOTIFICATION_WRITE_FAILED",
    );
    const reverseFailure = {
      ledger: eventBySource(ledger, "evt-A").notificationStatus,
      ack: readAck()?.acknowledged_at ?? null,
      presentation: itemFor(service.getView(), eventA.id)?.presentation.state ?? null,
    };
    recordEvidence.failures.push({ phase: "ledger", ...reverseFailure });
    assert.deepEqual(
      [reverseFailure.ledger, reverseFailure.ack, reverseFailure.presentation],
      ["pending", null, "offered"],
    );
    db.exec("DROP TRIGGER fail_ledger_present");

    db.exec(`
      CREATE TRIGGER fail_mark_visible
      BEFORE UPDATE ON notification_presentations
      WHEN NEW.state = 'visible'
      BEGIN SELECT RAISE(ABORT, 'forced markVisible failure'); END;
    `);
    assert.throws(
      () => service.acknowledge({
        presentationId: originalPid, eventIds: [eventA.id],
      }),
      (error) => error.code === "NOTIFICATION_WRITE_FAILED",
    );
    const visibleFailure = {
      ledger: eventBySource(ledger, "evt-A").notificationStatus,
      ack: readAck()?.acknowledged_at ?? null,
      presentation: itemFor(service.getView(), eventA.id)?.presentation.state ?? null,
    };
    recordEvidence.failures.push({ phase: "markVisible", ...visibleFailure });
    assert.deepEqual(
      [visibleFailure.ledger, visibleFailure.ack, visibleFailure.presentation],
      ["pending", null, "offered"],
    );
    db.exec("DROP TRIGGER fail_mark_visible");

    /* 进程退出式关库：不 dispose、不再使用旧 service。 */
    service = null;
    db.close();
    db = null;
    opened = openLedger(root, "app-notify-006b", clock);
    db = opened.db;
    ledger = opened.ledger;
    service = serviceFor(db, ledger, clock);
    assert.throws(
      () => service.acknowledge({ presentationId: originalPid, eventIds: [eventA.id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const reopened = service.tick();
    const reopenedA = itemFor(reopened, eventA.id);
    assert.ok(reopenedA);
    assert.equal(reopenedA.item.dueAt, eventA.receivedAt + 4000);
    assert.notEqual(reopenedA.presentation.presentationId, originalPid);
    clock.set(START + 200);
    const ack = service.acknowledge({
      presentationId: reopenedA.presentation.presentationId, eventIds: [eventA.id],
    });
    assert.equal(ack.accepted, true);
    assert.equal(ack.holdUntil, START + 4200);
    const ackPid = reopenedA.presentation.presentationId;
    assert.equal(eventBySource(ledger, "evt-A").notificationStatus, "presented");

    service = null;
    db.close();
    db = null;
    opened = openLedger(root, "app-notify-006c", clock);
    db = opened.db;
    ledger = opened.ledger;
    service = serviceFor(db, ledger, clock);
    assert.throws(
      () => service.acknowledge({ presentationId: ackPid, eventIds: [eventA.id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const finalView = service.tick();
    assert.equal(itemFor(finalView, eventA.id), null);
    assert.equal(pendingEvents(ledger).length, 0);
    assert.equal(eventBySource(ledger, "evt-A").notificationStatus, "presented");
    const persisted = db.prepare(`
      SELECT acknowledged_at, hold_until FROM notification_presentation_items
      WHERE presentation_id = ? AND event_id = ?
    `).get(ackPid, eventA.id);
    assert.equal(persisted.acknowledged_at, START + 200);
    assert.equal(persisted.hold_until, START + 4200);
    recordEvidence.reopened = { reopened, ack, persisted };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("006", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-007 跨tick分页下全局deadline选择、旧pending恢复与3+1", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("007");
  const clock = createClock();
  const recordEvidence = { case: "007", source: "fake-presenter", cleanup: {} };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-007", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    const agentIds = Array.from({ length: 12 }, (_, index) => `A${index}`);
    registerAgents(ledger, instanceId, runId, "来源一", agentIds);
    const events = [];
    for (let index = 0; index < 12; index += 1) {
      clock.set(START + index * 10);
      const state = index === 5 ? "needs_attention" : (index % 3 === 0 ? "finished" : "working");
      assert.equal(record(ledger, instanceId, runId, agentIds[index], state, 1,
        `evt-${index}`).accepted, true);
      events.push(eventBySource(ledger, `evt-${index}`));
    }
    const firstPage = ledger.listPendingPage({ after: 0, limit: 5 });
    const firstPageSources = firstPage.items.map((item) => item.eventId);
    assert.deepEqual(firstPageSources, ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]);
    assert.equal(firstPageSources.includes("evt-5"), false);
    assert.equal(firstPageSources.includes("evt-6"), false);

    clock.set(START + 9000);
    service = serviceFor(db, ledger, clock, { pageSize: 5, maxScanPages: 1 });
    const page1 = service.tick();
    assert.equal(page1.scan.pages, 1);
    assert.equal(page1.scan.scanned, 5);
    assert.equal(page1.scan.complete, false);
    assert.ok(page1.scan.nextCursor);
    assert.equal(page1.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(page1.presentations.filter((item) => item.channel === "urgent").length, 1);
    const firstOrdinary = page1.presentations
      .filter((item) => item.channel === "ordinary").flatMap((item) => item.items);
    const firstOrdinarySources = firstOrdinary.map((item) => item.sourceEventId).sort();
    assert.deepEqual(firstOrdinarySources, ["evt-0", "evt-3", "evt-6"]);
    assert.ok(firstOrdinary.every((item) => item.sourceEventId));
    const p0First = itemFor(page1, events[5].id);
    assert.ok(p0First);
    assert.equal(p0First.presentation.channel, "urgent");
    assert.equal(p0First.item.sourceEventId, "evt-5");
    assert.equal(p0First.item.dueAt, events[5].receivedAt + 1000);
    const p0Pid = p0First.presentation.presentationId;

    const page2 = service.tick();
    assert.equal(page2.scan.pages, 1);
    assert.equal(page2.scan.scanned, 5);
    assert.equal(page2.scan.complete, false);
    assert.deepEqual(
      page2.presentations.map((item) => item.presentationId),
      page1.presentations.map((item) => item.presentationId),
    );
    const page3 = service.tick();
    assert.equal(page3.scan.pages, 1);
    assert.equal(page3.scan.scanned, 2);
    assert.equal(page3.scan.complete, true);
    assert.equal(pendingEvents(ledger).length, 12);
    assert.equal(service.listOverdue({ limit: 50 }).length, 12);
    assert.equal(allEvents(ledger).filter(
      (item) => item.eventId && item.notificationStatus === "presented",
    ).length, 0);

    const rebuilt = service.rebuildWindow();
    assert.ok(rebuilt.invalidated >= 4);
    assert.throws(
      () => service.acknowledge({ presentationId: p0Pid, eventIds: [events[5].id] }),
      (error) => error.code === "NOTIFICATION_STALE_PRESENTATION",
    );
    const again1 = service.tick();
    assert.equal(again1.scan.pages, 1);
    assert.equal(again1.scan.scanned, 5);
    assert.ok(again1.presentations.filter((item) => item.channel === "ordinary").length === 3);
    assert.equal(again1.presentations.filter((item) => item.channel === "urgent").length, 1);
    const recoveredOrdinarySources = again1.presentations
      .filter((item) => item.channel === "ordinary").flatMap((item) => item.items)
      .map((item) => item.sourceEventId).sort();
    assert.deepEqual(recoveredOrdinarySources, firstOrdinarySources);
    const recoveredP0 = itemFor(again1, events[5].id);
    assert.ok(recoveredP0);
    assert.notEqual(recoveredP0.presentation.presentationId, p0Pid);
    assert.equal(recoveredP0.item.dueAt, events[5].receivedAt + 1000);
    assert.equal(recoveredP0.item.acknowledgedAt, null);
    const again2 = service.tick();
    assert.equal(again2.scan.pages, 1);
    assert.equal(again2.scan.scanned, 5);
    const again3 = service.tick();
    assert.equal(again3.scan.pages, 1);
    assert.equal(again3.scan.scanned, 2);
    assert.equal(again3.scan.complete, true);

    const activeBeforeProgress = again3.presentations
      .flatMap((item) => item.items.map((entry) => entry.eventId));
    clock.set(START + 9000);
    for (const presentation of again3.presentations) {
      service.acknowledge({
        presentationId: presentation.presentationId,
        eventIds: presentation.items.map((item) => item.eventId),
      });
    }
    clock.set(START + 15000);
    const progressed = service.tick();
    assert.equal(progressed.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(progressed.presentations.filter((item) => item.channel === "urgent").length, 0);
    assert.ok(progressed.presentations.flatMap((item) => item.items)
      .every((item) => !activeBeforeProgress.includes(item.eventId)));
    assert.equal(pendingEvents(ledger).length, 8);
    assert.equal(allEvents(ledger).filter(
      (item) => item.eventId && item.notificationStatus === "presented",
    ).length, 4);
    for (const view of [page1, page2, page3, again1, again2, again3, progressed]) {
      assert.ok(view.presentations.filter((item) => item.channel === "ordinary").length <= 3);
      assert.ok(view.presentations.filter((item) => item.channel === "urgent").length <= 1);
    }
    recordEvidence.page1 = page1;
    recordEvidence.page2 = page2;
    recordEvidence.page3 = page3;
    recordEvidence.again = { again1, again2, again3 };
    recordEvidence.progressed = progressed;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("007", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-008 全队列deadline、P0独立与有限队列排空", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("008");
  const clock = createClock();
  const recordEvidence = { case: "008", source: "fake-presenter", cleanup: {}, rounds: [] };
  let db = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-008", clock);
    db = opened.db;
    const ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    const agents = [
      "P2a", "P2b", "P2c", "P2d", "P2e", "P2f", "P2g", "P2h", "P0", "P1a", "P1b",
    ];
    registerAgents(ledger, instanceId, runId, "来源一", agents);
    const sourceIds = [];
    const make = (agentId, state, eventId) => {
      assert.equal(record(ledger, instanceId, runId, agentId, state, 1, eventId).accepted, true);
      sourceIds.push(eventId);
      return eventBySource(ledger, eventId);
    };
    clock.set(START);
    const p2a = make("P2a", "working", "p2-a");
    const p2b = make("P2b", "working", "p2-b");
    clock.set(START + 10);
    const extraP2 = [];
    for (let index = 0; index < 6; index += 1) {
      const agentId = agents[index + 2];
      extraP2.push(make(agentId, "working", `p2-${agentId}`));
    }
    clock.set(START + 20);
    const p0 = make("P0", "needs_attention", "p0");
    clock.set(START + 100);
    const p1a = make("P1a", "finished", "p1-a");
    const p1b = make("P1b", "finished", "p1-b");
    const firstPage = ledger.listPendingPage({ after: 0, limit: 2 });
    assert.deepEqual(firstPage.items.map((item) => item.eventId), ["p2-a", "p2-b"]);

    clock.set(START + 200);
    service = serviceFor(db, ledger, clock, { pageSize: 2, maxScanPages: 1 });
    let view = service.tick();
    assert.equal(view.scan.pages, 1);
    assert.equal(view.scan.scanned, 2);
    assert.equal(view.scan.complete, false);
    assert.equal(view.presentations.filter((item) => item.channel === "ordinary").length, 3);
    assert.equal(view.presentations.filter((item) => item.channel === "urgent").length, 1);
    const firstOrdinary = view.presentations
      .filter((item) => item.channel === "ordinary").flatMap((item) => item.items);
    assert.deepEqual(
      firstOrdinary.map((item) => item.sourceEventId).sort(),
      ["p1-a", "p1-b", "p2-a"],
    );
    const firstP0 = itemFor(view, p0.id);
    assert.ok(firstP0);
    assert.equal(firstP0.presentation.channel, "urgent");
    assert.equal(firstP0.item.sourceEventId, "p0");
    assert.equal(firstP0.item.dueAt, p0.receivedAt + 1000);
    assert.ok(firstOrdinary.find((item) => item.sourceEventId === "p1-a"));
    assert.ok(firstOrdinary.find((item) => item.sourceEventId === "p1-b"));
    recordEvidence.first = view;

    const ackedRows = [];
    const ackedSources = [];
    let rounds = 0;
    while (view.presentations.length > 0 && rounds < 8) {
      rounds += 1;
      assert.ok(view.presentations.filter((item) => item.channel === "ordinary").length <= 3);
      assert.ok(view.presentations.filter((item) => item.channel === "urgent").length <= 1);
      for (const presentation of view.presentations) {
        const result = service.acknowledge({
          presentationId: presentation.presentationId,
          eventIds: presentation.items.map((item) => item.eventId),
        });
        assert.equal(result.accepted, true);
        for (const item of presentation.items) {
          assert.equal(item.sourceEventId.startsWith("p"), true);
          assert.equal(ackedRows.includes(item.eventId), false);
          assert.equal(ackedSources.includes(item.sourceEventId), false);
          ackedRows.push(item.eventId);
          ackedSources.push(item.sourceEventId);
        }
      }
      recordEvidence.rounds.push({
        round: rounds,
        presentations: view.presentations.map((item) => ({
          channel: item.channel,
          sources: item.items.map((entry) => entry.sourceEventId),
        })),
        acked: ackedSources.length,
        pending: pendingEvents(ledger).length,
      });
      clock.advance(6000);
      view = service.tick();
    }
    assert.equal(view.presentations.length, 0);
    assert.equal(ackedRows.length, 11);
    assert.equal(new Set(ackedRows).size, 11);
    assert.equal(ackedSources.length, 11);
    assert.equal(new Set(ackedSources).size, 11);
    assert.deepEqual([...new Set(ackedSources)].sort(), [...sourceIds].sort());
    assert.equal(pendingEvents(ledger).length, 0);
    assert.equal(allEvents(ledger).filter(
      (item) => item.eventId && item.notificationStatus === "presented",
    ).length, 11);
    assert.equal(rounds, 4);
    recordEvidence.final = {
      rounds, ackedSources, pending: pendingEvents(ledger).length,
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("008", recordEvidence, [root]);
  }
});

test("POL-NOTIFY-009 1105个活跃P0超过旧排除上限、SQL关联排除与普通推进", {
  timeout: 40000,
}, async () => {
  const root = tempRoot("009");
  const clock = createClock();
  const recordEvidence = {
    case: "009", source: "fake-presenter", cleanup: {}, ticks: [], ackBatches: [],
  };
  let db = null;
  let ledger = null;
  let service = null;
  try {
    const opened = openLedger(root, "app-notify-009", clock);
    db = opened.db;
    ledger = opened.ledger;
    const instanceId = "inst-1";
    const runId = "run-1";
    ledger.registerInstance({ instanceId, runId, label: "来源一" });
    ackOnline(ledger, instanceId, runId);
    clock.set(START);
    const normalSources = [];
    for (let index = 0; index < 6; index += 1) {
      const source = `normal-${index}`;
      const state = index % 2 === 0 ? "finished" : "working";
      assert.equal(record(ledger, instanceId, runId, `N${index}`, state, 1, source).accepted, true);
      normalSources.push(source);
    }
    clock.set(START + 10);
    const p0Sources = [];
    for (let index = 0; index < 1105; index += 1) {
      const source = `p0-${index}`;
      assert.equal(record(ledger, instanceId, runId, `P${index}`, "needs_attention", 1,
        source).accepted, true);
      p0Sources.push(source);
    }
    clock.set(START + 9000);
    service = serviceFor(db, ledger, clock, { pageSize: 200, maxScanPages: 1 });

    const summarize = (view) => {
      const urgent = view.presentations.find((item) => item.channel === "urgent");
      const ordinary = view.presentations.filter((item) => item.channel === "ordinary");
      return {
        counts: view.counts,
        urgentItems: urgent ? urgent.items.length : 0,
        urgentPresentationId: urgent ? urgent.presentationId : null,
        ordinarySources: ordinary.flatMap((item) => item.items.map((entry) => entry.sourceEventId)),
        scan: view.scan,
        pending: pendingEvents(ledger).length,
      };
    };
    let view = service.tick();
    let ticks = 1;
    recordEvidence.ticks.push(summarize(view));
    while (summarize(view).urgentItems < 1105) {
      if (ticks >= 10) throw new Error("urgent 追加未在 10 tick 内收敛");
      view = service.tick();
      ticks += 1;
      recordEvidence.ticks.push(summarize(view));
    }
    const firstFull = summarize(view);
    assert.equal(firstFull.urgentItems, 1105);
    assert.equal(firstFull.counts.urgent, 1);
    assert.ok(firstFull.counts.ordinary <= 3);
    assert.equal(pendingEvents(ledger).length, 1111);

    /* 普通位在 1105 个未 ack P0 活跃时仍推进。 */
    const activeRows = [];
    const activeSources = [];
    const ackPresentation = (presentation) => {
      const result = service.acknowledge({
        presentationId: presentation.presentationId,
        eventIds: presentation.items.map((item) => item.eventId),
      });
      assert.equal(result.accepted, true);
      for (const item of presentation.items) {
        assert.equal(activeRows.includes(item.eventId), false);
        assert.equal(activeSources.includes(item.sourceEventId), false);
        activeRows.push(item.eventId);
        activeSources.push(item.sourceEventId);
      }
    };
    const ordinaryBefore = view.presentations.filter((item) => item.channel === "ordinary");
    const ordinarySourcesBefore = ordinaryBefore
      .flatMap((item) => item.items.map((entry) => entry.sourceEventId));
    for (const presentation of ordinaryBefore) ackPresentation(presentation);
    clock.advance(4000);
    const progressed = service.tick();
    const ordinaryAfter = progressed.presentations
      .filter((item) => item.channel === "ordinary");
    const ordinarySourcesAfter = ordinaryAfter
      .flatMap((item) => item.items.map((entry) => entry.sourceEventId));
    assert.equal(ordinaryAfter.length, 3);
    assert.ok(ordinarySourcesAfter.every((source) => !ordinarySourcesBefore.includes(source)));
    assert.equal(summarize(progressed).urgentItems, 1105);
    for (const presentation of ordinaryAfter) ackPresentation(presentation);
    clock.advance(4000);
    const afterOrdinary = service.tick();
    assert.equal(afterOrdinary.presentations.filter((item) => item.channel === "ordinary").length, 0);
    assert.equal(summarize(afterOrdinary).urgentItems, 1105);
    assert.ok(afterOrdinary.presentations.filter((item) => item.channel === "urgent").length <= 1);

    /* 1105 P0 分多个回执提交；每条一次，不重新扫描全 ID 参数。 */
    const urgent = afterOrdinary.presentations.find((item) => item.channel === "urgent");
    assert.ok(urgent);
    const urgentItems = urgent.items;
    assert.equal(urgentItems.length, 1105);
    const batchSize = 200;
    for (let offset = 0; offset < urgentItems.length; offset += batchSize) {
      const batch = urgentItems.slice(offset, offset + batchSize);
      const result = service.acknowledge({
        presentationId: urgent.presentationId,
        eventIds: batch.map((item) => item.eventId),
      });
      assert.equal(result.accepted, true);
      for (const item of batch) {
        assert.equal(activeRows.includes(item.eventId), false);
        assert.equal(activeSources.includes(item.sourceEventId), false);
        activeRows.push(item.eventId);
        activeSources.push(item.sourceEventId);
      }
      recordEvidence.ackBatches.push({ offset, count: batch.length });
    }
    assert.equal(activeRows.length, 1111);
    assert.equal(new Set(activeRows).size, 1111);
    assert.equal(new Set(activeSources).size, 1111);
    assert.deepEqual([...activeSources].sort(), [...normalSources, ...p0Sources].sort());
    assert.equal(pendingEvents(ledger).length, 0);
    clock.advance(6000);
    const drained = service.tick();
    assert.equal(drained.presentations.length, 0);
    assert.equal(allEvents(ledger).filter(
      (item) => item.eventId && item.notificationStatus === "presented",
    ).length, 1111);
    const activeTableCount = db.prepare(
      "SELECT COUNT(*) AS count FROM notification_active_events",
    ).get().count;
    assert.equal(activeTableCount, 0);
    recordEvidence.final = {
      ticks,
      activeRows: activeRows.length,
      activeSources: activeSources.length,
      pending: pendingEvents(ledger).length,
      activeTableCount,
      ordinarySourcesBefore,
      ordinarySourcesAfter,
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("009", recordEvidence, [root]);
  }
});
