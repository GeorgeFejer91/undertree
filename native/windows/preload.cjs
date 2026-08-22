const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("undertree", {
  chooseProjectFolder: () => ipcRenderer.invoke("undertree:choose-project-folder"),
});
