/* 角色画布 IPC 的窄校验：播放事实只接受当前角色窗口本身，通知窗口等其他
   webContents 不能用同名通道冒充节点或进度。 */
function acceptsCanvasIpc({ sender, window }) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
    return false;
  }
  return sender === window.webContents;
}

module.exports = { acceptsCanvasIpc };
