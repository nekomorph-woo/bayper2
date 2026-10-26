const assert = require("node:assert/strict");
const test = require("node:test");
const {
  presentationAssetKey,
  nodeMatchesPresentation,
  validActivitySource,
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
