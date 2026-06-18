"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  desktopCapturer,
  Notification,
  dialog,
  nativeImage,
  powerMonitor,
  screen,
} = require("electron");
const path = require("path");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");
const { execFile } = require("child_process");
const util = require("util");
const execFilePromise = util.promisify(execFile);

const store = new Store();
const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
let windowsApi = null;
let isCloseFlowInProgress = false;
let hasHandledPreQuit = false;
let updateCheckInterval = null;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function sendUpdateStatus(status, detail = null) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    return;
  }

  mainWindow.webContents.send("update-status", {
    status,
    detail,
  });
}

async function checkForUpdatesSafe() {
  if (isDev) return null;

  try {
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error?.message || String(error);
    console.error("Auto-update check failed:", message);
    sendUpdateStatus("error", message);
    return null;
  }
}

function scheduleAutoUpdateChecks() {
  clearInterval(updateCheckInterval);
  updateCheckInterval = setInterval(() => {
    void checkForUpdatesSafe();
  }, UPDATE_CHECK_INTERVAL_MS);
}

function configureAutoUpdates() {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus("checking");
  });

  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus("available", info?.version || null);
  });

  autoUpdater.on("update-not-available", () => {
    sendUpdateStatus("not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus("downloading", {
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version = info?.version || "latest";
    const body = `Version ${version} is ready and will install when you close the app.`;

    sendUpdateStatus("downloaded", version);
    if (Notification.isSupported()) {
      new Notification({
        title: "Activity Tracker update ready",
        body,
      }).show();
    } else {
      void dialog.showMessageBox({
        type: "info",
        title: "Activity Tracker update ready",
        message: body,
      });
    }
  });

  autoUpdater.on("error", (error) => {
    const message = error?.message || String(error);
    console.error("Auto-update error:", message);
    sendUpdateStatus("error", message);
  });

  void checkForUpdatesSafe();
  scheduleAutoUpdateChecks();
}

function requestSessionEndBeforeQuit(timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
      resolve();
      return;
    }

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      ipcMain.removeListener("app-closing-done", onDone);
      resolve();
    };

    const onDone = () => finish();
    const timeoutHandle = setTimeout(finish, timeoutMs);

    ipcMain.once("app-closing-done", onDone);

    try {
      mainWindow.webContents.send("app-closing");
    } catch (error) {
      console.error("Failed to notify renderer about app close:", error);
      finish();
    }
  });
}

async function runPreQuitFlow() {
  if (hasHandledPreQuit || isCloseFlowInProgress) {
    return;
  }

  isCloseFlowInProgress = true;
  hasHandledPreQuit = true;

  // Only set pendingSessionEndAtMs if not already set by shutdown handler
  if (
    !store.has("pendingSessionEndAtMs") ||
    !store.get("pendingSessionEndAtMs")
  ) {
    store.set("pendingSessionEndAtMs", Date.now());
  }

  try {
    await requestSessionEndBeforeQuit();
  } catch (error) {
    console.error("Failed to end session before quit:", error);
  } finally {
    app.isQuitting = true;
    app.quit();
  }
}

async function getMacOSWindows() {
  try {
    const script = `
      set output to ""
      tell application "System Events"
        repeat with appProcess in (processes where background only is false)
          set appName to name of appProcess
          try
            repeat with appWindow in (windows of appProcess)
              set windowTitle to name of appWindow
              set windowPos to position of appWindow
              set windowSize to size of appWindow
              set x to item 1 of windowPos
              set y to item 2 of windowPos
              set w to item 1 of windowSize
              set h to item 2 of windowSize
              set output to output & appName & "|" & windowTitle & "|" & x & "|" & y & "|" & w & "|" & h & linefeed
            end repeat
          end try
        end repeat
      end tell
      return output
    `;

    const { stdout } = await execFilePromise("osascript", ["-e", script]);
    const windowLines = stdout.trim().split("\n");

    const windows = [];
    for (const line of windowLines) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length === 6) {
        try {
          windows.push({
            owner: {
              name: parts[0].trim(),
              processName: parts[0].trim(),
            },
            title: parts[1].trim(),
            bounds: {
              x: parseInt(parts[2]) || 0,
              y: parseInt(parts[3]) || 0,
              width: parseInt(parts[4]) || 0,
              height: parseInt(parts[5]) || 0,
            },
          });
        } catch (e) {
          // Skip parsing errors for individual windows
        }
      }
    }

    return windows;
  } catch (error) {
    console.error("Failed to get macOS windows:", error);
    return [];
  }
}

async function getWindowsApi() {
  if (windowsApi) return windowsApi;

  if (process.platform === "win32") {
    const module = await import("get-windows");
    windowsApi = {
      activeWindow: module.activeWindow,
      openWindows: module.openWindows,
    };
  } else if (process.platform === "darwin") {
    const module = await import("active-win");
    const getActiveWindow = module.default || module;
    windowsApi = {
      activeWindow: async () => getActiveWindow(),
      openWindows: async () => {
        try {
          return await getMacOSWindows();
        } catch (error) {
          console.error("Failed to get macOS open windows:", error);
          return [];
        }
      },
    };
  } else {
    const module = await import("active-win");
    const getActiveWindow = module.default || module;
    windowsApi = {
      activeWindow: async () => getActiveWindow(),
      openWindows: async () => [],
    };
  }

  return windowsApi;
}

function extractFileNameFromTitle(title = "") {
  const prefix = String(title).split(" - ")[0]?.trim();
  if (!prefix) return null;
  const candidate = prefix.split(/[\\/]/).pop()?.trim();
  if (!candidate) return null;
  if (!/\.[a-z0-9]{1,8}$/i.test(candidate)) return null;
  return candidate;
}

function buildActivityContext(activeWindow) {
  const appName =
    activeWindow?.owner?.name ||
    activeWindow?.owner?.processName ||
    "Unknown app";
  const windowTitle = activeWindow?.title || "Unknown window";
  const fileName = extractFileNameFromTitle(windowTitle);
  const lowerTitle = windowTitle.toLowerCase();
  const lowerAppName = appName.toLowerCase();
  const titleAlreadyHasApp =
    lowerTitle === lowerAppName || lowerTitle.endsWith(` - ${lowerAppName}`);

  const summary = fileName
    ? `${fileName} ${appName}`
    : titleAlreadyHasApp
      ? windowTitle
      : `${windowTitle} ${appName}`;

  return {
    summary,
    appName,
    windowTitle,
    fileName,
  };
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}

function getWindowCenter(windowInfo) {
  const bounds = windowInfo?.bounds;
  if (!bounds) return null;
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function matchWindowForDisplay(windowList, displayBounds) {
  return windowList.find((windowInfo) => {
    if (!windowInfo?.title || !windowInfo?.owner) return false;
    const center = getWindowCenter(windowInfo);
    return pointInBounds(center, displayBounds);
  });
}

async function buildPerScreenActivityContext(displayIds = []) {
  const api = await getWindowsApi();
  const [activeWindow, allOpenWindows] = await Promise.all([
    api.activeWindow(),
    api.openWindows(),
  ]);

  const activeContext = buildActivityContext(activeWindow);
  const openWindows = Array.isArray(allOpenWindows) ? allOpenWindows : [];
  const displayIdSet = new Set((displayIds || []).filter(Boolean).map(String));

  const displays = screen
    .getAllDisplays()
    .filter((display) =>
      displayIdSet.size === 0 ? true : displayIdSet.has(String(display.id)),
    );

  const perScreen = displays.map((display, index) => {
    const matchedWindow = matchWindowForDisplay(openWindows, display.bounds);
    const context = matchedWindow
      ? buildActivityContext(matchedWindow)
      : activeContext;

    return {
      displayId: String(display.id),
      screenName: `Screen ${index + 1}`,
      ...context,
    };
  });

  return {
    active: activeContext,
    perScreen,
  };
}

if (!isDev) {
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
}

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

  mainWindow.on("close", async (event) => {
    if (app.isQuitting || hasHandledPreQuit || isCloseFlowInProgress) {
      return;
    }

    event.preventDefault();
    void runPreQuitFlow();
  });
}

function createTray() {
  const trayIconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  let icon = nativeImage.createFromPath(
    path.join(__dirname, "assets", trayIconName),
  );
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

function enableAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      enabled: true,
      path: process.execPath,
      args: [],
      openAsHidden: false,
    });
  } catch (error) {
    console.error("Failed to enable auto-launch on startup:", error);
  }
}

ipcMain.handle("take-screenshot", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 },
  });
  if (!sources || sources.length === 0)
    throw new Error("No screen sources available");

  return sources.map((s, index) => {
    const fallbackName = `Screen ${index + 1}`;
    const screenName =
      s.name && s.name !== "Entire Screen" ? s.name : fallbackName;

    return {
      screenName,
      displayId: s.display_id ? String(s.display_id) : null,
      dataUrl: s.thumbnail.toDataURL(),
    };
  });
});

ipcMain.handle("get-activity-contexts", async (_event, displayIds = []) => {
  try {
    return await buildPerScreenActivityContext(displayIds);
  } catch (error) {
    console.error("Failed to read per-screen activity context:", error);
    return {
      active: {
        summary: "Unknown activity",
        appName: "Unknown app",
        windowTitle: "Unknown window",
        fileName: null,
      },
      perScreen: [],
    };
  }
});

ipcMain.handle("get-activity-context", async () => {
  try {
    const api = await getWindowsApi();
    const activeWindow = await api.activeWindow();
    return buildActivityContext(activeWindow);
  } catch (error) {
    console.error("Failed to read active window context:", error);
    return {
      summary: "Unknown activity",
      appName: "Unknown app",
      windowTitle: "Unknown window",
      fileName: null,
    };
  }
});

ipcMain.handle("store-get", (_e, key) => store.get(key) ?? null);

ipcMain.handle("store-set", (_e, key, value) => {
  if (value == null) store.delete(key);
  else store.set(key, value);
});

ipcMain.handle("show-notification", (_e, title, body) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

ipcMain.handle("check-for-updates", async () => {
  const result = await checkForUpdatesSafe();
  return Boolean(result);
});

ipcMain.handle("session-end-confirmed", () => {
  console.log("Renderer confirmed session saved to Firebase");
});

ipcMain.handle("quit-and-install", async () => {
  try {
    autoUpdater.quitAndInstall();
    return true;
  } catch (error) {
    console.error("Failed to quit and install update:", error);
    return false;
  }
});

const IDLE_THRESHOLD_SEC = 15 * 60;
ipcMain.handle("get-idle-state", () =>
  powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SEC),
);
ipcMain.handle("get-idle-time", () => powerMonitor.getSystemIdleTime());

app.whenReady().then(() => {
  if (!isDev) {
    enableAutoLaunch();
  }

  createWindow();
  configureAutoUpdates();
  if (!isDev) {
    createTray();
  }
});

app.on("before-quit", (event) => {
  clearInterval(updateCheckInterval);
  updateCheckInterval = null;

  if (app.isQuitting || hasHandledPreQuit || isCloseFlowInProgress) {
    return;
  }

  event.preventDefault();
  void runPreQuitFlow();
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

function sendPowerMonitorEvent(eventName) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    return;
  }
  mainWindow.webContents.send("power-monitor-event", eventName);
}

for (const eventName of [
  "suspend",
  "resume",
  "lock-screen",
  "unlock-screen",
  "display-sleep",
  "display-on",
]) {
  powerMonitor.on(eventName, () => sendPowerMonitorEvent(eventName));
}

powerMonitor.on("shutdown", (event) => {
  if (app.isQuitting || hasHandledPreQuit || isCloseFlowInProgress) {
    return;
  }

  store.set("pendingSessionEndAtMs", Date.now());
  hasHandledPreQuit = true;

  void runPreQuitFlow().finally(() => {
    if (!app.isQuitting) {
      app.quit();
    }
  });
});
