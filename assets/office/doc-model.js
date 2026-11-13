// The document's changes ("ops"): what each edit is, applying it, undoing it, and working it out again against edits
// other people made at the same moment (rebase). Every paragraph has an id that never changes, so two people working in
// different paragraphs never touch; in the same paragraph, positions are moved past each other's typing. Tables merge
// cell by cell. Works in the browser (window.OfficeDocModel) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OfficeDocModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/*
 * Ops ("at", "from", "to" count characters in the paragraph's text, as the browser does):
 *   { t: "text", id, at, del, ins: [runs] }        typing, deleting, pasting inside a paragraph
 *   { t: "fmt", id, from, to, set: { b: true, color: null } }
 *   { t: "para", id, set: { style, align, indent, list } }   (null removes)
 *   { t: "split", id, at, newId }                   Enter: the rest becomes a new paragraph after it, styled the same
 *   { t: "join", id, next, at }                     Backspace at the start of $next: it joins $id ($at: $id's length then)
 *   { t: "insert", after, block }                   after: an id, or null for the top
 *   { t: "delete", id, prev }                       prev: the block before it then (where things inserted after it go)
 *   { t: "replace", id, block }                     a picture or a whole table changed
 *   { t: "cell", id, r, c, blocks }                 one table cell's contents
 *   { t: "page", page } / { t: "hf", which: "header" | "footer", blocks }
 */
/** A link that's safe to show and follow: web, email and phone addresses, and places in the document. Null otherwise. */
const safeHref = (href) => {
  const h = String(href ?? "").trim().replace(/[\u0000-\u001f\u007f\s]+/g, (m) => (m.trim() === "" && !/[\u0000-\u001f\u007f]/.test(m) ? "%20" : ""));
  return /^(https?:\/\/|mailto:|tel:|#)/i.test(h) && h.length <= 2000 ? h : null;
};
const RUN_KEYS = ["b", "i", "u", "s", "sup", "sub", "color", "bg", "font", "size", "href"];
const len = (runs) => runs.reduce((n, r) => n + r.text.length, 0);
const textOf = (b) => (b.runs || []).map((r) => r.text).join("");
const props = (r) => { const p = {}; for (const k of RUN_KEYS) if (r[k] !== undefined && r[k] !== null && r[k] !== false) p[k] = r[k]; if (p.href !== undefined) { const h = safeHref(p.href); if (h) p.href = h; else delete p.href; } return p; };
const same = (a, b) => { for (const k of RUN_KEYS) if ((a[k] ?? null) !== (b[k] ?? null) && !(a[k] === false && b[k] == null) && !(b[k] === false && a[k] == null)) return false; return true; };
function tidy(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && same(last, r)) last.text += r.text; else out.push({ text: r.text, ...props(r) });
  }
  return out;
}
/** Runs [from, to). */
function slice(runs, from, to) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end > from && pos < to) out.push({ ...r, text: r.text.slice(Math.max(0, from - pos), Math.min(r.text.length, to - pos)) });
    pos = end;
  }
  return tidy(out);
}
function splice(runs, at, del, ins) {
  const n = len(runs);
  at = Math.max(0, Math.min(at, n));
  del = Math.max(0, Math.min(del, n - at));
  // Typing with no formatting of its own takes the formatting of the character before (as word processors do).
  if (ins.length && ins.every((r) => !Object.keys(props(r)).length) && at > 0) {
    const before = slice(runs, at - 1, at)[0];
    const keep = before ? props(before) : {};
    delete keep.href;
    ins = ins.map((r) => ({ ...keep, ...r }));
  }
  return tidy([...slice(runs, 0, at), ...ins, ...slice(runs, at + del, n)]);
}
function format(runs, from, to, set) {
  const n = len(runs);
  from = Math.max(0, Math.min(from, n)); to = Math.max(from, Math.min(to, n));
  const mid = slice(runs, from, to).map((r) => { const x = { ...r }; for (const [k, v] of Object.entries(set)) { if (v === null || v === false) delete x[k]; else x[k] = v; if (k === "sup" && v) delete x.sub; if (k === "sub" && v) delete x.sup; } return x; });
  return tidy([...slice(runs, 0, from), ...mid, ...slice(runs, to, n)]);
}

let seq = 0;
const newId = () => "b" + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 7);
const index = (doc, id) => doc.blocks.findIndex((b) => b.id === id);
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const clone = (doc) => ({ ...doc, page: copy(doc.page), header: doc.header && doc.header.map((b) => ({ ...b, runs: b.runs?.map((r) => ({ ...r })) })), footer: doc.footer && doc.footer.map((b) => ({ ...b, runs: b.runs?.map((r) => ({ ...r })) })),
  blocks: doc.blocks.map((b) => (b.type === "p" ? { ...b, runs: b.runs.map((r) => ({ ...r })), list: b.list && { ...b.list } } : b)) });
const P_KEYS = ["style", "align", "indent", "list"];

/** Applies $op to $doc (changing it). Returns the ids of the blocks to draw again, or "all", or null for no change. */
function apply(doc, op) {
  const i = op.id !== undefined ? index(doc, op.id) : -1;
  const b = i >= 0 ? doc.blocks[i] : null;
  switch (op.t) {
    case "text":
      if (!b || b.type !== "p") return null;
      doc.blocks[i] = { ...b, runs: splice(b.runs, op.at, op.del || 0, op.ins || []) };
      return [b.id];
    case "fmt":
      if (!b || b.type !== "p") return null;
      doc.blocks[i] = { ...b, runs: format(b.runs, op.from, op.to, op.set || {}) };
      return [b.id];
    case "para": {
      if (!b || b.type !== "p") return null;
      const nb = { ...b };
      for (const k of P_KEYS) if (k in (op.set || {})) { const v = op.set[k]; if (v === null || v === undefined || v === "" || v === 0 || (k === "style" && v === "normal")) delete nb[k]; else nb[k] = copy(v); }
      doc.blocks[i] = nb;
      return [b.id];
    }
    case "split": {
      if (!b || b.type !== "p" || index(doc, op.newId) >= 0) return null;
      const n = len(b.runs), at = Math.max(0, Math.min(op.at, n));
      const rest = { ...b, id: op.newId, runs: slice(b.runs, at, n) };
      // A heading ends at Enter: what follows is ordinary text (unless it's the heading's own end being moved down).
      if (/^(h\d|title)$/.test(b.style || "") && at === n) delete rest.style;
      doc.blocks.splice(i, 1, { ...b, runs: slice(b.runs, 0, at) }, rest);
      return [b.id, op.newId];
    }
    case "join": {
      const j = index(doc, op.next);
      if (!b || j < 0 || b.type !== "p" || doc.blocks[j].type !== "p") return null;
      doc.blocks[i] = { ...b, runs: tidy([...b.runs, ...doc.blocks[j].runs]) };
      doc.blocks.splice(j, 1);
      return "all";
    }
    case "insert": {
      if (!op.block?.id || index(doc, op.block.id) >= 0) return null;
      const at = op.after == null ? 0 : index(doc, op.after) + 1;
      doc.blocks.splice(at > 0 || op.after == null ? at : doc.blocks.length, 0, copy(op.block));
      return "all";
    }
    case "delete":
      // A document always ends with a paragraph (somewhere to type after a table or picture): that one is emptied instead.
      if (!b || doc.blocks.length < 2 || (i === doc.blocks.length - 1 && doc.blocks[i - 1]?.type !== "p")) { if (b) doc.blocks[i] = { id: b.id, type: "p", runs: [] }; return b ? "all" : null; }
      doc.blocks.splice(i, 1);
      return "all";
    case "replace":
      if (!b) return null;
      doc.blocks[i] = { ...copy(op.block), id: b.id };
      return [b.id];
    case "cell": {
      if (!b || b.type !== "table") return null;
      const row = b.rows[op.r], cell = row?.cells[op.c];
      if (!cell) return null;
      const rows = b.rows.slice();
      rows[op.r] = { ...row, cells: row.cells.slice() };
      rows[op.r].cells[op.c] = { ...cell, blocks: copy(op.blocks) };
      doc.blocks[i] = { ...b, rows };
      return [b.id];
    }
    case "page": doc.page = copy(op.page); return "all";
    case "hf": doc[op.which === "footer" ? "footer" : "header"] = op.blocks?.length ? copy(op.blocks) : null; return "all";
  }
  return null;
}

/** Where position $p ends up after $a (a text change in the same paragraph). $end: the end of a range, which stays before typed text. */
function mapPos(p, a, end = false) {
  const L = len(a.ins || []), d = a.del || 0;
  if (p < a.at || (end && p === a.at && d === 0)) return p;
  if (p > a.at + d || (p === a.at + d && !end)) return p - d + L;
  return end ? a.at : a.at + L;
}

/**
 * $op, made before $against happened (other people's changes, already applied, in order), worked out again so it
 * means the same now. Returns an op, a list of ops (a change that a new paragraph break now cuts in two), or null.
 */
function rebase(op, against) {
  let ops = [op];
  for (const a of against) ops = ops.flatMap((o) => { const r = past(o, a); return r === null ? [] : Array.isArray(r) ? r : [r]; });
  return ops.length === 0 ? null : ops.length === 1 ? ops[0] : ops;
}
function past(o, a) {
  // Where a block went: deleted, or joined into the one before it.
  const gone = (id) => (a.t === "delete" && a.id === id) || (a.t === "join" && a.next === id);
  switch (o.t) {
    case "insert": {
      let after = o.after;
      if (a.t === "delete" && a.id === after) after = a.prev ?? null;
      if (a.t === "join" && a.next === after) after = a.id;
      if (a.t === "split" && a.id === after) after = a.newId; // inserted after the paragraph, so after both halves
      return after === o.after ? o : { ...o, after };
    }
    case "delete":
      if (gone(o.id)) return null;
      if (a.t === "delete" && a.id === o.prev) return { ...o, prev: a.prev ?? null };
      return o;
    case "replace": case "cell":
      if (gone(o.id)) return null;
      if (o.t === "cell" && a.t === "replace" && a.id === o.id) return null; // the table was rebuilt
      return o;
    case "page": case "hf":
      return o;
    case "para":
      if (a.t === "delete" && a.id === o.id) return null;
      if (a.t === "join" && a.next === o.id) return null; // its text now belongs to the paragraph before
      if (a.t === "split" && a.id === o.id) return [o, { ...o, id: a.newId }];
      return o;
    case "text": case "fmt": case "split": case "join":
      return pastPositional(o, a, gone);
  }
  return o;
}
function pastPositional(o, a, gone) {
  const range = o.t === "text" ? [o.at, o.at + (o.del || 0)] : o.t === "fmt" ? [o.from, o.to] : [o.at, o.at];
  const put = (id, s, e) => o.t === "text" ? { ...o, id, at: s, del: e - s } : o.t === "fmt" ? { ...o, id, from: s, to: e } : { ...o, id, at: s };
  if (o.t === "join") {
    if (gone(o.next)) return null;
    if (a.t === "delete" && a.id === o.id) return null;
    if (a.t === "join" && a.next === o.id) return { ...o, id: a.id, at: a.at + o.at };
    if (a.t === "split" && a.id === o.id) return { ...o, id: a.newId, at: o.at - a.at };
    if (a.t === "text" && a.id === o.id) return { ...o, at: o.at - (a.del || 0) + len(a.ins || []) };
    return o;
  }
  if (a.t === "delete" && a.id === o.id) return null;
  if (a.t === "replace" && a.id === o.id) return null;
  if (a.t === "join" && a.next === o.id) return put(a.id, range[0] + a.at, range[1] + a.at);
  if (a.id !== o.id) return o;
  if (a.t === "text") {
    const s = mapPos(range[0], a);
    if (o.t === "split") return put(o.id, s, s);
    if (o.t === "text") return put(o.id, s, range[1] === range[0] ? s : Math.max(s, mapPos(range[1], a, true)));
    const e = mapPos(range[1], a, true);
    return e <= s ? null : put(o.id, s, e);
  }
  if (a.t === "split") {
    const at = a.at;
    if (range[1] <= at) return o;
    if (range[0] >= at) return put(a.newId, range[0] - at, range[1] - at);
    if (o.t === "split") return o;
    // Across the break: one change for each half.
    const first = put(o.id, range[0], at), second = put(a.newId, 0, range[1] - at);
    if (o.t === "text") { second.ins = []; }
    return [first, second].filter((x) => x.t !== "fmt" || x.to > x.from);
  }
  if (a.t === "join" && a.id === o.id) return o; // the joined text went on the end: positions in $id don't move
  return o;
}

/** The op(s) that undo $op, worked out from $doc before $op is applied. */
function inverse(doc, op) {
  const i = op.id !== undefined ? index(doc, op.id) : -1;
  const b = i >= 0 ? doc.blocks[i] : null;
  switch (op.t) {
    case "text": {
      if (!b || b.type !== "p") return null;
      const n = len(b.runs), at = Math.max(0, Math.min(op.at, n)), del = Math.max(0, Math.min(op.del || 0, n - at));
      return { t: "text", id: op.id, at, del: len(op.ins || []), ins: slice(b.runs, at, at + del) };
    }
    case "fmt": {
      if (!b || b.type !== "p") return null;
      const n = len(b.runs), from = Math.max(0, Math.min(op.from, n)), to = Math.max(from, Math.min(op.to, n));
      return { t: "text", id: op.id, at: from, del: to - from, ins: slice(b.runs, from, to) };
    }
    case "para": return b && { t: "para", id: op.id, set: Object.fromEntries(Object.keys(op.set || {}).map((k) => [k, copy(b[k]) ?? null])) };
    case "split": return b && { t: "join", id: op.id, next: op.newId, at: Math.min(op.at, len(b.runs)) };
    case "join": {
      const nx = doc.blocks[index(doc, op.next)];
      if (!b || !nx) return null;
      return [{ t: "split", id: op.id, at: len(b.runs), newId: op.next }, { t: "para", id: op.next, set: Object.fromEntries(P_KEYS.map((k) => [k, copy(nx[k]) ?? null])) }];
    }
    case "insert": return op.block && { t: "delete", id: op.block.id, prev: op.after ?? null };
    case "delete": return b && { t: "insert", after: i > 0 ? doc.blocks[i - 1].id : null, block: copy(b) };
    case "replace": return b && { t: "replace", id: op.id, block: copy(b) };
    case "cell": { const cell = b?.rows?.[op.r]?.cells?.[op.c]; return cell && { t: "cell", id: op.id, r: op.r, c: op.c, blocks: copy(cell.blocks) }; }
    case "page": return { t: "page", page: copy(doc.page) };
    case "hf": return { t: "hf", which: op.which, blocks: copy(doc[op.which === "footer" ? "footer" : "header"]) || [] };
  }
  return null;
}

return { apply, rebase, inverse, clone, newId, len, textOf, slice, splice, format, tidy, props, same, safeHref, RUN_KEYS, P_KEYS };
});
