#!/usr/bin/env node
/* S03m B2 真实聊天操作 probe。L1：聊天 envelope 构造、关系 HTTP 真实；L2：聊天与关系真实。
   核心 createStore/chat/memory/SQLite/关系协议真实，只用自建临时库与构造用户原话；
   不直接调用 applyConfirmed... 或手工写 proof。dry-run 不读 .env、不允许非 loopback 请求，
   只用本机 fixture chat/relation 演练真实入口；输出 JSON 必须显式新 --out。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");
const { parseRelationResponse } = require("../../app/memory-relation-protocol.cjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
const DATASET_PATH = path.join(__dirname, "chat-operation-cases.json");
const DEFAULT_MODEL = "deepseek-flash";
const RELATIONS = ["equivalent", "different", "uncertain"];
const EFFECTS = ["correct_propagate", "forget_delete", "temporary_copy", "no_propagate"];
const KINDS = ["identity", "preference", "experience", "detail"];
const ACTIONS = ["correct", "forget"];
const FLAG_KEYS = ["rawFalseMerge", "effectiveFalseMerge", "classificationFalseMerge",
  "databaseFalseMerge", "falseMerge", "missedPositive", "wrongDelete", "wrongSync",
  "missedExtractionA", "missedExtractionB", "seedAmbiguous", "missedRecall", "missedOperation",
  "wrongOperationType", "candidateCountMismatch", "relationMismatch", "noVerification",
  "holderLeak", "leak", "wrongAssistant", "aCorrectionMismatch"];
const newFlags = () => Object.fromEntries(FLAG_KEYS.map((key) => [key, false]));
const TABLES = [
  "memory_entries", "memory_fact_identities", "memory_derivations", "memory_fts",
  "memory_source_controls", "memory_forget_identity_controls", "memory_share_identity_controls",
  "memory_deleted_fact_fingerprints", "memory_forget_controls", "memory_share_controls",
  "memory_temporary_links", "memory_temporary_entry_links", "chat_requests", "chat_messages",
];
const MEMORY_TABLES = TABLES.filter((table) => table.startsWith("memory_"));
const MODELS_TIMEOUT_MS = 20000;
const SETTLE_TIMEOUT_MS = 30000;
function fail(message) { throw new Error(message); }
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} 必须是非空字符串。`);
  return value;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function shaOfFile(file) { return { path: path.relative(REPO_ROOT, file), sha256: sha256(fs.readFileSync(file)) }; }
function redact(value) {
  return String(value ?? "").replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "<redacted>").replace(/Bearer\s+\S+/gu, "Bearer <redacted>");
}
function safeError(error) { return { code: error?.code ?? "ERROR", message: redact(error?.message ?? error).slice(0, 400) }; }
function isLoopbackUrl(value) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(String(value)).hostname); }
  catch { return false; }
}

function parseArgs(argv) {
  const options = { mode: "l1", dryRun: false, out: null, model: DEFAULT_MODEL, caseId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mode") {
      const mode = argv[++index];
      if (mode !== "l1" && mode !== "l2") fail("--mode 只能是 l1 或 l2。");
      options.mode = mode;
    } else if (arg === "--model") options.model = required(argv[++index], "--model");
    else if (arg === "--case") options.caseId = required(argv[++index], "--case");
    else if (arg === "--out") options.out = path.resolve(process.cwd(), required(argv[++index], "--out"));
    else fail(`参数无效：${arg}`);
  }
  if (options.caseId && !/^C\d{2}$/u.test(options.caseId)) fail("--case 必须是 C 加两位数字。");
  if (!options.out) fail("必须显式提供新的 --out 文件路径。");
  if (fs.existsSync(options.out)) fail(`拒绝覆盖已有结果：${options.out}`);
  return options;
}

function validateSide(side, label) {
  if (!side || typeof side !== "object" || !Array.isArray(side.prelude) ||
    side.prelude.length > 1 || side.prelude.some((text) => typeof text !== "string" || !text.trim())) {
    fail(`${label}.prelude 无效。`);
  }
  required(side.utterance, `${label}.utterance`);
  if (!Array.isArray(side.match) || side.match.length === 0 ||
    side.match.some((text) => typeof text !== "string" || !text.trim())) fail(`${label}.match 无效。`);
  const l1 = side.l1 ?? {};
  required(l1.factKey, `${label}.l1.factKey`);
  required(l1.body, `${label}.l1.body`);
  required(l1.evidence, `${label}.l1.evidence`);
  if (!KINDS.includes(l1.kind)) fail(`${label}.l1.kind 无效。`);
  if (!side.utterance.includes(l1.body)) fail(`${label}.l1.body 必须是原话子串（直连来源要求）。`);
  if (!side.utterance.includes(l1.evidence)) fail(`${label}.l1.evidence 必须是原话子串。`);
}

function validateFollowupCase(item) {
  if (item.id !== "C12") fail("followup 只允许 C12。");
  const expected = item.expected ?? {};
  if (expected.path !== "clarify" || expected.candidates !== 1 || expected.memory !== "unchanged" ||
    expected.relationCalls !== 0 || expected.assistantDelta !== 1) fail(`${item.id}.expected 首回合契约无效。`);
  const operation = item.operation ?? {};
  if (operation.l1ModelOperation !== "null") fail(`${item.id}.operation.l1ModelOperation 必须为 null。`);
  required(operation.l1Reply, `${item.id}.operation.l1Reply`);
  const followup = item.followup ?? {};
  required(followup.text, `${item.id}.followup.text`);
  const after = followup.expected ?? {};
  if (after.action !== "forget" || !RELATIONS.includes(after.relation) || after.deleted?.a !== true ||
    typeof after.deleted?.b !== "boolean" || after.unknownC !== 0 || after.assistantDelta !== 1 ||
    after.chatModelCalls !== 0 || after.relationCallsMax !== 1 ||
    after.sources !== "command-and-answer-excluded") fail(`${item.id}.followup.expected 无效。`);
}

function readDataset() {
  const text = fs.readFileSync(DATASET_PATH, "utf8");
  const data = JSON.parse(text);
  if (typeof data.version !== "string" || !Array.isArray(data.cases) ||
    data.cases.length < 9 || data.cases.length > 12 || !Number.isFinite(Date.parse(data.fixedNow))) {
    fail("场景文件顶层或 fixedNow 无效。");
  }
  const ids = new Set();
  for (const item of data.cases) {
    if (typeof item.id !== "string" || !/^C\d{2}$/u.test(item.id) || ids.has(item.id)) fail("Case id 无效或重复。");
    ids.add(item.id);
    required(item.goal, `${item.id}.goal`);
    if (item.followup) {
      validateFollowupCase(item);
    } else {
      const expected = item.expected ?? {};
      if (!RELATIONS.includes(expected.relation) || !EFFECTS.includes(expected.effect) ||
        !Number.isInteger(expected.candidates) || expected.candidates < 0) fail(`${item.id}.expected 无效。`);
      if (expected.relationModel !== undefined && expected.relationModel !== "not_exercised") {
        fail(`${item.id}.expected.relationModel 无效。`);
      }
      if (expected.aBodyTokens !== undefined &&
        (!Array.isArray(expected.aBodyTokens) || expected.aBodyTokens.some((token) => typeof token !== "string" || !token))) {
        fail(`${item.id}.expected.aBodyTokens 无效。`);
      }
    }
    validateSide(item.a, `${item.id}.a`);
    validateSide(item.b, `${item.id}.b`);
    required(item.b.privateMarker, `${item.id}.b.privateMarker`);
    required(item.b.privateMarkerUtterance, `${item.id}.b.privateMarkerUtterance`);
    if (!item.b.privateMarkerUtterance.includes(item.b.privateMarker)) fail(`${item.id} 隐私标记不在 B 消息中。`);
    const operation = item.operation ?? {};
    if (!ACTIONS.includes(operation.action)) fail(`${item.id}.operation.action 无效。`);
    required(operation.text, `${item.id}.operation.text`);
    required(operation.targetNeedle, `${item.id}.operation.targetNeedle`);
    required(operation.evidence, `${item.id}.operation.evidence`);
    if (!operation.text.includes(operation.evidence)) fail(`${item.id} evidence 不在操作原话中。`);
    if (operation.action === "correct") required(operation.excerpt, `${item.id}.operation.excerpt`);
  }
  return { data, text };
}

function buildPlan(cases, mode) {
  const perCase = cases.map((item) => {
    const aTurns = item.a.prelude.length + 1;
    const bTurns = item.b.prelude.length + 2; // 事实 + B 独有隐私标记
    return { id: item.id, seedTurns: { a: aTurns, b: bTurns }, operationTurns: 1,
      liveChat: mode === "l2" ? aTurns + bTurns + 1 : 0 };
  });
  const liveChat = perCase.reduce((sum, item) => sum + item.liveChat, 0);
  const fixtureChat = perCase.reduce((sum, item) => sum + item.seedTurns.a + item.seedTurns.b + 1, 0);
  return { mode, cases: perCase.length, perCase,
    live: { models: 1, chat: liveChat, relation: perCase.length, total: 1 + liveChat + perCase.length },
    fixture: { chat: fixtureChat, relation: perCase.length } };
}

function relationDescription(side) {
  const sources = [side.text, side.sourceContext?.utterance,
    ...(side.sourceContext?.segments ?? []), ...(side.sourceContext?.context ?? []).map((item) => item.content)];
  const quote = ["用户", "我", "她"].find((candidate) =>
    sources.some((text) => typeof text === "string" && text.includes(candidate))) ?? side.text.slice(0, 1);
  return { subject: quote === "用户" ? "用户" : "我", subjectQuote: quote, scope: "current", time: null, timeQuote: null };
}

async function startRelationFixture() {
  const state = { relation: "uncertain" };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const pairs = JSON.parse(body.messages.find((message) => message.role === "user").content).pairs;
        const envelope = { results: pairs.map((pair) => ({
          pair: pair.id, relation: state.relation,
          left: relationDescription(pair.left), right: relationDescription(pair.right),
        })) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }] }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: safeError(error).message }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state, server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

function createChatFixture(caseData) {
  const queue = [];
  const requests = [];
  const turns = [];
  const empty = { reply: "我记下了。", memoryCandidates: [], memoryOperation: null, memoryRelay: null };
  const candidate = (l1) => ({ reply: "我记下了。", memoryCandidates: [{ ...l1, trust: "stated" }],
    memoryOperation: null, memoryRelay: null });
  for (const side of [caseData.a, caseData.b]) {
    for (const prior of side.prelude) { void prior; queue.push(empty); }
    queue.push(candidate(side.l1));
  }
  queue.push(empty); // B 独有隐私标记消息，不提炼
  const trace = { holder: null, turn: null };
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const lastUser = [...body.messages].reverse().find((message) => message.role === "user")?.content;
    let envelope;
    if (queue.length > 0) {
      envelope = queue.shift();
    } else if (lastUser === caseData.operation.text) {
      if (caseData.followup && caseData.operation.l1ModelOperation === "null") {
        envelope = { reply: caseData.operation.l1Reply, memoryCandidates: [], memoryOperation: null, memoryRelay: null };
      } else {
        const systemText = body.messages.filter((message) => message.role === "system")
          .map((message) => message.content).join("\n");
        const line = systemText.split("\n").find((item) =>
          /^\[M\d+\]/u.test(item) && item.includes(caseData.operation.targetNeedle));
        const target = line?.match(/^\[(M\d+)\]/u)?.[1];
        if (!target) fail(`Case ${caseData.id} 的 L1 目标未出现在候选列表。`);
        envelope = { reply: "好的。", memoryCandidates: [], memoryRelay: null, memoryOperation: {
          action: caseData.operation.action, target, evidence: caseData.operation.evidence,
          ...(caseData.operation.action === "correct" ? { excerpt: caseData.operation.excerpt } : { scope: "all" }),
        } };
      }
    } else fail(`Case ${caseData.id} 的聊天 fixture 没有可用响应。`);
    requests.push({ holder: trace.holder, messages: body.messages, response: envelope });
    turns.push(trace.turn);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, requests, turns, trace };
}

function installFetchSpy({ budget, dryRun }) {
  const original = globalThis.fetch;
  const calls = [];
  const trace = { caseId: null, holder: null, turn: null };
  const guards = { loopbackOnly: dryRun, blocked: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    const kind = body?.messages?.some((message) =>
      message.role === "system" && message.content.includes("记忆事实关系判定器")) ? "relation" : "chat";
    const entry = { caseId: trace.caseId, holder: trace.holder, turn: trace.turn, kind, url: redact(url),
      request: body, startedAt: Date.now(), fixture: dryRun };
    calls.push(entry);
    if (dryRun && !isLoopbackUrl(url)) {
      entry.error = { code: "NON_LOOPBACK_BLOCKED", message: "dry-run 只允许 loopback。" };
      guards.blocked.push({ url: entry.url, kind });
      fail("dry-run 禁止非 loopback 请求。");
    }
    if (calls.filter((call) => call.kind === kind).length > budget[kind]) {
      entry.error = { code: "CALL_BUDGET_EXCEEDED", message: `${kind} 超出计划上限。` };
      fail(`${kind} 调用超出计划上限 ${budget[kind]}。`);
    }
    try {
      const response = await original(input, init);
      entry.status = response.status;
      entry.durationMs = Date.now() - entry.startedAt;
      entry.response = await response.clone().text();
      return response;
    } catch (error) {
      entry.error = safeError(error);
      entry.durationMs = Date.now() - entry.startedAt;
      throw error;
    }
  };
  return { calls, trace, guards, restore() { globalThis.fetch = original; } };
}

function openStore(dir, credentials, chatFixture, fixedNow) {
  const store = createStore(dir, { now: () => fixedNow,
    chat: { getCredentials: () => credentials, ...(chatFixture ? { fetchImpl: chatFixture.fetch } : {}) } });
  try {
    const relationships = store.db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)");
    const stats = store.db.prepare("INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, ?, ?, ?)");
    for (const characterId of ["a", "b"]) {
      relationships.run(characterId, new Date(fixedNow).toISOString());
      stats.run(characterId, 10, 100, 0);
    }
    return store;
  } catch (error) {
    try { store.close(); } catch { /* 保留建库错误 */ }
    throw error;
  }
}

function snapshot(store) {
  const rows = (table) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return Object.fromEntries(TABLES.map((table) => [table, rows(table)]));
}
const entriesOf = (snap, characterId) => snap.memory_entries.filter((entry) => entry.character_id === characterId);
const entryById = (snap, id) => snap.memory_entries.find((entry) => entry.id === id) ?? null;
const entryOfFact = (snap, characterId, factKey) =>
  snap.memory_entries.find((entry) => entry.character_id === characterId && entry.fact_key === factKey) ?? null;
const sameRow = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function resolveSource(store, characterId, entry) {
  if (!entry) return null;
  try {
    return store.memorySourceContext.resolve({ characterId, entryId: entry.id, expectedVersion: entry.version });
  } catch (error) { return { status: "error", error: safeError(error) }; }
}

function summarizeSource(store, value) {
  if (!value) return null;
  if (value.status !== "ok") return { status: value.status, reason: value.reason ?? null,
    error: value.error ?? null };
  return {
    status: "ok", format: value.format ?? null, direct: value.direct ?? null, via: value.via ?? null,
    excerpt: value.excerpt, entryId: value.entryId, entryVersion: value.entryVersion,
    expiresAt: value.expiresAt, contextIncomplete: value.contextIncomplete,
    sourceMessage: value.sourceMessage ? { id: value.sourceMessage.id,
      conversationId: value.sourceMessage.conversationId, seq: value.sourceMessage.seq,
      createdAt: value.sourceMessage.createdAt, content: value.sourceMessage.content } : null,
    context: (value.messages ?? []).map((message) => message.content),
    isCurrent: store.memorySourceContext.isCurrent(value),
  };
}

function sourceOf(store, characterId, entry) {
  return summarizeSource(store, resolveSource(store, characterId, entry));
}

function findSeedEntry(store, side, holder, snap, isFixture) {
  if (isFixture) {
    const entry = entryOfFact(snap, holder, side.l1.factKey);
    return { entry, ambiguous: false, matches: entry ? [entry.id] : [] };
  }
  const scored = entriesOf(snap, holder).filter((entry) => entry.expires_at === null).map((entry) => {
    const source = sourceOf(store, holder, entry);
    const text = `${entry.body}\n${source?.excerpt ?? ""}`;
    return { entry, score: side.match.filter((token) => text.includes(token)).length };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  if (scored.length === 0) return { entry: null, ambiguous: false, matches: [] };
  const top = scored.filter((item) => item.score === scored[0].score);
  if (top.length > 1) return { entry: null, ambiguous: true, matches: top.map((item) => item.entry.id) };
  return { entry: top[0].entry, ambiguous: false, matches: [top[0].entry.id] };
}

function assistantState(store, conversation, characterId) {
  const list = store.chat.getConversation({ characterId, conversationId: conversation.id })
    .messages.filter((message) => message.role === "assistant");
  return { count: list.length, ids: list.map((message) => message.id),
    contents: list.map((message) => message.content), lastId: list.at(-1)?.id ?? null,
    lastContent: list.at(-1)?.content ?? null };
}

async function waitUntil(predicate, message) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > SETTLE_TIMEOUT_MS) fail(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function relationFromCall(call, sourceSnapshots) {
  const requestPairs = JSON.parse(call.request.messages.find((message) => message.role === "user").content).pairs;
  /* 请求体里的 sourceContext 是发送给模型的紧凑视图；用请求前真实 resolve
     快照重新解析 effectiveRelation，避免把紧凑视图误当协议输入。 */
  const pairs = requestPairs.map((pair) => ({
    ...pair,
    left: { ...pair.left, sourceContext: sourceSnapshots?.[pair.left.holder] ?? pair.left.sourceContext },
    right: { ...pair.right, sourceContext: sourceSnapshots?.[pair.right.holder] ?? pair.right.sourceContext },
  }));
  const content = JSON.parse(call.response)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") fail("关系响应缺少助手内容。");
  const parsed = parseRelationResponse(content, pairs);
  const views = parsed.results.map((result) => {
    const pair = pairs.find((item) => item.id === result.pair);
    return { id: result.pair, leftHolder: pair?.left?.holder ?? null, rightHolder: pair?.right?.holder ?? null,
      leftText: pair?.left?.text ?? null, rightText: pair?.right?.text ?? null,
      relation: result.relation, effectiveRelation: result.effectiveRelation, reasons: result.reasons };
  });
  const target = views.find((pair) => pair.rightHolder === "b");
  if (!target) fail("关系响应中没有 B 候选对。");
  return { actual: target.effectiveRelation, raw: target.relation, pairs: views, pairCount: pairs.length };
}

function attachRequests(record, chatFixture, spy) {
  const calls = spy.calls;
  record.requests.chat = chatFixture ? chatFixture.requests : calls.filter((call) =>
    call.caseId === record.id && call.kind === "chat").map((call) => ({
    holder: call.holder, messages: call.request?.messages ?? [], response: call.response ?? null,
    error: call.error ?? null }));
  record.requests.relation = calls.filter((call) =>
    call.caseId === record.id && call.kind === "relation").map((call) => ({
    request: call.request, response: call.response ?? null, error: call.error ?? null,
    durationMs: call.durationMs ?? null }));
  record.calls.fixtureChat = chatFixture?.requests.length ?? 0;
  record.calls.networkChat = calls.filter((call) => call.caseId === record.id && call.kind === "chat").length;
  record.calls.relation = calls.filter((call) => call.caseId === record.id && call.kind === "relation").length;
}

function markFlags(record, caseData) {
  if (!record.relation.exercised) return;
  const flags = record.flags;
  const expected = caseData.expected.relation;
  const raw = record.relation.raw, effective = record.relation.actual;
  if (raw !== null) {
    flags.rawFalseMerge = expected !== "equivalent" && raw === "equivalent";
    flags.relationMismatch = flags.relationMismatch || raw !== expected;
  }
  if (effective !== null) {
    flags.effectiveFalseMerge = expected !== "equivalent" && effective === "equivalent";
    flags.relationMismatch = flags.relationMismatch || effective !== expected;
    if (expected === "equivalent" && effective !== "equivalent") flags.missedPositive = true;
  }
  flags.classificationFalseMerge = flags.rawFalseMerge || flags.effectiveFalseMerge;
}

function databaseMutation(before, after, bBefore) {
  const oldIds = new Set(before.memory_entries.map((entry) => entry.id));
  const afterB = entryById(after, bBefore.id);
  const bOwned = entriesOf(after, "b");
  const newBOwned = bOwned.filter((entry) => !oldIds.has(entry.id));
  const newTemps = after.memory_entries.filter((entry) => entry.expires_at !== null && !oldIds.has(entry.id));
  const bIds = new Set([...entriesOf(before, "b"), ...bOwned].map((entry) => entry.id));
  const beforeIdentity = bBefore.fact_identity_id;
  const identityChanged = (afterB && afterB.fact_identity_id !== beforeIdentity) ||
    newBOwned.some((entry) => entry.fact_identity_id !== beforeIdentity);
  const edgeChanged = JSON.stringify(before.memory_fact_relation_edges) !==
      JSON.stringify(after.memory_fact_relation_edges) &&
    after.memory_fact_relation_edges.some((edge) =>
      bIds.has(edge.from_entry_id) || bIds.has(edge.to_entry_id));
  return { bChanged: !afterB || !sameRow(afterB, bBefore), newBOwned: newBOwned.length,
    newTemps: newTemps.length, identityChanged, edgeChanged };
}

function checkEffects(caseData, record, before, after, actual, fixedNow) {
  const flags = record.flags, reasons = record.reasons;
  const aBefore = entryById(before, record.seed.a.entryId);
  const bBefore = entryById(before, record.seed.b.entryId);
  if (!aBefore || !bBefore) { reasons.push("seed-entry-missing"); return; }
  const aAfter = entryById(after, aBefore.id), bAfter = entryById(after, bBefore.id);
  const effect = caseData.expected.effect;
  const tokens = caseData.expected.aBodyTokens ?? [];
  const target = record.operation.modelOperation?.modelOperation?.target ?? null;
  if (record.operation.candidates !== caseData.expected.candidates) {
    flags.candidateCountMismatch = true; reasons.push("candidate-count-mismatch");
  }
  if (effect === "temporary_copy" && record.operation.proofMode !== "temporary") {
    flags.wrongOperationType = true; reasons.push("temporary-proof-mode-mismatch");
  }
  if (effect !== "temporary_copy" && record.operation.proofMode === "temporary") {
    flags.wrongOperationType = true; reasons.push("unexpected-temporary-proof-mode");
  }
  if (effect === "correct_propagate") {
    if (!aAfter) reasons.push("a-updated-entry-missing");
    if (!bAfter) { flags.missedPositive = true; reasons.push("b-propagation-missing"); }
    else if (!aAfter || bAfter.body !== aAfter.body || bAfter.fact_identity_id !== aAfter.fact_identity_id) {
      flags.wrongSync = true; reasons.push("b-propagation-mismatch");
    }
    const corrected = Boolean(aAfter) && aAfter.version > aBefore.version &&
      aAfter.body !== aBefore.body && tokens.length > 0 && tokens.some((token) => aAfter.body.includes(token));
    record.effects.aCorrection = { temporary: false, target, userText: caseData.operation.text,
      before: aBefore.body, after: aAfter?.body ?? null, versionBefore: aBefore.version,
      versionAfter: aAfter?.version ?? null, tokens, tokensMatched: Boolean(aAfter) &&
        tokens.some((token) => aAfter.body.includes(token)), tokensOnlyCoarseFilter: true };
    if (!corrected) { flags.aCorrectionMismatch = true; reasons.push("a-correction-not-verified"); }
    record.operation.executed = corrected;
  } else if (effect === "forget_delete") {
    record.operation.executed = !aAfter;
    if (aAfter) { flags.wrongDelete = true; reasons.push("a-stage1-delete-missing"); }
    if (actual === "equivalent" && bAfter) { flags.missedPositive = true; reasons.push("b-delete-missing"); }
    if (actual !== "equivalent" && !bAfter) { flags.wrongDelete = true; reasons.push("b-deleted-without-equivalent"); }
  } else if (effect === "no_propagate") {
    if (!bAfter) { flags.wrongDelete = true; reasons.push("b-deleted-without-equivalent"); }
    else if (!sameRow(bAfter, bBefore)) { flags.wrongSync = true; reasons.push("b-changed-without-equivalent"); }
    const corrected = Boolean(aAfter) && aAfter.version > aBefore.version &&
      aAfter.body !== aBefore.body && tokens.length > 0 && tokens.some((token) => aAfter.body.includes(token));
    record.effects.aCorrection = { temporary: false, target, userText: caseData.operation.text,
      before: aBefore.body, after: aAfter?.body ?? null, versionBefore: aBefore.version,
      versionAfter: aAfter?.version ?? null, tokens, tokensMatched: Boolean(aAfter) &&
        tokens.some((token) => aAfter.body.includes(token)), tokensOnlyCoarseFilter: true };
    if (!corrected) { flags.aCorrectionMismatch = true; reasons.push("a-correction-not-verified"); }
    record.operation.executed = corrected;
  } else if (effect === "temporary_copy") {
    if (!aAfter || !sameRow(aAfter, aBefore)) { flags.wrongSync = true; reasons.push("a-long-term-changed"); }
    if (!bAfter || !sameRow(bAfter, bBefore)) { flags.wrongSync = true; reasons.push("b-long-term-changed"); }
    const aTemps = entriesOf(after, "a").filter((entry) => entry.expires_at !== null);
    const bTemps = entriesOf(after, "b").filter((entry) => entry.expires_at !== null);
    const expectedExpiry = endOfLocalDay(fixedNow);
    record.effects.aCorrection = { temporary: true, target, userText: caseData.operation.text,
      before: aBefore.body, after: aTemps[0]?.body ?? null, tokens, expiresAt: aTemps[0]?.expires_at ?? null,
      tokensMatched: Boolean(aTemps[0]) && tokens.some((token) => aTemps[0].body.includes(token)),
      tokensOnlyCoarseFilter: true };
    if (actual === "equivalent") {
      if (aTemps.length !== 1 || bTemps.length !== 1) { flags.missedPositive = true; reasons.push("temporary-current-missing"); }
      else if (aTemps[0].fact_identity_id !== bTemps[0].fact_identity_id ||
        aTemps[0].body !== bTemps[0].body || aTemps[0].expires_at !== bTemps[0].expires_at ||
        aTemps[0].expires_at !== expectedExpiry) {
        flags.wrongSync = true; reasons.push("temporary-current-mismatch");
      } else if (!/^chat-current-copy:/u.test(bTemps[0].source_id)) {
        flags.wrongSync = true; reasons.push("b-temporary-source-not-copy");
      }
      if (aTemps.length !== 1 || !tokens.some((token) => aTemps[0].body.includes(token))) {
        flags.aCorrectionMismatch = true; reasons.push("temporary-content-not-verified");
      }
      record.operation.executed = aTemps.length === 1 &&
        tokens.some((token) => aTemps[0].body.includes(token));
    } else if (bTemps.length > 0) {
      flags.wrongSync = true; reasons.push("b-temporary-created-without-equivalent");
    }
  }
  if (caseData.expected.relation !== "equivalent" &&
    ["no_propagate", "temporary_copy", "forget_delete"].includes(effect)) {
    const mutation = databaseMutation(before, after, bBefore);
    if (mutation.bChanged || mutation.newBOwned > 0 || mutation.newTemps > 0 ||
      mutation.identityChanged || mutation.edgeChanged) {
      flags.databaseFalseMerge = true; reasons.push("database-mutated-without-equivalent");
      record.effects.databaseMutation = mutation;
    }
  }
  if (caseData.expected.unknownC) {
    if (entriesOf(after, "c").length > 0) { flags.holderLeak = true; reasons.push("unknown-c-records-created"); }
    if (record.relation.pairs.some((pair) => pair.leftHolder === "c" || pair.rightHolder === "c")) {
      flags.holderLeak = true; reasons.push("unknown-c-in-relation-pairs");
    }
  }
  flags.falseMerge = flags.classificationFalseMerge || flags.databaseFalseMerge;
}

function endOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function checkLeak(caseData, record) {
  const marker = caseData.b.privateMarker;
  const matches = [];
  record.requests.chat.filter((item) => item.holder === "a").forEach((request, index) => {
    const text = request.messages.map((message) => message.content).join("\n");
    if (text.includes(marker)) matches.push({ request: index, marker });
  });
  record.leak = { marker, found: matches.length > 0, matches };
  record.flags.leak = matches.length > 0;
  if (record.leak.found) record.reasons.push("a-prompt-contains-b-private-marker");
}

function aggregate(records) {
  const metrics = { cases: records.length, pass: 0, fail: 0, error: 0, dryRun: 0, review: 0,
    inconclusive: 0, notCovered: 0, notTriggered: 0,
    relationCalls: 0, fixtureChatCalls: 0, networkChatCalls: 0, semanticReviewRequired: 0,
    relationNotExercised: 0, ...Object.fromEntries(FLAG_KEYS.map((key) => [key, 0])) };
  for (const record of records) {
    const statusKey = { PASS: "pass", FAIL: "fail", ERROR: "error", REVIEW: "review",
      "DRY-RUN": "dryRun", INCONCLUSIVE: "inconclusive", NOT_COVERED: "notCovered" }[record.status];
    if (statusKey) metrics[statusKey] += 1;
    for (const key of FLAG_KEYS) if (record.flags[key]) metrics[key] += 1;
    metrics.relationCalls += record.calls.relation;
    metrics.fixtureChatCalls += record.calls.fixtureChat;
    metrics.networkChatCalls += record.calls.networkChat;
    if (record.semanticReviewRequired) metrics.semanticReviewRequired += 1;
    if (record.relation.model === "not_exercised") metrics.relationNotExercised += 1;
    if (record.clarification?.path && record.clarification.path !== "clarify") metrics.notTriggered += 1;
  }
  return metrics;
}

function writeResult(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { if (error?.code === "EEXIST") fail(`拒绝覆盖已有结果：${file}`); throw error; }
}

function baseRecord(options, data, text, plan) {
  return { generatedAt: new Date().toISOString(), mode: options.mode, dryRun: options.dryRun,
    boundary: { chat: options.dryRun || options.mode === "l1" ? "fixture" : "real",
      relation: options.dryRun ? "fixture" : "real", core: "real createStore/chat/memory/SQLite" },
    semanticReviewRequired: options.mode === "l2",
    model: { name: options.model, used: null, presentInModels: null, requestModelMismatch: false },
    credentialsRead: false, network: false,
    guards: { loopbackOnly: options.dryRun, blocked: [] },
    input: { dataset: path.relative(REPO_ROOT, DATASET_PATH), version: data.version, sha256: sha256(text) },
    modules: { tool: shaOfFile(__filename), dataset: shaOfFile(DATASET_PATH),
      production: ["app/store.cjs", "app/chat.cjs", "app/memory.cjs", "app/memory-store.cjs",
        "app/memory-source-context.cjs", "app/memory-relation-protocol.cjs", "app/chat-memory-verification.cjs",
        "app/chat-memory-operations.cjs", "app/model.cjs"].map((relative) => shaOfFile(path.join(REPO_ROOT, relative))) },
    plan, calls: { models: 0, fixtureChat: 0, networkChat: 0, relation: 0, totalHttp: 0 },
    durationsMs: { models: null, total: null }, cases: [], metrics: null, cleanup: null,
    output: options.out, error: null, status: "PENDING" };
}

async function listModels(baseUrl, apiKey) {
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` },
      redirect: "manual", signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
  } catch { fail("GET /models 请求失败或超时。"); }
  if (response.status >= 300 && response.status < 400) fail("GET /models 返回重定向，已停止。");
  if (response.status !== 200) fail(`GET /models 返回 HTTP ${response.status}。`);
  const data = await response.json().catch(() => null);
  return Array.isArray(data?.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
}

function loadCredentials() {
  let values;
  try { values = parseEnv(fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8")); }
  catch { fail("无法读取根 .env；live 需要 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。"); }
  const baseUrl = values.OPEN_AI_BASE_URL?.trim(), apiKey = values.OPEN_AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) fail("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY。");
  return { baseUrl: parseBaseUrl(baseUrl), apiKey };
}

function changedTables(before, after, tables = MEMORY_TABLES) {
  return tables.filter((table) =>
    JSON.stringify(before?.[table] ?? null) !== JSON.stringify(after?.[table] ?? null));
}

async function settleRequest(store, characterId, requestId) {
  if (store.chat.getRequest({ characterId, requestId }).verificationStatus === "pending") {
    await waitUntil(() => store.chat.getRequest({ characterId, requestId }).verificationStatus !== "pending",
      `请求 ${requestId} 的核验未在时限内收束。`);
  }
  return store.chat.getRequest({ characterId, requestId });
}
function readProof(store, requestId) {
  const row = store.db.prepare(
    "SELECT operation_proof, verification_status, memory_applied FROM chat_requests WHERE id = ?",
  ).get(requestId);
  let proof = null;
  try { proof = row?.operation_proof ? JSON.parse(row.operation_proof) : null; } catch { proof = null; }
  return { row, proof };
}
function note(record, flag, reason) {
  if (flag) record.flags[flag] = true;
  record.reasons.push(reason);
}
function markTrace(chatFixture, spy, holder, turn) {
  for (const trace of [chatFixture?.trace, spy.trace]) {
    if (trace) Object.assign(trace, { holder, turn });
  }
}
function chatEnvelopeForTurn({ chatFixture, spy, caseId, turn, holder, text }) {
  let call;
  if (chatFixture) {
    const index = chatFixture.turns.findIndex((item, position) => item === turn &&
      chatFixture.requests[position].holder === holder &&
      chatFixture.requests[position].messages.at(-1)?.content === text);
    if (index < 0) return { status: "missing" };
    call = chatFixture.requests[index];
  } else {
    const calls = spy.calls.filter((item) => item.caseId === caseId && item.kind === "chat" &&
      item.turn === turn && item.holder === holder && item.request?.messages?.at(-1)?.content === text);
    if (calls.length === 0) return { status: "missing" };
    if (calls.length > 1) return { status: "invalid", reason: "multiple-chat-requests" };
    call = { messages: calls[0].request?.messages ?? [], response: calls[0].response };
  }
  if (call.response && typeof call.response === "object") {
    if (!Object.prototype.hasOwnProperty.call(call.response, "memoryOperation")) {
      return { status: "invalid", reason: "memoryOperation-missing", raw: call.response, messages: call.messages };
    }
    return { status: "ok", source: "fixture-envelope", raw: call.response,
      modelOperation: call.response.memoryOperation, reply: call.response.reply ?? null, messages: call.messages };
  }
  if (typeof call.response !== "string") {
    return { status: "invalid", reason: "response-not-text", messages: call.messages };
  }
  try {
    const content = JSON.parse(JSON.parse(call.response).choices[0].message.content);
    if (!content || typeof content !== "object" ||
      !Object.prototype.hasOwnProperty.call(content, "memoryOperation")) {
      return { status: "invalid", reason: "memoryOperation-missing", raw: call.response, messages: call.messages };
    }
    return { status: "ok", source: "network-envelope", raw: call.response,
      modelOperation: content.memoryOperation, reply: content.reply ?? null, messages: call.messages };
  } catch {
    return { status: "invalid", reason: "response-parse-failed", raw: call.response, messages: call.messages };
  }
}

function bindTurnIndexes(record, caseData) {
  const chat = record.requests.chat, relation = record.requests.relation;
  const first = record.clarification?.firstTurn, followup = record.clarification?.followup;
  const indexOf = (text) => chat.findIndex((item) => item.holder === "a" && item.messages.at(-1)?.content === text);
  if (first) {
    first.chatRequestIndex = indexOf(caseData.operation.text);
    first.relationRequestIndexes = followup ? [] : relation.map((_, index) => index);
  }
  if (followup) {
    followup.chatRequestIndex = indexOf(caseData.followup.text);
    followup.relationRequestIndexes = relation.map((_, index) => index);
  }
}

async function runClarificationTurns({
  caseData, options, record, store, conversationA, conversationB, chatFixture, spy,
}) {
  const clarification = { path: null, firstTurn: null, followup: null, facts: null, outcome: null };
  record.clarification = clarification;
  const beforeA = assistantState(store, conversationA, "a");
  const beforeB = assistantState(store, conversationB, "b");
  markTrace(chatFixture, spy, "a", "operation");
  const firstResult = await store.chat.sendMessage({ characterId: "a", conversationId: conversationA.id,
    text: caseData.operation.text, requestId: record.operation.requestId });
  if (firstResult.status !== "completed") fail(`Case ${caseData.id} 首回合未完成：${firstResult.status}`);
  const firstSettled = await settleRequest(store, "a", record.operation.requestId);
  const firstSnapshot = snapshot(store);
  record.snapshots.firstTurnAfter = firstSnapshot;
  const firstProof = readProof(store, record.operation.requestId);
  const afterA = assistantState(store, conversationA, "a");
  const envelope = chatEnvelopeForTurn({ chatFixture, spy, caseId: record.id,
    turn: "operation", holder: "a", text: caseData.operation.text });
  const firstMemory = changedTables(record.snapshots.before, firstSnapshot);
  const firstRelationCount = spy.calls.filter((call) =>
    call.caseId === record.id && call.kind === "relation" && call.turn === "operation").length;
  const candidateLines = (envelope.messages ?? []).filter((message) => message.role === "system")
    .flatMap((message) => String(message.content).split("\n")).filter((line) => /^\[M\d+\]/u.test(line));
  delete envelope.messages;
  clarification.firstTurn = { requestId: record.operation.requestId, turn: "operation", chatRequestIndex: null,
    relationRequestIndexes: [], status: firstResult.status, verificationStatus: firstSettled.verificationStatus,
    memoryApplied: firstResult.memoryApplied, reply: firstResult.reply, modelOperation: envelope,
    proof: firstProof.proof, assistant: { before: beforeA, after: afterA }, dbChangedTables: firstMemory };
  if (envelope.status !== "ok") {
    note(record, "missedOperation",
      `operation-envelope-${envelope.status}${envelope.reason ? `:${envelope.reason}` : ""}`);
    record.snapshots.after = firstSnapshot;
    record.status = chatFixture ? "ERROR" : "FAIL";
    if (chatFixture) record.error = { stage: "envelope", code: "ENVELOPE_INVALID" };
    return record;
  }
  const assistantBad = afterA.count !== beforeA.count + 1 || afterA.lastId !== firstResult.assistantMessageId;
  const verificationBad = !["none", "completed"].includes(firstSettled.verificationStatus);
  const l1Leak = Boolean(chatFixture && String(firstResult.reply ?? "").includes(caseData.operation.l1Reply));
  const violations = firstMemory.length > 0 || firstRelationCount > 0 || Boolean(firstProof.proof) ||
    assistantBad || verificationBad || l1Leak;
  if (assistantBad) note(record, "wrongAssistant", "first-turn-assistant-count");
  if (verificationBad) note(record, null, `first-verification-${firstSettled.verificationStatus}`);
  if (l1Leak) note(record, "wrongAssistant", "l1-fake-success-leaked");
  if (envelope.modelOperation !== null) {
    clarification.path = "model-direct-operation";
    clarification.facts = { modelOperation: envelope.modelOperation, reply: firstResult.reply, verificationStatus: firstSettled.verificationStatus };
    record.snapshots.after = firstSnapshot;
    record.status = assistantBad || verificationBad || l1Leak ? "FAIL" : "NOT_COVERED";
    return record;
  }
  if (firstMemory.length > 0) note(record, "wrongSync", "first-turn-memory-changed");
  if (firstRelationCount > 0) note(record, null, "first-turn-relation-called");
  if (firstProof.proof) note(record, null, "first-turn-proof-present");
  const replyText = String(firstResult.reply ?? "");
  const candidateCount = (replyText.match(/\[第\s*\d+\s*条\]/gu) ?? []).length;
  const observed = (replyText.includes("我只找到一条可能相关的记忆") ||
    /我找到\s*\d+\s*条可能相关的记忆/u.test(replyText)) && candidateCount > 0 && replyText.includes("加糖");
  if (!observed) {
    clarification.path = "null-no-prompt";
    const seedBody = entryById(record.snapshots.before, record.seed.a.entryId)?.body ?? null;
    const premise = Boolean(seedBody?.includes("加糖")) &&
      candidateLines.some((line) => line.includes("加糖")) && caseData.expected.candidates === 1;
    clarification.facts = { modelNull: true, seedBody, requestLines: candidateLines,
      expectedCandidates: caseData.expected.candidates, promptObserved: false, gaps: violations || premise ? [] : ["request candidate text or seed premise not proven"] };
    if (violations) record.status = "FAIL";
    else if (premise) { note(record, null, "clarification-premise-met-but-no-prompt"); record.status = "FAIL"; }
    else record.status = "INCONCLUSIVE";
    record.snapshots.after = firstSnapshot;
    return record;
  }
  clarification.path = "clarify";
  if (candidateCount !== caseData.expected.candidates) {
    note(record, "candidateCountMismatch", "prompt-candidate-count-mismatch");
  }
  if (record.reasons.length > 0 || Object.values(record.flags).some(Boolean)) {
    record.status = "FAIL";
    record.snapshots.after = firstSnapshot;
    return record;
  }
  markTrace(chatFixture, spy, "a", "followup");
  const followupRequestId = crypto.randomUUID();
  const answerResult = await store.chat.sendMessage({ characterId: "a", conversationId: conversationA.id,
    text: caseData.followup.text, requestId: followupRequestId });
  const phase1 = assistantState(store, conversationA, "a");
  const answerSettled = await settleRequest(store, "a", followupRequestId);
  const answerProof = readProof(store, followupRequestId);
  const finalSnapshot = snapshot(store);
  record.snapshots.after = finalSnapshot;
  const finalA = assistantState(store, conversationA, "a");
  const finalB = assistantState(store, conversationB, "b");
  const answerChatCount = chatFixture ? chatFixture.turns.filter((turn) => turn === "followup").length
    : spy.calls.filter((call) => call.caseId === record.id && call.kind === "chat" &&
      call.turn === "followup").length;
  const relationCalls = spy.calls.filter((call) =>
    call.caseId === record.id && call.kind === "relation" && call.turn === "followup");
  const messages = store.chat.getConversation({ characterId: "a", conversationId: conversationA.id }).messages;
  const command = messages.find((message) => message.role === "user" && message.content === caseData.operation.text);
  const answerMessage = messages.find((message) => message.role === "user" && message.content === caseData.followup.text);
  const commandHash = command ? sha256(command.sourceId) : null;
  const answerHash = answerMessage ? sha256(answerMessage.sourceId) : null;
  const proof = answerProof.proof;
  const excluded = store.memory.listExcludedSources("a");
  clarification.followup = { requestId: followupRequestId, turn: "followup", chatRequestIndex: null,
    relationRequestIndexes: [], status: answerResult.status, verificationStatus: answerSettled.verificationStatus,
    reply: finalA.lastContent, proof, assistant: { phase1, final: finalA },
    dbChangedTables: changedTables(firstSnapshot, finalSnapshot),
    relation: { expected: caseData.followup.expected.relation, actual: null, raw: null, pairs: [] },
    sources: { commandSourceHash: proof?.commandSourceHash ?? null, commandSourceId: proof?.commandSourceId ?? null,
      answerSourceHash: answerHash, excluded, sourceControls: proof?.sourceControls ?? null } };
  if (answerResult.status !== "completed") note(record, null, "followup-not-completed");
  if (answerChatCount > 0) note(record, null, "followup-chat-model-called");
  if (relationCalls.length > 1) note(record, null, "followup-relation-more-than-once");
  if (!command || !answerMessage) note(record, null, "source-message-missing");
  if (proof?.action !== "forget") note(record, "missedOperation", "followup-proof-missing");
  if (commandHash && proof?.commandSourceHash !== commandHash) note(record, null, "command-source-hash-mismatch");
  if (command && proof?.commandSourceId !== command.sourceId) note(record, null, "command-source-id-mismatch");
  if (commandHash && !excluded.includes(commandHash)) note(record, null, "command-source-not-excluded");
  if (answerHash && !excluded.includes(answerHash)) note(record, null, "answer-source-not-excluded");
  const sourceControls = Array.isArray(proof?.sourceControls?.a) ? proof.sourceControls.a : null;
  if (!sourceControls) note(record, null, "proof-source-controls-missing");
  else {
    if (commandHash && !sourceControls.includes(commandHash)) note(record, null, "proof-command-source-control-missing");
    if (answerHash && !sourceControls.includes(answerHash)) note(record, null, "proof-answer-source-control-missing");
  }
  if (phase1.count !== beforeA.count + 2 || phase1.lastId !== answerResult.assistantMessageId ||
    finalA.ids.join("\u0000") !== phase1.ids.join("\u0000")) {
    note(record, "wrongAssistant", "followup-assistant-not-single-in-place");
  }
  if (/正在核对/u.test(finalA.lastContent ?? "")) note(record, null, "assistant-still-verifying");
  if (relationCalls.length === 1 && answerSettled.verificationStatus !== "completed") {
    note(record, null, `followup-verification-${answerSettled.verificationStatus}`);
  }
  if (JSON.stringify(finalB.ids) !== JSON.stringify(beforeB.ids) ||
    JSON.stringify(finalB.contents) !== JSON.stringify(beforeB.contents)) {
    note(record, "wrongAssistant", "b-assistant-messages-changed");
  }
  const aAfter = entryById(finalSnapshot, record.seed.a.entryId);
  const bAfter = entryById(finalSnapshot, record.seed.b.entryId);
  const bBeforeRow = entryById(record.snapshots.before, record.seed.b.entryId);
  if (relationCalls.length === 1) {
    try {
      const parsed = relationFromCall(relationCalls[0], record.sourceSnapshots);
      Object.assign(clarification.followup.relation,
        { actual: parsed.actual, raw: parsed.raw, pairs: parsed.pairs });
      Object.assign(record.relation,
        { exercised: true, actual: parsed.actual, raw: parsed.raw, pairs: parsed.pairs });
      markFlags(record, { expected: { relation: caseData.followup.expected.relation } });
    } catch {
      note(record, "noVerification", "relation-response-invalid");
    }
  } else if (relationCalls.length === 0) {
    note(record, "noVerification", "followup-relation-missing");
    if (!bAfter) note(record, "wrongDelete", "b-deleted-without-relation");
  }
  clarification.outcome = { aDeleted: !aAfter, bDeleted: !bAfter, cEntries: entriesOf(finalSnapshot, "c").length, relationActual: record.relation.actual };
  if (aAfter) note(record, "wrongDelete", "a-not-deleted");
  if (record.relation.actual === "equivalent" && bAfter) {
    note(record, "missedPositive", "b-not-deleted-with-equivalent");
  }
  if (record.relation.exercised && record.relation.actual !== "equivalent" && !bAfter) {
    note(record, "wrongDelete", "b-deleted-without-equivalent");
  }
  if (record.relation.exercised && record.relation.actual !== "equivalent" && bAfter &&
    !sameRow(bAfter, bBeforeRow)) {
    note(record, "wrongSync", "b-changed-without-equivalent");
  }
  if (clarification.outcome.cEntries > 0) note(record, "holderLeak", "unknown-c-records-created");
  if (record.reasons.length > 0 || Object.values(record.flags).some(Boolean)) record.status = "FAIL";
  else record.status = options.dryRun ? "DRY-RUN" : options.mode === "l2" ? "REVIEW" : "PASS";
  return record;
}

async function runCase(caseData, options, credentials, spy, fixedNow) {
  const record = { id: caseData.id, goal: caseData.goal, expected: { ...caseData.expected },
    semanticReviewRequired: options.mode === "l2", status: "ERROR", error: null, cleanup: null,
    seed: { a: { entryId: null }, b: { entryId: null }, extracted: { a: false, b: false } },
    operation: { text: caseData.operation.text, expectedAction: caseData.operation.action,
      actualAction: null, effectiveAction: null, executed: false, modelOperation: null,
      requestId: crypto.randomUUID(), resultStatus: null,
      verificationStatus: null, candidates: null, proof: null, assistantMessageId: null },
    relation: { expected: caseData.expected.relation, model: caseData.expected.relationModel ?? null,
      exercised: false, actual: null, raw: null, fixture: options.dryRun, pairs: [] },
    effects: { aCorrection: null,
      singleAssistant: { a: { before: null, phase1: null, final: null }, b: { before: null, final: null } } },
    requests: { chat: [], relation: [] }, leak: { marker: caseData.b.privateMarker, found: false, matches: [] },
    markerExtracted: false, calls: { fixtureChat: 0, networkChat: 0, relation: 0 },
    durationsMs: { operation: null, total: null }, snapshots: { before: null, after: null, source: null },
    sourceSnapshots: { a: null, b: null }, reasons: [], flags: newFlags() };
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-chat-op-probe-"));
  let store = null;
  let conversationA = null, conversationB = null;
  const chatFixture = options.dryRun || options.mode === "l1" ? createChatFixture(caseData) : null;
  try {
    spy.trace.caseId = caseData.id;
    store = openStore(dir, credentials, chatFixture, fixedNow);
    conversationA = store.chat.openConversation({ characterId: "a" }).conversation;
    conversationB = store.chat.openConversation({ characterId: "b" }).conversation;
    const send = async (holder, conversation, text, turn = "seed") => {
      const trace = chatFixture?.trace ?? spy.trace;
      trace.holder = holder;
      trace.turn = turn;
      return store.chat.sendMessage({ characterId: holder, conversationId: conversation.id,
        text, requestId: crypto.randomUUID() });
    };
    for (const [holder, side, conversation] of [["a", caseData.a, conversationA], ["b", caseData.b, conversationB]]) {
      for (const prior of side.prelude) {
        if ((await send(holder, conversation, prior)).status !== "completed") fail(`Case ${caseData.id} ${holder} 前文失败。`);
      }
      if ((await send(holder, conversation, side.utterance)).status !== "completed") fail(`Case ${caseData.id} ${holder} 事实失败。`);
    }
    if ((await send("b", conversationB, caseData.b.privateMarkerUtterance)).status !== "completed") {
      fail(`Case ${caseData.id} B 隐私标记发送失败。`);
    }
    record.snapshots.before = snapshot(store);
    for (const [holder, side] of [["a", caseData.a], ["b", caseData.b]]) {
      const found = findSeedEntry(store, side, holder, record.snapshots.before, Boolean(chatFixture));
      record.seed[holder] = { entryId: found.entry?.id ?? null, candidateIds: found.matches, ambiguous: found.ambiguous };
      record.seed.extracted[holder] = Boolean(found.entry);
      if (found.ambiguous) { record.flags.seedAmbiguous = true; record.reasons.push(`seed-ambiguous-${holder}`); }
      if (!found.entry) record.flags[holder === "a" ? "missedExtractionA" : "missedExtractionB"] = true;
    }
    record.sourceSnapshots = {
      a: resolveSource(store, "a", entryById(record.snapshots.before, record.seed.a.entryId)),
      b: resolveSource(store, "b", entryById(record.snapshots.before, record.seed.b.entryId)) };
    record.snapshots.source = {
      a: summarizeSource(store, record.sourceSnapshots.a),
      b: summarizeSource(store, record.sourceSnapshots.b) };
    record.markerExtracted = entriesOf(record.snapshots.before, "b").some((entry) => {
      const source = sourceOf(store, "b", entry);
      return `${entry.body}\n${source?.excerpt ?? ""}`.includes(caseData.b.privateMarker);
    });
    if (!record.seed.extracted.a || !record.seed.extracted.b) {
      record.reasons.push("seed-extraction-incomplete");
      record.snapshots.after = snapshot(store);
      record.status = chatFixture ? "ERROR" : "FAIL";
      if (chatFixture) record.error = { code: "SEED_EXTRACTION", message: "fixture 种子条目缺失或歧义。" };
      return record;
    }
    if (caseData.followup) {
      return await runClarificationTurns({
        caseData, options, record, store, conversationA, conversationB, chatFixture, spy,
      });
    }
    const aBefore = assistantState(store, conversationA, "a");
    const bBefore = assistantState(store, conversationB, "b");
    record.effects.singleAssistant.a.before = aBefore;
    record.effects.singleAssistant.b.before = bBefore;
    const operationStarted = Date.now();
    markTrace(chatFixture, spy, "a", "operation");
    const result = await store.chat.sendMessage({ characterId: "a", conversationId: conversationA.id,
      text: caseData.operation.text, requestId: record.operation.requestId });
    record.durationsMs.operation = Date.now() - operationStarted;
    record.operation.resultStatus = result.status;
    record.operation.verificationStatus = result.verificationStatus;
    record.operation.assistantMessageId = result.assistantMessageId ?? null;
    if (result.status !== "completed") fail(`Case ${caseData.id} 操作发送失败：${result.status}`);
    record.effects.singleAssistant.a.phase1 = assistantState(store, conversationA, "a");
    await settleRequest(store, "a", record.operation.requestId);
    const proof = readProof(store, record.operation.requestId);
    record.operation.verificationStatus = proof.row?.verification_status ?? null;
    record.operation.candidates = proof.proof?.candidates?.length ?? 0;
    record.operation.actualAction = proof.proof?.action ?? null;
    record.operation.proof = proof.proof ? { version: proof.proof.version, mode: proof.proof.mode,
      action: proof.proof.action, candidateCount: proof.proof.candidates?.length ?? 0,
      candidates: (proof.proof.candidates ?? []).map((candidate) => ({ identityId: candidate.identityId,
        holder: candidate.characterId, members: (candidate.members ?? []).map((member) => member.holder) })),
      entryCount: proof.proof.entries?.length ?? 0 } : null;
    record.snapshots.after = snapshot(store);
    const relationCalls = spy.calls.filter((call) => call.caseId === caseData.id && call.kind === "relation");
    if (relationCalls.length > 1) fail(`Case ${caseData.id} 发生多次关系调用。`);
    if (relationCalls.length === 1) {
      try {
        const parsed = relationFromCall(relationCalls[0], record.sourceSnapshots);
        record.relation.actual = parsed.actual; record.relation.raw = parsed.raw;
        record.relation.pairs = parsed.pairs; record.relation.exercised = true;
        record.operation.candidates = parsed.pairCount;
      } catch (error) {
        record.relation.error = safeError(error);
        record.error = { stage: "relation", ...safeError(error) };
        record.flags.noVerification = true; record.reasons.push("relation-response-invalid");
      }
    } else if (caseData.expected.candidates > 0) {
      record.flags.missedRecall = true; record.reasons.push("no-candidate");
    }
    record.relation.model = record.relation.exercised
      ? "exercised" : (caseData.expected.relationModel ?? "not_exercised");
    attachRequests(record, chatFixture, spy);
    const oldEnvelope = chatEnvelopeForTurn({ chatFixture, spy, caseId: record.id,
      turn: "operation", holder: "a", text: caseData.operation.text });
    record.operation.modelOperation = oldEnvelope.status === "ok"
      ? { source: oldEnvelope.source, raw: oldEnvelope.raw, modelOperation: oldEnvelope.modelOperation,
        ...(oldEnvelope.source === "network-envelope" ? { reply: oldEnvelope.reply } : {}) }
      : null;
    record.operation.proofMode = record.operation.proof?.mode ?? null;
    record.operation.target = record.operation.modelOperation?.modelOperation?.target ?? null;
    record.operation.effectiveAction = record.operation.proof?.action ??
      record.operation.modelOperation?.modelOperation?.action ?? null;
    if (!record.operation.modelOperation && record.operation.resultStatus === "completed" &&
      !proof.proof) { record.flags.missedOperation = true; record.reasons.push("operation-not-identified"); }
    if (record.operation.effectiveAction !== caseData.operation.action) {
      record.flags.wrongOperationType = true; record.reasons.push("operation-type-mismatch");
    }
    markFlags(record, caseData);
    const aFinal = assistantState(store, conversationA, "a");
    const bFinal = assistantState(store, conversationB, "b");
    record.effects.singleAssistant.a.final = aFinal;
    record.effects.singleAssistant.b.final = bFinal;
    const a = record.effects.singleAssistant.a;
    if (!a.phase1 || a.phase1.count !== a.before.count + 1 ||
      a.phase1.lastId !== record.operation.assistantMessageId ||
      aFinal.count !== a.phase1.count || aFinal.lastId !== a.phase1.lastId ||
      aFinal.ids.join("\u0000") !== a.phase1.ids.join("\u0000") ||
      /正在核对/u.test(aFinal.lastContent ?? "")) {
      record.flags.wrongAssistant = true; record.reasons.push("a-assistant-not-single-in-place");
    }
    if (JSON.stringify(bFinal.ids) !== JSON.stringify(bBefore.ids) ||
      JSON.stringify(bFinal.contents) !== JSON.stringify(bBefore.contents)) {
      record.flags.wrongAssistant = true; record.reasons.push("b-assistant-messages-changed");
    }
    checkEffects(caseData, record, record.snapshots.before, record.snapshots.after, record.relation.actual, fixedNow);
    checkLeak(caseData, record);
    if (!record.error) {
      record.status = options.dryRun ? "DRY-RUN" : options.mode === "l2" ? "REVIEW" : "PASS";
    }
    return record;
  } catch (error) {
    record.error = safeError(error); record.status = "ERROR"; record.reasons.push(record.error.message);
    return record;
  } finally {
    try { record.snapshots.after = record.snapshots.after ?? (store ? snapshot(store) : null); } catch { /* 保留错误 */ }
    attachRequests(record, chatFixture, spy);
    if (caseData.followup) {
      checkLeak(caseData, record);
      bindTurnIndexes(record, caseData);
    }
    record.durationsMs.total = Date.now() - started;
    try {
      if (store) { await store.chat.dispose(); store.close(); }
      fs.rmSync(dir, { recursive: true, force: true });
      record.cleanup = { path: dir, closed: store ? 1 : 0,
        removed: fs.existsSync(dir) ? 0 : 1, existsAfter: fs.existsSync(dir) };
    } catch (error) {
      record.cleanup = { path: dir, closed: 0, removed: fs.existsSync(dir) ? 0 : 1,
        existsAfter: fs.existsSync(dir), error: safeError(error) };
      record.error = record.error ?? safeError(error); record.status = "ERROR";
    }
    const businessFailure = record.reasons.length > 0 || Object.values(record.flags).some(Boolean);
    if (record.error) record.status = "ERROR";
    else if (businessFailure) record.status = "FAIL";
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { data, text } = readDataset();
  const fixedNow = Date.parse(data.fixedNow);
  const selected = options.caseId ? data.cases.filter((item) => item.id === options.caseId) : data.cases;
  if (options.caseId && selected.length === 0) fail(`--case 未找到：${options.caseId}`);
  const plan = buildPlan(selected, options.mode);
  const record = baseRecord(options, data, text, plan);
  const started = Date.now();
  let credentials = null, fixtureServer = null, spy = null;
  try {
    if (options.dryRun) {
      fixtureServer = await startRelationFixture();
      credentials = { baseUrl: fixtureServer.baseUrl, modelName: "fixture-relation", apiKey: "fixture" };
      record.model.used = credentials.modelName;
    } else {
      credentials = { ...loadCredentials(), modelName: options.model };
      record.credentialsRead = true; record.network = true;
      record.model.used = credentials.modelName;
      record.calls.models = 1;
      const modelsStarted = Date.now();
      const ids = await listModels(credentials.baseUrl, credentials.apiKey);
      record.durationsMs.models = Date.now() - modelsStarted;
      record.model.presentInModels = ids.includes(options.model);
      if (!record.model.presentInModels) {
        record.error = { stage: "models", code: "MODEL_MISSING", message: `GET /models 未返回 ${options.model}。` };
        record.status = "ERROR"; return record;
      }
    }
    spy = installFetchSpy({ budget: { chat: options.dryRun || options.mode === "l1" ? 0 : plan.live.chat,
      relation: plan.live.relation }, dryRun: options.dryRun });
    record.guards = spy.guards;
    for (const item of selected) {
      if (fixtureServer) fixtureServer.state.relation = item.followup?.expected?.relation ?? item.expected.relation;
      record.cases.push(await runCase(item, options, credentials, spy, fixedNow));
    }
    for (const call of spy.calls.filter((item) => !item.fixture)) {
      if (call.request?.model !== undefined && call.request.model !== options.model) {
        record.model.requestModelMismatch = true;
      }
    }
    if (record.model.requestModelMismatch) {
      record.error = { stage: "model", code: "REQUEST_MODEL_MISMATCH", message: "请求 model 与预检 id 不一致。" };
      record.status = "ERROR";
    }
    record.metrics = aggregate(record.cases);
    record.calls.fixtureChat = record.cases.reduce((sum, item) => sum + item.calls.fixtureChat, 0);
    record.calls.networkChat = record.cases.reduce((sum, item) => sum + item.calls.networkChat, 0);
    record.calls.relation = record.cases.reduce((sum, item) => sum + item.calls.relation, 0);
    record.calls.totalHttp = record.calls.models + record.calls.networkChat + record.calls.relation;
  } catch (error) {
    record.error = safeError(error); record.status = "ERROR";
  } finally {
    if (spy) { spy.restore(); record.guards = spy.guards; }
    let serverClosed = true;
    if (fixtureServer) {
      try { await fixtureServer.close(); } catch (error) {
        serverClosed = false; record.error = record.error ?? safeError(error); record.status = "ERROR";
      }
    }
    record.cleanup = { stores: record.cases.length,
      closed: record.cases.filter((item) => item.cleanup?.closed === 1).length,
      dirs: record.cases.length, removed: record.cases.filter((item) => item.cleanup?.removed === 1).length,
      paths: record.cases.map((item) => item.cleanup?.path ?? null),
      existsAfter: record.cases.map((item) => item.cleanup?.existsAfter ?? null),
      fixtureServerClosed: serverClosed };
    record.cleanup.ok = record.cleanup.closed === record.cleanup.stores &&
      record.cleanup.removed === record.cleanup.dirs && serverClosed;
    if (!record.cleanup.ok) {
      record.error = record.error ?? { code: "CLEANUP_FAILED", message: "临时库或 fixture server 未完整清理。" };
    }
    if (record.error) record.status = "ERROR";
    record.durationsMs.total = Date.now() - started;
    if (!record.metrics) record.metrics = aggregate(record.cases);
    if (record.status === "PENDING") {
      const statuses = record.cases.map((item) => item.status);
      record.status = ["ERROR", "FAIL", "INCONCLUSIVE", "NOT_COVERED", "REVIEW"]
        .find((status) => statuses.includes(status)) ?? (options.dryRun ? "DRY-RUN" : "PASS");
    }
    writeResult(options.out, record);
  }
  return record;
}

if (require.main === module) {
  main().then((record) => {
    console.log(JSON.stringify({ status: record.status, mode: record.mode, dryRun: record.dryRun,
      boundary: record.boundary, models: record.model, plan: record.plan, calls: record.calls,
      metrics: record.metrics, cleanup: record.cleanup, output: record.output }, null, 2));
    process.exitCode = ["PASS", "REVIEW", "DRY-RUN"].includes(record.status) ? 0 : 1;
  }).catch((error) => { console.error(`ERROR: ${redact(error?.message ?? error)}`); process.exitCode = 1; });
}

module.exports = { installFetchSpy, isLoopbackUrl, endOfLocalDay };
