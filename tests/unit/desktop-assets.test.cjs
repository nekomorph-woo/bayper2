const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildDesktopPresentation,
  getActivitySupport,
  getRinAnimations,
  getHuAnimations,
  getChengAnimations,
  isOutfitAssetAvailable,
} = require("../../app/desktop-assets.cjs");

const OUTFIT_ID = "rin.warm-tea";

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
  // 睡眠运行切片：drowsy/sleep 是待视觉验收的正式运行候选，不冒充已发布。
  assert.equal(rin.drowsy.frames.length, 8);
  assert.match(rin.drowsy.frames[0], /drowsy-pixel-v2-canvas256\/frame-00\.png$/);
  assert.equal(rin.drowsy.loop, false);
  assert.equal(rin.drowsy.candidate, true);
  assert.deepEqual(rin.drowsy.frameSize, { width: 256, height: 384 });
  assert.equal(rin.sleep.frames.length, 8);
  assert.match(rin.sleep.frames[0], /sleep-pixel-v2-canvas256\/frame-00\.png$/);
  assert.equal(rin.sleep.loop, true);
  assert.equal(rin.sleep.candidate, true);
  assert.deepEqual(rin.sleep.frameSize, { width: 256, height: 384 });
  // 工作结束短反应候选：与六动作共用 256×384 画布和脚锚，仍标记候选。
  assert.equal(rin.happy.frames.length, 8);
  assert.match(rin.happy.frames[0], /happy-pixel-v4\/frame-00\.png$/);
  assert.deepEqual(rin.happy.durations, [250, 120, 180, 250, 350, 180, 160, 300]);
  assert.equal(rin.happy.loop, false);
  assert.equal(rin.happy.candidate, true);
  assert.deepEqual(rin.happy.frameSize, { width: 256, height: 384 });
  // 七动作共同并集仍为 216×314；happy 不改变 scale/窗口/脚锚。
  assert.deepEqual(rin.display.visibleBox, { x: 31, y: 68, width: 216, height: 314 });
  assert.ok(Math.abs(rin.display.scale - 128 / 314) < 1e-12);
  assert.equal(rin.display.windowWidth, 89);
  assert.equal(rin.display.windowHeight, 128);
  assert.ok(Math.abs(rin.display.footAnchor.x - 97 * (128 / 314)) < 1e-9);
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
  // 基础衣装不是衣装候选，不凭空新增 outfitCandidate 字段。
  assert.equal(Object.hasOwn(rinPresentation, "outfitCandidate"), false);
  for (const [characterId, label] of [["hu", "琥珀"], ["cheng", "澄"]]) {
    const presentation = buildDesktopPresentation(characterId, label);
    assert.equal(presentation.assetState, "ready");
    assert.equal(presentation.assetLabel, "idle/wave/stretch 候选");
    assert.match(presentation.assetNote, /候选/);
    assert.match(presentation.assetNote, /尚未/);
    assert.equal(presentation.animations.display.targetPt, 128);
    assert.equal(Object.hasOwn(presentation, "outfitCandidate"), false);
    // 未接入坐姿素材的角色保持 null，不借用凛的休息表现。
    assert.equal(presentation.animations.sit, null);
    // 睡眠素材只属于凛，其他角色不临时借图或换服装。
    assert.equal(presentation.animations.drowsy ?? null, null);
    assert.equal(presentation.animations.sleep ?? null, null);
    assert.equal(presentation.animations.happy ?? null, null);
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

test("POL-OUTFIT-007 温茶候选三动作独立映射，缺动作保持 null 且无基础衣装回退", () => {
  const presentation = buildDesktopPresentation("rin", "凛", OUTFIT_ID);
  assert.equal(presentation.assetState, "ready");
  assert.equal(presentation.outfitId, OUTFIT_ID);
  assert.equal(presentation.outfitCandidate, true);
  assert.match(presentation.assetLabel, /warm-tea/);
  assert.match(presentation.assetNote, /候选/);
  assert.match(
    presentation.animations.idle.frames[0],
    /outfits\/warm-tea\/animations\/idle-pixel-v2\/frame-00\.png$/,
  );
  assert.match(
    presentation.animations.wave.frames[0],
    /outfits\/warm-tea\/animations\/wave-pixel-v1\/frame-00\.png$/,
  );
  assert.match(
    presentation.animations.stretch.frames[0],
    /outfits\/warm-tea\/animations\/stretch-pixel-v2-canvas320\/frame-00\.png$/,
  );
  for (const name of ["idle", "wave", "stretch"]) {
    assert.equal(presentation.animations[name].candidate, true);
    assert.deepEqual(presentation.animations[name].frameSize, { width: 320, height: 384 });
    assert.equal(presentation.animations[name].frames.length, 8);
  }
  // 缺失动作必须明确为 null，不能用基础衣服或其他动作冒充。
  for (const name of ["sit", "drowsy", "sleep", "happy"]) {
    assert.equal(presentation.animations[name], null, `温茶不应借用 ${name}`);
  }
  assert.deepEqual(presentation.animations.display.visibleBox, {
    x: 67,
    y: 72,
    width: 203,
    height: 304,
  });
  assert.equal(presentation.animations.display.windowWidth, 86);
  assert.equal(presentation.animations.display.windowHeight, 128);
  assert.ok(Math.abs(presentation.animations.display.scale - 128 / 304) < 1e-12);
  assert.ok(
    Math.abs(presentation.animations.display.footAnchor.y - 128) < 1e-9,
    "温茶脚锚在自身窗口底部",
  );
  assert.equal(
    presentation.animations.idle.frames.some((frame) => frame.includes("/rin/animations/")),
    false,
    "不得混入基础衣装帧",
  );

  // 旧两参数调用仍为基础衣装，行为不变。
  const base = buildDesktopPresentation("rin", "凛");
  assert.equal(base.assetState, "ready");
  assert.equal(base.outfitId, "base");
  assert.equal(base.animations.sit.frames.length, 8);
  assert.deepEqual(base.animations.display.visibleBox, { x: 31, y: 68, width: 216, height: 314 });

  // 日常资格随当前衣装；温茶只有伸展，不拿基础动作冒充。探索保持全局边界。
  const outfitDaily = getActivitySupport("rin", "daily", OUTFIT_ID);
  assert.equal(outfitDaily.available, true);
  assert.equal(outfitDaily.candidate, "stretch-pixel-v2-canvas320");
  assert.match(outfitDaily.note, /候选/);
  assert.equal(getActivitySupport("rin", "daily").candidate, "stretch-pixel-v2-canvas256");
  assert.equal(getActivitySupport("rin", "exploration", OUTFIT_ID).available, true);

  // 衣装不属于该角色时不得借用凛的帧。
  const wrongOwner = buildDesktopPresentation("hu", "琥珀", OUTFIT_ID);
  assert.notEqual(wrongOwner.assetState, "ready");
  assert.equal(wrongOwner.animations, null);
  assert.equal(wrongOwner.reason, "OUTFIT_UNAVAILABLE");
});

test("POL-OUTFIT-004 衣装目录可隔离注入；缺失目录明确不可用", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(
    __dirname,
    "..",
    "..",
    "assets",
    "characters",
    "rin",
    "outfits",
    "warm-tea",
  );
  fs.cpSync(source, path.join(root, "rin", "outfits", "warm-tea"), { recursive: true });

  const injected = buildDesktopPresentation("rin", "凛", OUTFIT_ID, { assetsRoot: root });
  assert.equal(injected.assetState, "ready");
  assert.ok(injected.animations.idle.frames[0].startsWith("file:"));
  assert.match(injected.animations.idle.frames[0], new RegExp(`${root.split(path.sep).join("/")}`));
  assert.equal(isOutfitAssetAvailable("rin", OUTFIT_ID, { assetsRoot: root }), true);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-missing-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(isOutfitAssetAvailable("rin", OUTFIT_ID, { assetsRoot: empty }), false);
  const missing = buildDesktopPresentation("rin", "凛", OUTFIT_ID, { assetsRoot: empty });
  assert.equal(missing.assetState, "error");
  assert.equal(missing.animations, null);
  assert.ok(missing.error);
  assert.equal(isOutfitAssetAvailable("rin", "unknown.outfit", { assetsRoot: root }), false);
});

test("POL-OUTFIT-007 同一注入目录缓存命中后帧消失必须失效，恢复后可重新加载", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-outfit-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(
    __dirname,
    "..",
    "..",
    "assets",
    "characters",
    "rin",
    "outfits",
    "warm-tea",
  );
  fs.cpSync(source, path.join(root, "rin", "outfits", "warm-tea"), { recursive: true });

  const first = buildDesktopPresentation("rin", "凛", OUTFIT_ID, { assetsRoot: root });
  assert.equal(first.assetState, "ready");
  assert.equal(isOutfitAssetAvailable("rin", OUTFIT_ID, { assetsRoot: root }), true);

  // 同一 root 已缓存后删除真实帧：不能继续用缓存报告 ready，也不能回退基础衣装。
  const frame = path.join(
    root,
    "rin",
    "outfits",
    "warm-tea",
    "animations",
    "idle-pixel-v2",
    "frame-00.png",
  );
  fs.rmSync(frame);
  assert.equal(
    isOutfitAssetAvailable("rin", OUTFIT_ID, { assetsRoot: root }),
    false,
    "帧文件消失后不得继续报告可用",
  );
  const missing = buildDesktopPresentation("rin", "凛", OUTFIT_ID, { assetsRoot: root });
  assert.equal(missing.assetState, "error");
  assert.equal(missing.animations, null, "不得回退基础衣装帧");

  // 文件恢复后允许重新加载，而不是永久失败或沿用失效缓存。
  fs.copyFileSync(
    path.join(source, "animations", "idle-pixel-v2", "frame-00.png"),
    frame,
  );
  assert.equal(isOutfitAssetAvailable("rin", OUTFIT_ID, { assetsRoot: root }), true);
  const restored = buildDesktopPresentation("rin", "凛", OUTFIT_ID, { assetsRoot: root });
  assert.equal(restored.assetState, "ready");
  assert.ok(restored.animations.idle.frames[0].includes(root));
});
