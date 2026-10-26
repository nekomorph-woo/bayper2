/* S04d 正式来源设置验收：真实 Electron、SQLite 与临时目录。
   原生选择/确认通过主进程 dialog fixture 注入，只验证 IPC 参数、取消与确认路径；
   不代表实际系统对话框体验。不读取真实 HOME 会话、不调用模型、不碰 .env。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { startModelServer } = require("./fixture-server.cjs");
const { createLegacyDatabase, dbPath, localDay } = require("./s02-fixtures.cjs");
const { createStore } = require("../../app/store.cjs");
const { createExternalSources } = require("../../app/external-sources.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const EVIDENCE_ROOT = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s04d-source-settings",
);
const batchStamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
const BATCH_ID = `${batchStamp}-${Math.random().toString(16).slice(2, 8)}`;
const EVIDENCE_DIR = path.join(EVIDENCE_ROOT, `run-${BATCH_ID}`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "batch.log"),
  [
    `batch: ${BATCH_ID}`,
    `created: ${new Date().toISOString()}`,
    `source: tests/acceptance/source-settings.spec.cjs`,
    `evidence: ${EVIDENCE_DIR}`,
    "note: 历史根目录证据保留；本批仅写本次 Runner 截图、Case 日志与 cleanup。",
    `missing: 返修前 source-default-960x680.png 已被覆盖且不可重造；文字依据见 ${path.join(
      EVIDENCE_ROOT,
      "layout-failure-before-repair.log",
    )}。`,
    "missing: 历史失败原始 Case 日志已被成功运行覆盖；本批只保留带来源说明的转录摘录。",
    "",
  ].join("\n"),
);
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "historical-failure-excerpt.log"),
  [
    "# 历史失败摘录（非本批运行）",
    "source: 本次 Claude 任务工具输出中的失败日志文本（2026-10-26），原始 Case 日志随后被成功运行覆盖。",
    "observed: POL-SOURCE-UI-003 三段有界循环的第三次用时 90003ms，失败原文包含：",
    "  locator.click: Timeout 30000ms exceeded.",
    "  waiting for locator('[data-nav=\"home\"]')",
    "  at openHome (tests/acceptance/source-settings.spec.cjs)",
    "  cleanup: ok",
    "note: 这是转录摘录，不是原始文件；不重造丢失的旧布局截图。",
    "missing: 旧布局 source-default-960x680.png 无可用副本；文字依据见根目录 layout-failure-before-repair.log。",
    "",
  ].join("\n"),
);
const SENTINEL = "SOURCE-SESSION-BODY-MUST-NOT-LEAK";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function makeHomeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-home-"));
  const claudeRoot = path.join(home, ".claude", "projects");
  const codexRoot = path.join(home, ".codex", "sessions");
  const codexDay = path.join(codexRoot, "2026", "10", "26");
  const otherAgent = path.join(home, "other-agent");
  const customClaude = path.join(home, "custom", "claude-sessions");
  const customCodex = path.join(home, "custom", "codex-sessions");
  for (const directory of [claudeRoot, codexDay, otherAgent, customClaude, customCodex]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const files = {
    claude: path.join(claudeRoot, "session.jsonl"),
    codex: path.join(codexDay, "rollout-fixture.jsonl"),
    other: path.join(otherAgent, "secret.jsonl"),
    customClaude: path.join(customClaude, "custom-claude.jsonl"),
    customCodex: path.join(customCodex, "custom-codex.jsonl"),
  };
  for (const file of Object.values(files)) {
    fs.writeFileSync(file, `${SENTINEL}\n`);
  }
  return {
    home,
    claudeRoot,
    codexRoot,
    codexDay,
    otherAgent,
    customClaude,
    customCodex,
    files,
    before: snapshotFiles(files),
  };
}

function snapshotFiles(files) {
  return Object.fromEntries(
    Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, "utf8")]),
  );
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-data-"));
}

async function makeContext() {
  const dataDir = makeDataDir();
  const homeFixture = makeHomeFixture();
  const server = await startModelServer();
  createLegacyDatabase(dataDir, {
    characters: [{ id: "rin", acceptedAt: "2026-10-01T00:00:00.000Z" }],
    modelCipher: Buffer.from([4, 3, 2, 1]),
    baseUrl: server.baseUrl,
    modelName: "fixture-source",
    fixedId: "rin",
    currentId: "rin",
    rosterDay: localDay(new Date()),
  });
  const seeded = createStore(dataDir);
  try {
    seeded.memory.remember({
      characterId: "rin",
      factKey: "pref.source.keep",
      body: "来源设置前已经存在的记忆",
      kind: "preference",
      sourceId: "seed:s04d",
    });
  } finally {
    seeded.close();
  }
  return { dataDir, server, ...homeFixture };
}

async function launchApp(ctx, trace) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${ctx.dataDir}`],
    env: {
      ...process.env,
      HOME: ctx.home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
    },
  });
  const logs = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const page = await app.firstWindow();
  page.on("console", (message) => trace.consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => trace.consoleLines.push(`[pageerror] ${error?.stack || error}`));
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  return { app, page, logs };
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

async function closeApp(app, timeout = 10000) {
  if (!app) {
    return;
  }
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
    try {
      processHandle?.kill("SIGKILL");
    } catch {
      // 应用已退出或无法终止时仍报告实际退出失败。
    }
    throw new Error(`应用未在 ${timeout}ms 内退出（实际 app 退出失败，非 dialog fixture）`);
  }
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    let alive = true;
    try {
      process.kill(processHandle.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        processHandle.kill("SIGKILL");
      } catch {
        // 仍按实际退出失败处理。
      }
      throw new Error("app.close 返回但应用进程仍存活（实际 app 退出失败）");
    }
  }
}

async function closeServer(server, timeout = 5000) {
  if (!server) {
    return;
  }
  let timedOut = false;
  let timer;
  try {
    await Promise.race([
      server.close().catch(() => {}),
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
    throw new Error(`fixture HTTP server 未在 ${timeout}ms 内关闭`);
  }
}

async function setOuterSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(220);
}

async function waitForSourceLoaded(page) {
  await page.waitForFunction(
    () => {
      const summary = document.querySelector("#source-summary");
      const status = document.querySelector("#source-status");
      return (
        Boolean(summary?.textContent) &&
        !status?.textContent?.includes("正在读取") &&
        document.querySelectorAll("#source-list .source-row").length > 0
      );
    },
    null,
    { timeout: 15000 },
  );
}

async function openSettings(page) {
  await page.bringToFront().catch(() => {});
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-page="settings"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-settings-tab="sources"]').click();
  await page.locator('[data-settings-panel="sources"]').waitFor({ state: "visible", timeout: 10000 });
  await waitForSourceLoaded(page);
}

async function openSettingsTab(page, tab) {
  await page.locator(`[data-settings-tab="${tab}"]`).click();
  await page.locator(`[data-settings-panel="${tab}"]`).waitFor({ state: "visible", timeout: 10000 });
  if (tab === "sources") {
    await waitForSourceLoaded(page);
  }
}

async function openHome(page) {
  try {
    await page.bringToFront().catch(() => {});
    await page.locator('[data-nav="home"]').click();
    await page.locator('[data-page="home"]').waitFor({ state: "visible", timeout: 10000 });
  } catch (error) {
    try {
      const diag = await withTimeout(
        page.evaluate(() => {
          const nav = document.querySelector("#primary-nav");
          const button = document.querySelector('[data-nav="home"]');
          const box = button?.getBoundingClientRect() ?? null;
          const hit = box
            ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            : null;
          return {
            visibility: document.visibilityState,
            hasFocus: document.hasFocus(),
            navHidden: nav?.hidden ?? null,
            activePage: document.body.dataset.activePage ?? null,
            navBox: box
              ? { x: box.x, y: box.y, width: box.width, height: box.height }
              : null,
            hitTag: hit?.tagName ?? null,
            hitId: hit?.id ?? null,
            hitClass: hit?.className ?? null,
            activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
            dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(
              (item) => item.id || item.className,
            ),
          };
        }),
        3000,
        "页面诊断超时",
      );
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "source-003-openhome-diagnostic.json"),
        JSON.stringify(diag, null, 2),
      );
    } catch (diagError) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "source-003-openhome-diagnostic.json"),
        JSON.stringify({ diagnosticError: String(diagError) }),
      );
    }
    throw error;
  }
}

function providerRow(page, provider) {
  return page.locator(`#source-list .source-row[data-provider="${provider}"]`);
}

async function sourceState(page) {
  const result = await page.evaluate(() => window.bayperSources.getState());
  assert.equal(result.ok, true);
  return result.state;
}

function readSourceDb(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const state = (key) =>
      db.prepare("SELECT value FROM external_source_state WHERE key = ?").get(key)?.value ?? null;
    return {
      enabled: state("analysis_enabled") ?? "0",
      revision: Number(state("permission_revision") ?? 0),
      grants: db
        .prepare(`
          SELECT id, provider, display_path, canonical_path, root_identity, revision, status
          FROM external_source_grants
          ORDER BY created_at, id
        `)
        .all(),
      memories: db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count,
      memoryBodies: db
        .prepare("SELECT body FROM memory_entries ORDER BY id")
        .all()
        .map((row) => row.body),
    };
  } finally {
    db.close();
  }
}

function openWriteDb(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir));
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

async function installDialogFixture(app) {
  await app.evaluate(({ dialog }) => {
    const state = {
      openCalls: [],
      confirmCalls: [],
      openQueue: [],
      confirmQueue: [],
      deferred: null,
      openDeferred: null,
      restore: null,
    };
    const originalOpen = dialog.showOpenDialog;
    const originalMessage = dialog.showMessageBox;
    state.restore = () => {
      dialog.showOpenDialog = originalOpen;
      dialog.showMessageBox = originalMessage;
    };
    globalThis.__sourceDialogState = state;
    dialog.showOpenDialog = async (_window, options) => {
      state.openCalls.push(options);
      const next = state.openQueue.shift();
      if (next?.deferred) {
        return new Promise((resolve) => {
          state.openDeferred = resolve;
        });
      }
      return next ?? { canceled: true, filePaths: [] };
    };
    dialog.showMessageBox = async (_window, options) => {
      state.confirmCalls.push(options);
      const next = state.confirmQueue.shift();
      if (next?.deferred) {
        return new Promise((resolve) => {
          state.deferred = resolve;
        });
      }
      return { response: next?.response ?? 0, checkboxChecked: false };
    };
  });
}

async function resetDialogFixture(app) {
  if (!app) {
    return { ok: true };
  }
  const processHandle = app.process?.();
  if (processHandle && (processHandle.exitCode !== null || processHandle.signalCode !== null)) {
    // 应用已退出时 fixture 随之消失，不存在需要清理的主进程 dialog。
    return { ok: true };
  }
  try {
    await withTimeout(
      app.evaluate(() => {
        const state = globalThis.__sourceDialogState;
        if (!state) {
          return;
        }
        if (state.openDeferred) {
          const resolve = state.openDeferred;
          state.openDeferred = null;
          resolve({ canceled: true, filePaths: [] });
        }
        if (state.deferred) {
          const resolve = state.deferred;
          state.deferred = null;
          resolve({ response: 0, checkboxChecked: false });
        }
        state.openQueue.length = 0;
        state.confirmQueue.length = 0;
        if (typeof state.restore === "function") {
          state.restore();
        }
      }),
      3000,
      "dialog fixture 清理超时",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function queueDialogs(app, { open = [], confirm = [] } = {}) {
  await app.evaluate(
    (_electron, payload) => {
      const state = globalThis.__sourceDialogState;
      state.openQueue.push(...payload.open);
      state.confirmQueue.push(...payload.confirm);
    },
    { open, confirm },
  );
}

async function readDialogs(app) {
  return app.evaluate(() => globalThis.__sourceDialogState);
}

async function waitForDeferred(app) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const ready = await app.evaluate(() =>
      Boolean(globalThis.__sourceDialogState?.deferred),
    );
    if (ready) {
      return;
    }
    await delay(50);
  }
  assert.fail("等待原生确认 dialog fixture 超时");
}

async function resolveDeferred(app, response) {
  await app.evaluate(
    (_electron, value) => {
      const state = globalThis.__sourceDialogState;
      const resolve = state.deferred;
      state.deferred = null;
      resolve({ response: value, checkboxChecked: false });
    },
    response,
  );
}

async function waitForOpenDeferred(app) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const ready = await app.evaluate(() =>
      Boolean(globalThis.__sourceDialogState?.openDeferred),
    );
    if (ready) {
      return;
    }
    await delay(50);
  }
  assert.fail("等待原生目录选择 dialog fixture 超时");
}

async function resolveOpenDeferred(app, result) {
  await app.evaluate(
    (_electron, value) => {
      const state = globalThis.__sourceDialogState;
      const resolve = state.openDeferred;
      state.openDeferred = null;
      resolve(value);
    },
    result,
  );
}

async function hideManagementWindow(app) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())?.close();
  });
  await waitUntil(
    () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
        return Boolean(window) && !window.isVisible();
      }),
    5000,
    "管理窗未在预期时间关闭",
  );
}

async function showManagementWindow(app) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())?.show();
  });
  await waitUntil(
    () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
        return Boolean(window) && window.isVisible();
      }),
    5000,
    "管理窗未在预期时间恢复",
  );
}

async function quitAppAndWait(app, { resolveConfirm = false, timeout = 10000 } = {}) {
  const processHandle = app.process?.();
  await app
    .evaluate(
      ({ app: electronApp }, shouldResolveConfirm) => {
        electronApp.quit();
        if (shouldResolveConfirm) {
          const state = globalThis.__sourceDialogState;
          const resolve = state?.deferred;
          if (resolve) {
            state.deferred = null;
            resolve({ response: 1, checkboxChecked: false });
          }
        }
        return true;
      },
      resolveConfirm,
    )
    .catch(() => {});
  await withTimeout(
    new Promise((resolve) => {
      if (
        !processHandle ||
        processHandle.exitCode !== null ||
        processHandle.signalCode !== null
      ) {
        resolve();
        return;
      }
      processHandle.once("exit", resolve);
      if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
        resolve();
      }
    }),
    timeout,
    "应用退出超时（实际 app 退出失败）",
  );
}

async function waitUntil(predicate, timeout, message) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }
  assert.fail(message);
}

async function waitSourceStatus(page, expected, timeout = 12000) {
  await page.waitForFunction(
    (text) => document.querySelector("#source-status")?.textContent?.includes(text),
    expected,
    { timeout },
  );
}

async function waitSummary(page, expected, timeout = 12000) {
  await page.waitForFunction(
    (text) => document.querySelector("#source-summary")?.textContent?.includes(text),
    expected,
    { timeout },
  );
}

async function assertNoDocumentScroll(page, label) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
  }));
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${label} 不应横向整页滚动`);
  assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1, `${label} 不应纵向整页滚动`);
  assert.ok(metrics.bodyScrollWidth <= metrics.clientWidth + 1, `${label} body 不应横向溢出`);
  assert.ok(metrics.bodyScrollHeight <= metrics.clientHeight + 1, `${label} body 不应纵向溢出`);
}

async function assertSettingsSingleScreen(page, label) {
  await assertNoDocumentScroll(page, label);
  const metrics = await page.evaluate(() => {
    const settingsPage = document.querySelector('[data-page="settings"]');
    const panels = document.querySelector(".settings-panels");
    const sourceScroll = document.querySelector(".source-scroll");
    return {
      pageClientHeight: settingsPage.clientHeight,
      pageScrollHeight: settingsPage.scrollHeight,
      pageOverflowY: getComputedStyle(settingsPage).overflowY,
      panelsClientHeight: panels.clientHeight,
      panelsScrollHeight: panels.scrollHeight,
      sourceOverflowY: sourceScroll ? getComputedStyle(sourceScroll).overflowY : "",
    };
  });
  assert.equal(metrics.pageOverflowY, "hidden", `${label} 设置页不得整体滚动`);
  assert.ok(
    metrics.pageScrollHeight <= metrics.pageClientHeight + 1,
    `${label} 设置页不应有整体滚动高度：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.panelsScrollHeight <= metrics.panelsClientHeight + 1,
    `${label} 设置面板不应溢出：${JSON.stringify(metrics)}`,
  );
  if (metrics.sourceOverflowY) {
    assert.equal(metrics.sourceOverflowY, "auto", "只有来源目录列表允许局部滚动");
  }
}

async function assertInViewportNow(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} 应有可点击尺寸`);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  assert.ok(box.x >= 0 && box.y >= 0, `${selector} 不应位于窗口外`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${selector} 不应横向被裁切`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${selector} 不应纵向被裁切`);
}

async function assertSettingsTabsFirstScreen(page, label) {
  await openSettingsTab(page, "model");
  await assertSettingsSingleScreen(page, `模型 ${label}`);
  await assertInViewportNow(page, "#settings-model-name");
  await assertInViewportNow(page, "#check-model");
  await capture(page, `settings-model-${label}.png`);

  await openSettingsTab(page, "desktop");
  await assertSettingsSingleScreen(page, `桌面 ${label}`);
  await assertInViewportNow(page, "#desktop-status");
  await capture(page, `settings-desktop-${label}.png`);

  await openSettingsTab(page, "sources");
  await assertSettingsSingleScreen(page, `会话来源 ${label}`);
  await assertInViewportNow(page, "#source-analysis-enabled");
  await assertInViewportNow(page, "#source-summary");
  await assertInViewportNow(page, "#source-status");
  await assertInViewportNow(page, ".source-scroll");
  await capture(page, `settings-sources-${label}.png`);
}

async function capture(page, name) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

async function captureFailure(page, name) {
  if (!page) {
    return;
  }
  try {
    await withTimeout(capture(page, `${name}-failure.png`), 5000, "失败截图超时");
  } catch {
    // 失败现场截图不是主证据；页面失去响应时不得阻塞退出。
  }
}

function writeLog(name, launched, failure, cleanupErrors = [], appExit = null) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.log`),
    [
      `# ${name}`,
      `batch: ${BATCH_ID}`,
      `evidence: ${EVIDENCE_DIR}`,
      `time: ${new Date().toISOString()}`,
      `failure: ${failure ? failure.stack || failure.message || String(failure) : "none"}`,
      `cleanup: ${cleanupErrors.length === 0 ? "ok" : "failed"}`,
      `appExit: ${JSON.stringify(appExit)}`,
      ...cleanupErrors.map(
        (error, index) => `  cleanup-${index + 1}: ${error?.stack || error?.message || error}`,
      ),
      "",
      "## renderer console",
      ...(launched?.trace?.consoleLines ?? []),
      "",
      "## application stdout/stderr",
      ...(launched?.logs ?? []),
      "",
      "## boundary",
      "native dialog fixture injected in main process; it checks IPC parameters/cancel/confirm",
      "but is not evidence of the real macOS dialog experience.",
      "",
    ].join("\n"),
  );
}

async function cleanupResources({
  testName,
  launched,
  ctx,
  failure,
  trace,
  cleanupErrors = [],
}) {
  const errors = [...cleanupErrors];
  const processHandle = launched?.app?.process?.();
  let appExit = {
    status: launched?.app ? "not-closed" : "no-app",
    code: processHandle?.exitCode ?? null,
    signal: processHandle?.signalCode ?? null,
  };
  const reset = await resetDialogFixture(launched?.app);
  if (!reset.ok) {
    errors.push(
      reset.error instanceof Error ? reset.error : new Error(`dialog fixture 清理失败：${reset.error}`),
    );
  }
  try {
    await closeApp(launched?.app);
    appExit = {
      status: "exited",
      code: processHandle?.exitCode ?? null,
      signal: processHandle?.signalCode ?? null,
    };
  } catch (error) {
    appExit = {
      status: "failed",
      code: processHandle?.exitCode ?? null,
      signal: processHandle?.signalCode ?? null,
    };
    errors.push(error);
  }
  try {
    await closeServer(ctx.server);
  } catch (error) {
    errors.push(error);
  }
  try {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    fs.rmSync(ctx.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    errors.push(error);
  }
  const cleanupOk = errors.length === 0;
  fs.appendFileSync(
    path.join(EVIDENCE_DIR, "cleanup.log"),
    [
      `${new Date().toISOString()} batch=${BATCH_ID} case=${testName} appExit=${JSON.stringify(appExit)} cleanup=${cleanupOk ? "ok" : "failed"} errors=${errors.length}`,
      ...errors.map((error, index) => `  error-${index + 1}: ${error?.message || error}`),
      "",
    ].join("\n"),
  );
  writeLog(testName, launched ? { logs: launched.logs, trace } : { trace }, failure, errors, appExit);
  if (!failure && errors.length > 0) {
    throw errors[0];
  }
}

function assertConfirmDetail(call, label, directory) {
  assert.equal(call.type, "warning");
  assert.deepEqual(call.buttons, ["取消", "允许分析此目录"]);
  assert.equal(call.defaultId, 0);
  assert.equal(call.cancelId, 0);
  assert.match(call.message, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(call.message, /Bayper/);
  assert.match(call.message, /指定的/);
  assert.ok(call.detail.includes(`来源：${label}`));
  assert.ok(call.detail.includes("执行主体：Bayper"));
  assert.ok(call.detail.includes(`目录：${directory}`));
  assert.ok(
    call.detail.includes(
      "分析会话中用户表达的内容，可能发送必要片段到你配置的模型；不会把原目录作为记忆存储。",
    ),
  );
}

function assertNoFixtureLeak(state, uiText) {
  const serialized = JSON.stringify(state);
  for (const forbidden of [SENTINEL, "other-agent", "secret.jsonl"]) {
    assert.equal(serialized.includes(forbidden), false, `来源状态不得包含 ${forbidden}`);
    assert.equal(uiText.includes(forbidden), false, `来源 UI 不得包含 ${forbidden}`);
  }
}

function assertFilesUnchanged(ctx) {
  const after = snapshotFiles(ctx.files);
  assert.deepEqual(after, ctx.before, "来源设置不得修改任何夹具会话文件");
}

test("POL-SOURCE-UI-001 默认关闭、发现两支持来源且开关不授权", { timeout: 60000 }, async () => {
  const ctx = await makeContext();
  const trace = { consoleLines: [] };
  let launched = null;
  let failure = null;
  try {
    launched = await launchApp(ctx, trace);
    const { app, page } = launched;
    await openSettings(page);

    const state = await sourceState(page);
    assert.equal(state.enabled, false);
    assert.deepEqual(
      state.candidates.map((candidate) => candidate.provider),
      ["claude-code", "codex"],
    );
    const claude = state.candidates.find((candidate) => candidate.provider === "claude-code");
    const codex = state.candidates.find((candidate) => candidate.provider === "codex");
    assert.equal(claude.displayPath, ctx.claudeRoot);
    assert.equal(codex.displayPath, ctx.codexRoot);
    assert.equal(claude.available, true);
    assert.equal(codex.available, true);
    assert.equal(claude.grant, null);
    assert.equal(codex.grant, null);
    assert.deepEqual(state.customGrants, []);

    const uiText = await page.locator("#source-settings").innerText();
    assertNoFixtureLeak(state, uiText);
    assert.equal(await page.locator("#source-list .source-row").count(), 2);
    assert.equal(await page.locator("#source-analysis-enabled").isChecked(), false);
    assert.match(await page.locator("#source-summary").textContent(), /分析已关闭/);
    assert.equal(uiText.includes("已分析"), false);
    assert.equal(uiText.includes("已形成记忆"), false);

    const db = readSourceDb(ctx.dataDir);
    assert.equal(db.enabled, "0");
    assert.equal(db.grants.length, 0);
    assert.equal(db.memories, 1);
    assert.deepEqual(db.memoryBodies, ["来源设置前已经存在的记忆"]);
    assert.equal(ctx.server.requests.length, 0, "发现与开关不得发起模型请求");
    assertFilesUnchanged(ctx);

    for (const size of [
      { width: 1200, height: 800, label: "1200x800" },
      { width: 960, height: 680, label: "960x680" },
    ]) {
      await setOuterSize(app, size.width, size.height);
      await assertSettingsTabsFirstScreen(page, size.label);
      await capture(page, `source-default-${size.label}.png`);
    }

    await setOuterSize(app, 1200, 800);
    await page.locator("#source-analysis-enabled").check();
    await waitSummary(page, "分析已开启");
    const enabled = await sourceState(page);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.candidates.every((candidate) => candidate.grant === null), true);
    const enabledDb = readSourceDb(ctx.dataDir);
    assert.equal(enabledDb.enabled, "1");
    assert.equal(enabledDb.grants.length, 0, "打开开关不得自动授权目录");
    assert.equal(enabledDb.memories, 1);
    assert.deepEqual(enabledDb.memoryBodies, ["来源设置前已经存在的记忆"]);
    assert.equal(ctx.server.requests.length, 0, "打开开关不得发起模型请求");
    const enabledText = await page.locator("#source-settings").innerText();
    assert.equal(enabledText.includes("已分析"), false);
    assertFilesUnchanged(ctx);

    for (const size of [
      { width: 1200, height: 800, label: "1200x800" },
      { width: 960, height: 680, label: "960x680" },
    ]) {
      await setOuterSize(app, size.width, size.height);
      await assertSettingsSingleScreen(page, `已开启来源 ${size.label}`);
      await assertInViewportNow(page, "#source-analysis-enabled");
      await assertInViewportNow(page, "#source-summary");
      await capture(page, `source-enabled-${size.label}.png`);
    }
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "source-ui-001");
    throw error;
  } finally {
    await cleanupResources({
      testName: "source-settings-001",
      launched,
      ctx,
      failure,
      trace,
    });
  }
});

test("POL-SOURCE-UI-002 原生取消/确认、持久化、撤销与其他授权隔离", { timeout: 90000 }, async () => {
  const ctx = await makeContext();
  const trace = { consoleLines: [] };
  let launched = null;
  let permissionDb = null;
  let failure = null;
  try {
    launched = await launchApp(ctx, trace);
    let { app, page } = launched;
    await openSettings(page);
    await installDialogFixture(app);

    // 默认候选：取消不写授权，确认后才写。
    await queueDialogs(app, { confirm: [{ response: 0 }] });
    await providerRow(page, "claude-code")
      .locator('button[data-source-action="authorize"]')
      .click();
    await waitSourceStatus(page, "已取消");
    let db = readSourceDb(ctx.dataDir);
    assert.equal(db.grants.length, 0, "取消不得写入授权");
    let dialogs = await readDialogs(app);
    assert.equal(dialogs.openCalls.length, 0, "默认候选不需要文件选择器");
    assert.equal(dialogs.confirmCalls.length, 1);
    assertConfirmDetail(dialogs.confirmCalls[0], "Claude Code", ctx.claudeRoot);
    assert.equal(db.enabled, "0");

    await queueDialogs(app, { confirm: [{ response: 1 }] });
    await providerRow(page, "claude-code")
      .locator('button[data-source-action="authorize"]')
      .click();
    await waitSourceStatus(page, "已授权此目录");
    db = readSourceDb(ctx.dataDir);
    assert.equal(db.grants.length, 1);
    assert.equal(db.grants[0].provider, "claude-code");
    assert.equal(db.grants[0].display_path, ctx.claudeRoot);
    assert.equal(db.grants[0].status, "active");
    assert.equal(db.enabled, "0", "授权目录不得偷偷打开分析开关");
    let state = await sourceState(page);
    assert.equal(state.enabled, false);
    assert.equal(state.candidates.find((item) => item.provider === "claude-code").grant.valid, true);
    assert.match(await page.locator("#source-summary").textContent(), /分析已关闭/);
    await assertSettingsSingleScreen(page, "已授权来源 1200x800");
    await assertInViewportNow(page, "#source-analysis-enabled");
    await capture(page, "source-granted-1200x800.png");

    // 自选目录：选择器取消、确认取消、确认授权三条路径。
    await queueDialogs(app, { open: [{ canceled: true, filePaths: [] }] });
    await providerRow(page, "codex")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitSourceStatus(page, "已取消");
    db = readSourceDb(ctx.dataDir);
    assert.equal(db.grants.length, 1);
    dialogs = await readDialogs(app);
    assert.equal(dialogs.openCalls.length, 1);
    assert.ok(dialogs.openCalls[0].properties.includes("openDirectory"));
    assert.ok(dialogs.openCalls[0].title.includes("Codex"));
    assert.equal(dialogs.confirmCalls.length, 2, "选择器取消不得进入确认框");

    await queueDialogs(app, {
      open: [{ canceled: false, filePaths: [ctx.customCodex] }],
      confirm: [{ response: 0 }],
    });
    await providerRow(page, "codex")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitSourceStatus(page, "已取消");
    dialogs = await readDialogs(app);
    assert.equal(dialogs.openCalls.length, 2);
    assert.equal(dialogs.confirmCalls.length, 3);
    assertConfirmDetail(dialogs.confirmCalls[2], "Codex", ctx.customCodex);
    assert.equal(readSourceDb(ctx.dataDir).grants.length, 1);

    await queueDialogs(app, {
      open: [{ canceled: false, filePaths: [ctx.customCodex] }],
      confirm: [{ response: 1 }],
    });
    await providerRow(page, "codex")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitSourceStatus(page, "已授权所选目录");
    db = readSourceDb(ctx.dataDir);
    assert.equal(db.grants.length, 2);
    const codexGrant = db.grants.find((grant) => grant.provider === "codex");
    assert.equal(codexGrant.display_path, ctx.customCodex);
    assert.equal(codexGrant.status, "active");
    assert.equal(db.enabled, "0", "自选目录授权不得打开分析开关");
    state = await sourceState(page);
    assert.equal(
      state.customGrants.find((grant) => grant.provider === "codex").valid,
      true,
      "自选目录应出现在其他已授权目录",
    );
    await setOuterSize(app, 960, 680);
    await assertSettingsSingleScreen(page, "自选授权 960x680");
    await page.locator(".source-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await capture(page, "source-custom-granted-960x680.png");

    // 重启保留两条授权与关闭状态。
    await closeApp(app);
    launched = null;
    launched = await launchApp(ctx, trace);
    ({ app, page } = launched);
    await openSettings(page);
    state = await sourceState(page);
    assert.equal(state.enabled, false);
    const validCandidateGrants = state.candidates.filter(
      (candidate) => candidate.grant?.valid,
    ).length;
    const validCustomGrants = state.customGrants.filter((grant) => grant.valid).length;
    assert.equal(validCandidateGrants + validCustomGrants, 2);
    db = readSourceDb(ctx.dataDir);
    assert.equal(db.grants.filter((grant) => grant.status === "active").length, 2);

    // 真实开启分析后，关闭应用，另开真实 SQLite 服务签发旧许可。
    await page.locator("#source-analysis-enabled").check();
    await waitSummary(page, "分析已开启");
    assert.equal(readSourceDb(ctx.dataDir).enabled, "1");
    await closeApp(app);
    launched = null;

    permissionDb = new DatabaseSync(dbPath(ctx.dataDir));
    const permissions = createExternalSources({ db: permissionDb });
    assert.equal(permissions.isEnabled(), true);
    const claudeGrant = permissions
      .listGrants()
      .find((grant) => grant.provider === "claude-code" && grant.active);
    assert.ok(claudeGrant);
    const oldPermit = permissions.issueReadPermit(claudeGrant.id);

    launched = await launchApp(ctx, trace);
    ({ app, page } = launched);
    await openSettings(page);
    assert.equal((await sourceState(page)).enabled, true);
    const revisionBefore = readSourceDb(ctx.dataDir).revision;
    await providerRow(page, "claude-code")
      .locator('button[data-source-action="revoke"]')
      .click();
    await waitSourceStatus(page, "已撤销授权");
    db = readSourceDb(ctx.dataDir);
    const claudeRow = db.grants.find((grant) => grant.id === claudeGrant.id);
    assert.equal(claudeRow.status, "revoked");
    assert.ok(db.revision > revisionBefore, "撤销必须提升权限修订");
    assert.equal(
      db.grants.find((grant) => grant.provider === "codex").status,
      "active",
      "撤销一个目录不得影响其他授权",
    );
    assert.throws(
      () => permissions.validateReadPermit(oldPermit),
      (error) => error?.code === "PERMIT_REVOKED",
      "撤销后 reader 旧许可必须失效",
    );
    const afterRevoke = readSourceDb(ctx.dataDir);
    assert.equal(afterRevoke.memories, 1);
    assert.deepEqual(afterRevoke.memoryBodies, ["来源设置前已经存在的记忆"]);
    assertFilesUnchanged(ctx);
    assert.equal(ctx.server.requests.length, 0);
    const claudeRowUi = await providerRow(page, "claude-code").innerText();
    assert.match(claudeRowUi, /目录可用 · 未授权/);
    assert.equal(claudeRowUi.includes("已授权"), false);

    // 撤销与其余授权在再次重启后仍保持。
    await closeApp(app);
    launched = null;
    launched = await launchApp(ctx, trace);
    ({ app, page } = launched);
    await openSettings(page);
    state = await sourceState(page);
    assert.equal(state.enabled, true);
    assert.equal(state.candidates.find((item) => item.provider === "claude-code").grant, null);
    assert.equal(
      state.customGrants.find((item) => item.provider === "codex").valid,
      true,
      "自选 Codex 授权应在重启后保留",
    );
    assert.equal(readSourceDb(ctx.dataDir).grants.find((g) => g.id === claudeGrant.id).status, "revoked");
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "source-ui-002");
    throw error;
  } finally {
    const cleanupErrors = [];
    if (permissionDb) {
      try {
        permissionDb.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      permissionDb = null;
    }
    await cleanupResources({
      testName: "source-settings-002",
      launched,
      ctx,
      failure,
      trace,
      cleanupErrors,
    });
  }
});

test("POL-SOURCE-UI-003 失效目录、保存故障、迟到确认与不可信 IPC", { timeout: 90000 }, async () => {
  const ctx = await makeContext();
  const trace = { consoleLines: [] };
  let launched = null;
  let failure = null;
  try {
    launched = await launchApp(ctx, trace);
    const { app, page } = launched;
    await openSettings(page);
    await installDialogFixture(app);

    await queueDialogs(app, { confirm: [{ response: 1 }] });
    await providerRow(page, "claude-code")
      .locator('button[data-source-action="authorize"]')
      .click();
    await waitSourceStatus(page, "已授权此目录");
    assert.equal(readSourceDb(ctx.dataDir).grants.length, 1);

    // 目录消失：授权记录仍在，但不能继续显示为可用/已授权。
    fs.renameSync(ctx.claudeRoot, `${ctx.claudeRoot}-old`);
    await openHome(page);
    await openSettings(page);
    let state = await sourceState(page);
    let claude = state.candidates.find((item) => item.provider === "claude-code");
    assert.equal(claude.available, false);
    assert.equal(claude.reason, "NOT_FOUND");
    assert.equal(claude.grant.active, true);
    assert.equal(claude.grant.valid, false);
    assert.equal(claude.grant.reason, "PATH_UNAVAILABLE");
    assert.match(await providerRow(page, "claude-code").innerText(), /授权已失效/);
    assert.equal((await providerRow(page, "claude-code").innerText()).includes("已授权"), false);
    assert.equal(readSourceDb(ctx.dataDir).grants[0].status, "active");

    // 同一路径换成新目录：身份变化，不自动改指、不自动重授权。
    fs.mkdirSync(ctx.claudeRoot);
    await openHome(page);
    await openSettings(page);
    state = await sourceState(page);
    claude = state.candidates.find((item) => item.provider === "claude-code");
    assert.equal(claude.available, true);
    assert.equal(claude.grant.valid, false);
    assert.equal(claude.grant.reason, "GRANT_PATH_CHANGED");
    assert.match(await providerRow(page, "claude-code").innerText(), /授权已失效/);
    assert.equal(readSourceDb(ctx.dataDir).grants.length, 1, "不得自动新增指向新目录的授权");
    await setOuterSize(app, 1200, 800);
    await assertSettingsSingleScreen(page, "失效来源 1200x800");
    await assertInViewportNow(page, "#source-analysis-enabled");
    await capture(page, "source-invalid-1200x800.png");
    await setOuterSize(app, 960, 680);
    await assertSettingsSingleScreen(page, "失效来源 960x680");
    await assertInViewportNow(page, "#source-analysis-enabled");
    await capture(page, "source-invalid-960x680.png");

    // 父目录不可访问：realpath/stat 失败，不能显示为可用授权。
    fs.chmodSync(path.join(ctx.home, ".claude"), 0o000);
    await openHome(page);
    await openSettings(page);
    state = await sourceState(page);
    claude = state.candidates.find((item) => item.provider === "claude-code");
    assert.equal(claude.available, false);
    assert.equal(claude.reason, "INACCESSIBLE");
    assert.equal(claude.grant.valid, false);
    assert.equal(claude.grant.reason, "PATH_INACCESSIBLE");
    assert.match(await providerRow(page, "claude-code").innerText(), /授权已失效/);
    assert.match(await providerRow(page, "claude-code").innerText(), /目录当前不可访问/);
    await assertNoDocumentScroll(page, "不可访问来源 960x680");
    await capture(page, "source-inaccessible-960x680.png");
    fs.chmodSync(path.join(ctx.home, ".claude"), 0o755);

    // 路径变成普通文件：明确不是目录。
    fs.rmSync(ctx.claudeRoot, { recursive: true, force: true });
    fs.writeFileSync(ctx.claudeRoot, "not a directory");
    await openHome(page);
    await openSettings(page);
    state = await sourceState(page);
    claude = state.candidates.find((item) => item.provider === "claude-code");
    assert.equal(claude.available, false);
    assert.equal(claude.reason, "NOT_DIRECTORY");
    assert.equal(claude.grant.valid, false);
    assert.match(await providerRow(page, "claude-code").innerText(), /授权已失效/);

    // 保存故障：真实 SQLite trigger 让开关更新失败，UI 必须回到真实状态。
    await page.locator("#source-analysis-enabled").check();
    await waitSummary(page, "分析已开启");
    assert.equal(readSourceDb(ctx.dataDir).enabled, "1");
    const blocker = openWriteDb(ctx.dataDir);
    try {
      blocker.exec(`
        CREATE TRIGGER fail_source_state
        BEFORE UPDATE ON external_source_state
        BEGIN SELECT RAISE(ABORT, 'forced source state failure'); END
      `);
      await page.locator("#source-analysis-enabled").click();
      await page.locator("#source-error").waitFor({ state: "visible", timeout: 10000 });
      assert.match(await page.locator("#source-summary").textContent(), /分析已开启/);
      assert.equal(await page.locator("#source-analysis-enabled").isChecked(), true);
      assert.equal(readSourceDb(ctx.dataDir).enabled, "1");
      await assertSettingsSingleScreen(page, "来源保存失败 960x680");
      await assertInViewportNow(page, "#source-error");
      await capture(page, "source-save-error-960x680.png");
    } finally {
      blocker.exec("DROP TRIGGER IF EXISTS fail_source_state");
      blocker.close();
    }
    await page.locator("#source-analysis-enabled").uncheck();
    await waitSummary(page, "分析已关闭");
    const afterDisable = readSourceDb(ctx.dataDir);
    assert.equal(afterDisable.enabled, "0");
    assert.equal(
      afterDisable.grants.filter((grant) => grant.status === "active").length,
      1,
      "关闭分析不得删除已有目录授权",
    );

    // 确认期间目录被替换：拒绝把新目标当作原选择。
    await queueDialogs(app, { confirm: [{ deferred: true }] });
    await providerRow(page, "codex")
      .locator('button[data-source-action="authorize"]')
      .click();
    await waitForDeferred(app);
    fs.renameSync(ctx.codexRoot, `${ctx.codexRoot}-old`);
    fs.mkdirSync(ctx.codexRoot);
    await resolveDeferred(app, 1);
    await page.locator("#source-error").waitFor({ state: "visible", timeout: 10000 });
    assert.match(await page.locator("#source-error").textContent(), /确认期间发生变化/);
    assert.equal(
      readSourceDb(ctx.dataDir).grants.filter(
        (grant) => grant.provider === "codex" && grant.status === "active",
      ).length,
      0,
      "目录身份变化时不得落库授权",
    );
    fs.rmSync(ctx.codexRoot, { recursive: true, force: true });
    fs.renameSync(`${ctx.codexRoot}-old`, ctx.codexRoot);
    await openHome(page);
    await openSettings(page);

    // 迟到原生确认：导航离开后回包不得覆盖新面板；重新进入读取真实落库结果。
    await queueDialogs(app, { confirm: [{ deferred: true }] });
    await providerRow(page, "codex")
      .locator('button[data-source-action="authorize"]')
      .click();
    await waitForDeferred(app);
    const pendingDialogs = await readDialogs(app);
    assertConfirmDetail(pendingDialogs.confirmCalls.at(-1), "Codex", ctx.codexRoot);
    await openHome(page);
    await resolveDeferred(app, 1);
    await delay(400);
    await openSettings(page);
    state = await sourceState(page);
    const codex = state.candidates.find((item) => item.provider === "codex");
    assert.equal(codex.grant.valid, true, "迟到确认的落库结果应在重新进入时读取");
    assert.match(await providerRow(page, "codex").innerText(), /已授权/);
    assert.equal(await page.locator("#source-error").isHidden(), true);
    assert.equal(await page.locator("#source-status").textContent(), "");

    // renderer 能力面与非法参数。
    const surface = await page.evaluate(() => ({
      keys: Object.keys(window.bayperSources).sort(),
      hasIpcRenderer: "ipcRenderer" in window,
    }));
    assert.deepEqual(surface.keys, [
      "authorizeCandidate",
      "chooseDirectory",
      "getState",
      "revoke",
      "setEnabled",
    ]);
    assert.equal(surface.hasIpcRenderer, false);
    const unknown = await page.evaluate(() => window.bayperSources.authorizeCandidate("unknown-agent"));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "UNSUPPORTED_PROVIDER");
    const invalidToggle = await page.evaluate(() => window.bayperSources.setEnabled("yes"));
    assert.equal(invalidToggle.ok, false);
    assert.equal(invalidToggle.error.code, "INVALID_INPUT");

    // 非可信 sender/frame 在真实 handler 边界被拒绝。
    const rejected = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handlers = ipcMain._invokeHandlers;
      const handler = handlers instanceof Map ? handlers.get("bayper:source:set-enabled") : null;
      if (typeof handler !== "function") {
        throw new Error("Electron 内部 IPC handler 入口不可用。");
      }
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      const badSender = await handler(
        { sender: {}, senderFrame: { url: "https://evil.example/" } },
        true,
      );
      const badFrame = await handler(
        { sender: win.webContents, senderFrame: { url: "https://evil.example/" } },
        true,
      );
      return { badSender, badFrame };
    });
    assert.equal(rejected.badSender.ok, false);
    assert.equal(rejected.badSender.error.code, "UNTRUSTED_IPC");
    assert.equal(rejected.badFrame.ok, false);
    assert.equal(rejected.badFrame.error.code, "UNTRUSTED_IPC");

    // 原生确认等待期间关闭管理窗：迟到确认不得落库。
    const beforeWindowConfirm = readSourceDb(ctx.dataDir);
    await queueDialogs(app, {
      open: [{ canceled: false, filePaths: [ctx.customClaude] }],
      confirm: [{ deferred: true }],
    });
    await providerRow(page, "claude-code")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitForDeferred(app);
    await hideManagementWindow(app);
    await resolveDeferred(app, 1);
    await delay(300);
    const afterWindowConfirm = readSourceDb(ctx.dataDir);
    assert.equal(
      afterWindowConfirm.grants.some((grant) => grant.display_path === ctx.customClaude),
      false,
      "窗口关闭后的确认不得写入授权",
    );
    assert.equal(
      afterWindowConfirm.grants.length,
      beforeWindowConfirm.grants.length,
      "窗口关闭后的确认不得改变授权数量",
    );
    await showManagementWindow(app);
    await openHome(page);
    await openSettings(page);

    // 原生目录选择等待期间关闭管理窗：返回路径不得进入确认或落库。
    const beforeWindowOpen = readSourceDb(ctx.dataDir);
    const dialogsBeforeOpen = await readDialogs(app);
    await queueDialogs(app, { open: [{ deferred: true }] });
    await providerRow(page, "codex")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitForOpenDeferred(app);
    await hideManagementWindow(app);
    await resolveOpenDeferred(app, { canceled: false, filePaths: [ctx.customCodex] });
    await delay(300);
    const afterWindowOpen = readSourceDb(ctx.dataDir);
    assert.equal(
      afterWindowOpen.grants.some((grant) => grant.display_path === ctx.customCodex),
      false,
      "窗口关闭后的目录选择不得写入授权",
    );
    assert.equal(
      afterWindowOpen.grants.length,
      beforeWindowOpen.grants.length,
      "窗口关闭后的目录选择不得改变授权数量",
    );
    assert.equal(
      (await readDialogs(app)).confirmCalls.length,
      dialogsBeforeOpen.confirmCalls.length,
      "窗口关闭后的目录选择不得进入确认框",
    );
    await showManagementWindow(app);
    await openHome(page);
    await openSettings(page);

    // 本用例主动移动/替换了 Claude 目录；其余夹具文件内容必须未被来源设置写入。
    assert.equal(
      fs.readFileSync(path.join(`${ctx.claudeRoot}-old`, "session.jsonl"), "utf8"),
      ctx.before.claude,
    );
    for (const key of ["codex", "other", "customClaude", "customCodex"]) {
      assert.equal(fs.readFileSync(ctx.files[key], "utf8"), ctx.before[key], `${key} 未被修改`);
    }
    const finalDb = readSourceDb(ctx.dataDir);
    assert.equal(finalDb.memories, 1);
    assert.deepEqual(finalDb.memoryBodies, ["来源设置前已经存在的记忆"]);
    assert.equal(ctx.server.requests.length, 0);

    // 原生确认等待期间退出应用：迟到请求不得落库，且应用必须在界内退出。
    const beforeQuit = readSourceDb(ctx.dataDir);
    await queueDialogs(app, {
      open: [{ canceled: false, filePaths: [ctx.customCodex] }],
      confirm: [{ deferred: true }],
    });
    await providerRow(page, "codex")
      .locator('button[data-source-action="choose"]')
      .click();
    await waitForDeferred(app);
    await quitAppAndWait(app, { resolveConfirm: true });
    const afterQuit = readSourceDb(ctx.dataDir);
    assert.equal(
      afterQuit.grants.some((grant) => grant.display_path === ctx.customCodex),
      false,
      "应用退出后的迟到确认不得写入授权",
    );
    assert.equal(
      afterQuit.grants.length,
      beforeQuit.grants.length,
      "应用退出后的迟到确认不得改变授权数量",
    );
    assert.equal(ctx.server.requests.length, 0);
  } catch (error) {
    failure = error;
    await captureFailure(launched?.page, "source-ui-003");
    throw error;
  } finally {
    await cleanupResources({
      testName: "source-settings-003",
      launched,
      ctx,
      failure,
      trace,
    });
  }
});
