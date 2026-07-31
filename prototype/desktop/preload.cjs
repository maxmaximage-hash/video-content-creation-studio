const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoContentDesktop", {
  startFileDrag(payload) {
    ipcRenderer.send("start-file-drag", payload);
  },
});
