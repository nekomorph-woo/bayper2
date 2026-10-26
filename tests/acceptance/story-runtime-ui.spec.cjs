/* S06i 真实 Electron 接线验收：本机 HTTP 首次配置、真实 daily 动画完成、
   正式 main 消费结果落库、正式未发布素材门、重启不重放与正常退出。
   不读取 .env/真实 Key；不通过 main 源码字符串或直接调用 runtime 冒充接线。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { startModelServer } = require("./fixture-server.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const CONTENT_PATH = path.join(repoRoot, "app", "content", "maid-stories.json");
const EVIDENCE_DIR =
  process.env.BAYPER_S06I_EVIDENCE_DIR ??
  path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence",
    "s06i-story-runtime", `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(40);
  }
  assert.fail(message);
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
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}
async function closeApp(app) {
  const handle = app.process?.() ?? null;
  await app.close();
  const exited = !handle || handle.exitCode !== null || handle.signalCode !== null;
  return {
    status: exited ? "exited" : "unconfirmed",
    code: handle?.exitCode ?? null,
    signal: handle?.signalCode ?? null,
  };
}
async function onboarding(page, baseUrl) {
  await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-model");
  await page.locator("#api-key").fill("sk-fixture-ok");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}
async function waitDesktop(page) {
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
}
async function patchClock(app, offsetMs) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__s06iClock) {
        const RealDate = Date;
        const clock = { base: RealDate.now(), value: RealDate.now() };
        globalThis.__s06iClock = clock;
        globalThis.Date = class extends RealDate {
          constructor(...args) {
            super(...(args.length === 0 ? [clock.value] : args));
          }
          static now() {
            return clock.value;
          }
        };
      }
      const clock = globalThis.__s06iClock;
      clock.value = clock.base + input.offset;
      Math.random = () => 0.1;
    },
    { offset: offsetMs },
  );
}
function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}
function readFirstActivity(dataDir) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT * FROM character_activities ORDER BY created_at, activity_id LIMIT 1")
      .get();
  } finally {
    db.close();
  }
}
function readFacts(dataDir, activityId) {
  const db = openDb(dataDir);
  try {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
    return {
      activity: db
        .prepare("SELECT * FROM character_activities WHERE activity_id = ?")
        .get(activityId),
      activityCount: count("SELECT COUNT(*) AS n FROM character_activities"),
      progress: count("SELECT COUNT(*) AS n FROM story_progress"),
      storyFacts: count("SELECT COUNT(*) AS n FROM story_facts"),
      activityResults: count("SELECT COUNT(*) AS n FROM story_activity_results"),
      runtimeResults: count(
        "SELECT COUNT(*) AS n FROM story_runtime_activity_results WHERE activity_id = ?",
        activityId,
      ),
      runtimeResult: db
        .prepare("SELECT * FROM story_runtime_activity_results WHERE activity_id = ?")
        .get(activityId),
      invitations: count("SELECT COUNT(*) AS n FROM discovery_invitations"),
      ownership: count("SELECT COUNT(*) AS n FROM discovery_outfit_ownership"),
    };
  } finally {
    db.close();
  }
}
test(
  "POL-STORYRUN-UI-001 真实 daily 完成后 main 消费落库、素材门保持且重启不重放",
  { timeout: 180000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06i-ui-"));
    const server = await startModelServer();
    const facts = {
      cleanup: null,
      directory: null,
      server: null,
      exitConfirmed: null,
      firstExit: null,
      secondExit: null,
    };
    let launched = null;
    let failure = null;
    try {
      launched = await launchApp(dataDir);
      await onboarding(launched.page, server.baseUrl);
      await waitDesktop(launched.page);
      const purposeDb = new DatabaseSync(path.join(dataDir, DB_FILE));
      try {
        purposeDb.prepare(`
          INSERT INTO app_state (key, value) VALUES ('automatic_purpose_cursor', 'daily')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run();
      } finally {
        purposeDb.close();
      }
      await patchClock(launched.app, 31 * 60 * 1000);
      await waitFor(
        () => readFacts(dataDir, "").activityCount > 0,
        10000,
        "心跳未建立日常活动",
      );

      facts.activity = readFirstActivity(dataDir);
      facts.activityId = facts.activity.activity_id;
      assert.equal(facts.activity.kind, "daily");
      await waitFor(
        () => readFacts(dataDir, facts.activityId).activity?.status === "running",
        12000,
        "自然节点未启动日常动画",
      );
      await waitFor(
        () => readFacts(dataDir, facts.activityId).activity?.action_completed_at !== null,
        12000,
        "真实 daily 动画未完成",
      );
      assert.ok(Number(readFacts(dataDir, facts.activityId).activity.action_frame) >= 1);

      await patchClock(launched.app, 31 * 60 * 1000 + 11 * 1000);
      await waitFor(
        () => readFacts(dataDir, facts.activityId).activity?.status === "completed",
        10000,
        "动作与有效时长满足后未在自然节点收束",
      );
      await waitFor(
        () => readFacts(dataDir, facts.activityId).runtimeResults === 1,
        8000,
        "main 未消费已完成活动",
      );

      const consumed = readFacts(dataDir, facts.activityId);
      assert.equal(consumed.activity.status, "completed");
      assert.equal(consumed.activityResults, 0);
      assert.equal(consumed.runtimeResult.outcome, "skipped");
      assert.equal(consumed.runtimeResult.reason, "NO_STORY_CANDIDATE");
      assert.equal(consumed.progress, 0);
      assert.equal(consumed.storyFacts, 0);
      assert.equal(consumed.invitations, 0);
      assert.equal(consumed.ownership, 0);
      assert.equal(
        JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8")).stories.every(
          (story) => story.assetAvailable === false,
        ),
        true,
      );
      facts.consumed = consumed;
      facts.firstExit = await closeApp(launched.app);
      launched = null;
      assert.deepEqual(facts.firstExit, { status: "exited", code: 0, signal: null });

      // 同一数据目录重启：旧活动不重放，故事事实仍为空。
      launched = await launchApp(dataDir);
      await launched.page
        .locator('[data-step="home"]')
        .waitFor({ state: "visible", timeout: 20000 });
      await waitDesktop(launched.page);
      await delay(1200);
      const reopened = readFacts(dataDir, facts.activityId);
      assert.equal(reopened.runtimeResults, 1);
      assert.equal(reopened.progress, 0);
      assert.equal(reopened.storyFacts, 0);
      assert.equal(reopened.activityCount, 1);
      facts.reopened = reopened;
      facts.secondExit = await closeApp(launched.app);
      launched = null;
      assert.deepEqual(facts.secondExit, { status: "exited", code: 0, signal: null });
    } catch (error) {
      failure = error;
    } finally {
      let exitConfirmed = true;
      if (launched) {
        try {
          facts.secondExit = await closeApp(launched.app);
        } catch (error) {
          exitConfirmed = false;
          facts.secondExit = { status: "failed", error: error.message };
          failure ??= error;
        }
      }
      for (const result of [facts.firstExit, facts.secondExit]) {
        if (result && result.status !== "exited") {
          exitConfirmed = false;
        }
      }
      facts.exitConfirmed = exitConfirmed;
      try {
        await server.close();
        facts.server = "closed";
      } catch (error) {
        facts.server = `failed: ${error.message}`;
        failure ??= error;
      }
      if (!exitConfirmed) {
        facts.cleanup = "skipped: 进程退出未确认";
        facts.directory = `retained: ${dataDir}`;
        failure ??= new Error("应用退出未确认，保留临时目录");
      } else {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          facts.cleanup = "ok";
          facts.directory = "removed";
        } catch (error) {
          facts.cleanup = `failed: ${error.message}`;
          facts.directory = `retained: ${dataDir}`;
          failure ??= error;
        }
      }
      try {
        fs.writeFileSync(
          path.join(EVIDENCE_DIR, "story-runtime-ui.log"),
          [
            `failure: ${failure ? failure.stack || failure.message : "none"}`,
            `activityId: ${facts.activityId}`,
            `server: ${facts.server}`,
            `exitConfirmed: ${facts.exitConfirmed}`,
            `firstExit: ${JSON.stringify(facts.firstExit)}`,
            `secondExit: ${JSON.stringify(facts.secondExit)}`,
            `directory: ${facts.directory}`,
            `cleanup: ${facts.cleanup}`,
            `consumed: ${JSON.stringify(facts.consumed ?? null)}`,
            `reopened: ${JSON.stringify(facts.reopened ?? null)}`,
            "",
          ].join("\n"),
        );
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }
  },
);
