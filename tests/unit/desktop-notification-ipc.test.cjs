/* 通知 IPC 来源校验单元回归：只允许当前通知窗口，回执类要求真实可见。 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { acceptsNotificationIpc } = require("../../app/desktop/notification-ipc.cjs");

function fakeWindow({ visible = true, destroyed = false } = {}) {
  const webContents = { id: "notification" };
  return {
    webContents,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
  };
}

test("通知 IPC 只接受当前窗口，隐藏或非可见视图拒绝回执", () => {
  const window = fakeWindow();
  const latest = { visible: true };
  assert.equal(acceptsNotificationIpc({
    sender: window.webContents, window, latest,
  }), true);
  assert.equal(acceptsNotificationIpc({
    sender: window.webContents, window, latest, requireVisible: true,
  }), true);
  assert.equal(acceptsNotificationIpc({
    sender: { id: "canvas" }, window, latest, requireVisible: false,
  }), false);
  assert.equal(acceptsNotificationIpc({
    sender: window.webContents, window, latest: { visible: false }, requireVisible: true,
  }), false);

  const hidden = fakeWindow({ visible: false });
  assert.equal(acceptsNotificationIpc({
    sender: hidden.webContents, window: hidden, latest, requireVisible: true,
  }), false);
  assert.equal(acceptsNotificationIpc({
    sender: hidden.webContents, window: hidden, latest, requireVisible: false,
  }), true);

  const destroyed = fakeWindow({ destroyed: true });
  assert.equal(acceptsNotificationIpc({
    sender: destroyed.webContents, window: destroyed, latest,
  }), false);
});
