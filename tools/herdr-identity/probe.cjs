/* S05c 插件运行身份探针。仅在 /tmp/bayper-herdr-identity-* 中创建两个命名
   headless Herdr server，在隔离 XDG link 已审查 fixture；不查询默认/已有会话，
   不启 GUI/模型，不读终端内容。结果写入本工具 evidence 的唯批次文件。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { createHerdrTransport } = require("../../app/herdr-transport.cjs");

const HERDR = process.env.HERDR_BIN || "herdr";
const FIXTURE = path.join(__dirname, "fixture");
const MANIFEST = path.join(FIXTURE, "herdr-plugin.toml");
const RECORDER = path.join(FIXTURE, "record.cjs");
const EVIDENCE = path.join(__dirname, "evidence");
const PLUGIN_ID = "bayper.identity.probe";
const ACTION_ID = `${PLUGIN_ID}.capture`;
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
const CONFIG = `
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
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
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
const inside = (root, target) => {
  if (!target) return false;
  const base = realish(root);
  const value = realish(target);
  return value === base || value.startsWith(`${base}${path.sep}`);
};
const samePath = (a, b) => Boolean(a && b) && realish(a) === realish(b);
const pluginsOf = (value) => (Array.isArray(value) ? value : value.plugins || value.result?.plugins || [])
  .map((item) => item.plugin_id || item.id);

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const redact = (text, root, realRoot) => text
  .split(realRoot).join("<isolated-root>")
  .split(root).join("<isolated-root>");

function writeEvidence(report, records, root, realRoot) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const reportPath = path.join(EVIDENCE, `report-${RUN_ID}.json`);
  const recordsPath = path.join(EVIDENCE, `records-${RUN_ID}.jsonl`);
  fs.writeFileSync(reportPath, redact(JSON.stringify(report, null, 2), root, realRoot));
  fs.writeFileSync(
    recordsPath,
    `${records.map((record) => redact(JSON.stringify(record), root, realRoot)).join("\n")}\n`,
  );
  return { reportPath, recordsPath };
}

function readMain(file) {
  const records = readRecords(file);
  process.stdout.write(JSON.stringify({ count: records.length, records }));
}

async function mainProbe() {
  if (process.env.HERDR_ENV === "1") {
    throw new Error("HERDR_ENV=1：拒绝创建会话外 Herdr 探测 server");
  }
  const root = fs.mkdtempSync("/tmp/bayper-herdr-identity-");
  const realRoot = fs.realpathSync(root);
  const recordPath = path.join(root, "hooks.jsonl");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    HERDR_CONFIG_PATH: path.join(root, "launch.toml"),
    BAYPER_IDENTITY_ROOT: root,
    BAYPER_IDENTITY_RECORD_PATH: recordPath,
  };
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(env.HERDR_CONFIG_PATH, CONFIG);

  const commands = [];
  const servers = [];
  const records = () => readRecords(recordPath);
  const run = (server, args) => {
    commands.push(["herdr", "--session", server.session, ...args]);
    return execFileSync(HERDR, ["--session", server.session, ...args], {
      env, encoding: "utf8", timeout: 10000,
    });
  };
  const runJson = (server, args) => JSON.parse(run(server, args));
  const add = (key, session = `bhid-${key}-${crypto.randomBytes(4).toString("hex")}`) => {
    const child = spawn(HERDR, ["--session", session, "server"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    const server = { key, session, child, pid: child.pid, socket: null, status: null, stderr: "" };
    child.stderr.on("data", (chunk) => {
      server.stderr = `${server.stderr}${chunk.toString("utf8")}`.slice(-3000);
    });
    servers.push(server);
    return server;
  };
  const ready = async (server) => {
    const expected = path.join(
      env.XDG_CONFIG_HOME, "herdr", "sessions", server.session, "herdr.sock",
    );
    await waitFor(() => {
      if (server.child.exitCode !== null || server.child.signalCode !== null) {
        throw new Error(`${server.key} server 提前退出：${server.stderr}`);
      }
      return fs.existsSync(expected);
    }, 10000, `${server.key} socket`);
    const status = await waitFor(async () => {
      if (server.child.exitCode !== null || server.child.signalCode !== null) {
        throw new Error(`${server.key} server 提前退出：${server.stderr}`);
      }
      try {
        const parsed = JSON.parse(execFileSync(
          HERDR,
          ["--session", server.session, "status", "server", "--json"],
          { env, encoding: "utf8", timeout: 2000 },
        ));
        return parsed.running ? parsed : null;
      } catch {
        return null;
      }
    }, 10000, `${server.key} status`);
    assert.equal(status.session, server.session);
    assert.match(status.version, /^0\.9\.5\b/);
    assert.ok(fs.realpathSync(status.socket).startsWith(`${realRoot}${path.sep}`));
    server.socket = status.socket;
    server.status = status;
    return server;
  };
  const stop = async (server) => {
    const result = {
      session: server.session,
      pid: server.pid,
      exitCode: server.child.exitCode,
      signal: server.child.signalCode,
      socketRemoved: false,
    };
    if (server.child.exitCode === null && server.child.signalCode === null) {
      try {
        run(server, ["server", "stop"]);
      } catch (error) {
        result.stopError = error.message.slice(0, 200);
      }
      await waitFor(
        () => server.child.exitCode !== null || server.child.signalCode !== null,
        5000,
        `${server.key} exit`,
      ).catch(() => {});
      if (server.child.exitCode === null && server.child.signalCode === null) {
        result.forcedKill = server.child.kill("SIGTERM");
        await waitFor(
          () => server.child.exitCode !== null || server.child.signalCode !== null,
          2000,
          `${server.key} exit after SIGTERM`,
        ).catch(() => {});
      }
      result.exitCode = server.child.exitCode;
      result.signal = server.child.signalCode;
    }
    await waitFor(() => !fs.existsSync(server.socket), 5000, `${server.key} socket removal`).catch(() => {});
    result.socketRemoved = !fs.existsSync(server.socket);
    return result;
  };
  const socketSame = (record, socketPath) => {
    const stat = fs.statSync(socketPath, { bigint: true });
    return record.socket.dev === stat.dev.toString()
      && record.socket.ino === stat.ino.toString()
      && record.socket.birthtime_ms === stat.birthtimeMs.toString();
  };
  const action = async (server) => {
    const before = new Set(
      records().filter((item) => item.kind === "action" && samePath(item.socket?.path, server.socket))
        .map((item) => item.own_pid),
    );
    run(server, ["plugin", "action", "invoke", ACTION_ID]);
    return waitFor(
      () => records().find(
        (item) => item.kind === "action"
          && samePath(item.socket?.path, server.socket)
          && !before.has(item.own_pid),
      ),
      5000,
      `${server.key} action`,
    );
  };

  const report = {
    run_id: RUN_ID,
    status: "running",
    fixture: {
      dir: FIXTURE,
      manifest_sha256: hash(MANIFEST),
      record_sha256: hash(RECORDER),
      plugin_id: PLUGIN_ID,
      action_id: ACTION_ID,
    },
    commands,
    servers: {},
    cases: {},
    facts: [],
    limitations: [],
    recommendation: {},
    cleanup: {},
  };
  let bodyError = null;
  try {
    const a = add("a");
    const b = add("b");
    await Promise.all([ready(a), ready(b)]);
    report.servers = {
      a: { session: a.session, pid: a.pid, socket: a.socket },
      b: { session: b.session, pid: b.pid, socket: b.socket },
    };

    run(a, ["plugin", "link", FIXTURE, "--enabled"]);
    await waitFor(() => pluginsOf(runJson(a, ["plugin", "list", "--json"])).includes(PLUGIN_ID), 5000, "plugin a");
    await waitFor(() => pluginsOf(runJson(b, ["plugin", "list", "--json"])).includes(PLUGIN_ID), 5000, "plugin b");
    const configDir = run(a, ["plugin", "config-dir", PLUGIN_ID]).trim();
    assert.ok(inside(root, configDir), "config dir 在隔离根内");
    assert.equal(records().filter((item) => item.kind === "startup").length, 0, "link 不触发 startup");
    const wsA = runJson(a, ["workspace", "create", "--cwd", root, "--label", "identity-a", "--focus"]).result.workspace;
    const wsB = runJson(b, ["workspace", "create", "--cwd", root, "--label", "identity-b", "--focus"]).result.workspace;
    const actionA1 = await action(a);
    const actionB1 = await action(b);

    assert.deepEqual([actionA1.plugin_id, actionB1.plugin_id], [PLUGIN_ID, PLUGIN_ID]);
    assert.ok(samePath(actionA1.socket.path, a.socket));
    assert.ok(samePath(actionB1.socket.path, b.socket));
    assert.ok(actionA1.config_dir && inside(root, actionA1.config_dir));
    assert.ok(actionA1.state_dir && inside(root, actionA1.state_dir));
    assert.ok(samePath(actionA1.config_dir, actionB1.config_dir));
    assert.ok(samePath(actionA1.state_dir, actionB1.state_dir));
    assert.equal(actionA1.own_ppid, a.pid);
    assert.equal(actionB1.own_ppid, b.pid);
    assert.ok(socketSame(actionA1, a.socket));
    assert.ok(socketSame(actionB1, b.socket));
    assert.notEqual(actionA1.socket.ino, actionB1.socket.ino);
    assert.notEqual(a.pid, b.pid);
    assert.equal(actionA1.context.ids.workspace_id, wsA.workspace_id);
    assert.equal(actionB1.context.ids.workspace_id, wsB.workspace_id);
    assert.ok(samePath(actionA1.context.ids.pane_id, actionA1.pane_id));
    assert.equal(actionA1.context.ids.tab_id, actionA1.tab_id);
    report.cases["001"] = {
      a: {
        server: report.servers.a,
        own_pid: actionA1.own_pid,
        own_ppid: actionA1.own_ppid,
        socket: actionA1.socket,
        context: actionA1.context,
        state_dir: actionA1.state_dir,
      },
      b: {
        server: report.servers.b,
        own_pid: actionB1.own_pid,
        own_ppid: actionB1.own_ppid,
        socket: actionB1.socket,
        context: actionB1.context,
        state_dir: actionB1.state_dir,
      },
      config_dir: configDir,
      shared_state_dir: actionA1.state_dir,
      plugin_visible_in_b: true,
      no_startup_on_link: true,
    };
    report.facts.push("action hook 父 PID 分别等于两个 server 的 spawn 句柄 PID");
    report.facts.push("action context 的 workspace/tab/focused pane ID 来自各自 focused workspace；只记录字段名/ID");
    report.facts.push("两 server socket inode/路径不同；plugin config/state dir 相同且在隔离根内");
    report.facts.push("link 已运行 server 未触发 startup；显式 action 才产生 action 记录");
    report.facts.push("workspace/tab/pane ID 是 session 局部值，两 server 可同时为 w1/w1:t1/w1:p1，不能单独作 run 身份");
    report.limitations.push("socket birthtime 可能同毫秒；代次需 path+dev+ino+birthtime 组合");
    report.limitations.push("PID 可能复用；旧身份结束不能仅凭 kill(pid,0) 或 ps 秒级时间宣称");

    const actionA2 = await action(a);
    assert.notEqual(actionA2.own_pid, actionA1.own_pid);
    assert.equal(actionA2.own_ppid, actionA1.own_ppid);
    assert.deepEqual(actionA2.socket, actionA1.socket);
    const transport = createHerdrTransport({ socketPath: a.socket });
    const pong = await transport.request("ping", {});
    transport.dispose();
    assert.deepEqual([pong.type, pong.version, pong.protocol], ["pong", "0.9.5", 22]);
    report.facts.push("同一 server 两次 action 的 own_pid 不同，但 ppid/socket 元数据稳定；生产 ping 成功");

    const oldA = { pid: a.pid, socket: a.socket, ino: actionA1.socket.ino };
    const stoppedA = await stop(a);
    assert.ok(stoppedA.socketRemoved, "旧 A socket 已移除");
    const a2 = add("a", a.session);
    await ready(a2);
    const startup = await waitFor(
      () => records().find((item) => item.kind === "startup" && samePath(item.socket?.path, a2.socket)),
      5000,
      "startup after restart",
    );
    assert.equal(startup.event, "startup");
    assert.equal(startup.own_ppid, a2.pid);
    assert.ok(socketSame(startup, a2.socket));
    assert.notEqual(startup.socket.ino, actionA1.socket.ino);
    assert.notEqual(a2.pid, a.pid);
    report.cases["002"] = {
      action_pids: [actionA1.own_pid, actionA2.own_pid],
      ppid: actionA1.own_ppid,
      ping: { type: pong.type, version: pong.version, protocol: pong.protocol },
      old_a: oldA,
      stopped_a: stoppedA,
      restarted_a: {
        pid: a2.pid,
        socket: a2.socket,
        startup_pid: startup.own_pid,
        startup_ppid: startup.own_ppid,
        startup_socket: startup.socket,
      },
      socket_generation_changed: startup.socket.ino !== actionA1.socket.ino,
      old_process_exit: stoppedA.exitCode !== null || stoppedA.signal !== null,
    };
    report.facts.push("同名 session 重启产生新 startup、新 server PID、新 socket inode");
    report.facts.push("旧身份结束由旧 child 退出、旧 socket 移除和新端点替换共同支持");

    const reader = JSON.parse(execFileSync(
      process.execPath,
      [__filename, "read", recordPath],
      { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } },
    ));
    const lateB = reader.records.find(
      (item) => item.kind === "action" && samePath(item.socket?.path, b.socket),
    );
    assert.ok(reader.count >= 4);
    assert.ok(lateB, "独立 reader 读到 server B 记录");
    const lateTransport = createHerdrTransport({ socketPath: lateB.socket.path });
    const latePong = await lateTransport.request("ping", {});
    lateTransport.dispose();
    assert.deepEqual([latePong.type, latePong.version], ["pong", "0.9.5"]);
    report.cases["003"] = {
      reader_count: reader.count,
      late_action: {
        own_pid: lateB.own_pid,
        own_ppid: lateB.own_ppid,
        socket: lateB.socket,
        context: lateB.context,
      },
      late_ping: { type: latePong.type, version: latePong.version, protocol: latePong.protocol },
    };
    report.facts.push("独立 reader 在记录持久化后读到上下文/socket；生产 transport 对记录端点 ping 成功");

    report.recommendation = {
      instanceId: "PRD 一个 server 一个实例。共享安装 UUID 只能作为命名空间，不能单独作为 instanceId；instanceId 必须由该命名空间与正式规范定义的具体端点身份共同组成，确保同一 session 重启仍属于同一实例、不同 server 不能合并。",
      runId: "runId 依据同一 instanceId 的当前端点代次和实际进程证据分配；重复 action 复用同一代次，不按 action PID 新建。既有 server 首次 link 没有 startup 时，首次 action 也必须在核对实际进程/端点后创建当前代次记录，不能只读取不存在的 startup 记录。",
      end: "端点替换只证明旧端点代次失效；socket 消失本身不能单独称为明确的 server stop。若无法独立证明 server 进程已经结束，应保持 unknown/disconnected；只有实际进程退出（或正式规范确认的等价证据）才结束旧 run。",
      lateDiscovery: "Bayper 晚启动时读取 state dir 中持久化记录后，必须核验端点/进程证据；首次 action 可在无 startup 时建立当前代次。正式自动发现/登记尚未实现。",
      registration: "正式插件登记、端点身份规范和运行代次持久化均尚未实现；以上为探针事实支持的建议，待正式方案与验证，不能当作已完成的连接器或自动发现。",
      caveats: [
        "共享安装 UUID 只是命名空间，不是 instanceId 本身；端点身份字段待正式规范确认。",
        "context 的 workspace/tab/pane ID 是 session 局部值，两 server 可重复；必须与实例/端点身份一起使用。",
        "socket birthtime 可能同毫秒；代次需 path+dev+ino+birthtime 组合。",
        "本次只验证本机 macOS 0.9.5 与构造 fixture。",
      ],
    };
    report.status = "pass";
  } catch (error) {
    bodyError = error;
    report.status = "fail";
    report.error = { code: error.code || null, message: error.message };
  } finally {
    const latest = new Map();
    for (const server of servers) latest.set(server.session, server);
    const cleaned = [];
    for (const server of servers) {
      if (latest.get(server.session) !== server) {
        cleaned.push({
          session: server.session,
          pid: server.pid,
          exitCode: server.child.exitCode,
          signal: server.child.signalCode,
          superseded: true,
          socketReusedByRestart: true,
        });
      } else {
        cleaned.push(await stop(server));
      }
    }
    const finalRecords = records();
    const fixtureAlive = finalRecords.filter((item) => {
      try {
        const command = execFileSync("ps", ["-o", "command=", "-p", String(item.own_pid)], {
          encoding: "utf8", timeout: 1000,
        }).trim();
        return command.includes("record.cjs");
      } catch {
        return false;
      }
    }).map((item) => item.own_pid);
    fs.rmSync(root, { recursive: true, force: true });
    const latestClean = cleaned.filter((item) => !item.superseded)
      .every((item) => item.exitCode !== null && item.socketRemoved === true);
    report.cleanup = {
      servers: cleaned,
      latestClean,
      fixtureProcessesAlive: fixtureAlive,
      tempRootRemoved: !fs.existsSync(root),
      hookPidCaveat: "fixture PID 检查仅辅助；旧身份以 server 句柄退出和端点替换为准",
    };
    report.cleanup.ok = latestClean
      && fixtureAlive.length === 0
      && report.cleanup.tempRootRemoved;
    if (!report.cleanup.ok && report.status === "pass") {
      report.status = "fail";
      report.error = { code: "CLEANUP", message: "隔离 server/socket/临时目录清理未完成" };
    }
    const evidence = writeEvidence(report, finalRecords, root, realRoot);
    report.evidence = evidence;
    report.cleanup.evidence = evidence;
    fs.writeFileSync(evidence.reportPath, redact(JSON.stringify(report, null, 2), root, realRoot));
    if (report.status === "pass") {
      process.stdout.write(`${JSON.stringify({
        status: report.status,
        run_id: RUN_ID,
        evidence,
        facts: report.facts,
        recommendation: report.recommendation,
        cleanup: report.cleanup,
      }, null, 2)}\n`);
    }
  }
  if (bodyError) throw bodyError;
  if (report.status !== "pass") throw new Error(report.error?.message || "identity probe 未通过");
}

if (process.argv[2] === "read") {
  readMain(process.argv[3]);
} else {
  mainProbe().catch((error) => {
    process.stderr.write(`S05c identity probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
