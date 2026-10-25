const { contextBridge, ipcRenderer } = require('electron');

// renderer 只拿到写日志的函数，不暴露 Node 能力。
contextBridge.exposeInMainWorld('probeLog', (event) => {
  ipcRenderer.send('probe:log', event);
});
