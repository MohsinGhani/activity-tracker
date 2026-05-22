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

export async function saveScreenshot(sessionId, userId, imageUrl, timestamp) {
  return addDoc(collection(db, "screenshots"), {
    sessionId,
    userId,
    imageUrl,
    timestamp,
    createdAt: serverTimestamp(),
  });
}

export async function createSession(userId) {
  const docRef = await addDoc(collection(db, "sessions"), {
    userId,
    startTime: serverTimestamp(),
    status: "active",
  });
  return docRef.id;
}

export async function endSession(sessionId, duration) {
  return updateDoc(doc(db, "sessions", sessionId), {
    endTime: serverTimestamp(),
    duration,
    status: "ended",
  });
}
