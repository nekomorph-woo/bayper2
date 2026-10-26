/* S04e 来源分析接入真实自动机会：真实 Electron、SQLite、本机 HTTP fixture。
   测试只通过设置 IPC 授权/开关，并通过主进程心跳与加速时钟触发机会；
   不直接调用 source-analysis.analyze 冒充应用链路。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createLegacyDatabase, localDay } = require("./s02-fixtures.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const EVIDENCE_ROOT = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s04e-source-automation",
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
    `source: tests/acceptance/source-automation.spec.cjs`,
    `evidence: ${EVIDENCE_DIR}`,
    "",
  ].join("\n"),
);

const KEY = "sk-fixture-auto";
const SENTINEL = "AUTO-SESSION-SECRET";
const DB_FILE = "bayper.sqlite3";

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
    await delay(50);
  }
  assert.fail(message);
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendAssistant(response, content, status = 200) {
  sendJson(response, status, {
    choices: [{ message: { role: "assistant", content } }],
  });
}

function sourceFacts(body) {
  const userMessage = [...(body.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message?.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim().startsWith("{"),
    );
  if (!userMessage) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(userMessage.content);
  } catch {
    return null;
  }
  const source = (payload.sources ?? []).find((item) => item.role === "user");
  if (!source || typeof source.sourceId !== "string" || typeof source.text !== "string") {
    return { facts: [] };
  }
  const evidence = source.text.slice(0, 10);
  return {
    facts: [
      {
        sourceId: source.sourceId,
        factKey: `auto-${source.sourceId.replace(/[^a-zA-Z0-9]/g, "").slice(-24)}`,
        body: `初步记忆：${evidence}`,
        kind: "preference",
        evidence,
      },
    ],
  };
}

async function startAutomationServer() {
  const requests = [];
  const sourceRecords = [];
  const chatRecords = [];
  const checkRecords = [];
  const responders = [];
  const releases = new Set();
  let closed = false;

  function classify(body) {
    const messages = body.messages ?? [];
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    if (system.includes("外部会话来源分析器")) {
      return "source";
    }
    if (messages.length === 1 && messages[0]?.role === "user") {
      return "check";
    }
    return "chat";
  }

  function autoRespond(request, body) {
    const kind = request.kind;
    if (kind === "source") {
      const facts = sourceFacts(body) ?? { facts: [] };
      sendAssistant(request.response, JSON.stringify(facts));
      return;
    }
    if (kind === "check") {
      sendAssistant(request.response, "连接正常。");
      return;
    }
    sendAssistant(
      request.response,
      JSON.stringify({ reply: "聊天收到。", memoryCandidates: [] }),
    );
  }

  const server = http.createServer((incoming, response) => {
    let raw = "";
    incoming.on("data", (chunk) => {
      raw += chunk;
    });
    incoming.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const kind = classify(body ?? {});
      const request = {
        kind,
        body,
        response,
        hasAuthorization: Boolean(incoming.headers.authorization),
        aborted: false,
      };
      requests.push(request);
      if (kind === "source") {
        sourceRecords.push(request);
      } else if (kind === "chat") {
        chatRecords.push(request);
      } else {
        checkRecords.push(request);
      }
      response.on("close", () => {
        if (!response.writableEnded) {
          request.aborted = true;
        }
      });
      const responder = responders.shift();
      Promise.resolve(
        responder ? responder(request) : autoRespond(request, body ?? {}),
      ).catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    sourceRecords,
    chatRecords,
    checkRecords,
    enqueue(responder) {
      responders.push(responder);
    },
    enqueueFailure() {
      responders.push((request) => sendJson(request.response, 500, { error: "fixture" }));
    },
    holdNext() {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const wrapped = () => release;
      releases.add(wrapped);
      responders.push((request) =>
        gate.then(() => {
          releases.delete(wrapped);
          autoRespond(request, request.body ?? {});
        }),
      );
      return {
        release() {
          releases.delete(wrapped);
          release();
        },
      };
    },
    releaseAll() {
      for (const release of [...releases]) {
        release();
      }
      releases.clear();
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      this.releaseAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function dbPath(dataDir) {
  return path.join(dataDir, DB_FILE);
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-auto-"));
}

function makeSourceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-auto-files-"));
  const claudeConfig = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const claudeProjects = path.join(claudeConfig, "projects");
  const codexSessions = path.join(codexHome, "sessions");
  const customCodex = path.join(root, "custom-codex");
  fs.mkdirSync(claudeProjects, { recursive: true });
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.mkdirSync(customCodex, { recursive: true });
  return { root, claudeConfig, codexHome, claudeProjects, codexSessions, customCodex };
}

function writeClaudeSession(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: `user-${marker}`,
      timestamp: "2026-10-26T08:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `${marker} 用户喜欢白茶 ${SENTINEL}` }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: `assistant-${marker}`,
      timestamp: "2026-10-26T08:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "我记住了。" }] },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function writeCodexSession(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: marker } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${marker} 用户喜欢旧书 ${SENTINEL}` }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "好。" }],
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

async function launchApp(ctx, { onboarding = true } = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${ctx.dataDir}`],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: ctx.claudeConfig,
      CODEX_HOME: ctx.codexHome,
      BAYPER_HEARTBEAT_MS: "400",
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

  if (onboarding) {
    await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#base-url").fill(ctx.server.baseUrl);
    await page.locator("#model-name").fill("fixture-auto");
    await page.locator("#api-key").fill(KEY);
    await page.locator("#config-submit").click();
    await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#wish-input").fill("想找安静陪着我的伙伴");
    await page.locator("#wish-submit").click();
    await page.locator("#candidate-card").waitFor({ state: "visible" });
    await page.locator("#accept-button").click();
  }
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
  await installDialogFixture(app);
  return { app, page, logs, consoleLines };
}

async function launchConfigApp(ctx) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${ctx.dataDir}`],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: ctx.claudeConfig,
      CODEX_HOME: ctx.codexHome,
      BAYPER_HEARTBEAT_MS: "400",
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
  await page.locator('[data-step="config"]').waitFor({ state: "visible", timeout: 20000 });
  await installDialogFixture(app);
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
    throw new Error(`应用未在 ${timeout}ms 内退出（实际 app 退出失败）`);
  }
  return {
    status: "exited",
    code: processHandle?.exitCode ?? null,
    signal: processHandle?.signalCode ?? null,
  };
}

async function installDialogFixture(app) {
  await app.evaluate(({ dialog }) => {
    const state = {
      confirmResponse: 1,
      openResult: { canceled: true, filePaths: [] },
      confirmCalls: [],
      openCalls: [],
    };
    globalThis.__sourceAutoDialog = state;
    dialog.showMessageBox = async (_window, options) => {
      state.confirmCalls.push(options);
      return { response: state.confirmResponse, checkboxChecked: false };
    };
    dialog.showOpenDialog = async (_window, options) => {
      state.openCalls.push(options);
      return state.openResult;
    };
  });
}

async function setDialogOpen(app, filePath) {
  await app.evaluate((_electron, target) => {
    globalThis.__sourceAutoDialog.openResult = { canceled: false, filePaths: [target] };
  }, filePath);
}

async function authorizeDefault(page) {
  const result = await page.evaluate(() =>
    window.bayperSources.authorizeCandidate("claude-code"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function authorizeCodexCustom(app, page, directory) {
  await setDialogOpen(app, directory);
  const result = await page.evaluate(() =>
    window.bayperSources.chooseDirectory("codex"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function setAnalysis(page, enabled) {
  const result = await page.evaluate(
    (value) => window.bayperSources.setEnabled(value),
    enabled,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function sourceState(page) {
  const result = await page.evaluate(() => window.bayperSources.getState());
  assert.equal(result.ok, true);
  return result.state;
}

async function waitForMemory(page, count, timeout = 15000) {
  await waitFor(
    async () => {
      const result = await page.evaluate(() =>
        window.bayperMemory.listMemories({ characterId: "rin", page: 0 }),
      );
      return result.ok === true && result.entries.length >= count;
    },
    timeout,
    "初步记忆未在预期时间落库",
  );
}

async function patchClock(app, offsetMs, randomValue = 0.1) {
  await app.evaluate(
    (_electron, input) => {
      if (!globalThis.__sourceAutoClock) {
        const realNow = Date.now.bind(Date);
        globalThis.__sourceAutoClock = { base: realNow(), now: realNow() };
        Date.now = () => globalThis.__sourceAutoClock.now;
      }
      globalThis.__sourceAutoClock.now = globalThis.__sourceAutoClock.base + input.offset;
      Math.random = () => input.random;
    },
    { offset: offsetMs, random: randomValue },
  );
}

function readDb(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const state = (key) =>
      db.prepare("SELECT value FROM app_state WHERE key = ?").get(key)?.value ?? null;
    return {
      memory: db
        .prepare("SELECT id, character_id, body, trust FROM memory_entries ORDER BY created_at, id")
        .all(),
      budget: db
        .prepare(
          "SELECT id, request_id, character_id, status, sent, sent_at FROM automatic_budget_attempts ORDER BY created_at, id",
        )
        .all(),
      grants: db
        .prepare("SELECT id, provider, display_path, status FROM external_source_grants ORDER BY created_at, id")
        .all(),
      processed: db
        .prepare("SELECT character_id, source_id FROM source_analysis_processed")
        .all(),
      cursor: (() => {
        const raw = state("source_analysis_cursor");
        if (!raw) {
          return null;
        }
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })(),
      lastOpportunity: state("automatic_opportunity_last_eval_at"),
      nextOpportunity: state("automatic_opportunity_next_at"),
      energy: db.prepare("SELECT character_id, energy FROM character_stats ORDER BY character_id").all(),
      chatConversations: db
        .prepare("SELECT id, character_id, closed_at FROM chat_conversations ORDER BY created_at, id")
        .all(),
      chatMessages: db
        .prepare("SELECT id, conversation_id, role, content FROM chat_messages ORDER BY created_at, id")
        .all(),
      chatRequests: db
        .prepare(
          "SELECT id, conversation_id, status, assistant_message_id FROM chat_requests ORDER BY created_at, id",
        )
        .all(),
      sourceEnabled:
        db
          .prepare("SELECT value FROM external_source_state WHERE key = 'analysis_enabled'")
          .get()?.value ?? "0",
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

function setCursor(dataDir, directoryId, relativePath, files = null) {
  const db = openWriteDb(dataDir);
  try {
    const payload =
      files && typeof files === "object"
        ? { directoryId, relativePath, files }
        : { directoryId, relativePath };
    db.prepare(`
      INSERT INTO app_state (key, value) VALUES ('source_analysis_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(payload));
  } finally {
    db.close();
  }
}

function setEnergy(dataDir, characterId, energy) {
  const db = openWriteDb(dataDir);
  try {
    db.prepare("UPDATE character_stats SET energy = ? WHERE character_id = ?").run(
      energy,
      characterId,
    );
  } finally {
    db.close();
  }
}

function seedSentBudget(dataDir, characterId, sentAt) {
  const db = openWriteDb(dataDir);
  try {
    const id = `seed-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO automatic_budget_attempts
        (id, request_id, character_id, created_at, updated_at, status, sent, sent_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'success', 1, ?, ?)
    `).run(id, id, characterId, sentAt - 1000, sentAt, sentAt, sentAt);
  } finally {
    db.close();
  }
}

async function deleteMemoryByMarker(page, marker) {
  const result = await page.evaluate(async (needle) => {
    const list = await window.bayperMemory.listMemories({ characterId: "rin", page: 0 });
    if (!list.ok) {
      return list;
    }
    const entry = list.entries.find((item) => item.body.includes(needle));
    if (!entry) {
      return { ok: false, error: { message: "memory not found" } };
    }
    return window.bayperMemory.forgetMemory({
      characterId: "rin",
      entryId: entry.id,
      expectedVersion: entry.version,
      scope: "all",
    });
  }, marker);
  assert.equal(result.ok, true, JSON.stringify(result));
}

function sourceMarkers(record) {
  const userMessage = [...(record.body?.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message?.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim().startsWith("{"),
    );
  if (!userMessage) {
    return [];
  }
  try {
    const payload = JSON.parse(userMessage.content);
    return (payload.sources ?? [])
      .filter((source) => source.role === "user")
      .map((source) => String(source.text).slice(0, 4));
  } catch {
    return [];
  }
}

function writeLog(name, launched, failure, cleanupErrors, appExit) {
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

async function cleanupResources({ caseName, launched, ctx, failure, cleanupErrors = [] }) {
  const errors = [...cleanupErrors];
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
  try {
    ctx.server.releaseAll();
    await withTimeout(ctx.server.close(), 5000, "fixture HTTP server 未在 5s 内关闭");
  } catch (error) {
    errors.push(error);
  }
  for (const directory of [ctx.dataDir, ctx.root]) {
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
  writeLog(caseName, launched, failure, errors, appExit);
  if (!failure && errors.length > 0) {
    throw errors[0];
  }
}

async function makeContext({ legacy = false } = {}) {
  const dataDir = makeDataDir();
  const source = makeSourceRoot();
  const server = await startAutomationServer();
  const ctx = { dataDir, server, ...source };
  if (legacy) {
    createLegacyDatabase(dataDir, {
      characters: [{ id: "rin", acceptedAt: "2026-10-01T00:00:00.000Z" }],
      modelCipher: Buffer.from([1, 2, 3, 4]),
      baseUrl: server.baseUrl,
      modelName: "fixture-auto",
      fixedId: "rin",
      currentId: "rin",
      rosterDay: localDay(new Date()),
    });
  }
  return ctx;
}

test("POL-SOURCE-AUTO-001 默认关闭不读取，开启后经心跳产生一次分析与初步记忆", { timeout: 90000 }, async () => {
  const ctx = await makeContext();
  const trace = { consoleLines: [], logs: [] };
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "a001.jsonl"), "A001");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    trace.consoleLines = launched.consoleLines;
    trace.logs = launched.logs;
    await authorizeDefault(page);
    assert.equal((await sourceState(page)).enabled, false);

    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(800);
    await patchClock(app, 61 * 60 * 1000, 0.1);
    await delay(800);
    assert.equal(ctx.server.sourceRecords.length, 0, "默认关闭不得读取/请求来源");
    assert.equal(readDb(ctx.dataDir).memory.length, 0);
    assert.equal(readDb(ctx.dataDir).budget.length, 0);

    await setAnalysis(page, true);
    await patchClock(app, 91 * 60 * 1000, 0.1);
    await waitFor(() => ctx.server.sourceRecords.length === 1, 15000, "开启后未产生来源请求");
    await waitForMemory(page, 1);

    const db = readDb(ctx.dataDir);
    assert.equal(db.sourceEnabled, "1");
    assert.equal(db.memory.length, 1);
    assert.match(db.memory[0].body, /A001/);
    assert.equal(db.memory[0].trust, "inferred");
    assert.equal(db.memory[0].character_id, "rin");
    assert.equal(db.processed.length, 1);
    assert.equal(db.budget.length, 1);
    assert.equal(db.budget[0].sent, 1);
    assert.equal(db.budget[0].status, "success");
    assert.equal(ctx.server.sourceRecords[0].kind, "source");
    assert.equal(ctx.server.sourceRecords[0].hasAuthorization, true);
    assert.ok(sourceMarkers(ctx.server.sourceRecords[0]).includes("A001"));

    const listed = await page.evaluate(() =>
      window.bayperMemory.listMemories({ characterId: "rin", page: 0 }),
    );
    assert.equal(listed.ok, true);
    assert.ok(listed.entries.some((entry) => entry.body.includes("A001")));
    await page.locator("#memory-open").click();
    await page.locator("#memory-overlay").waitFor({ state: "visible" });
    await page.locator(".memory-entry-body").filter({ hasText: "A001" }).first().waitFor({
      state: "visible",
      timeout: 10000,
    });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    const unauthorized = await page.evaluate(() => window.bayperSources.getState());
    assert.equal(unauthorized.ok, true, JSON.stringify(unauthorized));
    const unauthorizedText = JSON.stringify(unauthorized);
    assert.equal(unauthorizedText.includes(SENTINEL), false);
    assert.equal(unauthorizedText.includes(KEY), false);
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(logs.includes(KEY), false, "日志不得包含 Key");
    assert.equal(logs.includes(SENTINEL), false, "日志不得包含未授权会话正文");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-001",
      launched,
      ctx,
      failure,
    });
  }
});

async function triggerHeldSource(app, server, offsetMs, expectedCount) {
  const hold = server.holdNext();
  await patchClock(app, offsetMs, 0.1);
  await waitFor(
    () => server.sourceRecords.length >= expectedCount,
    15000,
    `第 ${expectedCount} 次来源请求未出现`,
  );
  return hold;
}

test("POL-SOURCE-AUTO-002 关闭/撤销/聊天/锁屏取消迟到响应且不发布", { timeout: 120000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "b002.jsonl"), "B002");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);

    // 关分析开关：迟到响应不发布。
    const first = await triggerHeldSource(app, ctx.server, 31 * 60 * 1000, 1);
    await setAnalysis(page, false);
    first.release();
    await delay(600);
    const afterOff = readDb(ctx.dataDir);
    assert.equal(afterOff.memory.length, 0);
    assert.equal(afterOff.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(afterOff.budget[0].status, "cancelled");

    // 重新开启不立即补抽。
    await setAnalysis(page, true);
    const afterReenable = ctx.server.sourceRecords.length;
    await delay(800);
    assert.equal(ctx.server.sourceRecords.length, afterReenable, "重新开启不得立即补抽");

    // 撤销授权：迟到响应不发布。
    const second = await triggerHeldSource(app, ctx.server, 3 * 60 * 60 * 1000 + 6 * 60 * 1000, 2);
    const grant = readDb(ctx.dataDir).grants.find(
      (item) => item.provider === "claude-code" && item.status === "active",
    );
    assert.ok(grant);
    const revoked = await page.evaluate(
      (grantId) => window.bayperSources.revoke(grantId),
      grant.id,
    );
    assert.equal(revoked.ok, true);
    second.release();
    await delay(600);
    assert.equal(readDb(ctx.dataDir).memory.length, 0);
    assert.equal(
      readDb(ctx.dataDir).grants.find((item) => item.id === grant.id).status,
      "revoked",
    );

    // 重新授权后用聊天取消；显式聊天不消耗自动预算。
    await authorizeDefault(page);
    const third = await triggerHeldSource(app, ctx.server, 5 * 60 * 60 * 1000 + 11 * 60 * 1000, 3);
    const chatOpen = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chatOpen.ok, true);
    third.release();
    await delay(600);
    assert.equal(readDb(ctx.dataDir).memory.length, 0);
    const budgetBeforeChat = readDb(ctx.dataDir).budget.length;
    const chatRequest = await page.evaluate(async () => {
      const requestId = crypto.randomUUID();
      return window.bayperChat.sendChatMessage({
        characterId: "rin",
        text: "你好，这段是显式聊天。",
        requestId,
      });
    });
    assert.equal(chatRequest.ok, true);
    await waitFor(() => ctx.server.chatRecords.length >= 1, 15000, "显式聊天未走模型请求");
    assert.equal(readDb(ctx.dataDir).budget.length, budgetBeforeChat, "显式聊天不得占用自动预算");
    const chatClose = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(chatClose.ok, true);
    const afterChatSourceCount = ctx.server.sourceRecords.length;
    await delay(1200);
    assert.equal(
      ctx.server.sourceRecords.length,
      afterChatSourceCount,
      "聊天结束后不得立即补抽",
    );

    // 锁屏取消；解锁后也不立即补抽。
    const fourth = await triggerHeldSource(app, ctx.server, 7 * 60 * 60 * 1000 + 16 * 60 * 1000, 4);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    fourth.release();
    await delay(600);
    assert.equal(readDb(ctx.dataDir).memory.length, 0);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    const afterLockCount = ctx.server.sourceRecords.length;
    await delay(1200);
    assert.equal(
      ctx.server.sourceRecords.length,
      afterLockCount,
      "解锁后不得立即补抽",
    );

    // 原因叠加：单独解除锁屏但仍有 suspend 时不得恢复；全部解除也不立即补抽。
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
      powerMonitor.emit("lock-screen");
      powerMonitor.emit("unlock-screen");
    });
    const stackCount = ctx.server.sourceRecords.length;
    await delay(900);
    assert.equal(ctx.server.sourceRecords.length, stackCount, "其他暂停原因未解除时不得恢复");
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    await delay(900);
    assert.equal(ctx.server.sourceRecords.length, stackCount, "全部原因解除后不得立即补抽");

    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 0);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 4);
    assert.ok(db.budget.every((row) => row.status === "cancelled"));
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(SENTINEL), false);
    // 等真实 IPC 返回值，而不是把 Promise 序列化成 {} 后自证。
    const sourceView = await page.evaluate(() => window.bayperSources.getState());
    assert.equal(sourceView.ok, true, JSON.stringify(sourceView));
    assert.equal(typeof sourceView.state, "object");
    assert.equal(Array.isArray(sourceView.state.candidates), true);
    const claudeCandidate = sourceView.state.candidates.find(
      (candidate) => candidate.provider === "claude-code",
    );
    assert.ok(claudeCandidate, "来源状态应包含真实的 Claude 候选目录");
    assert.equal(typeof claudeCandidate.displayPath, "string");
    assert.ok(path.isAbsolute(claudeCandidate.displayPath), "来源目录应是非空真实路径");
    assert.equal(typeof claudeCandidate.label, "string");
    assert.ok(claudeCandidate.label.length > 0);
    const sourceStateText = JSON.stringify(sourceView);
    assert.equal(sourceStateText.includes(SENTINEL), false);
    assert.equal(sourceStateText.includes(KEY), false);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-002",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-002b 聊天中锁屏与解锁叠加，关闭聊天后才恢复来源机会", { timeout: 90000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "combo-002b.jsonl"), "C002");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);

    // 先进入聊天：来源自动入口暂停，随后锁屏再叠加系统原因。
    const chatOpen = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chatOpen.ok, true, JSON.stringify(chatOpen));
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await delay(300);
    const locked = await page.evaluate(() => window.bayper.getSystemStatus());
    assert.equal(locked.ok, true);
    assert.equal(locked.paused, true);
    assert.ok(locked.reasons.includes("lock"));

    // 解锁时仍聊天：机会到期也不得恢复自动来源。
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(300);
    const unlocked = await page.evaluate(() => window.bayper.getSystemStatus());
    assert.equal(unlocked.ok, true);
    assert.equal(unlocked.paused, false);
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 0, "解锁但仍在聊天时不得恢复来源机会");

    // 聊天跨锁屏保留；关闭聊天才清除最后的暂停原因。
    const chatClose = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(chatClose.ok, true, JSON.stringify(chatClose));
    assert.equal(chatClose.closed, true, "锁屏不得关闭仍在进行的聊天");
    const afterCloseCount = ctx.server.sourceRecords.length;
    await delay(900);
    assert.equal(ctx.server.sourceRecords.length, afterCloseCount, "关闭聊天不得立即补抽");

    // 全部原因解除后从下一个机会窗口恢复，只处理一份来源。
    await patchClock(app, 62 * 60 * 1000, 0.1);
    await waitFor(
      () => ctx.server.sourceRecords.length === 1,
      15000,
      "关闭聊天并解除锁屏后未在下一个机会恢复来源",
    );
    await waitForMemory(page, 1);
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 1);
    assert.match(db.memory[0].body, /C002/);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(db.budget[0].status, "success");
    assert.ok(sourceMarkers(ctx.server.sourceRecords[0]).includes("C002"));
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(SENTINEL), false);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-002b",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-002c 系统暂停取消在途聊天但保留会话与互动", { timeout: 90000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "lifecycle-002c.jsonl"), "D002");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);

    const chatOpen = await page.evaluate(() => window.bayperChat.openChat("rin"));
    assert.equal(chatOpen.ok, true, JSON.stringify(chatOpen));
    const requestId = "c002-inflight";
    const held = ctx.server.holdNext();
    const sendPromise = page
      .evaluate(
        (id) =>
          window.bayperChat.sendChatMessage({
            characterId: "rin",
            text: "锁屏前正在发送的消息",
            requestId: id,
          }),
        requestId,
      )
      .catch((error) => ({
        ok: false,
        error: { code: "EVALUATE_FAILED", message: error?.message ?? String(error) },
      }));
    await waitFor(() => ctx.server.chatRecords.length === 1, 15000, "在途聊天请求未发出");
    const beforeLock = readDb(ctx.dataDir);
    assert.equal(beforeLock.chatRequests.length, 1);
    assert.equal(beforeLock.chatRequests[0].status, "pending");
    assert.equal(beforeLock.chatMessages.filter((row) => row.role === "assistant").length, 0);

    // 锁屏：取消在途请求，但保留会话、用户消息与陪伴互动。
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
    await waitFor(
      () => readDb(ctx.dataDir).chatRequests[0]?.status === "cancelled",
      3000,
      "锁屏未取消在途聊天请求",
    );
    const afterLock = readDb(ctx.dataDir);
    assert.equal(afterLock.chatRequests[0].status, "cancelled");
    assert.equal(afterLock.chatRequests[0].assistant_message_id, null);
    assert.equal(afterLock.chatConversations.length, 1);
    assert.equal(afterLock.chatConversations[0].closed_at, null, "系统暂停不得关闭聊天会话");
    assert.equal(afterLock.chatMessages.filter((row) => row.role === "user").length, 1);
    assert.equal(afterLock.chatMessages.filter((row) => row.role === "assistant").length, 0);
    const lockedSnapshot = await page.evaluate(() => window.bayper.getSnapshot());
    assert.equal(lockedSnapshot.ok, true, JSON.stringify(lockedSnapshot));
    const lockedCompanion = lockedSnapshot.snapshot.companionship;
    assert.equal(lockedCompanion.interaction?.characterId, "rin", "系统暂停不得解除互动");
    assert.equal(lockedCompanion.current?.mode, "interacting");
    assert.equal(
      lockedCompanion.characters.find((character) => character.characterId === "rin")?.mode,
      "interacting",
    );

    // 迟到响应不得补写助手回复；原发送调用以 cancelled 结束。
    held.release();
    const sendResult = await withTimeout(sendPromise, 15000, "取消后的聊天调用未结束");
    assert.equal(sendResult.ok, true, JSON.stringify(sendResult));
    assert.equal(sendResult.result.status, "cancelled");
    assert.equal(sendResult.result.reply, null);
    await delay(600);
    const afterLate = readDb(ctx.dataDir);
    assert.equal(afterLate.chatRequests[0].status, "cancelled");
    assert.equal(afterLate.chatMessages.filter((row) => row.role === "assistant").length, 0);

    // 暂停期间 send/retry 拒绝且不产生新 HTTP。
    const chatCountAtPause = ctx.server.chatRecords.length;
    const pausedSend = await page.evaluate(() =>
      window.bayperChat.sendChatMessage({
        characterId: "rin",
        text: "暂停期间不应发送",
        requestId: "c002-paused-send",
      }),
    );
    assert.equal(pausedSend.ok, false, JSON.stringify(pausedSend));
    assert.equal(pausedSend.error.code, "SYSTEM_PAUSED");
    const pausedRetry = await page.evaluate(
      (id) => window.bayperChat.retryChatMessage({ characterId: "rin", requestId: id }),
      requestId,
    );
    assert.equal(pausedRetry.ok, false, JSON.stringify(pausedRetry));
    assert.equal(pausedRetry.error.code, "SYSTEM_PAUSED");
    assert.equal(ctx.server.chatRecords.length, chatCountAtPause, "暂停期间不得新增聊天 HTTP");
    assert.equal(readDb(ctx.dataDir).chatMessages.filter((row) => row.role === "user").length, 1);

    // 解锁仍聊天：会话与互动保留，来源机会仍暂停。
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await delay(300);
    const unlockedSnapshot = await page.evaluate(() => window.bayper.getSnapshot());
    assert.equal(unlockedSnapshot.snapshot.companionship.interaction?.characterId, "rin");
    assert.equal(unlockedSnapshot.snapshot.companionship.current?.mode, "interacting");
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 0, "解锁但仍在聊天时不得恢复来源机会");

    // 用户关闭聊天后互动结束，来源从下一个机会窗口恢复。
    const chatClose = await page.evaluate(() => window.bayperChat.closeChat());
    assert.equal(chatClose.ok, true, JSON.stringify(chatClose));
    assert.equal(chatClose.closed, true);
    const closedDb = readDb(ctx.dataDir);
    assert.ok(closedDb.chatConversations[0].closed_at !== null, "用户关闭后会话应关闭");
    const closedSnapshot = await page.evaluate(() => window.bayper.getSnapshot());
    assert.equal(closedSnapshot.snapshot.companionship.interaction, null);
    assert.notEqual(closedSnapshot.snapshot.companionship.current?.mode, "interacting");
    const afterCloseCount = ctx.server.sourceRecords.length;
    await delay(900);
    assert.equal(ctx.server.sourceRecords.length, afterCloseCount, "关闭聊天不得立即补抽");

    await patchClock(app, 62 * 60 * 1000, 0.1);
    await waitFor(
      () => ctx.server.sourceRecords.length === 1,
      15000,
      "关闭聊天并解除锁屏后未在下一个机会恢复来源",
    );
    await waitForMemory(page, 1);
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 1);
    assert.match(db.memory[0].body, /D002/);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(db.budget[0].status, "success");
    assert.ok(sourceMarkers(ctx.server.sourceRecords[0]).includes("D002"));
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(SENTINEL), false);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-002c",
      launched,
      ctx,
      failure,
    });
  }
});

function activeGrantId(dataDir, provider) {
  const grant = readDb(dataDir).grants.find(
    (item) => item.provider === provider && item.status === "active",
  );
  assert.ok(grant, `缺少 ${provider} 的有效授权`);
  return grant.id;
}

test("POL-SOURCE-AUTO-003 多目录轮转、删除/改写/坏文件与重启保留", { timeout: 120000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    const claudeFiles = {
      R001: { relativePath: "rot-a.jsonl", provider: "claude-code" },
      R002: { relativePath: "rot-b.jsonl", provider: "claude-code" },
    };
    const codexFiles = {
      R003: { relativePath: "2026/10/26/rollout-a.jsonl", provider: "codex" },
      R004: { relativePath: "2026/10/26/rollout-b.jsonl", provider: "codex" },
    };
    writeClaudeSession(path.join(ctx.claudeProjects, claudeFiles.R001.relativePath), "R001");
    writeClaudeSession(path.join(ctx.claudeProjects, claudeFiles.R002.relativePath), "R002");
    writeCodexSession(path.join(ctx.customCodex, codexFiles.R003.relativePath), "R003");
    writeCodexSession(path.join(ctx.customCodex, codexFiles.R004.relativePath), "R004");

    launched = await launchApp(ctx);
    let { app, page } = launched;
    await authorizeDefault(page);
    await authorizeCodexCustom(app, page, ctx.customCodex);
    await setAnalysis(page, true);

    const offsets = [31, 3 * 60 + 6, 5 * 60 + 11, 7 * 60 + 16].map(
      (minutes) => minutes * 60 * 1000,
    );
    for (let index = 0; index < offsets.length; index += 1) {
      await patchClock(app, offsets[index], 0.1);
      await waitFor(
        () => ctx.server.sourceRecords.length >= index + 1,
        15000,
        `轮转第 ${index + 1} 次来源请求未出现`,
      );
      await waitForMemory(page, index + 1);
    }

    const markerByFile = { ...claudeFiles, ...codexFiles };
    const observedMarkers = ctx.server.sourceRecords.map((record) => sourceMarkers(record)[0]);
    assert.equal(observedMarkers.length, 4);
    assert.equal(new Set(observedMarkers).size, 4, "连续机会应轮转到不同文件");
    let db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 4);
    assert.equal(db.processed.length, 4);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 4);
    assert.ok(db.memory.every((entry) => entry.trust === "inferred"));

    // 删除第一条初步记忆后，把游标放回同一文件；不得学回或重新请求。
    const deletedMarker = observedMarkers[0];
    await deleteMemoryByMarker(page, deletedMarker);
    const deletedFile = markerByFile[deletedMarker];
    setCursor(ctx.dataDir, activeGrantId(ctx.dataDir, deletedFile.provider), deletedFile.relativePath);
    await patchClock(app, offsets[3] + 2 * 60 * 60 * 1000 + 5 * 60 * 1000, 0.1);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 4, "删除后的同源不得重新请求");
    assert.equal(readDb(ctx.dataDir).memory.length, 3);

    // 改写已处理文件区域后，同文件不得再次请求或发布。
    const editedFile = markerByFile[observedMarkers[1]];
    const editedPath = path.join(
      editedFile.provider === "claude-code" ? ctx.claudeProjects : ctx.customCodex,
      editedFile.relativePath,
    );
    fs.writeFileSync(
      editedPath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-EDITED-R002",
        message: {
          role: "user",
          content: [{ type: "text", text: "EDITED-R002 用户改了记录" }],
        },
      })}\n`,
    );
    setCursor(ctx.dataDir, activeGrantId(ctx.dataDir, editedFile.provider), editedFile.relativePath);
    await patchClock(app, offsets[3] + 4 * 60 * 60 * 1000 + 10 * 60 * 1000, 0.1);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 4, "改写区域不得重新请求");
    assert.equal(readDb(ctx.dataDir).memory.length, 3);

    // 坏文件只消耗一次选择并推进游标，不无限同步重试。
    fs.writeFileSync(path.join(ctx.claudeProjects, "bad.jsonl"), "{not-json}\n");
    // 将游标放在 Codex 授权目录的最后一份文件，使下一份候选是 Claude 的坏文件。
    const codexGrant = activeGrantId(ctx.dataDir, "codex");
    setCursor(ctx.dataDir, codexGrant, codexFiles.R004.relativePath);
    await patchClock(app, offsets[3] + 6 * 60 * 60 * 1000 + 15 * 60 * 1000, 0.1);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 4, "坏文件不得发模型请求");
    const afterBadCursor = readDb(ctx.dataDir).cursor;
    assert.equal(afterBadCursor?.relativePath, "bad.jsonl", "坏文件应被选择并推进游标");
    await patchClock(app, offsets[3] + 8 * 60 * 60 * 1000 + 20 * 60 * 1000, 0.1);
    await delay(1500);
    const nextCursor = readDb(ctx.dataDir).cursor;
    assert.notEqual(nextCursor?.relativePath, "bad.jsonl", "坏文件后游标应继续推进");
    assert.equal(ctx.server.sourceRecords.length, 4);

    db = readDb(ctx.dataDir);
    const preservedBudget = db.budget.filter((row) => row.sent === 1).length;
    const preservedProcessed = db.processed.length;
    const preservedCursor = db.cursor;
    const preservedMemory = db.memory.length;
    assert.equal(preservedBudget, 4);
    assert.equal(preservedProcessed, 4);
    assert.equal(preservedMemory, 3);

    // 真正关库重开：额度、游标、去重保留，但不补离线任务。
    await closeApp(app);
    launched = null;
    launched = await launchApp(ctx, { onboarding: false });
    ({ app, page } = launched);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 4, "重开不得立即补做离线任务");
    db = readDb(ctx.dataDir);
    assert.equal(db.sourceEnabled, "1");
    assert.equal(db.budget.filter((row) => row.sent === 1).length, preservedBudget);
    assert.equal(db.processed.length, preservedProcessed);
    assert.deepEqual(db.cursor, preservedCursor);
    assert.equal(db.memory.length, preservedMemory);
    assert.ok(db.grants.filter((grant) => grant.status === "active").length >= 2);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-003",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-005 满额目录不饿死后续目录，目录与文件游标跨重开保留", { timeout: 180000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    // 目录 A 占满单次聚合候选容量；目录 B 只有一份不同来源的会话。
    const FULL_COUNT = 200;
    for (let index = 0; index < FULL_COUNT; index += 1) {
      const suffix = String(index).padStart(3, "0");
      writeClaudeSession(
        path.join(ctx.claudeProjects, `full-${suffix}.jsonl`),
        `A${suffix}`,
      );
    }
    const singlePath = "2026/10/26/rollout-only-b.jsonl";
    writeCodexSession(path.join(ctx.customCodex, singlePath), "B005");
    const emptyCodex = path.join(ctx.root, "empty-codex");
    fs.mkdirSync(emptyCodex, { recursive: true });

    launched = await launchApp(ctx);
    let { app, page } = launched;
    const defaultGrant = await authorizeDefault(page);
    const codexGrant = await authorizeCodexCustom(app, page, ctx.customCodex);
    const emptyGrant = await authorizeCodexCustom(app, page, emptyCodex);
    const fullId = defaultGrant.grant.id;
    const singleId = codexGrant.grant.id;
    const emptyId = emptyGrant.grant.id;
    assert.notEqual(fullId, singleId);

    // 从满额目录第一份文件之后继续；旧聚合候选算法只会继续 A 的第二份。
    setCursor(ctx.dataDir, fullId, "full-000.jsonl");
    await setAnalysis(page, true);
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await waitFor(
      () => ctx.server.sourceRecords.length === 1,
      15000,
      "首次机会未处理任何来源",
    );
    const firstMarkers = sourceMarkers(ctx.server.sourceRecords[0]);
    assert.ok(firstMarkers.includes("B005"), `满额目录 A 饿死了目录 B：${firstMarkers}`);
    await waitForMemory(page, 1);

    const afterFirst = readDb(ctx.dataDir);
    assert.equal(afterFirst.cursor.directoryId, singleId);
    assert.equal(afterFirst.cursor.relativePath, singlePath);
    assert.equal(afterFirst.cursor.files[fullId], "full-000.jsonl");
    assert.equal(afterFirst.cursor.files[singleId], singlePath);
    assert.equal(afterFirst.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(afterFirst.memory.length, 1);

    // 真正关库重开：目录/文件游标原样保留，不立即补做离线任务。
    const preservedCursor = afterFirst.cursor;
    await closeApp(app);
    launched = null;
    launched = await launchApp(ctx, { onboarding: false });
    ({ app, page } = launched);
    await delay(1500);
    assert.equal(ctx.server.sourceRecords.length, 1, "重开不得立即补做离线任务");
    let db = readDb(ctx.dataDir);
    assert.equal(db.sourceEnabled, "1");
    assert.deepEqual(db.cursor, preservedCursor);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 1);
    assert.equal(db.processed.length, 1);
    assert.equal(db.memory.length, 1);

    // 从 B 之后继续轮转回 A，并使用 A 自己的文件游标（不是重新从第一份开始）。
    await patchClock(app, 3 * 60 * 60 * 1000 + 6 * 60 * 1000, 0.1);
    await waitFor(
      () => ctx.server.sourceRecords.length === 2,
      15000,
      "目录轮转未回到后续目录",
    );
    assert.ok(sourceMarkers(ctx.server.sourceRecords[1]).includes("A001"));
    await waitForMemory(page, 2);
    db = readDb(ctx.dataDir);
    assert.equal(db.cursor.files[fullId], "full-001.jsonl");

    // 空目录也推进游标，不会永久停在空目录或阻止后续目录。
    const filesBeforeEmpty = readDb(ctx.dataDir).cursor.files;
    setCursor(ctx.dataDir, emptyId, "", filesBeforeEmpty);
    await patchClock(app, 5 * 60 * 60 * 1000 + 11 * 60 * 1000, 0.1);
    await waitFor(
      () => readDb(ctx.dataDir).cursor?.directoryId !== emptyId,
      15000,
      "空目录永久阻止了后续目录",
    );
    db = readDb(ctx.dataDir);
    assert.notEqual(db.cursor.directoryId, emptyId);
    assert.match(db.cursor.files[fullId] ?? "", /^full-00[12]\.jsonl$/);
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(SENTINEL), false);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-005",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004a 模型凭据失效时不发送", { timeout: 60000 }, async () => {
  const ctx = await makeContext({ legacy: true });
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "cred.jsonl"), "C001");
    launched = await launchApp(ctx, { onboarding: false });
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1800);
    const db = readDb(ctx.dataDir);
    assert.equal(ctx.server.sourceRecords.length, 0, "失效凭据不得发模型请求");
    assert.equal(db.memory.length, 0);
    assert.equal(db.budget.filter((row) => row.sent === 1).length, 0);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004a",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004a2 模型配置缺失时不发送", { timeout: 60000 }, async () => {
  const ctx = await makeContext({ legacy: true });
  let launched = null;
  let failure = null;
  try {
    const db = openWriteDb(ctx.dataDir);
    try {
      db.prepare("DELETE FROM model_config").run();
    } finally {
      db.close();
    }
    writeClaudeSession(path.join(ctx.claudeProjects, "missing-model.jsonl"), "M001");
    launched = await launchConfigApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1800);
    assert.equal(ctx.server.sourceRecords.length, 0, "模型缺失不得读取或发送");
    const dbState = readDb(ctx.dataDir);
    assert.equal(dbState.memory.length, 0);
    assert.equal(dbState.budget.length, 0);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004a2",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004b 模型 HTTP 失败只消耗一次已发送尝试且不重试", { timeout: 60000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "fail.jsonl"), "F001");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);
    ctx.server.enqueueFailure();
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await waitFor(() => ctx.server.sourceRecords.length === 1, 15000, "失败请求未发出");
    await delay(1200);
    assert.equal(ctx.server.sourceRecords.length, 1, "同一机会不得换文件重试");
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 0);
    const sent = db.budget.filter((row) => row.sent === 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, "failed");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004b",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004c 预算耗尽时不发送", { timeout: 60000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "budget.jsonl"), "P001");
    launched = await launchApp(ctx);
    await authorizeDefault(launched.page);
    await setAnalysis(launched.page, true);
    await closeApp(launched.app);
    launched = null;
    seedSentBudget(ctx.dataDir, "rin", Date.now() + 30 * 60 * 1000);
    launched = await launchApp(ctx, { onboarding: false });
    const { app, page } = launched;
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1800);
    assert.equal(ctx.server.sourceRecords.length, 0, "预算耗尽不得发模型请求");
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 0);
    assert.equal(db.budget.length, 1);
    assert.equal(db.budget[0].sent, 1);
    assert.equal(db.budget[0].character_id, "rin");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004c",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004d 无合资格角色时不发送", { timeout: 60000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "eligible.jsonl"), "E001");
    launched = await launchApp(ctx);
    await authorizeDefault(launched.page);
    await setAnalysis(launched.page, true);
    await closeApp(launched.app);
    launched = null;
    setEnergy(ctx.dataDir, "rin", 10);
    launched = await launchApp(ctx, { onboarding: false });
    const { app, page } = launched;
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await delay(1800);
    assert.equal(ctx.server.sourceRecords.length, 0, "无合资格角色不得发模型请求");
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 0);
    assert.equal(db.budget.length, 0);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004d",
      launched,
      ctx,
      failure,
    });
  }
});

test("POL-SOURCE-AUTO-004e 退出期间迟到 HTTP 不落库且有界退出", { timeout: 60000 }, async () => {
  const ctx = await makeContext();
  let launched = null;
  let failure = null;
  try {
    writeClaudeSession(path.join(ctx.claudeProjects, "exit.jsonl"), "X001");
    launched = await launchApp(ctx);
    const { app, page } = launched;
    await authorizeDefault(page);
    await setAnalysis(page, true);
    const hold = ctx.server.holdNext();
    await patchClock(app, 31 * 60 * 1000, 0.1);
    await waitFor(() => ctx.server.sourceRecords.length === 1, 15000, "退出前请求未发出");
    const exit = await closeApp(app);
    launched.exit = exit;
    hold.release();
    await delay(500);
    const db = readDb(ctx.dataDir);
    assert.equal(db.memory.length, 0, "退出期间迟到响应不得落库");
    const logs = [...launched.consoleLines, ...launched.logs].join("\n");
    assert.equal(/UnhandledPromiseRejection|uncaughtException/i.test(logs), false);
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(SENTINEL), false);
    assert.equal(exit.status, "exited");
    assert.equal(exit.code, 0);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupResources({
      caseName: "source-automation-004e",
      launched,
      ctx,
      failure,
    });
  }
});
