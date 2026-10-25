/* 渲染进程唯一的业务接口面。不暴露 ipcRenderer、文件、数据库或网络能力。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "bayper",
  Object.freeze({
    getSnapshot: () => ipcRenderer.invoke("bayper:snapshot"),
    validateAndSaveModel: (input) => ipcRenderer.invoke("bayper:model:validate-and-save", input),
    recommendCharacters: (wish) => ipcRenderer.invoke("bayper:wish:recommend", wish),
    acceptCharacter: (characterId) => ipcRenderer.invoke("bayper:character:accept", characterId),
    checkStoredModel: () => ipcRenderer.invoke("bayper:model:check-stored"),
    setNickname: (characterId, nickname) =>
      ipcRenderer.invoke("bayper:companion:nickname", characterId, nickname),
    setFixedCompanion: (characterId) => ipcRenderer.invoke("bayper:companion:fixed", characterId),
    switchCompanion: (characterId) => ipcRenderer.invoke("bayper:companion:switch", characterId),
    restCompanion: () => ipcRenderer.invoke("bayper:companion:rest"),
  }),
);
