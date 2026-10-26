/* 渲染进程的具名业务接口面。不暴露 ipcRenderer、文件、数据库或网络能力。
   bayper 保持既有 S01/S02 表面；bayperChat 只提供聊天所需的显式方法。 */
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
    onSnapshotUpdated: (callback) => {
      ipcRenderer.on("bayper:snapshot-updated", (_event, snapshot) => callback(snapshot));
    },
    getSystemStatus: () => ipcRenderer.invoke("bayper:system-status"),
  }),
);

contextBridge.exposeInMainWorld(
  "bayperChat",
  Object.freeze({
    openChat: (characterId) => ipcRenderer.invoke("bayper:chat:open", characterId),
    getChatConversation: (characterId, conversationId) =>
      ipcRenderer.invoke("bayper:chat:conversation", characterId, conversationId),
    sendChatMessage: (payload) => ipcRenderer.invoke("bayper:chat:send", payload),
    cancelChatMessage: (payload) => ipcRenderer.invoke("bayper:chat:cancel", payload),
    retryChatMessage: (payload) => ipcRenderer.invoke("bayper:chat:retry", payload),
    closeChat: () => ipcRenderer.invoke("bayper:chat:close"),
    onChatClosed: (callback) => {
      ipcRenderer.on("bayper:chat-closed", () => callback());
    },
  }),
);

contextBridge.exposeInMainWorld(
  "bayperMemory",
  Object.freeze({
    listMemories: (payload) => ipcRenderer.invoke("bayper:memory:list", payload),
    correctMemory: (payload) => ipcRenderer.invoke("bayper:memory:correct", payload),
    forgetMemory: (payload) => ipcRenderer.invoke("bayper:memory:forget", payload),
    keepExclusive: (payload) => ipcRenderer.invoke("bayper:memory:keep-exclusive", payload),
    relayMemory: (payload) => ipcRenderer.invoke("bayper:memory:relay", payload),
    restrictMemorySharing: (payload) =>
      ipcRenderer.invoke("bayper:memory:restrict-sharing", payload),
    allowMemorySharing: (payload) =>
      ipcRenderer.invoke("bayper:memory:allow-sharing", payload),
    onMemoryChanged: (callback) => {
      ipcRenderer.on("bayper:memory-changed", (_event, payload) => callback(payload));
    },
  }),
);

contextBridge.exposeInMainWorld(
  "bayperStories",
  Object.freeze({
    listStories: () => ipcRenderer.invoke("bayper:story:list"),
    getStory: (storyId) => ipcRenderer.invoke("bayper:story:detail", storyId),
    acknowledgeInvitation: (payload) =>
      ipcRenderer.invoke("bayper:story:invitation-shown", payload),
    leaveStory: () => ipcRenderer.invoke("bayper:story:leave"),
    acceptInvitation: (invitationId) =>
      ipcRenderer.invoke("bayper:story:invitation-accept", invitationId),
    deferInvitation: (invitationId) =>
      ipcRenderer.invoke("bayper:story:invitation-later", invitationId),
    rejectInvitation: (invitationId) =>
      ipcRenderer.invoke("bayper:story:invitation-reject", invitationId),
    reopenInvitation: (invitationId) =>
      ipcRenderer.invoke("bayper:story:invitation-reopen", invitationId),
  }),
);

contextBridge.exposeInMainWorld(
  "bayperSources",
  Object.freeze({
    getState: () => ipcRenderer.invoke("bayper:source:state"),
    setEnabled: (enabled) => ipcRenderer.invoke("bayper:source:set-enabled", enabled),
    authorizeCandidate: (provider) =>
      ipcRenderer.invoke("bayper:source:authorize-candidate", provider),
    chooseDirectory: (provider) => ipcRenderer.invoke("bayper:source:choose-directory", provider),
    revoke: (grantId) => ipcRenderer.invoke("bayper:source:revoke", grantId),
  }),
);

contextBridge.exposeInMainWorld(
  "bayperConnectors",
  Object.freeze({
    setEnabled: (instanceId, enabled) =>
      ipcRenderer.invoke("bayper:connector:set-enabled", instanceId, enabled),
    copyRegistryPath: () => ipcRenderer.invoke("bayper:connector:copy-registry-path"),
  }),
);
