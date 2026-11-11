import {
  loginUser,
  logoutUser,
  onAuthChange,
  saveScreenshot,
  createSession,
  endSession,
  getTodaySessionsSummary,
  updateUserStatus,
  TRACKER_SETTINGS_DEFAULTS,
  watchTrackerSettings,
  getManualTimeForDay,
  addManualTime,
  deleteManualTime,
  saveSessionSegments,
} from "./firebase.js";
import { uploadScreenshot } from "./screenshotStorage.js";
import { applyManualOverride, mergeWindows } from "./manualOverride.js";

let currentUser = null;
let currentSessionId = null;
let sessionStartTime = null;
let sessionStartedAtMs = null;
let elapsedBeforePauseMs = 0;
let totalIdleMs = 0;
let timerInterval = null;
let screenshotTimeout = null;
let midnightTimeout = null;
let newSessionTimeout = null;
let sessionPersistInterval = null;
let isIdle = false;
let idlePollInterval = null;
let isSessionPaused = false;
let pausedDueToIdle = false;
let idleResumeInProgress = false;
let todayEndedSeconds = 0;
let todayIdleSeconds = 0;
// Today's tracker sessions as { id, start, end, activeMs, idleMs, segments }.
let todaySessions = [];
// Today's manual time entries: [{ id, start: Date, end: Date, minutes, note }].
let manualEntries = [];

// Active/idle blocks of the current session, so manual time can replace the
// exact minutes it covers: [{ k: "a" | "i", s, e }] in ms. Paused time has no
// block. Saved with the session (sessions/{id}.segments).
let segmentLog = [];
let openSegment = null;

function closeSegment(endMs) {
  if (!openSegment) return;
  const e = Math.max(openSegment.s, Math.round(endMs));
  if (e > openSegment.s) segmentLog.push({ k: openSegment.k, s: openSegment.s, e });
  openSegment = null;
}

function openSegmentAt(kind, startMs) {
  let s = Math.round(startMs);
  if (openSegment) {
    // A backdated start (e.g. idle since the last input) never reaches before
    // the block it ends.
    s = Math.max(s, openSegment.s);
    closeSegment(s);
  }
  openSegment = { k: kind, s };
}

function beginSegments(startMs) {
  segmentLog = [];
  openSegment = null;
  openSegmentAt("a", startMs);
}

function currentSegments(nowMs = Date.now()) {
  return openSegment
    ? [...segmentLog, { k: openSegment.k, s: openSegment.s, e: Math.max(openSegment.s, nowMs) }]
    : [...segmentLog];
}

function syncSegments() {
  if (currentSessionId) void saveSessionSegments(currentSessionId, currentSegments());
}
let idleStartedAtMs = null;
let isAppClosingHandled = false;
let autoRestartInProgress = false;

// Set by admins in the portal (trackerSettings/{uid}); defaults until loaded.
let trackerSettings = { ...TRACKER_SETTINGS_DEFAULTS };
let stopSettingsWatch = null;
const getIdleThresholdMs = () => trackerSettings.idleThresholdMin * 60 * 1000;
const getScreenshotBlockMs = () =>
  trackerSettings.screenshotIntervalMin * 60 * 1000;
// getIdleTime() has whole-second resolution and the Windows probe takes a
// moment, so "last input" can look a few seconds later than it really was.
const IDLE_INPUT_TOLERANCE_MS = 5 * 1000;
const POWER_IDLE_EVENTS = new Set(["suspend", "lock-screen", "display-sleep"]);
const POWER_ACTIVE_EVENTS = new Set(["resume", "unlock-screen", "display-on"]);

const loginView = document.getElementById("login-view");
const dashView = document.getElementById("dashboard-view");
const emailInput = document.getElementById("email");
const passInput = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const welcomeMsg = document.getElementById("welcome-msg");
const timerDisplay = document.getElementById("timer-display");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const endBtn = document.getElementById("end-btn");
const statusText = document.getElementById("status-text");
const todayTotalTime = document.getElementById("today-total-time");
const todayIdleTime = document.getElementById("today-idle-time");
const toastArea = document.getElementById("toast-area");
const updateBanner = document.getElementById("update-banner");
const updateMessage = document.getElementById("update-message");
const updateHint = document.getElementById("update-hint");
const updateProgressFill = document.getElementById("update-progress-fill");
const updateActionBtn = document.getElementById("update-action-btn");
const logoutBtn = document.getElementById("logout-btn");
const permissionBanner = document.getElementById("permission-banner");
const permissionMessage = document.getElementById("permission-message");
const permissionActionBtn = document.getElementById("permission-action-btn");
const permissionCloseBtn = document.getElementById("permission-close-btn");
const rememberCheckbox = document.getElementById("remember-me");
const diagnostics = document.getElementById("diagnostics");
const diagnosticsText = document.getElementById("diagnostics-text");
const openLogBtn = document.getElementById("open-log-btn");
let updateIsReadyToInstall = false;
let permissionCheckInProgress = false;

function showPermissionBanner({
  message,
  actionText = "Open Settings",
  onAction,
}) {
  if (!permissionBanner || !permissionMessage) return;
  permissionMessage.textContent = message;
  if (permissionActionBtn) {
    permissionActionBtn.textContent = actionText;
    permissionActionBtn.style.display = "";
    permissionActionBtn.onclick = async () => {
      if (onAction) await onAction();
    };
  }
  permissionBanner.classList.add("show");
}

function hidePermissionBanner() {
  if (!permissionBanner) return;
  permissionBanner.classList.remove("show");
  if (permissionMessage) permissionMessage.textContent = "";
  if (permissionActionBtn) {
    permissionActionBtn.style.display = "none";
    permissionActionBtn.onclick = null;
  }
}

function showUpdateBanner({ message, hint = "", percent = 0, ready = false }) {
  updateMessage.textContent = message;
  updateHint.textContent = hint;
  updateProgressFill.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  updateIsReadyToInstall = ready;
  updateActionBtn.disabled = !ready;
  updateActionBtn.textContent = ready
    ? "Restart & Update"
    : "Downloading update…";
  updateActionBtn.classList.toggle("btn-success", ready);
  updateActionBtn.classList.toggle("btn-ghost", !ready);
  updateBanner.classList.add("show");
}

function hideUpdateBanner() {
  updateIsReadyToInstall = false;
  updateBanner.classList.remove("show");
  updateMessage.textContent = "";
  updateHint.textContent = "";
  updateProgressFill.style.width = "0%";
  updateActionBtn.disabled = true;
  updateActionBtn.textContent = "Restart & Update";
  updateActionBtn.classList.remove("btn-success");
  updateActionBtn.classList.add("btn-ghost");
}

if (permissionCloseBtn) {
  permissionCloseBtn.addEventListener("click", () => {
    hidePermissionBanner();
  });
}

function showDiagnostic(message, at = new Date().toISOString()) {
  if (!diagnostics || !diagnosticsText || !message) return;
  const time = new Date(at).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  diagnosticsText.textContent = `${message} — ${time}`;
  diagnostics.hidden = false;
}

function hideDiagnostic() {
  if (!diagnostics) return;
  diagnostics.hidden = true;
  if (diagnosticsText) diagnosticsText.textContent = "";
}

function friendlyScreenshotError(err) {
  const msg = (err?.message || String(err || "")).trim();
  if (/permission|not allowed|screen recording|no screen sources/i.test(msg)) {
    return "Screen Recording permission issue — see the banner above.";
  }
  if (/upload/i.test(msg)) {
    return `Upload failed: ${msg}`;
  }
  if (/network|fetch|ENOTFOUND|ETIMEDOUT|ECONN/i.test(msg)) {
    return "Network error while uploading the screenshot.";
  }
  return msg || "Unknown screenshot error.";
}

if (openLogBtn) {
  openLogBtn.addEventListener("click", async () => {
    try {
      await window.tracker.openLogFile();
    } catch (err) {
      console.error("Failed to open log file:", err);
    }
  });
}

if (window.tracker.onDiagnostic) {
  window.tracker.onDiagnostic((payload) => {
    if (!payload?.message) return;
    showDiagnostic(
      friendlyScreenshotError({ message: payload.message }),
      payload.at,
    );
  });
}

function resetStuckButtons() {
  try {
    if (!currentSessionId && startBtn && startBtn.disabled) {
      startBtn.disabled = false;
      startBtn.textContent = "▶ Start Session";
    }
  } catch (_) {}
}

window.addEventListener("unhandledrejection", (event) => {
  const msg = event?.reason?.message || String(event?.reason || "unknown");
  console.error("Unhandled rejection:", event?.reason);
  void window.tracker.logEvent?.("unhandledrejection", msg);
  try {
    showDiagnostic(`Unexpected error: ${msg}`);
  } catch (_) {}
  resetStuckButtons();
});

window.addEventListener("error", (event) => {
  const msg = event?.error?.message || event?.message || "unknown";
  console.error("Uncaught error:", event?.error || event?.message);
  void window.tracker.logEvent?.("uncaught-error", msg);
  resetStuckButtons();
});

updateActionBtn.addEventListener("click", async () => {
  if (!updateIsReadyToInstall) return;

  updateActionBtn.disabled = true;
  updateActionBtn.textContent = "Restarting...";

  try {
    const result = await window.tracker.quitAndInstall();
    if (!result) {
      throw new Error("quitAndInstall failed");
    }
  } catch (err) {
    console.error("Update restart failed:", err);
    showToast("Could not restart for update. Please close the app manually.");
    updateActionBtn.disabled = false;
    updateActionBtn.textContent = "Restart & Update";
  }
});

function getMissingPermissions(result) {
  const missing = [];
  if (!result?.screenRecording) missing.push("Screen Recording");
  if (!result?.accessibility) missing.push("Accessibility");
  return missing;
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

async function checkMacOSPermissions() {
  if (permissionCheckInProgress) return null;
  if (window.tracker.platform !== "darwin") {
    hidePermissionBanner();
    return {
      screenRecording: true,
      accessibility: true,
      idleTime: true,
      missing: [],
    };
  }

  permissionCheckInProgress = true;
  try {
    const result = await withTimeout(
      window.tracker.checkPermissions(),
      12000,
      null,
    );
    if (result === null) {
      console.error("Permission check timed out");
      return { timedOut: true, missing: [] };
    }
    const missing = getMissingPermissions(result);

    if (result?.needsRelaunch) {
      showPermissionBanner({
        message:
          "Screen Recording was granted but needs an app relaunch to take effect. Relaunch now so screenshots and activity tracking work.",
        actionText: "Relaunch now",
        onAction: async () => {
          await window.tracker.relaunchApp();
        },
      });
    } else if (missing.length > 0) {
      showPermissionBanner({
        message: `Missing permissions: ${missing.join(" and ")}. Click below to open System Settings and grant access so screenshots and activity tracking can work.`,
        actionText: "Open Settings",
        onAction: async () => {
          if (!result?.screenRecording) {
            await window.tracker.openPermissionSettings();
          }
          if (!result?.accessibility) {
            await window.tracker.openAccessibilitySettings();
          }
        },
      });
    } else {
      hidePermissionBanner();
    }

    return { ...result, missing };
  } catch (err) {
    console.error("Permission check failed:", err);
    return null;
  } finally {
    permissionCheckInProgress = false;
  }
}

window.tracker.onUpdateStatus((payload) => {
  const status = payload?.status;
  if (!status) return;

  if (status === "available") {
    const version = payload?.detail ? ` v${payload.detail}` : "";
    showUpdateBanner({
      message: `Update${version} is available and downloading in the background.`,
      hint: "This update will be ready to install soon.",
      percent: 0,
      ready: false,
    });
    return;
  }

  if (status === "downloading") {
    const percent = Number(payload?.detail?.percent) || 0;
    showUpdateBanner({
      message: "Downloading update…",
      hint: `${percent.toFixed(0)}% complete`,
      percent,
      ready: false,
    });
    return;
  }

  if (status === "downloaded") {
    const version = payload?.detail ? `v${payload.detail}` : "latest";
    showUpdateBanner({
      message: `Update ${version} downloaded and ready to install.`,
      hint: "Click Restart & Update to apply it now.",
      percent: 100,
      ready: true,
    });
    return;
  }

  if (status === "not-available") {
    hideUpdateBanner();
    return;
  }

  if (status === "error") {
    hideUpdateBanner();
    const reason = typeof payload?.detail === "string" ? payload.detail : "";
    showToast(
      reason
        ? `Update failed: ${reason.split("\n")[0].slice(0, 200)}`
        : "Update failed. Will retry automatically.",
    );
  }
});

window.tracker.onPowerEvent(async (eventName) => {
  if (!currentSessionId) return;

  if (POWER_IDLE_EVENTS.has(eventName)) {
    if (!isIdle && !isSessionPaused) {
      const idleSeconds = Number(await window.tracker.getIdleTime());
      enterIdleMode(Number.isFinite(idleSeconds) ? idleSeconds * 1000 : 0);
      showToast("Session idle detected — time will be excluded from duration.");
    }
    return;
  }

  if (POWER_ACTIVE_EVENTS.has(eventName) && isIdle && !idleResumeInProgress) {
    idleResumeInProgress = true;
    try {
      exitIdleMode();
      showToast("Session active again.");
    } finally {
      idleResumeInProgress = false;
    }
  }
});

window.tracker.onAppClosing(async () => {
  if (isAppClosingHandled) {
    window.tracker.notifyAppClosingDone();
    return;
  }

  isAppClosingHandled = true;
  try {
    if (currentSessionId) {
      await persistSessionState();
      // Check if this is a shutdown - use shutdown timestamp if available
      const pendingEndAtMs = Number(
        await window.tracker.storeGet("pendingSessionEndAtMs"),
      );
      let sessionSaved = false;

      if (Number.isFinite(pendingEndAtMs) && pendingEndAtMs > 0) {
        // System shutdown detected - end session at shutdown time
        sessionSaved = await recoverPendingShutdownSession(pendingEndAtMs);
        if (sessionSaved) {
          console.log(
            "Session ended at system shutdown time:",
            new Date(pendingEndAtMs).toISOString(),
          );
        }
      } else {
        // Normal close - end session at current time
        sessionSaved = await endCurrentSession();
      }
      if (sessionSaved && window.tracker.invoke) {
        await window.tracker.invoke("session-end-confirmed");
        console.log("Session saved and confirmed before quit");
      }
    }
  } catch (err) {
    console.error("Failed to end session on app close:", err);
  } finally {
    window.tracker.notifyAppClosingDone();
  }
});

window.addEventListener("beforeunload", () => {
  if (currentSessionId) {
    void persistSessionState();
  }
});

onAuthChange(async (user) => {
  currentUser = user;
  if (user) {
    startTrackerSettingsWatch(user.uid);
    if (isRecentSignIn(user)) {
      const freshAuthTimeMs = Date.now();
      await window.tracker.storeSet("authTimeMs", freshAuthTimeMs);
      showDashboard(user);
      await restoreSession();
      await refreshTodayEndedSeconds();
      renderTodayTotalTime();
      await checkMacOSPermissions();
      return;
    }

    const authTimeMs = await ensureAuthTimeMs();
    showDashboard(user);
    await restoreSession();
    await refreshTodayEndedSeconds();
    renderTodayTotalTime();
    await checkMacOSPermissions();
  } else {
    stopTrackerSettingsWatch();
    clearTimers();
    clearSessionState();
    todayEndedSeconds = 0;
    renderTodayTotalTime();
    showLogin();
    hidePermissionBanner();
  }
});

loginBtn.addEventListener("click", handleLogin);
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});

async function handleLogin() {
  const email = emailInput.value.trim();
  const password = passInput.value;
  const remember = rememberCheckbox ? rememberCheckbox.checked : true;

  if (!email || !password) {
    loginError.textContent = "Please enter your email and password.";
    return;
  }

  loginError.textContent = "";
  loginBtn.disabled = true;
  loginBtn.textContent = "Logging in\u2026";

  try {
    await loginUser(email, password, remember);
    await window.tracker.storeSet("authTimeMs", Date.now());
    // Persist the preference and the email only \u2014 never the password.
    await window.tracker.storeSet("rememberMe", remember);
    await window.tracker.storeSet("savedEmail", remember ? email : null);
  } catch (err) {
    loginError.textContent = friendlyAuthError(err);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Login";
  }
}

logoutBtn.addEventListener("click", async () => {
  try {
    if (currentSessionId) {
      await endCurrentSession();
    }
  } catch (err) {
    console.error("Failed to finish session before logout:", err);
  }

  try {
    await window.tracker.storeSet("authTimeMs", null);
    await window.tracker.storeSet("sessionId", null);
    await window.tracker.storeSet("sessionStartTime", null);
    await window.tracker.storeSet("sessionStartedAtMs", null);
    await window.tracker.storeSet("sessionUserId", null);
    await window.tracker.storeSet("sessionElapsedMs", null);
    await window.tracker.storeSet("sessionIdleMs", null);
    await window.tracker.storeSet("sessionPaused", null);
    await window.tracker.storeSet("sessionPersistedAtMs", null);
    await window.tracker.storeSet("pendingSessionEndAtMs", null);
  } catch (err) {
    console.error("Failed to clear session state on logout:", err);
  }

  try {
    await logoutUser();
    showToast("Logged out successfully.");
  } catch (err) {
    console.error("Logout failed:", err);
    showToast("Logout failed. Please try again.");
    return;
  }

  clearTimers();
  clearSessionState();
  setInactiveUI();
  showLogin();
});

startBtn.addEventListener("click", async () => {
  if (currentSessionId) return;
  startBtn.disabled = true;
  startBtn.textContent = "Starting\u2026";
  void window.tracker.logEvent?.("start", "Start clicked");

  if (window.tracker.platform === "darwin") {
    void window.tracker.logEvent?.("start", "checking permissions\u2026");
    const perm = await checkMacOSPermissions();
    void window.tracker.logEvent?.(
      "start",
      `permissions result: ${JSON.stringify(perm)}`,
    );
    if (!perm || perm.timedOut) {
      showToast(
        perm?.timedOut
          ? "Permission check timed out \u2014 please try again."
          : "Could not verify permissions \u2014 please try again.",
      );
      startBtn.disabled = false;
      startBtn.textContent = "\u25b6 Start Session";
      return;
    }
    if (perm.needsRelaunch || perm.missing.length > 0) {
      showToast(
        perm.needsRelaunch
          ? "Relaunch required before starting \u2014 see the banner above."
          : `Can't start \u2014 grant: ${perm.missing.join(", ")}.`,
      );
      startBtn.disabled = false;
      startBtn.textContent = "\u25b6 Start Session";
      return;
    }
  }

  try {
    void window.tracker.logEvent?.(
      "start",
      "permissions OK \u2014 calling createSession (Firestore write)\u2026",
    );
    const SESSION_TIMEOUT = Symbol("session-timeout");
    const sessionId = await withTimeout(
      createSession(currentUser.uid),
      15000,
      SESSION_TIMEOUT,
    );
    if (sessionId === SESSION_TIMEOUT) {
      void window.tracker.logEvent?.(
        "start",
        "createSession TIMED OUT after 15s (Firestore write wedged)",
      );
      throw new Error(
        "Starting a session timed out \u2014 the server took too long to respond. Check your network connection (firewall/VPN/proxy) and try again.",
      );
    }
    void window.tracker.logEvent?.(
      "start",
      `createSession returned id=${sessionId}`,
    );
    currentSessionId = sessionId;
    sessionStartTime = Date.now();
    sessionStartedAtMs = sessionStartTime;
    beginSegments(sessionStartTime);
    elapsedBeforePauseMs = 0;
    totalIdleMs = 0;
    isSessionPaused = false;

    await window.tracker.storeSet("sessionId", sessionId);
    await window.tracker.storeSet("sessionStartTime", sessionStartTime);
    await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
    await window.tracker.storeSet("sessionUserId", currentUser.uid);
    await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
    await window.tracker.storeSet("sessionIdleMs", totalIdleMs);
    await window.tracker.storeSet("sessionPaused", false);

    startTimer();
    scheduleNextScreenshot();
    scheduleMidnightEnd();
    startIdlePoll();
    renderTodayTotalTime();
    setActiveUI();
  } catch (err) {
    console.error("Failed to start session:", err);
    const friendly = err?.message || "check the console.";
    showToast(`Could not start session \u2014 ${friendly}`);
    showDiagnostic(friendly);
    startBtn.disabled = false;
    startBtn.textContent = "\u25B6 Start Session";
  }
});

stopBtn.addEventListener("click", toggleSessionState);
endBtn.addEventListener("click", () => {
  void endCurrentSession();
});

async function toggleSessionState() {
  if (!currentSessionId) return;

  if (isSessionPaused) {
    await resumeSession();
    return;
  }

  await pauseSession();
}

async function pauseSession(dueToIdle = false, idleMs = null) {
  if (isIdle) {
    exitIdleMode();
  }
  const elapsedAtPauseMs = getElapsedMs();
  if (dueToIdle) {
    const requestedIdleMs = Number.isFinite(Number(idleMs))
      ? Math.max(getIdleThresholdMs(), Number(idleMs))
      : getIdleThresholdMs();
    // Count idle time that triggered the pause (at least the idle threshold)
    totalIdleMs += requestedIdleMs;
    // Record when idle was first detected so we can track the full duration
    idleStartedAtMs = Date.now();
    elapsedBeforePauseMs = elapsedAtPauseMs;
    openSegmentAt("i", Date.now() - requestedIdleMs);
  } else {
    elapsedBeforePauseMs = elapsedAtPauseMs;
    closeSegment(Date.now());
  }
  syncSegments();
  // Update user status in DB
  if (currentSessionId && dueToIdle) {
    void updateUserStatus(currentSessionId, "idle");
  }
  sessionStartTime = null;
  clearInterval(timerInterval);
  timerInterval = null;
  clearTimeout(screenshotTimeout);
  screenshotTimeout = null;
  if (!dueToIdle) {
    stopIdlePoll();
  }
  isSessionPaused = true;
  pausedDueToIdle = dueToIdle;
  if (dueToIdle) {
    isIdle = true;
  }
  renderTimer();
  await persistSessionState();
  setPausedUI();
}

async function resumeSession() {
  if (isPastSessionMidnight()) {
    await endCurrentSession();
    return;
  }

  // Calculate the full idle duration from when idle was first detected until now
  if (idleStartedAtMs !== null && pausedDueToIdle) {
    // Full wall-clock time the user was away
    const fullIdleMs = Date.now() - idleStartedAtMs;
    // Replace the initial threshold with the actual full idle duration
    totalIdleMs = Math.max(totalIdleMs, Math.round(fullIdleMs));
    idleStartedAtMs = null;
  }

  sessionStartTime = Date.now();
  isSessionPaused = false;
  pausedDueToIdle = false;
  isIdle = false;
  openSegmentAt("a", sessionStartTime);
  await persistSessionState();
  startTimer();
  scheduleNextScreenshot();
  scheduleMidnightEnd();
  startIdlePoll();
  setActiveUI();

  // Update user status to active in DB
  if (currentSessionId) {
    void updateUserStatus(currentSessionId, "active");
  }
}

async function endCurrentSession(endTimeMs = null) {
  if (!currentSessionId) return false;

  const candidateEndTime =
    typeof endTimeMs === "number" || typeof endTimeMs === "string"
      ? new Date(endTimeMs)
      : endTimeMs instanceof Date
        ? new Date(endTimeMs.getTime())
        : new Date();
  const endTime = Number.isNaN(candidateEndTime.getTime())
    ? new Date()
    : candidateEndTime;
  const { duration, idleTime } = getSessionTotalsAt(endTime.getTime());

  console.log(
    `[Session End Details] Duration: ${duration}s, Idle: ${idleTime}s, End Time: ${endTime.toISOString()} (${endTime.toLocaleTimeString()})`,
  );

  clearTimers();
  closeSegment(endTime.getTime());

  let firebaseSaved = false;
  try {
    await endSession(
      currentSessionId,
      duration,
      idleTime,
      endTime,
      getEffectiveSessionStartDate(endTime.getTime()),
      segmentLog.filter((seg) => seg.s < endTime.getTime()),
    );
    firebaseSaved = true;
    console.log(
      `[Session End Success] Session ${currentSessionId} successfully saved to Firestore.`,
    );
  } catch (err) {
    console.error(
      "[Session End Error] Failed to end session in Firestore:",
      err,
    );
    return false;
  }

  // Only clear if Firebase save succeeded
  if (firebaseSaved) {
    await clearStoredSession();
    clearSessionState();
    await refreshTodayEndedSeconds();
    renderTodayTotalTime();
    setInactiveUI();
  }

  return firebaseSaved;
}

async function recoverPendingShutdownSession(pendingEndAtMs) {
  if (!currentSessionId || !Number.isFinite(pendingEndAtMs)) {
    return false;
  }

  const effectiveEndAtMs = sessionStartedAtMs
    ? Math.min(getRolloverEndMs(sessionStartedAtMs), pendingEndAtMs)
    : pendingEndAtMs;
  const { duration, idleTime } = getSessionTotalsAt(effectiveEndAtMs);
  const endTime = new Date(effectiveEndAtMs);
  closeSegment(effectiveEndAtMs);
  const savedSegments = segmentLog
    .filter((seg) => seg.s < effectiveEndAtMs)
    .map((seg) => ({ ...seg, e: Math.min(seg.e, effectiveEndAtMs) }));

  try {
    await endSession(
      currentSessionId,
      duration,
      idleTime,
      endTime,
      getEffectiveSessionStartDateAt(effectiveEndAtMs),
      savedSegments,
    );
  } catch (err) {
    console.error("Failed to recover session after shutdown:", err);
    return false;
  }

  await clearStoredSession();
  clearSessionState();
  await refreshTodayEndedSeconds();
  renderTodayTotalTime();
  // No setInactiveUI() here: during boot recovery it would re-enable Start
  // before the auto-started session exists. Callers set the UI.
  showToast("Previous session was closed at the last shutdown time.");
  return true;
}

async function restoreSession() {
  // Recovery below can close yesterday's session and auto-start a new one.
  // A Start click in the meantime would create a second session that this
  // code then forgets, leaving it "active" forever. Every exit path below
  // sets the UI again (or resetStuckButtons does on error).
  startBtn.disabled = true;
  startBtn.textContent = "Restoring…";

  const sessionId = await window.tracker.storeGet("sessionId");
  const startTime = await window.tracker.storeGet("sessionStartTime");
  const startedAtMs = await window.tracker.storeGet("sessionStartedAtMs");
  const userId = await window.tracker.storeGet("sessionUserId");
  const pendingSessionEndAtMs = Number(
    await window.tracker.storeGet("pendingSessionEndAtMs"),
  );
  const lastPersistedAtMs = Number(
    await window.tracker.storeGet("sessionPersistedAtMs"),
  );
  const elapsedMs = Number(
    (await window.tracker.storeGet("sessionElapsedMs")) ?? 0,
  );
  const idleMs = Number((await window.tracker.storeGet("sessionIdleMs")) ?? 0);
  const paused = Boolean(await window.tracker.storeGet("sessionPaused"));

  if (sessionId && userId === currentUser.uid) {
    const restoredStartTime = Number(startTime);
    currentSessionId = sessionId;
    elapsedBeforePauseMs = elapsedMs;
    totalIdleMs = Math.max(0, idleMs);
    isSessionPaused = paused;
    sessionStartTime = paused ? null : restoredStartTime;
    sessionStartedAtMs = Number.isFinite(Number(startedAtMs))
      ? Number(startedAtMs)
      : restoredStartTime;
    const storedSegments = await window.tracker.storeGet("sessionSegments");
    segmentLog = Array.isArray(storedSegments?.log) ? storedSegments.log : [];
    openSegment = storedSegments?.open ?? null;

    if (pendingSessionEndAtMs) {
      const endpointMs = Number.isFinite(lastPersistedAtMs)
        ? Math.min(pendingSessionEndAtMs, lastPersistedAtMs)
        : pendingSessionEndAtMs;
      const recovered = await recoverPendingShutdownSession(endpointMs);
      if (recovered) {
        await startNewSessionAfterRecovery();
        return;
      }

      showToast(
        "Previous session pending recovery — will retry on next start.",
      );
      setInactiveUI();
      return;
    }

    if (
      Number.isFinite(lastPersistedAtMs) &&
      lastPersistedAtMs > sessionStartedAtMs
    ) {
      const recovered = await recoverPendingShutdownSession(lastPersistedAtMs);
      if (recovered) {
        // Auto-start new session after shutdown recovery
        await startNewSessionAfterRecovery();
        return;
      }

      showToast(
        "Previous session pending recovery — will retry on next start.",
      );
      setInactiveUI();
      return;
    }

    if (
      Number.isFinite(sessionStartedAtMs) &&
      hasCrossedMidnight(sessionStartedAtMs)
    ) {
      await window.tracker.storeSet("pendingSessionEndAtMs", null);
      await rolloverSessionAfterMidnight();
      return;
    }

    if (isSessionPaused) {
      renderTimer();
      setPausedUI();
      scheduleMidnightEnd();
      return;
    }

    startTimer();
    scheduleNextScreenshot();
    scheduleMidnightEnd();
    startIdlePoll();
    setActiveUI();
    return;
  }

  await window.tracker.storeSet("pendingSessionEndAtMs", null);
  setInactiveUI();
}

async function startNewSessionAfterRecovery() {
  try {
    const RECOVERY_TIMEOUT = Symbol("session-timeout");
    const sessionId = await withTimeout(
      createSession(currentUser.uid),
      15000,
      RECOVERY_TIMEOUT,
    );
    if (sessionId === RECOVERY_TIMEOUT) {
      throw new Error("Starting the recovered session timed out.");
    }
    currentSessionId = sessionId;
    sessionStartTime = Date.now();
    sessionStartedAtMs = sessionStartTime;
    beginSegments(sessionStartTime);
    elapsedBeforePauseMs = 0;
    totalIdleMs = 0;
    isSessionPaused = false;

    await window.tracker.storeSet("sessionId", sessionId);
    await window.tracker.storeSet("sessionStartTime", sessionStartTime);
    await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
    await window.tracker.storeSet("sessionUserId", currentUser.uid);
    await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
    await window.tracker.storeSet("sessionIdleMs", totalIdleMs);
    await window.tracker.storeSet("sessionPaused", false);

    startTimer();
    scheduleNextScreenshot();
    scheduleMidnightEnd();
    startIdlePoll();
    await refreshTodayEndedSeconds();
    renderTodayTotalTime();
    setActiveUI();
    showToast("New session started automatically.");
  } catch (err) {
    console.error("Failed to auto-start session after recovery:", err);
    showToast("Session recovered. Please start a new session.");
    setInactiveUI();
  }
}

async function rolloverSessionAfterMidnight() {
  const rolloverEndTime = new Date(getRolloverEndMs(sessionStartedAtMs));
  const { duration: rolloverDuration, idleTime: rolloverIdleTime } =
    getSessionTotalsAt(rolloverEndTime.getTime());

  try {
    await endSession(
      currentSessionId,
      rolloverDuration,
      rolloverIdleTime,
      rolloverEndTime,
      new Date(sessionStartedAtMs),
    );
  } catch (err) {
    console.error("Failed to close previous session at rollover:", err);
  }

  await clearStoredSession();
  clearSessionState();

  const freshSessionId = await createSession(currentUser.uid);
  currentSessionId = freshSessionId;
  sessionStartTime = Date.now();
  sessionStartedAtMs = sessionStartTime;
  beginSegments(sessionStartTime);
  elapsedBeforePauseMs = 0;
  totalIdleMs = 0;
  isSessionPaused = false;

  await window.tracker.storeSet("sessionId", freshSessionId);
  await window.tracker.storeSet("sessionStartTime", sessionStartTime);
  await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
  await window.tracker.storeSet("sessionUserId", currentUser.uid);
  await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
  await window.tracker.storeSet("sessionIdleMs", totalIdleMs);
  await window.tracker.storeSet("sessionPaused", false);

  startTimer();
  scheduleNextScreenshot();
  scheduleMidnightEnd();
  startIdlePoll();
  await refreshTodayEndedSeconds();
  renderTodayTotalTime();
  setActiveUI();
  showToast("Previous session ended at 11:59 PM. New session started.");
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  renderTimer();
  timerInterval = setInterval(renderTimer, 1000);
  // Persist session state periodically so sudden shutdowns can be recovered
  if (sessionPersistInterval) clearInterval(sessionPersistInterval);
  sessionPersistInterval = setInterval(() => {
    // best-effort, do not block UI
    void persistSessionState();
  }, 15 * 1000);
}

function renderTimer() {
  const secs = Math.max(0, Math.floor(getElapsedMs() / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  timerDisplay.textContent = `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  renderTodayTotalTime();
  void persistSessionState();
}

function getLocalDayRange() {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return { dayStart, dayEnd };
}

function isRecentSignIn(user, windowMs = 2 * 60 * 1000) {
  const lastSignInRaw = user?.metadata?.lastSignInTime;
  if (!lastSignInRaw) return false;

  const lastSignInMs = new Date(lastSignInRaw).getTime();
  if (!Number.isFinite(lastSignInMs)) return false;

  return Date.now() - lastSignInMs <= windowMs;
}

async function ensureAuthTimeMs() {
  const storedValue = Number(await window.tracker.storeGet("authTimeMs"));
  if (Number.isFinite(storedValue)) {
    return storedValue;
  }

  const authTimeMs = Date.now();
  await window.tracker.storeSet("authTimeMs", authTimeMs);
  return authTimeMs;
}

function clearNewSessionTimer() {
  clearTimeout(newSessionTimeout);
  newSessionTimeout = null;
}

async function refreshTodayEndedSeconds() {
  if (!currentUser) {
    todayEndedSeconds = 0;
    todayIdleSeconds = 0;
    return;
  }

  const { dayStart, dayEnd } = getLocalDayRange();
  try {
    const summary = await getTodaySessionsSummary(
      currentUser.uid,
      dayStart,
      dayEnd,
    );
    todayEndedSeconds = summary.totalEndedSeconds;
    todayIdleSeconds = summary.totalIdleSeconds;
    todaySessions = summary.sessions.map((session) => ({
      id: session.id,
      start: session.startTime?.getTime() || 0,
      end: session.endTime?.getTime() || Date.now(),
      activeMs: (session.endedSecondsForToday || 0) * 1000,
      idleMs: (session.idleSecondsForToday || 0) * 1000,
      segments: session.segments,
      ended: session.status === "ended",
    }));

    console.log("Today's sessions summary", {
      date: dayStart.toLocaleDateString(),
      userId: summary.userId,
      count: summary.sessions.length,
      totalEndedSeconds: summary.totalEndedSeconds,
      totalIdleSeconds: summary.totalIdleSeconds,
    });
  } catch (err) {
    console.error("Failed to load today's total time:", err);
  }
}

// Today's manual entries as merged windows (overlaps count once), in ms.
function manualWindows() {
  return mergeWindows(
    manualEntries.map((e) => ({ start: e.start.getTime(), end: e.end.getTime() })),
  );
}

// Tracked active/idle time that today's manual entries replace (INC-192).
function getManualOverrideCuts() {
  if (!manualEntries.length) return { activeCut: 0, idleCut: 0 };
  const now = Date.now();
  // Only ended sessions are in Today's figures (plus the current one, below),
  // so only they can have minutes replaced.
  const sessions = todaySessions.filter((x) => x.ended && x.id !== currentSessionId);
  if (currentSessionId) {
    sessions.push({ start: sessionStartedAtMs || now, end: now, segments: currentSegments(now) });
  }
  return applyManualOverride(sessions, manualWindows());
}

function renderTodayTotalTime() {
  if (!todayTotalTime) return;
  // Show work time only (excluding idle time)
  const trackedIdleMs = getTrackedIdleMs();
  const { activeCut, idleCut } = getManualOverrideCuts();
  const currentSessionWorkMs = Math.max(0, getElapsedMs() - trackedIdleMs);
  const currentSessionSeconds = Math.floor(currentSessionWorkMs / 1000);
  const totalSeconds = Math.max(
    0,
    todayEndedSeconds + currentSessionSeconds - Math.floor(activeCut / 1000),
  );
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  todayTotalTime.textContent = `${pad(h)}h ${pad(m)}m ${pad(s)}s`;

  // Show idle time: completed idle (from Firebase) + current session idle
  if (todayIdleTime) {
    const currentIdleSeconds = Math.floor(trackedIdleMs / 1000);
    const totalIdleSecs = Math.max(
      0,
      todayIdleSeconds + currentIdleSeconds - Math.floor(idleCut / 1000),
    );
    const ih = Math.floor(totalIdleSecs / 3600);
    const im = Math.floor((totalIdleSecs % 3600) / 60);
    const is = totalIdleSecs % 60;
    todayIdleTime.textContent = `${pad(ih)}h ${pad(im)}m ${pad(is)}s`;
  }
}

function getCurrentIdleMs(referenceMs = Date.now()) {
  if (!isIdle || !Number.isFinite(idleStartedAtMs)) return 0;
  return Math.max(0, referenceMs - idleStartedAtMs);
}

function getTrackedIdleMs(referenceMs = Date.now()) {
  return Math.max(0, totalIdleMs + getCurrentIdleMs(referenceMs));
}

function enterIdleMode(observedIdleMs = 0) {
  if (!currentSessionId || isSessionPaused || isIdle) return;
  const observed = Number(observedIdleMs);
  const now = Date.now();

  isIdle = true;
  // The OS reports time since the last input, which can reach back past this
  // session's start (e.g. to last night after a morning boot). Never count
  // idle from before the session (or the last resume) began.
  idleStartedAtMs = Math.max(
    now - (Number.isFinite(observed) ? Math.max(0, observed) : 0),
    sessionStartTime ?? now,
  );
  openSegmentAt("i", idleStartedAtMs);
  statusText.textContent = "Session active (idle detected)";
  statusText.className = "status-text active";
  renderTodayTotalTime();
  void persistSessionState();

  if (currentSessionId) {
    void updateUserStatus(currentSessionId, "idle");
  }
}

function exitIdleMode() {
  if (!isIdle) return;

  totalIdleMs = getTrackedIdleMs();
  isIdle = false;
  idleStartedAtMs = null;
  if (isSessionPaused) closeSegment(Date.now());
  else openSegmentAt("a", Date.now());
  syncSegments();

  if (!isSessionPaused) {
    statusText.textContent = "Session active";
    statusText.className = "status-text active";
  }

  renderTodayTotalTime();
  void persistSessionState();

  if (currentSessionId && !isSessionPaused) {
    void updateUserStatus(currentSessionId, "active");
  }
}

function getElapsedMs() {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + (Date.now() - sessionStartTime);
}

function getWorkTimeMs() {
  if (!currentSessionId) return 0;
  const totalElapsed = getElapsedMs();
  return Math.max(0, totalElapsed - getTrackedIdleMs());
}

function getElapsedMsAt(referenceMs) {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + Math.max(0, referenceMs - sessionStartTime);
}

// The one place a session's saved totals are computed, for every end path
// (End button, quit, next-boot recovery, midnight). Work = elapsed - idle, and
// idle can never exceed elapsed.
// ponytail: idle recorded after endMs (e.g. a recovery capped at 23:59:59 that
// last saved next morning) can't be separated out, only capped. Keep per-day
// idle in the store if exact splits ever matter.
function getSessionTotalsAt(endMs) {
  const elapsedMs = getElapsedMsAt(endMs);
  const idleMs = Math.min(getTrackedIdleMs(endMs), elapsedMs);
  return {
    duration: Math.floor((elapsedMs - idleMs) / 1000),
    idleTime: Math.floor(idleMs / 1000),
  };
}

function getEffectiveSessionStartDate(referenceMs = Date.now()) {
  if (Number.isFinite(sessionStartedAtMs)) {
    return new Date(sessionStartedAtMs);
  }

  return new Date(referenceMs - getElapsedMs());
}

function getEffectiveSessionStartDateAt(referenceMs) {
  if (Number.isFinite(sessionStartedAtMs)) {
    return new Date(sessionStartedAtMs);
  }
  return new Date(referenceMs - getElapsedMsAt(referenceMs));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

const SCREENSHOT_BLOCK_MIN_OFFSET_MS = 1 * 60 * 1000;

function startIdlePoll() {
  stopIdlePoll();
  idlePollInterval = setInterval(async () => {
    if (!currentSessionId) return;

    try {
      // Get actual idle time from system
      const idleSeconds = Number(await window.tracker.getIdleTime());
      const idleMs = Number.isFinite(idleSeconds) ? idleSeconds * 1000 : 0;

      // Debug logging
      console.log("Idle check:", {
        idleSeconds,
        idleMs,
        threshold: getIdleThresholdMs(),
        isIdle,
        isSessionPaused,
        willPause:
          idleMs >= getIdleThresholdMs() && !isIdle && !isSessionPaused,
      });

      // Check if user is idle (past the admin-set idle threshold)
      if (idleMs >= getIdleThresholdMs() && !isIdle && !isSessionPaused) {
        console.log("User is idle, tracking idle time without pausing session");
        enterIdleMode(idleMs);
        showToast("Session idle detected — time excluded from duration.");
      } else if (
        isIdle &&
        // Back only once there has been input since idle began. A plain
        // "under 15 min" check would end a screen-lock idle 10s after it starts.
        Date.now() - idleMs > idleStartedAtMs + IDLE_INPUT_TOLERANCE_MS &&
        !idleResumeInProgress
      ) {
        console.log("User is active, ending idle state");
        idleResumeInProgress = true;
        try {
          exitIdleMode();
          showToast("Session active again.");
        } finally {
          idleResumeInProgress = false;
        }
      }
    } catch (err) {
      console.error("Idle poll error:", err);
    }
  }, 10000);
}

function stopIdlePoll() {
  clearInterval(idlePollInterval);
  idlePollInterval = null;
}

function scheduleNextScreenshot() {
  if (screenshotTimeout) clearTimeout(screenshotTimeout);
  if (isSessionPaused) {
    screenshotTimeout = null;
    return;
  }
  const nowElapsed = getElapsedMs();
  const blockMs = getScreenshotBlockMs();

  const currentBlock = Math.floor(nowElapsed / blockMs);
  const currentBlockStart = currentBlock * blockMs;
  const currentWindowStart = currentBlockStart + SCREENSHOT_BLOCK_MIN_OFFSET_MS;

  const targetBlock =
    nowElapsed < currentWindowStart ? currentBlock : currentBlock + 1;
  const targetBlockStart = targetBlock * blockMs;
  const minOffset = targetBlockStart + SCREENSHOT_BLOCK_MIN_OFFSET_MS;
  const maxOffset = targetBlockStart + blockMs;

  const randWindow = Math.max(1, maxOffset - minOffset);
  const targetElapsed = minOffset + Math.floor(Math.random() * randWindow);

  const delay = Math.max(0, targetElapsed - nowElapsed);
  screenshotTimeout = setTimeout(captureAndUpload, delay);
}

function getNextRolloverMs(referenceMs = Date.now()) {
  const nextRollover = new Date(referenceMs);
  nextRollover.setHours(23, 59, 59, 999);
  if (nextRollover.getTime() <= referenceMs) {
    nextRollover.setDate(nextRollover.getDate() + 1);
  }
  return nextRollover.getTime();
}

function getNextMidnightMs(referenceMs = Date.now()) {
  const nextMidnight = new Date(referenceMs);
  nextMidnight.setHours(0, 0, 0, 0);
  if (nextMidnight.getTime() < referenceMs) {
    nextMidnight.setDate(nextMidnight.getDate() + 1);
  }
  return nextMidnight.getTime();
}

function getRolloverEndMs(startMs) {
  const rolloverEnd = new Date(startMs);
  rolloverEnd.setHours(23, 59, 59, 999);
  if (rolloverEnd.getTime() < startMs) {
    rolloverEnd.setDate(rolloverEnd.getDate() + 1);
  }
  return rolloverEnd.getTime();
}

function hasCrossedMidnight(startMs, referenceMs = Date.now()) {
  const startDate = new Date(startMs);
  const referenceDate = new Date(referenceMs);
  return (
    startDate.getFullYear() !== referenceDate.getFullYear() ||
    startDate.getMonth() !== referenceDate.getMonth() ||
    startDate.getDate() !== referenceDate.getDate()
  );
}

function isPastSessionMidnight(referenceMs = Date.now()) {
  if (!sessionStartedAtMs) return false;
  return hasCrossedMidnight(sessionStartedAtMs, referenceMs);
}

function clearMidnightTimer() {
  clearTimeout(midnightTimeout);
  midnightTimeout = null;
}

function scheduleNewSessionAtRollover(targetTimeMs = null) {
  clearNewSessionTimer();
  if (!currentUser) return;

  const now = Date.now();
  // Use passed target time or calculate from current time
  const midnightTime = targetTimeMs || getNextMidnightMs(now);
  const delay = Math.max(0, midnightTime - now);

  console.log(
    `[New Session Scheduled] Starting at: ${new Date(midnightTime).toISOString()}, delay: ${delay}ms`,
  );

  newSessionTimeout = setTimeout(async () => {
    clearNewSessionTimer();

    // IMPORTANT: Force clear old session ID to ensure new session can start
    if (currentSessionId) {
      console.log(
        `[New Session] WARNING: Clearing leftover sessionId: ${currentSessionId}`,
      );
      currentSessionId = null;
    }

    if (!currentUser) {
      console.log("[New Session] Skipped - user logged out.");
      return;
    }

    try {
      console.log(
        `[New Session] Creating new session at: ${new Date().toISOString()} (${new Date().toLocaleTimeString()})`,
      );
      const ROLLOVER_TIMEOUT = Symbol("session-timeout");
      const sessionId = await withTimeout(
        createSession(currentUser.uid),
        15000,
        ROLLOVER_TIMEOUT,
      );
      if (sessionId === ROLLOVER_TIMEOUT) {
        throw new Error("Starting the rollover session timed out.");
      }
      currentSessionId = sessionId;
      sessionStartTime = Date.now();
      sessionStartedAtMs = sessionStartTime;
      beginSegments(sessionStartTime);
      elapsedBeforePauseMs = 0;
      totalIdleMs = 0;
      isSessionPaused = false;

      await window.tracker.storeSet("sessionId", sessionId);
      await window.tracker.storeSet("sessionStartTime", sessionStartTime);
      await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
      await window.tracker.storeSet("sessionUserId", currentUser.uid);
      await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
      await window.tracker.storeSet("sessionIdleMs", totalIdleMs);
      await window.tracker.storeSet("sessionPaused", false);

      startTimer();
      scheduleNextScreenshot();
      scheduleMidnightEnd();
      startIdlePoll();
      await refreshTodayEndedSeconds();
      renderTodayTotalTime();
      setActiveUI();
      console.log(`[New Session] Successfully created session: ${sessionId}`);
      showToast("New session started at 12:00 AM.");
    } catch (err) {
      console.error(
        "[New Session Error] Failed to start new session at rollover:",
        err,
      );
      showToast("Could not start new session at 12:00 AM.");
      // Retry in 5 seconds if failed
      newSessionTimeout = setTimeout(
        () => scheduleNewSessionAtRollover(),
        5000,
      );
    }
  }, delay);
}

function scheduleMidnightEnd() {
  clearMidnightTimer();
  if (!currentSessionId) return;

  const now = Date.now();
  const rolloverTime = getNextRolloverMs(now);
  const delay = Math.max(0, rolloverTime - now);

  const newSessionTime = new Date(rolloverTime);
  newSessionTime.setHours(0, 0, 0, 0);
  newSessionTime.setDate(newSessionTime.getDate() + 1);
  const newSessionTimeMs = newSessionTime.getTime();

  midnightTimeout = setTimeout(async () => {
    if (!currentSessionId) return;

    const wasPausedAtRollover = isSessionPaused;

    const isUserActive = !isIdle && !isSessionPaused;
    const hasSessionToEnd = Boolean(currentSessionId);

    console.log(
      `[Midnight Check] User Active: ${isUserActive}, Session Paused: ${isSessionPaused}`,
    );

    const endTime = new Date(rolloverTime);
    console.log(
      `[Session End] Ending session at: ${endTime.toISOString()} (${endTime.toLocaleTimeString()})`,
    );

    if (hasSessionToEnd) {
      try {
        const success = await endCurrentSession(rolloverTime);
        if (success) {
          showToast("Session ended at 11:59:59 PM.");
          console.log(
            "[Session End] Session successfully ended at rollover time.",
          );
        } else {
          console.error("[Session End] Failed to end session at rollover.");
          showToast("Warning: Could not end session at 11:59 PM.");
        }
      } catch (err) {
        console.error("[Session End] Error ending session:", err);
        showToast("Error ending session at 11:59 PM.");
      }
    }

    if (wasPausedAtRollover) {
      console.log(
        "[Session End] Session was paused at rollover; skipping 12:00 AM auto-start.",
      );
      showToast("Paused session ended at 11:59 PM. No new session started.");
      return;
    }

    console.log(
      `[Session End] Now scheduling new session to start at 12:00 AM...`,
    );
    scheduleNewSessionAtRollover(newSessionTimeMs);
  }, delay);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot image"));
    img.src = url;
  });
}

// Each screenshot is stored in three sizes. Heights are per monitor, so a
// multi-monitor capture keeps every screen readable. `height: null` = the
// monitor's real size.
const SCREENSHOT_VERSIONS = [
  { name: "thumb", height: 169, quality: 0.5 },
  { name: "std", height: 720, quality: 0.6 },
  { name: "full", height: null, quality: 0.8 },
];

// Stitches all screens side by side, each at its real size, and encodes every
// version as WebP. Returns { thumb, std, full } blobs.
async function buildScreenshotVersions(screens) {
  if (!Array.isArray(screens) || screens.length === 0) {
    throw new Error("No screenshot data received");
  }

  const images = await Promise.all(screens.map((s) => loadImage(s.dataUrl)));
  const sizes = images.map((img, i) => ({
    width: screens[i].width || img.naturalWidth,
    height: screens[i].height || img.naturalHeight,
  }));
  const fullWidth = sizes.reduce((sum, s) => sum + s.width, 0);
  const fullHeight = Math.max(...sizes.map((s) => s.height));

  const versions = {};
  for (const { name, height, quality } of SCREENSHOT_VERSIONS) {
    const scale = height ? Math.min(1, height / fullHeight) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(fullWidth * scale);
    canvas.height = Math.round(fullHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to prepare screenshot canvas");
    }

    let x = 0;
    images.forEach((img, i) => {
      const width = sizes[i].width * scale;
      ctx.drawImage(img, x, 0, width, sizes[i].height * scale);
      x += width;
    });

    versions[name] = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Failed to encode screenshot")),
        "image/webp",
        quality,
      ),
    );
  }
  return versions;
}

function normalizeCapturedScreens(captureResult) {
  if (!Array.isArray(captureResult)) {
    if (Array.isArray(captureResult?.dataUrls)) {
      return captureResult.dataUrls.map((dataUrl, index) => ({
        screenName: `Screen ${index + 1}`,
        displayId: null,
        dataUrl,
      }));
    }
    return [];
  }

  return captureResult
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          screenName: `Screen ${index + 1}`,
          displayId: null,
          dataUrl: item,
        };
      }

      const dataUrl = item?.dataUrl;
      if (!dataUrl) return null;

      return {
        screenName: item.screenName || `Screen ${index + 1}`,
        displayId: item.displayId ? String(item.displayId) : null,
        dataUrl,
        width: item.width || null,
        height: item.height || null,
      };
    })
    .filter(Boolean);
}

async function captureAndUpload() {
  if (!currentSessionId || !currentUser || isSessionPaused) return;

  try {
    const captureResult = await window.tracker.takeScreenshot();
    if (
      !captureResult ||
      (Array.isArray(captureResult) && captureResult.length === 0)
    ) {
      throw new Error(
        "Screenshot capture returned no data. Please check Screen Recording permission.",
      );
    }
    const capturedScreens = normalizeCapturedScreens(captureResult);
    const image = await uploadScreenshot(
      await buildScreenshotVersions(capturedScreens),
    );
    const now = new Date();

    const displayIds = capturedScreens
      .map((screen) => screen.displayId)
      .filter(Boolean);
    const activityContexts =
      await window.tracker.getActivityContexts(displayIds);
    const activeContext = activityContexts?.active || {
      summary: "Unknown activity",
    };

    if (activityContexts?.permissionError || activityContexts?.needsRelaunch) {
      await checkMacOSPermissions();
    }

    const perScreenContextMap = new Map(
      (activityContexts?.perScreen || [])
        .filter((item) => item?.displayId)
        .map((item) => [String(item.displayId), item]),
    );

    const screenSummaries = capturedScreens.map((screen) => {
      const perScreen = screen.displayId
        ? perScreenContextMap.get(String(screen.displayId))
        : null;
      const summary =
        perScreen?.summary || activeContext.summary || "Unknown activity";
      return `${screen.screenName}: ${summary}`;
    });
    const combinedSummary = screenSummaries.join(" | ");

    console.log("Screen activities:", screenSummaries);

    await saveScreenshot(
      currentSessionId,
      currentUser.uid,
      image,
      now.toISOString(),
      {
        ...activeContext,
        summary: combinedSummary || activeContext.summary || "Unknown activity",
        screenCount: capturedScreens.length,
        screenSummaries,
      },
    );

    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const activityText = combinedSummary ? ` (${combinedSummary})` : "";
    hideDiagnostic();
    showToast(`Screenshot captured at ${timeStr}${activityText}`);
    await window.tracker.showNotification(
      "Team Tracker",
      `Screenshot captured at ${timeStr}${activityText}`,
    );
  } catch (err) {
    console.error("Screenshot capture/upload failed:", err);
    const friendly = friendlyScreenshotError(err);
    showToast(`Screenshot failed: ${friendly}`);
    showDiagnostic(friendly);
    // If it looks like a Screen Recording problem, surface the banner too so
    // the user can grant access or relaunch.
    if (
      window.tracker.platform === "darwin" &&
      /permission|not allowed|screen recording|no screen sources/i.test(
        err?.message || "",
      )
    ) {
      await checkMacOSPermissions();
    }
  } finally {
    scheduleNextScreenshot();
  }
}

function showDashboard(user) {
  loginView.classList.remove("active");
  dashView.classList.add("active");
  welcomeMsg.textContent = user.email;
}

function showLogin() {
  dashView.classList.remove("active");
  loginView.classList.add("active");
  passInput.value = "";
  loginError.textContent = "";
  void prefillRememberedEmail();
}

async function prefillRememberedEmail() {
  try {
    const stored = await window.tracker.storeGet("rememberMe");
    // Default to "on" until the user explicitly opts out, so sessions persist
    // and users don't have to sign in every day.
    const remembered = stored == null ? true : Boolean(stored);
    const savedEmail = await window.tracker.storeGet("savedEmail");
    if (rememberCheckbox) rememberCheckbox.checked = remembered;
    emailInput.value = remembered && savedEmail ? savedEmail : "";
  } catch (err) {
    console.error("Failed to prefill remembered email:", err);
    emailInput.value = "";
  }
}

function setActiveUI() {
  statusText.textContent = "Session active";
  statusText.className = "status-text active";
  startBtn.style.display = "none";
  stopBtn.style.display = "";
  endBtn.style.display = "";
  stopBtn.disabled = false;
  stopBtn.classList.remove("btn-success");
  stopBtn.classList.add("btn-danger");
  stopBtn.innerHTML = "&#10074;&#10074; Pause Session";
  endBtn.disabled = false;
}

function setPausedUI() {
  statusText.textContent = "Session paused";
  statusText.className = "status-text";
  startBtn.style.display = "none";
  stopBtn.style.display = "";
  endBtn.style.display = "";
  stopBtn.disabled = false;
  stopBtn.classList.remove("btn-danger");
  stopBtn.classList.add("btn-success");
  stopBtn.innerHTML = "&#9654; Resume Session";
  endBtn.disabled = false;
}

function setInactiveUI() {
  timerDisplay.textContent = "00h 00m 00s";
  statusText.textContent = "No active session";
  statusText.className = "status-text";
  startBtn.style.display = "";
  startBtn.disabled = false;
  startBtn.textContent = "\u25B6 Start Session";
  stopBtn.style.display = "none";
  endBtn.style.display = "none";
  stopBtn.disabled = true;
  stopBtn.classList.remove("btn-success");
  stopBtn.classList.add("btn-danger");
  stopBtn.innerHTML = "&#10074;&#10074; Pause Session";
  endBtn.disabled = true;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastArea.appendChild(toast);

  requestAnimationFrame(() =>
    requestAnimationFrame(() => toast.classList.add("visible")),
  );

  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

function clearTimers() {
  clearInterval(timerInterval);
  timerInterval = null;
  clearTimeout(screenshotTimeout);
  screenshotTimeout = null;
  clearMidnightTimer();
  clearNewSessionTimer();
  stopIdlePoll();
  if (sessionPersistInterval) {
    clearInterval(sessionPersistInterval);
    sessionPersistInterval = null;
  }
}

function clearSessionState() {
  currentSessionId = null;
  sessionStartTime = null;
  sessionStartedAtMs = null;
  elapsedBeforePauseMs = 0;
  totalIdleMs = 0;
  isIdle = false;
  isSessionPaused = false;
  pausedDueToIdle = false;
  idleResumeInProgress = false;
  idleStartedAtMs = null;
  segmentLog = [];
  openSegment = null;
}

async function clearStoredSession() {
  await window.tracker.storeSet("sessionId", null);
  await window.tracker.storeSet("sessionStartTime", null);
  await window.tracker.storeSet("sessionStartedAtMs", null);
  await window.tracker.storeSet("sessionUserId", null);
  await window.tracker.storeSet("sessionElapsedMs", null);
  await window.tracker.storeSet("sessionIdleMs", null);
  await window.tracker.storeSet("sessionPaused", null);
  await window.tracker.storeSet("sessionPersistedAtMs", null);
  await window.tracker.storeSet("sessionSegments", null);
  await window.tracker.storeSet("pendingSessionEndAtMs", null);
}

async function persistSessionState() {
  await window.tracker.storeSet("sessionStartTime", sessionStartTime);
  await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
  await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
  await window.tracker.storeSet("sessionIdleMs", getTrackedIdleMs());
  await window.tracker.storeSet("sessionPaused", isSessionPaused);
  await window.tracker.storeSet("sessionSegments", { log: segmentLog, open: openSegment });
  await window.tracker.storeSet("sessionPersistedAtMs", Date.now());
}

function friendlyAuthError(err) {
  const map = {
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-email": "Invalid email address.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/too-many-requests": "Too many failed attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/user-disabled": "This account has been disabled.",
  };
  return map[err.code] || err.message || "Login failed. Please try again.";
}

// ─── Tracker settings + manual time (INC-192) ───────────────────────────────
// Admins set these per person in the portal (Activity Tracker → Tracker
// settings). They apply without a restart.

const manualCard = document.getElementById("today-manual-card");
const manualTimeValue = document.getElementById("today-manual-time");
const manualSection = document.getElementById("manual-section");
const manualList = document.getElementById("manual-list");
const manualEmpty = document.getElementById("manual-empty");
const manualAddBtn = document.getElementById("manual-add-btn");
const manualDialog = document.getElementById("manual-dialog");
const manualForm = document.getElementById("manual-form");
const manualFrom = document.getElementById("manual-from");
const manualTo = document.getElementById("manual-to");
const manualNote = document.getElementById("manual-note");
const manualPreview = document.getElementById("manual-preview");
const manualCancel = document.getElementById("manual-cancel");
const manualSave = document.getElementById("manual-save");

let manualDate = null;

// The portal groups activity by Pakistan-time day.
function getPkDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function startTrackerSettingsWatch(userId) {
  stopTrackerSettingsWatch();
  stopSettingsWatch = watchTrackerSettings(userId, applyTrackerSettings);
}

function stopTrackerSettingsWatch() {
  if (stopSettingsWatch) stopSettingsWatch();
  stopSettingsWatch = null;
  trackerSettings = { ...TRACKER_SETTINGS_DEFAULTS };
  manualEntries = [];
  closeManualDialog();
  renderManualTime();
}

function applyTrackerSettings(next) {
  const previous = trackerSettings;
  trackerSettings = next;
  console.log("Tracker settings", next);

  // New interval: reschedule the pending screenshot with it.
  if (
    previous.screenshotIntervalMin !== next.screenshotIntervalMin &&
    currentSessionId &&
    !isSessionPaused
  ) {
    scheduleNextScreenshot();
  }

  if (next.manualTimeAllowed && !previous.manualTimeAllowed) {
    void loadManualEntries();
  }
  if (!next.manualTimeAllowed) closeManualDialog();
  renderManualTime();
}

async function loadManualEntries() {
  if (!currentUser || !trackerSettings.manualTimeAllowed) return;
  manualDate = getPkDateString();
  try {
    manualEntries = await getManualTimeForDay(currentUser.uid, manualDate);
    renderTodayTotalTime();
  } catch (err) {
    console.error("Failed to load manual time:", err);
    manualEntries = [];
  }
  renderManualTime();
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad(h)}h ${pad(m)}m`;
}

function renderManualTime() {
  const show = Boolean(currentUser && trackerSettings.manualTimeAllowed);
  if (manualCard) manualCard.hidden = !show;
  if (manualSection) manualSection.hidden = !show;
  if (!show || !manualList) return;

  // A new day: yesterday's entries no longer belong here.
  if (manualDate && manualDate !== getPkDateString()) {
    manualEntries = [];
    void loadManualEntries();
    return;
  }

  const total = Math.round(
    manualWindows().reduce((sum, w) => sum + (w.end - w.start), 0) / 60000,
  );
  if (manualTimeValue) manualTimeValue.textContent = formatMinutes(total);

  manualList.replaceChildren(
    ...manualEntries.map((entry) => {
      const item = document.createElement("li");
      item.className = "manual-item";

      const when = document.createElement("span");
      when.className = "manual-item-when";
      when.textContent = `${formatClock(entry.start)} – ${formatClock(entry.end)}`;

      const dur = document.createElement("span");
      dur.className = "manual-item-dur";
      dur.textContent = formatMinutes(entry.minutes);

      const note = document.createElement("span");
      note.className = "manual-item-note";
      note.textContent = entry.note;
      note.title = entry.note;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "manual-item-delete";
      remove.setAttribute("aria-label", "Delete this entry");
      remove.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';
      remove.addEventListener("click", () => void removeManualEntry(entry));

      item.append(when, dur, note, remove);
      return item;
    }),
  );
  if (manualEmpty) manualEmpty.hidden = manualEntries.length > 0;
}

// Today's date at the given "HH:MM" (local time).
function todayAt(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}

// Returns an error message, or "" when the entry is fine.
function validateManualEntry(start, end) {
  if (!start || !end) return "Pick a start and end time.";
  if (end <= start) return "End time must be after start time.";
  if (end.getTime() > Date.now()) return "You can't add time that hasn't happened yet.";

  const s = start.getTime();
  const e = end.getTime();
  const overlaps = (a, b) => s < b && e > a;

  // Overlapping tracked time is fine: manual time replaces it.
  if (manualEntries.some((x) => overlaps(x.start.getTime(), x.end.getTime()))) {
    return "This overlaps manual time you already added.";
  }
  return "";
}

function updateManualPreview() {
  const start = todayAt(manualFrom.value);
  const end = todayAt(manualTo.value);
  const error = validateManualEntry(start, end);
  manualPreview.classList.toggle("error", Boolean(error));
  manualPreview.textContent = error
    ? error
    : `Adds ${formatMinutes(Math.round((end - start) / 60000))} to today`;
  manualSave.disabled = Boolean(error);
}

function openManualDialog() {
  if (!trackerSettings.manualTimeAllowed) return;
  manualForm.reset();
  manualPreview.textContent = "";
  manualPreview.classList.remove("error");
  manualSave.disabled = false;
  manualDialog.hidden = false;
  manualFrom.focus();
}

function closeManualDialog() {
  if (manualDialog) manualDialog.hidden = true;
}

async function submitManualEntry(event) {
  event.preventDefault();
  if (!currentUser || !trackerSettings.manualTimeAllowed) return;

  const start = todayAt(manualFrom.value);
  const end = todayAt(manualTo.value);
  const note = manualNote.value.trim();
  const error = validateManualEntry(start, end) || (note ? "" : "Add a short note.");
  if (error) {
    manualPreview.textContent = error;
    manualPreview.classList.add("error");
    return;
  }

  manualSave.disabled = true;
  try {
    const date = getPkDateString(start);
    const id = await addManualTime(currentUser.uid, { date, start, end, note });
    manualEntries = [
      ...manualEntries,
      { id, start, end, minutes: Math.round((end - start) / 60000), note },
    ].sort((a, b) => a.start - b.start);
    closeManualDialog();
    renderManualTime();
    renderTodayTotalTime();
    showToast("Manual time added.");
  } catch (err) {
    console.error("Failed to add manual time:", err);
    manualPreview.textContent = "Couldn't save. Check your connection and try again.";
    manualPreview.classList.add("error");
    manualSave.disabled = false;
  }
}

async function removeManualEntry(entry) {
  if (!window.confirm(`Delete ${formatClock(entry.start)} – ${formatClock(entry.end)}?`)) {
    return;
  }
  try {
    await deleteManualTime(entry.id);
    manualEntries = manualEntries.filter((x) => x.id !== entry.id);
    renderManualTime();
    renderTodayTotalTime();
    showToast("Manual time deleted.");
  } catch (err) {
    console.error("Failed to delete manual time:", err);
    showToast("Couldn't delete. Try again.");
  }
}

manualAddBtn?.addEventListener("click", openManualDialog);
manualCancel?.addEventListener("click", closeManualDialog);
manualForm?.addEventListener("submit", submitManualEntry);
manualFrom?.addEventListener("input", updateManualPreview);
manualTo?.addEventListener("input", updateManualPreview);
manualDialog?.addEventListener("click", (event) => {
  if (event.target === manualDialog) closeManualDialog();
});
manualDialog?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeManualDialog();
});
