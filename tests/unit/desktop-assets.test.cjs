const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDesktopPresentation,
  getRinAnimations,
  getHuAnimations,
} = require("../../app/desktop-assets.cjs");

test("POL-DESKTOP-001 凛使用 idle-v3/wave-v2，Hu 使用真实 idle-v1，其他角色保持未接入", () => {
  const rin = getRinAnimations();
  assert.equal(rin.idle.frames.length, 8);
  assert.deepEqual(rin.idle.frameSize, { width: 256, height: 384 });
  assert.equal(rin.idle.loop, true);
  assert.equal(rin.wave.frames.length, 8);
  assert.equal(rin.wave.loop, false);
  assert.equal(rin.wave.candidate, true);

  const hu = getHuAnimations();
  assert.equal(hu.idle.frames.length, 8);
  assert.deepEqual(hu.idle.frameSize, { width: 256, height: 384 });
  assert.equal(hu.idle.loop, true);
  assert.equal(Object.hasOwn(hu, "wave"), false);

  const rinPresentation = buildDesktopPresentation("rin", "凛");
  assert.equal(rinPresentation.assetState, "ready");
  assert.equal(rinPresentation.assetLabel, "idle-v3");
  assert.equal(rinPresentation.animations.wave.candidate, true);
  const huPresentation = buildDesktopPresentation("hu", "琥珀");
  assert.equal(huPresentation.assetState, "ready");
  assert.equal(huPresentation.assetLabel, "idle-v1");
  assert.equal(huPresentation.animations.wave, undefined);
  const cheng = buildDesktopPresentation("cheng", "澄");
  assert.equal(cheng.assetState, "pending");
  assert.equal(cheng.assetLabel, "素材未接入");
  assert.equal(cheng.animations, null);
  assert.match(cheng.assetNote, /尚未接入或验证/);
  assert.equal(Object.hasOwn(rinPresentation, "memory"), false);
  assert.equal(Object.hasOwn(rinPresentation, "apiKey"), false);
});
