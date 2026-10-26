/* S03i 自动共享全局开关 GUI Runner：真实 Electron main/preload/renderer/SQLite。
   本切片不调用模型、不访问用户来源：数据库直接构造已接纳状态与假模型元数据，
   全程没有本机或外部 HTTP 服务。由 Codex 在 GUI 环境执行并查看截图。
   覆盖 POL-AUTOSHARE-CONTROL-001/004；002/003 的领域行为见
   tests/acceptance/memory-auto-share.spec.cjs。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
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
const AUTO_SHARE_KEY = "memory_auto_share_enabled";
const sourceFiles = [
  "app/memory.cjs", "app/memory-store.cjs", "app/main.cjs", "app/preload.cjs",
  "app/renderer/index.html", "app/renderer/app.js", "app/renderer/styles.css",
  "tests/acceptance/memory-auto-share-ui.spec.cjs",
];
const requestedBatch = process.env.S03I_AUTOSHARE_UI_BATCH
  ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
let batchDir = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s03i-auto-share-ui",
  requestedBatch,
);
if (fs.existsSync(batchDir)) {
  batchDir = `${batchDir}-${Date.now()}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => String(error?.message ?? error).slice(0, 500);

function sha256File(relativePath) {
  const file = path.join(repoRoot, relativePath);
  return fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : "MISSING";
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-auto-share-ui-"));
}

function openDb(dataDir, readOnly = false) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

/* 直接构造“已接纳并配置过模型”的数据库，使 GUI 不经过连通检查，也就没有网络请求。 */
function seedAcceptedApp(dataDir) {
  const store = createStore(dataDir);
  try {
    store.db.exec(`
      INSERT INTO model_config (id, base_url, model_name, api_key_cipher, updated_at)
      VALUES (1, 'https://example.invalid/v1', 'fixture-auto-share',
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
      sourceId: "seed:s03i-auto-share",
    });
  } finally {
    store.close();
  }
}

function readAutoShareValue(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db.prepare("SELECT value FROM app_state WHERE key = ?").get(AUTO_SHARE_KEY)?.value ?? null;
  } finally {
    db.close();
  }
}

/* 只读取本切片声称不受影响的业务数据，避免把运行时长等无关字段当成差异。 */
function readBusinessSummary(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return {
      memories: db
        .prepare("SELECT character_id, fact_key, body, version FROM memory_entries ORDER BY character_id, fact_key")
        .all(),
      stats: db
        .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
        .all(),
      roster: db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
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

/* 父进程与桌面子进程都按有限时间等待退出，超时才升级信号。 */
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function desktopChildrenOf(parentPid) {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u))
      .filter((match) => match && Number(match[2]) === parentPid && match[3].endsWith("/app/desktop"))
      .map((match) => Number(match[1]));
  } catch {
    return [];
  }
}

async function waitGone(pids, timeoutMs = 3000) {
  const started = Date.now();
  let remaining = pids.filter(pidAlive);
  while (remaining.length > 0 && Date.now() - started < timeoutMs) {
    await delay(100);
    remaining = pids.filter(pidAlive);
  }
  return remaining;
}

async function killPids(pids) {
  let remaining = pids.filter(pidAlive);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (remaining.length === 0) {
      break;
    }
    for (const pid of remaining) {
      try {
        process.kill(pid, signal);
      } catch {
        // 进程可能已退出。
      }
    }
    remaining = await waitGone(remaining, signal === "SIGTERM" ? 3000 : 1000);
  }
  return remaining;
}

async function closeApp(app) {
  if (!app) {
    return { closed: true, error: null, exitCode: null, signalCode: null };
  }
  const proc = app.process();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  let error = null;
  try {
    await Promise.race([
      app.close(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("app.close 超时")), 15000);
        timer.unref?.();
      }),
    ]);
  } catch (closeError) {
    error = safeError(closeError);
  }
  let remaining = exited() ? [] : await waitGone([proc.pid], 5000);
  if (!exited()) {
    remaining = await killPids(remaining);
  }
  if (exited()) {
    remaining = [];
  }
  return {
    closed: error === null && remaining.length === 0,
    error: error ?? (remaining.length > 0 ? "进程仍在运行" : null),
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
  };
}

/* 父进程与桌面子进程都要确认退出；残留时该 Case 不能写 PASS。 */
async function closeWithChildren(app) {
  const desktopPids = app ? desktopChildrenOf(app.process().pid) : [];
  const close = await closeApp(app);
  const desktopStillRunning = await killPids(desktopPids);
  return {
    ...close,
    desktopPids,
    desktopStillRunning,
    closed: close.closed && desktopStillRunning.length === 0,
  };
}

/* 关闭失败或临时目录/桌面子进程残留都必须让 Case 失败，不能仅凭业务断言写 PASS。 */
async function finishCleanup(dataDir, app, evidence, failure) {
  const close = await closeWithChildren(app);
  let removeError = null;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    removeError = safeError(error);
  }
  const tempDirRemoved = !fs.existsSync(dataDir);
  const errors = [];
  if (!close.closed) {
    const reason = close.error
      ?? (close.desktopStillRunning.length > 0
        ? `桌面残留 ${close.desktopStillRunning.join(",")}`
        : "进程仍在运行");
    errors.push(`应用或桌面子进程未确认退出：${reason}`);
  }
  if (!tempDirRemoved) {
    errors.push(`临时目录未删除：${removeError ?? dataDir}`);
  }
  evidence.cleanup = { app: close, tempDirRemoved, removeError, errors };
  evidence.failure = failure ? safeError(failure) : null;
  if (!failure && errors.length > 0) {
    evidence.machineVerdict = "FAIL";
    throw new Error(errors.join(" | "));
  }
}

async function setWindowSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(
        (item) => !item.isDestroyed() && item.webContents.getURL().endsWith("/renderer/index.html"),
      );
      if (!win) {
        throw new Error("找不到正式管理窗。");
      }
      win.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(150);
}

async function openMemorySettings(page) {
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-settings-tab="memory"]').click();
  await page.locator('[data-settings-panel="memory"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const toggle = document.querySelector("#memory-auto-share");
    return Boolean(toggle) && !toggle.disabled && !toggle.indeterminate;
  });
}

async function readMemoryPanelState(page) {
  return page.evaluate(() => {
    const toggle = document.querySelector("#memory-auto-share");
    return {
      checked: toggle.checked,
      stateLabel: document.querySelector("#memory-share-state")?.textContent ?? "",
      status: document.querySelector("#memory-share-status")?.textContent ?? "",
      error: document.querySelector("#memory-share-error")?.hidden === false
        ? document.querySelector("#memory-share-error").textContent
        : "",
      note: document.querySelector("#memory-settings .note")?.textContent ?? "",
    };
  });
}

async function readMemoryPanelGeometry(page) {
  return page.evaluate(() => {
    const measure = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toggle: measure("#memory-auto-share"),
      label: measure("#memory-auto-share + span"),
      note: measure("#memory-settings .note"),
      status: measure("#memory-share-status"),
      documentScrolls: document.scrollingElement.scrollHeight > window.innerHeight,
    };
  });
}

function assertMemoryPanelGeometry(geometry) {
  assert.equal(geometry.documentScrolls, false);
  for (const [name, rect] of Object.entries({
    toggle: geometry.toggle,
    label: geometry.label,
    note: geometry.note,
    status: geometry.status,
  })) {
    assert.ok(rect.top >= 0, `${name} 顶部不可见`);
    assert.ok(rect.bottom <= geometry.viewport.height, `${name} 底部超出视口`);
    assert.ok(rect.left >= 0, `${name} 左侧不可见`);
    assert.ok(rect.right <= geometry.viewport.width, `${name} 右侧超出视口`);
  }
}

async function capture(page, name) {
  fs.mkdirSync(batchDir, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: path.join(batchDir, name) });
}

/* 只在本测试进程内让下一次保存返回失败，随后自动恢复生产 handler。 */
async function failNextAutoShareSave(app, result) {
  await app.evaluate(({ ipcMain }, override) => {
    const original = ipcMain._invokeHandlers?.get("bayper:memory:auto-share:set");
    if (typeof original !== "function") {
      throw new Error("找不到自动分享 IPC handler。");
    }
    ipcMain.removeHandler("bayper:memory:auto-share:set");
    ipcMain.handle("bayper:memory:auto-share:set", (event, enabled) => {
      ipcMain.removeHandler("bayper:memory:auto-share:set");
      ipcMain.handle("bayper:memory:auto-share:set", original);
      return override;
    });
  }, result);
}

function writeEvidence(fileName, evidence) {
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, fileName), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function baseEvidence(caseId) {
  return {
    case: caseId,
    batch: path.relative(repoRoot, batchDir),
    executedAt: new Date().toISOString(),
    localHttp: "无：未启动任何模型或本机 HTTP 服务",
    sourceSha: Object.fromEntries(sourceFiles.map((file) => [file, sha256File(file)])),
    screenshots: [],
    businessError: null,
    machineVerdict: "FAIL",
    semanticReviewStatus: "PENDING_CODEX",
  };
}

test("POL-AUTOSHARE-CONTROL-001 默认开启、关闭写库、重启保持且不删除记忆", { timeout: 180000 }, async () => {
  const evidence = baseEvidence("POL-AUTOSHARE-CONTROL-001");
  const dataDir = makeDataDir();
  let app = null;
  let failure = null;

  try {
    seedAcceptedApp(dataDir);
    const launched = await launchApp(dataDir);
    app = launched.app;
    let page = launched.page;
    await openMemorySettings(page);

    const initial = await readMemoryPanelState(page);
    assert.equal(initial.checked, true);
    assert.equal(initial.stateLabel, "已开启");
    evidence.facts = { defaultEnabled: true };

    const beforeToggle = readBusinessSummary(dataDir);
    await page.locator("#memory-auto-share").uncheck();
    await page.waitForFunction(() =>
      document.querySelector("#memory-share-status")?.textContent?.includes("已关闭"),
    );
    const closed = await readMemoryPanelState(page);
    assert.equal(closed.checked, false);
    assert.equal(closed.stateLabel, "已关闭");
    assert.equal(readAutoShareValue(dataDir), "false");
    // 开关只写 app_state，不删除任何记忆、数值或名单。
    assert.deepEqual(readBusinessSummary(dataDir), beforeToggle);
    evidence.facts.savedValue = readAutoShareValue(dataDir);
    evidence.facts.memoryCount = readBusinessSummary(dataDir).memories.length;
    await capture(page, "auto-share-001-closed-1200x800.png");
    evidence.screenshots.push("auto-share-001-closed-1200x800.png");

    const stopped = await closeWithChildren(app);
    assert.equal(stopped.closed, true, stopped.error ?? "应用或桌面子进程未确认退出");
    app = null;
    const relaunched = await launchApp(dataDir);
    app = relaunched.app;
    page = relaunched.page;
    await openMemorySettings(page);
    const reopened = await readMemoryPanelState(page);
    assert.equal(reopened.checked, false);
    assert.equal(reopened.stateLabel, "已关闭");
    assert.equal(readAutoShareValue(dataDir), "false");
    evidence.facts.reopenedDisabled = true;
    evidence.machineVerdict = "PASS";
  } catch (error) {
    failure = error;
    evidence.businessError = safeError(error);
    throw error;
  } finally {
    try {
      await finishCleanup(dataDir, app, evidence, failure);
    } finally {
      writeEvidence("auto-share-001.json", evidence);
    }
  }
});

test("POL-AUTOSHARE-CONTROL-004 两种窗口尺寸可见、失败回退、拒绝非布尔与非可信请求", { timeout: 180000 }, async () => {
  const evidence = baseEvidence("POL-AUTOSHARE-CONTROL-004");
  const dataDir = makeDataDir();
  let app = null;
  let failure = null;

  try {
    seedAcceptedApp(dataDir);
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;

    await setWindowSize(app, 1200, 800);
    await openMemorySettings(page);
    assertMemoryPanelGeometry(await readMemoryPanelGeometry(page));
    const text = (await readMemoryPanelState(page)).note;
    for (const expected of [
      "仅主题日常或探索的小故事",
      "私聊偏好",
      "Coding Agent",
      "关闭不会删除已分享内容",
      "不会每天安排分享任务",
      "转告",
    ]) {
      assert.ok(text.includes(expected), `说明缺少：${expected}`);
    }
    assert.equal(text.includes("已全面支持"), false);
    // 记忆 → 连接器 → 记忆 的真实往返不能被标签早返回挡住。
    await page.locator('[data-settings-tab="connectors"]').click();
    await page.locator('[data-settings-panel="connectors"]').waitFor({ state: "visible" });
    await page.locator('[data-settings-tab="memory"]').click();
    await page.locator('[data-settings-panel="memory"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const toggle = document.querySelector("#memory-auto-share");
      return Boolean(toggle) && !toggle.disabled && !toggle.indeterminate;
    });
    await capture(page, "auto-share-004-1200x800.png");
    evidence.screenshots.push("auto-share-004-1200x800.png");

    await setWindowSize(app, 960, 680);
    assertMemoryPanelGeometry(await readMemoryPanelGeometry(page));
    await page.locator("#memory-auto-share").uncheck();
    await page.waitForFunction(() =>
      document.querySelector("#memory-share-status")?.textContent?.includes("已关闭"),
    );
    assertMemoryPanelGeometry(await readMemoryPanelGeometry(page));
    assert.equal(readAutoShareValue(dataDir), "false");
    await capture(page, "auto-share-004-960x680.png");
    evidence.screenshots.push("auto-share-004-960x680.png");

    await setWindowSize(app, 1200, 800);
    const invalid = await page.evaluate(() => window.bayperMemory.setMemoryAutoShare("yes"));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "INVALID_INPUT");
    assert.equal(readAutoShareValue(dataDir), "false");

    const untrusted = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handlers = ipcMain._invokeHandlers;
      const getHandler = handlers?.get("bayper:memory:auto-share");
      const setHandler = handlers?.get("bayper:memory:auto-share:set");
      if (typeof getHandler !== "function" || typeof setHandler !== "function") {
        throw new Error("Electron 内部 IPC handler 入口不可用。");
      }
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      return {
        getBadSender: await getHandler({
          sender: {},
          senderFrame: { url: "https://evil.example/" },
        }),
        getBadFrame: await getHandler({
          sender: win.webContents,
          senderFrame: { url: "https://evil.example/" },
        }),
        setBadSender: await setHandler(
          { sender: {}, senderFrame: { url: "https://evil.example/" } },
          true,
        ),
        setBadFrame: await setHandler(
          { sender: win.webContents, senderFrame: { url: "https://evil.example/" } },
          true,
        ),
      };
    });
    for (const result of Object.values(untrusted)) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UNTRUSTED_IPC");
    }
    assert.equal(readAutoShareValue(dataDir), "false");

    // 构造保存失败：界面必须回退到最近一次确认的关闭状态，并给出错误。
    await failNextAutoShareSave(app, {
      ok: false,
      error: { code: "WRITE_FAILED", message: "构造保存失败。" },
    });
    // 保存失败会立即回退到 false，click 不要求最终 checked=true。
    await page.locator("#memory-auto-share").click();
    await page.locator("#memory-share-error").waitFor({ state: "visible" });
    const failed = await readMemoryPanelState(page);
    assert.equal(failed.checked, false);
    assert.equal(failed.stateLabel, "已关闭");
    assert.ok(failed.error.includes("构造保存失败"));
    assert.equal(readAutoShareValue(dataDir), "false");
    await capture(page, "auto-share-004-save-failure-1200x800.png");
    evidence.screenshots.push("auto-share-004-save-failure-1200x800.png");

    // handler 已自动恢复，同一路径可正常保存。
    await page.locator("#memory-auto-share").check();
    await page.waitForFunction(() =>
      document.querySelector("#memory-share-status")?.textContent?.includes("已开启"),
    );
    assert.equal(readAutoShareValue(dataDir), "true");
    evidence.facts = {
      sizes: ["1200x800", "960x680"],
      noteComplete: true,
      settingsRoundTrip: true,
      documentScrolls: false,
      nonBooleanRejected: true,
      untrustedRejected: true,
      saveFailureReverted: true,
      recoveredSave: true,
    };
    evidence.machineVerdict = "PASS";
  } catch (error) {
    failure = error;
    evidence.businessError = safeError(error);
    throw error;
  } finally {
    try {
      await finishCleanup(dataDir, app, evidence, failure);
    } finally {
      writeEvidence("auto-share-004.json", evidence);
    }
  }
});
