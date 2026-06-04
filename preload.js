"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getActivityContexts: (displayIds) =>
    ipcRenderer.invoke("get-activity-contexts", displayIds),
  getActivityContext: () => ipcRenderer.invoke("get-activity-context"),
  getIdleState: () => ipcRenderer.invoke("get-idle-state"),
  storeGet: (key) => ipcRenderer.invoke("store-get", key),
  storeSet: (key, value) => ipcRenderer.invoke("store-set", key, value),
  showNotification: (title, body) =>
    ipcRenderer.invoke("show-notification", title, body),
  onAppClosing: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app-closing", listener);
    return () => ipcRenderer.removeListener("app-closing", listener);
  },
  notifyAppClosingDone: () => ipcRenderer.send("app-closing-done"),
});
