/* 角色画布 IPC 来源校验：节点/进度只接受当前角色窗口。 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { acceptsCanvasIpc } = require("../../app/desktop/canvas-ipc.cjs");

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
