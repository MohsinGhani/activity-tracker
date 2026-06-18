"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getActivityContexts: (displayIds) =>
    ipcRenderer.invoke("get-activity-contexts", displayIds),
  getActivityContext: () => ipcRenderer.invoke("get-activity-context"),
  getIdleState: () => ipcRenderer.invoke("get-idle-state"),
  getIdleTime: () => ipcRenderer.invoke("get-idle-time"),
  storeGet: (key) => ipcRenderer.invoke("store-get", key),
  storeSet: (key, value) => ipcRenderer.invoke("store-set", key, value),
  showNotification: (title, body) =>
    ipcRenderer.invoke("show-notification", title, body),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update-status", listener);
    return () => ipcRenderer.removeListener("update-status", listener);
  },
  onPowerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("power-monitor-event", listener);
    return () => ipcRenderer.removeListener("power-monitor-event", listener);
  },
  onAppClosing: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app-closing", listener);
    return () => ipcRenderer.removeListener("app-closing", listener);
  },
  notifyAppClosingDone: () => ipcRenderer.send("app-closing-done"),
});
