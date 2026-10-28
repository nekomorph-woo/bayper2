/* S06l Part A 正式验收：真实 SQLite、正式 store/storyProgress/discoveryOutcomes
   入口与 app_state 持久化；作者目录、活动与素材可用性为构造 fixture。
   不启动 GUI、不调用真实模型，不写回正式目录。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createStore } = require("../../app/store.cjs");
const { createOutfits } = require("../../app/outfits.cjs");

const DAY = 24 * 60 * 60 * 1000;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const CHARACTER_ID = "rin";
const OUTFIT_ID = "rin.warm-tea";
const STORY_ID = "fixture.outfit.warm-tea";

function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function throwsCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function outfitStory(options = {}) {
  const storyId = options.storyId ?? STORY_ID;
  return {
    storyId,
    type: "outfit",
    targetId: options.targetId ?? OUTFIT_ID,
    ownerCharacterId: options.ownerCharacterId ?? CHARACTER_ID,
    themeId: "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: [
      {
        nodeId: "pocket-plan",
        factId: `${storyId}-pocket-plan`,
        body: "想给围裙缝个口袋。",
      },
      {
        nodeId: "pocket-ready",
        factId: `${storyId}-pocket-ready`,
        body: "口袋缝好了。",
      },
    ],
  };
}

function fixtureCatalog(stories) {
  return { schemaVersion: 1, theme: { id: "fixture-theme", name: "测试主题" }, stories };
}

function insertActivity(db, activityId, at, characterId) {
  db.prepare(`
    INSERT INTO character_activities
      (activity_id, character_id, kind, status, duration_ms, active_elapsed_ms,
       started_at, completed_at, action_completed_at, action_frame, created_at, updated_at)
    VALUES (?, ?, 'daily', 'completed', 10000, 10000, ?, ?, ?, 8, ?, ?)
  `).run(activityId, characterId, at, at, at, at, at);
}

function memorySnapshot(db) {
  return Object.fromEntries(
    db
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'memory%' ORDER BY name
      `)
      .all()
      .map(({ name }) => {
        const columns = db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((column) => `"${column.name}"`);
        const order = columns.length ? ` ORDER BY ${columns.join(", ")}` : "";
        return [
          name,
          db.prepare(`SELECT * FROM "${name}"${order}`).all().map((row) => ({ ...row })),
        ];
      }),
  );
}

function makeHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfits-"));
  const clock = { ms: START };
  let catalog = options.catalog ?? fixtureCatalog([outfitStory()]);
  let store = null;
  let seeded = false;

  function open() {
    store = createStore(dir, {
      storyCatalog: catalog,
      now: () => clock.ms,
    });
    if (!seeded) {
      store.acceptCharacter({
        characterId: CHARACTER_ID,
        day: localDay(clock.ms),
        acceptedAt: new Date(clock.ms).toISOString(),
      });
      for (const extra of options.extraCharacters ?? []) {
        seedCharacter(extra);
      }
      seeded = true;
    }
    store.outfits = options.useStoreOutfits === false
      ? createOutfits({
        db: store.db,
        storyProgress: store.storyProgress,
        discoveryOutcomes: store.discoveryOutcomes,
        isAssetAvailable: options.isAssetAvailable ?? (() => true),
        now: () => new Date(clock.ms),
      })
      : store.outfits;
  }

  function seedCharacter({ characterId, exploring = false, inRoster = false }) {
    store.db
      .prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)")
      .run(characterId, new Date(clock.ms).toISOString());
    store.db
      .prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, 100, 0)
      `)
      .run(characterId);
    store.db
      .prepare(`
        INSERT INTO character_runtime (character_id, mode, last_settled_at, exploring)
        VALUES (?, 'waiting', ?, ?)
      `)
      .run(characterId, clock.ms, exploring ? 1 : 0);
    if (inRoster) {
      store.db
        .prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'random_1', ?)")
        .run(localDay(clock.ms), characterId);
    }
  }

  function completeStory(story, { unlock = true, narratorId = story.ownerCharacterId } = {}) {
    story.nodes.forEach((node, index) => {
      const activityId = `act-${story.storyId}-${index + 1}`;
      insertActivity(store.db, activityId, clock.ms, narratorId);
      const result = store.storyProgress.recordNode({
        activityId,
        narratorId,
        storyId: story.storyId,
        nodeId: node.nodeId,
      });
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      clock.ms += DAY;
    });
    if (unlock) {
      const unlocked = store.discoveryOutcomes.unlockNextOutfit();
      assert.equal(unlocked.unlocked, true, JSON.stringify(unlocked));
    }
  }

  function businessSnapshot() {
    return {
      relationships: store.db
        .prepare("SELECT * FROM relationships ORDER BY character_id")
        .all(),
      stats: store.db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
      runtime: store.db
        .prepare("SELECT * FROM character_runtime ORDER BY character_id")
        .all(),
      roster: store.db.prepare("SELECT * FROM roster ORDER BY day, slot").all(),
      interactions: store.db.prepare("SELECT * FROM interactions").all(),
      ownership: store.db
        .prepare("SELECT * FROM discovery_outfit_ownership ORDER BY story_id")
        .all(),
      invitations: store.db
        .prepare("SELECT * FROM discovery_invitations ORDER BY invitation_id")
        .all(),
      memory: memorySnapshot(store.db),
    };
  }

  const h = {
    dir,
    clock,
    get store() {
      return store;
    },
    get outfits() {
      return store.outfits;
    },
    one: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    currentId: () =>
      store.db
        .prepare("SELECT value FROM app_state WHERE key = 'current_character_id'")
        .get().value,
    useCatalog: (next) => {
      catalog = next;
    },
    reopen: () => {
      store.close();
      open();
    },
    completeStory,
    businessSnapshot,
    request: (outfitId, characterId = CHARACTER_ID) =>
      store.outfits.request({ characterId, outfitId }),
    commit: (pending, characterId = CHARACTER_ID) =>
      store.outfits.commitPending({
        characterId,
        token: pending.token,
        version: pending.version,
      }),
    list: (characterId = CHARACTER_ID) => store.outfits.list({ characterId }),
  };

  open();
  t.after(() => {
    try {
      store?.close();
    } catch {
      // 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

function seedKeepsake(store) {
  const result = store.memory.remember({
    characterId: CHARACTER_ID,
    factKey: "fixture.s06l-keepsake",
    body: "用户喜欢在雨后整理衣橱。",
    kind: "preference",
    sourceId: "chat:s06l-001",
  });
  assert.equal(result.created, true);
}

test("POL-OUTFIT-001 查看不改写，选择只存待穿，提交后才换装且不动身份/记忆/数值/名单", (t) => {
  const h = makeHarness(t);
  const story = outfitStory();
  h.completeStory(story);
  h.store.setNickname(CHARACTER_ID, "小凛");
  seedKeepsake(h.store);
  const before = h.businessSnapshot();
  const ownershipBefore = h.one(
    "SELECT * FROM discovery_outfit_ownership WHERE story_id = ?",
    STORY_ID,
  );

  // 查看：默认基础衣装，列出已拥有温茶；只读不写。
  const listed = h.list();
  assert.equal(listed.worn.outfitId, "base");
  assert.equal(listed.pending, null);
  assert.ok(listed.outfits.some((item) => item.outfitId === OUTFIT_ID && item.available));
  assert.deepEqual(h.businessSnapshot(), before, "查看不得改关系/记忆/名单/归属");

  // 选择：只写待穿意图与 token，尚未穿用。
  const requested = h.request(OUTFIT_ID);
  assert.equal(requested.requested, true);
  assert.equal(requested.duplicate, false);
  assert.equal(requested.worn.outfitId, "base");
  assert.equal(requested.pending.outfitId, OUTFIT_ID);
  assert.equal(typeof requested.pending.token, "string");
  assert.ok(requested.pending.token.length > 0);
  assert.deepEqual(h.businessSnapshot(), before, "待穿不得提前改身份或归属");

  // 旧/伪造 token 不能提交。
  throwsCode(
    () =>
      h.outfits.commitPending({
        characterId: CHARACTER_ID,
        token: "forged-token",
        version: requested.pending.version,
      }),
    "OUTFIT_PENDING_STALE",
  );
  assert.equal(h.list().worn.outfitId, "base");

  const committed = h.commit(requested.pending);
  assert.equal(committed.committed, true);
  assert.equal(committed.worn.outfitId, OUTFIT_ID);
  assert.equal(committed.worn.storyId, STORY_ID);
  assert.equal(committed.pending, null);
  assert.deepEqual(h.businessSnapshot(), before, "换装不得改记忆、数值、名单或归属");
  assert.deepEqual(
    h.one("SELECT * FROM discovery_outfit_ownership WHERE story_id = ?", STORY_ID),
    ownershipBefore,
    "换装不得改解锁时间或提示状态",
  );
});

test("POL-OUTFIT-002 重复选择、选回基础与重启保持最后选择", (t) => {
  const h = makeHarness(t);
  h.completeStory(outfitStory());
  h.store.setNickname(CHARACTER_ID, "小凛");
  seedKeepsake(h.store);
  h.commit(h.request(OUTFIT_ID).pending);
  const ownershipBefore = h.all(
    "SELECT * FROM discovery_outfit_ownership ORDER BY story_id",
  );
  const memoryBefore = memorySnapshot(h.store.db);

  // 已穿温茶，再次选择同一件是取消待穿/幂等，不新增归属。
  const repeat = h.request(OUTFIT_ID);
  assert.equal(repeat.worn.outfitId, OUTFIT_ID);
  assert.equal(repeat.pending, null);
  assert.equal(repeat.cancelled, false);

  // 选回基础并提交；基础始终有回退入口。
  const basePending = h.request("base");
  assert.equal(basePending.pending.outfitId, "base");
  h.commit(basePending.pending);
  assert.equal(h.list().worn.outfitId, "base");

  // 再穿温茶后重启，已穿保持；昵称与独属记忆不变。
  h.commit(h.request(OUTFIT_ID).pending);
  h.reopen();
  assert.equal(h.list().worn.outfitId, OUTFIT_ID);
  assert.equal(h.list().pending, null);
  assert.equal(
    h.one("SELECT nickname FROM relationships WHERE character_id = ?", CHARACTER_ID).nickname,
    "小凛",
  );
  assert.deepEqual(memorySnapshot(h.store.db), memoryBefore);
  assert.deepEqual(
    h.all("SELECT * FROM discovery_outfit_ownership ORDER BY story_id"),
    ownershipBefore,
    "重复穿用不得产生新解锁",
  );

  h.commit(h.request("base").pending);
  assert.equal(h.list().worn.outfitId, "base");
});

test("POL-OUTFIT-005 待穿跨重启保留，旧 token 失效，最后意图唯一", (t) => {
  const secondOutfit = outfitStory({
    storyId: "fixture.outfit.summer",
    targetId: "rin.summer",
  });
  const h = makeHarness(t, {
    catalog: fixtureCatalog([outfitStory(), secondOutfit]),
    useStoreOutfits: false,
    isAssetAvailable: () => true,
  });
  h.completeStory(outfitStory());
  h.clock.ms += 73 * 60 * 60 * 1000;
  h.completeStory(secondOutfit);
  assert.equal(h.store.discoveryOutcomes.getOutfitOwnership({ storyId: STORY_ID }).outfitId, OUTFIT_ID);
  assert.equal(
    h.store.discoveryOutcomes.getOutfitOwnership({ storyId: secondOutfit.storyId }).outfitId,
    "rin.summer",
  );

  const first = h.request(OUTFIT_ID);
  h.reopen();
  const restored = h.list();
  assert.equal(restored.worn.outfitId, "base");
  assert.equal(restored.pending.outfitId, OUTFIT_ID);
  assert.equal(restored.pending.token, first.pending.token);

  // 同一件重复选择保留同一待穿意图。
  const duplicate = h.request(OUTFIT_ID);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.pending.token, first.pending.token);

  // 新选择覆盖旧意图；旧回调不能提交。
  const second = h.request("rin.summer");
  assert.equal(second.pending.outfitId, "rin.summer");
  assert.notEqual(second.pending.token, first.pending.token);
  throwsCode(
    () =>
      h.outfits.commitPending({
        characterId: CHARACTER_ID,
        token: first.pending.token,
        version: first.pending.version,
      }),
    "OUTFIT_PENDING_STALE",
  );
  assert.equal(h.list().worn.outfitId, "base");
  assert.equal(h.list().pending.outfitId, "rin.summer");

  // 选择当前已穿衣装（基础）可取消待穿。
  const cancelled = h.request("base");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.pending, null);
  throwsCode(
    () =>
      h.outfits.commitPending({
        characterId: CHARACTER_ID,
        token: second.pending.token,
        version: second.pending.version,
      }),
    "OUTFIT_PENDING_MISSING",
  );

  // 重启后仍可用新 token 提交最后一个意图。
  const third = h.request(OUTFIT_ID);
  h.reopen();
  assert.equal(h.list().pending.token, third.pending.token);
  h.commit(h.list().pending);
  assert.equal(h.list().worn.outfitId, OUTFIT_ID);
});

test("POL-OUTFIT-004 未拥有、他人衣装与归属撤销均拒绝且保留旧穿着", (t) => {
  const unowned = makeHarness(t);
  unowned.completeStory(outfitStory(), { unlock: false });
  throwsCode(() => unowned.request(OUTFIT_ID), "OUTFIT_NOT_OWNED");
  assert.equal(unowned.list().worn.outfitId, "base");

  const other = makeHarness(t, {
    catalog: fixtureCatalog([
      outfitStory({ ownerCharacterId: "hu", targetId: OUTFIT_ID }),
    ]),
    extraCharacters: [{ characterId: "hu", inRoster: true }],
  });
  other.completeStory(outfitStory({ ownerCharacterId: "hu" }), { narratorId: "hu" });
  throwsCode(() => other.request(OUTFIT_ID, CHARACTER_ID), "OUTFIT_OWNER_MISMATCH");
  assert.equal(other.list(CHARACTER_ID).worn.outfitId, "base");

  const revoked = makeHarness(t);
  revoked.completeStory(outfitStory());
  revoked.commit(revoked.request(OUTFIT_ID).pending);
  revoked.store.db
    .prepare("DELETE FROM discovery_outfit_ownership WHERE story_id = ?")
    .run(STORY_ID);
  const afterRevoke = revoked.list();
  assert.equal(afterRevoke.worn.outfitId, OUTFIT_ID);
  assert.equal(afterRevoke.worn.available, false);
  throwsCode(() => revoked.request(OUTFIT_ID), "OUTFIT_NOT_OWNED");
  assert.equal(revoked.list().worn.outfitId, OUTFIT_ID);
  revoked.commit(revoked.request("base").pending);
  assert.equal(revoked.list().worn.outfitId, "base");
});

test("POL-OUTFIT-004 未发布与素材不可用拒绝提交，重启不偷偷重置已穿身份", (t) => {
  const pendingHarness = makeHarness(t);
  pendingHarness.completeStory(outfitStory());
  const pending = pendingHarness.request(OUTFIT_ID).pending;
  pendingHarness.useCatalog(
    fixtureCatalog([outfitStory({ assetAvailable: false })]),
  );
  pendingHarness.reopen();
  const unavailablePending = pendingHarness.list();
  assert.equal(unavailablePending.worn.outfitId, "base");
  assert.equal(unavailablePending.pending.outfitId, OUTFIT_ID);
  assert.equal(unavailablePending.pending.available, false);
  throwsCode(() => pendingHarness.request(OUTFIT_ID), "OUTFIT_UNAVAILABLE");
  throwsCode(() => pendingHarness.commit(pending), "OUTFIT_UNAVAILABLE");
  assert.equal(pendingHarness.list().worn.outfitId, "base");
  assert.equal(
    pendingHarness.list().pending.outfitId,
    OUTFIT_ID,
    "失败的待穿不得被吞掉",
  );
  const cancelled = pendingHarness.request("base");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.pending, null);

  // 已穿身份在版本不可用后保留；显式选回基础才恢复。
  const wornHarness = makeHarness(t);
  wornHarness.completeStory(outfitStory());
  wornHarness.commit(wornHarness.request(OUTFIT_ID).pending);
  wornHarness.useCatalog(
    fixtureCatalog([outfitStory({ assetAvailable: false })]),
  );
  wornHarness.reopen();
  const unavailableWorn = wornHarness.list();
  assert.equal(unavailableWorn.worn.outfitId, OUTFIT_ID);
  assert.equal(unavailableWorn.worn.available, false);
  assert.equal(unavailableWorn.worn.reason, "STORY_UNAVAILABLE");
  throwsCode(() => wornHarness.request(OUTFIT_ID), "OUTFIT_UNAVAILABLE");
  assert.equal(wornHarness.list().worn.outfitId, OUTFIT_ID);
  wornHarness.commit(wornHarness.request("base").pending);
  assert.equal(wornHarness.list().worn.outfitId, "base");

  let assetAvailable = true;
  const assets = makeHarness(t, {
    useStoreOutfits: false,
    isAssetAvailable: () => assetAvailable,
  });
  assets.completeStory(outfitStory());
  assetAvailable = false;
  throwsCode(() => assets.request(OUTFIT_ID), "OUTFIT_ASSET_UNAVAILABLE");
  assert.equal(assets.list().worn.outfitId, "base");
  assetAvailable = true;
  assets.commit(assets.request(OUTFIT_ID).pending);
  assert.equal(assets.list().worn.outfitId, OUTFIT_ID);
});

test("POL-OUTFIT-006 名单外与探索中的角色可保存选择，不改名单/当前角色/探索", (t) => {
  const story = outfitStory({
    storyId: "fixture.outfit.outside",
    targetId: "b.summer",
    ownerCharacterId: "b",
  });
  const h = makeHarness(t, {
    catalog: fixtureCatalog([story]),
    extraCharacters: [{ characterId: "b", exploring: true }],
    useStoreOutfits: false,
    isAssetAvailable: () => true,
  });
  h.completeStory(story, { narratorId: "b" });
  const beforeRoster = h.all("SELECT * FROM roster ORDER BY day, slot");
  const beforeCurrent = h.currentId();

  h.commit(h.request("b.summer", "b").pending, "b");
  assert.equal(h.list("b").worn.outfitId, "b.summer");
  assert.equal(h.currentId(), beforeCurrent);
  assert.deepEqual(h.all("SELECT * FROM roster ORDER BY day, slot"), beforeRoster);
  assert.equal(
    h.one("SELECT exploring FROM character_runtime WHERE character_id = 'b'").exploring,
    1,
    "保存名单外角色的衣装不得提前结束探索",
  );
  assert.equal(
    h.all("SELECT * FROM roster WHERE character_id = 'b'").length,
    0,
    "不得把名单外角色拉上桌",
  );
});

test("POL-OUTFIT-005 已穿写入失败整笔回滚，解除后同一待穿重试一次成功", (t) => {
  const h = makeHarness(t);
  h.completeStory(outfitStory());
  h.store.setNickname(CHARACTER_ID, "小凛");
  seedKeepsake(h.store);
  const before = h.businessSnapshot();
  const requested = h.request(OUTFIT_ID);

  // 只注入“已穿写入”失败；待穿、记忆、归属均为真实数据。
  h.store.db.exec(`
    CREATE TRIGGER s06l_worn_fail BEFORE INSERT ON app_state
    WHEN NEW.key GLOB 'outfit_worn:*'
    BEGIN SELECT RAISE(ABORT, 'injected worn write'); END;
  `);
  assert.throws(() => h.commit(requested.pending), /injected worn write/);
  const afterFailure = h.list();
  assert.equal(afterFailure.worn.outfitId, "base");
  assert.equal(afterFailure.pending.token, requested.pending.token);
  assert.equal(afterFailure.pending.version, requested.pending.version);
  assert.equal(afterFailure.pending.outfitId, OUTFIT_ID);
  assert.deepEqual(h.businessSnapshot(), before, "回滚后记忆/归属/数值/名单不变");

  // 解除故障后同一 token 重试成功一次，不残留半提交。
  h.store.db.exec("DROP TRIGGER s06l_worn_fail");
  h.commit(h.list().pending);
  assert.equal(h.list().worn.outfitId, OUTFIT_ID);
  assert.equal(h.list().pending, null);
  assert.deepEqual(h.businessSnapshot(), before);
  throwsCode(() => h.commit(requested.pending), "OUTFIT_PENDING_MISSING");
});

test("POL-OUTFIT-005 待穿删除失败整笔回滚，已穿旧值与待穿内容都保留", (t) => {
  const h = makeHarness(t);
  h.completeStory(outfitStory());
  seedKeepsake(h.store);
  h.commit(h.request(OUTFIT_ID).pending);
  const before = h.businessSnapshot();
  const pendingBase = h.request("base");

  h.store.db.exec(`
    CREATE TRIGGER s06l_pending_fail BEFORE DELETE ON app_state
    WHEN OLD.key GLOB 'outfit_pending:*'
    BEGIN SELECT RAISE(ABORT, 'injected pending delete'); END;
  `);
  assert.throws(() => h.commit(pendingBase.pending), /injected pending delete/);
  const afterFailure = h.list();
  assert.equal(afterFailure.worn.outfitId, OUTFIT_ID, "已穿旧值必须保留");
  assert.equal(afterFailure.pending.outfitId, "base");
  assert.equal(afterFailure.pending.token, pendingBase.pending.token);
  assert.deepEqual(h.businessSnapshot(), before);

  h.store.db.exec("DROP TRIGGER s06l_pending_fail");
  h.commit(h.list().pending);
  assert.equal(h.list().worn.outfitId, "base");
  assert.equal(h.list().pending, null);
});

test("POL-OUTFIT-005 待穿后接纳资格消失，commit拒绝且不覆盖旧穿着", (t) => {
  const h = makeHarness(t);
  h.completeStory(outfitStory());
  seedKeepsake(h.store);
  h.commit(h.request(OUTFIT_ID).pending);
  const before = h.businessSnapshot();
  const pendingBase = h.request("base");

  // 隔离构造“接纳资格消失”，不代表产品支持用户取消接纳；
  // 仅关闭外键以便删除测试角色行，保留其他数据用于核对回滚。
  h.store.db.exec("PRAGMA foreign_keys = OFF");
  h.store.db.prepare("DELETE FROM relationships WHERE character_id = ?").run(CHARACTER_ID);
  h.store.db.exec("PRAGMA foreign_keys = ON");

  throwsCode(() => h.commit(pendingBase.pending), "INVALID_CHARACTER");
  const wornRow = h.one(
    "SELECT value FROM app_state WHERE key = ?",
    `outfit_worn:${CHARACTER_ID}`,
  );
  const pendingRow = h.one(
    "SELECT value FROM app_state WHERE key = ?",
    `outfit_pending:${CHARACTER_ID}`,
  );
  assert.equal(JSON.parse(wornRow.value).outfitId, OUTFIT_ID);
  assert.equal(JSON.parse(pendingRow.value).token, pendingBase.pending.token);
  assert.deepEqual(
    h.all("SELECT * FROM discovery_outfit_ownership ORDER BY story_id"),
    before.ownership,
    "归属不得因拒绝提交而改变",
  );
});

test("POL-OUTFIT-004 素材检查非严格 true 时拒绝，不把 undefined 当可用", (t) => {
  const h = makeHarness(t, {
    useStoreOutfits: false,
    isAssetAvailable: () => undefined,
  });
  h.completeStory(outfitStory());
  throwsCode(() => h.request(OUTFIT_ID), "OUTFIT_ASSET_UNAVAILABLE");
  assert.equal(h.list().worn.outfitId, "base");
  assert.equal(h.list().pending, null);
});
