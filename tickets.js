// Linear tickets for the "Working on" menu: grouping, search, and the
// snapshot saved with a session. No DOM and no network here (see
// ticketPicker.js and the "linear-tickets" handler in main.js).

// Order and names of the menu's groups. The portal sends each ticket's group.
export const GROUPS = [
  ["inProgress", "In progress"],
  ["upNext", "Up next"],
  ["dailyLogs", "Daily logs"],
  ["backlog", "Backlog"],
];

// The list is reloaded when the menu is opened and it is older than this.
export const STALE_MS = 15 * 60 * 1000;

const lower = (s) => String(s || "").toLowerCase();

export function matchesQuery(ticket, query) {
  const q = lower(query).trim();
  if (!q) return true;
  return lower(
    `${ticket.identifier} ${ticket.title} ${ticket.project?.name || ""}`,
  ).includes(q);
}

// [{ key, name, items }] in menu order, only groups with a match.
export function groupTickets(tickets, query = "") {
  const list = Array.isArray(tickets) ? tickets : [];
  return GROUPS.map(([key, name]) => ({
    key,
    name,
    items: list.filter(
      (t) => (t.group || "backlog") === key && matchesQuery(t, query),
    ),
  })).filter((g) => g.items.length > 0);
}

// The fields of a ticket the tracker keeps (selection and local cache).
export function pickTicketFields(ticket) {
  return {
    id: String(ticket.id),
    identifier: String(ticket.identifier || ""),
    title: String(ticket.title || ""),
    url: String(ticket.url || ""),
    status: {
      name: String(ticket.status?.name || ""),
      type: String(ticket.status?.type || ""),
      color: String(ticket.status?.color || ""),
    },
    project: ticket.project
      ? { id: String(ticket.project.id || ""), name: String(ticket.project.name || "") }
      : null,
    group: ticket.group || "backlog",
  };
}

// What the session keeps about a ticket: sessions/{id}.tasks[<linear id>].
// Taken when it is picked, so the portal shows the status it had that day.
export function taskSnapshot(ticket, atMs) {
  return {
    type: "linear",
    identifier: ticket.identifier,
    title: ticket.title,
    url: ticket.url,
    projectId: ticket.project?.id || null,
    project: ticket.project?.name || null,
    status: ticket.status?.name || "",
    statusType: ticket.status?.type || "",
    at: atMs,
  };
}

// True when a reload shows something the session's snapshot should follow.
export function ticketChanged(before, after) {
  return (
    !!before &&
    !!after &&
    (before.status?.name !== after.status?.name ||
      before.title !== after.title ||
      before.identifier !== after.identifier ||
      (before.project?.name || null) !== (after.project?.name || null))
  );
}

// Local calendar day, YYYY-MM-DD (sessions split at local midnight too).
export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// "Updated just now" / "Updated 4m ago" / "Updated 2h ago". After a failed
// reload: "Last updated 9:12 AM" (the list shown is the saved one).
export function syncedText({ fetchedAtMs, loading, failed }, nowMs) {
  if (loading) return "Loading from Linear…";
  if (!fetchedAtMs) return failed ? "Not loaded yet" : "";
  if (failed) return `Last updated ${clock(fetchedAtMs)}`;
  const min = Math.floor((nowMs - fetchedAtMs) / 60000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min}m ago`;
  return `Updated ${Math.floor(min / 60)}h ago`;
}

// One line for a failed reload, by the portal's error code.
export function ticketErrorText(error, hasList) {
  if (!error) return "";
  if (error.code === "not_in_linear") {
    return "Your portal email isn't in Linear. Ask your admin to add it.";
  }
  if (error.code === "not_configured") {
    return "Linear isn't connected to the portal yet.";
  }
  return hasList
    ? "Couldn't reach Linear. Showing the last saved list."
    : "Couldn't reach Linear. Check your connection and try again.";
}

// What the menu says when there is nothing to list.
export const NO_TICKETS_TEXT =
  "No open Linear tickets are assigned to you. Ask your lead, then reload.";
