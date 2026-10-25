/* S05b-2 真实 Herdr 隔离互通验收。
   手动运行：node --test tests/acceptance/herdr-live.spec.cjs
   用户仅在 HERDR_ENV 不为 1 时授权创建、控制并清理本任务自建命名会话；
   不伪造 HERDR_ENV，不接触默认/现有会话，不启动 GUI，不启动真实模型。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { test } = require("node:test");
const { createHerdrTransport } = require("../../app/herdr-transport.cjs");

const HERDR = process.env.HERDR_BIN || "herdr";
const CASE_TIMEOUT = 40000;
const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.hapilon/polaris/Bayper完整交付/evidence/s05b-live",
);
const SKIP = process.env.HERDR_ENV === "1"
  ? "HERDR_ENV=1：不在 Herdr 会话外创建测试会话"
  : false;
const ISOLATED_CONFIG = `
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

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

function redact(value, roots) {
  if (typeof value === "string") {
    return roots.reduce((text, root) => text.split(root).join("<isolated-root>"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, roots)]),
    );
  }
  return value;
}

function writeEvidence(caseId, record, roots) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${caseId}.json`),
    `${JSON.stringify(redact(record, roots), null, 2)}\n`,
  );
}

function cli(env, record, args) {
  record.commands.push(["herdr", "--session", env.session, ...args]);
  return execFileSync(HERDR, ["--session", env.session, ...args], {
    env: env.env,
    encoding: "utf8",
    timeout: 10000,
  });
}

function cliJson(env, record, args) {
  return JSON.parse(cli(env, record, args));
}

async function startIsolated() {
  if (process.env.HERDR_ENV === "1") {
    throw new Error("HERDR_ENV=1：拒绝创建会话外 Herdr 测试会话");
  }
  // macOS sun_path 约 104 字节；隔离根显式使用短 /tmp，避免 XDG 路径超限。
  const root = fs.mkdtempSync("/tmp/bayper-herdr-live-");
  const realRoot = fs.realpathSync(root);
  const session = `bayper-live-${crypto.randomBytes(4).toString("hex")}`;
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    HERDR_CONFIG_PATH: path.join(root, "launch.toml"),
  };
  let child;
  let stderr = "";
  const commands = [];
  try {
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(env.XDG_STATE_HOME, { recursive: true });
    fs.mkdirSync(env.XDG_DATA_HOME, { recursive: true });
    fs.writeFileSync(env.HERDR_CONFIG_PATH, ISOLATED_CONFIG);
    commands.push(["herdr", "--version"]);
    const versionLine = execFileSync(HERDR, ["--version"], { env, encoding: "utf8" }).trim();
    assert.match(versionLine, /^herdr 0\.9\.5\b/);

    commands.push(["herdr", "--session", session, "server"]);
    child = spawn(HERDR, ["--session", session, "server"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    const expectedSocket = path.join(
      env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock",
    );
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Herdr server 提前退出：${stderr}`);
      }
      return fs.existsSync(expectedSocket);
    }, 10000, "server socket");

    commands.push(["herdr", "--session", session, "status", "server", "--json"]);
    const status = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Herdr server 提前退出：${stderr}`);
      }
      try {
        const parsed = JSON.parse(execFileSync(
          HERDR,
          ["--session", session, "status", "server", "--json"],
          { env, encoding: "utf8", timeout: 2000 },
        ));
        return parsed.running ? parsed : null;
      } catch {
        return null;
      }
    }, 10000, "server status");

    assert.equal(status.session, session);
    assert.match(status.version, /^0\.9\.5\b/);
    assert.equal(status.protocol, 22);
    const socketPath = status.socket;
    const realSocket = fs.realpathSync(socketPath);
    assert.ok(
      realSocket.startsWith(`${realRoot}${path.sep}`),
      "实际 socket 必须位于本轮隔离根内",
    );
    return {
      root,
      realRoot,
      session,
      env,
      child,
      socketPath,
      version: status.version,
      commands,
      stderr: () => stderr,
    };
  } catch (error) {
    try {
      execFileSync(HERDR, ["--session", session, "server", "stop"], {
        env,
        timeout: 3000,
        stdio: "ignore",
      });
    } catch {
      // 启动失败时只记录原始错误；临时目录必须删除。
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    fs.rmSync(root, { recursive: true, force: true });
    const message = String(error.message)
      .split(realRoot)
      .join("<isolated-root>")
      .split(root)
      .join("<isolated-root>");
    const safe = new Error(message);
    safe.code = error.code;
    throw safe;
  }
}

async function stopIsolated(env, record) {
  const cleanup = {
    pid: env.child.pid,
    serverStopRequested: false,
    serverStopError: null,
    serverExit: false,
    exitedCode: null,
    exitedSignal: null,
    forcedKill: false,
    socketRemoved: false,
    tempDirRemoved: false,
  };
  const alive = env.child.exitCode === null && env.child.signalCode === null;
  if (alive) {
    record.commands.push(["herdr", "--session", env.session, "server", "stop"]);
    try {
      execFileSync(HERDR, ["--session", env.session, "server", "stop"], {
        env: env.env,
        encoding: "utf8",
        timeout: 10000,
      });
      cleanup.serverStopRequested = true;
    } catch (error) {
      cleanup.serverStopError = { code: error.code || null, message: String(error.message).slice(0, 200) };
    }
  }
  await waitFor(
    () => env.child.exitCode !== null || env.child.signalCode !== null,
    5000,
    "server exit",
  ).catch(() => {});
  if (env.child.exitCode === null && env.child.signalCode === null) {
    record.commands.push(["herdr", "session", "stop", env.session, "--json"]);
    try {
      execFileSync(HERDR, ["session", "stop", env.session, "--json"], {
        env: env.env,
        encoding: "utf8",
        timeout: 5000,
      });
    } catch {
      // 失败时保留下方明确的强制清理标记。
    }
    await waitFor(
      () => env.child.exitCode !== null || env.child.signalCode !== null,
      2000,
      "server exit after session stop",
    ).catch(() => {});
  }
  if (env.child.exitCode === null && env.child.signalCode === null) {
    cleanup.forcedKill = env.child.kill("SIGTERM");
    await waitFor(
      () => env.child.exitCode !== null || env.child.signalCode !== null,
      2000,
      "server exit after SIGTERM",
    ).catch(() => {});
  }
  cleanup.serverExit = env.child.exitCode !== null || env.child.signalCode !== null;
  cleanup.exitedCode = env.child.exitCode;
  cleanup.exitedSignal = env.child.signalCode;
  await waitFor(() => !fs.existsSync(env.socketPath), 5000, "socket removal").catch(() => {});
  cleanup.socketRemoved = !fs.existsSync(env.socketPath);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch (error) {
    cleanup.removeError = String(error.message).slice(0, 200);
  }
  cleanup.tempDirRemoved = !fs.existsSync(env.root);
  cleanup.ok = cleanup.serverExit && cleanup.socketRemoved && cleanup.tempDirRemoved;
  return cleanup;
}

async function withIsolated(caseId, record, fn) {
  let env;
  let bodyError;
  try {
    env = await startIsolated();
    record.session = env.session;
    record.version = env.version;
    record.startPid = env.child.pid;
    record.socketPath = env.socketPath;
    record.commands = env.commands;
    await fn(env, record);
    record.status = "pass";
  } catch (error) {
    record.status = "fail";
    record.error = { code: error.code || null, message: error.message };
    bodyError = error;
  } finally {
    record.cleanup = env ? await stopIsolated(env, record) : { started: false };
    record.endPid = env ? env.child.pid : null;
    writeEvidence(caseId, record, env ? [env.realRoot, env.root] : []);
  }
  if (bodyError) throw bodyError;
  assert.ok(record.cleanup.ok, "隔离 server/socket/临时目录清理未完成");
}

function waitEvent(events, predicate, label, timeout = 5000) {
  return waitFor(() => events.find(predicate), timeout, label);
}

test("POL-HERDR-LIVE-001 隔离 server 的真实 ping/snapshot/plugin.list 与只读白名单", {
  timeout: CASE_TIMEOUT,
  skip: SKIP,
}, async () => {
  const record = { case: "001", commands: [], events: [], results: {} };
  await withIsolated("001", record, async (env) => {
    const created = cliJson(env, record, [
      "workspace", "create", "--cwd", env.root, "--label", "bayper-live-001", "--focus",
    ]);
    const workspace = created.result.workspace;
    const pane = created.result.root_pane;
    record.results.workspaceId = workspace.workspace_id;
    record.results.paneId = pane.pane_id;

    const transport = createHerdrTransport({ socketPath: env.socketPath });
    try {
      const pong = await transport.request("ping", {});
      const snapshotResult = await transport.request("session.snapshot", {});
      const pluginResult = await transport.request("plugin.list", {});
      const snapshot = snapshotResult.snapshot;
      record.snapshot = snapshot;

      assert.deepEqual(
        [pong.type, pong.version, pong.protocol],
        ["pong", "0.9.5", 22],
      );
      assert.equal(snapshotResult.type, "session_snapshot");
      assert.equal(snapshot.version, "0.9.5");
      assert.equal(snapshot.protocol, 22);
      assert.ok(Array.isArray(snapshot.workspaces));
      assert.ok(snapshot.workspaces.some(
        (item) => item.workspace_id === workspace.workspace_id && item.label === "bayper-live-001",
      ));
      assert.ok(snapshot.panes.some((item) => item.pane_id === pane.pane_id));
      for (const item of snapshot.panes) {
        for (const field of ["cwd", "foreground_cwd"]) {
          if (item[field]) {
            const realCwd = fs.realpathSync(item[field]);
            assert.ok(
              realCwd === env.realRoot || realCwd.startsWith(`${env.realRoot}${path.sep}`),
              `${field} 必须位于本轮隔离根内`,
            );
          }
        }
      }
      assert.equal(pluginResult.type, "plugin_list");
      assert.ok(Array.isArray(pluginResult.plugins));
      await assert.rejects(
        transport.request("server.stop", {}),
        (error) => error.code === "HERDR_METHOD_NOT_ALLOWED",
      );
      await assert.rejects(
        transport.request("pane.read", { pane_id: pane.pane_id }),
        (error) => error.code === "HERDR_METHOD_NOT_ALLOWED",
      );

      record.snapshot = snapshot;
      record.results.ping = { type: pong.type, version: pong.version, protocol: pong.protocol };
      record.results.pluginCount = pluginResult.plugins.length;
      record.results.readOnlyWhitelist = true;
    } finally {
      transport.dispose();
    }
  });
});

test("POL-HERDR-LIVE-002 真实状态/拓扑订阅与 working→blocked→working", {
  timeout: CASE_TIMEOUT,
  skip: SKIP,
}, async () => {
  const record = { case: "002", commands: [], events: [], results: {} };
  await withIsolated("002", record, async (env) => {
    const created = cliJson(env, record, [
      "workspace", "create", "--cwd", env.root, "--label", "bayper-live-002", "--focus",
    ]);
    const paneA = created.result.root_pane;
    const splitA = cliJson(env, record, [
      "pane", "split", paneA.pane_id, "--direction", "right", "--cwd", env.root, "--no-focus",
    ]);
    const paneB = splitA.result.pane;
    const transport = createHerdrTransport({ socketPath: env.socketPath });
    const events = record.events;
    let closeCount = 0;
    let closeError;
    const handle = await transport.subscribe({
      subscriptions: [
        { type: "pane.agent_status_changed", pane_id: paneA.pane_id },
        { type: "pane.agent_status_changed", pane_id: paneB.pane_id },
        { type: "pane.created" },
        { type: "pane.closed" },
      ],
      onEvent: (event) => events.push(event),
      onClose: (error) => {
        closeCount += 1;
        closeError = error;
      },
    });
    try {
      const [subA, subB, subCreated, subClosed] = handle.subscriptions;
      record.results.subscriptionIds = handle.subscriptions;
      record.results.readyBeforeReports = true;
      const report = (pane, agent, state, seq) => cli(env, record, [
        "pane", "report-agent", pane.pane_id,
        "--source", "bayper-live-fixture",
        "--agent", agent,
        "--state", state,
        "--seq", String(seq),
      ]);
      const countStatus = (paneId, status) => events.filter(
        (event) => event.event === "pane.agent_status_changed"
          && event.data.pane_id === paneId
          && event.data.agent_status === status,
      ).length;
      const reportAndWait = async (pane, agent, state, seq) => {
        const before = countStatus(pane.pane_id, state);
        report(pane, agent, state, seq);
        await waitFor(
          () => countStatus(pane.pane_id, state) > before,
          5000,
          `${pane.pane_id} ${state}`,
        );
      };

      await reportAndWait(paneA, "fixture-a", "working", 1);
      await reportAndWait(paneB, "fixture-b", "working", 1);
      await reportAndWait(paneA, "fixture-a", "blocked", 2);
      await reportAndWait(paneB, "fixture-b", "blocked", 2);
      await reportAndWait(paneA, "fixture-a", "working", 3);
      await reportAndWait(paneB, "fixture-b", "working", 3);

      const snapshot = (await transport.request("session.snapshot", {})).snapshot;
      record.snapshot = snapshot;
      const agents = snapshot.agents.filter(
        (item) => item.pane_id === paneA.pane_id || item.pane_id === paneB.pane_id,
      );
      assert.ok(agents.some((item) => item.pane_id === paneA.pane_id && item.agent === "fixture-a"));
      assert.ok(agents.some((item) => item.pane_id === paneB.pane_id && item.agent === "fixture-b"));

      const statusA = events.filter(
        (event) => event.event === "pane.agent_status_changed"
          && event.data.pane_id === paneA.pane_id,
      );
      const statusB = events.filter(
        (event) => event.event === "pane.agent_status_changed"
          && event.data.pane_id === paneB.pane_id,
      );
      const reportedA = statusA
        .filter((event) => ["working", "blocked"].includes(event.data.agent_status))
        .map((event) => event.data.agent_status);
      const reportedB = statusB
        .filter((event) => ["working", "blocked"].includes(event.data.agent_status))
        .map((event) => event.data.agent_status);
      assert.deepEqual(reportedA, ["working", "blocked", "working"]);
      assert.deepEqual(reportedB, ["working", "blocked", "working"]);
      assert.ok(statusA.every((event) => event.subscriptionId === subA.subscriptionId));
      assert.ok(statusB.every((event) => event.subscriptionId === subB.subscriptionId));
      assert.ok(statusA.every((event) => !("type" in event.data)));
      assert.ok(statusB.every((event) => !("type" in event.data)));
      assert.equal(statusA[0].localIndex, 1);
      assert.equal(statusB[0].localIndex, 1);
      for (const status of [statusA, statusB]) {
        const indices = status.map((event) => event.localIndex);
        assert.ok(indices.every((value, index) => index === 0 || value > indices[index - 1]));
      }

      const splitC = cliJson(env, record, [
        "pane", "split", paneA.pane_id, "--direction", "down", "--cwd", env.root, "--no-focus",
      ]);
      const paneC = splitC.result.pane;
      const createdEvent = await waitEvent(
        events,
        (event) => event.event === "pane_created" && event.data.pane?.pane_id === paneC.pane_id,
        "pane_created",
      );
      cli(env, record, ["pane", "close", paneC.pane_id]);
      const closedEvent = await waitEvent(
        events,
        (event) => event.event === "pane_closed" && event.data.pane_id === paneC.pane_id,
        "pane_closed",
      );
      assert.equal(createdEvent.subscriptionId, subCreated.subscriptionId);
      assert.equal(closedEvent.subscriptionId, subClosed.subscriptionId);
      assert.equal(createdEvent.data.type, "pane_created");
      assert.equal(closedEvent.data.type, "pane_closed");
      assert.equal(createdEvent.data.pane.pane_id, paneC.pane_id);
      assert.equal(closedEvent.data.pane_id, paneC.pane_id);
      record.results.reportedA = reportedA;
      record.results.reportedB = reportedB;
      record.results.topology = {
        created: createdEvent,
        closed: closedEvent,
      };
      record.results.finalSnapshotAgents = agents.map((item) => ({
        pane_id: item.pane_id,
        agent: item.agent,
        agent_status: item.agent_status,
      }));
      handle.close();
      assert.equal(closeCount, 1);
      assert.equal(closeError.code, "HERDR_CLOSED");
    } finally {
      transport.dispose();
    }
  });
});

test("POL-HERDR-LIVE-003 重订阅身份、新变化、server stop EOF 与 dispose", {
  timeout: CASE_TIMEOUT,
  skip: SKIP,
}, async () => {
  const record = { case: "003", commands: [], events: [], results: {} };
  await withIsolated("003", record, async (env) => {
    const created = cliJson(env, record, [
      "workspace", "create", "--cwd", env.root, "--label", "bayper-live-003", "--focus",
    ]);
    const pane = created.result.root_pane;
    const transport = createHerdrTransport({ socketPath: env.socketPath });
    const events = record.events;
    const report = (state, seq) => cli(env, record, [
      "pane", "report-agent", pane.pane_id,
      "--source", "bayper-live-fixture",
      "--agent", "fixture-live",
      "--state", state,
      "--seq", String(seq),
    ]);
    try {
      let firstCloseCount = 0;
      let firstCloseError;
      const first = await transport.subscribe({
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: pane.pane_id }],
        onEvent: (event) => events.push({ ...event, phase: "first" }),
        onClose: (error) => {
          firstCloseCount += 1;
          firstCloseError = error;
        },
      });
      const firstId = first.subscriptions[0].subscriptionId;
      report("working", 1);
      await waitEvent(
        events,
        (event) => event.phase === "first"
          && event.data.pane_id === pane.pane_id
          && event.data.agent_status === "working",
        "first working",
      );
      first.close();
      assert.equal(firstCloseCount, 1);
      assert.equal(firstCloseError.code, "HERDR_CLOSED");

      let secondCloseCount = 0;
      let secondCloseError;
      const second = await transport.subscribe({
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: pane.pane_id }],
        onEvent: (event) => events.push({ ...event, phase: "second" }),
        onClose: (error) => {
          secondCloseCount += 1;
          secondCloseError = error;
        },
      });
      const secondId = second.subscriptions[0].subscriptionId;
      assert.notEqual(secondId, firstId);

      await sleep(300);
      assert.equal(
        events.filter(
          (event) => event.phase === "second"
            && event.data?.pane_id === pane.pane_id
            && event.data.agent_status === "working",
        ).length,
        0,
        "新订阅不得把既往 working 历史当存在",
      );
      report("blocked", 2);
      const secondBlocked = await waitEvent(
        events,
        (event) => event.phase === "second"
          && event.data.pane_id === pane.pane_id
          && event.data.agent_status === "blocked",
        "second blocked",
      );
      const secondEvents = events.filter((event) => event.phase === "second");
      assert.equal(secondBlocked.subscriptionId, secondId);
      assert.ok(secondEvents.length > 0);
      assert.equal(secondEvents[0].localIndex, 1);
      assert.ok(secondEvents.every((event) => event.subscriptionId === secondId));

      cli(env, record, ["server", "stop"]);
      await waitFor(() => secondCloseError, 5000, "subscription EOF");
      assert.equal(secondCloseCount, 1);
      assert.equal(secondCloseError.code, "HERDR_EOF");
      assert.equal(
        events.filter(
          (event) => ["done", "finished"].includes(event.data?.agent_status),
        ).length,
        0,
        "EOF 不得伪造所有 Agent 完成",
      );
      assert.equal(
        events.filter((event) => event.event === "server.stop").length,
        0,
        "EOF 不得伪造 server.stop 事件",
      );

      const eventCountBeforeDispose = events.length;
      transport.dispose();
      await sleep(200);
      assert.equal(secondCloseCount, 1);
      assert.equal(events.length, eventCountBeforeDispose);
      record.results.firstSubscriptionId = firstId;
      record.results.secondSubscriptionId = secondId;
      record.results.newEvent = {
        subscriptionId: secondBlocked.subscriptionId,
        localIndex: secondBlocked.localIndex,
        data: secondBlocked.data,
      };
      record.results.close = {
        first: firstCloseError.code,
        second: secondCloseError.code,
      };
    } finally {
      transport.dispose();
    }
  });
});
