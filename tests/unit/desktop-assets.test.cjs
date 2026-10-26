const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDesktopPresentation,
  getActivitySupport,
  getRinAnimations,
  getHuAnimations,
} = require("../../app/desktop-assets.cjs");

test("POL-DESKTOP-007 新版凛 idle/wave/stretch 与 Hu 旧 idle 同尺度裁剪，其他角色 pending", () => {
  const rin = getRinAnimations();
  assert.equal(rin.idle.frames.length, 8);
  assert.match(rin.idle.frames[0], /idle-pixel-v2\/frame-00\.png$/);
  assert.deepEqual(rin.idle.frameSize, { width: 256, height: 384 });
  assert.equal(rin.idle.loop, true);
  assert.equal(rin.wave.frames.length, 8);
  assert.match(rin.wave.frames[0], /wave-pixel-v1\/frame-00\.png$/);
  assert.equal(rin.wave.loop, false);
  assert.equal(rin.wave.candidate, false);
  assert.equal(rin.stretch.frames.length, 8);
  assert.match(rin.stretch.frames[0], /stretch-pixel-v2-canvas256\/frame-00\.png$/);
  assert.equal(rin.stretch.loop, false);
  assert.equal(rin.stretch.candidate, false);
  assert.deepEqual(rin.stretch.frameSize, { width: 256, height: 384 });
  assert.deepEqual(rin.idle.frameSize, rin.stretch.frameSize);
  assert.equal(rin.display.windowWidth, 88);
  assert.equal(rin.display.windowHeight, 128);
  assert.ok(Math.abs(rin.display.footAnchor.y - 128) < 1e-6);

  const hu = getHuAnimations();
  assert.match(hu.idle.frames[0], /idle-v1\/frame-00\.png$/);
  assert.equal(hu.display.windowWidth, 87);
  assert.equal(hu.display.windowHeight, 128);

  const rinPresentation = buildDesktopPresentation("rin", "凛");
  assert.equal(rinPresentation.assetState, "ready");
  assert.equal(rinPresentation.assetLabel, "idle-pixel-v2");
  assert.equal(rinPresentation.animations.display.targetPt, 128);
  const huPresentation = buildDesktopPresentation("hu", "琥珀");
  assert.equal(huPresentation.assetState, "ready");
  assert.equal(huPresentation.assetLabel, "idle-v1");
  assert.match(huPresentation.assetNote, /旧版/);
  assert.match(huPresentation.assetNote, /新画风未完成/);
  assert.equal(huPresentation.animations.display.targetPt, 128);
  const cheng = buildDesktopPresentation("cheng", "澄");
  assert.equal(cheng.assetState, "pending");
  assert.equal(cheng.animations, null);
  assert.match(cheng.assetNote, /尚未接入或验证/);
  // 只有凛的伸展动作获准接入日常；其他角色不借图，也不静默 fallback。
  assert.equal(getActivitySupport("rin", "daily").available, true);
  assert.equal(
    getActivitySupport("rin", "daily").candidate,
    "stretch-pixel-v2-canvas256",
  );
  assert.equal(getActivitySupport("hu", "daily").available, false);
  assert.equal(getActivitySupport("hu", "daily").reason, "ACTIVITY_ACTION_UNAVAILABLE");
  assert.equal(getActivitySupport("cheng", "daily").available, false);
  assert.equal(Object.hasOwn(rinPresentation, "memory"), false);
  assert.equal(Object.hasOwn(rinPresentation, "apiKey"), false);
});
