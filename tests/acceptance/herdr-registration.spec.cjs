/* S05d Herdr 正式插件登记验收。
   001/002 使用真实 Unix socket 的受控端点与正式 register.cjs 子进程；
   003 使用本轮隔离 XDG 的真实 Herdr named server，手动运行，不加入默认 npm test。
   所有 Herdr 运行态命令显式 --session 与隔离 env，不访问默认/已有会话。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { readHerdrRegistry } = require("../../app/herdr-registry.cjs");
const { createHerdrTransport } = require("../../app/herdr-transport.cjs");

const HERDR = process.env.HERDR_BIN || "herdr";
const REGISTER = path.resolve(__dirname, "../../plugins/herdr/register.cjs");
const PLUGIN_DIR = path.resolve(__dirname, "../../plugins/herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const EVIDENCE = path.resolve(
  __dirname,
  "../../.hapilon/polaris/Bayper完整交付/evidence/s05d-registration",
);
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
const SKIP_LIVE = process.env.HERDR_ENV === "1"
  ? "HERDR_ENV=1：不在 Herdr 会话外创建真实测试 server"
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = () => fs.mkdtempSync("/tmp/bayper-herdr-registration-");
const realish = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};
const redactText = (text, roots) => roots.reduce(
  (value, root) => value.split(realish(root)).join("<isolated-root>").split(root).join("<isolated-root>"),
  text,
);

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`等待超时：${label}`);
}

function saveEvidence(caseId, record, roots) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `report-${RUN_ID}-${caseId}.json`);
  fs.writeFileSync(file, `${redactText(JSON.stringify(record, null, 2), roots)}\n`);
  return file;
}

function readRegistryFiles(registryDir) {
  if (!fs.existsSync(registryDir)) return [];
  return fs.readdirSync(registryDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => ({ name, record: JSON.parse(fs.readFileSync(path.join(registryDir, name), "utf8")) }));
}

function pluginEnv(endpoint, stateDir, configDir) {
  return {
    HERDR_SOCKET_PATH: endpoint.socketPath,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_ID: PLUGIN_ID,
  };
}

function writePluginConfig(configDir, registryDir) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
}

function fixtureEndpoint(socketPath, readyPath) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
  });
  server.listen(socketPath, () => fs.writeFileSync(readyPath, "ready"));
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let job;
    try {
      job = JSON.parse(line);
    } catch {
      return;
    }
    const child = spawn(process.execPath, [REGISTER], {
      env: { ...process.env, ...job.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      process.stdout.write(`${JSON.stringify({ id: job.id, code: -1, stdout, stderr: error.message })}\n`);
    });
    child.on("close", (code) => {
      process.stdout.write(`${JSON.stringify({ id: job.id, code, stdout, stderr })}\n`);
    });
  });
  const stop = () => {
    server.close(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // 已移除。
      }
      process.exit(0);
    });
  };
  lines.on("close", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function startEndpoint(root, name) {
  const socketPath = path.join(root, `${name}.sock`);
  const readyPath = `${socketPath}.ready`;
  const child = spawn(process.execPath, [__filename, "fixture-endpoint", socketPath, readyPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // 忽略非协议输出。
    }
  });
  await waitFor(
    () => fs.existsSync(readyPath) && fs.existsSync(socketPath),
    5000,
    `${name} fixture endpoint`,
  );
  return {
    child,
    pid: child.pid,
    socketPath,
    stderr: () => stderr,
    request(env) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, env })}\n`);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${name} register timeout`));
        }, 10000).unref?.();
      });
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitFor(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
        `${name} exit`,
      ).catch(() => {});
      await waitFor(() => !fs.existsSync(socketPath), 3000, `${name} socket removal`).catch(() => {});
      return {
        pid: child.pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
        socketRemoved: !fs.existsSync(socketPath),
      };
    },
  };
}

function pluginsOf(value) {
  const list = Array.isArray(value) ? value : value.plugins || value.result?.plugins || [];
  return list.map((item) => item.plugin_id || item.id);
}

const sameSocketPath = (a, b) => Boolean(a && b) && realish(a) === realish(b);

function startHerdr(env, key, session, commands) {
  const name = session || `bhid-${key}-${crypto.randomBytes(4).toString("hex")}`;
  commands.push(["herdr", "--session", name, "server"]);
  const child = spawn(HERDR, ["--session", name, "server"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { key, session: name, child, pid: child.pid, socket: null, stderr: "" };
  child.stderr.on("data", (chunk) => {
    server.stderr = `${server.stderr}${chunk.toString("utf8")}`.slice(-3000);
  });
  return server;
}

function herdrCli(server, env, args, commands) {
  commands.push(["herdr", "--session", server.session, ...args]);
  return execFileSync(HERDR, ["--session", server.session, ...args], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
}

async function waitHerdr(server, env, commands) {
  const expected = path.join(
    env.XDG_CONFIG_HOME, "herdr", "sessions", server.session, "herdr.sock",
  );
  await waitFor(() => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`${server.key} server 提前退出：${server.stderr}`);
    }
    return fs.existsSync(expected);
  }, 10000, `${server.key} socket`);
  const status = await waitFor(() => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`${server.key} server 提前退出：${server.stderr}`);
    }
    try {
      const parsed = JSON.parse(herdrCli(server, env, ["status", "server", "--json"], commands));
      return parsed.running ? parsed : null;
    } catch {
      return null;
    }
  }, 10000, `${server.key} status`);
  assert.equal(status.session, server.session);
  assert.match(status.version, /^0\.9\.5\b/);
  server.socket = status.socket;
  return server;
}

async function stopHerdr(server, env, commands) {
  if (!server) return null;
  const result = {
    session: server.session,
    pid: server.pid,
    exitCode: server.child.exitCode,
    signal: server.child.signalCode,
    socketRemoved: false,
  };
  if (server.child.exitCode === null && server.child.signalCode === null) {
    try {
      herdrCli(server, env, ["server", "stop"], commands);
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
}

function defineTests() {
  test("POL-REGISTER-001 两独立端点重复登记不外泄且 app 读取独立", { timeout: 20000 }, async (t) => {
    const root = tempRoot();
    const registryDir = path.join(root, "registry");
    const stateDir = path.join(root, "state");
    const configDir = path.join(root, "config");
    writePluginConfig(configDir, registryDir);
    const record = { case: "001", registrations: [], app: null, cleanup: {}, commands: [] };
    const endpoints = [];
    try {
      const a = await startEndpoint(root, "endpoint-a");
      const b = await startEndpoint(root, "endpoint-b");
      endpoints.push(a, b);
      const envA = pluginEnv(a, stateDir, configDir);
      const envB = pluginEnv(b, stateDir, configDir);

      const firstA = await a.request(envA);
      const secondA = await a.request(envA);
      const firstB = await b.request(envB);
      for (const [label, result] of [["a1", firstA], ["a2", secondA], ["b1", firstB]]) {
        record.commands.push({ label, code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
        assert.equal(result.code, 0, `${label} register: ${result.stderr}`);
      }
      const parsedA1 = JSON.parse(firstA.stdout);
      const parsedA2 = JSON.parse(secondA.stdout);
      const parsedB1 = JSON.parse(firstB.stdout);
      assert.equal(parsedA1.instanceId, parsedA2.instanceId);
      assert.equal(parsedA1.runId, parsedA2.runId);
      assert.notEqual(parsedA1.instanceId, parsedB1.instanceId);
      assert.notEqual(parsedA1.runId, parsedB1.runId);

      const files = readRegistryFiles(registryDir);
      assert.equal(files.length, 2);
      const byInstance = Object.fromEntries(files.map((item) => [item.record.instanceId, item]));
      const recordA = byInstance[parsedA1.instanceId];
      const recordB = byInstance[parsedB1.instanceId];
      assert.ok(recordA && recordB);
      assert.equal(recordA.name, `${recordA.record.instanceId}.json`);
      assert.equal(recordB.name, `${recordB.record.instanceId}.json`);
      assert.equal(recordA.record.schemaVersion, 2);
      assert.equal(recordA.record.pluginId, PLUGIN_ID);
      assert.equal(recordA.record.observedServerPid, a.pid);
      assert.equal(recordB.record.observedServerPid, b.pid);
      assert.equal(recordA.record.socket.path, realish(a.socketPath));
      assert.equal(recordB.record.socket.path, realish(b.socketPath));
      for (const item of [recordA.record, recordB.record]) {
        const keys = Object.keys(item).sort();
        assert.deepEqual(keys, [
          "firstRegisteredAt", "instanceId", "lastRegisteredAt", "namespaceId",
          "observedServerPid", "pluginId", "runId", "schemaVersion", "socket",
        ]);
        assert.equal(fs.statSync(path.join(registryDir, `${item.instanceId}.json`)).mode & 0o777, 0o600);
      }
      const namespace = JSON.parse(fs.readFileSync(path.join(stateDir, "install.json"), "utf8"));
      assert.equal(namespace.schemaVersion, 1);
      assert.equal(files.length, 2);

      const app = readHerdrRegistry({ registryDir });
      assert.equal(app.found, true);
      assert.equal(app.registrations.length, 2);
      assert.equal(app.diagnostics.length, 0);
      for (const item of app.registrations) {
        assert.equal(item.endpoint, "matches");
        assert.equal(item.connectable, true);
        assert.equal(Object.prototype.hasOwnProperty.call(item, "online"), false);
      }
      const missingConfig = await a.request({
        ...envA,
        HERDR_PLUGIN_CONFIG_DIR: path.join(root, "no-config"),
      });
      assert.notEqual(missingConfig.code, 0);
      assert.match(missingConfig.stderr, /bayper\.json/);
      const missingDir = readHerdrRegistry({ registryDir: path.join(root, "no-registry") });
      assert.equal(missingDir.found, false);
      assert.equal(missingDir.registrations.length, 0);
      record.commands.push({
        label: "missing-config",
        code: missingConfig.code,
        stderr: missingConfig.stderr.trim(),
      });
      record.registrations = files.map((item) => item.record);
      record.app = app;
      record.endpoints = { a: a.pid, b: b.pid };
      record.cleanup.endpoints = [await a.stop(), await b.stop()];
      endpoints.length = 0;
    } catch (error) {
      record.error = { code: error.code || null, message: error.message };
      throw error;
    } finally {
      for (const endpoint of endpoints) {
        try {
          record.cleanup[endpoint.socketPath] = await endpoint.stop();
        } catch {
          // 保留原始失败。
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      record.cleanup.tempRootRemoved = !fs.existsSync(root);
      record.evidence = saveEvidence("001", record, [root]);
    }
  });

  test("POL-REGISTER-002 首次并发/端点代次/损坏记录与 namespace", { timeout: 25000 }, async (t) => {
    const root = tempRoot();
    const registryDir = path.join(root, "registry");
    const stateDir = path.join(root, "state");
    const configDir = path.join(root, "config");
    writePluginConfig(configDir, registryDir);
    const record = { case: "002", registrations: [], app: null, cleanup: {}, commands: [] };
    let endpoint = null;
    try {
      endpoint = await startEndpoint(root, "endpoint-a");
      const env = pluginEnv(endpoint, stateDir, configDir);
      let watching = true;
      let parseError = null;
      const watcher = (async () => {
        while (watching) {
          if (fs.existsSync(registryDir)) {
            for (const name of fs.readdirSync(registryDir)
              .filter((item) => item.endsWith(".json") && !item.startsWith("."))) {
              try {
                JSON.parse(fs.readFileSync(path.join(registryDir, name), "utf8"));
              } catch (error) {
                parseError = error;
              }
            }
          }
          await pause(2);
        }
      })();
      const concurrent = await Promise.all(Array.from({ length: 4 }, () => endpoint.request(env)));
      watching = false;
      await watcher;
      assert.equal(parseError, null, "registry 原子文件在并发写入期间必须可读");
      assert.ok(concurrent.every((item) => item.code === 0));
      const parsed = concurrent.map((item) => JSON.parse(item.stdout));
      assert.equal(new Set(parsed.map((item) => item.instanceId)).size, 1);
      assert.equal(new Set(parsed.map((item) => item.runId)).size, 1);
      const namespaces = fs.readdirSync(stateDir).filter((name) => name === "install.json");
      assert.equal(namespaces.length, 1);
      const initial = readRegistryFiles(registryDir);
      assert.equal(initial.length, 1);
      const initialRecord = initial[0].record;
      assert.equal(initialRecord.observedServerPid, endpoint.pid);

      const oldPid = endpoint.pid;
      const stopOld = await endpoint.stop();
      endpoint = null;
      const missing = readHerdrRegistry({ registryDir });
      assert.equal(missing.registrations[0].endpoint, "missing");
      assert.equal(missing.registrations[0].connectable, false);
      assert.equal(Object.prototype.hasOwnProperty.call(missing.registrations[0], "online"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(missing.registrations[0], "stopped"), false);

      endpoint = await startEndpoint(root, "endpoint-a");
      const replaced = readHerdrRegistry({ registryDir });
      assert.equal(replaced.registrations[0].endpoint, "replaced");
      assert.equal(replaced.registrations[0].connectable, false);
      const second = await endpoint.request(env);
      assert.equal(second.code, 0, second.stderr);
      const current = readRegistryFiles(registryDir)[0].record;
      assert.equal(current.instanceId, initialRecord.instanceId);
      assert.notEqual(current.runId, initialRecord.runId);
      assert.equal(current.observedServerPid, endpoint.pid);
      assert.notEqual(current.observedServerPid, oldPid);
      assert.equal(readHerdrRegistry({ registryDir }).registrations[0].endpoint, "matches");

      fs.writeFileSync(path.join(stateDir, "install.json"), "{broken");
      const corrupt = await endpoint.request(env);
      assert.notEqual(corrupt.code, 0);
      assert.match(corrupt.stderr, /namespace/);
      assert.equal(readRegistryFiles(registryDir)[0].record.runId, current.runId);

      fs.writeFileSync(path.join(registryDir, "bad.json"), "{\"schemaVersion\":1,");
      fs.writeFileSync(path.join(registryDir, "oversized.json"), "x".repeat(64 * 1024 + 1));
      fs.writeFileSync(path.join(registryDir, "wrong.json"), JSON.stringify({ schemaVersion: 99 }));
      fs.writeFileSync(path.join(registryDir, "mismatch.json"), JSON.stringify({
        ...current,
        instanceId: "inst-mismatch",
      }));
      const app = readHerdrRegistry({ registryDir });
      assert.equal(app.found, true);
      assert.equal(app.registrations.length, 1);
      assert.ok(app.diagnostics.length >= 4);
      assert.equal(app.registrations[0].runId, current.runId);
      assert.equal(app.registrations[0].endpoint, "matches");
      record.initial = initialRecord;
      record.current = current;
      record.concurrent = parsed;
      record.app = app;
      record.cleanup.stopOld = stopOld;
      record.cleanup.endpoint = await endpoint.stop();
      endpoint = null;
    } catch (error) {
      record.error = { code: error.code || null, message: error.message };
      throw error;
    } finally {
      if (endpoint) {
        try {
          record.cleanup.endpoint = await endpoint.stop();
        } catch {
          // 保留原始失败。
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      record.cleanup.tempRootRemoved = !fs.existsSync(root);
      record.evidence = saveEvidence("002", record, [root]);
    }
  });

  test("POL-REGISTER-003 真实隔离 Herdr：首次action、重启startup与两server并存", {
    timeout: 40000,
    skip: SKIP_LIVE,
  }, async () => {
    const root = tempRoot();
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
    fs.writeFileSync(env.HERDR_CONFIG_PATH, ISOLATED_CONFIG);
    const registryDir = path.join(root, "registry");
    const record = { case: "003", commands: [], app: null, cleanup: {} };
    let a = null;
    let b = null;
    let a2 = null;
    try {
      a = startHerdr(env, "a", null, record.commands);
      b = startHerdr(env, "b", null, record.commands);
      await Promise.all([waitHerdr(a, env, record.commands), waitHerdr(b, env, record.commands)]);
      herdrCli(a, env, ["plugin", "link", PLUGIN_DIR, "--enabled"], record.commands);
      await waitFor(
        () => pluginsOf(JSON.parse(
          herdrCli(b, env, ["plugin", "list", "--json"], record.commands),
        )).includes(PLUGIN_ID),
        5000,
        "plugin visible b",
      );
      const configDir = herdrCli(a, env, ["plugin", "config-dir", PLUGIN_ID], record.commands).trim();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
      herdrCli(a, env, ["workspace", "create", "--cwd", root, "--label", "registration-a", "--focus"], record.commands);
      herdrCli(b, env, ["workspace", "create", "--cwd", root, "--label", "registration-b", "--focus"], record.commands);
      assert.equal(readHerdrRegistry({ registryDir }).found, false, "link 不应触发 startup/登记");

      herdrCli(a, env, ["plugin", "action", "invoke", ACTION_ID], record.commands);
      const firstA = await waitFor(
        () => readHerdrRegistry({ registryDir }).registrations.find(
          (item) => sameSocketPath(item.socket.path, a.socket),
        ),
        5000,
        "A first action registration",
      );
      assert.equal(firstA.observedServerPid, a.pid);
      assert.equal(firstA.endpoint, "matches");
      assert.equal(firstA.connectable, true);
      assert.equal(Object.prototype.hasOwnProperty.call(firstA, "online"), false);

      await pause(30);
      herdrCli(a, env, ["plugin", "action", "invoke", ACTION_ID], record.commands);
      await pause(250);
      const againA = readHerdrRegistry({ registryDir }).registrations.find(
        (item) => item.instanceId === firstA.instanceId,
      );
      assert.equal(againA.runId, firstA.runId);
      assert.equal(againA.observedServerPid, a.pid);
      const oldA = firstA;
      const oldASession = a.session;

      const stoppedA = await stopHerdr(a, env, record.commands);
      a = null;
      const missing = readHerdrRegistry({ registryDir }).registrations.find(
        (item) => item.instanceId === oldA.instanceId,
      );
      assert.equal(missing.endpoint, "missing");
      assert.equal(missing.connectable, false);
      assert.equal(Object.prototype.hasOwnProperty.call(missing, "online"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(missing, "stopped"), false);

      a2 = startHerdr(env, "a", oldASession, record.commands);
      await waitHerdr(a2, env, record.commands);
      const startupA = await waitFor(
        () => readHerdrRegistry({ registryDir }).registrations.find(
          (item) => item.instanceId === oldA.instanceId
            && item.runId !== oldA.runId
            && item.observedServerPid === a2.pid,
        ),
        5000,
        "A startup registration",
      );
      assert.equal(startupA.instanceId, oldA.instanceId);
      assert.notEqual(startupA.runId, oldA.runId);
      assert.equal(startupA.endpoint, "matches");

      herdrCli(b, env, ["plugin", "action", "invoke", ACTION_ID], record.commands);
      const firstB = await waitFor(
        () => readHerdrRegistry({ registryDir }).registrations.find(
          (item) => sameSocketPath(item.socket.path, b.socket),
        ),
        5000,
        "B action registration",
      );
      assert.equal(firstB.observedServerPid, b.pid);
      assert.notEqual(firstB.instanceId, oldA.instanceId);

      const app = readHerdrRegistry({ registryDir });
      assert.equal(app.registrations.length, 2);
      assert.equal(app.diagnostics.length, 0);
      for (const item of app.registrations) {
        assert.equal(item.endpoint, "matches");
        assert.equal(item.connectable, true);
        assert.equal(Object.prototype.hasOwnProperty.call(item, "online"), false);
      }
      const currentA = app.registrations.find((item) => item.instanceId === oldA.instanceId);
      const transport = createHerdrTransport({ socketPath: currentA.socket.path });
      const pong = await transport.request("ping", {});
      transport.dispose();
      assert.deepEqual([pong.type, pong.version, pong.protocol], ["pong", "0.9.5", 22]);

      record.registrations = readRegistryFiles(registryDir).map((item) => item.record);
      record.firstA = firstA;
      record.againA = againA;
      record.oldA = oldA;
      record.stoppedA = stoppedA;
      record.startupA = startupA;
      record.firstB = firstB;
      record.app = app;
      record.ping = { type: pong.type, version: pong.version, protocol: pong.protocol };
      record.cleanup.b = await stopHerdr(b, env, record.commands);
      b = null;
      record.cleanup.a = await stopHerdr(a2, env, record.commands);
      a2 = null;
    } catch (error) {
      record.error = { code: error.code || null, message: error.message };
      throw error;
    } finally {
      for (const server of [a2, b, a]) {
        if (server) {
          try {
            record.cleanup[`${server.key}-${server.session}`] = await stopHerdr(
              server, env, record.commands,
            );
          } catch {
            // 保留原始失败。
          }
        }
      }
      try {
        record.registryFiles = readRegistryFiles(registryDir);
      } catch {
        record.registryFiles = [];
      }
      fs.rmSync(root, { recursive: true, force: true });
      record.cleanup.tempRootRemoved = !fs.existsSync(root);
      record.evidence = saveEvidence("003", record, [root]);
    }
  });

  test("POL-REGISTER-004 元数据不一致拒绝与100记录读取上限", { timeout: 25000 }, async () => {
    const root = tempRoot();
    const registryDir = path.join(root, "registry");
    const stateDir = path.join(root, "state");
    const configDir = path.join(root, "config");
    writePluginConfig(configDir, registryDir);
    const record = { case: "004", cleanup: {}, mutations: [] };
    const endpoints = [];
    try {
      const a = await startEndpoint(root, "endpoint-a");
      const b = await startEndpoint(root, "endpoint-b");
      endpoints.push(a, b);
      const regA = await a.request(pluginEnv(a, stateDir, configDir));
      const regB = await b.request(pluginEnv(b, stateDir, configDir));
      assert.equal(regA.code, 0, regA.stderr);
      assert.equal(regB.code, 0, regB.stderr);
      const files = readRegistryFiles(registryDir);
      assert.equal(files.length, 2);
      const byInstance = Object.fromEntries(files.map((item) => [item.record.instanceId, item.record]));
      const recA = byInstance[JSON.parse(regA.stdout).instanceId];
      const recB = byInstance[JSON.parse(regB.stdout).instanceId];
      assert.ok(recA && recB);
      const aFile = `${recA.instanceId}.json`;
      const writeRecord = (name, item) => fs.writeFileSync(
        path.join(registryDir, name), JSON.stringify(item),
      );
      const readApp = () => readHerdrRegistry({ registryDir });
      const reject = (mutated, fileName = aFile) => {
        if (fileName !== aFile) fs.rmSync(path.join(registryDir, aFile), { force: true });
        writeRecord(fileName, mutated);
        const app = readApp();
        assert.equal(app.registrations.length, 1);
        assert.equal(app.registrations[0].instanceId, recB.instanceId);
        assert.equal(app.registrations[0].endpoint, "matches");
        assert.ok(app.diagnostics.some(
          (item) => item.file === fileName && item.code === "INVALID_RECORD",
        ));
        fs.rmSync(path.join(registryDir, fileName), { force: true });
        writeRecord(aFile, recA);
        return app;
      };
      const valid = readApp();
      assert.equal(valid.registrations.length, 2);
      assert.equal(valid.diagnostics.length, 0);
      const mutations = [
        ["runId", { ...recA, runId: `run-${"0".repeat(32)}` }, aFile],
        ["observedServerPid", { ...recA, observedServerPid: recA.observedServerPid + 1 }, aFile],
        ["instanceId", { ...recA, instanceId: `inst-${"f".repeat(32)}` }, `inst-${"f".repeat(32)}.json`],
        ["pluginId", { ...recA, pluginId: "other.plugin" }, aFile],
      ];
      for (const [label, mutated, fileName] of mutations) {
        const app = reject(mutated, fileName);
        record.mutations.push({ label, registrations: app.registrations.length });
      }
      for (let index = 0; index < 99; index += 1) {
        writeRecord(`zz-extra-${String(index).padStart(3, "0")}.json`, {});
      }
      const limited = readApp();
      assert.equal(limited.truncated, true);
      assert.ok(limited.diagnostics.some((item) => item.code === "TOO_MANY_FILES"));
      assert.equal(limited.registrations.length, 2);
      assert.equal(
        limited.registrations.length + limited.diagnostics.filter((item) => item.file).length,
        100,
      );
      record.valid = valid;
      record.limited = {
        registrations: limited.registrations.length,
        truncated: limited.truncated,
        diagnostics: limited.diagnostics.map((item) => item.code),
      };
      record.registryFiles = readRegistryFiles(registryDir).map((item) => item.record);
      record.cleanup.endpoints = [await a.stop(), await b.stop()];
      endpoints.length = 0;
    } catch (error) {
      record.error = { code: error.code || null, message: error.message };
      throw error;
    } finally {
      for (const endpoint of endpoints) {
        try {
          record.cleanup[endpoint.socketPath] = await endpoint.stop();
        } catch {
          // 保留原始失败。
        }
      }
      try {
        record.registryFiles = readRegistryFiles(registryDir);
      } catch {
        record.registryFiles = [];
      }
      fs.rmSync(root, { recursive: true, force: true });
      record.cleanup.tempRootRemoved = !fs.existsSync(root);
      record.evidence = saveEvidence("004", record, [root]);
    }
  });
}

if (process.argv[2] === "fixture-endpoint") {
  fixtureEndpoint(process.argv[3], process.argv[4]);
} else {
  defineTests();
}
