import {
  loginUser,
  logoutUser,
  onAuthChange,
  saveScreenshot,
  createSession,
  endSession,
  getTodaySessionsSummary,
  updateUserStatus,
} from "./firebase.js";
import { uploadScreenshot } from "./cloudinary.js";

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
let idleStartedAtMs = null;
let isAppClosingHandled = false;
let autoRestartInProgress = false;

const IDLE_THRESHOLD_MS = 15 * 60 * 1000; 
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

async function checkMacOSPermissions() {
  if (permissionCheckInProgress) return;
  if (process.platform !== "darwin") {
    hidePermissionBanner();
    return;
  }

  permissionCheckInProgress = true;
  try {
    const result = await window.tracker.checkPermissions();
    const missing = [];
    if (!result?.screenRecording) missing.push("Screen Recording");
    if (!result?.accessibility) missing.push("Accessibility");
    if (!result?.idleTime) missing.push("Input Monitoring");

    if (missing.length > 0) {
      showPermissionBanner({
        message: `Missing permissions: ${missing.join(" and ")}. Click below to open System Settings and grant access so screenshots, activity tracking, and idle detection can work.`,
        actionText: "Open Settings",
        onAction: async () => {
          if (!result?.screenRecording) {
            await window.tracker.openPermissionSettings();
          }
          if (!result?.accessibility) {
            await window.tracker.openAccessibilitySettings();
          }
          if (!result?.idleTime) {
            await window.tracker.openInputMonitoringSettings();
          }
        },
      });
    } else {
      hidePermissionBanner();
    }
  } catch (err) {
    console.error("Permission check failed:", err);
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
    showToast("Update check failed. Will retry automatically.");
  }
});

window.tracker.onPowerEvent(async (eventName) => {
  if (!currentSessionId) return;

  if (POWER_IDLE_EVENTS.has(eventName)) {
    if (!isIdle && !isSessionPaused) {
      const idleSeconds = Number(await window.tracker.getIdleTime());
      const idleMs = Number.isFinite(idleSeconds)
        ? idleSeconds * 1000
        : IDLE_THRESHOLD_MS;
      await pauseSession(true, idleMs);
      statusText.textContent = "Session paused (idle)";
      showToast("Session paused — display off or system suspend.");
    }
    return;
  }

  if (
    POWER_ACTIVE_EVENTS.has(eventName) &&
    isSessionPaused &&
    pausedDueToIdle &&
    !idleResumeInProgress
  ) {
    idleResumeInProgress = true;
    try {
      await resumeSession();
      showToast("Session resumed.");
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

  if (!email || !password) {
    loginError.textContent = "Please enter your email and password.";
    return;
  }

  loginError.textContent = "";
  loginBtn.disabled = true;
  loginBtn.textContent = "Logging in\u2026";

  try {
    await loginUser(email, password);
    await window.tracker.storeSet("authTimeMs", Date.now());
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
  startBtn.disabled = true;
  startBtn.textContent = "Starting\u2026";

  try {
    const sessionId = await createSession(currentUser.uid);
    currentSessionId = sessionId;
    sessionStartTime = Date.now();
    sessionStartedAtMs = sessionStartTime;
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
    showToast("Could not start session \u2014 check the console.");
    startBtn.disabled = false;
    startBtn.textContent = "\u25B6 Start Session";
  }
});

stopBtn.addEventListener("click", toggleSessionState);
endBtn.addEventListener("click", endCurrentSession);

async function toggleSessionState() {
  if (!currentSessionId) return;

  if (isSessionPaused) {
    await resumeSession();
    return;
  }

  await pauseSession();
}

async function pauseSession(dueToIdle = false, idleMs = null) {
  const elapsedAtPauseMs = getElapsedMs();
  if (dueToIdle) {
    const requestedIdleMs = Number.isFinite(Number(idleMs))
      ? Math.max(IDLE_THRESHOLD_MS, Number(idleMs))
      : IDLE_THRESHOLD_MS;
    // Count idle time that triggered the pause (at least 15 min)
    totalIdleMs += requestedIdleMs;
    // Record when idle was first detected so we can track the full duration
    idleStartedAtMs = Date.now();
    elapsedBeforePauseMs = elapsedAtPauseMs;
  } else {
    elapsedBeforePauseMs = elapsedAtPauseMs;
  }
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

async function endCurrentSession() {
  if (!currentSessionId) return false;

  // Duration = total elapsed time minus idle time (work time only)
  const totalElapsedMs = getElapsedMs();
  const workTimeMs = Math.max(0, totalElapsedMs - totalIdleMs);
  const duration = Math.floor(workTimeMs / 1000);
  const idleTime = Math.floor(totalIdleMs / 1000);
  const endTime = new Date();
  clearTimers();

  let firebaseSaved = false;
  try {
    await endSession(
      currentSessionId,
      duration,
      idleTime,
      endTime,
      getEffectiveSessionStartDate(endTime.getTime()),
    );
    firebaseSaved = true;
  } catch (err) {
    console.error("Failed to end session in Firestore:", err);
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
  const duration = Math.floor(getElapsedMsAt(effectiveEndAtMs) / 1000);
  const idleTime = Math.floor(totalIdleMs / 1000);
  const endTime = new Date(effectiveEndAtMs);

  try {
    await endSession(
      currentSessionId,
      duration,
      idleTime,
      endTime,
      getEffectiveSessionStartDateAt(effectiveEndAtMs),
    );
  } catch (err) {
    console.error("Failed to recover session after shutdown:", err);
    return false;
  }

  await clearStoredSession();
  clearSessionState();
  await refreshTodayEndedSeconds();
  renderTodayTotalTime();
  setInactiveUI();
  showToast("Previous session was closed at the last shutdown time.");
  return true;
}

async function restoreSession() {
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

    if (pendingSessionEndAtMs) {
      const endpointMs = Number.isFinite(lastPersistedAtMs)
        ? Math.min(pendingSessionEndAtMs, lastPersistedAtMs)
        : pendingSessionEndAtMs;
      const recovered = await recoverPendingShutdownSession(endpointMs);
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
}

async function startNewSessionAfterRecovery() {
  try {
    const sessionId = await createSession(currentUser.uid);
    currentSessionId = sessionId;
    sessionStartTime = Date.now();
    sessionStartedAtMs = sessionStartTime;
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
  const rolloverDuration = Math.floor(
    getElapsedMsAt(rolloverEndTime.getTime()) / 1000,
  );
  const rolloverIdleTime = Math.floor(totalIdleMs / 1000);

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

function renderTodayTotalTime() {
  if (!todayTotalTime) return;
  // Show work time only (excluding idle time)
  const currentSessionWorkMs = Math.max(0, getElapsedMs() - totalIdleMs);
  const currentSessionSeconds = Math.floor(currentSessionWorkMs / 1000);
  const totalSeconds = Math.max(0, todayEndedSeconds + currentSessionSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  todayTotalTime.textContent = `${pad(h)}h ${pad(m)}m ${pad(s)}s`;

  // Show idle time: completed idle (from Firebase) + current session idle
  if (todayIdleTime) {
    const currentIdleSeconds = Math.floor(totalIdleMs / 1000);
    const totalIdleSecs = Math.max(0, todayIdleSeconds + currentIdleSeconds);
    const ih = Math.floor(totalIdleSecs / 3600);
    const im = Math.floor((totalIdleSecs % 3600) / 60);
    const is = totalIdleSecs % 60;
    todayIdleTime.textContent = `${pad(ih)}h ${pad(im)}m ${pad(is)}s`;
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
  return Math.max(0, totalElapsed - totalIdleMs);
}

function getElapsedMsAt(referenceMs) {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + Math.max(0, referenceMs - sessionStartTime);
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

const SCREENSHOT_BLOCK_MS = 10 * 60 * 1000;
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
        threshold: IDLE_THRESHOLD_MS,
        isIdle,
        isSessionPaused,
        willPause: idleMs >= IDLE_THRESHOLD_MS && !isIdle && !isSessionPaused,
      });

      // Check if user is idle (15+ minutes)
      if (idleMs >= IDLE_THRESHOLD_MS && !isIdle && !isSessionPaused) {
        console.log("User is idle, pausing session");
        await pauseSession(true, idleMs);
        statusText.textContent = "Session paused (idle)";
        showToast("Session paused — you are idle.");
      } else if (
        idleMs < IDLE_THRESHOLD_MS &&
        isSessionPaused &&
        pausedDueToIdle &&
        !idleResumeInProgress
      ) {
        console.log("User is active, resuming session");
        idleResumeInProgress = true;
        try {
          await resumeSession();
          showToast("Session resumed.");
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
  isIdle = false;
}

function scheduleNextScreenshot() {
  if (screenshotTimeout) clearTimeout(screenshotTimeout);
  if (isSessionPaused) {
    screenshotTimeout = null;
    return;
  }
  const nowElapsed = getElapsedMs();
  const blockMs = SCREENSHOT_BLOCK_MS;

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
  nextRollover.setHours(23, 59, 0, 0);
  if (nextRollover.getTime() < referenceMs) {
    nextRollover.setDate(nextRollover.getDate() + 1);
  }
  return nextRollover.getTime();
}

function getNextMidnightMs(referenceMs = Date.now()) {
  const nextMidnight = new Date(referenceMs);
  nextMidnight.setHours(0, 0, 0, 0);
  if (nextMidnight.getTime() <= referenceMs) {
    nextMidnight.setDate(nextMidnight.getDate() + 1);
  }
  return nextMidnight.getTime();
}

function getRolloverEndMs(startMs) {
  const rolloverEnd = new Date(startMs);
  rolloverEnd.setHours(23, 59, 0, 0);
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

function scheduleNewSessionAtRollover() {
  clearNewSessionTimer();
  if (!currentUser) return;

  const now = Date.now();
  const delay = Math.max(0, getNextMidnightMs(now) - now);
  newSessionTimeout = setTimeout(async () => {
    clearNewSessionTimer();
    if (currentSessionId || !currentUser) return;

    try {
      const sessionId = await createSession(currentUser.uid);
      currentSessionId = sessionId;
      sessionStartTime = Date.now();
      sessionStartedAtMs = sessionStartTime;
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
      showToast("New session started at 12:00 AM.");
    } catch (err) {
      console.error("Failed to start new session at rollover:", err);
      showToast("Could not start new session at 12:00 AM.");
    }
  }, delay);
}

function scheduleMidnightEnd() {
  clearMidnightTimer();
  if (!currentSessionId) return;

  const now = Date.now();
  const delay = Math.max(0, getNextRolloverMs(now) - now);
  midnightTimeout = setTimeout(async () => {
    if (!currentSessionId) return;
    if (isSessionPaused) {
      showToast("Session ended at 11:59 PM.");
      await endCurrentSession();
      scheduleNewSessionAtRollover();
      return;
    }

    showToast("Session ended at 11:59 PM.");
    await endCurrentSession();
    scheduleNewSessionAtRollover();
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

async function stitchScreenshots(dataUrls) {
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) {
    throw new Error("No screenshot data received");
  }
  if (dataUrls.length === 1) return dataUrls[0];

  const images = await Promise.all(dataUrls.map(loadImage));

  const totalWidth = images.reduce((sum, img) => sum + img.naturalWidth, 0);
  const maxHeight = Math.max(...images.map((img) => img.naturalHeight));

  const canvas = document.createElement("canvas");
  canvas.width = totalWidth;
  canvas.height = maxHeight;
  const ctx = canvas.getContext("2d");

  let x = 0;
  for (const img of images) {
    ctx.drawImage(img, x, 0);
    x += img.naturalWidth;
  }

  return canvas.toDataURL("image/png");
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
    const dataUrls = capturedScreens.map((screen) => screen.dataUrl);

    if (dataUrls.length === 0) {
      throw new Error("No screenshot data received");
    }

    const stitched = await stitchScreenshots(dataUrls);
    const imageUrl = await uploadScreenshot(stitched);
    const now = new Date();

    const displayIds = capturedScreens
      .map((screen) => screen.displayId)
      .filter(Boolean);
    const activityContexts =
      await window.tracker.getActivityContexts(displayIds);
    const activeContext = activityContexts?.active || {
      summary: "Unknown activity",
    };

    if (activityContexts?.permissionError) {
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
      imageUrl,
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
    showToast(`Screenshot captured at ${timeStr}${activityText}`);
    await window.tracker.showNotification(
      "Team Tracker",
      `Screenshot captured at ${timeStr}${activityText}`,
    );
  } catch (err) {
    console.error("Screenshot capture/upload failed:", err);
    showToast("Screenshot failed \u2014 will retry next interval.");
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
  emailInput.value = "";
  passInput.value = "";
  loginError.textContent = "";
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
  await window.tracker.storeSet("pendingSessionEndAtMs", null);
}

async function persistSessionState() {
  await window.tracker.storeSet("sessionStartTime", sessionStartTime);
  await window.tracker.storeSet("sessionStartedAtMs", sessionStartedAtMs);
  await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
  await window.tracker.storeSet("sessionIdleMs", totalIdleMs);
  await window.tracker.storeSet("sessionPaused", isSessionPaused);
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
