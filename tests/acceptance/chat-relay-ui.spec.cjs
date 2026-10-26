/* S03g 正式 GUI 验收：真实 Electron main/preload/renderer/SQLite + 本机受控 HTTP。
   单 Case 覆盖明确转告、“琥珀的朋友”反例、真实记忆来源和重启持久；不复制服务大矩阵。
   不读 .env、不调用真实 API、不直接 IPC 代替用户发送。
   失败也保留 run.json、请求、DB 摘要和截图；finally 顺序执行全部清理步骤。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
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
const POSITIVE_TEXT = "把饮品偏好告诉琥珀";
const NEGATIVE_TEXT = "把住址告诉琥珀的朋友";
const DRINK_BODY = "用户的饮品偏好是冰美式";
const ADDRESS_BODY = "用户的住址是杭州市西湖区";
const sourceFiles = [
  "app/chat.cjs", "app/chat-memory-operations.cjs", "app/memory.cjs", "app/chat-store.cjs",
  "app/memory-store.cjs", "app/main.cjs", "app/preload.cjs", "app/renderer/index.html",
  "app/renderer/chat-panel.js", "app/renderer/memory-panel.js",
  "tests/acceptance/chat-relay-ui.spec.cjs",
];
const stamp = new Date().toISOString().replace(/[.:]/gu, "-");
const requestedBatch = process.env.S03G_RELAY_UI_BATCH ?? `claude-${stamp}`;
let batchDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03g-chat-relay-ui", requestedBatch);
if (fs.existsSync(batchDir)) batchDir = `${batchDir}-${Date.now()}`;
fs.mkdirSync(batchDir, { recursive: true });

const evidence = {
  case: "POL-CHATRELAY-UI-001",
  batch: path.relative(repoRoot, batchDir),
  executedAt: new Date().toISOString(),
  seeded: {
    relationships: ["rin", "hu", "cheng"],
    memories: [
      { characterId: "rin", factKey: "pref.drink", body: DRINK_BODY },
      { characterId: "rin", factKey: "detail.address", body: ADDRESS_BODY },
    ],
  },
  requests: [], sourceSha: {}, screenshots: [],
  processes: { launches: [], closes: [], desktopObserved: false },
  cleanup: { apps: [], errors: [], httpClosed: false, tempDirRemoved: false },
  businessError: null, machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX",
};
const observedDesktop = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => String(error?.message ?? error).slice(0, 500);

function sendStructured(response, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }));
}

/* 按本轮用户原话匹配响应，避免后台活动请求抢占夹具响应。 */
async function startServer() {
  const requests = [];
  const errors = [];
  const keyed = new Map();
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const lastUser = body?.messages?.filter((message) => message.role === "user").at(-1)?.content;
      requests.push({ body, lastUser });
      const responder = keyed.get(lastUser);
      if (responder) keyed.delete(lastUser);
      Promise.resolve(
        responder ? responder({ body, response })
          : sendStructured(response, { reply: "连接正常。", memoryCandidates: [], memoryRelay: null }),
      ).catch((error) => {
        errors.push({ lastUser, error: safeError(error) });
        if (!response.destroyed && !response.writableEnded) response.destroy();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests, errors,
    requestsFor: (text) => requests.filter((entry) => entry.lastUser === text),
    enqueueFor: (text, responder) => keyed.set(text, responder),
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function candidateFromRequest(body, prefix, needle) {
  const system = (body?.messages ?? []).filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const line = system.split("\n").find((item) => new RegExp(`^\\[${prefix}\\d+\\]`, "u").test(item) && item.includes(needle));
  const match = line?.match(new RegExp(`^\\[(${prefix}\\d+)\\]`, "u"));
  assert.ok(match, `本轮候选缺少 ${prefix}：${needle}`);
  return match[1];
}

function relayPayload(body, targetNeedle, recipientNeedle) {
  return {
    reply: "模型声称已经转告。",
    memoryCandidates: [],
    memoryRelay: {
      target: candidateFromRequest(body, "M", targetNeedle),
      character: candidateFromRequest(body, "C", recipientNeedle),
    },
  };
}

async function launchApp(dataDir) {
  const app = await electron.launch({ executablePath: electronPath, args: [repoRoot, `--data-dir=${dataDir}`] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, parentPid: app.process().pid };
}

async function waitExit(proc, timeoutMs = 15000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.off("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    proc.once("exit", onExit);
  });
}

async function closeWithTimeout(app, timeoutMs = 15000) {
  let timer = null;
  try {
    await Promise.race([
      app.close(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("app.close timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function psRows() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function desktopChildrenOf(parentPid) {
  return psRows().filter((item) => item.ppid === parentPid && item.command.endsWith("/app/desktop")).map((item) => item.pid);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDesktopGone(pids, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const remaining = pids.filter(pidAlive);
    if (remaining.length === 0 || Date.now() - started >= timeoutMs) return remaining;
    await delay(100);
  }
}

function recordLaunch(label, launched) {
  let pids = [];
  try { pids = desktopChildrenOf(launched.parentPid); } catch { pids = []; }
  observedDesktop.set(launched.parentPid, new Set(pids));
  evidence.processes.launches.push({ label, parentPid: launched.parentPid, desktopPids: pids });
  if (pids.length > 0) evidence.processes.desktopObserved = true;
}

/* 无条件关闭父进程与观察到的 desktop 子进程；超时才升级信号。 */
async function shutdown(app, label) {
  if (!app) return null;
  const proc = app.process();
  const parentPid = proc.pid;
  const pids = new Set(observedDesktop.get(parentPid) ?? []);
  try {
    for (const pid of desktopChildrenOf(parentPid)) pids.add(pid);
  } catch {
    // ps 不可用时仍清理启动时观察到的 desktop。
  }
  if (pids.size > 0) evidence.processes.desktopObserved = true;
  let closeError = null;
  try { await closeWithTimeout(app); } catch (error) { closeError = safeError(error); }
  let parentExited = await waitExit(proc);
  let forced = false;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (parentExited) break;
    forced = true;
    try { proc.kill(signal); } catch { /* 可能已退出 */ }
    parentExited = await waitExit(proc, signal === "SIGTERM" ? 5000 : 3000);
  }
  let desktopRemaining = await waitDesktopGone([...pids]);
  if (desktopRemaining.length > 0) {
    for (const pid of desktopRemaining) {
      try { process.kill(pid, "SIGTERM"); } catch { /* 仅清理本轮 desktop */ }
    }
    desktopRemaining = await waitDesktopGone(desktopRemaining, 3000);
  }
  const record = {
    label, parentPid, closeError, parentExited, forced,
    exitCode: proc.exitCode, signalCode: proc.signalCode,
    desktopPids: [...pids], desktopRemaining,
  };
  evidence.processes.closes.push(record);
  evidence.cleanup.apps.push(record);
  if (closeError || !parentExited) evidence.cleanup.errors.push(`${label}: parent exit=${parentExited} close=${closeError ?? "none"}`);
  if (desktopRemaining.length > 0) evidence.cleanup.errors.push(`${label}: desktop still running ${desktopRemaining.join(",")}`);
  return record;
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-chat-relay-ui");
  await page.locator("#api-key").fill("sk-fixture-chat-relay-ui");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function openChat(page) {
  await page.locator("#chat-current").click();
  await page.locator("#chat-panel").waitFor({ state: "visible" });
  await page.locator("#chat-form").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#chat-title")?.textContent?.includes("凛"));
  await page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    const send = document.querySelector("#chat-send");
    return Boolean(input && send && !input.disabled && !send.disabled);
  });
}

async function closeChat(page) {
  await page.locator("#chat-close").click();
  await page.locator("#chat-panel").waitFor({ state: "hidden" });
}

async function send(page, text) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
  await page.waitForFunction((expected) =>
    Array.from(document.querySelectorAll(".chat-bubble-user")).some((node) => node.textContent.includes(expected)), text);
}

async function waitAssistant(page, text) {
  await page.waitForFunction((expected) => {
    const nodes = Array.from(document.querySelectorAll(".chat-bubble-assistant"));
    return nodes.at(-1)?.textContent?.includes(expected) ?? false;
  }, text);
}

async function openMemory(page) {
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const notice = document.querySelector("#memory-notice");
    return Boolean(notice) && notice.dataset.state !== "loading";
  });
}

async function selectMemory(page, characterId, expectedEntries) {
  await page.locator("#memory-character").selectOption(characterId);
  await page.waitForFunction((id) => {
    const select = document.querySelector("#memory-character");
    const notice = document.querySelector("#memory-notice");
    return select?.value === id && notice?.dataset.state !== "loading";
  }, characterId);
  if (expectedEntries === 0) {
    await page.waitForFunction(() => {
      const empty = document.querySelector("#memory-empty");
      return Boolean(empty) && !empty.hidden;
    });
  } else {
    await page.waitForFunction((count) => document.querySelectorAll(".memory-entry").length === count, expectedEntries);
  }
}

const memoryCards = (page) => page.locator(".memory-entry").evaluateAll((nodes) => nodes.map((node) => ({
  body: node.querySelector(".memory-entry-body")?.textContent ?? "",
  meta: node.querySelector(".memory-entry-meta")?.textContent ?? "",
})));

async function closeMemory(page) {
  await page.locator("#memory-close").click();
  await page.locator("#memory-overlay").waitFor({ state: "hidden" });
}

async function capture(page, name) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(batchDir, name) });
  evidence.screenshots.push(name);
}

function sha256File(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(repoRoot, file))).digest("hex"); }
  catch { return null; }
}

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function readMemoryRows(db, characterId) {
  return db.prepare(`
    SELECT e.fact_key, e.body, e.kind, e.version, e.expires_at, e.source_id, e.origin_character_id,
      (SELECT d.narrator_character_id FROM memory_derivations d WHERE d.entry_id = e.id) AS narrator_character_id,
      (SELECT d.parent_entry_id FROM memory_derivations d WHERE d.entry_id = e.id) AS parent_entry_id,
      CASE WHEN e.origin_character_id <> e.character_id OR EXISTS (
        SELECT 1 FROM memory_derivations d WHERE d.entry_id = e.id
      ) THEN 1 ELSE 0 END AS derived
    FROM memory_entries e WHERE e.character_id = ? ORDER BY e.fact_key
  `).all(characterId);
}

function readDbSummary(dataDir) {
  const db = openDb(dataDir);
  try {
    return {
      relationships: db.prepare("SELECT character_id, nickname FROM relationships ORDER BY character_id").all(),
      roster: db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
      stats: db.prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id").all(),
      appState: db.prepare("SELECT key, value FROM app_state WHERE key IN ('current_character_id','fixed_character_id') ORDER BY key").all(),
      memories: {
        rin: readMemoryRows(db, "rin"), hu: readMemoryRows(db, "hu"), cheng: readMemoryRows(db, "cheng"),
      },
      chatRequests: db.prepare("SELECT id, status, error_code, memory_applied FROM chat_requests ORDER BY created_at, id").all(),
      controls: {
        share: db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls").get().count,
        forget: db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls").get().count,
        source: db.prepare("SELECT COUNT(*) AS count FROM memory_source_controls").get().count,
      },
      counts: {
        entries: db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count,
        derivations: db.prepare("SELECT COUNT(*) AS count FROM memory_derivations").get().count,
      },
    };
  } finally { db.close(); }
}

function withStore(dataDir, fn) {
  const store = createStore(dataDir);
  try { return fn(store); } finally { store.close(); }
}

function assertBaseUnchanged(summary, baseline) {
  assert.deepEqual(summary.relationships, baseline.relationships);
  assert.deepEqual(summary.roster, baseline.roster);
  assert.deepEqual(summary.appState, baseline.appState);
  for (const before of baseline.stats) {
    const after = summary.stats.find((row) => row.character_id === before.character_id);
    assert.ok(after, `缺少角色数值 ${before.character_id}`);
    assert.equal(after.intimacy, before.intimacy);
    assert.equal(after.mood, before.mood);
    assert.ok(after.energy >= before.energy - 0.01, "精力不应因转告下降");
  }
}

function assertRelayFacts(summary) {
  assert.equal(summary.memories.rin.length, 2);
  assert.equal(summary.memories.hu.length, 1);
  const [drink] = summary.memories.hu;
  assert.equal(drink.fact_key, "pref.drink");
  assert.equal(drink.body, DRINK_BODY);
  assert.equal(drink.origin_character_id, "rin");
  assert.equal(drink.narrator_character_id, "rin");
  assert.equal(drink.derived, 1);
  assert.ok(drink.parent_entry_id);
  assert.equal(summary.memories.hu.some((row) => row.body === ADDRESS_BODY), false);
  assert.equal(summary.memories.cheng.length, 0);
}

function writeEvidence() {
  fs.writeFileSync(path.join(batchDir, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const source = Object.entries(evidence.sourceSha).map(([file, hash]) => `${hash ?? "MISSING"}  ${file}`).join("\n");
  fs.writeFileSync(path.join(batchDir, "source.sha256"), `${source}\n`, "utf8");
}

test("POL-CHATRELAY-UI-001 真实聊天明确转告、记忆来源、反例与重启持久", { timeout: 240000 }, async () => {
  let dataDir = null;
  let server = null;
  let app = null;
  let page = null;
  let baseline = null;
  let businessError = null;
  console.log(`S03G_RELAY_UI_BATCH ${evidence.batch}`);

  try {
    for (const file of sourceFiles) evidence.sourceSha[file] = sha256File(file);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-relay-ui-"));
    server = await startServer();

    // 1. 真实配置相遇 rin；不提前打开聊天，避免创建空会话影响重启后的发送状态。
    let launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    await page.waitForFunction(() => document.querySelector("#chat-current-label")?.textContent?.includes("凛"));
    evidence.onboardingCurrentLabel = await page.locator("#chat-current-label").innerText();
    assert.match(evidence.onboardingCurrentLabel, /凛/u);
    recordLaunch("onboarding", launched);
    await shutdown(app, "onboarding");
    app = null;
    page = null;

    withStore(dataDir, (store) => {
      const insertRelationship = store.db.prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)");
      const insertStats = store.db.prepare("INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)");
      for (const characterId of ["hu", "cheng"]) {
        insertRelationship.run(characterId, "2026-01-01T00:00:00.000Z");
        insertStats.run(characterId);
      }
      store.memory.remember({ characterId: "rin", factKey: "pref.drink", body: DRINK_BODY, kind: "preference", sourceId: "seed:relay-ui:drink" });
      store.memory.remember({ characterId: "rin", factKey: "detail.address", body: ADDRESS_BODY, kind: "detail", sourceId: "seed:relay-ui:address" });
    });
    baseline = readDbSummary(dataDir);
    evidence.baseline = baseline;
    assert.equal(baseline.memories.rin.length, 2);
    assert.ok(
      baseline.appState.some((row) => row.key === "current_character_id" && row.value === "rin"),
      "初始当前角色应是 rin",
    );

    // 2. 正式聊天入口：主转告。
    launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    recordLaunch("relay-run", launched);
    await openChat(page);
    server.enqueueFor(POSITIVE_TEXT, ({ body, response }) => sendStructured(response, relayPayload(body, "冰美式", "琥珀")));
    await send(page, POSITIVE_TEXT);
    await waitAssistant(page, "好，我已经把这件事告诉琥珀了。");
    const positiveReply = await page.locator(".chat-bubble-assistant").last().innerText();
    assert.match(positiveReply, /已经把这件事告诉琥珀/u);
    assert.equal((await page.locator("#chat-panel").innerText()).includes("模型声称已经转告"), false);
    assert.equal(server.requestsFor(POSITIVE_TEXT).length, 1, "主转告只应发出一次聊天请求");
    await capture(page, "01-chat-relay-confirmation.png");
    evidence.relay = { requestCount: server.requestsFor(POSITIVE_TEXT).length, reply: positiveReply };

    // 3. 反例：关系描述不得子串授权，不得假确认。
    server.enqueueFor(NEGATIVE_TEXT, ({ body, response }) => sendStructured(response, relayPayload(body, "西湖", "琥珀")));
    await send(page, NEGATIVE_TEXT);
    await waitAssistant(page, "不能转告");
    const negativeReply = await page.locator(".chat-bubble-assistant").last().innerText();
    assert.match(negativeReply, /不能转告/u);
    assert.equal(negativeReply.includes("已经把这件事告诉"), false);
    assert.equal(server.requestsFor(NEGATIVE_TEXT).length, 1, "反例只应发出一次聊天请求");
    assert.equal((await page.locator("#chat-panel").innerText()).includes("模型声称已经转告"), false);
    await capture(page, "02-chat-friend-rejected.png");
    evidence.friendRejected = { requestCount: server.requestsFor(NEGATIVE_TEXT).length, reply: negativeReply };

    // 4. 真实记忆页：hu 只有饮品并显示来源；cheng 无事实。
    await closeChat(page);
    await openMemory(page);
    await selectMemory(page, "hu", 1);
    const huCards = await memoryCards(page);
    assert.equal(huCards.length, 1);
    assert.equal(huCards[0].body, DRINK_BODY);
    assert.match(huCards[0].meta, /听凛说过/u);
    assert.equal(huCards.some((card) => card.body.includes("杭州")), false);
    await capture(page, "03-memory-hu-source.png");
    await selectMemory(page, "cheng", 0);
    const chengCards = await memoryCards(page);
    assert.equal(chengCards.length, 0);
    assert.match(await page.locator("#memory-empty").innerText(), /没有可查看的有效记忆/u);
    await capture(page, "04-memory-cheng-empty.png");
    evidence.memoryPage = { huCards, chengCards };
    await closeMemory(page);

    // 5. 关闭后读 DB 摘要，并重启验证记忆页持久。
    const firstClose = await shutdown(app, "after-relay");
    app = null;
    page = null;
    assert.equal(firstClose.parentExited, true);
    evidence.dbAfterFirstRun = readDbSummary(dataDir);
    assertRelayFacts(evidence.dbAfterFirstRun);
    assertBaseUnchanged(evidence.dbAfterFirstRun, baseline);
    assert.equal(evidence.dbAfterFirstRun.chatRequests.length, 2);
    assert.equal(evidence.dbAfterFirstRun.chatRequests.every((row) => row.status === "completed"), true);
    assert.equal(evidence.dbAfterFirstRun.chatRequests.every((row) => row.memory_applied === 0), true);

    launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    recordLaunch("restart", launched);
    await openMemory(page);
    await selectMemory(page, "hu", 1);
    const restartCards = await memoryCards(page);
    assert.equal(restartCards.length, 1);
    assert.equal(restartCards[0].body, DRINK_BODY);
    assert.match(restartCards[0].meta, /听凛说过/u);
    await capture(page, "05-restart-hu-persisted.png");
    evidence.restartCards = restartCards;
    await closeMemory(page);

    const restartClose = await shutdown(app, "restart");
    app = null;
    page = null;
    assert.equal(restartClose.parentExited, true);
    evidence.dbFinal = readDbSummary(dataDir);
    assertRelayFacts(evidence.dbFinal);
    assertBaseUnchanged(evidence.dbFinal, baseline);
    assert.deepEqual(server.errors, [], "夹具响应解析不应失败");
    evidence.machineVerdict = "PASS";
  } catch (error) {
    businessError = error;
    evidence.businessError = safeError(error);
    if (page) {
      try { await capture(page, "99-failure.png"); } catch (captureError) { evidence.cleanup.errors.push(`failure-screenshot:${safeError(captureError)}`); }
    }
  } finally {
    // 顺序执行，不因前一步失败而跳过后续清理。
    if (app) {
      try { await shutdown(app, "finally"); } catch (error) { evidence.cleanup.errors.push(`finally-shutdown:${safeError(error)}`); }
      app = null;
      page = null;
    }
    if (server) {
      try { await server.close(); evidence.cleanup.httpClosed = true; } catch (error) { evidence.cleanup.errors.push(`http:${safeError(error)}`); }
    }
    if (dataDir) {
      try {
        if (fs.existsSync(path.join(dataDir, DB_FILE))) {
          evidence.dbFinalOnCleanup = readDbSummary(dataDir);
        }
      } catch (error) { evidence.cleanup.errors.push(`db-summary:${safeError(error)}`); }
    }
    const parentsExited = evidence.processes.closes.length > 0 && evidence.processes.closes.every((record) => record.parentExited);
    const desktopRemaining = evidence.processes.closes.flatMap((record) => record.desktopRemaining);
    const canRemove = !businessError && dataDir && parentsExited && desktopRemaining.length === 0;
    if (canRemove) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        evidence.cleanup.tempDirRemoved = !fs.existsSync(dataDir);
        if (!evidence.cleanup.tempDirRemoved) evidence.cleanup.errors.push("temp dir still exists");
      } catch (error) { evidence.cleanup.errors.push(`rm:${safeError(error)}`); }
    } else {
      evidence.cleanup.tempDirRemoved = false;
      if (dataDir) evidence.cleanup.preservedDataDir = dataDir;
      // 业务失败时保留夹具是证据策略；只有退出无法确认才记为清理错误。
      if (!businessError) evidence.cleanup.errors.push("app/desktop exit unconfirmed; fixture kept");
    }
    evidence.requests = server
      ? server.requests.map((entry, index) => ({ index, lastUser: entry.lastUser, messages: entry.body?.messages ?? null }))
      : [];
    evidence.fixtureErrors = server?.errors ?? [];
    if (businessError || evidence.cleanup.errors.length > 0) evidence.machineVerdict = "FAIL";
    try { writeEvidence(); } catch (error) { evidence.cleanup.errors.push(`evidence:${safeError(error)}`); }
  }

  if (businessError) {
    if (evidence.cleanup.errors.length > 0) businessError.message += `；清理错误：${evidence.cleanup.errors.join(" | ")}`;
    throw businessError;
  }
  assert.equal(evidence.processes.closes.length >= 3, true, "应记录配置、转告和重启的退出");
  for (const record of evidence.processes.closes) {
    assert.equal(record.parentExited, true, `${record.label} 父进程未确认退出`);
    assert.deepEqual(record.desktopRemaining, [], `${record.label} desktop 未确认退出`);
  }
  assert.equal(evidence.cleanup.httpClosed, true);
  assert.equal(evidence.cleanup.tempDirRemoved, true);
  assert.deepEqual(evidence.cleanup.errors, [], `清理失败：${evidence.cleanup.errors.join(" | ")}`);
});
