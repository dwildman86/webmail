// The calendar: month, week, day and schedule views of your own calendars and the ones shared with you. Plain
// JavaScript like app.js (it uses app.js's h, icon, api, toast and popMenu). Times are shown in this device's time zone;
// all-day events are dates, the same everywhere.
"use strict";

const CAL = {
  view: matchMedia("(max-width: 900px)").matches ? "schedule" : "week",
  date: new Date(),                // the day in view (the week, month or schedule around it)
  calendars: [], people: [], colors: [],
  events: [], range: null,         // the loaded occurrences and the range they cover
  loading: 0,
  railOpen: false,
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DAY_MS = 86400000;
const HOUR_PX = 48;                // the height of an hour in the week and day views
const SNAP = 15;                   // minutes: where dragging snaps to
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
let $cal = null;

// ------------------------------------------------------------------------------------------------ dates

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const sameDay = (a, b) => ymd(a) === ymd(b);
/** Monday of the week a day is in. */
const weekStart = (d) => addDays(dayStart(d), -((d.getDay() + 6) % 7));
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (d, opts = { weekday: "short", day: "numeric", month: "short" }) => d.toLocaleDateString([], opts);
const localInput = (d) => `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const isToday = (d) => sameDay(d, new Date());

/** An occurrence's start and end as Dates in this time zone; all-day ones at local midnight, the end exclusive. */
function span(e) {
  if (e.all_day) return { s: fromYmd(e.start), e: fromYmd(e.end), allDay: true };
  return { s: new Date(e.start), e: new Date(e.end), allDay: false };
}
/** Shown in the all-day row: all-day events, and timed ones of 24 hours or more. */
const isBar = (e) => e.all_day || (new Date(e.end) - new Date(e.start)) >= DAY_MS;

function whenText(e) {
  const { s, e: en, allDay } = span(e);
  if (allDay) {
    const last = addDays(en, -1);
    return sameDay(s, last) ? `${fmtDay(s, { weekday: "long", day: "numeric", month: "long" })} · All day`
      : `${fmtDay(s)} – ${fmtDay(last)} · All day`;
  }
  return sameDay(s, en) || (en - s <= DAY_MS && minutesOf(en) === 0 && sameDay(s, addDays(en, -1)))
    ? `${fmtDay(s, { weekday: "long", day: "numeric", month: "long" })} · ${fmtTime(s)} – ${fmtTime(en)}`
    : `${fmtDay(s)} ${fmtTime(s)} – ${fmtDay(en)} ${fmtTime(en)}`;
}

function repeatText(r, startDate) {
  if (!r) return "";
  const n = r.interval || 1;
  const unit = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] }[r.freq];
  let t = n === 1 ? `Every ${unit[0]}` : `Every ${n} ${unit[1]}`;
  if (r.freq === "daily" && n === 1) t = "Daily";
  if (r.freq === "weekly") {
    const names = (r.days?.length ? r.days : [WEEKDAYS[(startDate.getDay() + 6) % 7]]).map((d) => dayName(d, "short"));
    t = (n === 1 ? "Weekly" : t) + " on " + (r.days?.join() === "MO,TU,WE,TH,FR" ? "weekdays" : names.join(", "));
  }
  if (r.freq === "monthly") t = (n === 1 ? "Monthly" : t) + (r.by === "weekday" ? ` on the ${nthText(startDate)} ${dayName(WEEKDAYS[(startDate.getDay() + 6) % 7], "long")}` : ` on day ${startDate.getDate()}`);
  if (r.freq === "yearly") t = (n === 1 ? "Yearly" : t) + ` on ${fmtDay(startDate, { day: "numeric", month: "long" })}`;
  if (r.until) t += `, until ${fmtDay(fromYmd(r.until), { day: "numeric", month: "short", year: "numeric" })}`;
  else if (r.count) t += `, ${r.count} times`;
  return t;
}
function dayName(code, style) {
  const d = addDays(weekStart(new Date()), WEEKDAYS.indexOf(code));
  return d.toLocaleDateString([], { weekday: style });
}
/** "first", "second"… or "last" Tuesday of its month (as the server counts it). */
function nthText(d) {
  if (d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()) return "last";
  return ["first", "second", "third", "fourth"][Math.floor((d.getDate() - 1) / 7)];
}

// ------------------------------------------------------------------------------------------------ loading

const calById = (id) => CAL.calendars.find((c) => c.id === id);
const colorOf = (e) => e.color || calById(e.calendar_id)?.color || "#2563eb";
const shownEvents = () => CAL.events.filter((e) => calById(e.calendar_id)?.shown);

async function loadCalendars() {
  const r = await api("calendar");
  CAL.calendars = r.calendars; CAL.people = r.people; CAL.colors = r.colors;
}

/** What the view covers: [from, to) as local Dates. */
function viewRange() {
  const d = CAL.date;
  if (CAL.view === "day") return [dayStart(d), addDays(dayStart(d), 1)];
  if (CAL.view === "week") { const s = weekStart(d); return [s, addDays(s, 7)]; }
  if (CAL.view === "month") { const s = weekStart(new Date(d.getFullYear(), d.getMonth(), 1)); return [s, addDays(s, 42)]; }
  return [dayStart(d), addDays(dayStart(d), 42)]; // schedule: six weeks from the day
}

async function loadEvents({ force = false } = {}) {
  const [from, to] = viewRange();
  // A little either side, so going forward and back a step is instant.
  const lo = addDays(from, -7), hi = addDays(to, 7);
  if (!force && CAL.range && CAL.range[0] <= from && CAL.range[1] >= to) return;
  const ticket = ++CAL.loading;
  const r = await api("calendar/events", { query: { from: lo.toISOString(), to: hi.toISOString() } });
  if (ticket !== CAL.loading) return; // a newer request is on its way
  CAL.events = r.events; CAL.range = [lo, hi];
}

/** Open the calendar (from the side menu, the tab bar, or a notification). */
async function showCalendar({ date, eventId, occurrence } = {}) {
  $cal = document.querySelector(".cal-pane");
  if (!$cal) return;
  // Every 30 seconds the webmail checks for changes (refresh): then, quietly, unless something is open or being dragged.
  const again = !date && !eventId && $cal.querySelector(".cal-head");
  if (again && (document.querySelector(".pop-menu, .overlay") || document.body.matches(".moving, .resizing"))) return;
  if (date) CAL.date = date;
  if (!CAL.calendars.length) $cal.replaceChildren(h("div", { class: "placeholder" }, h("div", {}, icon("calendar"), h("p", {}, "Loading…"))));
  try {
    if (!CAL.calendars.length || again) await loadCalendars();
    await loadEvents({ force: true });
  } catch (err) {
    $cal.replaceChildren(h("div", { class: "empty" }, icon("calendar"), h("p", {}, err.message), h("button", { class: "btn", onclick: () => showCalendar() }, "Try again")));
    return;
  }
  renderCalendar();
  if (eventId) {
    const e = CAL.events.find((x) => x.id === eventId && (!occurrence || x.occurrence === occurrence))
      ?? await api("calendar/event", { query: { id: eventId } }).catch(() => null);
    if (e) { CAL.date = span(e).s; await loadEvents(); renderCalendar(); openEvent(e, null); }
    else toast("That event isn't on your calendars any more.");
  }
}

async function go(fn) {
  fn();
  renderCalendar(); // straight away with what's loaded, then with the rest
  try { await loadEvents(); renderCalendar(); } catch (err) { toast(err.message); }
}
const step = (dir) => go(() => {
  const d = CAL.date;
  if (CAL.view === "day") CAL.date = addDays(d, dir);
  else if (CAL.view === "week") CAL.date = addDays(d, 7 * dir);
  else if (CAL.view === "month") CAL.date = new Date(d.getFullYear(), d.getMonth() + dir, 1);
  else CAL.date = addDays(d, 14 * dir);
});
const setView = (v) => go(() => { CAL.view = v; });
const today = () => go(() => { CAL.date = new Date(); });

async function reloadAll() {
  try { await loadCalendars(); await loadEvents({ force: true }); } catch (err) { toast(err.message); }
  renderCalendar();
}

// ------------------------------------------------------------------------------------------------ the page

function title() {
  const d = CAL.date;
  if (CAL.view === "day") return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (CAL.view === "month") return d.toLocaleDateString([], { month: "long", year: "numeric" });
  const [s, e] = CAL.view === "week" ? viewRange() : [dayStart(d), addDays(dayStart(d), 42)];
  const last = addDays(e, -1);
  if (s.getMonth() === last.getMonth()) return `${s.getDate()} – ${last.getDate()} ${s.toLocaleDateString([], { month: "long", year: "numeric" })}`;
  return `${fmtDay(s, { day: "numeric", month: "short" })} – ${fmtDay(last, { day: "numeric", month: "short", year: "numeric" })}`;
}

function renderCalendar() {
  if (!$cal || state.folder !== "calendar") return;
  const views = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["schedule", "Schedule"]];
  const scroller = $cal.querySelector(`.view-${CAL.view} .tv .cal-grid-scroll`);
  const keepScroll = scroller ? scroller.scrollTop : null;
  const head = h("div", { class: "cal-head" },
    h("button", { class: "icon-btn menu-btn", "aria-label": "Menu", onclick: () => $shell.classList.toggle("menu") }, icon("menu")),
    h("button", { class: "btn btn-sm", onclick: today, title: "Today (T)" }, "Today"),
    h("div", { class: "cal-nav" },
      h("button", { class: "icon-btn", "aria-label": "Previous", title: "Previous (←)", onclick: () => step(-1) }, icon("back")),
      h("button", { class: "icon-btn flip", "aria-label": "Next", title: "Next (→)", onclick: () => step(1) }, icon("back"))),
    h("h2", { class: "cal-title", "aria-live": "polite" }, title()),
    h("div", { class: "seg", role: "tablist", "aria-label": "View" }, views.map(([k, label]) => h("button", { role: "tab", "aria-selected": String(CAL.view === k), class: CAL.view === k ? "on" : "",
      title: `${label} (${label[0]})`, onclick: () => setView(k) }, label))),
    h("button", { class: "btn btn-sm view-menu", "aria-label": "View", onclick: (e) => popMenu(e.currentTarget, views.map(([k, label]) => ({ label, icon: CAL.view === k ? "check" : null, run: () => setView(k) }))) },
      views.find(([k]) => k === CAL.view)[1], icon("down")),
    h("button", { class: "icon-btn rail-btn", "aria-label": "Calendars", title: "Calendars", onclick: () => { CAL.railOpen = !CAL.railOpen; renderCalendar(); } }, icon("layers")),
    h("button", { class: "btn btn-primary btn-sm new-event", onclick: () => newEvent() }, icon("compose"), h("span", {}, "New event")));
  const main = CAL.view === "month" ? monthView() : CAL.view === "schedule" ? scheduleView() : timeView(CAL.view === "day" ? 1 : 7);
  $cal.replaceChildren(head, h("div", { class: `cal-body${CAL.railOpen ? " rail-open" : ""}` }, rail(), h("div", { class: `cal-main view-${CAL.view}` }, main)));
  renderTabbar(); // on phones, the middle button makes an event here
  const grid = $cal.querySelector(".cal-grid-scroll");
  if (grid && CAL.view !== "schedule") {
    // Where it was; else a little before now (today in view), or 7:00.
    const [from, to] = viewRange();
    const now = new Date();
    grid.scrollTop = keepScroll ?? (now >= from && now < to ? Math.max(0, (minutesOf(now) / 60 - 1.5) * HOUR_PX) : 7 * HOUR_PX);
  }
  swipeToStep($cal.querySelector(".cal-main"));
}

/** Phones: swipe sideways for the next or previous day, week or month. */
function swipeToStep(el) {
  if (!el) return;
  let x0 = null, y0 = 0;
  el.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ------------------------------------------------------------------------------------------------ the side rail

function rail() {
  const mine = CAL.calendars.filter((c) => c.kind === "personal");
  const shared = CAL.calendars.filter((c) => c.kind === "shared");
  const item = (c) => h("li", { class: "cal-item" },
    h("label", { class: "cal-check", style: `--c:${c.color}` },
      h("input", { type: "checkbox", checked: c.shown, onchange: async (e) => {
        c.shown = e.target.checked; renderCalendar();
        try { await api("calendar/show", { method: "POST", body: { id: c.id, shown: c.shown } }); } catch (err) { toast(err.message); }
      } }), h("span", { class: "box", "aria-hidden": "true" }), h("span", { class: "name" }, c.name),
      c.kind === "shared" && h("small", { class: "muted" }, c.role === "view" ? "can view" : `${c.members?.length || 1}`)),
    h("button", { class: "icon-btn small-btn", "aria-label": `${c.name}: options`, onclick: (e) => calendarMenu(e.currentTarget, c) }, icon("more")));
  return h("aside", { class: "cal-rail" },
    miniMonth(),
    h("div", { class: "cal-group" }, h("div", { class: "cal-group-head" }, h("span", {}, "My calendars"),
      h("button", { class: "icon-btn small-btn", title: "New calendar", "aria-label": "New calendar", onclick: () => editCalendar({ kind: "personal" }) }, icon("compose"))),
    h("ul", {}, mine.map(item))),
    h("div", { class: "cal-group" }, h("div", { class: "cal-group-head" }, h("span", {}, "Shared calendars"),
      h("button", { class: "icon-btn small-btn", title: "New shared calendar", "aria-label": "New shared calendar", onclick: () => editCalendar({ kind: "shared" }) }, icon("compose"))),
    shared.length ? h("ul", {}, shared.map(item))
      : h("p", { class: "muted small cal-hint" }, "Share a calendar with your team: holidays, rotas, meeting rooms.",
        h("button", { class: "linkish", onclick: () => editCalendar({ kind: "shared" }) }, "Make one"))));
}

function miniMonth() {
  const shown = CAL.miniMonth ?? new Date(CAL.date.getFullYear(), CAL.date.getMonth(), 1);
  const start = weekStart(shown);
  const [from, to] = viewRange();
  const busy = new Set(shownEvents().flatMap((e) => { const { s } = span(e); return [ymd(s)]; }));
  const move = (n) => { CAL.miniMonth = new Date(shown.getFullYear(), shown.getMonth() + n, 1); renderCalendar(); };
  return h("div", { class: "mini" },
    h("div", { class: "mini-head" }, h("strong", {}, shown.toLocaleDateString([], { month: "long", year: "numeric" })),
      h("button", { class: "icon-btn small-btn", "aria-label": "Previous month", onclick: () => move(-1) }, icon("back")),
      h("button", { class: "icon-btn small-btn flip", "aria-label": "Next month", onclick: () => move(1) }, icon("back"))),
    h("div", { class: "mini-grid", role: "grid" },
      WEEKDAYS.map((d) => h("span", { class: "mini-dow" }, dayName(d, "narrow"))),
      Array.from({ length: 42 }, (_, i) => {
        const d = addDays(start, i);
        const inView = d >= from && d < to && CAL.view !== "month" && CAL.view !== "schedule";
        return h("button", { class: ["mini-day", d.getMonth() !== shown.getMonth() && "other", isToday(d) && "today", sameDay(d, CAL.date) && "sel", inView && "in-view", busy.has(ymd(d)) && "busy"].filter(Boolean).join(" "),
          "aria-label": fmtDay(d, { weekday: "long", day: "numeric", month: "long" }), onclick: () => { CAL.miniMonth = null; CAL.railOpen = false; go(() => { CAL.date = d; if (CAL.view === "month" || CAL.view === "schedule") CAL.view = matchMedia("(max-width: 900px)").matches ? "day" : CAL.view === "month" ? "week" : "day"; }); } },
        String(d.getDate()));
      })));
}

function calendarMenu(anchor, c) {
  const items = [];
  if (c.can_manage) items.push({ label: c.kind === "shared" ? "Edit and share" : "Edit", icon: "settings", run: () => editCalendar(c) });
  else if (c.kind === "shared") items.push({ label: "People", icon: "people", run: () => showMembers(c) });
  items.push({ label: "Show only this", icon: "eye", run: async () => {
    for (const x of CAL.calendars) {
      const want = x.id === c.id;
      if (x.shown !== want) { x.shown = want; api("calendar/show", { method: "POST", body: { id: x.id, shown: want } }).catch(() => {}); }
    }
    renderCalendar();
  } });
  items.push({ label: "On your phone or computer", icon: "phone", run: () => feedDialog(c) });
  if (c.can_edit) items.push({ label: "Import .ics file", icon: "upload", run: () => importFile(c) });
  items.push({ label: "Download .ics", icon: "download", run: () => { location.href = `api.php?a=calendar/export&id=${c.id}`; } });
  if (c.role !== "owner") items.push(null, { label: "Leave this calendar", icon: "logout", class: "danger", run: async () => {
    if (!confirm(`Leave ${c.name}? You won't see it any more.`)) return;
    try { await api("calendar/leave", { method: "POST", body: { id: c.id } }); toast(`You've left ${c.name}.`); reloadAll(); } catch (err) { toast(err.message); }
  } });
  else if (c.can_manage) items.push(null, { label: "Delete calendar", icon: "trash", class: "danger", run: async () => {
    if (!confirm(`Delete ${c.name} and all its events${c.kind === "shared" ? ", for everyone on it" : ""}? This can't be undone.`)) return;
    try { await api("calendar/delete", { method: "POST", body: { id: c.id } }); toast(`${c.name} is deleted.`); reloadAll(); } catch (err) { toast(err.message); }
  } });
  popMenu(anchor, items);
}

// ------------------------------------------------------------------------------------------------ week and day

/** The occurrences that touch a day, as parts of it: [{ e, s, en (Dates clipped to the day) }]. Bars left out. */
function dayParts(day) {
  const lo = dayStart(day), hi = addDays(lo, 1);
  return shownEvents().filter((e) => !isBar(e)).map((e) => {
    const { s, e: en } = span(e);
    return { e, s: s < lo ? lo : s, en: en > hi ? hi : en, cutTop: s < lo, cutBottom: en > hi };
  }).filter((p) => p.en > lo && p.s < hi && (p.en > p.s || +p.s === +lo));
}

/** Side by side where they overlap: each part gets col and cols. */
function layoutDay(parts) {
  parts.sort((a, b) => a.s - b.s || b.en - a.en);
  let cluster = [], end = 0;
  const flush = () => {
    const cols = [];
    for (const p of cluster) {
      let i = cols.findIndex((last) => last <= +p.s);
      if (i === -1) { i = cols.length; cols.push(0); }
      cols[i] = Math.max(+p.en, +p.s + 20 * 60000); // at least 20 minutes tall
      p.col = i;
    }
    for (const p of cluster) p.cols = cols.length;
  };
  for (const p of parts) {
    if (cluster.length && +p.s >= end) { flush(); cluster = []; end = 0; }
    cluster.push(p); end = Math.max(end, +p.en, +p.s + 20 * 60000);
  }
  if (cluster.length) flush();
  return parts;
}

/** Bars (all-day and long events) for a row of days, in lanes: [{ e, from, to (day indexes), lane }]. */
function barLanes(days, events) {
  const first = dayStart(days[0]), n = days.length;
  const items = events.map((e) => {
    const { s, e: en, allDay } = span(e);
    const lastDay = allDay ? addDays(en, -1) : (minutesOf(en) === 0 && en > s ? addDays(en, -1) : en);
    const from = Math.round((dayStart(s) - first) / DAY_MS), to = Math.round((dayStart(lastDay) - first) / DAY_MS);
    return { e, from: Math.max(0, from), to: Math.min(n - 1, to), cutL: from < 0, cutR: to > n - 1 };
  }).filter((x) => x.to >= 0 && x.from <= n - 1 && x.to >= x.from);
  items.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || (isBar(a.e) ? 0 : 1) - (isBar(b.e) ? 0 : 1) || span(a.e).s - span(b.e).s);
  const lanes = [];
  for (const it of items) {
    let lane = lanes.findIndex((busy) => busy.every((v, i) => i < it.from || i > it.to || !v));
    if (lane === -1) { lane = lanes.length; lanes.push(Array(n).fill(false)); }
    for (let i = it.from; i <= it.to; i++) lanes[lane][i] = true;
    it.lane = lane;
  }
  return items;
}

function timeView(n) {
  const first = n === 1 ? dayStart(CAL.date) : weekStart(CAL.date);
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  const bars = barLanes(days, shownEvents().filter(isBar));
  const laneCount = Math.max(0, ...bars.map((b) => b.lane + 1));
  const headRow = h("div", { class: "tv-head", style: `--days:${n}` },
    h("div", { class: "tv-gutter tz" }, h("small", { class: "muted" }, new Date().toLocaleTimeString([], { timeZoneName: "short" }).split(" ").pop())),
    days.map((d) => h("button", { class: `tv-day${isToday(d) ? " today" : ""}`, onclick: () => { if (n > 1) go(() => { CAL.view = "day"; CAL.date = d; }); } },
      h("span", { class: "dow" }, d.toLocaleDateString([], { weekday: "short" })), h("span", { class: "dnum" }, String(d.getDate())))));
  const allDay = h("div", { class: "tv-allday", style: `--days:${n};--lanes:${Math.max(1, laneCount)}` },
    h("div", { class: "tv-gutter" }, h("small", { class: "muted" }, "all-day")),
    h("div", { class: "tv-bars", ondblclick: (ev) => {
      const col = Math.floor((ev.offsetX / ev.currentTarget.clientWidth) * n);
      if (ev.target === ev.currentTarget) newEvent({ allDay: true, start: days[col] });
    } }, bars.map((b) => eventChip(b.e, { bar: true, style: `grid-column:${b.from + 1} / ${b.to + 2};grid-row:${b.lane + 1}`, cutL: b.cutL, cutR: b.cutR }))));
  const hours = h("div", { class: "tv-hours" }, Array.from({ length: 24 }, (_, i) => h("div", { class: "tv-hour" }, i ? h("span", {}, fmtTime(new Date(2000, 0, 1, i))) : null)));
  const cols = days.map((d) => {
    const col = h("div", { class: `tv-col${isToday(d) ? " today" : ""}`, dataset: { day: ymd(d) } });
    for (const p of layoutDay(dayParts(d))) {
      const top = minutesOf(p.s) / 60 * HOUR_PX;
      const height = Math.max(18, ((p.en - p.s) / 3600000) * HOUR_PX - 2);
      const el = eventChip(p.e, { block: true, short: height < 42,
        style: `top:${top}px;height:${height}px;left:calc(${(p.col / p.cols) * 100}% + 1px);width:calc(${100 / p.cols}% - ${p.cols > 1 ? 3 : 6}px)` });
      if (p.cutTop) el.classList.add("cut-top");
      if (p.cutBottom) el.classList.add("cut-bottom");
      col.append(el);
    }
    if (isToday(d)) col.append(h("div", { class: "now-line", style: `top:${minutesOf(new Date()) / 60 * HOUR_PX}px` }));
    dragCreate(col, d);
    return col;
  });
  const grid = h("div", { class: "tv-grid", style: `--days:${n};height:${24 * HOUR_PX}px` }, hours, ...cols);
  return h("div", { class: "tv" }, headRow, allDay, h("div", { class: "cal-grid-scroll" }, grid));
}

/** An event in a view: a block (week/day), a bar (all-day row, month) or a line (month). Opens on click; drags to move. */
function eventChip(e, { block = false, bar = false, short = false, style = "", cutL = false, cutR = false } = {}) {
  const { s, e: en } = span(e);
  const color = colorOf(e);
  const timed = !e.all_day;
  const label = [e.title, timed ? fmtTime(s) : "", e.location].filter(Boolean).join(", ");
  const el = h("button", { type: "button", class: ["ev", block && "ev-block", bar && "ev-bar", !block && !bar && "ev-line", short && "short", cutL && "cut-l", cutR && "cut-r",
    !e.can_edit && "ro", e.repeat && "rep"].filter(Boolean).join(" "), style: `--c:${color};${style}`, "aria-label": label, title: `${e.title}\n${whenText(e)}${e.location ? `\n${e.location}` : ""}` },
  block ? [h("span", { class: "ev-title" }, e.title, short && timed ? h("span", { class: "ev-time" }, ` ${fmtTime(s)}`) : null),
    !short && h("span", { class: "ev-time" }, `${fmtTime(s)} – ${fmtTime(en)}`), !short && e.location && h("span", { class: "ev-loc" }, e.location)]
    : bar || !timed ? [h("span", { class: "ev-title" }, e.title)]
      : [h("span", { class: "dot" }), h("span", { class: "ev-time" }, fmtTime(s)), h("span", { class: "ev-title" }, e.title)]);
  el.addEventListener("click", (ev) => { if (el.dataset.dragged) { delete el.dataset.dragged; return; } ev.stopPropagation(); openEvent(e, el); });
  if (e.can_edit) dragMove(el, e, block ? "time" : "day");
  return el;
}

// ------------------------------------------------------------------------------------------------ dragging

const snapMinutes = (y) => Math.max(0, Math.min(24 * 60, Math.round((y / HOUR_PX * 60) / SNAP) * SNAP));
const isTouch = (ev) => ev.pointerType === "touch";

/** Drag down an empty part of a day to make an event that long; a click makes an hour. (Touch: a tap.) */
function dragCreate(col, day) {
  col.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target !== col) return;
    const rect = col.getBoundingClientRect();
    const startMin = Math.min(snapMinutes(ev.clientY - rect.top - SNAP / 60 * HOUR_PX / 2), 24 * 60 - SNAP);
    if (isTouch(ev)) {
      // Touch scrolls: only a tap (no movement) makes an event.
      const y0 = ev.clientY, x0 = ev.clientX;
      col.addEventListener("pointerup", (up) => {
        if (Math.abs(up.clientY - y0) < 8 && Math.abs(up.clientX - x0) < 8) {
          const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.floor(startMin / 60) * 60);
          newEvent({ start: s, end: new Date(+s + 3600000) });
        }
      }, { once: true });
      return;
    }
    ev.preventDefault();
    let endMin = startMin + 60;
    let moved = false;
    const ghost = h("div", { class: "ev ev-block ghost", style: "--c:var(--accent)" }, h("span", { class: "ev-time" }));
    const draw = () => {
      const a = Math.min(startMin, endMin), b = Math.max(startMin, endMin);
      ghost.style.top = `${a / 60 * HOUR_PX}px`; ghost.style.height = `${Math.max(SNAP, b - a) / 60 * HOUR_PX - 2}px`; ghost.style.left = "1px"; ghost.style.width = "calc(100% - 6px)";
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, a), en = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.max(a + SNAP, b));
      ghost.firstChild.textContent = `${fmtTime(s)} – ${fmtTime(en)}`;
      return [s, en];
    };
    col.append(ghost); draw();
    col.setPointerCapture(ev.pointerId);
    const move = (m) => {
      const y = m.clientY - rect.top;
      const at = snapMinutes(y);
      if (Math.abs(m.clientY - ev.clientY) > 4) moved = true;
      if (moved) { endMin = at === startMin ? startMin + SNAP : at; draw(); }
    };
    const up = () => {
      col.removeEventListener("pointermove", move); col.removeEventListener("pointerup", up); col.removeEventListener("pointercancel", up);
      const [s, en] = draw();
      quickCreate(ghost, { start: s, end: en }, () => ghost.remove());
    };
    col.addEventListener("pointermove", move); col.addEventListener("pointerup", up); col.addEventListener("pointercancel", up);
  });
}

/**
 * Drag an event to move it: to another time or day (week and day views, kind "time"; the bottom edge changes when it
 * ends), or another day (month and all-day, kind "day"). A repeating event asks: just this one, or all of them?
 */
function dragMove(el, e, kind) {
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || isTouch(ev)) return;
    const { s: s0, e: en0 } = span(e);
    const rect = el.getBoundingClientRect();
    const resize = kind === "time" && ev.clientY > rect.bottom - 8 && !el.classList.contains("cut-bottom");
    let dMin = 0, dDays = 0, started = false;
    const x0 = ev.clientX, y0 = ev.clientY;
    const col0 = el.closest("[data-day]");
    el.setPointerCapture(ev.pointerId);
    const move = (m) => {
      if (!started && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      if (!started) { started = true; el.classList.add("dragging"); document.body.classList.add(resize ? "resizing" : "moving"); }
      if (kind === "time") {
        dMin = Math.round(((m.clientY - y0) / HOUR_PX * 60) / SNAP) * SNAP;
        const over = document.elementsFromPoint(m.clientX, m.clientY).find((x) => x.dataset?.day && x.classList.contains("tv-col"));
        dDays = !resize && over && col0 ? Math.round((fromYmd(over.dataset.day) - fromYmd(col0.dataset.day)) / DAY_MS) : 0;
        if (resize) {
          el.style.height = `${Math.max(SNAP / 60 * HOUR_PX, (en0 - s0) / 3600000 * HOUR_PX + dMin / 60 * HOUR_PX) - 2}px`;
        } else {
          el.style.transform = `translate(${dDays && col0 ? dDays * col0.getBoundingClientRect().width : 0}px, ${dMin / 60 * HOUR_PX}px)`;
        }
        const ns = resize ? s0 : new Date(+addDays(s0, dDays) + dMin * 60000);
        const ne = resize ? new Date(Math.max(+s0 + SNAP * 60000, +en0 + dMin * 60000)) : new Date(+addDays(en0, dDays) + dMin * 60000);
        el.querySelector(".ev-time")?.replaceChildren(`${fmtTime(ns)} – ${fmtTime(ne)}`);
      } else {
        const over = document.elementsFromPoint(m.clientX, m.clientY).find((x) => x.dataset?.day);
        document.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
        if (over) { over.classList.add("drop"); dDays = Math.round((fromYmd(over.dataset.day) - dayStart(s0)) / DAY_MS) - (el.dataset.offset ? Number(el.dataset.offset) : 0); }
      }
    };
    const up = async () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing", "moving");
      document.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      if (!started) return;
      el.dataset.dragged = "1";
      if (!dMin && !dDays) { renderCalendar(); return; }
      let ns, ne;
      if (e.all_day) { ns = ymd(addDays(fromYmd(e.start), dDays)); ne = ymd(addDays(fromYmd(e.end), dDays)); }
      else if (resize) { ns = s0.toISOString(); ne = new Date(Math.max(+s0 + SNAP * 60000, +en0 + dMin * 60000)).toISOString(); }
      else { ns = new Date(+addDays(s0, dDays) + dMin * 60000).toISOString(); ne = new Date(+addDays(en0, dDays) + dMin * 60000).toISOString(); }
      await saveTimes(e, ns, ne);
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  });
}

/** Save an event at new times (from a drag): for a repeating one, just this one or all of them. */
async function saveTimes(e, start, end) {
  let scope = "all";
  if (e.repeat) {
    scope = await askScope("Move a repeating event");
    if (!scope) { renderCalendar(); return; }
  }
  try {
    const body = await bodyFor(e, { start, end }, scope);
    await api("calendar/event/save", { method: "POST", body });
    await loadEvents({ force: true });
    toast(scope === "all" && e.repeat ? "All of them are moved." : "Moved.");
  } catch (err) { toast(err.message); }
  renderCalendar();
}

/**
 * What to send to save an occurrence with some fields changed. For "all" of a repeating event, the change in its
 * time is applied to the series (whose first start may be long ago), so every occurrence moves the same.
 */
async function bodyFor(e, changes, scope) {
  const body = { id: e.id, calendar_id: e.calendar_id, title: e.title, location: e.location, notes: e.notes, all_day: e.all_day, start: e.start, end: e.end,
    tz: e.tz || TZ, repeat: e.repeat, reminders: e.reminders, color: e.color, ...changes, scope, occurrence: e.occurrence };
  if (e.repeat && scope === "all") {
    const first = await api("calendar/event", { query: { id: e.id } });
    if (body.all_day && e.all_day) {
      const shift = Math.round((fromYmd(body.start) - fromYmd(e.start)) / DAY_MS);
      const len = Math.round((fromYmd(body.end) - fromYmd(body.start)) / DAY_MS);
      body.start = ymd(addDays(fromYmd(first.start), shift)); body.end = ymd(addDays(fromYmd(body.start), len));
    } else if (!body.all_day && !e.all_day) {
      const shift = new Date(body.start) - new Date(e.start), len = new Date(body.end) - new Date(body.start);
      body.start = new Date(+new Date(first.start) + shift).toISOString(); body.end = new Date(+new Date(body.start) + len).toISOString();
    }
  }
  return body;
}

/** For a repeating event: "this", "following" or "all" (null: cancelled). */
function askScope(heading, { following = true } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    const done = (v) => { picked = v; overlay.remove(); resolve(v); };
    const opt = (v, label) => h("button", { class: "btn scope-opt", onclick: () => done(v) }, label);
    const overlay = h("div", { class: "overlay center", onclick: (e) => { if (e.target === overlay) done(null); } },
      h("div", { class: "dialog small-dialog", role: "dialog", "aria-label": heading },
        h("div", { class: "dialog-head" }, h("h2", {}, heading)),
        h("div", { class: "pad stack" }, opt("this", "This event"), following && opt("following", "This and following events"), opt("all", "All events"),
          h("button", { class: "btn btn-ghost", onclick: () => done(null) }, "Cancel"))));
    document.body.append(overlay);
    overlay.querySelector(".scope-opt").focus();
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape" && picked === null) done(null); });
  });
}

// ------------------------------------------------------------------------------------------------ month

function monthView() {
  const first = weekStart(new Date(CAL.date.getFullYear(), CAL.date.getMonth(), 1));
  const month = CAL.date.getMonth();
  const weeks = [];
  const maxLanes = matchMedia("(max-width: 900px)").matches ? 2 : 3;
  for (let w = 0; w < 6; w++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i));
    if (w >= 4 && days[0].getMonth() !== month) break; // five weeks are enough this month
    const items = barLanes(days, shownEvents());
    const hidden = Array(7).fill(0);
    const row = h("div", { class: "m-week" },
      days.map((d, i) => h("div", { class: ["m-day", d.getMonth() !== month && "other", isToday(d) && "today"].filter(Boolean).join(" "), dataset: { day: ymd(d) },
        onclick: (ev) => { if (ev.target === ev.currentTarget || ev.target.classList.contains("m-num")) { if (ev.target.classList.contains("m-num")) go(() => { CAL.view = "day"; CAL.date = d; }); else newEvent({ start: d, allDay: false, fromDay: true }); } } },
      h("button", { class: "m-num", "aria-label": fmtDay(d, { weekday: "long", day: "numeric", month: "long" }) }, d.getDate() === 1 ? d.toLocaleDateString([], { day: "numeric", month: "short" }) : String(d.getDate())))),
      items.map((it) => {
        if (it.lane >= maxLanes) { for (let i = it.from; i <= it.to; i++) hidden[i]++; return null; }
        const chip = eventChip(it.e, { bar: isBar(it.e), style: `--from:${it.from};--to:${it.to};--lane:${it.lane}`, cutL: it.cutL, cutR: it.cutR });
        chip.classList.add("m-item");
        chip.dataset.offset = String(Math.round((days[it.from] - dayStart(span(it.e).s)) / DAY_MS));
        return chip;
      }),
      hidden.map((n, i) => n > 0 && h("button", { class: "m-more", style: `--from:${i};--lane:${maxLanes}`, onclick: (ev) => dayPopover(ev.currentTarget, days[i]) }, `${n} more`)));
    weeks.push(row);
  }
  return h("div", { class: "month", style: `--lanes:${maxLanes}` },
    h("div", { class: "m-dows" }, WEEKDAYS.map((d) => h("div", {}, dayName(d, "short")))),
    h("div", { class: "m-weeks", style: `--weeks:${weeks.length}` }, weeks));
}

function dayPopover(anchor, d) {
  const items = shownEvents().filter((e) => { const { s, e: en } = span(e); return s < addDays(d, 1) && (en > d || (+en === +s && sameDay(s, d))); });
  popMenu(anchor, [h("div", { class: "pop-title" }, fmtDay(d, { weekday: "long", day: "numeric", month: "long" })),
    ...items.map((e) => { const c = eventChip(e, {}); c.classList.add("pop-ev"); return c; })], { className: "day-pop" });
}

// ------------------------------------------------------------------------------------------------ schedule

function scheduleView() {
  const from = dayStart(CAL.date), to = addDays(from, 42);
  const byDay = new Map();
  for (const e of shownEvents()) {
    const { s, e: en } = span(e);
    // Multi-day events show on each of their days.
    for (let d = dayStart(s < from ? from : s); d < to && (d < en || (+d === +dayStart(s))); d = addDays(d, 1)) {
      if (!byDay.has(ymd(d))) byDay.set(ymd(d), []);
      byDay.get(ymd(d)).push(e);
      if (+en === +s) break;
    }
  }
  const keys = [...byDay.keys()].sort();
  if (!keys.length) {
    return h("div", { class: "empty" }, icon("calendar"), h("p", {}, "Nothing in the next six weeks."), h("button", { class: "btn", onclick: () => newEvent() }, "Add an event"));
  }
  return h("div", { class: "schedule cal-grid-scroll" }, keys.map((k) => {
    const d = fromYmd(k);
    const list = byDay.get(k).sort((a, b) => (b.all_day - a.all_day) || span(a).s - span(b).s);
    return h("section", { class: `sch-day${isToday(d) ? " today" : ""}` },
      h("div", { class: "sch-date" }, h("span", { class: "dnum" }, String(d.getDate())), h("span", { class: "dow" }, d.toLocaleDateString([], { weekday: "short" })),
        h("span", { class: "mon muted" }, d.toLocaleDateString([], { month: "short" }))),
      h("div", { class: "sch-list" }, list.map((e) => {
        const { s, e: en } = span(e);
        const timeText = e.all_day || isBar(e) && !(sameDay(s, d)) ? "All day" : `${fmtTime(s)} – ${fmtTime(en)}`;
        const row = h("button", { class: "sch-ev", style: `--c:${colorOf(e)}`, onclick: () => openEvent(e, row) },
          h("span", { class: "dot" }), h("span", { class: "sch-time" }, timeText),
          h("span", { class: "sch-what" }, h("strong", {}, e.title), e.location && h("small", { class: "muted" }, e.location)),
          e.repeat && h("span", { class: "rep-icon", title: repeatText(e.repeat, s) }, icon("refresh")));
        return row;
      })));
  }));
}

// ------------------------------------------------------------------------------------------------ an event

function openEvent(e, anchor) {
  const cal = calById(e.calendar_id);
  const { s } = span(e);
  const remind = (m) => reminderLabel(m, e.all_day);
  const body = h("div", { class: "ev-card", style: `--c:${colorOf(e)}` },
    h("div", { class: "ev-card-head" }, h("span", { class: "swatch" }), h("h3", {}, e.title)),
    h("p", { class: "ev-when" }, whenText(e)),
    e.repeat && h("p", { class: "muted small" }, icon("refresh"), repeatText(e.repeat, s)),
    e.location && h("p", {}, icon("pin"), /^https?:\/\//.test(e.location) ? h("a", { href: e.location, target: "_blank", rel: "noopener noreferrer" }, e.location) : e.location),
    e.reminders?.length > 0 && h("p", { class: "muted small" }, icon("bell"), e.reminders.map(remind).join(", ")),
    e.notes && h("div", { class: "ev-notes" }, e.notes),
    h("p", { class: "muted small" }, h("span", { class: "swatch sm", style: `--c:${cal?.color}` }), cal?.name ?? "",
      cal?.kind === "shared" && e.created_by ? ` · added by ${e.created_by}` : "", e.updated_by && e.updated_by !== e.created_by ? ` · changed by ${e.updated_by}` : ""),
    h("div", { class: "row ev-actions" },
      e.can_edit && h("button", { class: "btn btn-sm btn-primary", onclick: () => { menu?.close(); overlay?.remove(); editEvent(e); } }, icon("drafts"), "Edit"),
      e.can_edit && h("button", { class: "btn btn-sm", onclick: () => { menu?.close(); overlay?.remove(); duplicate(e); } }, "Duplicate"),
      e.can_edit && h("button", { class: "btn btn-sm btn-danger", onclick: async () => { menu?.close(); overlay?.remove(); deleteEvent(e); } }, icon("trash"), "Delete"),
      !e.can_edit && h("span", { class: "muted small" }, "You can see this calendar, but not change it.")));
  let menu = null, overlay = null;
  if (anchor && !matchMedia("(max-width: 900px)").matches) {
    menu = popMenu(anchor, [body], { className: "ev-pop" });
  } else {
    overlay = h("div", { class: "overlay center sheet", onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } },
      h("div", { class: "dialog small-dialog", role: "dialog", "aria-label": e.title },
        h("div", { class: "dialog-head" }, h("h2", {}, ""), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))), h("div", { class: "pad" }, body)));
    document.body.append(overlay);
  }
}

async function deleteEvent(e) {
  let scope = "all";
  if (e.repeat) { scope = await askScope("Delete a repeating event"); if (!scope) return; }
  else if (!confirm(`Delete “${e.title}”?`)) return;
  try {
    await api("calendar/event/delete", { method: "POST", body: { id: e.id, scope, occurrence: e.occurrence } });
    await loadEvents({ force: true }); renderCalendar(); toast("Deleted.");
  } catch (err) { toast(err.message); }
}

function duplicate(e) {
  const { s, e: en } = span(e);
  editEvent({ ...e, id: null, title: e.title, repeat: null }, { start: s, end: en });
}

const REMINDERS_TIMED = [[0, "At the time"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"],
  [120, "2 hours before"], [1440, "1 day before"], [2880, "2 days before"], [10080, "1 week before"]];
const REMINDERS_DAY = [[0, "On the day at 9:00"], [1440, "The day before at 9:00"], [2880, "2 days before at 9:00"], [10080, "1 week before at 9:00"]];
function reminderLabel(m, allDay) {
  const hit = (allDay ? REMINDERS_DAY : REMINDERS_TIMED).find(([v]) => v === m);
  if (hit) return hit[1];
  return m % 1440 === 0 ? `${m / 1440} days before` : m % 60 === 0 ? `${m / 60} hours before` : `${m} minutes before`;
}

const editableCalendars = () => CAL.calendars.filter((c) => c.can_edit);
const defaultCalendar = () => (editableCalendars().find((c) => c.shown && c.kind === "personal" && c.role === "owner") ?? editableCalendars()[0]);

/** A new event: at a time (from the grid), on a day, or the next hour. */
function newEvent({ start, end, allDay = false, fromDay = false } = {}) {
  let s = start ? new Date(start) : null;
  if (!s || fromDay) {
    const now = new Date();
    const base = s ?? (CAL.view === "month" || sameDay(CAL.date, now) ? now : CAL.date);
    s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sameDay(base, now) ? now.getHours() + 1 : 9, 0);
  }
  if (allDay) s = dayStart(s);
  const en = end ? new Date(end) : allDay ? addDays(s, 1) : new Date(+s + 3600000);
  editEvent({ id: null, calendar_id: defaultCalendar()?.id, title: "", location: "", notes: "", all_day: allDay, repeat: null, reminders: allDay ? [] : [10], color: null }, { start: s, end: en });
}

/** A short form where an event was just dragged out: its title, then save, or more options. */
function quickCreate(anchor, { start, end }, onClose) {
  const cal = defaultCalendar();
  if (!cal) { onClose(); toast("You can't add to any of your calendars."); return; }
  const titleIn = h("input", { class: "input", placeholder: "Add a title", "aria-label": "Title", maxlength: 200 });
  const calSel = h("select", { class: "input", "aria-label": "Calendar" }, editableCalendars().map((c) => h("option", { value: String(c.id), selected: c.id === cal.id }, c.name)));
  let saving = false;
  const save = async () => {
    if (saving) return;
    saving = true;
    try {
      await api("calendar/event/save", { method: "POST", body: { calendar_id: Number(calSel.value), title: titleIn.value || "(no title)", all_day: false, start: start.toISOString(), end: end.toISOString(), tz: TZ, reminders: [10] } });
      menu.close(); onClose(); await loadEvents({ force: true }); renderCalendar();
    } catch (err) { toast(err.message); saving = false; }
  };
  const form = h("form", { class: "quick", onsubmit: (e) => { e.preventDefault(); save(); } },
    h("div", { class: "muted small" }, `${fmtDay(start, { weekday: "long", day: "numeric", month: "long" })} · ${fmtTime(start)} – ${fmtTime(end)}`),
    titleIn, calSel,
    h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-sm", onclick: () => { menu.close(); onClose();
      editEvent({ id: null, calendar_id: Number(calSel.value), title: titleIn.value, location: "", notes: "", all_day: false, repeat: null, reminders: [10] }, { start, end }); } }, "More options"),
    h("button", { class: "btn btn-sm btn-primary" }, "Save")));
  const menu = popMenu(anchor, [form], { className: "quick-pop" });
  titleIn.focus();
  // Closed without saving: take the outline away.
  const watch = new MutationObserver(() => { if (!menu.box.isConnected) { watch.disconnect(); if (!saving) onClose(); } });
  watch.observe(document.body, { childList: true });
}

/** The full form: everything about an event. */
function editEvent(e, times = null) {
  const cals = editableCalendars();
  if (!cals.length) { toast("You can't add to any of your calendars."); return; }
  const { s: s0, e: e0 } = times ? { s: times.start, e: times.end } : span(e);
  const isNew = !e.id;
  const allDayIn = h("input", { type: "checkbox", checked: !!e.all_day });
  const titleIn = h("input", { class: "input title-in", value: e.title || "", placeholder: "Add a title", "aria-label": "Title", maxlength: 200, required: false });
  const startD = h("input", { type: "date", class: "input", value: ymd(s0), "aria-label": "Starts on" });
  const startT = h("input", { type: "time", class: "input", value: `${pad2(s0.getHours())}:${pad2(s0.getMinutes())}`, step: 300, "aria-label": "Starts at" });
  const endDate = e.all_day && !times ? addDays(e0, -1) : (times && e.all_day ? addDays(e0, -1) : e0);
  const endD = h("input", { type: "date", class: "input", value: ymd(endDate), "aria-label": "Ends on" });
  const endT = h("input", { type: "time", class: "input", value: `${pad2(e0.getHours())}:${pad2(e0.getMinutes())}`, step: 300, "aria-label": "Ends at" });
  let length = +e0 - +s0; // keep the length when the start moves
  const startAt = () => new Date(`${startD.value}T${startT.value || "00:00"}`);
  const endAt = () => new Date(`${endD.value}T${endT.value || "00:00"}`);
  const syncEnd = () => {
    if (allDayIn.checked) { if (endD.value < startD.value) endD.value = startD.value; return; }
    const en = new Date(+startAt() + Math.max(length, SNAP * 60000));
    endD.value = ymd(en); endT.value = `${pad2(en.getHours())}:${pad2(en.getMinutes())}`;
  };
  startD.addEventListener("change", syncEnd); startT.addEventListener("change", syncEnd);
  const onEnd = () => { if (!allDayIn.checked) length = Math.max(SNAP * 60000, +endAt() - +startAt()); };
  endD.addEventListener("change", onEnd); endT.addEventListener("change", onEnd);

  // Repeat: the usual choices for the start date, and one of your own.
  let rule = e.repeat ? { ...e.repeat } : null;
  const repeatSel = h("select", { class: "input", "aria-label": "Repeat" });
  const custom = h("div", { class: "custom-repeat" });
  const presets = () => {
    const d = fromYmd(startD.value || ymd(s0));
    const wd = WEEKDAYS[(d.getDay() + 6) % 7];
    return [["none", "Doesn't repeat", null], ["daily", "Every day", { freq: "daily", interval: 1 }], ["weekdays", "Every weekday (Monday to Friday)", { freq: "weekly", interval: 1, days: ["MO", "TU", "WE", "TH", "FR"] }],
      ["weekly", `Every week on ${dayName(wd, "long")}`, { freq: "weekly", interval: 1, days: [wd] }],
      ["fortnightly", `Every 2 weeks on ${dayName(wd, "long")}`, { freq: "weekly", interval: 2, days: [wd] }],
      ["monthly", `Every month on day ${d.getDate()}`, { freq: "monthly", interval: 1 }],
      ["monthly-wd", `Every month on the ${nthText(d)} ${dayName(wd, "long")}`, { freq: "monthly", interval: 1, by: "weekday" }],
      ["yearly", `Every year on ${fmtDay(d, { day: "numeric", month: "long" })}`, { freq: "yearly", interval: 1 }], ["custom", "Custom…", null]];
  };
  const same = (a, b) => JSON.stringify({ ...a, until: undefined, count: undefined, days: a?.days?.join() }) === JSON.stringify({ ...b, until: undefined, count: undefined, days: b?.days?.join() });
  const fillRepeat = () => {
    const list = presets();
    const hit = rule ? list.find(([, , r]) => r && same(r, { interval: 1, ...rule, days: rule.freq === "weekly" ? (rule.days?.length ? rule.days : r.days) : undefined }) && !rule.until && !rule.count) : list[0];
    repeatSel.replaceChildren(...list.map(([k, label]) => h("option", { value: k }, label)));
    if (rule && !hit) repeatSel.append(h("option", { value: "current" }, repeatText(rule, fromYmd(startD.value))));
    repeatSel.value = hit ? hit[0] : "current";
    custom.hidden = true;
  };
  repeatSel.addEventListener("change", () => {
    const v = repeatSel.value;
    if (v === "custom") { rule ??= { freq: "weekly", interval: 1, days: [WEEKDAYS[(fromYmd(startD.value).getDay() + 6) % 7]] }; customRepeat(); return; }
    if (v === "current") return;
    rule = presets().find(([k]) => k === v)?.[2] ?? null;
    custom.hidden = true;
  });
  startD.addEventListener("change", () => { if (repeatSel.value !== "custom") fillRepeat(); });
  function customRepeat() {
    custom.hidden = false;
    const freq = h("select", { class: "input" }, [["daily", "days"], ["weekly", "weeks"], ["monthly", "months"], ["yearly", "years"]].map(([v, l]) => h("option", { value: v, selected: rule.freq === v }, l)));
    const every = h("input", { type: "number", class: "input num", min: 1, max: 99, value: rule.interval || 1 });
    const days = h("div", { class: "day-picks" }, WEEKDAYS.map((d) => h("button", { type: "button", class: (rule.days || []).includes(d) ? "on" : "", "aria-pressed": String((rule.days || []).includes(d)), onclick: (ev) => {
      const set = new Set(rule.days || []); set.has(d) ? set.delete(d) : set.add(d); rule.days = WEEKDAYS.filter((x) => set.has(x)); ev.currentTarget.classList.toggle("on"); ev.currentTarget.setAttribute("aria-pressed", String(set.has(d)));
    } }, dayName(d, "narrow"))));
    const monthBy = h("select", { class: "input" }, h("option", { value: "date" }, `On day ${fromYmd(startD.value).getDate()}`),
      h("option", { value: "weekday", selected: rule.by === "weekday" }, `On the ${nthText(fromYmd(startD.value))} ${dayName(WEEKDAYS[(fromYmd(startD.value).getDay() + 6) % 7], "long")}`));
    const endsSel = h("select", { class: "input" }, h("option", { value: "never" }, "Never"), h("option", { value: "until", selected: !!rule.until }, "On"), h("option", { value: "count", selected: !!rule.count }, "After"));
    const until = h("input", { type: "date", class: "input", value: rule.until || ymd(addDays(fromYmd(startD.value), 90)) });
    const count = h("input", { type: "number", class: "input num", min: 1, max: 999, value: rule.count || 10 });
    const sync = () => {
      rule = { freq: freq.value, interval: Math.max(1, Number(every.value) || 1) };
      if (rule.freq === "weekly") rule.days = [...days.querySelectorAll("button")].map((b, i) => b.classList.contains("on") && WEEKDAYS[i]).filter(Boolean);
      if (rule.freq === "monthly" && monthBy.value === "weekday") rule.by = "weekday";
      if (endsSel.value === "until") rule.until = until.value; else if (endsSel.value === "count") rule.count = Math.max(1, Number(count.value) || 1);
      days.hidden = rule.freq !== "weekly"; monthBy.hidden = rule.freq !== "monthly"; until.hidden = endsSel.value !== "until"; count.hidden = endsSel.value !== "count";
      countLabel.hidden = count.hidden;
    };
    const countLabel = h("span", { class: "muted" }, "times");
    [freq, every, monthBy, endsSel, until, count].forEach((x) => x.addEventListener("change", sync));
    days.addEventListener("click", sync);
    custom.replaceChildren(
      h("div", { class: "row tight" }, h("span", {}, "Every"), every, freq),
      days, monthBy,
      h("div", { class: "row tight" }, h("span", {}, "Ends"), endsSel, until, count, countLabel));
    sync();
  }
  fillRepeat();

  const calSel = h("select", { class: "input", "aria-label": "Calendar" }, cals.map((c) => h("option", { value: String(c.id), selected: c.id === e.calendar_id }, c.name + (c.kind === "shared" ? " (shared)" : ""))));
  const swatch = h("span", { class: "swatch" });
  const paintSwatch = () => { swatch.style.setProperty("--c", color || calById(Number(calSel.value))?.color); };
  let color = e.color || null;
  calSel.addEventListener("change", paintSwatch);
  const colorBtn = h("button", { type: "button", class: "btn btn-sm", "aria-label": "Colour", onclick: (ev) => popMenu(ev.currentTarget, [h("div", { class: "swatches" },
    h("button", { type: "button", class: "sw none", title: "The calendar's colour", onclick: () => { color = null; paintSwatch(); document.querySelector(".pop-menu")?.remove(); } }),
    CAL.colors.map((c) => h("button", { type: "button", class: "sw", style: `--c:${c}`, "aria-label": c, onclick: () => { color = c; paintSwatch(); document.querySelector(".pop-menu")?.remove(); } })))]) }, swatch);
  paintSwatch();

  const locationIn = h("input", { class: "input", value: e.location || "", placeholder: "Add a place or a video call link", "aria-label": "Location", maxlength: 300 });
  const notesIn = h("textarea", { class: "input", rows: 4, placeholder: "Add notes", "aria-label": "Notes", maxlength: 20000 }, e.notes || "");
  let reminders = [...(e.reminders || [])];
  const remBox = h("div", { class: "reminders" });
  const drawRem = () => {
    const opts = allDayIn.checked ? REMINDERS_DAY : REMINDERS_TIMED;
    remBox.replaceChildren(...reminders.map((m, i) => h("div", { class: "rem" },
      h("select", { class: "input", "aria-label": "Reminder", onchange: (ev) => { reminders[i] = Number(ev.target.value); } },
        [...opts, ...(opts.some(([v]) => v === m) ? [] : [[m, reminderLabel(m, allDayIn.checked)]])].map(([v, l]) => h("option", { value: String(v), selected: v === m }, l))),
      h("button", { type: "button", class: "icon-btn small-btn", "aria-label": "Remove reminder", onclick: () => { reminders.splice(i, 1); drawRem(); } }, icon("close")))),
    reminders.length < 5 && h("button", { type: "button", class: "linkish add-rem", onclick: () => { reminders.push(allDayIn.checked ? 1440 : 10); drawRem(); } }, reminders.length ? "Add another reminder" : "Add a reminder"),
    reminders.length > 0 && typeof Notification !== "undefined" && Notification.permission !== "granted"
      && h("p", { class: "muted small" }, "Reminders come as notifications: turn them on under ", h("button", { type: "button", class: "linkish", onclick: () => openSettings("security") }, "Settings → Sign-in & alerts"), "."));
  };
  const toggleAllDay = () => {
    startT.hidden = endT.hidden = allDayIn.checked;
    if (allDayIn.checked) { reminders = reminders.length ? [1440] : []; } else if (!reminders.length && isNew) reminders = [10];
    drawRem();
  };
  allDayIn.addEventListener("change", toggleAllDay);
  startT.hidden = endT.hidden = allDayIn.checked;
  drawRem();

  const error = h("div", { class: "error", role: "alert" });
  const saveBtn = h("button", { class: "btn btn-primary" }, "Save");
  const overlay = h("div", { class: "overlay center", onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } },
    h("form", { class: "dialog event-dialog", role: "dialog", "aria-label": isNew ? "New event" : "Edit event", onsubmit: async (ev) => {
      ev.preventDefault();
      error.textContent = "";
      const allDay = allDayIn.checked;
      const s = allDay ? startD.value : startAt().toISOString();
      const en = allDay ? ymd(addDays(fromYmd(endD.value || startD.value), 1)) : endAt().toISOString();
      if (!allDay && endAt() <= startAt()) { error.textContent = "It has to end after it starts."; return; }
      if (repeatSel.value === "custom" && rule?.freq === "weekly" && !rule.days?.length) { error.textContent = "Choose the days it repeats on."; return; }
      let scope = "all";
      if (!isNew && e.repeat && e.occurrence) { scope = await askScope("Change a repeating event"); if (!scope) return; }
      saveBtn.disabled = true;
      try {
        const changes = { calendar_id: Number(calSel.value), title: titleIn.value.trim() || "(no title)", location: locationIn.value, notes: notesIn.value, all_day: allDay, start: s, end: en,
          tz: TZ, repeat: repeatSel.value === "none" ? null : rule, reminders, color };
        const body = isNew ? changes : await bodyFor(e, changes, scope);
        if (!isNew && scope === "this") body.repeat = null;
        const saved = await api("calendar/event/save", { method: "POST", body });
        overlay.remove();
        await loadEvents({ force: true }); renderCalendar();
        toast(isNew ? `Added to ${calById(saved.calendar_id)?.name ?? "the calendar"}.` : "Saved.");
      } catch (err) { error.textContent = err.message; saveBtn.disabled = false; }
    } },
    h("div", { class: "dialog-head" }, h("h2", {}, isNew ? "New event" : "Edit event"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))),
    h("div", { class: "pad ev-form" },
      titleIn,
      h("div", { class: "when-row" }, icon("clock"),
        h("div", { class: "when" },
          h("div", { class: "when-line" }, h("span", { class: "muted" }, "Starts"), startD, startT),
          h("div", { class: "when-line" }, h("span", { class: "muted" }, "Ends"), endD, endT),
          h("div", { class: "row tight" }, h("label", { class: "check" }, allDayIn, "All day"), repeatSel), custom,
          h("div", { class: "muted small" }, TZ))),
      h("div", { class: "when-row" }, icon("pin"), locationIn),
      h("div", { class: "when-row" }, icon("calendar"), h("div", { class: "row tight grow" }, calSel, colorBtn)),
      h("div", { class: "when-row" }, icon("bell"), remBox),
      h("div", { class: "when-row" }, icon("note"), notesIn),
      error),
    h("div", { class: "dialog-foot" },
      !isNew && h("button", { type: "button", class: "btn btn-danger", onclick: () => { overlay.remove(); deleteEvent(e); } }, icon("trash"), "Delete"),
      h("span", { class: "grow" }), h("button", { type: "button", class: "btn", onclick: () => overlay.remove() }, "Cancel"), saveBtn)));
  document.body.append(overlay);
  overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") overlay.remove(); });
  titleIn.focus();
}

// ------------------------------------------------------------------------------------------------ calendars: edit, share, subscribe

function editCalendar(c) {
  const isNew = !c.id;
  const shared = c.kind === "shared";
  const name = h("input", { class: "input", value: c.name || "", placeholder: shared ? "e.g. Team holidays" : "e.g. Family", maxlength: 80, required: true, "aria-label": "Name" });
  let color = c.color || CAL.colors[(CAL.calendars.length + 1) % CAL.colors.length] || "#2563eb";
  const swatches = h("div", { class: "swatches" });
  const drawSw = () => swatches.replaceChildren(...CAL.colors.map((x) => h("button", { type: "button", class: `sw${x === color ? " on" : ""}`, style: `--c:${x}`, "aria-label": x, "aria-pressed": String(x === color),
    onclick: () => { color = x; drawSw(); } })));
  drawSw();
  let members = (c.members || []).filter((m) => m.role !== "owner").map((m) => ({ user_id: m.user_id, role: m.role }));
  const owner = (c.members || []).find((m) => m.role === "owner");
  const list = h("div", { class: "members" });
  const who = (id) => CAL.people.find((p) => p.id === id);
  const drawMembers = () => {
    const taken = new Set([state.user.id, owner?.user_id, ...members.map((m) => m.user_id)]);
    const add = h("select", { class: "input", "aria-label": "Add someone", onchange: (ev) => { if (ev.target.value) { members.push({ user_id: Number(ev.target.value), role: "edit" }); drawMembers(); } } },
      h("option", { value: "" }, "Add someone…"), CAL.people.filter((p) => !taken.has(p.id)).map((p) => h("option", { value: String(p.id) }, p.name ? `${p.name} (${p.email})` : p.email)));
    list.replaceChildren(
      h("div", { class: "member" }, avatar({ name: (who(owner?.user_id ?? state.user.id))?.name, address: (who(owner?.user_id ?? state.user.id))?.email }),
        h("span", { class: "grow" }, who(owner?.user_id ?? state.user.id)?.name || who(owner?.user_id ?? state.user.id)?.email), h("span", { class: "muted small" }, "Owner")),
      ...members.map((m, i) => { const p = who(m.user_id); return h("div", { class: "member" }, avatar({ name: p?.name, address: p?.email }),
        h("span", { class: "grow" }, p?.name || p?.email || "Someone", p?.name && h("small", { class: "muted" }, ` ${p.email}`)),
        h("select", { class: "input", "aria-label": "What they can do", onchange: (ev) => { m.role = ev.target.value; } },
          h("option", { value: "edit", selected: m.role === "edit" }, "Can change"), h("option", { value: "view", selected: m.role === "view" }, "Can see")),
        h("button", { type: "button", class: "icon-btn small-btn", "aria-label": "Remove", onclick: () => { members.splice(i, 1); drawMembers(); } }, icon("close"))); }),
      CAL.people.length > taken.size - (owner ? 0 : 1) ? add : h("p", { class: "muted small" }, "Everyone using the webmail is on it."));
  };
  if (shared) drawMembers();
  const error = h("div", { class: "error", role: "alert" });
  const overlay = h("div", { class: "overlay center", onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } },
    h("form", { class: "dialog small-dialog", role: "dialog", "aria-label": isNew ? "New calendar" : "Edit calendar", onsubmit: async (ev) => {
      ev.preventDefault(); error.textContent = "";
      try {
        await api("calendar/save", { method: "POST", body: { id: c.id || undefined, kind: c.kind, name: name.value, color, ...(shared ? { members } : {}) } });
        overlay.remove(); toast(isNew ? `${name.value} is ready.` : "Saved."); reloadAll();
      } catch (err) { error.textContent = err.message; }
    } },
    h("div", { class: "dialog-head" }, h("h2", {}, isNew ? (shared ? "New shared calendar" : "New calendar") : `Edit ${c.name}`), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))),
    h("div", { class: "pad" },
      h("label", { class: "field" }, "Name", name),
      h("div", { class: "field" }, "Colour", swatches),
      shared && h("div", { class: "field" }, "People", h("small", {}, "Everyone here sees it in their calendar. “Can change” lets them add, move and delete events; “Can see” is read-only. Reminders come to everyone on it."), list),
      error),
    h("div", { class: "dialog-foot" }, h("span", { class: "grow" }), h("button", { type: "button", class: "btn", onclick: () => overlay.remove() }, "Cancel"), h("button", { class: "btn btn-primary" }, isNew ? "Create" : "Save"))));
  document.body.append(overlay);
  name.focus();
}

function showMembers(c) {
  popMenu(document.activeElement || document.body, [h("div", { class: "pop-title" }, c.name),
    ...(c.members || []).map((m) => h("div", { class: "member" }, avatar({ name: m.name, address: m.email }), h("span", { class: "grow" }, m.name || m.email),
      h("span", { class: "muted small" }, m.role === "owner" ? "Owner" : m.role === "edit" ? "Can change" : "Can see")))]);
}

async function feedDialog(c) {
  const box = h("div", { class: "pad" }, h("p", { class: "muted" }, "Loading…"));
  const overlay = h("div", { class: "overlay center", onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } },
    h("div", { class: "dialog small-dialog", role: "dialog", "aria-label": "On your phone or computer" },
      h("div", { class: "dialog-head" }, h("h2", {}, `${c.name} on your phone or computer`), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))), box));
  document.body.append(overlay);
  const show = async (doWhat) => {
    try {
      const r = await api("calendar/feed", { method: "POST", body: { id: c.id, do: doWhat } });
      if (!r.url) { box.replaceChildren(h("p", {}, "The link is turned off: calendar apps using it stop updating."), h("button", { class: "btn", onclick: () => show("show") }, "Make a link")); return; }
      const webcal = r.url.replace(/^https?:/, "webcal:");
      const input = h("input", { class: "input mono", value: r.url, readonly: true, onfocus: (e) => e.target.select(), "aria-label": "Calendar link" });
      box.replaceChildren(
        h("p", {}, "See this calendar in Apple Calendar, Google Calendar or Outlook. It updates there by itself (every few hours, depending on the app). It's read-only there: add and change events here."),
        h("div", { class: "feed-link" }, input, h("button", { class: "btn", onclick: async () => { await navigator.clipboard.writeText(r.url); toast("Link copied."); } }, "Copy")),
        h("p", {}, h("a", { class: "btn btn-primary", href: webcal }, icon("calendar"), "Open in my calendar app")),
        h("ul", { class: "muted small feed-steps" },
          h("li", {}, h("strong", {}, "iPhone, iPad, Mac: "), "tap Open in my calendar app, or Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link."),
          h("li", {}, h("strong", {}, "Google Calendar: "), "on a computer, Other calendars → + → From URL, and paste the link. It shows on your Android phone too."),
          h("li", {}, h("strong", {}, "Outlook: "), "Add calendar → Subscribe from web, and paste the link.")),
        h("p", { class: "notice warn small" }, "Anyone with this link can see the calendar: keep it to yourself. If it gets out, make a new one and the old one stops working."),
        h("div", { class: "row" }, h("button", { class: "btn btn-sm", onclick: () => confirm("Make a new link? Apps using the old one stop updating.") && show("new") }, "Make a new link"),
          h("button", { class: "btn btn-sm btn-danger", onclick: () => confirm("Turn the link off? Apps using it stop updating.") && show("off") }, "Turn off")));
    } catch (err) { box.replaceChildren(h("div", { class: "notice bad" }, err.message)); }
  };
  show("show");
}

function importFile(c) {
  const input = h("input", { type: "file", accept: ".ics,text/calendar", hidden: true, onchange: async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast("That file is too big (10 MB at most)."); return; }
    try {
      const r = await api("calendar/import", { method: "POST", body: { calendar_id: c.id, ics: await file.text() } });
      toast(`${r.added} event${r.added === 1 ? "" : "s"} added${r.updated ? `, ${r.updated} updated` : ""}.`);
      await loadEvents({ force: true }); renderCalendar();
    } catch (err) { toast(err.message); }
  } });
  document.body.append(input);
  input.click();
}

// ------------------------------------------------------------------------------------------------ invitations in email

/** For an email with a calendar file (.ics, an invitation): what's in it, and Add to calendar. */
async function invitationCard(attachment) {
  const card = h("div", { class: "invite" }, icon("calendar"), h("div", { class: "grow" }, h("strong", {}, "Calendar invitation"), h("div", { class: "muted small" }, "Reading it…")));
  try {
    const { events } = await api("calendar/preview", { method: "POST", body: { attachment: attachment.id } });
    if (!events.length) { card.remove(); return card; }
    if (!CAL.calendars.length) await loadCalendars();
    const first = events[0];
    const sel = h("select", { class: "input", "aria-label": "Calendar" }, editableCalendars().map((c) => h("option", { value: String(c.id), selected: c.id === defaultCalendar()?.id }, c.name)));
    const add = h("button", { class: "btn btn-sm btn-primary", onclick: async () => {
      add.disabled = true;
      try {
        const r = await api("calendar/import", { method: "POST", body: { attachment: attachment.id, calendar_id: Number(sel.value) } });
        add.replaceWith(h("span", { class: "pill ok" }, r.added ? "Added" : "Updated"),
          h("button", { class: "btn btn-sm", onclick: () => window.Webmail.openCalendar({ date: span(first).s }) }, "Show in calendar"));
      } catch (err) { toast(err.message); add.disabled = false; }
    } }, "Add to calendar");
    card.replaceChildren(icon("calendar"), h("div", { class: "grow" },
      h("strong", {}, first.title), h("div", { class: "muted small" }, whenText(first), first.location ? ` · ${first.location}` : "", first.repeat ? ` · ${repeatText(first.repeat, span(first).s)}` : "",
        events.length > 1 ? ` (and ${events.length - 1} more)` : "")),
    h("div", { class: "row tight" }, sel, add));
  } catch { card.remove(); }
  return card;
}

// ------------------------------------------------------------------------------------------------ keys

document.addEventListener("keydown", (e) => {
  if (state.folder !== "calendar" || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".overlay, .pop-menu")) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const keys = { t: today, d: () => setView("day"), w: () => setView("week"), m: () => setView("month"), s: () => setView("schedule"), a: () => setView("schedule"),
    ArrowLeft: () => step(-1), ArrowRight: () => step(1), j: () => step(1), k: () => step(-1), n: () => newEvent(), c: () => newEvent() };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

// The time line moves on its own.
setInterval(() => {
  if (state.folder !== "calendar" || document.hidden) return;
  document.querySelectorAll(".now-line").forEach((el) => { el.style.top = `${minutesOf(new Date()) / 60 * HOUR_PX}px`; });
}, 60000);

window.Calendar = { showCalendar, invitationCard, newEvent };
