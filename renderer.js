import {
  loginUser,
  logoutUser,
  onAuthChange,
  saveScreenshot,
  createSession,
  endSession,
  getTodaySessionsSummary,
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
let logoutTimeout = null;
let sessionPersistInterval = null;
let isIdle = false;
let idlePollInterval = null;
let isSessionPaused = false;
let pausedDueToIdle = false;
let idleResumeInProgress = false;
let todayEndedSeconds = 0;
let isAppClosingHandled = false;

const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

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
const toastArea = document.getElementById("toast-area");
const logoutBtn = document.getElementById("logout-btn");

window.tracker.onUpdateStatus((payload) => {
  const status = payload?.status;
  if (!status) return;

  if (status === "available") {
    const version = payload?.detail ? ` v${payload.detail}` : "";
    showToast(`Update available${version}. Downloading in background.`);
    return;
  }

  if (status === "downloaded") {
    showToast("Update ready. It will install when you close the app.");
    return;
  }

  if (status === "error") {
    showToast("Update check failed. Will retry automatically.");
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
      const sessionSaved = await endCurrentSession();
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
      scheduleMidnightLogout();
      await restoreSession();
      await refreshTodayEndedSeconds();
      renderTodayTotalTime();
      return;
    }

    const authTimeMs = await ensureAuthTimeMs();
    if (await logoutIfPastMidnight(authTimeMs)) {
      return;
    }

    showDashboard(user);
    scheduleMidnightLogout();
    await restoreSession();
    await refreshTodayEndedSeconds();
    renderTodayTotalTime();
  } else {
    clearTimers();
    clearSessionState();
    todayEndedSeconds = 0;
    renderTodayTotalTime();
    showLogin();
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
  if (currentSessionId) await endCurrentSession();
  await window.tracker.storeSet("authTimeMs", null);
  await logoutUser();
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

async function pauseSession(dueToIdle = false) {
  const elapsedAtPauseMs = getElapsedMs();
  if (dueToIdle) {
    const deductedIdleMs = Math.min(IDLE_THRESHOLD_MS, elapsedAtPauseMs);
    elapsedBeforePauseMs = Math.max(0, elapsedAtPauseMs - deductedIdleMs);
    totalIdleMs += deductedIdleMs;
  } else {
    elapsedBeforePauseMs = elapsedAtPauseMs;
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
}

async function endCurrentSession() {
  if (!currentSessionId) return false;

  const duration = Math.floor(getElapsedMs() / 1000);
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
    ? Math.min(getNextMidnightMs(sessionStartedAtMs), pendingEndAtMs)
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
      getEffectiveSessionStartDate(effectiveEndAtMs),
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
      if (await recoverPendingShutdownSession(pendingSessionEndAtMs)) {
        return;
      }
    } else if (
      Number.isFinite(lastPersistedAtMs) &&
      lastPersistedAtMs > sessionStartedAtMs
    ) {
      if (await recoverPendingShutdownSession(lastPersistedAtMs)) {
        return;
      }
    }

    if (
      Number.isFinite(sessionStartedAtMs) &&
      hasCrossedMidnight(sessionStartedAtMs)
    ) {
      await window.tracker.storeSet("pendingSessionEndAtMs", null);
      await rolloverSessionAfterMidnight();
      return;
    }

    await window.tracker.storeSet("pendingSessionEndAtMs", null);

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

async function rolloverSessionAfterMidnight() {
  const rolloverEndTime = new Date(getNextMidnightMs(sessionStartedAtMs));
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
    console.error("Failed to close previous session at midnight:", err);
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
  showToast("Previous session ended at 12:00 AM. New session started.");
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

function clearLogoutTimer() {
  clearTimeout(logoutTimeout);
  logoutTimeout = null;
}

async function logoutIfPastMidnight(authTimeMs = null) {
  if (!currentUser) return false;

  const effectiveAuthTimeMs = Number.isFinite(authTimeMs)
    ? authTimeMs
    : Number(await window.tracker.storeGet("authTimeMs"));

  if (
    !Number.isFinite(effectiveAuthTimeMs) ||
    !hasCrossedMidnight(effectiveAuthTimeMs)
  ) {
    return false;
  }

  try {
    if (currentSessionId) {
      await endCurrentSession();
    }
    await window.tracker.storeSet("authTimeMs", null);
    await logoutUser();
    showToast("You were logged out.");
  } catch (err) {
    console.error("Failed to log out user after 12:00 AM:", err);
    showToast("Automatic logout failed. Please log out and sign in again.");
  }

  return true;
}

function scheduleMidnightLogout() {
  clearLogoutTimer();
  if (!currentUser) return;

  const now = Date.now();
  const delay = Math.max(0, getNextMidnightMs(now) - now);
  logoutTimeout = setTimeout(async () => {
    await logoutIfPastMidnight();
  }, delay);
}

async function refreshTodayEndedSeconds() {
  if (!currentUser) {
    todayEndedSeconds = 0;
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

    console.log("Today's sessions summary", {
      date: dayStart.toLocaleDateString(),
      userId: summary.userId,
      count: summary.sessions.length,
      totalEndedSeconds: summary.totalEndedSeconds,
    });
  } catch (err) {
    console.error("Failed to load today's total time:", err);
  }
}

function renderTodayTotalTime() {
  if (!todayTotalTime) return;
  const currentSessionSeconds = Math.floor(getElapsedMs() / 1000);
  const totalSeconds = Math.max(0, todayEndedSeconds + currentSessionSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  todayTotalTime.textContent = `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

function getElapsedMs() {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + (Date.now() - sessionStartTime);
}

function getElapsedMsAt(referenceMs) {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + Math.max(0, referenceMs - sessionStartTime);
}

function getEffectiveSessionStartDate(referenceMs = Date.now()) {
  return new Date(referenceMs - getElapsedMs());
}

function pad(n) {
  return String(n).padStart(2, "0");
}

const SCREENSHOT_BLOCK_MS = 10 * 60 * 1000;
const SCREENSHOT_BLOCK_MIN_OFFSET_MS = 1 * 60 * 1000; // start at 1 minute into each block

function startIdlePoll() {
  stopIdlePoll();
  idlePollInterval = setInterval(async () => {
    if (!currentSessionId) return;
    const state = await window.tracker.getIdleState();
    if (
      (state === "idle" || state === "locked") &&
      !isIdle &&
      !isSessionPaused
    ) {
      isIdle = true;
      await pauseSession(true);
      statusText.textContent = "Session paused (idle)";
      showToast("Session paused — you are idle.");
    } else if (
      state === "active" &&
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
  }, 30000);
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

  // Determine which block to schedule a capture in:
  // - If we are before the block's minimum offset, schedule within the current block.
  // - Otherwise schedule in the next block to ensure at most one capture per block.
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

function getNextMidnightMs(referenceMs = Date.now()) {
  const nextMidnight = new Date(referenceMs);
  nextMidnight.setHours(24, 0, 0, 0);
  return nextMidnight.getTime();
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

function scheduleMidnightEnd() {
  clearMidnightTimer();
  if (!currentSessionId) return;

  const now = Date.now();
  const delay = Math.max(0, getNextMidnightMs(now) - now);
  midnightTimeout = setTimeout(async () => {
    if (!currentSessionId) return;
    showToast("Session ended at 12:00 AM.");
    await endCurrentSession();
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
  clearLogoutTimer();
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
