// The "Working on" field and its ticket menu (markup in index.html), and the
// note box used when there is no ticket. renderer.js owns the data (including
// note mode and the typed note) and passes it in with update(); this file only
// draws it and reports clicks and typing. Text is set with textContent / value,
// never HTML.
import {
  cleanNote,
  groupTickets,
  syncedText,
  ticketErrorText,
  NO_TICKETS_TEXT,
} from "./tickets.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function checkIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ticket-check");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4.5 10.5l3.5 3.5 7.5-8");
  svg.appendChild(path);
  return svg;
}

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createTicketPicker({
  onPick,
  onReload,
  onOpen,
  onNoteMode,
  onNoteInput,
  onNoteSubmit,
  onNoteEdit,
  onNoteNew,
  onNoteCancel,
}) {
  const el = (id) => document.getElementById(id);
  const field = el("ticket-field");
  const fieldDot = el("ticket-dot");
  const fieldMeta = el("ticket-field-meta");
  const fieldTitle = el("ticket-field-title");
  const reloadBtn = el("ticket-reload");
  const backdrop = el("ticket-backdrop");
  const menu = el("ticket-menu");
  const search = el("ticket-search");
  const alertBox = el("ticket-alert");
  const alertText = el("ticket-alert-text");
  const retryBtn = el("ticket-retry");
  const list = el("ticket-list");
  const synced = el("ticket-synced");
  const bar = field.closest(".ticket-bar");
  const noteToggle = el("ticket-note-toggle");
  const noteBox = el("ticket-note");
  const noteInput = el("ticket-note-input");
  const noteFromMenu = el("ticket-note-from-menu");
  const noteCurrent = el("ticket-note-current");
  const noteCurrentTitle = el("ticket-note-current-title");
  const noteEdit = el("ticket-note-edit");
  const noteNew = el("ticket-note-new");
  const noteForm = el("ticket-note-form");
  const noteSubmit = el("ticket-note-submit");
  const noteCancel = el("ticket-note-cancel");

  let state = {
    tickets: [],
    selected: null,
    fetchedAtMs: null,
    loading: false,
    error: null,
    required: false, // highlight the field: Start needs a ticket
    noteMode: false, // the note box is shown instead of the ticket field
    noteText: "", // what's typed in it
    noteEditing: false, // "Edit" on the added note: Save / Cancel
    noteAdding: false, // "New note" while a note is the task: Add note / Cancel
    notes: [], // today's notes, shown first in the menu
  };
  let isOpen = false;
  let query = "";
  let tick = null;

  function renderNote() {
    bar.hidden = state.noteMode;
    noteBox.hidden = !state.noteMode;
    noteToggle.textContent = state.noteMode
      ? "Pick a ticket instead"
      : "No ticket? Write a note";
    // An added note is locked; "Edit" opens it with Save / Cancel.
    const current = state.selected?.type === "note" ? state.selected : null;
    const locked = state.noteMode && !!current && !state.noteEditing && !state.noteAdding;
    noteCurrent.hidden = !locked;
    noteForm.hidden = locked;
    if (current) noteCurrentTitle.textContent = current.title;
    noteSubmit.textContent = state.noteEditing ? "Save" : "Add note";
    noteSubmit.disabled = !cleanNote(state.noteText);
    noteCancel.hidden = !(state.noteEditing || state.noteAdding);
    // Don't move the caret while the person is typing (a cleared draft always clears).
    if (
      noteInput.value !== state.noteText &&
      (document.activeElement !== noteInput || state.noteText === "")
    ) {
      noteInput.value = state.noteText;
    }
  }

  function renderField() {
    renderNote();
    const t = state.selected;
    field.classList.toggle("needs-ticket", !t && state.required);
    fieldMeta.classList.toggle("is-note", t?.type === "note");
    if (t?.type === "note") {
      // A note is the task, but tickets are shown: say so in the field.
      fieldDot.hidden = true;
      fieldMeta.textContent = "Note";
      fieldMeta.hidden = false;
      fieldTitle.textContent = t.title;
      fieldTitle.classList.remove("placeholder");
      field.setAttribute("aria-label", `Working on a note: ${t.title}. Choose a ticket`);
      reloadBtn.classList.toggle("spinning", state.loading);
      reloadBtn.disabled = state.loading;
      return;
    }
    field.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (t) {
      fieldDot.style.background = t.status?.color || "#a1a1aa";
      fieldDot.hidden = false;
      fieldMeta.textContent = t.project?.name
        ? `${t.identifier} · ${t.project.name}`
        : t.identifier;
      fieldMeta.hidden = false;
      fieldTitle.textContent = t.title;
      fieldTitle.classList.remove("placeholder");
      field.setAttribute(
        "aria-label",
        `Working on ${t.identifier}, ${t.title}. Change ticket`,
      );
    } else {
      fieldDot.hidden = true;
      fieldMeta.hidden = true;
      fieldTitle.textContent = "Choose a Linear ticket";
      fieldTitle.classList.add("placeholder");
      field.setAttribute("aria-label", "Choose a Linear ticket");
    }
    reloadBtn.classList.toggle("spinning", state.loading);
    reloadBtn.disabled = state.loading;
    reloadBtn.title = state.loading
      ? "Loading tickets from Linear…"
      : "Reload tickets from Linear";
  }

  function renderSynced() {
    synced.textContent = syncedText(
      {
        fetchedAtMs: state.fetchedAtMs,
        loading: state.loading,
        failed: !!state.error,
      },
      Date.now(),
    );
  }

  function renderMenu() {
    menu.hidden = !isOpen;
    backdrop.hidden = !isOpen;
    if (!isOpen) return;

    const hasList = state.tickets.length > 0;
    const errorLine = state.loading ? "" : ticketErrorText(state.error, hasList);
    alertBox.hidden = !errorLine;
    alertText.textContent = errorLine;
    retryBtn.hidden = state.error?.code === "not_in_linear";
    renderSynced();

    list.replaceChildren();
    const groups = groupTickets([...(state.notes || []), ...state.tickets], query);
    for (const group of groups) {
      list.appendChild(span("ticket-group", group.name));
      for (const t of group.items) {
        const on = state.selected?.id === t.id;
        const row = document.createElement("button");
        row.type = "button";
        row.className = on ? "ticket-row selected" : "ticket-row";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", on ? "true" : "false");
        row.dataset.id = t.id;
        const isNote = t.type === "note";
        const dot = span("ticket-dot");
        dot.style.background = isNote ? "#34d399" : t.status?.color || "#a1a1aa";
        const text = span("ticket-row-text");
        text.appendChild(span("ticket-row-title", t.title));
        const meta = span("ticket-row-meta");
        if (isNote) {
          meta.appendChild(span("ticket-note-tag", "Note"));
        } else {
          meta.appendChild(span("ticket-id", t.identifier));
          const extra = [t.status?.name, t.project?.name].filter(Boolean).join(" · ");
          if (extra) meta.appendChild(document.createTextNode(` · ${extra}`));
        }
        text.appendChild(meta);
        row.append(dot, text);
        if (on) row.appendChild(checkIcon());
        row.title = isNote ? `Note · ${t.title}` : `${t.identifier} · ${t.title}`;
        row.addEventListener("click", () => {
          close();
          onPick(t);
        });
        list.appendChild(row);
      }
    }
    if (groups.length === 0) {
      let text = "";
      if (state.loading && !hasList) text = "Loading tickets from Linear…";
      else if (query.trim() && hasList) text = `No ticket matches "${query.trim()}".`;
      else if (!state.error) text = NO_TICKETS_TEXT;
      if (text) list.appendChild(span("ticket-empty", text));
    }
  }

  function render() {
    renderField();
    renderMenu();
  }

  function fitMenu() {
    // The window is small and fixed: keep the menu inside it.
    const top = field.getBoundingClientRect().bottom + 6;
    menu.style.maxHeight = `${Math.max(200, window.innerHeight - top - 12)}px`;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    query = "";
    search.value = "";
    fitMenu();
    render();
    list.querySelector(".ticket-row.selected")?.scrollIntoView({ block: "nearest" });
    search.focus();
    tick = setInterval(renderSynced, 30 * 1000);
    onOpen?.();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearInterval(tick);
    tick = null;
    render();
    field.focus();
  }

  const options = () => [...list.querySelectorAll(".ticket-row")];

  field.addEventListener("click", () => (isOpen ? close() : open()));
  noteToggle.addEventListener("click", () => {
    close();
    onNoteMode?.(!state.noteMode);
  });
  // From the menu: always an empty box for a new note.
  noteFromMenu.addEventListener("click", () => {
    close();
    onNoteNew?.();
  });
  noteInput.addEventListener("input", () => onNoteInput?.(noteInput.value));
  // A note is only used once confirmed: "Add note" / "Save" or Enter. Leaving
  // the box changes nothing. Esc cancels an edit.
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (cleanNote(noteInput.value)) onNoteSubmit?.(noteInput.value);
    } else if (e.key === "Escape" && (state.noteEditing || state.noteAdding)) {
      e.preventDefault();
      onNoteCancel?.();
    }
  });
  noteSubmit.addEventListener("click", () => onNoteSubmit?.(noteInput.value));
  noteCancel.addEventListener("click", () => onNoteCancel?.());
  noteEdit.addEventListener("click", () => onNoteEdit?.());
  noteNew.addEventListener("click", () => onNoteNew?.());
  backdrop.addEventListener("click", close);
  reloadBtn.addEventListener("click", () => onReload());
  retryBtn.addEventListener("click", () => onReload());
  search.addEventListener("input", () => {
    query = search.value;
    renderMenu();
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      if (e.key === "Enter" && document.activeElement === search) {
        const first = options()[0];
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
      return;
    }
    e.preventDefault();
    const rows = options();
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    const next =
      e.key === "ArrowDown"
        ? rows[Math.min(rows.length - 1, at + 1)]
        : at <= 0
          ? search
          : rows[at - 1];
    next.focus();
  });

  return {
    update(next) {
      state = { ...state, ...next };
      render();
    },
    open,
    close,
    focusNote() {
      noteInput.focus();
    },
  };
}
