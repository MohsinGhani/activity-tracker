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
  shell,
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

async function checkScreenRecordingPermission() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources && sources.length > 0;
  } catch (error) {
    console.error("Screen recording permission check failed:", error);
    return false;
  }
}

async function checkAccessibilityPermission() {
  try {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        return frontApp
      end tell
    `;
    await execFilePromise("osascript", ["-e", script]);
    return true;
  } catch (error) {
    console.error("Accessibility permission check failed:", error);
    return false;
  }
}

async function checkIdleTimePermission() {
  try {
    // On macOS, getSystemIdleTime() returns 0 without Input Monitoring permission
    // Take multiple samples to verify it's actually working
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const idleTime = powerMonitor.getSystemIdleTime();
      samples.push(idleTime);
      if (idleTime > 0) {
        // Got a non-zero reading, permission is working
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // All samples returned 0 - likely a permission issue on macOS
    const allZero = samples.every((s) => s === 0);
    if (allZero && process.platform === "darwin") {
      console.error(
        "Idle time returns 0 on macOS - Input Monitoring permission may be missing",
      );
      return false;
    }

    // On Windows and Linux, always return true (we have our own detection or it works)
    return true;
  } catch (error) {
    console.error("Idle time permission check failed:", error);
    return false;
  }
}

async function getWindowsIdleTime() {
  try {
    // Use PowerShell to get idle time on Windows using GetLastInputInfo
    const script = `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
      }
      public class IdleTime {
        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        public static uint GetIdleTime() {
          LASTINPUTINFO info = new LASTINPUTINFO();
          info.cbSize = (uint)Marshal.SizeOf(info);
          if (GetLastInputInfo(ref info)) {
            return ((uint)Environment.TickCount - info.dwTime);
          }
          return 0;
        }
      }
"@
      [IdleTime]::GetIdleTime()
    `;

    const result = await execFilePromise("powershell.exe", [
      "-Command",
      script,
    ]);

    const idleMs = parseInt(result.stdout.trim()) || 0;
    return Math.floor(idleMs / 1000);
  } catch (error) {
    console.error("Failed to get Windows idle time:", error);
    return 0;
  }
}

ipcMain.handle("check-permissions", async () => {
  const screenRecording = await checkScreenRecordingPermission();
  const accessibility = await checkAccessibilityPermission();
  const idleTime = await checkIdleTimePermission();
  return {
    screenRecording,
    accessibility,
    idleTime,
    platform: process.platform,
  };
});

ipcMain.handle("open-permission-settings", async () => {
  if (process.platform === "darwin") {
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    } catch (error) {
      console.error("Failed to open screen recording settings:", error);
    }
  }
});

ipcMain.handle("open-accessibility-settings", async () => {
  if (process.platform === "darwin") {
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    } catch (error) {
      console.error("Failed to open accessibility settings:", error);
    }
  }
});

ipcMain.handle("open-input-monitoring-settings", async () => {
  if (process.platform === "darwin") {
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
      );
    } catch (error) {
      console.error("Failed to open input monitoring settings:", error);
    }
  }
});

ipcMain.handle("take-screenshot", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 },
  });
  if (!sources || sources.length === 0)
    throw new Error(
      "No screen sources available. Please grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording.",
    );

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
    const isPermissionError =
      process.platform === "darwin" &&
      (error?.message?.includes("not allowed") ||
        error?.message?.includes("permission") ||
        error?.message?.includes("Accessibility") ||
        error?.code === "EACCES");

    return {
      active: {
        summary: isPermissionError
          ? "Activity tracking unavailable — grant Accessibility permission"
          : "Unknown activity",
        appName: isPermissionError ? "Permission required" : "Unknown app",
        windowTitle: isPermissionError
          ? "Open System Settings > Privacy & Security > Accessibility"
          : "Unknown window",
        fileName: null,
        permissionError: isPermissionError,
      },
      perScreen: [],
      permissionError: isPermissionError,
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
    const isPermissionError =
      process.platform === "darwin" &&
      (error?.message?.includes("not allowed") ||
        error?.message?.includes("permission") ||
        error?.message?.includes("Accessibility") ||
        error?.code === "EACCES");

    return {
      summary: isPermissionError
        ? "Activity tracking unavailable — grant Accessibility permission"
        : "Unknown activity",
      appName: isPermissionError ? "Permission required" : "Unknown app",
      windowTitle: isPermissionError
        ? "Open System Settings > Privacy & Security > Accessibility"
        : "Unknown window",
      fileName: null,
      permissionError: isPermissionError,
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
ipcMain.handle("get-idle-time", async () => {
  let idleSeconds;

  if (process.platform === "win32") {
    // Use Windows-specific idle time detection
    idleSeconds = await getWindowsIdleTime();
  } else {
    // Use Electron's built-in idle time detection for macOS and Linux
    idleSeconds = powerMonitor.getSystemIdleTime();
  }

  console.log(
    "[IDLE DEBUG] Idle time:",
    idleSeconds,
    "seconds (platform:",
    process.platform,
    ")",
  );
  return idleSeconds;
});

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
