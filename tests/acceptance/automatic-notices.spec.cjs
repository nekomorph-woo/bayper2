/* S06m Part A 正式验收：真实 SQLite、正式 storyProgress/storyWindow/
   discoveryOutcomes 与固定时钟。作者目录、资格回调和时间均为构造 fixture；
   不以 SQL 伪造显示成功，只通过 prepare → ACK 建立真实收据。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStore } = require("../../app/store.cjs");
const { createStoryWindow } = require("../../app/story-window.cjs");
const { createAutomaticBudget } = require("../../app/automatic-budget.cjs");
const { createAutomaticNotices } = require("../../app/automatic-notices.cjs");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 28, 12, 0, 0).getTime();
const SLOTS = ["fixed", "random_1", "random_2", "random_3", "random_4"];
function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function fixtureStory(storyId, type, targetId, factIds, options = {}) {
  return {
    storyId,
    type,
    targetId,
    ownerCharacterId: options.ownerCharacterId ?? null,
    themeId: options.themeId ?? "fixture-theme",
    assetAvailable: options.assetAvailable ?? true,
    nodes: factIds.map((factId, index) => ({
      nodeId: `${storyId}-node-${index + 1}`,
      factId,
      body: `fixture ${storyId} node ${index + 1}`,
    })),
  };
}

function makeHarness(t, { stories, start = START }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-notices-"));
  const clock = { ms: start };
  let currentStories = stories;
  let store;
  let notices;
  let budget;
  let seeded = false;
  let assetBlocked = false;
  let assetTruthy = false;

  function seed() {
    for (const characterId of ["a", "b", "c", "rin"]) {
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
          VALUES (?, 'waiting', ?, 0)
        `)
        .run(characterId, clock.ms);
    }
    const set = (key, value) =>
      store.db
        .prepare(`
          INSERT INTO app_state (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        .run(key, String(value));
    set("fixed_character_id", "a");
    set("current_character_id", "a");
    set("current_mode", "companion");
    set("pending_rotation", "0");
    set("last_active_at", clock.ms);
    ["a", "b"].forEach((characterId, index) => {
      store.db
        .prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)")
        .run(localDay(clock.ms), SLOTS[index], characterId);
    });
  }

  function open() {
    store = createStore(dir, {
      now: () => new Date(clock.ms),
      storyCatalog: { version: "fixture", stories: currentStories },
    });
    if (!seeded) {
      seed();
      seeded = true;
    }
    budget = createAutomaticBudget({ db: store.db, now: () => clock.ms });
    const storyWindow = createStoryWindow({
      db: store.db,
      storyProgress: store.storyProgress,
      discoveryOutcomes: store.discoveryOutcomes,
      catalog: { version: "fixture", stories: currentStories },
    });
    notices = createAutomaticNotices({
      db: store.db,
      storyProgress: store.storyProgress,
      storyWindow,
      discoveryOutcomes: store.discoveryOutcomes,
      now: () => new Date(clock.ms),
      isAssetAvailable: (source) => {
        if (assetBlocked) {
          return false;
        }
        // 明确返回 truthy 而非 true，用于验证严格资格门。
        return assetTruthy ? "yes" : true;
      },
    });
  }

  /* 用正式活动存储构造已完成日常；storyProgress.recordNode 仍自行核对
     完成状态、讲述者与每日额度。 */
  function completeDaily(activityId, characterId = "a") {
    const at = clock.ms;
    store.activities.insertScheduled({
      activityId,
      characterId,
      kind: "daily",
      at,
      durationMs: 10 * 1000,
    });
    store.activities.start(activityId, at);
    store.activities.advance(activityId, 10 * 1000, at + 10 * 1000);
    store.activities.markActionComplete(activityId, at + 10 * 1000);
    store.activities.complete(activityId, at + 10 * 1000);
    clock.ms += 10 * 1000;
  }

  const h = {
    clock,
    get store() {
      return store;
    },
    get notices() {
      return notices;
    },
    advance: (ms) => {
      clock.ms += ms;
    },
    setClock: (ms) => {
      clock.ms = ms;
    },
    prepare: (speakerId = "a") => notices.prepare({ speakerId }),
    reopen: () => {
      store.close();
      open();
    },
    useCatalog: (stories) => {
      currentStories = stories;
      store.close();
      open();
    },
    setAssetBlocked: (value) => {
      assetBlocked = value;
    },
    setAssetTruthy: (value) => {
      assetTruthy = value;
    },
    one: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    exec: (sql) => store.db.exec(sql),
    completeStory: (activityId, storyId, characterId = "a") => {
      completeDaily(activityId, characterId);
      const result = store.storyProgress.recordNode({
        activityId,
        narratorId: characterId,
        storyId,
        nodeId: `${storyId}-node-1`,
      });
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      return result;
    },
    nextDayForA: () => {
      clock.ms += DAY;
    },
    addMemory: (id = "mem-fixture") => {
      store.db
        .prepare(`
          INSERT INTO memory_entries
            (id, character_id, fact_key, origin_character_id, derived_from_entry_id,
             kind, body, trust, importance, expires_at, source_id, source_version,
             version, created_at, updated_at)
          VALUES (?, 'a', 'fixture-key', 'a', NULL,
                  'detail', 'fixture memory', 'stated', 20, NULL, 'fixture',
                  1, 1, ?, ?)
        `)
        .run(id, clock.ms, clock.ms);
    },
    seedBudgetAttempt: () => {
      const reserved = budget.reserve({
        requestId: "notices-api-fixture",
        characterId: "a",
      });
      assert.equal(reserved.reserved, true, JSON.stringify(reserved));
      assert.equal(budget.beginAttempt(reserved.token).canSend, true);
      assert.equal(budget.finish(reserved.token, "success").sent, true);
    },
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

function stableState(h) {
  return {
    memories: h.all("SELECT * FROM memory_entries ORDER BY id"),
    relationships: h.all("SELECT * FROM relationships ORDER BY character_id"),
    stats: h.all("SELECT * FROM character_stats ORDER BY character_id"),
    runtime: h.all("SELECT * FROM character_runtime ORDER BY character_id"),
    roster: h.all("SELECT * FROM roster ORDER BY day, slot"),
    interactions: h.all("SELECT * FROM interactions"),
    model: h.all("SELECT * FROM model_config"),
    appState: h.all("SELECT * FROM app_state ORDER BY key"),
    stories: h.all("SELECT * FROM story_progress ORDER BY story_id"),
    facts: h.all("SELECT * FROM story_facts ORDER BY fact_id"),
    budget: h.all("SELECT * FROM automatic_budget_attempts ORDER BY id"),
    connectors: h.all("SELECT * FROM connector_events ORDER BY id"),
    notifications: h.all("SELECT * FROM notification_presentations ORDER BY presentation_id"),
  };
}

function receiptCount(h) {
  return Number(h.one("SELECT COUNT(*) AS n FROM automatic_notice_receipts").n);
}

function ownership(h, storyId) {
  return h.one("SELECT * FROM discovery_outfit_ownership WHERE story_id = ?", storyId);
}

function ackNotice(h, notice) {
  return h.notices.acknowledge({ noticeId: notice.noticeId, token: notice.token });
}

test("POL-AUTONOTICE-001A 衣装告知准备不计数，ACK 清 pending 且不换装", (t) => {
  const outfitA = fixtureStory("outfit-a", "outfit", "outfit-a", ["fact-oa"], {
    ownerCharacterId: "a",
  });
  const warmTea = fixtureStory("outfit-warm", "outfit", "rin.warm-tea", ["fact-warm"], {
    ownerCharacterId: "rin",
  });
  const h = makeHarness(t, { stories: [outfitA, warmTea] });

  h.completeStory("a1", "outfit-a");
  assert.equal(h.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId, "outfit-a");
  h.nextDayForA();
  h.completeStory("a2", "outfit-warm");
  h.advance(72 * HOUR);
  assert.equal(h.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId, "outfit-warm");
  const requested = h.store.outfits.request({
    characterId: "rin",
    outfitId: "rin.warm-tea",
  });
  assert.equal(requested.requested, true);
  const committed = h.store.outfits.commitPending({
    characterId: "rin",
    token: requested.pending.token,
    version: requested.pending.version,
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.worn.outfitId, "rin.warm-tea");

  h.addMemory();
  h.seedBudgetAttempt();
  const before = stableState(h);
  assert.ok(before.memories.length > 0);
  assert.ok(before.relationships.length >= 4);
  assert.ok(before.roster.length > 0);
  assert.equal(before.budget.length, 1);

  const prepared = h.prepare();
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.notice.kind, "outfit");
  assert.equal(prepared.notice.storyId, "outfit-a");
  assert.equal(prepared.notice.outfitId, "outfit-a");
  assert.equal(receiptCount(h), 0, "准备不写实际显示收据");
  const ownershipBefore = ownership(h, "outfit-a");
  assert.equal(ownershipBefore.notification_pending, 1);

  const view = h.notices.getView();
  assert.equal(
    h.notices.acknowledge({ noticeId: view.noticeId, token: "old-token" }).reason,
    "STALE_TOKEN",
    "当前展示的旧 token 不写",
  );
  assert.equal(receiptCount(h), 0);
  const ack = ackNotice(h, view);
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.duplicate, false);
  assert.equal(ack.receipt.kind, "outfit");
  assert.equal(ack.receipt.presentedAt, h.clock.ms);
  assert.equal(receiptCount(h), 1);
  const shown = ownership(h, "outfit-a");
  assert.equal(shown.notification_pending, 0);
  assert.equal(shown.notification_shown_at, h.clock.ms);
  assert.equal(shown.unlocked_at, ownershipBefore.unlocked_at);
  assert.equal(shown.owner_character_id, ownershipBefore.owner_character_id);
  assert.equal(shown.outfit_id, ownershipBefore.outfit_id);
  assert.equal(h.store.outfits.getState("a").worn.outfitId, "base");
  assert.equal(h.store.outfits.getState("rin").worn.outfitId, "rin.warm-tea");
  assert.equal(h.store.outfits.getState("a").pending, null);

  const duplicate = ackNotice(h, view);
  assert.equal(duplicate.duplicate, true);
  assert.equal(receiptCount(h), 1);
  assert.equal(ownership(h, "outfit-a").notification_shown_at, shown.notification_shown_at);
  assert.equal(
    h.notices.acknowledge({ noticeId: "notice:outfit:missing", token: view.token }).reason,
    "NOTICE_UNKNOWN",
    "未知来源不写",
  );
  assert.equal(receiptCount(h), 1);

  assert.deepEqual(stableState(h), before, "ACK 不改记忆、名单、数值、故事与 API 预算");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations").n,
    0,
    "衣装告知不创建邀请",
  );

  h.reopen();
  h.advance(HOUR + 1);
  const afterRestart = h.prepare();
  assert.equal(afterRestart.prepared, true);
  assert.notEqual(afterRestart.notice.storyId, "outfit-a", "已显示内容重启后不重播");
  assert.equal(afterRestart.notice.storyId, "outfit-warm");
  assert.equal(h.notices.cancel().cancelled, true);
  assert.equal(ownership(h, "outfit-warm").notification_pending, 1, "取消保留未显示内容");
  assert.equal(receiptCount(h), 1);
  const replay = ackNotice(h, view);
  assert.equal(replay.duplicate, true);
  assert.equal(receiptCount(h), 1);
});

test("POL-AUTONOTICE-002A 相遇邀请 ACK 同落 7 日额度，手动与已处理邀请不再自动准备", (t) => {
  const stories = [
    fixtureStory("char-one", "character", "u1", ["fact-c1"]),
    fixtureStory("char-two", "character", "u2", ["fact-c2"]),
    fixtureStory("char-three", "character", "u3", ["fact-c3"]),
  ];
  const h = makeHarness(t, { stories });
  h.completeStory("c1", "char-one");
  h.nextDayForA();
  h.completeStory("c2", "char-two");
  h.nextDayForA();
  h.completeStory("c3", "char-three");
  h.addMemory();
  const before = stableState(h);

  const prepared = h.prepare();
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.notice.kind, "invitation");
  assert.equal(prepared.notice.targetCharacterId, "u1");
  assert.equal(receiptCount(h), 0);
  const created = h.store.discoveryOutcomes.getInvitationByStory({ storyId: "char-one" });
  assert.equal(created.status, "prepared");
  assert.equal(created.quotaAt, null);

  const view = h.notices.getView();
  const ack = h.notices.acknowledge({ noticeId: view.noticeId, token: view.token });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.duplicate, false);
  const displayed = h.store.discoveryOutcomes.getInvitationByStory({ storyId: "char-one" });
  assert.equal(displayed.status, "pending");
  assert.equal(displayed.displayedAt, h.clock.ms);
  assert.equal(displayed.quotaAt, h.clock.ms, "自动 ACK 同时落 7 日额度");
  assert.equal(receiptCount(h), 1);
  assert.deepEqual(stableState(h), before);

  const duplicate = h.notices.acknowledge({ noticeId: view.noticeId, token: view.token });
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    h.store.discoveryOutcomes.getInvitationByStory({ storyId: "char-one" }).quotaAt,
    displayed.quotaAt,
  );

  assert.equal(h.prepare().reason, "HOURLY_LIMIT", "显示后 1 小时内不再准备新卡");
  assert.equal(receiptCount(h), 1);
  h.store.discoveryOutcomes.deferInvitation({ invitationId: displayed.invitationId });
  h.advance(HOUR + 1);
  assert.equal(h.prepare().reason, "NO_NOTICE_CONTENT", "稍后邀请不再自动准备");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-two'").n,
    0,
  );
  h.store.discoveryOutcomes.rejectInvitation({ invitationId: displayed.invitationId });
  assert.equal(h.prepare().reason, "NO_NOTICE_CONTENT", "拒绝目标不自动重发");
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-two'").n,
    0,
    "7 日自动邀请额度阻止新邀请",
  );

  const manual = h.store.discoveryOutcomes.prepareInvitation({
    storyId: "char-two",
    source: "manual",
  });
  assert.equal(manual.prepared, true);
  h.store.discoveryOutcomes.acknowledgeInvitation({
    invitationId: manual.invitation.invitationId,
    source: "manual",
  });
  const manualShown = h.store.discoveryOutcomes.getInvitationByStory({
    storyId: "char-two",
  });
  assert.equal(manualShown.status, "pending");
  assert.equal(manualShown.quotaAt, null, "手动展示不消耗自动 7 日额度");

  h.advance(HOUR + 1);
  assert.equal(h.prepare().reason, "NO_NOTICE_CONTENT", "手动旧邀请不被自动重发");
  assert.equal(receiptCount(h), 1);
  assert.equal(
    h.store.discoveryOutcomes.getInvitationByStory({ storyId: "char-two" }).quotaAt,
    null,
  );
  assert.equal(
    h.one("SELECT COUNT(*) AS n FROM discovery_invitations WHERE story_id = 'char-three'").n,
    0,
  );
  assert.deepEqual(stableState(h), before, "邀请流程不改记忆、名单、数值与 API 预算");
});

test("POL-AUTONOTICE-003A 两类来源共享全局 1 小时/8 小时额度与精确边界", (t) => {
  const stories = [
    fixtureStory("quota-outfit-1", "outfit", "q-outfit-1", ["fact-q1"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("quota-outfit-2", "outfit", "q-outfit-2", ["fact-q2"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("quota-outfit-3", "outfit", "q-outfit-3", ["fact-q3"], {
      ownerCharacterId: "a",
    }),
    fixtureStory("quota-invite", "character", "quota-target", ["fact-qi"]),
  ];
  const h = makeHarness(t, { stories });
  h.completeStory("q1", "quota-outfit-1");
  h.nextDayForA();
  h.completeStory("q2", "quota-outfit-2");
  h.nextDayForA();
  h.completeStory("q3", "quota-outfit-3");
  h.nextDayForA();
  h.completeStory("q4", "quota-invite");
  assert.equal(h.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId, "quota-outfit-1");
  h.advance(72 * HOUR);
  assert.equal(h.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId, "quota-outfit-2");
  h.advance(72 * HOUR);
  assert.equal(h.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId, "quota-outfit-3");
  const base = h.clock.ms;
  const before = stableState(h);

  const first = h.prepare();
  assert.equal(first.prepared, true);
  assert.equal(first.notice.kind, "invitation", "最早成熟相遇先于稍后解锁衣装");
  assert.equal(ackNotice(h, first.notice).acknowledged, true);
  assert.equal(
    h.prepare("b").reason,
    "HOURLY_LIMIT",
    "换 speakerId 仍受同一小时额度限制",
  );

  h.setClock(base + HOUR - 1);
  assert.equal(h.prepare().reason, "HOURLY_LIMIT", "1 小时边界前 1ms 仍受限");
  h.setClock(base + HOUR);
  const second = h.prepare();
  assert.equal(second.prepared, true);
  assert.equal(second.notice.kind, "outfit");
  assert.equal(second.notice.storyId, "quota-outfit-1");
  ackNotice(h, second.notice);

  h.setClock(base + 2 * HOUR - 1);
  assert.equal(h.prepare().reason, "HOURLY_LIMIT");
  h.setClock(base + 2 * HOUR);
  const third = h.prepare();
  assert.equal(third.prepared, true);
  assert.equal(third.notice.storyId, "quota-outfit-2");
  ackNotice(h, third.notice);
  assert.equal(receiptCount(h), 3);

  h.reopen();
  h.setClock(base + 2 * HOUR);
  assert.equal(h.prepare().reason, "HOURLY_LIMIT", "重启保留当前小时额度");
  h.setClock(base + 3 * HOUR + 1);
  assert.equal(h.prepare().reason, "EIGHT_HOUR_LIMIT", "跨来源合计 8 小时 3 次");
  assert.equal(
    h.prepare("b").reason,
    "EIGHT_HOUR_LIMIT",
    "换 speakerId 仍受同一 8 小时额度限制",
  );
  h.setClock(base - HOUR);
  assert.equal(h.prepare().reason, "HOURLY_LIMIT", "时钟回拨不提前重开额度");
  h.setClock(base + 8 * HOUR - 1);
  assert.equal(h.prepare().reason, "EIGHT_HOUR_LIMIT", "8 小时边界前 1ms 仍受限");

  h.setClock(base + 8 * HOUR);
  const boundary = h.prepare();
  assert.equal(boundary.prepared, true, "恰好 8 小时放开最早一次");
  assert.equal(boundary.notice.storyId, "quota-outfit-3");
  const boundaryAck = ackNotice(h, boundary.notice);
  assert.equal(boundaryAck.acknowledged, true);
  assert.equal(receiptCount(h), 4);
  assert.deepEqual(stableState(h), before, "显示额度不消耗 API 预算或必需通知账本");
});

test("POL-AUTONOTICE-005A-1 资格失效与旧 token 不半确认", (t) => {
  const failOutfit = fixtureStory("fail-outfit", "outfit", "fail-outfit", ["fact-fo"], {
    ownerCharacterId: "a",
  });
  const asset = makeHarness(t, { stories: [failOutfit] });
  asset.completeStory("f1", "fail-outfit");
  asset.store.discoveryOutcomes.unlockNextOutfit();
  asset.setAssetTruthy(true);
  assert.equal(asset.prepare().reason, "NO_NOTICE_CONTENT", "truthy 不等于严格素材资格");
  asset.setAssetTruthy(false);
  const prepared = asset.prepare();
  assert.equal(prepared.prepared, true);
  asset.setAssetBlocked(true);
  const blocked = ackNotice(asset, prepared.notice);
  assert.equal(blocked.acknowledged, false);
  assert.equal(blocked.reason, "ASSET_UNAVAILABLE");
  assert.equal(receiptCount(asset), 0);
  assert.equal(ownership(asset, "fail-outfit").notification_pending, 1);
  asset.setAssetBlocked(false);
  assert.equal(
    ackNotice(asset, prepared.notice).acknowledged,
    true,
    "资格恢复后同一次展示可重试成功",
  );
  assert.equal(receiptCount(asset), 1);
  assert.equal(ownership(asset, "fail-outfit").notification_pending, 0);

  const staleStory = fixtureStory("stale-outfit", "outfit", "stale-outfit", ["fact-so"], {
    ownerCharacterId: "a",
  });
  const stale = makeHarness(t, { stories: [staleStory] });
  stale.completeStory("s1", "stale-outfit");
  stale.store.discoveryOutcomes.unlockNextOutfit();
  const first = stale.prepare();
  const staleToken = stale.notices.acknowledge({
    noticeId: first.notice.noticeId,
    token: "stale-token",
  });
  assert.equal(staleToken.reason, "STALE_TOKEN");
  assert.equal(receiptCount(stale), 0);
  stale.notices.cancel();
  assert.equal(ownership(stale, "stale-outfit").notification_pending, 1);
  const reprepared = stale.prepare();
  assert.equal(reprepared.prepared, true);
  assert.notEqual(reprepared.notice.token, first.notice.token);
  assert.equal(
    stale.notices.acknowledge({
      noticeId: reprepared.notice.noticeId,
      token: first.notice.token,
    }).reason,
    "STALE_TOKEN",
  );
  assert.equal(receiptCount(stale), 0);
  assert.equal(ackNotice(stale, reprepared.notice).acknowledged, true);
  assert.equal(receiptCount(stale), 1);

  const inviteStory = fixtureStory("fail-invite", "character", "fu1", ["fact-fi"]);
  const invite = makeHarness(t, { stories: [inviteStory] });
  invite.completeStory("i1", "fail-invite");
  const invitePrepared = invite.prepare();
  const invitationId = invite.store.discoveryOutcomes.getInvitationByStory({
    storyId: "fail-invite",
  }).invitationId;
  invite.store.discoveryOutcomes.deferInvitation({ invitationId });
  const invalidated = ackNotice(invite, invitePrepared.notice);
  assert.equal(invalidated.reason, "INVITATION_NOT_PREPARED");
  assert.equal(receiptCount(invite), 0);
  assert.equal(
    invite.store.discoveryOutcomes.getInvitationByStory({ storyId: "fail-invite" }).quotaAt,
    null,
  );
  invite.store.discoveryOutcomes.reopenInvitation({ invitationId });
  assert.equal(
    ackNotice(invite, invitePrepared.notice).acknowledged,
    true,
    "邀请恢复 prepared 后同一次展示可重试成功",
  );
  const shown = invite.store.discoveryOutcomes.getInvitationByStory({ storyId: "fail-invite" });
  assert.equal(shown.status, "pending");
  assert.equal(shown.quotaAt, invite.clock.ms);
  assert.equal(receiptCount(invite), 1);

  const hiddenStory = fixtureStory("hidden-outfit", "outfit", "hidden-outfit", ["fact-ho"], {
    ownerCharacterId: "a",
  });
  const hidden = makeHarness(t, { stories: [hiddenStory] });
  hidden.completeStory("h1", "hidden-outfit");
  hidden.store.discoveryOutcomes.unlockNextOutfit();
  assert.equal(hidden.store.storyProgress.getProgress("hidden-outfit").available, true);
  hidden.useCatalog([{ ...hiddenStory, assetAvailable: false }]);
  const hiddenProgress = hidden.store.storyProgress.getProgress("hidden-outfit");
  assert.equal(hiddenProgress.available, false);
  assert.equal(hiddenProgress.reason, "ASSET_UNAVAILABLE");
  assert.equal(hidden.prepare().reason, "NO_NOTICE_CONTENT");
  assert.equal(receiptCount(hidden), 0, "目录下架不写实际显示收据");
  assert.equal(ownership(hidden, "hidden-outfit").notification_pending, 1);
});

test("POL-AUTONOTICE-005A-2 数据库写入失败时整笔回滚并可重试一次", (t) => {
  const outfitStory = fixtureStory("rollback-outfit", "outfit", "rollback-outfit", ["fact-ro"], {
    ownerCharacterId: "a",
  });
  const outfitStoryTwo = fixtureStory(
    "rollback-outfit-2",
    "outfit",
    "rollback-outfit-2",
    ["fact-ro2"],
    { ownerCharacterId: "a" },
  );
  const outfit = makeHarness(t, { stories: [outfitStory, outfitStoryTwo] });
  outfit.completeStory("r1", "rollback-outfit");
  outfit.store.discoveryOutcomes.unlockNextOutfit();
  const outfitPrepared = outfit.prepare();
  outfit.exec(`
    CREATE TRIGGER fail_receipt BEFORE INSERT ON automatic_notice_receipts
    BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END
  `);
  assert.throws(
    () => ackNotice(outfit, outfitPrepared.notice),
    /forced receipt failure/,
  );
  assert.equal(receiptCount(outfit), 0);
  assert.equal(ownership(outfit, "rollback-outfit").notification_pending, 1);
  assert.equal(
    outfit.store.discoveryOutcomes.getOutfitOwnership({ storyId: "rollback-outfit" })
      .notificationShownAt,
    null,
  );
  outfit.exec("DROP TRIGGER fail_receipt");
  assert.equal(ackNotice(outfit, outfitPrepared.notice).acknowledged, true);
  assert.equal(receiptCount(outfit), 1);
  assert.equal(ownership(outfit, "rollback-outfit").notification_pending, 0);

  outfit.nextDayForA();
  outfit.completeStory("r3", "rollback-outfit-2");
  outfit.advance(72 * HOUR);
  assert.equal(
    outfit.store.discoveryOutcomes.unlockNextOutfit().outfit.storyId,
    "rollback-outfit-2",
  );
  const ownershipPrepared = outfit.prepare();
  assert.equal(ownershipPrepared.notice.storyId, "rollback-outfit-2");
  outfit.exec(`
    CREATE TRIGGER fail_ownership_ack BEFORE UPDATE ON discovery_outfit_ownership
    BEGIN SELECT RAISE(ABORT, 'forced ownership failure'); END
  `);
  assert.throws(
    () => ackNotice(outfit, ownershipPrepared.notice),
    /forced ownership failure/,
  );
  assert.equal(receiptCount(outfit), 1, "衣装确认失败必须回滚已插入收据");
  const ownershipPending = ownership(outfit, "rollback-outfit-2");
  assert.equal(ownershipPending.notification_pending, 1);
  assert.equal(ownershipPending.notification_shown_at, null);
  outfit.exec("DROP TRIGGER fail_ownership_ack");
  assert.equal(
    ackNotice(outfit, ownershipPrepared.notice).acknowledged,
    true,
    "删除 trigger 后同 token 重试一次成功",
  );
  assert.equal(receiptCount(outfit), 2);
  assert.equal(ownership(outfit, "rollback-outfit-2").notification_pending, 0);

  const inviteStory = fixtureStory("rollback-invite", "character", "rv1", ["fact-ri"]);
  const invite = makeHarness(t, { stories: [inviteStory] });
  invite.completeStory("r2", "rollback-invite");
  const invitePrepared = invite.prepare();
  invite.exec(`
    CREATE TRIGGER fail_invitation_ack BEFORE UPDATE ON discovery_invitations
    BEGIN SELECT RAISE(ABORT, 'forced invitation failure'); END
  `);
  assert.throws(
    () => ackNotice(invite, invitePrepared.notice),
    /forced invitation failure/,
  );
  assert.equal(receiptCount(invite), 0, "发现确认失败必须回滚已插入收据");
  const preparedRow = invite.store.discoveryOutcomes.getInvitationByStory({
    storyId: "rollback-invite",
  });
  assert.equal(preparedRow.status, "prepared");
  assert.equal(preparedRow.displayedAt, null);
  assert.equal(preparedRow.quotaAt, null);
  invite.exec("DROP TRIGGER fail_invitation_ack");
  assert.equal(ackNotice(invite, invitePrepared.notice).acknowledged, true);
  assert.equal(receiptCount(invite), 1);
  assert.equal(
    invite.store.discoveryOutcomes.getInvitationByStory({ storyId: "rollback-invite" })
      .quotaAt,
    invite.clock.ms,
  );
});
