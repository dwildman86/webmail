// The presentation editor (.pptx): slides down the side, the slide being edited in the middle, speaker notes below.
// Text boxes, shapes and pictures are placed, moved, resized and rotated by hand; text in them is edited in place (the
// document editor's page ↔ paragraphs machinery, doc.js). Changes are ops (pres-model.js), shared through the editor
// (editor.js), so several people can work on the same slides, even in the same text box. Present shows it full screen.
"use strict";

(() => {
const P = () => window.OfficePresModel;
const D = () => window.OfficeDocModel;
const DD = () => window.OfficeDocDom;
const UI = () => window.OfficeUI;
const W = () => window.Webmail;
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v); return el; };
const INSET = { x: 9.6, y: 4.8 }; // PowerPoint's text margins (0.1 and 0.05 inch)

// ---------------------------------------------------------------------------------------------- shapes

/** The outline of a preset shape (PowerPoint's names) in a w × h box, as an SVG path. Unknown ones are drawn as rectangles. */
function shapePath(kind, w, h) {
  const p = (pts) => "M" + pts.map(([x, y]) => `${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`).join("L") + "Z";
  switch (kind) {
    case "ellipse": return `M0 ${h / 2}A${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 0 0 ${h / 2}Z`;
    case "roundRect": { const r = Math.min(w, h) * 0.1667; return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`; }
    case "triangle": return p([[0.5, 0], [1, 1], [0, 1]]);
    case "rtTriangle": return p([[0, 0], [1, 1], [0, 1]]);
    case "diamond": return p([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case "parallelogram": return p([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
    case "trapezoid": return p([[0.25, 0], [0.75, 0], [1, 1], [0, 1]]);
    case "pentagon": return p([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]);
    case "hexagon": return p([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case "octagon": return p([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
    case "star5": { const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.19 : 0.5; pts.push([0.5 + Math.cos(a) * r, 0.52 + Math.sin(a) * r]); } return p(pts); }
    case "rightArrow": return p([[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]]);
    case "leftArrow": return p([[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]]);
    case "upArrow": return p([[0.25, 1], [0.25, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.75, 0.4], [0.75, 1]]);
    case "downArrow": return p([[0.25, 0], [0.25, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.75, 0.6], [0.75, 0]]);
    case "chevron": return p([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1], [0.25, 0.5]]);
    case "homePlate": return p([[0, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0, 1]]);
    case "plus": return p([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]);
    case "wedgeRectCallout": return p([[0, 0], [1, 0], [1, 0.75], [0.42, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]);
    default: return `M0 0H${w}V${h}H0Z`;
  }
}
const SHAPES = [["rect", "Rectangle"], ["roundRect", "Rounded rectangle"], ["ellipse", "Oval"], ["triangle", "Triangle"], ["diamond", "Diamond"], ["pentagon", "Pentagon"], ["hexagon", "Hexagon"],
  ["star5", "Star"], ["rightArrow", "Arrow"], ["chevron", "Chevron"], ["wedgeRectCallout", "Speech bubble"], ["line", "Line"], ["arrowLine", "Arrow line"]];

// ---------------------------------------------------------------------------------------------- drawing a slide

/** An element's DOM (in slide pixels). $edit: for the editor (placeholder prompts shown). */
function elNode(e, { edit = false } = {}) {
  const d = document.createElement("div");
  d.className = `ps-el ps-${e.type}`;
  d.dataset.id = e.id;
  d.style.left = `${e.x}px`; d.style.top = `${e.y}px`; d.style.width = `${Math.max(1, e.w)}px`; d.style.height = `${Math.max(1, e.h)}px`;
  const t = [];
  if (e.rot) t.push(`rotate(${e.rot}deg)`);
  if (e.type === "img" && (e.flipH || e.flipV)) t.push(`scale(${e.flipH ? -1 : 1}, ${e.flipV ? -1 : 1})`);
  if (t.length) d.style.transform = t.join(" ");
  if (e.type === "img") {
    const img = document.createElement("img");
    img.src = /^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(e.src || "") ? e.src : "";
    img.alt = e.alt || "";
    img.draggable = false;
    d.append(img);
    return d;
  }
  const line = e.shape === "line";
  if (e.type === "shape" || e.fill || e.line) {
    const w = Math.max(1, e.w), hh = Math.max(1, e.h);
    const s = svg("svg", { class: "ps-geom", width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, preserveAspectRatio: "none", overflow: "visible" });
    const lw = e.line ? Math.max(0.5, e.line.w || 1) : 0;
    if (line) {
      const [x1, y1, x2, y2] = [e.flipH ? w : 0, e.flipV ? hh : 0, e.flipH ? 0 : w, e.flipV ? 0 : hh];
      if (e.line?.end === "arrow" || e.line?.start === "arrow") {
        const defs = svg("defs"); const mk = svg("marker", { id: `a${e.id}`, viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "4", markerHeight: "4", orient: "auto-start-reverse" });
        mk.append(svg("path", { d: "M0 0L10 5L0 10Z", fill: e.line.color || "#000" })); defs.append(mk); s.append(defs);
      }
      s.append(svg("line", { x1, y1, x2, y2, stroke: e.line?.color || "#000", "stroke-width": lw || 1, "marker-end": e.line?.end === "arrow" ? `url(#a${e.id})` : null, "marker-start": e.line?.start === "arrow" ? `url(#a${e.id})` : null }));
    } else {
      s.append(svg("path", { d: shapePath(e.type === "shape" ? e.shape : "rect", w, hh), fill: e.fill || "none", stroke: e.line ? e.line.color || "#000" : "none", "stroke-width": lw || null, transform: e.flipH || e.flipV ? `translate(${e.flipH ? w : 0} ${e.flipV ? hh : 0}) scale(${e.flipH ? -1 : 1} ${e.flipV ? -1 : 1})` : null }));
    }
    d.append(s);
  }
  if (!line && (e.type === "text" || e.blocks)) d.append(textNode(e, edit));
  return d;
}
function textNode(e, edit) {
  const tx = document.createElement("div");
  tx.className = `ps-text ${e.anchor === "ctr" ? "mid" : e.anchor === "b" ? "bot" : "top"}`;
  const blocks = e.blocks?.length ? e.blocks : [{ id: "x", type: "p", runs: [] }];
  const empty = !blocks.some((b) => D().len(b.runs || []));
  for (const b of blocks) {
    const el = DD().paraEl(b);
    el.removeAttribute("data-style");
    if (b.def?.size) el.style.fontSize = `${b.def.size}pt`;
    if (b.def?.color) el.style.color = b.def.color;
    if (b.def?.font) el.style.fontFamily = `"${b.def.font}", sans-serif`;
    if (b.def?.b) el.style.fontWeight = "700";
    tx.append(el);
  }
  if (empty && edit && blocks[0].hint) tx.firstElementChild.dataset.hint = blocks[0].hint;
  return tx;
}
/** A whole slide's DOM at its own size (w × h px). */
function slideNode(s, size, opts = {}) {
  const d = document.createElement("div");
  d.className = "ps-slide";
  d.style.width = `${size.w}px`; d.style.height = `${size.h}px`;
  d.style.background = s.bg || "#ffffff";
  for (const e of s.els) d.append(elNode(e, opts));
  return d;
}

// ---------------------------------------------------------------------------------------------- the editor

function mount(host, ctx) {
  const { h, icon, tool } = ctx;
  const pres = () => ctx.state;
  let slideId = pres().slides.find((s) => !s.hidden)?.id || pres().slides[0].id;
  const slide = () => pres().slides.find((s) => s.id === slideId) || pres().slides[0];
  const elById = (id) => slide().els.find((e) => e.id === id);
  let sel = new Set();      // selected element ids
  let editing = null;       // { id, node } while typing in a box
  let zoom = 1;
  let othersNow = ctx.others || [];
  let clip = null;          // copied elements

  const $rail = h("div", { class: "ps-rail", role: "listbox", "aria-label": "Slides" });
  const $stage = h("div", { class: "ps-stage" });
  const $canvas = h("div", { class: "ps-canvas" }, $stage);
  const $overlay = h("div", { class: "ps-overlay" });
  const $notes = h("textarea", { class: "ps-notes", placeholder: ctx.readOnly ? "" : "Speaker notes", "aria-label": "Speaker notes", readOnly: ctx.readOnly });
  const $count = h("span", { class: "ox-words" });
  $stage.append($overlay);
  host.append(h("div", { class: "ps" }, $rail, h("div", { class: "ps-main" }, $canvas, $notes), h("div", { class: "ox-foot doc" }, $count)));

  // ---- toolbar
  const tb = ctx.toolbar;
  const fontSel = UI().select("Font", UI().FONTS.map((f) => [f, f]), (v) => formatText({ font: v === "Calibri" ? null : v }));
  const sizeSel = UI().select("Size", [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96].map((s) => [s, s]), (v) => formatText({ size: +v }), "ox-size");
  const btn = {};
  if (!ctx.readOnly) {
    tb.append(
      h("button", { type: "button", class: "btn btn-sm ps-new", onmousedown: (e) => e.preventDefault(), onclick: (e) => newSlideMenu(e.currentTarget) }, icon("plus"), "New slide"), h("span", { class: "ox-sep" }),
      tool("textBox", "Text box", () => addText()), tool("shapes", "Shapes", (e) => shapeMenu(e.currentTarget)), tool("image", "Picture", pickImage), h("span", { class: "ox-sep" }),
      fontSel, sizeSel,
      btn.b = tool("bold", "Bold (Ctrl+B)", () => toggleText("b")), btn.i = tool("italic", "Italic (Ctrl+I)", () => toggleText("i")), btn.u = tool("underline", "Underline (Ctrl+U)", () => toggleText("u")),
      tool("textColor", "Text colour", (e) => UI().colorPicker(e.currentTarget, { pick: (c) => formatText({ color: c }) })),
      btn.left = tool("alignLeft", "Align left", () => alignText(null)), btn.center = tool("alignCenter", "Centre", () => alignText("center")), btn.right = tool("alignRight", "Align right", () => alignText("right")),
      btn.bullet = tool("bullets", "Bulleted list", () => listText("bullet")), btn.number = tool("numbers", "Numbered list", () => listText("number")), h("span", { class: "ox-sep" }),
      tool("fill", "Shape fill", (e) => UI().colorPicker(e.currentTarget, { none: "No fill", pick: (c) => setSel({ fill: c }) })),
      tool("outline", "Outline", (e) => outlineMenu(e.currentTarget)), tool("layers", "Arrange", (e) => arrangeMenu(e.currentTarget)),
      tool("trash", "Delete (Del)", deleteSel), h("span", { class: "ox-sep" }),
      tool("background", "Slide background", (e) => UI().colorPicker(e.currentTarget, { none: "White", pick: (c) => change({ t: "slideSet", id: slideId, set: { bg: c || "#ffffff" } }) })),
      tool("comment", "Comment on this slide", () => ctx.comment(`slide:${slideId}`)),
      h("button", { type: "button", class: "btn btn-sm btn-primary ps-present", onmousedown: (e) => e.preventDefault(), onclick: () => present(slideIndex()) }, icon("play"), "Present"));
  } else {
    tb.append(tool("comment", "Comment on this slide", () => ctx.comment(`slide:${slideId}`)), h("button", { type: "button", class: "btn btn-sm btn-primary ps-present", onclick: () => present(slideIndex()) }, icon("play"), "Present"));
  }
  const slideIndex = () => pres().slides.findIndex((s) => s.id === slideId);

  // ---- drawing
  const thumbSigs = new Map();
  function renderRail() {
    const list = pres().slides;
    const tw = 168, scale = tw / pres().size.w;
    const keep = new Map([...$rail.children].map((c) => [c.dataset.id, c]));
    const nodes = list.map((s, i) => {
      let item = keep.get(s.id);
      const sig = JSON.stringify([s, pres().size]);
      if (!item || thumbSigs.get(s.id) !== sig) {
        const thumb = slideNode(s, pres().size);
        thumb.style.transform = `scale(${scale})`;
        item = h("div", { class: "ps-thumb", role: "option", tabindex: "0", dataset: { id: s.id }, onclick: () => go(s.id), onkeydown: (e) => railKey(e, s.id), oncontextmenu: (e) => { e.preventDefault(); slideMenu(e.currentTarget, s.id); } },
          h("span", { class: "ps-num" }, ""), h("div", { class: "ps-thumb-box" }, thumb), h("span", { class: "ps-who" }));
        item.querySelector(".ps-thumb-box").style.height = `${pres().size.h * scale}px`;
        thumbSigs.set(s.id, sig);
      }
      item.querySelector(".ps-num").textContent = String(i + 1);
      item.classList.toggle("on", s.id === slideId);
      item.classList.toggle("hidden-slide", !!s.hidden);
      item.setAttribute("aria-selected", s.id === slideId ? "true" : "false");
      item.setAttribute("aria-label", `Slide ${i + 1}${s.hidden ? " (hidden)" : ""}`);
      return item;
    });
    if (!ctx.readOnly) nodes.push(h("button", { type: "button", class: "ps-add", onclick: () => newSlide("content") }, icon("plus"), "New slide"));
    $rail.replaceChildren(...nodes);
    drawOthers();
  }
  function fit() {
    const sz = pres().size;
    const box = $canvas.getBoundingClientRect();
    zoom = Math.max(0.1, Math.min((box.width - 48) / sz.w, (box.height - 48) / sz.h));
    $stage.style.width = `${sz.w}px`; $stage.style.height = `${sz.h}px`;
    $stage.style.transform = `scale(${zoom})`;
    $stage.style.left = `${Math.max(24, (box.width - sz.w * zoom) / 2)}px`; $stage.style.top = `${Math.max(24, (box.height - sz.h * zoom) / 2)}px`;
  }
  function renderSlide() {
    const s = slide();
    const old = $stage.querySelector(".ps-slide");
    const fresh = slideNode(s, pres().size, { edit: true });
    // The box being typed in stays as it is (the cursor's in it), unless its text changed under it.
    if (editing && old) {
      const oldEl = old.querySelector(`.ps-el[data-id="${CSS.escape(editing.id)}"]`), e = elById(editing.id);
      const newEl = fresh.querySelector(`.ps-el[data-id="${CSS.escape(editing.id)}"]`);
      if (!e || !oldEl || !newEl) stopEditing(false);
      else {
        const same = JSON.stringify(e.blocks) === editing.sig;
        const tx = oldEl.querySelector(".ps-text");
        // Where the cursor is, by paragraph and offset: the box is moved into the new slide (which takes the focus
        // away), and drawn again if someone else's typing changed it.
        editing.caret = caretIn(tx) || editing.caret;
        if (!same) { tx.replaceWith(editing.node = textNode(e, true)); editing.node.contentEditable = "true"; editing.sig = JSON.stringify(e.blocks); }
        newEl.replaceWith(oldEl);
        for (const k of ["left", "top", "width", "height", "transform"]) oldEl.style[k] = newEl.style[k];
      }
    }
    if (old) old.replaceWith(fresh); else $stage.prepend(fresh);
    if (editing) { editing.node.focus({ preventScroll: true }); if (editing.caret) placeCaret(editing.node, editing.caret); }
    for (const id of [...sel]) if (!elById(id)) sel.delete(id);
    $notes.value = document.activeElement === $notes ? $notes.value : s.notes || "";
    $count.textContent = `Slide ${slideIndex() + 1} of ${pres().slides.length}`;
    drawSel();
    drawOthers();
  }
  function refresh() { renderRail(); renderSlide(); syncToolbar(); }
  function go(id) {
    if (id === slideId) return;
    stopEditing();
    slideId = id; sel.clear();
    refresh();
    presence();
    $rail.querySelector(`.ps-thumb[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ---- selection box
  const toSlide = (cx, cy) => { const r = $stage.getBoundingClientRect(); return { x: (cx - r.left) / zoom, y: (cy - r.top) / zoom }; };
  function drawSel() {
    $overlay.replaceChildren();
    const ids = [...sel].filter(elById);
    for (const id of ids) {
      const e = elById(id);
      const box = h("div", { class: `ps-selbox${ids.length === 1 ? " one" : ""}${editing?.id === id ? " editing" : ""}` });
      box.style.left = `${e.x}px`; box.style.top = `${e.y}px`; box.style.width = `${Math.max(1, e.w)}px`; box.style.height = `${Math.max(1, e.h)}px`;
      if (e.rot) box.style.transform = `rotate(${e.rot}deg)`;
      box.style.setProperty("--z", String(1 / zoom));
      if (ids.length === 1 && !ctx.readOnly && editing?.id !== id) {
        const handles = e.shape === "line" ? ["nw", "se"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
        for (const hd of handles) box.append(h("span", { class: `ps-h ${hd}`, dataset: { h: hd } }));
        if (e.shape !== "line") box.append(h("span", { class: "ps-h rot", dataset: { h: "rot" }, title: "Rotate" }));
      }
      $overlay.append(box);
    }
  }
  function drawOthers() {
    $overlay.querySelectorAll(".ps-other").forEach((x) => x.remove());
    $rail.querySelectorAll(".ps-who").forEach((x) => x.replaceChildren());
    for (const o of othersNow) {
      const p = o.presence;
      if (!p?.slide) continue;
      const who = $rail.querySelector(`.ps-thumb[data-id="${CSS.escape(p.slide)}"] .ps-who`);
      if (who) { const dot = h("span", { class: "ps-dot", title: o.name }, UI().initials(o.name)); dot.style.background = o.color; who.append(dot); }
      if (p.slide !== slideId) continue;
      for (const id of p.els || []) {
        const e = elById(id);
        if (!e) continue;
        const box = h("div", { class: "ps-other" }, h("span", { class: "ps-other-name" }, o.name));
        box.style.left = `${e.x}px`; box.style.top = `${e.y}px`; box.style.width = `${Math.max(1, e.w)}px`; box.style.height = `${Math.max(1, e.h)}px`;
        box.style.setProperty("--c", o.color); box.style.setProperty("--z", String(1 / zoom));
        if (e.rot) box.style.transform = `rotate(${e.rot}deg)`;
        $overlay.append(box);
      }
    }
  }
  let presTimer = null;
  function presence() { clearTimeout(presTimer); presTimer = setTimeout(() => ctx.presence({ slide: slideId, els: [...sel] }), 150); }
  function select(ids) { sel = new Set(ids); drawSel(); syncToolbar(); presence(); }

  // ---- mouse and touch on the slide
  let drag = null;
  $canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const hd = e.target.closest(".ps-h");
    const elNodeHit = e.target.closest(".ps-el");
    if (editing && elNodeHit?.dataset.id === editing.id) return; // typing: the browser handles clicks in the text
    if (editing) stopEditing();
    const pt = toSlide(e.clientX, e.clientY);
    if (hd && !ctx.readOnly) {
      const e0 = elById([...sel][0]);
      drag = { kind: hd.dataset.h === "rot" ? "rot" : "resize", h: hd.dataset.h, start: pt, orig: { ...e0 }, id: e0.id };
    } else if (elNodeHit) {
      const id = elNodeHit.dataset.id;
      const was = sel.has(id);
      if (e.shiftKey) { if (was) sel.delete(id); else sel.add(id); select([...sel]); }
      else if (!was) select([id]);
      if (!ctx.readOnly) drag = { kind: "move", start: pt, origs: [...sel].map((x) => ({ ...elById(x) })), moved: false, clickEdit: was && !e.shiftKey && sel.size === 1, id };
    } else {
      select([]);
      drag = { kind: "marquee", start: pt, box: null };
    }
    $canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    $canvas.focus({ preventScroll: true });
  });
  $canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const pt = toSlide(e.clientX, e.clientY);
    const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (drag.kind === "move") {
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / zoom) return;
      drag.moved = true;
      // Snap to the slide's centre lines and edges, and other things' edges.
      const sz = pres().size, o0 = drag.origs.find((o) => o.id === drag.id) || drag.origs[0];
      const others = slide().els.filter((x) => !sel.has(x.id));
      const xs = [0, sz.w / 2, sz.w, ...others.flatMap((x) => [x.x, x.x + x.w / 2, x.x + x.w])], ys = [0, sz.h / 2, sz.h, ...others.flatMap((x) => [x.y, x.y + x.h / 2, x.y + x.h])];
      const snap = (v, size, list) => { if (e.altKey) return 0; let best = null; for (const t of list) for (const off of [0, size / 2, size]) { const d = t - (v + off); if (Math.abs(d) <= 6 / zoom && (best === null || Math.abs(d) < Math.abs(best))) best = d; } return best ?? 0; };
      const sx = snap(o0.x + dx, o0.w, xs), sy = snap(o0.y + dy, o0.h, ys);
      drag.dx = dx + sx; drag.dy = dy + sy;
      for (const o of drag.origs) { const n = $stage.querySelector(`.ps-slide .ps-el[data-id="${CSS.escape(o.id)}"]`); if (n) { n.style.left = `${o.x + drag.dx}px`; n.style.top = `${o.y + drag.dy}px`; } }
      $overlay.querySelectorAll(".ps-selbox").forEach((b, i) => { const o = drag.origs[i]; if (o) { b.style.left = `${o.x + drag.dx}px`; b.style.top = `${o.y + drag.dy}px`; } });
    } else if (drag.kind === "resize") {
      const o = drag.orig, k = drag.h;
      let { x, y, w, h: ht } = o;
      if (k.includes("e")) w = o.w + dx; if (k.includes("s")) ht = o.h + dy;
      if (k.includes("w")) { x = o.x + dx; w = o.w - dx; } if (k.includes("n")) { y = o.y + dy; ht = o.h - dy; }
      const line = o.shape === "line";
      if ((e.shiftKey || (o.type === "img" && k.length === 2)) && !line && o.w && o.h) { const r = o.w / o.h; if (Math.abs(w / r) > Math.abs(ht)) ht = w / r; else w = ht * r; if (k.includes("w")) x = o.x + o.w - w; if (k.includes("n")) y = o.y + o.h - ht; }
      if (!line) { if (w < 10) { if (k.includes("w")) x -= 10 - w; w = 10; } if (ht < 10) { if (k.includes("n")) y -= 10 - ht; ht = 10; } }
      drag.next = line ? lineBox(o, k, pt) : { x, y, w, h: ht };
      const n = $stage.querySelector(`.ps-slide .ps-el[data-id="${CSS.escape(o.id)}"]`);
      const ghost = { ...o, ...drag.next };
      if (n) n.replaceWith(elNode(ghost, { edit: true }));
      const b = $overlay.querySelector(".ps-selbox"); if (b) { b.style.left = `${ghost.x}px`; b.style.top = `${ghost.y}px`; b.style.width = `${Math.max(1, ghost.w)}px`; b.style.height = `${Math.max(1, ghost.h)}px`; }
    } else if (drag.kind === "rot") {
      const o = drag.orig, c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      let a = (Math.atan2(pt.y - c.y, pt.x - c.x) * 180) / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15; else if (Math.abs(((a % 90) + 90) % 90) < 3 || Math.abs(((a % 90) + 90) % 90) > 87) a = Math.round(a / 90) * 90;
      drag.rot = ((Math.round(a * 10) / 10) % 360 + 360) % 360;
      const n = $stage.querySelector(`.ps-slide .ps-el[data-id="${CSS.escape(o.id)}"]`); if (n) n.style.transform = `rotate(${drag.rot}deg)`;
      const b = $overlay.querySelector(".ps-selbox"); if (b) b.style.transform = `rotate(${drag.rot}deg)`;
    } else if (drag.kind === "marquee") {
      if (Math.abs(dx) + Math.abs(dy) < 4 / zoom) return;
      const r = { x: Math.min(pt.x, drag.start.x), y: Math.min(pt.y, drag.start.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (!drag.box) { drag.box = h("div", { class: "ps-marquee" }); $overlay.append(drag.box); }
      Object.assign(drag.box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      drag.rect = r;
    }
  });
  const endDrag = () => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.kind === "move") {
      if (d.moved) change(d.origs.map((o) => ({ t: "elSet", slide: slideId, id: o.id, set: { x: Math.round(o.x + d.dx), y: Math.round(o.y + d.dy) } })));
      else if (d.clickEdit) { const e = elById(d.id); if (e && (e.type === "text" || (e.type === "shape" && e.shape !== "line"))) startEditing(d.id, true); }
    } else if (d.kind === "resize" && d.next) change({ t: "elSet", slide: slideId, id: d.id, set: { x: Math.round(d.next.x), y: Math.round(d.next.y), w: Math.round(d.next.w), h: Math.round(d.next.h), ...(d.next.flipH !== undefined ? { flipH: d.next.flipH || null, flipV: d.next.flipV || null } : {}) } });
    else if (d.kind === "rot" && d.rot !== undefined) change({ t: "elSet", slide: slideId, id: d.id, set: { rot: d.rot || null } });
    else if (d.kind === "marquee" && d.rect) { d.box?.remove(); const r = d.rect; select(slide().els.filter((e) => e.x < r.x + r.w && e.x + e.w > r.x && e.y < r.y + r.h && e.y + e.h > r.y).map((e) => e.id)); }
    else drawSel();
  };
  /** A line's box from one end dragged to $pt (its other end stays): flips say which way it runs. */
  function lineBox(o, k, pt) {
    const a = { x: o.flipH ? o.x + o.w : o.x, y: o.flipV ? o.y + o.h : o.y }, b = { x: o.flipH ? o.x : o.x + o.w, y: o.flipV ? o.y : o.y + o.h };
    const [p1, p2] = k === "nw" ? [pt, b] : [a, pt];
    return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y), flipH: p2.x < p1.x, flipV: p2.y < p1.y };
  }
  $canvas.addEventListener("pointerup", endDrag);
  $canvas.addEventListener("pointercancel", endDrag);
  $canvas.addEventListener("dblclick", (e) => {
    const n = e.target.closest(".ps-el");
    if (!n || ctx.readOnly || editing?.id === n.dataset.id) return;
    const el = elById(n.dataset.id);
    if (el && (el.type === "text" || (el.type === "shape" && el.shape !== "line"))) startEditing(el.id, true, e);
  });
  $canvas.tabIndex = -1;

  // ---- keys (when not typing in a box)
  $canvas.addEventListener("keydown", (e) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key;
    if (ctx.readOnly) { if (["ArrowRight", "ArrowDown", "PageDown"].includes(k)) { step(1); e.preventDefault(); } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(k)) { step(-1); e.preventDefault(); } return; }
    if ((k === "Delete" || k === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); return; }
    if (k.startsWith("Arrow") && sel.size) {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1, dx = k === "ArrowLeft" ? -n : k === "ArrowRight" ? n : 0, dy = k === "ArrowUp" ? -n : k === "ArrowDown" ? n : 0;
      change([...sel].map((id) => { const x = elById(id); return { t: "elSet", slide: slideId, id, set: { x: x.x + dx, y: x.y + dy } }; }), { group: `nudge:${[...sel].join()}` });
      return;
    }
    if (k.startsWith("Arrow") || k === "PageDown" || k === "PageUp") { e.preventDefault(); step(k === "ArrowDown" || k === "ArrowRight" || k === "PageDown" ? 1 : -1); return; }
    if ((k === "Enter" || k === "F2") && sel.size === 1) { const x = elById([...sel][0]); if (x && x.type !== "img" && x.shape !== "line") { e.preventDefault(); startEditing(x.id, false); } return; }
    if (k === "Escape") { select([]); return; }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); select(slide().els.map((x) => x.id)); return; }
    if (mod && k.toLowerCase() === "d") { e.preventDefault(); duplicateSel(); return; }
    if (mod && k.toLowerCase() === "c") { copySel(false); return; }
    if (mod && k.toLowerCase() === "x") { copySel(true); return; }
    if (mod && k.toLowerCase() === "m") { e.preventDefault(); newSlide("content"); return; }
    if (mod && ["b", "i", "u"].includes(k.toLowerCase()) && sel.size) { e.preventDefault(); toggleText(k.toLowerCase()); return; }
    // Typing with a box selected starts typing in it (its text replaced, as in PowerPoint).
    if (!mod && !e.altKey && k.length === 1 && sel.size === 1) { const x = elById([...sel][0]); if (x && x.type !== "img" && x.shape !== "line") startEditing(x.id, false, null, true); }
  });
  $canvas.addEventListener("paste", (e) => {
    if (editing || ctx.readOnly) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => /^image\//.test(f.type));
    if (file) { e.preventDefault(); addImage(file); return; }
    const text = e.clipboardData?.getData("text/plain") || "";
    if (clip && text === clip.marker) { e.preventDefault(); pasteEls(); return; }
    if (text.trim()) { e.preventDefault(); addText(text); }
  });
  function step(d) {
    const list = pres().slides, i = slideIndex() + d;
    if (i >= 0 && i < list.length) go(list[i].id);
  }
  function railKey(e, id) {
    const i = pres().slides.findIndex((s) => s.id === id);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey && !ctx.readOnly) { const to = Math.max(0, Math.min(pres().slides.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))); change({ t: "slideMove", id, at: to }); }
      else { const n = pres().slides[i + (e.key === "ArrowDown" ? 1 : -1)]; if (n) { go(n.id); $rail.querySelector(`.ps-thumb[data-id="${CSS.escape(n.id)}"]`)?.focus(); } }
    } else if ((e.key === "Delete" || e.key === "Backspace") && !ctx.readOnly) { e.preventDefault(); deleteSlide(id); }
    else if (e.key === "Enter") { e.preventDefault(); $canvas.focus(); }
  }

  // ---- typing in a box
  function startEditing(id, fromPointer, ev = null, replace = false) {
    const e = elById(id);
    if (!e || ctx.readOnly) return;
    if (!e.blocks) { change({ t: "el", slide: slideId, id, el: { ...e, blocks: [{ id: D().newId(), type: "p", runs: [], align: "center", def: { size: 18, color: "#ffffff" } }] } }); }
    select([id]);
    const n = $stage.querySelector(`.ps-slide .ps-el[data-id="${CSS.escape(id)}"] .ps-text`);
    if (!n) return;
    n.contentEditable = "true";
    n.querySelectorAll("[data-hint]").forEach((x) => x.removeAttribute("data-hint"));
    editing = { id, node: n, sig: JSON.stringify(elById(id).blocks) };
    drawSel();
    n.focus({ preventScroll: true });
    const s = getSelection();
    if (replace) { const r = document.createRange(); r.selectNodeContents(n); s.removeAllRanges(); s.addRange(r); }
    else if (fromPointer && ev && document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(ev.clientX, ev.clientY); if (r && n.contains(r.startContainer)) { s.removeAllRanges(); s.addRange(r); } }
    else { const last = n.lastElementChild; if (last) { const [nd, o] = DD().domAt(last, D().len(DD().readRuns(last))); s.setBaseAndExtent(nd, o, nd, o); } }
    presence();
    syncToolbar();
  }
  function stopEditing(save = true) {
    if (!editing) return;
    if (save) flushBox();
    editing.node.contentEditable = "false";
    editing = null;
    renderSlide();
    renderRail();
  }
  /** The caret in a box as { id, off } of its paragraph; and back. */
  function caretIn(tx) {
    const s = getSelection();
    if (!s.rangeCount || !tx.contains(s.focusNode)) return null;
    const p = (s.focusNode.nodeType === 3 ? s.focusNode.parentNode : s.focusNode).closest("[data-id]");
    return p && tx.contains(p) ? { id: p.dataset.id, off: DD().offsetIn(p, s.focusNode, s.focusOffset) } : null;
  }
  function placeCaret(tx, c) {
    const p = tx.querySelector(`[data-id="${CSS.escape(c.id)}"]`) || tx.lastElementChild;
    if (!p) return;
    const [n, o] = DD().domAt(p, Math.min(c.off, D().len(DD().readRuns(p))));
    try { getSelection().setBaseAndExtent(n, o, n, o); } catch { /* gone */ }
  }
  function textOps(id, oldRuns, newRuns) {
    const flat = (runs) => { const out = []; for (const r of runs) { const k = JSON.stringify(D().props(r)); for (let i = 0; i < r.text.length; i++) out.push(r.text[i] + "\u0000" + k); } return out; };
    const a = flat(oldRuns), b = flat(newRuns);
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    if (p === a.length && p === b.length) return [];
    return [{ t: "text", id, at: p, del: a.length - p - s, ins: D().slice(newRuns, p, b.length - s) }];
  }
  /** What changed in the box being typed in, as document ops inside "tx" ops. */
  function flushBox() {
    if (!editing) return;
    const e = elById(editing.id);
    if (!e) return;
    const tx = editing.node;
    // Text the browser left outside a paragraph goes into one.
    for (const n of [...tx.childNodes]) if (n.nodeType === 3 || (n.nodeType === 1 && !n.dataset.id && n.tagName !== "P" && n.tagName !== "DIV")) { const p = document.createElement("p"); n.replaceWith(p); p.append(n); }
    const els = [...tx.children];
    const seen = new Set();
    for (const el of els) { if (!el.dataset.id || seen.has(el.dataset.id)) el.dataset.id = D().newId(); el.dataset.type = "p"; seen.add(el.dataset.id); }
    const model = { blocks: e.blocks || [] };
    const work = { blocks: model.blocks.map((b) => ({ ...b, runs: b.runs.map((r) => ({ ...r })) })) };
    const ops = [];
    const push = (op) => { if (D().apply(work, op) !== null) ops.push(op); };
    const dIds = els.map((x) => x.dataset.id), dSet = new Set(dIds), oSet = new Set(model.blocks.map((b) => b.id));
    for (const b of model.blocks) {
      if (dSet.has(b.id)) continue;
      const i = work.blocks.findIndex((x) => x.id === b.id), prev = work.blocks[i - 1];
      if (prev && dSet.has(prev.id)) push({ t: "join", id: prev.id, next: b.id, at: D().len(prev.runs) });
      else if (work.blocks.length > 1) push({ t: "delete", id: b.id, prev: prev?.id ?? null });
    }
    dIds.forEach((id, k) => {
      if (oSet.has(id)) return;
      const pred = k > 0 && work.blocks.find((x) => x.id === dIds[k - 1]);
      if (pred) { const before = D().textOf(pred), now = DD().readRuns(els[k - 1]).map((r) => r.text).join(""); let at = 0; while (at < before.length && at < now.length && before[at] === now[at]) at++; push({ t: "split", id: pred.id, at, newId: id }); }
      else if (!work.blocks.some((x) => x.id === id)) { const first = work.blocks[0]; push({ t: "insert", after: null, block: { ...DD().readPara(els[k]), id, ...(first?.def ? { def: first.def } : {}), ...(first?.list ? { list: first.list } : {}) } }); }
    });
    for (const el of els) {
      const b = work.blocks.find((x) => x.id === el.dataset.id);
      if (!b) continue;
      const nb = DD().readPara(el);
      // What's typed into an empty paragraph takes the paragraph's own look (a title's size and colour).
      if (!D().len(b.runs) && b.def) nb.runs = nb.runs.map((r) => (Object.keys(D().props(r)).length ? r : { ...b.def, ...r }));
      for (const op of textOps(b.id, b.runs, nb.runs)) push(op);
      const set = {};
      for (const k of ["align", "list", "indent"]) if (JSON.stringify(b[k] ?? null) !== JSON.stringify(nb[k] ?? null)) set[k] = nb[k] ?? null;
      if (Object.keys(set).length) push({ t: "para", id: b.id, set });
    }
    if (!ops.length) return;
    ctx.commit(ops.map((op) => ({ t: "tx", slide: slideId, el: e.id, op })), { group: ops.every((o) => o.t === "text") ? `type:${e.id}` : null });
    editing.sig = JSON.stringify(elById(e.id)?.blocks);
    renderRail();
  }
  $stage.addEventListener("input", (e) => { if (editing && editing.node.contains(e.target)) flushBox(); });
  $stage.addEventListener("keydown", (e) => {
    if (!editing || !editing.node.contains(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const id = editing.id; stopEditing(); select([id]); $canvas.focus(); return; }
    if (mod && ["b", "i", "u"].includes(e.key.toLowerCase())) { e.preventDefault(); toggleText(e.key.toLowerCase()); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const c = caretIn(editing.node), b = c && elById(editing.id).blocks.find((x) => x.id === c.id);
      if (b) { const level = Math.max(0, Math.min(4, (b.list?.level || 0) + (e.shiftKey ? -1 : 1))); change({ t: "tx", slide: slideId, el: editing.id, op: { t: "para", id: b.id, set: { list: { kind: b.list?.kind || "bullet", level } } } }); }
    }
  });
  $stage.addEventListener("beforeinput", (e) => { if (editing && e.inputType === "historyUndo") { e.preventDefault(); ctx.undo(); } else if (editing && e.inputType === "historyRedo") { e.preventDefault(); ctx.redo(); } else if (editing && /^format/.test(e.inputType)) e.preventDefault(); });
  document.addEventListener("selectionchange", onSel);
  function onSel() { if (editing && editing.node.contains(getSelection().anchorNode)) syncToolbar(); }

  // ---- changes
  function change(ops, o) {
    if (ctx.readOnly) return;
    if (editing) flushBox();
    ctx.commit(ops, o);
    refresh();
  }
  /** The text formatting at the caret, or of the first selected box. */
  function textHere() {
    if (editing) {
      const c = caretIn(editing.node), b = c && elById(editing.id)?.blocks?.find((x) => x.id === c.id);
      if (b) { const r = D().slice(b.runs, Math.max(0, c.off - 1), Math.max(1, c.off))[0]; return { ...(b.def || {}), ...(r ? D().props(r) : {}), _b: b }; }
    }
    const e = [...sel].map(elById).find((x) => x?.blocks);
    const b = e?.blocks[0];
    return b ? { ...(b.def || {}), ...(b.runs[0] ? D().props(b.runs[0]) : {}), _b: b } : {};
  }
  function syncToolbar() {
    if (ctx.readOnly) return;
    const r = textHere();
    for (const k of ["b", "i", "u"]) btn[k].classList.toggle("on", !!r[k]);
    fontSel.value = r.font && UI().FONTS.includes(r.font) ? r.font : "Calibri";
    sizeSel.value = String(Math.round(r.size || 18));
    const b = r._b;
    btn.left.classList.toggle("on", !!b && !b.align); btn.center.classList.toggle("on", b?.align === "center"); btn.right.classList.toggle("on", b?.align === "right");
    btn.bullet.classList.toggle("on", b?.list?.kind === "bullet"); btn.number.classList.toggle("on", b?.list?.kind === "number");
  }
  /** Ops that format text: the selection while typing, else all the text in the selected boxes. */
  function textRanges() {
    if (editing) {
      const s = getSelection(), e = elById(editing.id);
      if (!s.rangeCount || !e) return [];
      const pt = (node, off) => { const p = (node.nodeType === 3 ? node.parentNode : node).closest("[data-id]"); return p && editing.node.contains(p) ? { id: p.dataset.id, off: DD().offsetIn(p, node, off) } : null; };
      let a = pt(s.anchorNode, s.anchorOffset), f = pt(s.focusNode, s.focusOffset);
      if (!a || !f) return [];
      const ids = e.blocks.map((b) => b.id);
      if (ids.indexOf(a.id) > ids.indexOf(f.id) || (a.id === f.id && a.off > f.off)) [a, f] = [f, a];
      const out = [];
      for (let i = ids.indexOf(a.id); i <= ids.indexOf(f.id); i++) { const b = e.blocks[i]; out.push({ el: e.id, b, from: b.id === a.id ? a.off : 0, to: b.id === f.id ? f.off : D().len(b.runs) }); }
      return out;
    }
    return [...sel].map(elById).filter((e) => e?.blocks).flatMap((e) => e.blocks.map((b) => ({ el: e.id, b, from: 0, to: D().len(b.runs), whole: true })));
  }
  function formatText(set) {
    const ranges = textRanges();
    if (!ranges.length) { ctx.toast("Select a text box, or text in one, first."); return; }
    const caret = editing && caretIn(editing.node);
    const ops = [];
    for (const r of ranges) {
      if (r.to > r.from) ops.push({ t: "tx", slide: slideId, el: r.el, op: { t: "fmt", id: r.b.id, from: r.from, to: r.to, set } });
    }
    // Formatting a whole box (or an empty paragraph) also changes what's typed there next.
    const defs = ranges.filter((r) => r.whole || !D().len(r.b.runs));
    const byEl = new Map();
    for (const r of defs) { if (!byEl.has(r.el)) byEl.set(r.el, new Set()); byEl.get(r.el).add(r.b.id); }
    for (const [elId, ids] of byEl) { const e = elById(elId); ops.push({ t: "el", slide: slideId, id: elId, el: { ...e, blocks: e.blocks.map((b) => (ids.has(b.id) ? { ...b, def: { ...(b.def || {}), ...Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null)) } } : b)) } }); }
    if (!ops.length) return;
    // Whole-box replacements go last so they carry the formatted runs.
    const fmts = ops.filter((o) => o.t === "tx"), wholes = ops.filter((o) => o.t === "el");
    if (editing) flushBox();
    ctx.commit(fmts);
    ctx.commit(wholes.map((o) => { const cur = elById(o.id); return { ...o, el: { ...cur, blocks: cur.blocks.map((b) => ({ ...b, def: o.el.blocks.find((x) => x.id === b.id)?.def })) } }; }));
    rerender(caret);
  }
  function rerender(caret) {
    if (editing) { const e = elById(editing.id); const fresh = textNode(e, true); editing.node.replaceWith(fresh); editing.node = fresh; fresh.contentEditable = "true"; editing.sig = JSON.stringify(e.blocks); fresh.focus({ preventScroll: true }); if (caret) placeCaret(fresh, caret); }
    refresh();
  }
  function toggleText(k) { formatText({ [k]: textHere()[k] ? null : true }); }
  function paraOps(fn) {
    const ranges = textRanges();
    if (!ranges.length) { ctx.toast("Select a text box, or text in one, first."); return; }
    const caret = editing && caretIn(editing.node);
    if (editing) flushBox();
    ctx.commit(ranges.map((r) => ({ t: "tx", slide: slideId, el: r.el, op: { t: "para", id: r.b.id, set: fn(r.b) } })));
    rerender(caret);
  }
  const alignText = (a) => paraOps(() => ({ align: a }));
  const listText = (kind) => { const on = textHere()._b?.list?.kind === kind; paraOps((b) => ({ list: on ? null : { kind, level: b.list?.level || 0 } })); };
  function setSel(set) {
    if (!sel.size) { ctx.toast("Select a shape or text box first."); return; }
    change([...sel].map((id) => ({ t: "elSet", slide: slideId, id, set })));
  }
  function outlineMenu(anchor) {
    W().popMenu(anchor, [
      { label: "Colour…", run: () => UI().colorPicker(anchor, { none: "No outline", pick: (c) => setSel({ line: c ? { ...(elById([...sel][0])?.line || { w: 2 }), color: c } : null }) }) },
      ...[1, 2, 3, 6].map((w) => ({ label: `${w} pt`, run: () => setSel({ line: { ...(elById([...sel][0])?.line || { color: "#000000" }), w: w * 4 / 3 } }) })),
      { label: "No outline", run: () => setSel({ line: null }) },
    ]);
  }
  function arrangeMenu(anchor) {
    const z = (fn) => () => { if (sel.size !== 1) { ctx.toast("Select one thing to move in front or behind."); return; } const id = [...sel][0], i = slide().els.findIndex((x) => x.id === id); change({ t: "elZ", slide: slideId, id, at: fn(i, slide().els.length) }); };
    W().popMenu(anchor, [
      { label: "Bring to front", run: z((i, n) => n - 1) }, { label: "Bring forward", run: z((i, n) => Math.min(n - 1, i + 1)) },
      { label: "Send backward", run: z((i) => Math.max(0, i - 1)) }, { label: "Send to back", run: z(() => 0) }, null,
      { label: "Centre on the slide", run: () => setSelEach((e) => ({ x: Math.round((pres().size.w - e.w) / 2), y: Math.round((pres().size.h - e.h) / 2) })) },
      { label: "Flip horizontally", run: () => setSelEach((e) => ({ flipH: !e.flipH || null })) }, { label: "Flip vertically", run: () => setSelEach((e) => ({ flipV: !e.flipV || null })) },
      { label: "Duplicate", hint: "Ctrl+D", run: duplicateSel },
    ]);
  }
  function setSelEach(fn) { if (!sel.size) { ctx.toast("Select something first."); return; } change([...sel].map((id) => ({ t: "elSet", slide: slideId, id, set: fn(elById(id)) }))); }

  // ---- adding things
  const center = (w, ht) => ({ x: Math.round((pres().size.w - w) / 2), y: Math.round((pres().size.h - ht) / 2) });
  function addEl(el) { const id = P().newId(); change({ t: "el", slide: slideId, id, el: { ...el, id } }); select([id]); return id; }
  function addText(text = "") {
    const w = 480, ht = 80;
    const id = addEl({ type: "text", ...center(w, ht), w, h: ht, blocks: (text ? text.split("\n") : [""]).map((t) => ({ id: D().newId(), type: "p", runs: t ? [{ text: t, size: 20 }] : [], def: { size: 20 } })) });
    if (!text) startEditing(id, false);
  }
  function shapeMenu(anchor) {
    W().popMenu(anchor, SHAPES.map(([k, l]) => ({ label: l, run: () => {
      if (k === "line" || k === "arrowLine") addEl({ type: "shape", shape: "line", ...center(320, 0), w: 320, h: 0, line: { color: "#1f2937", w: 3, ...(k === "arrowLine" ? { end: "arrow" } : {}) } });
      else addEl({ type: "shape", shape: k, ...center(240, k === "rightArrow" || k === "chevron" ? 140 : 180), w: 240, h: k === "rightArrow" || k === "chevron" ? 140 : 180, fill: "#4472c4", line: { color: "#2f528f", w: 1.33 }, anchor: "ctr" });
    } })), { className: "ps-shape-menu" });
  }
  function pickImage() {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/bmp", onchange: () => { if (input.files[0]) addImage(input.files[0]); } });
    input.click();
  }
  async function addImage(file) {
    try {
      const { src, w, h: ht } = await DD().imageData(file);
      const sz = pres().size, scale = Math.min(1, (sz.w * 0.6) / w, (sz.h * 0.6) / ht);
      addEl({ type: "img", src, alt: file.name.replace(/\.[^.]+$/, ""), ...center(w * scale, ht * scale), w: Math.round(w * scale), h: Math.round(ht * scale) });
    } catch (err) { ctx.toast(err.message); }
  }
  function deleteSel() {
    if (!sel.size) return;
    const ids = [...sel];
    select([]);
    change(ids.map((id) => ({ t: "el", slide: slideId, id, el: null })));
  }
  function cloneEl(e, dx = 20, dy = 20) { return { ...JSON.parse(JSON.stringify(e)), id: P().newId(), x: e.x + dx, y: e.y + dy, blocks: e.blocks?.map((b) => ({ ...JSON.parse(JSON.stringify(b)), id: D().newId() })) }; }
  function duplicateSel() {
    if (!sel.size) return;
    const copies = [...sel].map(elById).filter(Boolean).map((e) => cloneEl(e));
    change(copies.map((c) => ({ t: "el", slide: slideId, id: c.id, el: c })));
    select(copies.map((c) => c.id));
  }
  function copySel(cut) {
    if (!sel.size) return;
    clip = { els: [...sel].map(elById).filter(Boolean).map((e) => JSON.parse(JSON.stringify(e))), marker: `[slides ${Date.now()}]` };
    navigator.clipboard?.writeText(clip.els.map((e) => P().textOf(e)).filter(Boolean).join("\n") || clip.marker).then(() => { clip.marker = clip.els.map((e) => P().textOf(e)).filter(Boolean).join("\n") || clip.marker; }).catch(() => {});
    if (cut) deleteSel();
  }
  function pasteEls() {
    const copies = clip.els.map((e) => cloneEl(e, 20, 20));
    change(copies.map((c) => ({ t: "el", slide: slideId, id: c.id, el: c })));
    select(copies.map((c) => c.id));
  }

  // ---- slides
  const THEME = () => { const s = slide(); const t = s.els.find((e) => e.ph === "title")?.blocks?.[0]; return { accent: t?.def?.color || t?.runs?.[0]?.color, font: t?.def?.font }; };
  function newSlide(kind, after = slideId) {
    const id = "s" + P().newId().slice(1);
    const at = pres().slides.findIndex((s) => s.id === after) + 1;
    const bg = slide().bg && slide().bg !== "#ffffff" && kind !== "title" && kind !== "section" ? "#ffffff" : slide().bg || "#ffffff";
    change({ t: "slide", id, at, slide: { bg, els: P().layout(kind, pres().size, THEME()) } });
    go(id);
  }
  function newSlideMenu(anchor) { W().popMenu(anchor, P().LAYOUTS.map(([k, l]) => ({ label: l, run: () => newSlide(k) }))); }
  function deleteSlide(id) {
    if (pres().slides.length < 2) { ctx.toast("A presentation needs at least one slide."); return; }
    const i = pres().slides.findIndex((s) => s.id === id);
    if (id === slideId) { slideId = (pres().slides[i + 1] || pres().slides[i - 1]).id; sel.clear(); }
    change({ t: "slideDel", id });
  }
  function duplicateSlide(id) {
    const s = pres().slides.find((x) => x.id === id), nid = "s" + P().newId().slice(1);
    change({ t: "slide", id: nid, at: pres().slides.indexOf(s) + 1, slide: { ...JSON.parse(JSON.stringify(s)), els: s.els.map((e) => cloneEl(e, 0, 0)) } });
    go(nid);
  }
  function slideMenu(anchor, id) {
    if (ctx.readOnly) return;
    const s = pres().slides.find((x) => x.id === id), i = pres().slides.indexOf(s);
    W().popMenu(anchor, [
      { label: "New slide after", run: () => newSlide("content", id) }, { label: "Duplicate", run: () => duplicateSlide(id) },
      { label: s.hidden ? "Show in the slide show" : "Hide in the slide show", run: () => change({ t: "slideSet", id, set: { hidden: !s.hidden } }) },
      { label: "Move up", hint: "Alt+↑", run: () => change({ t: "slideMove", id, at: Math.max(0, i - 1) }) }, { label: "Move down", hint: "Alt+↓", run: () => change({ t: "slideMove", id, at: i + 1 }) },
      null, { label: "Delete slide", class: "danger", run: () => deleteSlide(id) },
    ]);
  }
  // Dragging slides in the list to reorder them.
  let railDrag = null;
  $rail.addEventListener("pointerdown", (e) => { const t = e.target.closest(".ps-thumb"); if (t && !ctx.readOnly && e.button === 0) railDrag = { id: t.dataset.id, y: e.clientY, moved: false }; });
  $rail.addEventListener("pointermove", (e) => {
    if (!railDrag) return;
    if (!railDrag.moved && Math.abs(e.clientY - railDrag.y) < 8) return;
    railDrag.moved = true;
    $rail.classList.add("dragging");
    $rail.querySelectorAll(".ps-thumb").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".ps-thumb");
    if (over && over.dataset.id !== railDrag.id) { const r = over.getBoundingClientRect(); over.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after"); railDrag.over = over.dataset.id; railDrag.before = e.clientY < r.top + r.height / 2; }
  });
  document.addEventListener("pointerup", onRailUp);
  function onRailUp() {
    const d = railDrag; railDrag = null;
    $rail.classList.remove("dragging");
    $rail.querySelectorAll(".ps-thumb").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    if (!d?.moved || !d.over) return;
    const list = pres().slides.map((s) => s.id).filter((x) => x !== d.id);
    const at = list.indexOf(d.over) + (d.before ? 0 : 1);
    change({ t: "slideMove", id: d.id, at });
  }

  // ---- notes
  let notesTimer = null;
  $notes.addEventListener("input", () => { clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 600); });
  $notes.addEventListener("blur", () => { clearTimeout(notesTimer); saveNotes(); });
  function saveNotes() { if (ctx.readOnly) return; const v = $notes.value; if ((slide().notes || "") !== v) { ctx.commit({ t: "slideSet", id: slideId, set: { notes: v } }); renderRail(); } }

  // ---- presenting
  function present(from = 0) {
    stopEditing();
    const list = () => pres().slides.filter((s) => !s.hidden || s.id === pres().slides[from]?.id);
    let i = Math.max(0, list().findIndex((s) => s.id === pres().slides[from]?.id));
    const $show = h("div", { class: "ps-show", tabindex: "0", role: "dialog", "aria-label": "Slide show" });
    const $count2 = h("div", { class: "ps-show-count" });
    const draw = () => {
      const s = list()[i];
      if (!s) return;
      const sz = pres().size, scale = Math.min(innerWidth / sz.w, innerHeight / sz.h);
      const n = slideNode(s, sz);
      n.style.transform = `scale(${scale})`;
      n.style.left = `${(innerWidth - sz.w * scale) / 2}px`; n.style.top = `${(innerHeight - sz.h * scale) / 2}px`;
      $show.replaceChildren(n, $count2);
      $count2.textContent = `${i + 1} / ${list().length}`;
    };
    const close = () => { removeEventListener("resize", draw); $show.remove(); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); $canvas.focus(); };
    $show.addEventListener("keydown", (e) => {
      const k = e.key;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(k)) { e.preventDefault(); if (i < list().length - 1) { i++; draw(); } else close(); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(k)) { e.preventDefault(); if (i > 0) { i--; draw(); } }
      else if (k === "Home") { i = 0; draw(); } else if (k === "End") { i = list().length - 1; draw(); }
      else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    $show.addEventListener("click", (e) => { if (e.clientX < innerWidth / 4) { if (i > 0) { i--; draw(); } } else if (i < list().length - 1) { i++; draw(); } else close(); });
    document.addEventListener("fullscreenchange", function fs() { if (!document.fullscreenElement && $show.isConnected) { document.removeEventListener("fullscreenchange", fs); close(); } });
    addEventListener("resize", draw);
    document.body.append($show);
    $show.requestFullscreen?.().catch(() => {});
    draw();
    $show.focus();
  }

  // ---- printing: a slide a page
  function print() {
    const sz = pres().size;
    const body = document.createElement("div");
    const pageW = 277; // mm across a landscape A4 page, less the margins
    const scale = (pageW * 96 / 25.4) / sz.w;
    for (const s of pres().slides.filter((x) => !x.hidden)) {
      const page = document.createElement("div"); page.className = "print-slide";
      const n = slideNode(s, sz); n.style.transform = `scale(${scale})`;
      page.style.height = `${sz.h * scale}px`; page.append(n);
      body.append(page);
    }
    UI().printHtml(ctx.file.name, body, [
      "@page { size: A4 landscape; margin: 10mm; }",
      "body { margin: 0; font-family: Calibri, Carlito, Arial, sans-serif; }",
      ".print-slide { position: relative; overflow: hidden; break-after: page; border: 1px solid #ccc; }",
      ".ps-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; }",
      ".ps-el { position: absolute; transform-origin: center; } .ps-el img { width: 100%; height: 100%; display: block; } .ps-geom { position: absolute; inset: 0; }",
      `.ps-text { position: absolute; inset: 0; padding: ${INSET.y}px ${INSET.x}px; display: flex; flex-direction: column; white-space: pre-wrap; overflow-wrap: break-word; font-size: 18pt; line-height: 1.2; }`,
      ".ps-text.mid { justify-content: center; } .ps-text.bot { justify-content: flex-end; } .ps-text p { margin: 0; }",
      ".ps-text [data-list] { position: relative; padding-left: 1.1em; } .ps-text [data-list=bullet]::before { content: '•'; position: absolute; left: 0.1em; }",
      ".ps-text [data-level='1'] { margin-left: 1.2em; } .ps-text [data-level='2'] { margin-left: 2.4em; }",
    ].join("\n"));
  }

  // ---- start
  const ro = new ResizeObserver(() => { fit(); drawSel(); drawOthers(); });
  ro.observe($canvas);
  fit();
  refresh();
  presence();

  return {
    refresh() { refresh(); },
    others(list) { othersNow = list; drawOthers(); },
    focus() { $canvas.focus({ preventScroll: true }); },
    anchorLabel(anchor) { const m = /^slide:(.+)$/.exec(anchor || ""); if (!m) return ""; const i = pres().slides.findIndex((s) => s.id === m[1]); return i < 0 ? "(a slide that's since been deleted)" : `Slide ${i + 1}`; },
    reveal(anchor) { const m = /^slide:(.+)$/.exec(anchor || ""); if (m && pres().slides.some((s) => s.id === m[1])) go(m[1]); },
    commentsChanged() {},
    print,
    menu: () => [
      { label: "Present from the start", icon: "eye", run: () => present(0) },
      ...(ctx.readOnly ? [] : [{ label: pres().size.w / pres().size.h > 1.5 ? "Make slides 4:3" : "Make slides 16:9 (widescreen)", icon: "layers", run: () => { const w = pres().size.w / pres().size.h > 1.5 ? 960 : 1280; change({ t: "size", w, h: 720 }); fit(); refresh(); } }]),
    ],
    escape() { if (editing) { const id = editing.id; stopEditing(); select([id]); return true; } if (sel.size) { select([]); return true; } return false; },
    destroy() { ro.disconnect(); document.removeEventListener("selectionchange", onSel); document.removeEventListener("pointerup", onRailUp); },
  };
}

// ---------------------------------------------------------------------------------------------- the kind

const blank = () => {
  const size = { w: 1280, h: 720 };
  return { size, slides: [{ id: "s1", bg: "#ffffff", els: window.OfficePresModel.layout("title", size) }] };
};
window.OfficeKinds = window.OfficeKinds || {};
window.OfficeKinds.presentation = {
  get model() { return P(); },
  async load(bytes) {
    if (!bytes.length) return { state: blank(), unsupported: [] };
    const { pres, unsupported } = await window.OfficePptx.readPptx(bytes);
    return { state: pres, unsupported };
  },
  save: (pres) => window.OfficePptx.writePptx(pres),
  get formats() { return [{ label: "PowerPoint (.pptx)", ext: "pptx", make: (pres) => window.OfficePptx.writePptx(pres) }]; },
  mount,
  blank,
};
window.OfficeSlides = { slideNode, shapePath };
})();
