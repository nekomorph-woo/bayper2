#!/usr/bin/env node
/* S03l 真实来源关系对照：用正式 createStore / chat / memorySourceContext / 关系协议，
   让聊天提炼产生真实记忆条目与来源快照，再交给正式协议做一次关系判定。
   聊天提炼使用本地 fetch fixture 返回固定合规候选，明确标为构造，不访问网络。
   关系判定 live 才读取根 .env 并请求 deepseek-flash。--dry-run 只构造并输出待审消息，
   不读凭据、不联网。Expected 只用于事后评分，不进入模型输入。
   每对使用独立临时 SQLite：正式记忆服务会按正文复用同角色 preference 的身份，
   同一库里 04/05/06 的“她喜欢蓝色”会共用一个条目并把来源串到第一段会话。
   结果不调用 associateFacts，不更新产品记忆；所有临时库在 finally 关闭并删除。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl, requestChatCompletion } = require("../../app/model.cjs");
const {
  SOURCE_POLICY_VERSION, buildRelationMessages, parseRelationResponse,
} = require("../../app/memory-relation-protocol.cjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
const DATASET_PATH = path.join(__dirname, "source-pairs.json");
const FIXED_NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const FIXTURE_BASE_URL = "http://127.0.0.1:9/v1";
const MODEL_NAME = "deepseek-flash";
const CHAT_MAX_TOKENS = 6000, CHAT_TEMPERATURE = 0;
const CHAT_TIMEOUT_MS = 60000, MODELS_TIMEOUT_MS = 20000;
const RELATIONS = Object.freeze(["equivalent", "different", "uncertain"]);
const KINDS = Object.freeze(["identity", "preference", "experience", "detail"]);
const HOLDERS = Object.freeze(["a", "b"]);
const PAIR_IDS = Object.freeze(Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")));
const SIDE_KEYS = Object.freeze(["utterance", "excerpt", "kind", "factKey", "prelude"]);
const PAIR_KEYS = Object.freeze(["id", "left", "right", "expected", "reason"]);

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateSide(side, label) {
  if (!hasExactKeys(side, SIDE_KEYS)) throw new Error(`${label} 字段不符。`);
  for (const field of ["utterance", "excerpt", "kind", "factKey"]) {
    if (typeof side[field] !== "string" || !side[field].trim()) throw new Error(`${label}.${field} 不能为空。`);
  }
  if (!side.utterance.includes(side.excerpt)) throw new Error(`${label}.excerpt 不在原话中。`);
  if (!KINDS.includes(side.kind)) throw new Error(`${label}.kind 无效。`);
  if (!Array.isArray(side.prelude) || side.prelude.length > 1 ||
    side.prelude.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error(`${label}.prelude 必须是 0～1 条非空消息。`);
  }
}

function readDataset() {
  const text = fs.readFileSync(DATASET_PATH, "utf8");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data) ||
    typeof data.version !== "string" || !data.version.trim() || !Array.isArray(data.pairs)) {
    throw new Error("source-pairs.json 必须包含 version 与 pairs 数组。");
  }
  if (data.pairs.length !== PAIR_IDS.length) throw new Error(`必须包含 ${PAIR_IDS.length} 对事实。`);
  const ids = new Set();
  const factKeys = new Set();
  for (const pair of data.pairs) {
    if (!hasExactKeys(pair, PAIR_KEYS)) throw new Error("pair 字段不符。");
    if (!PAIR_IDS.includes(pair.id) || ids.has(pair.id)) throw new Error(`pair id 无效或重复：${pair.id}`);
    if (!RELATIONS.includes(pair.expected)) throw new Error(`pair ${pair.id} 的 expected 无效。`);
    if (typeof pair.reason !== "string" || !pair.reason.trim()) throw new Error(`pair ${pair.id} 缺少原因。`);
    ids.add(pair.id);
    validateSide(pair.left, `pair ${pair.id}.left`);
    validateSide(pair.right, `pair ${pair.id}.right`);
    for (const side of [pair.left, pair.right]) {
      if (factKeys.has(side.factKey)) throw new Error(`factKey 重复：${side.factKey}`);
      factKeys.add(side.factKey);
    }
  }
  return { data, text };
}

function parseArgs(argv) {
  const options = { dryRun: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run" && !options.dryRun) {
      options.dryRun = true;
    } else if (argv[index] === "--out" && !options.out) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--out 需要一个文件路径。");
      options.out = path.resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`参数无效或重复：${argv[index]}`);
    }
  }
  return options;
}

/* 只插入两个持有者的关系与数值；记忆、聊天和来源全部走正式服务。 */
function createProbeStore(dir, fixture) {
  const store = createStore(dir, {
    now: () => FIXED_NOW,
    chat: {
      timeoutMs: 1000,
      fetchImpl: fixture.fetch,
      getCredentials: () => ({ baseUrl: FIXTURE_BASE_URL, modelName: "fixture-extract", apiKey: "fixture" }),
    },
  });
  const insertRelationship = store.db.prepare(
    "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
  );
  const insertStats = store.db.prepare(
    "INSERT INTO character_stats (character_id, intimacy, energy, mood) VALUES (?, ?, ?, ?)",
  );
  for (const characterId of HOLDERS) {
    insertRelationship.run(characterId, new Date(FIXED_NOW).toISOString());
    insertStats.run(characterId, 10, 100, 0);
  }
  return store;
}
function createChatFixture() {
  const fixture = { pending: [], calls: 0 };
  fixture.envelope = (candidate) => ({
    reply: "我记下了。",
    memoryCandidates: candidate ? [candidate] : [],
    memoryOperation: null,
    memoryRelay: null,
  });
  fixture.fetch = async (url, init) => {
    fixture.calls += 1;
    const envelope = fixture.pending.shift();
    if (!envelope) throw new Error("聊天 fixture 响应队列为空。");
    const request = JSON.parse(init.body);
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error("聊天 fixture 收到无效请求。");
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(envelope) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return fixture;
}

async function buildSide({ store, fixture, pair, sideName, holder }) {
  const side = pair[sideName];
  const conversation = store.chat.openConversation({ characterId: holder }).conversation;
  const send = async (text) => store.chat.sendMessage({
    characterId: holder, conversationId: conversation.id, text, requestId: crypto.randomUUID(),
  });
  for (const prior of side.prelude) {
    fixture.pending.push(fixture.envelope(null));
    if ((await send(prior)).status !== "completed") throw new Error(`${pair.id}.${sideName} 前文发送失败。`);
  }
  fixture.pending.push(fixture.envelope({
    factKey: side.factKey, body: side.excerpt, kind: side.kind, trust: "stated", evidence: side.excerpt,
  }));
  const result = await send(side.utterance);
  if (result.status !== "completed" || result.memoryApplied !== 1) {
    throw new Error(`${pair.id}.${sideName} 未能通过正式聊天写入记忆。`);
  }
  const entry = store.memory.listMemories(holder).find((item) => item.factKey === side.factKey);
  if (!entry) throw new Error(`${pair.id}.${sideName} 找不到写入的记忆条目。`);
  const snapshot = store.memorySourceContext.resolve({
    characterId: holder, entryId: entry.id, expectedVersion: entry.version,
  });
  if (snapshot.status !== "ok") throw new Error(`${pair.id}.${sideName} 来源不可用：${snapshot.reason}`);
  if (snapshot.excerpt !== side.excerpt || snapshot.sourceMessage.content !== side.utterance) {
    throw new Error(`${pair.id}.${sideName} 来源与原话不一致。`);
  }
  if (snapshot.messages.map((message) => message.content).join("\u0000") !== side.prelude.join("\u0000")) {
    throw new Error(`${pair.id}.${sideName} 来源前文与构造前文不一致。`);
  }
  return { store, pairId: pair.id, side: sideName, holder, snapshot };
}

async function buildSources(fixture, data, stores, dirs) {
  const sources = [];
  for (const pair of data.pairs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-source-probe-"));
    dirs.push(dir);
    const store = createProbeStore(dir, fixture);
    stores.push(store);
    sources.push(await buildSide({ store, fixture, pair, sideName: "left", holder: "a" }));
    sources.push(await buildSide({ store, fixture, pair, sideName: "right", holder: "b" }));
  }
  return sources;
}

function sourceSummary(source) {
  const snapshot = source.snapshot;
  return {
    pair: source.pairId, side: source.side, holder: source.holder,
    excerpt: snapshot.excerpt, utterance: snapshot.sourceMessage.content,
    sourceCreatedAt: new Date(snapshot.sourceCreatedAt).toISOString(),
    contextIncomplete: snapshot.contextIncomplete,
    context: snapshot.messages.map((message) => message.content),
  };
}

function protocolSide(side, source) {
  return {
    text: side.excerpt, kind: side.kind, sourceKind: "user", trust: "stated",
    holder: source.holder, participants: null, sourceContext: source.snapshot,
  };
}

/* 模型输入只取 id/left/right；Expected 与原因留在本地评分数据上。 */
function buildPairs(data, sources) {
  const byKey = new Map(sources.map((source) => [`${source.pairId}.${source.side}`, source]));
  return data.pairs.map((pair) => ({
    id: pair.id,
    expected: pair.expected,
    reason: pair.reason,
    left: protocolSide(pair.left, byKey.get(`${pair.id}.left`)),
    right: protocolSide(pair.right, byKey.get(`${pair.id}.right`)),
  }));
}

function checkCurrent(sources) {
  const items = sources.map((source) => ({
    pair: source.pairId,
    side: source.side,
    isCurrent: source.store.memorySourceContext.isCurrent(source.snapshot),
  }));
  return { all: items.every((item) => item.isCurrent), items };
}

function buildItems(pairs, results, failed = false) {
  const byId = new Map((results ?? []).map((result) => [result.pair, result]));
  return pairs.map((pair) => {
    const result = failed ? null : byId.get(pair.id);
    const actual = result?.effectiveRelation ?? null;
    return {
      id: pair.id, expected: pair.expected, reason: pair.reason, actual,
      rawRelation: result?.relation ?? null, effectiveRelation: actual,
      reasons: result?.reasons ?? [],
      verdict: failed || actual === null ? "ERROR" : pair.expected === actual ? "PASS" : "FAIL",
    };
  });
}

function summarize(items) {
  const summary = { total: items.length, pass: 0, fail: 0, error: 0, falseMerge: 0, missedEquivalent: 0, uncertain: 0 };
  for (const item of items) {
    summary[item.verdict.toLowerCase()] += 1;
    if (item.verdict === "ERROR") continue;
    // falseMerge：Expected 非 equivalent 却判为 equivalent；missedEquivalent 反之。
    if (item.expected !== "equivalent" && item.actual === "equivalent") summary.falseMerge += 1;
    if (item.expected === "equivalent" && item.actual !== "equivalent") summary.missedEquivalent += 1;
    if (item.actual === "uncertain") summary.uncertain += 1;
  }
  return summary;
}

function semanticStatus(items) {
  if (items.some((item) => item.verdict === "ERROR")) return "ERROR";
  if (items.some((item) => item.verdict === "FAIL")) return "FAIL";
  return "PASS";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shaOfFile(filePath) {
  return { path: path.relative(REPO_ROOT, filePath), sha256: sha256(fs.readFileSync(filePath)) };
}

function redact(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "<redacted>")
    .replace(/Bearer\s+\S+/gu, "Bearer <redacted>");
}

function safeError(error) {
  return { code: error?.code ?? "ERROR", message: redact(error?.message ?? error).slice(0, 300) };
}

function countEntries(stores) {
  return stores.reduce((sum, store) => sum +
    store.db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count, 0);
}

function baseRecord(options, data, text) {
  return {
    generatedAt: new Date().toISOString(),
    mode: options.dryRun ? "dry-run" : "live",
    policyVersion: SOURCE_POLICY_VERSION,
    fixedNow: new Date(FIXED_NOW).toISOString(),
    model: { name: MODEL_NAME, presentInModels: null },
    input: {
      dataset: path.relative(REPO_ROOT, DATASET_PATH), version: data.version,
      pairCount: data.pairs.length, sha256: sha256(text),
    },
    modules: {
      tool: shaOfFile(__filename),
      dataset: shaOfFile(DATASET_PATH),
      production: ["app/store.cjs", "app/chat.cjs", "app/memory.cjs",
        "app/memory-store.cjs", "app/memory-fact-identity.cjs",
        "app/memory-source-context.cjs", "app/memory-relation-protocol.cjs", "app/model.cjs"]
        .map((relative) => shaOfFile(path.join(REPO_ROOT, relative))),
    },
    network: false, credentialsRead: false,
    calls: { models: 0, chat: 0, total: 0 },
    durationsMs: { constructionMs: null, modelsMs: null, chatMs: null, totalMs: null },
    construction: null, sourceCurrent: { before: null, after: null },
    request: { maxTokens: CHAT_MAX_TOKENS, temperature: CHAT_TEMPERATURE, timeoutMs: CHAT_TIMEOUT_MS },
    messages: null, response: null, items: null, summary: null,
    memoryEntries: { beforeRelation: null, afterRelation: null },
    error: null, cleanup: null, status: "PENDING",
  };
}

function loadCredentials() {
  let values;
  try {
    values = parseEnv(fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8"));
  } catch {
    throw new Error("无法读取根 .env；live 需要 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。");
  }
  const baseUrl = values.OPEN_AI_BASE_URL?.trim(), apiKey = values.OPEN_AI_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY。");
  return { baseUrl: parseBaseUrl(baseUrl), apiKey };
}

async function listModels(baseUrl, apiKey, calls) {
  if (calls.models >= 1) throw new Error("models 调用预算已用完。");
  calls.models += 1;
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch {
    throw new Error("GET /models 请求失败或超时。");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("GET /models 返回重定向，已停止。");
  if (response.status !== 200) throw new Error(`GET /models 返回 HTTP ${response.status}。`);
  const data = await response.json().catch(() => null);
  if (!data) throw new Error("GET /models 未返回有效 JSON。");
  return Array.isArray(data.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === "string") : [];
}

async function runLive(record, pairs, context) {
  const calls = record.calls;
  let stage = "config";
  try {
    const credentials = loadCredentials();
    record.credentialsRead = true;
    record.network = true;
    stage = "models";
    const modelsStarted = Date.now();
    const modelIds = await listModels(credentials.baseUrl, credentials.apiKey, calls);
    record.durationsMs.modelsMs = Date.now() - modelsStarted;
    record.model.presentInModels = modelIds.includes(MODEL_NAME);
    if (!record.model.presentInModels) {
      record.error = { stage, code: "MODEL_MISSING", message: `GET /models 未返回 ${MODEL_NAME}。` };
      return;
    }
    stage = "source";
    if (!checkCurrent(context.sources).all) {
      record.error = { stage, code: "SOURCE_STALE", message: "请求前来源快照已失效。" };
      return;
    }
    stage = "chat";
    if (calls.chat >= 1) throw new Error("chat 调用预算已用完。");
    calls.chat += 1;
    const chatStarted = Date.now();
    let content;
    try {
      ({ content } = await requestChatCompletion({
        baseUrl: credentials.baseUrl,
        modelName: MODEL_NAME,
        apiKey: credentials.apiKey,
        messages: record.messages,
        maxTokens: CHAT_MAX_TOKENS,
        temperature: CHAT_TEMPERATURE,
        timeoutMs: CHAT_TIMEOUT_MS,
      }));
    } finally {
      record.durationsMs.chatMs = Date.now() - chatStarted;
    }
    stage = "structure";
    let parseOk = false;
    try {
      JSON.parse(content.trim());
      parseOk = true;
    } catch {
      parseOk = false;
    }
    try {
      const parsed = parseRelationResponse(content, pairs);
      record.response = { parseOk, raw: redact(content), validation: { ok: true, errors: [] }, structured: parsed.results };
      record.items = buildItems(pairs, parsed.results);
    } catch (error) {
      record.response = { parseOk, raw: redact(content), validation: { ok: false, errors: [safeError(error).message] }, structured: [] };
      record.error = { stage, ...safeError(error) };
      record.items = buildItems(pairs, null, true);
    }
  } catch (error) {
    record.error = { stage, ...safeError(error) };
    record.items = buildItems(pairs, null, true);
  } finally {
    calls.total = calls.models + calls.chat;
    record.memoryEntries.afterRelation = countEntries(context.stores);
    if (!record.items) record.items = buildItems(pairs, null, true);
    record.summary = summarize(record.items);
    if (!record.error && record.memoryEntries.afterRelation !== record.memoryEntries.beforeRelation) {
      record.error = { stage: "memory", code: "MEMORY_CHANGED", message: "关系判定改变了记忆条目数。" };
    }
    record.status = record.error ? "ERROR" : semanticStatus(record.items);
  }
}

async function cleanup(stores, dirs) {
  let closed = 0;
  let removed = 0;
  let error = null;
  for (const store of stores) {
    try {
      await store.chat.dispose();
      store.close();
      closed += 1;
    } catch (failure) {
      error = error ?? safeError(failure);
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) removed += 1;
    } catch (failure) {
      error = error ?? safeError(failure);
    }
  }
  return {
    stores: stores.length, closed, dirs: dirs.length, removed, error,
    ok: closed === stores.length && removed === dirs.length && error === null,
  };
}

function writeResult(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`拒绝覆盖已有结果：${filePath}`);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun && !options.out) throw new Error("live 模式必须显式提供 --out。");
  if (options.out && fs.existsSync(options.out)) throw new Error(`拒绝覆盖已有结果：${options.out}`);
  const { data, text } = readDataset();
  const record = baseRecord(options, data, text);
  const stores = [];
  const dirs = [];
  let sources = null;
  const started = Date.now();
  try {
    const fixture = createChatFixture();
    sources = await buildSources(fixture, data, stores, dirs);
    record.construction = {
      characters: [...HOLDERS],
      isolation: { tempStores: stores.length, reason: "每对独立临时 SQLite，避免同正文 preference 复用身份导致来源串用" },
      chatFixture: { kind: "构造 fetch fixture（不联网）", calls: fixture.calls },
      sources: sources.map(sourceSummary),
    };
    record.durationsMs.constructionMs = Date.now() - started;
    record.memoryEntries.beforeRelation = countEntries(stores);
    record.sourceCurrent.before = checkCurrent(sources);
    if (!record.sourceCurrent.before.all) throw new Error("构建后来源快照 isCurrent 不为 true。");
    const pairs = buildPairs(data, sources);
    record.messages = buildRelationMessages(pairs);
    const serialized = JSON.stringify(record.messages);
    if (serialized.includes('"expected"') || serialized.includes('"reason"')) {
      throw new Error("Expected 或原因进入了模型消息。");
    }
    if (options.dryRun) {
      record.memoryEntries.afterRelation = record.memoryEntries.beforeRelation;
      record.status = "DRY-RUN";
    } else {
      await runLive(record, pairs, { stores, sources });
    }
  } catch (error) {
    record.error = { stage: "construct", ...safeError(error) };
    record.status = "ERROR";
  } finally {
    try {
      if (sources) {
        record.sourceCurrent.after = checkCurrent(sources);
        if (!record.sourceCurrent.after.all && record.status !== "ERROR") {
          record.error = { stage: "source", code: "SOURCE_STALE", message: "请求后来源快照已失效。" };
          record.status = "ERROR";
        }
      }
    } catch (error) {
      record.error = { stage: "source", ...safeError(error) };
      record.status = "ERROR";
    } finally {
      record.cleanup = await cleanup(stores, dirs);
      if (!record.cleanup.ok && record.status !== "ERROR") {
        record.error = { stage: "cleanup", code: "CLEANUP_FAILED", message: "临时数据库未完整清理。" };
        record.status = "ERROR";
      }
      record.durationsMs.totalMs = Date.now() - started;
    }
  }
  if (options.out) {
    writeResult(options.out, record);
    console.log(JSON.stringify({ status: record.status, summary: record.summary, output: options.out }, null, 2));
  } else {
    console.log(JSON.stringify(record, null, 2));
  }
  return record.status === "PASS" || record.status === "DRY-RUN" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`ERROR: ${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  });
