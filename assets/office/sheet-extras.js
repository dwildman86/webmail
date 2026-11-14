// What the spreadsheet's extras work out, apart from drawing the grid: which conditional formatting applies to a cell,
// a chart as SVG from its data, and a pivot table's summary. No DOM: works in the browser (window.OfficeSheetExtras)
// and in Node (its tests); charts come back as SVG text.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./formula.js"), require("./sheet-model.js"));
  else root.OfficeSheetExtras = factory(root.OfficeFormula, root.OfficeSheetModel);
})(typeof self !== "undefined" ? self : this, function (F, M) {
"use strict";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const MAX_CELLS = 200000; // cells looked at per rule (top 10, averages, duplicates, scales)

// ------------------------------------------------------------------------------------------------ conditional formatting

/*
 * Rules (rule.type):
 *   cell   { op: gt|lt|ge|le|eq|ne|between|notBetween, a, b }   a, b: formulas without "=", relative to the range's top left
 *   text   { op: contains|notContains|begins|ends, text }
 *   top    { n, percent, bottom }
 *   avg    { below, equal }
 *   dup    { unique }
 *   blank  { not }          error { not }
 *   date   { period: today|yesterday|tomorrow|last7Days|thisWeek|lastWeek|nextWeek|thisMonth|lastMonth|nextMonth }
 *   expr   { f }            true where the formula is (relative to the top left)
 *   scale  { stops: [{ kind: min|max|num|percent|percentile, val, color }] }   2 or 3 stops
 *   bar    { color, min: { kind, val }, max: { kind, val } }
 *   icons  { set: "3Arrows"…, reverse, hideValue, stops: [{ kind: percent|num|percentile, val }] } (one fewer than icons)
 */
const RULE_LABELS = {
  cell: (r) => ({ gt: "Greater than", lt: "Less than", ge: "Greater than or equal to", le: "Less than or equal to", eq: "Equal to", ne: "Not equal to", between: "Between", notBetween: "Not between" }[r.op] + ` ${r.a}${/between/i.test(r.op) ? ` and ${r.b}` : ""}`),
  text: (r) => `${{ contains: "Text contains", notContains: "Text doesn't contain", begins: "Text begins with", ends: "Text ends with" }[r.op]} “${r.text}”`,
  top: (r) => `${r.bottom ? "Bottom" : "Top"} ${r.n}${r.percent ? "%" : ""}`,
  avg: (r) => `${r.below ? "Below" : "Above"} average`,
  dup: (r) => (r.unique ? "Unique values" : "Duplicate values"),
  blank: (r) => (r.not ? "Not blank" : "Blank"),
  error: (r) => (r.not ? "No errors" : "Errors"),
  date: (r) => ({ today: "Today", yesterday: "Yesterday", tomorrow: "Tomorrow", last7Days: "In the last 7 days", thisWeek: "This week", lastWeek: "Last week", nextWeek: "Next week", thisMonth: "This month", lastMonth: "Last month", nextMonth: "Next month" }[r.period] || "A date"),
  expr: (r) => `Formula: =${r.f}`,
  scale: (r) => `${r.stops?.length || 2}-colour scale`,
  bar: () => "Data bars",
  icons: (r) => { const fam = String(r.set || "").slice(1).replace(/\d+$/, ""); return `Icons: ${{ Arrows: "arrows", ArrowsGray: "grey arrows", Flags: "flags", TrafficLights: "traffic lights", Signs: "signs", Symbols: "symbols", Stars: "stars", Triangles: "triangles", RedToBlack: "red to black", Rating: "ratings", Quarters: "quarters", Boxes: "boxes" }[fam] || r.set}`; },
};
const ruleLabel = (rule) => (RULE_LABELS[rule.type] ? RULE_LABELS[rule.type](rule) : rule.type);

const ICON_SETS = ["3Arrows", "3ArrowsGray", "3Flags", "3TrafficLights1", "3TrafficLights2", "3Signs", "3Symbols", "3Symbols2", "3Stars", "3Triangles",
  "4Arrows", "4ArrowsGray", "4RedToBlack", "4Rating", "4TrafficLights", "5Arrows", "5ArrowsGray", "5Rating", "5Quarters", "5Boxes"];
const iconCount = (set) => +String(set || "3").charAt(0) || 3;
/** The glyph and colour for level $i (0 = lowest) of $n in $set. */
function iconFor(set, i, n) {
  const fam = String(set || "").slice(1);
  const RG = ["#d9363e", "#f2b200", "#2f9e44"], RG4 = ["#d9363e", "#f2b200", "#a5c84b", "#2f9e44"], RG5 = ["#d9363e", "#f08c00", "#f2b200", "#a5c84b", "#2f9e44"];
  const col = n === 3 ? RG : n === 4 ? RG4 : RG5;
  if (/^Arrows/.test(fam)) { const g = n === 3 ? ["↓", "→", "↑"] : n === 4 ? ["↓", "↘", "↗", "↑"] : ["↓", "↘", "→", "↗", "↑"]; return { g: g[i], color: fam === "ArrowsGray" ? "#6b7280" : col[i] }; }
  if (fam === "Triangles") return { g: ["▼", "▬", "▲"][i], color: col[i] };
  if (fam === "Stars") return { g: ["☆", "⯪", "★"][i] || "★", color: "#f2b200" };
  if (/Rating|Quarters|Boxes/.test(fam)) return { g: ["○", "◔", "◑", "◕", "●"][Math.round((i * 4) / (n - 1))], color: "#4472c4" };
  if (fam === "RedToBlack") return { g: "●", color: ["#111111", "#6b7280", "#e67c7c", "#d9363e"][i] };
  if (fam === "Flags") return { g: "⚑", color: col[i] };
  if (fam === "Symbols" || fam === "Symbols2") return { g: ["✖", "!", "✔"][i], color: col[i] };
  return { g: "●", color: col[i] };
}

function lerpColor(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
const percentile = (sorted, p) => { if (!sorted.length) return 0; const k = (sorted.length - 1) * p; const lo = Math.floor(k), hi = Math.ceil(k); return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo); };

/**
 * Conditional formatting for one sheet. $value(r, c) → the cell's value; $evaluate(src, r, c) → a formula's value as if in
 * that cell. Returns at(r, c) → null or { bg, color, b, i, u, s, bar: { from, to, color, neg }, icon: { g, color, hide } }.
 * Build a new one after any change: rules' statistics (averages, top 10…) are worked out once, when first needed.
 */
function conditional(rules, value, evaluate) {
  const stats = new Map();
  const statOf = (rule) => {
    if (stats.has(rule)) return stats.get(rule);
    const nums = [], all = [];
    let seen = 0;
    for (const g of rule.ranges) for (let r = g.r1; r <= g.r2 && seen < MAX_CELLS; r++) for (let c = g.c1; c <= g.c2 && seen < MAX_CELLS; c++, seen++) {
      const v = value(r, c);
      all.push(v);
      if (isNum(v)) nums.push(v);
    }
    nums.sort((a, b) => a - b);
    const counts = new Map();
    for (const v of all) if (v !== null && v !== "" && v !== undefined) { const k = typeof v === "string" ? "s" + v.toLowerCase() : "n" + v; counts.set(k, (counts.get(k) || 0) + 1); }
    const sum = nums.reduce((a, b) => a + b, 0);
    const st = { nums, counts, avg: nums.length ? sum / nums.length : 0, std: nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - sum / nums.length) ** 2, 0) / (nums.length - 1)) : 0 };
    stats.set(rule, st);
    return st;
  };
  const point = (st, p, def) => {
    if (!p) p = { kind: def };
    const n = st.nums;
    switch (p.kind) {
      case "min": return n[0] ?? 0;
      case "max": return n[n.length - 1] ?? 0;
      case "percent": return (n[0] ?? 0) + ((n[n.length - 1] ?? 0) - (n[0] ?? 0)) * (+p.val / 100);
      case "percentile": return percentile(n, +p.val / 100);
      default: return +p.val || 0;
    }
  };
  const topLeft = (rule) => rule.ranges.reduce((a, g) => ({ r: Math.min(a.r, g.r1), c: Math.min(a.c, g.c1) }), { r: Infinity, c: Infinity });
  const rel = (rule, src, r, c) => { const tl = topLeft(rule); const f = F.shift("=" + src, r - tl.r, c - tl.c); return evaluate(f, r, c); };
  const cmp = (a, b) => (isNum(a) && isNum(b) ? a - b : F.compare(a, b));
  const today = () => { const d = new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 864e5); };
  function matches(rule, v, r, c) {
    const R = rule.rule;
    switch (R.type) {
      case "cell": {
        if (v === null || v === undefined || v === "") return false;
        const a = rel(rule, R.a, r, c);
        if (R.op === "between" || R.op === "notBetween") { const b = rel(rule, R.b, r, c); const lo = cmp(a, b) <= 0 ? a : b, hi = lo === a ? b : a; const inside = cmp(v, lo) >= 0 && cmp(v, hi) <= 0; return R.op === "between" ? inside : !inside; }
        const d = cmp(v, a);
        return { gt: d > 0, lt: d < 0, ge: d >= 0, le: d <= 0, eq: d === 0, ne: d !== 0 }[R.op] ?? false;
      }
      case "text": {
        if (v === null || v === undefined) return R.op === "notContains";
        const s = String(typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v).toLowerCase(), t = String(R.text || "").toLowerCase();
        return { contains: s.includes(t), notContains: !s.includes(t), begins: s.startsWith(t), ends: s.endsWith(t) }[R.op] ?? false;
      }
      case "top": {
        if (!isNum(v)) return false;
        const st = statOf(rule), n = st.nums;
        let k = R.percent ? Math.max(1, Math.floor((n.length * (+R.n || 10)) / 100)) : Math.max(1, +R.n || 10);
        k = Math.min(k, n.length);
        return R.bottom ? v <= n[k - 1] : v >= n[n.length - k];
      }
      case "avg": { if (!isNum(v)) return false; const st = statOf(rule); const lim = st.avg + (R.std ? (R.below ? -1 : 1) * R.std * st.std : 0); return R.below ? (R.equal ? v <= lim : v < lim) : R.equal ? v >= lim : v > lim; }
      case "dup": { if (v === null || v === undefined || v === "") return false; const n = statOf(rule).counts.get(typeof v === "string" ? "s" + v.toLowerCase() : "n" + v) || 0; return R.unique ? n === 1 : n > 1; }
      case "blank": { const b = v === null || v === undefined || (typeof v === "string" && !v.trim()); return R.not ? !b : b; }
      case "error": { const e = F.isErr(v); return R.not ? !e : e; }
      case "date": {
        if (!isNum(v)) return false;
        const t = today(), d = Math.floor(v), wd = new Date(Date.UTC(1899, 11, 30) + t * 864e5).getUTCDay();
        const weekStart = t - wd, ym = (x) => { const dt = new Date(Date.UTC(1899, 11, 30) + x * 864e5); return dt.getUTCFullYear() * 12 + dt.getUTCMonth(); };
        return {
          today: d === t, yesterday: d === t - 1, tomorrow: d === t + 1, last7Days: d > t - 7 && d <= t,
          thisWeek: d >= weekStart && d < weekStart + 7, lastWeek: d >= weekStart - 7 && d < weekStart, nextWeek: d >= weekStart + 7 && d < weekStart + 14,
          thisMonth: ym(d) === ym(t), lastMonth: ym(d) === ym(t) - 1, nextMonth: ym(d) === ym(t) + 1,
        }[R.period] ?? false;
      }
      case "expr": { const x = rel(rule, R.f, r, c); return x === true || (isNum(x) && x !== 0); }
    }
    return false;
  }
  const inRule = (rule, r, c) => rule.ranges.some((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);
  return {
    rules,
    at(r, c) {
      let out = null;
      const set = (k, v) => { if (v === undefined || v === null) return; out = out || {}; if (out[k] === undefined) out[k] = v; };
      for (const rule of rules) {
        if (!inRule(rule, r, c)) continue;
        const v = value(r, c), R = rule.rule;
        if (R.type === "scale") {
          if (!isNum(v)) continue;
          const st = statOf(rule), stops = R.stops?.length >= 2 ? R.stops : [{ kind: "min", color: "#f8696b" }, { kind: "max", color: "#63be7b" }];
          const pts = stops.map((s, i) => ({ x: point(st, s, i === 0 ? "min" : i === stops.length - 1 ? "max" : "percentile"), color: s.color }));
          let color = pts[0].color;
          if (v >= pts[pts.length - 1].x) color = pts[pts.length - 1].color;
          else for (let i = 0; i < pts.length - 1; i++) if (v >= pts[i].x && v <= pts[i + 1].x) { color = lerpColor(pts[i].color, pts[i + 1].color, pts[i + 1].x === pts[i].x ? 0 : (v - pts[i].x) / (pts[i + 1].x - pts[i].x)); break; }
          set("bg", color);
        } else if (R.type === "bar") {
          if (!isNum(v)) continue;
          const st = statOf(rule);
          const lo = Math.min(0, point(st, R.min, "min")), hi = Math.max(0, point(st, R.max, "max"));
          const span = hi - lo || 1, zero = (0 - lo) / span;
          const x = (Math.max(lo, Math.min(hi, v)) - lo) / span;
          if (!out?.bar) { out = out || {}; out.bar = { from: Math.min(zero, x), to: Math.max(zero, x), color: R.color || "#638ec6", neg: v < 0 }; }
        } else if (R.type === "icons") {
          if (!isNum(v)) continue;
          const st = statOf(rule), n = iconCount(R.set);
          const stops = R.stops?.length === n - 1 ? R.stops : Array.from({ length: n - 1 }, (_, i) => ({ kind: "percent", val: Math.round(((i + 1) * 100) / n) }));
          let level = 0;
          stops.forEach((s, i) => { const x = s.kind === "num" ? +s.val : point(st, s, "percent"); if (s.gt ? v > x : v >= x) level = i + 1; });
          if (R.reverse) level = n - 1 - level;
          if (!out?.icon) { out = out || {}; out.icon = { ...iconFor(R.set, level, n), hide: !!R.hideValue }; }
        } else if (matches(rule, v, r, c)) {
          for (const k of ["bg", "color", "b", "i", "u", "s"]) set(k, rule.style?.[k]);
          if (rule.stop) break;
        }
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------ charts

const PALETTE = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47", "#264478", "#9e480e", "#636363", "#997300", "#255e91", "#43682b"];
const CHART_TYPES = [["column", "Column"], ["bar", "Bar"], ["line", "Line"], ["area", "Area"], ["pie", "Pie"], ["doughnut", "Doughnut"], ["scatter", "Scatter"]];
const escX = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A chart's data from its refs. $read(sheetName, r, c) → value; $text(sheetName, r, c) → the value as shown.
 * Returns { cats: [label], series: [{ name, vals: [number|null], xs?: [number] }] }.
 */
function chartData(chart, read, text) {
  const cells = (ref) => { const g = M.parseRef(ref); if (!g || !g.sheet) return []; const out = []; for (let r = g.r1; r <= g.r2 && out.length < 5000; r++) for (let c = g.c1; c <= g.c2 && out.length < 5000; c++) out.push([g.sheet, r, c]); return out; };
  const series = (chart.series || []).map((s, i) => {
    let name = `Series ${i + 1}`;
    if (typeof s.name === "string" && s.name) name = s.name[0] === '"' ? s.name.slice(1, -1).replace(/""/g, '"') : cells(s.name).map(([sh, r, c]) => text(sh, r, c)).join(" ");
    const vals = cells(s.val).map(([sh, r, c]) => { const v = read(sh, r, c); return isNum(v) ? v : null; });
    const out = { name, vals };
    if (chart.type === "scatter" && s.cat) out.xs = cells(s.cat).map(([sh, r, c]) => { const v = read(sh, r, c); return isNum(v) ? v : null; });
    return out;
  });
  const catRef = chart.series?.find((s) => s.cat)?.cat;
  const n = Math.max(0, ...series.map((s) => s.vals.length));
  const cats = catRef ? cells(catRef).map(([sh, r, c]) => text(sh, r, c)) : Array.from({ length: n }, (_, i) => String(i + 1));
  return { cats, series };
}

/** "Nice" axis steps: about $count ticks covering lo..hi. */
function ticks(lo, hi, count = 5) {
  if (lo === hi) { if (lo === 0) hi = 1; else if (lo > 0) lo = 0; else hi = 0; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const out = [];
  for (let x = a; x <= b + step / 2; x += step) out.push(Math.round(x / step) * step);
  return out;
}
function short(v, percent) {
  if (percent) return `${Math.round(v * 100)}%`;
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return String(+v.toFixed(Math.abs(v) < 1 ? 2 : Math.abs(v) < 10 ? 1 : 0)).replace(/^-0$/, "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const fit = (s, max) => { s = String(s ?? ""); return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s; };

/** The chart as SVG (text), $w × $h px. */
function chartSvg(chart, data, w, h, { font = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif", dark = false } = {}) {
  const ink = dark ? "#e5e7eb" : "#404040", mute = dark ? "#9ca3af" : "#7f7f7f", grid = dark ? "#374151" : "#d9d9d9", bgc = dark ? "#111827" : "#ffffff";
  const out = [];
  const T = (x, y, s, o = {}) => out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${o.fill || ink}" font-size="${o.size || 11}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.bold ? ' font-weight="700"' : ""}${o.rot ? ` transform="rotate(${o.rot} ${x.toFixed(1)} ${y.toFixed(1)})"` : ""}>${escX(s)}</text>`);
  const type = chart.type || "column";
  const series = data.series.filter((s) => s.vals.length);
  let top = 10;
  if (chart.title) { T(w / 2, 24, fit(chart.title, Math.floor(w / 9)), { size: 15, anchor: "middle", bold: false }); top = 38; }
  const color = (i) => chart.colors?.[i] || PALETTE[i % PALETTE.length];
  const pie = type === "pie" || type === "doughnut";
  // Legend: series names (pies: categories), at the right or the bottom.
  const legendItems = pie ? data.cats.map((c, i) => [c, color(i)]) : series.map((s, i) => [s.name, color(i)]);
  const legend = chart.legend === "none" || (!pie && series.length < 2 && chart.legend !== "right" && chart.legend !== "bottom") ? null : chart.legend === "bottom" || w < 360 ? "bottom" : "right";
  let right = w - 12, bottom = h - 10;
  if (legend === "right") {
    const lw = Math.min(160, Math.max(...legendItems.map(([n]) => String(n).length)) * 6.5 + 26);
    const lh = legendItems.length * 18, y0 = Math.max(top, (top + h - lh) / 2);
    legendItems.slice(0, Math.floor((h - top) / 18)).forEach(([n, c], i) => { out.push(`<rect x="${(w - lw + 4).toFixed(1)}" y="${(y0 + i * 18 - 9).toFixed(1)}" width="10" height="10" fill="${c}"/>`); T(w - lw + 19, y0 + i * 18, fit(n, Math.floor((lw - 24) / 6.5)), { fill: ink }); });
    right = w - lw - 6;
  } else if (legend === "bottom") {
    let x = 12, row = 0;
    const items = legendItems.map(([n, c]) => { const t = fit(n, 22); const iw = t.length * 6.5 + 26; if (x + iw > w - 8 && x > 12) { x = 12; row++; } const it = { x, row, t, c }; x += iw; return it; });
    const rows = items.length ? items[items.length - 1].row + 1 : 0;
    bottom = h - 8 - rows * 18;
    for (const it of items) { const y = bottom + 14 + it.row * 18; out.push(`<rect x="${it.x}" y="${y - 9}" width="10" height="10" fill="${it.c}"/>`); T(it.x + 15, y, it.t); }
  }
  if (!series.length || !series.some((s) => s.vals.some((v) => v !== null))) {
    T(w / 2, (top + bottom) / 2, "No numbers to chart in the data", { fill: mute, anchor: "middle" });
    return wrapSvg(out, w, h, bgc, font);
  }
  if (pie) {
    const vals = series[0].vals.map((v) => (v && v > 0 ? v : 0)), total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 12 + (right - 12) / 2, cy = top + (bottom - top) / 2, rad = Math.max(10, Math.min(right - 12, bottom - top) / 2 - 6), hole = type === "doughnut" ? rad * 0.5 : 0;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (!v) return;
      const a1 = a0 + (v / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, r) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
      const d = v === total ? (hole ? `M${p(0, rad)}A${rad} ${rad} 0 1 1 ${p(Math.PI, rad)}A${rad} ${rad} 0 1 1 ${p(0, rad)}M${p(0, hole)}A${hole} ${hole} 0 1 0 ${p(Math.PI, hole)}A${hole} ${hole} 0 1 0 ${p(0, hole)}Z` : `M${p(0, rad)}A${rad} ${rad} 0 1 1 ${p(Math.PI, rad)}A${rad} ${rad} 0 1 1 ${p(0, rad)}Z`)
        : hole ? `M${p(a0, rad)}A${rad} ${rad} 0 ${large} 1 ${p(a1, rad)}L${p(a1, hole)}A${hole} ${hole} 0 ${large} 0 ${p(a0, hole)}Z` : `M${cx.toFixed(2)} ${cy.toFixed(2)}L${p(a0, rad)}A${rad} ${rad} 0 ${large} 1 ${p(a1, rad)}Z`;
      out.push(`<path d="${d}" fill="${color(i)}" stroke="${bgc}" stroke-width="1.5"${hole ? ' fill-rule="evenodd"' : ""}/>`);
      if (chart.labels !== false && v / total >= 0.04) { const am = (a0 + a1) / 2, lr = hole ? (rad + hole) / 2 : rad * 0.65; T(cx + Math.cos(am) * lr, cy + Math.sin(am) * lr + 4, `${Math.round((v / total) * 100)}%`, { anchor: "middle", fill: "#ffffff", size: 11 }); }
      a0 = a1;
    });
    return wrapSvg(out, w, h, bgc, font);
  }
  // Axes charts.
  const horiz = type === "bar", stacked = chart.grouping === "stacked" || chart.grouping === "percent", percent = chart.grouping === "percent";
  const n = Math.max(...series.map((s) => s.vals.length));
  let lo = Infinity, hi = -Infinity;
  if (type === "scatter") { for (const s of series) for (const v of s.vals) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  else if (stacked) {
    for (let i = 0; i < n; i++) { let pos = 0, neg = 0, tot = 0; for (const s of series) { const v = s.vals[i] ?? 0; if (v >= 0) pos += v; else neg += v; tot += Math.abs(v); } if (percent) { lo = Math.min(lo, tot ? neg / tot : 0); hi = Math.max(hi, tot ? pos / tot : 0); } else { lo = Math.min(lo, neg); hi = Math.max(hi, pos); } }
  } else for (const s of series) for (const v of s.vals) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (type !== "scatter" && type !== "line") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const tk = ticks(lo, hi, Math.max(2, Math.round((horiz ? right : bottom - top) / 60)));
  const vmin = tk[0], vmax = tk[tk.length - 1];
  const labW = Math.min(70, Math.max(...tk.map((t) => short(t, percent).length)) * 6.5 + 8);
  const catLabW = horiz ? Math.min(110, Math.max(20, ...data.cats.map((c) => String(c).length * 6.2)) + 8) : 0;
  const L = 12 + (horiz ? catLabW : labW), B = bottom - (horiz ? 20 : 22), Rr = right - 6, Tt = top + 4;
  const val2px = (v) => (horiz ? L + ((v - vmin) / (vmax - vmin)) * (Rr - L) : B - ((v - vmin) / (vmax - vmin)) * (B - Tt));
  // Gridlines and value labels.
  for (const t of tk) {
    const p = val2px(t);
    if (horiz) { out.push(`<line x1="${p.toFixed(1)}" y1="${Tt}" x2="${p.toFixed(1)}" y2="${B}" stroke="${grid}"/>`); T(p, B + 15, short(t, percent), { anchor: "middle", fill: mute }); }
    else { out.push(`<line x1="${L}" y1="${p.toFixed(1)}" x2="${Rr}" y2="${p.toFixed(1)}" stroke="${grid}"/>`); T(L - 6, p + 4, short(t, percent), { anchor: "end", fill: mute }); }
  }
  if (type === "scatter") {
    let xlo = Infinity, xhi = -Infinity;
    for (const s of series) for (const x of s.xs || s.vals.map((_, i) => i + 1)) if (x !== null) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); }
    if (!Number.isFinite(xlo)) { xlo = 0; xhi = 1; }
    const xt = ticks(xlo, xhi, Math.max(2, Math.round((Rr - L) / 80)));
    const x2px = (x) => L + ((x - xt[0]) / (xt[xt.length - 1] - xt[0])) * (Rr - L);
    for (const t of xt) T(x2px(t), B + 15, short(t), { anchor: "middle", fill: mute });
    out.push(`<line x1="${L}" y1="${B}" x2="${Rr}" y2="${B}" stroke="${mute}"/>`);
    series.forEach((s, si) => { const xs = s.xs || s.vals.map((_, i) => i + 1); s.vals.forEach((v, i) => { if (v === null || xs[i] === null || xs[i] === undefined) return; out.push(`<circle cx="${x2px(xs[i]).toFixed(1)}" cy="${val2px(v).toFixed(1)}" r="3.5" fill="${color(si)}"/>`); }); });
    return wrapSvg(out, w, h, bgc, font);
  }
  // Categories.
  const slot = (horiz ? B - Tt : Rr - L) / Math.max(1, n);
  const catPos = (i) => (horiz ? Tt + slot * (i + 0.5) : L + slot * (i + 0.5));
  const every = Math.max(1, Math.ceil((horiz ? 16 : 14 + Math.min(10, Math.max(...data.cats.map((c) => String(c).length))) * 6) / slot));
  for (let i = 0; i < n; i += every) {
    const c = data.cats[i] ?? String(i + 1);
    if (horiz) T(L - 6, catPos(i) + 4, fit(c, Math.floor(catLabW / 6.2)), { anchor: "end", fill: mute });
    else T(catPos(i), B + 15, fit(c, Math.max(4, Math.floor((slot * every) / 6.2))), { anchor: "middle", fill: mute });
  }
  const zero = val2px(Math.max(vmin, Math.min(vmax, 0)));
  out.push(horiz ? `<line x1="${zero.toFixed(1)}" y1="${Tt}" x2="${zero.toFixed(1)}" y2="${B}" stroke="${mute}"/>` : `<line x1="${L}" y1="${zero.toFixed(1)}" x2="${Rr}" y2="${zero.toFixed(1)}" stroke="${mute}"/>`);
  if (type === "column" || type === "bar") {
    const groupW = slot * 0.7, barW = stacked ? groupW : groupW / series.length;
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      const tot = percent ? series.reduce((a, s) => a + Math.abs(s.vals[i] ?? 0), 0) || 1 : 1;
      series.forEach((s, si) => {
        let v = s.vals[i];
        if (v === null || v === undefined) return;
        if (percent) v /= tot;
        let a, b;
        if (stacked) { if (v >= 0) { a = pos; b = pos + v; pos = b; } else { a = neg; b = neg + v; neg = b; } } else { a = 0; b = v; }
        const p1 = val2px(a), p2 = val2px(b), off = catPos(i) - groupW / 2 + (stacked ? 0 : barW * si);
        const rect = horiz ? [Math.min(p1, p2), off, Math.abs(p2 - p1), barW] : [off, Math.min(p1, p2), barW, Math.abs(p2 - p1)];
        out.push(`<rect x="${rect[0].toFixed(1)}" y="${rect[1].toFixed(1)}" width="${Math.max(0.5, rect[2]).toFixed(1)}" height="${Math.max(0.5, rect[3]).toFixed(1)}" fill="${color(si)}"/>`);
        if (chart.labels && !stacked) T(horiz ? Math.max(p1, p2) + 4 : off + barW / 2, horiz ? off + barW / 2 + 4 : Math.min(p1, p2) - 4, short(v, percent), { anchor: horiz ? "start" : "middle", size: 10 });
      });
    }
  } else {
    // Lines and areas.
    const base = new Array(n).fill(0);
    const tots = Array.from({ length: n }, (_, i) => (percent ? series.reduce((a, s) => a + Math.abs(s.vals[i] ?? 0), 0) || 1 : 1));
    const layers = series.map((s) => s.vals.map((v, i) => { if (v === null || v === undefined) return null; const x = percent ? v / tots[i] : v; if (!stacked) return [0, x]; const a = base[i]; base[i] += x; return [a, base[i]]; }));
    const order = type === "area" && !stacked ? layers.map((_, i) => i) : layers.map((_, i) => i);
    for (const si of order) {
      const pts = layers[si].map((p, i) => (p ? [catPos(i), val2px(p[1]), val2px(p[0])] : null));
      if (type === "area") {
        const run = pts.filter(Boolean);
        if (run.length) out.push(`<path d="M${run.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}L${run.slice().reverse().map((p) => `${p[0].toFixed(1)} ${(stacked ? p[2] : zero).toFixed(1)}`).join("L")}Z" fill="${color(si)}" fill-opacity="${stacked ? 1 : 0.55}"/>`);
      } else {
        let d = "", pen = false;
        for (const p of pts) { if (!p) { pen = false; continue; } d += `${pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`; pen = true; }
        out.push(`<path d="${d}" fill="none" stroke="${color(si)}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`);
        if (n <= 40) for (const p of pts) if (p) out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${color(si)}"/>`);
      }
    }
  }
  return wrapSvg(out, w, h, bgc, font);
}
const wrapSvg = (parts, w, h, bg, font) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${escX(font)}"><rect width="${w}" height="${h}" fill="${bg}"/>${parts.join("")}</svg>`;

/**
 * Series for a new chart from a block of cells (sheet name, r1..r2, c1..c2): text along the top row and/or down the left
 * column become names and categories; each column (or row, if $byRow, or if there are more columns than rows) a series.
 */
function seriesFrom(sheetName, g, read, byRow = null) {
  const isLabel = (v) => typeof v === "string" || v === null || v === undefined;
  let r1 = g.r1, c1 = g.c1;
  const headRow = g.r2 > g.r1 && [...Array(g.c2 - g.c1 + 1).keys()].every((i) => isLabel(read(g.r1, g.c1 + i))) && [...Array(g.c2 - g.c1 + 1).keys()].some((i) => typeof read(g.r1, g.c1 + i) === "string");
  const headCol = g.c2 > g.c1 && [...Array(g.r2 - g.r1 + 1).keys()].every((i) => i === 0 || isLabel(read(g.r1 + i, g.c1))) && [...Array(g.r2 - g.r1 + 1).keys()].some((i) => i > 0 && typeof read(g.r1 + i, g.c1) === "string");
  if (headRow) r1++;
  if (headCol) c1++;
  const rows = g.r2 - r1 + 1, cols = g.c2 - c1 + 1;
  const along = byRow ?? (cols > rows && rows <= 4);
  const ref = (a, b, c, d) => M.refOf(sheetName, a, b, c, d);
  const series = [];
  if (!along) {
    for (let c = c1; c <= g.c2; c++) series.push({ name: headRow ? ref(g.r1, c) : null, cat: headCol ? ref(r1, g.c1, g.r2, g.c1) : null, val: ref(r1, c, g.r2, c) });
  } else {
    for (let r = r1; r <= g.r2; r++) series.push({ name: headCol ? ref(r, g.c1) : null, cat: headRow ? ref(g.r1, c1, g.r1, g.c2) : null, val: ref(r, c1, r, g.c2) });
  }
  // Columns (or rows) with no numbers in them aren't series: labels beside the data, like a product name.
  const numeric = (ref) => { const x = M.parseRef(ref); for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) if (isNum(read(r, c))) return true; return false; };
  return series.filter((s) => numeric(s.val)).slice(0, 24);
}

// ------------------------------------------------------------------------------------------------ pivot tables

const FNS = { sum: "Sum", count: "Count", average: "Average", max: "Max", min: "Min" };
const blankKey = "\u0000(blank)";
const keyOf = (v) => (v === null || v === undefined || v === "" ? blankKey : typeof v === "string" ? "s" + v : "n" + String(v));
const sortKeys = (a, b) => { if (a.k === blankKey) return 1; if (b.k === blankKey) return -1; return F.compare(a.v, b.v); };

/**
 * A pivot table's summary: $rows of the source (first row: field names), and the definition { rows, cols, vals }.
 * Returns { cells: [[{ v, b?, nf? }]], fields } — a grid starting at the pivot's top left, or { error }.
 */
function pivot(table, def, nfOf = () => null) {
  if (!table.length) return { error: "The source has no rows." };
  const names = table[0].map((v, i) => (v === null || v === undefined || v === "" ? `Column ${i + 1}` : String(v)));
  const idx = (f) => names.findIndex((n) => n.toLowerCase() === String(f).toLowerCase());
  const rowF = (def.rows || []).map(idx), colF = (def.cols || []).map(idx), vals = (def.vals || []).map((v) => ({ ...v, i: idx(v.field), fn: FNS[v.fn] ? v.fn : "sum" }));
  if ([...rowF, ...colF].some((i) => i < 0) || vals.some((v) => v.i < 0)) return { error: "A field in this pivot table isn't in the source any more." };
  if (!vals.length) vals.push({ field: names[0], i: 0, fn: "count" });
  const data = table.slice(1).filter((r) => r.some((v) => v !== null && v !== undefined && v !== ""));
  // Accumulators by row key and column key.
  const acc = new Map();
  const add = (rk, ck, row) => {
    const k = rk + "\u0001" + ck;
    let a = acc.get(k);
    if (!a) acc.set(k, (a = vals.map(() => ({ sum: 0, n: 0, nums: 0, max: -Infinity, min: Infinity }))));
    vals.forEach((v, j) => { const x = row[v.i]; if (x !== null && x !== undefined && x !== "") a[j].n++; if (isNum(x)) { a[j].sum += x; a[j].nums++; a[j].max = Math.max(a[j].max, x); a[j].min = Math.min(a[j].min, x); } });
  };
  const rowKeys = new Map(), colKeys = new Map();
  for (const row of data) {
    const rv = rowF.map((i) => row[i]), cv = colF.map((i) => row[i]);
    const rk = rv.map(keyOf).join("\u0002"), ck = cv.map(keyOf).join("\u0002");
    if (!rowKeys.has(rk)) rowKeys.set(rk, rv);
    if (!colKeys.has(ck)) colKeys.set(ck, cv);
    for (const r of [rk, "*"]) for (const c of [ck, "*"]) add(r, c, row);
  }
  const sortTuples = (m) => [...m.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => { for (let i = 0; i < a.v.length; i++) { const d = sortKeys({ k: keyOf(a.v[i]), v: a.v[i] }, { k: keyOf(b.v[i]), v: b.v[i] }); if (d) return d; } return 0; });
  const rk = rowF.length ? sortTuples(rowKeys) : [{ k: "", v: [] }];
  const ck = colF.length ? sortTuples(colKeys) : [{ k: "", v: [] }];
  const result = (r, c, j) => { const a = acc.get(r + "\u0001" + c)?.[j]; if (!a) return null; switch (vals[j].fn) { case "count": return a.n; case "average": return a.nums ? a.sum / a.nums : null; case "max": return a.nums ? a.max : null; case "min": return a.nums ? a.min : null; default: return a.sum; } };
  const label = (v) => (v === null || v === undefined || v === "" ? "(blank)" : v);
  const vName = (v) => `${FNS[v.fn]} of ${names[v.i]}`;
  const nfs = vals.map((v) => (v.fn === "count" ? null : nfOf(v.i)));
  const cells = [];
  const multi = vals.length > 1;
  // Header: row field names, then a column per (column item × value), then grand totals.
  const head = rowF.length ? rowF.map((i) => ({ v: names[i], b: true })) : [{ v: "", b: true }];
  const colHeads = [];
  if (colF.length) {
    for (const c of ck) for (let j = 0; j < vals.length; j++) colHeads.push({ c: c.k, j, v: c.v.map(label).join(" / ") + (multi ? ` – ${vName(vals[j])}` : "") });
    for (let j = 0; j < vals.length; j++) colHeads.push({ c: "*", j, v: multi ? `Total ${vName(vals[j])}` : "Grand Total" });
    cells.push([{ v: multi ? "Values" : vName(vals[0]), b: true }, ...Array(rowF.length ? rowF.length - 1 : 0).fill({ v: "", b: true }), { v: colF.map((i) => names[i]).join(" / "), b: true }]);
  } else for (let j = 0; j < vals.length; j++) colHeads.push({ c: "", j, v: vName(vals[j]) });
  cells.push([...head, ...colHeads.map((x) => ({ v: x.v, b: true }))]);
  if (rowF.length) for (const r of rk) cells.push([...r.v.map((v) => ({ v: label(v) })), ...colHeads.map((x) => ({ v: result(r.k, x.c, x.j), nf: nfs[x.j] }))]);
  cells.push([{ v: rowF.length ? "Grand Total" : "Total", b: true }, ...Array(Math.max(0, rowF.length - 1)).fill({ v: "", b: true }), ...colHeads.map((x) => ({ v: result("*", x.c === "" ? "" : x.c, x.j), nf: nfs[x.j], b: true }))]);
  // Without row fields, the totals row is the only one, and "*" has the column totals.
  if (!rowF.length) cells[cells.length - 1] = [{ v: "Total", b: true }, ...colHeads.map((x) => ({ v: result("*", x.c === "" ? "*" : x.c, x.j), nf: nfs[x.j], b: true }))];
  else cells[cells.length - 1] = [{ v: "Grand Total", b: true }, ...Array(rowF.length - 1).fill({ v: "", b: true }), ...colHeads.map((x) => ({ v: result("*", colF.length ? x.c : "*", x.j), nf: nfs[x.j], b: true }))];
  return { cells, fields: names };
}

return { conditional, ruleLabel, ICON_SETS, iconFor, iconCount, chartData, chartSvg, seriesFrom, CHART_TYPES, PALETTE, pivot, PIVOT_FNS: FNS, ticks };
});
