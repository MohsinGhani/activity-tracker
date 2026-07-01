import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const firebaseApp = initializeApp(firebaseConfig);

export const auth = getAuth(firebaseApp);
// Firestore's default WebChannel transport can hang indefinitely (never
// resolving, never rejecting) inside Electron's file:// renderer — reads
// (one-shot GETs) often succeed while writes/streams wedge forever. FORCING
// long-polling (rather than auto-detecting it, which can itself stall in
// Electron) is the established fix. useFetchStreams:false avoids a separate
// fetch-based streaming path that is also unreliable in Electron.
export const db = initializeFirestore(firebaseApp, {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
});

// Choose how long the Firebase session survives. Local persistence (IndexedDB)
// keeps the user signed in across app restarts ("Remember me"); session
// persistence clears the login when the app closes.
export async function setAuthPersistence(remember) {
  try {
    await setPersistence(
      auth,
      remember ? browserLocalPersistence : browserSessionPersistence,
    );
  } catch (error) {
    console.error("Failed to set auth persistence:", error);
  }
}

export async function loginUser(email, password, remember = true) {
  await setAuthPersistence(remember);
  return signInWithEmailAndPassword(auth, email, password);
}

export function logoutUser() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function saveScreenshot(
  sessionId,
  userId,
  imageUrl,
  timestamp,
  activityContext = {},
) {
  const hasScreenSummaries =
    Array.isArray(activityContext.screenSummaries) &&
    activityContext.screenSummaries.length > 0;

  const screenshotDoc = {
    sessionId,
    userId,
    imageUrl,
    timestamp,
    activitySummary: activityContext.summary || "Unknown activity",
    createdAt: serverTimestamp(),
  };

  return addDoc(collection(db, "screenshots"), screenshotDoc);
}

export async function createSession(userId) {
  const docRef = await addDoc(collection(db, "sessions"), {
    userId,
    startTime: new Date(),
    status: "active",
  });
  return docRef.id;
}

export async function endSession(
  sessionId,
  duration,
  idleTime,
  endTime,
  startTime,
) {
  return updateDoc(doc(db, "sessions", sessionId), {
    startTime,
    endTime,
    duration,
    idleTime,
    status: "ended",
  });
}

function toDateOrNull(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function updateUserStatus(sessionId, status) {
  return updateDoc(doc(db, "sessions", sessionId), {
    status: status,
  });
}

export async function getTodaySessionsSummary(userId, dayStart, dayEnd) {
  const q = query(collection(db, "sessions"), where("userId", "==", userId));
  const snapshot = await getDocs(q);

  const sessions = [];
  let totalEndedSeconds = 0;
  let totalIdleSeconds = 0;
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();

  snapshot.forEach((item) => {
    const data = item.data();
    const startDate = toDateOrNull(data?.startTime);
    const endDate = toDateOrNull(data?.endTime);
    const status = data?.status || "unknown";

    if (!startDate) return;

    let duration = Number(data?.duration ?? 0);
    if (!Number.isFinite(duration) && startDate && endDate) {
      duration = Math.floor((endDate.getTime() - startDate.getTime()) / 1000);
    }

    const normalizedDuration = Math.max(0, Math.floor(duration || 0));

    const markerDate = endDate || startDate;
    const touchesToday =
      Math.min(endDate?.getTime() || startDate.getTime(), dayEndMs) >
      Math.max(startDate.getTime(), dayStartMs);

    let endedSecondsForToday = 0;
    let idleSecondsForToday = 0;
    if (status === "ended") {
      if (touchesToday) {
        endedSecondsForToday = normalizedDuration;
        totalEndedSeconds += endedSecondsForToday;
        // Sum idle time from saved idleTime field (same date filter)
        const sessionIdle = Math.max(
          0,
          Math.floor(Number(data?.idleTime ?? 0)),
        );
        if (Number.isFinite(sessionIdle)) {
          idleSecondsForToday = sessionIdle;
          totalIdleSeconds += sessionIdle;
        }
      }
    }

    if (!markerDate && !touchesToday) return;
    if (!touchesToday && (markerDate < dayStart || markerDate >= dayEnd))
      return;

    sessions.push({
      id: item.id,
      userId: data?.userId || userId,
      status,
      duration: normalizedDuration,
      endedSecondsForToday,
      idleSecondsForToday,
      startTime: startDate,
      endTime: endDate,
    });
  });

  sessions.sort(
    (a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0),
  );

  return {
    userId,
    dayStart,
    dayEnd,
    sessions,
    totalEndedSeconds: Math.max(0, totalEndedSeconds),
    totalIdleSeconds: Math.max(0, totalIdleSeconds),
  };
}
