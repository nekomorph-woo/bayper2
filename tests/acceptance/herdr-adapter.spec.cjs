/* S05e Herdr 逐 Agent 适配验收。
   001～005 使用真实 Unix socket 的受控协议端点（只控制响应、事件与断连）；
   006 使用本轮随机 session + 隔离 XDG 的真实 Herdr 与正式登记插件。
   所有 adapter 均走生产 transport/ledger；本文件不启动 GUI、不启动模型。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createConnectorLedger } = require("../../app/connector-ledger.cjs");
const { createHerdrAdapter } = require("../../app/herdr-adapter.cjs");
const { readHerdrRegistry } = require("../../app/herdr-registry.cjs");
const { createHerdrTransport } = require("../../app/herdr-transport.cjs");

const HERDR = process.env.HERDR_BIN || "herdr";
const PLUGIN_DIR = path.resolve(__dirname, "../../plugins/herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const EVIDENCE = path.resolve(
  __dirname,
  "../../.hapilon/polaris/Bayper完整交付/evidence/s05e-adapter",
);
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
const SKIP_LIVE = process.env.HERDR_ENV === "1"
  ? "HERDR_ENV=1：不在 Herdr 会话外创建真实测试 server"
  : false;
const ISO_CONFIG = `
onboarding = false
[terminal]
default_shell = "/bin/sh"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
[ui.sound]
enabled = false
[ui.toast]
delivery = "off"
[session]
resume_agents_on_restore = false
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = (ms) => sleep(ms);

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`等待超时：${label}`);
}

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
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `case-${caseId}-${RUN_ID}.json`);
  fs.writeFileSync(file, `${redact(JSON.stringify(record, null, 2), roots)}\n`);
  return file;
}

function tempRoot(tag) {
  return fs.mkdtempSync(`/tmp/bayper-adapter-${tag}-`);
}

function openLedger(file, appRunId, now) {
  const db = new DatabaseSync(file);
  const ledger = createConnectorLedger({ db, appRunId, now });
  return { db, ledger };
}

function pane(paneId, terminalId, options = {}) {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: options.workspaceId ?? "ws-1",
    tab_id: options.tabId ?? "tab-1",
    label: options.label ?? paneId,
    focused: false,
    agent_status: options.status ?? "idle",
    revision: 1,
  };
}

function agent(terminalId, paneId, status, sequence, options = {}) {
  return {
    terminal_id: terminalId,
    pane_id: paneId,
    workspace_id: options.workspaceId ?? "ws-1",
    tab_id: options.tabId ?? "tab-1",
    agent_status: status,
    state_change_seq: sequence,
    completion_seq: null,
    name: options.name ?? terminalId,
    display_agent: options.displayAgent ?? "fixture",
    focused: false,
    revision: 1,
    terminal_title: options.terminalTitle ?? "SECRET-CONTENT-NOT-READ",
  };
}

function snapshot(panes, agents) {
  return {
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "ws-1", number: 1, label: "工作区", focused: true }],
    tabs: [{ tab_id: "tab-1", workspace_id: "ws-1", number: 1, label: "标签", focused: true, pane_count: panes.length, agent_status: "idle" }],
    panes,
    layouts: [],
    agents,
  };
}

/* 与真实协议同形的受控 Unix socket server：只决定响应顺序、事件与断连。 */
function createProtocolServer(root, name) {
  const socketPath = path.join(root, `${name}.sock`);
  const state = {
    socketPath, snapshot: null, snapshotCount: 0, subscribeCount: 0,
    inFlightSnapshots: 0, maxInFlightSnapshots: 0,
    requests: [], subscriptions: new Set(), sockets: new Set(),
    timeline: [], gate: null, server: null,
  };

  function write(socket, message) {
    if (socket.destroyed) return false;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function handleConnection(socket) {
    state.sockets.add(socket);
    let subscription = null;
    let buffer = "";
    socket.on("error", () => {});
    socket.on("close", () => {
      state.sockets.delete(socket);
      if (subscription) state.subscriptions.delete(subscription);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (message.method === "events.subscribe") {
          subscription = {
            socket, id: message.id, subscriptions: message.params?.subscriptions ?? [],
          };
          state.subscriptions.add(subscription);
          state.subscribeCount += 1;
          state.timeline.push({
            at: Date.now(), kind: "subscribe", attempt: state.subscribeCount,
            panes: subscription.subscriptions.filter((item) => item.pane_id).map((item) => item.pane_id),
          });
          write(socket, { id: message.id, result: { type: "subscription_started" } });
          continue;
        }
        if (typeof message.method !== "string") continue;
        state.requests.push({ method: message.method, params: message.params ?? {} });
        state.timeline.push({ at: Date.now(), kind: message.method, count: state.snapshotCount + 1 });
        respond(message, socket);
      }
    });
  }

  async function respond(message, socket) {
    if (message.method === "ping") {
      write(socket, {
        id: message.id,
        result: { type: "pong", version: "0.9.5", protocol: 22 },
      });
      socket.end();
      return;
    }
    if (message.method !== "session.snapshot") {
      socket.destroy();
      return;
    }
    if (state.failSnapshots) {
      socket.destroy();
      return;
    }
    state.snapshotCount += 1;
    state.inFlightSnapshots += 1;
    state.maxInFlightSnapshots = Math.max(
      state.maxInFlightSnapshots, state.inFlightSnapshots,
    );
    try {
      let result;
      if (state.gate && (state.gate.at === undefined || state.gate.at === state.snapshotCount)) {
        const gate = state.gate;
        state.gate = null;
        await gate.promise;
        result = gate.value ?? state.snapshot;
      } else {
        result = state.snapshot;
      }
      write(socket, {
        id: message.id, result: { type: "session_snapshot", snapshot: result },
      });
      socket.end();
    } finally {
      state.inFlightSnapshots -= 1;
    }
  }

  function broadcast(message) {
    for (const subscription of [...state.subscriptions]) {
      write(subscription.socket, message);
    }
  }

  return {
    state, socketPath,
    async start() {
      try { fs.unlinkSync(socketPath); } catch { /* 不存在。 */ }
      state.server = net.createServer(handleConnection);
      await new Promise((resolve, reject) => {
        state.server.once("error", reject);
        state.server.listen(socketPath, resolve);
      });
    },
    async stop() {
      for (const socket of [...state.sockets]) socket.destroy();
      state.subscriptions.clear();
      const server = state.server;
      state.server = null;
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* 已移除。 */ }
    },
    status(paneId, value, options = {}) {
      broadcast({
        event: "pane.agent_status_changed",
        data: {
          pane_id: paneId, workspace_id: options.workspaceId ?? "ws-1", agent_status: value,
        },
      });
    },
    topology(type, data) {
      broadcast({ event: type, data: { type, ...data } });
    },
    eventsLost() {
      broadcast({ error: { code: "events_lost", message: "fixture lost" } });
    },
    gateNext(value) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      state.gate = { promise, value };
      return { release };
    },
    gateOn(at, value) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      state.gate = { promise, value, at };
      return { release };
    },
    subscriptions() {
      return [...state.subscriptions];
    },
  };
}

function createFakeClock(start = 1_000_000) {
  let time = start;
  let serial = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = ++serial;
      timers.set(id, { fn, due: time + ms, serial: id });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending() {
      return [...timers.values()]
        .map((timer) => ({ due: timer.due, delay: timer.due - time, serial: timer.serial }))
        .sort((a, b) => a.due - b.due || a.serial - b.serial);
    },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[1].serial - b[1].serial)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        time = timer.due;
        timer.fn();
        await pause(12);
      }
      time = target;
      await pause(12);
    },
  };
}

function observationEvents(ledger, instanceId, runId) {
  return ledger.listEvents({ instanceId, runId, limit: 200 }).items
    .filter((event) => event.kind === "observation");
}

function byTerminal(ledger, instanceId, runId) {
  return Object.fromEntries(
    ledger.listAgents({ instanceId, runId }).map((item) => [item.agentId, item]),
  );
}

async function startFixtureAdapter(root, name, snapshotValue, ledger, instanceId, runId) {
  const server = createProtocolServer(root, name);
  server.state.snapshot = snapshotValue;
  await server.start();
  const adapter = createHerdrAdapter({
    registration: { instanceId, runId, socketPath: server.socketPath, label: name },
    ledger,
  });
  const result = await adapter.start();
  assert.equal(result.started, true);
  return { server, adapter };
}

test("POL-ADAPTER-001 两端点同名pane局部ID独立terminal、baseline不补播与来源保留", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("001");
  const record = { case: "001", source: "fixture", cleanup: {}, observations: [] };
  let a = null;
  let b = null;
  let db = null;
  let ledger = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-001");
    db = opened.db;
    ledger = opened.ledger;
    const initialA = snapshot(
      [pane("pane-1", "term-a", { label: "A" })],
      [agent("term-a", "pane-1", "idle", 5, { name: "agent-a" })],
    );
    const initialB = snapshot(
      [pane("pane-1", "term-b", { label: "B" })],
      [agent("term-b", "pane-1", "idle", 5, { name: "agent-b" })],
    );
    const openedA = await startFixtureAdapter(
      root, "endpoint-a", initialA, ledger, "inst-a", "run-a",
    );
    const openedB = await startFixtureAdapter(
      root, "endpoint-b", initialB, ledger, "inst-b", "run-b",
    );
    a = openedA;
    b = openedB;
    assert.equal(a.server.state.snapshotCount, 2);
    assert.equal(b.server.state.snapshotCount, 2);
    const agentsA = byTerminal(ledger, "inst-a", "run-a");
    const agentsB = byTerminal(ledger, "inst-b", "run-b");
    assert.deepEqual(Object.keys(agentsA), ["term-a"]);
    assert.deepEqual(Object.keys(agentsB), ["term-b"]);
    for (const [instanceId, runId, terminal] of [
      ["inst-a", "run-a", "term-a"], ["inst-b", "run-b", "term-b"],
    ]) {
      const events = ledger.listEvents({ instanceId, runId, limit: 50 }).items;
      const baseline = events.filter((event) => event.kind === "baseline");
      assert.equal(baseline.length, 1);
      assert.equal(baseline[0].agentId, terminal);
      assert.equal(baseline[0].notificationStatus, "none");
      assert.equal(observationEvents(ledger, instanceId, runId).length, 0);
    }
    a.server.status("pane-1", "working");
    b.server.status("pane-1", "blocked");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").length === 1
        && observationEvents(ledger, "inst-b", "run-b").length === 1,
      5000, "两端点观测",
    );
    for (const [server, instanceId, runId, terminal, state, raw] of [
      [a.server, "inst-a", "run-a", "term-a", "working", "working"],
      [b.server, "inst-b", "run-b", "term-b", "needs_attention", "blocked"],
    ]) {
      const event = observationEvents(ledger, instanceId, runId)[0];
      assert.equal(event.agentId, terminal);
      assert.equal(event.state, state);
      assert.equal(event.rawState, raw);
      assert.equal(event.sequence, null);
      assert.equal(event.sourcePaneId, "pane-1");
      assert.equal(event.sourceTerminalId, terminal);
      assert.equal(event.sourceWorkspaceId, "ws-1");
      assert.equal(event.sourceTabId, "tab-1");
      assert.equal(event.subscriptionUuid.length > 0, true);
      assert.equal(Number.isInteger(event.localIndex), true);
      assert.equal(event.attribution, "terminal");
      assert.ok(event.observationId.includes(event.subscriptionUuid));
      assert.ok(event.observationId.endsWith(`:${event.localIndex}`));
      record.observations.push(event);
      assert.equal(
        server.state.requests.every(
          (item) => ["ping", "session.snapshot", "events.subscribe"].includes(item.method),
        ),
        true,
      );
    }
    assert.equal(JSON.stringify(agentsA).includes("SECRET-CONTENT-NOT-READ"), false);
    assert.equal(JSON.stringify(agentsB).includes("SECRET-CONTENT-NOT-READ"), false);
    record.agents = { a: agentsA, b: agentsB };
    record.instances = { a: ledger.getInstance({ instanceId: "inst-a" }),
      b: ledger.getInstance({ instanceId: "inst-b" }) };
    record.cleanup.a = ["dispose", "socket-close"];
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (a) a.adapter.dispose();
    if (b) b.adapter.dispose();
    if (a) await a.server.stop().catch(() => {});
    if (b) await b.server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.cleanup.sockets = [a?.server.socketPath, b?.server.socketPath]
      .filter(Boolean).map((item) => !fs.existsSync(item));
    record.evidence = saveEvidence("001", record, [root]);
  }
});

test("POL-ADAPTER-002 working→blocked→working、快照只在途去重与新往返保留", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("002");
  const record = { case: "002", source: "fixture", cleanup: {}, observations: [] };
  let fixture = null;
  let db = null;
  let ledger = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-002");
    db = opened.db;
    ledger = opened.ledger;
    fixture = await startFixtureAdapter(
      root, "endpoint", snapshot(
        [pane("pane-1", "term-a")], [agent("term-a", "pane-1", "idle", 1)],
      ),
      ledger, "inst-a", "run-a",
    );
    const { server, adapter } = fixture;
    const waitObservation = (count) => waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").length >= count,
      5000, `观测 ${count}`,
    );
    server.status("pane-1", "working");
    await waitObservation(1);
    server.status("pane-1", "blocked");
    await waitObservation(2);
    server.status("pane-1", "working");
    await waitObservation(3);
    const before = observationEvents(ledger, "inst-a", "run-a");
    assert.deepEqual(before.map((item) => item.state), ["working", "needs_attention", "working"]);
    assert.ok(before.every((item) => item.sequence === null));

    /* 延迟的 refresh 初始快照只回最终 working；在途重复 working 让快照 dirty。 */
    server.state.snapshot = snapshot(
      [pane("pane-1", "term-a", { status: "working" })],
      [agent("term-a", "pane-1", "working", 4)],
    );
    const gate = server.gateOn(server.state.snapshotCount + 2);
    const refreshing = adapter.refresh();
    await waitFor(() => server.state.gate === null, 5000, "refresh snapshot 在途");
    server.status("pane-1", "working");
    await waitObservation(4);
    gate.release();
    assert.equal((await refreshing).started, true);
    const after = observationEvents(ledger, "inst-a", "run-a");
    assert.equal(after.length, 4);
    assert.deepEqual(after.map((item) => item.state), [
      "working", "needs_attention", "working", "working",
    ]);
    const blocked = after.find((item) => item.state === "needs_attention");
    assert.equal(blocked.historical, true);
    assert.equal(blocked.priority, 1);
    assert.equal(blocked.notificationStatus, "pending");
    assert.equal(after[3].notificationStatus, "none");
    const current = byTerminal(ledger, "inst-a", "run-a")["term-a"];
    assert.equal(current.effectiveState, "working");
    const events = ledger.listEvents({ instanceId: "inst-a", runId: "run-a", limit: 200 }).items;
    const reconciled = events.filter((item) => item.kind === "reconciled");
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].notificationStatus, "none");
    assert.equal(reconciled[0].linkedObservationId, after[2].observationId);
    assert.equal(reconciled[0].sequence, 4);
    assert.equal(events.filter((item) => item.state === "needs_attention"
      && item.notificationStatus === "pending").length, 1);

    /* 重放同一观测 ID 幂等；相同终态重复观测不重复提示。 */
    const replay = ledger.recordObservation({
      instanceId: "inst-a", runId: "run-a", agentId: "term-a", state: "needs_attention",
      observationId: blocked.observationId, subscriptionUuid: blocked.subscriptionUuid,
      localIndex: blocked.localIndex, sourcePaneId: "pane-1",
    });
    assert.equal(replay.accepted, false);
    assert.equal(replay.reason, "DUPLICATE_OBSERVATION");
    assert.equal(observationEvents(ledger, "inst-a", "run-a").length, 4);

    server.status("pane-1", "blocked");
    await waitObservation(5);
    server.status("pane-1", "working");
    await waitObservation(6);
    const lastRound = observationEvents(ledger, "inst-a", "run-a").slice(-2);
    assert.deepEqual(lastRound.map((item) => item.state), ["needs_attention", "working"]);
    assert.equal(lastRound[0].notificationStatus, "pending");
    assert.equal(lastRound[0].historical, true);
    assert.equal(lastRound[0].priority, 1);
    record.observations = observationEvents(ledger, "inst-a", "run-a");
    record.reconciled = reconciled[0];
    record.current = byTerminal(ledger, "inst-a", "run-a");
    record.snapshotCount = server.state.snapshotCount;
    record.maxInFlightSnapshots = server.state.maxInFlightSnapshots;
    assert.equal(server.state.maxInFlightSnapshots, 1);
    record.cleanup.dispose = "ok";
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (fixture) fixture.adapter.dispose();
    if (fixture) await fixture.server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.evidence = saveEvidence("002", record, [root]);
  }
});

test("POL-ADAPTER-003 串行快照、拓扑新增/关闭/pane重用与缺失Agent unknown", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("003");
  const record = { case: "003", source: "fixture", cleanup: {}, snapshots: [] };
  let fixture = null;
  let db = null;
  let ledger = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-003");
    db = opened.db;
    ledger = opened.ledger;
    fixture = await startFixtureAdapter(
      root, "endpoint", snapshot(
        [pane("pane-1", "term-1")], [agent("term-1", "pane-1", "idle", 1)],
      ),
      ledger, "inst-a", "run-a",
    );
    const { server, adapter } = fixture;
    const stale = server.state.snapshot;
    const gate = server.gateOn(server.state.snapshotCount + 2, stale);
    const refreshing = adapter.refresh();
    await waitFor(() => server.state.gate === null, 5000, "旧快照在途");
    server.status("pane-1", "working");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").some(
        (item) => item.agentId === "term-1" && item.state === "working",
      ), 5000, "在途 working",
    );
    server.state.snapshot = snapshot(
      [pane("pane-1", "term-1", { status: "working" })],
      [agent("term-1", "pane-1", "working", 2)],
    );
    gate.release();
    assert.equal((await refreshing).started, true);
    const current = byTerminal(ledger, "inst-a", "run-a")["term-1"];
    assert.equal(current.effectiveState, "working");
    assert.equal(server.state.maxInFlightSnapshots, 1);
    assert.ok(server.state.snapshotCount >= 4);
    record.snapshots.push({ phase: "dirty", count: server.state.snapshotCount });

    /* 新 pane：拓扑事件触发 bounded 重新订阅，新 pane 状态可观测。 */
    server.state.snapshot = snapshot(
      [
        pane("pane-1", "term-1", { status: "working" }),
        pane("pane-2", "term-2"),
      ],
      [agent("term-1", "pane-1", "working", 2), agent("term-2", "pane-2", "idle", 1)],
    );
    server.topology("pane_created", {
      pane: pane("pane-2", "term-2"),
    });
    const subscribed = await waitFor(
      () => server.subscriptions().find((item) => item.subscriptions.some(
        (sub) => sub.pane_id === "pane-2",
      )),
      5000, "pane-2 新订阅",
    );
    assert.ok(subscribed);
    server.status("pane-2", "working");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").some(
        (item) => item.agentId === "term-2" && item.state === "working",
      ), 5000, "term-2 观测",
    );

    /* 旧 pane 事件先归旧 terminal，再关闭并以同一 pane_id 重用为新 terminal。 */
    server.status("pane-2", "blocked");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").some(
        (item) => item.agentId === "term-2" && item.state === "needs_attention",
      ), 5000, "term-2 blocked",
    );
    const beforeReuse = observationEvents(ledger, "inst-a", "run-a").length;
    server.state.snapshot = snapshot(
      [
        pane("pane-1", "term-1", { status: "working" }),
        pane("pane-2", "term-3"),
      ],
      [agent("term-1", "pane-1", "working", 2), agent("term-3", "pane-2", "idle", 1)],
    );
    server.topology("pane_closed", { pane_id: "pane-2" });
    server.topology("pane_created", { pane: pane("pane-2", "term-3") });
    await waitFor(
      () => server.state.subscribeCount >= 4,
      5000, "pane 重用后重订阅",
    );
    const reused = observationEvents(ledger, "inst-a", "run-a");
    assert.equal(reused.slice(0, beforeReuse).some(
      (item) => item.agentId === "term-3",
    ), false);
    assert.equal(reused.filter(
      (item) => item.agentId === "term-3" && item.state === "needs_attention",
    ).length, 0);
    server.status("pane-2", "working");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").some(
        (item) => item.agentId === "term-3" && item.state === "working",
      ), 5000, "term-3 观测",
    );

    /* 缺失 Agent：观察到的 done 只作为事实，当前仍是 unknown，不伪造终态。 */
    server.status("pane-2", "done");
    await waitFor(
      () => observationEvents(ledger, "inst-a", "run-a").some(
        (item) => item.agentId === "term-3" && item.state === "finished",
      ), 5000, "term-3 done 观测",
    );
    server.state.snapshot = snapshot(
      [pane("pane-1", "term-1", { status: "working" }), pane("pane-2", "term-3")],
      [agent("term-1", "pane-1", "working", 2)],
    );
    server.topology("pane_closed", { pane_id: "pane-2" });
    const missing = await waitFor(
      () => byTerminal(ledger, "inst-a", "run-a")["term-3"],
      5000, "term-3 仍在账本",
    );
    await waitFor(
      () => byTerminal(ledger, "inst-a", "run-a")["term-3"].effectiveState === "unknown",
      5000, "term-3 unknown",
    );
    assert.equal(byTerminal(ledger, "inst-a", "run-a")["term-3"].effectiveState, "unknown");
    assert.notEqual(missing.effectiveState, "finished");
    record.observations = observationEvents(ledger, "inst-a", "run-a");
    record.agents = byTerminal(ledger, "inst-a", "run-a");
    record.subscribeCount = server.state.subscribeCount;
    record.maxInFlightSnapshots = server.state.maxInFlightSnapshots;
    record.cleanup.dispose = "ok";
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (fixture) record.finalSubscribeCount = fixture.server.state.subscribeCount;
    if (fixture) record.finalRequests = fixture.server.state.requests;
    if (fixture) record.timeline = fixture.server.state.timeline;
    if (fixture) fixture.adapter.dispose();
    if (fixture) await fixture.server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.evidence = saveEvidence("003", record, [root]);
  }
});

test("POL-ADAPTER-004 EOF/events_lost、短断连无提示、长断连一次与有界退避", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("004");
  const record = { case: "004", source: "fixture", cleanup: {}, backoff: [] };
  const clock = createFakeClock();
  let fixture = null;
  let db = null;
  let ledger = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-004", clock.now);
    db = opened.db;
    ledger = opened.ledger;
    const server = createProtocolServer(root, "endpoint");
    server.state.snapshot = snapshot(
      [pane("pane-1", "term-1")], [agent("term-1", "pane-1", "idle", 1)],
    );
    await server.start();
    const adapter = createHerdrAdapter({
      registration: { instanceId: "inst-a", runId: "run-a", socketPath: server.socketPath },
      ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    fixture = { server, adapter };
    assert.equal((await adapter.start()).started, true);
    const eventsOf = (kind) => ledger.listEvents({
      instanceId: "inst-a", runId: "run-a", limit: 200,
    }).items.filter((item) => item.kind === kind);

    /* 短断连：EOF 后在观察期内重连，不产生离线提示。 */
    for (const subscription of server.subscriptions()) subscription.socket.destroy();
    await waitFor(() => adapter.state === "reconnecting", 2000, "短断连");
    assert.equal(clock.pending().some((item) => item.delay === 3000), true);
    await clock.advance(1000);
    await waitFor(() => adapter.state === "online", 3000, "短断连重连");
    await clock.advance(3000);
    assert.equal(eventsOf("disconnected").length, 0);
    assert.equal(eventsOf("offline").length, 0);
    assert.equal(eventsOf("recovered").length, 0);
    record.shortDisconnect = { disconnected: 0, offline: 0, recovered: 0 };

    /* 长断连：events_lost 后 server 仍答 ping 但快照失败；已登记的退避尝试
       不得重置首次断联时间，3 秒后仍须一次提示，退避 1/2/5。 */
    server.eventsLost();
    await waitFor(() => adapter.state === "reconnecting", 2000, "events_lost");
    const firstDisconnect = ledger.getInstance({ instanceId: "inst-a" });
    server.state.failSnapshots = true;
    await clock.advance(1000);
    await waitFor(
      () => clock.pending().some((item) => item.due === clock.now() + 2000),
      2000, "第一次失败退避",
    );
    const afterFailedAttempt = ledger.getInstance({ instanceId: "inst-a" });
    assert.equal(afterFailedAttempt.state, "reconnecting");
    assert.equal(afterFailedAttempt.disconnectedAt, firstDisconnect.disconnectedAt);
    record.failedRetryAttempt = {
      disconnectedAt: afterFailedAttempt.disconnectedAt,
      first: firstDisconnect.disconnectedAt,
      state: afterFailedAttempt.state,
    };
    assert.ok(clock.pending().some((item) => item.delay === 2000));
    record.backoff.push(1000, 2000);
    await clock.advance(2000);
    await waitFor(() => eventsOf("disconnected").length === 1, 3000, "超过窗口一次提示");
    const pendingAfterTick = clock.pending();
    assert.ok(pendingAfterTick.some((item) => item.delay === 5000));
    record.backoff.push(5000);
    const afterNotifiedAttempt = ledger.getInstance({ instanceId: "inst-a" });
    assert.equal(afterNotifiedAttempt.disconnectedAt, firstDisconnect.disconnectedAt);
    server.state.failSnapshots = false;
    const beforeRecovery = clock.now();
    await clock.advance(5000);
    await waitFor(() => adapter.state === "online", 4000, "长断连恢复");
    assert.ok(clock.now() - beforeRecovery >= 5000);
    const disconnected = eventsOf("disconnected");
    const recovered = eventsOf("recovered");
    const online = ledger.listEvents({ instanceId: "inst-a", runId: "run-a", limit: 200 })
      .items.filter((item) => item.kind === "online");
    assert.equal(disconnected.length, 1);
    assert.equal(disconnected[0].notificationStatus, "pending");
    assert.equal(recovered.length, 1);
    assert.equal(online.length, 1);
    assert.ok(eventsOf("gap").length >= 1);
    assert.equal(observationEvents(ledger, "inst-a", "run-a").length, 0);
    assert.equal(byTerminal(ledger, "inst-a", "run-a")["term-1"].effectiveState, "idle");
    record.longDisconnect = {
      disconnected: disconnected.length, recovered: recovered.length,
      online: online.length, gap: eventsOf("gap").length,
    };
    record.cleanup.beforeDisposeTimers = clock.pending().length;
    adapter.dispose();
    assert.equal(clock.pending().length, 0);
    record.cleanup.timersAfterDispose = clock.pending().length;
    fixture = { server, adapter };
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (fixture) fixture.adapter.dispose();
    if (fixture) await fixture.server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.evidence = saveEvidence("004", record, [root]);
  }
});

test("POL-ADAPTER-005 悬挂请求dispose、旧run不写新run、disabled不复活与重开库", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("005");
  const dbFile = path.join(root, "ledger.db");
  const record = { case: "005", source: "fixture", cleanup: {}, requests: [] };
  const clock = createFakeClock();
  let server = null;
  let db = null;
  let ledger = null;
  let oldAdapter = null;
  let newAdapter = null;
  let disabledAdapter = null;
  try {
    const opened = openLedger(dbFile, "app-005", clock.now);
    db = opened.db;
    ledger = opened.ledger;
    /* inst-b 用一个明确的在线快照作为“重开库不能假装仍在线”的对照。 */
    ledger.registerInstance({ instanceId: "inst-b", runId: "run-b" });
    ledger.applySnapshot({
      instanceId: "inst-b", runId: "run-b", complete: true,
      agents: [{ agentId: "term-b", state: "working", sequence: 1 }],
    });

    server = createProtocolServer(root, "endpoint");
    server.state.snapshot = snapshot(
      [pane("pane-1", "term-1", { status: "working" })],
      [agent("term-1", "pane-1", "working", 1)],
    );
    await server.start();
    const gate = server.gateNext();
    oldAdapter = createHerdrAdapter({
      registration: {
        instanceId: "inst-a", runId: "run-old", socketPath: server.socketPath,
      },
      ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    const oldStart = oldAdapter.start().then(
      () => ({ started: true }), (error) => ({ started: false, error }),
    );
    await waitFor(() => server.state.inFlightSnapshots === 1, 3000, "旧run悬挂快照");
    assert.equal(server.state.snapshotCount, 1);
    oldAdapter.dispose();
    gate.release();
    const oldResult = await oldStart;
    assert.equal(oldResult.started, false);
    assert.ok(["HERDR_ABORTED", "HERDR_DISPOSED"].includes(oldResult.error.code));
    assert.equal(clock.pending().length, 0);
    await waitFor(() => server.state.sockets.size === 0, 3000, "旧请求socket清理");
    assert.equal(Object.keys(byTerminal(ledger, "inst-a", "run-old")).length, 0);

    newAdapter = createHerdrAdapter({
      registration: {
        instanceId: "inst-a", runId: "run-new", socketPath: server.socketPath,
      },
      ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    assert.equal((await newAdapter.start()).started, true);
    assert.equal(byTerminal(ledger, "inst-a", "run-new")["term-1"].effectiveState, "working");
    assert.equal(ledger.getInstance({ instanceId: "inst-a" }).runId, "run-new");
    assert.equal(Object.keys(byTerminal(ledger, "inst-a", "run-old")).length, 0);

    const beforeDisable = server.state.requests.length;
    ledger.disableInstance({ instanceId: "inst-a" });
    const refreshed = await newAdapter.refresh();
    assert.equal(refreshed.started, false);
    assert.equal(refreshed.reason, "DISABLED");
    assert.notEqual(newAdapter.state, "online");
    assert.equal(server.state.requests.length, beforeDisable);
    const freshDisabled = createHerdrAdapter({
      registration: {
        instanceId: "inst-a", runId: "run-again", socketPath: server.socketPath,
      },
      ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    disabledAdapter = freshDisabled;
    const disabledStart = await freshDisabled.start();
    assert.equal(disabledStart.started, false);
    assert.equal(disabledStart.reason, "DISABLED");
    assert.equal(server.state.requests.length, beforeDisable);
    await clock.advance(30000);
    assert.equal(server.state.requests.length, beforeDisable);
    assert.equal(clock.pending().length, 0);
    record.disabled = { requestsBefore: beforeDisable, requestsAfter: server.state.requests.length };
    record.oldRunAgents = byTerminal(ledger, "inst-a", "run-old");
    record.beforeReopen = {
      a: ledger.getInstance({ instanceId: "inst-a" }),
      b: ledger.getInstance({ instanceId: "inst-b" }),
    };

    newAdapter.dispose();
    newAdapter = null;
    disabledAdapter.dispose();
    disabledAdapter = null;
    oldAdapter = null;
    await waitFor(() => server.state.sockets.size === 0, 3000, "disabled 后无socket");
    db.close();
    db = null;
    const reopened = openLedger(dbFile, "app-005-reopen");
    db = reopened.db;
    const reopenedLedger = reopened.ledger;
    const afterB = reopenedLedger.getInstance({ instanceId: "inst-b" });
    const agentsB = byTerminal(reopenedLedger, "inst-b", "run-b");
    assert.equal(afterB.online, false);
    assert.equal(afterB.state, "reconnecting");
    assert.equal(agentsB["term-b"].effectiveState, "unknown");
    const newRunOnline = reopenedLedger.listEvents({ limit: 200 }).items.filter(
      (item) => item.appRunId === "app-005-reopen" && item.kind === "online",
    );
    assert.equal(newRunOnline.length, 0);
    record.afterReopen = {
      b: afterB, agentsB, newRunOnline: newRunOnline.length,
    };
    record.cleanup = {
      timers: clock.pending().length,
      tempRemoved: false,
    };
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (oldAdapter) oldAdapter.dispose();
    if (newAdapter) newAdapter.dispose();
    if (disabledAdapter) disabledAdapter.dispose();
    if (server) await server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.cleanup.finalTimers = clock.pending().length;
    record.cleanup.socketRemoved = server ? !fs.existsSync(server.socketPath) : true;
    record.evidence = saveEvidence("005", record, [root]);
  }
});

function realCli(ctx, record, args) {
  record.commands.push(["herdr", "--session", ctx.session, ...args]);
  return execFileSync(HERDR, ["--session", ctx.session, ...args], {
    env: ctx.env, encoding: "utf8", timeout: 10000,
  });
}

function realJson(ctx, record, args) {
  return JSON.parse(realCli(ctx, record, args));
}

async function startRealServer(root, record) {
  if (process.env.HERDR_ENV === "1") {
    throw new Error("HERDR_ENV=1：拒绝创建真实 Herdr 测试 server");
  }
  const session = `bayper-s05e-${crypto.randomBytes(4).toString("hex")}`;
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    HERDR_CONFIG_PATH: path.join(root, "launch.toml"),
  };
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(env.HERDR_CONFIG_PATH, ISO_CONFIG);
  record.commands.push(["herdr", "--version"]);
  const versionLine = execFileSync(HERDR, ["--version"], { env, encoding: "utf8" }).trim();
  assert.match(versionLine, /^herdr 0\.9\.5\b/);
  record.commands.push(["herdr", "--session", session, "server"]);
  const child = spawn(HERDR, ["--session", session, "server"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  const ctx = { root, session, env, child, socketPath: null, version: null, stderr: () => stderr };
  const expected = path.join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock");
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Herdr server 提前退出：${stderr}`);
    }
    return fs.existsSync(expected);
  }, 10000, "真实 server socket");
  const status = await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Herdr server 提前退出：${stderr}`);
    }
    try {
      const parsed = JSON.parse(execFileSync(
        HERDR, ["--session", session, "status", "server", "--json"],
        { env, encoding: "utf8", timeout: 3000 },
      ));
      return parsed.running ? parsed : null;
    } catch {
      return null;
    }
  }, 10000, "真实 server status");
  assert.equal(status.session, session);
  assert.match(status.version, /^0\.9\.5\b/);
  assert.equal(status.protocol, 22);
  ctx.socketPath = status.socket;
  ctx.version = status.version;
  assert.ok(
    realish(status.socket).startsWith(`${realish(root)}${path.sep}`),
    "socket 必须位于本轮隔离根内",
  );
  return ctx;
}

async function stopRealServer(ctx, record) {
  if (!ctx) return { started: false };
  const cleanup = {
    pid: ctx.child.pid,
    stopRequested: false,
    stopError: null,
    exited: false,
    exitCode: null,
    exitSignal: null,
    forcedKill: false,
    socketRemoved: false,
  };
  if (ctx.child.exitCode === null && ctx.child.signalCode === null) {
    record.commands.push(["herdr", "--session", ctx.session, "server", "stop"]);
    try {
      execFileSync(HERDR, ["--session", ctx.session, "server", "stop"], {
        env: ctx.env, encoding: "utf8", timeout: 10000,
      });
      cleanup.stopRequested = true;
    } catch (error) {
      cleanup.stopError = String(error.message).slice(0, 200);
    }
  }
  await waitFor(
    () => ctx.child.exitCode !== null || ctx.child.signalCode !== null,
    5000, "真实 server 退出",
  ).catch(() => {});
  if (ctx.child.exitCode === null && ctx.child.signalCode === null) {
    cleanup.forcedKill = ctx.child.kill("SIGTERM");
    await waitFor(
      () => ctx.child.exitCode !== null || ctx.child.signalCode !== null,
      2000, "真实 server SIGTERM 退出",
    ).catch(() => {});
  }
  cleanup.exited = ctx.child.exitCode !== null || ctx.child.signalCode !== null;
  cleanup.exitCode = ctx.child.exitCode;
  cleanup.exitSignal = ctx.child.signalCode;
  await waitFor(() => !fs.existsSync(ctx.socketPath), 5000, "真实 socket 移除").catch(() => {});
  cleanup.socketRemoved = !fs.existsSync(ctx.socketPath);
  cleanup.ok = cleanup.exited && cleanup.socketRemoved;
  return cleanup;
}

test("POL-ADAPTER-006 真实隔离Herdr+正式登记：逐Agent中间观测、stop仅unknown", {
  timeout: 50000,
  skip: SKIP_LIVE,
}, async () => {
  const root = tempRoot("006");
  const record = { case: "006", source: "real-herdr", commands: [], cleanup: {} };
  let ctx = null;
  let adapter = null;
  let db = null;
  let ledger = null;
  let serverCleanup = null;
  let bodyError = null;
  try {
    ctx = await startRealServer(root, record);
    record.session = ctx.session;
    record.version = ctx.version;
    record.startPid = ctx.child.pid;
    record.socketPath = ctx.socketPath;
    realCli(ctx, record, ["plugin", "link", PLUGIN_DIR, "--enabled"]);
    const configDir = realCli(ctx, record, ["plugin", "config-dir", PLUGIN_ID]).trim();
    fs.mkdirSync(configDir, { recursive: true });
    const registryDir = path.join(root, "registry");
    fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
    const created = realJson(ctx, record, [
      "workspace", "create", "--cwd", root, "--label", "s05e-real", "--focus",
    ]);
    const paneA = created.result.root_pane;
    const split = realJson(ctx, record, [
      "pane", "split", paneA.pane_id, "--direction", "right", "--cwd", root, "--no-focus",
    ]);
    const paneB = split.result.pane;
    realCli(ctx, record, ["plugin", "action", "invoke", ACTION_ID]);
    const registration = await waitFor(() => {
      const app = readHerdrRegistry({ registryDir });
      return app.registrations.find(
        (item) => item.endpoint === "matches"
          && realish(item.socket.path) === realish(ctx.socketPath),
      );
    }, 10000, "正式插件登记");
    assert.equal(registration.pluginId, PLUGIN_ID);
    assert.equal(registration.connectable, true);
    record.registration = {
      instanceId: registration.instanceId,
      runId: registration.runId,
      socketPath: registration.socket.path,
      observedServerPid: registration.observedServerPid,
    };
    assert.equal(registration.observedServerPid, ctx.child.pid);

    /* 先报告一次 idle 让 AgentInfo 在订阅前形成，避免 agent_detected 的重订阅
       窗口吞掉随后要验收的 working→blocked→working 状态事件。 */
    const report = (paneId, name, state, sequence) => realCli(ctx, record, [
      "pane", "report-agent", paneId, "--source", "bayper-s05e-fixture",
      "--agent", name, "--state", state, "--seq", String(sequence),
    ]);
    report(paneA.pane_id, "fixture-a", "idle", 1);
    report(paneB.pane_id, "fixture-b", "idle", 1);
    const probe = createHerdrTransport({ socketPath: registration.socket.path });
    try {
      await waitFor(async () => {
        const result = await probe.request("session.snapshot", {});
        const paneIds = result.snapshot.agents.map((item) => item.pane_id);
        return paneIds.includes(paneA.pane_id) && paneIds.includes(paneB.pane_id);
      }, 5000, "预置两个 Agent");
    } finally {
      probe.dispose();
    }

    const opened = openLedger(path.join(root, "ledger.db"), "app-006");
    db = opened.db;
    ledger = opened.ledger;
    adapter = createHerdrAdapter({
      registration: {
        instanceId: registration.instanceId, runId: registration.runId,
        socketPath: registration.socket.path, label: "s05e-real",
      },
      ledger, requestTimeoutMs: 5000,
    });
    const started = await adapter.start();
    assert.equal(started.started, true);
    const initial = ledger.listAgents({
      instanceId: registration.instanceId, runId: registration.runId,
    });
    assert.equal(initial.length, 2, "初始快照建立基线，不补播预置历史");
    const initialObservations = ledger.listEvents({
      instanceId: registration.instanceId, runId: registration.runId, limit: 200,
    }).items.filter((item) => item.kind === "observation");
    record.initialObservations = initialObservations;
    assert.ok(initialObservations.every((item) => item.sequence === null));

    /* 两个 pane 交错报告，缩短构造 Agent 的存活窗口；旧订阅在 debounce 期间持续收事件。 */
    const targets = [[paneA, "fixture-a"], [paneB, "fixture-b"]];
    const waitObserved = (paneId, state, count = 1) => waitFor(() => {
      const items = ledger.listEvents({
        instanceId: registration.instanceId, runId: registration.runId, limit: 200,
      }).items.filter((item) => item.kind === "observation"
        && item.sourcePaneId === paneId && item.state === state);
      return items.length >= count;
    }, 5000, `${paneId} ${state}`);
    for (const [paneValue, name] of targets) report(paneValue.pane_id, name, "working", 2);
    await Promise.all(targets.map(([paneValue]) => waitObserved(paneValue.pane_id, "working")));
    for (const [paneValue, name] of targets) report(paneValue.pane_id, name, "blocked", 3);
    await Promise.all(targets.map(
      ([paneValue]) => waitObserved(paneValue.pane_id, "needs_attention"),
    ));
    for (const [paneValue, name] of targets) report(paneValue.pane_id, name, "working", 4);
    await Promise.all(targets.map(
      ([paneValue]) => waitObserved(paneValue.pane_id, "working", 2),
    ));
    /* 最后一份构造状态后立即取权威快照，取消尚未触发的拓扑 debounce。 */
    record.finalRefresh = await adapter.refresh();
    const agents = ledger.listAgents({
      instanceId: registration.instanceId, runId: registration.runId,
    });
    assert.equal(agents.length, 2);
    assert.ok(agents.every((item) => ["working", "unknown"].includes(item.effectiveState)));
    record.agentsBeforeStop = agents;
    const observations = ledger.listEvents({
      instanceId: registration.instanceId, runId: registration.runId, limit: 200,
    }).items.filter((item) => item.kind === "observation");
    record.observations = observations;
    assert.ok(observations.every((item) => item.sequence === null));
    for (const paneValue of [paneA, paneB]) {
      const states = observations
        .filter((item) => item.sourcePaneId === paneValue.pane_id)
        .map((item) => item.rawState)
        .filter((raw) => raw === "working" || raw === "blocked");
      assert.deepEqual(states, ["working", "blocked", "working"]);
    }

    serverCleanup = await stopRealServer(ctx, record);
    ctx = null;
    await waitFor(() => {
      const current = ledger.getInstance({ instanceId: registration.instanceId });
      return current && current.online === false;
    }, 5000, "真实 stop 断连");
    const stoppedAgents = ledger.listAgents({
      instanceId: registration.instanceId, runId: registration.runId,
    });
    assert.ok(stoppedAgents.every((item) => item.effectiveState === "unknown"));
    await waitFor(() => ledger.listEvents({
      instanceId: registration.instanceId, runId: registration.runId, limit: 200,
    }).items.some((item) => item.kind === "disconnected"), 4500, "真实 stop 断连提示");
    const allEvents = ledger.listEvents({
      instanceId: registration.instanceId, runId: registration.runId, limit: 200,
    }).items;
    assert.equal(allEvents.some((item) => ["finished", "stopped", "failed"].includes(item.state)), false);
    assert.equal(allEvents.some((item) => item.kind === "offline"), false);
    assert.equal(allEvents.filter((item) => item.kind === "disconnected").length, 1);
    record.agentsAfterStop = stoppedAgents;
    record.stopKinds = allEvents.filter(
      (item) => ["online", "offline", "disconnected", "gap"].includes(item.kind),
    ).map((item) => item.kind);
    record.cleanup.disconnectObserved = true;
    adapter.dispose();
    adapter = null;
  } catch (error) {
    bodyError = error;
    record.error = { code: error.code || null, message: error.message };
    if (ledger) {
      try {
        record.failureEvents = ledger.listEvents({ limit: 200 }).items;
        record.failureAgents = ledger.listAgents({ instanceId: record.registration.instanceId });
        record.failureInstance = ledger.getInstance({ instanceId: record.registration.instanceId });
        record.failurePending = ledger.listPending({ limit: 50 });
      } catch {
        // 失败证据尽量保留。
      }
    }
  } finally {
    if (adapter) adapter.dispose();
    if (ctx) {
      try {
        serverCleanup = await stopRealServer(ctx, record);
      } catch (error) {
        record.cleanup.stopError = String(error.message).slice(0, 300);
      }
      ctx = null;
    }
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.server = serverCleanup;
    record.cleanup.tempDirRemoved = !fs.existsSync(root);
    record.cleanup.ok = Boolean(
      serverCleanup?.ok !== false && record.cleanup.tempDirRemoved,
    );
    record.evidence = saveEvidence("006", record, [root]);
  }
  if (bodyError) throw bodyError;
  assert.ok(record.cleanup.ok, "真实 server、socket 与临时目录清理未完成");
});

test("POL-ADAPTER-007 已解释/presented观测不跨episode复用，纯快照回转产生新通知", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("007");
  const record = { case: "007", source: "fixture", cleanup: {}, phases: [] };
  let fixture = null;
  let db = null;
  let ledger = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-007");
    db = opened.db;
    ledger = opened.ledger;
    fixture = await startFixtureAdapter(
      root, "endpoint", snapshot(
        [pane("pane-1", "term-1", { status: "working" })],
        [agent("term-1", "pane-1", "working", 1)],
      ),
      ledger, "inst-a", "run-a",
    );
    const { server, adapter } = fixture;
    const events = () => ledger.listEvents({
      instanceId: "inst-a", runId: "run-a", limit: 200,
    }).items;
    const observations = () => events().filter((item) => item.kind === "observation");
    const setSnapshot = async (state, sequence) => {
      server.state.snapshot = snapshot(
        [pane("pane-1", "term-1", { status: state })],
        [agent("term-1", "pane-1", state, sequence)],
      );
      const result = await adapter.refresh();
      assert.equal(result.started, true);
      return result;
    };

    server.status("pane-1", "blocked");
    await waitFor(
      () => observations().some((item) => item.state === "needs_attention"),
      5000, "首次 blocked 观测",
    );
    const firstBlocked = observations().find((item) => item.state === "needs_attention");
    await setSnapshot("blocked", 2);
    const firstLink = events().find(
      (item) => item.kind === "reconciled" && item.sequence === 2
        && item.state === "needs_attention",
    );
    assert.ok(firstLink);
    assert.equal(firstLink.linkedObservationId, firstBlocked.observationId);
    const presented = ledger.markPresented([firstBlocked.id]);
    assert.equal(presented.updated, 1);
    record.phases.push({
      phase: "seq2-linked", firstBlocked, firstLink, presented: presented.updated,
    });

    /* 纯快照 working(seq3)：旧 blocked 观测已过去，presented 也必须标记 consumed。 */
    await setSnapshot("working", 3);
    const afterWorking = events().find((item) => item.id === firstBlocked.id);
    assert.equal(afterWorking.notificationStatus, "presented");
    assert.equal(afterWorking.historical, true);
    record.phases.push({ phase: "seq3-working", afterWorking });

    /* 纯快照 blocked(seq4)：这是新的当前变化，不能挂到 seq2 已解释的旧观测。 */
    await setSnapshot("blocked", 4);
    const fourth = events().find(
      (item) => item.kind === "reconciled" && item.sequence === 4
        && item.state === "needs_attention",
    );
    assert.ok(fourth);
    assert.equal(fourth.notificationStatus, "pending");
    assert.equal(fourth.linkedObservationId, null);
    assert.notEqual(fourth.linkedEventId, firstBlocked.id);
    record.phases.push({ phase: "seq4-blocked-pure", fourth });

    /* 再纯快照 working(seq5)，之后新的 blocked 观测必须形成新通知。 */
    await setSnapshot("working", 5);
    const beforeNewObservation = observations().length;
    server.status("pane-1", "blocked");
    await waitFor(
      () => observations().length > beforeNewObservation,
      5000, "回转后的新 blocked 观测",
    );
    const secondBlocked = observations().find(
      (item) => item.state === "needs_attention" && item.id !== firstBlocked.id,
    );
    assert.ok(secondBlocked);
    assert.equal(secondBlocked.notificationStatus, "pending");
    assert.equal(secondBlocked.historical, false);
    assert.notEqual(secondBlocked.observationId, firstBlocked.observationId);
    record.phases.push({ phase: "new-blocked-observation", secondBlocked });

    /* 新观测可解释随后的 blocked 快照；联结必须指向新观测，不是旧 ID。 */
    await setSnapshot("blocked", 6);
    const sixth = events().find(
      (item) => item.kind === "reconciled" && item.sequence === 6
        && item.state === "needs_attention",
    );
    assert.ok(sixth);
    assert.equal(sixth.linkedObservationId, secondBlocked.observationId);
    assert.notEqual(sixth.linkedObservationId, firstBlocked.observationId);
    record.phases.push({ phase: "seq6-blocked-new-observation", sixth });
    record.events = events();
    record.agents = byTerminal(ledger, "inst-a", "run-a");
    record.cleanup.dispose = "ok";
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (fixture) fixture.adapter.dispose();
    if (fixture) await fixture.server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.evidence = saveEvidence("007", record, [root]);
  }
});

test("POL-ADAPTER-008 首次ping失败自动重试且不伪造通知，disabled/stopped/stale/dispose仍生效", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("008");
  const record = { case: "008", source: "fixture", cleanup: {}, starts: {} };
  const clock = createFakeClock();
  let db = null;
  let ledger = null;
  const adapters = [];
  let server = null;
  let downServer = null;
  try {
    const opened = openLedger(path.join(root, "ledger.db"), "app-008", clock.now);
    db = opened.db;
    ledger = opened.ledger;
    const snapshotValue = snapshot(
      [pane("pane-1", "term-1", { status: "working" })],
      [agent("term-1", "pane-1", "working", 1)],
    );
    server = createProtocolServer(root, "recovery");
    server.state.snapshot = snapshotValue;
    const makeAdapter = (instanceId, runId) => {
      const adapter = createHerdrAdapter({
        registration: {
          instanceId, runId, socketPath: server.socketPath, label: instanceId,
        },
        ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      });
      adapters.push(adapter);
      return adapter;
    };

    /* 首次 ping 失败：没有 ledger 行、没有 online/offline，只有退避 timer。 */
    const initial = makeAdapter("inst-init", "run-init");
    let startError;
    try {
      await initial.start();
    } catch (error) {
      startError = error;
    }
    assert.ok(startError);
    assert.equal(ledger.getInstance({ instanceId: "inst-init" }), null);
    assert.equal(ledger.listEvents({ instanceId: "inst-init", runId: "run-init" }).items.length, 0);
    const initialPending = clock.pending();
    record.starts.initial = {
      error: { code: startError.code || null, message: startError.message },
      eventsBeforeRecovery: 0,
      pending: initialPending,
    };
    assert.ok(initialPending.some((item) => item.delay === 1000));

    await server.start();
    await clock.advance(1000);
    await waitFor(() => initial.state === "online", 4000, "首次连接自动恢复");
    const initialInstance = ledger.getInstance({ instanceId: "inst-init" });
    assert.equal(initialInstance.online, true);
    const initialEvents = ledger.listEvents({
      instanceId: "inst-init", runId: "run-init", limit: 100,
    }).items;
    assert.equal(initialEvents.filter((item) => item.kind === "online").length, 1);
    assert.equal(initialEvents.some((item) => ["offline", "disconnected"].includes(item.kind)), false);
    assert.equal(initialEvents.some((item) => item.kind === "observation"), false);
    record.starts.recovered = {
      instance: initialInstance,
      kinds: initialEvents.map((item) => item.kind),
      timers: clock.pending(),
    };
    initial.dispose();
    assert.equal(clock.pending().length, 0);

    const requestsBeforeGuards = server.state.requests.length;

    /* disabled：在 ping 前停止，不产生新请求。 */
    ledger.registerInstance({ instanceId: "inst-disabled", runId: "run-disabled" });
    ledger.disableInstance({ instanceId: "inst-disabled" });
    const disabled = makeAdapter("inst-disabled", "run-disabled");
    const disabledStart = await disabled.start();
    assert.equal(disabledStart.started, false);
    assert.equal(disabledStart.reason, "DISABLED");
    assert.equal(server.state.requests.length, requestsBeforeGuards);
    assert.equal(clock.pending().length, 0);
    record.starts.disabled = { result: disabledStart, requests: server.state.requests.length };

    /* stopped：在 ping 前停止，不产生新请求。 */
    ledger.registerInstance({ instanceId: "inst-stopped", runId: "run-stopped" });
    ledger.confirmStopped({ instanceId: "inst-stopped", runId: "run-stopped" });
    const stopped = makeAdapter("inst-stopped", "run-stopped");
    const stoppedStart = await stopped.start();
    assert.equal(stoppedStart.started, false);
    assert.equal(stoppedStart.reason, "STOPPED_RUN");
    assert.equal(server.state.requests.length, requestsBeforeGuards);
    assert.equal(clock.pending().length, 0);
    record.starts.stopped = { result: stoppedStart, requests: server.state.requests.length };

    /* stale：旧 run 已被同实例新 run 替代；不得借新连接复活。 */
    ledger.registerInstance({ instanceId: "inst-stale", runId: "run-old" });
    ledger.registerInstance({ instanceId: "inst-stale", runId: "run-current" });
    const stale = makeAdapter("inst-stale", "run-old");
    const staleStart = await stale.start();
    assert.equal(staleStart.started, false);
    assert.equal(staleStart.reason, "STALE_RUN");
    assert.equal(clock.pending().length, 0);
    const staleInstance = ledger.getInstance({ instanceId: "inst-stale" });
    assert.equal(staleInstance.runId, "run-current");
    assert.equal(staleInstance.online, true);
    record.starts.stale = {
      result: staleStart, instance: staleInstance,
      onlineForOldRun: ledger.listEvents({
        instanceId: "inst-stale", runId: "run-old", limit: 100,
      }).items.filter((item) => item.kind === "online").length,
    };

    /* dispose 取消首次失败后的退避 timer，之后不再尝试。 */
    downServer = createProtocolServer(root, "down");
    downServer.state.snapshot = snapshotValue;
    const disposing = createHerdrAdapter({
      registration: {
        instanceId: "inst-dispose", runId: "run-dispose",
        socketPath: downServer.socketPath, label: "dispose",
      },
      ledger, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    adapters.push(disposing);
    let disposeStartError;
    try {
      await disposing.start();
    } catch (error) {
      disposeStartError = error;
    }
    assert.ok(disposeStartError);
    assert.ok(clock.pending().some((item) => item.delay === 1000));
    disposing.dispose();
    assert.equal(clock.pending().length, 0);
    await clock.advance(5000);
    assert.equal(ledger.getInstance({ instanceId: "inst-dispose" }), null);
    assert.equal(downServer.state.requests.length, 0);
    record.starts.dispose = {
      error: { code: disposeStartError.code || null, message: disposeStartError.message },
      timersAfterDispose: clock.pending().length,
      events: ledger.listEvents({ instanceId: "inst-dispose", runId: "run-dispose" }).items.length,
    };
    record.cleanup.dispose = "ok";
  } catch (error) {
    record.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    for (const adapter of adapters) adapter.dispose();
    if (server) await server.stop().catch(() => {});
    if (downServer) await downServer.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    record.cleanup.tempRemoved = !fs.existsSync(root);
    record.cleanup.finalTimers = clock.pending().length;
    record.evidence = saveEvidence("008", record, [root]);
  }
});
