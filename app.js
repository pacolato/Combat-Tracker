const PX = 48;          // pixels per second
const GROUP = 3;        // solid line every 3 seconds
const MIN_SECS = 60;    // timeline is always at least this long
const PAD = 30;         // empty seconds kept after the last action
const LABEL_W = 150;    // width of the name column
const LANE = 44;        // height of one lane of events
const BLOCK_H = 36;     // height of an event block inside its lane
const PAD_TOP = 8;
const STRIP = 22;       // empty strip under each row's events, always free for drawing a new event
const STORE_KEY = "combat-tracker-v1";

const $ = (id) => document.getElementById(id);
const scroller = $("scroller");
const grid = $("grid");
const uid = () => Math.random().toString(36).slice(2, 9);

document.documentElement.style.setProperty("--label", LABEL_W + "px");

// ---------- State ----------
// { rows: [ { id, name, events: [ { id, start, end, title, description, completion } ] } ] }
// An event covers seconds start..end (end exclusive). Completion is extra seconds after end.

function newRow(name) { return { id: uid(), name, events: [] }; }

function clean(data) {
  if (!data || !Array.isArray(data.rows)) throw new Error("This isn't a combat tracker file.");
  return {
    rows: data.rows.map((r) => ({
      id: uid(),
      name: String(r.name ?? "").slice(0, 60),
      events: (Array.isArray(r.events) ? r.events : []).map((e) => {
        const start = Math.max(0, Math.floor(Number(e.start)) || 0);
        const end = Math.max(start + 1, Math.floor(Number(e.end)) || start + 1);
        return {
          id: uid(),
          start,
          end,
          title: String(e.title ?? e.label ?? "").slice(0, 60), // "label" = older files
          description: String(e.description ?? "").slice(0, 500),
          completion: Math.max(0, Math.floor(Number(e.completion)) || 0),
        };
      }),
    })),
  };
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

let state = load() || { rows: [newRow("Player 1"), newRow("Enemy 1")] };
let drag = null;
let selected = null; // id of the selected event

const allEvents = () => state.rows.flatMap((r) => r.events);
const maxEnd = () => Math.max(0, ...allEvents().map((e) => e.end));
const maxExtent = () => Math.max(0, ...allEvents().map((e) => e.end + e.completion));

function findEvent(id) {
  for (const row of state.rows) {
    const ev = row.events.find((e) => e.id === id);
    if (ev) return { row, ev };
  }
}

// Stack overlapping events into lanes (a completion line counts as part of its event).
function layout(row) {
  const sorted = [...row.events].sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds = [];
  const lanes = new Map();
  for (const ev of sorted) {
    let i = laneEnds.findIndex((end) => end <= ev.start);
    if (i < 0) i = laneEnds.length;
    laneEnds[i] = ev.end + ev.completion;
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
  return h("div", { className: "row ruler" }, h("div", { className: "label" }, "Seconds"), track);
}

function blockEl(ev, y) {
  return h("div",
    {
      className: "block" + (ev.id === selected ? " selected" : ""),
      style: `left:${ev.start * PX}px;width:${(ev.end - ev.start) * PX}px;top:${y}px;height:${BLOCK_H}px`,
      dataset: { ev: ev.id },
    },
    h("span", { className: "text" + (ev.title ? "" : " empty") }, ev.title || "Untitled"),
    h("small", {}, `${ev.end - ev.start}s`),
    h("div", { className: "handle" })
  );
}

function tailEl(ev, y) {
  return h("div", {
    className: "tail",
    style: `left:${ev.end * PX}px;width:${ev.completion * PX}px;top:${y + (BLOCK_H - 16) / 2}px`,
    dataset: { ev: ev.id },
  });
}

function rowEl(row, i) {
  const name = h("input", { className: "name", value: row.name, maxLength: 60, placeholder: "Name" });
  name.addEventListener("input", () => { row.name = name.value; save(); });

  const del = h("button", { className: "icon", type: "button", title: "Remove row", textContent: "×" });
  del.addEventListener("click", () => {
    if (row.events.length && !confirm(`Remove "${row.name}" and its ${row.events.length} action(s)?`)) return;
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
    if (ev.completion > 0) track.append(tailEl(ev, y));
    track.append(blockEl(ev, y));
  }

  return h("div", { className: "row", style: `--hue:${(i * 67 + 210) % 360}` },
    h("div", { className: "label" }, name, del), track);
}

function render() {
  const total = Math.ceil(Math.max(MIN_SECS, maxExtent() + PAD) / GROUP) * GROUP;
  grid.style.setProperty("--px", PX + "px");
  grid.style.setProperty("--w", total * PX + "px");
  $("upto").textContent = `Up to: ${maxEnd()}s`;
  grid.replaceChildren(rulerRow(total, maxEnd()), ...state.rows.map(rowEl));
  syncPanel();
}

// ---------- Details panel ----------
const F = { title: $("f-title"), desc: $("f-desc"), start: $("f-start"), len: $("f-len"), comp: $("f-comp") };

function syncPanel() {
  const found = selected && findEvent(selected);
  $("panel").hidden = !found;
  if (!found) { selected = null; return; }
  const { ev } = found;
  const set = (el, v) => { if (document.activeElement !== el) el.value = v; };
  set(F.title, ev.title);
  set(F.desc, ev.description);
  set(F.start, ev.start);
  set(F.len, ev.end - ev.start);
  set(F.comp, ev.completion);
  $("sum").textContent =
    `Starts at ${ev.start}s, ends at ${ev.end}s (${ev.end - ev.start}s).` +
    (ev.completion ? ` Completion time runs until ${ev.end + ev.completion}s.` : "");
}

function edit(fn) {
  const found = selected && findEvent(selected);
  if (!found) return;
  fn(found.ev);
  save();
  render();
}
const num = (el, min) => Math.max(min, Math.floor(Number(el.value)) || min);

F.title.addEventListener("input", () => edit((ev) => { ev.title = F.title.value; }));
F.desc.addEventListener("input", () => edit((ev) => { ev.description = F.desc.value; }));
F.start.addEventListener("input", () => edit((ev) => { const len = ev.end - ev.start; ev.start = num(F.start, 0); ev.end = ev.start + len; }));
F.len.addEventListener("input", () => edit((ev) => { ev.end = ev.start + num(F.len, 1); }));
F.comp.addEventListener("input", () => edit((ev) => { ev.completion = num(F.comp, 0); }));

$("close").addEventListener("click", () => { selected = null; render(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) { selected = null; render(); } });

$("delete").addEventListener("click", () => {
  const found = selected && findEvent(selected);
  if (!found) return;
  found.row.events = found.row.events.filter((v) => v !== found.ev);
  selected = null;
  save();
  render();
});

// ---------- Dragging (mouse and touch) ----------
const posAt = (e) => (e.clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft - LABEL_W) / PX;
const secAt = (e) => Math.max(0, Math.floor(posAt(e)));

scroller.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const track = e.target.closest(".track[data-row]");
  if (!track) return;

  const sec = secAt(e);
  const tail = e.target.closest(".tail");
  const node = e.target.closest(".block") || tail;
  let row = state.rows.find((r) => r.id === track.dataset.row);
  let ev, mode;

  if (node) {
    ({ row, ev } = findEvent(node.dataset.ev));
    mode = tail ? "complete" : e.target.closest(".handle") ? "resize" : "move";
  } else {
    ev = { id: uid(), start: sec, end: sec + 1, title: "", description: "", completion: 0 };
    row.events.push(ev);
    mode = "create";
  }

  selected = ev.id;
  drag = { mode, row, ev, anchor: sec, offset: sec - ev.start, moved: false, x: e.clientX, y: e.clientY };
  scroller.setPointerCapture(e.pointerId);
  e.preventDefault();
  render();
});

scroller.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const { ev, mode } = drag;
  const cur = secAt(e);
  if (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4) drag.moved = true;

  if (mode === "create") {
    ev.start = Math.min(drag.anchor, cur);
    ev.end = Math.max(drag.anchor, cur) + 1;
  } else if (mode === "resize") {
    ev.end = Math.max(ev.start + 1, cur + 1);
  } else if (mode === "complete") {
    ev.completion = Math.max(0, Math.round(posAt(e)) - ev.end);
  } else if (drag.moved) {
    const len = ev.end - ev.start;
    ev.start = Math.max(0, cur - drag.offset);
    ev.end = ev.start + len;
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
    version: 2,
    rows: state.rows.map(({ name, events }) => ({
      name,
      events: events.map(({ start, end, title, description, completion }) => ({ start, end, title, description, completion })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `combat-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
