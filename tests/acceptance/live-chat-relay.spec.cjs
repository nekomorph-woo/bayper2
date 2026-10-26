/* S03g 真实 DeepSeek 聊天转告三轮对照验收（不经过 GUI）。
   读取根 .env 凭据；最多 1 次 models、3 次 chat，不自动重试。
   三个独立临时库分别覆盖：明确转告只投递指定事实、关系描述不作为接收者
   授权、单纯询问不执行。结论以真实 SQLite 结果和本地回复为准，不把模型
   返回字段当作执行证据；证据保留脱敏 messages、模型建议、最终回复、源 SHA、
   SQLite 摘要与清理结果。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const batchName = process.env.S03G_LIVE_BATCH ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
const batchDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03g-live-chat-relay", batchName);
const CHARACTER_ID = "rin";
const LIVE_MODEL = "deepseek-flash";
const CHAT_BUDGET = 3;
const RELAY_SUCCESS_REPLY = "好，我已经把这件事告诉琥珀了。";
const RELAY_CLARIFY_REPLY = "我还不能转告：需要你明确说要把哪件事告诉哪一位已结识角色。这次没有改动任何记忆。";
const RELAY_NOT_PROCESSED_REPLY = "我这次没有转告任何内容。";
const FALSE_SUCCESS = /(?:已经|成功|完成|好了).{0,8}(?:转告|告诉|转达)|(?:转告|告诉|转达).{0,8}(?:已经|成功|完成|好了)/u;
const sourceFiles = ["app/chat.cjs", "app/chat-memory-operations.cjs", "app/memory.cjs",
  "app/memory-store.cjs", "tests/acceptance/live-chat-relay.spec.cjs"];

const evidence = {
  caseSet: "S03G-LIVE", batch: path.relative(repoRoot, batchDir), executedAt: new Date().toISOString(),
  model: { requested: LIVE_MODEL, presentInModels: false },
  calls: { models: 0, modelsBudget: 1, chat: 0, chatBudget: CHAT_BUDGET, automaticRetry: false },
  scenarios: [], cleanup: { contexts: [], errors: [], ok: false }, sourceSha: {},
  machineVerdict: "MACHINE_FAIL", semanticReviewStatus: "PENDING_CODEX", fatalError: null,
};
let liveCredentials = null;
let lastMessages = null;
let lastSuggestion = null;

test("S03G 真实 DeepSeek：聊天转告三轮对照", { timeout: 600000 }, async () => {
  console.log(`S03G_LIVE_BATCH ${evidence.batch}`);
  try {
    for (const file of sourceFiles) evidence.sourceSha[file] = sha256(fs.readFileSync(path.join(repoRoot, file)));
    liveCredentials = loadCredentials();
    const modelIds = await listModels(liveCredentials.baseUrl, liveCredentials.apiKey);
    evidence.model.presentInModels = modelIds.includes(LIVE_MODEL);
    assert.equal(evidence.model.presentInModels, true, `GET /models 未返回 ${LIVE_MODEL}`);
    await runDeliverDrink();
    await runAddressViaFriend();
    await runQuestionOnly();
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

async function runDeliverDrink() {
  const rec = startRec("LIVE-1", "把我的饮品偏好告诉琥珀",
    ["回复是否自然说明已把饮品偏好告诉琥珀，未提及住址或其他事实"]);
  try {
    await withFixture("deliver-drink", seedRin, async (store) => {
      await perform(rec, store);
      const rinDrink = store.memory.listMemories(CHARACTER_ID).find((e) => e.factKey === "pref.drink");
      const hu = store.memory.listMemories("hu");
      check(rec, "琥珀只新增饮品偏好且正文一致",
        hu.length === 1 && hu[0]?.body === "用户的饮品偏好是冰美式");
      check(rec, "来源为凛并派生自凛的饮品条目",
        hu[0]?.originCharacterId === "rin" && hu[0]?.narratorCharacterId === "rin" &&
          hu[0]?.derived === true && hu[0]?.derivedFromEntryId === rinDrink?.id);
      check(rec, "澄没有新增记忆", store.memory.listMemories("cheng").length === 0);
      check(rec, "住址没有被带给琥珀",
        hu.every((entry) => !entry.body.includes("杭州") && !entry.body.includes("西湖")));
      check(rec, "本地回复如实说明已转告琥珀",
        rec.reply === RELAY_SUCCESS_REPLY && claimsRelaySuccess(rec.reply));
      check(rec, "本轮只有一次 chat HTTP", rec.chatCalls === 1);
    });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

async function runAddressViaFriend() {
  const rec = startRec("LIVE-2", "把我的住址告诉琥珀的朋友",
    ["回复是否说明无法确认“琥珀的朋友”而澄清，不声称已完成转告"]);
  try {
    await withFixture("address-via-friend", (store) => seedRin(store, { address: true }),
      async (store) => {
        await perform(rec, store);
        const hu = store.memory.listMemories("hu");
        const cheng = store.memory.listMemories("cheng");
        const holdsAddress = (entries) =>
          entries.some((entry) => entry.body.includes("杭州") || entry.body.includes("西湖"));
        check(rec, "琥珀没有获得住址且无新增", hu.length === 0 && !holdsAddress(hu));
        check(rec, "澄没有获得住址且无新增", cheng.length === 0 && !holdsAddress(cheng));
        const address = store.memory.listMemories(CHARACTER_ID).find((e) => e.factKey === "detail.address");
        check(rec, "凛持有的住址保持原样",
          address?.body === "用户的住址是杭州市西湖区" &&
            store.memory.listMemories(CHARACTER_ID).length === 2);
        check(rec, "本地回复要求澄清接收者且不假成功",
          rec.reply === RELAY_CLARIFY_REPLY && !claimsRelaySuccess(rec.reply));
        check(rec, "本轮只有一次 chat HTTP", rec.chatCalls === 1);
      });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

async function runQuestionOnly() {
  const rec = startRec("LIVE-3", "我只是问问，你能把饮品偏好告诉琥珀吗",
    ["回复是否把能力问句当作询问，说明本次没有转告"]);
  try {
    await withFixture("question-only", (store) => seedRin(store, { address: true }), async (store) => {
      await perform(rec, store);
      const rin = store.memory.listMemories(CHARACTER_ID);
      check(rec, "琥珀没有获得饮品偏好", store.memory.listMemories("hu").length === 0);
      check(rec, "澄没有新增记忆", store.memory.listMemories("cheng").length === 0);
      check(rec, "凛原有饮品与住址未变",
        rin.length === 2 && rin.find((e) => e.factKey === "pref.drink")?.body === "用户的饮品偏好是冰美式" &&
          rin.find((e) => e.factKey === "detail.address")?.body === "用户的住址是杭州市西湖区");
      check(rec, "本地回复说明本次没有转告且不假成功",
        rec.reply === RELAY_NOT_PROCESSED_REPLY && !claimsRelaySuccess(rec.reply));
      check(rec, "本轮只有一次 chat HTTP", rec.chatCalls === 1);
    });
  } catch (error) { markExecutionError(rec, error); }
  finishRec(rec);
}

function startRec(id, userText, semanticItems) {
  const rec = {
    id, userText, status: "NOT_RUN", errorCode: null, error: null, reply: null,
    chatCalls: 0, messages: null, modelSuggestion: null, memoryApplied: 0, db: {},
    machineChecks: [], machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX", semanticItems,
  };
  evidence.scenarios.push(rec);
  return rec;
}

async function perform(rec, store) {
  const before = evidence.calls.chat;
  lastMessages = null;
  lastSuggestion = null;
  try {
    const result = await store.chat.sendMessage({
      characterId: CHARACTER_ID, conversationId: openConversation(store).id,
      text: rec.userText, requestId: `${rec.id.toLowerCase()}-live`,
    });
    rec.status = result.status;
    rec.reply = result.reply;
    rec.errorCode = result.errorCode ?? null;
    rec.memoryApplied = result.memoryApplied;
  } catch (error) {
    rec.status = "ERROR";
    rec.error = safeError(error);
  }
  rec.chatCalls = evidence.calls.chat - before;
  rec.messages = lastMessages;
  rec.modelSuggestion = lastSuggestion;
  rec.db = snapshotDb(store);
}

async function withFixture(name, seed, fn) {
  let dir = null;
  let store = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-live-s03g-${name}-`));
    store = createStore(dir, { chat: {
      getCredentials: async () => ({ baseUrl: liveCredentials.baseUrl, modelName: LIVE_MODEL, apiKey: liveCredentials.apiKey }),
      fetchImpl, timeoutMs: 45000,
    } });
    store.acceptCharacter({ characterId: CHARACTER_ID, day: new Date().toISOString().slice(0, 10), acceptedAt: new Date().toISOString() });
    seed(store);
    await fn(store);
  } finally {
    // 目录或 store 构造失败时也进入这里；记录安全证据并释放已获得的资源。
    await closeFixture(name, dir, store);
  }
}

async function closeFixture(name, dir, store) {
  const record = { name, dirCreated: Boolean(dir), storeCreated: Boolean(store), disposeOk: false,
    closeOk: false, tempDirRemoved: false, errors: [] };
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
    } catch (error) {
      record.errors.push(`rm:${safeError(error).message}`);
    }
  } else {
    record.errors.push("temp dir not created");
  }
  evidence.cleanup.contexts.push(record);
  if (record.errors.length > 0) {
    evidence.cleanup.errors.push(`${name}: ${record.errors.join("; ")}`);
  }
  evidence.cleanup.ok = evidence.cleanup.errors.length === 0 &&
    evidence.cleanup.contexts.every((item) => item.tempDirRemoved);
}

/* 凛持有饮品；两个接收者都已结识，但与凛的饮品/住址没有派生关系，
   场景 2 的“琥珀的朋友”因此没有唯一可授权的接收者。 */
function seedRin(store, { address = false } = {}) {
  store.memory.remember({
    characterId: CHARACTER_ID, factKey: "pref.drink", body: "用户的饮品偏好是冰美式",
    kind: "preference", sourceId: "seed-live-rin-drink",
  });
  if (address) {
    store.memory.remember({
      characterId: CHARACTER_ID, factKey: "detail.address", body: "用户的住址是杭州市西湖区",
      kind: "detail", sourceId: "seed-live-rin-address",
    });
  }
  const now = new Date().toISOString();
  const insert = store.db.prepare(
    "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
  );
  insert.run("hu", now);
  insert.run("cheng", now);
}

function openConversation(store) {
  return store.chat.openConversation({ characterId: CHARACTER_ID }).conversation;
}

function check(rec, name, pass) {
  rec.machineChecks.push({ name, pass: Boolean(pass) });
}

function claimsRelaySuccess(reply) {
  return typeof reply === "string" && FALSE_SUCCESS.test(reply);
}

function markExecutionError(rec, error) {
  if (rec.status !== "completed") rec.status = "ERROR";
  rec.error = safeError(error);
  check(rec, "case execution", false);
}

function finishRec(rec) {
  const pass = rec.status === "completed" && rec.chatCalls === 1 &&
    rec.machineChecks.length > 0 && rec.machineChecks.every((item) => item.pass);
  rec.machineVerdict = pass ? "PASS" : "FAIL";
  rec.semanticReviewStatus = "PENDING_CODEX";
}

function snapshotDb(store) {
  const memories = {};
  for (const id of ["rin", "hu", "cheng"]) memories[id] = store.memory.listMemories(id);
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    memories,
    relationships: store.db.prepare("SELECT character_id, accepted_at FROM relationships ORDER BY character_id").all(),
    shareControls: count("memory_share_controls"), forgetControls: count("memory_forget_controls"),
  };
}

async function fetchImpl(url, init) {
  if (evidence.calls.chat >= CHAT_BUDGET) throw new Error("chat 调用预算已用完");
  evidence.calls.chat += 1;
  lastMessages = messagesOf(init);
  lastSuggestion = null;
  const response = await fetch(url, init);
  try {
    lastSuggestion = suggestionOf(await response.clone().json());
  } catch { lastSuggestion = null; }
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
