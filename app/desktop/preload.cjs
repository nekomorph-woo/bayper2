/* 画布 renderer 的窄接口：只接收显示状态和发送节点/拖动消息。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    onState: (callback) => {
      ipcRenderer.on("canvas:state", (_event, state) => callback(state));
    },
    onCancelDrag: (callback) => {
      ipcRenderer.on("canvas:cancel-drag", () => callback());
    },
    nodeComplete: (node, displayKey, generation, activityId, characterId, restToken, boundaryKind) =>
      ipcRenderer.send("canvas:node-complete", {
        node,
        displayKey,
        generation,
        activityId,
        characterId,
        restToken,
        boundaryKind,
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
    hitFrame: (frame, displayKey, generation, epoch) =>
      ipcRenderer.send("canvas:hit-frame", { frame, displayKey, generation, epoch }),
    pointerMove: (displayKey, generation, epoch) =>
      ipcRenderer.send("canvas:pointer-move", { displayKey, generation, epoch }),
    assetError: (message) => ipcRenderer.send("canvas:asset-error", message),
    // 同步返回本次拖拽 token；0 表示透明像素或过期代次拒绝，不得开始拖拽。
    dragStart: (x, y, localX, localY, displayKey, generation, epoch) =>
      ipcRenderer.sendSync("canvas:drag-start", {
        x,
        y,
        localX,
        localY,
        displayKey,
        generation,
        epoch,
      }),
    dragMove: (x, y, token) => ipcRenderer.send("canvas:drag-move", { x, y, token }),
    dragEnd: (token) => ipcRenderer.send("canvas:drag-end", { token }),
  }),
);
