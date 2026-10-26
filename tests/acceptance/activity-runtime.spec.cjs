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
        .prepare("SELECT character_id, mode, exploring FROM character_runtime ORDER BY character_id")
        .all(),
      budget: db
        .prepare("SELECT id, status, sent FROM automatic_budget_attempts ORDER BY created_at, id")
        .all(),
      memory: db.prepare("SELECT id, body FROM memory_entries").all(),
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

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
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
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await waitFor(
    async () => {
      const result = await page.evaluate(() => window.bayper.getSnapshot());
      return (
        result.ok === true &&
        result.snapshot.desktop?.state === "running" &&
        result.snapshot.desktop?.assetState === "ready" &&
        result.snapshot.desktop?.lastNode === "idle-loop"
      );
    },
    20000,
    "正式桌面画布未就绪",
  );
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

test("POL-ACTIVITY-RUNTIME-001 daily 正式动作未发布：不启动不扣费，播放验收 NOT_COVERED", { timeout: 90000 }, async () => {
  const dataDir = seedDataDir({ purpose: "daily" });
  let launched = null;
  let failure = null;
  const facts = {};
  const screenshots = [];
  try {
    launched = await launchApp(dataDir);
    const { app, page } = launched;
    const before = readDb(dataDir);
    await triggerOpportunity(app, page, dataDir, "daily", 31 * 60 * 1000);
    await delay(1600);

    const after = readDb(dataDir);
    assert.equal(after.activities.length, 0, "daily 动作未发布时不得建立 scheduled 或运行活动");
    assert.equal(after.purpose, "exploration", "跳过的 daily 用途仍应只消费一次并推进游标");
    assert.equal(after.memory.length, 0);
    assert.equal(after.budget.length, 0);
    assert.ok(
      after.energyOf("rin") <= before.energyOf("rin") + 0.02,
      "跳过的 daily 不得扣除 -2 活动精力",
    );
    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.companionship.current.mode, "companion");
    assert.equal(snapshot.companionship.current.activity ?? null, null);
    assert.equal(snapshot.desktop.mode, "companion");
    assert.equal(snapshot.desktop.activity ?? null, null);
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.match(logs, /ACTIVITY_ACTION_UNAVAILABLE/, "应明确记录日常正式动作缺失");
    facts.dailyUnavailable = {
      activities: after.activities.length,
      purpose: after.purpose,
      energyBefore: before.energyOf("rin"),
      energyAfter: after.energyOf("rin"),
      currentMode: snapshot.companionship.current.mode,
      desktopActivity: snapshot.desktop.activity ?? null,
      notCovered: "daily 正式动作素材未发布；实际播放验收 NOT_COVERED",
    };
    screenshots.push(await capture(page, "runtime-001-daily-unavailable"));
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

test("POL-ACTIVITY-RUNTIME-004 单一用途不双发；预算耗尽仍可本地探索；daily 未发布不启动", { timeout: 150000 }, async () => {
  const sourceDir = seedDataDir({ purpose: "source", source: true });
  const hiddenDir = seedDataDir({ purpose: "daily", desktopVisible: false });
  let sourceLaunched = null;
  let hiddenLaunched = null;
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

    // daily 正式动作未发布：后续机会只记录跳过，不建立活动、不扣费、不换用途。
    await triggerOpportunity(sourceLaunched.app, sourceLaunched.page, sourceDir, "daily", 62 * 60 * 1000);
    await delay(1600);
    const afterDaily = readDb(sourceDir);
    assert.equal(afterDaily.activities.length, 0, "daily 动作未发布时不得建立活动");
    assert.equal(afterDaily.purpose, "exploration");
    assert.equal(afterDaily.budget.filter((row) => row.sent === 1).length, 1);
    const afterDailyLogs = [...sourceLaunched.consoleLines, ...sourceLaunched.logs].join("\n");
    assert.match(afterDailyLogs, /ACTIVITY_ACTION_UNAVAILABLE/);
    facts.dailyUnavailable = {
      activities: afterDaily.activities.length,
      purpose: afterDaily.purpose,
      energy: afterDaily.energyOf("rin"),
      notCovered: "daily 正式动作未发布",
    };

    // 预算仍耗尽，但下一次机会可执行纯本地探索。
    await triggerOpportunity(
      sourceLaunched.app,
      sourceLaunched.page,
      sourceDir,
      "exploration",
      93 * 60 * 1000,
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
        [hiddenLaunched, sourceLaunched].find((item) => item && !item.exit) ??
        sourceLaunched ??
        hiddenLaunched,
      dataDirs: [sourceDir, hiddenDir],
      failure,
      facts,
      screenshots,
    });
  }
});
