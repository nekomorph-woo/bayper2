#!/usr/bin/env node
/* S03s 三角色未知表达对照 probe。默认 dry-run：只读本地 Case、只连 loopback fixture，
   不读 .env、不访问外网；显式 --live 才读取根 .env 并调用真实模型。
   三个角色各一组 U（新库无记忆）/ K（新库先明确记住，再重开库、新对话提问），
   每个 Case 独立临时 SQLite；事实只经真实 chat.sendMessage 产生。工具只报告，
   不调参；回复语义留给 master 判定，确定性检查失败仍记 FAIL。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");
const CHARACTERS = require("../../app/content/characters.json").candidates;

const REPO_ROOT = path.resolve(__dirname, "../..");
const CASES_PATH = path.join(__dirname, "unknown-cases.json");
const RESULTS_DIR = path.join(__dirname, "results");
const MODEL = "deepseek-flash", REQUEST_TIMEOUT_MS = 60000, TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const PLAN = { models: 1, chat: 9, total: 12 };
const EXPECTED_IDS = ["POL-UNKNOWN-RIN-U", "POL-UNKNOWN-RIN-K", "POL-UNKNOWN-HU-U",
  "POL-UNKNOWN-HU-K", "POL-UNKNOWN-CHENG-U", "POL-UNKNOWN-CHENG-K"];
const PRODUCTION_FILES = ["app/store.cjs", "app/chat.cjs", "app/memory.cjs",
  "app/memory-store.cjs", "app/memory-explicit-remember.cjs", "app/model.cjs"];

/* dry-run 的自检响应只验证工具链路，不代表真实模型行为。 */
const DRY = {
  "POL-UNKNOWN-RIN-U": { ask: ["关于你最喜欢的早餐，我这边没有可用的信息。", []] },
  "POL-UNKNOWN-RIN-K": {
    remember: ["好，我记住了。", [["breakfast.favorite", "我最喜欢的早餐是豆浆配烧饼", "preference"]]],
    ask: ["你最喜欢的早餐是豆浆配烧饼。", []],
  },
  "POL-UNKNOWN-HU-U": { ask: ["关于上周的展览，我没有可用的记录。", []] },
  "POL-UNKNOWN-HU-K": {
    remember: ["好，我记住了。", [["week.exhibition", "我上周去过琉璃灯展", "experience"]]],
    ask: ["你上周去过琉璃灯展。", []],
  },
  "POL-UNKNOWN-CHENG-U": { ask: ["关于备用充电器的位置，我这边没有可用的信息。", []] },
  "POL-UNKNOWN-CHENG-K": {
    remember: ["好，我记住了。", [["home.charger", "我把备用充电器放在书桌右侧抽屉", "detail"]]],
    ask: ["你的备用充电器在书桌右侧抽屉。", []],
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
function hasTokens(text, tokens) { const value = normalize(text); return (tokens ?? []).every((token) => value.includes(normalize(token))); }
function addedRows(before, after) { const old = new Set((before ?? []).map((row) => row.id)); return (after ?? []).filter((row) => !old.has(row.id)); }

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
  const text = fs.readFileSync(CASES_PATH, "utf8"), data = JSON.parse(text);
  const ids = Array.isArray(data.cases) ? data.cases.map((item) => item.id) : [];
  if (typeof data.version !== "string" || !Number.isFinite(Date.parse(data.fixedNow)) ||
    ids.join("\u0000") !== EXPECTED_IDS.join("\u0000")) fail("Case 文件版本、fixedNow 或固定 6 Case 顺序无效。");
  let chatTurns = 0;
  for (const item of data.cases) {
    required(item.goal, `${item.id}.goal`); required(item.question, `${item.id}.question`);
    if (!CHARACTERS.some((character) => character.id === item.characterId)) fail(`${item.id} 的 characterId 无效。`);
    if (!["U", "K"].includes(item.kind) || !Array.isArray(item.steps)) fail(`${item.id} 的 kind/steps 无效。`);
    const stepIds = item.steps.map((step) => step.id), expected = item.kind === "U" ? ["ask"] : ["remember", "ask"];
    if (stepIds.join("\u0000") !== expected.join("\u0000")) fail(`${item.id} 的步骤必须为 ${expected.join("/")}。`);
    for (const step of item.steps) { required(step.text, `${item.id}.${step.id}.text`); chatTurns += 1; }
    const ask = item.steps.at(-1);
    if (ask.text !== item.question || ask.newConversation !== true) fail(`${item.id} 的提问必须与 question 一致并新建对话。`);
    if (item.kind === "K" && (ask.reopen !== true || item.steps[0].text === item.question)) fail(`${item.id} 的 K 步骤无效。`);
    const tokens = item.kind === "U" ? item.expected?.forbiddenValueTokens : item.expected?.factTokens;
    required(item.expected?.semanticReview, `${item.id}.expected.semanticReview`);
    if (!Array.isArray(tokens) || tokens.length === 0) fail(`${item.id} 缺少对照事实 token。`);
  }
  if (chatTurns !== PLAN.chat) fail(`固定 6 Case 的 chat 次数必须为 ${PLAN.chat}，实际 ${chatTurns}。`);
  for (const character of CHARACTERS) {
    const pair = data.cases.filter((item) => item.characterId === character.id);
    if (pair.length !== 2 || pair[0].question !== pair[1].question) fail(`${character.id} 的 U/K 提问必须相同。`);
  }
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
  const trace = { caseId: null, stepId: null, characterId: null };
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
    const entry = { caseId: trace.caseId, stepId: trace.stepId, characterId: trace.characterId, kind, method,
      url: redact(url), request: body, startedAt: Date.now() };
    calls.push(entry);
    const count = calls.filter((call) => call.kind === kind).length;
    if ((kind === "models" || kind === "chat") && count > PLAN[kind]) {
      entry.error = { code: "CALL_BUDGET_EXCEEDED", message: `${kind} 超出计划上限。` }; throw new Error(entry.error.message);
    }
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

function openStore(dir, credentials, fixedNow, characterId) {
  const store = createStore(dir, { now: () => fixedNow, characters: CHARACTERS,
    chat: { getCredentials: () => credentials, timeoutMs: REQUEST_TIMEOUT_MS } });
  try {
    const acceptedAt = new Date(fixedNow).toISOString();
    const accepted = store.acceptCharacter({ characterId, day: acceptedAt.slice(0, 10), acceptedAt });
    return { store, created: Boolean(accepted?.created) };
  } catch (error) { try { store.close(); } catch { /* 保留建库错误 */ } throw error; }
}

/* 只读观察正式记忆与其来源；不写 memory_entries，也不修模型结果。 */
function readMemory(store, characterId, nowMs) {
  const rows = store.db.prepare(`SELECT id, character_id, fact_key, fact_identity_id, origin_character_id, kind, body,
    trust, source_kind, importance, expires_at, source_id, source_version, version, created_at, updated_at
    FROM memory_entries WHERE character_id = ? ORDER BY created_at, id`).all(characterId).map((row) => ({
    id: row.id, characterId: row.character_id, factKey: row.fact_key, factIdentityId: row.fact_identity_id,
    originCharacterId: row.origin_character_id, kind: row.kind, body: row.body, trust: row.trust,
    sourceKind: row.source_kind, importance: row.importance, expiresAt: row.expires_at, sourceId: row.source_id,
    sourceVersion: row.source_version, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  const sources = {};
  for (const row of rows) {
    try {
      const source = store.memorySourceContext.resolve({ characterId, entryId: row.id, expectedVersion: row.version, nowMs });
      sources[row.id] = { status: source?.status ?? "unknown", excerpt: source?.excerpt ?? null,
        sourceMessage: source?.sourceMessage ? { id: source.sourceMessage.id, conversationId: source.sourceMessage.conversationId,
          content: source.sourceMessage.content } : null };
    } catch (error) { sources[row.id] = { status: "error", error: safeError(error) }; }
  }
  return { rows, sources };
}
function contextSummary(store, characterId, query, nowMs) {
  const search = store.memory.searchMemories({ characterId, query, strategy: "broad", nowMs, limit: 10 });
  const context = store.memory.buildContext({ characterId, query, nowMs });
  const compact = (entry) => ({ id: entry.id, factKey: entry.factKey, kind: entry.kind, body: entry.body,
    importance: entry.importance, version: entry.version });
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

async function performStep({ caseData, step, spy, session, credentials, fixedNow, characterId, dir, deadline }) {
  if (Date.now() > deadline) fail("总运行超过 15 分钟，已停止。");
  const previousConversationId = session.conversation?.id ?? null;
  if (step.reopen) {
    session.store.close();
    session.store = openStore(dir, credentials, fixedNow, characterId).store;
    session.conversation = null;
  }
  const store = session.store;
  if (!session.conversation || step.newConversation) session.conversation = store.chat.openConversation({ characterId }).conversation;
  const conversation = session.conversation;
  Object.assign(spy.trace, { caseId: caseData.id, stepId: step.id, characterId });
  const before = readMemory(store, characterId, fixedNow), requestId = crypto.randomUUID(), started = Date.now();
  const result = await store.chat.sendMessage({ characterId, conversationId: conversation.id, text: step.text, requestId });
  let request = store.chat.getRequest({ characterId, requestId });
  if (request.verificationStatus === "pending") request = await settle(store, characterId, requestId);
  const durationMs = Date.now() - started;
  const calls = spy.calls.filter((call) => call.caseId === caseData.id && call.stepId === step.id && call.kind === "chat");
  const relationCalls = spy.calls.filter((call) => call.caseId === caseData.id && call.stepId === step.id && call.kind === "relation");
  const call = calls.length === 1 ? calls[0] : null, after = readMemory(store, characterId, fixedNow);
  const messages = store.chat.getConversation({ characterId, conversationId: conversation.id }).messages;
  const finalReply = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? result.reply ?? null;
  const record = { id: step.id, text: step.text, reopen: Boolean(step.reopen), newConversation: Boolean(step.newConversation),
    previousConversationId, conversationId: conversation.id, requestId, durationMs,
    result: { status: result.status, memoryApplied: result.memoryApplied, reply: result.reply, finalReply,
      verificationStatus: request?.verificationStatus ?? result.verificationStatus ?? "none", errorCode: result.errorCode ?? null },
    requestModel: call?.request?.model ?? null, requestMessages: call?.request?.messages ?? null,
    requestDurationMs: call?.durationMs ?? null, requestError: call?.error ?? null, rawResponse: call?.response ?? null,
    calls: { chat: calls.length, relation: relationCalls.length },
    memory: { before: before.rows, after: after.rows, added: addedRows(before.rows, after.rows) },
    sources: after.sources };
  if (step.id === "ask") { record.isolation = extractIsolation(call, step); record.context = contextSummary(store, characterId, step.text, fixedNow); }
  return record;
}

function evaluate(caseData, steps) {
  const checks = [], byId = Object.fromEntries(steps.map((step) => [step.id, step])), add = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), detail });
  for (const step of steps) {
    add(`chat-${step.id}-single-completed`, step.calls.chat === 1 && step.result.status === "completed" && !step.requestError, { calls: step.calls, result: step.result });
    add(`chat-${step.id}-request`, Array.isArray(step.requestMessages) && step.requestModel === MODEL &&
      Number.isFinite(step.requestDurationMs) && step.requestDurationMs <= REQUEST_TIMEOUT_MS && step.calls.relation === 0,
      { model: step.requestModel, durationMs: step.requestDurationMs, relation: step.calls.relation });
  }
  const ask = byId.ask;
  add("ask-fresh-conversation", Boolean(ask.isolation?.ok) && ask.previousConversationId !== ask.conversationId,
    { history: ask.isolation?.history, previous: ask.previousConversationId, current: ask.conversationId });
  if (caseData.kind === "U") {
    const forbidden = caseData.expected.forbiddenValueTokens;
    add("u-memory-empty", ask.memory.after.length === 0, ask.memory.after);
    add("u-request-no-memory-values", !hasTokens(ask.isolation?.memoryText ?? "", forbidden), ask.isolation?.memoryText ?? null);
    add("u-context-no-memory-values", !hasTokens(JSON.stringify(ask.context ?? {}), forbidden), ask.context ?? null);
    add("u-reply-no-constructed-value", !hasTokens(ask.result.finalReply ?? "", forbidden), ask.result.finalReply);
  } else {
    const remember = byId.remember, factTokens = caseData.expected.factTokens;
    const saved = remember.memory.added.filter((row) => hasTokens(row.body, factTokens)), row = saved[0] ?? null;
    const source = row ? remember.sources[row.id] ?? null : null;
    const contextBodies = [...(ask.context?.search ?? []).map((item) => item.body),
      ...Object.values(ask.context?.context?.sections ?? {}).flat().map((item) => item.body)];
    add("k-remember-single-entry", saved.length === 1 && remember.memory.added.length === 1, remember.memory.added);
    add("k-remember-source", Boolean(row && row.characterId === caseData.characterId && row.sourceKind === "user" &&
      row.sourceId && row.factIdentityId && source?.status === "ok" && source.sourceMessage?.content === remember.text), { row, source });
    add("k-memory-persisted", Boolean(row && ask.memory.after.some((item) => item.id === row.id)), { rowId: row?.id ?? null, after: ask.memory.after });
    add("k-request-has-fact", hasTokens(ask.isolation?.memoryText ?? "", factTokens), ask.isolation?.memoryText ?? null);
    add("k-context-has-fact", contextBodies.some((body) => hasTokens(body, factTokens)), contextBodies);
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return { checks, failed };
}

async function runCase(caseData, options, credentials, spy, fixture, fixedNow, deadline) {
  const started = Date.now(), dir = fs.mkdtempSync(path.join(os.tmpdir(), `bayper-unknown-${caseData.id}-`));
  const record = { id: caseData.id, goal: caseData.goal, kind: caseData.kind, characterId: caseData.characterId,
    question: caseData.question, expected: caseData.expected, qualification: null, steps: [], calls: { chat: 0, relation: 0 },
    checks: null, cleanup: null, error: null, status: "ERROR",
    semantic: { status: options.live ? "REVIEW" : "NOT_EVALUATED", expected: caseData.expected.semanticReview } };
  let session = null, storeClosed = true;
  try {
    if (fixture) fixture.responses = new Map(caseData.steps.map((step) => [step.text, dryEnvelope(caseData.id, step.id)]));
    const opened = openStore(dir, credentials, fixedNow, caseData.characterId);
    session = { store: opened.store, conversation: null }; storeClosed = false;
    const relationships = session.store.db.prepare("SELECT character_id FROM relationships ORDER BY character_id").all().map((row) => row.character_id);
    record.qualification = { characterId: caseData.characterId, via: "acceptCharacter",
      present: relationships.includes(caseData.characterId), createdOnOpen: opened.created };
    if (!record.qualification.present) fail("角色资格 fixture 未生效。");
    for (const step of caseData.steps) {
      record.steps.push(await performStep({ caseData, step, spy, session, credentials, fixedNow, characterId: caseData.characterId, dir, deadline }));
    }
    const evaluated = evaluate(caseData, record.steps);
    record.checks = evaluated.checks;
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
      record.cleanup = { path: dir, closed: storeClosed ? 1 : 0, existsAfter: fs.existsSync(dir), removed: fs.existsSync(dir) ? 0 : 1 };
    } catch (error) {
      record.cleanup = { path: dir, closed: storeClosed ? 1 : 0, existsAfter: fs.existsSync(dir), removed: fs.existsSync(dir) ? 0 : 1, error: safeError(error) };
      record.error = record.error ?? safeError(error); record.status = "ERROR";
    }
  }
  return record;
}

function summarize(cases) {
  const checks = cases.flatMap((item) => item.checks ?? []);
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
    fixedNow: new Date(fixedNow).toISOString(), output: options.out, credentialsRead: false, network: false, semanticReviewRequired: false,
    boundary: { chat: options.live ? "real" : "fixture", relation: options.live ? "real" : "fixture", core: "real createStore/chat/memory/SQLite" },
    model: { requested: MODEL, used: null, presentInModels: null, modelsStatus: null, available: [], requestModelMismatch: false },
    characters: Object.fromEntries(CHARACTERS.map((item) => [item.id, { id: item.id, name: item.name, image: item.image }])),
    input: { cases: path.relative(REPO_ROOT, CASES_PATH), version: data.version, sha256: sha256(text) },
    modules: { tool: shaOfFile(__filename), cases: shaOfFile(CASES_PATH), production: PRODUCTION_FILES.map((relative) => shaOfFile(path.join(REPO_ROOT, relative))) },
    plan: PLAN, calls: { models: 0, chat: 0, relation: 0, total: 0, budgetOk: null },
    durationsMs: { models: null, total: null }, cases: [], metrics: null, cleanup: null, error: null, status: "PENDING" };
}

function writeResult(file, payload) {
  try { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { if (error?.code === "EEXIST") fail(`拒绝覆盖已有结果：${file}`); throw error; }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { data, text } = readCases(), fixedNow = Date.parse(data.fixedNow);
  const record = baseRecord(options, data, text, fixedNow), started = Date.now(), deadline = started + TOTAL_TIMEOUT_MS;
  let credentials = null, fixture = null, spy = null;
  try {
    if (options.live) { credentials = { ...loadCredentials(), modelName: MODEL }; record.credentialsRead = true; record.network = true; }
    else { fixture = await startFixtureServer(); credentials = { baseUrl: fixture.baseUrl, apiKey: "fixture-local", modelName: MODEL }; }
    record.model.used = credentials.modelName;
    spy = installFetchSpy({ dryRun: !options.live });
    record.guards = { loopbackOnly: !options.live, blocked: spy.blocked };
    const modelsStarted = Date.now(), ids = await listModels(credentials);
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
    record.calls.budgetOk = record.calls.models <= PLAN.models && record.calls.chat <= PLAN.chat && record.calls.total <= PLAN.total;
    if (!record.calls.budgetOk) record.error = record.error ?? { code: "HTTP_BUDGET_EXCEEDED", message: "HTTP 调用超出预算。" };
    record.durationsMs.total = Date.now() - started;
    record.cleanup = { cases: record.cases.map((item) => ({ id: item.id, ...item.cleanup })), fixtureServerClosed: fixtureClosed,
      ok: record.cases.every((item) => item.cleanup?.closed === 1 && item.cleanup?.removed === 1 && item.cleanup?.existsAfter === false) && (fixture ? fixtureClosed === true : true) };
    if (!record.cleanup.ok) record.error = record.error ?? { code: "CLEANUP_FAILED", message: "临时库或 fixture server 未完整清理。" };
    if (record.durationsMs.total > TOTAL_TIMEOUT_MS) record.error = record.error ?? { code: "TOTAL_TIMEOUT", message: "总运行超过 15 分钟。" };
    if (!record.metrics) record.metrics = summarize(record.cases);
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
