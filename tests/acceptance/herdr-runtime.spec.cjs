/* S05g Herdr 登记发现与多实例运行管理验收。
   001-005 使用真实 Unix socket 协议 fixture 与正式 registry/adapter/ledger；
   REAL 使用本轮随机具名隔离 Herdr，不接默认/已有工作 server。
   fixture 记录由正式 registry schema/runId 派生规则构造，插件登记本身已由 S05d 验收。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createConnectorLedger } = require("../../app/connector-ledger.cjs");
const { createHerdrRuntime } = require("../../app/herdr-runtime.cjs");
const { readHerdrRegistry } = require("../../app/herdr-registry.cjs");

const HERDR = process.env.HERDR_BIN || "herdr";
const PLUGIN_DIR = path.resolve(__dirname, "../../plugins/herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.hapilon/polaris/Bayper完整交付/evidence/s05g-runtime",
);
const BATCH = process.env.S05G_BATCH || `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
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

function realish(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function redact(text, roots) {
  return roots.reduce(
    (value, root) => value.split(realish(root)).join("<isolated-root>")
      .split(root).join("<isolated-root>"),
    text,
  );
}

function saveEvidence(caseId, record, roots) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `case-${caseId}-${BATCH}.json`);
  fs.writeFileSync(file, `${redact(JSON.stringify(record, null, 2), roots)}\n`);
  return file;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

function tempRoot(tag) {
  return fs.mkdtempSync(`/tmp/bayper-runtime-${tag}-`);
}

function openLedger(root, appRunId) {
  const file = path.join(root, "ledger.db");
  const db = new DatabaseSync(file);
  return { file, db, ledger: createConnectorLedger({ db, appRunId }) };
}

function digest(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function registryRecord(socketPath, namespaceId, observedPid = process.pid) {
  const stat = fs.statSync(socketPath, { bigint: true });
  const real = fs.realpathSync(socketPath);
  const instanceId = `inst-${digest(namespaceId, real).slice(0, 32)}`;
  const runId = `run-${digest(
    instanceId, stat.dev, stat.ino, stat.birthtimeMs, observedPid,
  ).slice(0, 32)}`;
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, pluginId: "bayper.herdr", instanceId, runId, namespaceId,
    socket: {
      path: real,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      birthtimeMs: stat.birthtimeMs.toString(),
    },
    observedServerPid: observedPid,
    firstRegisteredAt: now, lastRegisteredAt: now,
  };
}

function writeRegistry(registryDir, record) {
  fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  const file = path.join(registryDir, `${record.instanceId}.json`);
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function agentSnapshot(terminalId, paneId = "pane-1", label = terminalId) {
  return {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "ws-1", number: 1, label: "工作区", focused: true }],
    tabs: [{
      tab_id: "tab-1", workspace_id: "ws-1", number: 1, label: "标签",
      focused: true, pane_count: 1, agent_status: "idle",
    }],
    panes: [{
      pane_id: paneId, terminal_id: terminalId, workspace_id: "ws-1", tab_id: "tab-1",
      label: paneId, focused: true, agent_status: "working", revision: 1,
    }],
    layouts: [],
    agents: [{
      terminal_id: terminalId, pane_id: paneId, workspace_id: "ws-1", tab_id: "tab-1",
      agent_status: "working", state_change_seq: 1, completion_seq: null,
      name: label, display_agent: "fixture", focused: true, revision: 1,
    }],
  };
}

/* 真实 Unix socket 协议 fixture：控制请求/订阅、快照挂起与 server 代次。 */
function createProtocolServer(root, name, initialSnapshot) {
  const socketPath = path.join(root, `${name}.sock`);
  const state = {
    socketPath, snapshot: initialSnapshot ?? agentSnapshot(`term-${name}`),
    requests: [], snapshotCount: 0, subscribeCount: 0,
    subscriptions: new Set(), sockets: new Set(), server: null,
    held: null, hold: null, heldPing: null, holdPing: null,
    failFirstPing: false, pingFailures: 0,
  };
  function write(socket, message) {
    if (socket.destroyed) return false;
    try { socket.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }
  function respondSnapshot(socket, message, snapshot) {
    write(socket, {
      id: message.id, result: { type: "session_snapshot", snapshot },
    });
    socket.end();
  }
  function handle(socket) {
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
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.method === "events.subscribe") {
          subscription = {
            socket, id: message.id, subscriptions: message.params?.subscriptions ?? [],
          };
          state.subscriptions.add(subscription);
          state.subscribeCount += 1;
          write(socket, { id: message.id, result: { type: "subscription_started" } });
          continue;
        }
        if (typeof message.method !== "string") continue;
        state.requests.push(message.method);
        if (message.method === "ping") {
          if (state.failFirstPing) {
            state.failFirstPing = false;
            state.pingFailures += 1;
            socket.destroy();
            continue;
          }
          if (state.holdPing) {
            const hold = state.holdPing;
            state.holdPing = null;
            state.heldPing = { socket, message, hold };
            continue;
          }
          write(socket, {
            id: message.id, result: { type: "pong", version: "0.9.5", protocol: 22 },
          });
          socket.end();
          continue;
        }
        if (message.method === "session.snapshot") {
          state.snapshotCount += 1;
          if (state.hold) {
            const hold = state.hold;
            state.hold = null;
            state.held = { socket, message, hold };
            continue;
          }
          respondSnapshot(socket, message, state.snapshot);
          continue;
        }
        socket.destroy();
      }
    });
  }
  return {
    state, socketPath,
    requestCount() { return state.requests.length; },
    async start() {
      try { fs.unlinkSync(socketPath); } catch { /* 不存在。 */ }
      state.server = net.createServer(handle);
      await new Promise((resolve, reject) => {
        state.server.once("error", reject);
        state.server.listen(socketPath, resolve);
      });
    },
    holdNextSnapshot() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      state.hold = { promise };
      return { release: () => release() };
    },
    holdNextPing() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      state.holdPing = { promise };
      return { release: () => release() };
    },
    async releaseHeldPing() {
      if (!state.heldPing) return false;
      const held = state.heldPing;
      state.heldPing = null;
      await held.hold.promise;
      write(held.socket, {
        id: held.message.id, result: { type: "pong", version: "0.9.5", protocol: 22 },
      });
      held.socket.end();
      return true;
    },
    async releaseHeld() {
      if (!state.held) return false;
      const held = state.held;
      state.held = null;
      await held.hold.promise;
      respondSnapshot(held.socket, held.message, state.snapshot);
      return true;
    },
    sendStatus(paneId, status) {
      for (const subscription of state.subscriptions) {
        write(subscription.socket, {
          event: "pane.agent_status_changed",
          data: { pane_id: paneId, workspace_id: "ws-1", agent_status: status },
        });
      }
    },
    stopListening() {
      if (!state.server) return;
      const server = state.server;
      state.server = null;
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* 已移除。 */ }
    },
    async stop() {
      for (const socket of [...state.sockets]) socket.destroy();
      state.subscriptions.clear();
      const server = state.server;
      state.server = null;
      if (server) await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* 已移除。 */ }
    },
  };
}

function ledgerEvents(ledger, instanceId = null, runId = null) {
  const items = [];
  let after = 0;
  for (;;) {
    const page = ledger.listEvents({ instanceId, runId, after, limit: 200 });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    after = page.nextCursor;
  }
}

function instanceState(runtime, instanceId) {
  return runtime.getState().instances.find((item) => item.instanceId === instanceId);
}

function noOffline(ledger, instanceId) {
  return ledgerEvents(ledger, instanceId).every((item) => item.kind !== "offline");
}

test("POL-HERDR-RUNTIME-001 先登记/后登记两实例、同名pane隔离与重复扫描", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("001");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "001", cleanup: {} };
  let db = null;
  let runtime = null;
  let serverA = null;
  let serverB = null;
  try {
    const opened = openLedger(root, "app-runtime-001");
    db = opened.db;
    const ledger = opened.ledger;
    serverA = createProtocolServer(root, "a", agentSnapshot("term-A", "pane-1", "Agent A"));
    await serverA.start();
    const recordA = registryRecord(serverA.socketPath, namespaceId);
    writeRegistry(registryDir, recordA);
    runtime = createHerdrRuntime({
      registryDir, ledger, scanIntervalMs: 60000,
    });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, recordA.instanceId)?.online,
      5000, "A online",
    );
    const stateA = instanceState(runtime, recordA.instanceId);
    assert.equal(stateA.runId, recordA.runId);
    assert.deepEqual(stateA.agents.map((item) => item.agentId), ["term-A"]);
    const countsA = {
      requests: serverA.requestCount(), snapshots: serverA.state.snapshotCount,
      subscribes: serverA.state.subscribeCount,
    };
    await runtime.scan();
    await runtime.scan();
    await sleep(100);
    assert.deepEqual({
      requests: serverA.requestCount(), snapshots: serverA.state.snapshotCount,
      subscribes: serverA.state.subscribeCount,
    }, countsA);

    serverB = createProtocolServer(root, "b", agentSnapshot("term-B", "pane-1", "Agent B"));
    await serverB.start();
    const recordB = registryRecord(serverB.socketPath, namespaceId);
    writeRegistry(registryDir, recordB);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, recordB.instanceId)?.online,
      5000, "B online",
    );
    const both = runtime.getState();
    const stateB = instanceState(runtime, recordB.instanceId);
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.deepEqual(stateA.agents.map((item) => item.agentId), ["term-A"]);
    assert.deepEqual(stateB.agents.map((item) => item.agentId), ["term-B"]);
    assert.equal(both.instances.length, 2);
    const countsB = {
      requests: serverB.requestCount(), snapshots: serverB.state.snapshotCount,
      subscribes: serverB.state.subscribeCount,
    };
    await runtime.scan();
    await runtime.scan();
    await sleep(100);
    assert.deepEqual({
      requests: serverA.requestCount(), snapshots: serverA.state.snapshotCount,
      subscribes: serverA.state.subscribeCount,
    }, countsA);
    assert.deepEqual({
      requests: serverB.requestCount(), snapshots: serverB.state.snapshotCount,
      subscribes: serverB.state.subscribeCount,
    }, countsB);

    await serverB.stop();
    await waitFor(
      () => instanceState(runtime, recordB.instanceId)?.online === false,
      5000, "B offline state",
    );
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.equal(instanceState(runtime, recordB.instanceId).endpoint, "missing");
    assert.equal(noOffline(ledger, recordA.instanceId), true);
    assert.equal(noOffline(ledger, recordB.instanceId), true);
    recordEvidence.recordA = recordA;
    recordEvidence.recordB = recordB;
    recordEvidence.stateA = stateA;
    recordEvidence.stateB = stateB;
    recordEvidence.countsA = countsA;
    recordEvidence.countsB = countsB;
    recordEvidence.afterBStop = runtime.getState();
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (serverA) await serverA.stop().catch(() => {});
    if (serverB) await serverB.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("001", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-002 旧socket身份重连门、in-flight旧run终止与新run握手", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("002");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "002", cleanup: {} };
  let db = null;
  let runtime = null;
  let a1 = null;
  let a2 = null;
  let b1 = null;
  let b2 = null;
  try {
    const opened = openLedger(root, "app-runtime-002");
    db = opened.db;
    const ledger = opened.ledger;
    a1 = createProtocolServer(root, "a", agentSnapshot("term-A-old", "pane-A"));
    await a1.start();
    const oldA = registryRecord(a1.socketPath, namespaceId);
    writeRegistry(registryDir, oldA);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, oldA.instanceId)?.online,
      5000, "old A online",
    );
    await a1.stop();
    a2 = createProtocolServer(root, "a", agentSnapshot("term-A-new", "pane-A"));
    await a2.start();
    const noRegistrationBefore = {
      requests: a2.requestCount(), snapshots: a2.state.snapshotCount,
      subscribes: a2.state.subscribeCount,
    };
    await sleep(1400);
    assert.deepEqual({
      requests: a2.requestCount(), snapshots: a2.state.snapshotCount,
      subscribes: a2.state.subscribeCount,
    }, noRegistrationBefore);
    assert.equal(instanceState(runtime, oldA.instanceId).online, false);
    await runtime.scan();
    const replacedA = instanceState(runtime, oldA.instanceId);
    assert.equal(replacedA.endpoint, "replaced");
    assert.equal(replacedA.adapterState, null);
    assert.ok(runtime.getState().diagnostics.some((item) => item.code === "ENDPOINT_REPLACED"));
    assert.equal(a2.requestCount(), 0);
    const newA = registryRecord(a2.socketPath, namespaceId);
    assert.equal(newA.instanceId, oldA.instanceId);
    assert.notEqual(newA.runId, oldA.runId);
    writeRegistry(registryDir, newA);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, newA.instanceId)?.online,
      5000, "new A online",
    );
    assert.ok(a2.requestCount() > 0);
    assert.deepEqual(
      instanceState(runtime, newA.instanceId).agents.map((item) => item.agentId),
      ["term-A-new"],
    );
    recordEvidence.oldA = oldA;
    recordEvidence.newA = newA;
    recordEvidence.a2BeforeRegistration = noRegistrationBefore;
    recordEvidence.a2After = {
      requests: a2.requestCount(), subscribes: a2.state.subscribeCount,
    };

    /* 旧订阅保持时替换 socket，旧 adapter 的迟到 status 不能写入新 run。 */
    b1 = createProtocolServer(root, "b", agentSnapshot("term-B-old", "pane-B"));
    await b1.start();
    const oldB = registryRecord(b1.socketPath, namespaceId);
    writeRegistry(registryDir, oldB);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, oldB.instanceId)?.online,
      5000, "old B online",
    );
    b1.stopListening();
    b2 = createProtocolServer(root, "b", agentSnapshot("term-B-new", "pane-B"));
    await b2.start();
    const newB = registryRecord(b2.socketPath, namespaceId);
    writeRegistry(registryDir, newB);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, newB.instanceId)?.online,
      5000, "new B online",
    );
    b1.sendStatus("pane-B", "blocked");
    await sleep(100);
    const oldBRunEvents = ledgerEvents(ledger, oldB.instanceId, oldB.runId);
    assert.equal(oldBRunEvents.some(
      (item) => item.state === "needs_attention" && item.kind === "observation",
    ), false);
    assert.deepEqual(
      instanceState(runtime, newB.instanceId).agents.map((item) => item.agentId),
      ["term-B-new"],
    );
    recordEvidence.oldB = oldB;
    recordEvidence.newB = newB;
    recordEvidence.oldBLateStatus = oldBRunEvents.length;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (a1) await a1.stop().catch(() => {});
    if (a2) await a2.stop().catch(() => {});
    if (b1) await b1.stop().catch(() => {});
    if (b2) await b2.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("002", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-003 持久disable、关库重开、显式enable与另一实例", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("003");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "003", cleanup: {} };
  let db = null;
  let runtime = null;
  let serverA = null;
  let serverB = null;
  try {
    const opened = openLedger(root, "app-runtime-003");
    db = opened.db;
    let ledger = opened.ledger;
    serverA = createProtocolServer(root, "a", agentSnapshot("term-A", "pane-A"));
    serverB = createProtocolServer(root, "b", agentSnapshot("term-B", "pane-B"));
    await serverA.start();
    await serverB.start();
    const recordA = registryRecord(serverA.socketPath, namespaceId);
    const recordB = registryRecord(serverB.socketPath, namespaceId);
    writeRegistry(registryDir, recordA);
    writeRegistry(registryDir, recordB);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, recordA.instanceId)?.online
        && instanceState(runtime, recordB.instanceId)?.online,
      5000, "both online",
    );
    await assert.rejects(
      () => runtime.enable("inst-never-registered"),
      (error) => error.code === "HERDR_RUNTIME_NOT_REGISTERED",
    );
    assert.throws(
      () => runtime.disable("inst-never-registered"),
      (error) => error.code === "HERDR_RUNTIME_UNKNOWN_INSTANCE",
    );
    const aCountsBefore = {
      requests: serverA.requestCount(), subscribes: serverA.state.subscribeCount,
    };
    runtime.disable(recordA.instanceId);
    assert.equal(ledger.getInstance({ instanceId: recordA.instanceId }).disabled, true);
    assert.equal(instanceState(runtime, recordA.instanceId).disabled, true);
    assert.equal(instanceState(runtime, recordA.instanceId).adapterState, null);
    assert.equal(instanceState(runtime, recordB.instanceId).online, true);
    await runtime.scan();
    await sleep(100);
    assert.equal(serverA.requestCount(), aCountsBefore.requests);
    assert.equal(serverA.state.subscribeCount, aCountsBefore.subscribes);
    assert.equal(instanceState(runtime, recordB.instanceId).online, true);
    recordEvidence.beforeReopen = {
      a: instanceState(runtime, recordA.instanceId),
      b: instanceState(runtime, recordB.instanceId),
      aCounts: aCountsBefore,
    };

    assert.equal(noOffline(ledger, recordB.instanceId), true);
    assert.equal(ledger.getInstance({ instanceId: recordB.instanceId }).online, true);
    runtime.dispose();
    runtime = null;
    assert.equal(noOffline(ledger, recordB.instanceId), true);
    assert.equal(ledger.getInstance({ instanceId: recordB.instanceId }).online, true);
    db.close();
    db = null;
    const reopened = new DatabaseSync(path.join(root, "ledger.db"));
    db = reopened;
    ledger = createConnectorLedger({ db, appRunId: "app-runtime-003b" });
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, recordB.instanceId)?.online,
      5000, "B online after reopen",
    );
    assert.equal(instanceState(runtime, recordA.instanceId).disabled, true);
    assert.equal(instanceState(runtime, recordA.instanceId).online, false);
    assert.equal(serverA.requestCount(), aCountsBefore.requests);
    const bCountsAfterReopen = {
      requests: serverB.requestCount(), subscribes: serverB.state.subscribeCount,
    };
    await runtime.scan();
    await sleep(100);
    assert.equal(instanceState(runtime, recordB.instanceId).online, true);
    assert.equal(serverB.requestCount(), bCountsAfterReopen.requests);

    await runtime.enable(recordA.instanceId);
    await waitFor(
      () => instanceState(runtime, recordA.instanceId)?.online,
      5000, "A online after enable",
    );
    assert.equal(ledger.getInstance({ instanceId: recordA.instanceId }).disabled, false);
    assert.equal(instanceState(runtime, recordB.instanceId).online, true);
    assert.ok(serverA.requestCount() > aCountsBefore.requests);
    assert.equal(serverA.state.subscribeCount, aCountsBefore.subscribes + 1);
    const aOnlineNew = ledgerEvents(ledger, recordA.instanceId).filter(
      (item) => item.kind === "online" && item.appRunId === "app-runtime-003b",
    );
    assert.equal(aOnlineNew.length, 1);
    assert.equal(serverB.requestCount(), bCountsAfterReopen.requests);
    recordEvidence.afterEnable = {
      a: instanceState(runtime, recordA.instanceId),
      b: instanceState(runtime, recordB.instanceId),
      aServer: { requests: serverA.requestCount(), subscribes: serverA.state.subscribeCount },
      aOnlineNew: aOnlineNew.length,
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (serverA) await serverA.stop().catch(() => {});
    if (serverB) await serverB.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("003", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-004 登记损坏、目录不可读、socket缺失与修复", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("004");
  const registryDir = path.join(root, "registry");
  const backupDir = `${registryDir}-backup`;
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "004", cleanup: {} };
  let db = null;
  let runtime = null;
  let serverA = null;
  let serverA2 = null;
  try {
    const opened = openLedger(root, "app-runtime-004");
    db = opened.db;
    const ledger = opened.ledger;
    serverA = createProtocolServer(root, "a", agentSnapshot("term-A", "pane-A"));
    await serverA.start();
    const recordA = registryRecord(serverA.socketPath, namespaceId);
    const recordFile = writeRegistry(registryDir, recordA);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, recordA.instanceId)?.online,
      5000, "A online",
    );
    const baselineCounts = {
      requests: serverA.requestCount(), subscribes: serverA.state.subscribeCount,
    };

    fs.writeFileSync(recordFile, "{broken");
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.ok(runtime.getState().diagnostics.some(
      (item) => ["FILE_UNREADABLE", "INVALID_RECORD"].includes(item.code),
    ));
    assert.equal(serverA.requestCount(), baselineCounts.requests);
    fs.writeFileSync(recordFile, JSON.stringify(recordA));
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.equal(serverA.requestCount(), baselineCounts.requests);

    fs.renameSync(registryDir, backupDir);
    fs.writeFileSync(registryDir, "not a directory");
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.ok(runtime.getState().diagnostics.some(
      (item) => item.code === "DIRECTORY_UNREADABLE",
    ));
    fs.rmSync(registryDir, { force: true });
    fs.renameSync(backupDir, registryDir);
    fs.writeFileSync(recordFile, JSON.stringify(recordA));
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);

    fs.unlinkSync(serverA.socketPath);
    await runtime.scan();
    assert.equal(instanceState(runtime, recordA.instanceId).endpoint, "missing");
    assert.equal(instanceState(runtime, recordA.instanceId).online, true);
    assert.equal(noOffline(ledger, recordA.instanceId), true);
    await serverA.stop();
    serverA = null;
    serverA2 = createProtocolServer(root, "a", agentSnapshot("term-A2", "pane-A"));
    await serverA2.start();
    const recordA2 = registryRecord(serverA2.socketPath, namespaceId);
    assert.equal(recordA2.instanceId, recordA.instanceId);
    assert.notEqual(recordA2.runId, recordA.runId);
    writeRegistry(registryDir, recordA2);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, recordA2.instanceId)?.online,
      5000, "A repaired online",
    );
    assert.deepEqual(
      instanceState(runtime, recordA2.instanceId).agents.map((item) => item.agentId),
      ["term-A2"],
    );
    assert.equal(noOffline(ledger, recordA.instanceId), true);

    for (let index = 0; index < 100; index += 1) {
      fs.writeFileSync(
        path.join(registryDir, `zz-extra-${String(index).padStart(3, "0")}.json`), "{}",
      );
    }
    await runtime.scan();
    const limited = runtime.getState();
    assert.equal(limited.registry.truncated, true);
    assert.ok(limited.diagnostics.some((item) => item.code === "TOO_MANY_FILES"));
    assert.equal(instanceState(runtime, recordA2.instanceId).online, true);
    for (const name of fs.readdirSync(registryDir)) {
      if (name.startsWith("zz-extra-")) fs.rmSync(path.join(registryDir, name));
    }
    recordEvidence.recordA = recordA;
    recordEvidence.recordA2 = recordA2;
    recordEvidence.limited = {
      truncated: limited.registry.truncated,
      diagnostics: limited.diagnostics.map((item) => item.code),
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (fs.existsSync(registryDir) && fs.statSync(registryDir).isDirectory()) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 已恢复。 */ }
    } else if (fs.existsSync(backupDir)) {
      try {
        fs.rmSync(registryDir, { force: true });
        fs.renameSync(backupDir, registryDir);
      } catch { /* 保留原始失败。 */ }
    }
    if (runtime) runtime.dispose();
    if (serverA) await serverA.stop().catch(() => {});
    if (serverA2) await serverA2.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("004", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-005 挂起连接、并发scan、dispose与无泄漏", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("005");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "005", cleanup: {} };
  let db = null;
  let runtime = null;
  let server = null;
  try {
    const opened = openLedger(root, "app-runtime-005");
    db = opened.db;
    const ledger = opened.ledger;
    server = createProtocolServer(root, "a", agentSnapshot("term-A", "pane-A"));
    await server.start();
    const record = registryRecord(server.socketPath, namespaceId);
    writeRegistry(registryDir, record);
    const gate = server.holdNextSnapshot();
    const timers = new Map();
    let timerSerial = 0;
    const setIntervalFn = (fn, ms) => {
      const id = ++timerSerial;
      timers.set(id, { fn, ms });
      return id;
    };
    const clearIntervalFn = (id) => timers.delete(id);
    runtime = createHerdrRuntime({
      registryDir, ledger, scanIntervalMs: 60000,
      setIntervalFn, clearIntervalFn,
    });
    await runtime.start();
    await waitFor(() => server.state.held !== null, 3000, "held snapshot");
    assert.equal(timers.size, 1);
    assert.equal(server.state.snapshotCount, 1);
    assert.equal(server.state.subscribeCount, 0);
    await Promise.all([runtime.scan(), runtime.scan()]);
    await sleep(100);
    assert.equal(server.state.snapshotCount, 1);
    assert.equal(server.state.subscribeCount, 0);
    assert.equal(runtime.getState().instances.length, 1);
    const stateBefore = runtime.getState();
    runtime.dispose();
    assert.equal(timers.size, 0);
    await waitFor(() => server.state.sockets.size === 0, 3000, "request socket cleanup");
    await gate.release();
    await server.releaseHeld();
    await sleep(100);
    assert.equal(ledger.getInstance({ instanceId: record.instanceId }), null);
    assert.equal(ledgerEvents(ledger).length, 0);
    recordEvidence.requestsAfterDispose = [...server.state.requests];
    recordEvidence.snapshotCountAfterDispose = server.state.snapshotCount;
    assert.equal(server.state.snapshotCount, 1);
    assert.equal(server.state.subscribeCount, 0);
    const disposedState = runtime.getState();
    assert.equal(disposedState.disposed, true);
    runtime.dispose();
    await runtime.scan();
    assert.equal(server.requestCount(), 2);
    recordEvidence.stateBefore = stateBefore;
    recordEvidence.disposed = disposedState;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (server) await server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("005", recordEvidence, [root]);
  }
});

function realEnv(root, session) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    HERDR_CONFIG_PATH: path.join(root, "launch.toml"),
    session,
  };
}

function realCli(env, record, args) {
  record.commands.push(["herdr", "--session", env.session, ...args]);
  return execFileSync(HERDR, ["--session", env.session, ...args], {
    env, encoding: "utf8", timeout: 10000,
  });
}

async function startRealServer(root, record) {
  if (process.env.HERDR_ENV === "1") throw new Error("HERDR_ENV=1：拒绝创建测试 server");
  const session = `bayper-runtime-${crypto.randomBytes(4).toString("hex")}`;
  const env = realEnv(root, session);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(env.HERDR_CONFIG_PATH, ISO_CONFIG);
  record.commands.push(["herdr", "--version"]);
  const version = execFileSync(HERDR, ["--version"], { env, encoding: "utf8" }).trim();
  assert.match(version, /^herdr 0\.9\.5\b/);
  record.commands.push(["herdr", "--session", session, "server"]);
  const child = spawn(HERDR, ["--session", session, "server"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-3000);
  });
  const expected = path.join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock");
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Herdr server 提前退出：${stderr}`);
    }
    return fs.existsSync(expected);
  }, 10000, "real server socket");
  const status = await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Herdr server 提前退出：${stderr}`);
    }
    try {
      return JSON.parse(execFileSync(
        HERDR, ["--session", session, "status", "server", "--json"],
        { env, encoding: "utf8", timeout: 3000 },
      ));
    } catch {
      return null;
    }
  }, 10000, "real server status");
  assert.equal(status.running, true);
  assert.equal(status.session, session);
  assert.match(status.version, /^0\.9\.5\b/);
  assert.equal(status.protocol, 22);
  return {
    root, session, env, child, socketPath: status.socket,
    version: status.version, stderr: () => stderr,
  };
}

async function stopRealServer(ctx, record) {
  if (!ctx) return { started: false };
  const cleanup = {
    pid: ctx.child.pid, stopRequested: false, stopError: null, exited: false,
    exitCode: null, exitSignal: null, forcedKill: false, socketRemoved: false,
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
    5000, "real server exit",
  ).catch(() => {});
  if (ctx.child.exitCode === null && ctx.child.signalCode === null) {
    cleanup.forcedKill = ctx.child.kill("SIGTERM");
    await waitFor(
      () => ctx.child.exitCode !== null || ctx.child.signalCode !== null,
      2000, "real server SIGTERM",
    ).catch(() => {});
  }
  cleanup.exited = ctx.child.exitCode !== null || ctx.child.signalCode !== null;
  cleanup.exitCode = ctx.child.exitCode;
  cleanup.exitSignal = ctx.child.signalCode;
  await waitFor(() => !fs.existsSync(ctx.socketPath), 5000, "real socket removal").catch(() => {});
  cleanup.socketRemoved = !fs.existsSync(ctx.socketPath);
  cleanup.ok = cleanup.exited && cleanup.socketRemoved;
  return cleanup;
}

test("POL-HERDR-RUNTIME-008 真实Herdr在线后server stop确认下线、unknown与重复scan", {
  timeout: 45000,
  skip: SKIP_LIVE,
}, async () => {
  const root = tempRoot("008");
  const registryDir = path.join(root, "registry");
  const recordEvidence = { case: "008", commands: [], cleanup: {} };
  let ctx = null;
  let db = null;
  let runtime = null;
  let serverCleanup = null;
  let bodyError = null;
  try {
    ctx = await startRealServer(root, recordEvidence);
    recordEvidence.session = ctx.session;
    recordEvidence.version = ctx.version;
    recordEvidence.startPid = ctx.child.pid;
    recordEvidence.socketPath = ctx.socketPath;
    realCli(ctx.env, recordEvidence, ["plugin", "link", PLUGIN_DIR, "--enabled"]);
    const configDir = realCli(
      ctx.env, recordEvidence, ["plugin", "config-dir", PLUGIN_ID],
    ).trim();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
    const created = JSON.parse(realCli(ctx.env, recordEvidence, [
      "workspace", "create", "--cwd", root, "--label", "runtime-008", "--focus",
    ]));
    const paneId = created.result.root_pane.pane_id;
    realCli(ctx.env, recordEvidence, [
      "pane", "report-agent", paneId, "--source", "bayper-runtime-fixture",
      "--agent", "runtime-agent", "--state", "working", "--seq", "1",
    ]);
    realCli(ctx.env, recordEvidence, ["plugin", "action", "invoke", ACTION_ID]);
    const registration = await waitFor(() => {
      const app = readHerdrRegistry({ registryDir });
      return app.registrations.find((item) => item.endpoint === "matches");
    }, 10000, "real registry registration");
    recordEvidence.registration = {
      instanceId: registration.instanceId,
      runId: registration.runId,
      socketPath: registration.socket.path,
      observedServerPid: registration.observedServerPid,
    };
    assert.equal(registration.observedServerPid, ctx.child.pid);
    const opened = openLedger(root, "app-runtime-real");
    db = opened.db;
    runtime = createHerdrRuntime({
      registryDir, ledger: opened.ledger, scanIntervalMs: 60000,
    });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, registration.instanceId)?.online,
      10000, "real runtime online",
    );
    const state = instanceState(runtime, registration.instanceId);
    assert.equal(state.runId, registration.runId);
    assert.equal(state.endpoint, "matches");
    assert.ok(state.agents.some((item) => item.effectiveState === "working"));
    recordEvidence.onlineState = state;
    serverCleanup = await stopRealServer(ctx, recordEvidence);
    ctx = null;
    await waitFor(
      () => opened.ledger.getInstance({ instanceId: registration.instanceId }).online === false,
      5000, "real ledger disconnected",
    );
    await runtime.scan();
    const stoppedState = instanceState(runtime, registration.instanceId);
    assert.equal(stoppedState.stopped, true);
    assert.equal(stoppedState.online, false);
    const offlineEvents = ledgerEvents(opened.ledger, registration.instanceId)
      .filter((item) => item.kind === "offline");
    assert.equal(offlineEvents.length, 1);
    const agentsAfter = stoppedState.agents;
    assert.ok(agentsAfter.length >= 1);
    assert.ok(agentsAfter.every((item) => item.effectiveState === "unknown"));
    const all = ledgerEvents(opened.ledger, registration.instanceId);
    assert.equal(all.some((item) => ["finished", "failed", "stopped"].includes(item.state)), false);
    await runtime.scan();
    assert.equal(ledgerEvents(opened.ledger, registration.instanceId)
      .filter((item) => item.kind === "offline").length, 1);
    recordEvidence.stoppedState = stoppedState;
    recordEvidence.offlineEvents = offlineEvents.length;
    recordEvidence.cleanup.stopConfirmed = true;
    runtime.dispose();
    runtime = null;
  } catch (error) {
    bodyError = error;
    recordEvidence.error = { code: error.code || null, message: error.message };
  } finally {
    if (runtime) runtime.dispose();
    if (ctx) {
      try { serverCleanup = await stopRealServer(ctx, recordEvidence); } catch (error) {
        recordEvidence.cleanup.stopError = String(error.message).slice(0, 300);
      }
      ctx = null;
    }
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.server = serverCleanup;
    recordEvidence.cleanup.tempDirRemoved = !fs.existsSync(root);
    recordEvidence.cleanup.ok = Boolean(
      serverCleanup?.ok !== false && recordEvidence.cleanup.tempDirRemoved,
    );
    recordEvidence.evidence = saveEvidence("008", recordEvidence, [root]);
  }
  if (bodyError) throw bodyError;
  assert.ok(recordEvidence.cleanup.ok, "真实 server/socket/临时目录清理未完成");
});

test("POL-HERDR-RUNTIME-006 临时stat不可验证后同run自动退避恢复", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("006");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "006", cleanup: {} };
  let db = null;
  let runtime = null;
  let server = null;
  let mode = null;
  try {
    const opened = openLedger(root, "app-runtime-006");
    db = opened.db;
    const ledger = opened.ledger;
    server = createProtocolServer(root, "a", agentSnapshot("term-A", "pane-A"));
    await server.start();
    const record = registryRecord(server.socketPath, namespaceId);
    writeRegistry(registryDir, record);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, record.instanceId)?.online,
      5000, "A online",
    );
    const baseline = {
      requests: server.requestCount(), subscribes: server.state.subscribeCount,
    };
    const onlineBefore = ledgerEvents(ledger, record.instanceId).filter(
      (item) => item.kind === "online",
    ).length;
    for (const subscription of [...server.state.subscriptions]) {
      subscription.socket.destroy();
    }
    await waitFor(
      () => instanceState(runtime, record.instanceId)?.online === false,
      3000, "disconnected",
    );
    mode = fs.statSync(root).mode & 0o777;
    fs.chmodSync(root, 0o000);
    await sleep(1400);
    assert.equal(server.requestCount(), baseline.requests);
    const during = instanceState(runtime, record.instanceId);
    fs.chmodSync(root, mode);
    mode = null;
    await waitFor(
      () => instanceState(runtime, record.instanceId)?.online,
      6000, "same-run recovery",
    );
    assert.ok(server.requestCount() > baseline.requests);
    assert.equal(server.state.subscribeCount, baseline.subscribes + 1);
    const after = instanceState(runtime, record.instanceId);
    assert.equal(after.runId, record.runId);
    assert.equal(ledger.getInstance({ instanceId: record.instanceId }).online, true);
    const onlineAfter = ledgerEvents(ledger, record.instanceId).filter(
      (item) => item.kind === "online",
    ).length;
    assert.equal(onlineAfter, onlineBefore);
    recordEvidence.record = record;
    recordEvidence.baseline = baseline;
    recordEvidence.during = during;
    recordEvidence.after = after;
    recordEvidence.onlineBefore = onlineBefore;
    recordEvidence.onlineAfter = onlineAfter;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (mode !== null) {
      try { fs.chmodSync(root, mode); } catch { /* 保留原始失败。 */ }
    }
    if (runtime) runtime.dispose();
    if (server) await server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("006", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-007 握手跨短连接端点替换未被旧run摄入", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("007");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "007", cleanup: {} };
  let db = null;
  let runtime = null;
  let oldServer = null;
  let newServer = null;
  try {
    const opened = openLedger(root, "app-runtime-007");
    db = opened.db;
    const ledger = opened.ledger;
    oldServer = createProtocolServer(root, "a", agentSnapshot("term-old", "pane-A"));
    await oldServer.start();
    const oldRecord = registryRecord(oldServer.socketPath, namespaceId);
    writeRegistry(registryDir, oldRecord);
    const pingGate = oldServer.holdNextPing();
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(() => oldServer.state.heldPing !== null, 3000, "held ping");
    oldServer.stopListening();
    newServer = createProtocolServer(root, "a", agentSnapshot("term-new", "pane-A"));
    await newServer.start();
    await pingGate.release();
    await oldServer.releaseHeldPing();
    await sleep(500);
    assert.equal(newServer.requestCount(), 0);
    assert.equal(newServer.state.subscribeCount, 0);
    assert.equal(ledger.getInstance({ instanceId: oldRecord.instanceId }), null);
    assert.notEqual(instanceState(runtime, oldRecord.instanceId)?.online, true);
    await sleep(1200);
    assert.equal(newServer.requestCount(), 0);
    const newRecord = registryRecord(newServer.socketPath, namespaceId);
    assert.equal(newRecord.instanceId, oldRecord.instanceId);
    assert.notEqual(newRecord.runId, oldRecord.runId);
    writeRegistry(registryDir, newRecord);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, newRecord.instanceId)?.online,
      5000, "new run online",
    );
    assert.ok(newServer.requestCount() > 0);
    assert.deepEqual(
      instanceState(runtime, newRecord.instanceId).agents.map((item) => item.agentId),
      ["term-new"],
    );
    recordEvidence.oldRecord = oldRecord;
    recordEvidence.newRecord = newRecord;
    recordEvidence.newServerBeforeRegistration = {
      requests: 0, subscribes: 0,
    };
    recordEvidence.newServerAfter = {
      requests: newServer.requestCount(), subscribes: newServer.state.subscribeCount,
    };
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (oldServer) await oldServer.stop().catch(() => {});
    if (newServer) await newServer.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("007", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-009 socket移走但PID活着、EPERM/stat权限/首次握手失败均不确认下线", {
  timeout: 30000,
}, async () => {
  const root = tempRoot("009");
  const recordEvidence = { case: "009", cleanup: {}, subcases: [] };
  const opened = [];
  const servers = [];
  const runtimes = [];
  const makeServer = async (dir, name, snapshot) => {
    fs.mkdirSync(dir, { recursive: true });
    const server = createProtocolServer(dir, name, snapshot);
    await server.start();
    servers.push(server);
    return server;
  };
  const makeRuntime = (registryDir, ledger, extra = {}) => {
    const runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000, ...extra });
    runtimes.push(runtime);
    return runtime;
  };
  try {
    /* A：连接后仅移走 socket，登记 PID 仍活着。 */
    const rootA = path.join(root, "a");
    const registryA = path.join(rootA, "registry");
    const serverA = await makeServer(rootA, "socket", agentSnapshot("term-A", "pane-A"));
    const recordA = registryRecord(serverA.socketPath, crypto.randomUUID(), process.pid);
    writeRegistry(registryA, recordA);
    const dbA = openLedger(rootA, "app-runtime-009a");
    opened.push(dbA);
    const runtimeA = makeRuntime(registryA, dbA.ledger);
    await runtimeA.start();
    await waitFor(() => instanceState(runtimeA, recordA.instanceId)?.online, 5000, "A online");
    for (const subscription of [...serverA.state.subscriptions]) subscription.socket.destroy();
    await waitFor(
      () => dbA.ledger.getInstance({ instanceId: recordA.instanceId }).online === false,
      3000, "A disconnected",
    );
    fs.unlinkSync(serverA.socketPath);
    await runtimeA.scan();
    assert.equal(noOffline(dbA.ledger, recordA.instanceId), true);
    assert.notEqual(instanceState(runtimeA, recordA.instanceId).stopped, true);
    recordEvidence.subcases.push({ name: "socket-missing-pid-alive", offline: false });

    /* B：socket ENOENT，但 processProbe 为 EPERM。 */
    const rootB = path.join(root, "b");
    const registryB = path.join(rootB, "registry");
    const serverB = await makeServer(rootB, "socket", agentSnapshot("term-B", "pane-B"));
    const recordB = registryRecord(serverB.socketPath, crypto.randomUUID(), process.pid);
    writeRegistry(registryB, recordB);
    const dbB = openLedger(rootB, "app-runtime-009b");
    opened.push(dbB);
    const runtimeB = makeRuntime(registryB, dbB.ledger, {
      processProbe: () => ({ code: "EPERM" }),
    });
    await runtimeB.start();
    await waitFor(() => instanceState(runtimeB, recordB.instanceId)?.online, 5000, "B online");
    for (const subscription of [...serverB.state.subscriptions]) subscription.socket.destroy();
    await waitFor(
      () => dbB.ledger.getInstance({ instanceId: recordB.instanceId }).online === false,
      3000, "B disconnected",
    );
    fs.unlinkSync(serverB.socketPath);
    await runtimeB.scan();
    assert.equal(noOffline(dbB.ledger, recordB.instanceId), true);
    recordEvidence.subcases.push({ name: "eperm", offline: false });

    /* C：socket 路径 stat 权限失败，即使 PID ESRCH 也不确认。 */
    const rootC = path.join(root, "c");
    const sockDirC = path.join(rootC, "sock");
    const registryC = path.join(rootC, "registry");
    const dead = spawn(process.execPath, ["-e", ""]);
    await waitFor(() => dead.exitCode !== null || dead.signalCode !== null, 3000, "dead child");
    const serverC = await makeServer(sockDirC, "socket", agentSnapshot("term-C", "pane-C"));
    const recordC = registryRecord(serverC.socketPath, crypto.randomUUID(), dead.pid);
    writeRegistry(registryC, recordC);
    const dbC = openLedger(rootC, "app-runtime-009c");
    opened.push(dbC);
    const runtimeC = makeRuntime(registryC, dbC.ledger);
    await runtimeC.start();
    await waitFor(() => instanceState(runtimeC, recordC.instanceId)?.online, 5000, "C online");
    for (const subscription of [...serverC.state.subscriptions]) subscription.socket.destroy();
    await waitFor(
      () => dbC.ledger.getInstance({ instanceId: recordC.instanceId }).online === false,
      3000, "C disconnected",
    );
    fs.chmodSync(sockDirC, 0o000);
    try {
      await runtimeC.scan();
      assert.equal(noOffline(dbC.ledger, recordC.instanceId), true);
      recordEvidence.subcases.push({ name: "stat-eacces", offline: false });
    } finally {
      fs.chmodSync(sockDirC, 0o700);
    }

    /* D：首次握手从未成功，socket 消失且 PID ESRCH 也不确认。 */
    const rootD = path.join(root, "d");
    const registryD = path.join(rootD, "registry");
    const serverD = await makeServer(rootD, "socket", agentSnapshot("term-D", "pane-D"));
    const deadD = spawn(process.execPath, ["-e", ""]);
    await waitFor(() => deadD.exitCode !== null || deadD.signalCode !== null, 3000, "dead d");
    const recordD = registryRecord(serverD.socketPath, crypto.randomUUID(), deadD.pid);
    writeRegistry(registryD, recordD);
    await serverD.stop();
    const dbD = openLedger(rootD, "app-runtime-009d");
    opened.push(dbD);
    const runtimeD = makeRuntime(registryD, dbD.ledger);
    await runtimeD.start();
    await sleep(200);
    await runtimeD.scan();
    assert.equal(noOffline(dbD.ledger, recordD.instanceId), true);
    assert.notEqual(instanceState(runtimeD, recordD.instanceId)?.stopped, true);
    recordEvidence.subcases.push({ name: "never-connected", offline: false });

    /* E：登记已处于 ledger stopped；runtime 不新增 offline。 */
    const rootE = path.join(root, "e");
    const registryE = path.join(rootE, "registry");
    const serverE = await makeServer(rootE, "socket", agentSnapshot("term-E", "pane-E"));
    const recordE = registryRecord(serverE.socketPath, crypto.randomUUID(), process.pid);
    writeRegistry(registryE, recordE);
    const dbE = openLedger(rootE, "app-runtime-009e");
    opened.push(dbE);
    dbE.ledger.registerInstance({ instanceId: recordE.instanceId, runId: recordE.runId });
    dbE.ledger.confirmStopped({ instanceId: recordE.instanceId, runId: recordE.runId });
    const beforeE = ledgerEvents(dbE.ledger, recordE.instanceId)
      .filter((item) => item.kind === "offline").length;
    const runtimeE = makeRuntime(registryE, dbE.ledger);
    await runtimeE.start();
    await runtimeE.scan();
    assert.equal(ledgerEvents(dbE.ledger, recordE.instanceId)
      .filter((item) => item.kind === "offline").length, beforeE);
    assert.notEqual(instanceState(runtimeE, recordE.instanceId)?.online, true);
    recordEvidence.subcases.push({ name: "already-stopped", offline: false });

    /* F：坏登记目录不产生 offline。 */
    const rootF = path.join(root, "f");
    const registryF = path.join(rootF, "registry");
    fs.mkdirSync(registryF, { recursive: true });
    fs.writeFileSync(path.join(registryF, "broken.json"), "{broken");
    const dbF = openLedger(rootF, "app-runtime-009f");
    opened.push(dbF);
    const runtimeF = makeRuntime(registryF, dbF.ledger);
    await runtimeF.start();
    assert.equal(ledgerEvents(dbF.ledger).some((item) => item.kind === "offline"), false);
    assert.ok(runtimeF.getState().diagnostics.length >= 1);
    recordEvidence.subcases.push({ name: "bad-registration", offline: false });
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    for (const runtime of runtimes) runtime.dispose();
    for (const server of servers) await server.stop().catch(() => {});
    for (const entry of opened) entry.db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("009", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-010 新run先登记/连接时旧run不停止新run，disable/dispose无offline", {
  timeout: 25000,
}, async () => {
  const root = tempRoot("010");
  const registryDir = path.join(root, "registry");
  const recordEvidence = { case: "010", cleanup: {} };
  let db = null;
  let oldServer = null;
  let newServer = null;
  let runtime = null;
  try {
    const opened = openLedger(root, "app-runtime-010");
    db = opened.db;
    const ledger = opened.ledger;
    const namespaceId = crypto.randomUUID();
    oldServer = createProtocolServer(root, "endpoint", agentSnapshot("term-old", "pane-A"));
    await oldServer.start();
    const dead = spawn(process.execPath, ["-e", ""]);
    await waitFor(() => dead.exitCode !== null || dead.signalCode !== null, 3000, "dead old pid");
    const oldRecord = registryRecord(oldServer.socketPath, namespaceId, dead.pid);
    writeRegistry(registryDir, oldRecord);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, oldRecord.instanceId)?.online,
      5000, "old online",
    );
    await oldServer.stop();
    oldServer = null;
    newServer = createProtocolServer(root, "endpoint", agentSnapshot("term-new", "pane-A"));
    await newServer.start();
    const newRecord = registryRecord(newServer.socketPath, namespaceId, process.pid);
    assert.equal(newRecord.instanceId, oldRecord.instanceId);
    assert.notEqual(newRecord.runId, oldRecord.runId);
    writeRegistry(registryDir, newRecord);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, newRecord.instanceId)?.online,
      5000, "new online",
    );
    const newOnline = instanceState(runtime, newRecord.instanceId);
    assert.equal(ledgerEvents(ledger, newRecord.instanceId)
      .some((item) => item.kind === "offline"), false);
    assert.equal(ledgerEvents(ledger, oldRecord.instanceId, oldRecord.runId)
      .some((item) => item.kind === "offline"), false);
    runtime.disable(newRecord.instanceId);
    await runtime.scan();
    assert.equal(ledgerEvents(ledger, newRecord.instanceId)
      .some((item) => item.kind === "offline"), false);
    runtime.dispose();
    runtime = null;
    assert.equal(ledgerEvents(ledger, newRecord.instanceId)
      .some((item) => item.kind === "offline"), false);
    recordEvidence.oldRecord = oldRecord;
    recordEvidence.newRecord = newRecord;
    recordEvidence.newOnline = newOnline;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (oldServer) await oldServer.stop().catch(() => {});
    if (newServer) await newServer.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("010", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-011 首次失败内部retry成功后停止仍记录一次offline", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("011");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "011", cleanup: {} };
  let db = null;
  let runtime = null;
  let server = null;
  try {
    const opened = openLedger(root, "app-runtime-011");
    db = opened.db;
    const ledger = opened.ledger;
    const dead = spawn(process.execPath, ["-e", ""]);
    await waitFor(() => dead.exitCode !== null || dead.signalCode !== null, 3000, "dead pid");
    server = createProtocolServer(root, "endpoint", agentSnapshot("term-011", "pane-011"));
    await server.start();
    const record = registryRecord(server.socketPath, namespaceId, dead.pid);
    writeRegistry(registryDir, record);
    server.state.failFirstPing = true;
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    /* 只用 ledger/server 侧独立 Oracle 等待内部 retry 成功；期间不读 runtime.getState/scan。 */
    await waitFor(
      () => ledger.getInstance({ instanceId: record.instanceId })?.online === true,
      6000, "ledger online after retry",
    );
    assert.equal(server.state.pingFailures, 1);
    assert.ok(server.state.subscribeCount >= 1);
    const beforeOffline = ledgerEvents(ledger, record.instanceId)
      .filter((item) => item.kind === "offline").length;
    assert.equal(beforeOffline, 0);
    await server.stop();
    server = null;
    await waitFor(
      () => ledger.getInstance({ instanceId: record.instanceId }).online === false,
      3000, "disconnected after retry",
    );
    await runtime.scan();
    const stopped = instanceState(runtime, record.instanceId);
    recordEvidence.stoppedState = stopped;
    assert.equal(stopped.stopped, true);
    const offline = ledgerEvents(ledger, record.instanceId)
      .filter((item) => item.kind === "offline");
    assert.equal(offline.length, 1);
    assert.ok(stopped.agents.length >= 1);
    assert.ok(stopped.agents.every((item) => item.effectiveState === "unknown"));
    assert.equal(ledgerEvents(ledger, record.instanceId)
      .some((item) => ["finished", "failed", "stopped"].includes(item.state)), false);
    recordEvidence.record = record;
    recordEvidence.pingFailures = server?.state.pingFailures ?? 1;
    recordEvidence.stopped = stopped;
    recordEvidence.offline = offline.length;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (server) await server.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("011", recordEvidence, [root]);
  }
});

test("POL-HERDR-RUNTIME-012 已确认下线后同instance新run自动重连且旧offline不重复", {
  timeout: 20000,
}, async () => {
  const root = tempRoot("012");
  const registryDir = path.join(root, "registry");
  const namespaceId = crypto.randomUUID();
  const recordEvidence = { case: "012", cleanup: {} };
  let db = null;
  let runtime = null;
  let oldServer = null;
  let newServer = null;
  try {
    const opened = openLedger(root, "app-runtime-012");
    db = opened.db;
    const ledger = opened.ledger;
    oldServer = createProtocolServer(root, "endpoint", agentSnapshot("term-old", "pane-012"));
    await oldServer.start();
    const dead = spawn(process.execPath, ["-e", ""]);
    await waitFor(() => dead.exitCode !== null || dead.signalCode !== null, 3000, "dead old pid");
    const oldRecord = registryRecord(oldServer.socketPath, namespaceId, dead.pid);
    writeRegistry(registryDir, oldRecord);
    runtime = createHerdrRuntime({ registryDir, ledger, scanIntervalMs: 60000 });
    await runtime.start();
    await waitFor(
      () => instanceState(runtime, oldRecord.instanceId)?.online,
      5000, "old online",
    );
    await oldServer.stop();
    oldServer = null;
    await waitFor(
      () => ledger.getInstance({ instanceId: oldRecord.instanceId }).online === false,
      3000, "old disconnected",
    );
    await runtime.scan();
    assert.equal(instanceState(runtime, oldRecord.instanceId).stopped, true);
    const oldOffline = ledgerEvents(ledger, oldRecord.instanceId, oldRecord.runId)
      .filter((item) => item.kind === "offline");
    assert.equal(oldOffline.length, 1);

    newServer = createProtocolServer(root, "endpoint", agentSnapshot("term-new", "pane-012"));
    await newServer.start();
    const newRecord = registryRecord(newServer.socketPath, namespaceId, process.pid);
    assert.equal(newRecord.instanceId, oldRecord.instanceId);
    assert.notEqual(newRecord.runId, oldRecord.runId);
    writeRegistry(registryDir, newRecord);
    await runtime.scan();
    await waitFor(
      () => instanceState(runtime, newRecord.instanceId)?.online,
      5000, "new run online",
    );
    const newState = instanceState(runtime, newRecord.instanceId);
    assert.equal(newState.runId, newRecord.runId);
    assert.equal(newState.stopped, false);
    assert.deepEqual(newState.agents.map((item) => item.agentId), ["term-new"]);
    const oldOfflineAgain = ledgerEvents(ledger, oldRecord.instanceId, oldRecord.runId)
      .filter((item) => item.kind === "offline");
    assert.equal(oldOfflineAgain.length, 1);
    const newOnline = ledgerEvents(ledger, newRecord.instanceId, newRecord.runId)
      .filter((item) => item.kind === "online");
    assert.equal(newOnline.length, 1);
    await runtime.scan();
    assert.equal(ledgerEvents(ledger, oldRecord.instanceId, oldRecord.runId)
      .filter((item) => item.kind === "offline").length, 1);
    assert.equal(ledgerEvents(ledger, newRecord.instanceId, newRecord.runId)
      .filter((item) => item.kind === "online").length, 1);
    recordEvidence.oldRecord = oldRecord;
    recordEvidence.newRecord = newRecord;
    recordEvidence.newState = newState;
    recordEvidence.oldOffline = oldOfflineAgain.length;
    recordEvidence.newOnline = newOnline.length;
    recordEvidence.cleanup.service = "dispose";
  } catch (error) {
    recordEvidence.error = { code: error.code || null, message: error.message };
    throw error;
  } finally {
    if (runtime) runtime.dispose();
    if (oldServer) await oldServer.stop().catch(() => {});
    if (newServer) await newServer.stop().catch(() => {});
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    recordEvidence.cleanup.tempRemoved = !fs.existsSync(root);
    recordEvidence.evidence = saveEvidence("012", recordEvidence, [root]);
  }
});
