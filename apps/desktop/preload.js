// OpenClapp desktop — preload. Exposes a tiny, typed surface to the error
// page (and future shell integration); the web UI itself runs unprivileged.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openclapp", {
  restartServer: () => ipcRenderer.invoke("openclapp:restart-server"),
  getPaths: () => ipcRenderer.invoke("openclapp:paths"),
  platform: process.platform,
});
