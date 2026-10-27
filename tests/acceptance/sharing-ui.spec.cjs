/* S03e 正式记忆窗口中的明确转告与分享限制验收。
   真实 Electron/main/SQLite/renderer；本机 HTTP 只用于观察模型上下文与在途回复，
   不读取 .env、不调用真实模型。覆盖 POL-SHAREUI-001～006。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
/* 每次运行写入独立批次目录，保留既有历史截图；批次名可由编排方显式指定。 */
const EVIDENCE_BATCH =
  process.env.S03E_EVIDENCE_BATCH ||
  `run-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const EVIDENCE_DIR = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s03e-sharing-ui",
  EVIDENCE_BATCH,
);

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(EVIDENCE_DIR, "run.json"),
  `${JSON.stringify(
    {
      batch: EVIDENCE_BATCH,
      startedAt: new Date().toISOString(),
      runner: "tests/acceptance/sharing-ui.spec.cjs",
      boundary: [
        "真实 Electron/main/SQLite/renderer，临时数据目录",
        "本机 HTTP fixture 仅观察模型上下文与在途回复",
        "不读取 .env、不调用真实付费模型",
      ],
    },
    null,
    2,
  )}\n`,
);

let currentCase = null;

function beginCase(id) {
  currentCase = { id, apps: [], closed: new Set() };
}

function noteAppResult(app, result) {
  currentCase.apps.push(result);
  currentCase.closed.add(app);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待测试条件超时。");
    }
    await delay(10);
  }
}

function sendStructured(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
    }),
  );
}

function sendText(response, text) {
  sendStructured(response, { reply: text, memoryCandidates: [] });
}

async function startChatServer() {
  const requests = [];
  const responders = [];
  let closed = false;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push(body);
      const responder = responders.shift();
      Promise.resolve(responder ? responder({ body, response }) : sendText(response, "收到。")).catch(
        () => {
          if (!response.destroyed && !response.writableEnded) {
            response.destroy();
          }
        },
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    enqueue(responder) {
      responders.push(responder);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (server.listening) {
        throw new Error("HTTP fixture 仍在监听");
      }
    },
  };
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-sharing-ui-"));
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

async function waitAppExit(handle, timeoutMs = 5000) {
  const started = Date.now();
  while (handle && Date.now() - started <= timeoutMs) {
    if (handle.exitCode !== null || handle.signalCode !== null) {
      return true;
    }
    await delay(10);
  }
  return false;
}

/* 只操作本次启动的进程句柄。close 抛错或超时后终止该进程并等待真实退出；
   无法确认退出时返回 unconfirmed，由调用方保留目录并报告失败。 */
async function stopApp(app, timeout = 10000) {
  if (!app) {
    return { status: "no-app", pid: null, code: null, signal: null, error: null };
  }
  const handle = app.process?.() ?? null;
  const pid = handle?.pid ?? null;
  if (!handle) {
    return {
      status: "unconfirmed",
      pid,
      code: null,
      signal: null,
      error: "无进程句柄，无法确认退出",
    };
  }
  if (handle.exitCode !== null || handle.signalCode !== null) {
    return {
      status: "exited",
      pid,
      code: handle.exitCode,
      signal: handle.signalCode,
      error: null,
    };
  }
  let timedOut = false;
  let timer;
  let closeError = null;
  try {
    await Promise.race([
      app.close(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeout);
      }),
    ]);
  } catch (error) {
    closeError = error.message;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut || closeError) {
    try {
      handle.kill("SIGKILL");
    } catch (error) {
      closeError ??= error.message;
    }
  }
  let exited = await waitAppExit(handle, 5000);
  if (!exited) {
    try {
      handle.kill("SIGKILL");
    } catch (error) {
      closeError ??= error.message;
    }
    closeError ??= "close 后进程未退出";
    exited = await waitAppExit(handle, 5000);
  }
  return {
    status: exited ? (timedOut || closeError ? "exited-after-kill" : "exited") : "unconfirmed",
    pid,
    code: handle.exitCode ?? null,
    signal: handle.signalCode ?? null,
    error: timedOut ? `close 超时 ${timeout}ms` : closeError,
  };
}

async function closeApp(app, timeout = 10000) {
  const result = await stopApp(app, timeout);
  if (currentCase) {
    noteAppResult(app, result);
  }
  if (result.status !== "exited" && result.status !== "no-app") {
    throw new Error(result.error || `应用未确认退出：${result.status}`);
  }
  return result;
}

/* 先完成业务与清理，再把两者合并成最终 Case 结果写入批次；不提前写 PASS。
   业务失败优先保留；清理失败在无业务失败时使测试失败。 */
async function finishCase({ caseId, facts, screenshots = [], app, server, dataDir, failure }) {
  if (app && !currentCase.closed.has(app)) {
    noteAppResult(app, await stopApp(app));
  }
  const electron = currentCase.apps.slice();
  let http;
  try {
    await server.close();
    http = { status: "closed" };
  } catch (error) {
    http = { status: "failed", error: error.message };
  }
  const electronConfirmed = electron.every(
    (result) => result.status === "exited" || result.status === "exited-after-kill",
  );
  const electronGraceful = electron.every((result) => result.status === "exited");
  let tempDir;
  if (electronConfirmed) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      tempDir = fs.existsSync(dataDir)
        ? { status: "failed", error: "临时目录仍存在" }
        : { status: "deleted" };
    } catch (error) {
      tempDir = { status: "failed", error: error.message };
    }
  } else {
    tempDir = { status: "kept", reason: "Electron 退出未确认，保留目录供核对" };
  }
  const cleanupPass =
    electronGraceful && http.status === "closed" && tempDir.status === "deleted";
  const status = failure || !cleanupPass ? "FAIL" : "PASS";
  fs.appendFileSync(
    path.join(EVIDENCE_DIR, "cases.jsonl"),
    `${JSON.stringify({
      batch: EVIDENCE_BATCH,
      id: caseId,
      status,
      business: {
        status: failure ? "FAIL" : "PASS",
        error: failure?.message ?? null,
      },
      cleanup: {
        status: cleanupPass ? "PASS" : "FAIL",
        electron,
        http,
        tempDir,
      },
      pid: electron.at(-1)?.pid ?? null,
      facts: failure ? null : facts,
      screenshots,
      recordedAt: new Date().toISOString(),
    })}\n`,
  );
  if (!cleanupPass) {
    const message = `清理失败：${JSON.stringify({ electron, http, tempDir })}`;
    if (failure) {
      console.error(`${message}（保留原始业务失败）`);
    } else {
      throw new Error(message);
    }
  }
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-chat");
  await page.locator("#api-key").fill("sk-fixture-chat");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function setWindowSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(120);
}

function openDb(dataDir, readOnly = false) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
  // 主进程事务提交期间的只读核对等待短暂写锁，避免把锁竞争误报为业务失败。
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function readMemoryRows(dataDir, characterId) {
  const db = openDb(dataDir, true);
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.character_id, e.fact_key, e.body, e.version,
                e.origin_character_id, e.trust, e.fact_identity_id,
                d.parent_entry_id, d.narrator_character_id
         FROM memory_entries e
         LEFT JOIN memory_derivations d ON d.entry_id = e.id
         WHERE e.character_id = ?
           AND (e.expires_at IS NULL OR e.expires_at > ?)
         ORDER BY e.importance DESC, e.updated_at DESC, e.id ASC`,
      )
      .all(characterId, Date.now());
    const controls = new Set(
      db
        .prepare("SELECT identity_id FROM memory_share_identity_controls")
        .all()
        .map((row) => row.identity_id),
    );
    return rows.map((row) => ({
      ...row,
      derived:
        row.parent_entry_id !== null || row.origin_character_id !== row.character_id,
      sharingRestricted: controls.has(row.fact_identity_id),
    }));
  } finally {
    db.close();
  }
}

function readStats(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
      .all();
  } finally {
    db.close();
  }
}

function readRoster(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all();
  } finally {
    db.close();
  }
}

function readChatMessages(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare("SELECT role, content, character_id, conversation_id FROM chat_messages ORDER BY seq")
      .all();
  } finally {
    db.close();
  }
}

function readRequestStatuses(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db.prepare("SELECT status FROM chat_requests ORDER BY created_at, id").all();
  } finally {
    db.close();
  }
}

function seedCompanion(dataDir, characterId, nickname = null) {
  const db = openDb(dataDir);
  try {
    db.prepare(`
      INSERT INTO relationships (character_id, accepted_at, nickname) VALUES (?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, relationships.nickname)
    `).run(characterId, new Date().toISOString(), nickname);
    db.prepare(`
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `).run(characterId);
  } finally {
    db.close();
  }
}

function withStore(dataDir, fn) {
  const store = createStore(dataDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function openMemory(page, { waitForLoad = true } = {}) {
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  if (waitForLoad) {
    await waitMemoryLoaded(page);
  }
}

async function waitMemoryLoaded(page) {
  await page.waitForFunction(() => {
    const notice = document.querySelector("#memory-notice");
    return Boolean(notice) && notice.dataset.state !== "loading";
  });
}

async function selectMemoryCharacter(page, characterId) {
  await page.locator("#memory-character").selectOption(characterId);
  await page.waitForFunction(
    (id) => {
      const select = document.querySelector("#memory-character");
      const notice = document.querySelector("#memory-notice");
      return select?.value === id && notice?.dataset.state !== "loading";
    },
    characterId,
  );
}

async function selectMemoryByBody(page, body) {
  await page.locator(".memory-entry").filter({ hasText: body }).first().click();
  await page.waitForFunction(
    (expected) => document.querySelector("#memory-body")?.value === expected,
    body,
  );
}

async function memoryCards(page) {
  return page.locator(".memory-entry").evaluateAll((nodes) =>
    nodes.map((node) => ({
      body: node.querySelector(".memory-entry-body")?.textContent ?? "",
      meta: node.querySelector(".memory-entry-meta")?.textContent ?? "",
    })),
  );
}

async function waitNotice(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector("#memory-notice")?.textContent?.includes(expected),
    text,
  );
}

async function waitError(page, text) {
  await page.waitForFunction(
    (expected) => {
      const error = document.querySelector("#memory-error");
      return error && !error.hidden && error.textContent.includes(expected);
    },
    text,
  );
}

async function panelState(page) {
  return page.evaluate(() => ({
    character: document.querySelector("#memory-character")?.value ?? "",
    input: document.querySelector("#memory-body")?.value ?? "",
    notice: document.querySelector("#memory-notice")?.textContent ?? "",
    selected: document.querySelector(".memory-entry.is-selected .memory-entry-body")?.textContent ?? "",
    toggle: document.querySelector("#memory-sharing-toggle")?.textContent?.trim() ?? "",
    toggleDisabled: document.querySelector("#memory-sharing-toggle")?.disabled ?? false,
    sharingNote: document.querySelector("#memory-sharing-note")?.textContent?.trim() ?? "",
    relayNote: document.querySelector("#memory-relay-note")?.textContent?.trim() ?? "",
    relayDisabled: document.querySelector("#memory-relay")?.disabled ?? false,
    dirtyHidden: document.querySelector("#memory-dirty-note")?.hidden ?? true,
    errorText: document.querySelector("#memory-error")?.hidden
      ? ""
      : (document.querySelector("#memory-error")?.textContent ?? ""),
  }));
}

async function panelGeometry(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".memory-dialog").getBoundingClientRect();
    const list = document.querySelector("#memory-list");
    const controls = [
      "#memory-relay-target",
      "#memory-relay",
      "#memory-sharing-toggle",
      "#memory-save",
      "#memory-delete",
    ].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, top: rect.top, bottom: rect.bottom };
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: { top: dialog.top, bottom: dialog.bottom, left: dialog.left, right: dialog.right },
      controls,
      listScrolls: list.scrollHeight > list.clientHeight,
      documentScrolls: document.scrollingElement.scrollHeight > window.innerHeight,
    };
  });
}

function assertPanelGeometry(geometry) {
  assert.ok(geometry.dialog.top >= 0 && geometry.dialog.bottom <= geometry.viewport.height);
  assert.ok(geometry.dialog.left >= 0 && geometry.dialog.right <= geometry.viewport.width);
  assert.equal(geometry.listScrolls, true);
  assert.equal(geometry.documentScrolls, false);
  for (const control of geometry.controls) {
    assert.ok(control.top >= geometry.dialog.top, control.selector);
    assert.ok(control.bottom <= geometry.dialog.bottom, control.selector);
    assert.ok(control.bottom <= geometry.viewport.height, control.selector);
  }
}

async function capture(page, name) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

/* 复用 S03c 的真实 IPC 延迟方式：只在本测试进程内包装生产 handler，
   不向生产代码加入测试开关。relay/限制类在真实事务完成后暂停回包。 */
async function controlIpc(app, action, payload = {}) {
  return app.evaluate(
    async ({ ipcMain }, cmd) => {
      const state = (globalThis.__s03eIpcTest ??= { gates: new Map(), wrapped: new Set() });
      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      if (cmd.action === "install") {
        const handlers = ipcMain._invokeHandlers;
        if (!(handlers instanceof Map)) {
          throw new Error("Electron 内部 IPC handler 入口不可用。");
        }
        for (const channel of cmd.channels) {
          if (state.wrapped.has(channel)) {
            continue;
          }
          const original = handlers.get(channel);
          if (typeof original !== "function") {
            throw new Error(`找不到 IPC handler：${channel}`);
          }
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async (event, ...args) => {
            const afterOriginal = [
              "bayper:memory:correct",
              "bayper:memory:relay",
              "bayper:memory:restrict-sharing",
              "bayper:memory:allow-sharing",
            ].includes(channel);
            const key =
              channel === "bayper:chat:conversation"
                ? args[1]
                : channel === "bayper:memory:list"
                  ? args[0]?.characterId
                  : args[0]?.entryId;
            const gateKey = `${channel}:${key}`;
            const candidate = state.gates.get(gateKey);
            const gate = candidate && !candidate.claimed ? candidate : null;
            if (gate) {
              gate.claimed = true;
            }
            if (gate && !afterOriginal) {
              gate.entered.resolve();
              await gate.release.promise;
            }
            const result = original(event, ...args);
            if (gate && afterOriginal) {
              await event.sender.executeJavaScript(
                "window.__s03eIpcEventFlushed=(window.__s03eIpcEventFlushed??0)+1;",
              );
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (gate) {
              state.gates.delete(gateKey);
              setImmediate(() => {
                event.sender
                  .executeJavaScript(`window.__s03eIpcLast=${JSON.stringify(gateKey)};`)
                  .catch(() => {});
              });
            }
            return result;
          });
          state.wrapped.add(channel);
        }
        return true;
      }
      if (cmd.action === "hold") {
        state.gates.set(`${cmd.channel}:${cmd.key}`, {
          entered: deferred(),
          release: deferred(),
        });
        return true;
      }
      const gate = state.gates.get(`${cmd.channel}:${cmd.key}`);
      if (!gate) {
        throw new Error("没有等待中的 IPC 测试门。");
      }
      if (cmd.action === "entered") {
        await gate.entered.promise;
        return true;
      }
      if (cmd.action === "release") {
        gate.release.resolve();
        return true;
      }
      throw new Error(`未知的 IPC 测试操作：${cmd.action}`);
    },
    { action, ...payload },
  );
}

async function waitIpcReply(page, channel, key) {
  const expected = `${channel}:${key}`;
  await page.waitForFunction((value) => window.__s03eIpcLast === value, expected);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function selectRelayTarget(page, characterId) {
  await page.locator("#memory-relay-target").selectOption(characterId);
}

async function goHome(page) {
  await page.locator('[data-nav="home"]').click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function relaySelected(page, targetCharacterId) {
  await selectRelayTarget(page, targetCharacterId);
  await page.locator("#memory-relay").click();
}

async function openChatFor(page, characterId) {
  await page.locator('[data-nav="characters"]').click();
  await page.locator(`.character-item[data-character-id="${characterId}"]`).click();
  await page.locator("#character-chat").click();
  await page.waitForFunction(() => document.querySelector("#chat-panel")?.hidden === false);
}

async function sendChatAndWait(page, text, reply) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes(expected),
      ),
    reply,
  );
}

test("POL-SHAREUI-001 GUI 指定条目转告名单外B，来源清楚且重复幂等", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-001");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    seedCompanion(dataDir, "cheng");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.white-tea",
        body: "用户喜欢白茶",
        kind: "preference",
        sourceId: "seed:white-tea",
      });
      store.memory.remember({
        characterId: "rin",
        factKey: "detail.private",
        body: "用户的私人联系人是林舟",
        kind: "detail",
        sourceId: "seed:private",
      });
      store.memory.remember({
        characterId: "rin",
        factKey: "detail.work",
        body: "用户的工作代号是白鹭",
        kind: "detail",
        sourceId: "seed:work",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const rosterBefore = readRoster(dataDir);
    assert.equal(rosterBefore.some((row) => row.character_id === "hu"), false);
    const statsBefore = readStats(dataDir);
    const snapshotBefore = await page.evaluate(() => window.bayper.getSnapshot());
    const currentBefore = snapshotBefore.snapshot.companionship.current.characterId;
    const requestBaseline = server.requests.length;

    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢白茶");
    let state = await panelState(page);
    assert.equal(state.toggle, "禁止分享这件事");
    assert.match(state.sharingNote, /不会撤回已有记忆/u);
    const targets = await page.locator("#memory-relay-target option").allTextContents();
    assert.ok(targets.includes("琥珀"));
    assert.ok(targets.includes("澄"));
    assert.equal(targets.includes("凛"), false);
    await relaySelected(page, "hu");
    await waitNotice(page, "已转告给琥珀");

    const huRows = readMemoryRows(dataDir, "hu");
    assert.equal(huRows.length, 1);
    assert.equal(huRows[0].body, "用户喜欢白茶");
    assert.equal(huRows[0].origin_character_id, "rin");
    assert.equal(huRows[0].narrator_character_id, "rin");
    assert.equal(huRows[0].parent_entry_id, readMemoryRows(dataDir, "rin").find((row) => row.body === "用户喜欢白茶").id);
    assert.equal(readMemoryRows(dataDir, "cheng").length, 0);
    assert.deepEqual(readRoster(dataDir), rosterBefore);
    assert.deepEqual(readStats(dataDir), statsBefore);
    assert.equal(server.requests.length, requestBaseline);
    const after = await page.evaluate(() => window.bayper.getSnapshot());
    assert.equal(after.snapshot.companionship.current.characterId, currentBefore);

    await selectMemoryCharacter(page, "hu");
    let cards = await memoryCards(page);
    assert.deepEqual(cards.map((card) => card.body), ["用户喜欢白茶"]);
    assert.match(cards[0].meta, /听凛说过/u);

    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "用户喜欢白茶");
    await relaySelected(page, "hu");
    await waitNotice(page, "已经知道这件事");
    assert.equal(readMemoryRows(dataDir, "hu").length, 1);
    assert.equal(readMemoryRows(dataDir, "hu")[0].version, 1);
    state = await panelState(page);
    assert.equal(state.selected, "用户喜欢白茶");
    await setWindowSize(app, 1200, 800);
    await capture(page, "sharing-relay-1200x800.png");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "POL-SHAREUI-001",
      facts: { body: "用户喜欢白茶", recipient: "hu", repeatedAlreadyHeld: true, noHttp: true },
      screenshots: ["sharing-relay-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("POL-SHAREUI-002 GUI B转告C、B自忘记后C保留讲述者与模型来源", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-002");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    seedCompanion(dataDir, "cheng");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "exp.qingdao",
        body: "用户分享过在青岛吃蛤蜊的经历",
        kind: "experience",
        sourceId: "seed:qingdao",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });

    await openMemory(page);
    await selectMemoryByBody(page, "用户分享过在青岛吃蛤蜊的经历");
    await relaySelected(page, "hu");
    await waitNotice(page, "已转告给琥珀");

    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户分享过在青岛吃蛤蜊的经历");
    let cards = await memoryCards(page);
    assert.match(cards[0].meta, /听凛说过/u);
    await relaySelected(page, "cheng");
    await waitNotice(page, "已转告给澄");
    const chengRows = readMemoryRows(dataDir, "cheng");
    assert.equal(chengRows.length, 1);
    assert.equal(chengRows[0].origin_character_id, "rin");
    assert.equal(chengRows[0].narrator_character_id, "hu");
    assert.equal(
      chengRows[0].parent_entry_id,
      readMemoryRows(dataDir, "hu").find((row) => row.origin_character_id === "rin").id,
    );

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openChatFor(page, "hu");
    await sendChatAndWait(page, "你好。", "收到。");
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await goHome(page);
    const huChatBefore = readChatMessages(dataDir).filter((message) => message.character_id === "hu");
    assert.ok(huChatBefore.length > 0);

    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户分享过在青岛吃蛤蜊的经历");
    await page.locator('input[name="memory-scope"][value="self"]').check();
    await page.locator("#memory-delete").click();
    await page.waitForFunction(
      () => !document.querySelector(".memory-entry-body"),
    );
    assert.equal(readMemoryRows(dataDir, "hu").length, 0);

    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "用户分享过在青岛吃蛤蜊的经历");
    await relaySelected(page, "hu");
    await waitError(page, "接收者已明确忘记该事实");
    assert.equal(readMemoryRows(dataDir, "hu").length, 0);
    assert.equal(readMemoryRows(dataDir, "cheng").length, 1);
    // B 改昵称后，C 的来源用语与模型上下文都应使用既有昵称，同时保留稳定ID。
    seedCompanion(dataDir, "hu", "小琥");

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await closeApp(app);
    app = null;
    const restarted = await launchApp(dataDir);
    app = restarted.app;
    const page2 = restarted.page;
    await page2.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });

    await openMemory(page2);
    await selectMemoryCharacter(page2, "cheng");
    await selectMemoryByBody(page2, "用户分享过在青岛吃蛤蜊的经历");
    cards = await memoryCards(page2);
    assert.match(cards[0].meta, /听小琥说过，最初来自凛/u);
    await capture(page2, "sharing-c-source-1200x800.png");
    await page2.locator("#memory-close").click();
    await page2.locator("#memory-overlay").waitFor({ state: "hidden" });

    await openChatFor(page2, "cheng");
    const requestBefore = server.requests.length;
    server.enqueue(({ response }) => sendText(response, "我记得听琥珀提过。"));
    await sendChatAndWait(page2, "你还记得青岛吗？", "我记得听琥珀提过。");
    assert.equal(server.requests.length, requestBefore + 1);
    const memoryPrompt = server.requests.at(-1).messages.find(
      (message) => message.role === "system" && message.content.includes("本轮可用的记忆"),
    )?.content;
    assert.match(memoryPrompt, /听小琥\(hu\)说，最初来自凛\(rin\)/u);
    assert.match(memoryPrompt, /不是用户直接对本角色说/u);
    assert.equal(memoryPrompt.includes("听凛(rin)说"), false);
    assert.deepEqual(
      readChatMessages(dataDir).filter((message) => message.character_id === "hu"),
      huChatBefore,
    );
    assert.equal(readMemoryRows(dataDir, "hu").length, 0);
    await capture(page2, "sharing-c-chat-source-1200x800.png");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "POL-SHAREUI-002",
      facts: {
        directNarrator: "hu/小琥",
        origin: "rin/凛",
        nicknameApplied: true,
        modelPromptSource: "转述，听小琥(hu)说，最初来自凛(rin)",
        unrelatedHuChatPreserved: true,
      },
      screenshots: ["sharing-c-source-1200x800.png", "sharing-c-chat-source-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("REVIEW-S03E-1 GUI 旧派生记录未知讲述者显示转述与最初来源", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("REVIEW-S03E-1");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    const dbPath = path.join(dataDir, DB_FILE);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare(`
        INSERT INTO memory_entries (
          id, character_id, fact_key, origin_character_id, derived_from_entry_id,
          kind, body, trust, importance, expires_at, source_id, source_version,
          version, created_at, updated_at
        ) VALUES (?, 'hu', 'pref.legacy', 'rin', NULL, 'preference', ?, 'stated', 60, NULL, ?, 1, 1, ?, ?)
      `).run("legacy-derived-ui", "用户喜欢陈茶", "legacy:source", Date.now(), Date.now());
      db.prepare(`
        INSERT INTO memory_derivations (
          entry_id, parent_entry_id, origin_character_id, narrator_character_id,
          source_id, source_version, created_at
        ) VALUES (?, 'missing-parent', 'rin', NULL, ?, 1, ?)
      `).run("legacy-derived-ui", "legacy:source", Date.now());
    } finally {
      db.close();
    }
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户喜欢陈茶");
    const card = (await memoryCards(page))[0];
    assert.match(card.meta, /转述，最初来自凛/u);
    assert.equal(card.meta.includes("听凛说过"), false);
    assert.match(await page.locator("#memory-editor-meta").textContent(), /转述，最初来自凛/u);
    await capture(page, "sharing-unknown-narrator-1200x800.png");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "REVIEW-S03E-1",
      facts: { unknownNarrator: true, origin: "rin/凛", guessedNarrator: false },
      screenshots: ["sharing-unknown-narrator-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("POL-SHAREUI-003 GUI 事实禁止分享跨持有者持久，独立解除后恢复", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-003");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    seedCompanion(dataDir, "cheng");
    withStore(dataDir, (store) => {
      const entry = store.memory.remember({
        characterId: "rin",
        factKey: "detail.secret",
        body: "用户的秘密是银钥匙",
        kind: "detail",
        sourceId: "seed:secret",
      });
      store.memory.share({
        fromCharacterId: "rin",
        toCharacterId: "hu",
        entryIds: [entry.entry.id],
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const statsBefore = readStats(dataDir);
    const requestBaseline = server.requests.length;

    await openMemory(page);
    await selectMemoryByBody(page, "用户的秘密是银钥匙");
    let state = await panelState(page);
    assert.equal(state.toggle, "禁止分享这件事");
    await page.locator("#memory-sharing-toggle").click();
    await waitNotice(page, "已禁止分享这件事");
    state = await panelState(page);
    assert.equal(state.toggle, "允许分享");
    assert.match(state.sharingNote, /已有角色保留原副本/u);
    const cards = await memoryCards(page);
    assert.match(cards[0].meta, /已禁止分享/u);
    assert.equal(readMemoryRows(dataDir, "rin")[0].sharingRestricted, true);
    assert.equal(readMemoryRows(dataDir, "hu")[0].sharingRestricted, true);

    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户的秘密是银钥匙");
    state = await panelState(page);
    assert.equal(state.toggle, "允许分享");
    assert.match((await memoryCards(page))[0].meta, /已禁止分享/u);
    await relaySelected(page, "cheng");
    await waitError(page, "用户已禁止分享该事实");
    assert.equal(readMemoryRows(dataDir, "cheng").length, 0);
    assert.equal(readMemoryRows(dataDir, "rin").length, 1);
    assert.equal(readMemoryRows(dataDir, "hu").length, 1);
    assert.deepEqual(readStats(dataDir), statsBefore);
    assert.equal(server.requests.length, requestBaseline);
    await capture(page, "sharing-restricted-1200x800.png");

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await closeApp(app);
    app = null;
    const restarted = await launchApp(dataDir);
    app = restarted.app;
    const page2 = restarted.page;
    await page2.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(page2);
    await selectMemoryCharacter(page2, "hu");
    await selectMemoryByBody(page2, "用户的秘密是银钥匙");
    state = await panelState(page2);
    assert.equal(state.toggle, "允许分享");
    assert.match(state.sharingNote, /已有角色保留原副本/u);
    await page2.locator("#memory-sharing-toggle").click();
    await waitNotice(page2, "已允许分享");
    state = await panelState(page2);
    assert.equal(state.toggle, "禁止分享这件事");
    assert.equal(readMemoryRows(dataDir, "hu")[0].sharingRestricted, false);

    await relaySelected(page2, "cheng");
    await waitNotice(page2, "已转告给澄");
    const chengRows = readMemoryRows(dataDir, "cheng");
    assert.equal(chengRows.length, 1);
    assert.equal(chengRows[0].body, "用户的秘密是银钥匙");
    assert.equal(chengRows[0].origin_character_id, "rin");
    assert.equal(chengRows[0].narrator_character_id, "hu");
    // 解除限制同样对所有持有者可见：切回 A 时界面读取同一事实状态。
    await selectMemoryCharacter(page2, "rin");
    await selectMemoryByBody(page2, "用户的秘密是银钥匙");
    state = await panelState(page2);
    assert.equal(state.toggle, "禁止分享这件事");
    assert.equal(readMemoryRows(dataDir, "rin")[0].sharingRestricted, false);
    assert.deepEqual(readStats(dataDir), statsBefore);
    assert.equal(server.requests.length, requestBaseline);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "POL-SHAREUI-003",
      facts: {
        restrictedAcrossHolders: true,
        persistedAfterRestart: true,
        existingCopiesKept: true,
        independentlyLifted: true,
        chengNarrator: "hu",
      },
      screenshots: ["sharing-restricted-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("POL-SHAREUI-004 GUI 草稿、旧版本、删除与写故障不假成功", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-004");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    seedCompanion(dataDir, "cheng");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.white-tea",
        body: "用户喜欢白茶",
        kind: "preference",
        sourceId: "seed:white-tea",
      });
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.old-book",
        body: "用户喜欢旧书",
        kind: "preference",
        sourceId: "seed:old-book",
      });
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.osmanthus",
        body: "用户喜欢桂花糕",
        kind: "preference",
        sourceId: "seed:osmanthus",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });

    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢白茶");
    await page.locator("#memory-body").fill("未保存的草稿正文");
    let state = await panelState(page);
    assert.equal(state.dirtyHidden, false);
    assert.equal(state.relayDisabled, true);
    await setWindowSize(app, 1200, 800);
    await capture(page, "sharing-draft-blocked-1200x800.png");
    await page.locator("#memory-revert").click();
    state = await panelState(page);
    assert.equal(state.input, "用户喜欢白茶");
    assert.equal(state.dirtyHidden, true);
    assert.equal(state.relayDisabled, false);
    assert.equal(readMemoryRows(dataDir, "hu").length, 0);
    await relaySelected(page, "hu");
    await waitNotice(page, "已转告给琥珀");
    assert.equal(readMemoryRows(dataDir, "hu")[0].body, "用户喜欢白茶");

    const whiteTea = readMemoryRows(dataDir, "rin").find((row) => row.body === "用户喜欢白茶");
    let db = openDb(dataDir);
    db.prepare(
      "UPDATE memory_entries SET body = ?, version = version + 1, updated_at = updated_at + 1 WHERE id = ?",
    ).run("用户喜欢新白茶", whiteTea.id);
    db.close();
    await selectMemoryByBody(page, "用户喜欢白茶");
    await relaySelected(page, "cheng");
    await waitError(page, "记忆已更新");
    state = await panelState(page);
    assert.equal(state.input, "用户喜欢白茶");
    assert.equal(readMemoryRows(dataDir, "cheng").length, 0);
    const updated = readMemoryRows(dataDir, "rin").find((row) => row.id === whiteTea.id);
    assert.equal(updated.body, "用户喜欢新白茶");
    assert.equal(updated.version, 2);

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢新白茶");
    await relaySelected(page, "cheng");
    await waitNotice(page, "已转告给澄");
    assert.equal(readMemoryRows(dataDir, "cheng")[0].body, "用户喜欢新白茶");

    const oldBook = readMemoryRows(dataDir, "rin").find((row) => row.body === "用户喜欢旧书");
    await selectMemoryByBody(page, "用户喜欢旧书");
    db = openDb(dataDir);
    db.prepare("DELETE FROM memory_entries WHERE id = ?").run(oldBook.id);
    db.close();
    await page.locator("#memory-relay").click();
    await waitNotice(page, "转告失败");
    state = await panelState(page);
    assert.equal(state.input, "用户喜欢旧书");
    assert.match(state.errorText, /只能转告自己持有的记忆/u);
    assert.equal(readMemoryRows(dataDir, "hu").some((row) => row.body === "用户喜欢旧书"), false);

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢桂花糕");
    await page.locator("#memory-body").fill("故障前草稿");
    state = await panelState(page);
    assert.equal(state.dirtyHidden, false);
    await page.locator("#memory-revert").click();
    db = openDb(dataDir);
    db.exec(`
      CREATE TRIGGER fail_sharing_ui_relay BEFORE INSERT ON memory_entries
      WHEN NEW.character_id = 'hu' AND NEW.fact_key = 'pref.osmanthus'
      BEGIN SELECT RAISE(ABORT, 'injected sharing ui failure'); END;
    `);
    db.close();
    await relaySelected(page, "hu");
    await waitNotice(page, "转告失败");
    state = await panelState(page);
    assert.equal(state.input, "用户喜欢桂花糕");
    assert.equal(state.selected, "用户喜欢桂花糕");
    assert.equal(readMemoryRows(dataDir, "hu").some((row) => row.body === "用户喜欢桂花糕"), false);
    await capture(page, "sharing-write-failure-1200x800.png");
    db = openDb(dataDir);
    db.exec("DROP TRIGGER fail_sharing_ui_relay");
    db.close();
    await page.locator("#memory-relay").click();
    await waitNotice(page, "已转告给琥珀");
    assert.ok(readMemoryRows(dataDir, "hu").some((row) => row.body === "用户喜欢桂花糕"));

    const unknown = await page.evaluate(() =>
      window.bayperMemory.relayMemory({
        fromCharacterId: "rin",
        toCharacterId: "ghost",
        entryId: "not-real",
        expectedVersion: 1,
      }),
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "CHARACTER_UNKNOWN");
    const rejected = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handlers = ipcMain._invokeHandlers;
      const handler = handlers instanceof Map ? handlers.get("bayper:memory:relay") : null;
      if (typeof handler !== "function") {
        throw new Error("Electron 内部 IPC handler 入口不可用。");
      }
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      const badSender = await handler(
        { sender: {}, senderFrame: { url: "https://evil.example/" } },
        { fromCharacterId: "rin", toCharacterId: "hu", entryId: "x", expectedVersion: 1 },
      );
      const badFrame = await handler(
        { sender: win.webContents, senderFrame: { url: "https://evil.example/" } },
        { fromCharacterId: "rin", toCharacterId: "hu", entryId: "x", expectedVersion: 1 },
      );
      return { badSender, badFrame };
    });
    assert.equal(rejected.badSender.error.code, "UNTRUSTED_IPC");
    assert.equal(rejected.badFrame.error.code, "UNTRUSTED_IPC");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "POL-SHAREUI-004",
      facts: {
        dirtyDraftBlocked: true,
        staleVersionRejected: true,
        deletedEntryRejected: true,
        writeFailureNoFalseSuccess: true,
        untrustedSenderRejected: true,
      },
      screenshots: ["sharing-draft-blocked-1200x800.png", "sharing-write-failure-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("POL-SHAREUI-005 GUI 延迟回包不污染新面板，接收者在途旧回答失效", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-005");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  let release = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    seedCompanion(dataDir, "cheng");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.delay-tea",
        body: "用户喜欢延迟测试的茶",
        kind: "preference",
        sourceId: "seed:delay-tea",
      });
      store.memory.remember({
        characterId: "hu",
        factKey: "pref.hu-book",
        body: "用户喜欢画册",
        kind: "preference",
        sourceId: "seed:hu-book",
      });
      store.memory.remember({
        characterId: "hu",
        factKey: "pref.hu-film",
        body: "用户喜欢胶片",
        kind: "preference",
        sourceId: "seed:hu-film",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const teaEntry = readMemoryRows(dataDir, "rin").find(
      (row) => row.body === "用户喜欢延迟测试的茶",
    );
    const filmEntry = readMemoryRows(dataDir, "hu").find(
      (row) => row.body === "用户喜欢胶片",
    );
    await controlIpc(app, "install", {
      channels: ["bayper:memory:relay", "bayper:memory:restrict-sharing"],
    });
    await page.evaluate(() => {
      window.__s03eIpcLast = null;
    });

    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢延迟测试的茶");
    await controlIpc(app, "hold", { channel: "bayper:memory:relay", key: teaEntry.id });
    await relaySelected(page, "hu");
    await controlIpc(app, "entered", { channel: "bayper:memory:relay", key: teaEntry.id });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户喜欢胶片");
    await page.locator("#memory-body").fill("新面板草稿");
    await controlIpc(app, "release", { channel: "bayper:memory:relay", key: teaEntry.id });
    await waitIpcReply(page, "bayper:memory:relay", teaEntry.id);
    let state = await panelState(page);
    assert.equal(state.character, "hu");
    assert.equal(state.selected, "用户喜欢胶片");
    assert.equal(state.input, "新面板草稿");
    assert.equal(state.relayNote, "");
    assert.equal(state.notice.includes("已转告给"), false);
    assert.equal(readMemoryRows(dataDir, "hu").some((row) => row.body === "用户喜欢延迟测试的茶"), true);
    await setWindowSize(app, 1200, 800);
    await capture(page, "sharing-late-reply-1200x800.png");

    await controlIpc(app, "hold", {
      channel: "bayper:memory:restrict-sharing",
      key: filmEntry.id,
    });
    await page.locator("#memory-sharing-toggle").click();
    await controlIpc(app, "entered", {
      channel: "bayper:memory:restrict-sharing",
      key: filmEntry.id,
    });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "用户喜欢延迟测试的茶");
    await page.locator("#memory-body").fill("限制面板新草稿");
    const toggleBefore = (await panelState(page)).toggle;
    await controlIpc(app, "release", {
      channel: "bayper:memory:restrict-sharing",
      key: filmEntry.id,
    });
    await waitIpcReply(page, "bayper:memory:restrict-sharing", filmEntry.id);
    state = await panelState(page);
    assert.equal(state.character, "rin");
    assert.equal(state.selected, "用户喜欢延迟测试的茶");
    assert.equal(state.input, "限制面板新草稿");
    assert.equal(state.toggle, toggleBefore);
    assert.equal(readMemoryRows(dataDir, "hu").find((row) => row.id === filmEntry.id).sharingRestricted, true);

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    // 接收者在途旧回答：先保留一段无关角色的聊天，再让当前角色等待迟到回复。
    await openChatFor(page, "hu");
    await sendChatAndWait(page, "无关角色聊天", "收到。");
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await goHome(page);
    const unrelatedChat = readChatMessages(dataDir).filter(
      (message) => message.character_id === "hu",
    );
    assert.ok(unrelatedChat.length > 0);
    const requestBaseline = server.requests.length;

    await page.locator("#chat-current").click();
    await page.waitForFunction(() => document.querySelector("#chat-panel")?.hidden === false);
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendText(response, "迟到的旧回答");
    });
    await page.locator("#chat-input").fill("我喝什么茶？");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length === requestBaseline + 1);
    await page.locator("#chat-cancel").waitFor({ state: "visible" });

    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户喜欢画册");
    await relaySelected(page, "rin");
    await waitNotice(page, "已转告给凛");
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    release();
    await page.waitForFunction(() =>
      document.querySelector("#chat-status")?.textContent?.includes("旧回复没有显示"),
    );
    assert.equal(await page.locator(".chat-bubble-assistant").count(), 0);
    assert.deepEqual(
      readRequestStatuses(dataDir).map((row) => row.status),
      ["completed", "stale"],
    );
    assert.equal(
      readChatMessages(dataDir).some((message) => message.content === "迟到的旧回答"),
      false,
    );
    assert.deepEqual(
      readChatMessages(dataDir).filter((message) => message.character_id === "hu"),
      unrelatedChat,
    );
    const rinBook = readMemoryRows(dataDir, "rin").find((row) => row.body === "用户喜欢画册");
    assert.equal(rinBook.origin_character_id, "hu");
    assert.equal(rinBook.narrator_character_id, "hu");
    await capture(page, "sharing-stale-chat-1200x800.png");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    release?.();
    await finishCase({
      caseId: "POL-SHAREUI-005",
      facts: {
        lateRelayReplyIgnored: true,
        lateRestrictReplyIgnored: true,
        recipientInflightReplyStale: true,
        unrelatedChatPreserved: true,
        draftPreserved: true,
      },
      screenshots: ["sharing-late-reply-1200x800.png", "sharing-stale-chat-1200x800.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});

test("POL-SHAREUI-006 GUI 两尺寸、长内容与仅一位角色可达且列表局部滚动", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  beginCase("POL-SHAREUI-006");
  const server = await startChatServer();
  let app = null;
  let failure = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    const longNickname = "长".repeat(20);
    seedCompanion(dataDir, "rin", longNickname);
    withStore(dataDir, (store) => {
      for (let index = 0; index < 8; index += 1) {
        store.memory.remember({
          characterId: "rin",
          factKey: `seed.long.${index}`,
          body: `长记忆 ${index} ${"很长的记忆内容".repeat(120)}`,
          kind: "detail",
          sourceId: `seed:long:${index}`,
        });
      }
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });

    await openMemory(page);
    const longBody = readMemoryRows(dataDir, "rin").find((row) =>
      row.body.startsWith("长记忆 0 "),
    ).body;
    await selectMemoryByBody(page, longBody);
    let state = await panelState(page);
    assert.equal(state.relayDisabled, true);
    assert.match(state.relayNote, /还没有其他已结识角色/u);
    assert.equal(await page.locator("#memory-relay-target option").first().textContent(), "没有其他已结识角色");
    assert.equal(await page.locator("#memory-character option").first().textContent(), longNickname);
    assert.equal(await page.locator("#memory-sharing-toggle").isVisible(), true);

    for (const [width, height, name] of [
      [1200, 800, "sharing-layout-1200x800.png"],
      [960, 680, "sharing-layout-960x680.png"],
    ]) {
      await setWindowSize(app, width, height);
      const geometry = await panelGeometry(page);
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, `${name.replace(/\.png$/u, "")}-geometry.json`),
        `${JSON.stringify({ width, height, geometry }, null, 2)}\n`,
      );
      await capture(page, name);
      assertPanelGeometry(geometry);
    }

    await page.locator("#memory-sharing-toggle").focus();
    await page.keyboard.press("Enter");
    await waitNotice(page, "已禁止分享这件事");
    state = await panelState(page);
    assert.equal(state.toggle, "允许分享");
    assert.match(state.sharingNote, /已有角色保留原副本/u);
    const keyboardGeometry = await panelGeometry(page);
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "sharing-keyboard-960x680-geometry.json"),
      `${JSON.stringify({ width: 960, height: 680, geometry: keyboardGeometry }, null, 2)}\n`,
    );
    await capture(page, "sharing-keyboard-960x680.png");
    assertPanelGeometry(keyboardGeometry);
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.body === longBody).sharingRestricted,
      true,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishCase({
      caseId: "POL-SHAREUI-006",
      facts: {
        sizes: ["1200x800", "960x680"],
        controlsInsideDialog: true,
        listLocalScroll: true,
        singleCharacterReason: true,
        keyboardToggle: true,
      },
      screenshots: ["sharing-layout-1200x800.png", "sharing-layout-960x680.png", "sharing-keyboard-960x680.png"],
      app,
      server,
      dataDir,
      failure,
    });
  }
});
