/* S06l 协调反例：真实 SQLite 中当前角色持有不可用待穿时，不能饿死其他
   角色的合法待穿；每次调度最多提交一个合法意图，当前合法优先。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { createOutfitRuntime } = require("../../app/outfit-runtime.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function seedPeer(store, characterId, at) {
  store.db
    .prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)")
    .run(characterId, new Date(at).toISOString());
  store.db
    .prepare(`
      INSERT INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `)
    .run(characterId);
  store.db
    .prepare(`
      INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
      VALUES (?, 'waiting', ?, 0)
    `)
    .run(characterId, at);
}

function pending(token, outfitId, requestedAt) {
  return JSON.stringify({
    outfitId,
    storyId: null,
    token,
    version: 1,
    requestedAt,
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

test("POL-OUTFIT-005 当前不可用待穿不阻塞其他角色合法提交；每次只提交一个", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-runtime-"));
  const store = createStore(dir, {
    storyCatalog: { schemaVersion: 1, theme: { id: "t", name: "t" }, stories: [] },
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  store.acceptCharacter({
    characterId: "rin",
    day: localDay(Date.now()),
    acceptedAt: new Date().toISOString(),
  });
  seedPeer(store, "hu", Date.now());

  const statuses = [];
  const applied = [];
  let waits = 0;
  const runtime = createOutfitRuntime({
    outfits: store.outfits,
    getCurrentCharacterId: () => "rin",
    getPresentation: () => ({
      assetState: "pending",
      visible: true,
      resting: false,
      restToken: 0,
    }),
    canWaitForCurrent: () => false,
    isBlocked: () => false,
    waitForBoundary: async () => {
      waits += 1;
      throw new Error("非当前/无可见画布不应等待节点");
    },
    onStatus: (status) => statuses.push(status),
    onApplied: ({ characterId }) => applied.push(characterId),
    onError: (error) => {
      throw error;
    },
  });

  // 当前 rin 的待穿目标不存在；hu 的基础衣装合法。rin 必须被保留但不阻塞 hu。
  store.setAppState(
    "outfit_pending:rin",
    pending("rin-invalid", "missing.outfit", 1),
  );
  store.setAppState("outfit_pending:hu", pending("hu-base", "base", 2));
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "hu" }).pending === null,
    2000,
    "hu 的合法待穿没有被提交",
  );
  assert.equal(waits, 0);
  assert.deepEqual(applied, ["hu"]);
  const rinInvalid = JSON.parse(
    store.getAppState("outfit_pending:rin"),
  );
  assert.equal(rinInvalid.token, "rin-invalid");
  assert.equal(store.outfits.list({ characterId: "rin" }).pending.available, false);
  assert.equal(store.outfits.list({ characterId: "hu" }).worn.outfitId, "base");
  await delay(50);

  // 两个合法待穿同时存在时，当前角色优先，且本次只提交一个。
  store.setAppState("outfit_pending:rin", pending("rin-base", "base", 3));
  store.setAppState("outfit_pending:hu", pending("hu-base-2", "base", 4));
  applied.length = 0;
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "当前角色的合法待穿没有优先提交",
  );
  assert.deepEqual(applied, ["rin"]);
  assert.equal(store.outfits.list({ characterId: "hu" }).pending.token, "hu-base-2");
  assert.equal(waits, 0);
});

test("POL-OUTFIT-003/005 等待中新聊天或新 token 使旧回调失效，恢复后再提交", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-runtime-stale-"));
  const store = createStore(dir, {
    storyCatalog: { schemaVersion: 1, theme: { id: "t", name: "t" }, stories: [] },
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  store.acceptCharacter({
    characterId: "rin",
    day: localDay(Date.now()),
    acceptedAt: new Date().toISOString(),
  });

  let blocked = false;
  let waitMode = "deferred";
  let waitStarted = false;
  let resolveWait = null;
  let waitCalls = 0;
  const applied = [];
  const runtime = createOutfitRuntime({
    outfits: store.outfits,
    getCurrentCharacterId: () => "rin",
    getPresentation: () => ({
      assetState: "ready",
      visible: true,
      resting: false,
      restToken: 0,
    }),
    canWaitForCurrent: () => true,
    isBlocked: () => blocked,
    waitForBoundary: async () => {
      waitCalls += 1;
      waitStarted = true;
      if (waitMode === "deferred") {
        await new Promise((resolve) => {
          resolveWait = resolve;
        });
      }
    },
    onApplied: ({ characterId }) => applied.push(characterId),
    onError: (error) => {
      throw error;
    },
  });

  // 等待中新聊天：旧回调不得提交；恢复后同一待穿正常提交一次。
  store.setAppState("outfit_pending:rin", pending("chat-old", "base", 1));
  runtime.schedule();
  await waitFor(() => waitStarted, 2000, "没有进入真实节点等待");
  blocked = true;
  resolveWait();
  await delay(50);
  assert.deepEqual(applied, []);
  assert.equal(store.outfits.list({ characterId: "rin" }).pending.token, "chat-old");
  assert.equal(store.outfits.list({ characterId: "rin" }).worn.outfitId, "base");

  blocked = false;
  waitMode = "immediate";
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "新聊天结束后没有恢复提交",
  );
  assert.deepEqual(applied, ["rin"]);

  // 等待中新 token：旧 token 不得提交，新意图在下一触发提交。
  applied.length = 0;
  waitMode = "deferred";
  waitStarted = false;
  store.setAppState("outfit_pending:rin", pending("token-old", "base", 2));
  runtime.schedule();
  await waitFor(() => waitStarted, 2000, "第二次没有进入节点等待");
  store.setAppState("outfit_pending:rin", pending("token-new", "base", 3));
  resolveWait();
  await delay(50);
  assert.deepEqual(applied, []);
  assert.equal(store.outfits.list({ characterId: "rin" }).pending.token, "token-new");
  assert.equal(store.outfits.list({ characterId: "rin" }).worn.outfitId, "base");

  waitMode = "immediate";
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "新 token 没有在后续触发提交",
  );
  assert.deepEqual(applied, ["rin"]);
  assert.ok(waitCalls >= 4);
});

test("POL-OUTFIT-005 超时保留待穿、dispose 不写且全局只有一个节点等待", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-runtime-boundary-"));
  const store = createStore(dir, {
    storyCatalog: { schemaVersion: 1, theme: { id: "t", name: "t" }, stories: [] },
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  store.acceptCharacter({
    characterId: "rin",
    day: localDay(Date.now()),
    acceptedAt: new Date().toISOString(),
  });
  store.setAppState("outfit_pending:rin", pending("boundary-token", "base", 1));

  const baseConfig = {
    outfits: store.outfits,
    getCurrentCharacterId: () => "rin",
    getPresentation: () => ({
      assetState: "ready",
      visible: true,
      resting: false,
      restToken: 0,
      activity: null,
    }),
    canWaitForCurrent: () => true,
    isBlocked: () => false,
  };

  // 受控 timeout：只记 timeout，不提交、不清除待穿；同一协调器随后正常节点成功一次。
  let boundaryMode = "timeout";
  const timeoutStatuses = [];
  const timeoutApplied = [];
  const timeoutRuntime = createOutfitRuntime({
    ...baseConfig,
    waitForBoundary: async () => {
      if (boundaryMode === "timeout") {
        const error = new Error("timeout");
        error.code = "NODE_TIMEOUT";
        throw error;
      }
    },
    onStatus: (status) => timeoutStatuses.push(status),
    onApplied: ({ characterId }) => timeoutApplied.push(characterId),
  });
  timeoutRuntime.schedule();
  await waitFor(
    () => timeoutStatuses.some((status) => status?.phase === "timeout"),
    2000,
    "受控 timeout 没有进入 timeout 状态",
  );
  assert.deepEqual(timeoutApplied, []);
  assert.equal(store.outfits.list({ characterId: "rin" }).worn.outfitId, "base");
  assert.equal(
    store.outfits.list({ characterId: "rin" }).pending.token,
    "boundary-token",
  );
  await delay(50);
  boundaryMode = "success";
  timeoutRuntime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "同一协调器 timeout 后没有在正常节点恢复提交",
  );
  assert.deepEqual(timeoutApplied, ["rin"], "恢复后只提交一次");

  // dispose + 单等待：第二次 schedule 不得创建第二个等待；释放后不提交。
  store.setAppState("outfit_pending:rin", pending("dispose-token", "base", 2));
  let waitCalls = 0;
  let waitStarted = false;
  let resolveWait = null;
  const applied = [];
  const disposeRuntime = createOutfitRuntime({
    ...baseConfig,
    waitForBoundary: async () => {
      waitCalls += 1;
      waitStarted = true;
      await new Promise((resolve) => {
        resolveWait = resolve;
      });
    },
    onApplied: ({ characterId }) => applied.push(characterId),
    onError: (error) => {
      throw error;
    },
  });
  disposeRuntime.schedule();
  disposeRuntime.schedule();
  await waitFor(() => waitStarted, 2000, "没有进入节点等待");
  assert.equal(waitCalls, 1, "同时只允许一个节点等待");
  disposeRuntime.dispose();
  resolveWait();
  await delay(50);
  assert.deepEqual(applied, []);
  assert.equal(
    store.outfits.list({ characterId: "rin" }).pending.token,
    "dispose-token",
  );
  assert.equal(store.outfits.list({ characterId: "rin" }).worn.outfitId, "base");
});

async function makeBoundaryHarness(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(dir, {
    storyCatalog: { schemaVersion: 1, theme: { id: "t", name: "t" }, stories: [] },
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  store.acceptCharacter({
    characterId: "rin",
    day: localDay(Date.now()),
    acceptedAt: new Date().toISOString(),
  });
  store.setAppState("outfit_pending:rin", pending("edge-token", "base", 1));
  return { store, dir };
}

test("POL-OUTFIT-005 无可见画布 presentation=null 时合法待穿直接提交且不等待", async (t) => {
  const { store } = await makeBoundaryHarness(t, "bayper-outfit-null-presentation-");
  let waits = 0;
  const applied = [];
  const runtime = createOutfitRuntime({
    outfits: store.outfits,
    getCurrentCharacterId: () => "rin",
    getPresentation: () => null,
    canWaitForCurrent: () => true,
    isBlocked: () => false,
    waitForBoundary: async () => {
      waits += 1;
    },
    onApplied: ({ characterId }) => applied.push(characterId),
    onError: (error) => {
      throw error;
    },
  });
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "presentation=null 时没有恢复提交",
  );
  assert.equal(waits, 0, "无可见画布不得等待节点");
  assert.deepEqual(applied, ["rin"]);
  assert.equal(store.outfits.list({ characterId: "rin" }).worn.outfitId, "base");
});

test("POL-OUTFIT-005 getPresentation 抛错保留待穿，同一协调器下次读取恢复后提交一次", async (t) => {
  const { store } = await makeBoundaryHarness(t, "bayper-outfit-presentation-error-");
  let failing = true;
  let waits = 0;
  const errors = [];
  const applied = [];
  const runtime = createOutfitRuntime({
    outfits: store.outfits,
    getCurrentCharacterId: () => "rin",
    getPresentation: () => {
      if (failing) throw new Error("presentation unavailable");
      return null;
    },
    canWaitForCurrent: () => true,
    isBlocked: () => false,
    waitForBoundary: async () => {
      waits += 1;
    },
    onApplied: ({ characterId }) => applied.push(characterId),
    onError: (error) => errors.push(error.message),
  });
  runtime.schedule();
  await waitFor(() => errors.length === 1, 2000, "读取异常没有上报");
  assert.equal(waits, 0, "未知当前动作不得等待或提交");
  assert.deepEqual(applied, []);
  assert.equal(
    store.outfits.list({ characterId: "rin" }).pending.token,
    "edge-token",
  );

  await delay(50);
  failing = false;
  runtime.schedule();
  await waitFor(
    () => store.outfits.list({ characterId: "rin" }).pending === null,
    2000,
    "读取恢复后没有提交",
  );
  assert.deepEqual(applied, ["rin"], "恢复后只提交一次");
  assert.equal(waits, 0);
});
