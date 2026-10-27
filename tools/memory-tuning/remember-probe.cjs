#!/usr/bin/env node
/* S03s 明确记忆真实闭环 probe。默认 dry-run：只读本地 Case、只连 loopback fixture，
   不读 .env、不访问外网；显式 --live 才读取根 .env 并调用真实模型。
   五个 Case 各用独立临时 SQLite，事实只经真实 chat.sendMessage 写入；召回前关闭并
   重开同库、创建新对话，以排除旧聊天历史。工具只报告，不改生产、不重试、不自动判定语义通过。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");
const { INITIAL_STATS } = require("../../app/initial-stats.cjs");
const CHARACTERS = require("../../app/content/characters.json").candidates;

const REPO_ROOT = path.resolve(__dirname, "../..");
const CASES_PATH = path.join(__dirname, "remember-cases.json");
const RESULTS_DIR = path.join(__dirname, "results");
const MODEL = "deepseek-flash";
const REQUEST_TIMEOUT_MS = 60000;
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const PLAN = { models: 1, chat: 9, relation: 2, total: 12 };
const EXPECTED_IDS = ["POL-REMEMBER-LIVE-001", "POL-REMEMBER-LIVE-002", "POL-REMEMBER-LIVE-003",
  "POL-REMEMBER-LIVE-004", "POL-REMEMBER-LIVE-005"];
const PRODUCTION_FILES = ["app/store.cjs", "app/chat.cjs", "app/memory.cjs",
  "app/memory-explicit-remember.cjs", "app/memory-store.cjs", "app/model.cjs"];

/* dry-run 的自检响应只用于验证工具链路，不代表真实模型行为。 */
const DRY = {
  "POL-REMEMBER-LIVE-001": {
    remember: ["好，我记住了。", [["home.doorplate", "我家的门牌是307", "detail"]]],
    recall: ["我记得，你家门牌是307。", []],
  },
  "POL-REMEMBER-LIVE-002": {
    natural: ["记下了。", [["home.doorplate", "我家的门牌是307", "detail"]]],
    remember: ["好，我记住了。", [["home.doorplate", "我家的门牌是307", "detail"]]],
  },
  "POL-REMEMBER-LIVE-003": {
    negative: ["好，这次不保存。", []],
    recall: ["这个我没有印象，不能确定。", []],
  },
  "POL-REMEMBER-LIVE-004": {
    remember: ["好，我记住了门牌。", [
      ["home.doorplate", "我家的门牌是307", "detail"],
      ["home.plant", "我的盆栽叫小叶", "detail"],
      ["home.mixed", "我家的门牌是307，另外我的盆栽叫小叶", "detail"],
    ]],
  },
  "POL-REMEMBER-LIVE-005": {
    remember: ["好，我记住了。", [["home.doorplate", "我家的门牌是307", "detail"]]],
    recall: ["我不知道，我这边没有相关记忆。", []],
  },
};

function fail(message) { throw new Error(message); }
function required(value, label) { if (typeof value !== "string" || !value.trim()) fail(`${label} 必须是非空字符串。`); return value; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function shaOfFile(file) { return { path: path.relative(REPO_ROOT, file), sha256: sha256(fs.readFileSync(file)) }; }
function redact(value) { return String(value ?? "").replace(/https?:\/\/\S+/gu, "<url>")
  .replace(/\bsk-[A-Za-z0-9_-]+/gu, "<redacted>").replace(/Bearer\s+\S+/gu, "Bearer <redacted>"); }
function safeError(error) { return { code: error?.code ?? "ERROR", message: redact(error?.message ?? error).slice(0, 400) }; }
function isLoopbackUrl(value) { try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(String(value)).hostname); } catch { return false; } }
function normalize(value) { return String(value ?? "").normalize("NFKC").toLowerCase(); }
function matches(row, tokens, mode = "all") {
  const text = normalize(row?.body);
  const hits = (tokens ?? []).filter((token) => text.includes(normalize(token)));
  return mode === "all" ? hits.length === (tokens ?? []).length : hits.length > 0;
}
function shortRow(row) { return row ? { id: row.id, factKey: row.factKey, factIdentityId: row.factIdentityId,
  kind: row.kind, body: row.body, importance: row.importance, version: row.version,
  sourceId: row.sourceId, sourceVersion: row.sourceVersion, sourceKind: row.sourceKind } : null; }
const rowsOf = (step, characterId) => step.memory?.after?.[characterId] ?? [];
const addedOf = (step, characterId) => step.memory?.added?.[characterId] ?? [];
const actorIdOf = (actor) => actor === "primary" ? CHARACTERS[0].id : actor === "second" ? CHARACTERS[1]?.id : fail(`未知 actor：${actor}`);
const candidateOf = (step, tokens, mode = "all") => (step.parsed?.memoryCandidates ?? [])
  .filter((candidate) => matches({ body: candidate.evidence ?? candidate.body }, tokens, mode));
function sourceOf(step, row) { return row ? step.sources?.[row.id] ?? null : null; }
function sourceOk(step, row, text) { const source = sourceOf(step, row); return Boolean(source && source.status === "ok" && source.sourceMessage?.content === text); }

function parseArgs(argv) {
  const options = { live: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--live") options.live = true;
    else if (argv[index] === "--out") options.out = path.resolve(process.cwd(), required(argv[++index], "--out"));
    else fail(`参数无效：${argv[index]}`);
  }
  if (!options.out) fail("必须显式提供新的 --out 文件路径。");
  const relative = path.relative(RESULTS_DIR, options.out);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("--out 必须位于 tools/memory-tuning/results/ 内。");
  if (fs.existsSync(options.out)) fail(`拒绝覆盖已有结果：${options.out}`);
  if (!fs.existsSync(path.dirname(options.out))) fail("--out 的目录不存在。");
  return options;
}

function readCases() {
  const text = fs.readFileSync(CASES_PATH, "utf8");
  const data = JSON.parse(text);
  if (typeof data.version !== "string" || !Number.isFinite(Date.parse(data.fixedNow)) ||
    !Array.isArray(data.cases) || data.cases.map((item) => item.id).join("\u0000") !== EXPECTED_IDS.join("\u0000")) {
    fail("Case 文件版本、fixedNow 或固定 5 Case 顺序无效。");
  }
  let chatTurns = 0;
  for (const item of data.cases) {
    required(item.goal, `${item.id}.goal`);
    if (!item.expected || typeof item.expected !== "object" || !Array.isArray(item.steps)) fail(`${item.id} 的 expected/steps 无效。`);
    const ids = new Set();
    for (const step of item.steps) {
      required(step.id, `${item.id}.step.id`); required(step.text, `${item.id}.${step.id}.text`);
      if (ids.has(step.id)) fail(`${item.id} 的 step id 重复。`); ids.add(step.id);
      if (!["primary", "second"].includes(step.actor)) fail(`${item.id}.${step.id}.actor 无效。`);
      if (step.actor === "second" && !CHARACTERS[1]) fail(`${item.id} 需要第二位真实角色。`);
      if (step.id === "recall" && (step.reopen !== true || step.newConversation !== true)) fail(`${item.id} 召回必须重开同库并新建对话。`);
      chatTurns += 1;
    }
  }
  if (chatTurns !== PLAN.chat) fail(`固定 5 Case 的 chat 次数必须为 ${PLAN.chat}，实际 ${chatTurns}。`);
  return { data, text };
}

function loadCredentials() {
  let values;
  try { values = parseEnv(fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8")); }
  catch { fail("无法读取根 .env；live 需要 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。"); }
  const baseUrl = values.OPEN_AI_BASE_URL?.trim(), apiKey = values.OPEN_AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) fail("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY。");
  return { baseUrl: parseBaseUrl(baseUrl), apiKey };
}

async function listModels({ baseUrl, apiKey }) {
  const response = await fetch(`${baseUrl}/models`, { method: "GET", redirect: "manual",
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) fail("GET /models 返回重定向，已停止。");
  if (response.status !== 200) fail(`GET /models 返回 HTTP ${response.status}。`);
  const data = await response.json().catch(() => null);
  return Array.isArray(data?.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
}

async function startFixtureServer() {
  const fixture = { responses: new Map(), baseUrl: null };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const send = (status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
      try {
        if (request.method === "GET" && request.url.endsWith("/models")) { send(200, { data: [{ id: MODEL }] }); return; }
        const body = JSON.parse(raw);
        const text = [...body.messages].reverse().find((message) => message.role === "user")?.content;
        const envelope = fixture.responses.get(text);
        if (!envelope) fail(`dry-run fixture 缺少响应：${String(text).slice(0, 40)}`);
        send(200, { choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }] });
      } catch (error) { send(500, { error: safeError(error).message }); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fixture.close = async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); };
  return fixture;
}

function dryEnvelope(caseId, stepId) {
  const item = DRY[caseId]?.[stepId];
  if (!item) fail(`缺少 dry-run fixture：${caseId}/${stepId}`);
  return { reply: item[0], memoryCandidates: item[1].map(([factKey, body, kind]) =>
    ({ factKey, body, evidence: body, kind, trust: "stated" })), memoryOperation: null, memoryRelay: null };
}

function installFetchSpy({ dryRun }) {
  const original = globalThis.fetch, calls = [], blocked = [];
  const trace = { caseId: null, stepId: null, actor: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    const method = String(init.method ?? "GET").toUpperCase();
    let kind = "chat";
    try {
      if (method === "GET" && new URL(String(url)).pathname.endsWith("/models")) kind = "models";
      else if (body?.messages?.some((message) => message.role === "system" &&
        typeof message.content === "string" && message.content.includes("记忆事实关系判定器"))) kind = "relation";
    } catch { /* 非绝对 URL 仍按聊天请求记录。 */ }
    const entry = { caseId: trace.caseId, stepId: trace.stepId, actor: trace.actor, kind, method,
      url: redact(url), request: body, startedAt: Date.now() };
    calls.push(entry);
    const count = calls.filter((call) => call.kind === kind).length;
    if (count > PLAN[kind]) { entry.error = { code: "CALL_BUDGET_EXCEEDED", message: `${kind} 超出计划上限。` }; throw new Error(entry.error.message); }
    if (calls.length > PLAN.total) { entry.error = { code: "TOTAL_BUDGET_EXCEEDED", message: "HTTP 总调用超出预算。" }; throw new Error(entry.error.message); }
    if (dryRun && !isLoopbackUrl(url)) { blocked.push({ url: entry.url, kind }); entry.error = { code: "NON_LOOPBACK_BLOCKED", message: "dry-run 只允许 loopback。" }; throw new Error(entry.error.message); }
    try {
      const response = await original(input, init);
      entry.status = response.status; entry.durationMs = Date.now() - entry.startedAt;
      entry.response = await response.clone().text();
      return response;
    } catch (error) { entry.error = safeError(error); entry.durationMs = Date.now() - entry.startedAt; throw error; }
  };
  return { calls, blocked, trace, restore() { globalThis.fetch = original; } };
}

function openStore(dir, credentials, fixedNow, withSecond) {
  const store = createStore(dir, { now: () => fixedNow, characters: CHARACTERS,
    chat: { getCredentials: () => credentials, timeoutMs: REQUEST_TIMEOUT_MS } });
  try {
    const acceptedAt = new Date(fixedNow).toISOString();
    const accepted = store.acceptCharacter({ characterId: CHARACTERS[0].id, day: acceptedAt.slice(0, 10), acceptedAt });
    if (withSecond) {
      const exists = store.db.prepare("SELECT 1 AS present FROM relationships WHERE character_id = ?").get(CHARACTERS[1].id);
      if (!exists) {
        store.db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(CHARACTERS[1].id, acceptedAt);
        store.db.prepare("INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, ?, ?, ?)")
          .run(CHARACTERS[1].id, INITIAL_STATS.intimacy, INITIAL_STATS.energy, INITIAL_STATS.mood);
      }
    }
    return { store, primaryCreated: accepted.created };
  } catch (error) { try { store.close(); } catch { /* 保留建库错误 */ } throw error; }
}

const ROW_SQL = `SELECT id, character_id, fact_key, fact_identity_id, origin_character_id, kind, body,
  trust, source_kind, importance, expires_at, source_id, source_version, version, created_at, updated_at
  FROM memory_entries WHERE character_id = ? ORDER BY created_at, id`;
function readRows(store, characterIds) {
  const statement = store.db.prepare(ROW_SQL);
  return Object.fromEntries(characterIds.map((characterId) => [characterId, statement.all(characterId).map((row) => ({
    id: row.id, characterId: row.character_id, factKey: row.fact_key, factIdentityId: row.fact_identity_id,
    originCharacterId: row.origin_character_id, kind: row.kind, body: row.body, trust: row.trust,
    sourceKind: row.source_kind, importance: row.importance, expiresAt: row.expires_at,
    sourceId: row.source_id, sourceVersion: row.source_version, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }))]));
}
function addedRows(before, after) { const old = new Set((before ?? []).map((row) => row.id)); return (after ?? []).filter((row) => !old.has(row.id)); }
function sourceSummaries(store, characterId, rows, nowMs) {
  const result = {};
  for (const row of rows) {
    try {
      const source = store.memorySourceContext.resolve({ characterId, entryId: row.id, expectedVersion: row.version, nowMs });
      result[row.id] = { entryId: row.id, factKey: row.factKey, status: source?.status ?? "unknown",
        excerpt: source?.excerpt ?? null, reason: source?.reason ?? null, contextIncomplete: source?.contextIncomplete ?? null,
        sourceMessage: source?.sourceMessage ? { id: source.sourceMessage.id, conversationId: source.sourceMessage.conversationId,
          content: source.sourceMessage.content } : null };
    } catch (error) { result[row.id] = { entryId: row.id, factKey: row.factKey, status: "error", error: safeError(error) }; }
  }
  return result;
}
function contextSummary(store, characterId, query, nowMs) {
  const search = store.memory.searchMemories({ characterId, query, strategy: "broad", nowMs, limit: 10 });
  const context = store.memory.buildContext({ characterId, query, nowMs });
  const compact = (entry) => ({ id: entry.id, factKey: entry.factKey, factIdentityId: entry.factIdentityId ?? null,
    kind: entry.kind, body: entry.body, importance: entry.importance, version: entry.version });
  return { search: search.map(compact), context: { contextVersion: context.contextVersion, charCount: context.charCount,
    truncated: context.truncated, sections: Object.fromEntries(Object.entries(context.sections)
      .map(([name, entries]) => [name, entries.map(compact)])) } };
}
function extractIsolation(call, step) {
  const messages = call?.request?.messages ?? [];
  const memoryText = messages.filter((message) => message.role === "system" &&
    typeof message.content === "string" && message.content.includes("以下为本角色本轮可用的记忆"))
    .map((message) => message.content).join("\n");
  const history = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }));
  return { ok: Boolean(call) && history.length === 1 && history[0].role === "user" && history[0].content === step.text, history, memoryText };
}
function parseEnvelope(call) {
  try { const outer = JSON.parse(call?.response ?? ""); const content = outer?.choices?.[0]?.message?.content;
    return typeof content === "string" ? JSON.parse(content) : null; } catch { return null; }
}
async function settle(store, characterId, requestId) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let request = store.chat.getRequest({ characterId, requestId });
  while (request.verificationStatus === "pending") {
    if (Date.now() > deadline) fail(`请求 ${requestId} 的核验未在 60 秒内收束。`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    request = store.chat.getRequest({ characterId, requestId });
  }
  return request;
}

async function performStep({ caseData, step, spy, session, credentials, fixedNow, characterIds, dir, withSecond, deadline }) {
  if (Date.now() > deadline) fail("总运行超过 15 分钟，已停止。");
  const actorId = actorIdOf(step.actor);
  const previousConversationId = session.conversations.get(actorId)?.id ?? null;
  if (step.reopen) { session.store.close(); session.store = openStore(dir, credentials, fixedNow, withSecond).store; session.conversations = new Map(); }
  const store = session.store;
  let conversation = session.conversations.get(actorId);
  if (!conversation || step.newConversation) { conversation = store.chat.openConversation({ characterId: actorId }).conversation; session.conversations.set(actorId, conversation); }
  Object.assign(spy.trace, { caseId: caseData.id, stepId: step.id, actor: step.actor });
  const before = readRows(store, characterIds);
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const result = await store.chat.sendMessage({ characterId: actorId, conversationId: conversation.id, text: step.text, requestId });
  let request = store.chat.getRequest({ characterId: actorId, requestId });
  if (request.verificationStatus === "pending") request = await settle(store, actorId, requestId);
  const durationMs = Date.now() - started;
  const calls = spy.calls.filter((call) => call.caseId === caseData.id && call.stepId === step.id && call.kind === "chat");
  const relationCalls = spy.calls.filter((call) => call.caseId === caseData.id && call.stepId === step.id && call.kind === "relation");
  const call = calls.length === 1 ? calls[0] : null;
  const envelope = parseEnvelope(call);
  const after = readRows(store, characterIds);
  const messages = store.chat.getConversation({ characterId: actorId, conversationId: conversation.id }).messages;
  const finalReply = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? result.reply ?? null;
  const record = { id: step.id, actor: step.actor, characterId: actorId, text: step.text,
    reopen: Boolean(step.reopen), newConversation: Boolean(step.newConversation), previousConversationId,
    conversationId: conversation.id, requestId, durationMs,
    result: { status: result.status, memoryApplied: result.memoryApplied, reply: result.reply, finalReply,
      verificationStatus: request?.verificationStatus ?? result.verificationStatus ?? "none",
      assistantMessageId: result.assistantMessageId ?? null, errorCode: result.errorCode ?? null },
    requestModel: call?.request?.model ?? null, requestMessagesPresent: Array.isArray(call?.request?.messages),
    requestDurationMs: call?.durationMs ?? null, requestError: call?.error ?? null,
    parsed: envelope, modelOperation: envelope?.memoryOperation ?? null,
    calls: { chat: calls.length, relation: relationCalls.length },
    memory: { before, after, added: Object.fromEntries(characterIds.map((id) => [id, addedRows(before[id], after[id])])) },
    sources: sourceSummaries(store, actorId, after[actorId] ?? [], fixedNow) };
  if (step.newConversation) { record.isolation = extractIsolation(call, step); record.context = contextSummary(store, actorId, step.text, fixedNow); }
  return record;
}

function evaluate(caseData, steps) {
  const exp = caseData.expected, primary = CHARACTERS[0].id, second = CHARACTERS[1]?.id ?? null;
  const checks = [], signals = {}, byId = Object.fromEntries(steps.map((step) => [step.id, step]));
  const add = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), detail });
  let metrics = null;
  for (const step of steps) {
    add(`chat-${step.id}-single-completed`, step.calls.chat === 1 && step.result.status === "completed" && !step.requestError,
      { calls: step.calls, result: step.result, error: step.requestError });
    add(`chat-${step.id}-request`, step.requestMessagesPresent && step.requestModel === MODEL &&
      Number.isFinite(step.requestDurationMs) && step.requestDurationMs <= REQUEST_TIMEOUT_MS &&
      step.calls.relation === 0 && step.modelOperation === null,
      { messages: step.requestMessagesPresent, model: step.requestModel, durationMs: step.requestDurationMs,
        relation: step.calls.relation, memoryOperation: step.modelOperation });
    if (step.isolation) add(`recall-${step.id}-fresh`, step.isolation.ok &&
      (step.previousConversationId === null || step.previousConversationId !== step.conversationId),
      { history: step.isolation.history, previous: step.previousConversationId, current: step.conversationId });
    const rawCandidates = step.parsed?.memoryCandidates ?? [];
    for (const row of addedOf(step, step.characterId)) {
      const candidate = rawCandidates.find((item) => (item.evidence ?? item.body) === row.body);
      add(`memory-${step.id}-${row.factKey}-from-model`,
        Boolean(candidate && candidate.factKey === row.factKey && candidate.kind === row.kind),
        { row: shortRow(row), candidate: candidate ?? null });
    }
  }
  if (caseData.id === "POL-REMEMBER-LIVE-001") {
    const remember = byId.remember, recall = byId.recall;
    const facts = addedOf(remember, primary).filter((row) => matches(row, exp.factTokens));
    const fact = facts[0], candidate = candidateOf(remember, exp.factTokens)[0];
    add("remember-single-fact", facts.length === 1, facts.map(shortRow));
    add("remember-single-entry", addedOf(remember, primary).length === 1, addedOf(remember, primary).map(shortRow));
    add("remember-importance", (fact?.importance ?? -1) >= exp.minImportance, fact?.importance ?? null);
    add("remember-source-current-user", fact?.sourceKind === "user" && sourceOk(remember, fact, remember.text), sourceOf(remember, fact));
    add("remember-factkey-from-model", Boolean(fact && candidate && fact.factKey === candidate.factKey),
      { factKey: fact?.factKey ?? null, candidateKey: candidate?.factKey ?? null });
    add("recall-context-has-fact", exp.recallContextTokens.every((token) => recall.isolation?.memoryText?.includes(token)), recall.isolation?.memoryText ?? null);
    add("recall-entry-persisted", rowsOf(recall, primary).some((row) => row.id === fact?.id), fact?.id ?? null);
    add("recall-reply-mentions-value", (exp.replyTokens ?? []).every((token) => String(recall.result.finalReply ?? "").includes(token)), recall.result.finalReply);
    signals.reply = recall.result.finalReply;
  } else if (caseData.id === "POL-REMEMBER-LIVE-002") {
    const natural = byId.natural, remember = byId.remember;
    const firstFacts = addedOf(natural, primary).filter((row) => matches(row, exp.factTokens));
    const before = firstFacts[0], firstCand = candidateOf(natural, exp.factTokens)[0], secondCand = candidateOf(remember, exp.factTokens)[0];
    const after = rowsOf(remember, primary).find((row) => row.id === before?.id);
    add("first-extraction", firstFacts.length === 1, firstFacts.map(shortRow));
    add("first-single-entry", addedOf(natural, primary).length === 1, addedOf(natural, primary).map(shortRow));
    add("first-source-current-user", sourceOk(natural, before, natural.text), sourceOf(natural, before));
    add("candidates-visible", Boolean(firstCand && secondCand), { first: firstCand ?? null, second: secondCand ?? null });
    add("no-new-entry-on-remember", addedOf(remember, primary).length === 0, addedOf(remember, primary).map(shortRow));
    add("same-entry-preserved", Boolean(before && after && before.id === after.id &&
      before.factKey === after.factKey && before.kind === after.kind &&
      before.factIdentityId === after.factIdentityId && before.body === after.body &&
      before.sourceId === after.sourceId && before.sourceVersion === after.sourceVersion &&
      before.sourceKind === after.sourceKind && before.createdAt === after.createdAt &&
      before.updatedAt === after.updatedAt),
      { before: shortRow(before), after: shortRow(after) });
    add("version-rule", Boolean(before && after && after.version ===
      before.version + (after.importance > before.importance ? 1 : 0)),
      { before: shortRow(before), after: shortRow(after) });
    add("importance-at-least-80", (after?.importance ?? -1) >= exp.minImportance, after?.importance ?? null);
    add("source-still-first-utterance", sourceOk(remember, after, natural.text), sourceOf(remember, after));
    signals.factKeys = { first: firstCand?.factKey ?? null, second: secondCand?.factKey ?? null };
    signals.secondCandidateBodySameAsFirst = Boolean(firstCand && secondCand &&
      (firstCand.evidence ?? firstCand.body) === (secondCand.evidence ?? secondCand.body));
  } else if (caseData.id === "POL-REMEMBER-LIVE-003") {
    const negative = byId.negative, recall = byId.recall;
    const reply = String(recall.result.finalReply ?? "");
    const claims = (exp.forbidReplyTokens ?? []).filter((token) => reply.includes(token));
    add("negative-no-rows", rowsOf(negative, primary).length === 0, rowsOf(negative, primary).map(shortRow));
    add("recall-memory-still-empty", rowsOf(recall, primary).length === 0, rowsOf(recall, primary).map(shortRow));
    add("recall-context-absent", exp.forbiddenTokens.every((token) => !recall.isolation?.memoryText?.includes(token)), recall.isolation?.memoryText ?? null);
    add("recall-search-absent", (recall.context?.search ?? []).every((row) => exp.forbiddenTokens.every((token) => !row.body.includes(token))), recall.context?.search ?? []);
    add("reply-does-not-claim-never-told", claims.length === 0, { reply, claims });
    signals.replyClaimsNeverTold = claims;
  } else if (caseData.id === "POL-REMEMBER-LIVE-004") {
    const step = byId.remember, rows = rowsOf(step, primary);
    const primaryRows = rows.filter((row) => matches(row, exp.primaryTokens));
    const secondaryRows = rows.filter((row) => matches(row, exp.secondaryTokens));
    const mergedRows = rows.filter((row) => matches(row, exp.primaryTokens, "any") && matches(row, exp.secondaryTokens, "any"));
    const wide = (step.parsed?.memoryCandidates ?? []).filter((candidate) => {
      const row = { body: candidate.evidence ?? candidate.body };
      return matches(row, exp.primaryTokens, "any") && matches(row, exp.secondaryTokens, "any");
    });
    const completionOk = primaryRows.some((row) => row.importance >= exp.minImportance);
    const baselineImportance = exp.baselineImportance ?? {};
    const secondaryBaseline = secondaryRows.map((row) => ({
      kind: row.kind,
      importance: row.importance,
      baseline: Object.hasOwn(baselineImportance, row.kind) ? baselineImportance[row.kind] : null,
    }));
    const unknownSecondaryKinds = secondaryBaseline.filter((item) => item.baseline === null).map((item) => item.kind);
    const secondaryNotBoosted = unknownSecondaryKinds.length === 0 &&
      secondaryRows.every((row) => row.importance <= baselineImportance[row.kind]);
    const wideBlocked = wide.every((candidate) => !rows.some((row) => row.body === (candidate.evidence ?? candidate.body)));
    const safetyOk = mergedRows.length === 0 && secondaryNotBoosted && wideBlocked;
    add("completion", completionOk, { doorplateEntries: primaryRows.map(shortRow), single: primaryRows.length === 1 });
    add("safety", safetyOk, { mergedRows: mergedRows.map(shortRow), secondaryBaseline,
      unknownSecondaryKinds, wideCandidates: wide.map((candidate) => candidate.evidence ?? candidate.body), wideBlocked });
    metrics = { safety: { status: safetyOk ? "PASS" : "FAIL", mergedRows: mergedRows.length,
      secondaryBaseline, unknownSecondaryKinds, wideCandidates: wide.length, wideBlocked },
      completion: { status: completionOk ? "PASS" : "FAIL", doorplateEntries: primaryRows.length,
        importance: Math.max(-1, ...primaryRows.map((row) => row.importance)) } };
    signals.wideCandidateObserved = wide.length > 0; signals.wideCandidateBlocked = wideBlocked; signals.reply = step.result.finalReply;
  } else if (caseData.id === "POL-REMEMBER-LIVE-005") {
    const rin = byId.remember, hu = byId.recall;
    const rinFacts = addedOf(rin, primary).filter((row) => matches(row, exp.primaryTokens));
    const valueToken = (exp.primaryTokens ?? []).find((token) => /^\d+$/u.test(token)) ?? "307";
    const huReply = String(hu.result.finalReply ?? "");
    add("rin-remembered", rinFacts.length === 1 && rinFacts[0].importance >= exp.minImportance, rinFacts.map(shortRow));
    add("rin-single-entry", addedOf(rin, primary).length === 1, addedOf(rin, primary).map(shortRow));
    add("rin-source-current-user", sourceOk(rin, rinFacts[0], rin.text), sourceOf(rin, rinFacts[0]));
    add("hu-memory-empty", rowsOf(hu, second).length === 0, rowsOf(hu, second).map(shortRow));
    add("hu-context-absent", exp.primaryTokens.every((token) => !hu.isolation?.memoryText?.includes(token)), hu.isolation?.memoryText ?? null);
    add("hu-search-absent", (hu.context?.search ?? []).every((row) => exp.primaryTokens.every((token) => !row.body.includes(token))), hu.context?.search ?? []);
    add("hu-reply-no-primary-value", !huReply.includes(valueToken), huReply);
    signals.huReplyContainsPrimaryValue = huReply.includes(valueToken);
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return { status: failed.length ? "FAIL" : "PASS", failed, checks, metrics, signals };
}

async function runCase(caseData, options, credentials, spy, fixture, fixedNow, deadline) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-remember-${caseData.id}-`));
  const withSecond = caseData.steps.some((step) => step.actor === "second");
  const characterIds = withSecond ? [CHARACTERS[0].id, CHARACTERS[1].id] : [CHARACTERS[0].id];
  const record = { id: caseData.id, goal: caseData.goal, expected: caseData.expected, characterIds,
    qualification: null, steps: [], calls: { chat: 0, relation: 0 }, checks: null, metrics: null,
    semantic: { status: options.live ? "REVIEW" : "NOT_EVALUATED", expected: caseData.expected.semanticReview, observed: null },
    cleanup: null, error: null, status: "ERROR" };
  let session = null, storeClosed = true;
  try {
    if (fixture) fixture.responses = new Map(caseData.steps.map((step) => [step.text, dryEnvelope(caseData.id, step.id)]));
    const opened = openStore(dir, credentials, fixedNow, withSecond);
    session = { store: opened.store, conversations: new Map() }; storeClosed = false;
    const relationships = session.store.db.prepare("SELECT character_id FROM relationships ORDER BY character_id").all().map((row) => row.character_id);
    const primary = CHARACTERS[0].id, second = withSecond ? CHARACTERS[1].id : null;
    record.qualification = { primary: { characterId: CHARACTERS[0].id, name: CHARACTERS[0].name, via: "acceptCharacter",
      present: relationships.includes(CHARACTERS[0].id), createdOnOpen: opened.primaryCreated },
      ...(second ? { second: { characterId: CHARACTERS[1].id, name: CHARACTERS[1].name, via: "relationship-fixture",
        present: relationships.includes(CHARACTERS[1].id), reason: "acceptCharacter 只接纳首位；跨角色隔离 Case 的最小资格 fixture，不代表相遇流程验收" } } : {}) };
    if (!relationships.includes(primary) || (second && !relationships.includes(second))) fail("角色资格 fixture 未生效。");
    for (const step of caseData.steps) {
      record.steps.push(await performStep({ caseData, step, spy, session, credentials, fixedNow, characterIds, dir, withSecond, deadline }));
    }
    const evaluated = evaluate(caseData, record.steps);
    record.checks = evaluated; record.metrics = evaluated.metrics;
    record.semantic.observed = { replies: record.steps.map((step) => ({ id: step.id, reply: step.result.finalReply })),
      memoryContexts: record.steps.filter((step) => step.isolation).map((step) => ({ id: step.id, memoryText: step.isolation.memoryText })),
      signals: evaluated.signals };
    const incomplete = record.steps.find((step) => step.result.status !== "completed");
    if (incomplete) record.error = { stage: "chat", stepId: incomplete.id, code: incomplete.result.errorCode ?? incomplete.result.status };
    if (record.error) record.status = "ERROR";
    else if (evaluated.failed.length > 0) record.status = "FAIL";
    else record.status = options.live ? "REVIEW" : "DRY-RUN";
  } catch (error) { record.error = safeError(error); record.status = "ERROR"; }
  finally {
    record.calls.chat = spy.calls.filter((call) => call.caseId === caseData.id && call.kind === "chat").length;
    record.calls.relation = spy.calls.filter((call) => call.caseId === caseData.id && call.kind === "relation").length;
    record.durationMs = Date.now() - started;
    try {
      if (session?.store) { session.store.close(); storeClosed = true; }
      fs.rmSync(dir, { recursive: true, force: true });
      record.cleanup = { path: dir, closed: storeClosed ? 1 : 0, removed: fs.existsSync(dir) ? 0 : 1, existsAfter: fs.existsSync(dir) };
    } catch (error) {
      record.cleanup = { path: dir, closed: storeClosed ? 1 : 0, removed: fs.existsSync(dir) ? 0 : 1, existsAfter: fs.existsSync(dir), error: safeError(error) };
      record.error = record.error ?? safeError(error); record.status = "ERROR";
    }
  }
  return record;
}

function summarize(cases) {
  const checks = cases.flatMap((item) => item.checks?.checks ?? []);
  return { cases: cases.length, dryRun: cases.filter((item) => item.status === "DRY-RUN").length,
    review: cases.filter((item) => item.status === "REVIEW").length, fail: cases.filter((item) => item.status === "FAIL").length,
    error: cases.filter((item) => item.status === "ERROR").length, deterministicChecks: checks.length,
    deterministicFailed: checks.filter((check) => !check.ok).length,
    chatCalls: cases.reduce((sum, item) => sum + (item.calls?.chat ?? 0), 0),
    relationCalls: cases.reduce((sum, item) => sum + (item.calls?.relation ?? 0), 0),
    semanticReviewRequired: cases.filter((item) => item.semantic?.status === "REVIEW").length };
}

function baseRecord(options, data, text, fixedNow) {
  return { generatedAt: new Date().toISOString(), mode: options.live ? "live" : "dry-run",
    fixedNow: new Date(fixedNow).toISOString(), output: options.out,
    boundary: { chat: options.live ? "real" : "fixture", relation: options.live ? "real" : "fixture", core: "real createStore/chat/memory/SQLite" },
    credentialsRead: false, network: false, semanticReviewRequired: false,
    model: { requested: MODEL, used: null, presentInModels: null, modelsStatus: null, available: [], requestModelMismatch: false },
    characters: { primary: { id: CHARACTERS[0].id, name: CHARACTERS[0].name, image: CHARACTERS[0].image },
      ...(CHARACTERS[1] ? { second: { id: CHARACTERS[1].id, name: CHARACTERS[1].name, image: CHARACTERS[1].image } } : {}) },
    input: { cases: path.relative(REPO_ROOT, CASES_PATH), version: data.version, sha256: sha256(text) },
    modules: { tool: shaOfFile(__filename), cases: shaOfFile(CASES_PATH),
      production: PRODUCTION_FILES.map((relative) => shaOfFile(path.join(REPO_ROOT, relative))) },
    plan: PLAN, calls: { models: 0, chat: 0, relation: 0, total: 0, budgetOk: null },
    durationsMs: { models: null, total: null }, cases: [], metrics: null, cleanup: null, error: null, status: "PENDING" };
}

function writeResult(file, payload) {
  try { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { if (error?.code === "EEXIST") fail(`拒绝覆盖已有结果：${file}`); throw error; }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { data, text } = readCases();
  const fixedNow = Date.parse(data.fixedNow);
  const record = baseRecord(options, data, text, fixedNow);
  const started = Date.now(), deadline = started + TOTAL_TIMEOUT_MS;
  let credentials = null, fixture = null, spy = null;
  try {
    if (options.live) { credentials = { ...loadCredentials(), modelName: MODEL }; record.credentialsRead = true; record.network = true; }
    else { fixture = await startFixtureServer(); credentials = { baseUrl: fixture.baseUrl, apiKey: "fixture-local", modelName: MODEL }; }
    record.model.used = credentials.modelName;
    spy = installFetchSpy({ dryRun: !options.live });
    record.guards = { loopbackOnly: !options.live, blocked: spy.blocked };
    const modelsStarted = Date.now();
    const ids = await listModels(credentials);
    record.durationsMs.models = Date.now() - modelsStarted;
    record.model.modelsStatus = spy.calls.find((call) => call.kind === "models")?.status ?? null;
    record.model.available = ids; record.model.presentInModels = ids.includes(MODEL);
    if (!record.model.presentInModels) { record.error = { code: "MODEL_MISSING", message: `GET /models 未返回 ${MODEL}。`, available: ids }; record.status = "ERROR"; return record; }
    for (const caseData of data.cases) {
      if (Date.now() > deadline) fail("总运行超过 15 分钟，已停止。");
      record.cases.push(await runCase(caseData, options, credentials, spy, fixture, fixedNow, deadline));
    }
    const mismatched = spy.calls.filter((call) => call.kind === "chat" && call.request?.model !== MODEL);
    record.model.requestModelMismatch = mismatched.length > 0;
    if (mismatched.length > 0) { record.error = { code: "REQUEST_MODEL_MISMATCH", message: "聊天请求 model 与预检不一致。", count: mismatched.length }; record.status = "ERROR"; }
    record.metrics = summarize(record.cases);
  } catch (error) { record.error = safeError(error); record.status = "ERROR"; }
  finally {
    if (spy) { spy.restore(); record.guards = { ...(record.guards ?? {}), blocked: spy.blocked }; }
    let fixtureClosed = null;
    if (fixture) { try { await fixture.close(); fixtureClosed = true; } catch (error) { fixtureClosed = false; record.error = record.error ?? safeError(error); } }
    record.calls = { models: spy?.calls.filter((call) => call.kind === "models").length ?? 0,
      chat: spy?.calls.filter((call) => call.kind === "chat").length ?? 0,
      relation: spy?.calls.filter((call) => call.kind === "relation").length ?? 0 };
    record.calls.total = record.calls.models + record.calls.chat + record.calls.relation;
    record.calls.budgetOk = record.calls.models <= PLAN.models && record.calls.chat <= PLAN.chat &&
      record.calls.relation <= PLAN.relation && record.calls.total <= PLAN.total;
    if (!record.calls.budgetOk) record.error = record.error ?? { code: "HTTP_BUDGET_EXCEEDED", message: "HTTP 调用超出预算。" };
    record.durationsMs.total = Date.now() - started;
    record.cleanup = { cases: record.cases.map((item) => ({ id: item.id, ...item.cleanup })), fixtureServerClosed: fixtureClosed,
      ok: record.cases.every((item) => item.cleanup?.closed === 1 && item.cleanup?.removed === 1 && item.cleanup?.existsAfter === false) && (fixture ? fixtureClosed === true : true) };
    if (!record.cleanup.ok) record.error = record.error ?? { code: "CLEANUP_FAILED", message: "临时库或 fixture server 未完整清理。" };
    if (record.durationsMs.total > TOTAL_TIMEOUT_MS) record.error = record.error ?? { code: "TOTAL_TIMEOUT", message: "总运行超过 15 分钟。" };
    if (!record.metrics) record.metrics = summarize(record.cases);
    record.httpCalls = spy?.calls.map((call) => ({ caseId: call.caseId, stepId: call.stepId, actor: call.actor,
      kind: call.kind, method: call.method, url: call.url, status: call.status ?? null,
      durationMs: call.durationMs ?? null, request: call.request, response: call.response ?? null,
      error: call.error ?? null })) ?? [];
    if (record.error) record.status = "ERROR";
    else if (record.cases.some((item) => item.status === "ERROR")) record.status = "ERROR";
    else if (record.cases.some((item) => item.status === "FAIL")) record.status = "FAIL";
    else record.status = options.live ? "REVIEW" : "DRY-RUN";
    record.semanticReviewRequired = options.live;
    writeResult(options.out, record);
  }
  return record;
}

if (require.main === module) {
  main().then((record) => {
    console.log(JSON.stringify({ status: record.status, mode: record.mode, model: record.model,
      calls: record.calls, metrics: record.metrics, cleanup: record.cleanup, output: record.output }, null, 2));
    process.exitCode = ["DRY-RUN", "REVIEW"].includes(record.status) ? 0 : 1;
  }).catch((error) => { console.error(`ERROR: ${redact(error?.message ?? error)}`); process.exitCode = 1; });
}
