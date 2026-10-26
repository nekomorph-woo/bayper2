/* 通知 IPC 的窄校验：只接受当前通知窗口本身，且回执类消息要求窗口真实可见。 */
function acceptsNotificationIpc({ sender, window, latest, requireVisible = false }) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
    return false;
  }
  if (sender !== window.webContents) return false;
  if (!requireVisible) return true;
  return latest?.visible === true && window.isVisible() === true;
}

module.exports = { acceptsNotificationIpc };
