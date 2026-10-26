/* S05i 正式应用的 Herdr 连接管理验收。
   001 无来源启动；002 正式插件+隔离真实 Herdr 双向启动；003 两实例同名 Agent
   与持久停用/恢复（受控 Unix fixture）；004 真实 server stop/新 run 恢复；
   005 退出清理、IPC 校验与小窗口多 Agent。真实 Herdr 与 fixture 分开标注。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { startModelServer } = require("./fixture-server.cjs");
const { createStore } = require("../../app/store.cjs");
const { createLegacyDatabase, dbPath, localDay } = require("./s02-fixtures.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const HERDR = process.env.HERDR_BIN || "herdr";
const PLUGIN_DIR = path.join(repoRoot, "plugins", "herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const REGISTRY_NAME = "herdr-registry";
const SECRET_MEMORY = "CONNECTOR-MEMORY-BODY-MUST-NOT-LEAK";
const SECRET_CIPHER = "sk-connector-cipher-must-not-leak";
const SKIP_LIVE = process.env.HERDR_ENV === "1"
  ? "HERDR_ENV=1：不在 Herdr 会话外创建真实测试 server"
  : false;
const EVIDENCE_ROOT = path.join(
  repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s05i-connections-ui",
);
const BATCH = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${
  crypto.randomBytes(3).toString("hex")}`;
const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, `run-${BATCH}`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH}`,
    `created: ${new Date().toISOString()}`,
    `source: tests/acceptance/connector-ui.spec.cjs`,
    `evidence: ${EVIDENCE_DIR}`,
    "note: 001/003/005 使用受控真实 Unix 协议 fixture；002/004 使用具名隔离真实 Herdr。",
    "",
  ].join("\n"),
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

function tempRoot(tag) {
  return fs.mkdtempSync(`/tmp/bayper-connector-${tag}-`);
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-connector-home-"));
  for (const key of [".config", ".local/share", "Library/Application Support"]) {
    fs.mkdirSync(path.join(home, key), { recursive: true });
  }
  return home;
}

function makeDataDir(baseUrl = "https://127.0.0.1:1/v1") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-connector-data-"));
  createLegacyDatabase(dataDir, {
    characters: [{ id: "rin", acceptedAt: "2026-10-01T00:00:00.000Z" }],
    modelCipher: Buffer.from(SECRET_CIPHER),
    baseUrl,
    modelName: "connector-fixture",
    fixedId: "rin",
    currentId: "rin",
    rosterDay: localDay(new Date()),
  });
  return dataDir;
}

function seedMemory(dataDir) {
  const store = createStore(dataDir);
  try {
    store.memory.remember({
      characterId: "rin",
      factKey: "connector.secret.body",
      body: SECRET_MEMORY,
      kind: "preference",
      sourceId: "seed:s05i",
    });
  } finally {
    store.close();
  }
}

function registryDirOf(dataDir) {
  return path.join(dataDir, REGISTRY_NAME);
}

function queryDb(dataDir, sql, params = []) {
  const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function countEvents(dataDir, instanceId, kind, runId = null) {
  const rows = runId
    ? queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE instance_id = ? AND kind = ? AND run_id = ?
    `, [instanceId, kind, runId])
    : queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events WHERE instance_id = ? AND kind = ?
    `, [instanceId, kind]);
  return rows[0].count;
}

function readRegistryDir(registryDir) {
  if (!fs.existsSync(registryDir)) return [];
  return fs.readdirSync(registryDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(registryDir, name), "utf8"))];
      } catch {
        return [];
      }
    });
}

async function launchApp(dataDir, home, trace, logs) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
    },
  });
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  page.on("console", (message) => trace.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => trace.push(`[pageerror] ${error?.stack || error}`));
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  return { app, page, logs, trace };
}

async function closeApp(app, timeout = 12000) {
  if (!app) return { status: "no-app", code: null, signal: null };
  const processHandle = app.process?.();
  let timedOut = false;
  let timer;
  try {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    processHandle?.kill("SIGKILL");
    throw new Error(`应用未在 ${timeout}ms 内退出`);
  }
  const exit = {
    status: "exited",
    code: processHandle?.exitCode ?? null,
    signal: processHandle?.signalCode ?? null,
  };
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    try {
      process.kill(processHandle.pid, 0);
      processHandle.kill("SIGKILL");
      throw new Error("app.close 返回但应用进程仍存活");
    } catch (error) {
      if (error.message === "app.close 返回但应用进程仍存活") throw error;
    }
  }
  return exit;
}

async function setWindowSize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    win?.setSize(size.width, size.height);
  }, { width, height });
  await delay(220);
}

async function openConnectorTab(page) {
  await page.bringToFront().catch(() => {});
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-page="settings"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-settings-tab="connectors"]').click();
  await page.locator('[data-settings-panel="connectors"]').waitFor({
    state: "visible", timeout: 10000,
  });
  await page.waitForFunction(() => {
    const summary = document.querySelector("#connector-summary");
    return summary?.textContent && !summary.textContent.includes("正在读取");
  }, null, { timeout: 10000 });
}

function rowSelector(instanceId) {
  return `#connector-list .connector-row[data-instance-id="${instanceId}"]`;
}

async function waitRowStatus(page, instanceId, status, timeout = 20000) {
  await page.locator(rowSelector(instanceId)).waitFor({ state: "visible", timeout });
  await page.waitForFunction(({ selector, expected }) => (
    document.querySelector(selector)?.dataset.status === expected
  ), { selector: rowSelector(instanceId), expected: status }, { timeout });
}

async function connectorState(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot.connectors;
}

async function capture(page, name) {
  const file = path.join(EVIDENCE_DIR, `${name}-${BATCH}.png`);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(180);
  await page.screenshot({ path: file });
  return file;
}

async function captureFailure(page, name) {
  if (!page) return null;
  try {
    return await capture(page, `${name}-failure`);
  } catch {
    return null;
  }
}

function writeCaseLog(name, data) {
  const lines = [
    `# ${name}`,
    `batch: ${BATCH}`,
    `time: ${new Date().toISOString()}`,
    `failure: ${data.failure ? data.failure.stack || data.failure.message : "none"}`,
    `appExit: ${JSON.stringify(data.appExits ?? [])}`,
    `cleanup: ${data.cleanupErrors?.length ? "failed" : "ok"}`,
    ...(data.cleanupErrors ?? []).map(
      (error, index) => `  cleanup-${index + 1}: ${error?.stack || error?.message || error}`,
    ),
    `screenshots: ${JSON.stringify(data.screenshots ?? [])}`,
    `details: ${JSON.stringify(data.details ?? {}, null, 2)}`,
    "",
    "## renderer console",
    ...(data.trace ?? []),
    "",
    "## application stdout/stderr",
    ...(data.logs ?? []),
    "",
    "## boundary",
    data.boundary ?? "",
    "",
  ];
  const file = path.join(EVIDENCE_DIR, `${name}-${BATCH}.log`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

function finishResources(paths, cleanupErrors) {
  for (const target of paths) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (fs.existsSync(target)) throw new Error(`临时目录未清理：${target}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

function manyAgentSnapshot(count, state = "working") {
  const panes = [];
  const agents = [];
  for (let index = 0; index < count; index += 1) {
    const paneId = `pane-${String(index).padStart(3, "0")}`;
    const terminalId = `term-${String(index).padStart(3, "0")}`;
    const label = `Agent ${String(index + 1).padStart(2, "0")}`;
    panes.push({
      pane_id: paneId, terminal_id: terminalId, workspace_id: "ws-1", tab_id: "tab-1",
      label, focused: index === 0, agent_status: state, revision: 1,
    });
    agents.push({
      terminal_id: terminalId, pane_id: paneId, workspace_id: "ws-1", tab_id: "tab-1",
      agent_status: state, state_change_seq: 1, completion_seq: null,
      name: label, display_agent: "fixture", focused: index === 0, revision: 1,
    });
  }
  return {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "ws-1", number: 1, label: "工作区", focused: true }],
    tabs: [{
      tab_id: "tab-1", workspace_id: "ws-1", number: 1, label: "标签",
      focused: true, pane_count: count, agent_status: state,
    }],
    panes, layouts: [], agents,
  };
}

/* 受控真实 Unix 协议 fixture：只实现 adapter 需要的 ping/snapshot/subscription。 */
function createProtocolServer(root, name, snapshot) {
  const socketPath = path.join(root, `${name}.sock`);
  const state = {
    socketPath, snapshot, requests: [], snapshotCount: 0, subscribeCount: 0,
    sockets: new Set(), subscriptions: new Set(), server: null,
  };
  function write(socket, message) {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      // 连接已由测试主动关闭。
    }
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
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (message.method === "events.subscribe") {
          subscription = { socket, subscriptions: message.params?.subscriptions ?? [] };
          state.subscriptions.add(subscription);
          state.subscribeCount += 1;
          write(socket, { id: message.id, result: { type: "subscription_started" } });
          continue;
        }
        if (typeof message.method !== "string") continue;
        state.requests.push(message.method);
        if (message.method === "ping") {
          write(socket, {
            id: message.id, result: { type: "pong", version: "0.9.5", protocol: 22 },
          });
          socket.end();
          continue;
        }
        if (message.method === "session.snapshot") {
          state.snapshotCount += 1;
          write(socket, {
            id: message.id, result: { type: "session_snapshot", snapshot: state.snapshot },
          });
          socket.end();
          continue;
        }
        socket.destroy();
      }
    });
  }
  return {
    state,
    socketPath,
    requestCount() {
      return state.requests.length;
    },
    async start() {
      try { fs.unlinkSync(socketPath); } catch { /* 不存在。 */ }
      state.server = net.createServer(handle);
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
      if (server) await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* 已移除。 */ }
    },
  };
}

function registerFixture(socketPath, registryDir, root, name) {
  const stateDir = path.join(root, `plugin-${name}-state`);
  const configDir = path.join(root, `plugin-${name}-config`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
  const output = execFileSync(process.execPath, [path.join(PLUGIN_DIR, "register.cjs")], {
    env: {
      ...process.env,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    },
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  const result = JSON.parse(output.split("\n").pop());
  return JSON.parse(fs.readFileSync(result.registry, "utf8"));
}

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

function realCli(ctx, args) {
  return execFileSync(HERDR, ["--session", ctx.session, ...args], {
    env: ctx.env, encoding: "utf8", timeout: 10000,
  });
}

async function startRealServer(root, requestedSession = null) {
  if (process.env.HERDR_ENV === "1") throw new Error("HERDR_ENV=1：拒绝创建测试 server");
  const session = requestedSession ?? `bc-${crypto.randomBytes(3).toString("hex")}`;
  const env = realEnv(root, session);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(env.HERDR_CONFIG_PATH, [
    "onboarding = false",
    "[terminal]",
    'default_shell = "/bin/sh"',
    'shell_mode = "non_login"',
    "[update]",
    "version_check = false",
    "manifest_check = false",
    "[ui.sound]",
    "enabled = false",
    "[ui.toast]",
    'delivery = "off"',
    "[session]",
    "resume_agents_on_restore = false",
    "",
  ].join("\n"));
  const version = execFileSync(HERDR, ["--version"], { env, encoding: "utf8" }).trim();
  assert.match(version, /^herdr 0\.9\.5\b/);
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
    try {
      return JSON.parse(execFileSync(
        HERDR, ["--session", session, "status", "server", "--json"],
        { env, encoding: "utf8", timeout: 3000 },
      ));
    } catch {
      return null;
    }
  }, 10000, "real server status");
  return {
    root, session, env, child, socketPath: status.socket, version: status.version,
    stderr: () => stderr,
  };
}

async function stopRealServer(ctx) {
  if (!ctx) return { ok: true, skipped: true };
  const cleanup = { pid: ctx.child.pid, exited: false, socketRemoved: false, forcedKill: false };
  if (ctx.child.exitCode === null && ctx.child.signalCode === null) {
    try {
      execFileSync(HERDR, ["--session", ctx.session, "server", "stop"], {
        env: ctx.env, encoding: "utf8", timeout: 10000,
      });
    } catch {
      // 下方以进程/ socket 事实判定。
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
  cleanup.signal = ctx.child.signalCode;
  await waitFor(() => !fs.existsSync(ctx.socketPath), 5000, "real socket removal").catch(() => {});
  cleanup.socketRemoved = !fs.existsSync(ctx.socketPath);
  cleanup.ok = cleanup.exited && cleanup.socketRemoved;
  return cleanup;
}

function setupRealPlugin(ctx, registryDir) {
  try {
    realCli(ctx, ["plugin", "link", PLUGIN_DIR, "--enabled"]);
  } catch (error) {
    if (!/already|linked|enabled/i.test(String(error.message))) throw error;
  }
  const configDir = realCli(ctx, ["plugin", "config-dir", PLUGIN_ID]).trim();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
  return configDir;
}

function createRealAgent(ctx, workspaceLabel, agentName, state = "working") {
  const created = JSON.parse(realCli(ctx, [
    "workspace", "create", "--cwd", ctx.root, "--label", workspaceLabel, "--focus",
  ]));
  const paneId = created.result.root_pane.pane_id;
  realCli(ctx, ["pane", "run", paneId, "sleep", "300"]);
  realCli(ctx, [
    "pane", "report-agent", paneId, "--source", "bayper-connector-fixture",
    "--agent", agentName, "--state", state, "--seq", "1",
  ]);
  return paneId;
}

async function waitRealRegistration(registryDir, pid, previousRunId = null) {
  return waitFor(() => {
    const record = readRegistryDir(registryDir).find(
      (item) => item.observedServerPid === pid && item.runId !== previousRunId,
    );
    return record || null;
  }, 10000, "real plugin registration");
}

async function assertNoSecretLeak(page) {
  const state = await connectorState(page);
  const text = await page.locator("#connector-settings").innerText();
  const serialized = JSON.stringify(state);
  for (const secret of [SECRET_MEMORY, SECRET_CIPHER]) {
    assert.equal(serialized.includes(secret), false, `连接器状态不得包含 ${secret}`);
    assert.equal(text.includes(secret), false, `连接器 UI 不得包含 ${secret}`);
  }
  for (const forbidden of ["api_key_cipher", "socketPath", "runId", "apiKey", "body"]) {
    assert.equal(serialized.includes(forbidden), false, `连接器状态不得暴露 ${forbidden}`);
  }
}

test("POL-CONNECTOR-UI-001 无来源启动、未关联与不调用模型", { timeout: 60000 }, async () => {
  const details = {};
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  let launched = null;
  let modelServer = null;
  const home = makeHome();
  let dataDir = null;
  try {
    modelServer = await startModelServer();
    dataDir = makeDataDir(modelServer.baseUrl);
    seedMemory(dataDir);
    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await launched.page.locator("#connector-empty").waitFor({ state: "visible", timeout: 10000 });
    assert.match(await launched.page.locator("#connector-empty").innerText(), /尚未关联/);
    const state = await connectorState(launched.page);
    assert.equal(state.instances.length, 0);
    assert.equal(state.registryPath, registryDirOf(dataDir));
    assert.equal(state.registryFound, false);
    await delay(6200);
    assert.equal(modelServer.allRequests.length, 0, "连接器状态不得调用模型 API");
    await assertNoSecretLeak(launched.page);
    details.registryPath = state.registryPath;
    details.instanceCount = state.instances.length;
    details.modelRequests = modelServer.allRequests.length;
    screenshots.push(await capture(launched.page, "001-unassociated"));
  } catch (error) {
    failure = error;
    const shot = await captureFailure(launched?.page, "001");
    if (shot) screenshots.push(shot);
  } finally {
    try {
      appExits.push(await closeApp(launched?.app));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await modelServer?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    finishResources([dataDir, home], cleanupErrors);
    writeCaseLog("001-no-herdr", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "未启动 Herdr/插件；model fixture 记录到的请求数为 0。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("POL-CONNECTOR-UI-002 正式插件与真实 Herdr 双向启动、逐 Agent 在线", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const details = { phases: [] };
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  let activePage = null;
  const roots = [];
  const dataDirs = [];
  const homes = [];
  const servers = [];
  try {
    for (const phase of ["herdr-first", "bayper-first"]) {
      const root = tempRoot(phase === "herdr-first" ? "c2a" : "c2b");
      roots.push(root);
      const dataDir = makeDataDir();
      dataDirs.push(dataDir);
      const home = makeHome();
      homes.push(home);
      const registryDir = registryDirOf(dataDir);
      const phaseDetail = { phase };
      details.phases.push(phaseDetail);
      let launched = null;
      let server = null;
      try {
        if (phase === "herdr-first") {
          server = await startRealServer(root);
          servers.push(server);
          setupRealPlugin(server, registryDir);
          createRealAgent(server, `connector-002-${phase}`, "真实 Agent");
          realCli(server, ["plugin", "action", "invoke", ACTION_ID]);
          const registration = await waitRealRegistration(registryDir, server.child.pid);
          phaseDetail.registration = registration.runId;
          launched = await launchApp(dataDir, home, trace, logs);
        } else {
          launched = await launchApp(dataDir, home, trace, logs);
          activePage = launched.page;
          await openConnectorTab(launched.page);
          await launched.page.locator("#connector-empty").waitFor({
            state: "visible", timeout: 10000,
          });
          assert.match(await launched.page.locator("#connector-empty").innerText(), /尚未关联/);
          server = await startRealServer(root);
          servers.push(server);
          setupRealPlugin(server, registryDir);
          createRealAgent(server, `connector-002-${phase}`, "后来 Agent");
          realCli(server, ["plugin", "action", "invoke", ACTION_ID]);
          const registration = await waitRealRegistration(registryDir, server.child.pid);
          phaseDetail.registration = registration.runId;
        }
        activePage = launched.page;
        await openConnectorTab(launched.page);
        const record = readRegistryDir(registryDir).find(
          (item) => item.observedServerPid === server.child.pid,
        );
        assert.ok(record, "应有正式插件登记");
        await waitRowStatus(launched.page, record.instanceId, "online", 25000);
        const row = launched.page.locator(rowSelector(record.instanceId));
        await launched.page.waitForFunction((selector) => (
          /工作中/.test(document.querySelector(selector)?.innerText || "")
        ), rowSelector(record.instanceId), { timeout: 15000 });
        assert.match(await row.innerText(), /真实 Agent|后来 Agent/);
        assert.match(await row.innerText(), /工作中/);
        await delay(6200);
        await waitRowStatus(launched.page, record.instanceId, "online", 5000);
        assert.equal(countEvents(dataDir, record.instanceId, "online"), 1);
        Object.assign(phaseDetail, {
          instanceId: record.instanceId,
          runId: record.runId,
          onlineEvents: countEvents(dataDir, record.instanceId, "online"),
          ui: (await row.innerText()).slice(0, 300),
        });
        screenshots.push(await capture(launched.page, `002-${phase}-online`));
      } finally {
        try {
          appExits.push(await closeApp(launched?.app));
        } catch (error) {
          cleanupErrors.push(error);
        }
        activePage = null;
        const stopped = await stopRealServer(server);
        if (!stopped.ok) cleanupErrors.push(new Error(`真实 server 清理失败：${JSON.stringify(stopped)}`));
      }
    }
  } catch (error) {
    failure = error;
    const shot = await captureFailure(activePage, "002");
    if (shot) screenshots.push(shot);
  } finally {
    for (const pathTarget of [...dataDirs, ...homes, ...roots]) {
      finishResources([pathTarget], cleanupErrors);
    }
    writeCaseLog("002-real-bidirectional", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "真实 herdr 0.9.5、随机 session、隔离 XDG；插件通过正式 link/action 登记。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("POL-CONNECTOR-UI-003 两实例同名 Agent、停用持久与明确恢复", { timeout: 90000 }, async () => {
  const details = {};
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  const root = tempRoot("003");
  const dataDir = makeDataDir();
  const home = makeHome();
  let serverA = null;
  let serverB = null;
  let launched = null;
  try {
    const registryDir = registryDirOf(dataDir);
    serverA = createProtocolServer(root, "instance-a", manyAgentSnapshot(1));
    serverB = createProtocolServer(root, "instance-b", manyAgentSnapshot(1));
    await serverA.start();
    await serverB.start();
    const recordA = registerFixture(serverA.socketPath, registryDir, root, "a");
    const recordB = registerFixture(serverB.socketPath, registryDir, root, "b");
    assert.notEqual(recordA.instanceId, recordB.instanceId);

    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await waitRowStatus(launched.page, recordA.instanceId, "online");
    await waitRowStatus(launched.page, recordB.instanceId, "online");
    assert.match(await launched.page.locator(rowSelector(recordA.instanceId)).innerText(), /Agent 01/);
    assert.match(await launched.page.locator(rowSelector(recordB.instanceId)).innerText(), /Agent 01/);
    screenshots.push(await capture(launched.page, "003-two-independent-online"));

    await launched.page.locator(rowSelector(recordA.instanceId))
      .locator('button[data-connector-action="disable"]').click();
    await waitRowStatus(launched.page, recordA.instanceId, "disabled", 10000);
    await launched.page.evaluate(() => console.info("S05i-003-disable-clicked"));
    assert.equal(queryDb(
      dataDir, "SELECT disabled FROM connector_instances WHERE instance_id = ?", [recordA.instanceId],
    )[0].disabled, 1);
    await waitRowStatus(launched.page, recordB.instanceId, "online", 5000);
    screenshots.push(await capture(launched.page, "003-disabled-other-online"));

    appExits.push(await closeApp(launched.app));
    launched = null;
    assert.ok(
      trace.some((line) => line.includes("S05i-003-disable-clicked")),
      "关闭后应保留操作期间的 renderer console",
    );
    await waitFor(() => serverA.state.sockets.size === 0 && serverB.state.sockets.size === 0,
      5000, "first app sockets cleanup");

    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await waitRowStatus(launched.page, recordA.instanceId, "disabled");
    await waitRowStatus(launched.page, recordB.instanceId, "online");
    const requestsB = serverB.requestCount();
    assert.ok(requestsB > 0, "未停用实例在重启后应继续连接");
    const requestsABeforeRestore = serverA.requestCount();
    await launched.page.locator(rowSelector(recordA.instanceId))
      .locator('button[data-connector-action="enable"]').click();
    await waitRowStatus(launched.page, recordA.instanceId, "online", 15000);
    assert.ok(serverA.requestCount() > requestsABeforeRestore, "恢复后应真实重连");
    await waitRowStatus(launched.page, recordB.instanceId, "online", 5000);
    assert.equal(queryDb(
      dataDir, "SELECT disabled FROM connector_instances WHERE instance_id = ?", [recordA.instanceId],
    )[0].disabled, 0);
    details.recordA = recordA.instanceId;
    details.recordB = recordB.instanceId;
    details.requestsBAfterRestart = requestsB;
    screenshots.push(await capture(launched.page, "003-restored-online"));
  } catch (error) {
    failure = error;
    const shot = await captureFailure(launched?.page, "003");
    if (shot) screenshots.push(shot);
  } finally {
    try {
      appExits.push(await closeApp(launched?.app));
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const server of [serverA, serverB]) {
      try {
        await server?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    finishResources([root, dataDir, home], cleanupErrors);
    writeCaseLog("003-two-instances-disable", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "两个受控真实 Unix 协议 fixture 由正式 register.cjs 登记；非真实 Herdr。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("POL-CONNECTOR-UI-004 真实 server stop 下线、Agent unknown 与新 run 自动恢复", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const details = {};
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  const root = tempRoot("004");
  const dataDir = makeDataDir();
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  let server = null;
  let launched = null;
  try {
    server = await startRealServer(root);
    const session = server.session;
    setupRealPlugin(server, registryDir);
    createRealAgent(server, "connector-004", "真实旧 Agent");
    realCli(server, ["plugin", "action", "invoke", ACTION_ID]);
    const oldRecord = await waitRealRegistration(registryDir, server.child.pid);
    details.oldRunId = oldRecord.runId;

    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await waitRowStatus(launched.page, oldRecord.instanceId, "online", 30000);
    screenshots.push(await capture(launched.page, "004-before-stop-online"));

    const stopped = await stopRealServer(server);
    if (!stopped.ok) throw new Error(`真实 server stop 未完成：${JSON.stringify(stopped)}`);
    server = null;
    await waitRowStatus(launched.page, oldRecord.instanceId, "offline", 30000);
    const offlineText = await launched.page.locator(rowSelector(oldRecord.instanceId)).innerText();
    assert.match(offlineText, /未知/, "下线后 Agent 必须明确显示未知");
    assert.equal(countEvents(dataDir, oldRecord.instanceId, "offline"), 1);
    const agents = queryDb(dataDir, `
      SELECT effective_state FROM connector_agents
      WHERE instance_id = ? AND run_id = ?
    `, [oldRecord.instanceId, oldRecord.runId]);
    assert.ok(agents.length >= 1);
    assert.ok(agents.every((item) => item.effective_state === "unknown"));
    details.offlineEvents = countEvents(dataDir, oldRecord.instanceId, "offline");
    screenshots.push(await capture(launched.page, "004-offline-unknown"));

    server = await startRealServer(root, session);
    setupRealPlugin(server, registryDir);
    createRealAgent(server, "connector-004-restart", "真实新 Agent");
    realCli(server, ["plugin", "action", "invoke", ACTION_ID]);
    const newRecord = await waitRealRegistration(registryDir, server.child.pid, oldRecord.runId);
    assert.equal(newRecord.instanceId, oldRecord.instanceId, "同实例应恢复");
    assert.notEqual(newRecord.runId, oldRecord.runId, "新 server 应产生新 run");
    await waitRowStatus(launched.page, newRecord.instanceId, "online", 30000);
    const onlineText = await launched.page.locator(rowSelector(newRecord.instanceId)).innerText();
    assert.match(onlineText, /真实新 Agent/);
    assert.equal(countEvents(dataDir, oldRecord.instanceId, "offline"), 1);
    assert.equal(countEvents(dataDir, oldRecord.instanceId, "online", oldRecord.runId), 1);
    assert.equal(countEvents(dataDir, oldRecord.instanceId, "online", newRecord.runId), 1);
    details.newRunId = newRecord.runId;
    details.onlineNewRun = countEvents(dataDir, newRecord.instanceId, "online", newRecord.runId);
    screenshots.push(await capture(launched.page, "004-new-run-online"));
  } catch (error) {
    failure = error;
    const shot = await captureFailure(launched?.page, "004");
    if (shot) screenshots.push(shot);
  } finally {
    try {
      appExits.push(await closeApp(launched?.app));
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (server) {
      const stopped = await stopRealServer(server);
      if (!stopped.ok) cleanupErrors.push(new Error(`真实 server 清理失败：${JSON.stringify(stopped)}`));
    }
    finishResources([root, dataDir, home], cleanupErrors);
    writeCaseLog("004-real-stop-new-run", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "真实 herdr 0.9.5；停止/重启均通过正式 server 命令与插件 action，不重启 Bayper。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("POL-CONNECTOR-UI-005 退出清理、无效输入、无敏感状态与小窗口多 Agent", {
  timeout: 60000,
}, async () => {
  const details = {};
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  const root = tempRoot("005");
  const dataDir = makeDataDir();
  const home = makeHome();
  let server = null;
  let launched = null;
  try {
    seedMemory(dataDir);
    const snapshot = manyAgentSnapshot(80);
    snapshot.panes[0].agent_status = "done";
    snapshot.agents[0].agent_status = "done";
    server = createProtocolServer(root, "many", snapshot);
    await server.start();
    const record = registerFixture(server.socketPath, registryDirOf(dataDir), root, "many");
    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await waitRowStatus(launched.page, record.instanceId, "online", 20000);
    const finished = launched.page.locator(
      `${rowSelector(record.instanceId)} .connector-agent[data-state="finished"]`,
    );
    assert.equal(await finished.count(), 1);
    assert.match(await finished.innerText(), /已结束/);
    assert.equal((await finished.innerText()).includes("已完成"), false);
    await setWindowSize(launched.app, 960, 680);
    assert.equal(
      await launched.page.locator(rowSelector(record.instanceId)).locator(".connector-agent").count(),
      80,
    );
    const metrics = await launched.page.evaluate(() => {
      const settingsPage = document.querySelector('[data-page="settings"]');
      const panels = document.querySelector(".settings-panels");
      const scroll = document.querySelector(".connector-scroll");
      return {
        pageClientHeight: settingsPage.clientHeight,
        pageScrollHeight: settingsPage.scrollHeight,
        pageOverflowY: getComputedStyle(settingsPage).overflowY,
        panelsClientHeight: panels.clientHeight,
        panelsScrollHeight: panels.scrollHeight,
        scrollClientHeight: scroll.clientHeight,
        scrollScrollHeight: scroll.scrollHeight,
        scrollOverflowY: getComputedStyle(scroll).overflowY,
      };
    });
    assert.equal(metrics.pageOverflowY, "hidden");
    assert.ok(metrics.pageScrollHeight <= metrics.pageClientHeight + 1, JSON.stringify(metrics));
    assert.ok(metrics.panelsScrollHeight <= metrics.panelsClientHeight + 1, JSON.stringify(metrics));
    assert.equal(metrics.scrollOverflowY, "auto");
    assert.ok(metrics.scrollScrollHeight > metrics.scrollClientHeight, "多 Agent 应在局部滚动");
    details.metrics = metrics;
    screenshots.push(await capture(launched.page, "005-small-multi-agent"));

    const invalidPath = await launched.page.evaluate(
      () => window.bayperConnectors.setEnabled("../../etc/passwd", true),
    );
    assert.equal(invalidPath.ok, false);
    assert.equal(invalidPath.error.code, "INVALID_INPUT");
    const invalidFlag = await launched.page.evaluate(
      (instanceId) => window.bayperConnectors.setEnabled(instanceId, "true"),
      record.instanceId,
    );
    assert.equal(invalidFlag.ok, false);
    assert.equal(invalidFlag.error.code, "INVALID_INPUT");
    const unknown = await launched.page.evaluate(
      () => window.bayperConnectors.setEnabled(`inst-${"0".repeat(32)}`, false),
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "HERDR_RUNTIME_UNKNOWN_INSTANCE");
    await assertNoSecretLeak(launched.page);

    const clipboardBefore = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    await launched.page.locator("#connector-copy-path").click();
    await launched.page.waitForFunction(
      () => document.querySelector("#connector-status")?.textContent === "登记路径已复制。",
      null,
      { timeout: 5000 },
    );
    const copied = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copied, registryDirOf(dataDir));
    await launched.app.evaluate(({ clipboard }, prior) => clipboard.writeText(prior), clipboardBefore);

    appExits.push(await closeApp(launched.app));
    launched = null;
    await waitFor(() => server.state.sockets.size === 0, 5000, "退出后 socket 客户端清理");
    details.socketsAfterExit = server.state.sockets.size;
    details.subscriptionsAfterExit = server.state.subscriptions.size;
  } catch (error) {
    failure = error;
    const shot = await captureFailure(launched?.page, "005");
    if (shot) screenshots.push(shot);
  } finally {
    try {
      if (launched) appExits.push(await closeApp(launched.app));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await server?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    finishResources([root, dataDir, home], cleanupErrors);
    writeCaseLog("005-exit-input-layout", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "受控真实 Unix 协议 fixture；未验证操作系统剪贴板持久策略，只在点击后核对主进程写入值并恢复原值。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("POL-CONNECTOR-UI-006 登记暂失不冒充下线，恢复后不重复 online", {
  timeout: 90000,
  skip: SKIP_LIVE,
}, async () => {
  const details = {};
  const screenshots = [];
  const cleanupErrors = [];
  const appExits = [];
  const trace = [];
  const logs = [];
  let failure = null;
  const root = tempRoot("006");
  const dataDir = makeDataDir();
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  let server = null;
  let launched = null;
  try {
    server = await startRealServer(root);
    setupRealPlugin(server, registryDir);
    createRealAgent(server, "connector-006", "登记恢复 Agent");
    realCli(server, ["plugin", "action", "invoke", ACTION_ID]);
    const record = await waitRealRegistration(registryDir, server.child.pid);
    const registryFile = path.join(registryDir, `${record.instanceId}.json`);
    const backupFile = path.join(root, "registration-backup.json");
    launched = await launchApp(dataDir, home, trace, logs);
    await openConnectorTab(launched.page);
    await waitRowStatus(launched.page, record.instanceId, "online", 30000);
    assert.equal(countEvents(dataDir, record.instanceId, "online"), 1);

    fs.renameSync(registryFile, backupFile);
    await waitRowStatus(launched.page, record.instanceId, "reconnecting", 20000);
    const reconnectingText = await launched.page.locator(rowSelector(record.instanceId)).innerText();
    assert.match(reconnectingText, /重连中/);
    assert.match(reconnectingText, /连接暂不可确认/);
    assert.equal(reconnectingText.includes("已下线"), false);
    assert.equal(countEvents(dataDir, record.instanceId, "offline"), 0);
    details.registryRemovedState = reconnectingText.slice(0, 300);
    screenshots.push(await capture(launched.page, "006-registry-missing-unconfirmed"));

    fs.renameSync(backupFile, registryFile);
    await waitRowStatus(launched.page, record.instanceId, "online", 20000);
    assert.equal(countEvents(dataDir, record.instanceId, "online"), 1);
    assert.equal(countEvents(dataDir, record.instanceId, "offline"), 0);

    const stopped = await stopRealServer(server);
    if (!stopped.ok) throw new Error(`真实 server stop 未完成：${JSON.stringify(stopped)}`);
    server = null;
    await waitRowStatus(launched.page, record.instanceId, "offline", 30000);
    assert.match(await launched.page.locator(rowSelector(record.instanceId)).innerText(), /未知/);
    assert.equal(countEvents(dataDir, record.instanceId, "offline"), 1);
    details.onlineEvents = countEvents(dataDir, record.instanceId, "online");
    details.offlineEvents = countEvents(dataDir, record.instanceId, "offline");
    screenshots.push(await capture(launched.page, "006-confirmed-offline"));
  } catch (error) {
    failure = error;
    const shot = await captureFailure(launched?.page, "006");
    if (shot) screenshots.push(shot);
  } finally {
    try {
      if (launched) appExits.push(await closeApp(launched.app));
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (server) {
      const stopped = await stopRealServer(server);
      if (!stopped.ok) cleanupErrors.push(new Error(`真实 server 清理失败：${JSON.stringify(stopped)}`));
    }
    finishResources([root, dataDir, home], cleanupErrors);
    writeCaseLog("006-registry-unconfirmed", {
      failure, screenshots, details, appExits, cleanupErrors, trace, logs,
      boundary: "真实 herdr 0.9.5；只移动本轮隔离登记文件，socket/server PID 保持；恢复后同一 run 不重复 online。",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw cleanupErrors[0];
});
