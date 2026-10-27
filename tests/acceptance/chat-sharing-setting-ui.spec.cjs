/* S03k 聊天全局自动分享设置 GUI Runner：真实 Electron main/preload/renderer/SQLite。
   不启动任何模型或本机 HTTP 服务，模型配置指向不可达地址；聊天关闭/恢复若真的
   触达模型或凭据路径，就不会出现本地确认。用真实 SQLite 触发器制造一次失败，
   验证界面重试按钮能重新走本地分支；记录父进程退出码与独有临时目录路径，
   截图覆盖失败重试、重试成功聊天确认、重启前仍关闭和恢复确认。
   由 Codex 在 GUI 环境执行并查看截图。覆盖 POL-SHARESETTING-005；领域事务、
   失败重试与歧义输入见 tests/acceptance/chat-sharing-setting.spec.cjs。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");
const { LOCAL_SHARING_SETTING_ERROR } = require("../../app/chat.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const AUTO_SHARE_KEY = "memory_auto_share_enabled";
const sourceFiles = [
  "app/chat.cjs",
  "app/chat-sharing-setting.cjs",
  "app/memory.cjs",
  "app/memory-store.cjs",
  "app/main.cjs",
  "app/preload.cjs",
  "app/renderer/index.html",
  "app/renderer/app.js",
  "app/renderer/chat-panel.js",
  "tests/acceptance/chat-sharing-setting-ui.spec.cjs",
];
const requestedBatch =
  process.env.S03K_SHARING_UI_BATCH ??
  `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
const evidenceDir = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s03k-chat-sharing-setting",
  requestedBatch,
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => String(error?.message ?? error).slice(0, 500);

function sha256File(relativePath) {
  const file = path.join(repoRoot, relativePath);
  return fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : "MISSING";
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-sharing-ui-"));
}

function openDb(dataDir, readOnly = false) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/* 用真实 SQLite 触发器制造一次本地设置写入失败；解除后由 GUI 重试按钮重放。 */
function createAutoShareFailTrigger(dataDir) {
  const db = openDb(dataDir);
  try {
    db.exec(`
      CREATE TRIGGER fail_auto_share BEFORE INSERT ON app_state
      WHEN NEW.key = '${AUTO_SHARE_KEY}'
      BEGIN SELECT RAISE(ABORT, 'injected auto share failure'); END;
    `);
  } finally {
    db.close();
  }
}

function dropTrigger(dataDir, name) {
  const db = openDb(dataDir);
  try {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  } finally {
    db.close();
  }
}

/* 直接构造已接纳、已配置模型的应用；模型地址不可达，确保本地分支不需要网络。 */
function seedAcceptedApp(dataDir) {
  const store = createStore(dataDir);
  try {
    store.db.exec(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, 'https://example.invalid/v1', 'fixture-sharing-setting',
              x'66697874757265', '${new Date().toISOString()}');
      INSERT INTO relationships (character_id, accepted_at) VALUES
        ('rin', '2026-01-01T00:00:00.000Z'), ('hu', '2026-01-01T00:00:00.000Z');
      INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES
        ('rin', 10, 100, 0), ('hu', 10, 100, 0);
    `);
    store.setAppState("current_character_id", "rin");
    store.setAppState("fixed_character_id", "rin");
    store.memory.remember({
      characterId: "rin",
      factKey: "pref.tea",
      body: "用户喜欢热茶",
      kind: "preference",
      sourceId: "seed:s03k-chat-sharing-setting",
    });
  } finally {
    store.close();
  }
}

function readSummary(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return {
      autoShare:
        db.prepare("SELECT value FROM app_state WHERE key = ?").get(AUTO_SHARE_KEY)?.value ?? null,
      memories: db
        .prepare("SELECT character_id, fact_key, body, version FROM memory_entries ORDER BY character_id, fact_key")
        .all(),
      relationships: db
        .prepare("SELECT character_id, accepted_at FROM relationships ORDER BY character_id")
        .all(),
      stats: db
        .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
        .all(),
      messages: db
        .prepare("SELECT role, content FROM chat_messages ORDER BY seq, id")
        .all(),
      requests: db
        .prepare("SELECT id, status, error_code, memory_applied FROM chat_requests ORDER BY created_at, id")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function waitForExit(proc, timeoutMs = 5000) {
  const started = Date.now();
  while (
    proc.exitCode === null &&
    proc.signalCode === null &&
    Date.now() - started < timeoutMs
  ) {
    await delay(50);
  }
  return { exitCode: proc.exitCode, signalCode: proc.signalCode };
}

async function closeApp(app) {
  if (!app) {
    return {
      closed: true,
      error: null,
      pid: null,
      exitCode: null,
      signalCode: null,
    };
  }
  const proc = app.process();
  try {
    await app.close();
    const exit = await waitForExit(proc);
    return {
      closed: exit.exitCode !== null || exit.signalCode !== null,
      error: null,
      pid: proc.pid,
      ...exit,
    };
  } catch (error) {
    const exit = await waitForExit(proc, 1000);
    return {
      closed: exit.exitCode !== null || exit.signalCode !== null,
      error: safeError(error),
      pid: proc.pid,
      ...exit,
    };
  }
}

async function waitForHome(page) {
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function openCurrentChat(page) {
  await page.locator("#chat-current").click();
  await page.locator("#chat-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#chat-title")?.textContent?.includes("凛"),
  );
}

/* 重启后聊天默认以只读历史打开；继续对话会新建一轮，开关本身是全局的。 */
async function continueFreshChat(page) {
  const button = page.locator("#chat-continue");
  if (await button.isVisible()) {
    await button.click();
    await page.locator("#chat-input").waitFor({ state: "visible" });
  }
}

async function sendChat(page, text, expectedReply) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes(expected),
      ),
    expectedReply,
    15000,
  );
}

async function closeChat(page) {
  await page.locator("#chat-close").click();
  await page.locator("#chat-panel").waitFor({ state: "hidden" });
}

async function openMemorySettings(page) {
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-settings-tab="memory"]').click();
  await page.locator('[data-settings-panel="memory"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const toggle = document.querySelector("#memory-auto-share");
    return Boolean(toggle) && !toggle.disabled && !toggle.indeterminate;
  });
  return page.evaluate(() => ({
    checked: document.querySelector("#memory-auto-share").checked,
    stateLabel: document.querySelector("#memory-share-state")?.textContent ?? "",
  }));
}

async function capture(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

function writeEvidence(fileName, evidence) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, fileName), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

test("POL-SHARESETTING-005 本地失败经GUI重试后关闭，读回设置并在重启后恢复", { timeout: 180000 }, async () => {
  const dataDir = makeDataDir();
  const evidence = {
    case: "POL-SHARESETTING-005",
    executedAt: new Date().toISOString(),
    dataDir,
    noModelServer: "未启动模型或本机 HTTP 服务；模型地址为不可达 fixture",
    sourceSha: Object.fromEntries(sourceFiles.map((file) => [file, sha256File(file)])),
    screenshots: [],
    facts: {},
    machineVerdict: "FAIL",
    semanticReviewStatus: "PENDING_CODEX",
  };
  let app = null;
  let failure = null;

  try {
    seedAcceptedApp(dataDir);
    createAutoShareFailTrigger(dataDir);
    const before = readSummary(dataDir);
    const first = await launchApp(dataDir);
    app = first.app;
    let page = first.page;
    await waitForHome(page);
    await openCurrentChat(page);

    // 真实 SQLite 写入失败：本地设置与确认一起回滚，界面出现可点击的重试按钮。
    await page.locator("#chat-input").fill("以后不要自动互相讲我的事。");
    await page.locator("#chat-send").click();
    await page.locator("#chat-retry").waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await page.locator("#chat-retry").isVisible(), true);
    await page.waitForFunction(() =>
      document.querySelector("#chat-status")?.textContent?.includes("发送失败"),
    );
    const failedSummary = readSummary(dataDir);
    assert.equal(failedSummary.autoShare, null);
    assert.deepEqual(failedSummary.memories, before.memories);
    assert.deepEqual(
      failedSummary.messages.map((message) => message.role),
      ["user"],
    );
    assert.equal(failedSummary.requests.length, 1);
    assert.equal(failedSummary.requests[0].status, "failed");
    assert.equal(failedSummary.requests[0].error_code, LOCAL_SHARING_SETTING_ERROR);
    await capture(page, "sharing-005-failed-retry-1200x800.png");
    evidence.screenshots.push("sharing-005-failed-retry-1200x800.png");
    evidence.facts.failedThenRetried = {
      errorCode: failedSummary.requests[0].error_code,
      retryButtonVisible: true,
      messagesAfterFailure: failedSummary.messages.map((message) => message.role),
    };

    // 解除真实故障后点击界面重试按钮；沿用同一本地分支，不重复用户消息。
    dropTrigger(dataDir, "fail_auto_share");
    await page.locator("#chat-retry").click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
          element.textContent.includes("已经关闭"),
        ),
      null,
      15000,
    );
    let summary = readSummary(dataDir);
    assert.equal(summary.autoShare, "false");
    assert.deepEqual(summary.memories, before.memories);
    assert.deepEqual(summary.relationships, before.relationships);
    assert.deepEqual(summary.stats, before.stats);
    assert.deepEqual(
      summary.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(summary.requests.length, 1);
    assert.equal(summary.requests[0].status, "completed");
    evidence.facts.closedByChat = {
      autoShare: summary.autoShare,
      roles: summary.messages.map((message) => message.role),
      retriedThroughButton: true,
    };
    // 重试成功后的聊天确认必须留有画面，不只截设置页。
    await capture(page, "sharing-005-retry-success-chat-1200x800.png");
    evidence.screenshots.push("sharing-005-retry-success-chat-1200x800.png");

    await closeChat(page);
    const closedPanel = await openMemorySettings(page);
    assert.equal(closedPanel.checked, false);
    assert.equal(closedPanel.stateLabel, "已关闭");
    await capture(page, "sharing-005-chat-closed-settings-1200x800.png");
    evidence.screenshots.push("sharing-005-chat-closed-settings-1200x800.png");

    const firstClose = await closeApp(app);
    evidence.facts.firstClose = firstClose;
    assert.equal(firstClose.closed, true);
    assert.equal(firstClose.exitCode, 0);
    assert.equal(firstClose.signalCode, null);
    app = null;
    await delay(300);

    // 重启后先核对仍为关闭，再执行恢复。
    const second = await launchApp(dataDir);
    app = second.app;
    page = second.page;
    await waitForHome(page);
    const beforeRestore = readSummary(dataDir);
    assert.equal(beforeRestore.autoShare, "false");
    const beforeRestorePanel = await openMemorySettings(page);
    assert.equal(beforeRestorePanel.checked, false);
    assert.equal(beforeRestorePanel.stateLabel, "已关闭");
    evidence.facts.settingsStillClosedAfterRestart = {
      autoShare: beforeRestore.autoShare,
      checked: beforeRestorePanel.checked,
      stateLabel: beforeRestorePanel.stateLabel,
    };
    await capture(page, "sharing-005-restarted-still-closed-settings-1200x800.png");
    evidence.screenshots.push("sharing-005-restarted-still-closed-settings-1200x800.png");

    await page.locator('[data-nav="home"]').click();
    await waitForHome(page);
    await openCurrentChat(page);
    await continueFreshChat(page);
    await sendChat(page, "恢复角色之间的自动分享。", "已经恢复");
    const restored = readSummary(dataDir);
    assert.equal(restored.autoShare, "true");
    assert.deepEqual(restored.memories, before.memories);
    assert.deepEqual(restored.relationships, before.relationships);
    assert.deepEqual(restored.stats, before.stats);
    assert.deepEqual(
      restored.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    evidence.facts.restoredByChat = {
      autoShare: restored.autoShare,
      roles: restored.messages.map((message) => message.role),
      remindersPreserved: true,
    };
    await capture(page, "sharing-005-restored-chat-1200x800.png");
    evidence.screenshots.push("sharing-005-restored-chat-1200x800.png");

    await closeChat(page);
    const restoredPanel = await openMemorySettings(page);
    assert.equal(restoredPanel.checked, true);
    assert.equal(restoredPanel.stateLabel, "已开启");
    await capture(page, "sharing-005-restored-settings-1200x800.png");
    evidence.screenshots.push("sharing-005-restored-settings-1200x800.png");

    evidence.machineVerdict = "PASS";
  } catch (error) {
    failure = error;
    evidence.failure = safeError(error);
  } finally {
    const close = await closeApp(app);
    let removeError = null;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      removeError = safeError(error);
    }
    evidence.cleanup = {
      app: close,
      dataDir,
      tempDirRemoved: !fs.existsSync(dataDir),
      removeError,
    };
    if (!close.closed || close.exitCode !== 0 || evidence.cleanup.tempDirRemoved !== true) {
      evidence.machineVerdict = "FAIL";
      failure = failure ?? new Error("应用或临时目录未完成清理。");
      evidence.failure = safeError(failure);
    }
    writeEvidence("sharing-005.json", evidence);
    if (failure) {
      throw failure;
    }
  }
});
