const assert = require("node:assert/strict");
const test = require("node:test");
const {
  presentationAssetKey,
  nodeMatchesPresentation,
  validActivitySource,
  validRestSettled,
  validRestStand,
  validRestSleepBoundary,
} = require("../../app/desktop-host.cjs");

test("POL-DESKTOP-005 迟到节点必须匹配当前展示身份", () => {
  const rin = {
    character: { id: "rin" },
    assetState: "ready",
    animations: { idle: { frames: ["file://rin-idle-00.png"] } },
  };
  const hu = {
    character: { id: "hu" },
    assetState: "ready",
    animations: { idle: { frames: ["file://hu-idle-00.png"] } },
  };
  const pending = {
    character: { id: "cheng" },
    assetState: "pending",
    animations: null,
  };

  assert.equal(nodeMatchesPresentation(presentationAssetKey(rin), rin), true);
  assert.equal(nodeMatchesPresentation(presentationAssetKey(hu), hu), true);
  assert.equal(nodeMatchesPresentation(presentationAssetKey(rin), hu), false);
  assert.equal(nodeMatchesPresentation(presentationAssetKey(rin), pending), false);
  assert.equal(nodeMatchesPresentation("", rin), false);
});

test("S06h 活动回报必须匹配展示角色、显示代次与明确活动 ID", () => {
  const presentation = {
    character: { id: "rin" },
    assetState: "ready",
    animations: { idle: { frames: ["file://rin-idle-00.png"] } },
  };
  const base = {
    activityId: "daily-1",
    characterId: "rin",
    displayKey: presentationAssetKey(presentation),
    generation: 7,
  };
  assert.equal(validActivitySource(base, presentation, 7), true);
  // 旧活动/旧代次/别的角色/旧展示身份/缺活动 ID 都不能借当前展示身份补完成。
  assert.equal(validActivitySource({ ...base, characterId: "hu" }, presentation, 7), false);
  assert.equal(validActivitySource({ ...base, generation: 6 }, presentation, 7), false);
  assert.equal(validActivitySource({ ...base, generation: null }, presentation, 7), false);
  assert.equal(validActivitySource({ ...base, displayKey: "old-key" }, presentation, 7), false);
  assert.equal(validActivitySource({ ...base, activityId: "" }, presentation, 7), false);
  assert.equal(validActivitySource(base, null, 7), false);
});

test("S07 休息完成必须匹配本次 token、展示身份、末帧与显示代次", () => {
  const presentation = {
    character: { id: "rin" },
    assetState: "ready",
    animations: {
      idle: { frames: ["file://rin-idle-00.png"] },
      sit: { frames: ["file://rin-sit-00.png", "file://rin-sit-07.png"] },
    },
    resting: true,
    restToken: 3,
  };
  const base = {
    node: "rest-settled",
    restToken: 3,
    displayKey: presentationAssetKey(presentation),
    generation: 9,
  };
  const lastFrame = "file://rin-sit-07.png";
  const shownKey = presentationAssetKey(presentation);
  assert.equal(validRestSettled(base, presentation, 9, shownKey, lastFrame), true);
  // 上一轮/缺失/换身份/旧代次/非末帧都不能放行本次过渡。
  assert.equal(validRestSettled({ ...base, restToken: 2 }, presentation, 9, shownKey, lastFrame), false);
  assert.equal(validRestSettled({ ...base, restToken: 0 }, presentation, 9, shownKey, lastFrame), false);
  assert.equal(
    validRestSettled(base, { ...presentation, restToken: 4 }, 9, shownKey, lastFrame),
    false,
  );
  assert.equal(
    validRestSettled({ ...base, displayKey: "old-key" }, presentation, 9, shownKey, lastFrame),
    false,
  );
  assert.equal(validRestSettled({ ...base, generation: 8 }, presentation, 9, shownKey, lastFrame), false);
  assert.equal(validRestSettled(base, presentation, 9, "old-key", lastFrame), false);
  assert.equal(validRestSettled(base, presentation, 9, shownKey, "file://rin-sit-00.png"), false);
  assert.equal(validRestSettled(base, null, 9, shownKey, lastFrame), false);
  // 起身短节点只校验当前身份/代次，不证明坐下完成。
  assert.equal(validRestStand({ ...base, node: "rest-stand" }, presentation, 9), true);
  assert.equal(validRestStand({ ...base, generation: 8 }, presentation, 9), false);
});

test("S07 睡眠边界只接受本次 token/身份/代次下的真实收束帧与种类", () => {
  const frames = (name) => Array.from({ length: 8 }, (_, index) =>
    `file://rin-${name}-0${index}.png`);
  const presentation = {
    character: { id: "rin" },
    assetState: "ready",
    animations: {
      idle: { frames: ["file://rin-idle-00.png"] },
      drowsy: { frames: frames("drowsy") },
      sleep: { frames: frames("sleep") },
    },
    resting: true,
    restToken: 5,
  };
  const shownKey = presentationAssetKey(presentation);
  const base = {
    node: "rest-sleep-boundary",
    restToken: 5,
    displayKey: shownKey,
    generation: 11,
    boundaryKind: "drowsy-end",
  };
  assert.equal(
    validRestSleepBoundary(base, presentation, 11, shownKey, frames("drowsy")[7]),
    true,
  );
  assert.equal(
    validRestSleepBoundary(
      { ...base, boundaryKind: "sleep-end" },
      presentation,
      11,
      shownKey,
      frames("sleep")[7],
    ),
    true,
  );
  assert.equal(
    validRestSleepBoundary(
      { ...base, boundaryKind: "wake-end" },
      presentation,
      11,
      shownKey,
      frames("drowsy")[0],
    ),
    true,
  );
  // 中间帧、错种类、旧 token/代次/身份、缺种类与旧 settled 都不得放行。
  assert.equal(
    validRestSleepBoundary(base, presentation, 11, shownKey, frames("drowsy")[3]),
    false,
  );
  assert.equal(
    validRestSleepBoundary(
      { ...base, boundaryKind: "sleep-end" },
      presentation,
      11,
      shownKey,
      frames("drowsy")[7],
    ),
    false,
  );
  assert.equal(
    validRestSleepBoundary({ ...base, boundaryKind: "" }, presentation, 11, shownKey, frames("drowsy")[7]),
    false,
  );
  assert.equal(
    validRestSleepBoundary({ ...base, restToken: 4 }, presentation, 11, shownKey, frames("drowsy")[7]),
    false,
  );
  assert.equal(
    validRestSleepBoundary(base, presentation, 10, shownKey, frames("drowsy")[7]),
    false,
  );
  assert.equal(
    validRestSleepBoundary(base, presentation, 11, "old-key", frames("drowsy")[7]),
    false,
  );
  assert.equal(
    validRestSleepBoundary(base, { ...presentation, restToken: 6 }, 11, shownKey, frames("drowsy")[7]),
    false,
  );
});
