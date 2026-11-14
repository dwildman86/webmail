// The presentation's changes ("ops"): slides, and on each slide its text boxes, shapes and pictures. Positions, sizes
// and looks are set property by property (two people moving and recolouring the same box both count); the text in a
// box is a small document, edited with the document's own ops (doc-model.js), so typing together in one box merges as
// it does in a document. Works in the browser (window.OfficePresModel) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./doc-model.js"));
  else root.OfficePresModel = factory(root.OfficeDocModel);
})(typeof self !== "undefined" ? self : this, function (D) {
"use strict";

/*
 * A presentation: { size: { w, h } (px at 96 per inch: 1280 × 720 is 16:9), slides: [slide] }
 * A slide: { id, bg: colour | null, notes: text, hidden, els: [el] } (els in drawing order, the last on top)
 * An element: { id, type: "text" | "shape" | "img", x, y, w, h, rot (degrees), fill, line: { color, w } | null,
 *   shape: "rect" | "roundRect" | "ellipse" | … (shapes), ph: "title" | "body" | "subtitle" (placeholders),
 *   anchor: "t" | "ctr" | "b" (where text sits), blocks: [paragraphs, as in documents] (text and shapes),
 *   src: data URL, alt (pictures) }
 *
 * Ops:
 *   { t: "slide", id, at, slide }      a new slide (whole)        { t: "slideDel", id }
 *   { t: "slideMove", id, at }         { t: "slideSet", id, set: { bg, notes, hidden } }
 *   { t: "el", slide, id, el, at }     an element added or put back whole (at: its place in the order), or removed (el null)
 *   { t: "elSet", slide, id, set }     its position, size, rotation, colours, shape, anchor (null removes)
 *   { t: "elZ", slide, id, at }        brought forward or sent back
 *   { t: "tx", slide, el, op }         its text: a document op (doc-model.js) on { blocks }
 *   { t: "size", w, h }
 */
const SET_KEYS = ["x", "y", "w", "h", "rot", "fill", "line", "shape", "anchor", "src", "alt", "flipH", "flipV"];
const SLIDE_KEYS = ["bg", "notes", "hidden"];
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const cloneEl = (e) => ({ ...e, line: e.line && { ...e.line }, blocks: e.blocks && e.blocks.map((b) => ({ ...b, runs: (b.runs || []).map((r) => ({ ...r })), list: b.list && { ...b.list } })) });
const clone = (p) => ({ ...p, size: { ...p.size }, slides: p.slides.map((s) => ({ ...s, els: s.els.map(cloneEl) })) });
const slideOf = (p, id) => p.slides.find((s) => s.id === id);
const elOf = (s, id) => s?.els.find((e) => e.id === id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function apply(p, op) {
  switch (op.t) {
    case "slide": {
      if (!op.slide || slideOf(p, op.id)) return null;
      p.slides.splice(clamp(op.at ?? p.slides.length, 0, p.slides.length), 0, { ...copy(op.slide), id: op.id, els: copy(op.slide.els || []) });
      return { slides: true };
    }
    case "slideDel": {
      const i = p.slides.findIndex((s) => s.id === op.id);
      if (i < 0 || p.slides.length < 2) return null;
      p.slides.splice(i, 1);
      return { slides: true };
    }
    case "slideMove": {
      const i = p.slides.findIndex((s) => s.id === op.id);
      if (i < 0) return null;
      const [s] = p.slides.splice(i, 1);
      p.slides.splice(clamp(op.at, 0, p.slides.length), 0, s);
      return { slides: true };
    }
    case "slideSet": {
      const i = p.slides.findIndex((s) => s.id === op.id);
      if (i < 0) return null;
      const s = { ...p.slides[i] };
      for (const k of SLIDE_KEYS) if (k in (op.set || {})) { const v = op.set[k]; if (v === null || v === undefined || v === false || v === "") delete s[k]; else s[k] = copy(v); }
      p.slides[i] = s;
      return { slide: s.id };
    }
    case "el": {
      const s = slideOf(p, op.slide);
      if (!s) return null;
      const i = s.els.findIndex((e) => e.id === op.id);
      if (!op.el) { if (i < 0) return null; s.els.splice(i, 1); return { slide: s.id }; }
      const el = { ...copy(op.el), id: op.id };
      if (i >= 0) s.els.splice(i, 1);
      s.els.splice(clamp(op.at ?? (i >= 0 ? i : s.els.length), 0, s.els.length), 0, el);
      return { slide: s.id };
    }
    case "elSet": {
      const s = slideOf(p, op.slide), i = s ? s.els.findIndex((e) => e.id === op.id) : -1;
      if (i < 0) return null;
      const e = { ...s.els[i] };
      for (const k of SET_KEYS) if (k in (op.set || {})) { const v = op.set[k]; if (v === null || v === undefined || v === false) delete e[k]; else e[k] = typeof v === "number" ? Math.round(v * 100) / 100 : copy(v); }
      // Lines can be flat (no height or no width); other things keep a little size.
      const min = e.shape === "line" ? 0 : 4;
      if (e.w !== undefined) e.w = Math.max(min, e.w);
      if (e.h !== undefined) e.h = Math.max(min, e.h);
      s.els[i] = e;
      return { slide: s.id, el: e.id };
    }
    case "elZ": {
      const s = slideOf(p, op.slide), i = s ? s.els.findIndex((e) => e.id === op.id) : -1;
      if (i < 0) return null;
      const [e] = s.els.splice(i, 1);
      s.els.splice(clamp(op.at, 0, s.els.length), 0, e);
      return { slide: s.id };
    }
    case "tx": {
      const s = slideOf(p, op.slide), i = s ? s.els.findIndex((e) => e.id === op.el) : -1;
      if (i < 0 || !op.op) return null;
      const mini = { blocks: s.els[i].blocks || [] };
      const r = D.apply(mini, op.op);
      if (r === null) return null;
      if (!mini.blocks.length) mini.blocks.push({ id: D.newId(), type: "p", runs: [] });
      s.els[i] = { ...s.els[i], blocks: mini.blocks };
      return { slide: s.id, el: op.el, text: r };
    }
    case "size": {
      if (!(op.w > 0 && op.h > 0)) return null;
      p.size = { w: Math.round(op.w), h: Math.round(op.h) };
      return { all: true };
    }
  }
  return null;
}

/** $op worked out again past $against (others' ops, applied first). Null when its slide or element is gone. */
function rebase(op, against) {
  let ops = [op];
  for (const a of against) ops = ops.flatMap((o) => { const r = past(o, a); return r == null ? [] : Array.isArray(r) ? r : [r]; });
  return ops.length === 0 ? null : ops.length === 1 ? ops[0] : ops;
}
function past(o, a) {
  const slideId = o.t.startsWith("slide") ? o.id : o.slide;
  if (a.t === "slideDel" && slideId === a.id && o.t !== "slide") return null;
  const elId = o.t === "tx" ? o.el : o.t === "el" || o.t === "elSet" || o.t === "elZ" ? o.id : null;
  if (elId && a.t === "el" && a.slide === o.slide && a.id === elId) {
    if (!a.el) return o.t === "el" ? o : null;          // the element was removed: changes to it go
    if (o.t === "tx") return null;                        // it was put back whole (undo): its text is that one
  }
  if (o.t === "tx" && a.t === "tx" && a.slide === o.slide && a.el === o.el) {
    const r = D.rebase(o.op, [a.op]);
    if (r == null) return null;
    return (Array.isArray(r) ? r : [r]).map((x) => ({ ...o, op: x }));
  }
  return o;
}

/** The op(s) that undo $op, from $p before it's applied. */
function inverse(p, op) {
  switch (op.t) {
    case "slide": return { t: "slideDel", id: op.id };
    case "slideDel": { const i = p.slides.findIndex((s) => s.id === op.id); return i < 0 ? null : { t: "slide", id: op.id, at: i, slide: copy(p.slides[i]) }; }
    case "slideMove": { const i = p.slides.findIndex((s) => s.id === op.id); return i < 0 ? null : { t: "slideMove", id: op.id, at: i }; }
    case "slideSet": { const s = slideOf(p, op.id); return s && { t: "slideSet", id: op.id, set: Object.fromEntries(Object.keys(op.set || {}).map((k) => [k, copy(s[k]) ?? null])) }; }
    case "el": {
      const s = slideOf(p, op.slide);
      if (!s) return null;
      const i = s.els.findIndex((e) => e.id === op.id);
      return i < 0 ? { t: "el", slide: op.slide, id: op.id, el: null } : { t: "el", slide: op.slide, id: op.id, el: copy(s.els[i]), at: i };
    }
    case "elSet": { const e = elOf(slideOf(p, op.slide), op.id); return e && { t: "elSet", slide: op.slide, id: op.id, set: Object.fromEntries(Object.keys(op.set || {}).map((k) => [k, copy(e[k]) ?? null])) }; }
    case "elZ": { const s = slideOf(p, op.slide); const i = s ? s.els.findIndex((e) => e.id === op.id) : -1; return i < 0 ? null : { t: "elZ", slide: op.slide, id: op.id, at: i }; }
    case "tx": {
      const e = elOf(slideOf(p, op.slide), op.el);
      if (!e) return null;
      const r = D.inverse({ blocks: e.blocks || [] }, op.op);
      if (!r) return null;
      return (Array.isArray(r) ? r : [r]).map((x) => ({ t: "tx", slide: op.slide, el: op.el, op: x }));
    }
    case "size": return { t: "size", w: p.size.w, h: p.size.h };
  }
  return null;
}

let seq = 0;
const newId = () => "e" + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
const para = (text, extra = {}) => ({ id: D.newId(), type: "p", runs: text ? (Array.isArray(text) ? text : [{ text }]) : [], ...extra });

/** Slide layouts for new slides: the boxes they start with, sized to the presentation. */
const LAYOUTS = [["title", "Title slide"], ["content", "Title and content"], ["section", "Section header"], ["two", "Two content"], ["titleOnly", "Title only"], ["blank", "Blank"]];
function layout(kind, size, theme = {}) {
  const { w, h } = size, m = Math.round(w * 0.065), font = theme.font;
  const ink = theme.ink || "#1f2937", accent = theme.accent || ink;
  const run = (pt, extra = {}) => ({ size: pt, ...(font ? { font } : {}), ...extra });
  const box = (ph, x, y, bw, bh, blocks, extra = {}) => ({ id: newId(), type: "text", ph, x: Math.round(x), y: Math.round(y), w: Math.round(bw), h: Math.round(bh), blocks, ...extra });
  const title = (y, bh, pt, align, text = "") => box("title", m, y, w - 2 * m, bh, [para(text ? [{ text, ...run(pt, { b: true, color: accent }) }] : [], { ...(align ? { align } : {}), def: run(pt, { b: true, color: accent }), ...(text ? {} : { hint: "Click to add a title" }) })], { anchor: "b" });
  const body = (x, y, bw, bh) => box("body", x, y, bw, bh, [para([], { list: { kind: "bullet", level: 0 }, def: run(22, { color: ink }), hint: "Click to add text" })]);
  switch (kind) {
    case "title": return [title(h * 0.26, h * 0.26, 48, "center"), box("subtitle", m * 2, h * 0.56, w - 4 * m, h * 0.16, [para([], { align: "center", def: run(24, { color: ink }), hint: "Click to add a subtitle" })])];
    case "content": return [title(h * 0.06, h * 0.16, 36), body(m, h * 0.26, w - 2 * m, h * 0.64)];
    case "section": return [title(h * 0.34, h * 0.2, 44), box("body", m, h * 0.56, w - 2 * m, h * 0.12, [para([], { def: run(22, { color: ink }), hint: "Click to add text" })])];
    case "two": return [title(h * 0.06, h * 0.16, 36), body(m, h * 0.26, (w - 3 * m) / 2, h * 0.64), body(w / 2 + m / 2, h * 0.26, (w - 3 * m) / 2, h * 0.64)];
    case "titleOnly": return [title(h * 0.06, h * 0.16, 36)];
    default: return [];
  }
}
const textOf = (el) => (el.blocks || []).map((b) => D.textOf(b)).join("\n");

return { apply, rebase, inverse, clone, newId, para, layout, LAYOUTS, SET_KEYS, textOf };
});
