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
