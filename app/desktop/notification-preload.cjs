/* 通知气泡的窄接口：只接收待显示内容，并按实际可见条目回执。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "notifications",
  Object.freeze({
    onUpdate: (callback) => {
      ipcRenderer.on("notifications:update", (_event, view) => callback(view));
    },
    ack: (presentationId, token, eventIds) =>
      ipcRenderer.send("notifications:ack", { presentationId, token, eventIds }),
    visible: (presentationId, eventIds, complete) =>
      ipcRenderer.send("notifications:visible", { presentationId, eventIds, complete }),
    resize: (height) => ipcRenderer.send("notifications:size", { height }),
    close: (presentationId, token) =>
      ipcRenderer.send("notifications:close", { presentationId, token }),
    companionVisible: (noticeId, noticeToken, visibleMs, complete) =>
      ipcRenderer.send("companion-notice:visible", {
        noticeId, noticeToken, visibleMs, visible: complete !== false,
      }),
    companionAck: (noticeId, noticeToken) =>
      ipcRenderer.send("companion-notice:ack", { noticeId, noticeToken }),
    companionAction: (noticeId, noticeToken, action) =>
      ipcRenderer.send("companion-notice:action", { noticeId, noticeToken, action }),
    companionClose: (noticeId, noticeToken) =>
      ipcRenderer.send("companion-notice:close", { noticeId, noticeToken }),
    onCompanionResult: (callback) => {
      ipcRenderer.on("companion-notice:result", (_event, result) => callback(result));
    },
    onAckResult: (callback) => {
      ipcRenderer.on("notifications:ack-result", (_event, result) => callback(result));
    },
  }),
);
