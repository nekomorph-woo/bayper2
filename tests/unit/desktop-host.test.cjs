const assert = require("node:assert/strict");
const test = require("node:test");
const {
  presentationAssetKey,
  nodeMatchesPresentation,
  validActivitySource,
  validRestSettled,
  validRestStand,
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
