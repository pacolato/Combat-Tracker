const PX = 48;          // pixels per second
const GROUP = 3;        // solid line every 3 seconds
const MIN_SECS = 60;    // timeline is always at least this long
const PAD = 30;         // empty seconds kept after the last action
const LABEL_W = 170;    // width of the name column
const LANE = 44;        // height of one lane of events
const BLOCK_H = 36;     // height of an event block inside its lane
const PAD_TOP = 8;
const STRIP = 22;       // empty strip under each row's events, always free for drawing a new event
const DEFAULT_COLOR = "#2f6fe0";
const EXTEND = 15;        // seconds added by the + button
const STORE_KEY = "combat-tracker-v1";

const $ = (id) => document.getElementById(id);
const scroller = $("scroller");
const grid = $("grid");
const uid = () => Math.random().toString(36).slice(2, 9);

document.documentElement.style.setProperty("--label", LABEL_W + "px");

// ---------- State ----------
// { rows: [ { id, name, events: [ { id, windup, start, end, winddown, title, description, color } ] } ] }
// The event itself covers start..end. A wind-up line runs from windup to start (before it),
// and a wind-down line runs from end to winddown (after it). windup <= start < end <= winddown.

function newRow(name) { return { id: uid(), name, events: [] }; }

function cleanRows(data) {
  if (!data || !Array.isArray(data.rows)) throw new Error("This isn't a combat tracker file.");
  return {
    rows: data.rows.map((r) => ({
      id: uid(),
      name: String(r.name ?? "").slice(0, 60),
      events: (Array.isArray(r.events) ? r.events : []).map((e) => {
        const start = Math.max(0, Math.floor(Number(e.start)) || 0);
        const end = Math.max(start + 1, Math.floor(Number(e.end)) || start + 1);
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
          winddown: Math.max(end, winddown),
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
  return { rows, length: Math.ceil(wanted / GROUP) * GROUP };
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

let state = load() || { rows: [newRow("Player 1"), newRow("Enemy 1")], length: MIN_SECS };
let drag = null;
let rowDrag = null; // set while a row is being dragged to a new position
let selected = null; // id of the selected event

const allEvents = () => state.rows.flatMap((r) => r.events);
const maxEnd = () => Math.max(0, ...allEvents().map((e) => e.end));
const maxExtent = () => Math.max(0, ...allEvents().map((e) => e.winddown));
const totalSecs = () => Math.ceil(Math.max(state.length, maxExtent()) / GROUP) * GROUP;

// Keep an event's numbers consistent: windup <= start < end <= winddown.
function fix(ev) {
  ev.start = Math.max(0, ev.start);
  if (ev.end <= ev.start) ev.end = ev.start + 1;
  ev.windup = Math.min(ev.start, Math.max(0, ev.windup));
  if (ev.winddown < ev.end) ev.winddown = ev.end;
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

// Stack overlapping events into lanes (an event's line counts as part of it).
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

function rulerRow(total, end) {
  const track = h("div", { className: "track" });
  for (let s = 0; s <= total; s += GROUP) {
    track.append(h("span", { className: "tick", style: `left:${s * PX}px` }, String(s)));
  }
  track.append(h("div", { className: "fill", style: `width:${end * PX}px` }));
  const plus = h("button", { className: "plus", type: "button", title: `Add ${EXTEND} seconds`, textContent: "+" });
  return h("div", { className: "row ruler" }, h("div", { className: "label" }, "Seconds"), track, plus);
}

function blockEl(ev, y) {
  return h("div",
    {
      className: "block" + (ev.id === selected ? " selected" : ""),
      style: `left:${ev.start * PX}px;width:${(ev.end - ev.start) * PX}px;top:${y}px;height:${BLOCK_H}px;--c:${ev.color};--fg:${textOn(ev.color)}`,
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
    style: `left:${ev.end * PX}px;width:${(ev.winddown - ev.end) * PX}px;top:${y + (BLOCK_H - 16) / 2}px;--c:${ev.color}`,
    dataset: { ev: ev.id },
  });
}

function leadEl(ev, y) {
  return h("div", {
    className: "lead",
    style: `left:${ev.windup * PX}px;width:${(ev.start - ev.windup) * PX}px;top:${y + (BLOCK_H - 16) / 2}px;--c:${ev.color}`,
    dataset: { ev: ev.id },
  });
}

function rowEl(row) {
  const name = h("input", { className: "name", value: row.name, maxLength: 60, placeholder: "Name" });
  name.addEventListener("input", () => { row.name = name.value; save(); });

  const del = h("button", { className: "icon", type: "button", title: "Remove row", textContent: "×" });
  del.addEventListener("click", () => {
    if (row.events.length && !confirm(`Remove "${row.name}" and its ${row.events.length} event(s)?`)) return;
    state.rows = state.rows.filter((r) => r !== row);
    save();
    render();
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
  const total = totalSecs();
  grid.style.setProperty("--px", PX + "px");
  grid.style.setProperty("--w", total * PX + "px");
  $("upto").textContent = `Up to: ${maxEnd()}s`;
  grid.replaceChildren(rulerRow(total, maxEnd()), ...state.rows.map(rowEl));
  syncPanel();
}

// ---------- Details panel ----------
const F = {
  title: $("f-title"), desc: $("f-desc"), start: $("f-start"),
  end: $("f-end"), len: $("f-len"), wu: $("f-wu"), wulen: $("f-wulen"), wd: $("f-wd"), wdlen: $("f-wdlen"), color: $("f-color"),
};

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

function edit(fn) {
  const found = selected && findEvent(selected);
  if (!found) return;
  if (fn(found.ev) === false) return;
  fix(found.ev);
  save();
  render();
}

// Number fields only apply values that make sense (windup <= start < end <= winddown).
// Anything else is ignored while typing, and the field snaps back when you leave it.
function editNum(el, valid, apply) {
  const v = el.value.trim() === "" ? NaN : Math.floor(Number(el.value));
  if (!Number.isFinite(v)) return;
  edit((ev) => (valid(v, ev) ? apply(v, ev) : false));
}

F.title.addEventListener("input", () => edit((ev) => { ev.title = F.title.value; }));
F.desc.addEventListener("input", () => edit((ev) => { ev.description = F.desc.value; }));
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
F.color.addEventListener("input", () => edit((ev) => { ev.color = F.color.value; }));

$("close").addEventListener("click", () => { selected = null; render(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selected) { selected = null; render(); return; }
  const typing = e.target.closest && e.target.closest("input, textarea, select");
  if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
    e.preventDefault();
    deleteEvent(selected);
  }
});

function deleteEvent(id) {
  const found = findEvent(id);
  if (!found) return;
  found.row.events = found.row.events.filter((v) => v !== found.ev);
  if (selected === id) selected = null;
  save();
  render();
}

$("delete").addEventListener("click", () => { if (selected) deleteEvent(selected); });

grid.addEventListener("click", (e) => {
  const x = e.target.closest(".x");
  if (x) deleteEvent(x.closest(".block").dataset.ev);
  if (e.target.closest(".plus")) {
    state.length = totalSecs() + EXTEND;
    save();
    render();
    scroller.scrollLeft += EXTEND * PX; // keep the + under the pointer for repeat taps
  }
});

// ---------- Dragging (mouse and touch) ----------
const posAt = (e) => (e.clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft - LABEL_W) / PX;
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
  const grip = e.target.closest(".grip");
  if (grip) {
    rowDrag = { row: state.rows.find((r) => r.id === grip.dataset.row) };
    document.activeElement?.blur?.();
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
    render();
    return;
  }
  const track = e.target.closest(".track[data-row]");
  if (!track) return;

  const sec = secAt(e);
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
  drag = { mode, row, ev, anchor: sec, offset: sec - ev.start, moved: false, x: e.clientX, y: e.clientY };
  scroller.setPointerCapture(e.pointerId);
  e.preventDefault();
  render();
});

scroller.addEventListener("pointermove", (e) => {
  if (rowDrag) { reorderRows(e); return; }
  if (!drag) return;
  const { ev, mode } = drag;
  const cur = secAt(e);
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
    ev.winddown = Math.max(ev.end, Math.round(posAt(e)));
  } else if (mode === "windup") {
    ev.windup = Math.min(ev.start, Math.max(0, Math.round(posAt(e))));
  } else if (drag.moved) {
    const len = ev.end - ev.start;
    const leadLen = ev.start - ev.windup;
    const tailLen = ev.winddown - ev.end;
    ev.start = Math.max(leadLen, cur - drag.offset); // can't slide so far left that the wind-up passes 0
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
  if (rowDrag) { rowDrag = null; save(); render(); return; }
  if (!drag) return;
  const { mode, ev, row } = drag;
  drag = null;
  if (e.type === "pointercancel" && mode === "create") {
    row.events = row.events.filter((x) => x !== ev); // browser took over to scroll
    if (selected === ev.id) selected = null;
  }
  save();
  render();
}
scroller.addEventListener("pointerup", endDrag);
scroller.addEventListener("pointercancel", endDrag);

// ---------- Buttons ----------
$("addRow").addEventListener("click", () => {
  state.rows.push(newRow(`Entity ${state.rows.length + 1}`));
  save();
  render();
});

$("download").addEventListener("click", () => {
  const data = {
    version: 5,
    length: totalSecs(),
    rows: state.rows.map(({ name, events }) => ({
      name,
      events: events.map(({ windup, start, end, winddown, title, description, color }) => ({ windup, start, end, winddown, title, description, color })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `combat-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("reset").addEventListener("click", () => {
  if (!confirm("Reset everything? This removes all events and all rows except the first, and sets the timeline back to 60 seconds. Download first if you want to keep this combat.")) return;
  const first = state.rows[0] || newRow("Player 1");
  first.events = [];
  state = { rows: [first], length: MIN_SECS };
  selected = null;
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
    state = next;
    selected = null;
    save();
    render();
  } catch (err) {
    alert("Couldn't load that file: " + err.message);
  }
});

render();

// Offline support: the service worker caches the app's files.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => { /* e.g. opened from a file:// URL */ });
  });
}