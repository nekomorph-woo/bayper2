/* 角色画布 IPC 的窄校验：播放事实只接受当前角色窗口本身，通知窗口等其他
   webContents 不能用同名通道冒充节点或进度。 */
function acceptsCanvasIpc({ sender, window }) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
    return false;
  }
  return sender === window.webContents;
}

/* 命中消息还必须带当前状态代次与展示身份；旧 renderer 即使仍连着同一
   webContents，也不能用过期帧或别的角色改变鼠标穿透。 */
function acceptsCanvasHit({ sender, window, payload, epoch, displayKey }) {
  if (!acceptsCanvasIpc({ sender, window })) return false;
  if (!payload || !Number.isInteger(payload.epoch) || payload.epoch !== epoch) return false;
  if (typeof displayKey !== "string" || payload.displayKey !== displayKey) return false;
  return true;
}

module.exports = { acceptsCanvasIpc, acceptsCanvasHit };
