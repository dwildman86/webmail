// The spreadsheet's changes ("ops"): what each edit is, applying it, and working it out again against edits other
// people made at the same moment (rebase). Changes name cells by position, so inserting or deleting rows and columns
// moves later changes along; everything else merges cell by cell, the last change to reach the server winning.
// Works in the browser (window.OfficeSheetModel) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./formula.js"));
  else root.OfficeSheetModel = factory(root.OfficeFormula);
})(typeof self !== "undefined" ? self : this, function (F) {
"use strict";

/*
 * Ops (sheet = the sheet's id, which never changes; formulas name sheets, which can):
 *   { t: "set", sheet, cells: [[r, c, content | null]] }     content: { v } or { f: "=…" }; null empties it (keeps the style)
 *   { t: "style", sheet, cells: [[r, c, patch]] }             patch: { b: true, color: null, … } (null removes)
 *   { t: "ins" | "del", sheet, name, axis: "r" | "c", at, n } rows or columns (name: the sheet's, then)
 *   { t: "size", sheet, axis, i, px }                         px null = default
 *   { t: "merge", sheet, r1, c1, r2, c2, on }
 *   { t: "freeze", sheet, r, c }
 *   { t: "sheet", id, name, at }                              a new sheet
 *   { t: "sheetDel", id } / { t: "sheetName", id, name } / { t: "sheetMove", id, at } / { t: "sheetHide", id, hidden }
 *   { t: "sheetData", id, sheet }                             a whole sheet put back (undoing a delete)
 */
const KEY = (r, c) => `${r},${c}`;
const unkey = (k) => k.split(",").map(Number);
const sheetOf = (wb, id) => wb.sheets.find((s) => s.id === id);
const clone = (wb) => ({ ...wb, sheets: wb.sheets.map((s) => ({ ...s, cells: new Map(s.cells), cols: { ...s.cols }, rows: { ...s.rows }, merges: s.merges.map((m) => ({ ...m })), freeze: s.freeze && { ...s.freeze } })) });
const blank = (id, name) => ({ id, name, cells: new Map(), cols: {}, rows: {}, merges: [], freeze: null });

function patchStyle(s, patch) {
  const out = { ...(s || {}) };
  for (const [k, v] of Object.entries(patch || {})) { if (v === null || v === false || v === undefined) delete out[k]; else out[k] = v; }
  return Object.keys(out).length ? out : undefined;
}
/** Shifted positions after rows or columns are inserted/deleted: null when the position was deleted. */
function move(i, at, n) {
  if (n > 0) return i >= at ? i + n : i;
  if (i >= at && i < at - n) return null;
  return i >= at - n ? i + n : i;
}
function moveRange(a, b, at, n) {
  if (n > 0) return [a >= at ? a + n : a, b >= at ? b + n : b];
  const end = at - n; // deleted: [at, end)
  const na = a < at ? a : a >= end ? a + n : at;
  const nb = b < at ? b : b >= end ? b + n : at - 1;
  return nb < na ? null : [na, nb];
}

/** Applies $op to $wb (changing it). Returns what to redraw: { sheets: Set<id>, cells: [key] | "all", structure }. */
function apply(wb, op) {
  const sh = op.sheet !== undefined ? sheetOf(wb, op.sheet) : null;
  switch (op.t) {
    case "set":
      if (!sh) return null;
      for (const [r, c, content] of op.cells) {
        const k = KEY(r, c), old = sh.cells.get(k);
        const cell = { ...(content || {}) };
        if (old?.s) cell.s = old.s;
        if (cell.v === undefined && cell.f === undefined && !cell.s) sh.cells.delete(k);
        else sh.cells.set(k, { v: cell.v ?? null, ...(cell.f ? { f: cell.f } : {}), ...(cell.s ? { s: cell.s } : {}) });
      }
      return { sheet: sh.id, cells: op.cells.map(([r, c]) => KEY(r, c)) };
    case "style":
      if (!sh) return null;
      for (const [r, c, patch] of op.cells) {
        const k = KEY(r, c), old = sh.cells.get(k) || { v: null };
        const s = patchStyle(old.s, patch);
        const cell = { ...old };
        if (s) cell.s = s; else delete cell.s;
        if (cell.v == null && !cell.f && !cell.s) sh.cells.delete(k); else sh.cells.set(k, cell);
      }
      return { sheet: sh.id, cells: op.cells.map(([r, c]) => KEY(r, c)) };
    case "ins": case "del": {
      if (!sh) return null;
      const n = op.t === "ins" ? op.n : -op.n, ax = op.axis === "r" ? 0 : 1;
      const cells = new Map();
      for (const [k, cell] of sh.cells) {
        const p = unkey(k);
        const m = move(p[ax], op.at, n);
        if (m === null) continue;
        p[ax] = m;
        cells.set(KEY(p[0], p[1]), cell);
      }
      sh.cells = cells;
      const sizes = op.axis === "r" ? "rows" : "cols", next = {};
      for (const [i, px] of Object.entries(sh[sizes])) { const m = move(+i, op.at, n); if (m !== null) next[m] = px; }
      sh[sizes] = next;
      sh.merges = sh.merges.map((g) => {
        const [a, b] = op.axis === "r" ? [g.r1, g.r2] : [g.c1, g.c2];
        const mr = moveRange(a, b, op.at, n);
        if (!mr) return null;
        return op.axis === "r" ? { ...g, r1: mr[0], r2: mr[1] } : { ...g, c1: mr[0], c2: mr[1] };
      }).filter((g) => g && (g.r2 > g.r1 || g.c2 > g.c1));
      if (sh.freeze) { const k = op.axis; const f = sh.freeze[k]; if (f > op.at) sh.freeze = { ...sh.freeze, [k]: Math.max(op.at, f + n) }; }
      // Formulas everywhere that point at this sheet follow the cells.
      for (const s of wb.sheets) for (const [k, cell] of s.cells) if (cell.f) { const f = F.adjust(cell.f, s.name, sh.name, op.axis, op.at, n); if (f !== cell.f) s.cells.set(k, { ...cell, f }); }
      return { sheet: sh.id, cells: "all", structure: true, formulas: true };
    }
    case "size":
      if (!sh) return null;
      if (op.px == null) delete sh[op.axis === "r" ? "rows" : "cols"][op.i]; else sh[op.axis === "r" ? "rows" : "cols"][op.i] = Math.max(4, Math.min(2000, Math.round(op.px)));
      return { sheet: sh.id, cells: "all", structure: true };
    case "merge": {
      if (!sh) return null;
      const overlaps = (g) => !(g.r2 < op.r1 || g.r1 > op.r2 || g.c2 < op.c1 || g.c1 > op.c2);
      sh.merges = sh.merges.filter((g) => !overlaps(g));
      if (op.on && (op.r2 > op.r1 || op.c2 > op.c1)) sh.merges.push({ r1: op.r1, c1: op.c1, r2: op.r2, c2: op.c2 });
      return { sheet: sh.id, cells: "all", structure: true };
    }
    case "freeze":
      if (!sh) return null;
      sh.freeze = op.r || op.c ? { r: op.r | 0, c: op.c | 0 } : null;
      return { sheet: sh.id, cells: "all", structure: true };
    case "sheet": {
      if (sheetOf(wb, op.id)) return null;
      const name = uniqueName(wb, op.name);
      wb.sheets.splice(Math.max(0, Math.min(op.at ?? wb.sheets.length, wb.sheets.length)), 0, blank(op.id, name));
      return { sheets: true };
    }
    case "sheetData": {
      if (sheetOf(wb, op.id)) return null;
      const s = op.sheet;
      wb.sheets.splice(Math.max(0, Math.min(op.at ?? wb.sheets.length, wb.sheets.length)), 0, { ...blank(op.id, uniqueName(wb, s.name)), cells: new Map(s.cells), cols: { ...s.cols }, rows: { ...s.rows }, merges: s.merges.map((m) => ({ ...m })), freeze: s.freeze, hidden: s.hidden });
      return { sheets: true, formulas: true };
    }
    case "sheetDel": {
      const i = wb.sheets.findIndex((s) => s.id === op.id);
      if (i < 0 || wb.sheets.length < 2) return null;
      wb.sheets.splice(i, 1);
      return { sheets: true, formulas: true };
    }
    case "sheetName": {
      const s = sheetOf(wb, op.id);
      if (!s) return null;
      const from = s.name, to = uniqueName(wb, op.name, s);
      if (from === to) return null;
      s.name = to;
      for (const x of wb.sheets) for (const [k, cell] of x.cells) if (cell.f) { const f = F.renameSheet(cell.f, from, to); if (f !== cell.f) x.cells.set(k, { ...cell, f }); }
      return { sheets: true, formulas: true };
    }
    case "sheetMove": {
      const i = wb.sheets.findIndex((s) => s.id === op.id);
      if (i < 0) return null;
      const [s] = wb.sheets.splice(i, 1);
      wb.sheets.splice(Math.max(0, Math.min(op.at, wb.sheets.length)), 0, s);
      return { sheets: true };
    }
    case "sheetHide": {
      const s = sheetOf(wb, op.id);
      if (!s || (op.hidden && wb.sheets.filter((x) => !x.hidden).length < 2)) return null;
      if (op.hidden) s.hidden = true; else delete s.hidden;
      return { sheets: true };
    }
  }
  return null;
}
function uniqueName(wb, want, self = null) {
  let name = String(want || "Sheet").replace(/[\\/?*[\]:]/g, "").slice(0, 31).trim() || "Sheet";
  const taken = (n) => wb.sheets.some((s) => s !== self && s.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; ; i++) { const n = `${name.slice(0, 27)} (${i})`; if (!taken(n)) return n; }
}

/**
 * $op, made before $against happened (other people's changes, already applied, in order), worked out again so it
 * means the same now. Null when there's nothing left of it (its cells or sheet were deleted).
 */
function rebase(op, against) {
  let o = op;
  for (const a of against) { if (!o) return null; o = past(o, a); }
  return o;
}
function past(o, a) {
  if (a.t === "sheetDel" && (o.sheet === a.id || (o.t.startsWith("sheet") && o.t !== "sheet" && o.t !== "sheetData" && o.id === a.id))) return null;
  if (a.t !== "ins" && a.t !== "del") return o;
  if (o.sheet !== a.sheet) {
    // A formula on another sheet that points at the one that changed (by the name it had then).
    if (o.t !== "set" || !a.name) return o;
    const n = a.t === "ins" ? a.n : -a.n;
    return { ...o, cells: o.cells.map(([r, c, v]) => [r, c, v?.f ? { ...v, f: F.adjust(v.f, "\u0000", a.name, a.axis, a.at, n) } : v]) };
  }
  const n = a.t === "ins" ? a.n : -a.n, ax = a.axis === "r" ? 0 : 1;
  switch (o.t) {
    case "set": case "style": {
      const cells = [];
      for (const cell of o.cells) {
        const p = [cell[0], cell[1]];
        const m = move(p[ax], a.at, n);
        if (m === null) continue;
        p[ax] = m;
        let v = cell[2];
        if (o.t === "set" && v?.f) v = { ...v, f: F.adjust(v.f, null, null, a.axis, a.at, n) };
        cells.push([p[0], p[1], v]);
      }
      return cells.length ? { ...o, cells } : null;
    }
    case "ins": case "del": {
      if (o.axis !== a.axis) return o;
      if (o.t === "ins") { const at = a.t === "ins" ? (o.at >= a.at ? o.at + a.n : o.at) : o.at >= a.at + a.n ? o.at - a.n : o.at >= a.at ? a.at : o.at; return { ...o, at }; }
      const r = moveRange(o.at, o.at + o.n - 1, a.at, n);
      return r ? { ...o, at: r[0], n: r[1] - r[0] + 1 } : null;
    }
    case "size": { if (o.axis !== a.axis) return o; const i = move(o.i, a.at, n); return i === null ? null : { ...o, i }; }
    case "merge": {
      const [k1, k2] = a.axis === "r" ? ["r1", "r2"] : ["c1", "c2"];
      const r = moveRange(o[k1], o[k2], a.at, n);
      return r ? { ...o, [k1]: r[0], [k2]: r[1] } : null;
    }
    case "freeze": { const k = a.axis; if (o[k] > a.at) return { ...o, [k]: Math.max(a.at, o[k] + n) }; return o; }
  }
  return o;
}

/**
 * The op that undoes $op, worked out from $wb before $op is applied. Null if there's nothing to undo.
 */
function inverse(wb, op) {
  const sh = op.sheet !== undefined ? sheetOf(wb, op.sheet) : null;
  switch (op.t) {
    case "set": return sh && { t: "set", sheet: op.sheet, cells: op.cells.map(([r, c]) => { const x = sh.cells.get(KEY(r, c)); return [r, c, x && (x.f || x.v != null) ? (x.f ? { f: x.f } : { v: x.v }) : null]; }) };
    case "style": return sh && { t: "style", sheet: op.sheet, cells: op.cells.map(([r, c, patch]) => { const s = sh.cells.get(KEY(r, c))?.s || {}; return [r, c, Object.fromEntries(Object.keys(patch).map((k) => [k, s[k] ?? null]))]; }) };
    case "ins": return { t: "del", sheet: op.sheet, name: sh?.name, axis: op.axis, at: op.at, n: op.n };
    case "del": {
      if (!sh) return null;
      // Inserting them back, then their contents, styles and sizes.
      const ops = [{ t: "ins", sheet: op.sheet, name: sh.name, axis: op.axis, at: op.at, n: op.n }];
      const ax = op.axis === "r" ? 0 : 1, set = [], style = [];
      for (const [k, cell] of sh.cells) { const p = unkey(k); if (p[ax] >= op.at && p[ax] < op.at + op.n) { if (cell.f || cell.v != null) set.push([p[0], p[1], cell.f ? { f: cell.f } : { v: cell.v }]); if (cell.s) style.push([p[0], p[1], cell.s]); } }
      if (set.length) ops.push({ t: "set", sheet: op.sheet, cells: set });
      if (style.length) ops.push({ t: "style", sheet: op.sheet, cells: style });
      const sizes = sh[op.axis === "r" ? "rows" : "cols"];
      for (let i = op.at; i < op.at + op.n; i++) if (sizes[i]) ops.push({ t: "size", sheet: op.sheet, axis: op.axis, i, px: sizes[i] });
      // Formulas that pointed into them went #REF!: they're put back as they were (the rows or columns are back by then).
      for (const x of wb.sheets) {
        const cells = [];
        for (const [k, cell] of x.cells) {
          if (!cell.f) continue;
          const p = unkey(k);
          if (x === sh && p[ax] >= op.at && p[ax] < op.at + op.n) continue; // restored above
          if (F.adjust(cell.f, x.name, sh.name, op.axis, op.at, -op.n).includes("#REF!")) cells.push([p[0], p[1], { f: cell.f }]);
        }
        if (cells.length) ops.push({ t: "set", sheet: x.id, cells });
      }
      return ops;
    }
    case "size": return sh && { t: "size", sheet: op.sheet, axis: op.axis, i: op.i, px: sh[op.axis === "r" ? "rows" : "cols"][op.i] ?? null };
    case "merge": {
      if (!sh) return null;
      const overlaps = sh.merges.filter((g) => !(g.r2 < op.r1 || g.r1 > op.r2 || g.c2 < op.c1 || g.c1 > op.c2));
      return [{ t: "merge", sheet: op.sheet, r1: op.r1, c1: op.c1, r2: op.r2, c2: op.c2, on: false }, ...overlaps.map((g) => ({ t: "merge", sheet: op.sheet, ...g, on: true }))];
    }
    case "freeze": return sh && { t: "freeze", sheet: op.sheet, r: sh.freeze?.r || 0, c: sh.freeze?.c || 0 };
    case "sheet": return { t: "sheetDel", id: op.id };
    case "sheetData": return { t: "sheetDel", id: op.id };
    case "sheetDel": { const i = wb.sheets.findIndex((s) => s.id === op.id); const s = wb.sheets[i]; return s && { t: "sheetData", id: s.id, at: i, sheet: { name: s.name, cells: [...s.cells], cols: s.cols, rows: s.rows, merges: s.merges, freeze: s.freeze, hidden: s.hidden } }; }
    case "sheetName": { const s = sheetOf(wb, op.id); return s && { t: "sheetName", id: op.id, name: s.name }; }
    case "sheetMove": { const i = wb.sheets.findIndex((s) => s.id === op.id); return i >= 0 && { t: "sheetMove", id: op.id, at: i }; }
    case "sheetHide": { const s = sheetOf(wb, op.id); return s && { t: "sheetHide", id: op.id, hidden: !!s.hidden }; }
  }
  return null;
}

/** Ops travel as JSON: a sheet put back carries its cells as pairs. */
function revive(op) {
  if (op.t === "sheetData" && Array.isArray(op.sheet?.cells)) return { ...op, sheet: { ...op.sheet, cells: new Map(op.sheet.cells) } };
  return op;
}

/** The used area of a sheet: { rows, cols } (counts). */
function extent(sh) {
  let r = 0, c = 0;
  for (const k of sh.cells.keys()) { const [a, b] = unkey(k); if (a + 1 > r) r = a + 1; if (b + 1 > c) c = b + 1; }
  for (const g of sh.merges) { r = Math.max(r, g.r2 + 1); c = Math.max(c, g.c2 + 1); }
  return { rows: r, cols: c };
}

return { apply, rebase, inverse, revive, clone, extent, KEY, unkey, blank, uniqueName, patchStyle, move };
});
