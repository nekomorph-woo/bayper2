/* S06d 正式日常/探索运行时验收：真实 Electron 主进程、SQLite、桌面自然节点与自动机会。
   只注入加速时钟/随机数；活动、精力、名单、持久事实仍由正式 companionship/activity-runtime 处理。
   不读取真实会话/Key；来源用例只构造本地目录与预算事实。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { getRinAnimations } = require("../../app/desktop-assets.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const EVIDENCE_ROOT = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s06d-runtime-activities",
);
const BATCH_ID = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${Math.random()
  .toString(16)
  .slice(2, 8)}`;
const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, `run-${BATCH_ID}`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    `source: tests/acceptance/activity-runtime.spec.cjs`,
    `evidence: ${EVIDENCE_DIR}`,
    "",
  ].join("\n"),
);

const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const SOURCE_SECRET = "S06D-CONSTRUCTED-SOURCE";
// 正式陪伴模式的基础精力速率；用于把正常时间结算从活动扣费中分离出来。
const COMPANION_ENERGY_PER_HOUR = -6;
let notificationSequence = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, timeout = 15000, message = "等待条件超时") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) {
      return;
    }
    await delay(40);
  }
  assert.fail(message);
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dbFile(dataDir) {
  return path.join(dataDir, DB_FILE);
}

function openDb(dataDir, readOnly = false) {
  return new DatabaseSync(dbFile(dataDir), readOnly ? { readOnly: true } : {});
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function setPurpose(dataDir, purpose) {
  const db = openDb(dataDir);
  try {
    setState(db, "automatic_purpose_cursor", purpose);
  } finally {
    db.close();
  }
}

function seedDataDir(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-runtime-activity-"));
  createStore(dataDir, {
    sourceAnalysis: {
      getCredentials: async () => null,
      isEligible: () => true,
    },
  }).close();
  const roster = options.roster ?? ["rin", "hu"];
  const currentId = options.currentId ?? roster[0];
  const now = Date.now();
  const db = openDb(dataDir);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, 'http://127.0.0.1:9/v1', 'fixture-runtime', ?, ?)
    `).run(Buffer.from([1, 2, 3, 4]), new Date(now).toISOString());

    for (const characterId of roster) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        characterId,
        new Date(now).toISOString(),
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(characterId, options.energy?.[characterId] ?? 100);
      db.prepare(`
        INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, 0)
      `).run(characterId, characterId === currentId ? "companion" : "waiting", now);
    }

    setState(db, "fixed_character_id", roster[0]);
    setState(db, "current_character_id", currentId);
    setState(db, "current_mode", "companion");
    setState(db, "pending_rotation", "0");
    setState(db, "last_active_at", now);
    setState(db, "desktop_visible", options.desktopVisible === false ? "0" : "1");
    setState(db, "automatic_purpose_cursor", options.purpose ?? "daily");
    roster.forEach((characterId, index) => {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        localDay(),
        SLOTS[index],
        characterId,
      );
    });

    if (options.source) {
      const sourceDir = path.join(dataDir, "constructed-source");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "runtime-source.jsonl"),
        [
          JSON.stringify({
            type: "user",
            uuid: "runtime-source-user",
            message: {
              role: "user",
              content: [{ type: "text", text: `${SOURCE_SECRET} 构造来源记录` }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "runtime-source-assistant",
            message: { role: "assistant", content: [{ type: "text", text: "收到。" }] },
          }),
          "",
        ].join("\n"),
      );
      const canonicalPath = fs.realpathSync(sourceDir);
      const stat = fs.statSync(canonicalPath, { bigint: true });
      db.prepare(`
        INSERT INTO external_source_grants
          (id, provider, display_path, canonical_path, root_identity, revision, status, created_at, updated_at)
        VALUES ('runtime-source-grant', 'claude-code', ?, ?, ?, 1, 'active', ?, ?)
      `).run(sourceDir, canonicalPath, `${stat.dev}:${stat.ino}`, now, now);
      db.prepare(`
        INSERT INTO external_source_state (key, value) VALUES ('analysis_enabled', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
      db.prepare(`
        INSERT INTO automatic_budget_attempts
          (id, request_id, character_id, created_at, updated_at, status, sent, sent_at, finished_at)
        VALUES ('runtime-budget', 'runtime-budget', ?, ?, ?, 'success', 1, ?, ?)
      `).run(currentId, now - 1000, now, now, now);
    }
  } finally {
    db.close();
  }
  return dataDir;
}

function readDb(dataDir) {
  const db = openDb(dataDir, true);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return {
      activities: db
        .prepare("SELECT * FROM character_activities ORDER BY created_at, activity_id")
        .all(),
      stats: db.prepare("SELECT character_id, energy FROM character_stats ORDER BY character_id").all(),
      runtime: db
        .prepare("SELECT character_id, mode, exploring, last_settled_at FROM character_runtime ORDER BY character_id")
        .all(),
      moments: db
        .prepare(`
          SELECT s.character_id, s.energy, r.last_settled_at, r.mode
          FROM character_stats s JOIN character_runtime r USING (character_id)
          ORDER BY s.character_id
        `)
        .all(),
      budget: db
        .prepare("SELECT id, status, sent FROM automatic_budget_attempts ORDER BY created_at, id")
        .all(),
      memory: db.prepare("SELECT id, body FROM memory_entries").all(),
      notificationItems: db
        .prepare(`
          SELECT p.channel, p.slot, p.state, i.event_id
          FROM notification_presentation_items i
          JOIN notification_presentations p ON p.presentation_id = i.presentation_id
          WHERE p.state IN ('offered', 'visible')
          ORDER BY p.channel, p.slot, i.position
        `)
        .all(),
      events: Number(
        db.prepare("SELECT COUNT(*) AS count FROM relationship_events").get()?.count ?? 0,
      ),
      sourceEnabled:
        db.prepare("SELECT value FROM external_source_state WHERE key = 'analysis_enabled'").get()
          ?.value ?? "0",
      purpose:
        db.prepare("SELECT value FROM app_state WHERE key = 'automatic_purpose_cursor'").get()
          ?.value ?? null,
      activityById(activityId) {
        return this.activities.find((row) => row.activity_id === activityId) ?? null;
      },
      energyOf(characterId) {
        return Number(
          this.stats.find((row) => row.character_id === characterId)?.energy ?? NaN,
        );
      },
    };
  } finally {
    db.close();
  }
}

/* 构造独立仓库副本，仅复制画布实际加载的素材；用于在不改动正式源文件的前提下
   验证缺帧时能力门保持关闭。 */
function buildAssetFixtureRepo({ missingFrame = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-asset-repo-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "bayper-asset-fixture", private: true, main: "app/main.cjs" }),
  );
  fs.cpSync(path.join(repoRoot, "app"), path.join(root, "app"), { recursive: true });
  const rinDir = path.join(root, "assets", "characters", "rin", "animations");
  for (const name of ["idle-pixel-v2", "wave-pixel-v1", "stretch-pixel-v2-canvas256"]) {
    fs.cpSync(
      path.join(repoRoot, "assets", "characters", "rin", "animations", name),
      path.join(rinDir, name),
      { recursive: true },
    );
  }
  const trayDir = path.join(rinDir, "idle-v3");
  fs.mkdirSync(trayDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "assets", "characters", "rin", "animations", "idle-v3", "frame-00.png"),
    path.join(trayDir, "frame-00.png"),
  );
  if (missingFrame) {
    fs.rmSync(path.join(rinDir, "stretch-pixel-v2-canvas256", missingFrame));
  }
  return root;
}

/* 正常时间结算的明确基线：用同一行的 last_settled_at 差值核对，避免把陪伴消耗
   与活动扣费混在一条宽松不等式里。 */
function momentOf(db, characterId) {
  return db.moments.find((row) => row.character_id === characterId) ?? null;
}

function expectedEnergy(previous, next) {
  const hours = (Number(next.last_settled_at) - Number(previous.last_settled_at)) / 3600000;
  return Number(previous.energy) + COMPANION_ENERGY_PER_HOUR * hours;
}

/* 直接写入正式 connector_events 的受控通知事实；ticker/呈现/子进程仍是正式链路。 */
function seedNotification(dataDir, { priority, instanceId = "runtime-notify" }) {
  const now = Date.now();
  const db = openDb(dataDir);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare(`
      INSERT OR IGNORE INTO connector_instances (instance_id, label, created_at)
      VALUES (?, ?, ?)
    `).run(instanceId, "通知 fixture", now);
    notificationSequence += 1;
    const state = priority === 0 ? "failed" : "working";
    const result = db.prepare(`
      INSERT INTO connector_events
        (app_run_id, instance_id, run_id, agent_id, kind, state, sequence,
         priority, original_priority, notification_status, occurred_at, received_at)
      VALUES ('runtime-app', ?, 'runtime-run', ?, 'state', ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      instanceId,
      `agent-${notificationSequence}`,
      state,
      notificationSequence,
      priority,
      priority,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

function notificationChannels(snapshot) {
  return (snapshot.desktop?.notifications?.panels ?? []).map((panel) => panel.channel);
}

function stretchFrameIndex(snapshot) {
  const match = /stretch-pixel-v2-canvas256\/frame-(\d+)\.png/.exec(
    snapshot.desktop?.displayedFrame ?? "",
  );
  return match ? Number(match[1]) : null;
}

async function firstStretchFrameIndex(page, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const index = stretchFrameIndex(await getSnapshot(page));
    if (index !== null) {
      return index;
    }
    await delay(15);
  }
  return null;
}

/* 冷启动时管理页 preload 可能尚未就绪；静默轮询实际画布帧。 */
async function firstStretchFrameIndexQuiet(page, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const result = await page.evaluate(() => window.bayper?.getSnapshot?.());
      if (result?.ok) {
        const index = stretchFrameIndex(result.snapshot);
        if (index !== null) {
          return index;
        }
      }
    } catch {
      // 页面尚未完成桥接，继续等待。
    }
    await delay(15);
  }
  return null;
}

async function launchApp(dataDir, options = {}) {
  const appRoot = options.appRoot ?? repoRoot;
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appRoot, `--data-dir=${dataDir}`],
    env: {
      ...process.env,
      BAYPER_HEARTBEAT_MS: "400",
      CLAUDE_CONFIG_DIR: path.join(dataDir, "no-claude-config"),
      CODEX_HOME: path.join(dataDir, "no-codex-home"),
    },
  });
  const logs = [];
  const consoleLines = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error?.stack || error}`));
  await page.waitForLoadState("domcontentloaded");
  if (options.waitHome !== false) {
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  }
  if (options.waitDesktop !== false) {
    const requireIdleNode = options.requireIdleNode !== false;
    await waitFor(
      async () => {
        const result = await page.evaluate(() => window.bayper.getSnapshot());
        return (
          result.ok === true &&
          result.snapshot.desktop?.state === "running" &&
          result.snapshot.desktop?.assetState === "ready" &&
          (!requireIdleNode || result.snapshot.desktop?.lastNode === "idle-loop")
        );
      },
      20000,
      "正式桌面画布未就绪",
    );
  }
  return { app, page, logs, consoleLines };
}

async function closeApp(app, timeout = 10000) {
  if (!app) {
    return { status: "no-app", code: null, signal: null };
  }
  let processHandle = null;
  try {
    processHandle = app.process?.() ?? null;
  } catch {
    processHandle = null;
  }
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
    try {
      processHandle?.kill("SIGKILL");
    } catch {
      // 仍报告实际退出失败。
    }
    throw new Error(`应用未在 ${timeout}ms 内退出`);
  }
  return {
    status: "exited",
    code: processHandle?.exitCode ?? null,
    signal: processHandle?.signalCode ?? null,
  };
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.snapshot;
}

async function patchClock(app, offsetMs, randomValue = 0.1) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__runtimeActivityClock) {
        const RealDate = Date;
        const realNow = RealDate.now.bind(RealDate);
        globalThis.__runtimeActivityClock = { base: realNow(), now: realNow() };
        globalThis.Date = class extends RealDate {
          constructor(...args) {
            if (args.length === 0) {
              super(globalThis.__runtimeActivityClock.now);
            } else {
              super(...args);
            }
          }
          static now() {
            return globalThis.__runtimeActivityClock.now;
          }
        };
      }
      globalThis.__runtimeActivityClock.now = globalThis.__runtimeActivityClock.base + input.offset;
      Math.random = () => input.random;
    },
    { offset: offsetMs, random: randomValue },
  );
}

async function patchClockAt(app, epochMs, randomValue = 0.1) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__runtimeActivityClock) {
        const RealDate = Date;
        const realNow = RealDate.now.bind(RealDate);
        globalThis.__runtimeActivityClock = { base: realNow(), now: realNow() };
        globalThis.Date = class extends RealDate {
          constructor(...args) {
            if (args.length === 0) {
              super(globalThis.__runtimeActivityClock.now);
            } else {
              super(...args);
            }
          }
          static now() {
            return globalThis.__runtimeActivityClock.now;
          }
        };
      }
      globalThis.__runtimeActivityClock.now = input.at;
      Math.random = () => input.random;
    },
    { at: epochMs, random: randomValue },
  );
}

async function waitForNode(page) {
  await waitFor(
    async () => {
      const snapshot = await getSnapshot(page);
      return snapshot.desktop?.lastNode === "idle-loop";
    },
    15000,
    "桌面未产生待机自然节点",
  );
}

async function triggerOpportunity(app, page, dataDir, purpose, offsetMs) {
  await waitForNode(page);
  setPurpose(dataDir, purpose);
  await patchClock(app, offsetMs, 0.1);
}

async function capture(page, name) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

function captureDesktop(snapshot, name) {
  const bounds = snapshot.desktop?.bounds;
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) {
    return null;
  }
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  try {
    execFileSync(
      "screencapture",
      ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, file],
      { timeout: 5000 },
    );
    return file;
  } catch (error) {
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, `${name}.error.txt`),
      `screencapture 失败：${error?.message || error}\n`,
    );
    return null;
  }
}

function writeLog(name, launched, failure, cleanupErrors, appExit, facts, screenshots) {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.log`),
    [
      `# ${name}`,
      `batch: ${BATCH_ID}`,
      `time: ${new Date().toISOString()}`,
      `failure: ${failure ? failure.stack || failure.message || String(failure) : "none"}`,
      `cleanup: ${cleanupErrors.length === 0 ? "ok" : "failed"}`,
      `appExit: ${JSON.stringify(appExit)}`,
      ...cleanupErrors.map((error, index) => `  cleanup-${index + 1}: ${error?.message || error}`),
      `screenshots: ${JSON.stringify(screenshots)}`,
      "",
      "## facts",
      JSON.stringify(facts, null, 2),
      "",
      "## renderer console",
      ...(launched?.consoleLines ?? []),
      "",
      "## application stdout/stderr",
      ...(launched?.logs ?? []),
      "",
    ].join("\n"),
  );
}

async function cleanupResources({ caseName, launched, dataDirs, failure, facts, screenshots }) {
  const errors = [];
  let appExit = launched?.exit ?? {
    status: launched?.app ? "not-closed" : "no-app",
    code: null,
    signal: null,
  };
  if (!launched?.exit) {
    try {
      appExit = await closeApp(launched?.app);
    } catch (error) {
      errors.push(error);
      appExit = { status: "failed", code: null, signal: null };
    }
  }
  for (const directory of dataDirs) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      errors.push(error);
    }
  }
  fs.appendFileSync(
    path.join(EVIDENCE_DIR, "cleanup.log"),
    `${new Date().toISOString()} batch=${BATCH_ID} case=${caseName} appExit=${JSON.stringify(appExit)} cleanup=${errors.length === 0 ? "ok" : "failed"}\n`,
  );
  writeLog(caseName, launched, failure, errors, appExit, facts, screenshots);
  if (!failure && errors.length > 0) {
    throw errors[0];
  }
}

test("POL-ACTIVITY-RUNTIME-001 凛日常真实伸展：scheduled 不扣费、节点一次 -2、动作与时长后收束", { timeout: 120000 }, async () => {
  const dataDir = seedDataDir({ purpose: "daily" });
  let launched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    launched = await launchApp(dataDir);
    const { app, page } = launched;
    const before = readDb(dataDir);
    const beforeRin = momentOf(before, "rin");
    await triggerOpportunity(app, page, dataDir, "daily", 31 * 60 * 1000);

    await waitFor(
      () => readDb(dataDir).activities.some((activity) => activity.status === "scheduled"),
      5000,
      "心跳未建立待开始日常",
    );
    const scheduled = readDb(dataDir);
    const scheduledRow = scheduled.activities[0];
    const scheduledRin = momentOf(scheduled, "rin");
    assert.equal(scheduledRow.kind, "daily");
    assert.equal(scheduledRow.started_at, null, "scheduled 阶段不得开始计时");
    assert.equal(scheduledRow.action_completed_at, null);
    assert.equal(scheduledRow.action_frame, 0);
    const scheduledEnergy = scheduled.energyOf("rin");
    // 先核对包含正常陪伴结算的基线，再确认 scheduled 没有额外活动扣费。
    assert.ok(
      scheduledRin.last_settled_at > beforeRin.last_settled_at,
      "推进时钟后应发生正常时间结算",
    );
    assert.ok(
      Math.abs(scheduledEnergy - expectedEnergy(beforeRin, scheduledRin)) < 0.02,
      `scheduled 只应有正常结算：预期 ${expectedEnergy(beforeRin, scheduledRin)}，实际 ${scheduledEnergy}`,
    );
    facts.scheduled = {
      activity: scheduledRow,
      energy: scheduledEnergy,
      normalSettlement: expectedEnergy(beforeRin, scheduledRin),
      mode: (await getSnapshot(page)).companionship.current.mode,
    };

    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "running",
      10000,
      "自然节点未开始日常",
    );
    const started = readDb(dataDir);
    const startedRow = started.activities[0];
    const activityId = startedRow.activity_id;
    const startedRin = momentOf(started, "rin");
    const startedEnergy = started.energyOf("rin");
    assert.equal(startedRow.kind, "daily");
    assert.notEqual(startedRow.started_at, null);
    const expectedStarted = expectedEnergy(scheduledRin, startedRin) - 2;
    assert.ok(
      Math.abs(startedEnergy - expectedStarted) < 0.02,
      `节点开始应只扣一次 -2：预期 ${expectedStarted}，实际 ${startedEnergy}`,
    );

    // 日常播放期间插入普通与 P0 通知事实，走正式 ticker/呈现/气泡链路。
    const ordinaryEventId = seedNotification(dataDir, {
      priority: 1,
      instanceId: "runtime-notify-ordinary",
    });
    const urgentEventId = seedNotification(dataDir, {
      priority: 0,
      instanceId: "runtime-notify-urgent",
    });
    const notifyChannels = new Set();
    const collectChannels = (snapshot) => {
      for (const channel of notificationChannels(snapshot)) notifyChannels.add(channel);
    };

    // 真实帧序列：从渲染器逐帧上报的文件核对伸展素材，而不是只看状态徽标。
    const stretchFrames = new Set();
    let stretchShot = null;
    let peakShot = null;
    const frameDeadline = Date.now() + 2600;
    while (Date.now() < frameDeadline) {
      const snapshot = await getSnapshot(page);
      collectChannels(snapshot);
      const frame = snapshot.desktop?.displayedFrame ?? "";
      if (frame.includes("/stretch-pixel-v2-canvas256/frame-")) {
        stretchFrames.add(frame);
        if (!stretchShot) {
          stretchShot = captureDesktop(snapshot, "runtime-001-daily-stretch");
          if (stretchShot) screenshots.push(stretchShot);
        }
        // 举臂峰值帧单独留证，供与待机脚位、本体尺寸对照。
        if (!peakShot && /frame-0[4-7]\.png$/.test(frame)) {
          peakShot = captureDesktop(snapshot, "runtime-001-daily-stretch-peak");
          if (peakShot) screenshots.push(peakShot);
        }
      }
      await delay(40);
    }
    assert.ok(
      stretchFrames.size >= 4,
      `实际只观察到 ${stretchFrames.size} 个伸展帧：${[...stretchFrames].join(",")}`,
    );
    assert.ok(
      [...stretchFrames].every((frame) => frame.includes("stretch-pixel-v2-canvas256")),
      "日常帧不得借用其他动作或角色素材",
    );

    // 通知到达期间动作与活动保持不变；普通/加急均进入正式呈现事实。
    await waitFor(
      async () => {
        const snapshot = await getSnapshot(page);
        collectChannels(snapshot);
        return notifyChannels.has("ordinary") && notifyChannels.has("urgent");
      },
      5000,
      "普通/P0 通知未进入呈现",
    );
    const notified = await getSnapshot(page);
    await waitFor(
      async () => (await getSnapshot(page)).desktop?.notifications?.window?.visible === true,
      5000,
      "通知气泡未实际显示",
    );
    const notifiedWindow = await getSnapshot(page);
    const notifiedDb = readDb(dataDir);
    assert.equal(notifiedWindow.desktop.notifications.visible, true);
    assert.equal(notifiedWindow.desktop.notifications.window.visible, true);
    assert.equal(notifiedWindow.desktop.activity?.activityId, activityId);
    assert.equal(notifiedWindow.desktop.activity?.status, "running");
    assert.equal(notifiedDb.activities[0].status, "running");
    assert.equal(notifiedDb.activities[0].activity_id, activityId);
    assert.ok(Math.abs(notifiedDb.energyOf("rin") - startedEnergy) < 0.02);
    const ordinaryPanel = notified.desktop.notifications.panels.find(
      (panel) => panel.channel === "ordinary",
    );
    const urgentPanel = notified.desktop.notifications.panels.find(
      (panel) => panel.channel === "urgent",
    );
    assert.ok(ordinaryPanel?.eventIds.includes(ordinaryEventId));
    assert.ok(urgentPanel?.eventIds.includes(urgentEventId));
    const ordinaryItem = notifiedDb.notificationItems.find(
      (item) => item.event_id === ordinaryEventId,
    );
    const urgentItem = notifiedDb.notificationItems.find(
      (item) => item.event_id === urgentEventId,
    );
    assert.equal(ordinaryItem?.channel, "ordinary");
    assert.equal(urgentItem?.channel, "urgent");
    facts.notifications = {
      ordinaryEventId,
      urgentEventId,
      channels: [...notifyChannels],
      activityId,
      status: notifiedDb.activities[0].status,
      energy: notifiedDb.energyOf("rin"),
      windowVisible: notifiedWindow.desktop.notifications.window.visible,
    };

    await waitFor(
      () => readDb(dataDir).activities[0]?.action_completed_at !== null,
      5000,
      "真实伸展完成未持久化",
    );
    await waitFor(
      async () => (await getSnapshot(page)).desktop?.lastNode === "daily-action-complete",
      5000,
      "桌面未上报伸展完成节点",
    );
    const afterAction = readDb(dataDir);
    assert.equal(afterAction.activities[0].status, "running", "动作完成但时长未满不得提前收束");
    assert.equal(afterAction.activities[0].action_frame, 8);
    assert.ok(Math.abs(afterAction.energyOf("rin") - startedEnergy) < 0.02);

    await patchClockAt(app, startedRow.started_at + 11 * 1000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "completed",
      7000,
      "动作与有效时长都满足后未在自然节点收束",
    );
    const completed = readDb(dataDir);
    const completedRow = completed.activities[0];
    assert.equal(completedRow.active_elapsed_ms, 10000);
    assert.equal(completedRow.action_frame, 8);
    assert.ok(
      Math.abs(completed.energyOf("rin") - startedEnergy) < 0.02,
      "完成时不得重复扣费",
    );
    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.companionship.current.mode, "companion");
    assert.equal(snapshot.companionship.current.activity ?? null, null);
    assert.equal(snapshot.desktop.activity ?? null, null);
    const plan = getRinAnimations().display;
    assert.equal(snapshot.desktop.bounds.width, plan.windowWidth);
    assert.equal(snapshot.desktop.bounds.height, plan.windowHeight);
    assert.ok(plan.windowWidth <= 128 && plan.windowHeight <= 128);
    // 凛四动作并集 314 高，地面锚对应 308 行。
    assert.ok(Math.abs(plan.footAnchor.y - 308 * (128 / 314)) < 0.01, "脚锚应对应四动作并集");
    assert.match(snapshot.desktop.displayedFrame, /idle-pixel-v2\/frame-/);
    facts.completed = {
      activity: completedRow,
      frames: [...stretchFrames].map((frame) => frame.split("/").slice(-2).join("/")),
      bounds: snapshot.desktop.bounds,
      energy: completed.energyOf("rin"),
    };
    screenshots.push(await capture(page, "runtime-001-daily-completed"));
    const idleShot = captureDesktop(snapshot, "runtime-001-daily-idle-after");
    if (idleShot) screenshots.push(idleShot);

    // 同一滚动小时内再次抽中 daily：不得启动第二个活动或再扣一次。
    setPurpose(dataDir, "daily");
    await patchClock(app, 62 * 60 * 1000, 0.1);
    await delay(1600);
    const quota = readDb(dataDir);
    assert.equal(quota.activities.length, 1, "额度内的后续机会不得再启动日常");
    assert.equal(quota.activities[0].activity_id, activityId);
    assert.equal(quota.purpose, "exploration");
    facts.quota = { activities: quota.activities.length, purpose: quota.purpose };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-001",
      launched,
      dataDirs: [dataDir],
      failure,
      facts,
      screenshots,
    });
  }
});

test("POL-ACTIVITY-RUNTIME-002 探索：有接替者才出发并换人，只扣 8；无接替者不开始", { timeout: 150000 }, async () => {
  const dataDir = seedDataDir({ purpose: "exploration", roster: ["rin", "hu"] });
  const soloDir = seedDataDir({ purpose: "exploration", roster: ["rin"], currentId: "rin" });
  let launched = null;
  let soloLaunched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    launched = await launchApp(dataDir);
    const { app, page } = launched;
    await triggerOpportunity(app, page, dataDir, "exploration", 31 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities.some((activity) => activity.status === "scheduled"),
      5000,
      "心跳未建立待开始探索",
    );
    const scheduled = readDb(dataDir);
    assert.equal(scheduled.activities[0].kind, "exploration");
    assert.equal(scheduled.activities[0].started_at, null);
    assert.equal(
      scheduled.runtime.find((row) => row.character_id === "rin").exploring,
      0,
    );
    const scheduledEnergy = scheduled.energyOf("rin");

    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "running",
      10000,
      "自然节点未开始探索",
    );
    const started = readDb(dataDir);
    const activity = started.activities[0];
    const explorationEnergy = started.energyOf("rin");
    assert.ok(Math.abs(explorationEnergy - (scheduledEnergy - 8)) < 0.02);
    assert.equal(started.runtime.find((row) => row.character_id === "rin").exploring, 1);
    const startedSnapshot = await getSnapshot(page);
    assert.equal(startedSnapshot.companionship.current.characterId, "hu");
    assert.equal(startedSnapshot.desktop.characterId, "hu");
    assert.ok(startedSnapshot.desktop.bounds?.width <= 128);
    assert.ok(startedSnapshot.desktop.bounds?.height <= 128);
    assert.equal(
      startedSnapshot.companionship.roster.find((entry) => entry.characterId === "rin").activity
        .status,
      "running",
    );
    await page.locator("#roster-list").getByText("探索中", { exact: false }).first().waitFor({
      state: "visible",
      timeout: 5000,
    });
    facts.started = {
      activity,
      current: startedSnapshot.companionship.current.characterId,
      energy: explorationEnergy,
      desktopBounds: startedSnapshot.desktop.bounds,
    };
    screenshots.push(await capture(page, "runtime-002-exploration-successor"));
    const desktopShot = captureDesktop(startedSnapshot, "runtime-002-exploration-desktop");
    if (desktopShot) {
      screenshots.push(desktopShot);
    }

    await patchClockAt(app, activity.started_at + 5 * 60 * 1000);
    await delay(1000);
    const progressed = readDb(dataDir);
    assert.ok(progressed.activities[0].active_elapsed_ms >= 5 * 60 * 1000 - 1000);
    assert.ok(Math.abs(progressed.energyOf("rin") - explorationEnergy) < 0.02);

    await patchClockAt(app, activity.started_at + 21 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "completed",
      7000,
      "探索到时未完成",
    );
    const completed = readDb(dataDir);
    assert.ok(
      completed.energyOf("rin") >= explorationEnergy - 0.01 &&
        completed.energyOf("rin") <= explorationEnergy + 0.3,
      "探索结束只允许完成后的候场恢复，不得重复扣 8",
    );
    assert.equal(completed.runtime.find((row) => row.character_id === "rin").exploring, 0);
    const completedSnapshot = await getSnapshot(page);
    assert.equal(completedSnapshot.companionship.current.characterId, "hu", "探索回来不抢当前位");
    assert.equal(completedSnapshot.companionship.current.mode, "companion");
    assert.equal(completed.events, 0, "探索不得伪造线索/故事");
    facts.completed = {
      activity: completed.activities[0],
      current: completedSnapshot.companionship.current.characterId,
      energy: completed.energyOf("rin"),
      events: completed.events,
    };

    launched.exit = await closeApp(launched.app);
    soloLaunched = await launchApp(soloDir);
    await triggerOpportunity(soloLaunched.app, soloLaunched.page, soloDir, "exploration", 31 * 60 * 1000);
    await waitFor(
      () => readDb(soloDir).activities.some((activity) => activity.status === "scheduled"),
      5000,
      "无接替者对照未建立 scheduled",
    );
    await waitFor(
      () => readDb(soloDir).activities[0]?.status === "cancelled",
      10000,
      "无接替者探索未取消",
    );
    const solo = readDb(soloDir);
    assert.equal(solo.runtime.find((row) => row.character_id === "rin").exploring, 0);
    assert.ok(solo.energyOf("rin") > 60, "无接替者不得扣探索精力");
    const soloSnapshot = await getSnapshot(soloLaunched.page);
    assert.equal(soloSnapshot.companionship.current.characterId, "rin");
    assert.equal(solo.events, 0);
    facts.noSuccessor = {
      activity: solo.activities[0],
      energy: solo.energyOf("rin"),
      current: soloSnapshot.companionship.current.characterId,
      events: solo.events,
    };
    screenshots.push(await capture(soloLaunched.page, "runtime-002-no-successor"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-002",
      launched: soloLaunched ?? launched,
      dataDirs: [dataDir, soloDir],
      failure,
      facts,
      screenshots,
    });
  }
});

test("POL-ACTIVITY-RUNTIME-003 探索聊天/锁屏与多原因恢复，沿持久活动事实恢复同 ID", { timeout: 180000 }, async () => {
  const exploreDir = seedDataDir({ purpose: "exploration", roster: ["rin", "hu"], currentId: "rin" });
  const otherDir = seedDataDir({ purpose: "exploration", roster: ["hu", "rin"], currentId: "rin" });
  let exploreLaunched = null;
  let otherLaunched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    exploreLaunched = await launchApp(exploreDir);
    await triggerOpportunity(
      exploreLaunched.app,
      exploreLaunched.page,
      exploreDir,
      "exploration",
      31 * 60 * 1000,
    );
    await waitFor(
      () => readDb(exploreDir).activities[0]?.status === "running",
      12000,
      "探索未开始",
    );
    const explorationActivity = readDb(exploreDir).activities[0];
    const explorationId = explorationActivity.activity_id;
    await patchClockAt(exploreLaunched.app, explorationActivity.started_at + 5 * 60 * 1000);
    await delay(900);
    const beforeChat = readDb(exploreDir);
    const chatOpen = await exploreLaunched.page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chatOpen.ok, true, JSON.stringify(chatOpen));
    await waitFor(
      () => readDb(exploreDir).activities[0]?.status === "paused",
      3000,
      "聊天未暂停探索",
    );
    const paused = readDb(exploreDir);
    assert.equal(paused.activities[0].activity_id, explorationId);
    assert.equal(paused.activities[0].active_elapsed_ms, 5 * 60 * 1000);
    const pausedSnapshot = await getSnapshot(exploreLaunched.page);
    assert.equal(pausedSnapshot.companionship.interaction?.characterId, "rin");
    facts.explorationPaused = paused.activities[0];
    screenshots.push(await capture(exploreLaunched.page, "runtime-003-exploration-paused-chat"));

    const chatClose = await exploreLaunched.page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(chatClose.ok, true);
    await waitFor(
      () =>
        readDb(exploreDir).activities[0]?.status === "running" &&
        readDb(exploreDir).activities[0]?.activity_id === explorationId,
      5000,
      "关闭聊天未恢复同一探索",
    );
    assert.equal(readDb(exploreDir).activities[0].active_elapsed_ms, 5 * 60 * 1000);

    // 运行中锁屏暂停；解锁按持久活动事实恢复同 ID，离线时间不推进。
    await patchClockAt(exploreLaunched.app, explorationActivity.started_at + 7 * 60 * 1000);
    await delay(700);
    await exploreLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(
      () => readDb(exploreDir).activities[0]?.status === "paused",
      3000,
      "锁屏未暂停探索",
    );
    assert.equal(readDb(exploreDir).activities[0].active_elapsed_ms, 7 * 60 * 1000);
    await exploreLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitFor(
      () =>
        readDb(exploreDir).activities[0]?.status === "running" &&
        readDb(exploreDir).activities[0]?.activity_id === explorationId,
      5000,
      "解锁未恢复同一探索",
    );
    assert.equal(readDb(exploreDir).activities[0].active_elapsed_ms, 7 * 60 * 1000);
    facts.lockResume = readDb(exploreDir).activities[0];

    // 聊天期间再锁屏：解锁仍受聊天阻止，关闭聊天后从持久 paused 事实恢复。
    const combinedChat = await exploreLaunched.page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(combinedChat.ok, true);
    await waitFor(
      () => readDb(exploreDir).activities[0]?.status === "paused",
      3000,
      "聊天未暂停探索",
    );
    const combinedProgress = readDb(exploreDir).activities[0].active_elapsed_ms;
    await exploreLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await exploreLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(500);
    assert.equal(readDb(exploreDir).activities[0].status, "paused", "聊天未结束不得恢复活动");
    await exploreLaunched.page.evaluate(() => window.bayperChat.closeChat());
    await waitFor(
      () => readDb(exploreDir).activities[0]?.status === "running",
      5000,
      "关闭聊天后未恢复探索",
    );
    assert.equal(readDb(exploreDir).activities[0].active_elapsed_ms, combinedProgress);
    facts.combinedReasons = readDb(exploreDir).activities[0];

    // 退出后重开：沿持久活动事实恢复同 ID/进度，离线时间不推进。
    exploreLaunched.exit = await closeApp(exploreLaunched.app);
    exploreLaunched = await launchApp(exploreDir);
    await delay(1200);
    const reopened = readDb(exploreDir);
    assert.equal(reopened.activities[0].activity_id, explorationId);
    assert.equal(reopened.activities[0].status, "running");
    assert.ok(
      reopened.activities[0].active_elapsed_ms >= combinedProgress &&
        reopened.activities[0].active_elapsed_ms < combinedProgress + 30 * 1000,
      `重开只应推进恢复后的在线时间，实际 ${combinedProgress} -> ${reopened.activities[0].active_elapsed_ms}`,
    );
    facts.reopened = reopened.activities[0];
    screenshots.push(await capture(exploreLaunched.page, "runtime-003-reopened-resumed"));
    exploreLaunched.exit = await closeApp(exploreLaunched.app);

    // 另一位名单成员的探索被锁屏暂停，聊天没有捕获该 ID；关闭聊天后仍应沿持久事实恢复。
    otherLaunched = await launchApp(otherDir);
    await triggerOpportunity(
      otherLaunched.app,
      otherLaunched.page,
      otherDir,
      "exploration",
      31 * 60 * 1000,
    );
    await waitFor(
      () => readDb(otherDir).activities[0]?.status === "running",
      12000,
      "另一位成员探索未开始",
    );
    const otherActivity = readDb(otherDir).activities[0];
    assert.equal(otherActivity.character_id, "hu");
    const otherSnapshot = await getSnapshot(otherLaunched.page);
    assert.equal(otherSnapshot.companionship.current.characterId, "rin");
    const otherChat = await otherLaunched.page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(otherChat.ok, true);
    await delay(400);
    assert.equal(
      readDb(otherDir).activities[0].status,
      "running",
      "与当前角色聊天不应暂停另一位成员的探索",
    );
    await otherLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(
      () => readDb(otherDir).activities[0]?.status === "paused",
      3000,
      "锁屏未暂停另一位成员探索",
    );
    await otherLaunched.app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(500);
    assert.equal(
      readDb(otherDir).activities[0].status,
      "paused",
      "聊天未结束不得恢复另一位成员的探索",
    );
    await otherLaunched.page.evaluate(() => window.bayperChat.closeChat());
    await waitFor(
      () =>
        readDb(otherDir).activities[0]?.status === "running" &&
        readDb(otherDir).activities[0]?.activity_id === otherActivity.activity_id,
      5000,
      "关闭聊天后未沿持久事实恢复另一位成员的探索",
    );
    facts.otherMemberRecovery = readDb(otherDir).activities[0];
    screenshots.push(await capture(otherLaunched.page, "runtime-003-other-member-resumed"));
    otherLaunched.exit = await closeApp(otherLaunched.app);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-003",
      launched:
        [otherLaunched, exploreLaunched].find((item) => item && !item.exit) ??
        exploreLaunched ??
        otherLaunched,
      dataDirs: [exploreDir, otherDir],
      failure,
      facts,
      screenshots,
    });
  }
});

test("POL-ACTIVITY-RUNTIME-003 daily 聊天/切人/锁屏/重开沿同 ID 恢复，动作完成后收束", { timeout: 180000 }, async () => {
  const dataDir = seedDataDir({ purpose: "daily" });
  let launched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    launched = await launchApp(dataDir);
    let { app, page } = launched;
    await triggerOpportunity(app, page, dataDir, "daily", 31 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities.some((activity) => activity.status === "scheduled"),
      5000,
      "待开始日常未建立",
    );
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "running",
      10000,
      "日常未开始",
    );
    const started = readDb(dataDir);
    const row = started.activities[0];
    const activityId = row.activity_id;
    const startedAt = row.started_at;
    const energyAfterStart = started.energyOf("rin");

    // 伸展途中锁屏：动作在暂停期间真实播完，完成事实仍要记录，恢复后不得卡住。
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      3000,
      "锁屏未暂停日常",
    );
    await waitFor(
      () => readDb(dataDir).activities[0]?.action_completed_at !== null,
      6000,
      "暂停期间真实完成的伸展未记录",
    );
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 0);
    facts.pauseDuringAction = readDb(dataDir).activities[0];
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      5000,
      "解锁未恢复同 ID 日常",
    );
    assert.equal(readDb(dataDir).activities[0].action_completed_at !== null, true);

    await patchClockAt(app, startedAt + 2000);
    await delay(500);
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);

    // 聊天暂停：同 ID、有效进度保留。
    const chatOpen = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chatOpen.ok, true, JSON.stringify(chatOpen));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      3000,
      "聊天未暂停日常",
    );
    const paused = readDb(dataDir).activities[0];
    assert.equal(paused.activity_id, activityId);
    assert.equal(paused.active_elapsed_ms, 2000);

    // 聊天期间锁屏再解锁：仍被聊天阻止，不恢复、不推进。
    await patchClockAt(app, startedAt + 5 * 60 * 1000);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await delay(300);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(500);
    assert.equal(readDb(dataDir).activities[0].status, "paused", "聊天未结束不得恢复");
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);

    const closeResult = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(closeResult.ok, true, JSON.stringify(closeResult));
    assert.equal(closeResult.closed, true);
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      5000,
      "关闭聊天后未恢复同 ID 日常",
    );
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);

    // 手动切人暂停；切回后恢复同 ID，且暂停区间不推进有效时间。
    const switched = await page.evaluate(() => window.bayper.switchCompanion("hu"));
    assert.equal(switched.ok, true, JSON.stringify(switched));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      5000,
      "切换角色未暂停日常",
    );
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);
    await patchClockAt(app, startedAt + 10 * 60 * 1000);
    await delay(500);
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);

    const switchedBack = await page.evaluate(() => window.bayper.switchCompanion("rin"));
    assert.equal(switchedBack.ok, true, JSON.stringify(switchedBack));
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      6000,
      "切回后未恢复同 ID 日常",
    );
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, 2000);
    await waitFor(
      async () => {
        const state = await getSnapshot(page);
        return !String(state.desktop?.displayedFrame).includes("stretch-pixel-v2-canvas256");
      },
      3000,
      "切回已完成动作的角色不应重播伸展",
    );

    // 运行中锁屏暂停，解锁恢复同 ID；离线墙钟不计入有效活动时间。
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      3000,
      "锁屏未暂停日常",
    );
    const lockedActive = readDb(dataDir).activities[0].active_elapsed_ms;
    await patchClockAt(app, startedAt + 15 * 60 * 1000);
    await delay(500);
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, lockedActive);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      5000,
      "解锁未恢复同 ID 日常",
    );
    assert.equal(readDb(dataDir).activities[0].active_elapsed_ms, lockedActive);
    facts.pauseStack = readDb(dataDir).activities[0];

    // 退出重开：退出暂停并保留事实，重开沿同 ID 恢复，不补离线、不重复扣。
    launched.exit = await closeApp(launched.app);
    const exited = readDb(dataDir).activities[0];
    assert.equal(exited.activity_id, activityId);
    assert.equal(exited.status, "paused");
    launched = await launchApp(dataDir);
    ({ app, page } = launched);
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      10000,
      "重开后未恢复同 ID 日常",
    );
    const reopened = readDb(dataDir).activities[0];
    assert.ok(
      reopened.active_elapsed_ms >= lockedActive &&
        reopened.active_elapsed_ms < lockedActive + 30 * 1000,
      "重开只应推进恢复后的在线时间",
    );
    await waitFor(
      async () => {
        const state = await getSnapshot(page);
        return !String(state.desktop?.displayedFrame).includes("stretch-pixel-v2-canvas256");
      },
      5000,
      "已完成动作重开后不应重播",
    );
    assert.equal(
      (await getSnapshot(page)).desktop.activity?.actionComplete,
      true,
      "已完成事实应在重开后保持",
    );

    // 动作已完成，补足有效时长后在自然节点收束。
    await patchClockAt(app, startedAt + 20 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "completed",
      8000,
      "重开后动作与时长满足仍未收束",
    );
    const completed = readDb(dataDir).activities[0];
    assert.equal(completed.activity_id, activityId);
    assert.equal(completed.active_elapsed_ms, 10000);
    assert.ok(
      readDb(dataDir).energyOf("rin") >= energyAfterStart - 0.05,
      "暂停/重开期间不得重复扣除 -2",
    );
    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.companionship.current.characterId, "rin");
    assert.equal(snapshot.companionship.current.mode, "companion");
    assert.equal(snapshot.companionship.current.activity ?? null, null);
    facts.completed = {
      activity: completed,
      energy: readDb(dataDir).energyOf("rin"),
    };
    screenshots.push(await capture(page, "runtime-003-daily-completed"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-003-daily",
      launched,
      dataDirs: [dataDir],
      failure,
      facts,
      screenshots,
    });
  }
});

test("POL-ACTIVITY-RUNTIME-003 daily 连续两次中断与退出重开按已完成帧续播", { timeout: 180000 }, async () => {
  const dataDir = seedDataDir({ purpose: "daily" });
  let launched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    launched = await launchApp(dataDir);
    let { app, page } = launched;
    await triggerOpportunity(app, page, dataDir, "daily", 31 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities.some((activity) => activity.status === "scheduled"),
      5000,
      "待开始日常未建立",
    );
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "running",
      10000,
      "日常未开始",
    );
    const started = readDb(dataDir).activities[0];
    const activityId = started.activity_id;
    const energyAfterStart = readDb(dataDir).energyOf("rin");

    await waitFor(
      () => Number(readDb(dataDir).activities[0]?.action_frame) >= 2,
      6000,
      "真实播放进度未记录",
    );
    const chat1 = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chat1.ok, true, JSON.stringify(chat1));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      3000,
      "首次中断未暂停",
    );
    const paused1 = readDb(dataDir).activities[0];
    assert.ok(paused1.action_frame >= 2);
    assert.equal(paused1.action_completed_at, null);
    await page.evaluate(() => window.bayperChat.closeChat());
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      5000,
      "首次恢复未回到同 ID",
    );
    const firstResume = await firstStretchFrameIndex(page, 3000);
    assert.notEqual(firstResume, null, "首次恢复后未观察到续播帧");
    assert.ok(
      firstResume >= paused1.action_frame && firstResume > 0,
      `首次恢复应从已完成帧续播：进度 ${paused1.action_frame}，实际首帧 ${firstResume}`,
    );

    // 第二次中断紧接恢复；暂停期间退出，重开后仍应从持久进度续播。
    const chat2 = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chat2.ok, true, JSON.stringify(chat2));
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "paused",
      3000,
      "第二次中断未暂停",
    );
    const paused2 = readDb(dataDir).activities[0];
    assert.equal(paused2.activity_id, activityId);
    assert.ok(paused2.action_frame > 0 && paused2.action_frame < 8);
    assert.equal(paused2.action_completed_at, null);

    launched.exit = await closeApp(launched.app);
    const exited = readDb(dataDir).activities[0];
    assert.equal(exited.activity_id, activityId);
    assert.equal(exited.status, "paused");
    const resumeProgress = exited.action_frame;
    assert.ok(resumeProgress > 0 && resumeProgress < 8);

    launched = await launchApp(dataDir, {
      waitHome: false,
      waitDesktop: false,
    });
    ({ app, page } = launched);
    const restartFrame = await firstStretchFrameIndexQuiet(page, 10000);
    assert.notEqual(restartFrame, null, "重开后未观察到续播帧");
    assert.ok(
      restartFrame >= resumeProgress && restartFrame > 0,
      `重开应从持久进度续播：进度 ${resumeProgress}，实际首帧 ${restartFrame}`,
    );
    await waitFor(
      () =>
        readDb(dataDir).activities[0]?.status === "running" &&
        readDb(dataDir).activities[0]?.activity_id === activityId,
      10000,
      "重开后未恢复同 ID 日常",
    );

    await patchClockAt(app, exited.started_at + 20 * 60 * 1000);
    await waitFor(
      () => readDb(dataDir).activities[0]?.status === "completed",
      8000,
      "续播完成后未收束",
    );
    const completed = readDb(dataDir).activities[0];
    assert.equal(completed.activity_id, activityId);
    assert.equal(completed.active_elapsed_ms, 10000);
    assert.equal(completed.action_frame, 8);
    assert.ok(
      readDb(dataDir).energyOf("rin") >= energyAfterStart - 0.05,
      "中断与重开不得重复扣除 -2",
    );
    facts.resume = {
      paused1,
      firstResume,
      paused2,
      resumeProgress,
      restartFrame,
      completed,
    };
    screenshots.push(await capture(page, "runtime-003-daily-progress-resume"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-003-daily-progress",
      launched,
      dataDirs: [dataDir],
      failure,
      facts,
      screenshots,
    });
  }
});

test("POL-ACTIVITY-RUNTIME-004 单一用途不双发；预算耗尽仍可本地探索；琥珀日常用自身素材；缺帧/不可见 daily 不启动", { timeout: 180000 }, async () => {
  const sourceDir = seedDataDir({ purpose: "source", source: true });
  const hiddenDir = seedDataDir({ purpose: "daily", desktopVisible: false });
  const huDir = seedDataDir({ purpose: "daily", roster: ["hu", "rin"], currentId: "hu" });
  const assetDir = seedDataDir({ purpose: "daily" });
  let fixtureRoot = null;
  let sourceLaunched = null;
  let hiddenLaunched = null;
  let huLaunched = null;
  let assetLaunched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    sourceLaunched = await launchApp(sourceDir);
    await triggerOpportunity(
      sourceLaunched.app,
      sourceLaunched.page,
      sourceDir,
      "source",
      31 * 60 * 1000,
    );
    await delay(1500);
    const afterSource = readDb(sourceDir);
    assert.equal(afterSource.activities.length, 0, "来源失败不得在同一机会改启动活动");
    assert.equal(afterSource.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(afterSource.memory.length, 0);
    assert.equal(afterSource.purpose, "daily");
    facts.budgetSourceSkip = {
      activities: afterSource.activities.length,
      budget: afterSource.budget,
      purpose: afterSource.purpose,
    };

    // 预算仍耗尽，但下一次机会可执行纯本地探索。
    await triggerOpportunity(
      sourceLaunched.app,
      sourceLaunched.page,
      sourceDir,
      "exploration",
      62 * 60 * 1000,
    );
    await waitFor(
      () => readDb(sourceDir).activities.some((activity) => activity.status === "running"),
      12000,
      "预算耗尽后的本地探索未开始",
    );
    const local = readDb(sourceDir);
    const localActivity = local.activities[0];
    assert.equal(localActivity.kind, "exploration");
    assert.equal(local.budget.filter((row) => row.sent === 1).length, 1, "本地探索不得新增 API 预算");
    assert.equal(local.memory.length, 0);
    facts.laterLocal = { activity: localActivity, budget: local.budget };
    screenshots.push(await capture(sourceLaunched.page, "runtime-004-later-local"));

    const exitResult = await closeApp(sourceLaunched.app);
    sourceLaunched.exit = exitResult;
    assert.equal(exitResult.code, 0);
    const afterExit = readDb(sourceDir);
    const exitedActivity = afterExit.activities.find(
      (activity) => activity.activity_id === localActivity.activity_id,
    );
    assert.equal(exitedActivity.status, "paused", "退出应暂停运行活动并保留事实");
    facts.exit = { appExit: exitResult, activity: exitedActivity };

    // 琥珀已有自己的基础日常候选：建立自身活动，不借用凛的素材。
    huLaunched = await launchApp(huDir);
    const huBefore = readDb(huDir);
    await triggerOpportunity(huLaunched.app, huLaunched.page, huDir, "daily", 31 * 60 * 1000);
    await waitFor(
      () => readDb(huDir).activities.some((activity) => activity.status === "running"),
      12000,
      "琥珀日常未开始",
    );
    const huAfter = readDb(huDir);
    assert.equal(huAfter.activities.length, 1, "琥珀日常只需建立一项活动");
    assert.equal(huAfter.activities[0].kind, "daily");
    assert.equal(huAfter.activities[0].character_id, "hu");
    assert.equal(huAfter.purpose, "exploration");
    const huActivityId = huAfter.activities[0].activity_id;
    await waitFor(
      async () => {
        const state = await getSnapshot(huLaunched.page);
        return (
          state.desktop?.activity?.activityId === huActivityId &&
          String(state.desktop?.displayedFrame).includes(
            "/stretch-pixel-v2-canvas320/frame-",
          )
        );
      },
      12000,
      "琥珀日常未播放自己的伸展帧",
    );
    const huSnapshot = await getSnapshot(huLaunched.page);
    assert.equal(huSnapshot.desktop.characterId, "hu");
    assert.match(huSnapshot.desktop.displayedFrame, /stretch-pixel-v2-canvas320\/frame-/);
    facts.huDaily = {
      activity: huAfter.activities[0],
      purpose: huAfter.purpose,
      energyBefore: huBefore.energyOf("hu"),
      energyAfter: huAfter.energyOf("hu"),
      displayedFrame: huSnapshot.desktop.displayedFrame,
    };
    screenshots.push(await capture(huLaunched.page, "runtime-004-hu-daily"));
    huLaunched.exit = await closeApp(huLaunched.app);

    // 正式源文件不动：使用独立仓库副本缺失一帧伸展，能力门保持关闭且不扣费。
    fixtureRoot = buildAssetFixtureRepo({ missingFrame: "frame-04.png" });
    assetLaunched = await launchApp(assetDir, {
      appRoot: fixtureRoot,
      waitDesktop: false,
    });
    await waitFor(
      async () => {
        const result = await assetLaunched.page.evaluate(() => window.bayper.getSnapshot());
        return (
          result.ok === true &&
          result.snapshot.desktop?.assetState === "error" &&
          result.snapshot.desktop?.state === "running"
        );
      },
      15000,
      "缺帧时画布未进入明确错误状态",
    );
    const assetBefore = readDb(assetDir);
    setPurpose(assetDir, "daily");
    await patchClock(assetLaunched.app, 31 * 60 * 1000, 0.1);
    await delay(1600);
    const assetAfter = readDb(assetDir);
    assert.equal(assetAfter.activities.length, 0, "缺帧时不得建立日常或扣费");
    assert.equal(assetAfter.purpose, "exploration");
    assert.ok(
      assetAfter.energyOf("rin") > assetBefore.energyOf("rin") - 4,
      "缺帧的日常不得扣除 -2 活动精力",
    );
    const assetSnapshot = await getSnapshot(assetLaunched.page);
    assert.equal(assetSnapshot.desktop.activity ?? null, null);
    facts.missingFrame = {
      assetState: assetSnapshot.desktop.assetState,
      activities: assetAfter.activities.length,
      energyBefore: assetBefore.energyOf("rin"),
      energyAfter: assetAfter.energyOf("rin"),
    };
    screenshots.push(await capture(assetLaunched.page, "runtime-004-missing-frame"));
    assetLaunched.exit = await closeApp(assetLaunched.app);

    hiddenLaunched = await launchApp(hiddenDir);
    const hiddenBefore = readDb(hiddenDir);
    await triggerOpportunity(hiddenLaunched.app, hiddenLaunched.page, hiddenDir, "daily", 31 * 60 * 1000);
    await delay(1600);
    const hidden = readDb(hiddenDir);
    assert.equal(hidden.activities.length, 0, "不可见 daily 不得建立或扣费");
    assert.ok(
      hidden.energyOf("rin") <= hiddenBefore.energyOf("rin") + 0.02,
      "不可见 daily 不得扣除活动精力",
    );
    facts.invisibleDaily = {
      activities: hidden.activities.length,
      energyBefore: hiddenBefore.energyOf("rin"),
      energyAfter: hidden.energyOf("rin"),
    };
    screenshots.push(await capture(hiddenLaunched.page, "runtime-004-invisible-daily"));
    hiddenLaunched.exit = await closeApp(hiddenLaunched.app);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "activity-runtime-004",
      launched:
        [assetLaunched, huLaunched, hiddenLaunched, sourceLaunched].find(
          (item) => item && !item.exit,
        ) ??
        sourceLaunched ??
        hiddenLaunched ??
        huLaunched ??
        assetLaunched,
      dataDirs: [sourceDir, hiddenDir, huDir, assetDir, ...(fixtureRoot ? [fixtureRoot] : [])],
      failure,
      facts,
      screenshots,
    });
  }
});
