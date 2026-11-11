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
export async function endSession(id, duration, idleTime, endTime, startTime, segments) {
  await gate("endSession");
  Object.assign(fb().sessions[id], { duration, idleTime, endTime, startTime, status: "ended", ...(segments ? { segments } : {}) });
}
export async function updateUserStatus(id, status) { if (fb().sessions[id]) fb().sessions[id].status = status; }
export async function getTodaySessionsSummary() { return { totalEndedSeconds: 0, totalIdleSeconds: 0, sessions: [] }; }
export const TRACKER_SETTINGS_DEFAULTS = Object.freeze({ manualTimeAllowed: false, screenshotIntervalMin: 10, idleThresholdMin: 15 });
export function watchTrackerSettings(userId, onChange) { onChange({ ...TRACKER_SETTINGS_DEFAULTS, ...(fb().settings || {}) }); return () => {}; }
export async function getManualTimeForDay() { return []; }
export async function addManualTime() { return "m1"; }
export async function deleteManualTime() {}
export async function saveSessionSegments(id, segments) { if (fb().sessions[id]) fb().sessions[id].segments = segments; }
`);
fs.writeFileSync(path.join(dir, "screenshotStorage.js"), "export async function uploadScreenshot() { return {}; }");
fs.copyFileSync(new URL("../manualOverride.js", import.meta.url), path.join(dir, "manualOverride.js"));

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
      takeScreenshot: async () => { fb.shots = (fb.shots || 0) + 1; throw new Error("no screens in test"); },
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

test("E: the admin's idle threshold is used (5 min instead of 15)", async () => {
  reset();
  fb.settings = { idleThresholdMin: 5 };
  fb.lastInputMs = at(17, 9);
  const app = await launch(at(17, 9));
  await app.click("start-btn");
  await advance(1 * H, { working: true });
  await advance(8 * MIN, { working: false }); // away 8 min: idle with a 5-min threshold
  await advance(30 * MIN, { working: true });
  await app.click("end-btn");

  const [s1] = sessions();
  assert.ok(s1.idleTime >= 5 * 60, `idle should be counted, got ${s1.idleTime}s`);
});

test("E: with the default 15-min threshold, 8 minutes away is not idle", async () => {
  reset();
  fb.lastInputMs = at(17, 9);
  const app = await launch(at(17, 9));
  await app.click("start-btn");
  await advance(1 * H, { working: true });
  await advance(8 * MIN, { working: false });
  await advance(30 * MIN, { working: true });
  await app.click("end-btn");

  const [s1] = sessions();
  assert.equal(s1.idleTime, 0);
});

test("F: the admin's screenshot interval is used (every 5 min instead of 10)", async () => {
  reset();
  fb.settings = { screenshotIntervalMin: 5 };
  fb.lastInputMs = at(18, 9);
  const app = await launch(at(18, 9));
  await app.click("start-btn");
  await advance(1 * H, { working: true });
  await app.click("end-btn");

  // One screenshot per 5-minute block: about 12 in an hour (10-min blocks give 6).
  assert.ok(fb.shots >= 11 && fb.shots <= 13, `expected ~12 screenshot attempts, got ${fb.shots}`);
});

test("G: a session saves its active/idle blocks (idle starts at the last input)", async () => {
  reset();
  fb.lastInputMs = at(19, 9);
  const app = await launch(at(19, 9));
  await app.click("start-btn");
  await advance(1 * H, { working: true });       // 09:00-10:00 active
  await advance(30 * MIN, { working: false });   // 10:00-10:30 away (idle after 15 min, backdated)
  await advance(30 * MIN, { working: true });    // 10:30-11:00 active
  await app.click("end-btn");

  const [s1] = sessions();
  const blocks = (s1.segments || []).map((b) => b.k + Math.round((b.e - b.s) / MIN));
  assert.equal(s1.segments?.[0]?.k, "a");
  const idle = s1.segments.filter((b) => b.k === "i").reduce((n, b) => n + (b.e - b.s), 0);
  const active = s1.segments.filter((b) => b.k === "a").reduce((n, b) => n + (b.e - b.s), 0);
  assert.ok(Math.abs(idle - 30 * MIN) <= 1 * MIN, `idle blocks ${blocks.join(",")}`);
  assert.ok(Math.abs(active - 90 * MIN) <= 1 * MIN, `active blocks ${blocks.join(",")}`);
});

test("H: manual time replaces the tracked minutes it covers, whatever they were", async () => {
  const { applyManualOverride } = await import(new URL("../manualOverride.js", import.meta.url).href);
  // Tracker 13:00-17:00; idle 14:00-14:20 and 14:30-15:00 (mouse moved 14:20-14:30), idle 15:45-16:00.
  const t = (h, m = 0) => Date.UTC(2026, 10, 11, h, m);
  const segments = [
    { k: "a", s: t(13), e: t(14) }, { k: "i", s: t(14), e: t(14, 20) }, { k: "a", s: t(14, 20), e: t(14, 30) },
    { k: "i", s: t(14, 30), e: t(15) }, { k: "a", s: t(15), e: t(15, 45) }, { k: "i", s: t(15, 45), e: t(16) },
    { k: "a", s: t(16), e: t(17) },
  ];
  const r = applyManualOverride([{ start: t(13), end: t(17), segments }], [{ start: t(14), end: t(15) }]);
  assert.equal(r.idleCut, 50 * MIN);
  assert.equal(r.activeCut, 10 * MIN);
  assert.deepEqual(r.replaced, [{ activeMs: 10 * MIN, idleMs: 50 * MIN }]);

  // Partly outside tracked time: only the overlapping half replaces anything.
  const r2 = applyManualOverride([{ start: t(13), end: t(17), segments }], [{ start: t(12, 30), end: t(13, 30) }]);
  assert.equal(r2.activeCut, 30 * MIN);
  assert.equal(r2.idleCut, 0);

  // Older session without blocks: split by its idle share (1h idle of 4h).
  const r3 = applyManualOverride([{ start: t(13), end: t(17), activeMs: 180 * MIN, idleMs: 60 * MIN }], [{ start: t(14), end: t(15) }]);
  assert.equal(Math.round(r3.idleCut / MIN), 15);
  assert.equal(Math.round(r3.activeCut / MIN), 45);
});

test("I: deleting manual time gives the tracked minutes back; overlapping entries count once", async () => {
  const { applyManualOverride, mergeWindows } = await import(new URL("../manualOverride.js", import.meta.url).href);
  const t = (h, m = 0) => Date.UTC(2026, 10, 11, h, m);
  const session = { start: t(13), end: t(17), segments: [
    { k: "a", s: t(13), e: t(14) }, { k: "i", s: t(14), e: t(15) }, { k: "a", s: t(15), e: t(17) },
  ] };
  // Added: 14:00-15:00 replaces the idle hour.
  const added = applyManualOverride([session], mergeWindows([{ start: t(14), end: t(15) }]));
  assert.equal(added.idleCut, 60 * MIN);
  assert.equal(added.activeCut, 0);
  // Deleted: nothing is replaced any more, so idle is back.
  const deleted = applyManualOverride([session], mergeWindows([]));
  assert.equal(deleted.idleCut, 0);
  assert.equal(deleted.activeCut, 0);
  // Two overlapping entries (e.g. two devices) are merged before anything is replaced.
  const merged = mergeWindows([{ start: t(14), end: t(15) }, { start: t(14, 30), end: t(15, 30) }]);
  assert.deepEqual(merged, [{ start: t(14), end: t(15, 30) }]);
  const both = applyManualOverride([session], merged);
  assert.equal(both.idleCut, 60 * MIN);
  assert.equal(both.activeCut, 30 * MIN);
});
