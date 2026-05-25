import {
  loginUser,
  logoutUser,
  onAuthChange,
  saveScreenshot,
  createSession,
  endSession,
} from "./firebase.js";
import { uploadScreenshot } from "./cloudinary.js";

let currentUser = null;
let currentSessionId = null;
let sessionStartTime = null;
let elapsedBeforePauseMs = 0;
let timerInterval = null;
let screenshotTimeout = null;
let isIdle = false;
let idlePollInterval = null;
let isSessionPaused = false;

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
const toastArea = document.getElementById("toast-area");
const logoutBtn = document.getElementById("logout-btn");

onAuthChange(async (user) => {
  currentUser = user;
  if (user) {
    showDashboard(user);
    await restoreSession();
  } else {
    clearTimers();
    clearSessionState();
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
  } catch (err) {
    loginError.textContent = friendlyAuthError(err);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Login";
  }
}

logoutBtn.addEventListener("click", async () => {
  if (currentSessionId) await endCurrentSession();
  await logoutUser();
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Starting\u2026";

  try {
    const sessionId = await createSession(currentUser.uid);
    currentSessionId = sessionId;
    sessionStartTime = Date.now();
    elapsedBeforePauseMs = 0;
    isSessionPaused = false;

    await window.tracker.storeSet("sessionId", sessionId);
    await window.tracker.storeSet("sessionStartTime", sessionStartTime);
    await window.tracker.storeSet("sessionUserId", currentUser.uid);
    await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
    await window.tracker.storeSet("sessionPaused", false);

    startTimer();
    scheduleNextScreenshot();
    startIdlePoll();
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

async function pauseSession() {
  elapsedBeforePauseMs = getElapsedMs();
  sessionStartTime = null;
  clearInterval(timerInterval);
  timerInterval = null;
  clearTimeout(screenshotTimeout);
  screenshotTimeout = null;
  stopIdlePoll();
  isSessionPaused = true;
  renderTimer();
  await persistSessionState();
  setPausedUI();
}

async function resumeSession() {
  sessionStartTime = Date.now();
  isSessionPaused = false;
  await persistSessionState();
  startTimer();
  scheduleNextScreenshot();
  startIdlePoll();
  setActiveUI();
}

async function endCurrentSession() {
  if (!currentSessionId) return;

  const duration = Math.floor(getElapsedMs() / 1000);
  clearTimers();

  try {
    await endSession(currentSessionId, duration);
  } catch (err) {
    console.error("Failed to end session in Firestore:", err);
  }

  await clearStoredSession();
  clearSessionState();
  setInactiveUI();
}

async function restoreSession() {
  const sessionId = await window.tracker.storeGet("sessionId");
  const startTime = await window.tracker.storeGet("sessionStartTime");
  const userId = await window.tracker.storeGet("sessionUserId");
  const elapsedMs = Number(
    (await window.tracker.storeGet("sessionElapsedMs")) ?? 0,
  );
  const paused = Boolean(await window.tracker.storeGet("sessionPaused"));

  if (sessionId && userId === currentUser.uid) {
    currentSessionId = sessionId;
    elapsedBeforePauseMs = elapsedMs;
    isSessionPaused = paused;
    sessionStartTime = paused ? null : Number(startTime);

    if (isSessionPaused) {
      renderTimer();
      setPausedUI();
      return;
    }

    startTimer();
    scheduleNextScreenshot();
    startIdlePoll();
    setActiveUI();
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  renderTimer();
  timerInterval = setInterval(renderTimer, 1000);
}

function renderTimer() {
  const secs = Math.max(0, Math.floor(getElapsedMs() / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  timerDisplay.textContent = `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

function getElapsedMs() {
  if (!currentSessionId) return 0;
  if (!sessionStartTime) return elapsedBeforePauseMs;
  return elapsedBeforePauseMs + (Date.now() - sessionStartTime);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

const MIN_MS = 15 * 60 * 1000;
const MAX_MS = 15 * 60 * 1000;

function startIdlePoll() {
  stopIdlePoll();
  idlePollInterval = setInterval(async () => {
    if (!currentSessionId) return;
    const state = await window.tracker.getIdleState();
    if ((state === "idle" || state === "locked") && !isIdle) {
      isIdle = true;
      clearInterval(timerInterval);
      timerInterval = null;
      clearTimeout(screenshotTimeout);
      screenshotTimeout = null;
      statusText.textContent = "Session paused (idle)";
      statusText.className = "status-text";
      showToast("Session paused — you are idle.");
    } else if (state === "active" && isIdle) {
      isIdle = false;
      startTimer();
      scheduleNextScreenshot();
      statusText.textContent = "Session active";
      statusText.className = "status-text active";
      showToast("Session resumed.");
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
  const delay = MIN_MS + Math.floor(Math.random() * (MAX_MS - MIN_MS + 1));
  screenshotTimeout = setTimeout(captureAndUpload, delay);
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

async function captureAndUpload() {
  if (!currentSessionId || !currentUser) return;

  try {
    const dataUrls = await window.tracker.takeScreenshot();
    const stitched = await stitchScreenshots(dataUrls);
    const imageUrl = await uploadScreenshot(stitched);
    const now = new Date();

    await saveScreenshot(
      currentSessionId,
      currentUser.uid,
      imageUrl,
      now.toISOString(),
    );

    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    showToast(`Screenshot captured at ${timeStr}`);
    await window.tracker.showNotification(
      "Team Tracker",
      `Screenshot captured at ${timeStr}`,
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
  stopIdlePoll();
}

function clearSessionState() {
  currentSessionId = null;
  sessionStartTime = null;
  elapsedBeforePauseMs = 0;
  isIdle = false;
  isSessionPaused = false;
}

async function clearStoredSession() {
  await window.tracker.storeSet("sessionId", null);
  await window.tracker.storeSet("sessionStartTime", null);
  await window.tracker.storeSet("sessionUserId", null);
  await window.tracker.storeSet("sessionElapsedMs", null);
  await window.tracker.storeSet("sessionPaused", null);
}

async function persistSessionState() {
  await window.tracker.storeSet("sessionStartTime", sessionStartTime);
  await window.tracker.storeSet("sessionElapsedMs", elapsedBeforePauseMs);
  await window.tracker.storeSet("sessionPaused", isSessionPaused);
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
