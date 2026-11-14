// PowerPoint files (.pptx) for the presentation editor: reading slides (with what they take from their layout, master
// and theme worked out: positions, fonts, sizes, colours, bullets, backgrounds, the master's own shapes) into the
// editor's model (pres-model.js), and writing that back as an ordinary .pptx with one master and layout. What it can't
// keep (tables and charts in slides, SmartArt, video, animations, transitions…) is listed in `unsupported`, so the
// editor can offer to edit a copy instead. Works in the browser (window.OfficePptx) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./ooxml.js"), require("./doc-model.js"));
  else root.OfficePptx = factory(root.OfficeFiles, root.OfficeDocModel);
})(typeof self !== "undefined" ? self : this, function (O, D) {
"use strict";

const EMU = 9525; // per pixel (96 per inch)
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const local = (n) => (n || "").replace(/^[^:]*:/, "");
const kids = (el, name) => (el?.children || []).filter((c) => c.name && (name === undefined || local(c.name) === name));
const kid = (el, name) => kids(el, name)[0];
const attr = (el, name) => { if (!el) return undefined; for (const [k, v] of Object.entries(el.attrs || {})) if (local(k) === name) return v; return undefined; };
const textOf = (el) => (el?.children || []).map((c) => (c.text !== undefined ? c.text : textOf(c))).join("");
function deep(el, name, out = []) { for (const c of el?.children || []) if (c.name) { if (local(c.name) === name) out.push(c); deep(c, name, out); } return out; }
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
const resolvePath = (base, rel) => { const out = []; for (const p of (base + rel).split("/")) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); } return out.join("/"); };
function relsOf(files, part) {
  const i = part.lastIndexOf("/");
  const path = part.slice(0, i + 1) + "_rels/" + part.slice(i + 1) + ".rels";
  const map = {};
  if (!files[path]) return map;
  for (const r of kids(O.parseXml(files[path]), "Relationship")) {
    const ext = r.attrs.TargetMode === "External";
    const t = r.attrs.Target || "";
    map[r.attrs.Id] = { target: ext ? t : t.startsWith("/") ? t.slice(1) : resolvePath(part.slice(0, i + 1), t), type: (r.attrs.Type || "").split("/").pop(), external: ext };
  }
  return map;
}
const safeHref = (h) => { const s = String(h ?? "").trim(); return /^(https?:\/\/|mailto:|tel:)/i.test(s) && !/[\u0000-\u001f\u007f]/.test(s) && s.length <= 2000 ? s : null; };
const hex6 = (c) => (c || "#000000").replace("#", "").toUpperCase().padStart(6, "0").slice(-6);

// ------------------------------------------------------------------------------------------------ colours

function rgb(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function toHex([r, g, b]) { return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""); }
function hsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return [h, s, l]; }
function fromHsl([h, s, l]) { if (!s) return [l * 255, l * 255, l * 255]; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]; }
/** A DrawingML colour element (srgbClr, schemeClr, sysClr, prstClr) as #rrggbb, with its tints and shades applied. */
function colorOf(el, theme) {
  if (!el) return null;
  const n = local(el.name);
  let c = null;
  if (n === "srgbClr") c = "#" + (attr(el, "val") || "000000").toLowerCase();
  else if (n === "sysClr") c = "#" + (attr(el, "lastClr") || (attr(el, "val") === "window" ? "ffffff" : "000000")).toLowerCase();
  else if (n === "schemeClr") { const v = attr(el, "val"); c = theme.colors[theme.map[v] || v] || null; }
  else if (n === "prstClr") c = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080", grey: "#808080" }[attr(el, "val")] || "#000000";
  else if (n === "scrgbClr") c = toHex([+attr(el, "r") / 100000 * 255, +attr(el, "g") / 100000 * 255, +attr(el, "b") / 100000 * 255]);
  if (!c || !/^#[0-9a-f]{6}$/.test(c)) return c;
  let x = hsl(rgb(c)), changed = false;
  for (const m of el.children || []) {
    if (!m.name) continue;
    const v = +attr(m, "val") / 100000, mn = local(m.name);
    if (mn === "lumMod") { x[2] *= v; changed = true; } else if (mn === "lumOff") { x[2] += v; changed = true; }
    else if (mn === "tint") { x[2] = x[2] * v + (1 - v); changed = true; } else if (mn === "shade") { x[2] *= v; changed = true; }
  }
  if (changed) { x[2] = Math.max(0, Math.min(1, x[2])); c = toHex(fromHsl(x)); }
  return c;
}
const COLOR_TAGS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"]);
const firstColor = (el, theme) => { const c = (el?.children || []).find((x) => x.name && COLOR_TAGS.has(local(x.name))); return c ? colorOf(c, theme) : null; };
/** A fill: colour, "none", or undefined (not set here). */
function fillOf(spPr, theme) {
  if (!spPr) return undefined;
  if (kid(spPr, "noFill")) return "none";
  const sf = kid(spPr, "solidFill");
  if (sf) return firstColor(sf, theme);
  const gf = kid(spPr, "gradFill");
  if (gf) { const stop = deep(gf, "gs")[0]; return stop ? firstColor(stop, theme) : undefined; }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ reading

/**
 * Reads a .pptx: { pres, unsupported }. Ids come from the file (the editors' own, if they saved it), so everyone who
 * opens it agrees on them.
 */
async function readPptx(bytes) {
  const files = await O.unzip(bytes);
  const unsupported = new Set();
  const presPart = "ppt/presentation.xml";
  if (!files[presPart]) throw new Error("This isn't a PowerPoint presentation the editor can read.");
  const px = O.parseXml(files[presPart]);
  const prels = relsOf(files, presPart);
  const sz = kid(px, "sldSz");
  const size = { w: Math.round(+(attr(sz, "cx") || 12192000) / EMU), h: Math.round(+(attr(sz, "cy") || 6858000) / EMU) };
  if (Object.keys(files).some((n) => /^ppt\/comments\//.test(n) || /^ppt\/commentAuthors/.test(n))) unsupported.add("PowerPoint comments");
  if (files["ppt/vbaProject.bin"]) unsupported.add("macros");
  const parts = {};
  const part = (path) => (parts[path] ??= files[path] ? O.parseXml(files[path]) : null);
  const media = (rels, rid) => {
    const r = rels[rid];
    if (!r || r.external || !files[r.target]) return null;
    const ext = r.target.split(".").pop().toLowerCase();
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" }[ext];
    if (!mime) { unsupported.add("pictures in formats other than PNG, JPEG and GIF"); return null; }
    const b = files[r.target];
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:${mime};base64,` + (typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64"));
  };
  // Theme (colours, fonts) and master, for what slides take from them.
  const themeOf = (masterPath) => {
    const mr = relsOf(files, masterPath);
    const tp = Object.values(mr).find((r) => r.type === "theme")?.target;
    const t = tp && part(tp);
    const colors = {};
    const scheme = t && deep(t, "clrScheme")[0];
    for (const c of kids(scheme)) { const v = kid(c, "srgbClr") || kid(c, "sysClr"); if (v) colors[local(c.name)] = colorOf(v, { colors: {}, map: {} }); }
    const fonts = t && deep(t, "fontScheme")[0];
    const major = attr(kid(kid(fonts, "majorFont"), "latin"), "typeface") || "Calibri Light", minor = attr(kid(kid(fonts, "minorFont"), "latin"), "typeface") || "Calibri";
    const m = part(masterPath);
    const map = { ...(kid(m, "clrMap")?.attrs || {}) };
    return { colors, map, major, minor };
  };
  /** Placeholder shapes of a layout or master, by type and by idx. */
  const placeholders = (x) => {
    const byType = {}, byIdx = {};
    for (const sp of deep(kid(kid(x, "cSld"), "spTree"), "sp")) {
      const ph = deep(kid(sp, "nvSpPr"), "ph")[0];
      if (!ph) continue;
      const type = attr(ph, "type") || "body";
      byType[type] ??= sp;
      if (attr(ph, "idx") !== undefined) byIdx[attr(ph, "idx")] ??= sp;
    }
    return { byType, byIdx };
  };
  const phKind = (type) => (type === "title" || type === "ctrTitle" ? "title" : type === "subTitle" ? "subtitle" : type === "body" || type === "obj" ? "body" : type);
  const findPh = (src, type, idx) => (idx !== undefined && src.byIdx[idx]) || src.byType[type] || (type === "ctrTitle" && src.byType.title) || (type === "subTitle" && src.byType.body) || (type === "obj" && src.byType.body) || null;

  // Paragraph level properties (lvlNpPr) from a list style: alignment, bullets, run defaults.
  const lvlProps = (lst, lvl, theme) => {
    const p = kid(lst, `lvl${lvl + 1}pPr`);
    if (!p) return {};
    const o = {};
    const algn = attr(p, "algn"); if (algn) o.align = algn;
    if (kid(p, "buNone")) o.bullet = "none"; else if (kid(p, "buAutoNum")) o.bullet = "number"; else if (kid(p, "buChar")) o.bullet = "bullet";
    const d = kid(p, "defRPr");
    if (d) Object.assign(o, runProps(d, theme));
    return o;
  };
  const runProps = (rPr, theme) => {
    const o = {};
    if (!rPr) return o;
    const sz = attr(rPr, "sz"); if (sz) o.size = +sz / 100;
    for (const [k, a] of [["b", "b"], ["i", "i"]]) { const v = attr(rPr, a); if (v !== undefined) o[k] = v === "1" || v === "true"; }
    const u = attr(rPr, "u"); if (u !== undefined) o.u = u !== "none";
    const st = attr(rPr, "strike"); if (st !== undefined) o.s = st !== "noStrike";
    const base = attr(rPr, "baseline"); if (base) { if (+base > 0) o.sup = true; else if (+base < 0) o.sub = true; }
    const fill = kid(rPr, "solidFill"); if (fill) { const c = firstColor(fill, theme); if (c) o.color = c; }
    const hl = kid(rPr, "highlight"); if (hl) { const c = firstColor(hl, theme); if (c) o.bg = c; }
    const lat = attr(kid(rPr, "latin"), "typeface");
    if (lat) o.font = lat === "+mj-lt" ? theme.major : lat === "+mn-lt" ? theme.minor : lat;
    return o;
  };

  const slides = [];
  const sldIds = kids(kid(px, "sldIdLst"), "sldId");
  for (const [si, sid] of sldIds.entries()) {
    const rid = Object.entries(sid.attrs || {}).find(([k]) => /:id$/.test(k))?.[1];
    const path = prels[rid]?.target;
    const sx = path && part(path);
    if (!sx) continue;
    const srels = relsOf(files, path);
    const layoutPath = Object.values(srels).find((r) => r.type === "slideLayout")?.target;
    const lx = layoutPath ? part(layoutPath) : null;
    const lrels = layoutPath ? relsOf(files, layoutPath) : {};
    const masterPath = Object.values(lrels).find((r) => r.type === "slideMaster")?.target;
    const mx = masterPath ? part(masterPath) : null;
    const mrels = masterPath ? relsOf(files, masterPath) : {};
    const theme = masterPath ? themeOf(masterPath) : { colors: {}, map: {}, major: "Calibri Light", minor: "Calibri" };
    const lph = lx ? placeholders(lx) : { byType: {}, byIdx: {} }, mph = mx ? placeholders(mx) : { byType: {}, byIdx: {} };
    const txStyles = kid(mx, "txStyles");
    if (kid(sx, "timing") && deep(kid(sx, "timing"), "par").length) unsupported.add("animations");
    // An empty transition element (LibreOffice writes one) is no transition.
    if (deep(sx, "transition").some((t) => kids(t).length || attr(t, "advTm"))) unsupported.add("slide transitions");
    const slide = { id: `s${si + 1}`, els: [] };
    if (attr(sx, "show") === "0") slide.hidden = true;
    // Background: the slide's, else its layout's, else the master's.
    for (const x of [sx, lx, mx]) {
      const bg = kid(kid(x, "cSld"), "bg");
      if (!bg) continue;
      const bgPr = kid(bg, "bgPr"), ref = kid(bg, "bgRef");
      const rels = x === sx ? srels : x === lx ? lrels : mrels;
      const blip = bgPr && deep(kid(bgPr, "blipFill"), "blip")[0];
      if (blip) { const src = media(rels, attr(blip, "embed")); if (src) slide.els.push({ id: "", type: "img", x: 0, y: 0, w: size.w, h: size.h, src, alt: "", bgImage: true }); }
      const c = bgPr ? fillOf(bgPr, theme) : ref ? firstColor(ref, theme) : null;
      if (c && c !== "none") slide.bg = c;
      break;
    }
    if (!slide.bg) slide.bg = theme.colors[theme.map.bg1 || "lt1"] || "#ffffff";
    const ink = theme.colors[theme.map.tx1 || "dk1"] || "#000000";

    // Shapes: from the master and layout first (unless the slide or layout hides them), then the slide's own.
    const trees = [];
    if (kid(sx, "cSld") && attr(sx, "showMasterSp") !== "0") {
      if (lx && attr(lx, "showMasterSp") !== "0" && mx) trees.push([mx, mrels, "master"]);
      if (lx) trees.push([lx, lrels, "layout"]);
    }
    trees.push([sx, srels, "slide"]);
    for (const [x, rels, from] of trees) {
      const walk = (tree, tf) => {
        for (const c of kids(tree)) {
          const n = local(c.name);
          if (n === "sp" || n === "cxnSp" || n === "pic") {
            const isPh = !!deep(kid(c, n === "pic" ? "nvPicPr" : n === "cxnSp" ? "nvCxnSpPr" : "nvSpPr"), "ph")[0];
            if (from !== "slide" && isPh) continue; // placeholders on masters and layouts are only prompts
            const el = shape(c, n, rels, tf, from);
            if (el) slide.els.push(el);
          } else if (n === "grpSp") {
            const xf = kid(kid(c, "grpSpPr"), "xfrm");
            if (attr(xf, "rot") && +attr(xf, "rot")) unsupported.add("rotated groups of shapes");
            const off = kid(xf, "off"), ext = kid(xf, "ext"), choff = kid(xf, "chOff"), chext = kid(xf, "chExt");
            const sx2 = ext && chext && +chext.attrs.cx ? +ext.attrs.cx / +chext.attrs.cx : 1, sy2 = ext && chext && +chext.attrs.cy ? +ext.attrs.cy / +chext.attrs.cy : 1;
            const inner = { ox: +(off?.attrs.x || 0), oy: +(off?.attrs.y || 0), cx: +(choff?.attrs.x || 0), cy: +(choff?.attrs.y || 0), sx: sx2, sy: sy2 };
            walk(c, (X, Y, W, H) => tf(inner.ox + (X - inner.cx) * inner.sx, inner.oy + (Y - inner.cy) * inner.sy, W * inner.sx, H * inner.sy));
          } else if (n === "graphicFrame") {
            const uri = attr(deep(c, "graphicData")[0], "uri") || "";
            unsupported.add(/table/.test(uri) ? "tables in slides" : /chart/.test(uri) ? "charts in slides" : /diagram/.test(uri) ? "SmartArt" : "embedded objects");
          } else if (n === "contentPart" || n === "AlternateContent") unsupported.add("ink and other objects");
        }
      };
      walk(kid(kid(x, "cSld"), "spTree"), (X, Y, W, H) => [X, Y, W, H]);
    }
    function shape(c, n, rels, tf, from) {
      const nv = kid(c, n === "pic" ? "nvPicPr" : n === "cxnSp" ? "nvCxnSpPr" : "nvSpPr");
      const ph = deep(nv, "ph")[0];
      const phType = ph ? attr(ph, "type") || "body" : null, phIdx = ph ? attr(ph, "idx") : undefined;
      const lsp = ph ? findPh(lph, phType, phIdx) : null, msp = ph ? findPh(mph, phType, phIdx) : null;
      const spPr = kid(c, "spPr");
      if (deep(nv, "videoFile").length || deep(nv, "audioFile").length || deep(nv, "media").length) unsupported.add("videos and sounds");
      // Position: its own, else its placeholder's on the layout, else on the master.
      const xfrm = kid(spPr, "xfrm") || kid(kid(lsp, "spPr"), "xfrm") || kid(kid(msp, "spPr"), "xfrm");
      const off = kid(xfrm, "off"), ext = kid(xfrm, "ext");
      if (!off || !ext) return null;
      const [X, Y, W, H] = tf(+off.attrs.x, +off.attrs.y, +ext.attrs.cx, +ext.attrs.cy);
      const el = { id: "", x: Math.round(X / EMU), y: Math.round(Y / EMU), w: Math.max(0, Math.round(W / EMU)), h: Math.max(0, Math.round(H / EMU)) };
      if (from !== "slide") el.from = from;
      const rot = +(attr(xfrm, "rot") || 0) / 60000; if (rot) el.rot = Math.round(rot * 100) / 100;
      if (attr(xfrm, "flipH") === "1") el.flipH = true;
      if (attr(xfrm, "flipV") === "1") el.flipV = true;
      const cNvPr = kid(nv, "cNvPr");
      if (n === "pic") {
        const blip = deep(kid(c, "blipFill"), "blip")[0];
        const src = blip && media(rels, attr(blip, "embed"));
        if (!src) return null;
        if (deep(kid(c, "blipFill"), "srcRect").some((r) => ["l", "t", "r", "b"].some((k) => +(r.attrs[k] || 0)))) unsupported.add("cropped pictures");
        return { ...el, type: "img", src, alt: attr(cNvPr, "descr") || "" };
      }
      const style = kid(c, "style");
      const prst = attr(kid(spPr, "prstGeom"), "prst") || (kid(spPr, "custGeom") ? (unsupported.add("freeform shapes"), "rect") : "rect");
      let fill = fillOf(spPr, theme);
      if (fill === undefined && style) fill = firstColor(kid(style, "fillRef"), theme) || undefined;
      if (fill === undefined && ph) fill = fillOf(kid(lsp, "spPr"), theme) ?? fillOf(kid(msp, "spPr"), theme);
      const ln = kid(spPr, "ln");
      let line = null;
      if (ln && !kid(ln, "noFill")) { const lc = firstColor(kid(ln, "solidFill"), theme) || (style && firstColor(kid(style, "lnRef"), theme)) || ink; line = { color: lc, w: Math.max(0.5, Math.round((+(attr(ln, "w") || 12700) / EMU) * 4) / 4) }; if (kid(ln, "tailEnd") && attr(kid(ln, "tailEnd"), "type") !== "none") line.end = "arrow"; if (kid(ln, "headEnd") && attr(kid(ln, "headEnd"), "type") !== "none") line.start = "arrow"; }
      else if (!ln && style && n !== "sp") { const lc = firstColor(kid(style, "lnRef"), theme); if (lc) line = { color: lc, w: 1 }; }
      else if (!ln && style && attr(kid(style, "lnRef"), "idx") !== "0") { const lc = firstColor(kid(style, "lnRef"), theme); if (lc) line = { color: lc, w: 1 }; }
      if (n === "cxnSp" || prst === "line" || prst === "straightConnector1" || /Connector/.test(prst)) {
        if (!/^(line|straightConnector1)$/.test(prst)) unsupported.add("bent and curved connectors");
        return { ...el, type: "shape", shape: "line", line: line || { color: ink, w: 1 } };
      }
      const tx = kid(c, "txBody");
      const isText = !!kid(kid(c, "nvSpPr"), "cNvSpPr") && attr(kid(kid(c, "nvSpPr"), "cNvSpPr"), "txBox") === "1";
      const out = { ...el, type: ph || isText || (prst === "rect" && (fill === undefined || fill === "none") && !line && tx) ? "text" : "shape" };
      if (out.type === "shape") out.shape = prst;
      if (fill && fill !== "none") out.fill = fill;
      if (line) out.line = line;
      if (ph) out.ph = phKind(phType);
      // Text: its paragraphs, with what each takes from the placeholder and master styles.
      const bodyPr = kid(tx, "bodyPr") || kid(kid(lsp, "txBody"), "bodyPr") || kid(kid(msp, "txBody"), "bodyPr");
      const anchor = attr(kid(tx, "bodyPr"), "anchor") || attr(kid(kid(lsp, "txBody"), "bodyPr"), "anchor") || attr(kid(kid(msp, "txBody"), "bodyPr"), "anchor") || (out.type === "shape" ? "ctr" : "t");
      if (anchor !== "t" && (tx || out.type === "text")) out.anchor = anchor === "ctr" ? "ctr" : anchor === "b" ? "b" : "t";
      if (attr(kid(tx, "bodyPr"), "vert") && attr(kid(tx, "bodyPr"), "vert") !== "horz") unsupported.add("vertical text");
      const scale = +(attr(kid(bodyPr, "normAutofit"), "fontScale") || 100000) / 100000;
      const master = !ph ? kid(txStyles, "otherStyle") : phType === "title" || phType === "ctrTitle" ? kid(txStyles, "titleStyle") : ["body", "obj", "subTitle"].includes(phType) || !["dt", "ftr", "sldNum"].includes(phType) ? kid(txStyles, "bodyStyle") : kid(txStyles, "otherStyle");
      const lists = [master, kid(kid(msp, "txBody"), "lstStyle"), kid(kid(lsp, "txBody"), "lstStyle"), kid(tx, "lstStyle")];
      const blocks = [];
      for (const p of kids(tx, "p")) {
        const pPr = kid(p, "pPr");
        const lvl = Math.min(8, +(attr(pPr, "lvl") || 0));
        const eff = { size: 18, color: ink, font: theme.minor };
        if (ph && (phType === "title" || phType === "ctrTitle")) eff.font = theme.major;
        for (const l of lists) Object.assign(eff, lvlProps(l, lvl, theme));
        const local2 = {};
        const algn = attr(pPr, "algn"); if (algn) local2.align = algn;
        if (kid(pPr, "buNone")) local2.bullet = "none"; else if (kid(pPr, "buAutoNum")) local2.bullet = "number"; else if (kid(pPr, "buChar")) local2.bullet = "bullet";
        Object.assign(eff, local2, runProps(kid(pPr, "defRPr"), theme));
        const block = { id: "", type: "p", runs: [] };
        const align = { ctr: "center", r: "right", just: "justify", dist: "justify" }[eff.align];
        if (align) block.align = align;
        if (eff.bullet === "bullet" || eff.bullet === "number") block.list = { kind: eff.bullet, level: lvl };
        const runBase = (rPr) => {
          const r = { ...eff, ...runProps(rPr, theme) };
          const out2 = {};
          for (const k of ["b", "i", "u", "s", "sup", "sub", "color", "bg", "font"]) if (r[k]) out2[k] = r[k];
          if (out2.color === "#000000") delete out2.color; // the editor's own default
          if (out2.font && (out2.font === theme.minor || out2.font === theme.major) && /^Calibri/.test(out2.font)) delete out2.font; // the editor's own default
          out2.size = Math.round(r.size * scale * 2) / 2;
          const link = kid(rPr, "hlinkClick"); if (link) { const h = safeHref(rels[attr(link, "id")]?.target); if (h) out2.href = h; }
          return out2;
        };
        for (const r of kids(p)) {
          const rn = local(r.name);
          if (rn === "r") block.runs.push({ text: textOf(kid(r, "t")), ...runBase(kid(r, "rPr")) });
          else if (rn === "br") block.runs.push({ text: "\n", ...runBase(kid(r, "rPr")) });
          else if (rn === "fld") { unsupported.add("slide numbers and dates that update"); block.runs.push({ text: textOf(kid(r, "t")), ...runBase(kid(r, "rPr")) }); }
        }
        block.runs = O.merge(block.runs);
        // What typing in it starts with (and an empty paragraph's height).
        block.def = { size: Math.round(eff.size * scale * 2) / 2 };
        for (const k of ["b", "i", "color", "font"]) if (eff[k] && !(k === "font" && /^Calibri/.test(eff[k]))) block.def[k] = eff[k];
        blocks.push(block);
      }
      if (tx || out.type === "text") out.blocks = blocks.length ? blocks : [{ id: "", type: "p", runs: [] }];
      if (ph && out.blocks && !out.blocks.some((b) => b.runs.length)) out.blocks[0].hint = { title: "Click to add a title", subtitle: "Click to add a subtitle" }[out.ph] || "Click to add text";
      return out;
    }
    // Speaker notes.
    const notesPath = Object.values(srels).find((r) => r.type === "notesSlide")?.target;
    const nx = notesPath && part(notesPath);
    if (nx) {
      const body = deep(nx, "sp").find((sp) => { const ph = deep(sp, "ph")[0]; return ph && (attr(ph, "type") || "body") === "body"; });
      const text = body ? kids(kid(body, "txBody"), "p").map((p) => kids(p).map((r) => (local(r.name) === "br" ? "\n" : local(r.name) === "r" || local(r.name) === "fld" ? textOf(kid(r, "t")) : "")).join("")).join("\n").trim() : "";
      if (text) slide.notes = text;
    }
    slides.push(slide);
  }
  if (!slides.length) slides.push({ id: "s1", bg: "#ffffff", els: [] });
  // Ids: the editors' own if they saved this file (so everyone editing agrees), else made from positions.
  let saved = null;
  try { saved = JSON.parse(readCustomProp(files, "WebmailPresIds") || "null"); } catch { saved = null; }
  const match = Array.isArray(saved) && saved.length === slides.length && saved.every((s, i) => Array.isArray(s?.[1]) && s[1].length === slides[i].els.length && s[1].every((e, j) => (e[1] || []).length === (slides[i].els[j].blocks || []).length));
  slides.forEach((s, i) => {
    if (match) s.id = String(saved[i][0]);
    s.els.forEach((e, j) => {
      e.id = match ? String(saved[i][1][j][0]) : `${s.id}e${j + 1}`;
      (e.blocks || []).forEach((b, k) => { b.id = match ? String(saved[i][1][j][1][k]) : `${e.id}p${k + 1}`; });
    });
  });
  return { pres: { size, slides }, unsupported: [...unsupported] };
}
function readCustomProp(files, name) {
  if (!files["docProps/custom.xml"]) return null;
  for (const p of kids(O.parseXml(files["docProps/custom.xml"]), "property")) if (p.attrs.name === name) return textOf(p);
  return null;
}

// ------------------------------------------------------------------------------------------------ writing

const SOLID = (c) => `<a:solidFill><a:srgbClr val="${hex6(c)}"/></a:solidFill>`;
const THEME_XML = (name, major, minor) => XML_HEAD + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="${esc(major)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${esc(minor)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const lvls = (sz, bullets = false) => Array.from({ length: 9 }, (_, i) => `<a:lvl${i + 1}pPr marL="${bullets ? 228600 + i * 457200 : 0}" indent="${bullets ? -228600 : 0}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${bullets ? 1000 : 0}"/></a:spcBef><a:buNone/><a:defRPr sz="${typeof sz === "number" ? sz : sz[i] || sz[sz.length - 1]}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`).join("");
const xfrm = (x, y, w, h, extra = "") => `<a:xfrm${extra}><a:off x="${Math.round(x * EMU)}" y="${Math.round(y * EMU)}"/><a:ext cx="${Math.round(Math.max(0, w) * EMU)}" cy="${Math.round(Math.max(0, h) * EMU)}"/></a:xfrm>`;

/** Writes a presentation ({ size, slides }) as a .pptx Blob. */
async function writePptx(pres) {
  const files = {};
  const types = [];
  const { w: SW, h: SH } = pres.size || { w: 1280, h: 720 };
  const ids = [];
  let mediaN = 0;
  const mediaExt = new Set();
  const hasNotes = pres.slides.some((s) => (s.notes || "").trim());
  pres.slides.forEach((s, i) => {
    const n = i + 1;
    const rels = [['rId1', "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    const rel = (type, target, external = false) => { const id = `rId${rels.length + 1}`; rels.push([id, type, target, external]); return id; };
    let shapeId = 1, phIdx = 0;
    const elIds = [];
    const runXml = (r, defSize) => {
      const href = safeHref(r.href);
      const rPr = `<a:rPr lang="en-GB" sz="${Math.round((r.size || defSize || 18) * 100)}"${r.b ? ' b="1"' : ""}${r.i ? ' i="1"' : ""}${r.u ? ' u="sng"' : ""}${r.s ? ' strike="sngStrike"' : ""}${r.sup ? ' baseline="30000"' : r.sub ? ' baseline="-25000"' : ""} dirty="0">${r.color ? SOLID(r.color) : ""}${r.bg ? `<a:highlight><a:srgbClr val="${hex6(r.bg)}"/></a:highlight>` : ""}${r.font ? `<a:latin typeface="${esc(r.font)}"/><a:cs typeface="${esc(r.font)}"/>` : ""}${href ? `<a:hlinkClick r:id="${rel("hyperlink", href, true)}"/>` : ""}</a:rPr>`;
      return r.text.split("\n").map((t, k) => (k ? `<a:br>${rPr}</a:br>` : "") + (t ? `<a:r>${rPr}<a:t>${esc(t)}</a:t></a:r>` : "")).join("");
    };
    const paraXml = (b, defSize) => {
      const lvl = b.list ? Math.min(8, b.list.level || 0) : 0;
      const algn = { center: "ctr", right: "r", justify: "just" }[b.align];
      const bullet = b.list ? (b.list.kind === "number" ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : '<a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="•"/>') : "<a:buNone/>";
      const pPr = `<a:pPr${b.list ? ` marL="${228600 + lvl * 457200}" lvl="${lvl}" indent="-228600"` : ' marL="0" indent="0"'}${algn ? ` algn="${algn}"` : ""}>${bullet}</a:pPr>`;
      const size = b.runs?.find((r) => r.size)?.size || b.def?.size || defSize || 18;
      return `<a:p>${pPr}${(b.runs || []).filter((r) => !r.fn).map((r) => runXml(r, defSize)).join("")}<a:endParaRPr lang="en-GB" sz="${Math.round(size * 100)}" dirty="0"/></a:p>`;
    };
    const txBody = (e) => `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${e.anchor === "ctr" ? "ctr" : e.anchor === "b" ? "b" : "t"}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${(e.blocks?.length ? e.blocks : [{ runs: [] }]).map((b) => paraXml(b, e.ph === "title" ? 36 : 18)).join("")}</p:txBody>`;
    const lineXml = (l) => (l ? `<a:ln w="${Math.round((l.w || 1) * EMU)}">${SOLID(l.color || "#000000")}${l.start === "arrow" ? '<a:headEnd type="triangle"/>' : ""}${l.end === "arrow" ? '<a:tailEnd type="triangle"/>' : ""}</a:ln>` : "<a:ln><a:noFill/></a:ln>");
    const xf = (e) => xfrm(e.x, e.y, e.w, e.h, `${e.rot ? ` rot="${Math.round(e.rot * 60000)}"` : ""}${e.flipH ? ' flipH="1"' : ""}${e.flipV ? ' flipV="1"' : ""}`);
    const body = s.els.map((e) => {
      const id = ++shapeId;
      elIds.push([e.id, (e.blocks || []).map((b) => b.id)]);
      const name = esc(e.type === "img" ? `Picture ${id}` : e.ph === "title" ? `Title ${id}` : e.type === "text" ? `TextBox ${id}` : `Shape ${id}`);
      if (e.type === "img") {
        const m = /^data:(image\/(png|jpeg|gif|webp|bmp));base64,(.+)$/.exec(e.src || "");
        if (!m) return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>`;
        const ext = m[2] === "jpeg" ? "jpg" : m[2];
        const fileName = `image${++mediaN}.${ext}`;
        mediaExt.add(ext);
        files[`ppt/media/${fileName}`] = typeof atob === "function" ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(m[3], "base64"));
        const rid = rel("image", `../media/${fileName}`);
        return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="${esc(e.alt || "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xf(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
      }
      if (e.type === "shape" && e.shape === "line") {
        return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xf(e)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${lineXml(e.line || { color: "#000000", w: 1 })}</p:spPr></p:cxnSp>`;
      }
      const ph = e.ph === "title" ? '<p:ph type="title"/>' : e.ph === "body" ? `<p:ph idx="${++phIdx}"/>` : e.ph === "subtitle" ? `<p:ph type="subTitle" idx="${++phIdx}"/>` : "";
      const geom = e.type === "shape" ? e.shape || "rect" : "rect";
      const fill = e.fill ? SOLID(e.fill) : "<a:noFill/>";
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${e.type === "text" && !ph ? ' txBox="1"' : ""}>${ph ? '<a:spLocks noGrp="1"/>' : ""}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xf(e)}<a:prstGeom prst="${esc(geom)}"><a:avLst/></a:prstGeom>${fill}${lineXml(e.line)}</p:spPr>${e.type === "text" || e.blocks?.length ? txBody(e) : ""}</p:sp>`;
    }).join("");
    ids.push([s.id, elIds]);
    const bg = s.bg ? `<p:bg><p:bgPr>${SOLID(s.bg)}<a:effectLst/></p:bgPr></p:bg>` : "";
    files[`ppt/slides/slide${n}.xml`] = XML_HEAD + `<p:sld ${NS}${s.hidden ? ' show="0"' : ""}><p:cSld>${bg}<p:spTree>${GRP}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    types.push([`/ppt/slides/slide${n}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);
    if ((s.notes || "").trim()) {
      rel("notesSlide", `../notesSlides/notesSlide${n}.xml`);
      const paras = String(s.notes).split("\n").map((t) => `<a:p>${t ? `<a:r><a:rPr lang="en-GB" dirty="0"/><a:t>${esc(t)}</a:t></a:r>` : ""}</a:p>`).join("");
      files[`ppt/notesSlides/notesSlide${n}.xml`] = XML_HEAD + `<p:notes ${NS}><p:cSld><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
      files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n}.xml"/></Relationships>`;
      types.push([`/ppt/notesSlides/notesSlide${n}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"]);
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${ext ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  });
  // One master and one layout (title and content); everything on the slides says its own position and look.
  const m = Math.round(SW * 0.065);
  const titleSp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(m, SH * 0.06, SW - 2 * m, SH * 0.16)}</p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>`;
  const bodySp = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(m, SH * 0.26, SW - 2 * m, SH * 0.64)}</p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>`;
  files["ppt/slideMasters/slideMaster1.xml"] = XML_HEAD + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${titleSp}${bodySp}</p:spTree></p:cSld>${CLRMAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${lvls([2800, 2400, 2000, 1800, 1800], true)}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-GB"/></a:defPPr>${lvls(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`;
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
  files["ppt/slideLayouts/slideLayout1.xml"] = XML_HEAD + `<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  files["ppt/theme/theme1.xml"] = THEME_XML("Office Theme", "Calibri Light", "Calibri");
  const presRels = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ...pres.slides.map((_, i) => [`rId${i + 10}`, "slide", `slides/slide${i + 1}.xml`]), ["rId2", "theme", "theme/theme1.xml"], ["rId3", "presProps", "presProps.xml"], ["rId4", "viewProps", "viewProps.xml"], ["rId5", "tableStyles", "tableStyles.xml"]];
  if (hasNotes) {
    presRels.push(["rId6", "notesMaster", "notesMasters/notesMaster1.xml"]);
    files["ppt/notesMasters/notesMaster1.xml"] = XML_HEAD + `<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>${CLRMAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
    files["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/></Relationships>`;
    files["ppt/theme/theme2.xml"] = THEME_XML("Notes Theme", "Calibri Light", "Calibri");
    types.push(["/ppt/notesMasters/notesMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"], ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"]);
  }
  files["ppt/presentation.xml"] = XML_HEAD + `<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : ""}<p:sldIdLst>${pres.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${Math.round(SW * EMU)}" cy="${Math.round(SH * EMU)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-GB"/></a:defPPr>${lvls(1800)}</p:defaultTextStyle></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;
  files["ppt/presProps.xml"] = XML_HEAD + `<p:presentationPr ${NS}/>`;
  files["ppt/viewProps.xml"] = XML_HEAD + `<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`;
  files["ppt/tableStyles.xml"] = XML_HEAD + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>';
  files["_rels/.rels"] = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>';
  files["docProps/core.xml"] = XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:modified></cp:coreProperties>`;
  files["docProps/custom.xml"] = XML_HEAD + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="WebmailPresIds"><vt:lpwstr>${esc(JSON.stringify(ids))}</vt:lpwstr></property></Properties>`;
  const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  files["[Content_Types].xml"] = XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaExt].map((e) => `<Default Extension="${e}" ContentType="${MIME[e]}"/>`).join("")}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>${types.map(([n, t]) => `<Override PartName="${n}" ContentType="${t}"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`;
  return O.zip(files);
}

return { readPptx, writePptx, EMU };
});
