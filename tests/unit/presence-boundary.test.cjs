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

  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: true, node: "idle-loop" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: false, reason: "asset-error" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: false, reason: "child-exit" }));
  assert.doesNotThrow(() => assertBoundaryCompleted({ ok: true, reason: "no-canvas-node" }));
  assert.throws(
    () => assertBoundaryCompleted({ ok: false, reason: "timeout" }),
    (error) => error.code === "NODE_TIMEOUT" && /还没有自然收束/.test(error.message),
  );
});
