const BASE_PX = 48;     // pixels per second at 100% zoom
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const GROUP = 3;        // solid line every 3 seconds
const MIN_SECS = 60;    // timeline is always at least this long
const MAX_SECS = 3600;  // upper limit for every time value (one hour)
const LABEL_W = 170;    // width of the name column
const LANE = 44;        // height of one lane of events
const BLOCK_H = 36;     // height of an event block inside its lane
const PAD_TOP = 8;
const STRIP = 22;       // empty strip under each row's events, always free for drawing a new event
const DEFAULT_COLOR = "#2f6fe0";
const EXTEND = 15;      // seconds added by the + button
const MAX_UNDO = 100;
const STORE_KEY = "combat-tracker-v1";
const ZOOM_KEY = "combat-tracker-zoom";

const $ = (id) => document.getElementById(id);
const scroller = $("scroller");
const grid = $("grid");
const uid = () => Math.random().toString(36).slice(2, 9);

document.documentElement.style.setProperty("--label", LABEL_W + "px");

// ---------- State ----------
// { rows: [ { id, name, events: [ { id, windup, start, end, winddown, title, description, color } ] } ],
//   length, now }
// The event itself covers start..end. A wind-up line runs from windup to start (before it),
// and a wind-down line runs from end to winddown (after it). windup <= start < end <= winddown.
// "now" is the second the combat is up to (the red marker).

function newRow(name) { return { id: uid(), name, events: [] }; }

function cleanRows(data) {
  if (!data || !Array.isArray(data.rows)) throw new Error("This isn't a combat tracker file.");
  return {
    rows: data.rows.map((r) => ({
      id: uid(),
      name: String(r.name ?? "").slice(0, 60),
      events: (Array.isArray(r.events) ? r.events : []).map((e) => {
        const start = Math.min(MAX_SECS - 1, Math.max(0, Math.floor(Number(e.start)) || 0));
        const end = Math.min(MAX_SECS, Math.max(start + 1, Math.floor(Number(e.end)) || start + 1));
        const winddown = e.winddown !== undefined
          ? Math.floor(Number(e.winddown)) || end
          : e.complete !== undefined
            ? Math.floor(Number(e.complete)) || end                        // older files called it "complete"
            : end + (Math.max(0, Math.floor(Number(e.completion)) || 0));  // the oldest stored seconds after end
        const windup = e.windup == null || !Number.isFinite(Number(e.windup))
          ? start
          : Math.min(start, Math.max(0, Math.floor(Number(e.windup))));
        return {
          id: uid(),
          start,
          end,
          windup,
          winddown: Math.min(MAX_SECS, Math.max(end, winddown)),
          title: String(e.title ?? e.label ?? "").slice(0, 60), // "label" = older files
          description: String(e.description ?? "").slice(0, 500),
          color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : DEFAULT_COLOR,
        };
      }),
    })),
  };
}

function clean(data) {
  const { rows } = cleanRows(data);
  const extent = Math.max(0, ...rows.flatMap((r) => r.events.map((e) => e.winddown)));
  const wanted = Math.max(MIN_SECS, Math.floor(Number(data.length)) || 0, extent);
  const length = Math.min(MAX_SECS, Math.ceil(wanted / GROUP) * GROUP);
  return { rows, length, now: Math.min(length, Math.max(0, Math.floor(Number(data.now)) || 0)) };
}

function load() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    return saved ? clean(JSON.parse(saved)) : null;
  } catch { return null; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function loadZoom() {
  try {
    const z = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(z) ? z : 1;
  } catch { return 1; }
}

// Emergency reset: opening the page with ?reset clears the saved data on this device.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("reset")) {
  try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(ZOOM_KEY); } catch { /* storage unavailable */ }
  history.replaceState(null, "", location.pathname);
}

let state = load() || { rows: [newRow("Player 1"), newRow("Enemy 1")], length: MIN_SECS, now: 0 };
let zoom = loadZoom();
let px = BASE_PX * zoom; // pixels per second right now
let drag = null;
let rowDrag = null;      // set while a row is being dragged to a new position
let nowDrag = false;     // true while the red marker is being dragged
let selected = null;     // id of the selected event
let clip = null;         // copied event: { rowId, ev }

const allEvents = () => state.rows.flatMap((r) => r.events);
const maxEnd = () => Math.max(0, ...allEvents().map((e) => e.end));
const maxExtent = () => Math.max(0, ...allEvents().map((e) => e.winddown));
const totalSecs = () => Math.min(MAX_SECS, Math.ceil(Math.max(state.length, maxExtent()) / GROUP) * GROUP);

// Keep an event's numbers consistent and within limits: windup <= start < end <= winddown <= MAX_SECS.
const clampSec = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.floor(v) : lo)); // also fixes NaN

function fix(ev) {
  ev.start = clampSec(ev.start, 0, MAX_SECS - 1);
  ev.end = clampSec(ev.end, ev.start + 1, MAX_SECS);
  ev.windup = clampSec(ev.windup, 0, ev.start);
  ev.winddown = clampSec(ev.winddown, ev.end, MAX_SECS);
}

// Pick black or white text for a given background colour.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#111" : "#fff";
}

function findEvent(id) {
  for (const row of state.rows) {
    const ev = row.events.find((e) => e.id === id);
    if (ev) return { row, ev };
  }
}

// Stack overlapping events into lanes (an event's lines count as part of it).
function layout(row) {
  const sorted = [...row.events].sort((a, b) => a.windup - b.windup || a.winddown - b.winddown);
  const laneEnds = [];
  const lanes = new Map();
  for (const ev of sorted) {
    let i = laneEnds.findIndex((end) => end <= ev.windup);
    if (i < 0) i = laneEnds.length;
    laneEnds[i] = ev.winddown;
    lanes.set(ev, i);
  }
  return { lanes, count: laneEnds.length };
}

// ---------- Undo / redo ----------
// Snapshots cover the rows and timeline length (not the marker or zoom).
const snapshot = () => JSON.stringify({ rows: state.rows, length: state.length });
const undoStack = [];
const redoStack = [];
let editGroup = null; // consecutive edits to the same field share one undo step

function pushUndo(before) {
  undoStack.push(before);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

// Run a change to the data. Records an undo step, saves and redraws.
function change(fn, key = null, redraw = true) {
  const before = snapshot();
  if (fn() === false) return false;
  if (snapshot() === before) return false;
  if (!key || key !== editGroup) pushUndo(before);
  editGroup = key;
  save();
  if (redraw) render();
  return true;
}

function stepHistory(from, to) {
  if (drag || rowDrag || nowDrag || !from.length) return;
  to.push(snapshot());
  const s = JSON.parse(from.pop());
  state.rows = s.rows;
  state.length = s.length;
  editGroup = null;
  save();
  render();
  syncPanel(true);
}
const undo = () => stepHistory(undoStack, redoStack);
const redo = () => stepHistory(redoStack, undoStack);

document.addEventListener("focusin", () => { editGroup = null; });

// ---------- Rendering ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") el.style.cssText = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el[k] = v;
  }
  el.append(...kids);
  return el;
}

function rulerRow(total, end, now) {
  const track = h("div", { className: "track" });
  for (let s = 0; s <= total; s += GROUP) {
    track.append(h("span", { className: "tick", style: `left:${s * px}px` }, String(s)));
  }
  track.append(h("div", { className: "fill", style: `width:${end * px}px` }));
  track.append(h("div", { className: "now-flag", title: "Drag to move the now marker", style: `left:${now * px}px` }));
  const plus = h("button", { className: "plus", type: "button", title: `Add ${EXTEND} seconds`, textContent: "+", disabled: total >= MAX_SECS });
  return h("div", { className: "row ruler" }, h("div", { className: "label" }, "Seconds"), track, plus);
}

function blockEl(ev, y) {
  return h("div",
    {
      className: "block" + (ev.id === selected ? " selected" : ""),
      style: `left:${ev.start * px}px;width:${(ev.end - ev.start) * px}px;top:${y}px;height:${BLOCK_H}px;--c:${ev.color};--fg:${textOn(ev.color)}`,
      dataset: { ev: ev.id },
    },
    h("div", { className: "head" }, h("strong", { className: ev.title ? "" : "empty" }, ev.title || "Untitled"), ` - ${ev.end - ev.start}s`),
    ...(ev.description ? [h("div", { className: "desc" }, ev.description)] : []),
    h("button", { className: "x", type: "button", title: "Delete event" }),
    h("div", { className: "handle" })
  );
}

function tailEl(ev, y) {
  return h("div", {
    className: "tail",
    style: `left:${ev.end * px}px;width:${(ev.winddown - ev.end) * px}px;top:${y + (BLOCK_H - 16) / 2}px;--c:${ev.color}`,
    dataset: { ev: ev.id },
  });
}

function leadEl(ev, y) {
  return h("div", {
    className: "lead",
    style: `left:${ev.windup * px}px;width:${(ev.start - ev.windup) * px}px;top:${y + (BLOCK_H - 16) / 2}px;--c:${ev.color}`,
    dataset: { ev: ev.id },
  });
}

function rowEl(row) {
  const name = h("input", { className: "name", value: row.name, maxLength: 60, placeholder: "Name" });
  name.addEventListener("input", () => change(() => { row.name = name.value; }, "name:" + row.id, false));

  const del = h("button", { className: "icon", type: "button", title: "Remove row", textContent: "×" });
  del.addEventListener("click", () => {
    if (row.events.length && !confirm(`Remove "${row.name}" and its ${row.events.length} event(s)?`)) return;
    change(() => { state.rows = state.rows.filter((r) => r !== row); });
  });

  const { lanes, count } = layout(row);
  const track = h("div", {
    className: "track",
    dataset: { row: row.id },
    style: `height:${PAD_TOP + Math.max(1, count) * LANE + STRIP}px`,
  });
  for (const ev of row.events) {
    const y = PAD_TOP + lanes.get(ev) * LANE;
    if (ev.windup < ev.start) track.append(leadEl(ev, y));
    if (ev.winddown > ev.end) track.append(tailEl(ev, y));
    track.append(blockEl(ev, y));
  }

  const grip = h("span", { className: "grip", title: "Drag to reorder", textContent: "≡", dataset: { row: row.id } });
  const dragging = rowDrag && rowDrag.row === row ? " dragging" : "";
  return h("div", { className: "row" + dragging }, h("div", { className: "label" }, grip, name, del), track);
}

function render() {
  // Safety net: whatever got into the data, never draw values outside the limits.
  state.length = clampSec(state.length, MIN_SECS, MAX_SECS);
  state.now = clampSec(state.now, 0, MAX_SECS);
  for (const ev of allEvents()) fix(ev);

  const total = totalSecs();
  const now = Math.min(state.now, total);
  grid.style.setProperty("--px", px + "px");
  grid.style.setProperty("--w", total * px + "px");
  $("upto").textContent = `Now: ${now}s / Up to: ${maxEnd()}s`;
  $("zoomLevel").textContent = Math.round(zoom * 100) + "%";
  $("zoomOut").disabled = zoom <= ZOOMS[0];
  $("zoomIn").disabled = zoom >= ZOOMS[ZOOMS.length - 1];
  grid.replaceChildren(
    rulerRow(total, maxEnd(), now),
    ...state.rows.map(rowEl),
    h("div", { className: "now-line", style: `left:${LABEL_W + now * px}px` })
  );
  syncPanel();
}

// ---------- Details panel ----------
const F = {
  title: $("f-title"), desc: $("f-desc"), start: $("f-start"),
  end: $("f-end"), len: $("f-len"), wu: $("f-wu"), wulen: $("f-wulen"), wd: $("f-wd"), wdlen: $("f-wdlen"), color: $("f-color"),
};

for (const el of [F.end, F.len, F.wd, F.wdlen]) el.max = MAX_SECS; // browser arrows and validation respect the limit

function syncPanel(force = false) {
  const found = selected && findEvent(selected);
  $("panel").hidden = !found;
  if (!found) { selected = null; return; }
  const { ev } = found;
  const set = (el, v) => { if (force || document.activeElement !== el) el.value = v; };
  set(F.title, ev.title);
  set(F.desc, ev.description);
  set(F.start, ev.start);
  set(F.end, ev.end);
  set(F.len, ev.end - ev.start);
  set(F.wu, ev.windup);
  set(F.wulen, ev.start - ev.windup);
  set(F.wd, ev.winddown);
  set(F.wdlen, ev.winddown - ev.end);
  F.start.max = ev.end - 1;   // the browser's arrows and validation respect these bounds
  F.end.min = ev.start + 1;
  F.wd.min = ev.end;
  F.wu.max = ev.start;
  F.wulen.max = ev.start;
  set(F.color, ev.color);
  $("sum").textContent =
    `Starts at ${ev.start}s, ends at ${ev.end}s (${ev.end - ev.start}s).` +
    (ev.windup < ev.start ? ` Wind-up begins at ${ev.windup}s.` : "") +
    (ev.winddown > ev.end ? ` Wind-down continues to ${ev.winddown}s.` : "");
}

// Edit the selected event. `key` groups consecutive edits to one field into one undo step.
function edit(fn, key) {
  const found = selected && findEvent(selected);
  if (!found) return;
  change(() => {
    if (fn(found.ev) === false) return false;
    fix(found.ev);
  }, key && key + ":" + found.ev.id);
}

// Number fields only apply values that make sense (windup <= start < end <= winddown).
// Anything else is ignored while typing, and the field snaps back when you leave it.
function editNum(el, valid, apply) {
  const maxDigits = String(MAX_SECS).length;
  if (el.value.length > maxDigits) el.value = el.value.slice(0, maxDigits); // stop absurdly long numbers being typed or pasted
  const v = el.value.trim() === "" ? NaN : Math.floor(Number(el.value));
  if (!Number.isFinite(v) || v > MAX_SECS) return; // too big: ignored, and the field snaps back
  edit((ev) => (valid(v, ev) ? apply(v, ev) : false), el.id);
}

F.title.addEventListener("input", () => edit((ev) => { ev.title = F.title.value; }, "title"));
F.desc.addEventListener("input", () => edit((ev) => { ev.description = F.desc.value; }, "desc"));
F.start.addEventListener("input", () => editNum(F.start, (v, ev) => v >= 0 && v < ev.end, (v, ev) => { ev.start = v; }));
F.end.addEventListener("input", () => editNum(F.end, (v, ev) => v > ev.start, (v, ev) => { ev.end = v; }));
F.wu.addEventListener("input", () => editNum(F.wu, (v, ev) => v >= 0 && v <= ev.start, (v, ev) => { ev.windup = v; }));
F.wulen.addEventListener("input", () => editNum(F.wulen, (v, ev) => v >= 0 && v <= ev.start, (v, ev) => { ev.windup = ev.start - v; }));
F.wd.addEventListener("input", () => editNum(F.wd, (v, ev) => v >= ev.end, (v, ev) => { ev.winddown = v; }));
// Durations: changing the event's length keeps its wind-down length, so that line moves with the end.
F.len.addEventListener("input", () => editNum(F.len, (v) => v >= 1, (v, ev) => {
  const line = ev.winddown - ev.end;
  ev.end = ev.start + v;
  ev.winddown = ev.end + line;
}));
F.wdlen.addEventListener("input", () => editNum(F.wdlen, (v) => v >= 0, (v, ev) => { ev.winddown = ev.end + v; }));
for (const el of [F.start, F.end, F.len, F.wu, F.wulen, F.wd, F.wdlen]) {
  el.addEventListener("focus", () => setTimeout(() => el.select(), 0)); // typing replaces the old value
  el.addEventListener("change", () => syncPanel(true));                 // snap back if the value was rejected
}
F.color.addEventListener("input", () => edit((ev) => { ev.color = F.color.value; }, "color"));

$("close").addEventListener("click", () => { selected = null; render(); });

function deleteEvent(id) {
  const found = findEvent(id);
  if (!found) return;
  change(() => {
    found.row.events = found.row.events.filter((v) => v !== found.ev);
    if (selected === id) selected = null;
  });
}

$("delete").addEventListener("click", () => { if (selected) deleteEvent(selected); });

grid.addEventListener("click", (e) => {
  const x = e.target.closest(".x");
  if (x) deleteEvent(x.closest(".block").dataset.ev);
  if (e.target.closest(".plus")) {
    change(() => { state.length = Math.min(MAX_SECS, totalSecs() + EXTEND); });
    scroller.scrollLeft += EXTEND * px; // keep the + under the pointer for repeat taps
  }
});

// ---------- Copy and paste ----------
function copySelected() {
  const found = selected && findEvent(selected);
  if (found) clip = { rowId: found.row.id, ev: { ...found.ev } };
}

// Pastes an exact copy: same row, same times (it stacks into a new lane if it overlaps).
function pasteEvent() {
  if (!clip) return;
  change(() => {
    const row = state.rows.find((r) => r.id === clip.rowId)
      || (selected && findEvent(selected)?.row)
      || state.rows[0];
    if (!row) return false;
    const copy = { ...clip.ev, id: uid() };
    row.events.push(copy);
    selected = copy.id;
  });
}

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest && e.target.closest("input, textarea, select");

  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (key === "y") { e.preventDefault(); redo(); }
    else if (key === "s") { e.preventDefault(); downloadJson(); }
    else if (key === "o") { e.preventDefault(); $("file").click(); }
    else if (key === "c" && !typing && selected && !String(window.getSelection())) { e.preventDefault(); copySelected(); }
    else if (key === "v" && !typing && clip) { e.preventDefault(); pasteEvent(); }
    else if (key === "+" || key === "=") { e.preventDefault(); stepZoom(1); }   // replaces the browser's page zoom
    else if (key === "-" || key === "_") { e.preventDefault(); stepZoom(-1); }
    else if (key === "0") { e.preventDefault(); setZoom(1); }
    else if ((key === "arrowleft" || key === "arrowright") && !typing) {
      e.preventDefault();
      state.now = clampSec(state.now + (key === "arrowright" ? 1 : -1), 0, totalSecs());
      save();
      render();
      const x = state.now * px, view = scroller.clientWidth - LABEL_W; // bring the marker into view if needed
      if (x < scroller.scrollLeft) scroller.scrollLeft = x - 20;
      else if (x > scroller.scrollLeft + view) scroller.scrollLeft = x - view + 20;
    }
    return;
  }

  if (e.key === "Escape" && selected) { selected = null; render(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
    e.preventDefault();
    deleteEvent(selected);
  }
});

// ---------- Dragging (mouse and touch) ----------
const posAt = (e) => (e.clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft - LABEL_W) / px;
const secAt = (e) => Math.max(0, Math.floor(posAt(e)));

function reorderRows(e) {
  const nodes = [...grid.querySelectorAll(".row:not(.ruler)")];
  const from = state.rows.indexOf(rowDrag.row);
  let to = 0; // count the other rows whose middle is above the pointer
  state.rows.forEach((r, i) => {
    if (r === rowDrag.row) return;
    const b = nodes[i].getBoundingClientRect();
    if (e.clientY > b.top + b.height / 2) to++;
  });
  if (to !== from) {
    state.rows.splice(from, 1);
    state.rows.splice(to, 0, rowDrag.row);
    render();
  }
}

scroller.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".x")) return;

  if (e.target.closest(".now-flag")) {
    nowDrag = true;
    document.activeElement?.blur?.();
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const before = snapshot();
  editGroup = null;

  const grip = e.target.closest(".grip");
  if (grip) {
    rowDrag = { row: state.rows.find((r) => r.id === grip.dataset.row), before };
    document.activeElement?.blur?.();
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
    render();
    return;
  }
  const track = e.target.closest(".track[data-row]");
  if (!track) return;

  const sec = Math.min(secAt(e), MAX_SECS - 1);
  const line = e.target.closest(".tail, .lead");
  const node = e.target.closest(".block") || line;
  let row = state.rows.find((r) => r.id === track.dataset.row);
  let ev, mode;

  if (node) {
    ({ row, ev } = findEvent(node.dataset.ev));
    mode = line ? (line.classList.contains("lead") ? "windup" : "winddown") : e.target.closest(".handle") ? "resize" : "move";
  } else {
    ev = { id: uid(), start: sec, end: sec + 1, windup: sec, winddown: sec + 1, title: "", description: "", color: DEFAULT_COLOR };
    row.events.push(ev);
    mode = "create";
  }

  selected = ev.id;
  document.activeElement?.blur?.(); // so Delete reaches the event, not a text box
  drag = { mode, row, ev, before, anchor: sec, offset: sec - ev.start, moved: false, x: e.clientX, y: e.clientY };
  scroller.setPointerCapture(e.pointerId);
  e.preventDefault();
  render();
});

scroller.addEventListener("pointermove", (e) => {
  if (nowDrag) {
    state.now = Math.min(totalSecs(), Math.max(0, Math.round(posAt(e))));
    render();
    return;
  }
  if (rowDrag) { reorderRows(e); return; }
  if (!drag) return;
  const { ev, mode } = drag;
  const cur = Math.min(secAt(e), MAX_SECS - 1);
  if (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4) drag.moved = true;

  if (mode === "create") {
    ev.start = Math.min(drag.anchor, cur);
    ev.end = Math.max(drag.anchor, cur) + 1;
    ev.windup = ev.start;
    ev.winddown = ev.end;
  } else if (mode === "resize") {
    ev.end = Math.max(ev.start + 1, cur + 1);
    fix(ev);
  } else if (mode === "winddown") {
    ev.winddown = Math.min(MAX_SECS, Math.max(ev.end, Math.round(posAt(e))));
  } else if (mode === "windup") {
    ev.windup = Math.min(ev.start, Math.max(0, Math.round(posAt(e))));
  } else if (drag.moved) {
    const len = ev.end - ev.start;
    const leadLen = ev.start - ev.windup;
    const tailLen = ev.winddown - ev.end;
    ev.start = Math.max(leadLen, Math.min(cur - drag.offset, MAX_SECS - len - tailLen)); // can't slide so far left that the wind-up passes 0
    ev.end = ev.start + len;
    ev.windup = ev.start - leadLen;
    ev.winddown = ev.end + tailLen;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(".track[data-row]");
    const target = under && state.rows.find((r) => r.id === under.dataset.row);
    if (target && target !== drag.row) {
      drag.row.events = drag.row.events.filter((x) => x !== ev);
      target.events.push(ev);
      drag.row = target;
    }
  }
  render();
});

function endDrag(e) {
  if (nowDrag) { nowDrag = false; save(); render(); return; }
  const d = rowDrag || drag;
  if (!d) return;
  if (drag && e.type === "pointercancel" && drag.mode === "create") {
    drag.row.events = drag.row.events.filter((x) => x !== drag.ev); // browser took over to scroll
    if (selected === drag.ev.id) selected = null;
  }
  rowDrag = null;
  drag = null;
  if (snapshot() !== d.before) pushUndo(d.before); // one undo step per drag
  save();
  render();
}
scroller.addEventListener("pointerup", endDrag);
scroller.addEventListener("pointercancel", endDrag);

// ---------- Zoom ----------
function setZoom(z) {
  const half = (scroller.clientWidth - LABEL_W) / 2;
  const centreSec = (scroller.scrollLeft + half) / px; // keep the middle of the view where it is
  zoom = z;
  px = BASE_PX * zoom;
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* storage unavailable */ }
  render();
  scroller.scrollLeft = centreSec * px - half;
}
const stepZoom = (dir) => {
  const next = ZOOMS[ZOOMS.indexOf(zoom) + dir];
  if (next) setZoom(next);
};
$("zoomOut").addEventListener("click", () => stepZoom(-1));
$("zoomIn").addEventListener("click", () => stepZoom(1));
$("zoomLevel").addEventListener("click", () => setZoom(1));

// ---------- Buttons ----------
$("addRow").addEventListener("click", () => {
  change(() => { state.rows.push(newRow(`Entity ${state.rows.length + 1}`)); });
});

function downloadJson() {
  const data = {
    version: 6,
    length: totalSecs(),
    now: Math.min(state.now, totalSecs()),
    rows: state.rows.map(({ name, events }) => ({
      name,
      events: events.map(({ windup, start, end, winddown, title, description, color }) => ({ windup, start, end, winddown, title, description, color })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `combat-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("download").addEventListener("click", downloadJson);

$("reset").addEventListener("click", () => {
  if (!confirm("Reset everything? This removes all events and all rows except the first, and sets the timeline back to 60 seconds. You can undo with Ctrl+Z, or download first to keep a copy.")) return;
  change(() => {
    const first = state.rows[0] || newRow("Player 1");
    first.events = [];
    state.rows = [first];
    state.length = MIN_SECS;
    selected = null;
  });
  state.now = 0;
  save();
  render();
  scroller.scrollLeft = 0;
});

$("upload").addEventListener("click", () => $("file").click());

$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  try {
    const next = clean(JSON.parse(await file.text()));
    if (maxEnd() > 0 && !confirm("Replace the current combat with this file?")) return;
    change(() => {
      state.rows = next.rows;
      state.length = next.length;
      selected = null;
    });
    state.now = next.now;
    save();
    render();
  } catch (err) {
    alert("Couldn't load that file: " + err.message);
  }
});

render();

// Offline support: the service worker caches the app's files.
if ("serviceWorker" in navigator) {
  // When an updated service worker takes over, reload once so you're never left on old code.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => { /* e.g. opened from a file:// URL */ });
  });
}