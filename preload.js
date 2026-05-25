"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getIdleState: () => ipcRenderer.invoke("get-idle-state"),
  storeGet: (key) => ipcRenderer.invoke("store-get", key),
  storeSet: (key, value) => ipcRenderer.invoke("store-set", key, value),
  showNotification: (title, body) =>
    ipcRenderer.invoke("show-notification", title, body),
});
