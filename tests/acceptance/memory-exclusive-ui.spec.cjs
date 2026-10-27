/* S03h 正式 GUI 验收：现有记忆面板的“只让所选角色记得”。
   真实 Electron main/preload/renderer/SQLite 与真实配置；本地面板阶段停掉本机 HTTP，
   证明独属保留不依赖模型。聊天阶段恢复同一端口夹具，验证一次实际请求与本地确认。
   不读 .env、不调用真实 API、不直接 IPC 代替用户点击；失败保留夹具与证据。 */
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
const DRINK_BODY = "用户的饮品偏好是冰美式";
const FOOD_BODY = "用户的饮食偏好是喜欢家常菜";
const ADDRESS_BODY = "用户的住址是杭州市西湖区";
const MUSIC_BODY = "用户的音乐偏好是听钢琴曲";
const CHAT_TEXT = "音乐偏好只让你记得";
const sourceFiles = [
  "app/main.cjs", "app/preload.cjs", "app/memory.cjs", "app/memory-store.cjs",
  "app/chat.cjs", "app/chat-memory-operations.cjs", "app/renderer/app.js",
  "app/renderer/memory-panel.js", "tests/acceptance/memory-exclusive-ui.spec.cjs",
];
const requestedBatch = process.env.S03H_EXCLUSIVE_UI_BATCH
  ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
let batchDir = path.join(
  repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence",
  "s03h-memory-exclusive-ui", requestedBatch,
);
if (fs.existsSync(batchDir)) batchDir = `${batchDir}-${Date.now()}`;
fs.mkdirSync(batchDir, { recursive: true });

const evidence = {
  case: "POL-EXCLUSIVEUI-001/002/003",
  batch: path.relative(repoRoot, batchDir),
  executedAt: new Date().toISOString(),
  seeded: {
    rin: ["pref.drink", "pref.food", "pref.music", "detail.address"],
    huDerived: ["pref.drink", "pref.food", "pref.music"],
    cheng: [],
  },
  localHttp: {}, cases: {},
  requests: [], sourceSha: {}, screenshots: [],
  processes: { closes: [], desktopObserved: false },
  cleanup: { apps: [], errors: [], httpClosed: false, tempDirRemoved: false },
  businessError: null, machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX",
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => String(error?.message ?? error).slice(0, 500);

function sendStructured(response, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
  }));
}

/* 夹具服务可在同一端口停下与恢复；停服期间请求无法到达。 */
function createFixtureServer() {
  const requests = [];
  const errors = [];
  const keyed = new Map();
  let port = null;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const lastUser = body?.messages
        ?.filter((message) => message.role === "user").at(-1)?.content;
      requests.push({ body, lastUser });
      const responder = keyed.get(lastUser);
      if (responder) keyed.delete(lastUser);
      Promise.resolve(responder
        ? responder({ body, response })
        : sendStructured(response, { reply: "连接正常。", memoryCandidates: [], memoryRelay: null }),
      ).catch((error) => {
        errors.push({ lastUser, error: safeError(error) });
        if (!response.destroyed && !response.writableEnded) response.destroy();
      });
    });
  });
  return {
    requests, errors,
    requestsFor: (text) => requests.filter((entry) => entry.lastUser === text),
    enqueueFor: (text, responder) => keyed.set(text, responder),
    isRunning: () => server.listening,
    async start() {
      await new Promise((resolve) => server.listen(port ?? 0, "127.0.0.1", resolve));
      port = server.address().port;
      return `http://127.0.0.1:${port}/v1`;
    },
    async stop() {
      if (!server.listening) return;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function candidateFromRequest(body, prefix, needle) {
  const system = (body?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => message.content).join("\n");
  const line = system.split("\n")
    .find((item) => new RegExp(`^\\[${prefix}\\d+\\]`, "u").test(item) && item.includes(needle));
  const match = line?.match(new RegExp(`^\\[(${prefix}\\d+)\\]`, "u"));
  assert.ok(match, `本轮候选缺少 ${prefix}：${needle}`);
  return match[1];
}

function exclusiveEnvelope(body, needle, evidenceText) {
  return {
    reply: "模型只提出建议，不代表已经执行。",
    memoryCandidates: [],
    memoryOperation: {
      action: "keepExclusive",
      target: candidateFromRequest(body, "M", needle),
      evidence: evidenceText,
    },
  };
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, parentPid: app.process().pid };
}

function psRows() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function desktopChildrenOf(parentPid) {
  return psRows().filter((item) => item.ppid === parentPid
    && item.command.endsWith("/app/desktop")).map((item) => item.pid);
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitExit(proc, timeoutMs = 15000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.off("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    proc.once("exit", onExit);
  });
}

async function waitGone(pids, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const remaining = pids.filter(pidAlive);
    if (remaining.length === 0 || Date.now() - started >= timeoutMs) return remaining;
    await delay(100);
  }
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

/* 关闭父进程与仍在运行的 desktop 子进程；超时才升级信号。 */
async function shutdown(app, label) {
  const proc = app.process();
  let desktopPids = [];
  try { desktopPids = desktopChildrenOf(proc.pid); } catch { desktopPids = []; }
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
  let desktopRemaining = await waitGone(desktopPids);
  for (const pid of desktopRemaining) {
    try { process.kill(pid, "SIGTERM"); } catch { /* 仅清理本轮 desktop */ }
  }
  desktopRemaining = await waitGone(desktopRemaining, 3000);
  const record = {
    label, parentPid: proc.pid, closeError, parentExited, forced,
    exitCode: proc.exitCode, signalCode: proc.signalCode, desktopPids, desktopRemaining,
  };
  evidence.processes.closes.push(record);
  evidence.cleanup.apps.push(record);
  if (closeError || !parentExited) {
    evidence.cleanup.errors.push(`${label}: parent exit=${parentExited} close=${closeError ?? "none"}`);
  }
  if (desktopRemaining.length > 0) {
    evidence.cleanup.errors.push(`${label}: desktop still running ${desktopRemaining.join(",")}`);
  }
  if (desktopPids.length > 0) evidence.processes.desktopObserved = true;
  return record;
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-memory-exclusive-ui");
  await page.locator("#api-key").fill("sk-fixture-memory-exclusive-ui");
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
  await page.waitForFunction(() => document.querySelector("#chat-title")?.textContent?.includes("凛"));
  await page.waitForFunction(() => {
    const input = document.querySelector("#chat-input");
    const send = document.querySelector("#chat-send");
    return Boolean(input && send && !input.disabled && !send.disabled);
  });
}

async function send(page, text) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
  await page.waitForFunction((expected) =>
    Array.from(document.querySelectorAll(".chat-bubble-user"))
      .some((node) => node.textContent.includes(expected)), text);
}

async function waitAssistant(page, text) {
  await page.waitForFunction((expected) => {
    const nodes = Array.from(document.querySelectorAll(".chat-bubble-assistant"));
    return nodes.at(-1)?.textContent?.includes(expected) ?? false;
  }, text);
}

async function openMemory(page) {
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible", timeout: 10000 });
}

async function closeMemory(page) {
  await page.locator("#memory-close").click();
  await page.locator("#memory-overlay").waitFor({ state: "hidden" });
}

async function waitMemoryReady(page, expectedEntries) {
  await page.waitForFunction((count) => {
    const notice = document.querySelector("#memory-notice");
    if (!notice || notice.dataset.state === "loading") return false;
    return count === 0
      ? !document.querySelector("#memory-empty")?.hidden
      : document.querySelectorAll(".memory-entry").length === count;
  }, expectedEntries);
}

async function selectMemoryCharacter(page, characterId, expectedEntries) {
  await page.locator("#memory-character").selectOption(characterId);
  await waitMemoryReady(page, expectedEntries);
  assert.equal(await page.locator("#memory-character").inputValue(), characterId);
}

async function selectMemoryEntry(page, body) {
  await page.locator(".memory-entry").filter({ hasText: body }).first().click();
  await page.waitForFunction((text) => document.querySelector("#memory-body")?.value === text, body);
}

const memoryCards = (page) => page.locator(".memory-entry").evaluateAll((nodes) => nodes.map((node) => ({
  body: node.querySelector(".memory-entry-body")?.textContent ?? "",
  meta: node.querySelector(".memory-entry-meta")?.textContent ?? "",
})));

const panelExclusiveState = (page) => page.evaluate(() => ({
  label: document.querySelector("#memory-exclusive")?.textContent?.trim() ?? "",
  note: document.querySelector("#memory-exclusive-note")?.textContent?.trim() ?? "",
  disabled: document.querySelector("#memory-exclusive")?.disabled ?? true,
  dirtyHidden: document.querySelector("#memory-dirty-note")?.hidden ?? true,
  selectedCharacter: document.querySelector("#memory-character")?.value ?? "",
}));

async function currentCharacterId(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot?.companionship?.current?.characterId ?? null;
}

const waitNotice = (page, text) => page.waitForFunction((expected) =>
  document.querySelector("#memory-notice")?.textContent?.includes(expected), text);

const waitError = (page, text) => page.waitForFunction((expected) => {
  const alert = document.querySelector("#memory-error");
  return Boolean(alert) && !alert.hidden && alert.textContent.includes(expected);
}, text);

async function resetMemoryEvents(page) {
  await page.evaluate(() => {
    window.__memoryEvents = [];
    if (!window.__memoryEventBound) {
      window.bayperMemory.onMemoryChanged((payload) => window.__memoryEvents.push(payload));
      window.__memoryEventBound = true;
    }
  });
}

async function waitMemoryEvents(page, count) {
  await page.waitForFunction((expected) => (window.__memoryEvents?.length ?? 0) >= expected, count);
  return page.evaluate(() => window.__memoryEvents ?? []);
}

async function capture(page, name) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(batchDir, name) });
  evidence.screenshots.push(name);
}

function sha256File(file) {
  try {
    return crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(repoRoot, file))).digest("hex");
  } catch {
    return null;
  }
}

function openDb(dataDir, readOnly = true) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function readMemoryRows(db, characterId) {
  return db.prepare(`
    SELECT e.id, e.fact_key, e.body, e.version, e.origin_character_id,
      (SELECT d.narrator_character_id FROM memory_derivations d WHERE d.entry_id = e.id)
        AS narrator_character_id,
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
      appState: db.prepare(
        "SELECT key, value FROM app_state WHERE key IN ('current_character_id','fixed_character_id') ORDER BY key",
      ).all(),
      memories: {
        rin: readMemoryRows(db, "rin"),
        hu: readMemoryRows(db, "hu"),
        cheng: readMemoryRows(db, "cheng"),
      },
      contexts: db.prepare(
        "SELECT character_id, version FROM memory_context_versions ORDER BY character_id",
      ).all(),
      chatRequests: db.prepare(
        "SELECT id, status, error_code, memory_applied FROM chat_requests ORDER BY created_at, id",
      ).all(),
      controls: {
        share: db.prepare("SELECT COUNT(*) AS count FROM memory_share_identity_controls").get().count,
        forget: db.prepare("SELECT COUNT(*) AS count FROM memory_forget_identity_controls").get().count,
        deleted: db.prepare("SELECT COUNT(*) AS count FROM memory_deleted_fact_fingerprints").get().count,
        source: db.prepare("SELECT COUNT(*) AS count FROM memory_source_controls").get().count,
      },
    };
  } finally {
    db.close();
  }
}

const rowsByFact = (summary, characterId) =>
  new Map(summary.memories[characterId].map((row) => [row.fact_key, row]));

const contextVersion = (summary, characterId) =>
  summary.contexts.find((row) => row.character_id === characterId)?.version ?? 0;

function withStore(dataDir, fn) {
  const store = createStore(dataDir);
  try { return fn(store); } finally { store.close(); }
}

function bumpEntryVersion(dataDir, entryId) {
  const db = openDb(dataDir, false);
  try {
    db.prepare(
      "UPDATE memory_entries SET version = version + 1, updated_at = updated_at + 1 WHERE id = ?",
    ).run(entryId);
  } finally {
    db.close();
  }
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
    assert.ok(after.energy >= before.energy - 0.01, "精力不应因独属保留下降");
  }
}

function writeEvidence() {
  fs.writeFileSync(path.join(batchDir, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const source = Object.entries(evidence.sourceSha)
    .map(([file, hash]) => `${hash ?? "MISSING"}  ${file}`).join("\n");
  fs.writeFileSync(path.join(batchDir, "source.sha256"), `${source}\n`, "utf8");
}

test("POL-EXCLUSIVEUI-001/002/003 面板独属保留、边界、重启与聊天闭环", { timeout: 300000 }, async () => {
  let dataDir = null;
  let server = null;
  let app = null;
  let page = null;
  let baseline = null;
  let businessError = null;
  console.log(`S03H_EXCLUSIVE_UI_BATCH ${evidence.batch}`);

  try {
    for (const file of sourceFiles) evidence.sourceSha[file] = sha256File(file);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-exclusive-ui-"));
    server = createFixtureServer();
    const baseUrl = await server.start();

    // 1. 真实配置相遇凛，然后关掉应用并用真实记忆服务构造持有关系。
    let launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await completeOnboarding(page, baseUrl);
    await page.waitForFunction(() =>
      document.querySelector("#chat-current-label")?.textContent?.includes("凛"));
    await shutdown(app, "onboarding");
    app = null;
    page = null;

    withStore(dataDir, (store) => {
      const insertRelationship = store.db.prepare(
        "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
      );
      const insertStats = store.db.prepare(
        "INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)",
      );
      for (const characterId of ["hu", "cheng"]) {
        insertRelationship.run(characterId, "2026-01-01T00:00:00.000Z");
        insertStats.run(characterId);
      }
      const remember = (factKey, body, kind) => store.memory.remember({
        characterId: "rin", factKey, body, kind, sourceId: `seed:exclusive-ui:${factKey}`,
      });
      const drink = remember("pref.drink", DRINK_BODY, "preference");
      const food = remember("pref.food", FOOD_BODY, "preference");
      const music = remember("pref.music", MUSIC_BODY, "preference");
      remember("detail.address", ADDRESS_BODY, "detail");
      for (const result of [drink, food, music]) {
        store.memory.relay({
          fromCharacterId: "rin",
          toCharacterId: "hu",
          entries: [{ entryId: result.entry.id, expectedVersion: result.entry.version }],
        });
      }
    });
    baseline = readDbSummary(dataDir);
    evidence.baseline = baseline;
    assert.equal(baseline.memories.rin.length, 4);
    assert.equal(baseline.memories.hu.length, 3);
    assert.equal(baseline.memories.cheng.length, 0);
    assert.equal(rowsByFact(baseline, "hu").get("pref.drink").narrator_character_id, "rin");

    // 2. 本地操作阶段：先停掉本机 HTTP，任何模型请求都无法到达夹具。
    launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await server.stop();
    const requestsAtStop = server.requests.length;
    evidence.localHttp = {
      stopped: !server.isRunning(),
      requestsAtStop,
      requestsAfterLocal: null,
      chatRequestsBeforeLocal: readDbSummary(dataDir).chatRequests.length,
    };
    assert.equal(evidence.localHttp.stopped, true);
    await resetMemoryEvents(page);

    // 3. POL-EXCLUSIVEUI-001：模型不可用时，在真实记忆详情选凛并保留独属。
    await openMemory(page);
    await waitMemoryReady(page, 4);
    await selectMemoryEntry(page, DRINK_BODY);
    let panel = await panelExclusiveState(page);
    assert.match(panel.label, /只让凛记得/u);
    assert.match(panel.note, /清除其他已知角色/u);
    assert.match(panel.note, /禁止再次分享/u);
    assert.match(panel.note, /只保留凛/u);
    assert.equal(panel.selectedCharacter, "rin");
    await capture(page, "01-rin-exclusive-scope.png");

    // 未保存正文不提交，按钮与现有转告一致保持禁用。
    await page.locator("#memory-body").fill(`${DRINK_BODY}（未保存草稿）`);
    panel = await panelExclusiveState(page);
    assert.equal(panel.disabled, true);
    assert.equal(panel.dirtyHidden, false);
    await capture(page, "02-unsaved-draft-blocked.png");
    await page.locator("#memory-revert").click();
    assert.equal((await panelExclusiveState(page)).disabled, false);

    // 详情期间其它入口更新版本：旧条目不能误清除其他角色。
    const beforeStale = readDbSummary(dataDir);
    const drink = rowsByFact(beforeStale, "rin").get("pref.drink");
    bumpEntryVersion(dataDir, drink.id);
    await page.locator("#memory-exclusive").click();
    await waitError(page, "记忆已更新");
    await waitNotice(page, "记忆已变化");
    const afterStale = readDbSummary(dataDir);
    assert.equal(rowsByFact(afterStale, "hu").has("pref.drink"), true, "过期版本不得清除琥珀");
    assert.equal(afterStale.controls.share, 0, "过期版本不得写入禁分享控制");
    assert.equal(rowsByFact(afterStale, "rin").get("pref.drink").version, drink.version + 1);
    await capture(page, "03-stale-version-blocked.png");
    await selectMemoryEntry(page, DRINK_BODY);

    // 成功保留凛；只发一次记忆变更事件，且包含保留者与被清除者。
    await resetMemoryEvents(page);
    const before001 = readDbSummary(dataDir);
    const rinDrinkVersion = rowsByFact(before001, "rin").get("pref.drink").version;
    await page.locator("#memory-exclusive").click();
    await waitNotice(page, "已只保留给凛");
    const events001 = await waitMemoryEvents(page, 1);
    const after001 = readDbSummary(dataDir);
    const rin001 = rowsByFact(after001, "rin");
    const hu001 = rowsByFact(after001, "hu");
    assert.equal(rin001.get("pref.drink").version, rinDrinkVersion + 1, "保留者版本应刷新");
    assert.equal(hu001.has("pref.drink"), false, "琥珀的同一事实应清除");
    assert.equal(after001.memories.cheng.length, 0, "澄不应因操作获得信息");
    assert.equal(rin001.has("pref.food") && rin001.has("detail.address")
      && rin001.has("pref.music"), true, "无关事实不得清除");
    assert.equal(hu001.has("pref.food") && hu001.has("pref.music"), true, "无关事实不得清除");
    assert.equal(after001.controls.share, 1);
    assert.equal(after001.controls.forget, before001.controls.forget + 1);
    assert.equal(after001.controls.source, before001.controls.source + 1);
    assert.ok(contextVersion(after001, "rin") > contextVersion(before001, "rin"));
    assert.ok(contextVersion(after001, "hu") > contextVersion(before001, "hu"));
    assert.equal(events001.length, 1, "一次操作只应发一次记忆变更");
    assert.deepEqual([...events001[0].affectedCharacters].sort(), ["hu", "rin"]);
    assertBaseUnchanged(after001, baseline);
    await capture(page, "04-rin-exclusive-applied.png");
    evidence.cases["001"] = {
      version: rin001.get("pref.drink").version,
      huHasDrink: hu001.has("pref.drink"),
      chengEntries: after001.memories.cheng.length,
      controls: after001.controls,
      events: events001,
    };

    // 重复确认幂等：刷新后的版本仍可用，不再改动正文或版本。
    await selectMemoryEntry(page, DRINK_BODY);
    assert.match(await page.locator("#memory-editor-meta").innerText(), /已禁止分享/u);
    await resetMemoryEvents(page);
    const beforeRepeat = readDbSummary(dataDir);
    await page.locator("#memory-exclusive").click();
    await waitNotice(page, "已经只保留给凛");
    const eventsRepeat = await waitMemoryEvents(page, 1);
    const afterRepeat = readDbSummary(dataDir);
    assert.equal(rowsByFact(afterRepeat, "rin").get("pref.drink").version,
      rowsByFact(beforeRepeat, "rin").get("pref.drink").version);
    assert.equal(afterRepeat.controls.share, beforeRepeat.controls.share);
    assert.deepEqual(eventsRepeat[0].affectedCharacters, ["rin"]);
    evidence.cases["001Repeat"] = { version: afterRepeat.memories.rin
      .find((row) => row.fact_key === "pref.drink").version, events: eventsRepeat };

    // 4. POL-EXCLUSIVEUI-002：所选角色不是桌面角色时，只作用于所选琥珀。
    assert.equal(await currentCharacterId(page), "rin");
    await resetMemoryEvents(page);
    await selectMemoryCharacter(page, "hu", 2);
    await selectMemoryEntry(page, FOOD_BODY);
    panel = await panelExclusiveState(page);
    assert.equal(panel.selectedCharacter, "hu");
    assert.match(panel.label, /只让琥珀记得/u);
    assert.match(panel.note, /只保留琥珀/u);
    assert.match(await page.locator("#memory-editor-meta").innerText(), /听凛说过/u);
    await capture(page, "05-hu-selected-not-desktop.png");

    const before002 = readDbSummary(dataDir);
    const huFoodVersion = rowsByFact(before002, "hu").get("pref.food").version;
    const rinDrinkVersion002 = rowsByFact(before002, "rin").get("pref.drink").version;
    await page.locator("#memory-exclusive").click();
    await waitNotice(page, "已只保留给琥珀");
    const events002 = await waitMemoryEvents(page, 1);
    const after002 = readDbSummary(dataDir);
    const rin002 = rowsByFact(after002, "rin");
    const hu002 = rowsByFact(after002, "hu");
    assert.equal(hu002.get("pref.food").version, huFoodVersion + 1);
    assert.equal(hu002.get("pref.food").origin_character_id, "rin", "保留来源不得改写成亲历");
    assert.equal(hu002.get("pref.food").narrator_character_id, "rin", "保留直接讲述者");
    assert.equal(hu002.get("pref.food").derived, 1);
    assert.equal(rin002.has("pref.food"), false, "原持有者的同一事实应清除");
    assert.equal(rin002.get("pref.drink").version, rinDrinkVersion002, "不得误伤凛的其它事实");
    assert.equal(rin002.has("detail.address") && rin002.has("pref.music"), true);
    assert.equal(hu002.has("pref.music"), true);
    assert.equal(after002.memories.cheng.length, 0);
    assert.ok(contextVersion(after002, "hu") > contextVersion(before002, "hu"));
    assert.deepEqual([...events002[0].affectedCharacters].sort(), ["hu", "rin"]);
    assert.equal(await currentCharacterId(page), "rin", "桌面角色不应被面板选择改写");
    await waitMemoryReady(page, 2);
    await selectMemoryEntry(page, FOOD_BODY);
    const retainedMeta = await page.locator("#memory-editor-meta").innerText();
    assert.match(retainedMeta, /听凛说过/u);
    assert.match(retainedMeta, /已禁止分享/u);
    assertBaseUnchanged(after002, baseline);
    await capture(page, "06-hu-exclusive-retained-source.png");
    evidence.cases["002"] = {
      selected: panel.selectedCharacter,
      desktop: await currentCharacterId(page),
      huFood: hu002.get("pref.food"),
      rinHasFood: rin002.has("pref.food"),
      events: events002,
    };

    // 5. 本地面板阶段从未恢复 HTTP；聊天请求数保持为 0。
    evidence.localHttp.requestsAfterLocal = server.requests.length;
    evidence.localHttp.chatRequestsAfterLocal = readDbSummary(dataDir).chatRequests.length;
    assert.equal(evidence.localHttp.requestsAfterLocal, requestsAtStop, "停服期间不应有请求到达");
    assert.equal(evidence.localHttp.chatRequestsAfterLocal,
      evidence.localHttp.chatRequestsBeforeLocal, "本地面板操作不应产生聊天请求");

    const localClose = await shutdown(app, "local-panel");
    app = null;
    page = null;
    assert.equal(localClose.parentExited, true);

    // 6. POL-EXCLUSIVEUI-003：重启检查持久，再恢复同一端口夹具做一次真实聊天输入。
    launched = await launchApp(dataDir);
    app = launched.app;
    page = launched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(page);
    await waitMemoryReady(page, 3);
    const rinRestartCards = await memoryCards(page);
    assert.equal(rinRestartCards.some((card) => card.body === DRINK_BODY), true);
    assert.equal(rinRestartCards.some((card) => card.body === FOOD_BODY), false);
    await selectMemoryCharacter(page, "hu", 2);
    const huRestartCards = await memoryCards(page);
    assert.equal(huRestartCards.some((card) => card.body === FOOD_BODY), true);
    assert.equal(huRestartCards.some((card) => card.body === DRINK_BODY), false);
    assert.equal(huRestartCards.find((card) => card.body === FOOD_BODY).meta.includes("听凛说过"), true);
    await selectMemoryCharacter(page, "cheng", 0);
    assert.match(await page.locator("#memory-empty").innerText(), /没有可查看的有效记忆/u);
    await capture(page, "07-restart-persisted.png");
    await closeMemory(page);

    await server.start();
    evidence.localHttp.resumed = server.isRunning();
    assert.equal(evidence.localHttp.resumed, true);
    await openChat(page);
    server.enqueueFor(CHAT_TEXT, ({ body, response }) =>
      sendStructured(response, exclusiveEnvelope(body, "钢琴曲", CHAT_TEXT)));
    await send(page, CHAT_TEXT);
    await waitAssistant(page, "只留在我这里记得");
    const chatReply = await page.locator(".chat-bubble-assistant").last().innerText();
    assert.equal(chatReply.includes("模型只提出建议"), false, "模型建议不能冒充本地确认");
    assert.equal(server.requestsFor(CHAT_TEXT).length, 1, "聊天独属保留只应发出一次请求");
    await capture(page, "08-chat-exclusive-confirmation.png");

    const afterChat = readDbSummary(dataDir);
    assert.equal(rowsByFact(afterChat, "hu").has("pref.music"), false, "聊天路径也应清除琥珀");
    assert.equal(rowsByFact(afterChat, "rin").get("pref.music").version,
      before002.memories.rin.find((row) => row.fact_key === "pref.music").version + 1);
    assert.equal(rowsByFact(afterChat, "hu").has("pref.food"), true, "聊天不得误伤已保留的琥珀内容");
    assert.equal(afterChat.memories.cheng.length, 0);
    assert.equal(afterChat.chatRequests.length, 1);
    assert.equal(afterChat.chatRequests[0].status, "completed");
    assert.equal(afterChat.chatRequests[0].memory_applied, 0);
    assertBaseUnchanged(afterChat, baseline);
    evidence.cases["003"] = {
      restart: { rin: rinRestartCards, hu: huRestartCards },
      chat: {
        requestCount: server.requestsFor(CHAT_TEXT).length,
        reply: chatReply,
        chatRequests: afterChat.chatRequests,
        huHasMusic: rowsByFact(afterChat, "hu").has("pref.music"),
      },
    };

    const chatClose = await shutdown(app, "restart-chat");
    app = null;
    page = null;
    assert.equal(chatClose.parentExited, true);
    const finalDb = readDbSummary(dataDir);
    assert.deepEqual(finalDb.memories, afterChat.memories);
    assert.equal(finalDb.controls.share, afterChat.controls.share);
    assertBaseUnchanged(finalDb, baseline);
    assert.deepEqual(server.errors, [], "夹具响应解析不应失败");
    evidence.machineVerdict = "PASS";
  } catch (error) {
    businessError = error;
    evidence.businessError = safeError(error);
    if (page) {
      try { await capture(page, "99-failure.png"); } catch (captureError) {
        evidence.cleanup.errors.push(`failure-screenshot:${safeError(captureError)}`);
      }
    }
  } finally {
    // 顺序执行，不因前一步失败而跳过后续清理。
    if (app) {
      try { await shutdown(app, "finally"); } catch (error) {
        evidence.cleanup.errors.push(`finally-shutdown:${safeError(error)}`);
      }
      app = null;
      page = null;
    }
    if (server) {
      try {
        await server.stop();
        evidence.cleanup.httpClosed = !server.isRunning();
      } catch (error) {
        evidence.cleanup.errors.push(`http:${safeError(error)}`);
      }
    }
    if (dataDir) {
      try {
        if (fs.existsSync(path.join(dataDir, DB_FILE))) evidence.dbFinalOnCleanup = readDbSummary(dataDir);
      } catch (error) {
        evidence.cleanup.errors.push(`db-summary:${safeError(error)}`);
      }
    }
    const parentsExited = evidence.processes.closes.length > 0
      && evidence.processes.closes.every((record) => record.parentExited);
    const desktopRemaining = evidence.processes.closes.flatMap((record) => record.desktopRemaining);
    const canRemove = !businessError && dataDir && parentsExited && desktopRemaining.length === 0;
    if (canRemove) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        evidence.cleanup.tempDirRemoved = !fs.existsSync(dataDir);
        if (!evidence.cleanup.tempDirRemoved) evidence.cleanup.errors.push("temp dir still exists");
      } catch (error) {
        evidence.cleanup.errors.push(`rm:${safeError(error)}`);
      }
    } else {
      evidence.cleanup.tempDirRemoved = false;
      if (dataDir) evidence.cleanup.preservedDataDir = dataDir;
      if (!businessError) evidence.cleanup.errors.push("app/desktop exit unconfirmed; fixture kept");
    }
    evidence.requests = server
      ? server.requests.map((entry, index) => ({
          index, lastUser: entry.lastUser, messages: entry.body?.messages ?? null,
        }))
      : [];
    evidence.fixtureErrors = server?.errors ?? [];
    if (businessError || evidence.cleanup.errors.length > 0) evidence.machineVerdict = "FAIL";
    try { writeEvidence(); } catch (error) {
      evidence.cleanup.errors.push(`evidence:${safeError(error)}`);
    }
  }

  if (businessError) {
    if (evidence.cleanup.errors.length > 0) {
      businessError.message += `；清理错误：${evidence.cleanup.errors.join(" | ")}`;
    }
    throw businessError;
  }
  assert.equal(evidence.processes.closes.length >= 3, true, "应记录配置、面板和重启聊天的退出");
  for (const record of evidence.processes.closes) {
    assert.equal(record.parentExited, true, `${record.label} 父进程未确认退出`);
    assert.deepEqual(record.desktopRemaining, [], `${record.label} desktop 未确认退出`);
  }
  assert.equal(evidence.localHttp.stopped, true);
  assert.equal(evidence.localHttp.resumed, true);
  assert.equal(evidence.cleanup.httpClosed, true);
  assert.equal(evidence.cleanup.tempDirRemoved, true);
  assert.deepEqual(evidence.cleanup.errors, [], `清理失败：${evidence.cleanup.errors.join(" | ")}`);
});
