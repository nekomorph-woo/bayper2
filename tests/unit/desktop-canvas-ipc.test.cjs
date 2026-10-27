/* 角色画布 IPC 来源校验：节点/进度只接受当前角色窗口。 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { acceptsCanvasIpc, acceptsCanvasHit, normalizeRestBoundaryKind } =
  require("../../app/desktop/canvas-ipc.cjs");

function fakeWindow({ destroyed = false } = {}) {
  return {
    webContents: { id: "canvas" },
    isDestroyed: () => destroyed,
  };
}

test("画布节点/进度 IPC 只接受当前角色窗口，其他窗口不能冒充", () => {
  const window = fakeWindow();
  assert.equal(acceptsCanvasIpc({ sender: window.webContents, window }), true);
  assert.equal(acceptsCanvasIpc({ sender: { id: "notification" }, window }), false);
  assert.equal(acceptsCanvasIpc({ sender: window.webContents, window: null }), false);
  const destroyed = fakeWindow({ destroyed: true });
  assert.equal(acceptsCanvasIpc({ sender: destroyed.webContents, window: destroyed }), false);
});

test("POL-HIT-002 命中消息同时校验发送窗口、状态代次和展示身份", () => {
  const window = fakeWindow();
  const base = {
    sender: window.webContents,
    window,
    payload: { epoch: 3, displayKey: "rin", frame: "file:///frame-00.png" },
    epoch: 3,
    displayKey: "rin",
  };
  assert.equal(acceptsCanvasHit(base), true);
  assert.equal(acceptsCanvasHit({ ...base, sender: { id: "notification" } }), false);
  assert.equal(acceptsCanvasHit({ ...base, payload: { ...base.payload, epoch: 2 } }), false);
  assert.equal(acceptsCanvasHit({ ...base, payload: { ...base.payload, epoch: "3" } }), false);
  assert.equal(acceptsCanvasHit({ ...base, payload: { ...base.payload, displayKey: "hu" } }), false);
  assert.equal(acceptsCanvasHit({ ...base, payload: null }), false);
  const destroyed = fakeWindow({ destroyed: true });
  assert.equal(acceptsCanvasHit({ ...base, window: destroyed, sender: destroyed.webContents }), false);
});

test("S07 睡眠边界种类只允许真实收束点", () => {
  assert.equal(normalizeRestBoundaryKind("drowsy-end"), "drowsy-end");
  assert.equal(normalizeRestBoundaryKind("sleep-end"), "sleep-end");
  assert.equal(normalizeRestBoundaryKind("wake-end"), "wake-end");
  assert.equal(normalizeRestBoundaryKind("drowsy"), "");
  assert.equal(normalizeRestBoundaryKind(""), "");
  assert.equal(normalizeRestBoundaryKind(null), "");
});
