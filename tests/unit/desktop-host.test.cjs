const assert = require("node:assert/strict");
const test = require("node:test");
const {
  presentationAssetKey,
  nodeMatchesPresentation,
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
