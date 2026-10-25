const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDesktopPresentation,
  getRinAnimations,
  getHuAnimations,
} = require("../../app/desktop-assets.cjs");

test("POL-DESKTOP-007 新版凛 idle/wave 与 Hu 旧 idle 同尺度裁剪，其他角色 pending", () => {
  const rin = getRinAnimations();
  assert.equal(rin.idle.frames.length, 8);
  assert.match(rin.idle.frames[0], /idle-pixel-v2\/frame-00\.png$/);
  assert.deepEqual(rin.idle.frameSize, { width: 256, height: 384 });
  assert.equal(rin.idle.loop, true);
  assert.equal(rin.wave.frames.length, 8);
  assert.match(rin.wave.frames[0], /wave-pixel-v1\/frame-00\.png$/);
  assert.equal(rin.wave.loop, false);
  assert.equal(rin.wave.candidate, true);
  assert.equal(rin.display.windowWidth, 90);
  assert.equal(rin.display.windowHeight, 128);
  assert.equal(rin.display.footAnchor.y, 128);

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
  assert.equal(Object.hasOwn(rinPresentation, "memory"), false);
  assert.equal(Object.hasOwn(rinPresentation, "apiKey"), false);
});
