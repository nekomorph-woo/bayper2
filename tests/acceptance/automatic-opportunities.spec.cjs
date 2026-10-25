/* S06b 正式验收：真实 SQLite app_state + companion + 注入时间/随机；
   Case 003 额外使用真实 permissions/reader/budget/memory/source-analysis 与本机 HTTP fixture。
   不接 GUI、真实 HOME/.env、远程模型或定时器。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { createCompanionshipService, localDay } = require("../../app/companionship.cjs");
const { createAutomaticOpportunities } = require("../../app/automatic-opportunities.cjs");
const { createMemoryService } = require("../../app/memory.cjs");
const { createExternalSources } = require("../../app/external-sources.cjs");
const { createSessionSourceReader } = require("../../app/session-sources.cjs");
const { createAutomaticBudget } = require("../../app/automatic-budget.cjs");
const { createSourceAnalysis } = require("../../app/source-analysis.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 26, 12, 0, 0);
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const LAST_KEY = "automatic_opportunity_last_eval_at";
const NEXT_KEY = "automatic_opportunity_next_at";
const CANDIDATES = ["a", "b", "c", "d", "e", "f"].map((id) => ({
  id,
  name: `角色${id}`,
  tagline: "",
  intro: "",
  traits: [],
}));

function setDbState(db, key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function makeCompanionContext(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-opportunity-"));
  const dbFile = path.join(dir, "bayper.sqlite3");
  createStore(dir).close();

  const start = options.start ?? START;
  const characters = options.characters ?? ["a", "b", "c", "d", "e"];
  const rosterIds = options.rosterIds ?? characters.slice(0, 5);
  const day = localDay(new Date(start));
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const characterId of characters) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        characterId,
        new Date(start).toISOString(),
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(characterId, options.energies?.[characterId] ?? 100);
    }
    setDbState(db, "fixed_character_id", rosterIds[0]);
    setDbState(db, "current_character_id", options.currentId ?? rosterIds[0]);
    setDbState(db, "current_mode", "companion");
    setDbState(db, "pending_rotation", "0");
    setDbState(db, "last_active_at", start);
    rosterIds.forEach((characterId, index) => {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        day,
        SLOTS[index],
        characterId,
      );
    });
    for (const characterId of characters) {
      const mode =
        options.modes?.[characterId] ??
        (characterId === (options.currentId ?? rosterIds[0]) ? "companion" : "waiting");
      db.prepare(`
        INSERT INTO character_runtime
          (character_id, mode, last_settled_at, exploring)
        VALUES (?, ?, ?, ?)
      `).run(characterId, mode, start, options.exploring?.[characterId] ? 1 : 0);
    }
  } finally {
    db.close();
  }

  const store = createStore(dir);
  const clock = { ms: start };
  const values = [...(options.randoms ?? [])];
  let randomIndex = 0;
  const random = () => (randomIndex < values.length ? values[randomIndex++] : 0);
  const companionship = createCompanionshipService({
    store,
    candidates: CANDIDATES,
    now: () => new Date(clock.ms),
    random: () => 0.5,
  });
  const ctx = {
    dir,
    dbFile,
    store,
    companionship,
    clock,
    random,
    randomCalls: () => randomIndex,
  };
  t.after(() => {
    try {
      store.close();
    } catch {
      // 测试已关闭时仍清理目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function makeActivityFixture() {
  const calls = [];
  let behavior = "success";
  let release = null;
  let cancelCalls = 0;
  async function runActivity(args) {
    calls.push(args);
    if (behavior === "reject") {
      const error = new Error("forced activity failure");
      error.code = "SERVER_ERROR";
      throw error;
    }
    if (behavior === "failed") {
      return { status: "failed", code: "SERVER_ERROR" };
    }
    if (behavior === "deferred") {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { status: "completed" };
    }
    return { status: "completed" };
  }
  function cancelActivity() {
    cancelCalls += 1;
  }
  return {
    runActivity,
    cancelActivity,
    calls,
    setBehavior(value) {
      behavior = value;
    },
    release() {
      release?.();
    },
    cancelCalls: () => cancelCalls,
  };
}

function makeOpportunity(ctx, activity) {
  return createAutomaticOpportunities({
    store: ctx.store,
    companionship: ctx.companionship,
    now: () => ctx.clock.ms,
    random: ctx.random,
    runActivity: activity.runActivity,
    cancelActivity: activity.cancelActivity,
  });
}

function stateOf(ctx) {
  return {
    last: ctx.store.getAppState(LAST_KEY),
    next: ctx.store.getAppState(NEXT_KEY),
  };
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

function writeClaudeSession(dir, characterId, text) {
  const file = path.join(dir, "sessions", "project", `${characterId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "user",
      uuid: `u-${characterId}`,
      message: { role: "user", content: text },
    })}\n` +
      `${JSON.stringify({
        type: "assistant",
        uuid: `a-${characterId}`,
        message: { role: "assistant", content: "好的。" },
      })}\n`,
  );
  return file;
}

async function startModelServer() {
  const requests = [];
  let gated = false;
  let releaseGate = null;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      if (gated) {
        await new Promise((resolve) => {
          releaseGate = resolve;
        });
      }
      const payload = JSON.parse(body);
      const data = JSON.parse(payload.messages.find((message) => message.role === "user").content);
      const user = data.sources.find((source) => source.role === "user");
      const content = JSON.stringify({
        facts: [
          {
            sourceId: user.sourceId,
            factKey: "pref.tea",
            body: "用户喜欢茉莉花茶",
            kind: "preference",
            evidence: "喜欢茉莉花茶",
          },
        ],
      });
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      }
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
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    setGated(value) {
      gated = value;
    },
    release() {
      releaseGate?.();
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

test("POL-OPPORTUNITY-001 30分钟窗口、重建、回拨与长间隔", async (t) => {
  const ctx = makeCompanionContext(t, { randoms: [0.9, 0.1, 0, 0.1, 0] });
  const activity = makeActivityFixture();
  let service = makeOpportunity(ctx, activity);

  assert.equal(Number(stateOf(ctx).next), START + 30 * MINUTE);
  assert.equal((await service.evaluate()).status, "not_due");
  assert.equal(activity.calls.length, 0);

  ctx.clock.ms = START + 30 * MINUTE;
  const chance = await service.evaluate();
  assert.equal(chance.status, "skipped");
  assert.equal(chance.reason, "CHANCE");
  assert.equal(activity.calls.length, 0);
  assert.equal(Number(stateOf(ctx).last), START + 30 * MINUTE);
  assert.equal(Number(stateOf(ctx).next), START + 60 * MINUTE);
  assert.equal(ctx.randomCalls(), 1);
  assert.equal((await service.evaluate()).status, "not_due");
  assert.equal(activity.calls.length, 0);

  service = makeOpportunity(ctx, activity);
  assert.equal((await service.evaluate()).status, "not_due");
  assert.equal(activity.calls.length, 0);
  assert.equal(Number(stateOf(ctx).next), START + 60 * MINUTE);

  ctx.clock.ms = START + 60 * MINUTE;
  const completed = await service.evaluate();
  assert.equal(completed.status, "completed");
  assert.equal(activity.calls.length, 1);
  assert.equal(ctx.randomCalls(), 3);
  assert.equal(Number(stateOf(ctx).last), START + 60 * MINUTE);
  assert.equal(Number(stateOf(ctx).next), START + 90 * MINUTE);
  assert.equal((await service.evaluate()).status, "not_due");

  ctx.clock.ms = START + 45 * MINUTE;
  const rollback = await service.evaluate();
  assert.equal(rollback.status, "not_due");
  assert.equal(rollback.reason, "CLOCK_ROLLBACK");
  assert.equal(activity.calls.length, 1);

  ctx.clock.ms = START + 4 * HOUR;
  const late = await service.evaluate();
  assert.equal(late.status, "completed");
  assert.equal(activity.calls.length, 2);
  assert.equal(Number(stateOf(ctx).last), START + 4 * HOUR);
  assert.equal(Number(stateOf(ctx).next), START + 4 * HOUR + 30 * MINUTE);
  assert.equal((await service.evaluate()).status, "not_due");
});

test("POL-OPPORTUNITY-002 名单/状态资格、聊天优先与暂停取消", async (t) => {
  const ctx = makeCompanionContext(t, {
    characters: ["a", "b", "c", "d", "e", "f"],
    rosterIds: ["a", "b", "c", "d", "e"],
    energies: { d: 20 },
    modes: { a: "companion", b: "waiting", c: "resting", d: "waiting", e: "waiting" },
    exploring: { e: true },
    randoms: [0.1, 0.9, 0.1, 0],
  });
  const activity = makeActivityFixture();
  const service = makeOpportunity(ctx, activity);
  // 先启动真实 companion，再固定一个非当前角色的 resting 状态；
  // 正常启动会把非当前角色统一恢复为 waiting。
  ctx.companionship.getSnapshot();
  const seedDb = new DatabaseSync(ctx.dbFile);
  seedDb
    .prepare("UPDATE character_runtime SET mode = 'resting' WHERE character_id = 'c'")
    .run();
  seedDb.close();

  ctx.clock.ms = START + 30 * MINUTE;
  const first = await service.evaluate();
  assert.equal(first.status, "completed");
  assert.equal(activity.calls.length, 1);
  assert.equal(activity.calls[0].characterId, "b");

  ctx.clock.ms = START + 60 * MINUTE;
  const rosterBefore = ctx.companionship.getSnapshot().roster.map((entry) => entry.characterId);
  assert.equal(ctx.companionship.startInteraction("f").temporary, true);
  const chatting = await service.evaluate();
  assert.equal(chatting.status, "skipped");
  assert.equal(chatting.reason, "INTERACTION");
  assert.equal(activity.calls.length, 1);
  assert.deepEqual(
    ctx.companionship.getSnapshot().roster.map((entry) => entry.characterId),
    rosterBefore,
  );
  ctx.companionship.endInteraction();

  ctx.clock.ms = START + 90 * MINUTE;
  assert.equal(service.pause(), true);
  const paused = await service.evaluate();
  assert.equal(paused.status, "paused");
  assert.equal(service.pause(), false);
  assert.equal(service.resume(), true);
  assert.equal(service.resume(), false);
  assert.equal(Number(stateOf(ctx).next), START + 90 * MINUTE + 30 * MINUTE);
  assert.equal((await service.evaluate()).status, "not_due");

  ctx.clock.ms = START + 120 * MINUTE;
  activity.setBehavior("deferred");
  const pending = service.evaluate();
  await waitFor(() => activity.calls.length === 2);
  const busy = await service.evaluate();
  assert.equal(busy.status, "busy");
  assert.equal(service.pause(), true);
  assert.equal(activity.cancelCalls(), 1);
  activity.release();
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(activity.calls.length, 2);
  assert.equal(service.dispose(), true);
  assert.equal(service.dispose(), false);
  assert.equal(service.resume(), false);

  const disposeCtx = makeCompanionContext(t, {
    characters: ["a", "b"],
    rosterIds: ["a", "b"],
    randoms: [0.1, 0],
  });
  const disposeActivity = makeActivityFixture();
  disposeActivity.setBehavior("deferred");
  const disposeService = makeOpportunity(disposeCtx, disposeActivity);
  disposeCtx.clock.ms = START + 30 * MINUTE;
  const disposePending = disposeService.evaluate();
  await waitFor(() => disposeActivity.calls.length === 1);
  assert.equal(disposeService.dispose(), true);
  assert.equal(disposeActivity.cancelCalls(), 1);
  disposeActivity.release();
  assert.equal((await disposePending).status, "cancelled");
  assert.equal(disposeService.dispose(), false);

  const recheckCtx = makeCompanionContext(t, {
    characters: ["a", "b"],
    rosterIds: ["a", "b"],
    randoms: [],
  });
  const recheckDb = new DatabaseSync(recheckCtx.dbFile);
  let draws = 0;
  recheckCtx.random = () => {
    draws += 1;
    if (draws === 1) {
      return 0.1;
    }
    if (draws === 2) {
      recheckDb.prepare("UPDATE character_stats SET energy = 0 WHERE character_id = 'b'").run();
      recheckDb.prepare("UPDATE character_runtime SET mode = 'resting' WHERE character_id = 'b'").run();
      return 0.9;
    }
    return 0;
  };
  const recheckActivity = makeActivityFixture();
  const recheckService = makeOpportunity(recheckCtx, recheckActivity);
  recheckCtx.clock.ms = START + 30 * MINUTE;
  try {
    const recheck = await recheckService.evaluate();
    assert.equal(recheck.status, "skipped");
    assert.equal(recheck.reason, "INELIGIBLE");
    assert.equal(recheckActivity.calls.length, 0);
  } finally {
    recheckDb.close();
  }
});

test("POL-OPPORTUNITY-003 真实来源分析链路与共享预算", async (t) => {
  const ctx = makeCompanionContext(t, {
    characters: ["a", "b", "c"],
    rosterIds: ["a", "b", "c"],
    randoms: [0.1, 0.9, 0.1, 0, 0.1, 0.6],
  });
  const sessionsRoot = path.join(ctx.dir, "sessions");
  writeClaudeSession(ctx.dir, "a", "我喜欢茉莉花茶。");
  writeClaudeSession(ctx.dir, "b", "我喜欢茉莉花茶。");
  writeClaudeSession(ctx.dir, "c", "我喜欢茉莉花茶。");

  const rawDb = new DatabaseSync(ctx.dbFile);
  let modelServer = null;
  let sourceAnalysis = null;
  try {
    rawDb.exec("PRAGMA foreign_keys = ON");
    const memory = createMemoryService({ db: rawDb, now: () => ctx.clock.ms });
    const permissions = createExternalSources({ db: rawDb });
    permissions.setEnabled(true);
    const grant = permissions.grantDirectory("claude-code", sessionsRoot);
    const budget = createAutomaticBudget({ db: rawDb, now: () => ctx.clock.ms });
    const reader = createSessionSourceReader({ permissions });

    modelServer = await startModelServer();
    let eligibilityGate = () => false;
    sourceAnalysis = createSourceAnalysis({
      db: rawDb,
      memory,
      permissions,
      reader,
      budget,
      getCredentials: () => ({
        baseUrl: modelServer.baseUrl,
        modelName: "fixture-model",
        apiKey: "fixture-key",
      }),
      isEligible: (characterId) => eligibilityGate(characterId),
      fetchImpl: fetch,
      now: () => ctx.clock.ms,
    });

    const runCharacters = [];
    async function runActivity({ characterId, requestId, signal, isEligible }) {
      runCharacters.push(characterId);
      eligibilityGate = isEligible;
      const cancel = () => sourceAnalysis.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await sourceAnalysis.analyze({
          requestId,
          characterId,
          directoryId: grant.id,
          relativePath: `project/${characterId}.jsonl`,
        });
      } finally {
        signal.removeEventListener("abort", cancel);
        eligibilityGate = () => false;
      }
    }
    const service = createAutomaticOpportunities({
      store: ctx.store,
      companionship: ctx.companionship,
      now: () => ctx.clock.ms,
      random: ctx.random,
      runActivity,
      cancelActivity: () => sourceAnalysis.cancel(),
    });

    ctx.clock.ms = START + 30 * MINUTE;
    const first = await service.evaluate();
    assert.equal(first.status, "completed");
    assert.equal(first.characterId, "c");
    assert.equal(first.activity.created, 1);
    assert.deepEqual(
      memory.listMemories("c").map((entry) => entry.body),
      ["用户喜欢茉莉花茶"],
    );
    assert.equal(memory.listMemories("c")[0].trust, "inferred");
    assert.equal(memory.listMemories("a").length, 0);
    assert.equal(memory.listMemories("b").length, 0);
    assert.equal(modelServer.requests.length, 1);
    assert.equal(
      rawDb.prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1").get()
        .count,
      1,
    );

    ctx.clock.ms = START + 60 * MINUTE;
    const budgetFull = await service.evaluate();
    assert.equal(budgetFull.status, "skipped");
    assert.equal(budgetFull.activity.code, "HOURLY_LIMIT");
    assert.equal(modelServer.requests.length, 1);
    assert.equal(
      rawDb.prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1").get()
        .count,
      1,
    );
    assert.equal(memory.listMemories("a").length, 0);
    assert.deepEqual(runCharacters, ["c", "a"]);

    ctx.clock.ms = START + 90 * MINUTE;
    modelServer.setGated(true);
    const pending = service.evaluate();
    await waitFor(() => modelServer.requests.length === 2);
    permissions.revokeDirectory(grant.id);
    modelServer.release();
    const stale = await pending;
    assert.equal(stale.status, "stale");
    assert.equal(stale.characterId, "b");
    assert.equal(modelServer.requests.length, 2);
    assert.equal(
      rawDb.prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1").get()
        .count,
      2,
    );
    assert.equal(memory.listMemories("b").length, 0);
    assert.deepEqual(
      memory.listMemories("c").map((entry) => entry.body),
      ["用户喜欢茉莉花茶"],
    );
    assert.equal(
      rawDb
        .prepare("SELECT COUNT(*) AS count FROM source_analysis_processed WHERE character_id = 'b'")
        .get().count,
      0,
    );
    assert.deepEqual(runCharacters, ["c", "a", "b"]);
    service.dispose();
  } finally {
    modelServer?.close();
    try {
      rawDb.close();
    } catch {
      // 测试结束清理。
    }
  }
});

test("POL-OPPORTUNITY-004 app_state 写故障、busy 与活动失败", async (t) => {
  const ctx = makeCompanionContext(t, { randoms: [0.1, 0, 0.1, 0, 0.1, 0] });
  const activity = makeActivityFixture();
  const service = makeOpportunity(ctx, activity);
  const rawDb = new DatabaseSync(ctx.dbFile);
  try {
    ctx.clock.ms = START + 30 * MINUTE;
    rawDb.exec(`
      CREATE TRIGGER fail_state_insert BEFORE INSERT ON app_state
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
      CREATE TRIGGER fail_state_update BEFORE UPDATE ON app_state
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);
    const failed = await service.evaluate();
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, "STATE_PERSIST_FAILED");
    assert.equal(activity.calls.length, 0);
    assert.equal(stateOf(ctx).last, null);
    assert.equal(Number(stateOf(ctx).next), START + 30 * MINUTE);

    rawDb.exec("DROP TRIGGER fail_state_insert; DROP TRIGGER fail_state_update;");
    const recovered = await service.evaluate();
    assert.equal(recovered.status, "completed");
    assert.equal(activity.calls.length, 1);
    assert.equal(Number(stateOf(ctx).next), START + 60 * MINUTE);

    ctx.clock.ms = START + 60 * MINUTE;
    activity.setBehavior("deferred");
    const pending = service.evaluate();
    await waitFor(() => activity.calls.length === 2);
    const busy = await service.evaluate();
    assert.equal(busy.status, "busy");
    activity.release();
    assert.equal((await pending).status, "completed");
    assert.equal(activity.calls.length, 2);

    ctx.clock.ms = START + 90 * MINUTE;
    activity.setBehavior("reject");
    const rejected = await service.evaluate();
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.activity.code, "SERVER_ERROR");
    assert.equal(activity.calls.length, 3);
    assert.equal((await service.evaluate()).status, "not_due");
  } finally {
    rawDb.close();
  }
});

test("POL-OPPORTUNITY-005 重建后长时间离线不立即抽签", async (t) => {
  const ctx = makeCompanionContext(t, { randoms: [0.9, 0.1, 0] });
  const activity = makeActivityFixture();
  let service = makeOpportunity(ctx, activity);

  ctx.clock.ms = START + 30 * MINUTE;
  const first = await service.evaluate();
  assert.equal(first.status, "skipped");
  assert.equal(first.reason, "CHANCE");
  assert.equal(activity.calls.length, 0);

  // 模拟应用关闭很久后，用同一真实 SQLite app_state 重建服务。
  ctx.clock.ms = START + 4 * HOUR;
  service = makeOpportunity(ctx, activity);
  const immediate = await service.evaluate();
  assert.equal(immediate.status, "not_due");
  assert.equal(activity.calls.length, 0);
  assert.ok(Number(stateOf(ctx).next) >= ctx.clock.ms + 30 * MINUTE);

  ctx.clock.ms += 30 * MINUTE;
  const later = await service.evaluate();
  assert.equal(later.status, "completed");
  assert.equal(activity.calls.length, 1);
});

test("POL-OPPORTUNITY-006 时钟回拨后 pause/resume 不提前下一次", async (t) => {
  const ctx = makeCompanionContext(t, { randoms: [0.1, 0, 0.1, 0, 0.1, 0] });
  const activity = makeActivityFixture();
  const service = makeOpportunity(ctx, activity);

  ctx.clock.ms = START + 30 * MINUTE;
  assert.equal((await service.evaluate()).status, "completed");
  ctx.clock.ms = START + 60 * MINUTE;
  assert.equal((await service.evaluate()).status, "completed");
  assert.equal(activity.calls.length, 2);

  const previousNext = Number(stateOf(ctx).next);
  const previousLast = Number(stateOf(ctx).last);
  assert.equal(previousNext, START + 90 * MINUTE);

  // 回拨到上次评估之前，再 pause/resume；不能把已有 next 推早。
  ctx.clock.ms = START + 45 * MINUTE;
  assert.equal(service.pause(), true);
  assert.equal(service.resume(), true);
  assert.ok(Number(stateOf(ctx).next) >= previousNext);
  assert.ok(Number(stateOf(ctx).next) >= previousLast + 30 * MINUTE);

  // 回到 last 之后 20 分钟，仍不足 30 分钟，不得提前评估。
  ctx.clock.ms = START + 80 * MINUTE;
  assert.equal((await service.evaluate()).status, "not_due");
  assert.equal(activity.calls.length, 2);

  ctx.clock.ms = START + 90 * MINUTE;
  assert.equal((await service.evaluate()).status, "completed");
  assert.equal(activity.calls.length, 3);
});

test("POL-OPPORTUNITY-007 store 必须提供事务能力", async (t) => {
  const ctx = makeCompanionContext(t, { randoms: [0.1, 0] });
  assert.equal(typeof ctx.store.runInTransaction, "function");
  const activity = makeActivityFixture();
  assert.throws(
    () =>
      createAutomaticOpportunities({
        store: {
          getAppState: () => null,
          setAppState: () => {},
        },
        companionship: ctx.companionship,
        now: () => ctx.clock.ms,
        random: () => 0.1,
        runActivity: activity.runActivity,
        cancelActivity: activity.cancelActivity,
      }),
    (error) => error?.code === "DEPENDENCY_REQUIRED",
  );
});
