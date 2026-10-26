const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDesktopPresentation,
  getActivitySupport,
  getRinAnimations,
  getHuAnimations,
  getChengAnimations,
} = require("../../app/desktop-assets.cjs");

test("POL-DESKTOP-007 三角色各自基础动作同尺度裁剪，Hu/Cheng 保持候选标识", () => {
  const rin = getRinAnimations();
  assert.equal(rin.idle.frames.length, 8);
  assert.match(rin.idle.frames[0], /idle-pixel-v2\/frame-00\.png$/);
  assert.deepEqual(rin.idle.frameSize, { width: 256, height: 384 });
  assert.equal(rin.idle.loop, true);
  assert.equal(rin.wave.frames.length, 8);
  assert.match(rin.wave.frames[0], /wave-pixel-v1\/frame-00\.png$/);
  assert.equal(rin.wave.candidate, false);
  assert.equal(rin.stretch.frames.length, 8);
  assert.match(rin.stretch.frames[0], /stretch-pixel-v2-canvas256\/frame-00\.png$/);
  assert.equal(rin.stretch.candidate, false);
  assert.deepEqual(rin.stretch.frameSize, { width: 256, height: 384 });
  // 坐姿与站姿共用 256×384 画布；manifest 使用 output_ground_anchor。
  assert.equal(rin.sit.frames.length, 8);
  assert.match(rin.sit.frames[0], /sit-pixel-v2-canvas256\/frame-00\.png$/);
  assert.equal(rin.sit.loop, false);
  assert.equal(rin.sit.candidate, false);
  assert.deepEqual(rin.sit.frameSize, { width: 256, height: 384 });
  // 四动作并集 215×314，按 128pt 主体统一缩放，不逐动作 fit。
  assert.deepEqual(rin.display.visibleBox, { x: 32, y: 68, width: 215, height: 314 });
  assert.ok(Math.abs(rin.display.scale - 128 / 314) < 1e-12);
  assert.equal(rin.display.windowWidth, 88);
  assert.equal(rin.display.windowHeight, 128);
  assert.ok(Math.abs(rin.display.footAnchor.x - 96 * (128 / 314)) < 1e-9);
  // 坐姿最低像素低于地面锚，锚点因此比窗口底部高约 2.45pt；完整轮廓保留。
  assert.ok(Math.abs(rin.display.footAnchor.y - 308 * (128 / 314)) < 1e-9);

  const hu = getHuAnimations();
  assert.match(hu.idle.frames[0], /idle-pixel-v2-canvas320\/frame-00\.png$/);
  assert.match(hu.wave.frames[0], /wave-pixel-v3\/frame-00\.png$/);
  assert.match(hu.stretch.frames[0], /stretch-pixel-v2-canvas320\/frame-00\.png$/);
  assert.equal(hu.wave.frames.length, 4);
  assert.deepEqual(hu.idle.frameSize, { width: 320, height: 384 });
  assert.deepEqual(hu.wave.frameSize, { width: 320, height: 384 });
  assert.deepEqual(hu.stretch.frameSize, { width: 320, height: 384 });
  assert.equal(hu.idle.candidate, true);
  assert.equal(hu.wave.candidate, true);
  assert.equal(hu.stretch.candidate, true);
  assert.equal(hu.display.windowWidth, 96);
  assert.equal(hu.display.windowHeight, 128);
  assert.ok(Math.abs(hu.display.footAnchor.y - 128) < 1e-6);

  const cheng = getChengAnimations();
  assert.match(cheng.idle.frames[0], /idle-pixel-v2-canvas320\/frame-00\.png$/);
  assert.match(cheng.wave.frames[0], /wave-pixel-v1-canvas320\/frame-00\.png$/);
  assert.match(cheng.stretch.frames[0], /stretch-pixel-v2-canvas320\/frame-00\.png$/);
  assert.deepEqual(cheng.idle.frameSize, { width: 320, height: 384 });
  assert.deepEqual(cheng.stretch.frameSize, { width: 320, height: 384 });
  assert.equal(cheng.idle.candidate, true);
  assert.equal(cheng.wave.candidate, true);
  assert.equal(cheng.stretch.candidate, true);
  assert.equal(cheng.display.windowWidth, 100);
  assert.equal(cheng.display.windowHeight, 128);
  assert.ok(Math.abs(cheng.display.footAnchor.y - 128) < 1e-6);

  const rinPresentation = buildDesktopPresentation("rin", "凛");
  assert.equal(rinPresentation.assetState, "ready");
  assert.equal(rinPresentation.assetLabel, "idle-pixel-v2");
  assert.equal(rinPresentation.animations.display.targetPt, 128);
  for (const [characterId, label] of [["hu", "琥珀"], ["cheng", "澄"]]) {
    const presentation = buildDesktopPresentation(characterId, label);
    assert.equal(presentation.assetState, "ready");
    assert.equal(presentation.assetLabel, "idle/wave/stretch 候选");
    assert.match(presentation.assetNote, /候选/);
    assert.match(presentation.assetNote, /尚未/);
    assert.equal(presentation.animations.display.targetPt, 128);
    // 未接入坐姿素材的角色保持 null，不借用凛的休息表现。
    assert.equal(presentation.animations.sit, null);
  }

  // 三项基础候选可各自触发日常伸展，但不是完整动作库或正式发布。
  for (const [characterId, candidate] of [
    ["rin", "stretch-pixel-v2-canvas256"],
    ["hu", "stretch-pixel-v2-canvas320"],
    ["cheng", "stretch-pixel-v2-canvas320"],
  ]) {
    const support = getActivitySupport(characterId, "daily");
    assert.equal(support.available, true);
    assert.equal(support.candidate, candidate);
  }
  assert.equal(getActivitySupport("unknown", "daily").available, false);
  assert.equal(
    getActivitySupport("unknown", "daily").reason,
    "ACTIVITY_ACTION_UNAVAILABLE",
  );
  assert.equal(Object.hasOwn(rinPresentation, "memory"), false);
  assert.equal(Object.hasOwn(rinPresentation, "apiKey"), false);
});
