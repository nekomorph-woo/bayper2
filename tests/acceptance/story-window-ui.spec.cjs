/* S06j 故事回看与相遇窗口 GUI Runner。真实 Electron 管理窗 → preload/IPC →
   正式 discovery-outcomes/story-progress → 真实 SQLite。首次配置使用本地 HTTP，
   不读 .env、不调用真实 API；作者目录与活动为临时 fixture，不修改正式
   assetAvailable。需独占 GUI 运行。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { startModelServer } = require("./fixture-server.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.now() - 10 * DAY;
const NARRATOR_ID = "rin";
const ACCEPT_TARGET_ID = "hu";
const LATER_TARGET_ID = "cheng";
const SOURCE_FILES = [
  "app/discovery-outcomes.cjs",
  "app/main.cjs",
  "app/preload.cjs",
  "app/renderer/app.js",
  "app/renderer/index.html",
  "app/renderer/story-panel.js",
  "app/renderer/styles.css",
  "app/story-window.cjs",
  "tests/acceptance/story-window-ui.spec.cjs",
  "tests/acceptance/story-window.spec.cjs",
];
const SOURCE_DIGEST = SOURCE_FILES.map((file) => {
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(repoRoot, file)))
    .digest("hex");
  return `${file}:${digest}`;
}).join("\n");
const SOURCE_SHA = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unavailable";
  }
})();
const RUN_ID = `run-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")
  .slice(0, 17)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const EVIDENCE_DIR =
  process.env.BAYPER_S06J_EVIDENCE_DIR ??
  path.join(
    repoRoot,
    ".hapilon",
    "polaris",
    "Bayper完整交付",
    "evidence",
    "s06j-story-window",
    RUN_ID,
  );
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "meta.json"),
  `${JSON.stringify(
    {
      runId: RUN_ID,
      sourceSha: SOURCE_SHA,
      sourceFiles: SOURCE_FILES,
      sourceDigest: crypto
        .createHash("sha256")
        .update(SOURCE_DIGEST)
        .digest("hex"),
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(message);
}

function story(storyId, targetId, options = {}) {
  return {
    storyId,
    type: "character",
    targetId,
    ownerCharacterId: null,
    themeId: "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: [
      {
        nodeId: `${storyId}-node-1`,
        factId: `${storyId}-fact-1`,
        body: `fixture ${storyId} occurred body`,
      },
    ],
  };
}

function longStory(storyId, targetId, nodeCount = 10) {
  return {
    ...story(storyId, targetId),
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      nodeId: `${storyId}-node-${index + 1}`,
      factId: `${storyId}-fact-${index + 1}`,
      body: `第 ${index + 1} 段。${"这是用于撑开故事局部滚动视口的长正文。".repeat(8)}`,
    })),
  };
}

function catalog(stories) {
  return {
    schemaVersion: 1,
    theme: { id: "fixture-theme", name: "测试主题" },
    stories,
  };
}

function writeCatalog(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

function insertActivity(db, activityId, at, characterId = NARRATOR_ID) {
  db.prepare(`
    INSERT INTO character_activities
      (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
       started_at, completed_at, action_completed_at, action_frame, created_at, updated_at)
    VALUES (?, ?, 'daily', 'completed', 10000, 10000, ?, ?, ?, 8, ?, ?)
  `).run(activityId, characterId, at, at, at, at, at);
}

/* 只写临时数据目录；fixture 的“可用”副本只存在于测试内存和临时 JSON。
   角色 rin 已由真实首次配置接纳；故事事实使用同一讲述者。 */
function seedData(
  dataDir,
  content,
  { record = [], quotaStory = null, narratorId = NARRATOR_ID } = {},
) {
  const clock = { ms: START };
  const store = createStore(dataDir, {
    storyCatalog: content,
    now: () => clock.ms,
  });
  try {
    // 首次配置启动时留下的运行基线会把随后写入的活动当作历史；重开前清空，
    // 让第二次启动重新建立保守基线，不自动消费本测试构造的故事事实。
    store.db.exec("DELETE FROM story_runtime_activity_results");
    store.db
      .prepare("DELETE FROM app_state WHERE key = 'story_runtime_baseline_at'")
      .run();
    record.forEach((storyId) => {
      const item = content.stories.find((candidate) => candidate.storyId === storyId);
      item.nodes.forEach((node, nodeIndex) => {
        const activityId = `seed-act-${storyId}-${nodeIndex + 1}`;
        insertActivity(store.db, activityId, clock.ms, narratorId);
        const result = store.storyProgress.recordNode({
          activityId,
          narratorId,
          storyId,
          nodeId: node.nodeId,
        });
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        clock.ms += DAY;
      });
    });
    if (quotaStory) {
      const prepared = store.discoveryOutcomes.prepareInvitation({ storyId: quotaStory });
      assert.equal(prepared.prepared, true, JSON.stringify(prepared));
      store.discoveryOutcomes.acknowledgeInvitation({
        invitationId: prepared.invitation.invitationId,
      });
      store.discoveryOutcomes.rejectInvitation({
        invitationId: prepared.invitation.invitationId,
      });
    }
  } finally {
    store.close();
  }
}

async function launchApp(dataDir, catalogPath, { heartbeatMs = 600000 } = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`, `--story-catalog=${catalogPath}`],
    env: {
      ...process.env,
      BAYPER_HEARTBEAT_MS: String(heartbeatMs),
      BAYPER_NOTIFICATION_TICK_MS: "600000",
      CLAUDE_CONFIG_DIR: path.join(dataDir, "no-claude-config"),
      CODEX_HOME: path.join(dataDir, "no-codex-home"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitProcessesGone(pids, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some(processAlive)) return true;
    await delay(100);
  }
  return false;
}

/* 同时确认 Electron 父进程和桌面画布子进程都已退出，才允许清理数据目录。 */
async function closeApp(launched) {
  let desktopKnown = false;
  let desktopPid = null;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = await launched.page.evaluate(() =>
        window.bayper.getSnapshot(),
      );
      const desktop = snapshot?.snapshot?.desktop ?? null;
      desktopPid = desktop?.pid ?? null;
      desktopKnown =
        snapshot?.ok === true &&
        (Number.isInteger(desktopPid) ||
          desktop?.state === "stopped" ||
          desktop?.state === "failed");
      if (desktopKnown) break;
      await delay(100);
    }
  } catch {
    desktopKnown = false;
  }
  const parent = launched.app.process?.() ?? null;
  const parentPid = parent?.pid ?? null;
  let closeError = null;
  try {
    await launched.app.close();
  } catch (error) {
    closeError = error;
  }
  const pids = [parentPid, desktopPid].filter(Number.isInteger);
  const gone = await waitProcessesGone(pids);
  return {
    status: gone && desktopKnown ? "exited" : "unconfirmed",
    parentPid,
    desktopPid,
    desktopKnown,
    parentAlive: parentPid ? processAlive(parentPid) : null,
    desktopAlive: desktopPid ? processAlive(desktopPid) : null,
    error: closeError?.message ?? null,
  };
}

async function completeOnboarding(page, baseUrl) {
  await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-story-window");
  await page.locator("#api-key").fill("sk-fixture-ok");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible", timeout: 20000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = await page.locator("#candidate-name").textContent();
    if (name?.includes("凛")) break;
    await page.locator("#next-candidate").click();
  }
  assert.match(await page.locator("#candidate-name").textContent(), /凛/);
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  const snapshot = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(snapshot.ok, true);
  assert.ok(
    snapshot.snapshot.companionship.characters.some(
      (character) => character.characterId === NARRATOR_ID,
    ),
    "首次配置后角色列表应包含正式角色凛",
  );
  return snapshot.snapshot;
}

async function openStoryTab(page) {
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('[data-nav="characters"]').click();
  await page.locator('[data-character-tab="stories"]').click();
}

async function openStories(page) {
  await openStoryTab(page);
  await page.locator("#story-list .character-item").first().waitFor({
    state: "visible",
    timeout: 20000,
  });
}

async function openStoriesEmpty(page) {
  await openStoryTab(page);
  await page.locator("#story-empty").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await page.locator("#story-empty").textContent(), /还没有已发生的故事/);
}

async function openStory(page, storyId) {
  await page.locator(`#story-list [data-story-id="${storyId}"]`).click();
  await page.locator("#story-detail-content").waitFor({
    state: "visible",
    timeout: 20000,
  });
}

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function readState(dataDir, storyId) {
  const db = openDb(dataDir);
  try {
    return {
      invitation: db
        .prepare("SELECT * FROM discovery_invitations WHERE story_id = ?")
        .get(storyId),
      quota: Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM discovery_invitations WHERE quota_at IS NOT NULL",
          )
          .get().n,
      ),
      current: db
        .prepare("SELECT value FROM app_state WHERE key = 'current_character_id'")
        .get().value,
      roster: db.prepare("SELECT * FROM roster ORDER BY day, slot").all(),
      facts: Number(db.prepare("SELECT COUNT(*) AS n FROM story_facts").get().n),
      activities: Number(
        db.prepare("SELECT COUNT(*) AS n FROM character_activities").get().n,
      ),
    };
  } finally {
    db.close();
  }
}

function readRelationship(dataDir, characterId) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT * FROM relationships WHERE character_id = ?")
      .get(characterId);
  } finally {
    db.close();
  }
}

function readStats(dataDir, characterId) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        "SELECT intimacy, energy, mood FROM character_stats WHERE character_id = ?",
      )
      .get(characterId);
  } finally {
    db.close();
  }
}

function readRelationshipIds(dataDir) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT character_id FROM relationships ORDER BY character_id")
      .all()
      .map((row) => row.character_id);
  } finally {
    db.close();
  }
}

function readInvitation(dataDir, storyId) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT * FROM discovery_invitations WHERE story_id = ?")
      .get(storyId);
  } finally {
    db.close();
  }
}

function readRuntimeResult(dataDir, activityId) {
  const db = openDb(dataDir);
  try {
    return db
      .prepare("SELECT * FROM story_runtime_activity_results WHERE activity_id = ?")
      .get(activityId);
  } finally {
    db.close();
  }
}

function writeEvidence(name, payload) {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.json`),
    `${JSON.stringify(
      {
        runId: RUN_ID,
        sourceSha: SOURCE_SHA,
        sourceDigest: crypto
          .createHash("sha256")
          .update(SOURCE_DIGEST)
          .digest("hex"),
        ...payload,
      },
      null,
      2,
    )}\n`,
  );
}

async function closeAndAssert(launched, key, facts) {
  const result = await closeApp(launched);
  facts[key] = result;
  assert.equal(result.status, "exited", `进程退出未确认：${JSON.stringify(result)}`);
}

async function closeModelServer(server, facts) {
  if (!server) return null;
  try {
    await server.close();
    facts.server = "closed";
    return null;
  } catch (error) {
    facts.server = `failed: ${error.message}`;
    return error;
  }
}

/* 子进程退出确认后才删除临时数据目录；失败时保留证据并继续抛出原错误。 */
function finalize(dataDir, launched, name, facts, failure) {
  if (launched) {
    facts.directory = `retained: ${dataDir}`;
    facts.cleanup = "skipped: 进程退出未确认";
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
  writeEvidence(name, { failure: failure?.stack ?? null, ...facts });
  if (failure) throw failure;
}

const ACCEPT_STORY = "ui.char.accept";
const LATER_STORY = "ui.char.later";
const HIDDEN_STORY = "ui.char.hidden";
const QUOTA_STORY = "ui.char.quota";
const LONG_STORY = "ui.char.long";
const REFRESH_STORY = "ui.char.refresh";

test(
  "POL-STORYUI-UI-001 真实管理窗回看、manual展示、接纳与重启",
  { timeout: 180000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-accept-"));
    const content = catalog([
      story(ACCEPT_STORY, ACCEPT_TARGET_ID),
      story(LATER_STORY, LATER_TARGET_ID),
      story(HIDDEN_STORY, "ui.hidden"),
      story(QUOTA_STORY, "ui.quota"),
    ]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = {
        current: initial.companionship.current?.characterId ?? null,
        characters: initial.companionship.characters.map(
          (character) => character.characterId,
        ),
      };
      assert.equal(facts.onboarding.current, NARRATOR_ID);
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content, {
        record: [ACCEPT_STORY, LATER_STORY, HIDDEN_STORY, QUOTA_STORY],
        quotaStory: QUOTA_STORY,
      });

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      facts.itemCount = await launched.page.locator("#story-list .character-item").count();
      assert.equal(facts.itemCount, 4);
      assert.equal(
        await launched.page.locator("#story-list").textContent().then((text) =>
          text.includes("fixture"),
        ),
        false,
        "列表不得泄露作者正文",
      );
      facts.size = await launched.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        focused: document.hasFocus(),
      }));
      assert.ok(facts.size.width >= 1000 && facts.size.height >= 700);
      assert.equal(facts.size.focused, true);

      await openStory(launched.page, ACCEPT_STORY);
      await launched.page.locator("#story-invitation").waitFor({
        state: "visible",
        timeout: 20000,
      });
      await waitFor(
        async () => (await launched.page.locator("#story-accept").isEnabled()) === true,
        20000,
        "可见邀请未完成 manual 展示回执",
      );
      facts.afterAck = readInvitation(dataDir, ACCEPT_STORY);
      assert.equal(facts.afterAck.status, "pending");
      assert.notEqual(facts.afterAck.displayed_at, null);
      assert.equal(facts.afterAck.quota_at, null, "主动查看不占自动 7 天额度");
      assert.equal(readState(dataDir, ACCEPT_STORY).quota, 1, "原有自动额度保持不变");

      const before = readState(dataDir, ACCEPT_STORY);
      const nodesText = await launched.page.locator("#story-nodes").textContent();
      assert.match(nodesText, /fixture ui\.char\.accept occurred body/);
      assert.match(nodesText, /由凛讲述/);
      assert.match(nodesText, /日常记录/);
      assert.match(await launched.page.locator("#story-title").textContent(), /关于琥珀/);
      await launched.page.locator("#story-accept").click();
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation-text")?.textContent.includes("已接纳"),
      );
      await launched.page.waitForFunction(() =>
        document.querySelector("#character-list")?.textContent.includes("琥珀"),
      );
      const after = readState(dataDir, ACCEPT_STORY);
      assert.equal(readRelationship(dataDir, ACCEPT_TARGET_ID).character_id, "hu");
      assert.deepEqual(
        { ...readStats(dataDir, ACCEPT_TARGET_ID) },
        { intimacy: 10, energy: 100, mood: 0 },
      );
      assert.deepEqual(readRelationshipIds(dataDir), ["hu", "rin"]);
      const afterSnapshot = await launched.page.evaluate(() =>
        window.bayper.getSnapshot(),
      );
      assert.ok(
        afterSnapshot.snapshot.companionship.characters.some(
          (character) =>
            character.characterId === "hu" && character.displayName === "琥珀",
        ),
        "真实角色列表应包含接纳后的琥珀",
      );
      assert.equal(after.current, before.current, "接纳不得切换当前角色");
      assert.deepEqual(after.roster, before.roster, "接纳不得改固定位或今日名单");
      assert.equal(after.facts, before.facts);
      assert.equal(after.activities, before.activities);
      facts.accepted = after;
      facts.acceptedCharacter = afterSnapshot.snapshot.companionship.characters.find(
        (character) => character.characterId === "hu",
      );
      await launched.page.screenshot({
        path: path.join(EVIDENCE_DIR, "story-window-accept.png"),
        fullPage: false,
      });
      await closeAndAssert(launched, "firstExit", facts);
      launched = null;

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await openStory(launched.page, ACCEPT_STORY);
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation-text")?.textContent.includes("已接纳"),
      );
      assert.equal(readInvitation(dataDir, ACCEPT_STORY).status, "accepted");
      assert.equal(readRelationship(dataDir, ACCEPT_TARGET_ID).character_id, "hu");
      await launched.page.waitForFunction(() =>
        document.querySelector("#character-list")?.textContent.includes("琥珀"),
      );
      await closeAndAssert(launched, "secondExit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.secondExit = await closeApp(launched);
          if (facts.secondExit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "accept", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-003 稍后重启、拒绝与主动重开保持同一邀请",
  { timeout: 180000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-later-"));
    const content = catalog([story(LATER_STORY, LATER_TARGET_ID)]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content, { record: [LATER_STORY] });

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await openStory(launched.page, LATER_STORY);
      assert.match(await launched.page.locator("#story-nodes").textContent(), /由凛讲述/);
      assert.match(await launched.page.locator("#story-title").textContent(), /关于澄/);
      await launched.page.locator("#story-invitation").waitFor({ state: "visible" });
      await waitFor(
        async () => (await launched.page.locator("#story-later").isEnabled()) === true,
        20000,
        "稍后按钮在展示回执后仍不可用",
      );
      const displayed = readInvitation(dataDir, LATER_STORY);
      await launched.page.locator("#story-later").click();
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation-text")?.textContent.includes("已稍后"),
      );
      const later = readInvitation(dataDir, LATER_STORY);
      assert.equal(later.status, "later");
      assert.equal(later.displayed_at, displayed.displayed_at);
      assert.equal(later.quota_at, null);
      facts.later = later;
      await closeAndAssert(launched, "firstExit", facts);
      launched = null;

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await openStory(launched.page, LATER_STORY);
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation-text")?.textContent.includes("已稍后"),
      );
      await launched.page.locator("#story-reject").click();
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation-text")?.textContent.includes("已经结束"),
      );
      const rejected = readInvitation(dataDir, LATER_STORY);
      assert.equal(rejected.status, "rejected");
      await launched.page.locator("#story-reopen").click();
      await launched.page.waitForFunction(
        () =>
          document.querySelector("#story-invitation-text")?.textContent.includes("等你决定"),
      );
      const reopened = readInvitation(dataDir, LATER_STORY);
      assert.equal(reopened.status, "pending");
      assert.equal(reopened.displayed_at, displayed.displayed_at, "重开不刷新首次展示时间");
      assert.equal(reopened.quota_at, null);
      facts.reopened = reopened;
      await closeAndAssert(launched, "secondExit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.secondExit = await closeApp(launched);
          if (facts.secondExit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "later", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-004B 长正文滚动前不ACK，滚入局部视口后才确认",
  { timeout: 180000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-long-"));
    const content = catalog([longStory(LONG_STORY, "ui.long", 10)]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content, { record: [LONG_STORY] });

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await openStory(launched.page, LONG_STORY);
      await launched.page.locator("#story-invitation").waitFor({ state: "visible" });
      facts.before = await launched.page.evaluate(() => {
        const item = document.querySelector("#story-invitation").getBoundingClientRect();
        const view = document.querySelector("#story-detail").getBoundingClientRect();
        return {
          intersects: item.bottom > view.top && item.top < view.bottom,
          itemTop: item.top,
          viewBottom: view.bottom,
          scrollTop: document.querySelector("#story-detail").scrollTop,
          scrollHeight: document.querySelector("#story-detail").scrollHeight,
        };
      });
      assert.equal(facts.before.intersects, false, "长正文应把邀请挡在局部视口外");
      assert.equal(facts.before.scrollTop, 0);
      await delay(800);
      assert.equal(
        readInvitation(dataDir, LONG_STORY).displayed_at,
        null,
        "邀请未进入局部视口时不得确认展示",
      );
      await launched.page.screenshot({
        path: path.join(EVIDENCE_DIR, "long-story-before-scroll.png"),
      });

      // 只露出邀请顶部约 2px：边框刚相交不算可读，不得确认展示。
      await launched.page.evaluate(() => {
        const viewElement = document.querySelector("#story-detail");
        const item = document.querySelector("#story-invitation").getBoundingClientRect();
        const view = viewElement.getBoundingClientRect();
        viewElement.scrollTop += item.top - view.bottom + 2;
      });
      await delay(600);
      facts.partial = await launched.page.evaluate(() => {
        const view = document.querySelector("#story-detail").getBoundingClientRect();
        const item = document.querySelector("#story-invitation").getBoundingClientRect();
        const title = document
          .querySelector(".story-invitation-title")
          .getBoundingClientRect();
        const body = document
          .querySelector("#story-invitation-text")
          .getBoundingClientRect();
        const height = (rect) =>
          Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top));
        return {
          intersects: item.bottom > view.top && item.top < view.bottom,
          titleVisible: height(title),
          bodyVisible: height(body),
          scrollTop: document.querySelector("#story-detail").scrollTop,
        };
      });
      assert.equal(facts.partial.intersects, true);
      assert.ok(
        facts.partial.titleVisible < 16 || facts.partial.bodyVisible < 24,
        "只露出边框时标题/正文不应可读",
      );
      assert.equal(
        readInvitation(dataDir, LONG_STORY).displayed_at,
        null,
        "邀请只有边缘进入视口时不得确认展示",
      );
      await launched.page.screenshot({
        path: path.join(EVIDENCE_DIR, "long-story-edge-only.png"),
      });

      await launched.page.evaluate(() => {
        const view = document.querySelector("#story-detail");
        view.scrollTop = view.scrollHeight;
      });
      await delay(100);
      facts.afterScroll = await launched.page.evaluate(() => {
        const view = document.querySelector("#story-detail").getBoundingClientRect();
        const item = document.querySelector("#story-invitation").getBoundingClientRect();
        const title = document
          .querySelector(".story-invitation-title")
          .getBoundingClientRect();
        const body = document
          .querySelector("#story-invitation-text")
          .getBoundingClientRect();
        const height = (rect) =>
          Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top));
        return {
          intersects: item.bottom > view.top && item.top < view.bottom,
          titleVisible: height(title),
          bodyVisible: height(body),
          scrollTop: document.querySelector("#story-detail").scrollTop,
        };
      });
      assert.equal(facts.afterScroll.intersects, true);
      assert.ok(facts.afterScroll.scrollTop > 0);
      assert.ok(facts.afterScroll.titleVisible >= 16);
      assert.ok(facts.afterScroll.bodyVisible >= 24);
      await launched.page.screenshot({
        path: path.join(EVIDENCE_DIR, "long-story-after-scroll.png"),
      });
      await waitFor(
        () => readInvitation(dataDir, LONG_STORY)?.displayed_at !== null,
        20000,
        "滚入视口后未确认 manual 展示",
      );
      const shown = readInvitation(dataDir, LONG_STORY);
      assert.equal(shown.quota_at, null);
      facts.after = await launched.page.evaluate(() => {
        const item = document.querySelector("#story-invitation").getBoundingClientRect();
        const view = document.querySelector("#story-detail").getBoundingClientRect();
        return {
          intersects: item.bottom > view.top && item.top < view.bottom,
          scrollTop: document.querySelector("#story-detail").scrollTop,
        };
      });
      facts.invitation = shown;
      await closeAndAssert(launched, "exit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.exit = await closeApp(launched);
          if (facts.exit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "long-viewport", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-003B 运行中新增真实活动节点，重进故事页刷新且不准备邀请",
  { timeout: 180000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-refresh-"));
    const content = catalog([story(REFRESH_STORY, "ui.refresh")]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content);

      launched = await launchApp(dataDir, catalogPath, { heartbeatMs: 1000 });
      await launched.app.evaluate(() => {
        Math.random = () => 0.9;
      });
      await openStoriesEmpty(launched.page);
      assert.equal(await launched.page.locator("#story-list .character-item").count(), 0);
      assert.equal(readState(dataDir, REFRESH_STORY).facts, 0);

      const db = new DatabaseSync(path.join(dataDir, DB_FILE));
      try {
        db.exec("PRAGMA busy_timeout = 2000");
        insertActivity(db, "refresh-act", Date.now());
      } finally {
        db.close();
      }
      await waitFor(
        () => readRuntimeResult(dataDir, "refresh-act")?.outcome === "applied",
        20000,
        "主进程未在心跳中消费真实活动节点",
      );
      assert.equal(readState(dataDir, REFRESH_STORY).facts, 1);
      const factsAfterActivity = readState(dataDir, REFRESH_STORY).facts;
      assert.equal(readInvitation(dataDir, REFRESH_STORY), undefined);

      await launched.page.locator('[data-nav="home"]').click();
      await launched.page.locator('[data-nav="characters"]').click();
      await launched.page.locator('[data-character-tab="stories"]').click();
      await launched.page.locator("#story-list .character-item").first().waitFor({
        state: "visible",
        timeout: 20000,
      });
      facts.listText = await launched.page.locator("#story-list").textContent();
      assert.match(facts.listText, /关于ui\.refresh/);
      assert.equal(readState(dataDir, REFRESH_STORY).facts, factsAfterActivity);
      assert.equal(
        readInvitation(dataDir, REFRESH_STORY),
        undefined,
        "列表刷新不得准备或确认邀请",
      );
      facts.runtime = readRuntimeResult(dataDir, "refresh-act");
      await launched.page.screenshot({
        path: path.join(EVIDENCE_DIR, "refresh-story-list.png"),
      });
      await closeAndAssert(launched, "exit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.exit = await closeApp(launched);
          if (facts.exit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "refresh", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-004 隐藏窗口不确认展示，其他邀请不误接纳当前故事",
  { timeout: 120000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-hidden-"));
    const content = catalog([
      story(HIDDEN_STORY, "ui.hidden"),
      story(LATER_STORY, LATER_TARGET_ID),
    ]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content, { record: [HIDDEN_STORY, LATER_STORY] });
      const seedStore = createStore(dataDir, {
        storyCatalog: content,
        now: () => START + 3 * DAY,
      });
      let prepared;
      try {
        prepared = seedStore.discoveryOutcomes.prepareInvitation({
          storyId: HIDDEN_STORY,
          source: "manual",
        });
      } finally {
        seedStore.close();
      }
      assert.equal(prepared.prepared, true, JSON.stringify(prepared));

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed() && window.getTitle() === "Bayper")
          .hide();
      });
      const hidden = await launched.page.evaluate(async (storyId) => {
        const list = await window.bayperStories.listStories();
        const detail = await window.bayperStories.getStory(storyId);
        const ack = await window.bayperStories.acknowledgeInvitation({
          storyId,
          invitationId: detail.invitation.invitationId,
          viewToken: detail.viewToken,
          visible: true,
        });
        const other = await window.bayperStories.getStory("ui.char.later");
        return { list, detail, ack, other };
      }, HIDDEN_STORY);
      assert.equal(hidden.list.ok, true);
      assert.equal(hidden.ack.ok, false);
      assert.equal(hidden.ack.error.code, "INVITATION_NOT_VISIBLE");
      assert.equal(readInvitation(dataDir, HIDDEN_STORY).displayed_at, null);
      assert.equal(readInvitation(dataDir, HIDDEN_STORY).quota_at, null);
      assert.equal(hidden.other.ok, true);
      assert.equal(hidden.other.invitation, null, "不能把另一份邀请当成当前故事目标");
      assert.equal(hidden.other.otherInvitation.storyId, HIDDEN_STORY);
      assert.equal(hidden.other.preparation.reason, "INVITATION_ACTIVE");
      assert.equal(readInvitation(dataDir, LATER_STORY), undefined);
      facts.hidden = { ack: hidden.ack, other: hidden.other.preparation };

      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed() && window.getTitle() === "Bayper")
          .show();
      });
      await launched.page.bringToFront();
      await openStory(launched.page, LATER_STORY);
      await launched.page.waitForFunction(
        () =>
          document.querySelector("#story-invitation-text")?.textContent.includes("另一份相遇邀请"),
      );
      assert.equal(await launched.page.locator("#story-accept").isHidden(), true);
      await openStory(launched.page, HIDDEN_STORY);
      await launched.page.locator("#story-invitation").waitFor({ state: "visible" });
      await waitFor(
        async () => (await launched.page.locator("#story-accept").isEnabled()) === true,
        20000,
        "恢复可见后未完成 manual 展示",
      );
      const displayed = readInvitation(dataDir, HIDDEN_STORY);
      assert.notEqual(displayed.displayed_at, null);
      assert.equal(displayed.quota_at, null);
      facts.displayed = displayed;
      await closeAndAssert(launched, "exit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.exit = await closeApp(launched);
          if (facts.exit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "hidden", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-005 快速切换后迟到详情不覆盖当前故事",
  { timeout: 120000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-late-"));
    const content = catalog([
      story(ACCEPT_STORY, ACCEPT_TARGET_ID),
      story(LATER_STORY, LATER_TARGET_ID),
    ]);
    const catalogPath = writeCatalog(dataDir, "fixture-catalog.json", content);
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, catalogPath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, content, { record: [ACCEPT_STORY, LATER_STORY] });

      launched = await launchApp(dataDir, catalogPath);
      await openStories(launched.page);
      await launched.app.evaluate(({ ipcMain }, storyId) => {
        const handlers = ipcMain._invokeHandlers;
        const original = handlers.get("bayper:story:detail");
        let delayed = false;
        ipcMain.removeHandler("bayper:story:detail");
        ipcMain.handle("bayper:story:detail", async (event, id) => {
          const result = await original(event, id);
          if (id === storyId && !delayed) {
            delayed = true;
            await new Promise((resolve) => {
              globalThis.__s06jRelease = resolve;
            });
          }
          return result;
        });
      }, ACCEPT_STORY);
      await launched.page.locator(`#story-list [data-story-id="${ACCEPT_STORY}"]`).click();
      await delay(80);
      await launched.page.locator(`#story-list [data-story-id="${LATER_STORY}"]`).click();
      await launched.page.waitForFunction(
        (expected) =>
          document.querySelector("#story-nodes")?.textContent.includes(expected),
        `fixture ${LATER_STORY} occurred body`,
      );
      await launched.app.evaluate(() => globalThis.__s06jRelease?.());
      await delay(400);
      facts.title = await launched.page.locator("#story-title").textContent();
      facts.nodes = await launched.page.locator("#story-nodes").textContent();
      assert.match(facts.nodes, new RegExp(`fixture ${LATER_STORY}`));
      assert.equal(facts.nodes.includes(`fixture ${ACCEPT_STORY}`), false);
      assert.equal(
        readInvitation(dataDir, ACCEPT_STORY).displayed_at,
        null,
        "绘制前切走的详情不得确认展示",
      );

      // 先取 A 的详情身份，再取 B 覆盖当前展示身份；A 的晚到 ACK 必须被拒绝。
      const lateAck = await launched.page.evaluate(async () => {
        const first = await window.bayperStories.getStory("ui.char.accept");
        await window.bayperStories.getStory("ui.char.later");
        return window.bayperStories.acknowledgeInvitation({
          storyId: first.story.storyId,
          invitationId: first.invitation.invitationId,
          viewToken: first.viewToken,
          visible: true,
        });
      });
      assert.equal(lateAck.ok, false);
      assert.equal(lateAck.error.code, "STORY_VIEW_STALE");
      assert.equal(readInvitation(dataDir, ACCEPT_STORY).displayed_at, null);
      facts.lateAck = lateAck;

      // 取详情身份后切回总览；切页会主动失效身份，旧 ACK 不得确认。
      const leaveIdentity = await launched.page.evaluate(() =>
        window.bayperStories.getStory("ui.char.accept"),
      );
      await launched.page.locator('[data-character-tab="overview"]').click();
      await delay(100);
      const afterLeave = await launched.page.evaluate(
        (payload) => window.bayperStories.acknowledgeInvitation(payload),
        {
          storyId: leaveIdentity.story.storyId,
          invitationId: leaveIdentity.invitation.invitationId,
          viewToken: leaveIdentity.viewToken,
          visible: true,
        },
      );
      assert.equal(afterLeave.ok, false);
      assert.equal(afterLeave.error.code, "STORY_VIEW_STALE");
      assert.equal(readInvitation(dataDir, ACCEPT_STORY).displayed_at, null);
      facts.leaveAck = afterLeave;
      await closeAndAssert(launched, "exit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.exit = await closeApp(launched);
          if (facts.exit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "late", facts, failure);
    }
  },
);

test(
  "POL-STORYUI-UI-004 正式未发布素材门在故事窗口保持",
  { timeout: 120000 },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s06j-ui-asset-"));
    const available = story("ui.char.asset", "ui.asset");
    const availableCatalog = catalog([available]);
    const unavailableCatalog = catalog([{ ...available, assetAvailable: false }]);
    const availablePath = writeCatalog(
      dataDir,
      "available-catalog.json",
      availableCatalog,
    );
    const unavailablePath = writeCatalog(
      dataDir,
      "unavailable-catalog.json",
      unavailableCatalog,
    );
    const server = await startModelServer();
    let setup = null;
    let launched = null;
    let failure = null;
    const facts = {};
    try {
      setup = await launchApp(dataDir, availablePath);
      const initial = await completeOnboarding(setup.page, server.baseUrl);
      facts.onboarding = initial.companionship.current?.characterId ?? null;
      await closeAndAssert(setup, "setupExit", facts);
      setup = null;
      seedData(dataDir, availableCatalog, { record: ["ui.char.asset"] });
      const seedStore = createStore(dataDir, {
        storyCatalog: availableCatalog,
        now: () => START + 2 * DAY,
      });
      let seededInvitation;
      try {
        const prepared = seedStore.discoveryOutcomes.prepareInvitation({
          storyId: "ui.char.asset",
          source: "manual",
        });
        seedStore.discoveryOutcomes.acknowledgeInvitation({
          invitationId: prepared.invitation.invitationId,
          source: "manual",
        });
        seededInvitation = seedStore.discoveryOutcomes.getInvitationByStory({
          storyId: "ui.char.asset",
        });
      } finally {
        seedStore.close();
      }

      launched = await launchApp(dataDir, unavailablePath);
      await openStories(launched.page);
      await openStory(launched.page, "ui.char.asset");
      await launched.page.waitForFunction(
        () => document.querySelector("#story-invitation")?.textContent.includes("素材暂时不可用"),
      );
      facts.unavailable = await launched.page.locator("#story-invitation").textContent();
      assert.equal(
        await launched.page.locator("#story-accept").isEnabled(),
        false,
        "素材不可用时不得接纳",
      );
      const invitation = readInvitation(dataDir, "ui.char.asset");
      assert.equal(invitation.invitation_id, seededInvitation.invitationId);
      assert.equal(invitation.displayed_at, seededInvitation.displayedAt);
      const direct = await launched.page.evaluate(
        (invitationId) => window.bayperStories.acceptInvitation(invitationId),
        seededInvitation.invitationId,
      );
      assert.equal(direct.ok, false);
      assert.equal(direct.error.code, "INVITATION_SOURCE_UNAVAILABLE");
      const detail = await launched.page.evaluate(() =>
        window.bayperStories.getStory("ui.char.asset"),
      );
      assert.equal(detail.ok, true);
      assert.equal(detail.story.available, false);
      assert.equal(detail.story.reason, "ASSET_UNAVAILABLE");
      assert.equal(detail.invitation.invitationId, seededInvitation.invitationId);
      assert.equal(readState(dataDir, "ui.char.asset").facts, 1);
      assert.equal(
        await launched.page.evaluate(() => window.bayper.getSnapshot()).then(
          (result) =>
            result.snapshot.companionship.characters.some(
              (character) => character.characterId === "ui.asset",
            ) === false,
        ),
        true,
      );
      await closeAndAssert(launched, "exit", facts);
      launched = null;
    } catch (error) {
      failure = error;
    } finally {
      if (setup) {
        try {
          facts.setupExit = await closeApp(setup);
          if (facts.setupExit.status === "exited") setup = null;
        } catch (error) {
          failure ??= error;
        }
      }
      if (launched) {
        try {
          facts.exit = await closeApp(launched);
          if (facts.exit.status === "exited") launched = null;
        } catch (error) {
          failure ??= error;
        }
      }
      const serverError = await closeModelServer(server, facts);
      failure ??= serverError;
      finalize(dataDir, launched || setup, "unavailable", facts, failure);
    }
  },
);
