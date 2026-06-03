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
const Store = require("electron-store");

const store = new Store();

let mainWindow = null;
let tray = null;
let windowsApi = null;

async function getWindowsApi() {
  if (windowsApi) return windowsApi;
  const module = await import("get-windows");
  windowsApi = {
    activeWindow: module.activeWindow,
    openWindows: module.openWindows,
  };
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
