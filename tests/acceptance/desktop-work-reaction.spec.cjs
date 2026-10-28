/* S07 工作结束短反应验收：真实 Herdr 非焦点 pane working→idle→done，
   正式 Electron/SQLite/通知/画布链路；渲染层用直接画布子进程精确测帧。
   只操作本轮自建 server/窗口/数据；不读取用户 Herdr 会话。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { _electron: electron, chromium } = require("playwright");
const electronPath = require("electron");
const { createDesktopHost } = require("../../app/desktop-host.cjs");
const {
  getRinAnimations,
  getHuAnimations,
} = require("../../app/desktop-assets.cjs");
const { createLegacyDatabase, dbPath, localDay } = require("./s02-fixtures.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const PLUGIN_DIR = path.join(repoRoot, "plugins", "herdr");
const PLUGIN_ID = "bayper.herdr";
const ACTION_ID = "bayper.herdr.associate";
const HERDR = process.env.HERDR_BIN || "herdr";
const EVIDENCE_ROOT = path.join(
  repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s07-work-reaction",
);
const BATCH = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${
  crypto.randomBytes(3).toString("hex")}`;
const RUN_DIR = path.join(EVIDENCE_ROOT, `run-${BATCH}`);
fs.mkdirSync(RUN_DIR, { recursive: true });
fs.writeFileSync(path.join(RUN_DIR, "batch.log"), [
  `batch: ${BATCH}`,
  `created: ${new Date().toISOString()}`,
  "source: tests/acceptance/desktop-work-reaction.spec.cjs",
  "boundary: 真实 Herdr 0.9.5；done 由非焦点 pane 的 idle 投影，不使用同形 fixture。",
  "",
].join("\n"));
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
    await delay(40);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? `（${last.message}）` : ""}`);
}

function writeCase(caseId, facts, extra = {}) {
  const record = { case: caseId, batch: BATCH, at: new Date().toISOString(), facts, ...extra };
  const fileId = String(caseId).replaceAll("/", "-");
  fs.writeFileSync(path.join(RUN_DIR, `case-${fileId}.json`),
    `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(RUN_DIR, `case-${fileId}.log`), [
    `case: ${caseId}`,
    `failure: ${extra.failure ? extra.failure.stack || extra.failure.message : "none"}`,
    `boundary: ${extra.boundary ?? ""}`,
    `screenshots: ${JSON.stringify(extra.screenshots ?? [])}`,
    "",
    "## facts",
    JSON.stringify(facts, null, 2),
    "",
  ].join("\n"));
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

function execDb(dataDir, sql, params = []) {
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-workreaction-home-"));
  for (const key of [".config", ".local/share"]) {
    fs.mkdirSync(path.join(home, key), { recursive: true });
  }
  return home;
}

function makeDataDir(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-workreaction-data-"));
  createLegacyDatabase(dataDir, {
    characters: options.characters ?? [{ id: "rin", acceptedAt: "2026-10-01T00:00:00.000Z" }],
    modelCipher: Buffer.from("workreaction-fixture"),
    baseUrl: "https://127.0.0.1:1/v1",
    modelName: "workreaction-unreachable",
    fixedId: options.fixedId ?? "rin",
    currentId: options.currentId ?? "rin",
    rosterDay: localDay(new Date()),
  });
  return dataDir;
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

async function startRealServer(root) {
  const session = `workreaction-${crypto.randomBytes(3).toString("hex")}`;
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
  const { spawn } = require("node:child_process");
  const child = spawn(HERDR, ["--session", session, "server"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
  });
  const context = { root, session, env, child, version, stderr: () => stderr, socketPath: null };
  const expected = path.join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock");
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Herdr server 提前退出：${stderr}`);
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
  return context;
}

async function stopRealServer(context) {
  if (!context) return { ok: true };
  try { realCli(context, ["server", "stop"]); } catch { /* 以进程/socket 判定。 */ }
  await waitFor(() => context.child.exitCode !== null, 5000, "server exit").catch(() => {});
  if (context.child.exitCode === null) context.child.kill("SIGTERM");
  await waitFor(() => context.child.exitCode !== null, 2000, "server SIGTERM").catch(() => {});
  return {
    ok: context.child.exitCode !== null && !fs.existsSync(context.socketPath),
    exitCode: context.child.exitCode,
  };
}

function setupPlugin(context, registryDir) {
  try {
    realCli(context, ["plugin", "link", PLUGIN_DIR, "--enabled"]);
  } catch (error) {
    if (!/already|linked|enabled/i.test(String(error.message))) throw error;
  }
  const configDir = realCli(context, ["plugin", "config-dir", PLUGIN_ID]).trim();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "bayper.json"), JSON.stringify({ registryDir }));
}

function createWorkspace(context, label, focus) {
  const args = ["workspace", "create", "--cwd", context.root, "--label", label];
  args.push(focus ? "--focus" : "--no-focus");
  const created = JSON.parse(realCli(context, args));
  const pane = created.result.root_pane.pane_id;
  realCli(context, ["pane", "run", pane, "sleep", "300"]);
  return pane;
}

function reportAgent(context, pane, label, state, sequence) {
  realCli(context, [
    "pane", "report-agent", pane, "--source", "bayper-workreaction",
    "--agent", label, "--state", state, "--seq", String(sequence),
  ]);
}

function invokeRegistration(context) {
  realCli(context, ["plugin", "action", "invoke", ACTION_ID]);
}

async function launchApp(dataDir, home) {
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
      BAYPER_DESKTOP_DEBUG_PORT: "1",
      BAYPER_NOTIFICATION_TICK_MS: "100",
      BAYPER_HEARTBEAT_MS: "400",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 30000 });
  return { app, page };
}

function snapshotOf(page) {
  return page.evaluate(() => window.bayper.getSnapshot()).then((result) => {
    assert.equal(result.ok, true);
    return result.snapshot;
  });
}

async function waitDesktopReady(page) {
  return waitFor(async () => {
    const snapshot = await snapshotOf(page);
    return snapshot.desktop?.state === "running"
      && snapshot.desktop?.assetState === "ready"
      && snapshot.connectors.instances.some((item) => item.status === "online")
      ? snapshot : null;
  }, 35000, "desktop + connector online");
}

async function connectPage(dataDir, suffix) {
  return waitFor(async () => {
    const portFile = path.join(dataDir, "desktop-profile", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) return null;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    if (!port) return null;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((item) => item.url().includes(suffix));
    if (!page) {
      await browser.close();
      return null;
    }
    return { browser, page };
  }, 15000, `CDP ${suffix}`);
}

function spriteName(src) {
  return String(src ?? "").split("/").slice(-2).join("/");
}

async function currentSprite(canvas) {
  return canvas.page.evaluate(() => document.getElementById("sprite")?.src ?? "");
}

async function waitFrame(canvas, needle, timeout = 8000) {
  return waitFor(async () => {
    const src = await currentSprite(canvas);
    return src.includes(needle) ? src : null;
  }, timeout, `canvas frame ${needle}`);
}

async function sampleFrames(canvas, durationMs, intervalMs = 20) {
  const frames = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const name = spriteName(await currentSprite(canvas));
    if (name) {
      const last = frames.at(-1);
      if (!last || last.name !== name) frames.push({ name, at: Date.now() });
    }
    await delay(intervalMs);
  }
  return frames;
}

function startFrameTrace(canvas, owner = null, intervalMs = 15) {
  const frames = [];
  let active = true;
  let failure = null;
  const done = (async () => {
    let last = "";
    try {
      while (active) {
        const name = spriteName(await currentSprite(canvas));
        if (name && name !== last) {
          frames.push({ name, at: Date.now() });
          last = name;
        }
        await delay(intervalMs);
      }
    } catch (error) {
      // 页面在断言失败后被关闭时保留采样错误，但不覆盖原始断言。
      failure = error;
    }
  })();
  const handle = {
    frames,
    async stop() {
      active = false;
      await done;
      if (owner?.traces) owner.traces.delete(handle);
      if (failure) throw new Error(`帧追踪采样失败：${failure.message}`);
      return frames;
    },
    get failure() { return failure; },
  };
  if (owner?.traces) owner.traces.add(handle);
  return handle;
}
function happyStarts(frames) {
  return frames.filter((frame) => {
    const name = typeof frame === "string" ? frame : frame.name;
    return name.includes("happy-pixel-v4/frame-00.png");
  }).length;
}

function maxEventId(dataDir) {
  return queryDb(dataDir, "SELECT COALESCE(MAX(id), 0) AS id FROM connector_events")[0].id;
}

function eventRowsAfter(dataDir, afterId, instanceId) {
  return queryDb(dataDir, `
    SELECT * FROM connector_events
    WHERE id > ? AND instance_id = ?
    ORDER BY id ASC
  `, [afterId, instanceId]);
}

async function waitEvent(dataDir, afterId, instanceId, predicate, label) {
  try {
    return await waitFor(() => {
      const rows = eventRowsAfter(dataDir, afterId, instanceId);
      return rows.find(predicate) ?? null;
    }, 10000, label);
  } catch (error) {
    throw new Error(`${error.message} events=${JSON.stringify(eventRowsAfter(dataDir, afterId, instanceId))}`);
  }
}

function ackRow(dataDir, eventId) {
  return queryDb(dataDir, `
    SELECT * FROM notification_presentation_items
    WHERE event_id = ? AND acknowledged_at IS NOT NULL
    ORDER BY rowid DESC LIMIT 1
  `, [eventId])[0] ?? null;
}

async function waitAck(dataDir, eventId, timeout = 12000) {
  return waitFor(() => ackRow(dataDir, eventId), timeout, `ack ${eventId}`);
}

async function notificationTexts(notification) {
  return notification.page.locator(".item-meaning").allTextContents()
    .then((items) => items.join("|"));
}

async function notificationItems(notification) {
  return notification.page.locator(".item").evaluateAll((rows) => rows.map((row) => ({
    eventId: Number(row.dataset.eventId), source: row.querySelector(".item-source")?.textContent ?? "",
    meaning: row.querySelector(".item-meaning")?.textContent ?? "",
  })));
}

const canvasDebugSessions = new WeakMap();
function sourceMatches(item, event, label, instanceId) {
  return Boolean(
    item
    && item.eventId === event.id
    && item.source.includes(String(instanceId).slice(-8))
    && (item.source.includes(label) || item.source.includes(event.agent_id)),
  );
}

async function setCanvasFrozen(canvas, frozen) {
  if (frozen) {
    const session = await canvas.page.context().newCDPSession(canvas.page);
    await session.send("Debugger.enable");
    await session.send("Debugger.pause");
    canvasDebugSessions.set(canvas.page, session);
    return session;
  }
  const session = canvasDebugSessions.get(canvas.page);
  if (session) {
    await session.send("Debugger.resume");
    canvasDebugSessions.delete(canvas.page);
  }
}

function statsOf(dataDir) {
  return queryDb(dataDir, `
    SELECT character_id, intimacy, energy, mood FROM character_stats WHERE character_id = 'rin'
  `)[0];
}

async function closeApp(app) {
  if (!app) return;
  await app.close().catch(() => {});
  await waitFor(() => {
    const handle = app.process?.();
    return !handle || handle.exitCode !== null || handle.signalCode !== null;
  }, 8000, "app exit").catch(() => {});
}

function cleanupDirs(dirs, errors) {
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (fs.existsSync(dir)) throw new Error(`临时目录未清理：${dir}`);
    } catch (error) {
      errors.push(error);
    }
  }
}

async function triggerFinished(context, dataDir, instanceId, pane, label, sequence) {
  const before = maxEventId(dataDir);
  reportAgent(context, pane, label, "working", sequence);
  const working = await waitEvent(dataDir, before, instanceId,
    (event) => event.state === "working", "real working event");
  reportAgent(context, pane, label, "idle", sequence + 1);
  const finished = await waitEvent(dataDir, before, instanceId,
    (event) => event.state === "finished"
      && event.agent_id === working.agent_id
      && event.historical === 0
      && event.notification_status !== "none",
    "real finished projection");
  return { working, finished };
}

async function triggerBlocked(context, dataDir, instanceId, pane, label, sequence) {
  const before = maxEventId(dataDir);
  reportAgent(context, pane, label, "blocked", sequence);
  return waitEvent(dataDir, before, instanceId,
    (event) => event.state === "needs_attention" && event.notification_status !== "none",
    "real needs_attention event");
}

async function waitNotificationWindow(page) {
  return waitFor(async () => {
    const snapshot = await snapshotOf(page);
    return snapshot.desktop?.notifications?.window?.visible ? snapshot : null;
  }, 20000, "notification window visible");
}
test("POL-WORKREACTION-001/003/004/007/009 真实非焦点 working→idle→done", {
  timeout: 300000,
  skip: process.env.HERDR_ENV === "1" ? "HERDR_ENV=1：不创建测试 server" : false,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-wr-root-");
  const dataDir = makeDataDir();
  const home = makeHome();
  const registryDir = path.join(dataDir, "herdr-registry");
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = {
    root, dataDir, home, server: null, app: null, cdp: [], traces: new Set(),
  };
  const cleanupErrors = [];
  let lastReactionAt = 0;
  let instanceId = "";
  try {
    resources.server = await startRealServer(root);
    setupPlugin(resources.server, registryDir);
    const control = createWorkspace(resources.server, "workreaction-control", true);
    const targets = ["t0", "t1", "t2", "t3", "p0"].map(
      (label, index) => ({ label, pane: createWorkspace(resources.server, `workreaction-${label}`, false), index }),
    );
    assert.ok(control, "focused control pane");
    invokeRegistration(resources.server);
    const registration = await waitFor(
      () => readRegistry(registryDir).find(
        (item) => item.observedServerPid === resources.server.child.pid,
      ) ?? null,
      15000,
      "real registration",
    );
    instanceId = registration.instanceId;
    let launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    await waitDesktopReady(launched.page);
    let canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    let notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");

    const target = (label) => targets.find((item) => item.label === label);
    // 001：触发前开始持续帧追踪，避免 ACK/重复回执延迟吞掉 happy 首帧。
    const statsBefore = statsOf(dataDir);
    const trace001 = startFrameTrace(canvas, resources);
    const first = await triggerFinished(
      resources.server, dataDir, instanceId, target("t0").pane, "t0", 1,
    );
    const ackFirst = await waitAck(dataDir, first.finished.id);
    const textFirst = await notificationTexts(notification);
    assert.match(textFirst, /已结束/);
    assert.doesNotMatch(textFirst, /成功/);
    const firstItems = await notificationItems(notification);
    const firstItem = firstItems.find((item) => item.eventId === first.finished.id);
    assert.ok(firstItem, "finished 应作为真实可见条目存在");
    assert.match(firstItem.source, /来源/);
    assert.ok(sourceMatches(firstItem, first.finished, "t0", instanceId),
      `来源需匹配 data-event-id/server/label 或 agent_id：${firstItem.source}`);
    assert.match(firstItem.meaning, /已结束/);
    const firstPanels = (await snapshotOf(launched.page)).desktop.notifications.panels;
    const firstPanel = firstPanels.find((item) => item.eventIds.includes(first.finished.id));
    assert.ok(firstPanel, "第一次 finished 应有呈现");
    assert.ok(firstPanel.eventIds.includes(first.finished.id));
    const firstToken = (await snapshotOf(launched.page)).desktop.notifications.token;
    // 在 happy 播放中重复回执同一事件；若重新触发，追踪会看到第二个 frame-00。
    await notification.page.evaluate(({ presentationId, ackToken, eventId }) => {
      window.notifications.ack(presentationId, ackToken, [eventId]);
    }, { presentationId: firstPanel.presentationId, ackToken: firstToken, eventId: first.finished.id });
    // 真实 working→idle 投影可能继续产生合法 idle/对账事件；先让来源事件
    // 结算，再只断言反应期间不再新增事件。来源事件种类全部记录。
    await delay(1000);
    const settledEvents = queryDb(dataDir, `
      SELECT id, kind, state, source_event_id, observation_id FROM connector_events
      WHERE id > ? AND instance_id = ? ORDER BY id ASC
    `, [first.finished.id, instanceId]);
    const settledFinished = queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE agent_id = ? AND state = 'finished'
    `, [first.working.agent_id])[0].count;
    await delay(1600);
    const firstFrames = await trace001.stop();
    const finalFinished = queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE agent_id = ? AND state = 'finished'
    `, [first.working.agent_id])[0].count;
    const finalEvents = queryDb(dataDir, `
      SELECT id, kind, state, source_event_id, observation_id FROM connector_events
      WHERE id > ? AND instance_id = ? ORDER BY id ASC
    `, [first.finished.id, instanceId]);
    const firstHappy = firstFrames.filter((frame) => frame.name.includes("happy-pixel-v4/"));
    const firstStart = firstFrames.find((frame) => frame.name.includes("happy-pixel-v4/frame-00.png"));
    if (firstStart) lastReactionAt = firstStart.at;
    const statsAfter = statsOf(dataDir);
    assert.equal(happyStarts(firstFrames), 1, "一次真实 finished 只开始一次 happy");
    assert.equal(firstHappy.length, 8, "happy 应完整 8 帧");
    assert.equal(new Set(firstHappy.map((frame) => frame.name)).size, 8, "happy 不得重复帧");
    assert.equal(finalFinished, settledFinished,
      "来源事件结算后，短反应不得再新增 finished 事件");
    assert.equal(finalEvents.length, settledEvents.length,
      "来源事件结算后，短反应不得再新增任何事件");
    assert.equal(queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM notification_presentation_items WHERE event_id = ?
    `, [first.finished.id])[0].count, 1, "同一 finished 不得重复呈现");
    assert.equal(statsAfter.intimacy, statsBefore.intimacy, "不得改亲密");
    assert.equal(statsAfter.mood, statsBefore.mood, "不得改心情");
    assert.ok(Math.abs(statsAfter.energy - statsBefore.energy) < 0.05, "只能有既有时间结算");
    writeCase("POL-WORKREACTION-001", {
      instanceId,
      workingEvent: first.working.id,
      finishedEvent: first.finished.id,
      finishedHistorical: first.finished.historical,
      ack: ackFirst.acknowledged_at,
      text: textFirst,
      frames: firstFrames,
      sourceItem: firstItem,
      statsBefore,
      statsAfter,
      sourceEvents: settledEvents,
      settledFinished,
      finalFinished,
    }, { boundary: "真实 Herdr 0.9.5 非焦点 pane；done 为 idle 投影。" });

    // 003：重复源状态/回执、子进程退出重启不重演。
    const notifiedFinishedBefore = queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE instance_id = ? AND state = 'finished' AND notification_status != 'none'
    `, [instanceId])[0].count;
    const traceDuplicate = startFrameTrace(canvas, resources);
    reportAgent(resources.server, target("t0").pane, "t0", "idle", 3);
    await delay(900);
    const notifiedFinishedAfter = queryDb(dataDir, `
      SELECT COUNT(*) AS count FROM connector_events
      WHERE instance_id = ? AND state = 'finished' AND notification_status != 'none'
    `, [instanceId])[0].count;
    assert.equal(notifiedFinishedAfter, notifiedFinishedBefore, "重复 idle 不得新增通知事件");
    await delay(1200);
    const duplicateFrames = await traceDuplicate.stop();
    assert.equal(happyStarts(duplicateFrames), 0, "重复源状态不得重演");

    const ackBeforeRestart = ackRow(dataDir, first.finished.id);
    const oldPid = (await snapshotOf(launched.page)).desktop.pid;
    process.kill(oldPid, "SIGKILL");
    const restarted = await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.desktop.state === "running"
        && snapshot.desktop.pid
        && snapshot.desktop.pid !== oldPid
        ? snapshot : null;
    }, 20000, "canvas restart");
    canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const traceRestart = startFrameTrace(canvas, resources);
    await delay(2000);
    const restartFrames = await traceRestart.stop();
    assert.equal(happyStarts(restartFrames), 0, "子进程重启不得重播已呈现事件");
    await waitFor(() => ackRow(dataDir, first.finished.id), 8000, "ack after restart");
    assert.equal(ackRow(dataDir, first.finished.id).acknowledged_at,
      ackBeforeRestart.acknowledged_at, "重启不得重复回执");
    writeCase("POL-WORKREACTION-003", {
      duplicateFinished: notifiedFinishedAfter - notifiedFinishedBefore,
      duplicateStart: happyStarts(duplicateFrames),
      duplicateAckExtraStarts: happyStarts(firstFrames) - 1,
      restartPid: restarted.desktop.pid,
      restartStart: happyStarts(restartFrames),
      ackStable: true,
    });

    // 004：一批一次、冷却内不补播、冷却后新事件可演。
    await waitFor(() => Date.now() - lastReactionAt >= 10200, 12000, "cooldown before batch");
    const traceBatch = startFrameTrace(canvas, resources);
    const batchA = await triggerFinished(
      resources.server, dataDir, instanceId, target("t1").pane, "t1", 1,
    );
    await waitAck(dataDir, batchA.finished.id);
    const batchAItem = (await notificationItems(notification))
      .find((item) => item.eventId === batchA.finished.id);
    assert.ok(batchAItem, "batch A 应真实可见");
    assert.match(batchAItem.meaning, /已结束/);
    assert.ok(sourceMatches(batchAItem, batchA.finished, "t1", instanceId),
      `batch A 来源：${batchAItem.source}`);
    const batchB = await triggerFinished(
      resources.server, dataDir, instanceId, target("t2").pane, "t2", 1,
    );
    await waitAck(dataDir, batchB.finished.id);
    const batchBItem = (await notificationItems(notification))
      .find((item) => item.eventId === batchB.finished.id);
    assert.ok(batchBItem, "batch B 应真实可见");
    assert.match(batchBItem.meaning, /已结束/);
    assert.ok(sourceMatches(batchBItem, batchB.finished, "t2", instanceId),
      `batch B 来源：${batchBItem.source}`);
    const batchText = await notificationTexts(notification);
    assert.match(batchText, /已结束/);
    await delay(2600);
    const batchFrames = await traceBatch.stop();
    assert.equal(happyStarts(batchFrames), 1, "一批 finished 只表演一次");
    const batchStart = batchFrames.find((frame) => frame.name.includes("happy-pixel-v4/frame-00.png"));
    if (batchStart) lastReactionAt = batchStart.at;
    const lastBatchReaction = lastReactionAt;
    const traceCooldown = startFrameTrace(canvas, resources);
    const cooldownDone = await triggerFinished(
      resources.server, dataDir, instanceId, target("t3").pane, "t3", 1,
    );
    await waitAck(dataDir, cooldownDone.finished.id);
    const cooldownText = await notificationTexts(notification);
    assert.match(cooldownText, /已结束/);
    await delay(1200);
    const cooldownFrames = await traceCooldown.stop();
    assert.equal(happyStarts(cooldownFrames), 0, "冷却内不补播");
    await waitFor(() => Date.now() - lastBatchReaction >= 10200, 12000, "new cooldown");
    const traceCooled = startFrameTrace(canvas, resources);
    const cooled = await triggerFinished(
      resources.server, dataDir, instanceId, target("t3").pane, "t3", 3,
    );
    await waitAck(dataDir, cooled.finished.id);
    await delay(2400);
    const cooledFrames = await traceCooled.stop();
    assert.equal(happyStarts(cooledFrames), 1, "冷却后新事件可表演");
    const cooledStart = cooledFrames.find((frame) => frame.name.includes("happy-pixel-v4/frame-00.png"));
    if (cooledStart) lastReactionAt = cooledStart.at;
    writeCase("POL-WORKREACTION-004", {
      batchEvents: [batchA.finished.id, batchB.finished.id],
      batchText,
      batchItems: [batchAItem, batchBItem],
      batchStarts: happyStarts(batchFrames),
      cooldownEvent: cooldownDone.finished.id,
      cooldownText,
      cooldownStarts: happyStarts(cooldownFrames),
      newEvent: cooled.finished.id,
      newStarts: happyStarts(cooledFrames),
    });

    // 007：冷却已过、P0 实际可见、其他门禁满足时抑制庆祝；文字在回执时捕获。
    await waitFor(() => Date.now() - lastReactionAt >= 10200, 12000, "cooldown before P0");
    const blocked = await triggerBlocked(
      resources.server, dataDir, instanceId, target("p0").pane, "p0", 1,
    );
    await waitNotificationWindow(launched.page);
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.desktop.notifications.panels.some(
        (item) => item.channel === "urgent" && item.eventIds.includes(blocked.id),
      ) ? snapshot : null;
    }, 10000, "P0 urgent panel visible");
    const traceP0 = startFrameTrace(canvas, resources);
    const p0Done = await triggerFinished(
      resources.server, dataDir, instanceId, target("t1").pane, "t1", 5,
    );
    await waitAck(dataDir, p0Done.finished.id);
    const p0TextAtAck = await notificationTexts(notification);
    assert.match(p0TextAtAck, /需要确认/);
    assert.match(p0TextAtAck, /已结束/);
    await delay(2000);
    const p0Frames = await traceP0.stop();
    assert.equal(happyStarts(p0Frames), 0, "P0 可见期间不得庆祝");
    writeCase("POL-WORKREACTION-007", {
      blocked: blocked.id,
      finished: p0Done.finished.id,
      textAtAck: p0TextAtAck,
      starts: happyStarts(p0Frames),
    });

    // 009：先等 P0 自然消散、冷却已过且凛处于合资格 idle，避免 P0 掩盖历史过滤。
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      const urgent = snapshot.desktop.notifications.panels.some(
        (item) => item.channel === "urgent" && item.eventIds.includes(blocked.id),
      );
      return !urgent ? snapshot : null;
    }, 20000, "P0 naturally cleared");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current?.characterId === "rin"
        && snapshot.companionship.current?.mode === "companion"
        && snapshot.companionship.current?.activity === null
        && snapshot.desktop?.displayedFrame?.includes("idle-pixel-v2/")
        ? snapshot : null;
    }, 10000, "rin idle eligible before history");
    await waitFor(() => Date.now() - lastReactionAt >= 10200, 12000, "cooldown before history");
    const run = queryDb(dataDir, `
      SELECT r.instance_id, r.run_id, r.app_run_id
      FROM connector_runs r JOIN connector_instances i ON i.instance_id = r.instance_id
      WHERE i.current_run_id = r.run_id AND r.online = 1
      ORDER BY r.registered_at DESC LIMIT 1
    `)[0];
    assert.ok(run, "需要在线运行代次");
    execDb(dataDir, `
      INSERT INTO connector_events (
        app_run_id, instance_id, run_id, agent_id, kind, state, raw_state, sequence,
        source_event_id, priority, original_priority, historical, notification_status, received_at
      ) VALUES (?, ?, ?, 'term-history', 'agent_change', 'finished', 'done', 30,
        'history-finished-1', 1, 1, 1, 'pending', ?)
    `, [run.app_run_id, run.instance_id, run.run_id, Date.now()]);
    const traceHistory = startFrameTrace(canvas, resources);
    const history = await waitFor(() => queryDb(dataDir, `
      SELECT * FROM connector_events WHERE source_event_id = 'history-finished-1'
    `)[0] ?? null, 5000, "history event");
    await waitAck(dataDir, history.id);
    await delay(1500);
    const historyFrames = await traceHistory.stop();
    assert.equal(happyStarts(historyFrames), 0, "历史 finished 不得补播");

    const oldAck = ackRow(dataDir, first.finished.id);
    await closeApp(resources.app);
    launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    await waitDesktopReady(launched.page);
    canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const traceRestartOld = startFrameTrace(canvas, resources);
    await delay(2000);
    const restartOldFrames = await traceRestartOld.stop();
    assert.equal(happyStarts(restartOldFrames), 0, "重启不得重播旧 presented");
    assert.equal(ackRow(dataDir, first.finished.id).acknowledged_at, oldAck.acknowledged_at);
    await waitFor(() => Date.now() - lastReactionAt >= 10200, 12000, "post-restart cooldown");
    const traceAfterRestart = startFrameTrace(canvas, resources);
    const afterRestart = await triggerFinished(
      resources.server, dataDir, instanceId, target("t2").pane, "t2", 5,
    );
    await waitAck(dataDir, afterRestart.finished.id);
    await delay(2400);
    const afterRestartFrames = await traceAfterRestart.stop();
    assert.equal(happyStarts(afterRestartFrames), 1, "重启后新 finished 应正常反应");
    writeCase("POL-WORKREACTION-009", {
      historyEvent: history.id,
      historyStarts: happyStarts(historyFrames),
      restartOldStarts: happyStarts(restartOldFrames),
      newEvent: afterRestart.finished.id,
      newStarts: happyStarts(afterRestartFrames),
      historyBoundary: "历史事件为构造 SQLite 输入；真实非焦点路径见 001/003。",
    });
  } catch (error) {
    resources.primaryError = error;
    writeCase("POL-WORKREACTION-001-009-failure", { instanceId }, { failure: error });
    throw error;
  } finally {
    if (resources.frozenCanvas) {
      await setCanvasFrozen(resources.frozenCanvas, false).catch(() => {});
      resources.frozenCanvas = null;
    }
    const secondaryErrors = [];
    for (const trace of resources.traces) {
      await trace.stop().catch((error) => {
        cleanupErrors.push(error);
        secondaryErrors.push(error);
      });
    }
    resources.traces.clear();
    await closeApp(resources.app);
    await stopRealServer(resources.server).catch((error) => cleanupErrors.push(error));
    for (const cdp of resources.cdp) await cdp.close().catch(() => {});
    cleanupDirs([root, dataDir, home], cleanupErrors);
    if (secondaryErrors.length > 0) {
      fs.writeFileSync(path.join(RUN_DIR, "secondary-errors.log"),
        `${secondaryErrors.map((error) => error.stack || error.message).join("\n")}\n`);
    }
    if (!resources.primaryError) {
      assert.deepEqual(cleanupErrors, [], "本轮自建环境应清理干净");
    }
  }
});
test("POL-WORKREACTION-002/008 渲染层剩余时长、几何与取消", {
  timeout: 180000,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-workreaction-render-"));
  process.env.BAYPER_DESKTOP_DEBUG_PORT = "1";
  const nodes = [];
  const host = createDesktopHost({
    dataDir, electronPath, onNodeComplete: (node) => nodes.push({ node, at: Date.now() }),
  });
  const rin = getRinAnimations();
  const presentation = {
    character: { id: "rin", displayName: "凛" },
    animations: {
      idle: rin.idle, wave: rin.wave, stretch: rin.stretch, sit: rin.sit,
      drowsy: rin.drowsy, sleep: rin.sleep, happy: rin.happy, display: rin.display,
    },
    assetState: "ready", assetLabel: "render", assetNote: "",
    mode: "companion", resting: false, restToken: 0, activity: null,
    visible: true, ignoreMouse: false, position: null,
  };
  let browser = null;
  let lateHost = null;
  let lateBrowser = null;
  let lateDir = null;
  const cleanupErrors = [];
  try {
    host.start(presentation);
    await waitFor(() => host.getStatus().displayedFrame, 15000, "host ready");
    const canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    browser = canvas.browser;
    const geometry = () => canvas.page.evaluate(() => {
      const sprite = document.getElementById("sprite");
      const rect = sprite.getBoundingClientRect();
      return {
        windowWidth: window.innerWidth, windowHeight: window.innerHeight,
        imageWidth: rect.width, imageHeight: rect.height, left: rect.left, top: rect.top,
        naturalWidth: sprite.naturalWidth, naturalHeight: sprite.naturalHeight,
        rendering: getComputedStyle(sprite).imageRendering,
      };
    });

    // 002：在 350ms 的 frame-07 故意消耗约 140ms 后触发，区分剩余与完整重播。
    await waitFrame(canvas, "idle-pixel-v2/frame-07.png");
    const frameSeenAt = Date.now();
    await delay(140);
    const before = await geometry();
    const idleBefore = spriteName(await currentSprite(canvas));
    assert.equal(idleBefore, "idle-pixel-v2/frame-07.png");
    assert.equal(host.sendWorkReaction({ eventIds: [101], characterId: "rin" }), true);
    const sentAt = Date.now();
    const expectedRemaining = Math.max(16, 350 - (sentAt - frameSeenAt));
    const frames = [];
    let during = null;
    const sampleEnd = Date.now() + 3000;
    let lastFrame = "";
    while (Date.now() < sampleEnd) {
      const name = spriteName(await currentSprite(canvas));
      if (name && name !== lastFrame) {
        frames.push({ name, at: Date.now() });
        lastFrame = name;
        if (name.includes("happy-pixel-v4/frame-04.png") && !during) {
          during = await geometry();
        }
      }
      await delay(15);
    }
    const happy = frames.filter((frame) => frame.name.includes("happy-pixel-v4/"));
    const happyFirst = happy[0];
    const happyLast = happy.at(-1);
    const resume = frames.find((frame) => frame.at > (happyLast?.at ?? 0)
      && frame.name.includes("idle-pixel-v2/"));
    const resumedNext = frames.find((frame) => frame.at > (resume?.at ?? 0)
      && frame.name.includes("idle-pixel-v2/") && frame.name !== resume?.name);
    assert.equal(happy.length, 8, "happy 应完整 8 帧");
    assert.equal(resume?.name, idleBefore, "happy 后应恢复原 idle 帧");
    const measuredRemaining = (resumedNext?.at ?? Date.now()) - (resume?.at ?? Date.now());
    const happyDuration = (resume?.at ?? Date.now()) - (happyFirst?.at ?? Date.now());
    assert.ok(happyDuration >= 1700 && happyDuration <= 1950,
      `happy 时长应接近 1790ms，实际 ${happyDuration}`);
    assert.ok(Math.abs(measuredRemaining - expectedRemaining) <= 90,
      `剩余时长应接近 ${expectedRemaining}ms，实际 ${measuredRemaining}ms`);
    assert.deepEqual(during, before, "反应中画布几何不得变化");
    const after = await geometry();
    assert.deepEqual(after, before, "反应后画布几何不得变化");
    const happyNodes = nodes.filter((item) => item.at >= sentAt
      && !["idle-loop"].includes(item.node));
    assert.deepEqual(happyNodes, [], "短反应不得发送日常/休息/起立节点");
    const idleLoops = nodes.filter((item) => item.node === "idle-loop" && item.at >= sentAt);
    assert.ok(idleLoops.every((item) => item.at >= (resume?.at ?? Infinity)),
      "idle-loop 不得在 happy 或恢复前发送");
    const screenshot = path.join(RUN_DIR, "POL-WORKREACTION-002-resume.png");
    await canvas.page.screenshot({ path: screenshot });
    writeCase("POL-WORKREACTION-002", {
      idleBefore, expectedRemaining, measuredRemaining, happyDuration,
      frames, geometryBefore: before, geometryDuring: during, geometryAfter: after,
      nodes,
    }, { screenshots: [screenshot] });

    // 自然节点真实 waiter：happy 完整 + idle 剩余串行后才有 idle-loop，
    // 旧 max+1200=3080ms 不足以覆盖此路径。
    await waitFrame(canvas, "idle-pixel-v2/frame-00.png");
    assert.equal(host.sendWorkReaction({ eventIds: [109], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-00.png");
    // 用户是在 happy 真正开始后才请求节点；waiter 不得早于恢复 idle-loop。
    const waiterStarted = Date.now();
    const boundaryPromise = host.waitForNodeBoundary(4870);
    const boundaryResult = await boundaryPromise;
    const boundaryMs = Date.now() - waiterStarted;
    assert.equal(boundaryResult.ok, true);
    assert.equal(boundaryResult.node, "idle-loop");
    assert.ok(boundaryMs >= 3200, `串行 happy+idle 不应在旧上限前完成，实际 ${boundaryMs}ms`);
    assert.ok(boundaryMs < 4870, `自然节点等待不得超时，实际 ${boundaryMs}ms`);
    await waitFrame(canvas, "idle-pixel-v2/frame-");

    // 008：点击、聊天、隐藏、暂停、换人、休息都不得留下 happy 或复活旧反应。
    const assertIdleAdvancing = async (label) => {
      // 覆盖完整待机周期：至少两个不同 idle 帧，且任何位置都不得出现 happy。
      const samples = await sampleFrames(canvas, 2200, 20);
      const names = samples.map((frame) => frame.name);
      const idle = [...new Set(names.filter((name) => name.includes("idle-pixel-v2/")))];
      assert.ok(idle.length >= 2, `${label} 后应持续播放 idle，实际 ${idle.join(",")}`);
      assert.equal(names.some((name) => name.includes("happy-pixel-v4/")), false,
        `${label} 后不得出现任何 happy 帧`);
      return names;
    };
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    assert.equal(host.sendWorkReaction({ eventIds: [102], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    await canvas.page.locator("#stage").click({ position: { x: 52, y: 70 } });
    await waitFrame(canvas, "wave-pixel-v1/frame-");
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const clickIdle = await assertIdleAdvancing("click");

    assert.equal(host.sendWorkReaction({ eventIds: [103], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({ ...presentation, mode: "interacting" });
    await assertIdleAdvancing("chat");
    host.update(presentation);
    await assertIdleAdvancing("chat close");

    assert.equal(host.sendWorkReaction({ eventIds: [104], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({ ...presentation, visible: false });
    await assertIdleAdvancing("hidden");
    host.update(presentation);
    await assertIdleAdvancing("shown");

    assert.equal(host.sendWorkReaction({ eventIds: [105], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({ ...presentation, systemPaused: true });
    await assertIdleAdvancing("paused");
    host.update(presentation);
    await assertIdleAdvancing("resumed");

    assert.equal(host.sendWorkReaction({ eventIds: [106], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({ ...presentation, resting: true, restToken: 1 });
    await waitFrame(canvas, "sit-pixel-v2-canvas256/frame-");
    const restSample = await sampleFrames(canvas, 700);
    assert.ok(restSample.some((frame) => frame.name.includes("sit-pixel-v2-canvas256/")),
      "休息应接管画布");
    assert.equal(happyStarts(restSample), 0, "休息后不得重新开始 happy");
    host.update(presentation);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    assert.equal(host.sendWorkReaction({ eventIds: [107], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({
      ...presentation, mode: "daily",
      activity: {
        activityId: "wr-daily-1", characterId: "rin", kind: "daily", status: "running",
        durationMs: 10000, activeElapsedMs: 0, actionComplete: false, actionProgress: 0,
      },
    });
    await waitFrame(canvas, "stretch-pixel-v2-canvas256/frame-");
    const dailySample = await sampleFrames(canvas, 900);
    assert.equal(happyStarts(dailySample), 0, "日常播放中不得插入 happy");
    host.update(presentation);
    await waitFrame(canvas, "idle-pixel-v2/frame-");

    const hu = getHuAnimations();
    assert.equal(host.sendWorkReaction({ eventIds: [108], characterId: "rin" }), true);
    await waitFrame(canvas, "happy-pixel-v4/frame-01.png");
    host.update({
      ...presentation,
      displayKey: "switch-hu",
      character: { id: "hu", displayName: "琥珀" },
      animations: {
        idle: hu.idle, wave: hu.wave, stretch: hu.stretch, sit: null,
        drowsy: null, sleep: null, happy: null, display: hu.display,
      },
    });
    await waitFrame(canvas, "idle-pixel-v2-canvas320/frame-");
    const switchFrames = await sampleFrames(canvas, 2200, 20);
    const switchIdle = [...new Set(switchFrames
      .map((frame) => frame.name)
      .filter((name) => name.includes("idle-pixel-v2-canvas320/")))];
    assert.ok(switchIdle.length >= 2, "换人后应持续播放新角色 idle");
    assert.equal(happyStarts(switchFrames), 0, "换人后旧 happy 不得续播");
    // 传输边界：host 未启动时发送必须拒绝，随后启动不得补播该消息。
    lateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-workreaction-late-"));
    lateHost = createDesktopHost({ dataDir: lateDir, electronPath });
    const notReadyRefused = lateHost.sendWorkReaction({ eventIds: [110], characterId: "rin" });
    assert.equal(notReadyRefused, false, "host 未启动时不得接受反应");
    lateHost.start(presentation);
    await waitFor(() => lateHost.getStatus().displayedFrame, 15000, "late host ready");
    const lateCanvas = await connectPage(lateDir, "/app/desktop/renderer/index.html");
    lateBrowser = lateCanvas.browser;
    await waitFrame(lateCanvas, "idle-pixel-v2/frame-");
    const lateFrames = await sampleFrames(lateCanvas, 1500);
    assert.equal(happyStarts(lateFrames), 0, "未启动时拒绝的反应不得在启动后补播");
    writeCase("POL-WORKREACTION-008", {
      clickIdle, dailyStarts: happyStarts(dailySample), switchStarts: happyStarts(switchFrames),
      boundaryWait: { ms: boundaryMs, result: boundaryResult }, nodes,
      notReadyRefused, notReadyStarts: happyStarts(lateFrames),
    }, { boundary: "直接正式画布子进程；主进程门禁另由真实 app Case 覆盖。" });
  } catch (error) {
    writeCase("POL-WORKREACTION-002-008-failure", { nodes }, { failure: error });
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (lateBrowser) await lateBrowser.close().catch(() => {});
    if (lateHost) await lateHost.stop().catch((error) => cleanupErrors.push(error));
    await host.stop().catch((error) => cleanupErrors.push(error));
    cleanupDirs([dataDir, lateDir], cleanupErrors);
    assert.deepEqual(cleanupErrors, [], "渲染层临时环境应清理干净");
  }
});
test("POL-WORKREACTION-005/006 主进程门禁真实状态", {
  timeout: 240000,
  skip: process.env.HERDR_ENV === "1" ? "HERDR_ENV=1：不创建测试 server" : false,
}, async () => {
  const root = fs.mkdtempSync("/tmp/bayper-wr-gate-");
  const dataDir = makeDataDir();
  const home = makeHome();
  const registryDir = path.join(dataDir, "herdr-registry");
  fs.mkdirSync(registryDir, { recursive: true });
  const resources = {
    root, dataDir, home, server: null, app: null, cdp: [], traces: new Set(),
  };
  const cleanupErrors = [];
  let instanceId = "";
  try {
    resources.server = await startRealServer(root);
    setupPlugin(resources.server, registryDir);
    createWorkspace(resources.server, "gate-control", true);
    const targets = ["g0", "g1", "g2", "g3"].map(
      (label) => ({ label, pane: createWorkspace(resources.server, `gate-${label}`, false) }),
    );
    invokeRegistration(resources.server);
    const registration = await waitFor(
      () => readRegistry(registryDir).find(
        (item) => item.observedServerPid === resources.server.child.pid,
      ) ?? null, 15000, "gate registration",
    );
    instanceId = registration.instanceId;
    let launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    await waitDesktopReady(launched.page);
    let canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    let notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const target = (label) => targets.find((item) => item.label === label);

    const assertNoReaction = async (label, duration = 1800) => {
      await delay(180);
      const frames = [];
      const end = Date.now() + duration;
      let last = "";
      while (Date.now() < end) {
        const name = spriteName(await currentSprite(canvas));
        if (name && name !== last) { frames.push(name); last = name; }
        await delay(25);
      }
      assert.equal(frames.some((frame) => {
        const name = typeof frame === "string" ? frame : frame.name;
        return name.includes("happy-pixel-v4/");
      }), false, `${label} 不得出现任何 happy 帧`);
      return frames;
    };

    const chat = await launched.page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chat.ok, true, JSON.stringify(chat));
    assert.equal((await snapshotOf(launched.page)).companionship.current.mode, "interacting");
    const chatEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g0").pane, "g0", 1,
    );
    await waitAck(dataDir, chatEvent.finished.id);
    const chatText = await notificationTexts(notification);
    assert.match(chatText, /已结束/);
    const chatFrames = await assertNoReaction("聊天");
    assert.equal((await snapshotOf(launched.page)).companionship.current.mode, "interacting");
    const chatClosed = await launched.page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(chatClosed.ok, true, JSON.stringify(chatClosed));
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current.mode === "companion" ? snapshot : null;
    }, 8000, "chat closed");

    const restStarted = await launched.page.evaluate(() => window.bayper.restCompanion());
    assert.equal(restStarted.ok, true, JSON.stringify(restStarted));
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current.mode === "resting"
        && snapshot.desktop?.displayedFrame?.includes("sit-pixel-v2-canvas256/")
        ? snapshot : null;
    }, 20000, "rest seated");
    const restEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g1").pane, "g1", 1,
    );
    await waitAck(dataDir, restEvent.finished.id);
    const restText = await notificationTexts(notification);
    assert.match(restText, /已结束/);
    const restFrames = await assertNoReaction("休息");
    assert.ok(restFrames.some((name) => name.includes("sit-pixel-v2-canvas256/")));
    // 必须等到真实 sleep 循环帧，不能以 drowsy 末帧代替睡眠。
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.desktop?.displayedFrame?.includes("sleep-pixel-v2-canvas256/frame-")
        ? snapshot : null;
    }, 32000, "real sleep frame");
    const sleepEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g1").pane, "g1", 3,
    );
    await waitAck(dataDir, sleepEvent.finished.id);
    const sleepFrames = await assertNoReaction("睡眠子态", 1500);
    const sleepFrame = (await snapshotOf(launched.page)).desktop.displayedFrame;
    assert.match(sleepFrame, /sleep-pixel-v2-canvas256\/frame-/);
    const companionBack = await launched.page.evaluate(
      () => window.bayper.switchCompanion("rin"),
    );
    assert.equal(companionBack.ok, true, JSON.stringify(companionBack));
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current.mode === "companion" ? snapshot : null;
    }, 10000, "companion back");
    await waitFrame(canvas, "idle-pixel-v2/frame-");

    const now = Date.now();
    execDb(dataDir, `
      INSERT INTO character_activities (
        activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
        started_at, last_progress_at, created_at, updated_at
      ) VALUES ('wr-daily-gate', 'rin', 'daily', 'running', 600000, 0, ?, ?, ?, ?)
    `, [now, now, now, now]);
    execDb(dataDir, "UPDATE character_runtime SET mode = 'daily' WHERE character_id = 'rin'");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current.activity?.activityId === "wr-daily-gate"
        ? snapshot : null;
    }, 8000, "daily state");
    const dailyEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g2").pane, "g2", 1,
    );
    await waitAck(dataDir, dailyEvent.finished.id);
    const dailyFrames = await assertNoReaction("日常");
    assert.equal(queryDb(dataDir,
      "SELECT status, action_frame FROM character_activities WHERE activity_id = 'wr-daily-gate'")[0].status,
    "running");
    execDb(dataDir, "DELETE FROM character_activities WHERE activity_id = 'wr-daily-gate'");
    execDb(dataDir, "UPDATE character_runtime SET mode = 'companion' WHERE character_id = 'rin'");
    await delay(500);

    execDb(dataDir, `
      INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES ('hu', ?)
    `, [new Date().toISOString()]);
    execDb(dataDir, `
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES ('hu', 10, 100, 0)
    `);
    execDb(dataDir, `
      INSERT OR IGNORE INTO character_runtime (character_id, mode, last_settled_at, exploring)
      VALUES ('hu', 'companion', ?, 0)
    `, [now]);
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('current_character_id', 'hu') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current?.characterId === "hu"
        && snapshot.desktop?.characterId === "hu" ? snapshot : null;
    }, 10000, "exploration successor on screen");

    execDb(dataDir, `
      INSERT INTO character_activities (
        activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
        started_at, last_progress_at, created_at, updated_at
      ) VALUES ('wr-explore-gate', 'rin', 'exploration', 'running', 600000, 0, ?, ?, ?, ?)
    `, [now, now, now, now]);
    execDb(dataDir,
      "UPDATE character_runtime SET mode = 'exploring', exploring = 1 WHERE character_id = 'rin'");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.desktop?.characterId === "hu"
        && snapshot.companionship.characters.find(
          (item) => item.characterId === "rin",
        )?.exploring === true
        ? snapshot : null;
    }, 8000, "exploration state");
    const exploreEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g3").pane, "g3", 1,
    );
    await waitAck(dataDir, exploreEvent.finished.id);
    const exploreFrames = await assertNoReaction("探索");
    const exploreSnapshot = await snapshotOf(launched.page);
    assert.equal(exploreSnapshot.desktop.characterId, "hu",
      "探索者应离桌，当前窗口由接替者承担");
    assert.equal(exploreSnapshot.companionship.characters.find(
      (item) => item.characterId === "rin",
    )?.exploring, true, "探索者保持离桌，不得被事件召回");
    assert.equal(queryDb(dataDir,
      "SELECT status FROM character_activities WHERE activity_id = 'wr-explore-gate'")[0].status,
    "running");
    execDb(dataDir, "DELETE FROM character_activities WHERE activity_id = 'wr-explore-gate'");
    execDb(dataDir,
      "UPDATE character_runtime SET mode = 'companion', exploring = 0 WHERE character_id = 'rin'");
    await delay(500);

    execDb(dataDir, `
      INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES ('hu', ?)
    `, [new Date().toISOString()]);
    execDb(dataDir, `
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES ('hu', 10, 100, 0)
    `);
    execDb(dataDir, `
      INSERT OR IGNORE INTO character_runtime (character_id, mode, last_settled_at, exploring)
      VALUES ('hu', 'companion', ?, 0)
    `, [now]);
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('current_character_id', 'hu') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    await waitFor(async () => {
      const snapshot = await snapshotOf(launched.page);
      return snapshot.companionship.current?.characterId === "hu"
        && snapshot.desktop?.characterId === "hu"
        ? snapshot : null;
    }, 10000, "hu current");
    const huEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g0").pane, "g0", 3,
    );
    await waitAck(dataDir, huEvent.finished.id);
    const huFrames = await assertNoReaction("非凛");
    assert.equal((await snapshotOf(launched.page)).desktop.characterId, "hu");
    // 暂停：通知窗口冻结，不等待不可能的 ACK；只观察无 happy/无 ACK。
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(async () => (await snapshotOf(launched.page)).system.paused === true,
      5000, "system paused");
    const pausedEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g2").pane, "g2", 5,
    );
    await delay(1500);
    const pausedSnapshot = await snapshotOf(launched.page);
    assert.equal(pausedSnapshot.desktop.notifications.window?.visible, false);
    assert.equal(ackRow(dataDir, pausedEvent.finished.id), null, "暂停中不得伪造 ACK");
    const pausedFrames = await assertNoReaction("暂停", 1200);
    await launched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(1200);
    await closeApp(resources.app);
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('current_character_id', 'rin') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('pending_rotation', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const tracePreHandoff = startFrameTrace(canvas, resources);
    await delay(150);
    const preHandoffFrames = await tracePreHandoff.stop();
    // 先冻结仅画布渲染 JS，再写入 pending；主进程/通知/Herdr 继续运行。
    const handoffFrozenSprite = spriteName(await currentSprite(canvas));
    await setCanvasFrozen(canvas, true);
    resources.frozenCanvas = canvas;
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('pending_rotation', 'low_energy') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    await waitDesktopReady(launched.page);
    notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFor(async () => (await snapshotOf(launched.page)).companionship.pendingRotation === true,
      8000, "handoff pending read by heartbeat");
    await delay(700);
    const handoffSnapshot = await snapshotOf(launched.page);
    assert.equal(handoffSnapshot.companionship.pendingRotation, true,
      "交接状态需在 ACK 前真实生效");
    const handoffEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g1").pane, "g1", 7,
    );
    const handoffAck = await waitAck(dataDir, handoffEvent.finished.id).catch((error) => {
      throw new Error(`ERROR: canvas pause blocked notification ACK: ${error.message}`);
    });
    const handoffAtAck = await snapshotOf(launched.page);
    assert.equal(handoffAtAck.companionship.pendingRotation, true,
      "ACK 时交接必须仍 pending");
    await setCanvasFrozen(canvas, false);
    resources.frozenCanvas = null;
    const traceHandoff = startFrameTrace(canvas, resources);
    await waitFor(async () => (await snapshotOf(launched.page)).companionship.pendingRotation === false,
      10000, "natural handoff completion");
    await delay(2000);
    const handoffFrames = await traceHandoff.stop();
    assert.equal(handoffFrames.some((frame) => frame.name.includes("happy-pixel-v4/")), false,
      "交接恢复至结束期间不得出现任意 happy 帧");
    assert.equal(preHandoffFrames.some((frame) => frame.name.includes("happy-pixel-v4/")), false);

    // 隐藏：角色隐藏不影响通知窗口可见；通知仍真实 ACK 并显示文字，
    // 恢复显示后不重复 ACK、不重播表演。
    await closeApp(resources.app);
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('pending_rotation', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('desktop_visible', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    await waitDesktopReady(launched.page);
    canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const hiddenEvent = await triggerFinished(
      resources.server, dataDir, instanceId, target("g3").pane, "g3", 5,
    );
    await delay(1500);
    const hiddenSnapshot = await snapshotOf(launched.page);
    // 角色隐藏与通知窗口可见性独立：通知窗口仍可见并真实 ACK。
    assert.equal(hiddenSnapshot.desktop.notifications.window?.visible, true,
      "角色隐藏不得等同通知窗口隐藏");
    const hiddenAck = ackRow(dataDir, hiddenEvent.finished.id);
    assert.ok(hiddenAck, "隐藏期间通知仍应真实 ACK");
    const hiddenText = await notificationTexts(notification);
    assert.match(hiddenText, /已结束/);
    const hiddenFrames = await assertNoReaction("隐藏", 1200);
    await closeApp(resources.app);
    execDb(dataDir,
      "INSERT INTO app_state (key, value) VALUES ('desktop_visible', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    launched = await launchApp(dataDir, home);
    resources.app = launched.app;
    await waitDesktopReady(launched.page);
    canvas = await connectPage(dataDir, "/app/desktop/renderer/index.html");
    notification = await connectPage(dataDir, "notification.html");
    resources.cdp.push(canvas.browser, notification.browser);
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    await waitFrame(canvas, "idle-pixel-v2/frame-");
    const traceRecovered = startFrameTrace(canvas, resources);
    await delay(1800);
    const recoveredFrames = await traceRecovered.stop();
    assert.equal(happyStarts(recoveredFrames), 0, "恢复显示后不得重播");
    assert.equal(recoveredFrames.some((frame) => frame.name.includes("happy-pixel-v4/")), false);
    const ackAfterRestore = ackRow(dataDir, hiddenEvent.finished.id);
    assert.equal(ackAfterRestore.acknowledged_at, hiddenAck.acknowledged_at,
      "恢复显示不得重复 ACK");
    writeCase("POL-WORKREACTION-005/006", {
      chatFrames, chatText, restFrames, restText, dailyFrames, exploreFrames,
      huFrames, sleepFrames, sleepFrame, pausedFrames, handoffFrames,
      handoffAtAck: handoffAtAck.companionship.pendingRotation,
      handoffFrozenSprite, preHandoffFrames,
      handoffAck: handoffAck.acknowledged_at, hiddenFrames,
      hiddenWindowVisible: true, hiddenAck: hiddenAck.acknowledged_at,
      hiddenText, ackAfterRestore: ackAfterRestore.acknowledged_at,
      recoveredStarts: happyStarts(recoveredFrames),
      boundaries: [
        "聊天/休息为真实 API；日常/探索/非凛/交接/隐藏/暂停为构造数据库或系统状态，已断言目标状态生效。",
        "睡眠已实际等待 20s 并确认 sleep-pixel-v2-canvas256 帧；未就绪由渲染组 host 未启动拒绝覆盖（传输边界，非主进程全链）。",
        "角色隐藏但通知窗口可见并真实 ACK/显示已结束；恢复显示不重复 ACK、不重播；暂停时通知窗口隐藏且无 ACK。",
      ],
    });
  } catch (error) {
    resources.primaryError = error;
    writeCase("POL-WORKREACTION-005-006-failure", { instanceId }, { failure: error });
    throw error;
  } finally {
    if (resources.frozenCanvas) {
      await setCanvasFrozen(resources.frozenCanvas, false).catch(() => {});
      resources.frozenCanvas = null;
    }
    const secondaryErrors = [];
    for (const trace of resources.traces) {
      await trace.stop().catch((error) => {
        cleanupErrors.push(error);
        secondaryErrors.push(error);
      });
    }
    resources.traces.clear();
    await closeApp(resources.app);
    await stopRealServer(resources.server).catch((error) => cleanupErrors.push(error));
    for (const cdp of resources.cdp) await cdp.close().catch(() => {});
    cleanupDirs([root, dataDir, home], cleanupErrors);
    if (secondaryErrors.length > 0) {
      fs.writeFileSync(path.join(RUN_DIR, "secondary-errors.log"),
        `${secondaryErrors.map((error) => error.stack || error.message).join("\n")}\n`);
    }
    if (!resources.primaryError) {
      assert.deepEqual(cleanupErrors, [], "本轮自建环境应清理干净");
    }
  }
});
