/* S03f 真实 DeepSeek 自然语言记忆操作验收（不经过 GUI）。
   读取根 .env 凭据；最多 1 次 models、6 次 chat，无自动重试。
   证据只存安全 messages、回复、DB 快照、源 SHA、机器结论；语义留给 Codex。 */
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
const batchName = process.env.S03F_LIVE_BATCH ?? `claude-${new Date().toISOString().replace(/[.:]/gu, "-")}`;
const batchDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence", "s03f-live-chat-memory", batchName);
const CHARACTER_ID = "rin";
const LIVE_MODEL = "deepseek-flash";
const CHAT_BUDGET = 6;
const TIMEOUT_MS = 45000;
const sourceFiles = ["app/chat.cjs", "app/chat-memory-operations.cjs", "app/memory.cjs", "tests/acceptance/live-chat-memory-operations.spec.cjs"];
const evidence = {
  caseSet: "S03F-LIVE", batch: path.relative(repoRoot, batchDir), executedAt: new Date().toISOString(),
  model: { requested: LIVE_MODEL, presentInModels: false },
  calls: { models: 0, modelsBudget: 1, chat: 0, chatBudget: CHAT_BUDGET, automaticRetry: false },
  scenarios: [], cleanup: { contexts: [], errors: [], ok: false }, sourceSha: {},
  machineVerdict: "MACHINE_FAIL", semanticReviewStatus: "PENDING_CODEX", fatalError: null,
};
let liveCredentials = null;
let lastMessages = null;
let lastOperation = null;
test("S03F 真实 DeepSeek：六场自然语言记忆操作", { timeout: 600000 }, async () => {
  console.log(`S03F_LIVE_BATCH ${evidence.batch}`);
  try {
    for (const file of sourceFiles) {
      evidence.sourceSha[file] = sha256(fs.readFileSync(path.join(repoRoot, file)));
    }
    liveCredentials = loadCredentials();
    const modelIds = await listModels(liveCredentials.baseUrl, liveCredentials.apiKey);
    evidence.model.presentInModels = modelIds.includes(LIVE_MODEL);
    assert.equal(evidence.model.presentInModels, true, `GET /models 未返回 ${LIVE_MODEL}`);
    await runCorrectionCase("LIVE-1", "我喜欢咖啡，不是茶，请纠正一下。", "不是茶", "回复是否自然承接纠正、不把茶当作当前偏好");
    await runCorrectionCase("LIVE-2", "我不是喜欢茶，而是喜欢咖啡。", "不是喜欢茶", "回复是否自然接受“不是茶而是咖啡”");
    await runAddressPair();
    await runRestrictCase();
    await runNarrationCase();
  } catch (error) {
    evidence.fatalError = safeError(error);
  } finally {
    evidence.machineVerdict =
      !evidence.fatalError &&
      evidence.scenarios.length === 6 &&
      evidence.scenarios.every((item) => item.machineVerdict === "PASS") &&
      evidence.cleanup.ok
        ? "MACHINE_PASS"
        : "MACHINE_FAIL";
    writeEvidence();
  }
  assert.equal(evidence.machineVerdict, "MACHINE_PASS", `真实服务机器结论 ${evidence.machineVerdict}；证据 ${evidence.batch}`);
  assert.deepEqual(evidence.cleanup.errors, [], `清理失败：${evidence.cleanup.errors.join(" | ")}`);
});
async function runCorrectionCase(id, text, negation, semanticItem) {
  const rec = startRec(id, text, [semanticItem]);
  try {
    await withFixture(id, (store) => seedPreference(store), async (store) => {
      const conversation = openConversation(store);
      await perform(rec, store, conversation, text);
      const active = store.memory.listMemories(CHARACTER_ID);
      const preference = active.find((entry) => entry.kind === "preference");
      check(rec, "咖啡成为当前偏好", Boolean(preference?.body.includes("咖啡")));
      check(rec, "旧茶以否定上下文保留", Boolean(preference?.body.includes(negation)));
      check(rec, "旧茶正向偏好被替换", active.every((entry) => entry.body !== "用户喜欢茶"));
      check(rec, "无关事实保留", active.some((entry) => entry.factKey === "detail.cat"));
    });
  } catch (error) {
    markExecutionError(rec, error);
  }
  finishRec(rec);
}

async function runAddressPair() {
  const first = startRec("LIVE-3", "能帮我忘记之前说的住址吗？", ["回复是否确认删除但不夸大"]);
  const second = startRec("LIVE-4", "我住在哪里？", ["回复是否表示不知道/请补充，不猜住址、不作“从没说过”的历史断言"]);
  try {
    await withFixture("address-pair", (store) => seedAddress(store), async (store) => {
      const conversation = openConversation(store);
      await perform(first, store, conversation, first.userText);
      await perform(second, store, conversation, second.userText);
      const active = store.memory.listMemories(CHARACTER_ID);
      check(first, "住址记忆删除", active.every((entry) => !entry.body.includes("杭州") && !entry.body.includes("西湖")));
      check(first, "无关工作事实保留", active.some((entry) => entry.factKey === "detail.job"));
      const sent = JSON.stringify(second.messages ?? []);
      check(second, "下一轮 messages 不含旧住址", !sent.includes("杭州") && !sent.includes("西湖") && !sent.includes("住址是"));
      check(second, "回复不猜住址", !String(second.reply ?? "").includes("杭州") && !String(second.reply ?? "").includes("西湖"));
    });
  } catch (error) {
    markExecutionError(first, error);
    markExecutionError(second, error);
  }
  finishRec(first);
  finishRec(second);
}

async function runRestrictCase() {
  const rec = startRec("LIVE-5", "我喜欢热茶这件事不要再告诉其他角色了。", ["回复是否只说明以后不分享，不声称撤回旧传播"]);
  try {
    await withFixture("restrict", (store) => seedHotTea(store), async (store) => {
      const conversation = openConversation(store);
      await perform(rec, store, conversation, rec.userText);
      const hot = store.memory.listMemories(CHARACTER_ID).find((entry) => entry.factKey === "pref.hot-tea");
      const controls = store.db.prepare("SELECT COUNT(*) AS count FROM memory_share_identity_controls").get().count;
      check(rec, "禁分享控制已落库", controls >= 1);
      check(rec, "已有热茶内容保留", Boolean(hot && hot.body.includes("热茶")));
      let blocked = false;
      if (hot) {
        try {
          store.memory.relay({ fromCharacterId: CHARACTER_ID, toCharacterId: "hu", entries: [{ entryId: hot.id, expectedVersion: hot.version }] });
        } catch (error) {
          blocked = error?.code === "SHARE_BLOCKED";
        }
      }
      check(rec, "后续 relay 被拒绝", blocked);
    });
  } catch (error) {
    markExecutionError(rec, error);
  }
  finishRec(rec);
}

async function runNarrationCase() {
  const rec = startRec("LIVE-6", "我忘了带钥匙，能帮我想想怎么办吗？", ["回复是否自然帮助想办法，没有把忘带钥匙误当记忆删除"]);
  try {
    await withFixture("narration", (store) => seedKey(store), async (store) => {
      const conversation = openConversation(store);
      await perform(rec, store, conversation, rec.userText);
      const active = store.memory.listMemories(CHARACTER_ID);
      check(rec, "钥匙事实未被删除", active.some((entry) => entry.factKey === "detail.key"));
      const forgetControls = store.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_identity_controls").get().count;
      const deletedFingerprints = store.db.prepare("SELECT COUNT(*) AS count FROM memory_deleted_fact_fingerprints").get().count;
      check(rec, "没有产生删除控制", forgetControls === 0 && deletedFingerprints === 0);
    });
  } catch (error) {
    markExecutionError(rec, error);
  }
  finishRec(rec);
}

function startRec(id, userText, semanticItems) {
  const rec = {
    id, userText, status: "NOT_RUN", errorCode: null, reply: null,
    chatCalls: 0, messages: null, memoryApplied: 0, operation: null, db: {},
    machineChecks: [], machineVerdict: "FAIL", semanticReviewStatus: "PENDING_CODEX", semanticItems,
  };
  evidence.scenarios.push(rec);
  return rec;
}

async function perform(rec, store, conversation, text) {
  const before = evidence.calls.chat;
  lastMessages = null;
  lastOperation = null;
  rec.userText = text;
  try {
    const result = await store.chat.sendMessage({ characterId: CHARACTER_ID, conversationId: conversation.id, text });
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
  rec.operation = lastOperation;
  rec.db = snapshotDb(store);
}

async function withFixture(name, seed, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-live-s03f-${name}-`));
  let store = null;
  try {
    store = createStore(dir, {
      chat: {
        getCredentials: async () => ({ baseUrl: liveCredentials.baseUrl, modelName: LIVE_MODEL, apiKey: liveCredentials.apiKey }),
        fetchImpl,
        timeoutMs: TIMEOUT_MS,
      },
    });
    store.acceptCharacter({ characterId: CHARACTER_ID, day: new Date().toISOString().slice(0, 10), acceptedAt: new Date().toISOString() });
    seed(store);
    await fn(store);
  } finally {
    await closeFixture(name, dir, store);
  }
}

async function closeFixture(name, dir, store) {
  const record = { name, storeCreated: Boolean(store), disposeOk: false, closeOk: false, tempDirRemoved: false, errors: [] };
  if (store) {
    try { await store.chat.dispose(); record.disposeOk = true; } catch (error) { record.errors.push(`dispose:${safeError(error).message}`); }
    try { store.close(); record.closeOk = true; } catch (error) { record.errors.push(`close:${safeError(error).message}`); }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    record.tempDirRemoved = !fs.existsSync(dir);
    if (!record.tempDirRemoved) record.errors.push("temp dir still exists");
  } catch (error) {
    record.errors.push(`rm:${safeError(error).message}`);
  }
  evidence.cleanup.contexts.push(record);
  if (record.errors.length > 0) evidence.cleanup.errors.push(`${name}: ${record.errors.join("; ")}`);
  evidence.cleanup.ok = evidence.cleanup.errors.length === 0 && evidence.cleanup.contexts.every((item) => item.tempDirRemoved);
}

function seedPreference(store) {
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "pref.tea", body: "用户喜欢茶", kind: "preference", sourceId: "seed-live-tea" });
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "detail.cat", body: "用户有一只叫团子的猫", kind: "detail", sourceId: "seed-live-cat" });
}
function seedAddress(store) {
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "detail.address", body: "用户的住址是杭州市西湖区", kind: "detail", sourceId: "seed-live-address" });
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "detail.job", body: "用户的工作是设计师", kind: "detail", sourceId: "seed-live-job" });
}
function seedHotTea(store) {
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "pref.hot-tea", body: "用户喜欢热茶", kind: "preference", sourceId: "seed-live-hot-tea" });
  store.db.prepare("INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)").run("hu", new Date().toISOString());
}
function seedKey(store) {
  store.memory.remember({ characterId: CHARACTER_ID, factKey: "detail.key", body: "用户的钥匙放在玄关", kind: "detail", sourceId: "seed-live-key" });
}
function openConversation(store) { return store.chat.openConversation({ characterId: CHARACTER_ID }).conversation; }
function check(rec, name, pass) { rec.machineChecks.push({ name, pass: Boolean(pass) }); }
function markExecutionError(rec, error) {
  if (rec.status !== "completed") rec.status = "ERROR";
  rec.error = safeError(error);
  check(rec, "case execution", false);
}
function finishRec(rec) {
  const pass = rec.status === "completed" && rec.chatCalls <= 1 && rec.machineChecks.length > 0 && rec.machineChecks.every((item) => item.pass);
  rec.machineVerdict = pass ? "PASS" : "FAIL";
  rec.semanticReviewStatus = "PENDING_CODEX";
}

function snapshotDb(store) {
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    memories: store.memory.listMemories(CHARACTER_ID).map(({ factKey, body, kind, trust, expiresAt }) => ({ factKey, body, kind, trust, expiresAt })),
    shareControls: count("memory_share_identity_controls"),
    forgetControls: count("memory_forget_identity_controls"),
    deletedFingerprints: count("memory_deleted_fact_fingerprints"),
  };
}
async function fetchImpl(url, init) {
  if (evidence.calls.chat >= CHAT_BUDGET) throw new Error("chat 调用预算已用完");
  evidence.calls.chat += 1;
  lastMessages = messagesOf(init);
  const response = await fetch(url, init);
  lastOperation = await operationOf(response);
  return response;
}
async function operationOf(response) {
  try {
    const data = await response.clone().json();
    const content = data?.choices?.[0]?.message?.content;
    const op = (typeof content === "string" ? JSON.parse(content) : null)?.memoryOperation;
    if (!op || typeof op !== "object" || Array.isArray(op)) return { present: Boolean(op), action: null, target: null, evidence: null, excerpt: null };
    return { present: true, action: typeof op.action === "string" ? op.action : null, target: typeof op.target === "string" ? op.target : null, evidence: typeof op.evidence === "string" ? op.evidence : null, excerpt: typeof op.excerpt === "string" ? op.excerpt : null };
  } catch { return null; }
}
function messagesOf(init) {
  try {
    const body = JSON.parse(String(init?.body ?? ""));
    return Array.isArray(body?.messages) ? body.messages.map(({ role, content }) => ({ role, content })) : null;
  } catch { return null; }
}
function loadCredentials() {
  let values;
  try { values = parseEnv(fs.readFileSync(path.join(repoRoot, ".env"), "utf8")); } catch { throw new Error("无法读取根 .env"); }
  const baseUrl = values.OPEN_AI_BASE_URL, apiKey = values.OPEN_AI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY");
  return { baseUrl: parseBaseUrl(baseUrl), apiKey };
}
async function listModels(baseUrl, apiKey) {
  evidence.calls.models += 1;
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  } catch { throw new Error("GET /models 网络请求失败"); }
  if (response.status !== 200) throw new Error(`GET /models 返回 HTTP ${response.status}`);
  let data;
  try { data = await response.json(); } catch { throw new Error("GET /models 未返回有效 JSON"); }
  return Array.isArray(data?.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeError(error) {
  const message = String(error?.message ?? error).replace(/https?:\/\/\S+/gu, "<url>").replace(/sk-[A-Za-z0-9_-]+/gu, "<redacted>").replace(/Bearer\s+\S+/gu, "<redacted>");
  return { code: error?.code ?? "ERROR", message: message.slice(0, 300) };
}
function writeEvidence() {
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const source = Object.entries(evidence.sourceSha).map(([file, hash]) => `${hash}  ${file}`).join("\n");
  fs.writeFileSync(path.join(batchDir, "source.sha256"), `${source}\n`, "utf8");
}
