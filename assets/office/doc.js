// The document editor (.docx): pages, headings, lists, fonts and colours, links, tables, pictures, page breaks,
// headers and footers, page size and margins, printing. The browser does the typing (so phone keyboards, dictation
// and spell check work as everywhere); after each change the page is read back and turned into ops (doc-model.js):
// typing, Enter (a paragraph split in two), Backspace at the start (two joined), formatting. Those are shared through
// the editor (editor.js), and other people's arrive the same way.
"use strict";

(() => {
const D = () => window.OfficeDocModel;
const UI = () => window.OfficeUI;
const W = () => window.Webmail;

const MM = 96 / 25.4;
const PAGES = { A4: [210, 297], Letter: [215.9, 279.4] };
const TAGS = { normal: "p", title: "h1", h1: "h1", h2: "h2", h3: "h3", h4: "h4", quote: "blockquote", code: "pre" };
const STYLES = [["normal", "Normal text"], ["title", "Title"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["quote", "Quote"], ["code", "Code"]];
const fromTag = { H1: "h1", H2: "h2", H3: "h3", H4: "h4", H5: "h4", H6: "h4", BLOCKQUOTE: "quote", PRE: "code" };
const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "LI", "UL", "OL", "TABLE", "FIGURE", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);
const hex = (c) => {
  if (!c) return null;
  if (c.startsWith("#")) return c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c.toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c);
  if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
  return "#" + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------------------------------------- drawing blocks

function renderRuns(el, runs) {
  for (const r of runs) {
    const parts = r.text.split("\n");
    const props = D().props(r); // links only to web, email and phone addresses (whatever a file or a collaborator sent)
    const plain = !Object.keys(props).length;
    parts.forEach((t, i) => {
      if (i > 0) el.append(document.createElement("br"));
      if (!t) return;
      if (plain) { el.append(t); return; }
      const s = document.createElement(props.href ? "a" : "span");
      if (props.href) { s.href = props.href; s.target = "_blank"; s.rel = "noopener noreferrer"; s.className = "ox-link"; }
      if (r.b) s.style.fontWeight = "700";
      if (r.i) s.style.fontStyle = "italic";
      if (r.u || r.s) s.style.textDecorationLine = [r.u && "underline", r.s && "line-through"].filter(Boolean).join(" ");
      if (r.color) s.style.color = r.color;
      if (r.bg) s.style.backgroundColor = r.bg;
      if (r.font) s.style.fontFamily = `"${r.font}"`;
      if (r.size) s.style.fontSize = `${r.size}pt`;
      if (r.sup) s.style.verticalAlign = "super";
      if (r.sub) s.style.verticalAlign = "sub";
      if (r.sup || r.sub) s.style.fontSize = r.size ? `${r.size * 0.7}pt` : "70%";
      s.textContent = t;
      el.append(s);
    });
  }
  // An empty paragraph (or one ending in a line break) needs a placeholder to have a line.
  const text = runs.map((r) => r.text).join("");
  if (!text || text.endsWith("\n")) el.append(document.createElement("br"));
}
function paraEl(b, tagOverride) {
  const el = document.createElement(tagOverride || TAGS[b.style || "normal"] || "p");
  el.dataset.id = b.id;
  el.dataset.type = "p";
  if (b.style && b.style !== "normal") el.dataset.style = b.style;
  if (b.align) el.style.textAlign = b.align;
  if (b.indent) el.dataset.indent = b.indent;
  if (b.list) { el.dataset.list = b.list.kind; el.dataset.level = b.list.level || 0; }
  renderRuns(el, b.runs || []);
  return el;
}
function blockEl(b, ctx) {
  if (b.type === "p") return paraEl(b);
  const wrap = document.createElement("div");
  wrap.dataset.id = b.id;
  wrap.dataset.type = b.type;
  wrap.contentEditable = "false";
  if (b.type === "pagebreak") { wrap.className = "ox-pb"; wrap.append(Object.assign(document.createElement("span"), { textContent: "Page break" })); }
  else if (b.type === "hr") { wrap.className = "ox-hrule"; wrap.append(document.createElement("hr")); }
  else if (b.type === "img") {
    wrap.className = `ox-fig${b.align ? " " + b.align : ""}`;
    const img = document.createElement("img");
    img.src = /^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(b.src || "") ? b.src : "";
    img.alt = b.alt || "";
    img.style.width = `${b.w || 300}px`;
    img.style.aspectRatio = `${b.w || 300} / ${b.h || 200}`;
    img.draggable = false;
    wrap.append(img);
    if (!ctx.readOnly) wrap.append(Object.assign(document.createElement("span"), { className: "ox-fig-handle", title: "Drag to resize" }));
  } else if (b.type === "table") {
    wrap.className = "ox-tbl";
    const t = document.createElement("table");
    const cols = Math.max(1, ...b.rows.map((r) => r.cells.reduce((n, c) => n + (c.span || 1), 0)));
    const total = (b.widths || []).reduce((s, w) => s + w, 0);
    if (b.widths?.length === cols && total) { const cg = document.createElement("colgroup"); b.widths.forEach((w) => { const col = document.createElement("col"); col.style.width = `${(100 * w / total).toFixed(2)}%`; cg.append(col); }); t.append(cg); }
    b.rows.forEach((row, r) => {
      const tr = t.insertRow();
      row.cells.forEach((cell, c) => {
        const td = tr.insertCell();
        if (cell.span > 1) td.colSpan = cell.span;
        if (cell.bg) td.style.backgroundColor = cell.bg;
        const body = document.createElement("div");
        body.className = "ox-cellbody";
        body.dataset.cell = `${r},${c}`;
        if (!ctx.readOnly) body.contentEditable = "true";
        for (const p of cell.blocks?.length ? cell.blocks : [{ id: D().newId(), type: "p", runs: [] }]) if (p.type === "p") body.append(paraEl(p));
        td.append(body);
      });
    });
    wrap.append(t);
  }
  return wrap;
}

// ---------------------------------------------------------------------------------------------- reading the page back

function fmtOf(el, base) {
  const f = { ...base };
  const t = el.tagName;
  if (t === "B" || t === "STRONG") f.b = true;
  if (t === "I" || t === "EM") f.i = true;
  if (t === "U" || t === "INS") f.u = true;
  if (t === "S" || t === "STRIKE" || t === "DEL") f.s = true;
  if (t === "SUP") f.sup = true;
  if (t === "SUB") f.sub = true;
  if (t === "A" && D().safeHref(el.getAttribute("href"))) f.href = D().safeHref(el.getAttribute("href"));
  if (t === "FONT") { if (el.getAttribute("color")) f.color = hex(el.getAttribute("color")); if (el.getAttribute("face")) f.font = el.getAttribute("face").split(",")[0].replace(/["']/g, "").trim(); }
  const st = el.style;
  if (st) {
    const fw = st.fontWeight;
    if (fw === "bold" || fw === "bolder" || +fw >= 600) f.b = true; else if (fw === "normal" || (fw && +fw < 600)) delete f.b;
    if (st.fontStyle === "italic") f.i = true; else if (st.fontStyle === "normal") delete f.i;
    const td = st.textDecorationLine || st.textDecoration || "";
    if (td.includes("underline")) f.u = true;
    if (td.includes("line-through")) f.s = true;
    if (td === "none") { delete f.u; delete f.s; }
    if (st.color) { const c = hex(st.color); if (c) f.color = c; }
    if (st.backgroundColor) { const c = hex(st.backgroundColor); if (c) f.bg = c; }
    if (st.fontFamily) f.font = st.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (st.fontSize) { const m = /^([\d.]+)(px|pt|em|%)?$/.exec(st.fontSize); if (m) { const v = +m[1]; const pt = m[2] === "px" ? v * 0.75 : m[2] === "pt" || !m[2] ? v : null; if (pt && !(f.sup || f.sub)) f.size = Math.round(pt * 2) / 2; } }
    if (st.verticalAlign === "super") f.sup = true;
    if (st.verticalAlign === "sub") f.sub = true;
  }
  if (f.href) delete f.color;
  return f;
}
function lastLeaf(el) { let n = el.lastChild; while (n && n.nodeType === 1 && n.lastChild && n.tagName !== "BR") n = n.lastChild; return n; }
function readRuns(el) {
  const runs = [];
  const last = lastLeaf(el);
  const walk = (node, fmt) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { const t = ch.data.replace(/ /g, " ").replace(/[​﻿]/g, ""); if (t) runs.push({ text: t, ...fmt }); }
      else if (ch.nodeType === 1) {
        if (ch.tagName === "BR") { if (ch !== last) runs.push({ text: "\n", ...fmt }); continue; }
        if (ch.classList?.contains("ox-ui")) continue;
        walk(ch, fmtOf(ch, fmt));
        if (BLOCK_TAGS.has(ch.tagName) && ch.nextSibling) runs.push({ text: "\n", ...fmt });
      }
    }
  };
  walk(el, {});
  return D().tidy(runs.map((r) => { const x = { ...r }; if (x.size === 11) delete x.size; return x; }));
}
function readPara(el) {
  const b = { id: el.dataset.id, type: "p", runs: readRuns(el) };
  const style = el.dataset.style || fromTag[el.tagName];
  if (style && style !== "normal") b.style = style;
  const align = el.style.textAlign;
  if (["center", "right", "justify"].includes(align)) b.align = align;
  if (+el.dataset.indent) b.indent = +el.dataset.indent;
  if (el.dataset.list) b.list = { kind: el.dataset.list, level: +el.dataset.level || 0 };
  return b;
}
function readCell(body) {
  const out = [];
  const seen = new Set();
  for (const el of body.children) {
    if (!el.dataset.id || seen.has(el.dataset.id)) el.dataset.id = D().newId();
    seen.add(el.dataset.id);
    out.push(readPara(el));
  }
  if (!out.length) out.push({ id: D().newId(), type: "p", runs: readRuns(body) });
  return out;
}
const sig = (b) => JSON.stringify(b);
const cellSig = (blocks) => JSON.stringify((blocks || []).map((b) => [D().textOf(b), b.runs, b.style || "", b.align || "", b.list || null, b.indent || 0]));

// ---------------------------------------------------------------------------------------------- positions (character offsets ↔ the page)

function leaves(el) { const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 3 || n.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) }); for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; }
function offsetIn(blockEl, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(blockEl);
  try { r.setEnd(node, offset); } catch { return 0; }
  const last = lastLeaf(blockEl);
  let n = 0;
  for (const leaf of leaves(blockEl)) {
    if (leaf === node && leaf.nodeType === 3) return n + offset;
    if (r.comparePoint(leaf, 0) === 1) return n;
    n += leaf.nodeType === 3 ? leaf.data.length : leaf === last ? 0 : 1;
  }
  return n;
}
function domAt(blockEl, off) {
  const last = lastLeaf(blockEl);
  for (const leaf of leaves(blockEl)) {
    if (leaf.nodeType === 3) { if (off <= leaf.data.length) return [leaf, off]; off -= leaf.data.length; }
    else if (leaf !== last) { if (off === 0) return [leaf.parentNode, [...leaf.parentNode.childNodes].indexOf(leaf)]; off -= 1; }
    else return [leaf.parentNode, [...leaf.parentNode.childNodes].indexOf(leaf)];
  }
  return [blockEl, blockEl.childNodes.length];
}
function mapPos(p, a, end = false) {
  const L = a.ins, d = a.del;
  if (p < a.at || (end && p === a.at && d === 0)) return p;
  if (p > a.at + d || (p === a.at + d && !end)) return p - d + L;
  return end ? a.at : a.at + L;
}

// ---------------------------------------------------------------------------------------------- pictures

/** A picture file, made a sensible size for a document (at most 1600 pixels across) as a data URL. */
async function imageData(file) {
  if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) throw new Error("Pictures can be PNG, JPEG, GIF, WebP or BMP.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That picture couldn't be read.")); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    if (scale === 1 && file.size < 1.5e6 && file.type !== "image/bmp" && file.type !== "image/webp") return { src: await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); }), w, h };
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return { src: c.toDataURL(file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg", 0.85), w, h };
  } finally { URL.revokeObjectURL(url); }
}

// ---------------------------------------------------------------------------------------------- the view

function mount(host, ctx) {
  const { h, icon, tool } = ctx;
  const doc = () => ctx.state;
  const $root = h("div", { class: "ox-doc", spellcheck: true, role: "textbox", "aria-multiline": "true", "aria-label": ctx.file.name });
  const $header = h("div", { class: "ox-hf ox-header", "data-placeholder": "Header" });
  const $footer = h("div", { class: "ox-hf ox-footer", "data-placeholder": "Footer" });
  const $marks = h("div", { class: "ox-pagemarks ox-ui", "aria-hidden": "true" });
  const $cursors = h("div", { class: "ox-cursors ox-ui", "aria-hidden": "true" });
  const $page = h("div", { class: "ox-page" }, $header, $root, $footer, $marks, $cursors);
  const $words = h("span", { class: "ox-words" });
  const $scroller = h("div", { class: "ox-paper" }, $page);
  host.append(h("div", { class: "ox-docwrap" }, $scroller, h("div", { class: "ox-foot doc" }, $words)));
  if (!ctx.readOnly) { $root.contentEditable = "true"; $header.contentEditable = "true"; $footer.contentEditable = "true"; }
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* old browsers */ }

  const rendered = new Map(); // id → signature drawn
  let pendingFmt = null;      // formatting for what's typed next (bold pressed with nothing selected)
  let composing = false;
  let othersNow = ctx.others || [];

  // ---- drawing
  function drawPage() {
    const p = doc().page || {};
    let [w, ht] = PAGES[p.size] || PAGES.A4;
    if (p.landscape) [w, ht] = [ht, w];
    const m = p.margins || { t: 25, r: 25, b: 25, l: 25 };
    $page.style.setProperty("--page-w", `${Math.round(w * MM)}px`);
    $page.style.setProperty("--page-h", `${Math.round(ht * MM)}px`);
    $page.style.setProperty("--m-t", `${Math.round(m.t * MM)}px`);
    $page.style.setProperty("--m-r", `${Math.round(m.r * MM)}px`);
    $page.style.setProperty("--m-b", `${Math.round(m.b * MM)}px`);
    $page.style.setProperty("--m-l", `${Math.round(m.l * MM)}px`);
    for (const [el, blocks] of [[$header, doc().header], [$footer, doc().footer]]) {
      if (document.activeElement === el) continue;
      el.replaceChildren(...(blocks || []).filter((b) => b.type === "p").map((b) => paraEl(b)));
    }
  }
  /** Brings the page in line with the model: only blocks that changed are drawn again; the cursor stays put. */
  function sync(caretHint = null) {
    const saved = caretHint || saveSel();
    const hadFocus = $root.contains(document.activeElement);
    const blocks = doc().blocks;
    const want = new Set(blocks.map((b) => b.id));
    const kept = new Set();
    for (const el of [...$root.childNodes]) {
      const id = el.nodeType === 1 ? el.dataset.id : null;
      if (!id || !want.has(id) || kept.has(id)) { el.remove(); if (id && !kept.has(id)) rendered.delete(id); continue; }
      kept.add(id);
    }
    let prev = null;
    const changedText = new Map();
    for (const b of blocks) {
      let el = $root.querySelector(`:scope > [data-id="${CSS.escape(b.id)}"]`);
      const s = sig(b);
      if (!el || rendered.get(b.id) !== s) {
        const old = el && el.dataset.type === "p" && b.type === "p" ? readRuns(el).map((r) => r.text).join("") : null;
        const fresh = blockEl(b, ctx);
        if (el) el.replaceWith(fresh); else if (prev) prev.after(fresh); else $root.prepend(fresh);
        el = fresh;
        rendered.set(b.id, s);
        if (old !== null) changedText.set(b.id, old);
      }
      if (prev ? prev.nextElementSibling !== el : $root.firstElementChild !== el) { if (prev) prev.after(el); else $root.prepend(el); }
      prev = el;
    }
    if (saved) {
      // The cursor moves along with other people's typing before it in the same paragraph.
      for (const k of ["a", "f"]) {
        const pnt = saved[k];
        if (!pnt || !changedText.has(pnt.id)) continue;
        const oldT = changedText.get(pnt.id), newT = D().textOf(doc().blocks.find((b) => b.id === pnt.id) || { runs: [] });
        let a = 0; while (a < oldT.length && a < newT.length && oldT[a] === newT[a]) a++;
        let z = 0; while (z < oldT.length - a && z < newT.length - a && oldT[oldT.length - 1 - z] === newT[newT.length - 1 - z]) z++;
        pnt.off = mapPos(pnt.off, { at: a, del: oldT.length - a - z, ins: newT.length - a - z }, k === "f" && saved.a?.off !== saved.f?.off);
      }
      restoreSel(saved, hadFocus);
    }
    observer.takeRecords();
    dirty.clear();
    drawPage();
    words();
    requestAnimationFrame(() => { pageMarks(); drawCursors(); commentMarks(); });
  }
  function words() {
    const text = doc().blocks.map((b) => (b.type === "p" ? D().textOf(b) : b.type === "table" ? b.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.map(D().textOf))).join(" ") : "")).join(" ");
    const n = (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
    $words.textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
  }
  /** Where pages end, roughly (the printout decides exactly): a dashed line every page's height of text. */
  function pageMarks() {
    const p = doc().page || {};
    let [, ht] = PAGES[p.size] || PAGES.A4;
    if (p.landscape) ht = (PAGES[p.size] || PAGES.A4)[0];
    const m = p.margins || { t: 25, b: 25 };
    const per = (ht - m.t - m.b) * MM;
    const marks = [];
    const total = $root.scrollHeight;
    let y = 0, page = 1;
    // Page breaks start a new page.
    const breaks = [...$root.querySelectorAll(":scope > .ox-pb")].map((el) => el.offsetTop + el.offsetHeight);
    let next = per;
    while (next < total && page < 500) {
      const brk = breaks.find((b) => b > y && b < next);
      if (brk) { y = brk; next = brk + per; page++; continue; }
      const el = h("div", { class: "ox-pagemark" }, h("span", {}, `Page ${page + 1}`));
      el.style.top = `${$root.offsetTop + next}px`;
      marks.push(el);
      y = next; next += per; page++;
    }
    $marks.replaceChildren(...marks);
  }

  // ---- selection
  const topOf = (node) => { let n = node?.nodeType === 3 ? node.parentNode : node; while (n && n.parentNode !== $root) { if (n === $root || !n.parentNode) return null; n = n.parentNode; } return n; };
  function pointOf(node, off) {
    const top = topOf(node);
    if (!top || top.dataset.type !== "p") return top ? { id: top.dataset.id, off: 0, object: true } : null;
    return { id: top.dataset.id, off: offsetIn(top, node, off) };
  }
  function saveSel() {
    const s = getSelection();
    if (!s.rangeCount || !$root.contains(s.anchorNode)) return null;
    // Inside a table cell: remembered by cell and paragraph.
    const cellOf = (n) => (n?.nodeType === 3 ? n.parentNode : n)?.closest?.(".ox-cellbody");
    const cb = cellOf(s.anchorNode);
    if (cb) { const p = (s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode).closest("[data-id]"); const tbl = cb.closest(".ox-tbl"); return { cell: { table: tbl.dataset.id, cell: cb.dataset.cell, pid: p?.dataset.id, off: p && p !== cb ? offsetIn(p, s.anchorNode, s.anchorOffset) : 0 } }; }
    const a = pointOf(s.anchorNode, s.anchorOffset), f = pointOf(s.focusNode, s.focusOffset);
    return a && f ? { a, f } : null;
  }
  function restoreSel(saved, hadFocus = false) {
    if (!saved || (!hadFocus && document.activeElement !== $root && !$root.contains(document.activeElement))) return;
    const s = getSelection();
    if (saved.cell) {
      const tbl = $root.querySelector(`:scope > [data-id="${CSS.escape(saved.cell.table)}"]`);
      const cb = tbl?.querySelector(`.ox-cellbody[data-cell="${saved.cell.cell}"]`);
      const p = cb?.querySelector(`[data-id="${CSS.escape(saved.cell.pid || "")}"]`) || cb?.firstElementChild;
      // The cell was drawn again: the cursor goes back into the new one.
      if (p) { if (document.activeElement !== cb) cb.focus({ preventScroll: true }); const [n, o] = domAt(p, saved.cell.off); s.setBaseAndExtent(n, o, n, o); }
      return;
    }
    if (hadFocus && document.activeElement !== $root) $root.focus({ preventScroll: true });
    const el = (p) => $root.querySelector(`:scope > [data-id="${CSS.escape(p.id)}"]`);
    const ae = el(saved.a), fe = el(saved.f);
    if (!ae || !fe || ae.dataset.type !== "p" || fe.dataset.type !== "p") return;
    const [an, ao] = domAt(ae, saved.a.off), [fn, fo] = domAt(fe, saved.f.off);
    try { s.setBaseAndExtent(an, ao, fn, fo); } catch { /* gone */ }
  }
  /** The selection in model terms: blocks in order with the range covered in each. */
  function selBlocks() {
    const saved = saveSel();
    if (!saved || saved.cell) return [];
    const ids = doc().blocks.map((b) => b.id);
    let { a, f } = saved;
    if (ids.indexOf(a.id) > ids.indexOf(f.id) || (a.id === f.id && a.off > f.off)) [a, f] = [f, a];
    const out = [];
    for (let i = ids.indexOf(a.id); i <= ids.indexOf(f.id) && i >= 0; i++) {
      const b = doc().blocks[i];
      if (b.type !== "p") continue;
      const n = D().len(b.runs);
      out.push({ b, from: b.id === a.id ? a.off : 0, to: b.id === f.id ? f.off : n });
    }
    return out;
  }
  const caretBlock = () => { const s = saveSel(); return s && !s.cell ? doc().blocks.find((b) => b.id === s.f.id) : null; };

  // ---- typing → ops
  const dirty = new Set();
  const observer = new MutationObserver((records) => { for (const r of records) note(r); });
  function note(r) {
    if (r.target === $root) { dirty.add("*"); return; }
    const top = topOf(r.target);
    if (top) dirty.add(top);
    else dirty.add("*");
  }
  observer.observe($root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "data-style", "data-list", "data-level", "data-indent"] });

  function textOps(id, oldRuns, newRuns) {
    const flat = (runs) => { const out = []; for (const r of runs) { const k = JSON.stringify(D().props(r)); for (let i = 0; i < r.text.length; i++) out.push(r.text[i] + "\u0000" + k); } return out; };
    const a = flat(oldRuns), b = flat(newRuns);
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    if (p === a.length && p === b.length) return [];
    return [{ t: "text", id, at: p, del: a.length - p - s, ins: D().slice(newRuns, p, b.length - s) }];
  }
  function paraOps(id, oldB, newB) {
    const set = {};
    for (const k of D().P_KEYS) if (JSON.stringify(oldB[k] ?? null) !== JSON.stringify(newB[k] ?? null)) set[k] = newB[k] ?? null;
    return Object.keys(set).length ? [{ t: "para", id, set }] : [];
  }
  /** Reads what the browser changed and turns it into ops. */
  function flush() {
    if (composing || ctx.readOnly) return;
    for (const r of observer.takeRecords()) note(r);
    if (!dirty.size) return;
    const model = doc();
    // Top-level text the browser left loose goes into a paragraph.
    for (const n of [...$root.childNodes]) if (n.nodeType === 3 && n.data.trim() || (n.nodeType === 1 && !n.dataset.type && !BLOCK_TAGS.has(n.tagName))) { const p = document.createElement("p"); n.replaceWith(p); p.append(n); dirty.add("*"); }
    const els = [...$root.children];
    const seen = new Set();
    for (const el of els) {
      // New paragraphs the browser made (Enter copies the paragraph it split, id and all) get ids of their own.
      if (!el.dataset.id || seen.has(el.dataset.id)) { el.dataset.id = D().newId(); el.dataset.type = BLOCK_TAGS.has(el.tagName) && el.tagName !== "TABLE" ? "p" : el.dataset.type || "p"; dirty.add(el); }
      if (!el.dataset.type) el.dataset.type = "p";
      seen.add(el.dataset.id);
    }
    const dIds = els.map((e) => e.dataset.id), dSet = new Set(dIds);
    const oSet = new Set(model.blocks.map((b) => b.id));
    const work = D().clone(model);
    const ops = [];
    const push = (op) => { const r = D().apply(work, op); if (r !== null) ops.push(op); };
    const elOf = (id) => els.find((e) => e.dataset.id === id);
    const domText = (el) => readRuns(el).map((r) => r.text).join("");
    // Blocks gone from the page: joined into the paragraph before (Backspace at a start), or deleted.
    for (const b of model.blocks) {
      if (dSet.has(b.id)) continue;
      const i = work.blocks.findIndex((x) => x.id === b.id);
      const prev = work.blocks[i - 1];
      if (prev && prev.type === "p" && b.type === "p" && dSet.has(prev.id)) push({ t: "join", id: prev.id, next: b.id, at: D().len(prev.runs) });
      else push({ t: "delete", id: b.id, prev: prev?.id ?? null });
    }
    // New ones: a paragraph split in two (Enter), or something inserted.
    dIds.forEach((id, k) => {
      if (oSet.has(id)) return;
      const el = els[k], predId = k > 0 ? dIds[k - 1] : null;
      const pred = predId && work.blocks.find((x) => x.id === predId);
      if (pred && pred.type === "p" && el.dataset.type === "p") {
        const before = D().textOf(pred), now = domText(elOf(predId));
        let at = 0; while (at < before.length && at < now.length && before[at] === now[at]) at++;
        push({ t: "split", id: predId, at, newId: id });
      } else if (el.dataset.type === "p") push({ t: "insert", after: predId, block: { ...readPara(el), id } });
    });
    // Anything that ended up out of order (dragged): moved.
    for (let k = 0; k < dIds.length; k++) {
      if (work.blocks[k]?.id === dIds[k]) continue;
      const b = work.blocks.find((x) => x.id === dIds[k]);
      if (!b) continue;
      const prevIdx = work.blocks.findIndex((x) => x.id === b.id) - 1;
      push({ t: "delete", id: b.id, prev: work.blocks[prevIdx]?.id ?? null });
      push({ t: "insert", after: k > 0 ? dIds[k - 1] : null, block: b.type === "p" ? { ...readPara(els[k]), id: b.id } : b });
    }
    // What's in each changed paragraph or table now.
    const check = dirty.has("*") ? els : els.filter((e) => dirty.has(e) || !oSet.has(e.dataset.id) || ops.some((o) => o.id === e.dataset.id || o.newId === e.dataset.id));
    for (const el of check) {
      const id = el.dataset.id;
      const b = work.blocks.find((x) => x.id === id);
      if (!b) continue;
      if (b.type === "p" && el.dataset.type === "p") {
        const nb = readPara(el);
        for (const op of textOps(id, b.runs, nb.runs)) push(op);
        for (const op of paraOps(id, b, nb)) push(op);
      } else if (b.type === "table") {
        el.querySelectorAll(".ox-cellbody").forEach((body) => {
          const [r, c] = body.dataset.cell.split(",").map(Number);
          const cell = b.rows[r]?.cells[c];
          if (!cell) return;
          const blocks = readCell(body);
          if (cellSig(blocks) !== cellSig(cell.blocks)) push({ t: "cell", id, r, c, blocks });
        });
      }
    }
    // Formatting chosen before typing (bold with nothing selected) goes on what was just typed.
    if (pendingFmt) {
      const last = ops[ops.length - 1];
      if (last?.t === "text" && last.ins?.length && !last.del) { push({ t: "fmt", id: last.id, from: last.at, to: last.at + D().len(last.ins), set: pendingFmt }); }
    }
    dirty.clear();
    if (!ops.length) return;
    const caret = saveSel();
    // Typing in one paragraph is one step to undo; moving elsewhere starts another.
    const blocksTouched = new Set(ops.map((o) => o.id));
    ctx.commit(ops, { group: ops.every((o) => o.t === "text") && blocksTouched.size === 1 ? `type:${ops[0].id}` : null });
    // Blocks the browser drew its own way (splits, joins, pasted styles) are drawn again cleanly.
    const redraw = ops.some((o) => o.t !== "text" && o.t !== "cell") || pendingFmt;
    if (redraw) sync(caret);
    else { for (const op of ops) { const b = doc().blocks.find((x) => x.id === op.id); if (b) rendered.set(b.id, sig(b)); } words(); requestAnimationFrame(() => { pageMarks(); drawCursors(); }); }
    presence();
  }
  $root.addEventListener("input", () => flush());
  $root.addEventListener("compositionstart", () => { composing = true; });
  $root.addEventListener("compositionend", () => { composing = false; setTimeout(flush); });

  // ---- keys
  $root.addEventListener("beforeinput", (e) => {
    if (ctx.readOnly) { e.preventDefault(); return; }
    const t = e.inputType;
    if (t === "historyUndo") { e.preventDefault(); ctx.undo(); return; }
    if (t === "historyRedo") { e.preventDefault(); ctx.redo(); return; }
    if (t === "formatBold") { e.preventDefault(); toggle("b"); return; }
    if (t === "formatItalic") { e.preventDefault(); toggle("i"); return; }
    if (t === "formatUnderline") { e.preventDefault(); toggle("u"); return; }
    if (t === "insertFromDrop") { e.preventDefault(); return; }
    if (t === "insertParagraph" && !inCell()) {
      const b = caretBlock();
      // Enter on an empty list item ends the list.
      if (b?.list && !D().len(b.runs)) { e.preventDefault(); commitSync({ t: "para", id: b.id, set: { list: null } }); return; }
    }
  });
  const inCell = () => { const s = getSelection(); return !!(s.anchorNode && (s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode).closest?.(".ox-cellbody")); };
  $root.addEventListener("keydown", (e) => {
    if (ctx.readOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && ["b", "i", "u"].includes(k)) { e.preventDefault(); toggle(k); return; }
    if (mod && k === "k") { e.preventDefault(); link(); return; }
    if (mod && e.shiftKey && (k === "x" || k === "5")) { e.preventDefault(); toggle("s"); return; }
    if (mod && e.altKey && /^[0-4]$/.test(e.key)) { e.preventDefault(); setStyle(e.key === "0" ? "normal" : `h${e.key}`); return; }
    if (mod && !e.altKey && ["l", "e", "r", "j"].includes(k) && !e.shiftKey) { e.preventDefault(); align({ l: null, e: "center", r: "right", j: "justify" }[k]); return; }
    if (mod && e.shiftKey && (k === "7" || k === "8")) { e.preventDefault(); list(k === "7" ? "number" : "bullet"); return; }
    if (mod && k === "f") { e.preventDefault(); e.stopPropagation(); findBar(); return; }
    if (mod && k === "enter") { e.preventDefault(); insertBlock({ type: "pagebreak" }); return; }
    if (mod && k === "\\") { e.preventDefault(); clearFormat(); return; }
    if (e.key === "Tab" && !mod) {
      if (inCell()) { e.preventDefault(); nextCell(e.shiftKey ? -1 : 1); return; }
      const b = caretBlock();
      e.preventDefault();
      if (b?.list) { indent(e.shiftKey ? -1 : 1); return; }
      if (e.shiftKey) { indent(-1); return; }
      document.execCommand("insertText", false, "\t");
      return;
    }
    if (e.key === "Backspace" && !mod) {
      const s = saveSel();
      if (s && !s.cell && s.a.id === s.f.id && s.a.off === 0 && s.f.off === 0) {
        const b = doc().blocks.find((x) => x.id === s.a.id);
        // Backspace at the start of a list item or an indented paragraph takes that away first.
        if (b?.list) { e.preventDefault(); commitSync(b.list.level > 0 ? { t: "para", id: b.id, set: { list: { ...b.list, level: b.list.level - 1 } } } : { t: "para", id: b.id, set: { list: null } }); return; }
        if (b?.indent) { e.preventDefault(); commitSync({ t: "para", id: b.id, set: { indent: b.indent - 1 || null } }); return; }
        const i = doc().blocks.indexOf(b);
        const prev = doc().blocks[i - 1];
        if (prev && prev.type !== "p") { e.preventDefault(); commitSync({ t: "delete", id: prev.id, prev: doc().blocks[i - 2]?.id ?? null }); return; }
      }
    }
  });
  function nextCell(d) {
    const s = getSelection();
    const body = (s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode).closest(".ox-cellbody");
    const all = [...body.closest("table").querySelectorAll(".ox-cellbody")];
    const next = all[all.indexOf(body) + d];
    if (next) { const p = next.lastElementChild || next; const [n, o] = domAt(p, D().len(readRuns(p))); s.setBaseAndExtent(n, 0, n, o); }
    else if (d > 0) tableEdit("rowBelow");
  }
  function commitSync(ops) { flush(); const caret = saveSel(); ctx.commit(ops); sync(caret); presence(); }

  // ---- formatting
  /** Formatting over the selection; with nothing selected, it's for what's typed next. */
  function format(set) {
    flush();
    const parts = selBlocks().filter((p) => p.to > p.from);
    if (!parts.length) {
      pendingFmt = { ...(pendingFmt || {}), ...set };
      syncToolbar();
      return;
    }
    commitSync(parts.map((p) => ({ t: "fmt", id: p.b.id, from: p.from, to: p.to, set })));
  }
  function runAtCaret() {
    const s = saveSel();
    if (!s || s.cell) return {};
    const b = doc().blocks.find((x) => x.id === s.f.id);
    if (!b || b.type !== "p") return {};
    const at = Math.max(0, Math.min(s.f.off, D().len(b.runs)));
    const r = D().slice(b.runs, Math.max(0, at - 1), Math.max(1, at))[0] || {};
    return { ...D().props(r), ...(pendingFmt || {}) };
  }
  function toggle(k) { const cur = runAtCaret(); format({ [k]: cur[k] ? null : true }); }
  function paraEach(fn) {
    flush();
    const s = saveSel();
    if (!s || s.cell) return;
    const parts = selBlocks();
    const ops = parts.map((p) => fn(p.b)).filter(Boolean);
    if (ops.length) commitSync(ops);
  }
  const setStyle = (style) => paraEach((b) => ({ t: "para", id: b.id, set: { style: style === "normal" ? null : style, list: style !== "normal" ? null : b.list ?? null } }));
  const align = (a) => paraEach((b) => ({ t: "para", id: b.id, set: { align: a } }));
  function list(kind) {
    const parts = selBlocks();
    const all = parts.length && parts.every((p) => p.b.list?.kind === kind);
    paraEach((b) => ({ t: "para", id: b.id, set: { list: all ? null : { kind, level: b.list?.level || 0 }, style: null } }));
  }
  const indent = (d) => paraEach((b) => (b.list ? { t: "para", id: b.id, set: { list: { ...b.list, level: Math.max(0, Math.min(8, (b.list.level || 0) + d)) } } } : { t: "para", id: b.id, set: { indent: Math.max(0, Math.min(8, (b.indent || 0) + d)) || null } }));
  function clearFormat() {
    flush();
    const parts = selBlocks().filter((p) => p.to > p.from);
    pendingFmt = null;
    if (parts.length) commitSync(parts.map((p) => ({ t: "fmt", id: p.b.id, from: p.from, to: p.to, set: Object.fromEntries(D().RUN_KEYS.map((k) => [k, null])) })));
  }
  function link() {
    const cur = runAtCaret();
    const url = prompt("Link to (a web address or email address)", cur.href || "https://");
    if (url === null) return;
    const u = url.trim();
    if (u && !/^(https?:\/\/|mailto:)/i.test(u)) { if (/^[^\s@]+@[^\s@]+$/.test(u)) return format({ href: "mailto:" + u }); return format({ href: "https://" + u }); }
    format({ href: u || null });
  }
  function insertBlock(block, after = null) {
    flush();
    const b = caretBlock();
    const at = after ?? b?.id ?? doc().blocks[doc().blocks.length - 1]?.id ?? null;
    const nb = { ...block, id: D().newId() };
    const ops = [{ t: "insert", after: at, block: nb }];
    // Something to type in after it, if it's last.
    const idx = doc().blocks.findIndex((x) => x.id === at);
    if (idx === doc().blocks.length - 1 || block.type === "table") ops.push({ t: "insert", after: nb.id, block: { id: D().newId(), type: "p", runs: [] } });
    commitSync(ops);
    // Into the table's first cell, or the line after what was inserted.
    const cellP = block.type === "table" && $root.querySelector(`:scope > [data-id="${CSS.escape(nb.id)}"] .ox-cellbody > *`);
    const next = cellP || $root.querySelector(`:scope > [data-id="${CSS.escape(ops[ops.length - 1].block.id)}"]`);
    if (next && (cellP || next.dataset.type === "p")) { (cellP ? cellP.closest(".ox-cellbody") : $root).focus(); getSelection().setBaseAndExtent(next, 0, next, 0); }
  }

  // ---- toolbar
  const tb = ctx.toolbar;
  const styleSel = UI().select("Paragraph style", STYLES, (v) => { setStyle(v); $root.focus(); }, "ox-style");
  const fontSel = UI().select("Font", UI().FONTS.map((f) => [f, f]), (v) => { format({ font: v === "Calibri" ? null : v }); $root.focus(); });
  const sizeSel = UI().select("Size", UI().SIZES.map((s) => [s, s]), (v) => { format({ size: +v === 11 ? null : +v }); $root.focus(); }, "ox-size");
  const btn = {};
  if (!ctx.readOnly) {
    tb.append(styleSel, fontSel, sizeSel, h("span", { class: "ox-sep" }),
      btn.b = tool("bold", "Bold (Ctrl+B)", () => toggle("b")), btn.i = tool("italic", "Italic (Ctrl+I)", () => toggle("i")),
      btn.u = tool("underline", "Underline (Ctrl+U)", () => toggle("u")), btn.s = tool("strike", "Strikethrough", () => toggle("s")),
      btn.sup = tool("superscript", "Superscript", () => toggle("sup")), btn.sub = tool("subscript", "Subscript", () => toggle("sub")),
      tool("textColor", "Text colour", (e) => UI().colorPicker(e.currentTarget, { pick: (c) => format({ color: c }) })),
      tool("fill", "Highlight", (e) => UI().colorPicker(e.currentTarget, { none: "No highlight", pick: (c) => format({ bg: c }) })),
      tool("link", "Link (Ctrl+K)", link), tool("clear", "Clear formatting", clearFormat), h("span", { class: "ox-sep" }),
      btn.left = tool("alignLeft", "Align left", () => align(null)), btn.center = tool("alignCenter", "Centre", () => align("center")),
      btn.right = tool("alignRight", "Align right", () => align("right")), btn.justify = tool("justify", "Justify", () => align("justify")),
      btn.bullet = tool("bullets", "Bulleted list", () => list("bullet")), btn.number = tool("numbers", "Numbered list", () => list("number")),
      tool("outdent", "Decrease indent", () => indent(-1)), tool("indent", "Increase indent", () => indent(1)), h("span", { class: "ox-sep" }),
      tool("table", "Table", (e) => tablePicker(e.currentTarget)), tool("image", "Picture", pickImage),
      tool("pagebreak", "Page break (Ctrl+Enter)", () => insertBlock({ type: "pagebreak" })), tool("hr", "Horizontal line", () => insertBlock({ type: "hr" })),
      tool("page", "Page setup", pageSetup), tool("comment", "Comment", () => { const b = caretBlock(); ctx.comment(b ? `block:${b.id}` : null); }), tool("search", "Find and replace (Ctrl+F)", findBar));
  } else tb.append(tool("search", "Find (Ctrl+F)", findBar), tool("comment", "Comment", () => { const b = caretBlock(); ctx.comment(b ? `block:${b.id}` : null); }));
  function syncToolbar() {
    if (ctx.readOnly) return;
    const r = runAtCaret();
    for (const k of ["b", "i", "u", "s", "sup", "sub"]) btn[k].classList.toggle("on", !!r[k]);
    fontSel.value = r.font || "Calibri";
    sizeSel.value = String(r.size || 11);
    const b = caretBlock();
    styleSel.value = b?.style || "normal";
    btn.left.classList.toggle("on", !!b && !b.align); btn.center.classList.toggle("on", b?.align === "center"); btn.right.classList.toggle("on", b?.align === "right"); btn.justify.classList.toggle("on", b?.align === "justify");
    btn.bullet.classList.toggle("on", b?.list?.kind === "bullet"); btn.number.classList.toggle("on", b?.list?.kind === "number");
  }
  let lastCaret = null;
  const onSel = () => {
    if (!$root.contains(getSelection().anchorNode)) return;
    const s = JSON.stringify(saveSel());
    if (s !== lastCaret) { if (lastCaret !== null) pendingFmt = null; lastCaret = s; }
    syncToolbar();
    presence();
    selectFigure(null);
  };
  document.addEventListener("selectionchange", onSel);
  let presTimer = null;
  function presence() { clearTimeout(presTimer); presTimer = setTimeout(() => { const s = saveSel(); ctx.presence(s && !s.cell ? { a: s.a, f: s.f } : s?.cell ? { cell: s.cell } : null); }, 150); }

  // ---- tables
  function tablePicker(anchor) {
    UI().popover(anchor, (pop, close) => {
      const label = h("div", { class: "muted small" }, "Insert a table");
      const grid = h("div", { class: "ox-tgrid" });
      for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) grid.append(h("button", { type: "button", class: "ox-tcell", dataset: { r, c }, "aria-label": `${r} by ${c}`,
        onmouseenter: () => { label.textContent = `${c} × ${r}`; grid.querySelectorAll(".ox-tcell").forEach((x) => x.classList.toggle("on", +x.dataset.r <= r && +x.dataset.c <= c)); },
        onclick: () => { close(); insertTable(r, c); } }));
      pop.append(label, grid);
    });
  }
  const emptyCell = () => ({ blocks: [{ id: D().newId(), type: "p", runs: [] }] });
  function insertTable(rows, cols) { insertBlock({ type: "table", rows: Array.from({ length: rows }, () => ({ cells: Array.from({ length: cols }, emptyCell) })) }); }
  function tableEdit(what) {
    flush();
    const s = saveSel();
    if (!s?.cell) return;
    const t = doc().blocks.find((b) => b.id === s.cell.table);
    if (!t) return;
    const [r, c] = s.cell.cell.split(",").map(Number);
    const rows = JSON.parse(JSON.stringify(t.rows));
    const cols = Math.max(...rows.map((x) => x.cells.length));
    const nt = { ...t, rows };
    delete nt.widths;
    if (what === "rowAbove" || what === "rowBelow") rows.splice(r + (what === "rowBelow" ? 1 : 0), 0, { cells: Array.from({ length: cols }, emptyCell) });
    else if (what === "colLeft" || what === "colRight") rows.forEach((row) => row.cells.splice(Math.min(row.cells.length, c + (what === "colRight" ? 1 : 0)), 0, emptyCell()));
    else if (what === "delRow") { if (rows.length < 2) return tableEdit("delTable"); rows.splice(r, 1); }
    else if (what === "delCol") { if (cols < 2) return tableEdit("delTable"); rows.forEach((row) => row.cells.splice(c, 1)); }
    else if (what === "delTable") { const i = doc().blocks.indexOf(t); commitSync({ t: "delete", id: t.id, prev: doc().blocks[i - 1]?.id ?? null }); return; }
    else if (what === "header") { rows[0].cells.forEach((cell) => { cell.bg = cell.bg ? undefined : "#e7e6e6"; cell.blocks.forEach((p) => { p.runs = D().format(p.runs, 0, D().len(p.runs), { b: cell.bg ? true : null }); }); }); }
    else if (what === "shade") { UI().colorPicker(document.activeElement, { none: "No shading", pick: (col) => { rows[r].cells[c].bg = col || undefined; commitSync({ t: "replace", id: t.id, block: nt }); } }); return; }
    commitSync({ t: "replace", id: t.id, block: nt });
  }
  $root.addEventListener("contextmenu", (e) => {
    if (!e.target.closest(".ox-cellbody") || ctx.readOnly) return;
    e.preventDefault();
    W().popMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), focus: () => $root.focus() }, [
      { label: "Insert row above", run: () => tableEdit("rowAbove") }, { label: "Insert row below", run: () => tableEdit("rowBelow") },
      { label: "Insert column left", run: () => tableEdit("colLeft") }, { label: "Insert column right", run: () => tableEdit("colRight") }, null,
      { label: "Header row on/off", run: () => tableEdit("header") }, { label: "Cell shading…", run: () => tableEdit("shade") }, null,
      { label: "Delete row", class: "danger", run: () => tableEdit("delRow") }, { label: "Delete column", class: "danger", run: () => tableEdit("delCol") }, { label: "Delete table", class: "danger", run: () => tableEdit("delTable") },
    ]);
  });

  // ---- pictures
  function pickImage() {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: true, onchange: async () => {
      const f = input.files[0]; input.remove();
      if (f) addImage(f);
    } });
    document.body.append(input); input.click();
  }
  async function addImage(file) {
    try {
      const { src, w, h: ht } = await imageData(file);
      const max = 600, scale = Math.min(1, max / w);
      insertBlock({ type: "img", src, w: Math.round(w * scale), h: Math.round(ht * scale), alt: file.name.replace(/\.[^.]+$/, "") });
    } catch (err) { ctx.toast(err.message); }
  }
  let figSel = null;
  function selectFigure(el) {
    figSel?.classList.remove("on");
    document.querySelector(".ox-figbar")?.remove();
    figSel = el;
    if (!el || ctx.readOnly) return;
    el.classList.add("on");
    const b = doc().blocks.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const set = (patch) => commitSync({ t: "replace", id: b.id, block: { ...b, ...patch } });
    const bar = h("div", { class: "ox-figbar ox-ui" },
      tool("alignLeft", "Left", () => set({ align: undefined })), tool("alignCenter", "Centre", () => set({ align: "center" })), tool("alignRight", "Right", () => set({ align: "right" })),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => { const alt = prompt("Describe the picture (for people who can't see it)", b.alt || ""); if (alt !== null) set({ alt }); } }, "Alt text"),
      tool("trash", "Delete picture", () => { const i = doc().blocks.indexOf(b); commitSync({ t: "delete", id: b.id, prev: doc().blocks[i - 1]?.id ?? null }); }));
    el.append(bar);
  }
  $root.addEventListener("click", (e) => {
    const fig = e.target.closest(".ox-fig");
    if (fig && !e.target.closest(".ox-figbar")) selectFigure(fig);
    const a = e.target.closest("a.ox-link");
    if (a && (e.ctrlKey || e.metaKey || ctx.readOnly)) { e.preventDefault(); const href = D().safeHref(a.getAttribute("href")); if (href && !href.startsWith("#")) window.open(href, "_blank", "noopener"); }
  });
  $root.addEventListener("pointerdown", (e) => {
    const hdl = e.target.closest(".ox-fig-handle");
    if (!hdl || ctx.readOnly) return;
    e.preventDefault();
    const fig = hdl.closest(".ox-fig"), img = fig.querySelector("img");
    const b = doc().blocks.find((x) => x.id === fig.dataset.id);
    const startX = e.clientX, startW = img.offsetWidth, ratio = (b.h || 200) / (b.w || 300);
    const maxW = $root.clientWidth;
    const move = (ev) => { img.style.width = `${Math.max(40, Math.min(maxW, startW + ev.clientX - startX))}px`; };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); const w = Math.round(img.offsetWidth); commitSync({ t: "replace", id: b.id, block: { ...b, w, h: Math.round(w * ratio) } }); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });

  // ---- paste and drop
  $root.addEventListener("paste", async (e) => {
    if (ctx.readOnly) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); for (const f of files) await addImage(f); return; }
    const html = e.clipboardData.getData("text/html"), text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (inCell()) { document.execCommand("insertText", false, text); return; }
    const blocks = html ? fromHtml(html) : text.replace(/\r\n?/g, "\n").split("\n").map((t) => ({ id: D().newId(), type: "p", runs: t ? [{ text: t }] : [] }));
    pasteBlocks(blocks);
  });
  $root.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImage);
  });
  function pasteBlocks(blocks) {
    flush();
    const s = saveSel();
    if (!s || s.cell || !blocks.length) return;
    // Whatever's selected goes first.
    const parts = selBlocks();
    const ops = [];
    const work = D().clone(doc());
    const push = (op) => { if (D().apply(work, op) !== null) ops.push(op); };
    if (parts.length && (parts.length > 1 || parts[0].to > parts[0].from)) {
      const first = parts[0], last = parts[parts.length - 1];
      for (const p of parts.slice(1)) { if (p !== last) push({ t: "delete", id: p.b.id, prev: first.b.id }); }
      if (last !== first) { push({ t: "text", id: last.b.id, at: 0, del: last.to, ins: [] }); push({ t: "join", id: first.b.id, next: last.b.id, at: D().len(work.blocks.find((x) => x.id === first.b.id).runs) }); }
      push({ t: "text", id: first.b.id, at: first.from, del: (last === first ? first.to : D().len(first.b.runs)) - first.from, ins: [] });
    }
    const start = parts[0] || { b: doc().blocks.find((x) => x.id === s.f.id), from: s.f.off };
    const id = start.b.id, at = start.from;
    const textBlocks = blocks.every((b) => b.type === "p");
    if (blocks.length === 1 && textBlocks) push({ t: "text", id, at, del: 0, ins: blocks[0].runs });
    else {
      // Split where the cursor is; the pasted paragraphs go between; the first and last join up with the text around them.
      const tailId = D().newId();
      push({ t: "split", id, at, newId: tailId });
      let after = id;
      blocks.forEach((b, i) => {
        if (i === 0 && b.type === "p") { push({ t: "text", id, at, del: 0, ins: b.runs }); if (b.style || b.list) push({ t: "para", id, set: { style: b.style ?? null, list: b.list ?? null } }); return; }
        const nb = { ...b, id: D().newId() };
        push({ t: "insert", after, block: nb });
        after = nb.id;
      });
      const lastB = work.blocks.find((x) => x.id === after);
      if (lastB?.type === "p" && after !== id) push({ t: "join", id: after, next: tailId, at: D().len(lastB.runs) });
    }
    commitSync(ops);
  }
  /** Pasted HTML (from a web page, Word, Google Docs) as blocks: read from an inert document; scripts and remote pictures never load. */
  function fromHtml(html) {
    const dom = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const para = (el, extra = {}) => { const runs = readRuns(el); out.push({ id: D().newId(), type: "p", runs, ...extra }); };
    const walk = (node, listInfo = null) => {
      for (const el of node.children) {
        const t = el.tagName;
        if (t === "SCRIPT" || t === "STYLE" || t === "META" || t === "TITLE") continue;
        if (/^H[1-6]$/.test(t)) para(el, { style: fromTag[t] });
        else if (t === "UL" || t === "OL") walk(el, { kind: t === "OL" ? "number" : "bullet", level: listInfo ? listInfo.level + 1 : 0 });
        else if (t === "LI") { const nested = [...el.children].filter((x) => x.tagName === "UL" || x.tagName === "OL"); nested.forEach((n) => n.remove()); para(el, { list: listInfo || { kind: "bullet", level: 0 } }); nested.forEach((n) => walk({ children: [n] }, listInfo)); }
        else if (t === "BLOCKQUOTE") para(el, { style: "quote" });
        else if (t === "PRE") para(el, { style: "code" });
        else if (t === "HR") out.push({ id: D().newId(), type: "hr" });
        else if (t === "IMG") { const src = el.getAttribute("src") || ""; if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) out.push({ id: D().newId(), type: "img", src, w: Math.min(600, +el.getAttribute("width") || 300), h: +el.getAttribute("height") || 200, alt: el.alt }); }
        else if (t === "TABLE") {
          const rows = [...el.rows].slice(0, 200).map((tr) => ({ cells: [...tr.cells].slice(0, 30).map((td) => ({ blocks: [{ id: D().newId(), type: "p", runs: readRuns(td) }], ...(td.colSpan > 1 ? { span: td.colSpan } : {}) })) }));
          if (rows.length) out.push({ id: D().newId(), type: "table", rows });
        } else if ([...el.children].some((c) => BLOCK_TAGS.has(c.tagName) || c.tagName === "IMG" || c.tagName === "HR")) walk(el, listInfo);
        else if (BLOCK_TAGS.has(t) || el.textContent.trim()) para(el, el.style?.textAlign && ["center", "right", "justify"].includes(el.style.textAlign) ? { align: el.style.textAlign } : {});
      }
    };
    walk(dom.body);
    if (!out.length && dom.body.textContent.trim()) para(dom.body);
    return out;
  }

  // ---- headers and footers
  for (const [el, which] of [[$header, "header"], [$footer, "footer"]]) {
    let t = null;
    el.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => saveHf(el, which), 700); });
    el.addEventListener("blur", () => { clearTimeout(t); saveHf(el, which); });
  }
  function saveHf(el, which) {
    if (ctx.readOnly) return;
    const blocks = [...el.children].filter((x) => x.tagName !== "BR").map((x) => { if (!x.dataset.id) x.dataset.id = D().newId(); return readPara(x); });
    if (!el.children.length && el.textContent.trim()) blocks.push({ id: D().newId(), type: "p", runs: readRuns(el) });
    const now = blocks.filter((b) => D().len(b.runs));
    if (JSON.stringify(now.map((b) => [D().textOf(b), b.runs, b.align])) === JSON.stringify((doc()[which] || []).map((b) => [D().textOf(b), b.runs, b.align]))) return;
    ctx.commit({ t: "hf", which, blocks: now });
  }

  // ---- page setup
  function pageSetup() {
    const p = { size: "A4", margins: { t: 25, r: 25, b: 25, l: 25 }, ...(doc().page || {}) };
    UI().popover(ctx.toolbar.querySelector('[title="Page setup"]') || ctx.toolbar, (pop, close) => {
      const size = h("select", {}, h("option", { value: "A4" }, "A4"), h("option", { value: "Letter" }, "US Letter")); size.value = p.size || "A4";
      const orient = h("select", {}, h("option", { value: "" }, "Portrait"), h("option", { value: "1" }, "Landscape")); orient.value = p.landscape ? "1" : "";
      const marg = h("select", {}, h("option", { value: "25" }, "Normal (2.5 cm)"), h("option", { value: "13" }, "Narrow (1.27 cm)"), h("option", { value: "19" }, "Moderate (1.9 cm)"), h("option", { value: "38" }, "Wide (3.8 cm)"), h("option", { value: "custom" }, "As it is"));
      const m = p.margins || {};
      marg.value = m.t === m.b && m.l === m.r && m.t === m.l && ["25", "13", "19", "38"].includes(String(m.t)) ? String(m.t) : "custom";
      pop.append(h("div", { class: "ox-form" }, h("label", {}, "Paper ", size), h("label", {}, "Orientation ", orient), h("label", {}, "Margins ", marg),
        h("div", { class: "row end" }, h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => {
          const mm = marg.value === "custom" ? p.margins : { t: +marg.value, r: +marg.value, b: +marg.value, l: +marg.value };
          close();
          commitSync({ t: "page", page: { size: size.value, ...(orient.value ? { landscape: true } : {}), margins: mm } });
        } }, "Apply"))));
    });
  }

  // ---- other people's cursors
  function drawCursors() {
    const out = [];
    const base = $page.getBoundingClientRect();
    for (const p of othersNow) {
      const st = p.state;
      if (!st?.f || st.cell) continue;
      const el = $root.querySelector(`:scope > [data-id="${CSS.escape(st.f.id)}"]`);
      if (!el || el.dataset.type !== "p") continue;
      try {
        const r = document.createRange();
        const [fn, fo] = domAt(el, st.f.off);
        r.setStart(fn, fo); r.collapse(true);
        let rect = r.getClientRects()[0] || el.getBoundingClientRect();
        if (!rect.height) rect = el.getBoundingClientRect();
        const caret = h("div", { class: "ox-rcaret" }, h("span", { class: "ox-rname" }, p.name));
        caret.style.left = `${rect.left - base.left}px`; caret.style.top = `${rect.top - base.top}px`; caret.style.height = `${rect.height || 18}px`;
        caret.style.borderColor = p.color; caret.firstChild.style.background = p.color;
        out.push(caret);
        // Their selection, lightly shaded.
        if (st.a && (st.a.id !== st.f.id || st.a.off !== st.f.off)) {
          const ae = $root.querySelector(`:scope > [data-id="${CSS.escape(st.a.id)}"]`);
          if (ae && ae.dataset.type === "p") {
            const rr = document.createRange();
            const [an, ao] = domAt(ae, st.a.off);
            const forward = ae.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING || (ae === el && st.a.off < st.f.off);
            if (forward) { rr.setStart(an, ao); rr.setEnd(fn, fo); } else { rr.setStart(fn, fo); rr.setEnd(an, ao); }
            for (const q of [...rr.getClientRects()].slice(0, 200)) { const s = h("div", { class: "ox-rsel" }); s.style.left = `${q.left - base.left}px`; s.style.top = `${q.top - base.top}px`; s.style.width = `${q.width}px`; s.style.height = `${q.height}px`; s.style.background = p.color; out.push(s); }
          }
        }
      } catch { /* their paragraph changed under them */ }
    }
    $cursors.replaceChildren(...out);
  }
  function commentMarks() {
    const anchors = ctx.commentAnchors?.() || new Set();
    $root.querySelectorAll(":scope > [data-commented]").forEach((el) => delete el.dataset.commented);
    for (const a of anchors) { const m = /^block:(.+)$/.exec(a); if (m) { const el = $root.querySelector(`:scope > [data-id="${CSS.escape(m[1])}"]`); if (el) el.dataset.commented = "1"; } }
  }

  // ---- find and replace
  let $find = null;
  function findBar() {
    if ($find) { $find.querySelector("input").focus(); return; }
    const q = h("input", { type: "search", placeholder: "Find", "aria-label": "Find" });
    const rep = h("input", { placeholder: "Replace with", "aria-label": "Replace with", hidden: ctx.readOnly });
    const count = h("span", { class: "muted small" });
    const hits = () => { const needle = q.value.toLowerCase(); if (!needle) return []; const out = []; for (const b of doc().blocks) { if (b.type !== "p") continue; const t = D().textOf(b).toLowerCase(); for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + needle.length)) out.push({ id: b.id, at: i, len: needle.length }); } return out; };
    let i = -1;
    const show = (x) => { const el = $root.querySelector(`:scope > [data-id="${CSS.escape(x.id)}"]`); if (!el) return; const [a, ao] = domAt(el, x.at), [b, bo] = domAt(el, x.at + x.len); $root.focus(); getSelection().setBaseAndExtent(a, ao, b, bo); el.scrollIntoView({ block: "center" }); };
    const go = (d) => { const m = hits(); count.textContent = m.length ? "" : "No matches"; if (!m.length) return; i = (i + d + m.length) % m.length; show(m[i]); count.textContent = `${i + 1} of ${m.length}`; };
    const replace = (all) => {
      const m = hits();
      if (!m.length) return;
      const list = all ? m : [m[Math.max(0, i)]];
      // From the end backwards, so earlier positions stay right.
      const ops = list.slice().reverse().map((x) => ({ t: "text", id: x.id, at: x.at, del: x.len, ins: rep.value ? D().slice(doc().blocks.find((b) => b.id === x.id).runs, x.at, x.at + 1).map((r) => ({ ...r, text: rep.value })) : [] }));
      commitSync(ops);
      ctx.toast(`Replaced ${list.length}.`);
    };
    $find = h("div", { class: "ox-find", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { e.stopPropagation(); closeFind(); } } },
      q, h("button", { type: "button", class: "ox-tool", "aria-label": "Previous", onclick: () => go(-1) }, icon("back")), h("button", { type: "button", class: "btn btn-sm", onclick: () => go(1) }, "Next"), count,
      rep, !ctx.readOnly && h("button", { type: "button", class: "btn btn-sm", onclick: () => replace(false) }, "Replace"), !ctx.readOnly && h("button", { type: "button", class: "btn btn-sm", onclick: () => replace(true) }, "Replace all"),
      h("button", { type: "button", class: "ox-tool", "aria-label": "Close", onclick: () => closeFind() }, icon("close")));
    host.querySelector(".ox-docwrap").prepend($find);
    q.focus();
    function closeFind() { $find?.remove(); $find = null; $root.focus(); }
  }

  // ---- printing: the real pagination comes from the browser, at the page size and margins chosen
  function print() {
    const p = doc().page || {};
    const [w, ht] = PAGES[p.size] || PAGES.A4;
    const m = p.margins || { t: 25, r: 25, b: 25, l: 25 };
    const body = document.createElement("div");
    const clean = (el) => { const c = el.cloneNode(true); c.removeAttribute?.("contenteditable"); c.querySelectorAll("[contenteditable]").forEach((x) => x.removeAttribute("contenteditable")); c.querySelectorAll(".ox-ui, .ox-fig-handle, .ox-figbar").forEach((x) => x.remove()); return c; };
    if (doc().header?.length) { const hd = clean($header); hd.className = "print-header"; body.append(hd); }
    if (doc().footer?.length) { const ft = clean($footer); ft.className = "print-footer"; body.append(ft); }
    const main = clean($root); main.className = "ox-doc print-main"; body.append(main);
    UI().printHtml(ctx.file.name, body, [
      `@page { size: ${p.landscape ? `${ht}mm ${w}mm` : `${w}mm ${ht}mm`}; margin: ${m.t}mm ${m.r}mm ${m.b}mm ${m.l}mm; }`,
      "body { margin: 0; font: 11pt/1.4 Calibri, Carlito, Arial, sans-serif; color: #000; }",
      "p, h1, h2, h3, h4, blockquote, pre { margin: 0 0 8pt; white-space: pre-wrap; }",
      "h1 { font-size: 18pt; } h2 { font-size: 15pt; } h3 { font-size: 13pt; } h4 { font-size: 11pt; font-style: italic; }",
      "h1[data-style=title] { font-size: 28pt; font-weight: 400; }",
      "blockquote { margin-left: 36pt; margin-right: 36pt; font-style: italic; color: #404040; }",
      "pre { font: 10pt Consolas, monospace; }",
      "[data-list] { position: relative; padding-left: 18pt; }",
      "[data-list=bullet]::before { content: '•'; position: absolute; left: 4pt; }",
      "[data-indent='1'] { margin-left: 36pt; } [data-indent='2'] { margin-left: 72pt; } [data-indent='3'] { margin-left: 108pt; }",
      "[data-level='1'] { margin-left: 18pt; } [data-level='2'] { margin-left: 36pt; } [data-level='3'] { margin-left: 54pt; }",
      ".ox-pb { break-after: page; height: 0; overflow: hidden; }",
      ".ox-pb span { display: none; }",
      ".ox-hrule hr { border: 0; border-top: 1px solid #000; }",
      ".ox-fig { margin: 0 0 8pt; } .ox-fig.center { text-align: center; } .ox-fig.right { text-align: right; } .ox-fig img { max-width: 100%; height: auto; }",
      "table { border-collapse: collapse; width: 100%; margin-bottom: 8pt; } td { border: 1px solid #000; padding: 3pt 5pt; vertical-align: top; } td p { margin: 0; }",
      "a { color: #0563c1; }",
      ".print-header { position: fixed; top: -12mm; left: 0; right: 0; font-size: 9pt; color: #444; }",
      ".print-footer { position: fixed; bottom: -12mm; left: 0; right: 0; font-size: 9pt; color: #444; }",
      ".print-main { counter-reset: n0; }",
      "[data-list=number] { counter-increment: n0; } [data-list=number]::before { content: counter(n0) '.'; position: absolute; left: 0; }",
    ].join("\n"));
  }

  // ---- start
  drawPage();
  sync();

  return {
    refresh() { sync(); syncToolbar(); },
    others(list) { othersNow = list; drawCursors(); },
    focus() { if (!ctx.readOnly) { $root.focus(); const first = $root.firstElementChild; if (first && first.dataset.type === "p" && !getSelection().rangeCount) getSelection().setBaseAndExtent(first, 0, first, 0); } },
    anchorLabel(anchor) {
      const m = /^block:(.+)$/.exec(anchor || "");
      if (!m) return "";
      const b = doc().blocks.find((x) => x.id === m[1]);
      if (!b) return "(on text that's since been removed)";
      const t = b.type === "p" ? D().textOf(b) : b.type === "table" ? "Table" : b.type === "img" ? "Picture" : "";
      return t.length > 60 ? `“${t.slice(0, 57)}…”` : t ? `“${t}”` : "An empty line";
    },
    reveal(anchor) { const m = /^block:(.+)$/.exec(anchor || ""); const el = m && $root.querySelector(`:scope > [data-id="${CSS.escape(m[1])}"]`); if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("ox-flash"); setTimeout(() => el.classList.remove("ox-flash"), 1500); } },
    commentsChanged: commentMarks,
    print,
    menu: () => (ctx.readOnly ? [] : [{ label: "Page setup…", icon: "file", run: pageSetup }]),
    destroy() { observer.disconnect(); document.removeEventListener("selectionchange", onSel); },
  };
}

window.OfficeKinds = window.OfficeKinds || {};
const blankDoc = () => ({ page: { size: /^en-US|^en-CA/i.test(navigator.language) ? "Letter" : "A4", margins: { t: 25, r: 25, b: 25, l: 25 } }, blocks: [{ id: D().newId(), type: "p", runs: [] }], header: null, footer: null });
window.OfficeKinds.document = {
  get model() { return D(); },
  async load(bytes) {
    if (!bytes.length) return { state: blankDoc(), unsupported: [] };
    const { doc, unsupported } = await window.OfficeFiles.readDocx(bytes);
    return { state: doc, unsupported };
  },
  save: (doc) => window.OfficeFiles.writeDocx(doc),
  get formats() { return [{ label: "Word document (.docx)", ext: "docx", make: (doc) => window.OfficeFiles.writeDocx(doc) }, { label: "Plain text (.txt)", ext: "txt", make: (doc) => new Blob([doc.blocks.filter((b) => b.type === "p").map((b) => D().textOf(b)).join("\n")], { type: "text/plain" }) }]; },
  mount,
  blank: blankDoc,
};
})();
