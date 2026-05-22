"use strict";

require("dotenv").config();

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  desktopCapturer,
  Notification,
  nativeImage,
  powerMonitor,
} = require("electron");
const path = require("path");
const Store = require("electron-store");

const store = new Store();

let mainWindow = null;
let tray = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 600,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=",
    );
  }

  tray = new Tray(icon);
  tray.setToolTip("Team Tracker");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

ipcMain.handle("take-screenshot", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 },
  });
  if (!sources || sources.length === 0)
    throw new Error("No screen sources available");
  return sources.map((s) => s.thumbnail.toDataURL());
});

ipcMain.handle("get-env-config", () => ({
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET,
  },
}));

ipcMain.handle("store-get", (_e, key) => store.get(key) ?? null);

ipcMain.handle("store-set", (_e, key, value) => {
  if (value == null) store.delete(key);
  else store.set(key, value);
});

ipcMain.handle("show-notification", (_e, title, body) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

const IDLE_THRESHOLD_SEC = 15 * 60;
ipcMain.handle("get-idle-state", () =>
  powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SEC),
);

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});
