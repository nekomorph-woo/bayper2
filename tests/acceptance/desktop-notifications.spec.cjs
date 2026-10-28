/* S05j 必需事件进入真实桌面气泡验收。
   真实 Electron 主进程 + 正式 SQLite/通知服务 + 实际通知 panel/DOM。
   001/002/003/004/005 中真实 Herdr 负责在线与逐 Agent 状态；需要 done 或
   events_lost 的部分由同形受控 Unix 协议 fixture 提供并明确标注边界。
   不读取用户会话，只创建本轮具名隔离 session，退出时清理。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { createLegacyDatabase, dbPath, localDay } = require("./s02-fixtures.cjs");
const {
  validateNotificationAck,
  validateNotificationClose,
} = require("../../app/desktop-host.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const PLUGIN_DIR = path.join(repoRoot, "plugins", "herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const HERDR = process.env.HERDR_BIN || "herdr";
const REGISTRY_NAME = "herdr-registry";
const BATCH = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${
  crypto.randomBytes(3).toString("hex")}`;
const EVIDENCE_DIR = path.join(
  repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s05j-desktop-notifications",
  `run-${BATCH}`,
);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH}`,
    `created: ${new Date().toISOString()}`,
    "source: tests/acceptance/desktop-notifications.spec.cjs",
    "boundary: 真实 Herdr 0.9.5 负责 working/blocked 与连接；done/events_lost 由同形 Unix fixture 提供。",
    "",
  ].join("\n"),
);

const SKIP_LIVE = process.env.HERDR_ENV === "1"
  ? "HERDR_ENV=1：不在 Herdr 会话外创建测试 server"
  : false;
const DEFAULT_SERVER_CONFIG = [
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
].join("\n");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? `（${last.message}）` : ""}`);
}

function realish(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function redactText(text, roots) {
  return roots.reduce(
    (value, root) => value.split(realish(root)).join("<isolated-root>").split(root).join("<isolated-root>"),
    text,
  );
}

function writeCase(caseId, record, roots = []) {
  const file = path.join(EVIDENCE_DIR, `case-${caseId}.json`);
  fs.writeFileSync(file, `${redactText(JSON.stringify(record, null, 2), roots)}\n`);
  const log = path.join(EVIDENCE_DIR, `case-${caseId}.log`);
  fs.writeFileSync(log, [
    `case: ${caseId}`,
    `batch: ${BATCH}`,
    `at: ${new Date().toISOString()}`,
    `status: ${record.failure ? "fail" : "pass"}`,
    `failure: ${record.failure ? record.failure.stack || record.failure.message : "none"}`,
    `cleanup: ${record.cleanupErrors?.length ? "failed" : "ok"}`,
    ...(record.cleanupErrors ?? []).map((error, index) =>
      `  cleanup-${index + 1}: ${error?.stack || error?.message || error}`),
    `screenshots: ${JSON.stringify(record.screenshots ?? [])}`,
    "",
    "## facts",
    JSON.stringify(record.facts ?? {}, null, 2),
    "",
    "## boundary",
    record.boundary ?? "",
    "",
  ].join("\n"));
  return { file, log };
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s05j-home-"));
  for (const key of [".config", ".local/share"]) {
    fs.mkdirSync(path.join(home, key), { recursive: true });
  }
  return home;
}

function makeDataDir(tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-s05j-${tag}-`));
  createLegacyDatabase(dataDir, {
    characters: [{ id: "rin", acceptedAt: "2026-10-01T00:00:00.000Z" }],
    modelCipher: Buffer.from("s05j-fixture-cipher"),
    baseUrl: "https://127.0.0.1:1/v1",
    modelName: "s05j-unreachable",
    fixedId: "rin",
    currentId: "rin",
    rosterDay: localDay(new Date()),
  });
  return dataDir;
}

function writeAppState(dataDir, key, value) {
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  } finally {
    db.close();
  }
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

function execDb(dataDir, sql) {
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec(sql);
  } finally {
    db.close();
  }
}

function readRegistry(registryDir) {
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

function registryDirOf(dataDir) {
  return path.join(dataDir, REGISTRY_NAME);
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

function realCli(context, args) {
  return execFileSync(HERDR, ["--session", context.session, ...args], {
    env: context.env, encoding: "utf8", timeout: 10000,
  });
}

async function startRealServer(root, session) {
  if (process.env.HERDR_ENV === "1") throw new Error("HERDR_ENV=1：拒绝创建测试 server");
  const env = realEnv(root, session);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(env.HERDR_CONFIG_PATH, DEFAULT_SERVER_CONFIG);
  const version = execFileSync(HERDR, ["--version"], { env, encoding: "utf8" }).trim();
  assert.match(version, /^herdr 0\.9\.5\b/);
  const child = spawn(HERDR, ["--session", session, "server"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-3000);
  });
  const context = { root, session, env, child, version, stderr: () => stderr, socketPath: null };
  const expected = path.join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock");
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Herdr server 提前退出：${stderr}`);
    }
    return fs.existsSync(expected);
  }, 10000, "real server socket");
  const status = await waitFor(() => {
    try {
      const parsed = JSON.parse(realCli(context, ["status", "server", "--json"]));
      return parsed.running ? parsed : null;
    } catch {
      return null;
    }
  }, 10000, "real server status");
  context.socketPath = status.socket;
  context.protocol = status.protocol;
  return context;
}

async function stopRealServer(context) {
  if (!context) return { ok: true, skipped: true };
  const cleanup = { pid: context.child.pid, exited: false, socketRemoved: false, forcedKill: false };
  if (context.child.exitCode === null && context.child.signalCode === null) {
    try {
      realCli(context, ["server", "stop"]);
    } catch {
      // 以进程和 socket 事实判定。
    }
  }
  await waitFor(
    () => context.child.exitCode !== null || context.child.signalCode !== null,
    5000, "real server exit",
  ).catch(() => {});
  if (context.child.exitCode === null && context.child.signalCode === null) {
    cleanup.forcedKill = context.child.kill("SIGTERM");
    await waitFor(
      () => context.child.exitCode !== null || context.child.signalCode !== null,
      2000, "real server SIGTERM",
    ).catch(() => {});
  }
  cleanup.exited = context.child.exitCode !== null || context.child.signalCode !== null;
  cleanup.exitCode = context.child.exitCode;
  await waitFor(() => !fs.existsSync(context.socketPath), 5000, "real socket removal").catch(() => {});
  cleanup.socketRemoved = !fs.existsSync(context.socketPath);
  cleanup.ok = cleanup.exited && cleanup.socketRemoved;
  return cleanup;
}

function setupRealPlugin(context, registryDir) {
  try {
    realCli(context, ["plugin", "link", PLUGIN_DIR, "--enabled"]);
  } catch (error) {
    if (!/already|linked|enabled/i.test(String(error.message))) throw error;
  }
  const configDir = realCli(context, ["plugin", "config-dir", PLUGIN_ID]).trim();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
}

function createPane(context, label) {
  const created = JSON.parse(realCli(context, [
    "workspace", "create", "--cwd", context.root, "--label", label, "--focus",
  ]));
  const pane = created.result.root_pane.pane_id;
  realCli(context, ["pane", "run", pane, "sleep", "300"]);
  return pane;
}

function splitPane(context, paneId) {
  const created = JSON.parse(realCli(context, [
    "pane", "split", paneId, "--direction", "right", "--cwd", context.root, "--no-focus",
  ]));
  const pane = created.result.pane.pane_id;
  realCli(context, ["pane", "run", pane, "sleep", "300"]);
  return pane;
}

function reportAgent(context, pane, agent, state, sequence) {
  realCli(context, [
    "pane", "report-agent", pane, "--source", "bayper-s05j-fixture",
    "--agent", agent, "--state", state, "--seq", String(sequence),
  ]);
}

function invokeRegistration(context) {
  realCli(context, ["plugin", "action", "invoke", ACTION_ID]);
}

async function waitRegistration(registryDir, pid, previousRunId = null) {
  return waitFor(() => readRegistry(registryDir).find(
    (item) => item.observedServerPid === pid && item.runId !== previousRunId,
  ) ?? null, 15000, "real plugin registration");
}

/* 同形受控 Unix 协议 fixture：只实现 adapter 需要的 ping/snapshot/订阅。
   用于真实 Herdr CLI 无法直接报告的 done 与 events_lost。 */
function fixtureSnapshot(agents) {
  const panes = agents.map((agent, index) => ({
    pane_id: `pane-${index}`, terminal_id: `term-${index}`, workspace_id: "ws-1",
    tab_id: "tab-1", label: agent.label, focused: index === 0,
    agent_status: agent.state, revision: 1,
  }));
  return {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "ws-1", number: 1, label: "fixture", focused: true }],
    tabs: [{
      tab_id: "tab-1", workspace_id: "ws-1", number: 1, label: "fixture",
      focused: true, pane_count: panes.length, agent_status: agents[0]?.state ?? "idle",
    }],
    panes,
    layouts: [],
    agents: agents.map((agent, index) => ({
      terminal_id: `term-${index}`, pane_id: `pane-${index}`, workspace_id: "ws-1",
      tab_id: "tab-1", agent_status: agent.state,
      state_change_seq: agent.sequence ?? 1,
      completion_seq: null, name: agent.label, display_agent: "fixture",
      focused: index === 0, revision: 1,
    })),
  };
}

function createFixtureServer(root, name, snapshot) {
  const socketPath = path.join(root, `${name}.sock`);
  const state = {
    socketPath, snapshot, count: 0, subscribeCount: 0, snapshotCount: 0,
    sockets: new Set(), subscriptions: new Set(), server: null,
  };
  const write = (socket, message) => {
    if (socket.destroyed) return;
    try { socket.write(`${JSON.stringify(message)}\n`); } catch { /* 已断开。 */ }
  };
  const handle = (socket) => {
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
          subscription = { socket, subscriptions: message.params?.subscriptions ?? [] };
          state.subscriptions.add(subscription);
          state.subscribeCount += 1;
          write(socket, { id: message.id, result: { type: "subscription_started" } });
          continue;
        }
        if (message.method === "ping") {
          write(socket, { id: message.id, result: { type: "pong", version: "0.9.5", protocol: 22 } });
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
  };
  const broadcast = (message) => {
    for (const subscription of [...state.subscriptions]) write(subscription.socket, message);
  };
  return {
    socketPath, state,
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
    status(paneId, value) {
      broadcast({
        event: "pane.agent_status_changed",
        data: { pane_id: paneId, workspace_id: "ws-1", agent_status: value },
      });
    },
    eventsLost() {
      broadcast({ error: { code: "events_lost", message: "s05j fixture lost" } });
    },
  };
}

function registerFixture(socketPath, registryDir, root, name) {
  const stateDir = path.join(root, `fixture-${name}-state`);
  const configDir = path.join(root, `fixture-${name}-config`);
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

async function launchApp(dataDir, home, extraEnv = {}, { waitHome = true } = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      // 仅验收进程开启 DevTools 端口以观察真实通知窗口 DOM。
      BAYPER_DESKTOP_DEBUG_PORT: "1",
      BAYPER_NOTIFICATION_TICK_MS: "100",
      ...extraEnv,
    },
  });
  const logs = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if (waitHome) {
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 30000 });
  }
  return { app, page, logs };
}

async function closeApp(app) {
  if (!app) return { status: "no-app" };
  const handle = app.process?.();
  await app.close().catch(() => {});
  await waitFor(
    () => !handle || handle.exitCode !== null || handle.signalCode !== null,
    8000, "app exit",
  ).catch(() => {});
  return {
    status: handle && (handle.exitCode !== null || handle.signalCode !== null)
      ? "exited" : "alive",
    code: handle?.exitCode ?? null,
    signal: handle?.signalCode ?? null,
  };
}

function snapshotOf(page) {
  return page.evaluate(() => window.bayper.getSnapshot()).then((result) => {
    assert.equal(result.ok, true);
    return result.snapshot;
  });
}

function notificationsOf(snapshot) {
  return snapshot?.desktop?.notifications ?? { window: {}, panels: [] };
}

async function waitDesktop(page) {
  return waitFor(async () => {
    const snapshot = await snapshotOf(page);
    return snapshot.desktop?.state === "running" && snapshot.desktop?.assetState === "ready"
      ? snapshot : null;
  }, 25000, "desktop running");
}

async function waitOnline(page) {
  return waitFor(async () => {
    const snapshot = await snapshotOf(page);
    return snapshot.connectors.instances.find((item) => item.status === "online")
      ? snapshot : null;
  }, 35000, "connector online");
}

async function waitNotificationWindow(page) {
  return waitFor(async () => {
    const notifications = notificationsOf(await snapshotOf(page));
    return notifications.window?.visible ? notifications : null;
  }, 20000, "notification window visible");
}

async function connectNotificationPage(dataDir) {
  return waitFor(async () => {
    const portFile = path.join(dataDir, "desktop-profile", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) return null;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    if (!port) return null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((item) => item.url().includes("notification.html"));
    if (!page) {
      await browser.close();
      return null;
    }
    return { browser, page };
  }, 15000, "notification CDP page");
}

function captureNotification(windowFact, name) {
  const captureId = windowFact?.captureId ?? "";
  const windowId = captureId.split(":")[1];
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  if (!windowId) return null;
  try {
    execFileSync("screencapture", ["-x", "-l", windowId, file], { timeout: 5000 });
    return file;
  } catch (error) {
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, `${name}.error.txt`),
      `screencapture 失败：${error?.message || error}\n`,
    );
    return null;
  }
}

function eventRow(dataDir, sourceEventId) {
  const rows = queryDb(
    dataDir,
    "SELECT * FROM connector_events WHERE event_id = ? ORDER BY id DESC LIMIT 1",
    [sourceEventId],
  );
  return rows[0] ?? null;
}

function ackRow(dataDir, eventId) {
  return queryDb(dataDir, `
    SELECT presentation_id, event_id, acknowledged_at, hold_until
    FROM notification_presentation_items WHERE event_id = ?
    ORDER BY rowid DESC LIMIT 1
  `, [eventId])[0] ?? null;
}

function presentedCount(dataDir) {
  return queryDb(dataDir, `
    SELECT COUNT(*) AS count FROM connector_events WHERE notification_status = 'presented'
  `)[0].count;
}

function waitAck(dataDir, eventId, timeout = 10000) {
  return waitFor(() => ackRow(dataDir, eventId)?.acknowledged_at != null
    ? ackRow(dataDir, eventId) : null, timeout, `ack ${eventId}`);
}

function allItems(dataDir) {
  return queryDb(dataDir, `
    SELECT presentation_id, event_id, acknowledged_at, hold_until
    FROM notification_presentation_items ORDER BY rowid ASC
  `);
}

async function teardown(resources, cleanupErrors) {
  const exits = [];
  try {
    exits.push(await closeApp(resources.app));
  } catch (error) {
    cleanupErrors.push(error);
  }
  const stopped = await stopRealServer(resources.server).catch((error) => {
    cleanupErrors.push(error);
    return { ok: false };
  });
  if (!stopped.ok) cleanupErrors.push(new Error(`server 清理失败：${JSON.stringify(stopped)}`));
  if (resources.fixtures) {
    for (const fixture of resources.fixtures) {
      await fixture.stop().catch((error) => cleanupErrors.push(error));
    }
  }
  for (const target of [resources.root, resources.dataDir, resources.home]) {
    if (!target) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (fs.existsSync(target)) throw new Error(`临时目录未清理：${target}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  return exits;
}

test("POL-NOTIFY-UI-001 真实Herdr逐Agent状态进入气泡；来源准确、done不称成功", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-001-");
  const dataDir = makeDataDir("001");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "001", facts: {}, screenshots: [], cleanupErrors: [] };
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const pane = createPane(resources.server, "s05j-001");
    reportAgent(resources.server, pane, "fixture-a", "working", 1);
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    record.facts.herdrVersion = resources.server.version;
    record.facts.session = session;

    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    const { page } = launched;
    await waitDesktop(page);
    await waitOnline(page);

    const sourceShort = record.facts.registration.instanceId.slice(-8);
    const visible = await waitNotificationWindow(page);
    record.screenshots.push(captureNotification(visible.window, "001-online"));

    const assertStateBubble = async (state, expectedText, targetMs, agent) => {
      const item = await waitFor(
        () => queryDb(dataDir, `
          SELECT * FROM connector_events
          WHERE state = ? AND notification_status = 'pending'
          ORDER BY id DESC LIMIT 1
        `, [state])[0] ?? null,
        8000,
        `${state} 入队尚未 presented`,
      );
      record.facts[`${state}QueuedPending`] = true;
      const ack = await waitAck(dataDir, item.id, Math.max(8000, targetMs + 4000));
      const panel = (await snapshotOf(page)).desktop.notifications.panels
        .find((entry) => entry.itemCount > 0 && entry.renderedEventIds?.includes(item.id));
      assert.ok(panel.renderedAt <= ack.acknowledged_at, "presented 必须晚于真实可见上报");
      const delayMs = ack.acknowledged_at - item.received_at;
      record.facts[`${state}DelayMs`] = delayMs;
      record.facts[`${state}HoldMs`] = ack.hold_until - ack.acknowledged_at;
      assert.ok(delayMs <= targetMs, `${state} 目标 ${targetMs}ms，实际 ${delayMs}ms`);
      const cdp = await connectNotificationPage(dataDir);
      resources.cdp.push(cdp.browser);
      await waitFor(async () => {
        const text = await cdp.page.locator("#stack").innerText();
        return text.includes(expectedText) && text.includes(sourceShort) ? text : null;
      }, 8000, `${state} 气泡文本`);
      const text = await cdp.page.locator("#stack").innerText();
      assert.match(text, new RegExp(`来源 ${sourceShort}`));
      if (agent) assert.ok(text.includes(agent), "气泡必须显示 Agent 名称");
      return { item, ack, delayMs, text };
    };

    reportAgent(resources.server, pane, "fixture-a", "idle", 2);
    const idleResult = await assertStateBubble("idle", "空闲", 8000, "fixture-a");
    record.facts.idle = {
      receivedAt: idleResult.item.received_at,
      acknowledgedAt: idleResult.ack.acknowledged_at,
      delayMs: idleResult.delayMs,
      text: idleResult.text,
    };

    reportAgent(resources.server, pane, "fixture-a", "blocked", 3);
    const blockedResult = await assertStateBubble("needs_attention", "需要确认", 1000, "fixture-a");
    record.facts.blocked = {
      receivedAt: blockedResult.item.received_at,
      acknowledgedAt: blockedResult.ack.acknowledged_at,
      delayMs: blockedResult.delayMs,
      text: blockedResult.text,
    };
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "001-urgent",
    ));

    reportAgent(resources.server, pane, "fixture-a", "working", 4);
    await assertStateBubble("working", "正在工作", 8000, "fixture-a");

    /* 真实 herdr CLI 只接受 idle/working/blocked/unknown；done 由同形受控
       Unix 协议 fixture 提供，仍走正式 adapter/ledger/通知链路。 */
    const fixture = createFixtureServer(root, "done", fixtureSnapshot([
      { label: "fixture-done", state: "working" },
    ]));
    await fixture.start();
    resources.fixtures = [fixture];
    const fixtureRecord = registerFixture(fixture.socketPath, registryDir, root, "done");
    record.facts.doneFixture = fixtureRecord;
    const doneInstance = await waitFor(async () => {
      const snapshot = await snapshotOf(page);
      return snapshot.connectors.instances.filter((item) => item.status === "online").length >= 2
        ? fixtureRecord.instanceId : null;
    }, 30000, "fixture online");
    fixture.status("pane-0", "done");
    const done = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events
      WHERE state = 'finished' AND notification_status != 'none' ORDER BY id DESC LIMIT 1
    `)[0] ?? null, 8000, "fixture done event");
    const doneAck = await waitAck(dataDir, done.id, 10000);
    const doneDelay = doneAck.acknowledged_at - done.received_at;
    assert.ok(doneDelay <= 4000, `P1 done 目标 4000ms，实际 ${doneDelay}ms`);
    const cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    const doneText = await waitFor(async () => {
      const text = await cdp.page.locator("#stack").innerText();
      return text.includes("已结束") ? text : null;
    }, 8000, "done 气泡文本");
    assert.doesNotMatch(doneText, /成功/);
    record.facts.done = {
      instanceId: doneInstance,
      receivedAt: done.received_at,
      acknowledgedAt: doneAck.acknowledged_at,
      delayMs: doneDelay,
      holdMs: doneAck.hold_until - doneAck.acknowledged_at,
      text: doneText,
    };
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "001-finished",
    ));

    const statuses = queryDb(dataDir,
      "SELECT id, kind, state, historical, gapped, notification_status FROM connector_events ORDER BY id");
    record.facts.ledger = statuses;
    record.facts.modelServerStarted = false;
    record.facts.boundary = "真实 herdr 0.9.5 负责 online/working/blocked；done 使用同形 Unix fixture。";
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) {
      await browser.close().catch(() => {});
    }
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("001", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-002 3普通满位、P0独立追加、每条6秒与普通不饿死", {
  timeout: 150000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-002-");
  const dataDir = makeDataDir("002");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "002", facts: {}, screenshots: [], cleanupErrors: [] };
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const panes = {};
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      panes[name] = createPane(resources.server, `s05j-002-${name}`);
      reportAgent(resources.server, panes[name], `fixture-${name}`, "working", 1);
    }
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);

    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    const { page } = launched;
    await waitDesktop(page);
    await waitOnline(page);

    const latestEventId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const agentEntry = async (label) => {
      const snapshot = await snapshotOf(page);
      return snapshot.connectors.instances
        .flatMap((item) => item.agents)
        .find((item) => item.label === label) ?? null;
    };
    /* 真实 Herdr 可能在 report 同时产生自己的生命周期事件；按该 Agent 的
       新事件取第一条，不把“请求的状态”当成唯一事实。 */
    const reportAndWait = async (pane, agent, state, sequence, expectedState = null) => {
      const entry = await agentEntry(agent);
      const before = latestEventId();
      reportAgent(resources.server, pane, agent, state, sequence);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const row = queryDb(dataDir, `
          SELECT * FROM connector_events WHERE id > ?
            AND (? IS NULL OR agent_id = ?)
          ORDER BY id ASC LIMIT 1
        `, [before, entry?.agentId ?? null, entry?.agentId ?? null])[0];
        if (row && (!expectedState || row.state === expectedState)) return row;
        await delay(50);
      }
      const recent = queryDb(dataDir, `
        SELECT id, state, agent_id, kind, notification_status, source_event_id
        FROM connector_events WHERE id > ? ORDER BY id ASC
      `, [before]);
      throw new Error(`${agent} ${state} 未入账；recent=${JSON.stringify(recent)}`);
    };
    const quietState = async (label) => {
      const entry = await agentEntry(label);
      return entry?.state === "unknown" ? "working" : "unknown";
    };
    const targetForPriority = (priority) =>
      priority === 0 ? 1000 : priority === 1 ? 4000 : 8000;
    const ackFor = (eventId) => ackRow(dataDir, eventId);
    const ordinaryPanels = async () =>
      (await snapshotOf(page)).desktop.notifications.panels
        .filter((item) => item.channel === "ordinary");
    const urgentPanel = async () =>
      (await snapshotOf(page)).desktop.notifications.panels
        .find((item) => item.channel === "urgent") ?? null;

    // 等启动 online 的 4 秒阅读结束，从空槽开始测目标。
    await waitFor(async () =>
      (await snapshotOf(page)).desktop.notifications.panels.length === 0,
    12000, "启动通知阅读结束");

    /* 空槽时的 P2 与 P0 目标按真实墙钟测量；P1 的 4 秒目标由 Case 001 的
       done 事件覆盖，本 Case 聚焦 1/8 秒和 3+1 位。 */
    const p2Event = await reportAndWait(panes.a, "fixture-a", await quietState("fixture-a"), 10);
    const p2Ack = await waitAck(dataDir, p2Event.id, 12000);
    const p2Delay = p2Ack.acknowledged_at - p2Event.received_at;
    const p2Target = targetForPriority(p2Event.priority);
    assert.ok(p2Delay <= p2Target, `优先级 ${p2Event.priority} 目标 ${p2Target}ms，实际 ${p2Delay}ms`);
    record.facts.p2 = {
      state: p2Event.state,
      priority: p2Event.priority,
      targetMs: p2Target,
      delayMs: p2Delay,
      holdMs: p2Ack.hold_until - p2Ack.acknowledged_at,
    };

    const p0Event = await reportAndWait(panes.b, "fixture-b", "blocked", 10, "needs_attention");
    const p0Ack = await waitAck(dataDir, p0Event.id, 5000);
    const p0Delay = p0Ack.acknowledged_at - p0Event.received_at;
    assert.ok(p0Delay <= 1000, `P0 目标 1000ms，实际 ${p0Delay}ms`);
    assert.equal(p0Ack.hold_until - p0Ack.acknowledged_at, 6000);
    record.facts.p0 = { delayMs: p0Delay, holdMs: 6000 };
    assert.ok(await urgentPanel(), "P0 应进入独立加急位");

    /* 立即填满 3 个普通位；P2 和启动 online 各占一位，再补真实变化。 */
    const ordinaryEvents = [];
    for (const name of ["c", "d", "f"]) {
      ordinaryEvents.push(await reportAndWait(
        panes[name], `fixture-${name}`, await quietState(`fixture-${name}`), 20,
      ));
      if ((await ordinaryPanels()).length === 3) break;
    }
    const ordinary = await waitFor(async () => {
      const panels = await ordinaryPanels();
      return panels.length === 3 && panels.every((item) => item.itemCount === 1)
        ? panels : null;
    }, 15000, "3 个普通位");
    const ordinarySnapshot = new Map(ordinary.map(
      (panel) => [panel.presentationId, [...(panel.eventIds ?? [])].sort()],
    ));
    const ordinaryItems = ordinary.map((panel) => panel.presentationId);
    record.facts.ordinaryFull = {
      presentations: ordinaryItems,
      events: [...ordinarySnapshot.entries()],
    };
    /* 满位后追加一条普通事实，验证它在槽位释放后不会被 P0 饿死。 */
    const queued = await reportAndWait(
      panes.g, "fixture-g", await quietState("fixture-g"), 20,
    );

    /* 连续 P0 追加到同一加急呈现，旧内容不被覆盖。 */
    const p0bEvent = await reportAndWait(panes.e, "fixture-e", "blocked", 20, "needs_attention");
    const urgent = await waitFor(async () => {
      const panel = await urgentPanel();
      return panel && panel.itemCount >= 2 ? panel : null;
    }, 10000, "加急追加");
    const p0aAck = await waitAck(dataDir, p0Event.id, 10000);
    const p0bAck = await waitAck(dataDir, p0bEvent.id, 10000);
    record.facts.timings = {
      p0bAckAt: Date.now(),
      p0aAckAt: p0aAck.acknowledged_at,
      p0bAckRowAt: p0bAck.acknowledged_at,
      p0aHoldUntil: p0aAck.hold_until,
      p0bHoldUntil: p0bAck.hold_until,
    };
    assert.equal(p0aAck.hold_until - p0aAck.acknowledged_at, 6000);
    assert.equal(p0bAck.hold_until - p0bAck.acknowledged_at, 6000);
    assert.ok(p0bAck.acknowledged_at >= p0aAck.acknowledged_at, "每条各自从实际回执起算");
    const afterP0 = await snapshotOf(page);
    for (const panel of afterP0.desktop.notifications.panels
      .filter((item) => item.channel === "ordinary")) {
      const before = ordinarySnapshot.get(panel.presentationId);
      if (!before) continue;
      assert.deepEqual(
        [...(panel.eventIds ?? [])].sort(), before,
        "P0 追加不得覆盖仍在阅读的普通内容",
      );
    }
    assert.ok(
      afterP0.desktop.notifications.panels.some((item) => item.channel === "ordinary"),
      "P0 活跃时普通位仍应存在",
    );
    const cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    record.facts.timings.cdpAt = Date.now();
    /* 旧新两条 P0 同时可见的状态要在首条 6 秒阅读期内采集；后续补普通位
       可能耗时超过 6 秒，不能把晚到的单页当成“旧内容被覆盖”。 */
    const urgentText = await waitFor(async () => {
      const card = cdp.page.locator('.card[data-channel="urgent"]');
      if (await card.count() === 0) return null;
      const text = await card.innerText();
      return text.includes("fixture-b") && text.includes("fixture-e") ? text : null;
    }, 8000, "P0 旧新两条同时可见");
    const urgentItemCount = await cdp.page.locator('.card[data-channel="urgent"] .item').count();
    assert.equal(urgentItemCount, 2, "P0 追加后旧新两条明细同时在位");
    /* 普通位只有 4 秒阅读期；先按 eventId/holdUntil 对照当前时间记录是否自然到期，
       再用真实队列补足需要维持的三位，而不是要求已到期内容永远在场。 */
    const appendObservedAt = Date.now();
    record.facts.ordinaryOriginalAtAppend = [...ordinarySnapshot.entries()].map(
      ([presentationId, eventIds]) => ({
        presentationId,
        events: eventIds.map((eventId) => {
          const row = ackFor(eventId);
          return {
            eventId,
            acknowledgedAt: row?.acknowledged_at ?? null,
            holdUntil: row?.hold_until ?? null,
            remainingMs: row?.hold_until ? row.hold_until - appendObservedAt : null,
            expired: row?.hold_until ? row.hold_until <= appendObservedAt : null,
          };
        }),
      }),
    );
    const readingOrdinary = async (minRemainingMs) => {
      const now = Date.now();
      const panels = await ordinaryPanels();
      return panels.filter((panel) => {
        const eventIds = panel.eventIds ?? [];
        if (eventIds.length === 0) return false;
        const rows = eventIds.map((eventId) => ackFor(eventId));
        return rows.every((row) => row?.acknowledged_at)
          && rows.every((row) => row.hold_until - now >= minRemainingMs);
      });
    };
    const advancedOrdinaryIds = new Set();
    const replenishPanes = ["c", "d", "f"];
    const ensureReadingOrdinary = async () => {
      const trace = [];
      record.facts.ordinaryFeedTrace = trace;
      const deadline = Date.now() + 8000;
      let attempt = 0;
      let lastFeed = 0;
      while (Date.now() < deadline) {
        const valid = await readingOrdinary(1200);
        const panels = await ordinaryPanels();
        for (const panel of panels) {
          for (const eventId of panel.renderedEventIds ?? []) {
            advancedOrdinaryIds.add(eventId);
          }
        }
        if (trace.length < 24) {
          trace.push({
            at: Date.now(),
            panels: panels.length,
            valid: valid.length,
            eventIds: panels.flatMap((panel) => panel.eventIds ?? []),
          });
        }
        if (valid.length === 3) return valid;
        // 槽位被旧内容占用时真实事件先排队，等其自然结束后补入。
        if (Date.now() - lastFeed > 500) {
          const name = replenishPanes[attempt % replenishPanes.length];
          await reportAndWait(
            panes[name], `fixture-${name}`, await quietState(`fixture-${name}`), 40 + attempt,
          ).catch(() => null);
          attempt += 1;
          lastFeed = Date.now();
        }
        await delay(200);
      }
      return null;
    };
    const sustained = await ensureReadingOrdinary();
    assert.ok(sustained, "需要用真实队列维持三个仍在有效阅读期的普通位");
    record.facts.ordinaryReading = sustained.map((panel) => ({
      presentationId: panel.presentationId,
      events: (panel.eventIds ?? []).map((eventId) => {
        const row = ackFor(eventId);
        return {
          eventId,
          acknowledgedAt: row?.acknowledged_at ?? null,
          holdUntil: row?.hold_until ?? null,
        };
      }),
    }));
    // 原本在场且仍在阅读期的普通呈现不得被 P0 覆盖。
    for (const panel of sustained) {
      const before = ordinarySnapshot.get(panel.presentationId);
      if (!before) continue;
      assert.deepEqual(
        [...(panel.eventIds ?? [])].sort(), before,
        "P0 追加不得覆盖仍在阅读的普通内容",
      );
    }
    const geometryOf = () => cdp.page.evaluate(() => ({
      innerHeight: window.innerHeight,
      cards: [...document.querySelectorAll('.card[data-channel="ordinary"]')].map((card) => ({
        presentationId: card.dataset.presentationId,
        rect: card.getBoundingClientRect().toJSON(),
        meanings: [...card.querySelectorAll(".item-meaning")].map((item) => {
          const rect = item.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom,
            clipped: item.scrollHeight > item.clientHeight + 1 };
        }),
      })),
    }));
    const layoutSamples = [];
    for (let round = 0; round < 3; round += 1) {
      assert.ok(await ensureReadingOrdinary(), "采样时三个普通位必须仍在阅读期");
      layoutSamples.push(await geometryOf());
      await delay(250);
    }
    const ordinaryLayout = layoutSamples[layoutSamples.length - 1];
    assert.equal(ordinaryLayout.cards.length, 3, "P0 追加后三个普通位仍同时存在");
    for (const sample of layoutSamples) {
      for (const card of sample.cards) {
        assert.ok(card.rect.top >= -0.5
          && card.rect.bottom <= sample.innerHeight + 0.5,
        "普通卡片必须在通知窗口内完整可见");
        for (const meaning of card.meanings) {
          assert.equal(meaning.clipped, false, "普通状态文字不得被裁切");
          assert.ok(meaning.top >= 0 && meaning.bottom <= sample.innerHeight + 0.5);
        }
      }
    }
    record.facts.ordinaryLayout = { samples: layoutSamples };
    assert.match(urgentText, /fixture-b/);
    assert.match(urgentText, /fixture-e/);
    record.screenshots.push(captureNotification(
      afterP0.desktop.notifications.window, "002-three-ordinary-plus-urgent",
    ));
    record.facts.urgent = {
      itemCount: urgentItemCount,
      text: urgentText,
      holds: [
        p0aAck.hold_until - p0aAck.acknowledged_at,
        p0bAck.hold_until - p0bAck.acknowledged_at,
      ],
    };

    /* 每条普通从实际回执起至少保留 4 秒；关闭时间由同一 SQLite 的 closing 事实核对。 */
    const ordinaryEventIds = [...ordinarySnapshot.values()].flat();
    const ordinaryAck = await waitFor(() => {
      const rows = ordinaryEventIds.map((id) => ackFor(id));
      return rows.every((row) => row?.acknowledged_at) ? rows : null;
    }, 12000, "普通回执");
    for (const row of ordinaryAck) {
      assert.equal(row.hold_until - row.acknowledged_at, 4000);
    }
    const heldPid = ordinaryAck[0].presentation_id;
    const heldHold = ordinaryAck[0].hold_until;
    const closed = await waitFor(() => queryDb(dataDir, `
      SELECT closed_at, close_reason FROM notification_presentations
      WHERE presentation_id = ? AND state = 'closed'
    `, [heldPid])[0] ?? null, 10000, "普通阅读结束");
    assert.ok(closed.closed_at >= heldHold, "普通内容不得早于 4 秒关闭");
    record.facts.ordinaryHold = {
      presentationId: heldPid,
      acknowledgedAt: ordinaryAck[0].acknowledged_at,
      holdUntil: heldHold,
      closedAt: closed.closed_at,
      closeReason: closed.close_reason,
      visibleMs: closed.closed_at - ordinaryAck[0].acknowledged_at,
    };

    /* 排队普通在 P0 仍活跃时也必须推进；若在补充三位期间已推进，直接采用该事实。 */
    const advancedDuringP0 = advancedOrdinaryIds.has(queued.id);
    const advanced = advancedDuringP0
      ? await ordinaryPanels()
      : await waitFor(async () => {
        const panels = await ordinaryPanels();
        const ids = panels.flatMap((item) => item.renderedEventIds ?? []);
        return ids.includes(queued.id) ? panels : null;
      }, 15000, "普通位推进");
    assert.ok(advanced.length > 0);
    assert.ok(advancedDuringP0 || advanced.some(
      (item) => (item.renderedEventIds ?? []).includes(queued.id),
    ), "排队普通必须在 P0 活跃时推进");
    await waitAck(dataDir, queued.id, 8000);
    const overdue = queryDb(dataDir,
      "SELECT event_id, due_at, observed_at, reason FROM notification_audit ORDER BY id");
    record.facts.queue = {
      advanced: advanced.map((item) => item.presentationId),
      advancedDuringP0,
      queuedEvent: queued.id,
      queuedDelayMs: ackFor(queued.id).acknowledged_at - queued.received_at,
      overdue,
    };
    record.facts.status = "pass";
    record.boundary = "真实 herdr 0.9.5；P0/P2 目标与 4/6 秒均为真实墙钟，排队超期保留在 notification_audit。";
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("002", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-003 往返、重复观测、events_lost快照恢复与过时催促", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-003-");
  const dataDir = makeDataDir("003");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const fixture = createFixtureServer(root, "recovery", fixtureSnapshot([
    { label: "fixture-r", state: "working", sequence: 1 },
  ]));
  const resources = { root, dataDir, home, server: null, app: null, cdp: [], fixtures: [fixture] };
  const record = { case: "003", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  try {
    await fixture.start();
    record.facts.registration = registerFixture(fixture.socketPath, registryDir, root, "recovery");
    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);

    const latestId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const waitNewEvent = async (before, state) => waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = ?
      ORDER BY id ASC LIMIT 1
    `, [before, state])[0] ?? null, 8000, `${state} 事件`);

    const beforeBlocked = latestId();
    fixture.state.snapshot = fixtureSnapshot([
      { label: "fixture-r", state: "blocked", sequence: 2 },
    ]);
    fixture.status("pane-0", "blocked");
    const blocked = await waitNewEvent(beforeBlocked, "needs_attention");
    const blockedAck = await waitAck(dataDir, blocked.id, 8000);
    assert.equal(blockedAck.hold_until - blockedAck.acknowledged_at, 6000);
    let cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    const beforeText = await waitFor(async () => {
      const text = await cdp.page.locator('.card[data-channel="urgent"]').innerText();
      return text.includes("需要确认") ? text : null;
    }, 8000, "需要确认文本");
    assert.doesNotMatch(beforeText, /成功/);
    record.facts.blocked = { eventId: blocked.id, text: beforeText };

    /* 短暂往返：blocked 后立即 working；旧 P0 更新为已恢复，不新增催促。 */
    fixture.state.snapshot = fixtureSnapshot([
      { label: "fixture-r", state: "working", sequence: 3 },
    ]);
    fixture.status("pane-0", "working");
    await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = 'working'
      ORDER BY id ASC LIMIT 1
    `, [blocked.id])[0] ?? null, 8000, "working 往返");
    await waitFor(async () => {
      const text = await cdp.page.locator('.card[data-channel="urgent"]').innerText();
      return text.includes("曾需要确认，现已继续工作") ? text : null;
    }, 8000, "恢复文案");
    const recoveredBadge = await cdp.page.locator('.card[data-channel="urgent"] .badge').innerText();
    assert.equal(recoveredBadge, "状态回顾", "已恢复事件不能继续显示需要确认标题");
    const recoveredText = await cdp.page.locator('.card[data-channel="urgent"]').innerText();
    const urgentItems = await cdp.page.locator('.card[data-channel="urgent"] .item').count();
    assert.equal(urgentItems, 1, "同一 P0 事件只能有一个明细，不能重复气泡");
    /* 历史项仍在可见时按 eventId 核对历史语义，不依赖它在列表中的位置。 */
    const historicalItem = cdp.page.locator(
      `.card[data-channel="urgent"] .item[data-event-id="${blocked.id}"]`,
    );
    const historicalText = await waitFor(async () => {
      if (await historicalItem.count() === 0) return null;
      const text = await historicalItem.innerText();
      return text.includes("历史") && text.includes("现已继续工作") ? text : null;
    }, 5000, "历史项可见时的历史语义");
    const p0Events = queryDb(dataDir, `
      SELECT * FROM connector_events
      WHERE state = 'needs_attention' AND notification_status != 'none'
      ORDER BY id ASC
    `);
    assert.equal(p0Events.length, 1);
    assert.equal(queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM notification_presentation_items WHERE event_id = ?
    `, [blocked.id])[0].count, 1);
    record.facts.recovered = {
      badge: recoveredBadge, text: recoveredText, urgentItems, p0Events: p0Events.length,
      historicalText,
      historicalHold: ackRow(dataDir, blocked.id),
    };

    /* 重复传送同一观测：同一 episode 不再产生第二条气泡。 */
    const beforeReplay = latestId();
    fixture.status("pane-0", "working");
    await delay(900);
    const replayEvents = queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? ORDER BY id ASC
    `, [beforeReplay]);
    assert.deepEqual(
      replayEvents.filter((item) => item.kind === "observation").map((item) => item.state),
      ["working"],
    );
    assert.equal(queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE state = 'working' AND notification_status != 'none'
    `)[0].count, 1, "重复 working 不追加第二条真实变化通知");
    record.facts.replay = replayEvents;

    /* events_lost：transport 断档后重新订阅并做完整快照；新 blocked 事实
       必须进入气泡，旧事实不重复，也不留过时的“已恢复”。 */
    const beforeLost = latestId();
    const subscriptionsBefore = fixture.state.subscribeCount;
    fixture.state.snapshot = fixtureSnapshot([
      { label: "fixture-r", state: "blocked", sequence: 4 },
    ]);
    fixture.eventsLost();
    const resubscribed = await waitFor(() =>
      fixture.state.subscribeCount > subscriptionsBefore ? fixture.state.subscribeCount : null,
    8000, "events_lost 后重新订阅");
    const recoveredBlocked = await waitNewEvent(beforeLost, "needs_attention");
    /* 旧页可能已按 6 秒自然结束；按 eventId 读取当前催促与历史事实，
       不把 DOM 第几条当作固定业务身份。 */
    const currentItem = cdp.page.locator(
      `.card[data-channel="urgent"] .item[data-event-id="${recoveredBlocked.id}"]`,
    );
    const currentText = await waitFor(async () => {
      if (await currentItem.count() === 0) return null;
      const text = await currentItem.innerText();
      return text.includes("需要确认") && !text.includes("现已继续工作") ? text : null;
    }, 12000, "events_lost 后当前需要确认");
    const recoveredAck = await waitAck(dataDir, recoveredBlocked.id, 10000);
    const urgentCount = await cdp.page.locator('.card[data-channel="urgent"] .item').count();
    const urgentBadge = await cdp.page.locator('.card[data-channel="urgent"] .badge').innerText();
    assert.equal(urgentBadge, "需要确认", "再次 blocked 后必须回到当前需要确认");
    const historicalItemAfterLoss = cdp.page.locator(
      `.card[data-channel="urgent"] .item[data-event-id="${blocked.id}"]`,
    );
    const historicalStillRendered = await historicalItemAfterLoss.count() > 0;
    let historicalTextAfterLoss = null;
    if (historicalStillRendered) {
      historicalTextAfterLoss = await historicalItemAfterLoss.innerText();
      assert.match(historicalTextAfterLoss, /历史/);
      assert.doesNotMatch(historicalTextAfterLoss, /现已继续工作/,
        "再次 blocked 时旧历史项不得伪造已恢复");
    }
    const historicalRow = ackRow(dataDir, blocked.id);
    const lossObservedAt = Date.now();
    assert.equal(queryDb(dataDir,
      "SELECT historical FROM connector_events WHERE id = ?", [blocked.id])[0].historical,
    1, "旧 P0 仍应在账本中标记为历史");
    assert.equal(
      queryDb(dataDir, "SELECT COUNT(*) AS count FROM notification_presentation_items WHERE event_id = ?",
        [recoveredBlocked.id])[0].count,
      1,
    );
    record.facts.eventsLost = {
      subscribeCount: resubscribed,
      snapshotCount: fixture.state.snapshotCount,
      eventId: recoveredBlocked.id,
      ackAt: recoveredAck.acknowledged_at,
      text: currentText,
      urgentCount,
      badge: urgentBadge,
      historicalStillRendered,
      historicalText: historicalTextAfterLoss,
      historicalHoldUntil: historicalRow?.hold_until ?? null,
      lossObservedAt,
      historicalNaturallyExpired: historicalRow?.hold_until
        ? historicalRow.hold_until <= lossObservedAt : null,
    };
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "003-events-lost-current",
    ));

    /* 断连把当前 Agent 置 unknown；旧 needs_attention 不得再被说成“已继续”。 */
    await fixture.stop();
    const disconnected = await waitFor(async () => {
      const snapshot = await snapshotOf(page);
      const instance = snapshot.connectors.instances[0];
      return instance?.agents?.some((agent) => agent.state === "unknown") ? instance : null;
    }, 12000, "断连 unknown");
    const disconnectedBadge = await waitFor(async () => {
      const badge = await cdp.page.locator('.card[data-channel="urgent"] .badge').innerText();
      return badge === "状态未知" ? badge : null;
    }, 5000, "断连后状态未知徽标");
    const disconnectedText = await cdp.page.locator('.card[data-channel="urgent"]').innerText();
    assert.doesNotMatch(disconnectedText, /现已继续工作/,
      "断连 unknown 时不能继续显示已恢复");
    record.facts.disconnected = {
      instance: disconnected.instanceId,
      agents: disconnected.agents,
      badge: disconnectedBadge,
      text: disconnectedText,
    };
    record.facts.finalEvents = queryDb(dataDir,
      "SELECT id, state, historical, kind, notification_status FROM connector_events ORDER BY id");
    record.boundary = "同形受控 Unix fixture（正式 adapter/ledger/通知链路）；真实 Herdr 往返由 001/002 覆盖。";
  } catch (error) {
    try {
      record.facts.debug = {
        events: queryDb(dataDir, `
          SELECT id, kind, state, historical, notification_status FROM connector_events
          ORDER BY id
        `),
        items: allItems(dataDir),
        notifications: page ? notificationsOf(await snapshotOf(page)) : null,
      };
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("003", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-004 不可见不ack、子进程重建、暂停恢复与旧回执拒绝", {
  timeout: 150000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-004-");
  const dataDir = makeDataDir("004");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "004", facts: {}, screenshots: [], cleanupErrors: [] };
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const pane = createPane(resources.server, "s05j-004");
    reportAgent(resources.server, pane, "fixture-a", "working", 1);
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    resources.logs = launched.logs;
    const { page } = launched;
    await waitDesktop(page);
    await waitOnline(page);
    await waitNotificationWindow(page);

    const maxEventId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const triggerNotification = async (state, sequence) => {
      // Herdr 可能同时产生自己的生命周期事实；任一新的待通知事实都可验收。
      for (const [index, attempt] of [state, "idle", "working", "unknown"].entries()) {
        const before = maxEventId();
        reportAgent(resources.server, pane, "fixture-a", attempt, sequence + index);
        const row = await waitFor(() => queryDb(dataDir, `
          SELECT * FROM connector_events WHERE id > ? AND notification_status != 'none'
          ORDER BY id ASC LIMIT 1
        `, [before])[0] ?? null, 3000, `${attempt} 入队`).catch(() => null);
        if (row) return row;
      }
      throw new Error("真实 Herdr 未产生可通知的新事实");
    };
    const waitNewDesktop = async (previousPid) => waitFor(async () => {
      const snapshot = await snapshotOf(page);
      return snapshot.desktop.state === "running"
        && snapshot.desktop.pid
        && snapshot.desktop.pid !== previousPid
        ? snapshot : null;
    }, 20000, "子进程重建");

    /* 子进程退出期间事件已入账但窗口不存在；恢复后才允许 presented。 */
    const beforeKill = await snapshotOf(page);
    const firstPid = beforeKill.desktop.pid;
    process.kill(firstPid, "SIGKILL");
    const pendingEvent = await triggerNotification("blocked", 10);
    const ackWhileDown = ackRow(dataDir, pendingEvent.id);
    assert.equal(ackWhileDown?.acknowledged_at ?? null, null, "子进程重建期间不得回执不可见通知");
    const downView = notificationsOf(await snapshotOf(page));
    assert.notEqual(downView.window?.visible, true, "子进程退出后通知窗口不应仍报可见");
    record.facts.notReady = {
      eventId: pendingEvent.id,
      pendingBeforeWindow: pendingEvent.notification_status === "pending",
      ackWhileDown,
      windowVisible: downView.window?.visible ?? null,
    };
    const restored = await waitNewDesktop(firstPid);
    const restoredAck = await waitAck(dataDir, pendingEvent.id, 12000);
    const restoredWindow = await waitNotificationWindow(page);
    assert.ok(restoredAck.acknowledged_at >= restoredWindow.window.shownAt,
      "presented 必须发生在真实窗口显示之后");
    record.facts.restoredAfterCrash = {
      pid: restored.desktop.pid,
      shownAt: restoredWindow.window.shownAt,
      acknowledgedAt: restoredAck.acknowledged_at,
      delayAfterShownMs: restoredAck.acknowledged_at - restoredWindow.window.shownAt,
    };
    record.screenshots.push(captureNotification(restoredWindow.window, "004-restored-after-crash"));

    /* 已展示事件在再次重建后保持同一呈现，不重复 ack 或追加事件。 */
    const panelBefore = restoredWindow.panels.find(
      (item) => (item.eventIds ?? []).includes(pendingEvent.id),
    );
    assert.ok(panelBefore, "恢复后应有该事件的呈现");
    const rowsBefore = allItems(dataDir);
    const eventCountBefore = queryDb(dataDir,
      "SELECT COUNT(*) AS count FROM connector_events")[0].count;
    process.kill(restored.desktop.pid, "SIGKILL");
    const rebuilt = await waitNewDesktop(restored.desktop.pid);
    const samePanel = await waitFor(async () => {
      const panels = notificationsOf(await snapshotOf(page)).panels;
      return panels.find((item) => item.presentationId === panelBefore.presentationId) ?? null;
    }, 15000, "同一呈现恢复");
    await delay(600);
    const rowsAfter = allItems(dataDir);
    assert.equal(rowsAfter.length, rowsBefore.length, "已展示内容不得重复回执");
    assert.equal(new Set(rowsAfter.map((row) => row.event_id)).size, rowsAfter.length,
      "同一事件不得追加第二条呈现项");
    for (const beforeRow of rowsBefore.filter((row) => row.acknowledged_at)) {
      const afterRow = rowsAfter.find((row) => row.event_id === beforeRow.event_id);
      assert.ok(afterRow);
      assert.equal(afterRow.acknowledged_at, beforeRow.acknowledged_at, "回执时间不得重复");
      assert.ok(afterRow.hold_until >= beforeRow.hold_until,
        "重建期间未走完的阅读时间只能顺延，不能压缩");
    }
    assert.equal(
      queryDb(dataDir, "SELECT COUNT(*) AS count FROM connector_events")[0].count,
      eventCountBefore,
    );
    assert.equal(samePanel.presentationId, panelBefore.presentationId);
    record.facts.rebuild = {
      pid: rebuilt.desktop.pid,
      presentationId: samePanel.presentationId,
      acknowledgedAt: ackRow(dataDir, pendingEvent.id).acknowledged_at,
      ackRowsUnchanged: rowsAfter.length === rowsBefore.length,
    };
    await waitNotificationWindow(page);

    /* 锁屏/睡眠：窗口隐藏时不 ack；解锁后按同一 pending 事实补显示。 */
    await page.evaluate(() => window.bayper.getSystemStatus());
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(page)).system.paused === true, 5000, "系统暂停");
    const pausedEvent = await triggerNotification("blocked", 20);
    const hiddenView = await waitFor(async () => {
      const view = notificationsOf(await snapshotOf(page));
      return view.window?.actualVisible === false ? view : null;
    }, 5000, "锁屏期间真实通知窗口未隐藏");
    await delay(500);
    const pausedRow = ackRow(dataDir, pausedEvent.id);
    const pausedView = notificationsOf(await snapshotOf(page));
    assert.equal(pausedRow?.acknowledged_at ?? null, null, "锁屏期间不得回执不可见通知");
    assert.notEqual(pausedView.window?.visible, true, "锁屏期间通知窗口必须隐藏");
    assert.equal(
      pausedView.window?.actualVisible,
      false,
      "锁屏期间真实 BrowserWindow.isVisible 必须为 false",
    );
    assert.equal(hiddenView.window.actualVisible, false);
    assert.equal(
      queryDb(dataDir, "SELECT notification_status FROM connector_events WHERE id = ?",
        [pausedEvent.id])[0].notification_status,
      "pending",
    );
    const unlockedAt = Date.now();
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const resumedAck = await waitAck(dataDir, pausedEvent.id, 10000);
    const resumedView = await waitNotificationWindow(page);
    assert.ok(resumedAck.acknowledged_at >= resumedView.window.shownAt);
    assert.ok(resumedAck.acknowledged_at >= unlockedAt);
    record.facts.paused = {
      eventId: pausedEvent.id,
      ackBeforeUnlock: pausedRow,
      windowVisible: pausedView.window?.visible ?? null,
      unlockedAt,
      shownAt: resumedView.window.shownAt,
      acknowledgedAt: resumedAck.acknowledged_at,
      holdMs: resumedAck.hold_until - resumedAck.acknowledged_at,
    };
    record.screenshots.push(captureNotification(resumedView.window, "004-resumed-after-lock"));

    /* ack 后仅 1 秒就锁屏且超过原 hold：恢复后必须保留剩余可读时间，
       不能按墙钟直接判定阅读结束。 */
    await delay(1000);
    const beforeHoldRow = ackRow(dataDir, pausedEvent.id);
    assert.ok(beforeHoldRow?.acknowledged_at);
    const lockedAgainAt = Date.now();
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(page)).system.paused === true, 5000, "再次锁屏");
    await delay(7000);
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const unlockedAgainAt = Date.now();
    const afterHoldRow = await waitFor(() => {
      const row = ackRow(dataDir, pausedEvent.id);
      return row?.hold_until > beforeHoldRow.hold_until ? row : null;
    }, 8000, "恢复后顺延阅读时间");
    assert.ok(
      afterHoldRow.hold_until >= beforeHoldRow.hold_until + 6000,
      `锁屏 7 秒后 hold 应顺延，原 ${beforeHoldRow.hold_until}，现 ${afterHoldRow.hold_until}`,
    );
    const stillVisible = await waitFor(async () => {
      const panels = notificationsOf(await snapshotOf(page)).panels;
      return panels.find((item) => (item.eventIds ?? []).includes(pausedEvent.id)) ?? null;
    }, 8000, "恢复后仍保留未走完的阅读");
    const heldClosed = await waitFor(() => {
      const row = queryDb(dataDir, `
        SELECT state, closed_at FROM notification_presentations
        WHERE presentation_id = ? AND state = 'closed'
      `, [stillVisible.presentationId])[0];
      return row ?? null;
    }, 12000, "顺延阅读结束");
    assert.ok(heldClosed.closed_at >= afterHoldRow.hold_until, "不得早于顺延后的 hold 关闭");
    const visibleMs = (lockedAgainAt - beforeHoldRow.acknowledged_at)
      + (heldClosed.closed_at - unlockedAgainAt);
    const readingMs = beforeHoldRow.hold_until - beforeHoldRow.acknowledged_at;
    record.facts.readingHold = {
      acknowledgedAt: beforeHoldRow.acknowledged_at,
      holdBefore: beforeHoldRow.hold_until,
      lockedAgainAt,
      unlockedAgainAt,
      holdAfter: afterHoldRow.hold_until,
      closedAt: heldClosed.closed_at,
      extensionMs: afterHoldRow.hold_until - beforeHoldRow.hold_until,
      readingMs,
      visibleMs,
    };
    // 进程暂停/恢复通知有几十毫秒事件循环延迟；允许 500ms 的边界误差。
    assert.ok(visibleMs >= readingMs - 500,
      `累计可见 ${visibleMs}ms 应接近完整阅读 ${readingMs}ms`);

    /* 旧 token/旧代次/越界事件的迟到回执必须拒绝。 */
    const view = {
      token: 9,
      generation: "gen-current",
      presentations: [{
        presentationId: "p-1",
        items: [{ eventId: 1 }, { eventId: 2 }],
      }],
    };
    const cases = {
      oldToken: validateNotificationAck(view, {
        token: 8, generation: "gen-current", presentationId: "p-1", eventIds: [1],
      }),
      oldGeneration: validateNotificationAck(view, {
        token: 9, generation: "gen-old", presentationId: "p-1", eventIds: [1],
      }),
      wrongPresentation: validateNotificationAck(view, {
        token: 9, generation: "gen-current", presentationId: "p-x", eventIds: [1],
      }),
      outsideEvent: validateNotificationAck(view, {
        token: 9, generation: "gen-current", presentationId: "p-1", eventIds: [3],
      }),
      duplicateIds: validateNotificationAck(view, {
        token: 9, generation: "gen-current", presentationId: "p-1", eventIds: [1, 1],
      }),
      valid: validateNotificationAck(view, {
        token: 9, generation: "gen-current", presentationId: "p-1", eventIds: [1, 2],
      }),
      closeOldToken: validateNotificationClose(view, {
        token: 8, generation: "gen-current", presentationId: "p-1",
      }),
      closeValid: validateNotificationClose(view, {
        token: 9, generation: "gen-current", presentationId: "p-1",
      }),
    };
    assert.deepEqual(cases, {
      oldToken: false,
      oldGeneration: false,
      wrongPresentation: false,
      outsideEvent: false,
      duplicateIds: false,
      valid: true,
      closeOldToken: false,
      closeValid: true,
    });
    record.facts.lateAck = cases;

    /* 真实退出：先关闭应用，再核对无残留进程、无未关闭呈现且 SQLite 完整。 */
    const exit = await closeApp(resources.app);
    resources.app = null;
    record.appExits = [exit];
    assert.equal(exit.status, "exited");
    await delay(600);
    const leftovers = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(dataDir));
    assert.deepEqual(leftovers, [], "退出后不得残留应用或画布进程");
    const openPresentations = queryDb(dataDir,
      "SELECT COUNT(*) AS count FROM notification_presentations WHERE state IN ('offered','visible')",
    )[0].count;
    assert.equal(openPresentations, 0, "退出后不得留下未关闭呈现");
    const integrity = queryDb(dataDir, "PRAGMA integrity_check")[0].integrity_check;
    assert.equal(integrity, "ok");
    record.facts.exit = {
      status: exit.status,
      leftovers,
      openPresentations,
      integrity,
      totalPresentationRows: queryDb(dataDir,
        "SELECT COUNT(*) AS count FROM notification_presentations")[0].count,
      totalItemRows: allItems(dataDir).length,
    };
    record.boundary = "真实 herdr 0.9.5 + 真实 Electron；旧回执拒绝用生产校验函数验证。";
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    const cleanupExits = await teardown(resources, record.cleanupErrors);
    record.appExits = [...(record.appExits ?? []), ...cleanupExits];
    writeCase("004", record, [root, dataDir, home]);
  }
});

function rectsIntersect(left, right) {
  return Boolean(left && right
    && left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height);
}

test("POL-NOTIFY-UI-005 边缘位置、超量明细、主动收起与聊天/角色不被打断", {
  timeout: 180000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-005-");
  const dataDir = makeDataDir("005");
  writeAppState(dataDir, "desktop_position", JSON.stringify({ x: 99999, y: 99999 }));
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "005", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  let cdp = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const panes = [];
    for (let index = 0; index < 14; index += 1) {
      const pane = createPane(resources.server, `s05j-005-${index}`);
      reportAgent(resources.server, pane, `fixture-${index}`, "working", 1);
      panes.push(pane);
    }
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    resources.logs = launched.logs;
    page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);
    const characterBounds = await waitFor(async () => {
      const snapshot = await snapshotOf(page);
      return snapshot.desktop.displayedKind === "character"
        && snapshot.desktop.bounds?.width <= 128
        ? snapshot.desktop.bounds : null;
    }, 10000, "角色窗口稳定");
    assert.ok(characterBounds.width <= 128 && characterBounds.height <= 128, "角色本体应约 128pt");

    const chat = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chat.ok, true);
    const chatSnapshot = await snapshotOf(page);
    assert.equal(chatSnapshot.companionship.current.mode, "interacting");
    record.facts.chat = { opened: chat.ok, mode: chatSnapshot.companionship.current.mode };

    const blockedIds = [];
    for (let index = 0; index < 6; index += 1) {
      const before = queryDb(dataDir,
        "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
      reportAgent(resources.server, panes[index], `fixture-${index}`, "blocked", 10);
      const row = await waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
        ORDER BY id ASC LIMIT 1
      `, [before])[0] ?? null, 8000, `阻塞 ${index}`);
      blockedIds.push(row.id);
    }
    const urgent = await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel && panel.itemCount >= 6 ? panel : null;
    }, 15000, "6 条加急明细");
    cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    // 短名首屏需等窗口按探针展开、容量锁定后再读取；原三条断言保持不变。
    await waitFor(() => cdp.page.locator('.card[data-channel="urgent"] .item')
      .count().then((count) => count === 3), 5000, "首屏容量稳定").catch(() => null);
    const firstPageIds = await cdp.page.locator('.card[data-channel="urgent"] .item')
      .evaluateAll((rows) => rows.map((row) => row.dataset.eventId));
    assert.equal(firstPageIds.length, 3, "首屏只渲染一页三条");
    assert.deepEqual(firstPageIds, blockedIds.slice(0, 3).map(String));
    const moreText = await cdp.page.locator('.card[data-channel="urgent"] .more').innerText();
    assert.match(moreText, /后续 3 条将自动显示/);
    await waitFor(() => blockedIds.slice(0, 3).every(
      (id) => ackRow(dataDir, id)?.acknowledged_at,
    ), 8000, "首屏三条回执");
    const ackedOpacity = await cdp.page.locator('.card[data-channel="urgent"] .item')
      .first().evaluate((element) => getComputedStyle(element).opacity);
    assert.equal(ackedOpacity, "1", "回执后的 6 秒阅读期不得整体淡化正文");
    const hiddenPending = blockedIds.slice(3);
    for (const id of hiddenPending) {
      assert.equal(ackRow(dataDir, id)?.acknowledged_at ?? null, null,
        "未进入可视区域的条目不得回执");
      assert.equal(queryDb(dataDir, "SELECT notification_status FROM connector_events WHERE id = ?",
        [id])[0].notification_status, "pending");
    }

    const windowFact = (await snapshotOf(page)).desktop.notifications.window;
    const workArea = await launched.app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    );
    assert.ok(windowFact.bounds.x >= workArea.x
      && windowFact.bounds.y >= workArea.y
      && windowFact.bounds.x + windowFact.bounds.width <= workArea.x + workArea.width
      && windowFact.bounds.y + windowFact.bounds.height <= workArea.y + workArea.height,
    "通知窗口必须位于工作区内");
    assert.equal(rectsIntersect(windowFact.bounds, characterBounds), false, "气泡不得遮挡角色");
    assert.equal(windowFact.focusable, false, "通知窗口不得可聚焦");
    const desktopNow = (await snapshotOf(page)).desktop;
    assert.deepEqual(desktopNow.bounds, characterBounds, "通知不得改变角色窗口尺寸/位置");
    assert.equal(desktopNow.focusable, false);
    assert.equal(desktopNow.activationPolicy, "prohibited");
    record.facts.geometry = {
      activationPolicy: desktopNow.activationPolicy,
      workArea,
      window: windowFact.bounds,
      character: characterBounds,
      notificationFocusable: windowFact.focusable,
    };
    record.screenshots.push(captureNotification(windowFact, "005-auto-page-1"));

    /* 无需展开：第一页各自 6 秒结束后自动推进第二页。 */
    const firstHoldMax = Math.max(...blockedIds.slice(0, 3)
      .map((id) => ackRow(dataDir, id).hold_until));
    await waitFor(() => blockedIds.slice(3).every(
      (id) => ackRow(dataDir, id)?.acknowledged_at,
    ), 16000, "第二页自动显示并回执");
    const secondPageIds = await cdp.page.locator('.card[data-channel="urgent"] .item')
      .evaluateAll((rows) => rows.map((row) => row.dataset.eventId));
    assert.deepEqual(secondPageIds, blockedIds.slice(3).map(String));
    assert.equal(await cdp.page.locator('.card[data-channel="urgent"] .more').isHidden(), true,
      "最后一页不再显示后续明细按钮");
    const secondAckMin = Math.min(...blockedIds.slice(3)
      .map((id) => ackRow(dataDir, id).acknowledged_at));
    assert.ok(secondAckMin >= firstHoldMax, "第二页必须在第一页阅读时间结束后才出现");
    for (const id of blockedIds) {
      assert.equal(ackRow(dataDir, id).hold_until - ackRow(dataDir, id).acknowledged_at, 6000);
    }
    const detailFacts = await cdp.page.evaluate(() => ({
      innerHeight: window.innerHeight,
      cards: [...document.querySelectorAll(".card")].map((card) => ({
        channel: card.dataset.channel,
        rect: card.getBoundingClientRect().toJSON(),
        meanings: [...card.querySelectorAll(".item-meaning")].map((item) => {
          const rect = item.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom,
            clipped: item.scrollHeight > item.clientHeight + 1 };
        }),
      })),
    }));
    for (const card of detailFacts.cards) {
      assert.ok(card.rect.top >= -0.5 && card.rect.bottom <= detailFacts.innerHeight + 0.5,
        `${card.channel} 卡片必须在窗口内`);
      for (const meaning of card.meanings) {
        assert.equal(meaning.clipped, false, "状态含义文字不得被裁切");
        assert.ok(meaning.top >= 0 && meaning.bottom <= detailFacts.innerHeight + 0.5);
      }
    }
    record.facts.detail = {
      ackedOpacity,
      firstPageIds,
      secondPageIds,
      moreText,
      hiddenPending: hiddenPending.length,
      firstHoldMax,
      secondAckMin,
      detailFacts,
    };
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "005-auto-page-2",
    ));

    await waitFor(async () => !notificationsOf(await snapshotOf(page)).panels
      .some((item) => item.channel === "urgent"), 12000, "第一批加急阅读结束");
    const secondBefore = [];
    for (let index = 8; index < 14; index += 1) {
      const before = queryDb(dataDir,
        "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
      reportAgent(resources.server, panes[index], `fixture-${index}`, "blocked", 10);
      const row = await waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
        ORDER BY id ASC LIMIT 1
      `, [before])[0] ?? null, 8000, `第二批阻塞 ${index}`);
      secondBefore.push(row.id);
    }
    const secondPanel = await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel && panel.itemCount >= 6 ? panel : null;
    }, 15000, "第二批加急");
    await waitFor(() => secondBefore.filter(
      (id) => ackRow(dataDir, id)?.acknowledged_at,
    ).length === 3, 8000, "第二批默认可见回执");
    const secondRendered = secondBefore.filter((id) => ackRow(dataDir, id)?.acknowledged_at);
    const secondHidden = secondBefore.filter((id) => !secondRendered.includes(id));
    assert.equal(secondHidden.length, 3);

    /* 锁屏使父进程停止推进；在真实收起按钮上触发正式 closePresentation。
       未渲染的三条必须保持 pending，恢复后重新显示。 */
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(page)).system.paused === true, 5000, "锁屏");
    // 窗口隐藏时直接用通知接口补一条隐藏项回执，必须被父/子两侧拒绝。
    const hiddenId = secondHidden[0];
    const hiddenToken = notificationsOf(await snapshotOf(page)).token;
    await cdp.page.evaluate(({ presentationId, token, eventId }) => {
      window.notifications.ack(presentationId, token, [eventId]);
    }, { presentationId: secondPanel.presentationId, token: hiddenToken, eventId: hiddenId });
    await delay(400);
    assert.equal(ackRow(dataDir, hiddenId)?.acknowledged_at ?? null, null,
      "窗口隐藏时的回执必须被拒绝");
    await cdp.page.locator('.card[data-channel="urgent"] .close').evaluate(
      (element) => element.click(),
    );
    const closed = await waitFor(() => queryDb(dataDir, `
      SELECT closed_at, close_reason FROM notification_presentations
      WHERE presentation_id = ? AND state = 'closed'
    `, [secondPanel.presentationId])[0] ?? null, 5000, "主动收起");
    for (const id of secondHidden) {
      assert.equal(ackRow(dataDir, id)?.acknowledged_at ?? null, null,
        "主动收起不得把隐藏明细标为已读");
      assert.equal(queryDb(dataDir, "SELECT notification_status FROM connector_events WHERE id = ?",
        [id])[0].notification_status, "pending");
    }
    assert.equal(closed.close_reason, "USER_CLOSED");
    for (const id of secondRendered) {
      assert.ok(ackRow(dataDir, id)?.acknowledged_at, "已真实展示的内容保持已读");
    }
    record.facts.activeClose = {
      presentationId: secondPanel.presentationId,
      closeReason: closed.close_reason,
      rendered: secondRendered.length,
      hiddenPending: secondHidden.length,
    };

    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const recoveredPanel = await waitFor(async () => {
      const panels = notificationsOf(await snapshotOf(page)).panels
        .filter((item) => item.channel === "urgent");
      return panels.find((item) => item.presentationId !== secondPanel.presentationId)
        ?? null;
    }, 15000, "收起后未读恢复");
    assert.ok(secondHidden.every((id) => (recoveredPanel.eventIds ?? []).includes(id)));
    await waitFor(() => secondHidden.every((id) => ackRow(dataDir, id)?.acknowledged_at),
      10000, "恢复后重新显示并回执");
    const chatAfter = await snapshotOf(page);
    assert.equal(chatAfter.companionship.current.mode, "interacting", "通知与收起不得关闭聊天");
    const finalDesktop = chatAfter.desktop;
    assert.deepEqual(finalDesktop.bounds, characterBounds, "角色窗口保持 128pt 原尺寸");
    record.facts.recovery = {
      presentationId: recoveredPanel.presentationId,
      events: recoveredPanel.eventIds,
      chatMode: chatAfter.companionship.current.mode,
      characterBounds: finalDesktop.bounds,
    };
    record.boundary = "真实 herdr 0.9.5、真实管理窗口与通知 panel；小屏以实际工作区约束和滚动列表验证。";
  } catch (error) {
    try {
      record.facts.debug = {
        items: allItems(dataDir),
        events: queryDb(dataDir, `
          SELECT id, state, notification_status, agent_id FROM connector_events ORDER BY id
        `),
        notifications: page ? notificationsOf(await snapshotOf(page)) : null,
        renderedText: cdp ? await cdp.page.locator("#stack").innerText() : null,
        rects: cdp ? await cdp.page.evaluate(() => {
          const list = document.querySelector('.card[data-channel="urgent"] .items');
          const listRect = list?.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        stack: document.getElementById("stack").getBoundingClientRect().toJSON(),
        stackStyle: document.getElementById("stack").getAttribute("style"),
        stackComputed: (() => {
          const style = getComputedStyle(document.getElementById("stack"));
          return { position: style.position, height: style.height, inset: style.inset,
            top: style.top, bottom: style.bottom, minHeight: style.minHeight,
            display: style.display, overflow: style.overflow };
        })(),
        bodyStyle: document.body.getAttribute("style"),
        bodyRect: document.body.getBoundingClientRect().toJSON(),
        htmlRect: document.documentElement.getBoundingClientRect().toJSON(),
            list: listRect ? { ...listRect.toJSON(), scrollTop: list.scrollTop,
              scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
            items: [...document.querySelectorAll('.card[data-channel="urgent"] .item')]
              .map((el) => ({ id: el.dataset.eventId, ack: el.dataset.ack,
                rect: el.getBoundingClientRect().toJSON() })),
          };
        }) : null,
        logs: (resources.logs ?? []).slice(-40),
      };
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("005", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-006 旧token拒绝后重试、暂时写入失败恢复且只presented一次", {
  timeout: 150000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-006-");
  const dataDir = makeDataDir("006");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "006", facts: {}, screenshots: [], cleanupErrors: [] };
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const panes = [];
    for (let index = 0; index < 3; index += 1) {
      const pane = createPane(resources.server, `s05j-006-${index}`);
      reportAgent(resources.server, pane, `fixture-${index}`, "working", 1);
      panes.push(pane);
    }
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {
      BAYPER_NOTIFICATION_ACK_DELAY_MS: "3000",
    });
    resources.app = launched.app;
    const { page } = launched;
    await waitDesktop(page);
    await waitOnline(page);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "启动通知阅读结束");

    const maxId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const triggerBlocked = async (pane, agent, sequence, before) => {
      reportAgent(resources.server, pane, agent, "blocked", sequence);
      return waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
        ORDER BY id ASC LIMIT 1
      `, [before])[0] ?? null, 8000, `${agent} blocked`);
    };

    /* 旧 token：首条已可见后立刻追加第二条 P0，首条延迟转发会被拒绝，
       renderer 收到结果后用当前 token 重试，仍只 presented 一次。 */
    const beforeA = maxId();
    const eventA = await triggerBlocked(panes[0], "fixture-0", 10, beforeA);
    await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel?.renderedEventIds?.includes(eventA.id) ? panel : null;
    }, 8000, "首条可见");
    // 等首条回执已由 renderer 发送并停在延迟通道，再追加 P0 改变视图 token。
    await delay(700);
    const beforeB = maxId();
    await triggerBlocked(panes[1], "fixture-1", 10, beforeB);
    await waitAck(dataDir, eventA.id, 18000);
    const rowsA = queryDb(dataDir, `
      SELECT presentation_id, event_id, acknowledged_at FROM notification_presentation_items
      WHERE event_id = ?
    `, [eventA.id]);
    assert.equal(rowsA.length, 1, "同一事件只能有一条呈现项");
    assert.equal(queryDb(dataDir,
      "SELECT notification_status FROM connector_events WHERE id = ?",
      [eventA.id])[0].notification_status, "presented");
    const statsAfterToken = (await snapshotOf(page)).desktop.notifications.ackStats;
    assert.ok(statsAfterToken.rejected >= 1, "旧 token 回执必须被拒绝");
    assert.ok(statsAfterToken.accepted >= 1, "新 token 重试必须成功");
    record.facts.tokenRetry = {
      eventA: eventA.id,
      rows: rowsA,
      stats: statsAfterToken,
    };

    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "006-retry-presented",
    ));
    record.boundary = "真实 herdr 0.9.5 + 真实 renderer；延迟转发为受控测试故障。";
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    try { execDb(dataDir, "DROP TRIGGER IF EXISTS s05j_fail_ack"); } catch { /* 已删除。 */ }
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("006", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-007 暂时SQLite写入失败后同事件重试且只presented一次", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-007-");
  const dataDir = makeDataDir("007");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "007", facts: {}, screenshots: [], cleanupErrors: [] };
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const pane = createPane(resources.server, "s05j-007");
    reportAgent(resources.server, pane, "fixture-0", "working", 1);
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    const { page } = launched;
    await waitDesktop(page);
    await waitOnline(page);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "启动通知阅读结束");

    const before = queryDb(dataDir,
      "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    execDb(dataDir, `
      CREATE TRIGGER s05j_fail_ack BEFORE UPDATE ON notification_presentation_items
      WHEN NEW.acknowledged_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 's05j forced ack failure'); END;
    `);
    reportAgent(resources.server, pane, "fixture-0", "blocked", 10);
    const event = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
      ORDER BY id ASC LIMIT 1
    `, [before])[0] ?? null, 8000, "阻塞入账");
    const firstRejected = await waitFor(async () => {
      const notifications = notificationsOf(await snapshotOf(page));
      return notifications.ackStats?.rejected >= 5 ? notifications.ackStats : null;
    }, 20000, "五次回执被拒");
    assert.equal(ackRow(dataDir, event.id)?.acknowledged_at ?? null, null);
    assert.equal(queryDb(dataDir,
      "SELECT notification_status FROM connector_events WHERE id = ?",
      [event.id])[0].notification_status, "pending");
    execDb(dataDir, "DROP TRIGGER s05j_fail_ack");
    // 不追加任何新业务事件；等待有上限的间隔自动恢复同一 pending 事件。
    await waitAck(dataDir, event.id, 10000);
    const rows = queryDb(dataDir, `
      SELECT presentation_id, event_id, acknowledged_at, hold_until
      FROM notification_presentation_items WHERE event_id = ?
    `, [event.id]);
    assert.equal(rows.length, 1, "重试不能追加第二条呈现项");
    assert.equal(queryDb(dataDir,
      "SELECT notification_status FROM connector_events WHERE id = ?",
      [event.id])[0].notification_status, "presented");
    const stats = (await snapshotOf(page)).desktop.notifications.ackStats;
    assert.ok(stats.rejected >= firstRejected.rejected);
    assert.ok(stats.accepted >= 1);
    assert.equal(queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE id > ? AND notification_status != 'none'
    `, [before])[0].count, 1, "恢复不得依赖新业务事件");
    record.facts.writeFailure = {
      event: event.id, rows, firstRejected, finalStats: stats,
      eventsWithoutNewToken: 1,
    };
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "007-write-failure-retry",
    ));
    record.boundary = "真实 herdr 0.9.5 + 真实 renderer；SQLite 触发器为受控测试故障。";
  } catch (error) {
    record.failure = error;
    throw error;
  } finally {
    try { execDb(dataDir, "DROP TRIGGER IF EXISTS s05j_fail_ack"); } catch { /* 已删除。 */ }
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("007", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-008 锁屏后迟到的shown(true)不能解除阅读冻结", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-008-");
  const dataDir = makeDataDir("008");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "008", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  let cdp = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const pane = createPane(resources.server, "s05j-008");
    reportAgent(resources.server, pane, "fixture-0", "working", 1);
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {
      BAYPER_NOTIFICATION_SHOWN_DELAY_MS: "1500",
    });
    resources.app = launched.app;
    resources.logs = launched.logs;
    page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "启动通知阅读结束");

    const before = queryDb(dataDir,
      "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    reportAgent(resources.server, pane, "fixture-0", "blocked", 10);
    const event = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
      ORDER BY id ASC LIMIT 1
    `, [before])[0] ?? null, 8000, "P0 入账");
    const ack = await waitAck(dataDir, event.id, 8000);
    assert.equal(ack.hold_until - ack.acknowledged_at, 6000);
    cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    // 触发一次晚到的可见回报，并在它到达前锁屏。
    await cdp.page.evaluate(() => window.notifications.resize(300));
    await delay(120);
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(page)).system.paused === true, 5000, "锁屏");
    await delay(1800);
    const pausedView = notificationsOf(await snapshotOf(page));
    assert.equal(pausedView.window?.visible, false,
      "暂停期间迟到的 shown(true) 不得把窗口状态改回可见");
    assert.equal(ackRow(dataDir, event.id).hold_until, ack.hold_until,
      "暂停中不得提前 resume 顺延阅读时间");
    const lockedAt = Date.now();
    await delay(5200);
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const unlockedAt = Date.now();
    const after = await waitFor(() => {
      const row = ackRow(dataDir, event.id);
      return row?.hold_until > ack.hold_until ? row : null;
    }, 8000, "解锁后统一顺延");
    assert.ok(after.hold_until >= ack.hold_until + 6000,
      `锁屏约 7 秒应整体顺延，原 ${ack.hold_until}，现 ${after.hold_until}`);
    const stillPanel = await waitFor(async () => {
      const panels = notificationsOf(await snapshotOf(page)).panels;
      return panels.find((item) => (item.eventIds ?? []).includes(event.id)) ?? null;
    }, 8000, "恢复后仍呈现");
    const closed = await waitFor(() => queryDb(dataDir, `
      SELECT closed_at FROM notification_presentations
      WHERE presentation_id = ? AND state = 'closed'
    `, [stillPanel.presentationId])[0] ?? null, 10000, "阅读结束");
    assert.ok(closed.closed_at >= after.hold_until);
    record.facts.lateShown = {
      event: event.id,
      holdBefore: ack.hold_until,
      pausedWindowVisible: pausedView.window?.visible ?? null,
      lockedAt,
      unlockedAt,
      holdAfter: after.hold_until,
      closedAt: closed.closed_at,
      extensionMs: after.hold_until - ack.hold_until,
    };
    record.boundary = "真实 herdr 0.9.5；shown(true) 延迟 1.5 秒为受控测试时序。";
  } catch (error) {
    record.facts.logs = (resources.logs ?? []).slice(-40);
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("008", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-009 完全无角色时必需通知仍显示并回执", {
  timeout: 120000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-009-");
  const dataDir = fs.mkdtempSync("/tmp/bayper-s05j-009-data-");
  createLegacyDatabase(dataDir, {
    characters: [],
    modelCipher: Buffer.from("s05j-fixture-cipher"),
    baseUrl: "https://127.0.0.1:1/v1",
    modelName: "s05j-unreachable",
  });
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "009", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const pane = createPane(resources.server, "s05j-009");
    reportAgent(resources.server, pane, "fixture-no-character", "working", 1);
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {}, { waitHome: false });
    resources.app = launched.app;
    resources.logs = launched.logs;
    page = launched.page;
    await waitOnline(page);
    const before = queryDb(dataDir,
      "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    reportAgent(resources.server, pane, "fixture-no-character", "blocked", 10);
    const event = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
      ORDER BY id ASC LIMIT 1
    `, [before])[0] ?? null, 8000, "无角色 P0 入账");
    const window = await waitNotificationWindow(page);
    const snapshot = await snapshotOf(page);
    assert.equal(snapshot.state === "accepted", false);
    assert.equal(snapshot.desktop.characterId ?? null, null);
    assert.notEqual(snapshot.desktop.assetState, "ready");
    const cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    const text = await waitFor(async () => {
      const body = await cdp.page.locator("#stack").innerText();
      return body.includes("需要确认") && body.includes("fixture-no-character") ? body : null;
    }, 8000, "无角色通知文本");
    const ack = await waitAck(dataDir, event.id, 8000);
    assert.equal(ack.hold_until - ack.acknowledged_at, 6000);
    assert.equal(queryDb(dataDir,
      "SELECT notification_status FROM connector_events WHERE id = ?",
      [event.id])[0].notification_status, "presented");
    record.screenshots.push(captureNotification(window.window, "009-no-character"));
    record.facts.noCharacter = {
      onboarding: snapshot.state,
      desktopState: snapshot.desktop.state,
      characterId: snapshot.desktop.characterId ?? null,
      assetState: snapshot.desktop.assetState,
      window: window.window,
      text,
      ack,
    };
    record.boundary = "真实 herdr 0.9.5；数据目录无已接纳角色。";
  } catch (error) {
    record.facts.logs = (resources.logs ?? []).slice(-40);
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("009", record, [root, dataDir, home]);
  }
});

const LONG_AGENT = (index) =>
  `agent-with-a-very-long-name-${String(index).padStart(2, "0")}-xxxxxxxxxxxxxxxx`;

/* 真实通知 DOM 的几何快照：不点击、不滚动，只读。 */
async function sampleNotificationGeometry(cdpPage) {
  const requestStartedAt = Date.now();
  const sample = await cdpPage.evaluate(() => {
    const sampledAt = Date.now();
    const urgent = document.querySelector('.card[data-channel="urgent"]');
    const list = urgent?.querySelector(".items") ?? null;
    const listRect = list?.getBoundingClientRect() ?? null;
    const clipBottom = Math.min(listRect?.bottom ?? 0, window.innerHeight);
    return {
      sampledAt,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      urgentRect: urgent?.getBoundingClientRect().toJSON() ?? null,
      list: list ? {
        rect: listRect.toJSON(),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      } : null,
      rows: urgent ? [...urgent.querySelectorAll(".item")].map((row) => {
        const source = row.querySelector(".item-source");
        const meaning = row.querySelector(".item-meaning");
        const rowRect = row.getBoundingClientRect();
        const sourceRect = source.getBoundingClientRect();
        const meaningRect = meaning.getBoundingClientRect();
        const sourceClipped = source.scrollHeight > source.clientHeight + 1;
        const meaningClipped = meaning.scrollHeight > meaning.clientHeight + 1;
        const fullyVisible = sourceRect.top >= (listRect?.top ?? 0) - 0.5
          && sourceRect.top >= -0.5
          && sourceRect.bottom <= clipBottom + 0.5
          && meaningRect.bottom <= clipBottom + 0.5
          && sourceRect.left >= -0.5
          && meaningRect.right <= window.innerWidth + 0.5;
        const clipReasons = [];
        if (sourceClipped) clipReasons.push("source-overflow");
        if (meaningClipped) clipReasons.push("meaning-overflow");
        if (!fullyVisible) clipReasons.push("outside-window-or-list");
        return {
          eventId: row.dataset.eventId,
          ack: row.dataset.ack,
          source: source.textContent,
          meaning: meaning.textContent,
          rowRect: rowRect.toJSON(),
          sourceRect: sourceRect.toJSON(),
          meaningRect: meaningRect.toJSON(),
          sourceClipped,
          meaningClipped,
          fullyVisible,
          clipped: sourceClipped || meaningClipped || !fullyVisible,
          clipReasons,
        };
      }) : [],
      layout: urgent ? (() => {
        const stackEl = document.getElementById("stack");
        const stackStyle = getComputedStyle(stackEl);
        const cardStyle = getComputedStyle(urgent);
        const head = urgent.querySelector(".card-head");
        const headStyle = head ? getComputedStyle(head) : null;
        const listStyle = list ? getComputedStyle(list) : null;
        const px = (value) => parseFloat(value) || 0;
        return {
          stack: {
            rect: stackEl.getBoundingClientRect().toJSON(),
            paddingTop: px(stackStyle.paddingTop),
            paddingBottom: px(stackStyle.paddingBottom),
            rowGap: px(stackStyle.rowGap),
          },
          card: {
            rect: urgent.getBoundingClientRect().toJSON(),
            borderTop: px(cardStyle.borderTopWidth),
            borderBottom: px(cardStyle.borderBottomWidth),
            paddingTop: px(cardStyle.paddingTop),
            paddingBottom: px(cardStyle.paddingBottom),
          },
          head: head ? {
            rect: head.getBoundingClientRect().toJSON(),
            marginTop: px(headStyle.marginTop),
            marginBottom: px(headStyle.marginBottom),
          } : null,
          list: list ? {
            rect: listRect.toJSON(),
            marginTop: px(listStyle.marginTop),
            marginBottom: px(listStyle.marginBottom),
            paddingTop: px(listStyle.paddingTop),
            paddingBottom: px(listStyle.paddingBottom),
          } : null,
          ordinaryHeights: [...document.querySelectorAll('.card[data-channel="ordinary"]')]
            .map((card) => card.getBoundingClientRect().height),
        };
      })() : null,
      ordinary: [...document.querySelectorAll('.card[data-channel="ordinary"]')].map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          presentationId: card.dataset.presentationId,
          rect: rect.toJSON(),
          texts: [...card.querySelectorAll(".item-source, .item-meaning")].map((element) => {
            const textRect = element.getBoundingClientRect();
            return {
              text: element.textContent,
              top: textRect.top,
              bottom: textRect.bottom,
              rect: textRect.toJSON(),
              clipped: element.scrollHeight > element.clientHeight + 1
                || element.scrollWidth > element.clientWidth + 1,
            };
          }),
        };
      }),
    };
  });
  return {
    ...sample,
    requestStartedAt,
    requestEndedAt: Date.now(),
  };
}

/* 失败时仍可审查采样时间线：异常/缺失样本都带当次请求区间、几何与 ack/hold。 */
function absentTimelineEntry(sample, eventId) {
  return {
    t: sample.sampledAt,
    requestStartedAt: sample.requestStartedAt,
    requestEndedAt: sample.requestEndedAt,
    rendered: false,
    fullyVisible: false,
    eventId,
    rowRect: null,
    sourceRect: null,
    meaningRect: null,
    listRect: sample.list?.rect ?? null,
    innerHeight: sample.innerHeight,
    clipReasons: ["not-rendered"],
  };
}

function rowTimelineEntry(sample, row, visible) {
  return {
    t: sample.sampledAt,
    requestStartedAt: sample.requestStartedAt,
    requestEndedAt: sample.requestEndedAt,
    rendered: true,
    fullyVisible: visible,
    eventId: row.eventId,
    rowRect: row.rowRect,
    sourceRect: row.sourceRect,
    meaningRect: row.meaningRect,
    listRect: sample.list?.rect ?? null,
    innerHeight: sample.innerHeight,
    sourceClipped: row.sourceClipped,
    meaningClipped: row.meaningClipped,
    clipped: row.sourceClipped || row.meaningClipped || !row.fullyVisible,
    clipReasons: row.clipReasons,
    source: row.source,
    meaning: row.meaning,
    ack: row.ack,
  };
}

function timelineForEvidence(timeline, dataDir) {
  const evidence = {};
  for (const [eventId, entries] of timeline) {
    const ack = ackRow(dataDir, eventId);
    evidence[eventId] = entries.map((entry) => ({
      ...entry,
      acknowledgedAt: ack?.acknowledged_at ?? null,
      holdUntil: ack?.hold_until ?? null,
    }));
  }
  return evidence;
}

test("POL-NOTIFY-UI-010 长Agent名默认分页自动可达；另批查看全部与普通三位并存", {
  timeout: 240000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-010-");
  const dataDir = makeDataDir("010");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "010", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  let cdp = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const panes = [];
    for (let index = 0; index < 9; index += 1) {
      const pane = createPane(resources.server, `s05j-010-${index}`);
      reportAgent(resources.server, pane,
        index < 3 ? `ordinary-${index}` : LONG_AGENT(index), "working", 1);
      panes.push(pane);
    }
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {
      BAYPER_NOTIFICATION_MAX_HEIGHT: "420",
    });
    resources.app = launched.app;
    resources.logs = launched.logs;
    page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "启动通知阅读结束");

    const maxId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const reportEvent = async (pane, agent, state, sequence, expectedState = null) => {
      const before = maxId();
      reportAgent(resources.server, pane, agent, state, sequence);
      return waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ?
          AND (? IS NULL OR state = ?)
        ORDER BY id ASC LIMIT 1
      `, [before, expectedState, expectedState])[0] ?? null, 8000, `${agent} ${state} 事件`);
    };
    const ordinaryState = new Map([[0, "working"], [1, "working"], [2, "working"]]);
    let ordinaryFeed = 0;
    /* 普通位 4 秒读完后会自然关闭；自动分页期间补入新的普通事实，
       让“三普通同时存在”贯穿整段加急阅读，而不是滚完再补。 */
    const feedOrdinary = (index) => {
      const next = ordinaryState.get(index) === "working" ? "unknown" : "working";
      ordinaryState.set(index, next);
      reportAgent(resources.server, panes[index], `ordinary-${index}`, next, 100 + ordinaryFeed);
      ordinaryFeed += 1;
    };
    const ordinaryPanels = async () =>
      notificationsOf(await snapshotOf(page)).panels
        .filter((item) => item.channel === "ordinary");
    const keepOrdinary = async () => {
      const panels = await ordinaryPanels();
      if (panels.length < 3) feedOrdinary(ordinaryFeed % 3);
      return panels.length;
    };

    // 第一批：三普通同时存在，再追加六条长名称 P0；全程不点击/不滚动。
    for (let index = 0; index < 3; index += 1) feedOrdinary(index);
    await waitFor(async () => (await ordinaryPanels()).length === 3, 12000, "首批三个普通位");
    const p0Ids = [];
    const p0Agents = [];
    for (let index = 3; index < 9; index += 1) {
      const event = await reportEvent(
        panes[index], LONG_AGENT(index), "blocked", 10, "needs_attention",
      );
      p0Ids.push(event.id);
      p0Agents.push({ eventId: event.id, agent: LONG_AGENT(index) });
    }
    const urgent = await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel && panel.itemCount >= 6 ? panel : null;
    }, 12000, "六条长名称加急");
    cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);

    const complete = new Map();
    const timeline = new Map();
    const pageGroups = [];
    const ordinarySamples = [];
    let lastPageKey = "";
    const autoStartedAt = Date.now();
    const autoDeadline = autoStartedAt + 60000;
    let lastFeedAt = 0;
    while (Date.now() < autoDeadline) {
      const sample = await sampleNotificationGeometry(cdp.page);
      const present = new Set(sample.rows.map((row) => row.eventId));
      // 先记录本帧缺席，再记录在场行；缺席同样属于“阅读期内被移出”。
      for (const [eventId, entries] of timeline) {
        if (!present.has(eventId)) {
          entries.push(absentTimelineEntry(sample, eventId));
        }
      }
      for (const row of sample.rows) {
        const visible = row.fullyVisible && !row.sourceClipped && !row.meaningClipped;
        if (!timeline.has(row.eventId)) timeline.set(row.eventId, []);
        timeline.get(row.eventId).push(rowTimelineEntry(sample, row, visible));
        if (visible) {
          complete.set(row.eventId, {
            eventId: row.eventId,
            source: row.source,
            meaning: row.meaning,
            ack: row.ack,
            innerHeight: sample.innerHeight,
          });
        }
      }
      const pageKey = sample.rows.map((row) => row.eventId).join(",");
      if (pageKey && pageKey !== lastPageKey) {
        pageGroups.push({
          eventIds: sample.rows.map((row) => row.eventId),
          rows: sample.rows,
          list: sample.list,
          innerHeight: sample.innerHeight,
        });
        lastPageKey = pageKey;
        record.screenshots.push(captureNotification(
          (await snapshotOf(page)).desktop.notifications.window,
          `010-auto-page-${pageGroups.length}`,
        ));
      }
      // 接近 420pt 稳定窗口时才记录普通位，排除窗口正在增高的过渡帧。
      if (sample.innerHeight >= 400 && sample.ordinary.length === 3) {
        ordinarySamples.push({ innerHeight: sample.innerHeight, cards: sample.ordinary });
      }
      if (Date.now() - lastFeedAt > 800) {
        await keepOrdinary();
        lastFeedAt = Date.now();
      }
      const ackedNow = p0Ids.map((id) => ackRow(dataDir, id)).filter(
        (row) => row?.acknowledged_at,
      );
      if (ackedNow.length === p0Ids.length
        && Date.now() >= Math.max(...ackedNow.map((row) => row.hold_until))) break;
      await delay(200);
    }

    const ackedFirst = p0Ids.filter((id) => ackRow(dataDir, id)?.acknowledged_at);
    record.facts.auto = {
      p0Ids,
      acked: ackedFirst.length,
      pageGroups,
      complete: [...complete.values()],
      ordinarySampleCount: ordinarySamples.length,
      autoElapsedMs: Date.now() - autoStartedAt,
    };
    // 断言前先落盘；失败时仍能按采样时间/几何/ack 复核裁切。
    record.facts.auto.timeline = timelineForEvidence(timeline, dataDir);
    assert.equal(ackedFirst.length, p0Ids.length,
      `无点击/滚动时六条长名称 P0 必须自动逐条展示；实际仅 ${ackedFirst.length}/6 回执`);
    for (const { eventId, agent } of p0Agents) {
      const ack = ackRow(dataDir, eventId);
      const visible = complete.get(String(eventId));
      assert.equal(ack.hold_until - ack.acknowledged_at, 6000, "每条 P0 各自保留 6 秒");
      assert.ok(visible, `P0 ${eventId} 必须曾在完整可见状态下出现`);
      assert.ok(visible.source.includes(agent), "来源必须完整显示 Agent 全名");
      assert.ok(visible.meaning.includes("需要确认"), "含义必须完整显示");
    }
    /* 不只核对数据库 6 秒：逐条按采样时间验证已回执内容在其阅读期内
       持续留在 DOM 且来源/含义完整可见，没有被普通位进出临时挤走。 */
    const continuity = [];
    for (const { eventId } of p0Agents) {
      const ack = ackRow(dataDir, eventId);
      const start = ack.acknowledged_at;
      const end = ack.hold_until - 250;
      const entries = (timeline.get(String(eventId)) ?? [])
        .filter((entry) => entry.t >= start && entry.t <= end);
      assert.ok(entries.length >= 3, `事件 ${eventId} 阅读期采样不足`);
      assert.ok(entries[0].t - start <= 800, `事件 ${eventId} 阅读期起点未覆盖`);
      assert.ok(end - entries[entries.length - 1].t <= 1000,
        `事件 ${eventId} 阅读期终点未覆盖`);
      for (let index = 1; index < entries.length; index += 1) {
        assert.ok(entries[index].t - entries[index - 1].t <= 1000,
          `事件 ${eventId} 阅读期采样间隔过大，无法证明连续可读`);
      }
      for (const entry of entries) {
        assert.ok(entry.rendered, `事件 ${eventId} 在 6 秒阅读期内被移出 DOM`);
        assert.ok(entry.fullyVisible, `事件 ${eventId} 在 6 秒阅读期内被裁切`);
      }
      continuity.push({
        eventId,
        samples: entries.length,
        acknowledgedAt: start,
        holdUntil: ack.hold_until,
        firstSample: entries[0].t,
        lastSample: entries[entries.length - 1].t,
      });
    }
    record.facts.auto.continuity = continuity;
    assert.ok(pageGroups.length >= 2, "默认分页应逐页推进，而不是一次塞入全部");
    const displayedIds = pageGroups.flatMap((group) => group.eventIds);
    assert.deepEqual([...new Set(displayedIds)].sort((left, right) => Number(left) - Number(right)),
      p0Ids.map(String).sort((left, right) => Number(left) - Number(right)),
      "六条 P0 都必须在默认分页中出现");
    for (const group of pageGroups) {
      assert.ok(group.rows.length <= 3, "单页不得超过内容可完整显示的容量");
      for (const row of group.rows) {
        assert.equal(row.sourceClipped, false, "自动分页不得裁切来源");
        assert.equal(row.meaningClipped, false, "自动分页不得裁切含义");
        assert.equal(row.fullyVisible, true,
          "自动分页的每条来源与含义都必须完整落在可视区域内");
      }
    }
    assert.ok(ordinarySamples.length > 0, "自动分页期间应始终有三普通位可读");
    for (const sample of ordinarySamples) {
      for (const card of sample.cards) {
        assert.ok(card.rect.top >= -0.5 && card.rect.bottom <= sample.innerHeight + 0.5,
          "长名称 P0 不得把普通位挤出当前窗口");
        for (const text of card.texts) {
          assert.equal(text.clipped, false, "普通位来源与含义不得被裁切");
          assert.ok(text.top >= 0 && text.bottom <= sample.innerHeight + 0.5);
        }
      }
    }
    record.facts.autoAcks = p0Agents.map(({ eventId, agent }) => {
      const ack = ackRow(dataDir, eventId);
      const event = queryDb(dataDir,
        "SELECT received_at, priority FROM connector_events WHERE id = ?", [eventId])[0];
      return {
        eventId,
        agent,
        priority: event.priority,
        receivedAt: event.received_at,
        acknowledgedAt: ack.acknowledged_at,
        delayMs: ack.acknowledged_at - event.received_at,
        holdMs: ack.hold_until - ack.acknowledged_at,
      };
    });
    record.facts.autoAudit = queryDb(dataDir,
      "SELECT event_id, due_at, observed_at, reason FROM notification_audit ORDER BY id");
    const autoWindowHeight =
      (await snapshotOf(page)).desktop.notifications.window.bounds.height;
    assert.ok(autoWindowHeight <= 420, "有限显示空间上限必须生效");
    record.facts.autoWindowHeight = autoWindowHeight;
    await waitFor(async () =>
      !notificationsOf(await snapshotOf(page)).panels.some(
        (item) => item.channel === "urgent",
      ), 12000, "第一批长名称阅读结束");

    // 第二批：三普通先在位，再手动展开全部长明细并滚动；普通位不得被挤走。
    const ordinaryBeforeManual = await keepOrdinary();
    for (let index = 0; index < 3; index += 1) feedOrdinary(index);
    await waitFor(async () => (await ordinaryPanels()).length === 3, 12000, "手动批三个普通位");
    const manualIds = [];
    const manualAgents = [];
    for (let index = 3; index < 9; index += 1) {
      const agent = LONG_AGENT(index);
      const beforeWork = maxId();
      reportAgent(resources.server, panes[index], agent, "working", 30 + index);
      await waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ? ORDER BY id ASC LIMIT 1
      `, [beforeWork])[0] ?? null, 5000, `${agent} 恢复`).catch(() => null);
      const event = await reportEvent(panes[index], agent, "blocked", 40 + index,
        "needs_attention");
      manualIds.push(event.id);
      manualAgents.push({ eventId: event.id, agent });
    }
    const manualUrgent = await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel && panel.itemCount >= 6 ? panel : null;
    }, 12000, "第二批六条长名称加急");
    await cdp.page.locator('.card[data-channel="urgent"] .more').click();
    await waitFor(() => cdp.page.locator('.card[data-channel="urgent"] .item')
      .count().then((count) => count === 6), 5000, "查看全部明细");
    const expanded = await sampleNotificationGeometry(cdp.page);
    const expandedOrdinary = expanded.ordinary;
    assert.equal(expandedOrdinary.length, 3, "查看全部时普通三位必须同时存在");
    for (const card of expandedOrdinary) {
      assert.ok(card.rect.top >= -0.5 && card.rect.bottom <= expanded.innerHeight + 0.5,
        "手动展开不得把普通位挤出窗口");
      for (const text of card.texts) assert.equal(text.clipped, false);
    }
    assert.ok(expanded.list.scrollHeight > expanded.list.clientHeight,
      "长明细展开后必须可在加急区域内滚动");
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "010-expanded-with-ordinary",
    ));

    const manualComplete = new Map();
    const list = cdp.page.locator('.card[data-channel="urgent"] .items');
    let manualOrdinarySamples = 0;
    let lastManualFeedAt = 0;
    for (let round = 0; round < 8; round += 1) {
      if (manualIds.every((id) => ackRow(dataDir, id)?.acknowledged_at)) break;
      const range = await list.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      );
      for (let offset = 0; offset <= range + 50; offset += 50) {
        await list.evaluate((element, top) => { element.scrollTop = top; }, offset);
        // 每个位置停留超过 READY_MS(350ms) 与一次 tick，确保真实可见后再继续滚。
        await delay(700);
        const sample = await sampleNotificationGeometry(cdp.page);
        for (const row of sample.rows) {
          if (row.fullyVisible && !row.sourceClipped && !row.meaningClipped) {
            manualComplete.set(row.eventId, {
              eventId: row.eventId, source: row.source, meaning: row.meaning,
            });
          }
        }
        if (sample.ordinary.length === 3) manualOrdinarySamples += 1;
        // 普通位 4 秒读完自然关闭；滚动期间持续补入，而不是滚完后再补。
        if (sample.ordinary.length < 3 && Date.now() - lastManualFeedAt > 1000) {
          await keepOrdinary();
          lastManualFeedAt = Date.now();
        }
      }
    }
    await waitFor(() => manualIds.every((id) => ackRow(dataDir, id)?.acknowledged_at),
      10000, "滚动后逐条回执");
    for (const { eventId, agent } of manualAgents) {
      const ack = ackRow(dataDir, eventId);
      const visible = manualComplete.get(String(eventId));
      assert.equal(ack.hold_until - ack.acknowledged_at, 6000, "手动明细同样各自 6 秒");
      assert.ok(visible, `手动明细 ${eventId} 必须曾在完整可见状态下出现`);
      assert.ok(visible.source.includes(agent));
      assert.ok(visible.meaning.includes("需要确认"));
    }
    assert.ok(manualOrdinarySamples > 0, "滚动长明细期间应始终有普通位在场");
    /* 滚动与逐条回执结束后，旧普通位通常已按 4 秒自然到期。
       布局检查需要合法未过期输入，因此用真实新事件重新供给，直到当前三个
       普通位都仍有明确剩余 hold；不冻结时钟、不保留过期卡。 */
    let freshOrdinaryLayout = null;
    const ordinaryLayoutDeadline = Date.now() + 12000;
    let lastOrdinaryFeedAt = 0;
    while (Date.now() < ordinaryLayoutDeadline) {
      if (Date.now() - lastOrdinaryFeedAt > 500) {
        feedOrdinary(ordinaryFeed % 3);
        lastOrdinaryFeedAt = Date.now();
      }
      const panels = await ordinaryPanels();
      const now = Date.now();
      const holds = panels.flatMap((panel) => panel.eventIds.map((eventId) => {
        const row = ackRow(dataDir, eventId);
        return {
          eventId,
          acknowledgedAt: row?.acknowledged_at ?? null,
          holdUntil: row?.hold_until ?? null,
        };
      }));
      if (panels.length === 3 && holds.every(
        (row) => row.holdUntil !== null && row.holdUntil > now + 300,
      )) {
        freshOrdinaryLayout = { sampledAt: now, panels, holds };
        break;
      }
      await delay(100);
    }
    assert.ok(freshOrdinaryLayout, "滚动后需要三个合法未过期普通位");
    const afterScroll = await sampleNotificationGeometry(cdp.page);
    const afterScrollAt = Date.now();
    const afterScrollPanels = notificationsOf(await snapshotOf(page)).panels;
    assert.equal(afterScroll.ordinary.length, 3, "滚动后普通三位仍须存在");
    assert.ok(
      afterScrollPanels.some((panel) => panel.channel === "urgent"),
      "布局检查时加急长明细仍应在场，否则无法证明普通位未被挤出",
    );
    for (const hold of freshOrdinaryLayout.holds) {
      assert.ok(hold.holdUntil > afterScrollAt,
        `普通位 ${hold.eventId} 在布局采样时已经过期`);
    }
    for (const card of afterScroll.ordinary) {
      assert.ok(card.rect.top >= -0.5 && card.rect.bottom <= afterScroll.innerHeight + 0.5,
        "滚动长明细不得把普通位挤出窗口");
      for (const text of card.texts) assert.equal(text.clipped, false);
    }
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "010-manual-after-scroll",
    ));
    record.facts.manual = {
      presentationId: manualUrgent.presentationId,
      ordinaryBeforeManual,
      ordinaryAfterScroll: afterScroll.ordinary,
      ordinaryFreshLayout: freshOrdinaryLayout,
      ordinaryLayoutSampledAt: afterScrollAt,
      urgentPresentAtLayout: afterScrollPanels.some(
        (panel) => panel.channel === "urgent",
      ),
      ordinaryLayoutMinRemainingMs: Math.min(
        ...freshOrdinaryLayout.holds.map((hold) => hold.holdUntil - afterScrollAt),
      ),
      expandedList: expanded.list,
      expandedUrgentRect: expanded.urgentRect,
      manualIds,
      manualComplete: [...manualComplete.values()],
    };
    record.boundary = "真实 herdr 0.9.5；420pt 高度上限模拟有限显示空间。自动批全程不点击/不滚动，手动批单独验证查看全部。";
  } catch (error) {
    try {
      record.facts.debug = cdp ? await sampleNotificationGeometry(cdp.page) : null;
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.facts.debug = record.facts.debug ?? {};
    record.facts.debug.itemsDb = allItems(dataDir);
    record.facts.logs = (resources.logs ?? []).slice(-40);
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("010", record, [root, dataDir, home]);
  }
});

test("POL-NOTIFY-UI-011 短名P0先到、三普通随后到420pt时已回执内容持续可见", {
  timeout: 180000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-011-");
  const dataDir = makeDataDir("011");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "011", facts: {}, screenshots: [], cleanupErrors: [] };
  let page = null;
  let cdp = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const panes = [];
    for (let index = 0; index < 6; index += 1) {
      const pane = createPane(resources.server, `s05j-011-${index}`);
      reportAgent(resources.server, pane,
        index < 3 ? `fixture-o${index}` : `fixture-p0-${index - 3}`, "working", 1);
      panes.push(pane);
    }
    invokeRegistration(resources.server);
    record.facts.registration = await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {
      BAYPER_NOTIFICATION_MAX_HEIGHT: "420",
    });
    resources.app = launched.app;
    resources.logs = launched.logs;
    page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "启动通知阅读结束");

    const maxId = () =>
      queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    const reportEvent = async (pane, agent, state, sequence, expectedState = null) => {
      const before = maxId();
      reportAgent(resources.server, pane, agent, state, sequence);
      return waitFor(() => queryDb(dataDir, `
        SELECT * FROM connector_events WHERE id > ?
          AND (? IS NULL OR state = ?)
        ORDER BY id ASC LIMIT 1
      `, [before, expectedState, expectedState])[0] ?? null, 8000, `${agent} ${state} 事件`);
    };
    const ordinaryPanels = async () =>
      notificationsOf(await snapshotOf(page)).panels
        .filter((item) => item.channel === "ordinary");
    const ordinaryState = new Map([[0, "working"], [1, "working"], [2, "working"]]);
    let feedCount = 0;
    const feedOrdinary = () => {
      const index = feedCount % 3;
      const next = ordinaryState.get(index) === "working" ? "unknown" : "working";
      ordinaryState.set(index, next);
      reportAgent(resources.server, panes[index], `fixture-o${index}`, next, 50 + feedCount);
      feedCount += 1;
    };

    // 加急先到：三条短名 P0。
    const p0Ids = [];
    const p0Agents = [];
    for (let index = 0; index < 3; index += 1) {
      const agent = `fixture-p0-${index}`;
      const event = await reportEvent(panes[index + 3], agent, "blocked", 10,
        "needs_attention");
      p0Ids.push(event.id);
      p0Agents.push({ eventId: event.id, agent });
    }
    await waitFor(async () => {
      const panel = notificationsOf(await snapshotOf(page)).panels
        .find((item) => item.channel === "urgent");
      return panel && panel.itemCount >= 3 ? panel : null;
    }, 12000, "三条短名 P0");
    cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    const initialRows = await cdp.page.locator('.card[data-channel="urgent"] .item')
      .evaluateAll((rows) => rows.map((row) => row.dataset.eventId));
    record.facts.initialRendered = initialRows;

    // 第一条开始回执后，在 6 秒内用真实事件填入三普通位。
    const firstAck = await waitAck(dataDir, p0Ids[0], 10000);
    for (let index = 0; index < 3; index += 1) feedOrdinary();
    await waitFor(async () => (await ordinaryPanels()).length === 3, 10000, "三普通随后到位");
    const ordinaryArrivedAt = Date.now();
    assert.ok(ordinaryArrivedAt - firstAck.acknowledged_at <= 5000,
      "三普通必须在首条 P0 的 6 秒阅读期内到位");

    const complete = new Map();
    const timeline = new Map();
    const ordinarySamples = [];
    const pageGroups = [];
    let lastPageKey = "";
    let lastFeedAt = 0;
    const startedAt = Date.now();
    const deadline = startedAt + 40000;
    while (Date.now() < deadline) {
      const sample = await sampleNotificationGeometry(cdp.page);
      const sampledAt = sample.sampledAt;
      const present = new Set(sample.rows.map((row) => row.eventId));
      for (const [eventId, entries] of timeline) {
        if (!present.has(eventId)) {
          entries.push(absentTimelineEntry(sample, eventId));
        }
      }
      for (const row of sample.rows) {
        const visible = row.fullyVisible && !row.sourceClipped && !row.meaningClipped;
        if (!timeline.has(row.eventId)) timeline.set(row.eventId, []);
        timeline.get(row.eventId).push(rowTimelineEntry(sample, row, visible));
        if (visible) complete.set(row.eventId, { source: row.source, meaning: row.meaning });
      }
      const pageKey = sample.rows.map((row) => row.eventId).join(",");
      if (pageKey && pageKey !== lastPageKey) {
        pageGroups.push({ eventIds: sample.rows.map((row) => row.eventId),
          innerHeight: sample.innerHeight });
        lastPageKey = pageKey;
        record.screenshots.push(captureNotification(
          (await snapshotOf(page)).desktop.notifications.window,
          `011-page-${pageGroups.length}`,
        ));
      }
      if (sample.ordinary.length === 3) {
        ordinarySamples.push({
          t: sampledAt,
          innerHeight: sample.innerHeight,
          cards: sample.ordinary,
        });
      }
      if (Date.now() - lastFeedAt > 1200) {
        if ((await ordinaryPanels()).length < 3) feedOrdinary();
        lastFeedAt = Date.now();
      }
      const ackedNow = p0Ids.map((id) => ackRow(dataDir, id)).filter(
        (row) => row?.acknowledged_at,
      );
      if (ackedNow.length === p0Ids.length
        && Date.now() >= Math.max(...ackedNow.map((row) => row.hold_until))) break;
      await delay(200);
    }

    const acked = p0Ids.filter((id) => ackRow(dataDir, id)?.acknowledged_at);
    record.facts.p0Ids = p0Ids;
    record.facts.initialRendered = initialRows;
    record.facts.ordinaryArrivedAt = ordinaryArrivedAt;
    record.facts.firstAck = firstAck.acknowledged_at;
    record.facts.pageGroups = pageGroups;
    record.facts.ordinarySampleCount = ordinarySamples.length;
    record.facts.timeline = timelineForEvidence(timeline, dataDir);
    assert.equal(acked.length, 3, "三条短名 P0 必须最终自动全部回执");
    for (const { eventId, agent } of p0Agents) {
      const ack = ackRow(dataDir, eventId);
      assert.equal(ack.hold_until - ack.acknowledged_at, 6000, "每条 P0 各自 6 秒");
      const visible = complete.get(String(eventId));
      assert.ok(visible, `P0 ${eventId} 必须曾在完整可见状态下出现`);
      assert.ok(visible.source.includes(agent));
      assert.ok(visible.meaning.includes("需要确认"));
      const entries = (timeline.get(String(eventId)) ?? [])
        .filter((entry) => entry.t >= ack.acknowledged_at
          && entry.t <= ack.hold_until - 250);
      assert.ok(entries.length >= 3, `P0 ${eventId} 阅读期采样不足`);
      for (const entry of entries) {
        assert.ok(entry.rendered, `P0 ${eventId} 在普通位到达后被移出 DOM`);
        assert.ok(entry.fullyVisible, `P0 ${eventId} 在普通位到达后被裁切`);
      }
    }
    const firstHoldEnd = firstAck.hold_until;
    const duringFirstHold = ordinarySamples.filter(
      (sample) => sample.t >= firstAck.acknowledged_at && sample.t <= firstHoldEnd - 250,
    );
    assert.ok(duringFirstHold.length > 0,
      "首条 P0 阅读期内必须有三普通位同时可读");
    for (const sample of ordinarySamples) {
      for (const card of sample.cards) {
        assert.ok(card.rect.top >= -0.5
          && card.rect.bottom <= sample.innerHeight + 0.5,
        "普通卡片必须在窗口内完整可见");
        for (const text of card.texts) {
          assert.equal(text.clipped, false, "普通来源与含义不得被裁切");
          assert.ok(text.top >= 0 && text.bottom <= sample.innerHeight + 0.5);
        }
      }
    }
    record.facts.firstHoldOrdinarySamples = duringFirstHold.length;
    record.facts.acks = p0Agents.map(({ eventId }) => {
      const ack = ackRow(dataDir, eventId);
      const event = queryDb(dataDir,
        "SELECT received_at, priority FROM connector_events WHERE id = ?", [eventId])[0];
      return {
        eventId,
        delayMs: ack.acknowledged_at - event.received_at,
        holdMs: ack.hold_until - ack.acknowledged_at,
      };
    });
    record.screenshots.push(captureNotification(
      (await snapshotOf(page)).desktop.notifications.window, "011-final",
    ));
    record.boundary = "真实 herdr 0.9.5；420pt 上限不变，短名 P0 先到、三普通后到。";
  } catch (error) {
    try {
      record.facts.debug = cdp ? await sampleNotificationGeometry(cdp.page) : null;
    } catch (debugError) {
      record.facts.debugError = debugError.message;
    }
    record.facts.debug = record.facts.debug ?? {};
    record.facts.debug.itemsDb = allItems(dataDir);
    record.facts.logs = (resources.logs ?? []).slice(-40);
    record.failure = error;
    throw error;
  } finally {
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("011", record, [root, dataDir, home]);
  }
});

const CONTINUITY_AGENT = "agent-with-a-very-long-name-00-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

test("POL-NOTIFY-UI-012 ack标签挤宽与三普通位重排下长P0连续可读", {
  timeout: 180000,
  skip: SKIP_LIVE,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-s05j-012-");
  const dataDir = makeDataDir("012");
  const home = makeHome();
  const registryDir = registryDirOf(dataDir);
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = { root, dataDir, home, server: null, app: null, cdp: [] };
  const record = { case: "012", facts: {}, screenshots: [], cleanupErrors: [] };
  let cdp = null;
  let timeline = null;
  try {
    const session = `s05j-${crypto.randomBytes(3).toString("hex")}`;
    resources.server = await startRealServer(root, session);
    setupRealPlugin(resources.server, registryDir);
    const p0Pane = createPane(resources.server, "s05j-012-p0");
    reportAgent(resources.server, p0Pane, CONTINUITY_AGENT, "working", 1);
    const ordinaryPanes = [0, 1, 2].map((index) =>
      createPane(resources.server, `s05j-012-ordinary-${index}`));
    for (let index = 0; index < 3; index += 1) {
      reportAgent(resources.server, ordinaryPanes[index], `fixture-o${index}`, "working", 1);
    }
    invokeRegistration(resources.server);
    await waitRegistration(registryDir, resources.server.child.pid);
    const launched = await launchApp(dataDir, home, {
      BAYPER_NOTIFICATION_MAX_HEIGHT: "420",
    });
    resources.app = launched.app;
    const page = launched.page;
    await waitDesktop(page);
    await waitOnline(page);
    // 先用普通位建立真实通知页/CDP，再触发长 P0，避免 350ms ack 先于连接。
    reportAgent(resources.server, ordinaryPanes[0], "fixture-o0", "unknown", 2);
    await waitNotificationWindow(page);
    cdp = await connectNotificationPage(dataDir);
    resources.cdp.push(cdp.browser);
    await waitFor(async () =>
      notificationsOf(await snapshotOf(page)).panels.length === 0,
    12000, "预热普通通知阅读结束");
    const beforeId = queryDb(dataDir,
      "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
    reportAgent(resources.server, p0Pane, CONTINUITY_AGENT, "blocked", 10);
    const event = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE id > ? AND state = 'needs_attention'
      ORDER BY id ASC LIMIT 1
    `, [beforeId])[0] ?? null, 8000, "长名称 P0 事件");
    assert.equal(event.priority, 0, "聚焦场景必须是真 P0");
    const eventId = String(event.id);
    record.facts.eventId = eventId;
    const rowOf = (sample) => sample.rows.find((row) => row.eventId === eventId) ?? null;
    timeline = new Map([[eventId, []]]);
    const pushSample = (sample) => {
      const row = rowOf(sample);
      timeline.get(eventId).push(row
        ? rowTimelineEntry(
          sample,
          row,
          row.fullyVisible && !row.sourceClipped && !row.meaningClipped,
        )
        : absentTimelineEntry(sample, eventId));
    };
    // 直接采样真实通知 DOM，ack 前状态在 350ms 阅读就绪窗口内捕获。
    const preAck = await waitFor(async () => {
      const sample = await sampleNotificationGeometry(cdp.page);
      pushSample(sample);
      const row = rowOf(sample);
      return row && row.ack === "0" ? { sample, row } : null;
    }, 10000, "ack 前长行");
    record.facts.preAck = preAck.row;
    record.facts.preWindow = (await snapshotOf(page)).desktop.notifications.window;
    assert.ok(
      preAck.row.source.includes(CONTINUITY_AGENT),
      `DOM 来源未包含预期长名称：${preAck.row.source}`,
    );
    const ack = await waitAck(dataDir, event.id, 10000);
    assert.equal(ack.hold_until - ack.acknowledged_at, 6000, "P0 仍为 6 秒阅读");
    record.facts.acknowledgedAt = ack.acknowledged_at;
    record.facts.holdUntil = ack.hold_until;
    const postAck = await waitFor(async () => {
      const sample = await sampleNotificationGeometry(cdp.page);
      pushSample(sample);
      const row = rowOf(sample);
      return row && row.ack === "1" ? { sample, row } : null;
    }, 5000, "ack 标签出现后的长行");
    record.facts.postAck = postAck.row;
    record.facts.postWindow = (await snapshotOf(page)).desktop.notifications.window;
    // 只报告是否真的多折一行；未变化不能称为 2→3 行已覆盖。
    record.facts.ackSqueeze = {
      sourceHeightChanged:
        preAck.row.sourceRect.height !== postAck.row.sourceRect.height,
    };
    // 新版“已显示”位首帧预留宽度，ack 不再改变正文折行。
    assert.equal(
      postAck.row.sourceRect.width,
      preAck.row.sourceRect.width,
      "ack 前后正文宽度必须稳定",
    );
    assert.equal(
      postAck.row.sourceRect.height,
      preAck.row.sourceRect.height,
      "ack 前后正文行高必须稳定",
    );

    let ordinaryTriggeredAt = null;
    let ordinaryArrival = null;
    while (true) {
      const sample = await sampleNotificationGeometry(cdp.page);
      pushSample(sample);
      // 先采样，再触发普通位，确保覆盖 resize 发生前后的同一阅读期。
      if (ordinaryTriggeredAt === null) {
        ordinaryTriggeredAt = Date.now();
        record.facts.ordinaryTriggeredAt = ordinaryTriggeredAt;
        for (let index = 0; index < 3; index += 1) {
          reportAgent(
            resources.server,
            ordinaryPanes[index],
            `fixture-o${index}`,
            index === 0 ? "working" : "unknown",
            index === 0 ? 3 : 2,
          );
        }
      }
      if (!ordinaryArrival) {
        const panels = notificationsOf(await snapshotOf(page)).panels.filter(
          (item) => item.channel === "ordinary",
        );
        if (panels.length === 3) {
          ordinaryArrival = {
            sampledAt: sample.sampledAt,
            innerHeight: sample.innerHeight,
            list: sample.list,
            layout: sample.layout,
            panelCount: panels.length,
            window: (await snapshotOf(page)).desktop.notifications.window,
          };
          record.facts.ordinaryArrival = ordinaryArrival;
        }
      }
      if (sample.sampledAt >= ack.hold_until) break;
      await delay(120);
    }

    record.facts.timeline = timelineForEvidence(timeline, dataDir);
    assert.ok(ordinaryArrival, "三普通位未在 6 秒阅读期内到达");
    // 独立 Oracle：只用 DOM 实际 rect/computed 值推算所需窗口，不调用生产 naturalHeight。
    const layout = ordinaryArrival.layout;
    const layoutList = layout.list;
    const requiredHeight =
      layout.stack.paddingTop + layout.stack.paddingBottom
      + layout.stack.rowGap * layout.ordinaryHeights.length
      + layout.ordinaryHeights.reduce((sum, height) => sum + height, 0)
      + layout.card.borderTop + layout.card.borderBottom
      + layout.card.paddingTop + layout.card.paddingBottom
      + layout.head.rect.height
      + Math.min(ordinaryArrival.list.scrollHeight, 150)
      + layoutList.marginTop;
    const capped = requiredHeight >= 420;
    record.facts.oracle = {
      requiredHeight,
      innerHeight: ordinaryArrival.innerHeight,
      listClientHeight: ordinaryArrival.list.clientHeight,
      listScrollHeight: ordinaryArrival.list.scrollHeight,
      listContentsHeight: Math.min(ordinaryArrival.list.scrollHeight, 150),
      capped,
    };
    if (!capped) {
      assert.ok(
        ordinaryArrival.innerHeight + 0.5 >= requiredHeight,
        `窗口高度不足：required=${requiredHeight}, actual=${ordinaryArrival.innerHeight}`,
      );
      assert.ok(
        ordinaryArrival.list.clientHeight + 0.5 >=
          Math.min(ordinaryArrival.list.scrollHeight, 150),
        `列表内容被高度漏算挤压：client=${ordinaryArrival.list.clientHeight}, scroll=${
          ordinaryArrival.list.scrollHeight}`,
      );
    }
    const holdEntries = record.facts.timeline[eventId].filter(
      (entry) => entry.t >= ack.acknowledged_at && entry.t <= ack.hold_until,
    );
    assert.ok(holdEntries.length >= 5, "6 秒阅读期采样不足");
    assert.ok(holdEntries[0].t - ack.acknowledged_at <= 800, "阅读期起点未覆盖");
    assert.ok(ack.hold_until - holdEntries[holdEntries.length - 1].t <= 1000,
      "阅读期终点未覆盖");
    let maxGap = 0;
    for (let index = 1; index < holdEntries.length; index += 1) {
      maxGap = Math.max(maxGap, holdEntries[index].t - holdEntries[index - 1].t);
    }
    assert.ok(maxGap <= 1000, `阅读期采样最大间隙过大：${maxGap}ms`);
    record.facts.continuity = { samples: holdEntries.length, maxGap };
    for (const entry of holdEntries) {
      assert.ok(entry.rendered, `事件 ${eventId} 在阅读期内被移出 DOM`);
      assert.ok(entry.fullyVisible, `事件 ${eventId} 在阅读期内被裁切`);
    }
  } catch (error) {
    // 时间线已在断言前落盘；不再用最终 debug 几何替代失败现场。
    record.failure = error;
    throw error;
  } finally {
    // preAck/普通位等待失败时也保存已获得的阶段事实与实际采样。
    if (timeline) {
      try {
        record.facts.timeline = timelineForEvidence(timeline, dataDir);
      } catch {
        // 失败现场保留已有 facts，不用采样异常覆盖业务 failure。
      }
    }
    for (const browser of resources.cdp) await browser.close().catch(() => {});
    record.appExits = await teardown(resources, record.cleanupErrors);
    writeCase("012", record, [root, dataDir, home]);
  }
});
