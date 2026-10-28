/* S06m Part B runtime 边界：可见证明、ACK 去重、6/10 秒撤下与 action 路由。
   只使用受控时钟与领域 stub；真实窗口与 SQLite 由 automatic-notices-ui 覆盖。 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createAutomaticNoticeRuntime,
  ACK_HOLD_MS,
  UNACKED_MAX_MS,
} = require("../../app/automatic-notice-runtime.cjs");

function makeClock(start = 1_000_000) {
  const clock = {
    now: start,
    timers: [],
    nextId: 1,
    setTimeoutFn(fn, ms) {
      const timer = { id: clock.nextId++, at: clock.now + Math.max(0, ms), fn, cleared: false };
      clock.timers.push(timer);
      return {
        unref() {},
        clear: () => {
          timer.cleared = true;
        },
      };
    },
    clearTimeoutFn(timer) {
      if (timer?.clear) timer.clear();
    },
    advance(ms) {
      const target = clock.now + ms;
      for (;;) {
        const due = clock.timers
          .filter((timer) => !timer.cleared && timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        clock.now = due.at;
        due.cleared = true;
        due.fn();
      }
      clock.now = target;
    },
  };
  return clock;
}

function makeNoticeHarness(overrides = {}) {
  const calls = { prepare: 0, acknowledge: 0, cancel: 0 };
  let view = null;
  const notices = {
    prepare({ speakerId } = {}) {
      calls.prepare += 1;
      view = {
        noticeId: "notice:outfit:outfit-1",
        token: "domain-token",
        kind: "outfit",
        storyId: "outfit-1",
        speakerId: speakerId ?? "rin",
        ownerCharacterId: "rin",
        outfitId: "rin.warm-tea",
      };
      return { prepared: true };
    },
    getView() {
      return view;
    },
    acknowledge() {
      calls.acknowledge += 1;
      return overrides.ackResult ?? { acknowledged: true, duplicate: false };
    },
    cancel() {
      calls.cancel += 1;
    },
  };
  return { notices, calls };
}

function makeRuntime({ clock, notices, onAction = () => {} }) {
  return createAutomaticNoticeRuntime({
    notices,
    storyWindow: {
      getStory() {
        return {
          available: true,
          nodes: [{ body: "凛想在围裙前面缝个口袋。" }],
        };
      },
    },
    characterNames: { rin: "凛", hu: "琥珀" },
    now: () => clock.now,
    setTimeoutFn: (fn, ms) => clock.setTimeoutFn(fn, ms),
    clearTimeoutFn: (timer) => clock.clearTimeoutFn(timer),
    onAction,
  });
}

test("runtime 准备后生成明确文案，未满足 350ms 可见不 ACK", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const runtime = makeRuntime({ clock, notices });
  const presented = runtime.tryPresent({ speakerId: "rin" });
  assert.equal(presented.presented, true);
  assert.equal(runtime.tryPresent({ speakerId: "rin" }).reason, "NOTICE_ACTIVE");
  const payload = runtime.getPayload();
  assert.match(payload.title, /凛/);
  assert.match(payload.title, /温茶围裙/);
  assert.match(payload.body, /围裙前面缝个口袋/);
  assert.match(payload.source, /已记录的衣装故事/);
  assert.equal(payload.actionType, "outfit");

  const early = runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "NOT_VISIBLE");
  assert.equal(calls.acknowledge, 0);
  assert.equal(runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 349,
  }), false);
  assert.equal(calls.acknowledge, 0);
});

test("runtime 隐藏窗口会让旧可见证明失效，NaN 不能通过 350ms", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const runtime = makeRuntime({ clock, notices });
  runtime.tryPresent({ speakerId: "rin" });
  const payload = runtime.getPayload();
  clock.advance(350);
  assert.equal(runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: Number.NaN,
  }), false);
  assert.equal(runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  }).reason, "NOT_VISIBLE");
  assert.equal(runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 350,
  }), true);
  assert.equal(runtime.markWindowHidden(), true);
  assert.equal(runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  }).reason, "NOT_VISIBLE");
  assert.equal(calls.acknowledge, 0, "隐藏后旧证明不得确认显示");
  assert.equal(runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 350,
  }), true);
  assert.equal(runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  }).accepted, true);
  assert.equal(calls.acknowledge, 1);
});

test("runtime ACK 只用一次，重复 ACK 不续命且 6 秒后撤下副本", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const runtime = makeRuntime({ clock, notices });
  runtime.tryPresent({ speakerId: "rin" });
  const payload = runtime.getPayload();
  clock.advance(350);
  assert.equal(runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 350,
  }), true);
  const ack = runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  });
  assert.equal(ack.accepted, true);
  assert.equal(ack.duplicate, false);
  assert.equal(calls.acknowledge, 1);

  clock.advance(1000);
  const duplicate = runtime.acknowledge({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.acknowledge, 1, "重复 ACK 不再次进入领域层");
  assert.ok(runtime.getPayload(), "ACK 后保留展示副本");
  clock.advance(ACK_HOLD_MS - 1000 - 1);
  assert.ok(runtime.getPayload(), "6 秒前不得撤下");
  clock.advance(1);
  assert.equal(runtime.getPayload(), null);
  assert.equal(calls.cancel, 0, "已 ACK 的副本到期不取消领域内容");
});

test("runtime 无 ACK 最多 10 秒，撤下并保留未显示内容", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const runtime = makeRuntime({ clock, notices });
  runtime.tryPresent({ speakerId: "rin" });
  const payload = runtime.getPayload();
  clock.advance(350);
  runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 350,
  });
  clock.advance(UNACKED_MAX_MS - 350 - 1);
  assert.ok(runtime.getPayload(), "10 秒前保留");
  clock.advance(1);
  assert.equal(runtime.getPayload(), null);
  assert.equal(calls.cancel, 1, "未 ACK 到期取消本次展示，内容留给下一次机会");
});

test("runtime action 只接受当前 token 与 350ms 可见证明", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const navigations = [];
  const runtime = makeRuntime({ clock, notices, onAction: (target) => navigations.push(target) });
  runtime.tryPresent({ speakerId: "rin" });
  const payload = runtime.getPayload();
  const stale = runtime.action({
    noticeId: payload.noticeId,
    noticeToken: "old-notice-token",
    actionType: "outfit",
  });
  assert.equal(stale.reason, "STALE_NOTICE");
  clock.advance(350);
  const notVisible = runtime.action({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    actionType: "outfit",
  });
  assert.equal(notVisible.reason, "NOT_VISIBLE");
  assert.equal(navigations.length, 0);

  runtime.markVisible({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    visible: true,
    visibleMs: 350,
  });
  const action = runtime.action({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    actionType: "outfit",
  });
  assert.equal(action.accepted, true);
  assert.equal(action.navigated, true);
  assert.equal(calls.acknowledge, 1);
  assert.deepEqual(navigations, [{
    type: "outfit",
    characterId: "rin",
    outfitId: "rin.warm-tea",
  }]);
  assert.equal(runtime.getPayload(), null);
  const again = runtime.action({
    noticeId: payload.noticeId,
    noticeToken: payload.noticeToken,
    actionType: "outfit",
  });
  assert.equal(again.reason, "STALE_NOTICE");
});

test("runtime 抢占在 ACK 前取消内容，在 ACK 后只撤副本", () => {
  const clock = makeClock();
  const { notices, calls } = makeNoticeHarness();
  const runtime = makeRuntime({ clock, notices });
  runtime.tryPresent({ speakerId: "rin" });
  const first = runtime.getPayload();
  runtime.markVisible({
    noticeId: first.noticeId,
    noticeToken: first.noticeToken,
    visible: true,
    visibleMs: 350,
  });
  assert.equal(runtime.cancel(), true);
  assert.equal(calls.cancel, 1, "未确认时取消展示但保留内容");

  clock.advance(400);
  runtime.tryPresent({ speakerId: "rin" });
  const second = runtime.getPayload();
  clock.advance(350);
  runtime.markVisible({
    noticeId: second.noticeId,
    noticeToken: second.noticeToken,
    visible: true,
    visibleMs: 350,
  });
  assert.equal(runtime.acknowledge({
    noticeId: second.noticeId,
    noticeToken: second.noticeToken,
  }).accepted, true);
  const cancels = calls.cancel;
  runtime.cancel();
  assert.equal(calls.cancel, cancels, "已 ACK 后抢占不再取消领域内容");
  assert.equal(runtime.getPayload(), null);
});
