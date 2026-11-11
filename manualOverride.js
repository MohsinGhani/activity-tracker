// Manual time overrides whatever the tracker recorded in its window (INC-192).
// The same rules live in the portal (items-vuejs/utils/manualOverride.ts):
// keep them in sync.
//
// sessions: [{ start, end, activeMs, idleMs, segments? }]   (ms)
//   segments: [{ k: "a" | "i", s, e }] — the session's active/idle blocks.
//   Sessions recorded before 1.0.6 have no segments; for those the overlap is
//   split by the session's overall idle share.
// entries:  [{ start, end }]                                  (ms)
//
// Returns how much tracked active/idle time the manual entries replace, in
// total and per entry.
export function applyManualOverride(sessions, entries) {
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  let activeCut = 0;
  let idleCut = 0;
  const replaced = entries.map(() => ({ activeMs: 0, idleMs: 0 }));

  for (const session of sessions) {
    if (Array.isArray(session.segments) && session.segments.length) {
      for (const seg of session.segments) {
        entries.forEach((m, i) => {
          const o = overlap(seg.s, seg.e, m.start, m.end);
          if (!o) return;
          if (seg.k === "i") {
            idleCut += o;
            replaced[i].idleMs += o;
          } else {
            activeCut += o;
            replaced[i].activeMs += o;
          }
        });
      }
      continue;
    }

    const tracked = (session.activeMs || 0) + (session.idleMs || 0);
    if (!tracked || !(session.end > session.start)) continue;
    const idleShare = (session.idleMs || 0) / tracked;
    entries.forEach((m, i) => {
      const o = Math.min(overlap(session.start, session.end, m.start, m.end), tracked);
      if (!o) return;
      idleCut += o * idleShare;
      activeCut += o * (1 - idleShare);
      replaced[i].idleMs += o * idleShare;
      replaced[i].activeMs += o * (1 - idleShare);
    });
  }

  return { activeCut, idleCut, replaced };
}

// Overlapping or touching windows merged into one, so time counts once
// (e.g. entries added from two devices).
export function mergeWindows(windows) {
  const sorted = windows.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}
