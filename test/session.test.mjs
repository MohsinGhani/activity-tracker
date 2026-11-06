// Replays real tracker scenarios against the actual renderer.js with Firebase,
// the DOM and the Electron bridge faked, on a mocked clock. Run: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const H = 3600e3;
const MIN = 60e3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-test-"));
const rendererSrc = fs.readFileSync(new URL("../renderer.js", import.meta.url), "utf8");

// Fake firebase.js: sessions live in globalThis.__fb.sessions. An op named in
// fb.hold waits until the test releases it, to model a slow Firestore call.
fs.writeFileSync(path.join(dir, "firebase.js"), `
const fb = () => globalThis.__fb;
const gate = async (op) => { while (fb().hold.has(op)) await new Promise((r) => setImmediate(r)); };
export async function loginUser() {}
export async function logoutUser() {}
export function onAuthChange(cb) { fb().authCb = cb; return () => {}; }
export async function saveScreenshot() {}
export async function createSession(userId) {
  const id = "s" + ++fb().n;
  fb().sessions[id] = { userId, status: "active", startTime: new Date() };
  await gate("createSession");
  return id;
}
export async function endSession(id, duration, idleTime, endTime, startTime) {
  await gate("endSession");
  Object.assign(fb().sessions[id], { duration, idleTime, endTime, startTime, status: "ended" });
}
export async function updateUserStatus(id, status) { if (fb().sessions[id]) fb().sessions[id].status = status; }
export async function getTodaySessionsSummary() { return { totalEndedSeconds: 0, totalIdleSeconds: 0, sessions: [] }; }
`);
fs.writeFileSync(path.join(dir, "screenshotStorage.js"), "export async function uploadScreenshot() { return {}; }");

console.log = () => {};
console.error = () => {};
globalThis.requestAnimationFrame = () => {};

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
let launches = 0;
let fb;

function fakeElement() {
  return {
    handlers: {}, style: {}, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    appendChild() {}, remove() {},
  };
}

// Starts a fresh app process: new DOM, new renderer module, same disk store.
async function launch(atMs) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: atMs });
  const els = {};
  globalThis.document = {
    getElementById: (id) => (els[id] ??= fakeElement()),
    createElement: () => fakeElement(),
  };
  const listeners = {};
  globalThis.window = {
    addEventListener() {},
    tracker: {
      platform: "win32",
      storeGet: async (k) => fb.store.get(k) ?? null,
      storeSet: async (k, v) => { if (v == null) fb.store.delete(k); else fb.store.set(k, v); },
      getIdleTime: async () => Math.floor((Date.now() - fb.lastInputMs) / 1000),
      takeScreenshot: async () => { throw new Error("no screens in test"); },
      showNotification: async () => {},
      logEvent: async () => {},
      onUpdateStatus() {}, onDiagnostic() {}, onAppClosing() {},
      onPowerEvent: (cb) => { listeners.power = cb; },
    },
  };
  const file = path.join(dir, `renderer-${++launches}.js`);
  fs.writeFileSync(file, rendererSrc);
  await import(pathToFileURL(file).href);
  fb.authCb({ uid: "u1", email: "u1@test" });
  await flush(50);
  return {
    els,
    power: async (name) => { listeners.power(name); await flush(); },
    click: async (id) => { if (!els[id].disabled) els[id].handlers.click(); await flush(50); },
  };
}

// Advance the clock. While working, the user touches the keyboard constantly.
async function advance(ms, { working }) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (working) fb.lastInputMs = Date.now();
    mock.timers.tick(Math.min(5000, end - Date.now()));
    await flush(3);
  }
}

const at = (day, h, m = 0) => new Date(2026, 8, day, h, m).getTime(); // September 2026, local time
const sessions = () => Object.entries(fb.sessions).map(([id, s]) => ({ id, ...s }));
const windowSec = (s) => (s.endTime - s.startTime) / 1000;

function reset() {
  fb = globalThis.__fb = { sessions: {}, n: 0, store: new Map(), hold: new Set(), lastInputMs: 0 };
}

test("A: overnight gap is not copied into the next morning's idle", async () => {
  reset();
  fb.lastInputMs = at(15, 9);
  const app = await launch(at(15, 9));
  await app.click("start-btn");
  await advance(8 * H, { working: true }); // 09:00-17:00, then the PC is shut down

  // Next morning: Windows reports ~15h since the last input. The tracker
  // recovers yesterday's session and auto-starts a new one; the user only
  // touches the mouse 30s later.
  const app2 = await launch(at(16, 8));
  await advance(30e3, { working: false });
  await advance(8 * H, { working: true });
  await app2.click("end-btn");

  const [day1, day2] = sessions();
  assert.equal(day1.status, "ended");
  assert.ok(Math.abs(day1.endTime - at(15, 17)) < MIN, `day1 ended at ${day1.endTime}`);
  assert.equal(day2.status, "ended");
  assert.ok(day2.idleTime < 60, `day2 idle should be ~30s, got ${(day2.idleTime / 3600).toFixed(2)}h`);
  assert.ok(Math.abs(day2.duration - 8 * 3600) < 120, `day2 duration ${day2.duration}s`);
});

test("A: a 2-minute screen lock counts as 2 minutes idle, not 17", async () => {
  reset();
  fb.lastInputMs = at(15, 9);
  const app = await launch(at(15, 9));
  await app.click("start-btn");
  await advance(1 * H, { working: true });
  await app.power("lock-screen");
  await advance(2 * MIN, { working: false });
  await app.power("unlock-screen");
  await advance(1 * H, { working: true });
  await app.click("end-btn");

  const [s] = sessions();
  assert.ok(Math.abs(s.idleTime - 120) <= 10, `idle should be ~120s, got ${s.idleTime}s`);
});

test("B: a session closed by next-boot recovery does not count idle as work", async () => {
  reset();
  fb.lastInputMs = at(15, 9);
  const app = await launch(at(15, 9));
  await app.click("start-btn");
  await advance(2 * H, { working: true });
  await advance(1 * H, { working: false }); // genuine 1h break, 11:00-12:00
  await advance(5 * H, { working: true }); // until 17:00, then the PC is shut down

  fb.lastInputMs = at(16, 8); // the user logged in by keyboard this time
  await launch(at(16, 8));

  const [day1] = sessions();
  assert.equal(day1.status, "ended");
  assert.ok(Math.abs(day1.idleTime - 3600) < 120, `idle ${day1.idleTime}s`);
  assert.ok(Math.abs(day1.duration - 7 * 3600) < 120, `duration should be ~7h, got ${(day1.duration / 3600).toFixed(2)}h`);
  assert.ok(day1.duration + day1.idleTime <= windowSec(day1) + 1, "duration + idle exceeds the session window");
});

test("C: clicking Start while recovery is running does not leave a stuck active session", async () => {
  reset();
  fb.lastInputMs = at(15, 9);
  const app = await launch(at(15, 9));
  await app.click("start-btn");
  await advance(8 * H, { working: true });

  // Next boot with slow Firestore: the user clicks Start at every chance.
  fb.hold.add("endSession");
  fb.lastInputMs = at(16, 8);
  const app2 = await launch(at(16, 8));
  await app2.click("start-btn");
  fb.hold.delete("endSession");
  fb.hold.add("createSession");
  await flush(50);
  await app2.click("start-btn");
  fb.hold.delete("createSession");
  await flush(50);

  const active = sessions().filter((s) => s.status === "active");
  assert.equal(active.length, 1, `expected 1 active session, got ${active.map((s) => s.id)}`);
  assert.equal(fb.store.get("sessionId"), active[0].id);
});

test("D: a session running at midnight is ended at 23:59:59 and a new one starts", async () => {
  reset();
  fb.lastInputMs = at(15, 20);
  const app = await launch(at(15, 20));
  await app.click("start-btn");
  await advance(4 * H + 5 * MIN, { working: true }); // 20:00 -> 00:05

  const [old, fresh] = sessions();
  assert.equal(old.status, "ended", "old session was not ended at midnight");
  assert.equal(old.endTime.getTime(), at(15, 23, 59) + 59999);
  assert.ok(Math.abs(old.duration - 4 * 3600) < 120, `duration ${old.duration}s`);
  assert.equal(fresh?.status, "active", "no new session at 00:00");
});
