// The spreadsheet editor (.xlsx, .csv): a grid that draws only the cells in view, formulas (formula.js), formatting,
// several sheets, sorting and filtering, the clipboard, the fill handle, and other people's selections as they move.
// Changes are ops (sheet-model.js), shared through the editor (editor.js).
"use strict";

(() => {
const F = () => window.OfficeFormula;
const M = () => window.OfficeSheetModel;
const X = () => window.OfficeSheetExtras;
const UI = () => window.OfficeUI;

const DEF_W = 96, DEF_H = 22, HDR_W = 46, HDR_H = 24;
const dmy = !/^en-US|^en-PH|^en-CA$/i.test(navigator.language || "en-GB");
const CURRENCY = /^en-GB/i.test(navigator.language) ? "£" : /^en-(US|CA|AU|NZ)/i.test(navigator.language) ? "$" : /^(ja)/i.test(navigator.language) ? "¥" : /^en-IN/i.test(navigator.language) ? "₹" : /^en/i.test(navigator.language) ? "£" : "€";
const FORMATS = [
  ["General", "General"], ["0", "Number"], ["#,##0.00", "Number (1,000.00)"], [`${CURRENCY}#,##0.00`, "Currency"], [`${CURRENCY}#,##0.00;[Red]-${CURRENCY}#,##0.00`, "Currency (red negatives)"],
  ["0%", "Percent"], ["0.00%", "Percent (0.00%)"], [dmy ? "dd/mm/yyyy" : "mm/dd/yyyy", "Date"], ["d mmmm yyyy", "Long date"], ["hh:mm", "Time"], [dmy ? "dd/mm/yyyy hh:mm" : "mm/dd/yyyy hh:mm", "Date and time"],
  ["[h]:mm", "Duration"], ["0.00E+00", "Scientific"], ["# ?/?", "Fraction"], ["@", "Text"],
];
const isNum = (v) => typeof v === "number";
const STYLE_KEYS = ["b", "i", "u", "s", "color", "bg", "font", "size", "h", "va", "wrap", "nf", "border"];
const NOSTYLE = Object.freeze(Object.fromEntries(STYLE_KEYS.map((k) => [k, null])));

/** A workbook from a CSV file: one sheet; numbers and dates recognised. */
function fromCsv(text, name) {
  const { rows, sep } = window.OfficeFiles.readCsv(text);
  const sh = M().blank("s1", name.replace(/\.[^.]+$/, "").slice(0, 31) || "Sheet1");
  rows.forEach((row, r) => row.forEach((raw, c) => {
    if (raw === "") return;
    if (raw.startsWith("=") && raw.length > 1) { sh.cells.set(`${r},${c}`, { v: null, f: raw }); return; }
    const p = F().parseInput(raw, { dmy });
    sh.cells.set(`${r},${c}`, { v: p.value, ...(p.format ? { s: { nf: p.format } } : {}) });
  }));
  return { sheets: [sh], csvSep: sep };
}

// ---------------------------------------------------------------------------------------------- calculation

class Book {
  constructor(get) { this.get = get; this.rebuild(); }
  rebuild() {
    const wb = this.get();
    const byName = new Map(wb.sheets.map((s) => [s.name.toLowerCase(), s]));
    this.byName = byName;
    this.calc = new (F().Calc)((sheet, r, c) => { const s = byName.get(String(sheet).toLowerCase()); const cell = s?.cells.get(`${r},${c}`); return cell && !cell.f ? cell.v : null; },
      { has: (n) => byName.has(String(n).toLowerCase()), used: (n) => { const s = byName.get(String(n).toLowerCase()); return s ? M().extent(s) : { rows: 0, cols: 0 }; } });
    for (const s of wb.sheets) for (const [k, cell] of s.cells) if (cell.f) { const [r, c] = k.split(",").map(Number); this.calc.set(s.name, r, c, cell.f); }
    try { this.calc.recalc(); } catch (e) { console.error(e); }
  }
  /** After cells changed on $sheet: only what depends on them is worked out again. */
  changed(sheet, keys) {
    const wb = this.get();
    const s = wb.sheets.find((x) => x.id === sheet);
    if (!s) return this.rebuild();
    const ks = [];
    for (const k of keys) {
      const [r, c] = k.split(",").map(Number);
      const cell = s.cells.get(k);
      if (cell?.f) this.calc.set(s.name, r, c, cell.f); else this.calc.clear(s.name, r, c);
      ks.push(F().Calc.key(s.name, r, c));
    }
    try { this.calc.recalc(ks); } catch (e) { console.error(e); this.rebuild(); }
  }
  value(sh, r, c) {
    const cell = sh.cells.get(`${r},${c}`);
    if (!cell) return null;
    if (cell.f) { const v = this.calc.value(sh.name, r, c); return v === undefined ? null : v; }
    return cell.v;
  }
}

// ---------------------------------------------------------------------------------------------- sizes (with hidden rows from a filter)

class Axis {
  constructor(sizes, def, hidden = new Set()) {
    this.def = def;
    const special = new Map();
    for (const [i, px] of Object.entries(sizes || {})) special.set(+i, px);
    for (const i of hidden) special.set(i, 0);
    this.list = [...special.entries()].sort((a, b) => a[0] - b[0]);
    // Running totals of the differences from the default, for quick positions.
    let acc = 0;
    this.acc = this.list.map(([, px]) => (acc += px - def));
  }
  size(i) { const k = this.find(i); return k >= 0 && this.list[k][0] === i ? this.list[k][1] : this.def; }
  /** Index of the last special entry at or before $i. */
  find(i) { let lo = 0, hi = this.list.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (this.list[m][0] <= i) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
  /** Where $i starts. */
  pos(i) { const k = this.find(i - 1); return i * this.def + (k >= 0 ? this.acc[k] : 0); }
  /** Which index is at pixel $x. */
  at(x) { let lo = 0, hi = F().MAX_ROWS; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.pos(m) <= x) lo = m; else hi = m - 1; } return lo; }
}

// ---------------------------------------------------------------------------------------------- the view

function mount(host, ctx) {
  const { h, icon, tool } = ctx;
  const wbNow = () => ctx.state;
  const book = new Book(wbNow);
  let sheetId = wbNow().sheets.find((s) => !s.hidden)?.id || wbNow().sheets[0].id;
  const sh = () => wbNow().sheets.find((s) => s.id === sheetId) || wbNow().sheets[0];
  let sel = { r: 0, c: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  let editing = null; // { r, c, from: "type" | "edit" | "bar" }
  let filters = new Map(); // sheetId → { r (header row), c1, c2, hide: { col: Set(values) } }
  let hiddenRows = new Set();
  let cols, rows; // Axis
  let rendered = null; // { r0, r1, c0, c1 }
  let clip = null;     // the last copy here: { tsv, cells, cut }
  let othersNow = ctx.others || [];
  let cfNow = null;     // the sheet's conditional formatting, worked out (sheet-extras.js)

  // ---- layout
  const $name = h("input", { class: "ox-namebox", "aria-label": "Cell", spellcheck: false, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); goTo(e.target.value); } if (e.key === "Escape") { $name.value = F().addr(sel.r, sel.c); focusGrid(); } } });
  const $bar = h("input", { class: "ox-formula", "aria-label": "Contents", spellcheck: false, readOnly: ctx.readOnly });
  const $grid = h("div", { class: "ox-grid", tabindex: "-1" });
  const $scroll = h("div", { class: "ox-scroll" });
  const $space = h("div", { class: "ox-space" });
  const layers = { body: h("div", { class: "ox-layer" }), top: h("div", { class: "ox-layer" }), left: h("div", { class: "ox-layer" }), corner: h("div", { class: "ox-layer" }) };
  const panes = { top: h("div", { class: "ox-pane" }, layers.top), left: h("div", { class: "ox-pane" }, layers.left), corner: h("div", { class: "ox-pane" }, layers.corner) };
  const $colHdr = h("div", { class: "ox-hdr ox-colhdr" }), $rowHdr = h("div", { class: "ox-hdr ox-rowhdr" });
  const $all = h("button", { type: "button", class: "ox-hdr-all", "aria-label": "Select all", onclick: () => { select(0, 0, Infinity, Infinity); } });
  const $input = h("textarea", { class: "ox-cellinput", "aria-label": "Cell contents", spellcheck: false, autocapitalize: "off", autocomplete: "off", rows: 1, wrap: "off" });
  const $suggest = h("div", { class: "ox-suggest", hidden: true, role: "listbox" });
  const $tabs = h("div", { class: "ox-tabs", role: "tablist" });
  const $stats = h("div", { class: "ox-stats", "aria-live": "polite" });
  $scroll.append($space, layers.body);
  $grid.append($scroll, panes.top, panes.left, panes.corner, $colHdr, $rowHdr, $all, $input, $suggest);
  const wrap = h("div", { class: "ox-sheet" },
    h("div", { class: "ox-fbar" }, $name, h("span", { class: "ox-fx", "aria-hidden": "true" }, "fx"), $bar),
    $grid,
    h("div", { class: "ox-foot" }, ctx.readOnly ? null : h("button", { type: "button", class: "ox-tool", title: "Add a sheet", "aria-label": "Add a sheet", onclick: addSheet }, icon("plus")), $tabs, $stats));
  host.append(wrap);

  // ---- toolbar
  const tb = ctx.toolbar;
  const fmt = UI().select("Number format", FORMATS.map(([v, t]) => [v, t]).concat([["custom", "Custom…"]]), (v) => {
    if (v === "custom") { const code = prompt("Number format (as in Excel), e.g. #,##0.00 or dd mmm yyyy", cellStyle().nf || "General"); if (code) styleSel({ nf: code === "General" ? null : code }); }
    else styleSel({ nf: v === "General" ? null : v });
    focusGrid();
  }, "ox-fmt");
  const font = UI().select("Font", UI().FONTS.map((f) => [f, f]), (v) => { styleSel({ font: v === "Calibri" ? null : v }); focusGrid(); });
  const size = UI().select("Size", UI().SIZES.map((s) => [s, s]), (v) => { styleSel({ size: +v === 11 ? null : +v }); focusGrid(); }, "ox-size");
  const btn = {};
  if (!ctx.readOnly) {
    tb.append(fmt,
      tool("minus", "Fewer decimal places", () => decimals(-1)), tool("plus", "More decimal places", () => decimals(1)), h("span", { class: "ox-sep" }),
      font, size,
      btn.b = tool("bold", "Bold (Ctrl+B)", () => toggle("b")), btn.i = tool("italic", "Italic (Ctrl+I)", () => toggle("i")),
      btn.u = tool("underline", "Underline (Ctrl+U)", () => toggle("u")), btn.s = tool("strike", "Strikethrough", () => toggle("s")),
      tool("textColor", "Text colour", (e) => UI().colorPicker(e.currentTarget, { pick: (c) => styleSel({ color: c }) })),
      tool("fill", "Fill colour", (e) => UI().colorPicker(e.currentTarget, { none: "No fill", pick: (c) => styleSel({ bg: c }) })),
      tool("borders", "Borders", (e) => bordersMenu(e.currentTarget)), tool("merge", "Merge cells", mergeToggle), h("span", { class: "ox-sep" }),
      btn.left = tool("alignLeft", "Align left", () => styleSel({ h: cellStyle().h === "left" ? null : "left" })),
      btn.center = tool("alignCenter", "Centre", () => styleSel({ h: cellStyle().h === "center" ? null : "center" })),
      btn.right = tool("alignRight", "Align right", () => styleSel({ h: cellStyle().h === "right" ? null : "right" })),
      tool("more", "Vertical alignment", (e) => W().popMenu(e.currentTarget, [["top", "Top"], ["middle", "Middle"], [null, "Bottom"]].map(([v, l]) => ({ label: l, run: () => styleSel({ va: v }) })))),
      btn.wrap = tool("wrap", "Wrap text", () => toggle("wrap")), h("span", { class: "ox-sep" }),
      tool("sigma", "Sum (AutoSum)", autoSum), tool("sort", "Sort", (e) => sortMenu(e.currentTarget)), btn.filter = tool("filter", "Filter", toggleFilter),
      tool("condFormat", "Conditional formatting", (e) => cfMenu(e.currentTarget)), tool("chart", "Insert chart", (e) => chartMenu(e.currentTarget)), tool("pivot", "Pivot table", (e) => pivotStart(e.currentTarget)),
      tool("freeze", "Freeze", (e) => freezeMenu(e.currentTarget)), tool("insertRow", "Rows and columns", (e) => rowsMenu(e.currentTarget)),
      tool("comment", "Comment", () => ctx.comment(anchorFor(sel.r, sel.c))), tool("search", "Find and replace (Ctrl+F)", findBar), tool("clear", "Clear formatting", clearFormat));
  } else {
    tb.append(tool("sort", "Sort (just for you)", (e) => sortMenu(e.currentTarget)), btn.filter = tool("filter", "Filter (just for you)", toggleFilter), tool("search", "Find (Ctrl+F)", findBar), tool("comment", "Comment", () => ctx.comment(anchorFor(sel.r, sel.c))));
  }
  const W = () => window.Webmail;

  // ---- geometry
  function axes() {
    const s = sh();
    const f = filters.get(s.id);
    hiddenRows = new Set();
    if (f) {
      const ext = M().extent(s);
      for (let r = f.r + 1; r < ext.rows; r++) for (const [c, hide] of Object.entries(f.hide)) if (hide.size && hide.has(display(s, r, +c).text)) { hiddenRows.add(r); break; }
    }
    cols = new Axis(s.cols, DEF_W);
    // Rows without a height of their own grow to fit bigger text (and wrapped lines), as spreadsheets do.
    const auto = {};
    for (const [k, cell] of s.cells) {
      const st = cell.s;
      if (!st || (!(st.size > 12) && !st.wrap)) continue;
      const r = +k.slice(0, k.indexOf(","));
      if (s.rows[r] !== undefined) continue;
      let need = Math.ceil((st.size || 11) * 4 / 3 * 1.25 + 4);
      if (st.wrap && typeof cell.v === "string") { const c = +k.slice(k.indexOf(",") + 1); const perLine = Math.max(1, Math.floor((s.cols[c] || DEF_W) / ((st.size || 11) * 0.62))); const lines = cell.v.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0); need = Math.max(need, Math.min(400, lines * Math.ceil((st.size || 11) * 4 / 3 * 1.2) + 4)); }
      if (need > (auto[r] || DEF_H)) auto[r] = need;
    }
    rows = new Axis({ ...auto, ...s.rows }, DEF_H, hiddenRows);
  }
  const frozen = () => ({ r: sh().freeze?.r || 0, c: sh().freeze?.c || 0 });
  function extentPx() {
    const s = sh(), e = M().extent(s), fz = frozen();
    const vr = Math.max(e.rows + 60, 200, Math.ceil(($scroll.scrollTop + $scroll.clientHeight * 2) / DEF_H)), vc = Math.max(e.cols + 12, 26, Math.ceil(($scroll.scrollLeft + $scroll.clientWidth * 2) / DEF_W));
    const nr = Math.min(vr, F().MAX_ROWS), nc = Math.min(vc, F().MAX_COLS);
    return { w: cols.pos(nc) - cols.pos(fz.c), h: rows.pos(nr) - rows.pos(fz.r), nr, nc };
  }
  function layout() {
    const fz = frozen();
    const fw = cols.pos(fz.c), fh = rows.pos(fz.r);
    const place = (el, l, t, w, ht) => { el.style.left = `${l}px`; el.style.top = `${t}px`; if (w != null) el.style.width = `${w}px`; if (ht != null) el.style.height = `${ht}px`; };
    $scroll.style.left = `${HDR_W + fw}px`; $scroll.style.top = `${HDR_H + fh}px`;
    place(panes.corner, HDR_W, HDR_H, fw, fh);
    place(panes.top, HDR_W + fw, HDR_H, null, fh); panes.top.style.right = "0";
    place(panes.left, HDR_W, HDR_H + fh, fw, null); panes.left.style.bottom = "0";
    for (const p of Object.values(panes)) p.hidden = false;
    panes.corner.hidden = !(fz.r && fz.c); panes.top.hidden = !fz.r; panes.left.hidden = !fz.c;
    const e = extentPx();
    $space.style.width = `${e.w}px`; $space.style.height = `${e.h}px`;
    sync();
  }
  function sync() {
    layers.top.style.transform = `translateX(${-$scroll.scrollLeft}px)`;
    layers.left.style.transform = `translateY(${-$scroll.scrollTop}px)`;
  }
  /** Where a cell is drawn: which layer and its box there. */
  function cellBox(r, c, r2 = r, c2 = c) {
    const fz = frozen();
    const top = r < fz.r, left = c < fz.c;
    const layer = top && left ? layers.corner : top ? layers.top : left ? layers.left : layers.body;
    const ox = left ? 0 : cols.pos(fz.c), oy = top ? 0 : rows.pos(fz.r);
    return { layer, x: cols.pos(c) - ox, y: rows.pos(r) - oy, w: cols.pos(c2 + 1) - cols.pos(c), h: rows.pos(r2 + 1) - rows.pos(r) };
  }
  /** The cell at a point on the screen. */
  function cellAt(clientX, clientY) {
    const g = $grid.getBoundingClientRect(), fz = frozen();
    const x = clientX - g.left - HDR_W, y = clientY - g.top - HDR_H;
    const fw = cols.pos(fz.c), fh = rows.pos(fz.r);
    const c = x < fw ? cols.at(Math.max(0, x)) : cols.at(x - fw + fw + $scroll.scrollLeft);
    const r = y < fh ? rows.at(Math.max(0, y)) : rows.at(y - fh + fh + $scroll.scrollTop);
    return { r: Math.max(0, Math.min(r, F().MAX_ROWS - 1)), c: Math.max(0, Math.min(c, F().MAX_COLS - 1)) };
  }

  // ---- drawing
  function display(s, r, c) {
    const cell = s.cells.get(`${r},${c}`);
    if (!cell) return { text: "" };
    const v = book.value(s, r, c);
    if (v === null || v === undefined) return { text: "" };
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", bool: true };
    if (F().isErr(v)) return { text: v.code, err: true };
    const f = F().format(v, cell.s?.nf);
    return { text: f.text, color: f.color, num: isNum(v) };
  }
  /** How wide text is in a cell's font (measured once per text and style). */
  const measurer = document.createElement("canvas").getContext("2d");
  const widths = new Map();
  function textWidth(text, st) {
    const font = `${st?.i ? "italic " : ""}${st?.b ? "700 " : ""}${((st?.size || 11) * 4) / 3}px ${st?.font ? `"${st.font}", ` : ""}Calibri, Carlito, "Segoe UI", Arial, sans-serif`;
    const key = font + "\u0000" + text;
    if (!widths.has(key)) { if (widths.size > 5000) widths.clear(); measurer.font = font; widths.set(key, measurer.measureText(text).width); }
    return widths.get(key);
  }
  const mergeAt = (s, r, c) => s.merges.find((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);
  function drawCell(s, r, c, out, anchors) {
    const g = mergeAt(s, r, c);
    if (g && (g.r1 !== r || g.c1 !== c)) return;
    const cell = s.cells.get(`${r},${c}`);
    const st = cell?.s;
    const d = cell ? display(s, r, c) : { text: "" };
    const cx = cfNow?.at(r, c);
    if (!d.text && !st?.bg && !st?.border && !cx && !anchors.has(anchorFor(r, c))) return;
    let r2 = r, c2 = c;
    if (g) { r2 = g.r2; c2 = g.c2; }
    const box = cellBox(r, c, r2, c2);
    if (box.h === 0) return;
    const el = document.createElement("div");
    el.className = "ox-cell";
    const halign = st?.h || (d.num ? "right" : d.bool || d.err ? "center" : "left");
    // Text that doesn't fit runs on into empty cells beside it.
    let w = box.w;
    if (d.text && !st?.wrap && !g && halign === "left") {
      const need = textWidth(d.text, st) + 10; // in the cell's own font and size
      let cc = c + 1;
      while (cc < c + 12 && w < need && !s.cells.get(`${r},${cc}`)?.v && !s.cells.get(`${r},${cc}`)?.f && !mergeAt(s, r, cc)) { w += cols.size(cc); cc++; }
    }
    el.style.left = `${box.x}px`; el.style.top = `${box.y}px`; el.style.width = `${w}px`; el.style.height = `${box.h}px`;
    if (w > box.w) el.classList.add("spill");
    if (st) {
      if (st.b) el.style.fontWeight = "700";
      if (st.i) el.style.fontStyle = "italic";
      if (st.u || st.s) el.style.textDecoration = [st.u && "underline", st.s && "line-through"].filter(Boolean).join(" ");
      if (st.color) el.style.color = st.color;
      if (st.bg) el.style.backgroundColor = st.bg;
      if (st.font) el.style.fontFamily = `"${st.font}", sans-serif`;
      if (st.size) el.style.fontSize = `${st.size * 4 / 3}px`;
      if (st.wrap) el.classList.add("wrap");
      if (st.va === "top") el.style.alignItems = "flex-start"; else if (st.va === "middle") el.style.alignItems = "center";
      if (st.border) { const B = { 1: "1px solid #444", 2: "2px solid #222", 3: "3px solid #000" }; for (const [k, side] of [["t", "Top"], ["r", "Right"], ["b", "Bottom"], ["l", "Left"]]) if (st.border[k]) el.style[`border${side}`] = B[st.border[k]]; }
    }
    if (d.color) el.style.color = d.color;
    if (cx) {
      if (cx.bg) el.style.backgroundColor = cx.bg;
      if (cx.color) el.style.color = cx.color;
      if (cx.b) el.style.fontWeight = "700";
      if (cx.i) el.style.fontStyle = "italic";
      if (cx.u || cx.s) el.style.textDecoration = [cx.u && "underline", cx.s && "line-through"].filter(Boolean).join(" ");
    }
    if (d.err) el.classList.add("err");
    el.style.justifyContent = halign === "right" ? "flex-end" : halign === "center" ? "center" : "flex-start";
    if (halign === "center") el.style.textAlign = "center"; else if (halign === "right") el.style.textAlign = "right";
    el.textContent = cx?.icon?.hide ? "" : d.text;
    if (cx?.icon) { const ic = h("span", { class: "ox-cficon", "aria-hidden": "true" }, cx.icon.g); ic.style.color = cx.icon.color; el.prepend(ic); el.style.justifyContent = "space-between"; }
    if (cx?.bar) { const bar = h("span", { class: "ox-cfbar" }); bar.style.left = `${(cx.bar.from * 100).toFixed(2)}%`; bar.style.width = `${((cx.bar.to - cx.bar.from) * 100).toFixed(2)}%`; bar.style.background = `linear-gradient(90deg, ${cx.bar.neg ? "#ff0000" : cx.bar.color}, ${cx.bar.neg ? "#ff000033" : cx.bar.color + "33"})`; el.prepend(bar); }
    if (anchors.has(anchorFor(r, c))) el.append(h("span", { class: "ox-cnote", title: "Comment" }));
    out.get(box.layer).append(el);
  }
  function draw(force = false) {
    const s = sh(), fz = frozen();
    const vx = $scroll.scrollLeft + cols.pos(fz.c), vy = $scroll.scrollTop + rows.pos(fz.r);
    const c0 = cols.at(vx), c1 = cols.at(vx + $scroll.clientWidth) + 1, r0 = rows.at(vy), r1 = rows.at(vy + $scroll.clientHeight) + 1;
    if (!force && rendered && r0 >= rendered.r0 && r1 <= rendered.r1 && c0 >= rendered.c0 && c1 <= rendered.c1) { drawHeaders(); return; }
    rendered = { r0: Math.max(fz.r, r0 - 20), r1: r1 + 30, c0: Math.max(fz.c, c0 - 6), c1: c1 + 8 };
    cfNow = cfFor(s);
    const out = new Map(Object.values(layers).map((l) => [l, document.createDocumentFragment()]));
    const anchors = ctx.commentAnchors?.() || new Set();
    // Merged cells starting off screen still show.
    const need = (r, c) => drawCell(s, r, c, out, anchors);
    const ranges = [[rendered.r0, rendered.r1, rendered.c0, rendered.c1], [0, fz.r - 1, rendered.c0, rendered.c1], [rendered.r0, rendered.r1, 0, fz.c - 1], [0, fz.r - 1, 0, fz.c - 1]];
    for (const [a, b, c, d] of ranges) {
      if (b < a || d < c) continue;
      // Sparse sheets: walk the cells that exist rather than every position.
      if ((b - a + 1) * (d - c + 1) > s.cells.size * 2) { for (const k of s.cells.keys()) { const [r, cc] = k.split(",").map(Number); if (r >= a && r <= b && cc >= c && cc <= d) need(r, cc); } }
      else for (let r = a; r <= b; r++) { if (hiddenRows.has(r)) continue; for (let c2 = c; c2 <= d; c2++) need(r, c2); }
      for (const g of s.merges) if (g.r2 >= a && g.r1 <= b && g.c2 >= c && g.c1 <= d && (g.r1 < a || g.c1 < c)) need(g.r1, g.c1);
    }
    // Gridlines, at each column's and row's real edge.
    const lines = (layer, ra, rb, ca, cb) => {
      if (rb < ra || cb < ca) return;
      const f = out.get(layer), b0 = cellBox(ra, ca), b1 = cellBox(rb, cb);
      const top = b0.y, bottom = b1.y + b1.h, left = b0.x, right = b1.x + b1.w;
      const frag = document.createDocumentFragment();
      for (let c = ca; c <= cb; c++) { const x = cellBox(ra, c).x + cols.size(c) - 1; const el = document.createElement("div"); el.className = "ox-gl v"; el.style.left = `${x}px`; el.style.top = `${top}px`; el.style.height = `${bottom - top}px`; frag.append(el); }
      for (let r = ra; r <= rb; r++) { if (hiddenRows.has(r)) continue; const y = cellBox(r, ca).y + rows.size(r) - 1; const el = document.createElement("div"); el.className = "ox-gl h"; el.style.top = `${y}px`; el.style.left = `${left}px`; el.style.width = `${right - left}px`; frag.append(el); }
      f.prepend(frag);
    };
    lines(layers.body, rendered.r0, rendered.r1, rendered.c0, rendered.c1);
    lines(layers.top, 0, fz.r - 1, rendered.c0, rendered.c1);
    lines(layers.left, rendered.r0, rendered.r1, 0, fz.c - 1);
    lines(layers.corner, 0, fz.r - 1, 0, fz.c - 1);
    for (const [l, frag] of out) l.replaceChildren(frag);
    drawFilterButtons();
    drawSelection();
    drawOthers();
    drawHeaders();
    drawCharts();
  }
  function drawHeaders() {
    const fz = frozen(), s = sh();
    const vx = $scroll.scrollLeft, vy = $scroll.scrollTop;
    const fw = cols.pos(fz.c), fh = rows.pos(fz.r);
    const colEls = [], rowEls = [];
    const sc1 = Math.min(sel.c1, sel.c2), sc2 = Math.max(sel.c1, sel.c2), sr1 = Math.min(sel.r1, sel.r2), sr2 = Math.max(sel.r1, sel.r2);
    const colCell = (c, x) => { const w = cols.size(c); const el = h("div", { class: `ox-hc${c >= sc1 && c <= sc2 ? " on" : ""}`, dataset: { c } }, F().colName(c), !ctx.readOnly && h("span", { class: "ox-resize", dataset: { c } })); el.style.left = `${x}px`; el.style.width = `${w}px`; return el; };
    const rowCell = (r, y) => { const ht = rows.size(r); if (!ht) return null; const el = h("div", { class: `ox-hr${r >= sr1 && r <= sr2 ? " on" : ""}`, dataset: { r } }, String(r + 1), !ctx.readOnly && h("span", { class: "ox-resize", dataset: { r } })); el.style.top = `${y}px`; el.style.height = `${ht}px`; return el; };
    for (let c = 0; c < fz.c; c++) colEls.push(colCell(c, cols.pos(c)));
    for (let c = cols.at(vx + fw); cols.pos(c) - vx < $grid.clientWidth; c++) { if (c >= F().MAX_COLS) break; colEls.push(colCell(c, cols.pos(c) - vx)); }
    for (let r = 0; r < fz.r; r++) rowEls.push(rowCell(r, rows.pos(r)));
    for (let r = rows.at(vy + fh); rows.pos(r) - vy < $grid.clientHeight; r++) { if (r >= F().MAX_ROWS) break; rowEls.push(rowCell(r, rows.pos(r) - vy)); }
    $colHdr.replaceChildren(...colEls);
    $rowHdr.replaceChildren(...rowEls.filter(Boolean));
    $tabs.querySelector(".on")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    void s;
  }
  function box(cls, r1, c1, r2, c2, label) {
    // A rectangle over cells, split across the frozen panes it crosses.
    const fz = frozen();
    const parts = [];
    const spans = (a, b, f) => (b < f ? [[a, b]] : a >= f ? [[a, b]] : [[a, f - 1], [f, b]]);
    for (const [ra, rb] of spans(r1, r2, fz.r)) for (const [ca, cb] of spans(c1, c2, fz.c)) {
      const b = cellBox(ra, ca, rb, cb);
      if (b.w <= 0 || b.h <= 0) continue;
      const el = h("div", { class: cls });
      el.style.left = `${b.x}px`; el.style.top = `${b.y}px`; el.style.width = `${b.w}px`; el.style.height = `${b.h}px`;
      if (label && !parts.length) el.append(h("span", { class: "ox-who" }, label));
      b.layer.append(el);
      parts.push(el);
    }
    return parts;
  }
  const norm = () => {
    const s = sh();
    let r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2), c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2);
    const ext = M().extent(s);
    if (r2 === Infinity) r2 = Math.max(ext.rows - 1, 0);
    if (c2 === Infinity) c2 = Math.max(ext.cols - 1, 0);
    // Grown to cover merged cells it touches.
    for (let grew = true; grew;) { grew = false; for (const g of s.merges) if (g.r2 >= r1 && g.r1 <= r2 && g.c2 >= c1 && g.c1 <= c2 && (g.r1 < r1 || g.r2 > r2 || g.c1 < c1 || g.c2 > c2)) { r1 = Math.min(r1, g.r1); r2 = Math.max(r2, g.r2); c1 = Math.min(c1, g.c1); c2 = Math.max(c2, g.c2); grew = true; } }
    return { r1, r2, c1, c2 };
  };
  function drawSelection() {
    for (const l of Object.values(layers)) l.querySelectorAll(".ox-sel, .ox-active, .ox-fill").forEach((e) => e.remove());
    const { r1, r2, c1, c2 } = norm();
    const g = mergeAt(sh(), sel.r, sel.c);
    if (r1 !== r2 || c1 !== c2) box("ox-sel", r1, c1, Math.min(r2, rendered ? Math.max(rendered.r1, r1) : r2), Math.min(c2, rendered ? Math.max(rendered.c1, c1) : c2));
    box("ox-active", sel.r, sel.c, g ? g.r2 : sel.r, g ? g.c2 : sel.c);
    if (!ctx.readOnly) for (const p of box("ox-fill", r2, c2, r2, c2).slice(-1)) {
      p.title = "Drag to fill";
      // On the corner, as in Excel; tucked inside the cell at a frozen pane's edge, where the pane would cut it in half.
      const inside = p.parentNode !== layers.body;
      p.style.left = `${parseFloat(p.style.left) + parseFloat(p.style.width) - (inside ? 9 : 4)}px`; p.style.top = `${parseFloat(p.style.top) + parseFloat(p.style.height) - (inside ? 9 : 4)}px`;
      p.style.width = "8px"; p.style.height = "8px";
    }
    placeInput();
    drawHeaders();
    const s = sh(), cell = s.cells.get(`${sel.r},${sel.c}`);
    if (document.activeElement !== $name) $name.value = r1 === r2 && c1 === c2 ? F().addr(sel.r, sel.c) : `${F().addr(r1, c1)}:${F().addr(r2, c2)}`;
    if (!editing || editing.from !== "bar") $bar.value = editing ? $input.value : cell ? (cell.f || rawText(cell)) : "";
    syncToolbar(cell?.s || {});
    stats();
  }
  function drawOthers() {
    for (const l of Object.values(layers)) l.querySelectorAll(".ox-other").forEach((e) => e.remove());
    for (const p of othersNow) {
      const st = p.state;
      if (!st || st.sheet !== sheetId) continue;
      const parts = box("ox-other", Math.min(st.r1, st.r2), Math.min(st.c1, st.c2), Math.max(st.r1, st.r2), Math.max(st.c1, st.c2), p.name);
      parts.forEach((el) => { el.style.borderColor = p.color; const w = el.querySelector(".ox-who"); if (w) w.style.background = p.color; });
    }
  }
  function drawTabs() {
    const wb = wbNow();
    $tabs.replaceChildren(...wb.sheets.filter((s) => !s.hidden).map((s) => {
      const t = h("button", { type: "button", role: "tab", class: `ox-tab${s.id === sheetId ? " on" : ""}`, "aria-selected": s.id === sheetId ? "true" : "false",
        onclick: () => switchSheet(s.id), ondblclick: () => !ctx.readOnly && renameSheet(s),
        oncontextmenu: (e) => { e.preventDefault(); if (!ctx.readOnly) tabMenu(e.currentTarget, s); } }, s.name);
      if (!ctx.readOnly) t.addEventListener("keydown", (e) => { if (e.key === "F2") renameSheet(s); });
      return t;
    }), ...(wb.sheets.some((s) => s.hidden) && !ctx.readOnly ? [h("button", { type: "button", class: "ox-tab quiet", title: "Hidden sheets", onclick: (e) => W().popMenu(e.currentTarget, wb.sheets.filter((s) => s.hidden).map((s) => ({ label: `Show ${s.name}`, run: () => ctx.commit({ t: "sheetHide", id: s.id, hidden: false }) && full() }))) }, "…")] : []));
  }
  function full() { book.rebuild(); axes(); layout(); drawTabs(); draw(true); }
  function stats() {
    const { r1, r2, c1, c2 } = norm();
    if (r1 === r2 && c1 === c2) { $stats.textContent = ""; return; }
    let sum = 0, n = 0, count = 0;
    const s = sh();
    const each = (r, c) => { const v = book.value(s, r, c); if (v !== null && v !== "" && v !== undefined) count++; if (isNum(v)) { sum += v; n++; } };
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 20000) { for (const k of s.cells.keys()) { const [r, c] = k.split(",").map(Number); if (r >= r1 && r <= r2 && c >= c1 && c <= c2) each(r, c); } }
    else for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) each(r, c);
    const nf = (x) => F().formatGeneral(Math.round(x * 1e10) / 1e10);
    $stats.textContent = n ? `Sum ${nf(sum)} · Average ${nf(sum / n)} · Count ${count}` : count ? `Count ${count}` : "";
  }
  function syncToolbar(st) {
    if (ctx.readOnly) return;
    for (const k of ["b", "i", "u", "s", "wrap"]) btn[k]?.classList.toggle("on", !!st[k]);
    btn.left.classList.toggle("on", st.h === "left"); btn.center.classList.toggle("on", st.h === "center"); btn.right.classList.toggle("on", st.h === "right");
    fmt.value = FORMATS.some(([v]) => v === (st.nf || "General")) ? (st.nf || "General") : "custom";
    if (!FORMATS.some(([v]) => v === (st.nf || "General"))) fmt.querySelector('option[value="custom"]').textContent = st.nf;
    font.value = st.font || "Calibri";
    size.value = String(st.size || 11);
    btn.filter.classList.toggle("on", filters.has(sheetId));
  }
  const rawText = (cell) => {
    if (cell.v === null || cell.v === undefined) return "";
    if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
    if (isNum(cell.v) && cell.s?.nf && /[dmyhs]/i.test(cell.s.nf.replace(/"[^"]*"|\[(?![hms]+\])[^\]]*\]/gi, "")) && !/^\[?h\]?:mm$/.test(cell.s.nf)) return F().format(cell.v, cell.s.nf.includes("h") ? (dmy ? "dd/mm/yyyy hh:mm" : "mm/dd/yyyy hh:mm") : dmy ? "dd/mm/yyyy" : "mm/dd/yyyy").text;
    if (isNum(cell.v) && cell.s?.nf && cell.s.nf.includes("%")) return `${Math.round(cell.v * 1e12) / 1e10}%`;
    // Text that would be read as something else if typed again (a number, a date, TRUE, a formula) gets an apostrophe.
    if (typeof cell.v === "string" && (/^[=+-]/.test(cell.v) || typeof F().parseInput(cell.v, { dmy }).value !== "string")) return "'" + cell.v;
    return String(cell.v);
  };

  // ---- selection and moving
  function select(r, c, r2 = r, c2 = c, keepActive = false) {
    if (!keepActive) { sel.r = Math.min(r, F().MAX_ROWS - 1); sel.c = Math.min(c, F().MAX_COLS - 1); }
    sel.r1 = r; sel.c1 = c; sel.r2 = r2; sel.c2 = c2;
    drawSelection();
    scrollTo(keepActive ? Math.min(r2, F().MAX_ROWS - 1) : sel.r, keepActive ? Math.min(c2, F().MAX_COLS - 1) : sel.c);
    presence();
  }
  function presence() { const { r1, r2, c1, c2 } = norm(); ctx.presence({ sheet: sheetId, r1, c1, r2, c2 }); }
  function scrollTo(r, c) {
    const fz = frozen();
    if (r === Infinity || c === Infinity) return;
    if (r >= fz.r) { const y = rows.pos(r) - rows.pos(fz.r), hgt = rows.size(r); if (y < $scroll.scrollTop) $scroll.scrollTop = y; else if (y + hgt > $scroll.scrollTop + $scroll.clientHeight) $scroll.scrollTop = y + hgt - $scroll.clientHeight + 2; }
    if (c >= fz.c) { const x = cols.pos(c) - cols.pos(fz.c), w = cols.size(c); if (x < $scroll.scrollLeft) $scroll.scrollLeft = x; else if (x + w > $scroll.scrollLeft + $scroll.clientWidth) $scroll.scrollLeft = x + w - $scroll.clientWidth + 2; }
  }
  function moveBy(dr, dc, extend = false, jump = false) {
    const s = sh();
    let r = extend ? sel.r2 : sel.r, c = extend ? sel.c2 : sel.c;
    if (r === Infinity) r = M().extent(s).rows - 1;
    if (c === Infinity) c = M().extent(s).cols - 1;
    const g = !extend && mergeAt(s, r, c);
    if (g) { if (dr > 0) r = g.r2; if (dc > 0) c = g.c2; if (dr < 0) r = g.r1; if (dc < 0) c = g.c1; }
    if (jump) {
      // Ctrl+arrow: to the edge of the data.
      const has = (rr, cc) => { const x = s.cells.get(`${rr},${cc}`); return !!(x && (x.f || (x.v !== null && x.v !== ""))); };
      const ext = M().extent(s);
      const lim = dr ? (dr > 0 ? Math.max(ext.rows, r + 1) : 0) : dc > 0 ? Math.max(ext.cols, c + 1) : 0;
      let rr = r, cc = c;
      const step = () => { rr += dr; cc += dc; };
      const inside = () => rr >= 0 && cc >= 0 && (dr > 0 ? rr <= lim : dr < 0 ? rr >= 0 : true) && (dc > 0 ? cc <= lim : true);
      if (has(r, c) && has(r + dr, c + dc)) { while (inside() && has(rr + dr, cc + dc)) step(); }
      else { step(); while (inside() && !has(rr, cc)) step(); if (!inside()) { rr = dr > 0 ? ext.rows : dr < 0 ? 0 : rr; cc = dc > 0 ? ext.cols : dc < 0 ? 0 : cc; } }
      r = rr; c = cc;
    } else { r += dr; c += dc; while (hiddenRows.has(r) && r > 0) r += dr || 1; }
    r = Math.max(0, Math.min(r, F().MAX_ROWS - 1)); c = Math.max(0, Math.min(c, F().MAX_COLS - 1));
    if (extend) select(sel.r1, sel.c1, r, c, true); else select(r, c);
  }
  function goTo(text) {
    const m = /^\s*(?:'?([^!]+?)'?!)?([A-Z]+\d+)(?::([A-Z]+\d+))?\s*$/i.exec(text);
    if (!m) { ctx.toast("Type a cell like B12, or a range like A1:C9."); return; }
    if (m[1]) { const t = wbNow().sheets.find((s) => s.name.toLowerCase() === m[1].toLowerCase()); if (t) switchSheet(t.id); }
    const a = /^([A-Z]+)(\d+)$/i.exec(m[2]), b = m[3] && /^([A-Z]+)(\d+)$/i.exec(m[3]);
    const r = +a[2] - 1, c = F().colIndex(a[1].toUpperCase());
    if (b) select(r, c, +b[2] - 1, F().colIndex(b[1].toUpperCase())); else select(r, c);
    focusGrid();
  }
  function switchSheet(id) {
    if (editing) commitEdit();
    sheetId = id;
    sel = { r: 0, c: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
    $scroll.scrollTop = 0; $scroll.scrollLeft = 0;
    rendered = null;
    axes(); layout(); drawTabs(); draw(true); presence();
    focusGrid();
  }
  const touch = matchMedia("(pointer: coarse)").matches;
  function focusGrid() { if (!touch || editing) $input.focus({ preventScroll: true }); else $grid.focus({ preventScroll: true }); }

  // ---- editing
  function placeInput() {
    const g = mergeAt(sh(), sel.r, sel.c);
    const b = cellBox(sel.r, sel.c, g ? g.r2 : sel.r, g ? g.c2 : sel.c);
    const gr = $grid.getBoundingClientRect(), lr = b.layer.getBoundingClientRect();
    $input.style.left = `${lr.left - gr.left + b.x}px`;
    $input.style.top = `${lr.top - gr.top + b.y}px`;
    $input.style.minWidth = `${b.w}px`;
    $input.style.height = `${Math.max(b.h, DEF_H)}px`;
    $input.classList.toggle("on", !!editing);
    if (editing) { const st = sh().cells.get(`${sel.r},${sel.c}`)?.s || {}; $input.style.fontWeight = st.b ? "700" : ""; $input.style.fontStyle = st.i ? "italic" : ""; $input.style.textAlign = st.h || ""; }
  }
  function startEdit(from, text = null) {
    if (ctx.readOnly) return;
    const cell = sh().cells.get(`${sel.r},${sel.c}`);
    editing = { r: sel.r, c: sel.c, from };
    $input.value = text ?? (cell ? cell.f || rawText(cell) : "");
    $bar.value = $input.value;
    placeInput();
    if (from === "bar") $bar.focus(); else { $input.focus(); const n = $input.value.length; $input.setSelectionRange(n, n); }
    autoSize();
  }
  function autoSize() { $input.style.width = "0"; $input.style.width = `${Math.min(600, Math.max($input.scrollWidth + 8, parseFloat($input.style.minWidth) || 0))}px`; }
  function cancelEdit() { editing = null; $input.value = ""; $suggest.hidden = true; drawSelection(); focusGrid(); }
  /** What was typed, into the cell: a formula, a number (with the format it suggests), a date, text. */
  function commitEdit() {
    if (!editing) return true;
    const raw = (editing.from === "bar" ? $bar.value : $input.value);
    const { r, c } = editing;
    $suggest.hidden = true;
    const s = sh(), cell = s.cells.get(`${r},${c}`);
    const ops = [];
    if (raw.startsWith("=") && raw.length > 1) {
      let src = raw;
      // Brackets left open are closed, as spreadsheets do.
      const open = (src.match(/\(/g) || []).length - (src.match(/\)/g) || []).length;
      if (open > 0 && !/"[^"]*$/.test(src)) src += ")".repeat(open);
      try { F().parse(src); } catch (err) { ctx.toast(`There's a problem with this formula: ${err.message}`); return false; }
      if (src !== (cell?.f || "")) ops.push({ t: "set", sheet: s.id, cells: [[r, c, { f: src }]] });
    } else if (raw.startsWith("'")) {
      ops.push({ t: "set", sheet: s.id, cells: [[r, c, { v: raw.slice(1) }]] });
    } else {
      const p = F().parseInput(raw, { dmy });
      const keepText = cell?.s?.nf === "@";
      const v = keepText ? (raw === "" ? null : raw) : p.value;
      if (v !== (cell?.f ? undefined : cell?.v ?? null) || cell?.f) ops.push({ t: "set", sheet: s.id, cells: [[r, c, v === null ? null : { v }]] });
      if (!keepText && p.format && (!cell?.s?.nf || (p.type === "date") !== /[dmy]/i.test(cell.s.nf))) ops.push({ t: "style", sheet: s.id, cells: [[r, c, { nf: p.format }]] });
    }
    editing = null;
    $input.value = "";
    if (ops.length) change(ops, { group: null });
    else drawSelection();
    return true;
  }
  /** Ops made here: shared, then drawn. */
  function change(ops, o = {}) {
    const results = ctx.commit(ops, o);
    const structure = results.some((x) => x && (x.structure || x.sheets || x.formulas));
    if (structure) { full(); return; }
    const byKeys = new Map();
    for (const x of results) if (x && x.cells && x.cells !== "all") { if (!byKeys.has(x.sheet)) byKeys.set(x.sheet, []); byKeys.get(x.sheet).push(...x.cells); }
    for (const [sid, keys] of byKeys) book.changed(sid, keys);
    draw(true);
  }

  // Formula help: function names as you type them.
  function suggest() {
    const v = $input.value, at = $input.selectionStart;
    const m = /(?:^=|[=(,;+\-*/&^<>:\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(v.slice(0, at));
    if (!v.startsWith("=") || !m) { $suggest.hidden = true; return; }
    const word = m[1].toUpperCase();
    const list = F().FUNCTIONS.filter((f) => f.startsWith(word)).slice(0, 8);
    if (!list.length || (list.length === 1 && list[0] === word)) { $suggest.hidden = true; return; }
    $suggest.replaceChildren(...list.map((f, i) => h("div", { class: `ox-sug${i === 0 ? " on" : ""}`, role: "option", onmousedown: (e) => { e.preventDefault(); pick(f); } }, f)));
    $suggest.hidden = false;
    $suggest.style.left = $input.style.left;
    $suggest.style.top = `${parseFloat($input.style.top) + $input.offsetHeight}px`;
    function pick(f) { const before = v.slice(0, at - m[1].length), after = v.slice(at); $input.value = `${before}${f}(${after}`; const p = before.length + f.length + 1; $input.setSelectionRange(p, p); $suggest.hidden = true; $bar.value = $input.value; autoSize(); }
    $suggest.pick = () => pick($suggest.querySelector(".on").textContent);
  }
  /** While typing a formula, clicking a cell puts its address in. */
  const pointing = () => editing && $input.value.startsWith("=") && /[=(,;+\-*/&^<>:]\s*$/.test($input.value.slice(0, $input.selectionStart));

  // ---- keyboard
  $input.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!$suggest.hidden && (e.key === "Tab" || e.key === "Enter") && $suggest.pick) { e.preventDefault(); $suggest.pick(); return; }
    if (!$suggest.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault(); const items = [...$suggest.children]; const i = items.findIndex((x) => x.classList.contains("on")); items[i]?.classList.remove("on"); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].classList.add("on"); return;
    }
    if (editing) {
      if (e.key === "Enter" && e.altKey) { e.preventDefault(); $input.setRangeText("\n", $input.selectionStart, $input.selectionEnd, "end"); autoSize(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); if (commitEdit()) moveBy(e.key === "Tab" ? 0 : e.shiftKey ? -1 : 1, e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); return; }
      if (editing.from === "type" && /^Arrow/.test(e.key) && !pointing()) { e.preventDefault(); if (commitEdit()) moveBy(e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0, e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0); return; }
      return;
    }
    // Not editing: the grid's keys.
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); moveBy(k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0, k === "ArrowRight" ? 1 : k === "ArrowLeft" ? -1 : 0, e.shiftKey, mod); return; }
    if (k === "Enter") { e.preventDefault(); moveBy(e.shiftKey ? -1 : 1, 0); return; }
    if (k === "Tab") { e.preventDefault(); moveBy(0, e.shiftKey ? -1 : 1); return; }
    if (k === "PageDown" || k === "PageUp") { e.preventDefault(); moveBy((k === "PageDown" ? 1 : -1) * Math.max(1, Math.floor($scroll.clientHeight / DEF_H) - 1), 0, e.shiftKey); return; }
    if (k === "Home") { e.preventDefault(); if (mod) select(0, 0); else select(sel.r, 0); return; }
    if (k === "End" && mod) { e.preventDefault(); const x = M().extent(sh()); select(Math.max(0, x.rows - 1), Math.max(0, x.cols - 1)); return; }
    if (k === "F2") { e.preventDefault(); startEdit("edit"); return; }
    if ((k === "Delete" || k === "Backspace") && !ctx.readOnly) { e.preventDefault(); clearContents(); return; }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); select(0, 0, Infinity, Infinity); return; }
    if (mod && k.toLowerCase() === "b") { e.preventDefault(); toggle("b"); return; }
    if (mod && k.toLowerCase() === "i") { e.preventDefault(); toggle("i"); return; }
    if (mod && k.toLowerCase() === "u") { e.preventDefault(); toggle("u"); return; }
    if (mod && k.toLowerCase() === "f") { e.preventDefault(); findBar(); return; }
    if (mod && k.toLowerCase() === "d" && !ctx.readOnly) { e.preventDefault(); fillFrom("down"); return; }
    if (mod && k.toLowerCase() === "r" && !ctx.readOnly) { e.preventDefault(); fillFrom("right"); return; }
    if (mod && k === ";" && !ctx.readOnly) { e.preventDefault(); const d = new Date(); startEdit("type", F().format(F().serial(d.getFullYear(), d.getMonth() + 1, d.getDate()), dmy ? "dd/mm/yyyy" : "mm/dd/yyyy").text); return; }
    if (k === " " && e.shiftKey) { e.preventDefault(); select(sel.r, 0, sel.r, Infinity); return; }
    if (k === " " && mod) { e.preventDefault(); select(0, sel.c, Infinity, sel.c); return; }
    if (k === "Escape" && clip?.cut) { clip = null; draw(true); return; }
    if (k === "ContextMenu" || (k === "F10" && e.shiftKey)) { e.preventDefault(); cellMenu($input); return; }
    if (!mod && !e.altKey && k.length === 1 && !ctx.readOnly) { /* typing starts editing: the character arrives in the input */ startEdit("type", ""); }
  });
  $input.addEventListener("input", () => {
    if (!editing) { if ($input.value && !ctx.readOnly) { const v = $input.value; startEdit("type", v); } else $input.value = ""; return; }
    $bar.value = $input.value;
    autoSize();
    suggest();
  });
  $grid.addEventListener("keydown", (e) => { if (e.target === $grid) { /* touch: no input focused */ if (e.key.length === 1 || e.key.startsWith("Arrow") || e.key === "Enter") { $input.focus(); $input.dispatchEvent(new KeyboardEvent("keydown", e)); } } });
  $bar.addEventListener("focus", () => { if (!ctx.readOnly && !editing) { editing = { r: sel.r, c: sel.c, from: "bar" }; placeInput(); } });
  $bar.addEventListener("input", () => { if (editing) { $input.value = $bar.value; } });
  $bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (commitEdit()) { moveBy(1, 0); focusGrid(); } }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    else if (e.key === "Tab") { e.preventDefault(); if (commitEdit()) { moveBy(0, e.shiftKey ? -1 : 1); focusGrid(); } }
  });
  $bar.addEventListener("blur", () => { if (editing?.from === "bar") setTimeout(() => { if (editing?.from === "bar" && document.activeElement !== $bar) commitEdit(); }, 100); });

  // ---- mouse and touch
  let drag = null;
  $grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const t = e.target;
    if (chartSel) { chartSel = null; drawCharts(); }
    if (t.closest(".ox-filterbtn")) return;
    if (t.classList.contains("ox-resize")) { startResize(e, t); return; }
    if (t.closest(".ox-hc")) { const c = +t.closest(".ox-hc").dataset.c; if (e.shiftKey) select(0, sel.c1, Infinity, c, true); else select(0, c, Infinity, c); sel.r = 0; drag = { kind: "cols", c }; focusGrid(); return; }
    if (t.closest(".ox-hr")) { const r = +t.closest(".ox-hr").dataset.r; if (e.shiftKey) select(sel.r1, 0, r, Infinity, true); else select(r, 0, r, Infinity); drag = { kind: "rows", r }; focusGrid(); return; }
    if (t === $input || t === $suggest || $suggest.contains(t) || t === $all) return;
    if (!t.closest(".ox-scroll, .ox-pane")) return;
    const p = cellAt(e.clientX, e.clientY);
    if (t.classList.contains("ox-fill")) { e.preventDefault(); drag = { kind: "fill", from: norm(), to: null }; $grid.setPointerCapture(e.pointerId); return; }
    if (pointing()) {
      e.preventDefault();
      drag = { kind: "point", start: p, at: $input.selectionStart, len: 0 };
      insertRef(p, p); $grid.setPointerCapture(e.pointerId); return;
    }
    if (editing) commitEdit();
    // Touch: dragging scrolls, unless it starts on the selected cell (then it selects).
    if (e.pointerType === "touch" && !(p.r === sel.r && p.c === sel.c)) { drag = { kind: "tap", p, x: e.clientX, y: e.clientY, t: Date.now() }; return; }
    if (e.shiftKey) select(sel.r, sel.c, p.r, p.c, true);
    else select(p.r, p.c);
    drag = { kind: "cells" };
    $grid.setPointerCapture(e.pointerId);
    if (e.pointerType !== "touch") { e.preventDefault(); focusGrid(); }
  });
  $grid.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.kind === "tap") return;
    const p = cellAt(e.clientX, e.clientY);
    if (drag.kind === "cells") { if (p.r !== sel.r2 || p.c !== sel.c2) select(sel.r1, sel.c1, p.r, p.c, true); }
    else if (drag.kind === "cols") select(0, Math.min(drag.c, sel.c1), Infinity, p.c, true);
    else if (drag.kind === "rows") select(Math.min(drag.r, sel.r1), 0, p.r, Infinity, true);
    else if (drag.kind === "point") insertRef(drag.start, p);
    else if (drag.kind === "fill") {
      const f = drag.from;
      const down = p.r > f.r2 ? p.r - f.r2 : p.r < f.r1 ? p.r - f.r1 : 0, across = p.c > f.c2 ? p.c - f.c2 : p.c < f.c1 ? p.c - f.c1 : 0;
      const vertical = Math.abs(down) >= Math.abs(across);
      drag.to = vertical ? { r1: Math.min(f.r1, p.r), r2: Math.max(f.r2, p.r), c1: f.c1, c2: f.c2 } : { r1: f.r1, r2: f.r2, c1: Math.min(f.c1, p.c), c2: Math.max(f.c2, p.c) };
      for (const l of Object.values(layers)) l.querySelectorAll(".ox-fillto").forEach((x) => x.remove());
      box("ox-fillto", drag.to.r1, drag.to.c1, drag.to.r2, drag.to.c2);
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (drag.kind === "tap") {
      if (Math.abs(e.clientX - drag.x) < 8 && Math.abs(e.clientY - drag.y) < 8) {
        const p = drag.p;
        const again = p.r === sel.r && p.c === sel.c;
        if (again) startEdit("edit"); else select(p.r, p.c);
      }
    } else if (drag.kind === "fill" && drag.to) {
      for (const l of Object.values(layers)) l.querySelectorAll(".ox-fillto").forEach((x) => x.remove());
      fill(drag.from, drag.to);
    }
    drag = null;
  };
  $grid.addEventListener("pointerup", endDrag);
  $grid.addEventListener("pointercancel", () => { drag = null; });
  $grid.addEventListener("dblclick", (e) => {
    if (e.target.classList.contains("ox-fill")) { fillDownToData(); return; }
    if (e.target.classList.contains("ox-resize")) { autoFit(e.target); return; }
    if (e.target.closest(".ox-scroll, .ox-pane") && !ctx.readOnly) startEdit("edit");
  });
  $grid.addEventListener("contextmenu", (e) => {
    if (e.target === $input && editing) return;
    e.preventDefault();
    const hc = e.target.closest(".ox-hc"), hr = e.target.closest(".ox-hr");
    if (hc && !(sel.r1 === 0 && sel.r2 === Infinity)) { const c = +hc.dataset.c; select(0, c, Infinity, c); }
    else if (hr && !(sel.c1 === 0 && sel.c2 === Infinity)) { const r = +hr.dataset.r; select(r, 0, r, Infinity); }
    else if (!hc && !hr) { const p = cellAt(e.clientX, e.clientY); const n = norm(); if (p.r < n.r1 || p.r > n.r2 || p.c < n.c1 || p.c > n.c2) select(p.r, p.c); }
    cellMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), focus: focusGrid });
  });
  let pressTimer = null;
  $grid.addEventListener("touchstart", (e) => { if (e.touches.length !== 1) return; const t = e.touches[0]; pressTimer = setTimeout(() => { const p = cellAt(t.clientX, t.clientY); select(p.r, p.c); cellMenu({ getBoundingClientRect: () => ({ left: t.clientX, right: t.clientX, top: t.clientY, bottom: t.clientY }), focus: focusGrid }); drag = null; }, 550); }, { passive: true });
  $grid.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });
  $grid.addEventListener("touchend", () => clearTimeout(pressTimer));
  function insertRef(a, b) {
    const ref = a.r === b.r && a.c === b.c ? F().addr(a.r, a.c) : `${F().addr(Math.min(a.r, b.r), Math.min(a.c, b.c))}:${F().addr(Math.max(a.r, b.r), Math.max(a.c, b.c))}`;
    const v = $input.value;
    const start = drag?.kind === "point" ? drag.at : $input.selectionStart;
    const len = drag?.kind === "point" ? drag.len : 0;
    $input.value = v.slice(0, start) + ref + v.slice(start + len);
    if (drag?.kind === "point") drag.len = ref.length;
    $input.setSelectionRange(start + ref.length, start + ref.length);
    $bar.value = $input.value;
    autoSize();
    $input.focus();
  }
  function startResize(e, handle) {
    e.preventDefault(); e.stopPropagation();
    const isCol = handle.dataset.c !== undefined, i = +(isCol ? handle.dataset.c : handle.dataset.r);
    const startPos = isCol ? e.clientX : e.clientY, startSize = isCol ? cols.size(i) : rows.size(i);
    const guide = h("div", { class: `ox-guide ${isCol ? "v" : "h"}` });
    $grid.append(guide);
    const at = (ev) => Math.max(isCol ? 20 : 12, startSize + (isCol ? ev.clientX : ev.clientY) - startPos);
    const g = $grid.getBoundingClientRect();
    const show = (ev) => { if (isCol) guide.style.left = `${ev.clientX - g.left}px`; else guide.style.top = `${ev.clientY - g.top}px`; };
    show(e);
    const move = (ev) => show(ev);
    const up = (ev) => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); guide.remove();
      const px = at(ev);
      if (Math.abs(px - startSize) < 2) return;
      // Several selected columns or rows: all take the size.
      const n = norm();
      const list = isCol && sel.r2 === Infinity && i >= n.c1 && i <= n.c2 ? range(n.c1, n.c2) : !isCol && sel.c2 === Infinity && i >= n.r1 && i <= n.r2 ? range(n.r1, n.r2) : [i];
      change(list.map((x) => ({ t: "size", sheet: sheetId, axis: isCol ? "c" : "r", i: x, px })));
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  const range = (a, b) => Array.from({ length: Math.min(b - a + 1, 500) }, (_, k) => a + k);
  function autoFit(handle) {
    if (handle.dataset.c === undefined || ctx.readOnly) return;
    const c = +handle.dataset.c, s = sh();
    const meas = document.createElement("canvas").getContext("2d");
    let w = 30;
    for (const [k] of s.cells) { const [r, cc] = k.split(",").map(Number); if (cc !== c) continue; const st = s.cells.get(k).s || {}; meas.font = `${st.b ? "700 " : ""}${(st.size || 11) * 4 / 3}px ${st.font || "Calibri, Carlito, sans-serif"}`; w = Math.max(w, meas.measureText(display(s, r, c).text).width + 14); }
    change({ t: "size", sheet: sheetId, axis: "c", i: c, px: Math.min(600, Math.ceil(w)) });
  }
  $scroll.addEventListener("scroll", () => { sync(); requestAnimationFrame(() => { const e = extentPx(); if (e.w > parseFloat($space.style.width) || e.h > parseFloat($space.style.height)) { $space.style.width = `${e.w}px`; $space.style.height = `${e.h}px`; } draw(); placeInput(); }); }, { passive: true });
  const ro = new ResizeObserver(() => { rendered = null; draw(true); });
  ro.observe($grid);

  // ---- formatting
  function cellStyle() { return sh().cells.get(`${sel.r},${sel.c}`)?.s || {}; }
  /** Every cell in the selection (capped to the data for whole rows and columns). */
  function selCells(includeEmpty = true) {
    const { r1, r2, c1, c2 } = norm();
    const out = [];
    const s = sh();
    if (!includeEmpty || (r2 - r1 + 1) * (c2 - c1 + 1) > 50000) { for (const k of s.cells.keys()) { const [r, c] = k.split(",").map(Number); if (r >= r1 && r <= r2 && c >= c1 && c <= c2) out.push([r, c]); } return out; }
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push([r, c]);
    return out;
  }
  function styleSel(patch) { if (ctx.readOnly) return; change({ t: "style", sheet: sheetId, cells: selCells().map(([r, c]) => [r, c, patch]) }); }
  function toggle(k) { styleSel({ [k]: cellStyle()[k] ? null : true }); }
  function decimals(d) {
    const st = cellStyle();
    let nf = st.nf || "General";
    if (nf === "General") { const v = book.value(sh(), sel.r, sel.c); const places = isNum(v) ? Math.min(10, (String(v).split(".")[1] || "").length) : 0; nf = places ? "0." + "0".repeat(places) : "0"; }
    nf = nf.split(";").map((sec) => sec.replace(/0(\.0*)?(?=[^0.]*$)|0(\.0*)?(?=%)/, (m) => { const n = Math.max(0, (m.split(".")[1] || "").length + d); return n ? "0." + "0".repeat(n) : "0"; })).join(";");
    styleSel({ nf });
  }
  function bordersMenu(anchor) {
    const set = (fn) => { const { r1, r2, c1, c2 } = norm(); change({ t: "style", sheet: sheetId, cells: selCells().map(([r, c]) => [r, c, { border: fn(r, c, r1, r2, c1, c2, sh().cells.get(`${r},${c}`)?.s?.border || {}) }]) }); };
    const pick = (o) => (Object.keys(o).length ? o : null);
    W().popMenu(anchor, [
      { label: "All borders", run: () => set(() => ({ t: 1, r: 1, b: 1, l: 1 })) },
      { label: "Outside borders", run: () => set((r, c, r1, r2, c1, c2, cur) => pick({ ...cur, ...(r === r1 ? { t: 1 } : {}), ...(r === r2 ? { b: 1 } : {}), ...(c === c1 ? { l: 1 } : {}), ...(c === c2 ? { r: 1 } : {}) })) },
      { label: "Thick outside borders", run: () => set((r, c, r1, r2, c1, c2, cur) => pick({ ...cur, ...(r === r1 ? { t: 2 } : {}), ...(r === r2 ? { b: 2 } : {}), ...(c === c1 ? { l: 2 } : {}), ...(c === c2 ? { r: 2 } : {}) })) },
      { label: "Bottom border", run: () => set((r, c, r1, r2, c1, c2, cur) => (r === r2 ? { ...cur, b: 1 } : pick(cur))) },
      { label: "Thick bottom border", run: () => set((r, c, r1, r2, c1, c2, cur) => (r === r2 ? { ...cur, b: 2 } : pick(cur))) },
      { label: "Double bottom (totals)", run: () => set((r, c, r1, r2, c1, c2, cur) => (r === r2 ? { ...cur, b: 3 } : pick(cur))) },
      { label: "Top border", run: () => set((r, c, r1, r2, c1, c2, cur) => (r === r1 ? { ...cur, t: 1 } : pick(cur))) },
      null, { label: "No borders", run: () => set(() => null) },
    ]);
  }
  function mergeToggle() {
    const { r1, r2, c1, c2 } = norm();
    const s = sh();
    const has = s.merges.some((g) => g.r2 >= r1 && g.r1 <= r2 && g.c2 >= c1 && g.c1 <= c2);
    if (has) { change({ t: "merge", sheet: sheetId, r1, c1, r2, c2, on: false }); return; }
    if (r1 === r2 && c1 === c2) return;
    const others = selCells(false).filter(([r, c]) => (r !== r1 || c !== c1) && (s.cells.get(`${r},${c}`)?.v != null || s.cells.get(`${r},${c}`)?.f));
    if (others.length && !confirm("Merging keeps only the top-left cell's contents. Merge anyway?")) return;
    const ops = [];
    if (others.length) ops.push({ t: "set", sheet: sheetId, cells: others.map(([r, c]) => [r, c, null]) });
    ops.push({ t: "merge", sheet: sheetId, r1, c1, r2, c2, on: true });
    if (!s.cells.get(`${r1},${c1}`)?.s?.h) ops.push({ t: "style", sheet: sheetId, cells: [[r1, c1, { h: "center" }]] });
    change(ops);
  }
  function clearFormat() { change({ t: "style", sheet: sheetId, cells: selCells(false).map(([r, c]) => [r, c, Object.fromEntries(Object.keys(sh().cells.get(`${r},${c}`)?.s || {}).map((k) => [k, null]))]) }); }
  function clearContents() {
    const cells = selCells(false).filter(([r, c]) => { const x = sh().cells.get(`${r},${c}`); return x && (x.f || x.v != null); });
    if (cells.length) change({ t: "set", sheet: sheetId, cells: cells.map(([r, c]) => [r, c, null]) });
  }
  function autoSum() {
    const s = sh();
    const n = norm();
    // A total under the numbers above (or beside the ones to the left).
    let r = n.r2 === n.r1 ? sel.r : n.r2 + 1, c = sel.c;
    let top = r - 1;
    while (top >= 0 && isNum(book.value(s, top, c))) top--;
    if (n.r2 > n.r1) { top = n.r1 - 1; c = n.c1; }
    if (top < r - 1) { change({ t: "set", sheet: sheetId, cells: [[r, c, { f: `=SUM(${F().addr(top + 1, c)}:${F().addr(r - 1, c)})` }]] }); select(r, c); return; }
    let left = c - 1;
    while (left >= 0 && isNum(book.value(s, sel.r, left))) left--;
    if (left < c - 1) { change({ t: "set", sheet: sheetId, cells: [[sel.r, c, { f: `=SUM(${F().addr(sel.r, left + 1)}:${F().addr(sel.r, c - 1)})` }]] }); return; }
    startEdit("type", "=SUM()"); $input.setSelectionRange(5, 5);
  }

  // ---- rows, columns, sheets
  function rowsMenu(anchor) {
    const n = norm();
    const nr = n.r2 - n.r1 + 1, nc = n.c2 - n.c1 + 1;
    const name = sh().name;
    const rowsWord = nr > 1 ? `${nr} rows` : "row", colsWord = nc > 1 ? `${nc} columns` : "column";
    W().popMenu(anchor, [
      { label: `Insert ${rowsWord} above`, run: () => change({ t: "ins", sheet: sheetId, name, axis: "r", at: n.r1, n: Math.min(nr, 1000) }) },
      { label: `Insert ${rowsWord} below`, run: () => change({ t: "ins", sheet: sheetId, name, axis: "r", at: n.r2 + 1, n: Math.min(nr, 1000) }) },
      { label: `Insert ${colsWord} left`, run: () => change({ t: "ins", sheet: sheetId, name, axis: "c", at: n.c1, n: Math.min(nc, 100) }) },
      { label: `Insert ${colsWord} right`, run: () => change({ t: "ins", sheet: sheetId, name, axis: "c", at: n.c2 + 1, n: Math.min(nc, 100) }) },
      null,
      { label: `Delete ${rowsWord}`, class: "danger", run: () => { change({ t: "del", sheet: sheetId, name, axis: "r", at: n.r1, n: nr }); select(n.r1, sel.c); } },
      { label: `Delete ${colsWord}`, class: "danger", run: () => { change({ t: "del", sheet: sheetId, name, axis: "c", at: n.c1, n: nc }); select(sel.r, n.c1); } },
    ]);
  }
  function freezeMenu(anchor) {
    const fz = frozen();
    W().popMenu(anchor, [
      { label: "Freeze top row", run: () => change({ t: "freeze", sheet: sheetId, r: 1, c: fz.c }) },
      { label: "Freeze first column", run: () => change({ t: "freeze", sheet: sheetId, r: fz.r, c: 1 }) },
      { label: `Freeze up to ${F().addr(sel.r, sel.c)}`, hint: "rows above, columns to the left", run: () => change({ t: "freeze", sheet: sheetId, r: sel.r, c: sel.c }) },
      (fz.r || fz.c) && { label: "Unfreeze", run: () => change({ t: "freeze", sheet: sheetId, r: 0, c: 0 }) },
    ].filter(Boolean));
  }
  function addSheet() {
    const wb = wbNow();
    let n = wb.sheets.length + 1;
    while (wb.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
    const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    change({ t: "sheet", id, name: `Sheet${n}`, at: wb.sheets.findIndex((s) => s.id === sheetId) + 1 });
    switchSheet(id);
  }
  function renameSheet(s) {
    const name = prompt("Sheet name", s.name);
    if (name && name.trim() && name !== s.name) change({ t: "sheetName", id: s.id, name: name.trim() });
  }
  function tabMenu(anchor, s) {
    const wb = wbNow(), i = wb.sheets.indexOf(s);
    W().popMenu(anchor, [
      { label: "Rename", run: () => renameSheet(s) },
      { label: "Duplicate", run: () => { const id = "s" + Date.now().toString(36); change({ t: "sheetData", id, at: i + 1, sheet: { ...s, name: `${s.name} (copy)` } }); switchSheet(id); } },
      i > 0 && { label: "Move left", run: () => change({ t: "sheetMove", id: s.id, at: i - 1 }) },
      i < wb.sheets.length - 1 && { label: "Move right", run: () => change({ t: "sheetMove", id: s.id, at: i + 1 }) },
      wb.sheets.filter((x) => !x.hidden).length > 1 && { label: "Hide", run: () => { change({ t: "sheetHide", id: s.id, hidden: true }); switchSheet(wb.sheets.find((x) => !x.hidden && x !== s).id); } },
      null,
      wb.sheets.length > 1 && { label: "Delete", class: "danger", run: () => { if (!confirm(`Delete the sheet “${s.name}”? (Undo brings it back.)`)) return; const next = wb.sheets.find((x) => x !== s && !x.hidden) || wb.sheets.find((x) => x !== s); change({ t: "sheetDel", id: s.id }); switchSheet(next.id); } },
    ].filter((x) => x !== false && x !== undefined));
  }
  function cellMenu(anchor) {
    const n = norm();
    const items = [
      { label: "Cut", hint: "Ctrl+X", run: () => copy(true) },
      { label: "Copy", hint: "Ctrl+C", run: () => copy(false) },
      { label: "Paste", hint: "Ctrl+V", run: async () => { try { const t = await navigator.clipboard.readText(); paste(t, null); } catch { ctx.toast("Use Ctrl+V (or ⌘V) to paste: the browser doesn't allow this button to read the clipboard."); } } },
      null,
    ];
    if (!ctx.readOnly) {
      const name = sh().name;
      if (sel.c2 === Infinity) items.push({ label: "Insert row above", run: () => change({ t: "ins", sheet: sheetId, name, axis: "r", at: n.r1, n: n.r2 - n.r1 + 1 }) }, { label: "Delete rows", class: "danger", run: () => change({ t: "del", sheet: sheetId, name, axis: "r", at: n.r1, n: n.r2 - n.r1 + 1 }) });
      else if (sel.r2 === Infinity) items.push({ label: "Insert column left", run: () => change({ t: "ins", sheet: sheetId, name, axis: "c", at: n.c1, n: n.c2 - n.c1 + 1 }) }, { label: "Delete columns", class: "danger", run: () => change({ t: "del", sheet: sheetId, name, axis: "c", at: n.c1, n: n.c2 - n.c1 + 1 }) });
      else items.push({ label: "Insert…", run: () => rowsMenu(anchor) });
      items.push({ label: "Clear contents", hint: "Delete", run: clearContents }, { label: "Clear formatting", run: clearFormat }, null);
    }
    const pv = pivotAt(sel.r, sel.c);
    if (pv && !ctx.readOnly) items.push({ label: "Edit pivot table…", run: () => pivotPanel(pv.id, anchor) }, { label: "Refresh pivot table", run: () => pivotRefresh(pv.id) }, null);
    items.push({ label: "Sort A → Z", run: () => sortRange(1) }, { label: "Sort Z → A", run: () => sortRange(-1) }, { label: "Comment", run: () => ctx.comment(anchorFor(sel.r, sel.c)) });
    W().popMenu(anchor, items.filter((x, i, a) => !(x === null && (i === 0 || a[i - 1] === null || i === a.length - 1))));
  }

  // ---- clipboard
  function grab(cut) {
    const { r1, r2, c1, c2 } = norm();
    const s = sh();
    const rowsOut = [], cells = new Map();
    for (let r = r1; r <= Math.min(r2, r1 + 20000); r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) { const cell = s.cells.get(`${r},${c}`); row.push(display(s, r, c).text); if (cell) cells.set(`${r - r1},${c - c1}`, cell); }
      rowsOut.push(row);
    }
    const tsv = rowsOut.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");
    clip = { tsv, cells, h: rowsOut.length, w: c2 - c1 + 1, from: { r: r1, c: c1 }, cut: cut ? { sheet: s.id, r1, c1, r2, c2 } : null };
    const table = document.createElement("table");
    rowsOut.forEach((r) => { const tr = table.insertRow(); r.forEach((v) => { tr.insertCell().textContent = v; }); });
    return { tsv, html: table.outerHTML };
  }
  function copy(cut) {
    const { tsv, html } = grab(cut);
    navigator.clipboard?.write?.([new ClipboardItem({ "text/plain": new Blob([tsv], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]).catch(() => navigator.clipboard?.writeText(tsv));
    draw(true);
    if (cut) box("ox-cutbox", norm().r1, norm().c1, norm().r2, norm().c2);
  }
  $input.addEventListener("copy", (e) => { if (editing) return; e.preventDefault(); const { tsv, html } = grab(false); e.clipboardData.setData("text/plain", tsv); e.clipboardData.setData("text/html", html); });
  $input.addEventListener("cut", (e) => { if (editing) return; e.preventDefault(); const { tsv, html } = grab(!ctx.readOnly); e.clipboardData.setData("text/plain", tsv); e.clipboardData.setData("text/html", html); if (!ctx.readOnly) box("ox-cutbox", norm().r1, norm().c1, norm().r2, norm().c2); });
  $input.addEventListener("paste", (e) => { if (editing || ctx.readOnly) return; e.preventDefault(); paste(e.clipboardData.getData("text/plain"), e.clipboardData.getData("text/html")); });
  function paste(text, html) {
    if (ctx.readOnly) return;
    const s = sh();
    const at = { r: Math.min(sel.r1, sel.r2), c: Math.min(sel.c1, sel.c2) };
    const ops = [];
    if (clip && text.replace(/\r/g, "") === clip.tsv) {
      // From this spreadsheet: formulas move with the cells, formatting comes too. A selection that's a whole multiple repeats it.
      const n = norm();
      const reps = (n.r2 - n.r1 + 1) % clip.h === 0 && (n.c2 - n.c1 + 1) % clip.w === 0 && (n.r2 > n.r1 || n.c2 > n.c1) ? { r: (n.r2 - n.r1 + 1) / clip.h, c: (n.c2 - n.c1 + 1) / clip.w } : { r: 1, c: 1 };
      const set = [], style = [];
      if (clip.cut) {
        const src = wbNow().sheets.find((x) => x.id === clip.cut.sheet);
        const clearSet = [], clearStyle = [];
        for (const k of src?.cells.keys() || []) { const [r, c] = k.split(",").map(Number); if (r >= clip.cut.r1 && r <= clip.cut.r2 && c >= clip.cut.c1 && c <= clip.cut.c2) { clearSet.push([r, c, null]); const st = src.cells.get(k).s; if (st) clearStyle.push([r, c, Object.fromEntries(Object.keys(st).map((x) => [x, null]))]); } }
        if (clearSet.length) ops.push({ t: "set", sheet: clip.cut.sheet, cells: clearSet });
        if (clearStyle.length) ops.push({ t: "style", sheet: clip.cut.sheet, cells: clearStyle });
      }
      for (let a = 0; a < reps.r; a++) for (let b = 0; b < reps.c; b++) {
        // Empty spots in what was copied empty the target, as in Excel.
        for (let r = 0; r < clip.h; r++) for (let c = 0; c < clip.w; c++) {
          const tr = at.r + a * clip.h + r, tc = at.c + b * clip.w + c;
          const src = clip.cells.get(`${r},${c}`);
          if (!src) { set.push([tr, tc, null]); style.push([tr, tc, NOSTYLE]); continue; }
          set.push([tr, tc, src.f ? { f: clip.cut ? src.f : F().shift(src.f, tr - r - clip.from.r, tc - c - clip.from.c) } : src.v != null ? { v: src.v } : null]);
          style.push([tr, tc, { ...NOSTYLE, ...(src.s || {}) }]);
        }
      }
      ops.push({ t: "set", sheet: s.id, cells: set });
      ops.push({ t: "style", sheet: s.id, cells: style });
      if (clip.cut) clip = null;
      change(ops);
      const r2 = set.reduce((m, x) => Math.max(m, x[0]), at.r), c2 = set.reduce((m, x) => Math.max(m, x[1]), at.c);
      sel.r = at.r; sel.c = at.c;
      select(at.r, at.c, r2, c2, true);
      return;
    }
    // From elsewhere: a table (HTML) or tab-separated text; numbers and dates recognised.
    let grid = null;
    if (html && /<table/i.test(html)) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const t = doc.querySelector("table");
      if (t) grid = [...t.rows].map((tr) => [...tr.cells].flatMap((td) => [td.textContent.replace(/\s+/g, " ").trim(), ...Array(Math.max(0, (td.colSpan || 1) - 1)).fill("")]));
    }
    if (!grid) grid = window.OfficeFiles.readCsv(text.includes("\t") ? text : text.replace(/,/g, "\t")).rows;
    if (!text.includes("\t") && !html) grid = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => [l]);
    const set = [], style = [];
    grid.forEach((row, r) => row.forEach((raw, c) => {
      if (raw === "") { set.push([at.r + r, at.c + c, null]); return; }
      if (raw.startsWith("=")) { try { F().parse(raw); set.push([at.r + r, at.c + c, { f: raw }]); return; } catch { /* as text */ } }
      const p = F().parseInput(raw, { dmy });
      set.push([at.r + r, at.c + c, { v: p.value }]);
      if (p.format) style.push([at.r + r, at.c + c, { nf: p.format }]);
    }));
    ops.push({ t: "set", sheet: s.id, cells: set });
    if (style.length) ops.push({ t: "style", sheet: s.id, cells: style });
    change(ops);
    select(at.r, at.c, at.r + grid.length - 1, at.c + Math.max(...grid.map((r) => r.length)) - 1, true);
  }
  // ---- fill
  function fillFrom(dir) {
    const n = norm();
    if (dir === "down" && n.r2 > n.r1) fill({ ...n, r2: n.r1 }, n);
    else if (dir === "right" && n.c2 > n.c1) fill({ ...n, c2: n.c1 }, n);
    else if (dir === "down" && n.r1 > 0) fill({ r1: n.r1 - 1, r2: n.r1 - 1, c1: n.c1, c2: n.c2 }, { r1: n.r1 - 1, r2: n.r2, c1: n.c1, c2: n.c2 });
  }
  /** Fills $to from $from: numbers and dates continue their series; anything else repeats, formulas moving along. */
  function fill(from, to) {
    if (ctx.readOnly) return;
    const s = sh();
    const vertical = to.r1 !== from.r1 || to.r2 !== from.r2;
    const set = [], style = [];
    const lines = vertical ? range(from.c1, from.c2) : range(from.r1, from.r2);
    for (const line of lines) {
      const src = vertical ? range(from.r1, from.r2).map((r) => [r, line]) : range(from.c1, from.c2).map((c) => [line, c]);
      const cells = src.map(([r, c]) => s.cells.get(`${r},${c}`));
      const nums = cells.map((x) => (x && !x.f && isNum(x.v) ? x.v : null));
      const series = nums.every((v) => v !== null) && (nums.length > 1 || (cells[0]?.s?.nf && /[dmy]/i.test(cells[0].s.nf)));
      const step = series ? (nums.length > 1 ? (nums[nums.length - 1] - nums[0]) / (nums.length - 1) : 1) : 0;
      // Text ending in a number (Week 1, Q1, Item 3) counts on.
      const textNum = cells.length === 1 && typeof cells[0]?.v === "string" && /^(.*?)(\d+)$/.exec(cells[0].v);
      const targets = vertical ? [...range(to.r1, from.r1 - 1), ...range(from.r2 + 1, to.r2)].map((r) => [r, line]) : [...range(to.c1, from.c1 - 1), ...range(from.c2 + 1, to.c2)].map((c) => [line, c]);
      for (const [r, c] of targets) {
        const offset = vertical ? r - from.r1 : c - from.c1;
        const span = vertical ? from.r2 - from.r1 + 1 : from.c2 - from.c1 + 1;
        const k = ((offset % span) + span) % span;
        const [sr, sc] = src[k];
        const cell = cells[k];
        let content = null;
        if (series) content = { v: nums[0] + step * offset };
        else if (textNum) content = { v: textNum[1] + String(+textNum[2] + offset).padStart(textNum[2].length, "0") };
        else if (cell?.f) content = { f: F().shift(cell.f, r - sr, c - sc) };
        else if (cell && cell.v != null) content = { v: cell.v };
        set.push([r, c, content]);
        style.push([r, c, cell?.s ? cell.s : NOSTYLE]);
      }
    }
    if (!set.length) return;
    change([{ t: "set", sheet: s.id, cells: set }, { t: "style", sheet: s.id, cells: style }]);
    select(to.r1, to.c1, to.r2, to.c2, false);
  }
  function fillDownToData() {
    const n = norm(), s = sh();
    const side = n.c1 > 0 ? n.c1 - 1 : n.c2 + 1;
    let r = n.r2;
    while (s.cells.get(`${r + 1},${side}`)?.v != null || s.cells.get(`${r + 1},${side}`)?.f) r++;
    if (r > n.r2) fill(n, { ...n, r2: r });
  }

  // ---- sorting and filtering
  /** The block of data around the cursor (as Excel's current region). */
  function region() {
    const n = norm();
    if (n.r2 > n.r1 || n.c2 > n.c1) return n;
    const s = sh();
    const has = (r, c) => { const x = s.cells.get(`${r},${c}`); return !!(x && (x.f || (x.v !== null && x.v !== ""))); };
    let r1 = sel.r, r2 = sel.r, c1 = sel.c, c2 = sel.c;
    for (let grew = true; grew;) {
      grew = false;
      if (r1 > 0 && range(c1, c2).some((c) => has(r1 - 1, c))) { r1--; grew = true; }
      if (range(c1, c2).some((c) => has(r2 + 1, c))) { r2++; grew = true; }
      if (c1 > 0 && range(r1, r2).some((r) => has(r, c1 - 1))) { c1--; grew = true; }
      if (range(r1, r2).some((r) => has(r, c2 + 1))) { c2++; grew = true; }
    }
    return { r1, r2, c1, c2 };
  }
  const looksLikeHeader = (g) => { const s = sh(); const first = range(g.c1, g.c2).map((c) => book.value(s, g.r1, c)); const second = range(g.c1, g.c2).map((c) => book.value(s, g.r1 + 1, c)); return first.every((v) => typeof v === "string" && v) && second.some((v) => isNum(v) || v === null || (typeof v === "string" && v)) && first.some((v, i) => typeof second[i] !== "string" || cellStyleAt(g.r1, g.c1 + i).b); };
  const cellStyleAt = (r, c) => sh().cells.get(`${r},${c}`)?.s || {};
  function sortMenu(anchor) {
    W().popMenu(anchor, [{ label: "Sort A → Z (smallest first)", run: () => sortRange(1) }, { label: "Sort Z → A (largest first)", run: () => sortRange(-1) }]);
  }
  function sortRange(dir) {
    const g = region();
    if (g.r2 <= g.r1) return;
    const header = looksLikeHeader(g);
    const r1 = header ? g.r1 + 1 : g.r1;
    const s = sh();
    const key = sel.c >= g.c1 && sel.c <= g.c2 ? sel.c : g.c1;
    const order = range(r1, g.r2).sort((a, b) => {
      const va = book.value(s, a, key), vb = book.value(s, b, key);
      if (va === null && vb === null) return a - b;
      if (va === null) return 1; if (vb === null) return -1;
      return (F().compare(va, vb) || a - b) * (F().compare(va, vb) ? dir : 1);
    });
    if (ctx.readOnly) { ctx.toast("This file is view only: sorting just for you isn't available yet."); return; }
    const set = [], style = [];
    order.forEach((from, i) => {
      const to = r1 + i;
      if (from === to) return;
      for (let c = g.c1; c <= g.c2; c++) {
        const cell = s.cells.get(`${from},${c}`);
        set.push([to, c, cell?.f ? { f: F().shift(cell.f, to - from, 0) } : cell && cell.v != null ? { v: cell.v } : null]);
        style.push([to, c, cell?.s || NOSTYLE]);
      }
    });
    if (set.length) change([{ t: "set", sheet: s.id, cells: set }, { t: "style", sheet: s.id, cells: style }]);
    ctx.toast(header ? `Sorted by ${display(s, g.r1, key).text || F().colName(key)}, keeping the header row.` : `Sorted by column ${F().colName(key)}.`);
  }
  function toggleFilter() {
    if (filters.has(sheetId)) { filters.delete(sheetId); axes(); layout(); draw(true); return; }
    const g = region();
    filters.set(sheetId, { r: g.r1, c1: g.c1, c2: g.c2, hide: {} });
    ctx.toast("Filter on: use the arrows in the top row. (Filters are just for you.)");
    axes(); layout(); draw(true);
  }
  function drawFilterButtons() {
    const f = filters.get(sheetId);
    if (!f) return;
    for (let c = f.c1; c <= f.c2; c++) {
      const b = cellBox(f.r, c);
      const on = f.hide[c]?.size;
      const el = h("button", { type: "button", class: `ox-filterbtn${on ? " on" : ""}`, "aria-label": `Filter ${F().colName(c)}`, onclick: (e) => filterPop(e.currentTarget, c) }, icon("filter"));
      el.style.left = `${b.x + b.w - 20}px`; el.style.top = `${b.y + 2}px`;
      b.layer.append(el);
    }
  }
  function filterPop(anchor, c) {
    const f = filters.get(sheetId), s = sh();
    const ext = M().extent(s);
    const values = new Map();
    for (let r = f.r + 1; r < ext.rows; r++) { const t = display(s, r, c).text; values.set(t, (values.get(t) || 0) + 1); }
    const hide = new Set(f.hide[c] || []);
    UI().popover(anchor, (pop, close) => {
      const list = h("div", { class: "ox-flist" });
      const search = h("input", { type: "search", placeholder: "Search", "aria-label": "Search values", oninput: () => drawList() });
      const drawList = () => list.replaceChildren(...[...values.keys()].sort((a, b) => F().compare(a, b)).filter((v) => !search.value || v.toLowerCase().includes(search.value.toLowerCase())).map((v) =>
        h("label", { class: "ox-fitem" }, h("input", { type: "checkbox", checked: !hide.has(v), onchange: (e) => { if (e.target.checked) hide.delete(v); else hide.add(v); } }), v === "" ? "(empty)" : v, h("small", { class: "muted" }, ` ${values.get(v)}`))));
      drawList();
      pop.append(search, h("div", { class: "row" }, h("button", { type: "button", class: "linkish small", onclick: () => { hide.clear(); drawList(); } }, "Select all"), h("button", { type: "button", class: "linkish small", onclick: () => { values.forEach((_, v) => hide.add(v)); drawList(); } }, "Clear")), list,
        h("div", { class: "row end" }, h("button", { type: "button", class: "btn btn-sm", onclick: close }, "Cancel"), h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => { f.hide[c] = hide; close(); axes(); layout(); draw(true); } }, "Apply")));
    });
  }

  // ---- find and replace
  let $find = null;
  function findBar() {
    if ($find) { $find.querySelector("input").focus(); return; }
    const q = h("input", { type: "search", placeholder: "Find", "aria-label": "Find" });
    const rep = h("input", { placeholder: "Replace with", "aria-label": "Replace with", hidden: ctx.readOnly });
    const count = h("span", { class: "muted small" });
    const matches = () => {
      const needle = q.value.toLowerCase();
      if (!needle) return [];
      const out = [];
      for (const s of wbNow().sheets) for (const [k, cell] of s.cells) { const [r, c] = k.split(",").map(Number); if (display(s, r, c).text.toLowerCase().includes(needle) || (cell.f || "").toLowerCase().includes(needle)) out.push({ s: s.id, r, c }); }
      return out.sort((a, b) => (a.s === b.s ? 0 : wbNow().sheets.findIndex((x) => x.id === a.s) - wbNow().sheets.findIndex((x) => x.id === b.s)) || a.r - b.r || a.c - b.c);
    };
    let i = -1;
    const go = (d) => { const m = matches(); count.textContent = m.length ? "" : "No matches"; if (!m.length) return; const cur = m.findIndex((x) => x.s === sheetId && x.r === sel.r && x.c === sel.c); i = cur < 0 ? (d > 0 ? m.findIndex((x) => x.s === sheetId && (x.r > sel.r || (x.r === sel.r && x.c > sel.c))) : -1) : cur + d; if (i < 0 || i >= m.length) i = d > 0 ? 0 : m.length - 1; const x = m[i]; if (x.s !== sheetId) switchSheet(x.s); select(x.r, x.c); count.textContent = `${i + 1} of ${m.length}`; };
    const replaceAll = () => {
      const needle = q.value; if (!needle) return;
      const byS = new Map();
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      for (const s of wbNow().sheets) for (const [k, cell] of s.cells) { if (cell.f || typeof cell.v !== "string" || !re.test(cell.v)) continue; re.lastIndex = 0; const [r, c] = k.split(",").map(Number); if (!byS.has(s.id)) byS.set(s.id, []); byS.get(s.id).push([r, c, { v: cell.v.replace(re, rep.value) }]); }
      const ops = [...byS].map(([id, cells]) => ({ t: "set", sheet: id, cells }));
      if (ops.length) change(ops);
      ctx.toast(ops.length ? `Replaced in ${ops.reduce((n, o) => n + o.cells.length, 0)} cells.` : "Nothing to replace (only text is replaced, not formulas).");
    };
    $find = h("div", { class: "ox-find", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { e.stopPropagation(); closeFind(); } } },
      q, h("button", { type: "button", class: "ox-tool", "aria-label": "Previous", onclick: () => go(-1) }, icon("back")), h("button", { type: "button", class: "btn btn-sm", onclick: () => go(1) }, "Next"), count,
      rep, !ctx.readOnly && h("button", { type: "button", class: "btn btn-sm", onclick: replaceAll }, "Replace all"),
      h("button", { type: "button", class: "ox-tool", "aria-label": "Close", onclick: () => closeFind() }, icon("close")));
    wrap.insertBefore($find, $grid);
    q.focus();
    function closeFind() { $find?.remove(); $find = null; focusGrid(); }
  }

  // ---- comments
  const anchorFor = (r, c) => `cell:${sheetId}:${F().addr(r, c)}`;

  // ---- conditional formatting, charts and pivot tables (sheet-extras.js works them out)
  const oid = () => Math.random().toString(36).slice(2, 10);
  const obj = (kind, id, data) => change({ t: "obj", sheet: sheetId, kind, id, data });
  const sheetByName = (n) => wbNow().sheets.find((x) => x.name.toLowerCase() === String(n).toLowerCase());
  const dataOf = (o) => { const { id, ...d } = o; void id; return d; };
  /** A formula's value as if in cell r, c of sheet $s (conditional formatting's own formulas). */
  const evalIn = (s, src, r, c) => {
    try {
      return F().evaluate(F().parse(src), { sheet: s.name, row: r, col: c, has: (n) => !!sheetByName(n), used: (n) => M().extent(sheetByName(n) || s), get: (n, rr, cc) => { const x = sheetByName(n); return x ? book.value(x, rr, cc) : null; } });
    } catch { return null; }
  };
  const cfFor = (s) => (s.cf?.length ? X().conditional(s.cf, (r, c) => book.value(s, r, c), (src, r, c) => evalIn(s, src, r, c)) : null);
  const rangesText = (ranges) => ranges.map((g) => (g.r1 === g.r2 && g.c1 === g.c2 ? F().addr(g.r1, g.c1) : `${F().addr(g.r1, g.c1)}:${F().addr(g.r2, g.c2)}`)).join(" ");
  const parseRanges = (text) => String(text || "").split(/[\s,;]+/).filter(Boolean).map((t) => M().parseRef(t.replace(/^\$?/, ""), sh().name)).filter((g) => g && (!g.sheet || g.sheet.toLowerCase() === sh().name.toLowerCase())).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
  /** The selection as a range, cut to the used area when whole rows or columns are selected. */
  function selRange() { const n = norm(); return { r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2 }; }
  /** Something typed for a rule: a number, a formula (=…), or text (quoted, as Excel stores it). */
  const asFormula = (v) => { const s = String(v ?? "").trim(); if (s.startsWith("=")) return s.slice(1); if (s !== "" && Number.isFinite(+s)) return String(+s); return `"${s.replace(/"/g, '""')}"`; };
  const CF_STYLES = [["Light red fill with dark red text", { bg: "#ffc7ce", color: "#9c0006" }], ["Yellow fill with dark yellow text", { bg: "#ffeb9c", color: "#9c5700" }], ["Green fill with dark green text", { bg: "#c6efce", color: "#006100" }],
    ["Light red fill", { bg: "#ffc7ce" }], ["Red text", { color: "#c00000" }], ["Bold", { b: true }]];
  function addCf(rule, style = {}) {
    if (ctx.readOnly) return;
    const pri = Math.min(1, ...(sh().cf || []).map((o) => o.pri ?? 0)) - 1; // newest first, as in Excel
    obj("cf", "cf" + oid(), { ranges: [selRange()], pri, rule, style });
  }
  function cfForm(anchor, title, fields, make, { withStyle = true } = {}) {
    UI().popover(anchor, (pop, close) => {
      const inputs = fields.map(([label, def = "", opts]) => (opts ? UI().select(label, opts, () => {}, "ox-in") : h("input", { class: "ox-in", value: def, "aria-label": label })));
      if (fields[0]?.[2]) inputs[0].value = fields[0][1];
      const style = UI().select("Format with", CF_STYLES.map(([l], i) => [String(i), l]), () => {}, "ox-in");
      const form = h("form", { class: "ox-form", onsubmit: (e) => { e.preventDefault(); const rule = make(inputs.map((i) => i.value)); if (!rule) return; close(); addCf(rule, withStyle ? { ...CF_STYLES[+style.value][1] } : {}); focusGrid(); } },
        h("strong", {}, title),
        fields.map(([label], i) => h("label", {}, h("span", {}, label), inputs[i])),
        withStyle ? h("label", {}, h("span", {}, "Format with"), style) : null,
        h("div", { class: "ox-form-btns" }, h("button", { type: "button", class: "btn btn-sm", onclick: close }, "Cancel"), h("button", { class: "btn btn-sm btn-primary" }, "Add rule")));
      pop.append(form);
      setTimeout(() => inputs[0]?.focus?.());
    });
  }
  function cfMenu(anchor) {
    const cell = (op, title, two) => () => cfForm(anchor, title, two ? [["From"], ["To"]] : [["Value", String(isNum(book.value(sh(), sel.r, sel.c)) ? book.value(sh(), sel.r, sel.c) : "")]], (v) => (v[0] === "" ? null : { type: "cell", op, a: asFormula(v[0]), ...(two ? { b: asFormula(v[1]) } : {}) }));
    const scale = (stops) => () => addCf({ type: "scale", stops });
    W().popMenu(anchor, [
      { label: "Greater than…", run: cell("gt", "Format cells greater than") },
      { label: "Less than…", run: cell("lt", "Format cells less than") },
      { label: "Between…", run: cell("between", "Format cells between", true) },
      { label: "Equal to…", run: cell("eq", "Format cells equal to") },
      { label: "Text that contains…", run: () => cfForm(anchor, "Format cells with text containing", [["Text"]], (v) => (v[0] ? { type: "text", op: "contains", text: v[0] } : null)) },
      { label: "A date occurring…", run: () => cfForm(anchor, "Format dates occurring", [["When", "thisWeek", [["yesterday", "Yesterday"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["last7Days", "In the last 7 days"], ["lastWeek", "Last week"], ["thisWeek", "This week"], ["nextWeek", "Next week"], ["lastMonth", "Last month"], ["thisMonth", "This month"], ["nextMonth", "Next month"]]]], (v) => ({ type: "date", period: v[0] })) },
      { label: "Duplicate values", run: () => cfForm(anchor, "Format duplicate values", [], () => ({ type: "dup" })) },
      null,
      { label: "Top 10 items…", run: () => cfForm(anchor, "Format the top", [["How many", "10"]], (v) => ({ type: "top", n: Math.max(1, +v[0] || 10) })) },
      { label: "Bottom 10 items…", run: () => cfForm(anchor, "Format the bottom", [["How many", "10"]], (v) => ({ type: "top", n: Math.max(1, +v[0] || 10), bottom: true })) },
      { label: "Above average", run: () => cfForm(anchor, "Format values above average", [], () => ({ type: "avg" })) },
      { label: "Below average", run: () => cfForm(anchor, "Format values below average", [], () => ({ type: "avg", below: true })) },
      null,
      { label: "Data bars", run: () => addCf({ type: "bar", color: "#638ec6" }) },
      { label: "Colour scale: green, yellow, red", run: scale([{ kind: "min", color: "#63be7b" }, { kind: "percentile", val: "50", color: "#ffeb84" }, { kind: "max", color: "#f8696b" }]) },
      { label: "Colour scale: red, yellow, green", run: scale([{ kind: "min", color: "#f8696b" }, { kind: "percentile", val: "50", color: "#ffeb84" }, { kind: "max", color: "#63be7b" }]) },
      { label: "Colour scale: white to blue", run: scale([{ kind: "min", color: "#ffffff" }, { kind: "max", color: "#5a8ac6" }]) },
      { label: "Icons: arrows", run: () => addCf({ type: "icons", set: "3Arrows" }) },
      { label: "Icons: traffic lights", run: () => addCf({ type: "icons", set: "3TrafficLights1" }) },
      null,
      { label: "Manage rules…", run: () => cfManager(anchor) },
      { label: "Clear rules from the selection", run: cfClearSel },
    ]);
  }
  function cfClearSel() {
    const s0 = selRange();
    const minus = (g, s) => {
      if (s.r2 < g.r1 || s.r1 > g.r2 || s.c2 < g.c1 || s.c1 > g.c2) return [g];
      const out = [];
      if (g.r1 < s.r1) out.push({ ...g, r2: s.r1 - 1 });
      if (g.r2 > s.r2) out.push({ ...g, r1: s.r2 + 1 });
      const r1 = Math.max(g.r1, s.r1), r2 = Math.min(g.r2, s.r2);
      if (g.c1 < s.c1) out.push({ r1, r2, c1: g.c1, c2: s.c1 - 1 });
      if (g.c2 > s.c2) out.push({ r1, r2, c1: s.c2 + 1, c2: g.c2 });
      return out;
    };
    const ops = [];
    for (const o of sh().cf || []) {
      const ranges = o.ranges.flatMap((g) => minus(g, s0));
      if (JSON.stringify(ranges) === JSON.stringify(o.ranges)) continue;
      ops.push({ t: "obj", sheet: sheetId, kind: "cf", id: o.id, data: ranges.length ? { ...dataOf(o), ranges } : null });
    }
    if (ops.length) change(ops); else ctx.toast("No conditional formatting in the selection.");
  }
  function cfManager(anchor) {
    UI().popover(anchor, (pop) => {
      const list = h("div", { class: "ox-rules" });
      const render = () => {
        const rules = sh().cf || [];
        list.replaceChildren(...(rules.length ? [] : [h("p", { class: "muted" }, "No conditional formatting on this sheet.")]),
          ...rules.map((o, i) => {
            const swatch = h("span", { class: "ox-rule-swatch" }, o.rule.type === "bar" ? "▬" : o.rule.type === "icons" ? X().iconFor(o.rule.set, X().iconCount(o.rule.set) - 1, X().iconCount(o.rule.set)).g : "Ab");
            if (o.style?.bg) swatch.style.background = o.style.bg;
            if (o.style?.color) swatch.style.color = o.style.color;
            if (o.style?.b) swatch.style.fontWeight = "700";
            if (o.rule.type === "scale") swatch.style.background = `linear-gradient(90deg, ${o.rule.stops.map((x) => x.color).join(", ")})`;
            if (o.rule.type === "bar") swatch.style.color = o.rule.color;
            const range = h("input", { class: "ox-in ox-rule-range", value: rangesText(o.ranges), "aria-label": "Applies to", onchange: (e) => { const ranges = parseRanges(e.target.value); if (ranges.length) { obj("cf", o.id, { ...dataOf(o), ranges }); render(); } else e.target.value = rangesText(o.ranges); } });
            const swap = (j) => { const other = rules[j]; if (!other) return; change([{ t: "obj", sheet: sheetId, kind: "cf", id: o.id, data: { ...dataOf(o), pri: other.pri } }, { t: "obj", sheet: sheetId, kind: "cf", id: other.id, data: { ...dataOf(other), pri: o.pri } }]); render(); };
            return h("div", { class: "ox-rule" }, swatch,
              h("div", { class: "grow" }, h("div", { class: "ox-rule-name" }, X().ruleLabel(o.rule)), range),
              ctx.readOnly ? null : h("div", { class: "ox-rule-btns" },
                h("button", { type: "button", class: "ox-tool", title: "Higher priority", "aria-label": "Higher priority", disabled: i === 0, onclick: () => swap(i - 1) }, "↑"),
                h("button", { type: "button", class: "ox-tool", title: "Lower priority", "aria-label": "Lower priority", disabled: i === rules.length - 1, onclick: () => swap(i + 1) }, "↓"),
                h("button", { type: "button", class: "ox-tool", title: "Delete rule", "aria-label": "Delete rule", onclick: () => { obj("cf", o.id, null); render(); } }, icon("trash"))));
          }));
      };
      render();
      pop.classList.add("ox-pop-wide");
      pop.append(h("strong", {}, "Conditional formatting on this sheet"), h("p", { class: "muted ox-small" }, "Rules higher up win when two set the same thing."), list);
    });
  }

  // Charts: drawn over the cells, anchored to the cell at their top left.
  const $charts = h("div", { class: "ox-charts" });
  $scroll.append($charts);
  let chartSel = null;
  function chartBox(a) { const fz = frozen(); return { x: cols.pos(a.c) - cols.pos(fz.c) + (a.dx || 0), y: rows.pos(a.r) - rows.pos(fz.r) + (a.dy || 0), w: a.w || 480, h: a.h || 288 }; }
  function anchorAt(x, y, w, ht) { const fz = frozen(); const ax = x + cols.pos(fz.c), ay = y + rows.pos(fz.r); const c = cols.at(ax), r = rows.at(ay); return { r, c, dx: Math.round(ax - cols.pos(c)), dy: Math.round(ay - rows.pos(r)), w: Math.round(w), h: Math.round(ht) }; }
  const chartDataOf = (ch) => X().chartData(ch, (n, r, c) => { const x = sheetByName(n); return x ? book.value(x, r, c) : null; }, (n, r, c) => { const x = sheetByName(n); return x ? display(x, r, c).text : ""; });
  function drawCharts() {
    const list = sh().charts || [];
    if (chartSel && !list.some((c) => c.id === chartSel)) chartSel = null;
    const focused = document.activeElement?.closest?.(".ox-chart")?.dataset.id;
    $charts.replaceChildren(...list.map((ch) => {
      const b = chartBox(ch.anchor || {});
      const el = h("div", { class: `ox-chart${chartSel === ch.id ? " on" : ""}`, tabindex: "0", role: "img", "aria-label": `${ch.title || "Chart"} (${(X().CHART_TYPES.find(([t]) => t === ch.type) || [, "Chart"])[1]} chart)`, dataset: { id: ch.id } });
      el.style.left = `${b.x}px`; el.style.top = `${b.y}px`; el.style.width = `${b.w}px`; el.style.height = `${b.h}px`;
      el.innerHTML = X().chartSvg(ch, chartDataOf(ch), Math.round(b.w), Math.round(b.h)); // escaped SVG text from sheet-extras.js
      if (!ctx.readOnly) {
        el.append(h("span", { class: "ox-chart-size", title: "Drag to resize" }));
        if (chartSel === ch.id) el.append(h("div", { class: "ox-chart-acts" },
          h("button", { type: "button", class: "btn btn-sm", onclick: (e) => { e.stopPropagation(); chartPanel(ch.id, el); } }, "Edit chart"),
          h("button", { type: "button", class: "ox-tool", title: "Delete chart", "aria-label": "Delete chart", onclick: (e) => { e.stopPropagation(); chartSel = null; obj("chart", ch.id, null); focusGrid(); } }, icon("trash"))));
      }
      return el;
    }));
    if (focused) $charts.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  function selectChart(id) { chartSel = id; drawCharts(); $charts.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
  $charts.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".ox-chart");
    if (!el) return;
    e.stopPropagation();
    if (e.target.closest(".ox-chart-acts")) return;
    if (editing) commitEdit();
    const ch = (sh().charts || []).find((x) => x.id === el.dataset.id);
    if (!ch) return;
    if (chartSel !== ch.id) selectChart(ch.id);
    const target = $charts.querySelector(`[data-id="${CSS.escape(ch.id)}"]`);
    if (ctx.readOnly || (e.button !== 0 && e.pointerType === "mouse")) return;
    e.preventDefault();
    const resize = e.target.classList.contains("ox-chart-size");
    const b0 = chartBox(ch.anchor || {}), x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    target.setPointerCapture(e.pointerId);
    const at = (ev) => ({ dx: ev.clientX - x0, dy: ev.clientY - y0 });
    const mv = (ev) => {
      const { dx, dy } = at(ev);
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (resize) { target.style.width = `${Math.max(160, b0.w + dx)}px`; target.style.height = `${Math.max(110, b0.h + dy)}px`; }
      else { target.style.left = `${Math.max(0, b0.x + dx)}px`; target.style.top = `${Math.max(0, b0.y + dy)}px`; }
    };
    const up = (ev) => {
      target.removeEventListener("pointermove", mv); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
      if (!moved) return;
      const { dx, dy } = at(ev);
      const anchor = resize ? { ...(ch.anchor || {}), w: Math.round(Math.max(160, b0.w + dx)), h: Math.round(Math.max(110, b0.h + dy)) } : anchorAt(Math.max(0, b0.x + dx), Math.max(0, b0.y + dy), b0.w, b0.h);
      obj("chart", ch.id, { ...dataOf(ch), anchor });
      $charts.querySelector(`[data-id="${CSS.escape(ch.id)}"]`)?.focus({ preventScroll: true });
    };
    target.addEventListener("pointermove", mv); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
  });
  $charts.addEventListener("dblclick", (e) => { const el = e.target.closest(".ox-chart"); if (el && !ctx.readOnly) chartPanel(el.dataset.id, el); });
  $charts.addEventListener("keydown", (e) => {
    const el = e.target.closest(".ox-chart");
    if (!el || e.target !== el) return;
    const ch = (sh().charts || []).find((x) => x.id === el.dataset.id);
    if (!ch) return;
    if ((e.key === "Delete" || e.key === "Backspace") && !ctx.readOnly) { e.preventDefault(); chartSel = null; obj("chart", ch.id, null); focusGrid(); }
    else if (e.key === "Enter" && !ctx.readOnly) { e.preventDefault(); chartPanel(ch.id, el); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); chartSel = null; drawCharts(); focusGrid(); }
    else if (/^Arrow/.test(e.key) && !ctx.readOnly) {
      e.preventDefault();
      const step = e.shiftKey ? 20 : 4, b = chartBox(ch.anchor || {});
      const x = b.x + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0), y = b.y + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0);
      obj("chart", ch.id, { ...dataOf(ch), anchor: anchorAt(Math.max(0, x), Math.max(0, y), b.w, b.h) });
    }
  });
  /** The block of cells a chart's data comes from (for showing and changing it). */
  function chartRange(ch) {
    const gs = ch.series.flatMap((s) => [s.name, s.cat, s.val]).map((r) => M().parseRef(r)).filter(Boolean);
    if (!gs.length) return null;
    const g = { sheet: gs[0].sheet, r1: Math.min(...gs.map((x) => x.r1)), c1: Math.min(...gs.map((x) => x.c1)), r2: Math.max(...gs.map((x) => x.r2)), c2: Math.max(...gs.map((x) => x.c2)) };
    return g;
  }
  const rangeLabel = (g) => (g ? `${g.sheet && g.sheet.toLowerCase() !== sh().name.toLowerCase() ? F().quoteSheet(g.sheet) + "!" : ""}${F().addr(g.r1, g.c1)}:${F().addr(g.r2, g.c2)}` : "");
  function chartPanel(id, anchorEl) {
    const cur = () => (sh().charts || []).find((x) => x.id === id);
    if (!cur()) return;
    const save = (patch) => { const c = cur(); if (c) obj("chart", id, { ...dataOf(c), ...patch }); };
    UI().popover(anchorEl, (pop, close) => {
      const c = cur();
      const g0 = chartRange(c);
      const typeSel = UI().select("Chart type", X().CHART_TYPES, (v) => { save({ type: v }); sync(); }, "ox-in");
      const stackSel = UI().select("Stacking", [["", "Side by side"], ["stacked", "Stacked"], ["percent", "100% stacked"]], (v) => save({ grouping: v || undefined }), "ox-in");
      const title = h("input", { class: "ox-in", value: c.title || "", "aria-label": "Title", onchange: (e) => save({ title: e.target.value.trim() || undefined }) });
      const range = h("input", { class: "ox-in", value: rangeLabel(g0), "aria-label": "Data", onchange: () => remake() });
      const bySel = UI().select("Series in", [["cols", "Columns"], ["rows", "Rows"]], () => remake(), "ox-in");
      const legend = UI().select("Legend", [["", "Automatic"], ["right", "Right"], ["bottom", "Bottom"], ["none", "None"]], (v) => save({ legend: v || undefined }), "ox-in");
      const labels = h("input", { type: "checkbox", checked: c.type === "pie" || c.type === "doughnut" ? c.labels !== false : !!c.labels, onchange: (e) => save({ labels: e.target.checked }) });
      typeSel.value = c.type || "column"; stackSel.value = c.grouping || ""; legend.value = c.legend || "";
      bySel.value = g0 && c.series[0] && (() => { const v = M().parseRef(c.series[0].val); return v && v.r1 === v.r2 && v.c2 > v.c1 ? "rows" : "cols"; })();
      const stackRow = h("label", {}, h("span", {}, "Stacking"), stackSel);
      const sync = () => { stackRow.hidden = ["pie", "doughnut", "scatter"].includes(typeSel.value); };
      function remake() {
        const g = M().parseRef(range.value.trim(), sh().name);
        const src = g && sheetByName(g.sheet || sh().name);
        if (!g || !src) { ctx.toast("Type the data's cells, like A1:D12."); range.value = rangeLabel(chartRange(cur())); return; }
        const series = X().seriesFrom(src.name, g, (r, cc) => book.value(src, r, cc), bySel.value === "rows");
        if (!series.length) { ctx.toast("There are no numbers in those cells to chart."); return; }
        save({ series });
      }
      sync();
      pop.classList.add("ox-pop-wide");
      pop.append(h("div", { class: "ox-form" }, h("strong", {}, "Chart"),
        h("label", {}, h("span", {}, "Type"), typeSel), stackRow,
        h("label", {}, h("span", {}, "Title"), title),
        h("label", {}, h("span", {}, "Data"), range),
        h("label", {}, h("span", {}, "Series in"), bySel),
        h("label", {}, h("span", {}, "Legend"), legend),
        h("label", { class: "ox-check" }, labels, h("span", {}, "Show values on the chart")),
        h("div", { class: "ox-form-btns" }, h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => { close(); chartSel = null; obj("chart", id, null); focusGrid(); } }, "Delete chart"), h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: close }, "Done"))));
    });
  }
  function insertChart(type, grouping) {
    if (ctx.readOnly) return;
    const g = region(), s = sh();
    const series = X().seriesFrom(s.name, g, (r, c) => book.value(s, r, c));
    if (!series.length) { ctx.toast("Select the numbers to chart, with their headings, first."); return; }
    const id = "ch" + oid();
    const name = series.length === 1 && series[0].name ? (() => { const x = M().parseRef(series[0].name); return x ? display(s, x.r1, x.c1).text : ""; })() : "";
    obj("chart", id, { type, ...(grouping ? { grouping } : {}), ...(name ? { title: name } : {}), series, anchor: { r: g.r1, c: g.c2 + 2, dx: 0, dy: 0, w: 480, h: 288 } });
    scrollTo(g.r1, g.c2 + 2);
    selectChart(id);
  }
  function chartMenu(anchor) {
    W().popMenu(anchor, [["column", "Column"], ["column", "Stacked column", "stacked"], ["bar", "Bar"], ["line", "Line"], ["area", "Area"], ["pie", "Pie"], ["doughnut", "Doughnut"], ["scatter", "Scatter (X Y)"]]
      .map(([t, l, g]) => ({ label: l, run: () => insertChart(t, g) })));
  }

  // Pivot tables: their summary is ordinary cells, worked out again when the definition changes or on Refresh.
  const pivotAt = (r, c, s = sh()) => (s.pivots || []).find((p) => r >= p.at.r && r < p.at.r + (p.size?.rows || 1) && c >= p.at.c && c < p.at.c + (p.size?.cols || 1));
  function sourceTable(src) {
    const g = M().parseRef(src);
    const s = g && sheetByName(g.sheet);
    if (!s) return null;
    const table = [];
    for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 100000); r++) { const row = []; for (let c = g.c1; c <= g.c2; c++) row.push(book.value(s, r, c)); table.push(row); }
    return { table, nfOf: (i) => { for (let r = g.r1 + 1; r <= Math.min(g.r2, g.r1 + 50); r++) { const nf = s.cells.get(`${r},${g.c1 + i}`)?.s?.nf; if (nf) return nf; } return null; } };
  }
  /** Ops that write pivot $id on sheet $sid from $def (clearing what it covered before). */
  function pivotOps(sid, id, def, old) {
    const src = sourceTable(def.src);
    if (!src) { ctx.toast("The pivot table's source isn't there any more."); return null; }
    const res = X().pivot(src.table, def, src.nfOf);
    if (res.error) { ctx.toast(res.error); return null; }
    const s = wbNow().sheets.find((x) => x.id === sid);
    const rowsN = res.cells.length, colsN = Math.max(...res.cells.map((r) => r.length));
    const inOld = (r, c) => old && r >= old.at.r && r < old.at.r + (old.size?.rows || 0) && c >= old.at.c && c < old.at.c + (old.size?.cols || 0);
    let covers = false;
    for (let r = def.at.r; r < def.at.r + rowsN && !covers; r++) for (let c = def.at.c; c < def.at.c + colsN; c++) { const x = s.cells.get(`${r},${c}`); if (!inOld(r, c) && x && (x.f || (x.v !== null && x.v !== ""))) { covers = true; break; } }
    if (covers && !confirm("The pivot table needs cells that have data in them. Replace that data?")) return null;
    const set = [], style = [];
    if (old) for (let r = old.at.r; r < old.at.r + (old.size?.rows || 0); r++) for (let c = old.at.c; c < old.at.c + (old.size?.cols || 0); c++) { set.push([r, c, null]); style.push([r, c, { b: null, nf: null }]); }
    res.cells.forEach((row, i) => row.forEach((x, j) => {
      const r = def.at.r + i, c = def.at.c + j;
      set.push([r, c, x.v === null || x.v === undefined || x.v === "" ? null : { v: x.v }]);
      style.push([r, c, { b: x.b ? true : null, nf: x.nf || null }]);
    }));
    return [{ t: "set", sheet: sid, cells: set }, { t: "style", sheet: sid, cells: style }, { t: "obj", sheet: sid, kind: "pivot", id, data: { ...def, size: { rows: rowsN, cols: colsN } } }];
  }
  function pivotStart(anchor) {
    if (ctx.readOnly) return;
    const inside = pivotAt(sel.r, sel.c);
    if (inside) { pivotPanel(inside.id, anchor); return; }
    const g = region(), s = sh();
    if (g.r2 - g.r1 < 1) { ctx.toast("Select a table with headings in its first row (or click a cell in one) first."); return; }
    const src = M().refOf(s.name, g.r1, g.c1, g.r2, g.c2);
    const heads = range(g.c1, g.c2).map((c) => book.value(s, g.r1, c));
    const firstText = heads.findIndex((_, i) => typeof book.value(s, g.r1 + 1, g.c1 + i) === "string");
    const firstNum = heads.findIndex((_, i) => isNum(book.value(s, g.r1 + 1, g.c1 + i)));
    const name = (i) => (heads[i] === null || heads[i] === undefined || heads[i] === "" ? `Column ${i + 1}` : String(heads[i]));
    const def = { src, at: { r: 0, c: 0 }, rows: firstText >= 0 ? [name(firstText)] : [], cols: [], vals: firstNum >= 0 ? [{ field: name(firstNum), fn: "sum" }] : [{ field: name(0), fn: "count" }] };
    const sid = "s" + oid(), at = wbNow().sheets.findIndex((x) => x.id === sheetId) + 1;
    change({ t: "sheet", id: sid, name: "Pivot", at });
    switchSheet(sid);
    const id = "pv" + oid();
    const ops = pivotOps(sid, id, def, null);
    if (ops) change(ops);
    select(0, 0);
    pivotPanel(id, anchor);
  }
  function pivotRefresh(id) {
    const p = (sh().pivots || []).find((x) => x.id === id);
    if (!p) return;
    const ops = pivotOps(sheetId, id, dataOf(p), p);
    if (ops) change(ops);
  }
  function pivotPanel(id, anchorEl) {
    const cur = () => (sh().pivots || []).find((x) => x.id === id);
    if (!cur()) return;
    UI().popover(anchorEl, (pop, close) => {
      pop.classList.add("ox-pop-wide");
      const body = h("div", { class: "ox-form" });
      pop.append(body);
      const update = (patch) => { const p = cur(); if (!p) return; const ops = pivotOps(sheetId, id, { ...dataOf(p), ...patch }, p); if (ops) change(ops); render(); };
      const render = () => {
        const p = cur();
        if (!p) { close(); return; }
        const src = sourceTable(p.src);
        const fields = src ? src.table[0].map((v, i) => (v === null || v === undefined || v === "" ? `Column ${i + 1}` : String(v))) : [];
        const chips = (key) => h("div", { class: "ox-chips" },
          (p[key] || []).map((f, i) => h("span", { class: "ox-chip" }, f, h("button", { type: "button", "aria-label": `Remove ${f}`, onclick: () => update({ [key]: p[key].filter((_, j) => j !== i) }) }, "×"))),
          UI().select(`Add to ${key}`, [["", "Add a field…"], ...fields.filter((f) => !(p.rows || []).includes(f) && !(p.cols || []).includes(f)).map((f) => [f, f])], (v) => { if (v) update({ [key]: [...(p[key] || []), v] }); }, "ox-in ox-chip-add"));
        const vals = h("div", { class: "ox-chips" },
          (p.vals || []).map((v, i) => {
            const fn = UI().select("Summarise by", Object.entries(X().PIVOT_FNS).map(([k, l]) => [k, l]), (x) => update({ vals: p.vals.map((w, j) => (j === i ? { ...w, fn: x } : w)) }), "ox-in ox-fn");
            fn.value = v.fn;
            return h("span", { class: "ox-chip" }, fn, h("span", {}, ` of ${v.field}`), h("button", { type: "button", "aria-label": `Remove ${v.field}`, onclick: () => update({ vals: p.vals.filter((_, j) => j !== i) }) }, "×"));
          }),
          UI().select("Add a value", [["", "Add a field…"], ...fields.map((f) => [f, f])], (v) => { if (v) { const t = src.table.slice(1).find((r) => r[fields.indexOf(v)] !== null)?.[fields.indexOf(v)]; update({ vals: [...(p.vals || []), { field: v, fn: isNum(t) ? "sum" : "count" }] }); } }, "ox-in ox-chip-add"));
        const srcIn = h("input", { class: "ox-in", value: p.src, "aria-label": "Source", onchange: (e) => { const g = M().parseRef(e.target.value.trim(), sh().name); if (!g || !sheetByName(g.sheet || sh().name)) { ctx.toast("Type the source's cells, like Sales!A1:D200."); e.target.value = p.src; return; } update({ src: M().refOf(sheetByName(g.sheet || sh().name).name, g.r1, g.c1, g.r2, g.c2) }); } });
        body.replaceChildren(h("strong", {}, "Pivot table"),
          h("label", {}, h("span", {}, "Source"), srcIn),
          h("div", { class: "ox-field" }, h("span", {}, "Rows"), chips("rows")),
          h("div", { class: "ox-field" }, h("span", {}, "Columns"), chips("cols")),
          h("div", { class: "ox-field" }, h("span", {}, "Values"), vals),
          h("div", { class: "ox-form-btns" },
            h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => { const q = cur(); if (!q) return; close(); const set = [], style = []; for (let r = q.at.r; r < q.at.r + (q.size?.rows || 0); r++) for (let c = q.at.c; c < q.at.c + (q.size?.cols || 0); c++) { set.push([r, c, null]); style.push([r, c, { b: null, nf: null }]); } change([{ t: "set", sheet: sheetId, cells: set }, { t: "style", sheet: sheetId, cells: style }, { t: "obj", sheet: sheetId, kind: "pivot", id, data: null }]); } }, "Delete"),
            h("button", { type: "button", class: "btn btn-sm", onclick: () => update({}) }, "Refresh"),
            h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: close }, "Done")));
      };
      render();
    });
  }

  // ---- start
  axes(); layout(); drawTabs(); draw(true);
  presence();

  return {
    refresh(info = {}) {
      if (!wbNow().sheets.some((s) => s.id === sheetId)) sheetId = wbNow().sheets.find((s) => !s.hidden)?.id || wbNow().sheets[0].id;
      // Someone else's change while typing in a cell: the typing carries on; the cell's new contents show after.
      book.rebuild(); axes(); layout(); drawTabs(); draw(true);
      void info;
    },
    others(list) { othersNow = list; drawOthers(); },
    focus: focusGrid,
    anchorLabel(anchor) {
      const m = /^cell:([^:]+):(.+)$/.exec(anchor || "");
      if (!m) return "";
      const s = wbNow().sheets.find((x) => x.id === m[1]);
      return s ? `${s.name}!${m[2]}` : m[2];
    },
    reveal(anchor) { const m = /^cell:([^:]+):(.+)$/.exec(anchor || ""); if (!m) return; if (m[1] !== sheetId && wbNow().sheets.some((s) => s.id === m[1])) switchSheet(m[1]); goTo(m[2]); },
    commentsChanged() { draw(true); },
    print() {
      const s = sh();
      const n = norm();
      const area = n.r2 > n.r1 || n.c2 > n.c1 ? n : (() => { const e = M().extent(s); return { r1: 0, c1: 0, r2: e.rows - 1, c2: e.cols - 1 }; })();
      const table = document.createElement("table");
      const printCf = cfFor(s);
      for (let r = area.r1; r <= area.r2; r++) {
        if (hiddenRows.has(r)) continue;
        const tr = table.insertRow();
        for (let c = area.c1; c <= area.c2; c++) {
          const g = mergeAt(s, r, c);
          if (g && (g.r1 !== r || g.c1 !== c)) continue;
          const td = tr.insertCell();
          if (g) { td.rowSpan = g.r2 - g.r1 + 1; td.colSpan = g.c2 - g.c1 + 1; }
          const d = display(s, r, c), st = s.cells.get(`${r},${c}`)?.s || {};
          const cx = printCf?.at(r, c);
          td.textContent = d.text;
          if (cx?.bg) td.style.backgroundColor = cx.bg;
          if (cx?.color) td.style.color = cx.color;
          if (st.b) td.style.fontWeight = "700"; if (st.i) td.style.fontStyle = "italic"; if (st.bg) td.style.backgroundColor = st.bg; if (st.color || d.color) td.style.color = d.color || st.color;
          td.style.textAlign = st.h || (d.num ? "right" : "left");
          if (st.border) for (const [k, side] of [["t", "Top"], ["r", "Right"], ["b", "Bottom"], ["l", "Left"]]) if (st.border[k]) td.style[`border${side}`] = `${st.border[k]}px solid #000`;
        }
      }
      UI().printHtml(`${ctx.file.name} — ${s.name}`, table, "body { font: 10pt Calibri, Carlito, Arial, sans-serif; margin: 0; }\ntable { border-collapse: collapse; }\ntd { padding: 2px 6px; border: 1px solid #ddd; white-space: nowrap; }\n@page { margin: 12mm; }");
    },
    menu: () => (ctx.readOnly ? [] : [{ label: "Insert rows or columns…", icon: "layers", run: () => rowsMenu(ctx.toolbar) }, { label: "Freeze panes…", icon: "pin", run: () => freezeMenu(ctx.toolbar) },
      { label: "Conditional formatting…", icon: "layers", run: () => cfManager(ctx.toolbar) }]),
    escape() { if (editing) { cancelEdit(); return true; } return false; },
    destroy() { ro.disconnect(); },
  };
}

// ---------------------------------------------------------------------------------------------- the kind

const valuesFor = (wb) => {
  const book = new Book(() => wb);
  return (si, r, c) => book.value(wb.sheets[si], r, c);
};
window.OfficeKinds = window.OfficeKinds || {};
window.OfficeKinds.spreadsheet = {
  get model() { return M(); },
  async load(bytes, file) {
    if (/\.csv$/i.test(file.name)) return { state: fromCsv(new TextDecoder().decode(bytes), file.name), unsupported: [] };
    if (!bytes.length) return { state: { sheets: [M().blank("s1", "Sheet1")] }, unsupported: [] };
    const { sheets, unsupported } = await window.OfficeFiles.readXlsx(bytes);
    return { state: { sheets }, unsupported };
  },
  async save(wb, file) {
    if (/\.csv$/i.test(file.name)) return csvOf(wb, wb.csvSep || ",");
    return window.OfficeFiles.writeXlsx(wb, valuesFor(wb));
  },
  get formats() {
    return [
      { label: "Excel workbook (.xlsx)", ext: "xlsx", make: (wb) => window.OfficeFiles.writeXlsx(wb, valuesFor(wb)) },
      { label: "CSV (first sheet)", ext: "csv", make: (wb) => csvOf(wb, ",") },
    ];
  },
  mount,
  blank: () => ({ sheets: [M().blank("s1", "Sheet1")] }),
  fromCsv,
};
function csvOf(wb, sep) {
  const s = wb.sheets.find((x) => !x.hidden) || wb.sheets[0];
  const book = new Book(() => wb);
  const e = M().extent(s);
  const out = [];
  for (let r = 0; r < e.rows; r++) {
    const row = [];
    for (let c = 0; c < e.cols; c++) {
      const v = book.value(s, r, c), nf = s.cells.get(`${r},${c}`)?.s?.nf;
      row.push(v == null ? "" : F().isErr(v) ? v.code : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : isNum(v) && nf && /[dmyh%]/i.test(nf.replace(/"[^"]*"/g, "")) ? F().format(v, nf).text : v);
    }
    out.push(row);
  }
  return new Blob([window.OfficeFiles.writeCsv(out, sep)], { type: "text/csv" });
}
})();
