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
  systemPreferences,
} = require("electron");
const path = require("path");
const fs = require("fs");
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
let activeWinLoadError = null;
let isCloseFlowInProgress = false;
let hasHandledPreQuit = false;
let updateCheckInterval = null;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/* ─── Diagnostics logger ──────────────────────────────────────────────────
 * Lightweight, dependency-free error logger. Writes timestamped lines to
 * <userData>/logs/tracker.log (rotated at ~1MB) and keeps the most recent
 * error in memory so the renderer can surface it. Best-effort: it must never
 * throw into the caller, and it never logs image data or credentials.
 */
const LOG_MAX_BYTES = 1024 * 1024;
let logFilePath = null;
let lastError = null;
let lastLogSignature = null;
let lastLogAtMs = 0;

function getLogFilePath() {
  if (logFilePath) return logFilePath;
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, "tracker.log");
  } catch (error) {
    console.error("Failed to prepare log directory:", error);
    logFilePath = null;
  }
  return logFilePath;
}

async function rotateLogIfNeeded(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > LOG_MAX_BYTES) {
      await fs.promises.rename(filePath, `${filePath}.1`);
    }
  } catch (error) {
    // File may not exist yet — nothing to rotate.
  }
}

async function logError(scope, error) {
  const message =
    error?.message || (typeof error === "string" ? error : String(error));
  lastError = { scope, message, at: new Date().toISOString() };

  // Throttle identical repeats so a persistent error can't flood the file.
  const signature = `${scope}:${message}`;
  const now = Date.now();
  if (signature === lastLogSignature && now - lastLogAtMs < 5 * 60 * 1000) {
    return;
  }
  lastLogSignature = signature;
  lastLogAtMs = now;

  const filePath = getLogFilePath();
  if (!filePath) return;
  try {
    await rotateLogIfNeeded(filePath);
    await fs.promises.appendFile(
      filePath,
      `[${lastError.at}] [${scope}] ${message}\n`,
    );
  } catch (writeError) {
    console.error("Failed to write to log file:", writeError);
  }
}

function sendDiagnostic(scope, message) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    return;
  }
  mainWindow.webContents.send("diagnostic", {
    scope,
    message,
    at: new Date().toISOString(),
  });
}

// Races a promise against a timer so a wedged native/OS call (e.g. an
// AppleScript Apple Events request stuck in a TCC negotiation on an
// ad-hoc-signed build) can never hang a permission check forever.
function withTimeout(promise, ms, fallbackValue, scope) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      void logError(scope, new Error(`Timed out after ${ms}ms`));
      resolve(fallbackValue);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

    const { stdout } = await execFilePromise("osascript", ["-e", script], {
      timeout: 5000,
      killSignal: "SIGKILL",
    });
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
    let getActiveWindow;
    try {
      const module = await import("active-win");
      getActiveWindow = module.default || module;
      activeWinLoadError = null;
    } catch (error) {
      activeWinLoadError = error?.message || String(error);
      await logError("active-win-load", error);
      getActiveWindow = async () => undefined;
    }
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
  const rawAppName =
    activeWindow?.owner?.name || activeWindow?.owner?.processName || null;
  const rawTitle = activeWindow?.title || null;

  const appName = rawAppName || "Unknown app";
  const windowTitle = rawTitle || "Unknown window";
  const fileName = extractFileNameFromTitle(rawTitle || "");
  const lowerTitle = windowTitle.toLowerCase();
  const lowerAppName = appName.toLowerCase();
  const titleAlreadyHasApp =
    lowerTitle === lowerAppName || lowerTitle.endsWith(` - ${lowerAppName}`);

  let summary;
  if (!rawAppName && !rawTitle) {
    // Nothing usable came back (no focused window / detection failed).
    summary = "Unknown activity";
  } else if (fileName) {
    summary = `${fileName} ${appName}`;
  } else if (!rawTitle) {
    // App is known but the window title is unavailable (e.g. Screen Recording
    // permission not effective) — show the app name alone rather than
    // "Unknown window <App>".
    summary = appName;
  } else if (titleAlreadyHasApp) {
    summary = windowTitle;
  } else {
    summary = `${windowTitle} ${appName}`;
  }

  return {
    summary,
    appName,
    windowTitle,
    fileName,
    degraded: !rawAppName || !rawTitle,
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

async function probeScreenSources() {
  try {
    const sources = await withTimeout(
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      }),
      5000,
      [],
      "probeScreenSources",
    );
    return Boolean(sources && sources.length > 0);
  } catch (error) {
    console.error("Screen recording probe failed:", error);
    return false;
  }
}

// Authoritative screen-recording status. On macOS we trust
// systemPreferences.getMediaAccessStatus("screen") for whether the permission
// was granted, and use the desktopCapturer probe to detect whether it is
// actually *effective* yet. A freshly granted Screen Recording permission is
// not effective (for desktopCapturer or active-win) until the app relaunches.
async function getScreenRecordingStatus() {
  const probeEffective = await probeScreenSources();

  if (process.platform !== "darwin") {
    return {
      status: probeEffective ? "granted" : "denied",
      granted: probeEffective,
      effective: probeEffective,
      needsRelaunch: false,
    };
  }

  let status = "unknown";
  try {
    status = systemPreferences.getMediaAccessStatus("screen");
  } catch (error) {
    console.error("Failed to read screen media access status:", error);
  }

  const granted = status === "granted";
  const effective = granted && probeEffective;
  const needsRelaunch = granted && !probeEffective;

  return { status, granted, effective, needsRelaunch };
}

async function checkScreenRecordingPermission() {
  const result = await getScreenRecordingStatus();
  return result.effective;
}

async function checkAccessibilityPermission() {
  try {
    const script = `
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        return frontApp
      end tell
    `;
    // timeout/killSignal force-kill osascript if it wedges waiting on a
    // TCC/Apple Events negotiation that never resolves (seen on ad-hoc
    // signed builds) — without this the child process (and this whole
    // check) can hang indefinitely.
    await execFilePromise("osascript", ["-e", script], {
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    return true;
  } catch (error) {
    console.error("Accessibility permission check failed:", error);
    if (error?.killed || error?.signal) {
      await logError(
        "checkAccessibilityPermission",
        new Error(
          "osascript timed out — Automation/Accessibility permission for System Events may be stuck",
        ),
      );
    }
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

    const result = await execFilePromise(
      "powershell.exe",
      ["-Command", script],
      { timeout: 5000, killSignal: "SIGKILL" },
    );

    const idleMs = parseInt(result.stdout.trim()) || 0;
    return Math.floor(idleMs / 1000);
  } catch (error) {
    console.error("Failed to get Windows idle time:", error);
    return 0;
  }
}

ipcMain.handle("check-permissions", async () => {
  // Hard backstop: the individual checks below already time out internally,
  // but this guarantees the renderer always gets an answer — never an
  // indefinite hang on the Start button — even if something unanticipated
  // wedges.
  return withTimeout(
    (async () => {
      const screen = await getScreenRecordingStatus();
      const accessibility = await checkAccessibilityPermission();
      const idleTime = await checkIdleTimePermission();
      return {
        screenRecording: screen.effective,
        screenRecordingStatus: screen.status,
        needsRelaunch: screen.needsRelaunch,
        accessibility,
        idleTime,
        platform: process.platform,
      };
    })(),
    10000,
    {
      screenRecording: false,
      screenRecordingStatus: "unknown",
      needsRelaunch: false,
      accessibility: false,
      idleTime: false,
      platform: process.platform,
    },
    "check-permissions",
  );
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
  try {
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
  } catch (error) {
    // Surface the real reason (permission, no sources, etc.) instead of
    // letting the renderer swallow it into a generic message.
    await logError("take-screenshot", error);
    sendDiagnostic("take-screenshot", error?.message || String(error));
    throw error;
  }
});

// Determine *why* activity detection failed by checking the actual OS
// permission state, instead of fragile string-matching on the error message.
async function buildActivityErrorContext(error) {
  let screenStatus = { granted: true, needsRelaunch: false };
  let accessibility = true;

  if (process.platform === "darwin") {
    try {
      screenStatus = await getScreenRecordingStatus();
    } catch (statusError) {
      console.error("Failed to read screen status for activity:", statusError);
    }
    accessibility = await checkAccessibilityPermission();
  }

  const permissionError =
    process.platform === "darwin" && (!screenStatus.granted || !accessibility);
  const needsRelaunch =
    process.platform === "darwin" && Boolean(screenStatus.needsRelaunch);

  let summary = "Unknown activity";
  let appName = "Unknown app";
  let windowTitle = "Unknown window";

  if (needsRelaunch) {
    summary = "Activity tracking needs an app relaunch to take effect";
    appName = "Relaunch required";
    windowTitle = "Screen Recording permission was just granted";
  } else if (permissionError) {
    const missing = [];
    if (!screenStatus.granted) missing.push("Screen Recording");
    if (!accessibility) missing.push("Accessibility");
    summary = `Activity tracking unavailable — grant ${missing.join(" and ")} permission`;
    appName = "Permission required";
    windowTitle = "Open System Settings > Privacy & Security";
  } else if (activeWinLoadError) {
    summary = "Activity tracking unavailable — window detection failed to load";
  }

  return {
    active: {
      summary,
      appName,
      windowTitle,
      fileName: null,
      permissionError,
      needsRelaunch,
    },
    perScreen: [],
    permissionError,
    needsRelaunch,
  };
}

ipcMain.handle("get-activity-contexts", async (_event, displayIds = []) => {
  try {
    return await buildPerScreenActivityContext(displayIds);
  } catch (error) {
    await logError("get-activity-contexts", error);
    return await buildActivityErrorContext(error);
  }
});

ipcMain.handle("get-activity-context", async () => {
  try {
    const api = await getWindowsApi();
    const activeWindow = await api.activeWindow();
    return buildActivityContext(activeWindow);
  } catch (error) {
    await logError("get-activity-context", error);
    const context = await buildActivityErrorContext(error);
    return context.active;
  }
});

ipcMain.handle("store-get", (_e, key) => store.get(key) ?? null);

ipcMain.handle("store-set", (_e, key, value) => {
  if (value == null) store.delete(key);
  else store.set(key, value);
});

// Lets the renderer append its own timestamped trace lines to tracker.log so
// hard-to-reproduce hangs (e.g. a wedged Firestore write) leave a durable
// breadcrumb trail we can read back later. Bypasses the dedup throttle in
// logError since these are intentional step markers.
ipcMain.handle("log-event", async (_e, scope, message) => {
  const at = new Date().toISOString();
  const filePath = getLogFilePath();
  if (!filePath) return;
  try {
    await fs.promises.appendFile(filePath, `[${at}] [${scope}] ${message}\n`);
  } catch (error) {
    console.error("Failed to write log-event:", error);
  }
});

// Relaunch the app so a freshly granted Screen Recording permission takes
// effect. Route through the normal pre-quit flow so any active session is
// safely ended/persisted first, then app.relaunch() spawns a new instance
// once this one quits.
ipcMain.handle("relaunch-app", async () => {
  try {
    app.relaunch();
    await runPreQuitFlow();
    return true;
  } catch (error) {
    console.error("Failed to relaunch app:", error);
    app.relaunch();
    app.exit(0);
    return false;
  }
});

ipcMain.handle("get-last-error", () => lastError);

ipcMain.handle("read-recent-log", async (_e, maxLines = 200) => {
  const filePath = getLogFilePath();
  if (!filePath) return "";
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.trimEnd().split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch (error) {
    return "";
  }
});

ipcMain.handle("open-log-file", async () => {
  const filePath = getLogFilePath();
  if (!filePath) return false;
  try {
    // Make sure the file exists so the OS can reveal it.
    await fs.promises.appendFile(filePath, "");
    shell.showItemInFolder(filePath);
    return true;
  } catch (error) {
    console.error("Failed to open log file:", error);
    return false;
  }
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
