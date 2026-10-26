/* S06g 正式作者内容验收：读取 app/content/maid-stories.json，使用真实 SQLite、
   正式 companionship 与 story-progress/discovery 入口。测试发布副本仅在内存，
   不写回正式文件；不包含 GUI、网络或真实模型。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { createCompanionshipService } = require("../../app/companionship.cjs");
const { createStoryProgress } = require("../../app/story-progress.cjs");
const { createDiscoveryOutcomes } = require("../../app/discovery-outcomes.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 26, 12, 0, 0).getTime();
const CONTENT_PATH = path.join(__dirname, "..", "..", "app", "content", "maid-stories.json");
const OFFICIAL = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8"));
const CANDIDATES = ["rin", "hu", "cheng"].map((id) => ({
  id,
  name: id === "rin" ? "凛" : id === "hu" ? "琥珀" : "澄",
  tagline: "",
  intro: "",
  traits: [],
}));
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];

function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function storyOf(storyId) {
  return OFFICIAL.stories.find((story) => story.storyId === storyId);
}

function makeHarness(t, { accepted = ["rin"], catalog = OFFICIAL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-content-"));
  const clock = { ms: START };
  const store = createStore(dir);
  store.acceptCharacter({
    characterId: accepted[0],
    day: localDay(clock.ms),
    acceptedAt: new Date(clock.ms).toISOString(),
  });
  const raw = new DatabaseSync(store.dbPath);
  raw.exec("PRAGMA foreign_keys = ON");
  const service = createCompanionshipService({
    store,
    candidates: CANDIDATES,
    now: () => new Date(clock.ms),
    random: () => 0.5,
  });
  const storyProgress = createStoryProgress({
    db: raw,
    catalog,
    now: () => new Date(clock.ms),
  });
  const discovery = createDiscoveryOutcomes({
    db: raw,
    storyProgress,
    now: () => new Date(clock.ms),
  });
  const h = {
    dir,
    raw,
    clock,
    service,
    story: storyProgress,
    discovery,
    currentId: () =>
      raw.prepare("SELECT value FROM app_state WHERE key = 'current_character_id'").get().value,
    one: (sql, ...params) => raw.prepare(sql).get(...params),
    all: (sql, ...params) => raw.prepare(sql).all(...params),
    exec: (sql) => raw.exec(sql),
    advance: (ms) => {
      clock.ms += ms;
    },
    completeDaily: (activityId) => {
      const current = h.currentId();
      const requested = service.requestActivity({
        activityId,
        characterId: current,
        kind: "daily",
      });
      assert.equal(requested.requested, true, JSON.stringify(requested));
      assert.equal(service.completeNaturalNode().started, true);
      // S06h 起日常必须由真实动作完成与自然节点收束，不能只推进计时。
      assert.equal(
        service.completeDailyAction(activityId, { characterId: current }).completed,
        true,
      );
      clock.ms += 10 * 1000;
      assert.equal(service.completeNaturalNode().completedDaily, 1);
      assert.equal(
        raw.prepare("SELECT status FROM character_activities WHERE activity_id = ?").get(activityId)
          .status,
        "completed",
      );
    },
    nextDay: () => {
      const current = h.currentId();
      service.rest();
      clock.ms += DAY;
      service.switchTo(current);
    },
    record: (activityId, storyId, nodeId) =>
      storyProgress.recordNode({
        activityId,
        narratorId: h.currentId(),
        storyId,
        nodeId,
      }),
    matureTwoNodes: (storyId, prefix) => {
      const story = storyOf(storyId);
      h.completeDaily(`${prefix}-1`);
      assert.equal(h.record(`${prefix}-1`, storyId, story.nodes[0].nodeId).outcome, "applied");
      h.nextDay();
      h.completeDaily(`${prefix}-2`);
      assert.equal(h.record(`${prefix}-2`, storyId, story.nodes[1].nodeId).outcome, "applied");
    },
  };
  t.after(() => {
    try {
      raw.close();
    } catch {
      // raw 已关闭时继续关闭 store 并清理目录。
    }
    try {
      store.close();
    } catch {
      // store 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("POL-CONTENT-001 正式作者目录四故事八节点与稳定归属", (t) => {
  const expected = {
    "maid.meet.rin": {
      type: "character",
      targetId: "rin",
      owner: null,
      nodes: [["window", "rin.leaves-window-seat"], ["warm-tea", "rin.waits-for-warm-tea"]],
    },
    "maid.meet.hu": {
      type: "character",
      targetId: "hu",
      owner: null,
      nodes: [["pocket", "hu.keeps-small-finds"], ["return", "hu.announces-before-going"]],
    },
    "maid.meet.cheng": {
      type: "character",
      targetId: "cheng",
      owner: null,
      nodes: [["cushion", "cheng.prefers-window-cushion"], ["quiet-visit", "cheng-warms-up-slowly"]],
    },
    "maid.outfit.rin-warm-tea": {
      type: "outfit",
      targetId: "rin.warm-tea",
      owner: "rin",
      nodes: [["pocket-plan", "rin-apron-needs-pocket"], ["pocket-ready", "rin-warm-apron-finished"]],
    },
  };
  function assertAuthorSpec(catalog) {
    assert.equal(catalog.theme.id, "maid.quiet-house");
    assert.equal(catalog.theme.name, "小窝里的慢时光");
    assert.equal(catalog.stories.length, 4);
    assert.equal(catalog.stories.flatMap((story) => story.nodes).length, 8);
    for (const story of catalog.stories) {
      const want = expected[story.storyId];
      assert.ok(want, `未预期的 storyId ${story.storyId}`);
      assert.equal(story.type, want.type);
      assert.equal(story.targetId, want.targetId);
      assert.equal(story.ownerCharacterId, want.owner);
      assert.equal(story.themeId, "maid.quiet-house");
      assert.equal(story.assetAvailable, false);
      assert.deepEqual(
        story.nodes.map((node) => [node.nodeId, node.factId]),
        want.nodes,
      );
      assert.ok(story.nodes.every((node) => node.body.length > 0));
    }
  }
  assertAuthorSpec(OFFICIAL);
  const wrongOwner = JSON.parse(JSON.stringify(OFFICIAL));
  wrongOwner.stories.find((story) => story.storyId === "maid.outfit.rin-warm-tea").ownerCharacterId = "hu";
  // 错误归属由显式内容断言拒绝；不把错误副本交给正式服务，也不新增泛用校验器。
  assert.throws(
    () => assertAuthorSpec(wrongOwner),
    (error) => error.code === "ERR_ASSERTION",
  );

  const h = makeHarness(t);
  assert.deepEqual(h.story.selectNextStories(), []);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
});

test("POL-CONTENT-002 未发布素材不能推进故事、邀请或所有权", (t) => {
  const h = makeHarness(t);
  h.exec(`
    INSERT INTO memory_entries
      (id, character_id, fact_key, origin_character_id, derived_from_entry_id,
       kind, body, trust, importance, expires_at, source_id, source_version,
       version, created_at, updated_at)
    VALUES ('content-mem', 'rin', 'fixture', 'rin', NULL,
            'detail', 'fixture memory', 'stated', 20, NULL, 'fixture',
            1, 1, ${START}, ${START})
  `);
  const before = {
    roster: h.all("SELECT * FROM roster ORDER BY day, slot"),
    fixed: h.one("SELECT value FROM app_state WHERE key = 'fixed_character_id'").value,
    current: h.one("SELECT value FROM app_state WHERE key = 'current_character_id'").value,
    relationships: h.all("SELECT * FROM relationships ORDER BY character_id"),
    memory: h.all("SELECT * FROM memory_entries ORDER BY id"),
  };
  h.completeDaily("content-a1");
  const result = h.record("content-a1", "maid.meet.hu", "pocket");
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.reason, "ASSET_UNAVAILABLE");
  assert.equal(h.story.getProgress("maid.meet.hu"), null);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_facts").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM story_progress").n, 0);
  assert.equal(
    h.discovery.prepareInvitation({ storyId: "maid.meet.hu" }).reason,
    "STORY_NOT_FOUND",
  );
  assert.equal(h.discovery.unlockNextOutfit().reason, "NO_ELIGIBLE_OUTFIT");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM discovery_outfit_ownership").n, 0);
  assert.deepEqual(h.all("SELECT * FROM roster ORDER BY day, slot"), before.roster);
  assert.equal(h.one("SELECT value FROM app_state WHERE key = 'fixed_character_id'").value, before.fixed);
  assert.equal(h.one("SELECT value FROM app_state WHERE key = 'current_character_id'").value, before.current);
  assert.deepEqual(h.all("SELECT * FROM relationships ORDER BY character_id"), before.relationships);
  assert.deepEqual(h.all("SELECT * FROM memory_entries ORDER BY id"), before.memory);
});

test("POL-CONTENT-003 三种首位下六条剩余角色路径与凛衣装均真实可达", (t) => {
  // 仅在内存中模拟素材已验收，正式 maid-stories.json 保持 false。
  const published = JSON.parse(JSON.stringify(OFFICIAL));
  published.stories.forEach((story) => {
    story.assetAvailable = true;
  });
  const storyIdByTarget = {
    rin: "maid.meet.rin",
    hu: "maid.meet.hu",
    cheng: "maid.meet.cheng",
  };
  const allCharacters = ["rin", "hu", "cheng"];
  let characterPaths = 0;
  let outfitPaths = 0;

  for (const first of allCharacters) {
    for (const target of allCharacters.filter((id) => id !== first)) {
      const h = makeHarness(t, { accepted: [first], catalog: published });
      assert.equal(
        h.story.selectNextStories().some((item) => item.type === "outfit"),
        first === "rin",
        "只有已结识凛时衣装才进入候选",
      );

      const story = storyOf(storyIdByTarget[target]);
      assert.equal(story.targetId, target);
      assert.notEqual(story.targetId, first);
      h.matureTwoNodes(story.storyId, `${first}-${target}`);
      assert.equal(h.story.getProgress(story.storyId).status, "mature");
      const invite = h.discovery.prepareInvitation({ storyId: story.storyId });
      h.discovery.acknowledgeInvitation({ invitationId: invite.invitation.invitationId });

      const rosterBefore = h.all("SELECT * FROM roster ORDER BY day, slot");
      const fixedBefore = h.one("SELECT value FROM app_state WHERE key = 'fixed_character_id'").value;
      const currentBefore = h.one("SELECT value FROM app_state WHERE key = 'current_character_id'").value;
      assert.equal(
        h.discovery.acceptInvitation({ invitationId: invite.invitation.invitationId }).accepted,
        true,
      );
      assert.deepEqual(h.all("SELECT * FROM roster ORDER BY day, slot"), rosterBefore);
      assert.equal(h.one("SELECT value FROM app_state WHERE key = 'fixed_character_id'").value, fixedBefore);
      assert.equal(h.one("SELECT value FROM app_state WHERE key = 'current_character_id'").value, currentBefore);
      assert.equal(
        h.one("SELECT COUNT(*) AS n FROM relationships WHERE character_id = ?", target).n,
        1,
      );
      characterPaths += 1;

      const runsOutfit =
        (first === "rin" && target === "hu") ||
        ((first === "hu" || first === "cheng") && target === "rin");
      if (!runsOutfit) {
        continue;
      }
      outfitPaths += 1;

      h.nextDay();
      h.completeDaily(`${first}-outfit-1`);
      assert.throws(
        () =>
          h.record(
            `${first}-outfit-1`,
            "maid.outfit.rin-warm-tea",
            "pocket-ready",
          ),
        (error) => error.code === "STORY_OUT_OF_ORDER",
      );
      assert.equal(
        h.record(`${first}-outfit-1`, "maid.outfit.rin-warm-tea", "pocket-plan").outcome,
        "applied",
      );
      h.nextDay();
      h.completeDaily(`${first}-outfit-2`);
      assert.equal(
        h.record(`${first}-outfit-2`, "maid.outfit.rin-warm-tea", "pocket-ready").outcome,
        "applied",
      );
      const rinBefore = h.one("SELECT * FROM relationships WHERE character_id = 'rin'");
      const stateBefore = h.all("SELECT * FROM app_state ORDER BY key");
      const rosterBeforeUnlock = h.all("SELECT * FROM roster ORDER BY day, slot");
      const unlocked = h.discovery.unlockNextOutfit();
      assert.equal(unlocked.unlocked, true);
      assert.equal(unlocked.outfit.storyId, "maid.outfit.rin-warm-tea");
      assert.equal(unlocked.outfit.outfitId, "rin.warm-tea");
      assert.equal(unlocked.outfit.ownerCharacterId, "rin");
      assert.deepEqual(h.one("SELECT * FROM relationships WHERE character_id = 'rin'"), rinBefore);
      assert.deepEqual(h.all("SELECT * FROM app_state ORDER BY key"), stateBefore);
      assert.deepEqual(h.all("SELECT * FROM roster ORDER BY day, slot"), rosterBeforeUnlock);
      assert.equal(
        h.discovery.getOutfitOwnership({ storyId: "maid.outfit.rin-warm-tea" })
          .notificationPending,
        true,
      );
    }
  }
  assert.equal(characterPaths, 6);
  assert.equal(outfitPaths, 3);
});
