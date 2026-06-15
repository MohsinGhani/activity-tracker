import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
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
export const db = getFirestore(firebaseApp);

export function loginUser(email, password) {
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

export async function getTodaySessionsSummary(userId, dayStart, dayEnd) {
  const q = query(collection(db, "sessions"), where("userId", "==", userId));
  const snapshot = await getDocs(q);

  const sessions = [];
  let totalEndedSeconds = 0;
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

    let endedSecondsForToday = 0;
    if (status === "ended") {
      // Count only the part of the session that falls inside today's local range.
      const sessionStartMs = startDate.getTime();
      const fallbackEndMs = sessionStartMs + normalizedDuration * 1000;
      const sessionEndMs = endDate?.getTime() || fallbackEndMs;
      const overlapStartMs = Math.max(sessionStartMs, dayStartMs);
      const overlapEndMs = Math.min(sessionEndMs, dayEndMs);
      const overlapMs = Math.max(0, overlapEndMs - overlapStartMs);
      endedSecondsForToday = Math.floor(overlapMs / 1000);
      totalEndedSeconds += endedSecondsForToday;
    }

    const markerDate = endDate || startDate;
    const touchesToday =
      Math.min(endDate?.getTime() || startDate.getTime(), dayEndMs) >
      Math.max(startDate.getTime(), dayStartMs);

    if (!markerDate && !touchesToday) return;
    if (!touchesToday && (markerDate < dayStart || markerDate >= dayEnd))
      return;

    sessions.push({
      id: item.id,
      userId: data?.userId || userId,
      status,
      duration: normalizedDuration,
      endedSecondsForToday,
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
  };
}
