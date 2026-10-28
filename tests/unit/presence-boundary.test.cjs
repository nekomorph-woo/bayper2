const assert = require("node:assert/strict");
const test = require("node:test");
const {
  boundaryTimeoutFor,
  assertBoundaryCompleted,
  NODE_TIMEOUT_MARGIN_MS,
} = require("../../app/presence-boundary.cjs");

test("POL-DESKTOP-005 手动切换等待时长来自 manifest，超时明确失败", () => {
  const presentation = {
    animations: {
      idle: { durations: [650, 180, 250, 80, 110, 80, 180, 350] },
      wave: { durations: [180, 160, 180, 180, 180, 180, 180, 260] },
    },
  };
  assert.equal(boundaryTimeoutFor(presentation), 1880 + NODE_TIMEOUT_MARGIN_MS);

  // 坐姿/起身逆序的短节点也计入，不能用旧的 idle/wave 时长误判超时。
  const resting = {
    animations: {
      ...presentation.animations,
      sit: { durations: [300, 150, 160, 180, 180, 180, 200, 600] },
    },
  };
  assert.equal(boundaryTimeoutFor(resting), 1950 + NODE_TIMEOUT_MARGIN_MS);

  // 短反应暂停 idle：上限必须是串行 happy + idle，而不是 max(happy, idle)。
  const withReaction = {
    animations: {
      ...presentation.animations,
      happy: { durations: [250, 120, 180, 250, 350, 180, 160, 300] },
    },
  };
  assert.equal(
    boundaryTimeoutFor(withReaction),
    1880 + 1790 + NODE_TIMEOUT_MARGIN_MS,
  );

  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: true, node: "idle-loop" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: false, reason: "asset-error" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: false, reason: "child-exit" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: true, reason: "no-canvas-node" }));
  assert.throws(
    () => assertBoundaryCompleted({ ok: false, reason: "timeout" }),
    (error) => error.code === "NODE_TIMEOUT" && /还没有自然收束/.test(error.message),
  );
});
