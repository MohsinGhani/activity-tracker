"use strict";

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
  screen,
} = require("electron");
const path = require("path");
const activeWindow = require("active-win");
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

function normalizeWindowInfo(windowInfo) {
  if (!windowInfo) return null;

  return {
    title: windowInfo.title?.trim() || null,
    appName: windowInfo.owner?.name?.trim() || null,
    processId: windowInfo.owner?.processId ?? null,
    processPath: windowInfo.owner?.path || null,
    windowId: windowInfo.id ?? null,
    bounds: windowInfo.bounds ?? null,
    platform: windowInfo.platform ?? process.platform,
  };
}

function buildActivitySummary(windowInfo) {
  const normalized = normalizeWindowInfo(windowInfo);

  if (!normalized) return "No active window detected";
  if (normalized.title && normalized.appName) {
    return `${normalized.title} - ${normalized.appName}`;
  }

  return normalized.title || normalized.appName || "Unknown activity";
}

function getIntersectionArea(firstBounds, secondBounds) {
  if (!firstBounds || !secondBounds) return 0;

  const left = Math.max(firstBounds.x, secondBounds.x);
  const top = Math.max(firstBounds.y, secondBounds.y);
  const right = Math.min(
    firstBounds.x + firstBounds.width,
    secondBounds.x + secondBounds.width,
  );
  const bottom = Math.min(
    firstBounds.y + firstBounds.height,
    secondBounds.y + secondBounds.height,
  );

  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function pickWindowForDisplay(displayBounds, windows, usedWindowIds) {
  let bestWindow = null;
  let bestArea = 0;

  for (const windowInfo of windows) {
    if (usedWindowIds.has(windowInfo.windowId)) continue;

    const overlapArea = getIntersectionArea(windowInfo.bounds, displayBounds);
    if (overlapArea > bestArea) {
      bestArea = overlapArea;
      bestWindow = windowInfo;
    }
  }

  if (bestWindow) {
    usedWindowIds.add(bestWindow.windowId);
    return bestWindow;
  }

  for (const windowInfo of windows) {
    const overlapArea = getIntersectionArea(windowInfo.bounds, displayBounds);
    if (overlapArea > bestArea) {
      bestArea = overlapArea;
      bestWindow = windowInfo;
    }
  }

  return bestWindow;
}

function getDisplaysForSources(sources) {
  const displaysById = new Map(
    screen.getAllDisplays().map((display) => [String(display.id), display]),
  );

  const matchedDisplays = sources
    .map((source) => displaysById.get(String(source.display_id)))
    .filter(Boolean);

  if (matchedDisplays.length > 0) {
    return matchedDisplays;
  }

  return screen
    .getAllDisplays()
    .slice()
    .sort(
      (first, second) =>
        first.bounds.x - second.bounds.x || first.bounds.y - second.bounds.y,
    );
}

function getActivitySummary(sources) {
  const currentWindow = activeWindow.sync();
  const fallbackSummary = buildActivitySummary(currentWindow);
  const displays = getDisplaysForSources(sources);

  const windows = activeWindow
    .getOpenWindowsSync()
    .map(normalizeWindowInfo)
    .filter(
      (windowInfo) =>
        windowInfo &&
        windowInfo.bounds &&
        (windowInfo.title || windowInfo.appName),
    );

  if (displays.length <= 1 || windows.length === 0) {
    return fallbackSummary;
  }

  const usedWindowIds = new Set();
  const summaries = displays
    .map((display) =>
      pickWindowForDisplay(display.bounds, windows, usedWindowIds),
    )
    .filter(Boolean)
    .map((windowInfo) => buildActivitySummary(windowInfo));

  const uniqueSummaries = [...new Set(summaries.filter(Boolean))];
  return uniqueSummaries.length > 0
    ? uniqueSummaries.join(" | ")
    : fallbackSummary;
}

ipcMain.handle("take-screenshot", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 },
  });
  if (!sources || sources.length === 0)
    throw new Error("No screen sources available");

  let activitySummary = null;
  try {
    activitySummary = getActivitySummary(sources);
  } catch (error) {
    console.error("Failed to capture activity summary:", error);
  }

  return {
    dataUrls: sources.map((s) => s.thumbnail.toDataURL()),
    activitySummary,
  };
});

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
