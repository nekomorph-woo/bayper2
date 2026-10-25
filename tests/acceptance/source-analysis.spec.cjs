/* S04c 正式验收：真实 SQLite、权限、读取器、预算、记忆与本地 HTTP 模型适配。
   只有模型响应与 isEligible 使用可控 fixture；不访问远程模型或真实私人会话。
   覆盖 POL-ANALYSIS-001～005，不覆盖设置页、机会调度、名单规则或真实提炼质量。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");
const { createMemoryService } = require("../../app/memory.cjs");
const { createExternalSources } = require("../../app/external-sources.cjs");
const { createSessionSourceReader } = require("../../app/session-sources.cjs");
const { createAutomaticBudget } = require("../../app/automatic-budget.cjs");
const { createSourceAnalysis } = require("../../app/source-analysis.cjs");

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 26, 12, 0, 0);

function userMessage(uuid, text) {
  return { type: "user", uuid, message: { role: "user", content: text } };
}

function assistantMessage(uuid, text = "好的。") {
  return { type: "assistant", uuid, message: { role: "assistant", content: text } };
}

function writeSession(ctx, name, records) {
  const file = path.join(ctx.sessionsRoot, "project", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function parseData(body) {
  const payload = JSON.parse(body);
  const dataMessage = payload.messages.find((message) => message.role === "user");
  return JSON.parse(dataMessage.content);
}

function firstUserSource(data) {
  return data.sources.find((source) => source.role === "user");
}

function sendContent(res, content, status = 200) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
}

function sendFacts(res, facts) {
  sendContent(res, JSON.stringify({ facts }));
}

function factFor(source, ctx) {
  let evidence;
  let body;
  if (source.text.includes("茉莉花茶")) {
    evidence = "喜欢茉莉花茶";
    body = "用户喜欢茉莉花茶";
  } else if (source.text.includes("团子")) {
    evidence = "养了一只叫团子的猫";
    body = "用户养了一只叫团子的猫";
  } else if (source.text.includes("乌龙茶")) {
    evidence = "喜欢喝乌龙茶";
    body = "用户喜欢喝乌龙茶";
  } else {
    evidence = source.text.slice(0, 8);
    body = "用户提到了来源内容";
  }
  return {
    sourceId: source.sourceId,
    factKey: ctx.nextFact(),
    body,
    kind: "preference",
    evidence,
  };
}

function defaultResponder(res, body, ctx) {
  if (ctx.mode === "http-500") {
    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"forced"}');
    }
    return;
  }
  if (ctx.mode === "invalid-json") {
    sendContent(res, "not-json");
    return;
  }
  if (ctx.mode === "empty") {
    sendFacts(res, []);
    return;
  }
  const data = parseData(body);
  if (ctx.mode === "multi") {
    const users = data.sources.filter((source) => source.role === "user");
    sendFacts(res, users.map((user) => factFor(user, ctx)));
    return;
  }
  if (ctx.mode === "forged") {
    sendFacts(res, [
      {
        sourceId: `external:${"0".repeat(64)}`,
        factKey: "bad.forged",
        body: "伪造事实",
        kind: "preference",
        evidence: "喜欢",
      },
    ]);
    return;
  }
  if (ctx.mode === "assistant-evidence") {
    const assistant = data.sources.find((source) => source.role === "assistant");
    sendFacts(res, [
      {
        sourceId: assistant.sourceId,
        factKey: "bad.assistant",
        body: "助手不是用户证据",
        kind: "preference",
        evidence: "好的",
      },
    ]);
    return;
  }
  if (ctx.mode === "partial-invalid") {
    const user = firstUserSource(data);
    sendFacts(res, [
      factFor(user, ctx),
      {
        sourceId: user.sourceId,
        factKey: "bad.second",
        body: "无效种类",
        kind: "root",
        evidence: "喜欢",
      },
    ]);
    return;
  }
  sendFacts(res, [factFor(firstUserSource(data), ctx)]);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeContext(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-analysis-"));
  const sessionsRoot = path.join(dir, "sessions");
  fs.mkdirSync(sessionsRoot);
  const characters = options.characters ?? ["a", "b", "c", "d", "e", "f"];
  createMemoryDatabase(dir, characters).db.close();

  let clock = options.start ?? START;
  let eligible = true;
  let credentials = null;
  let responder = null;
  let mode = "valid";
  let factSeq = 0;
  let db;
  let memory;
  let permissions;
  let budget;
  let reader;
  let analysis;
  let firstOpen = true;
  let grantId = null;
  const requests = [];
  const serviceFetch = options.fetchImpl ?? fetch;

  const ctx = {
    dir,
    sessionsRoot,
    requests,
    get db() {
      return db;
    },
    get memory() {
      return memory;
    },
    get permissions() {
      return permissions;
    },
    get budget() {
      return budget;
    },
    get reader() {
      return reader;
    },
    get analysis() {
      return analysis;
    },
    get grantId() {
      return grantId;
    },
    set grantId(value) {
      grantId = value;
    },
    get mode() {
      return mode;
    },
    setMode(value) {
      mode = value;
    },
    setNow(value) {
      clock = value;
    },
    setEligible(value) {
      eligible = value;
    },
    get credentials() {
      return credentials;
    },
    setCredentials(value) {
      credentials = value;
    },
    setResponder(value) {
      responder = value;
    },
    nextFact() {
      factSeq += 1;
      return `fact.${factSeq}`;
    },
    sentCount() {
      return db
        .prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1")
        .get().count;
    },
    activeCount() {
      return db
        .prepare(
          "SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE status IN ('reserved', 'in_flight')",
        )
        .get().count;
    },
    processedCount(characterId) {
      return db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_analysis_processed WHERE character_id = ?",
        )
        .get(characterId).count;
    },
    restart() {
      db.close();
      openServices();
    },
  };

  function openServices() {
    db = openMemoryDatabase(dir);
    memory = createMemoryService({ db, now: () => clock });
    permissions = createExternalSources({ db });
    budget = createAutomaticBudget({ db, now: () => clock });
    reader = createSessionSourceReader({ permissions });
    analysis = createSourceAnalysis({
      db,
      memory,
      permissions,
      reader,
      budget,
      getCredentials: () => credentials,
      isEligible: () => eligible,
      fetchImpl: serviceFetch,
      now: () => clock,
    });
    if (firstOpen) {
      permissions.setEnabled(true);
      const grant = permissions.grantDirectory("claude-code", sessionsRoot);
      grantId = grant.id;
      firstOpen = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      const handler = responder ?? defaultResponder;
      await handler(res, body, ctx);
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"fixture"}');
        } catch {
          // 客户端取消后 socket 可能已关闭。
        }
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  credentials = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    modelName: "fixture-model",
    apiKey: "fixture-key",
  };
  openServices();

  t.after(() => {
    try {
      db.close();
    } catch {
      // 测试已关闭时仍清理目录。
    }
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function analysisInput(ctx, requestId, characterId, relativePath, directoryId = ctx.grantId) {
  return { requestId, characterId, directoryId, relativePath };
}

test("POL-ANALYSIS-001 获准来源产生 inferred 记忆且重启不重复请求", async (t) => {
  const ctx = await makeContext(t);
  const file = writeSession(ctx, "s1.jsonl", [
    userMessage("u1", "我喜欢茉莉花茶，周末常去茶馆。"),
    assistantMessage("a1"),
    userMessage("u1b", "我也喜欢喝乌龙茶。"),
    assistantMessage("a1b"),
  ]);
  writeSession(ctx, "other.jsonl", [
    userMessage("u2", "B-PRIVATE-CONTENT"),
    assistantMessage("a2"),
  ]);
  const before = fs.readFileSync(file);
  ctx.setMode("multi");

  const result = await ctx.analysis.analyze(
    analysisInput(ctx, "req-1", "a", "project/s1.jsonl"),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.created, 2);

  const memories = ctx.memory.listMemories("a");
  assert.equal(memories.length, 2);
  assert.deepEqual(
    new Set(memories.map((memory) => memory.body)),
    new Set(["用户喜欢茉莉花茶", "用户喜欢喝乌龙茶"]),
  );
  assert.ok(memories.every((memory) => memory.trust === "inferred"));
  assert.ok(
    memories.every((memory) => /^external:[0-9a-f]{64}$/.test(memory.sourceId)),
  );
  assert.equal(ctx.memory.listMemories("b").length, 0);
  assert.equal(ctx.sentCount(), 1);
  assert.equal(ctx.requests.length, 1);

  const requestBody = JSON.parse(ctx.requests[0]);
  const data = parseData(ctx.requests[0]);
  const sentUsers = data.sources.filter((source) => source.role === "user");
  assert.equal(sentUsers.length, 2);
  assert.deepEqual(
    new Set(memories.map((memory) => memory.sourceId)),
    new Set(sentUsers.map((source) => source.sourceId)),
  );
  assert.equal(JSON.stringify(requestBody).includes("B-PRIVATE-CONTENT"), false);
  assert.equal(JSON.stringify(requestBody).includes(ctx.sessionsRoot), false);
  assert.equal(fs.readFileSync(file).equals(before), true);
  const dbRow = ctx.db
    .prepare(
      "SELECT COUNT(*) AS count FROM memory_entries WHERE character_id = 'a' AND trust = 'inferred'",
    )
    .get();
  assert.equal(dbRow.count, 2);

  ctx.restart();
  const again = await ctx.analysis.analyze(
    analysisInput(ctx, "req-2", "a", "project/s1.jsonl"),
  );
  assert.equal(again.status, "skipped");
  assert.equal(again.code, "NO_NEW_TEXT");
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.sentCount(), 1);
  assert.equal(fs.readFileSync(file).equals(before), true);

  // 重复 requestId 不产生第二次发送。
  fs.appendFileSync(
    file,
    `${JSON.stringify(userMessage("u3", "补充消息，不应发送。"))}\n`,
  );
  const duplicate = await ctx.analysis.analyze(
    analysisInput(ctx, "req-1", "a", "project/s1.jsonl"),
  );
  assert.equal(duplicate.status, "skipped");
  assert.equal(duplicate.code, "DUPLICATE_REQUEST");
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.sentCount(), 1);
  assert.equal(ctx.memory.listMemories("a").length, 2);

  // 合法空 facts 仍标记来源已处理，不产生记忆。
  ctx.setNow(START + 2 * HOUR);
  writeSession(ctx, "empty.jsonl", [
    userMessage("u-empty", "我只想安静一下。"),
    assistantMessage("a-empty"),
  ]);
  ctx.setMode("empty");
  const empty = await ctx.analysis.analyze(
    analysisInput(ctx, "empty-1", "a", "project/empty.jsonl"),
  );
  assert.equal(empty.status, "completed");
  assert.equal(empty.created, 0);
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.memory.listMemories("a").length, 2);
  const emptyAgain = await ctx.analysis.analyze(
    analysisInput(ctx, "empty-2", "a", "project/empty.jsonl"),
  );
  assert.equal(emptyAgain.status, "skipped");
  assert.equal(emptyAgain.code, "NO_NEW_TEXT");
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.sentCount(), 2);

  ctx.analysis.dispose();
  const disposed = await ctx.analysis.analyze(
    analysisInput(ctx, "after-dispose", "a", "project/empty.jsonl"),
  );
  assert.equal(disposed.status, "skipped");
  assert.equal(disposed.code, "DISPOSED");
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.sentCount(), 2);
});

test("POL-ANALYSIS-002 未授权/关闭/不合资格/空文本/预算满均不发送", async (t) => {
  const ctx = await makeContext(t);
  writeSession(ctx, "s1.jsonl", [
    userMessage("u1", "我喜欢茉莉花茶。"),
    assistantMessage("a1"),
  ]);
  writeSession(ctx, "s3.jsonl", [assistantMessage("a3")]);
  writeSession(ctx, "s4.jsonl", [
    userMessage("u4", "我喜欢茉莉花茶，预算场景。"),
    assistantMessage("a4"),
  ]);

  ctx.setEligible(false);
  let result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-1", "a", "project/s1.jsonl"),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "NOT_ELIGIBLE");
  ctx.setEligible(true);

  result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-2", "a", "project/s1.jsonl", "missing-directory"),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "GRANT_NOT_FOUND");

  ctx.permissions.setEnabled(false);
  result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-3", "a", "project/s1.jsonl"),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "ANALYSIS_DISABLED");
  ctx.permissions.setEnabled(true);

  result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-4", "b", "project/s3.jsonl"),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "NO_USER_TEXT");

  const savedCredentials = ctx.credentials;
  ctx.setCredentials(null);
  result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-5", "a", "project/s1.jsonl"),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "CREDENTIALS_UNAVAILABLE");
  assert.equal(ctx.sentCount(), 0);
  assert.equal(ctx.activeCount(), 0);
  ctx.setCredentials(savedCredentials);

  const manual = ctx.budget.reserve({ requestId: "manual-send", characterId: "b" });
  assert.equal(manual.reserved, true);
  assert.equal(ctx.budget.beginAttempt(manual.token).canSend, true);
  ctx.budget.finish(manual.token, "success");
  assert.equal(ctx.sentCount(), 1);

  result = await ctx.analysis.analyze(
    analysisInput(ctx, "skip-6", "a", "project/s4.jsonl"),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "HOURLY_LIMIT");

  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.memory.listMemories("a").length, 0);
  assert.equal(ctx.memory.listMemories("b").length, 0);
  assert.equal(ctx.processedCount("a"), 0);
  assert.equal(ctx.activeCount(), 0);
});

test("POL-ANALYSIS-003 在途撤销/资格/纠正/取消均不发布旧结果", async (t) => {
  let ignoreAbort = false;
  const ctx = await makeContext(t, {
    // 仅取消场景忽略 AbortSignal，用来证明迟到响应仍不会发布。
    fetchImpl: (url, options) =>
      fetch(url, ignoreAbort ? { ...options, signal: undefined } : options),
  });
  const files = {
    a: writeSession(ctx, "s-a.jsonl", [
      userMessage("ua", "我喜欢茉莉花茶，取消场景。"),
      assistantMessage("aa"),
    ]),
    b: writeSession(ctx, "s-b.jsonl", [
      userMessage("ub", "我喜欢茉莉花茶，资格场景。"),
      assistantMessage("ab"),
    ]),
    c: writeSession(ctx, "s-c.jsonl", [
      userMessage("uc", "我喜欢茉莉花茶，纠正场景。"),
      assistantMessage("ac"),
    ]),
    d: writeSession(ctx, "s-d.jsonl", [
      userMessage("ud", "我喜欢茉莉花茶，撤销场景。"),
      assistantMessage("ad"),
    ]),
  };

  ctx.memory.remember({
    characterId: "c",
    factKey: "legal.seed",
    body: "旧的合法记忆",
    kind: "preference",
    sourceId: "chat-seed-1",
  });

  let release = null;
  ctx.setResponder(async (res, body) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    sendFacts(res, [factFor(firstUserSource(parseData(body)), ctx)]);
  });

  const baseline = ctx.requests.length;

  ignoreAbort = true;
  const pendingCancel = ctx.analysis.analyze(
    analysisInput(ctx, "st-1", "a", "project/s-a.jsonl"),
  );
  await waitFor(() => ctx.requests.length === baseline + 1);
  assert.equal(ctx.analysis.cancel(), true);
  release();
  const cancelled = await pendingCancel;
  ignoreAbort = false;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(ctx.memory.listMemories("a").length, 0);
  assert.equal(ctx.processedCount("a"), 0);

  ctx.setNow(START + HOUR);
  const pendingEligibility = ctx.analysis.analyze(
    analysisInput(ctx, "st-2", "b", "project/s-b.jsonl"),
  );
  await waitFor(() => ctx.requests.length === baseline + 2);
  ctx.setEligible(false);
  release();
  const staleEligibility = await pendingEligibility;
  assert.equal(staleEligibility.status, "stale");
  assert.equal(staleEligibility.code, "NOT_ELIGIBLE");
  ctx.setEligible(true);
  assert.equal(ctx.memory.listMemories("b").length, 0);
  assert.equal(ctx.processedCount("b"), 0);

  ctx.setNow(START + 2 * HOUR);
  const pendingContext = ctx.analysis.analyze(
    analysisInput(ctx, "st-3", "c", "project/s-c.jsonl"),
  );
  await waitFor(() => ctx.requests.length === baseline + 3);
  ctx.memory.correct({
    characterId: "c",
    factKey: "legal.seed",
    body: "纠正后的合法记忆",
    sourceId: "chat-correction-1",
  });
  release();
  const staleContext = await pendingContext;
  assert.equal(staleContext.status, "stale");
  assert.equal(staleContext.code, "STALE_CONTEXT");
  const cMemories = ctx.memory.listMemories("c");
  assert.equal(cMemories.length, 1);
  assert.equal(cMemories[0].body, "纠正后的合法记忆");
  assert.equal(ctx.processedCount("c"), 0);

  ctx.setNow(START + 3 * HOUR);
  const pendingRevoked = ctx.analysis.analyze(
    analysisInput(ctx, "st-4", "d", "project/s-d.jsonl"),
  );
  await waitFor(() => ctx.requests.length === baseline + 4);
  ctx.permissions.revokeDirectory(ctx.grantId);
  release();
  const staleRevoked = await pendingRevoked;
  assert.equal(staleRevoked.status, "stale");
  assert.ok(["PERMIT_INVALID", "PERMIT_REVOKED"].includes(staleRevoked.code));
  assert.equal(ctx.memory.listMemories("d").length, 0);
  assert.equal(ctx.processedCount("d"), 0);

  const afterRevoke = await ctx.analysis.analyze(
    analysisInput(ctx, "st-5", "d", "project/s-d.jsonl"),
  );
  assert.ok(["skipped", "failed"].includes(afterRevoke.status));
  assert.ok(["GRANT_NOT_ACTIVE", "PERMIT_INVALID"].includes(afterRevoke.code));
  assert.equal(ctx.requests.length, baseline + 4);

  assert.equal(ctx.sentCount(), 4);
  const rows = ctx.db
    .prepare(
      "SELECT request_id, status, sent FROM automatic_budget_attempts WHERE request_id LIKE 'st-%' ORDER BY rowid",
    )
    .all();
  assert.deepEqual(
    rows.map((row) => [row.request_id, row.status, row.sent]),
    [
      ["st-1", "cancelled", 1],
      ["st-2", "success", 1],
      ["st-3", "success", 1],
      ["st-4", "success", 1],
    ],
  );
  assert.equal(ctx.processedCount("a"), 0);
  assert.equal(ctx.processedCount("b"), 0);
  assert.equal(ctx.processedCount("d"), 0);
  assert.equal(fs.readFileSync(files.a).length > 0, true);
});

test("POL-ANALYSIS-004 删除/重授权/重启后旧来源不进入请求", async (t) => {
  const ctx = await makeContext(t, { characters: ["a"] });
  const file = writeSession(ctx, "mixed.jsonl", [
    userMessage("old-1", "我养了一只叫团子的猫，旧来源暗号。"),
    assistantMessage("old-a"),
  ]);

  const first = await ctx.analysis.analyze(
    analysisInput(ctx, "first-1", "a", "project/mixed.jsonl"),
  );
  assert.equal(first.status, "completed");
  assert.equal(first.created, 1);
  const oldEntry = ctx.memory.listMemories("a")[0];
  const oldSourceId = oldEntry.sourceId;
  assert.match(oldSourceId, /^external:[0-9a-f]{64}$/);

  ctx.memory.forget({ characterId: "a", factKey: oldEntry.factKey });
  // 人为删除已处理标识，隔离验证“被删除来源”本身仍能阻止正文进入请求。
  ctx.db
    .prepare("DELETE FROM source_analysis_processed WHERE character_id = 'a' AND source_id = ?")
    .run(oldSourceId);

  fs.appendFileSync(
    file,
    `${JSON.stringify(userMessage("new-1", "我喜欢喝乌龙茶，新来源暗号。"))}\n` +
      `${JSON.stringify(assistantMessage("new-a"))}\n`,
  );
  const afterAppend = fs.readFileSync(file);

  ctx.permissions.revokeDirectory(ctx.grantId);
  const regranted = ctx.permissions.grantDirectory("claude-code", ctx.sessionsRoot);
  ctx.grantId = regranted.id;
  ctx.setNow(START + 2 * HOUR);
  ctx.restart();

  const second = await ctx.analysis.analyze(
    analysisInput(ctx, "second-1", "a", "project/mixed.jsonl"),
  );
  assert.equal(second.status, "completed");
  assert.equal(second.created, 1);
  assert.equal(ctx.requests.length, 2);
  const secondBody = ctx.requests[1];
  assert.equal(secondBody.includes("团子"), false);
  assert.equal(secondBody.includes("旧来源暗号"), false);
  assert.equal(secondBody.includes("乌龙茶"), true);

  const memories = ctx.memory.listMemories("a");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].body, "用户喜欢喝乌龙茶");
  assert.notEqual(memories[0].sourceId, oldSourceId);
  assert.equal(ctx.processedCount("a"), 1);
  assert.equal(fs.readFileSync(file).equals(afterAppend), true);
});

test("POL-ANALYSIS-005 非法/伪造/助手证据/部分无效/HTTP/发布失败均不部分保存", async (t) => {
  const ctx = await makeContext(t, { characters: ["a", "b", "c", "d", "e", "f"] });
  const files = [
    ["a", "e1.jsonl"],
    ["b", "e2.jsonl"],
    ["c", "e3.jsonl"],
    ["d", "e4.jsonl"],
    ["e", "e5.jsonl"],
    ["f", "e6.jsonl"],
  ];
  for (const [character, name] of files) {
    writeSession(ctx, name, [
      userMessage(`u-${character}`, "我喜欢茉莉花茶，失败场景。"),
      assistantMessage(`a-${character}`),
    ]);
  }

  const scenarios = [
    { character: "a", file: "e1.jsonl", mode: "invalid-json", code: "INVALID_MODEL_OUTPUT", time: START },
    { character: "b", file: "e2.jsonl", mode: "forged", code: "INVALID_MODEL_OUTPUT", time: START + HOUR },
    { character: "c", file: "e3.jsonl", mode: "assistant-evidence", code: "INVALID_MODEL_OUTPUT", time: START + 2 * HOUR },
    { character: "d", file: "e4.jsonl", mode: "partial-invalid", code: "INVALID_MODEL_OUTPUT", time: START + 3 * HOUR },
    { character: "e", file: "e5.jsonl", mode: "http-500", code: "SERVER_ERROR", time: START + 8 * HOUR },
    { character: "f", file: "e6.jsonl", mode: "valid", code: "PUBLISH_FAILED", time: START + 9 * HOUR, trigger: true },
  ];

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    ctx.setNow(scenario.time);
    ctx.setMode(scenario.mode);
    if (scenario.trigger) {
      ctx.db.exec(`
        CREATE TRIGGER fail_memory_insert BEFORE INSERT ON memory_entries
        BEGIN SELECT RAISE(ABORT, 'forced failure'); END
      `);
    }
    let result;
    try {
      result = await ctx.analysis.analyze(
        analysisInput(ctx, `e${index + 1}`, scenario.character, `project/${scenario.file}`),
      );
    } finally {
      if (scenario.trigger) {
        ctx.db.exec("DROP TRIGGER fail_memory_insert");
      }
    }
    assert.equal(result.status, "failed", `场景 ${scenario.mode}`);
    assert.equal(result.code, scenario.code, `场景 ${scenario.mode}`);
    assert.equal(ctx.memory.listMemories(scenario.character).length, 0);
    assert.equal(ctx.processedCount(scenario.character), 0);
    assert.equal(ctx.requests.length, index + 1);
  }

  assert.equal(ctx.sentCount(), 6);
  const rows = ctx.db
    .prepare(
      "SELECT request_id, status, sent FROM automatic_budget_attempts WHERE request_id IN ('e1','e2','e3','e4','e5','e6') ORDER BY rowid",
    )
    .all();
  assert.deepEqual(
    rows.map((row) => [row.request_id, row.status, row.sent]),
    [
      ["e1", "success", 1],
      ["e2", "success", 1],
      ["e3", "success", 1],
      ["e4", "success", 1],
      ["e5", "failed", 1],
      ["e6", "success", 1],
    ],
  );
  assert.equal(ctx.activeCount(), 0);
  assert.equal(ctx.requests.length, 6);
});

test("POL-ANALYSIS-006 无显式ID来源被删除后 offset 变化不得重新进入HTTP", async (t) => {
  const ctx = await makeContext(t, { characters: ["a"] });
  const file = writeSession(ctx, "offset.jsonl", [
    { type: "user", message: { role: "user", content: "旧删除暗号：我喜欢茉莉花茶。" } },
    { type: "assistant", message: { role: "assistant", content: "好的。" } },
  ]);

  const first = await ctx.analysis.analyze(
    analysisInput(ctx, "offset-first", "a", "project/offset.jsonl"),
  );
  assert.equal(first.status, "completed");
  const oldEntry = ctx.memory.listMemories("a")[0];
  ctx.memory.forget({ characterId: "a", factKey: oldEntry.factKey });

  // 旧消息没有显式 ID；前置一行后其字节 offset 改变，sourceId 随之改变。
  const original = fs.readFileSync(file, "utf8");
  const prepended = {
    type: "assistant",
    message: { role: "assistant", content: "前置上下文。" },
  };
  fs.writeFileSync(file, `${JSON.stringify(prepended)}\n${original}`);

  ctx.setNow(START + 2 * HOUR);
  const second = await ctx.analysis.analyze(
    analysisInput(ctx, "offset-second", "a", "project/offset.jsonl"),
  );
  assert.equal(second.status, "skipped");
  assert.equal(second.code, "SOURCE_HISTORY_CHANGED");
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.sentCount(), 1);
  assert.equal(ctx.memory.listMemories("a").length, 0);

  // 只暂停无法核实的这份文件；其他获准文件仍可正常分析。
  writeSession(ctx, "other.jsonl", [
    userMessage("other-1", "我喜欢喝乌龙茶。"),
    assistantMessage("other-a"),
  ]);
  const other = await ctx.analysis.analyze(
    analysisInput(ctx, "offset-other", "a", "project/other.jsonl"),
  );
  assert.equal(other.status, "completed");
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.sentCount(), 2);
  assert.equal(ctx.requests[1].includes("旧删除暗号"), false);
});

test("POL-ANALYSIS-007 budget.finish/cancel SQL故障后结果与下一次占位", async (t) => {
  const finishCtx = await makeContext(t, { characters: ["a", "b"] });
  writeSession(finishCtx, "finish.jsonl", [
    userMessage("finish-user", "我喜欢茉莉花茶，预算收尾场景。"),
    assistantMessage("finish-assistant"),
  ]);
  let releaseFinish;
  finishCtx.setResponder(async (res, body) => {
    await new Promise((resolve) => {
      releaseFinish = resolve;
    });
    sendFacts(res, [factFor(firstUserSource(parseData(body)), finishCtx)]);
  });
  const pendingFinish = finishCtx.analysis.analyze(
    analysisInput(finishCtx, "finish-fail", "a", "project/finish.jsonl"),
  );
  await waitFor(() => finishCtx.requests.length === 1);
  finishCtx.db.exec(`
    CREATE TRIGGER fail_budget_finish BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  releaseFinish();
  const finishResult = await pendingFinish;
  assert.equal(finishResult.status, "completed");
  assert.equal(finishResult.created, 1);
  assert.equal(finishResult.cleanupError.code, "BUDGET_STORAGE_FAILED");
  assert.equal(finishResult.cleanupError.recovered, false);
  assert.equal(finishCtx.memory.listMemories("a").length, 1);
  assert.equal(finishCtx.sentCount(), 1);
  const finishRow = finishCtx.db
    .prepare(
      "SELECT status, sent FROM automatic_budget_attempts WHERE request_id = 'finish-fail'",
    )
    .get();
  assert.equal(finishRow.status, "in_flight");
  assert.equal(finishRow.sent, 1);

  // 解除 SQL 故障后，越过正常 1 小时/角色冷却窗口，下一次占位应恢复并成功。
  finishCtx.db.exec("DROP TRIGGER fail_budget_finish");
  finishCtx.setNow(START + 2 * HOUR);
  const nextFinish = finishCtx.budget.reserve({
    requestId: "after-finish-failure",
    characterId: "b",
  });
  assert.equal(nextFinish.reserved, true);
  const recoveredFinish = finishCtx.db
    .prepare(
      "SELECT status, sent FROM automatic_budget_attempts WHERE request_id = 'finish-fail'",
    )
    .get();
  assert.equal(recoveredFinish.status, "success");
  assert.equal(recoveredFinish.sent, 1);
  assert.equal(finishCtx.requests.length, 1);
  finishCtx.budget.cancel(nextFinish.token);
  assert.equal(finishCtx.activeCount(), 0);

  const cancelCtx = await makeContext(t, { characters: ["c", "d"] });
  writeSession(cancelCtx, "cancel.jsonl", [
    userMessage("cancel-user", "我喜欢茉莉花茶，取消收尾场景。"),
    assistantMessage("cancel-assistant"),
  ]);
  let releaseCancel;
  cancelCtx.setResponder(async (res, body) => {
    await new Promise((resolve) => {
      releaseCancel = resolve;
    });
    sendFacts(res, [factFor(firstUserSource(parseData(body)), cancelCtx)]);
  });
  const pendingCancel = cancelCtx.analysis.analyze(
    analysisInput(cancelCtx, "cancel-fail", "c", "project/cancel.jsonl"),
  );
  await waitFor(() => cancelCtx.requests.length === 1);
  cancelCtx.db.exec(`
    CREATE TRIGGER fail_budget_cancel BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  cancelCtx.analysis.cancel();
  releaseCancel();
  const cancelResult = await pendingCancel;
  assert.equal(cancelResult.status, "cancelled");
  assert.equal(cancelResult.created, 0);
  assert.equal(cancelResult.cleanupError.code, "BUDGET_STORAGE_FAILED");
  assert.equal(cancelResult.cleanupError.recovered, false);
  assert.equal(cancelCtx.memory.listMemories("c").length, 0);
  assert.equal(cancelCtx.processedCount("c"), 0);
  assert.equal(cancelCtx.sentCount(), 1);
  const cancelRow = cancelCtx.db
    .prepare(
      "SELECT status, sent FROM automatic_budget_attempts WHERE request_id = 'cancel-fail'",
    )
    .get();
  assert.equal(cancelRow.status, "in_flight");
  assert.equal(cancelRow.sent, 1);

  cancelCtx.db.exec("DROP TRIGGER fail_budget_cancel");
  cancelCtx.setNow(START + 2 * HOUR);
  const nextCancel = cancelCtx.budget.reserve({
    requestId: "after-cancel-failure",
    characterId: "d",
  });
  assert.equal(nextCancel.reserved, true);
  const recoveredCancel = cancelCtx.db
    .prepare(
      "SELECT status, sent FROM automatic_budget_attempts WHERE request_id = 'cancel-fail'",
    )
    .get();
  assert.equal(recoveredCancel.status, "cancelled");
  assert.equal(recoveredCancel.sent, 1);
  assert.equal(cancelCtx.requests.length, 1);
  cancelCtx.budget.cancel(nextCancel.token);
  assert.equal(cancelCtx.activeCount(), 0);
});

test("POL-ANALYSIS-008 保护区段：正常追加继续，历史区段改写停止", async (t) => {
  const appendCtx = await makeContext(t, { characters: ["a"] });
  const appendFile = writeSession(appendCtx, "append.jsonl", [
    { type: "user", message: { role: "user", content: "旧删除暗号：我喜欢茉莉花茶。" } },
    { type: "assistant", message: { role: "assistant", content: "好的。" } },
  ]);
  const firstAppend = await appendCtx.analysis.analyze(
    analysisInput(appendCtx, "append-first", "a", "project/append.jsonl"),
  );
  assert.equal(firstAppend.status, "completed");
  const oldAppendEntry = appendCtx.memory.listMemories("a")[0];
  const oldAppendSourceId = oldAppendEntry.sourceId;
  appendCtx.memory.forget({ characterId: "a", factKey: oldAppendEntry.factKey });
  // 删除 processed 标记，单独验证纯追加时旧 sourceId 仍能被来源控制命中。
  appendCtx.db
    .prepare("DELETE FROM source_analysis_processed WHERE character_id = 'a' AND source_id = ?")
    .run(oldAppendSourceId);

  fs.appendFileSync(
    appendFile,
    `${JSON.stringify({ type: "user", message: { role: "user", content: "我喜欢喝乌龙茶。" } })}\n` +
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "好的。" } })}\n`,
  );
  appendCtx.setNow(START + 2 * HOUR);
  const appended = await appendCtx.analysis.analyze(
    analysisInput(appendCtx, "append-second", "a", "project/append.jsonl"),
  );
  assert.equal(appended.status, "completed");
  assert.equal(appendCtx.requests.length, 2);
  assert.equal(appendCtx.sentCount(), 2);
  assert.equal(appendCtx.requests[1].includes("旧删除暗号"), false);
  assert.equal(appendCtx.requests[1].includes("乌龙茶"), true);
  assert.deepEqual(
    appendCtx.memory.listMemories("a").map((memory) => memory.body),
    ["用户喜欢喝乌龙茶"],
  );

  const historyCtx = await makeContext(t, { characters: ["b"] });
  const historyFile = writeSession(historyCtx, "history.jsonl", [
    { type: "user", message: { role: "user", content: "旧删除暗号：我喜欢茉莉花茶。" } },
    { type: "assistant", message: { role: "assistant", content: "好的。" } },
  ]);
  const firstHistory = await historyCtx.analysis.analyze(
    analysisInput(historyCtx, "history-first", "b", "project/history.jsonl"),
  );
  assert.equal(firstHistory.status, "completed");
  const oldHistoryEntry = historyCtx.memory.listMemories("b")[0];
  historyCtx.memory.forget({ characterId: "b", factKey: oldHistoryEntry.factKey });

  const filler = [];
  for (let index = 0; index < 700; index += 1) {
    filler.push({
      type: "assistant",
      message: { role: "assistant", content: `填充${index}:${"中".repeat(900)}` },
    });
  }
  filler.push({ type: "user", message: { role: "user", content: "我喜欢喝乌龙茶。" } });
  filler.push({ type: "assistant", message: { role: "assistant", content: "好的。" } });
  fs.appendFileSync(
    historyFile,
    `${filler.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  assert.ok(fs.statSync(historyFile).size > 512 * 1024);

  // 旧消息已不在最新 512KiB tail；修改历史区段仍必须被历史 checkpoint 拦截。
  const historyBytes = fs.readFileSync(historyFile);
  const oldPosition = historyBytes.indexOf(Buffer.from("旧删除暗号"));
  assert.ok(oldPosition >= 0);
  historyBytes[oldPosition] = 0x58;
  fs.writeFileSync(historyFile, historyBytes);

  historyCtx.setNow(START + 2 * HOUR);
  const blocked = await historyCtx.analysis.analyze(
    analysisInput(historyCtx, "history-second", "b", "project/history.jsonl"),
  );
  assert.equal(blocked.status, "skipped");
  assert.equal(blocked.code, "SOURCE_HISTORY_CHANGED");
  assert.equal(historyCtx.requests.length, 1);
  assert.equal(historyCtx.sentCount(), 1);
  assert.equal(historyCtx.memory.listMemories("b").length, 0);
  assert.equal(historyCtx.processedCount("b"), 1);
});

test("POL-ANALYSIS-009 在途区段改写与checkpoint映射发布故障", async (t) => {
  const inflightCtx = await makeContext(t, { characters: ["a"] });
  const inflightFile = writeSession(inflightCtx, "inflight.jsonl", [
    { type: "user", message: { role: "user", content: "我喜欢茉莉花茶。" } },
    { type: "assistant", message: { role: "assistant", content: "好的。" } },
  ]);
  let releaseInflight;
  inflightCtx.setResponder(async (res, body) => {
    await new Promise((resolve) => {
      releaseInflight = resolve;
    });
    sendFacts(res, [factFor(firstUserSource(parseData(body)), inflightCtx)]);
  });
  const pendingInflight = inflightCtx.analysis.analyze(
    analysisInput(inflightCtx, "inflight-1", "a", "project/inflight.jsonl"),
  );
  await waitFor(() => inflightCtx.requests.length === 1);
  const inflightBytes = fs.readFileSync(inflightFile);
  inflightBytes[0] = 0x5b;
  fs.writeFileSync(inflightFile, inflightBytes);
  releaseInflight();
  const inflightResult = await pendingInflight;
  assert.equal(inflightResult.status, "stale");
  assert.equal(inflightResult.code, "SOURCE_HISTORY_CHANGED");
  assert.equal(inflightCtx.memory.listMemories("a").length, 0);
  assert.equal(inflightCtx.processedCount("a"), 0);
  assert.equal(inflightCtx.sentCount(), 1);
  assert.equal(inflightCtx.requests.length, 1);

  const mappingCtx = await makeContext(t, { characters: ["b"] });
  writeSession(mappingCtx, "mapping.jsonl", [
    userMessage("mapping-user", "我喜欢茉莉花茶。"),
    assistantMessage("mapping-assistant"),
  ]);
  mappingCtx.db.exec(`
    CREATE TRIGGER fail_checkpoint_insert BEFORE INSERT ON source_analysis_checkpoints
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  const mappingResult = await mappingCtx.analysis.analyze(
    analysisInput(mappingCtx, "mapping-1", "b", "project/mapping.jsonl"),
  );
  assert.equal(mappingResult.status, "failed");
  assert.equal(mappingResult.code, "PUBLISH_FAILED");
  assert.equal(mappingCtx.memory.listMemories("b").length, 0);
  assert.equal(mappingCtx.processedCount("b"), 0);
  assert.equal(
    mappingCtx.db.prepare("SELECT COUNT(*) AS count FROM source_analysis_checkpoints").get().count,
    0,
  );
  assert.equal(mappingCtx.sentCount(), 1);
  assert.equal(mappingCtx.requests.length, 1);
});

test("POL-ANALYSIS-010 历史 checkpoint 验证数量有界", async (t) => {
  const ctx = await makeContext(t, { characters: ["c"] });
  writeSession(ctx, "limit.jsonl", [
    userMessage("limit-user", "我喜欢茉莉花茶。"),
    assistantMessage("limit-assistant"),
  ]);
  const permit = ctx.permissions.issueReadPermit(ctx.grantId);
  const fileKey = ctx.reader.fileKey(permit, "project/limit.jsonl").fileKey;
  ctx.permissions.releaseReadPermit(permit);

  const sourceIds = [];
  for (let index = 0; index < 9; index += 1) {
    const sourceId = `external:${index.toString(16).padStart(64, "0")}`;
    ctx.memory.remember({
      characterId: "c",
      factKey: `seed.${index}`,
      body: "旧理解",
      kind: "detail",
      sourceId,
    });
    ctx.memory.forget({ characterId: "c", factKey: `seed.${index}` });
    sourceIds.push(sourceId);
  }
  const insert = ctx.db.prepare(`
    INSERT INTO source_analysis_checkpoints
      (character_id, source_id, source_id_hash, file_key, body_start, byte_length,
       region_sha256, dev, ino, snapshot_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < sourceIds.length; index += 1) {
    const sourceId = sourceIds[index];
    insert.run(
      "c",
      sourceId,
      crypto.createHash("sha256").update(sourceId, "utf8").digest("hex"),
      fileKey,
      index,
      1,
      "a".repeat(64),
      "1",
      "1",
      1000,
      START,
    );
  }

  const limited = await ctx.analysis.analyze(
    analysisInput(ctx, "limit-1", "c", "project/limit.jsonl"),
  );
  assert.equal(limited.status, "skipped");
  assert.equal(limited.code, "SOURCE_VERIFICATION_LIMIT");
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.sentCount(), 0);
  assert.equal(ctx.memory.listMemories("c").length, 0);
  assert.equal(ctx.processedCount("c"), 0);
});

test("POL-ANALYSIS-011 大量无关历史映射仍只核验受保护区段", async (t) => {
  const ctx = await makeContext(t, { characters: ["a"] });
  const file = writeSession(ctx, "unrelated.jsonl", [
    { type: "user", message: { role: "user", content: "旧删除暗号：我喜欢茉莉花茶。" } },
    { type: "assistant", message: { role: "assistant", content: "好的。" } },
  ]);
  const first = await ctx.analysis.analyze(
    analysisInput(ctx, "unrelated-first", "a", "project/unrelated.jsonl"),
  );
  assert.equal(first.status, "completed");
  const oldEntry = ctx.memory.listMemories("a")[0];
  ctx.memory.forget({ characterId: "a", factKey: oldEntry.factKey });

  const permit = ctx.permissions.issueReadPermit(ctx.grantId);
  const fileKey = ctx.reader.fileKey(permit, "project/unrelated.jsonl").fileKey;
  ctx.permissions.releaseReadPermit(permit);

  // 同一文件写入大量无关来源映射，且区段身份/摘要均为无效值。
  const insert = ctx.db.prepare(`
    INSERT INTO source_analysis_checkpoints
      (character_id, source_id, source_id_hash, file_key, body_start, byte_length,
       region_sha256, dev, ino, snapshot_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 60; index += 1) {
    const sourceId = `external:unrelated-${String(index).padStart(60, "0")}`;
    insert.run(
      "a",
      sourceId,
      crypto.createHash("sha256").update(sourceId, "utf8").digest("hex"),
      fileKey,
      1000 + index,
      1,
      "b".repeat(64),
      "999",
      "999",
      100000,
      START,
    );
  }

  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: "user", message: { role: "user", content: "我喜欢喝乌龙茶。" } })}\n` +
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "好的。" } })}\n`,
  );
  ctx.setNow(START + 2 * HOUR);
  const second = await ctx.analysis.analyze(
    analysisInput(ctx, "unrelated-second", "a", "project/unrelated.jsonl"),
  );
  assert.equal(second.status, "completed");
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.sentCount(), 2);
  assert.equal(ctx.requests[1].includes("旧删除暗号"), false);
  assert.equal(ctx.requests[1].includes("乌龙茶"), true);
  assert.deepEqual(
    ctx.memory.listMemories("a").map((memory) => memory.body),
    ["用户喜欢喝乌龙茶"],
  );
});
