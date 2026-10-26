/* S03h 真实 DeepSeek 独属记忆三例对照验收（不经过 GUI）。最多 1 次 models、3 次
   chat 且不自动重试；三个独立临时库分别覆盖明确“只让你记得”保留独属、陈述
   “就你记得”不构成删除授权、能力询问不执行。结论以真实 SQLite、FTS、控制、
   上下文和本地回复为准；模型建议只作证据，证据含脱敏 messages、建议、回复、
   SQLite 前后摘要、源 SHA、HTTP 计数与清理结果。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { isDeepStrictEqual, parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const batchName = process.env.S03H_LIVE_BATCH ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
const batchDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03h-live-exclusive", batchName);
const CHARACTER_ID = "rin";
const OTHERS = ["hu", "cheng"];
const LIVE_MODEL = "deepseek-flash";
const CHAT_BUDGET = 3;
const DRINK = "用户的饮品偏好是冰美式";
const ADDRESS = "用户的住址是杭州市西湖区";
const SUCCESS_REPLY = "好，这件事只留在我这里记得；其他角色已有的这条内容已清除，之后我也不会再分享或转告。";
/* 机器只认动作与“已经/已/成功/完成”同时出现的声明；“只留在我这里”这类
   裸短语也可能只是询问或复述（如“你是想把它只留在我这里吗？”），单独出现
   不构成执行证据。机器结论只覆盖这些明确声明，语义仍由 Codex 逐句审查。 */
const EXCLUSIVE_CLAIM =
  /(?:已经|我已|已(?!有)|成功|完成).{0,10}(?:清除|删掉|删除|只留|只保留|独属|独占)|(?:清除|删掉|删除|只留|只保留|独属|独占).{0,10}(?:已经|我已|已(?!有)|成功|完成)/u;
const sourceFiles = ["app/chat.cjs", "app/chat-memory-operations.cjs", "app/memory.cjs",
  "app/memory-store.cjs", "tests/acceptance/live-chat-exclusive.spec.cjs"];

const evidence = {
  caseSet: "S03H-LIVE-EXCLUSIVE", batch: path.relative(repoRoot, batchDir), executedAt: new Date().toISOString(),
  model: { requested: LIVE_MODEL, presentInModels: false },
  calls: { models: 0, modelsBudget: 1, chat: 0, chatBudget: CHAT_BUDGET, automaticRetry: false },
  scenarios: [], cleanup: { contexts: [], errors: [], ok: false }, sourceSha: {},
  machineVerdict: "MACHINE_FAIL", semanticReviewStatus: "PENDING_CODEX", fatalError: null,
};
let liveCredentials = null;
let lastMessages = null;
let lastSuggestion = null;

test("S03H 真实 DeepSeek：独属记忆三例对照", { timeout: 600000 }, async () => {
  console.log(`S03H_LIVE_BATCH ${evidence.batch}`);
  try {
    for (const file of sourceFiles) evidence.sourceSha[file] = sha256(fs.readFileSync(path.join(repoRoot, file)));
    liveCredentials = loadCredentials();
    const modelIds = await listModels(liveCredentials.baseUrl, liveCredentials.apiKey);
    evidence.model.presentInModels = modelIds.includes(LIVE_MODEL);
    assert.equal(evidence.model.presentInModels, true, `GET /models 未返回 ${LIVE_MODEL}`);
    await runExclusiveCase();
    await runStatementCase();
    await runQuestionCase();
  } catch (error) {
    evidence.fatalError = safeError(error);
  } finally {
    evidence.machineVerdict =
      !evidence.fatalError && evidence.model.presentInModels &&
      evidence.calls.models === 1 && evidence.calls.chat === CHAT_BUDGET &&
      evidence.scenarios.length === 3 &&
      evidence.scenarios.every((item) => item.machineVerdict === "PASS") &&
      evidence.cleanup.ok ? "MACHINE_PASS" : "MACHINE_FAIL";
    writeEvidence();
  }
  assert.equal(evidence.machineVerdict, "MACHINE_PASS",
    `真实服务机器结论 ${evidence.machineVerdict}；证据 ${evidence.batch}`);
  assert.deepEqual(evidence.cleanup.errors, [], `清理失败：${evidence.cleanup.errors.join(" | ")}`);
});

async function runExclusiveCase() {
  const rec = startRec("POL-EXCLUSIVE-LIVE-001", "我的饮品偏好只让你记得。",
    ["回复是否自然确认只保留凛的饮品记忆，并说明其他角色相应内容与后续分享受限；不声称修改住址或业务进度"]);
  try {
    await withFixture("exclusive", async (store) => {
      await perform(rec, store);
      const rinBefore = memoryOf(rec.dbBefore, CHARACTER_ID, "pref.drink");
      const rinDrink = entryOf(store, CHARACTER_ID, "pref.drink");
      check(rec, "聊天正常完成且操作轮不新增学习事实",
        rec.status === "completed" && rec.memoryApplied === 0);
      check(rec, "凛的饮品正文、来源保持且版本递增",
        rinDrink?.body === DRINK && rinDrink?.sourceId === "seed-live-rin-drink" &&
          rinDrink?.version === rinBefore?.version + 1);
      check(rec, "琥珀的饮品正文与 FTS 已清除",
        entryOf(store, "hu", "pref.drink") === null &&
          store.memory.searchMemories({ characterId: "hu", query: "冰美式" }).length === 0);
      check(rec, "澄仍未知且无新增记忆", store.memory.listMemories("cheng").length === 0);
      check(rec, "凛的住址保持原样", entryOf(store, CHARACTER_ID, "detail.address")?.body === ADDRESS);
      check(rec, "分享控制与琥珀防回流控制已落库",
        rec.dbAfter.controls.share === 1 && rec.dbAfter.controls.forget === 1 &&
          rec.dbAfter.controls.source === 1 &&
          store.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls WHERE character_id = ?")
            .get("cheng").count === 0);
      check(rec, "凛与琥珀上下文版本失效，澄不变",
        rec.dbAfter.contextVersions.rin === rec.dbBefore.contextVersions.rin + 1 &&
          rec.dbAfter.contextVersions.hu === rec.dbBefore.contextVersions.hu + 1 &&
          rec.dbAfter.contextVersions.cheng === rec.dbBefore.contextVersions.cheng);
      let blocked = false;
      try {
        store.memory.relay({ fromCharacterId: CHARACTER_ID, toCharacterId: "cheng",
          entries: [{ entryId: rinDrink.id, expectedVersion: rinDrink.version }] });
      } catch (error) { blocked = error?.code === "SHARE_BLOCKED"; }
      check(rec, "后续转告被分享控制拒绝", blocked);
      check(rec, "本地完成确认只出现一次且如实",
        rec.reply === SUCCESS_REPLY &&
          store.chat.getConversation({ characterId: CHARACTER_ID, conversationId: rec.conversationId })
            .messages.filter((message) => message.role === "assistant").length === 1);
      check(rec, "只向凛发起一次 chat HTTP",
        rec.chatCalls === 1 && rec.dbAfter.requests === 1 &&
          requestCharacters(store).join(",") === CHARACTER_ID);
      check(rec, "角色、名单与数值保持",
        isDeepStrictEqual(rec.dbAfter.business, rec.dbBefore.business));
    });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

async function runStatementCase() {
  const rec = startRec("POL-EXCLUSIVE-LIVE-002", "我发现就你记得我的饮品偏好。",
    ["回复是否把陈述当作陈述，不声称已清除其他持有者或执行独属保留"]);
  try {
    await withFixture("statement", async (store) => {
      await perform(rec, store);
      checkNoExecution(rec, store);
    });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

async function runQuestionCase() {
  const rec = startRec("POL-EXCLUSIVE-LIVE-003", "你能只让自己记得我的饮品偏好吗？",
    ["回复是否把能力询问当作询问，不声称已执行独属保留或清除其他持有者"]);
  try {
    await withFixture("question", async (store) => {
      await perform(rec, store);
      checkNoExecution(rec, store);
    });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

/* 陈述与能力询问都不得改变持有者、版本、控制或业务状态；模型即使给出
   keepExclusive 建议，本地也会因原话不构成命令而拒绝执行。 */
function checkNoExecution(rec, store) {
  const rinBefore = memoryOf(rec.dbBefore, CHARACTER_ID, "pref.drink");
  const huBefore = memoryOf(rec.dbBefore, "hu", "pref.drink");
  const rinDrink = entryOf(store, CHARACTER_ID, "pref.drink");
  const huDrink = entryOf(store, "hu", "pref.drink");
  check(rec, "凛的饮品正文、来源与版本不变",
    rinDrink?.body === DRINK && rinDrink?.sourceId === rinBefore?.sourceId &&
      rinDrink?.version === rinBefore?.version);
  check(rec, "琥珀的转述饮品正文与版本不变",
    huDrink?.body === DRINK && huDrink?.narratorCharacterId === CHARACTER_ID &&
      huDrink?.version === huBefore?.version);
  check(rec, "澄仍未知且凛的住址保持原样",
    store.memory.listMemories("cheng").length === 0 &&
      entryOf(store, CHARACTER_ID, "detail.address")?.body === ADDRESS);
  check(rec, "记忆、版本、控制与上下文均未变化",
    isDeepStrictEqual(rec.dbAfter.memories, rec.dbBefore.memories) &&
      isDeepStrictEqual(rec.dbAfter.controls, rec.dbBefore.controls) &&
      rec.dbAfter.controls.share === 0 &&
      isDeepStrictEqual(rec.dbAfter.contextVersions, rec.dbBefore.contextVersions));
  check(rec, "只有一次凛的 chat HTTP",
    rec.chatCalls === 1 && rec.dbAfter.requests === 1 &&
      requestCharacters(store).join(",") === CHARACTER_ID);
  check(rec, "回复不虚称已清除或执行独属",
    !(typeof rec.reply === "string" && (rec.reply === SUCCESS_REPLY || EXCLUSIVE_CLAIM.test(rec.reply))));
  check(rec, "角色、名单与数值保持",
    isDeepStrictEqual(rec.dbAfter.business, rec.dbBefore.business));
}

function startRec(id, userText, semanticItems) {
  const rec = {
    id, userText, status: "NOT_RUN", error: null, reply: null,
    chatCalls: 0, messages: null, modelSuggestion: null, memoryApplied: 0,
    conversationId: null, dbBefore: null, dbAfter: null, machineChecks: [],
    machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX", semanticItems,
  };
  evidence.scenarios.push(rec);
  return rec;
}

async function perform(rec, store) {
  const before = evidence.calls.chat;
  lastMessages = null;
  lastSuggestion = null;
  rec.dbBefore = snapshotDb(store);
  try {
    const conversation = store.chat.openConversation({ characterId: CHARACTER_ID }).conversation;
    rec.conversationId = conversation.id;
    const result = await store.chat.sendMessage({
      characterId: CHARACTER_ID, conversationId: conversation.id,
      text: rec.userText, requestId: `${rec.id.toLowerCase()}-live`,
    });
    rec.status = result.status;
    rec.reply = result.reply;
    rec.memoryApplied = result.memoryApplied;
  } catch (error) {
    rec.status = "ERROR";
    rec.error = safeError(error);
  }
  rec.chatCalls = evidence.calls.chat - before;
  rec.messages = lastMessages;
  rec.modelSuggestion = lastSuggestion;
  rec.dbAfter = snapshotDb(store);
}

async function withFixture(name, fn) {
  let dir = null;
  let store = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-live-s03h-${name}-`));
    store = createStore(dir, { chat: {
      getCredentials: async () => ({ baseUrl: liveCredentials.baseUrl, modelName: LIVE_MODEL, apiKey: liveCredentials.apiKey }),
      fetchImpl, timeoutMs: 45000,
    } });
    store.acceptCharacter({ characterId: CHARACTER_ID, day: new Date().toISOString().slice(0, 10), acceptedAt: new Date().toISOString() });
    seedSharedDrink(store);
    await fn(store);
  } finally {
    // 目录或 store 构造失败时也进入这里；记录安全证据并释放已获得的资源。
    await closeFixture(name, dir, store);
  }
}

async function closeFixture(name, dir, store) {
  const record = { name, dirCreated: Boolean(dir), storeCreated: Boolean(store), disposeOk: false, closeOk: false, tempDirRemoved: false, errors: [] };
  if (store) {
    try { await store.chat.dispose(); record.disposeOk = true; }
    catch (error) { record.errors.push(`dispose:${safeError(error).message}`); }
    try { store.close(); record.closeOk = true; }
    catch (error) { record.errors.push(`close:${safeError(error).message}`); }
  }
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      record.tempDirRemoved = !fs.existsSync(dir);
      if (!record.tempDirRemoved) record.errors.push("temp dir still exists");
    } catch (error) { record.errors.push(`rm:${safeError(error).message}`); }
  }
  evidence.cleanup.contexts.push(record);
  if (record.errors.length > 0) evidence.cleanup.errors.push(`${name}: ${record.errors.join("; ")}`);
  evidence.cleanup.ok = evidence.cleanup.errors.length === 0 &&
    evidence.cleanup.contexts.every((item) => item.tempDirRemoved);
}

/* 凛持有饮品和住址；琥珀通过真实 relay 持有同一饮品的转述副本；
   澄只存在于关系/名单中，不持有任何记忆。 */
function seedSharedDrink(store) {
  const drink = store.memory.remember({
    characterId: CHARACTER_ID, factKey: "pref.drink", body: DRINK,
    kind: "preference", sourceId: "seed-live-rin-drink",
  }).entry;
  store.memory.remember({
    characterId: CHARACTER_ID, factKey: "detail.address", body: ADDRESS,
    kind: "detail", sourceId: "seed-live-rin-address",
  });
  const now = new Date().toISOString();
  for (const characterId of OTHERS) {
    store.db.prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)")
      .run(characterId, now);
    store.db.prepare("INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, 10, 100, 0)")
      .run(characterId);
  }
  const relayed = store.memory.relay({
    fromCharacterId: CHARACTER_ID, toCharacterId: "hu",
    entries: [{ entryId: drink.id, expectedVersion: drink.version }],
  });
  if (!relayed.shared[0] || relayed.shared[0].alreadyHeld) {
    throw new Error("夹具构造失败：琥珀没有获得转述饮品。");
  }
}

function entryOf(store, characterId, factKey) {
  return store.memory.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function memoryOf(db, characterId, factKey) {
  return db.memories[characterId].find((entry) => entry.factKey === factKey) ?? null;
}

function requestCharacters(store) {
  return store.db.prepare("SELECT character_id FROM chat_requests ORDER BY created_at, id").all().map((row) => row.character_id);
}

function check(rec, name, pass) {
  rec.machineChecks.push({ name, pass: Boolean(pass) });
}

function markExecutionError(rec, error) {
  if (rec.status !== "completed") rec.status = "ERROR";
  rec.error = safeError(error);
  check(rec, "case execution", false);
}

function finishRec(rec) {
  rec.machineVerdict = rec.status === "completed" && rec.chatCalls === 1 &&
    rec.machineChecks.length > 0 && rec.machineChecks.every((item) => item.pass) ? "PASS" : "FAIL";
  rec.semanticReviewStatus = "PENDING_CODEX";
}

function snapshotDb(store) {
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  const memories = {};
  for (const id of [CHARACTER_ID, ...OTHERS]) {
    memories[id] = store.memory.listMemories(id).map((entry) => ({
      factKey: entry.factKey, body: entry.body, kind: entry.kind, trust: entry.trust,
      version: entry.version, sourceId: entry.sourceId, originCharacterId: entry.originCharacterId,
      narratorCharacterId: entry.narratorCharacterId, derived: entry.derived,
    }));
  }
  return {
    memories,
    controls: { share: count("memory_share_controls"), forget: count("memory_forget_controls"),
      source: count("memory_source_controls") },
    contextVersions: { rin: store.memory.getContextVersion(CHARACTER_ID),
      hu: store.memory.getContextVersion("hu"), cheng: store.memory.getContextVersion("cheng") },
    business: {
      relationships: store.db.prepare("SELECT character_id, accepted_at FROM relationships ORDER BY character_id").all(),
      stats: store.db.prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id").all(),
      roster: store.db.prepare("SELECT day, slot, character_id FROM roster ORDER BY day, slot").all(),
    },
    requests: count("chat_requests"),
  };
}

async function fetchImpl(url, init) {
  if (evidence.calls.chat >= CHAT_BUDGET) throw new Error("chat 调用预算已用完");
  evidence.calls.chat += 1;
  lastMessages = messagesOf(init);
  lastSuggestion = null;
  const response = await fetch(url, init);
  try { lastSuggestion = suggestionOf(await response.clone().json()); }
  catch { lastSuggestion = null; }
  return response;
}

/* 只记录模型给出的建议，不把它当作执行结果；凭据与请求头不进入证据。 */
function suggestionOf(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { parsed: true, envelope: JSON.parse(redact(JSON.stringify(parsed))) };
    }
  } catch {}
  return { parsed: false, rawPreview: redact(content).slice(0, 2000) };
}

function messagesOf(init) {
  try {
    const messages = JSON.parse(String(init?.body ?? "")).messages;
    if (!Array.isArray(messages)) return null;
    return messages.map(({ role, content }) => ({ role: role ?? null, content: redact(content) }));
  } catch { return null; }
}

function loadCredentials() {
  let values;
  try { values = parseEnv(fs.readFileSync(path.join(repoRoot, ".env"), "utf8")); }
  catch { throw new Error("无法读取根 .env"); }
  const baseUrl = values.OPEN_AI_BASE_URL?.trim();
  const apiKey = values.OPEN_AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY");
  return { baseUrl: parseBaseUrl(baseUrl), apiKey };
}

async function listModels(baseUrl, apiKey) {
  if (evidence.calls.models >= 1) throw new Error("models 调用预算已用完");
  evidence.calls.models += 1;
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error("GET /models 网络请求失败"); }
  if (response.status !== 200) throw new Error(`GET /models 返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (!data) throw new Error("GET /models 未返回有效 JSON");
  return Array.isArray(data.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
}

function redact(value) {
  return String(value ?? "").replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "<redacted>")
    .replace(/Bearer\s+\S+/gu, "Bearer <redacted>");
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function safeError(error) {
  return { code: error?.code ?? "ERROR", message: redact(error?.message ?? error).slice(0, 300) };
}

function writeEvidence() {
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const source = Object.entries(evidence.sourceSha).map(([file, hash]) => `${hash}  ${file}`).join("\n");
  fs.writeFileSync(path.join(batchDir, "source.sha256"), `${source}\n`, "utf8");
}
