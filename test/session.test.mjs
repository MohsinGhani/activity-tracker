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
export async function saveScreenshot(...args) { (fb().saved ||= []).push(args); }
export async function createSession(userId, meta = {}) {
  const id = "s" + ++fb().n;
  fb().sessions[id] = { userId, status: "active", startTime: new Date() };
  if (meta.deviceId) fb().sessions[id].deviceId = meta.deviceId;
  if (meta.appVersion) fb().sessions[id].appVersion = meta.appVersion;
  if (meta.task?.id) Object.assign(fb().sessions[id], { taskId: meta.task.id, tasks: { [meta.task.id]: meta.task.snapshot } });
  await gate("createSession");
  return id;
}
export async function saveSessionTask(id, taskId, snapshot, segments) {
  (fb().taskWrites ||= []).push({ id, taskId, at: Date.now() });
  const s = fb().sessions[id];
  if (!s) return;
  s.tasks = { ...(s.tasks || {}), [taskId]: snapshot };
  s.taskId = taskId;
  if (Array.isArray(segments)) s.segments = segments;
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
export async function saveSessionHeartbeat(id, segments) {
  (fb().beats ||= []).push({ id, at: Date.now() });
  if (fb().sessions[id]) Object.assign(fb().sessions[id], { lastSeenAt: Date.now(), segments });
}
export function watchRemovedTimeForDay(userId, date, onChange) { fb().removedCb = onChange; onChange(fb().removedMs || 0); return () => {}; }
`);
fs.writeFileSync(path.join(dir, "screenshotStorage.js"), "export async function uploadScreenshot() { return {}; }");
fs.copyFileSync(new URL("../manualOverride.js", import.meta.url), path.join(dir, "manualOverride.js"));
fs.copyFileSync(new URL("../tickets.js", import.meta.url), path.join(dir, "tickets.js"));
// Fake ticket menu: the test picks through fb.picker.onPick and sees what
// the menu would draw in fb.pickerState.
fs.writeFileSync(path.join(dir, "ticketPicker.js"), `
export function createTicketPicker(opts) {
  globalThis.__fb.picker = opts;
  return {
    update(state) { globalThis.__fb.pickerState = state; },
    open() { globalThis.__fb.pickerOpened = (globalThis.__fb.pickerOpened || 0) + 1; },
    close() {},
  };
}
`);

console.log = () => {};
// Images "load" straight away.
globalThis.Image = class { set src(_) { setImmediate(() => this.onload?.()); } };
console.error = () => {};
globalThis.requestAnimationFrame = () => {};

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Open Linear tickets as the portal returns them.
const ticket = (id, identifier, title, status, type, group) => ({
  id, identifier, title, url: `https://linear.app/x/issue/${identifier}`,
  status: { name: status, type, color: "#f2c94c" }, project: { id: "p1", name: "Portal" }, group,
});
const TICKETS = [
  ticket("iss-218", "INC-218", "Weekly hours: person week panel", "In Progress", "started", "inProgress"),
  ticket("iss-215", "INC-215", "Attendance export to CSV", "Todo", "unstarted", "upNext"),
];
const pick = async (t) => { fb.picker.onPick(t); await flush(30); };
let launches = 0;
let fb;

function fakeElement() {
  return {
    handlers: {}, style: {}, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    appendChild() {}, remove() {},
    // Enough of a canvas for a screenshot to be "encoded".
    getContext: () => ({ drawImage() {} }),
    toBlob: (cb) => cb({ size: 1 }),
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
      takeScreenshot: async () => {
        fb.shots = (fb.shots || 0) + 1;
        if (!fb.captureOk) throw new Error("no screens in test");
        return [{ dataUrl: "data:image/png;base64,AA", width: 100, height: 50, screenName: "Screen 1" }];
      },
      getActivityContexts: async () => ({ active: { summary: "Test app" }, perScreen: [] }),
      getAppVersion: async () => "1.0.10",
      getLinearTickets: async (token) => {
        (fb.ticketCalls ||= []).push(token);
        return fb.linear || { ok: true, tickets: TICKETS };
      },
      showNotification: async () => {},
      logEvent: async () => {},
      onUpdateStatus() {}, onDiagnostic() {}, onAppClosing() {},
      onPowerEvent: (cb) => { listeners.power = cb; },
    },
  };
  const file = path.join(dir, `renderer-${++launches}.js`);
  fs.writeFileSync(file, rendererSrc);
  await import(pathToFileURL(file).href);
  fb.authCb({ uid: "u1", email: "u1@test", getIdToken: async () => "id-token-u1" });
  await flush(50);
  // Most scenarios are about time, not tickets: pick one unless told not to.
  if (fb.autoPick !== false) await pick(TICKETS[0]);
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

test("J: each screenshot saves the block it was taken in (INC-222)", async () => {
  reset();
  fb.captureOk = true;
  fb.lastInputMs = at(21, 9);
  const app = await launch(at(21, 9));
  await app.click("start-btn");
  await advance(35 * MIN, { working: true });
  await app.click("end-btn");

  const blocks = (fb.saved || []).map((args) => args[5]);
  assert.ok(blocks.length >= 3, `expected 3 screenshots, got ${blocks.length}`);
  blocks.forEach((b, i) => {
    assert.equal(b.blockEndElapsedMs - b.blockStartElapsedMs, 10 * MIN);
    assert.equal(b.blockStartElapsedMs, i * 10 * MIN);
  });
});

test("K: Today's total drops as soon as a screenshot's time is removed (INC-222)", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(30 * MIN, { working: true });
  const before = app.els["today-total-time"].textContent;
  assert.match(before, /^00h 30m/);
  fb.removedCb(10 * MIN); // the portal deleted a screenshot: 10 min of active time removed
  await flush();
  assert.match(app.els["today-total-time"].textContent, /^00h 20m/);
});

test("L: a heartbeat every 2 minutes while a session is open, paused too; none after it ends", async () => {
  reset();
  fb.lastInputMs = at(23, 9);
  const app = await launch(at(23, 9));
  await app.click("start-btn");
  const [{ id }] = sessions();
  // One straight away on start, then every 2 minutes.
  assert.equal(fb.beats.filter((b) => b.id === id).length, 1);
  await advance(10 * MIN, { working: true });
  assert.equal(fb.beats.filter((b) => b.id === id).length, 6);
  assert.ok(Date.now() - fb.sessions[id].lastSeenAt < 2 * MIN);
  // The saved blocks reach the last heartbeat.
  const blocks = fb.sessions[id].segments;
  assert.equal(blocks[blocks.length - 1].e, fb.sessions[id].lastSeenAt);

  // Paused: the app is alive, so beats go on (the portal keeps it open).
  await app.click("stop-btn");
  const paused = fb.beats.length;
  await advance(6 * MIN, { working: false });
  assert.equal(fb.beats.length - paused, 3);

  // Ended: no more beats for that session.
  await app.click("end-btn");
  assert.equal(fb.sessions[id].status, "ended");
  const ended = fb.beats.filter((b) => b.id === id).length;
  await advance(10 * MIN, { working: false });
  assert.equal(fb.beats.filter((b) => b.id === id).length, ended);
});

test("L: after a shutdown, beats stop at the last one and the next start ends the session there", async () => {
  reset();
  fb.lastInputMs = at(24, 9);
  const app = await launch(at(24, 9));
  await app.click("start-btn");
  const [{ id }] = sessions();
  await advance(61 * MIN, { working: true }); // the PC is switched off at 10:01
  const lastBeat = fb.sessions[id].lastSeenAt;
  assert.ok(at(24, 10) - lastBeat <= 0 && at(24, 10, 1) - lastBeat < 2 * MIN);

  // Next morning the app starts and writes the real end, close to the last beat.
  const app2 = await launch(at(25, 8));
  await advance(30e3, { working: false });
  const s = fb.sessions[id];
  assert.equal(s.status, "ended");
  assert.ok(Math.abs(s.endTime - at(24, 10, 1)) < 1 * MIN, `ended at ${new Date(s.endTime).toTimeString()}`);
  await app2.click("end-btn");
});

// ─── M: Linear ticket ("Working on") ───────────────────────────────────────

test("M: Start needs a ticket; the session records it, this computer and the version", async () => {
  reset();
  fb.autoPick = false;
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  assert.equal(app.els["start-btn"].textContent, "Choose a ticket to start");
  assert.equal(fb.pickerState.required, true);
  assert.deepEqual(fb.ticketCalls, ["id-token-u1"], "tickets load once at sign-in, with the login's token");
  assert.equal(fb.pickerState.tickets.length, 2);

  await app.click("start-btn");
  assert.equal(sessions().length, 0, "started without a ticket");
  assert.equal(fb.pickerOpened, 1, "Start should open the ticket menu");

  await pick(TICKETS[0]);
  assert.equal(app.els["start-btn"].textContent, "▶ Start Session");
  await app.click("start-btn");
  await advance(20 * MIN, { working: true });

  const [s] = sessions();
  assert.equal(s.taskId, "iss-218");
  assert.deepEqual(s.tasks["iss-218"], {
    type: "linear", identifier: "INC-218", title: "Weekly hours: person week panel",
    url: "https://linear.app/x/issue/INC-218", projectId: "p1", project: "Portal",
    status: "In Progress", statusType: "started", at: at(22, 9),
  });
  assert.equal(s.appVersion, "1.0.10");
  assert.match(s.deviceId, /^[0-9a-f-]{36}$/);
  assert.ok(s.segments.length > 0 && s.segments.every((b) => b.t === "iss-218"));
});

test("M: switching ticket mid-session splits the block; idle keeps the ticket; one write per switch", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(60 * MIN, { working: true }); // 09:00-10:00 on INC-218
  await pick(TICKETS[1]); // 10:00 switch to INC-215
  await advance(30 * MIN, { working: true });
  await advance(20 * MIN, { working: false }); // idle from 10:30, detected at 10:45
  await app.click("end-btn");

  const [s] = sessions();
  assert.deepEqual(Object.keys(s.tasks).sort(), ["iss-215", "iss-218"]);
  assert.equal(s.taskId, "iss-215");
  const mins = (b) => Math.round((b.e - b.s) / MIN);
  const byTicket = (t, k) => s.segments.filter((b) => b.t === t && b.k === k).reduce((n, b) => n + mins(b), 0);
  assert.equal(byTicket("iss-218", "a"), 60);
  assert.equal(byTicket("iss-215", "a"), 30);
  assert.ok(byTicket("iss-215", "i") >= 19, `idle on INC-215: ${byTicket("iss-215", "i")}m`);
  assert.equal(s.segments.filter((b) => !b.t).length, 0, "every block has a ticket");
  assert.equal(fb.taskWrites.length, 1, "one write for the switch");

  // Picking the same ticket again changes nothing.
  reset();
  fb.lastInputMs = at(22, 9);
  const app2 = await launch(at(22, 9));
  await app2.click("start-btn");
  await advance(10 * MIN, { working: true });
  await pick(TICKETS[0]);
  assert.equal((fb.taskWrites || []).length, 0);
  assert.equal(sessions()[0].segments.length, 1);
});

test("M: a switch while paused: no new block until Resume, which starts on the new ticket", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(30 * MIN, { working: true });
  await app.click("stop-btn"); // pause
  await advance(10 * MIN, { working: false });
  await pick(TICKETS[1]);
  await advance(5 * MIN, { working: false });
  await app.click("stop-btn"); // resume
  await advance(20 * MIN, { working: true });
  await app.click("end-btn");

  const [s] = sessions();
  const blocks = s.segments.map((b) => `${b.k}${Math.round((b.e - b.s) / MIN)}:${b.t}`);
  assert.deepEqual(blocks, ["a30:iss-218", "a20:iss-215"]);
  assert.equal(s.taskId, "iss-215");
  assert.ok(s.tasks["iss-215"] && s.tasks["iss-218"]);
});

test("M: each screenshot saves the ticket it was taken on and the computer", async () => {
  reset();
  fb.captureOk = true;
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(20 * MIN, { working: true });
  await pick(TICKETS[1]);
  await advance(20 * MIN, { working: true });
  await app.click("end-btn");

  const extras = (fb.saved || []).map((args) => args[6]);
  assert.ok(extras.length >= 4, `expected 4 screenshots, got ${extras.length}`);
  assert.deepEqual(extras.slice(0, 2).map((x) => x.t), ["iss-218", "iss-218"]);
  assert.deepEqual(extras.slice(-2).map((x) => x.t), ["iss-215", "iss-215"]);
  extras.forEach((x) => assert.equal(x.deviceId, sessions()[0].deviceId));
});

test("M: the session started at midnight carries the ticket on", async () => {
  reset();
  fb.lastInputMs = at(15, 23);
  const app = await launch(at(15, 23));
  await app.click("start-btn");
  await advance(70 * MIN, { working: true }); // 23:00 -> 00:10

  const [old, fresh] = sessions();
  assert.equal(old.status, "ended");
  assert.ok(old.segments.every((b) => b.t === "iss-218"));
  assert.equal(fresh.taskId, "iss-218");
  assert.ok(fresh.tasks["iss-218"]);
  assert.ok(fresh.segments.every((b) => b.t === "iss-218"));
  // The pick now belongs to the new day: End, then Start again, needs no new pick.
  await app.click("end-btn");
  await app.click("start-btn");
  assert.equal(sessions().length, 3);
});

test("M: the pick survives a restart the same day, not the next morning", async () => {
  reset();
  fb.autoPick = false;
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await pick(TICKETS[1]);
  await app.click("start-btn");
  await advance(10 * MIN, { working: true });
  await app.click("end-btn");

  const app2 = await launch(at(22, 15)); // reopened the same afternoon
  assert.equal(fb.pickerState.selected?.id, "iss-215");
  assert.equal(app2.els["start-btn"].textContent, "▶ Start Session");

  const app3 = await launch(at(23, 9)); // next morning
  assert.equal(fb.pickerState.selected, null);
  assert.equal(app3.els["start-btn"].textContent, "Choose a ticket to start");
});

test("M: a running session restored after a restart keeps its ticket and blocks", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(30 * MIN, { working: true });
  fb.autoPick = false;
  await launch(Date.now()); // app restarted while the session runs
  await advance(10 * MIN, { working: true });
  const s = sessions().find((x) => x.status !== "ended");
  assert.equal(fb.pickerState.selected?.id, "iss-218");
  assert.ok(s.segments.every((b) => b.t === "iss-218"));
});

test("M: a reload with a new status updates the running session's snapshot", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  await app.click("start-btn");
  await advance(10 * MIN, { working: true });
  fb.linear = { ok: true, tickets: [{ ...TICKETS[0], status: { name: "In Review", type: "started", color: "#4cb782" } }, TICKETS[1]] };
  fb.picker.onReload();
  await flush(30);
  const [s] = sessions();
  assert.equal(s.tasks["iss-218"].status, "In Review");
  assert.equal(s.segments.length, 1, "a status change doesn't split the block");
  assert.equal(fb.pickerState.selected.status.name, "In Review");
});

test("M: Linear down keeps the saved list and says why; not in Linear is its own message", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  await launch(at(22, 9)); // loads and saves the list
  fb.linear = { ok: false, code: "linear_unavailable", message: "Couldn't load tickets from Linear" };
  fb.picker.onReload();
  await flush(30);
  assert.equal(fb.pickerState.tickets.length, 2, "the saved list stays");
  assert.equal(fb.pickerState.error.code, "linear_unavailable");
  assert.equal(fb.pickerState.loading, false);

  fb.linear = { ok: false, code: "not_in_linear", message: "No Linear account uses u1@test" };
  fb.picker.onReload();
  await flush(30);
  assert.equal(fb.pickerState.error.code, "not_in_linear");
});

test("M: logout forgets the pick and the saved list", async () => {
  reset();
  fb.lastInputMs = at(22, 9);
  const app = await launch(at(22, 9));
  assert.ok(fb.store.get("selectedTicket"));
  assert.ok(fb.store.get("linearTickets"));
  await app.click("logout-btn");
  assert.equal(fb.store.get("selectedTicket"), undefined);
  assert.equal(fb.store.get("linearTickets"), undefined);
  assert.ok(fb.store.get("deviceId"), "the computer's id stays");
});
