/* 画布 renderer 的窄接口：只接收显示状态和发送节点/拖动消息。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    onState: (callback) => {
      ipcRenderer.on("canvas:state", (_event, state) => callback(state));
    },
    nodeComplete: (node, displayKey, generation, activityId, characterId) =>
      ipcRenderer.send("canvas:node-complete", {
        node,
        displayKey,
        generation,
        activityId,
        characterId,
      }),
    activityProgress: (activityId, characterId, progress, displayKey, generation) =>
      ipcRenderer.send("canvas:activity-progress", {
        activityId,
        characterId,
        progress,
        displayKey,
        generation,
      }),
    displayState: (kind, displayKey, generation, frame) =>
      ipcRenderer.send("canvas:display-state", { kind, displayKey, generation, frame }),
    assetError: (message) => ipcRenderer.send("canvas:asset-error", message),
    dragStart: (x, y) => ipcRenderer.send("canvas:drag-start", { x, y }),
    dragMove: (x, y) => ipcRenderer.send("canvas:drag-move", { x, y }),
    dragEnd: () => ipcRenderer.send("canvas:drag-end"),
  }),
);
