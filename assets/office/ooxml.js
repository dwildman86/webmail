// Reading and writing Office files for the editors, with no libraries: zip (the browser's own deflate), a small XML
// reader, Word (.docx), Excel (.xlsx) and CSV. Only what the editors support is read; anything else found (tracked
// changes, macros, charts, pivot tables…) is listed in `unsupported`, so the editor can offer to edit a copy instead
// of losing it. Works in the browser (window.OfficeFiles) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./formula.js"));
  else root.OfficeFiles = factory(root.OfficeFormula);
})(typeof self !== "undefined" ? self : this, function (F) {
"use strict";

const enc = new TextEncoder(), dec = new TextDecoder();
/** Limits, so a hostile file can't hang the browser: total unzipped size and number of parts. */
const MAX_UNZIPPED = 300 * 1024 * 1024, MAX_PARTS = 5000;

// ------------------------------------------------------------------------------------------------ zip

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
/** A zip's files: { "word/document.xml": Uint8Array, … }. */
async function unzip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This isn't a valid Office file (it isn't a zip).");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > MAX_PARTS) throw new Error("This file has too many parts to open.");
  const files = {};
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("This Office file is damaged.");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    total += usize;
    if (total > MAX_UNZIPPED) throw new Error("This file is too big to open here.");
    const lnlen = dv.getUint16(off + 26, true), lxlen = dv.getUint16(off + 28, true);
    const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = await pipe(data, new DecompressionStream("deflate-raw"));
    else throw new Error("This file uses compression the editor doesn't know.");
  }
  return files;
}
/** A zip from { name: Uint8Array|string }, deflated. */
async function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const nameB = enc.encode(name);
    const deflated = raw.length > 64 ? await pipe(raw, new CompressionStream("deflate-raw")) : null;
    const [method, data] = deflated && deflated.length < raw.length ? [8, deflated] : [0, raw];
    const crc = crc32(raw);
    const head = new Uint8Array(30 + nameB.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true); hv.setUint16(8, method, true);
    hv.setUint16(10, dosTime, true); hv.setUint16(12, dosDate, true); hv.setUint32(14, crc, true); hv.setUint32(18, data.length, true); hv.setUint32(22, raw.length, true);
    hv.setUint16(26, nameB.length, true); head.set(nameB, 30);
    const cen = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true); cen.set(nameB, 46);
    parts.push(head, data); central.push(cen);
    offset += head.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// ------------------------------------------------------------------------------------------------ XML

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
/** XML into { name, attrs, children, text }. Entities beyond the five standard ones are never expanded. */
function parseXml(src) {
  const s = typeof src === "string" ? src : dec.decode(src);
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push({ text: m[1] });
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) attrs[a[1]] = unent(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && m[6].trim() !== "" || (m[6] && stack.length > 1)) top.children.push({ text: unent(m[6]) });
  }
  return root.children.find((c) => c.name) || root;
}
const local = (n) => (n || "").replace(/^[^:]*:/, "");
const kids = (el, name) => (el?.children || []).filter((c) => c.name && (name === undefined || local(c.name) === name));
const kid = (el, name) => kids(el, name)[0];
const textOf = (el) => (el?.children || []).map((c) => (c.text !== undefined ? c.text : textOf(c))).join("");
const attr = (el, name) => { if (!el) return undefined; for (const [k, v] of Object.entries(el.attrs)) if (local(k) === name) return v; return undefined; };
/** All elements named $name under $el, in document order. */
function deep(el, name, out = []) { for (const c of el?.children || []) if (c.name) { if (local(c.name) === name) out.push(c); deep(c, name, out); } return out; }
const relsOf = (files, part) => {
  const i = part.lastIndexOf("/");
  const relPath = part.slice(0, i + 1) + "_rels/" + part.slice(i + 1) + ".rels";
  const map = {};
  if (!files[relPath]) return map;
  for (const r of kids(parseXml(files[relPath]), "Relationship")) {
    let t = r.attrs.Target;
    if (r.attrs.TargetMode !== "External") t = t.startsWith("/") ? t.slice(1) : resolve(part.slice(0, i + 1), t);
    map[r.attrs.Id] = { target: t, type: (r.attrs.Type || "").split("/").pop(), external: r.attrs.TargetMode === "External" };
  }
  return map;
};
const resolve = (base, rel) => { const parts = (base + rel).split("/"); const out = []; for (const p of parts) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); } return out.join("/"); };
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ------------------------------------------------------------------------------------------------ colours

const THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080"];
const color = (el) => { if (!el) return null; const rgb = attr(el, "rgb") || attr(el, "val"); if (rgb && /^[0-9A-F]{6,8}$/i.test(rgb)) return "#" + rgb.slice(-6).toLowerCase(); const th = attr(el, "theme"); if (th !== undefined) return "#" + (THEME[+th] || "000000").toLowerCase(); const ix = attr(el, "indexed"); if (ix !== undefined && INDEXED[+ix]) return "#" + INDEXED[+ix].toLowerCase(); return null; };
const hex = (c) => (c || "#000000").replace("#", "").toUpperCase().padStart(6, "0");

// ------------------------------------------------------------------------------------------------ spreadsheets

/**
 * A workbook: { sheets: [{ id, name, cells: Map<"r,c", cell>, cols: {c: px}, rows: {r: px}, merges: [{r1,c1,r2,c2}], freeze: {r, c} }] }.
 * A cell: { v: number|string|boolean|null, f?: "=formula", s?: style }. A style: { b, i, u, s, color, bg, font, size,
 * h: left|center|right, va: top|middle|bottom, wrap, nf: number format, border: { t, r, b, l } (1 thin, 2 medium, 3 thick) }.
 */
const BUILTIN_NF = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "dd/mm/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
  18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "dd/mm/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@" };
const ref = (a) => { const m = /^([A-Z]+)(\d+)$/i.exec(a); return m ? { r: +m[2] - 1, c: F.colIndex(m[1]) } : null; };

async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const unsupported = new Set();
  if (files["xl/vbaProject.bin"]) unsupported.add("macros");
  if (Object.keys(files).some((n) => n.startsWith("xl/pivotTables/"))) unsupported.add("pivot tables");
  if (Object.keys(files).some((n) => n.startsWith("xl/charts/"))) unsupported.add("charts");
  if (Object.keys(files).some((n) => n.startsWith("xl/drawings/"))) unsupported.add("pictures and shapes");
  const wbXml = parseXml(files["xl/workbook.xml"] || "");
  const rels = relsOf(files, "xl/workbook.xml");
  const strings = files["xl/sharedStrings.xml"] ? kids(parseXml(files["xl/sharedStrings.xml"]), "si").map((si) => deep(si, "t").filter((t) => !deep(si, "rPh").some((ph) => deep(ph, "t").includes(t))).map(textOf).join("")) : [];
  // Styles: each cellXfs entry becomes a style object.
  const st = files["xl/styles.xml"] ? parseXml(files["xl/styles.xml"]) : null;
  const numFmts = { ...BUILTIN_NF };
  for (const n of kids(kid(st, "numFmts"), "numFmt")) numFmts[+n.attrs.numFmtId] = n.attrs.formatCode;
  const fonts = kids(kid(st, "fonts"), "font").map((f) => ({ b: !!kid(f, "b") && attr(kid(f, "b"), "val") !== "0", i: !!kid(f, "i") && attr(kid(f, "i"), "val") !== "0", u: !!kid(f, "u") && attr(kid(f, "u"), "val") !== "none",
    s: !!kid(f, "strike") && attr(kid(f, "strike"), "val") !== "0", color: color(kid(f, "color")), size: kid(f, "sz") ? +attr(kid(f, "sz"), "val") : null, font: attr(kid(f, "name"), "val") || null }));
  const fills = kids(kid(st, "fills"), "fill").map((f) => { const p = kid(f, "patternFill"); return p && attr(p, "patternType") && attr(p, "patternType") !== "none" ? color(kid(p, "fgColor")) : null; });
  const W = { thin: 1, hair: 1, dotted: 1, dashed: 1, medium: 2, mediumDashed: 2, thick: 3, double: 3 };
  const borders = kids(kid(st, "borders"), "border").map((b) => { const o = {}; for (const [k, s] of [["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"]]) { const e = kid(b, s); const w = W[attr(e, "style")]; if (w) o[k] = w; } return Object.keys(o).length ? o : null; });
  const xfs = kids(kid(st, "cellXfs"), "xf").map((x) => {
    const s = {};
    const f = fonts[+(x.attrs.fontId || 0)] || {};
    for (const k of ["b", "i", "u", "s"]) if (f[k]) s[k] = true;
    if (f.color && f.color !== "#000000") s.color = f.color;
    if (f.size && f.size !== 11) s.size = f.size;
    if (f.font && !/^(calibri|aptos( narrow)?)$/i.test(f.font)) s.font = f.font;
    const fill = fills[+(x.attrs.fillId || 0)]; if (fill) s.bg = fill;
    const bd = borders[+(x.attrs.borderId || 0)]; if (bd) s.border = bd;
    const nf = numFmts[+(x.attrs.numFmtId || 0)]; if (nf && nf !== "General") s.nf = nf;
    const al = kid(x, "alignment");
    if (al) { const h = attr(al, "horizontal"); if (["left", "center", "right"].includes(h)) s.h = h; const v = attr(al, "vertical"); if (v === "center") s.va = "middle"; else if (v === "top") s.va = "top"; if (attr(al, "wrapText") === "1" || attr(al, "wrapText") === "true") s.wrap = true; }
    return Object.keys(s).length ? s : null;
  });
  const sheets = [];
  for (const sh of kids(kid(wbXml, "sheets"), "sheet")) {
    const rid = attr(sh, "id");
    const path = rels[rid]?.target;
    if (!path || !files[path]) continue;
    const x = parseXml(files[path]);
    const sheet = { id: "s" + (sheets.length + 1), name: sh.attrs.name, cells: new Map(), cols: {}, rows: {}, merges: [], freeze: null };
    if (sh.attrs.state === "hidden" || sh.attrs.state === "veryHidden") sheet.hidden = true;
    for (const c of kids(kid(x, "cols"), "col")) { if (c.attrs.width) for (let i = +c.attrs.min - 1; i <= Math.min(+c.attrs.max - 1, 300); i++) sheet.cols[i] = Math.round(+c.attrs.width * 7 + 5); }
    const pane = deep(x, "pane")[0];
    if (pane && (pane.attrs.state === "frozen" || pane.attrs.state === "frozenSplit")) sheet.freeze = { r: +(pane.attrs.ySplit || 0), c: +(pane.attrs.xSplit || 0) };
    const shared = {};
    for (const row of kids(kid(x, "sheetData"), "row")) {
      if (row.attrs.ht && row.attrs.customHeight === "1") sheet.rows[+row.attrs.r - 1] = Math.round(+row.attrs.ht * 4 / 3);
      for (const c of kids(row, "c")) {
        const at = ref(c.attrs.r); if (!at) continue;
        const t = c.attrs.t || "n";
        const vEl = kid(c, "v"), fEl = kid(c, "f");
        let v = null;
        const vt = vEl ? textOf(vEl) : null;
        if (t === "s") v = strings[+vt] ?? "";
        else if (t === "inlineStr") v = deep(c, "t").map(textOf).join("");
        else if (t === "b") v = vt === "1";
        else if (t === "e") v = F.ERR[vt] || F.ERR["#VALUE!"];
        else if (t === "str") v = vt ?? "";
        else if (vt !== null && vt !== "") v = +vt;
        const cell = { v };
        if (fEl) {
          let src = textOf(fEl);
          if (fEl.attrs.t === "shared") {
            const si = fEl.attrs.si;
            if (src) shared[si] = { src, r: at.r, c: at.c };
            else if (shared[si]) src = F.shift("=" + shared[si].src, at.r - shared[si].r, at.c - shared[si].c).slice(1);
          }
          if (fEl.attrs.t === "array") unsupported.add("array formulas");
          if (src) cell.f = "=" + src;
        }
        const s = xfs[+(c.attrs.s || 0)];
        if (s) cell.s = s;
        if (cell.v !== null || cell.f || cell.s) sheet.cells.set(`${at.r},${at.c}`, cell);
      }
    }
    for (const m of kids(kid(x, "mergeCells"), "mergeCell")) { const [a, b] = m.attrs.ref.split(":").map(ref); if (a && b) sheet.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c }); }
    if (kid(x, "conditionalFormatting")) unsupported.add("conditional formatting");
    if (kid(x, "dataValidations")) unsupported.add("drop-down lists and data validation");
    if (kid(x, "tableParts")) unsupported.add("Excel tables");
    sheets.push(sheet);
  }
  if (!sheets.length) throw new Error("This spreadsheet has no sheets the editor can read.");
  return { sheets, unsupported: [...unsupported] };
}

async function writeXlsx(wb, values) {
  // values(sheetIndex, r, c) → the calculated value of a formula cell.
  const strings = [], stringIx = new Map();
  const sIx = (s) => { if (!stringIx.has(s)) { stringIx.set(s, strings.length); strings.push(s); } return stringIx.get(s); };
  const numFmts = new Map(); // code → id
  const BUILTIN_IDS = Object.fromEntries(Object.entries(BUILTIN_NF).map(([k, v]) => [v, +k]));
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfIx = new Map([["{}", 0]]);
  const ix = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { list.push(xml); i = list.length - 1; } return i; };
  const BW = { 1: "thin", 2: "medium", 3: "thick" };
  const styleId = (s) => {
    if (!s) return 0;
    const key = JSON.stringify(s);
    if (xfIx.has(key)) return xfIx.get(key);
    const font = `<font>${s.b ? "<b/>" : ""}${s.i ? "<i/>" : ""}${s.s ? "<strike/>" : ""}${s.u ? "<u/>" : ""}<sz val="${s.size || 11}"/>${s.color ? `<color rgb="FF${hex(s.color)}"/>` : ""}<name val="${esc(s.font || "Calibri")}"/></font>`;
    const fontId = ix(fonts, font);
    const fillId = s.bg ? ix(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex(s.bg)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (k, n) => (s.border?.[k] ? `<${n} style="${BW[s.border[k]]}"><color auto="1"/></${n}>` : `<${n}/>`);
    const borderId = s.border ? ix(borders, `<border>${side("l", "left")}${side("r", "right")}${side("t", "top")}${side("b", "bottom")}<diagonal/></border>`) : 0;
    let numFmtId = 0;
    if (s.nf) { numFmtId = BUILTIN_IDS[s.nf] ?? numFmts.get(s.nf); if (numFmtId === undefined) { numFmtId = 164 + numFmts.size; numFmts.set(s.nf, numFmtId); } }
    const al = s.h || s.va || s.wrap ? `<alignment${s.h ? ` horizontal="${s.h}"` : ""}${s.va ? ` vertical="${s.va === "middle" ? "center" : s.va}"` : ""}${s.wrap ? ' wrapText="1"' : ""}/>` : "";
    xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${al ? ' applyAlignment="1">' + al + "</xf>" : "/>"}`);
    xfIx.set(key, xfs.length - 1);
    return xfs.length - 1;
  };
  const out = {};
  const sheetXml = wb.sheets.map((sh, si) => {
    const rows = new Map();
    let maxR = 0, maxC = 0;
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(",").map(Number); if (!rows.has(r)) rows.set(r, []); rows.get(r).push([c, cell]); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
    const body = [...rows.keys()].sort((a, b) => a - b).map((r) => {
      const cells = rows.get(r).sort((a, b) => a[0] - b[0]).map(([c, cell]) => {
        const a = F.addr(r, c), s = styleId(cell.s), sAttr = s ? ` s="${s}"` : "";
        const v = cell.f ? values(si, r, c) : cell.v;
        const f = cell.f ? `<f>${esc(cell.f.slice(1))}</f>` : "";
        if (v === null || v === undefined || v === "") return cell.f ? `<c r="${a}"${sAttr}>${f}</c>` : s ? `<c r="${a}"${sAttr}/>` : "";
        if (typeof v === "number") return `<c r="${a}"${sAttr}>${f}<v>${Number.isFinite(v) ? v : 0}</v></c>`;
        if (typeof v === "boolean") return `<c r="${a}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
        if (F.isErr(v)) return `<c r="${a}"${sAttr} t="e">${f}<v>${v.code === "#CIRC!" ? "#REF!" : v.code}</v></c>`;
        return cell.f ? `<c r="${a}"${sAttr} t="str">${f}<v>${esc(v)}</v></c>` : `<c r="${a}"${sAttr} t="s"><v>${sIx(String(v))}</v></c>`;
      }).join("");
      return `<row r="${r + 1}"${sh.rows[r] ? ` ht="${(sh.rows[r] * 0.75).toFixed(2)}" customHeight="1"` : ""}>${cells}</row>`;
    }).join("");
    const cols = Object.entries(sh.cols || {}).sort((a, b) => a[0] - b[0]).map(([c, px]) => `<col min="${+c + 1}" max="${+c + 1}" width="${Math.max(1, (px - 5) / 7).toFixed(2)}" customWidth="1"/>`).join("");
    const fr = sh.freeze && (sh.freeze.r || sh.freeze.c) ? `<pane${sh.freeze.c ? ` xSplit="${sh.freeze.c}"` : ""}${sh.freeze.r ? ` ySplit="${sh.freeze.r}"` : ""} topLeftCell="${F.addr(sh.freeze.r, sh.freeze.c)}" activePane="${sh.freeze.r && sh.freeze.c ? "bottomRight" : sh.freeze.r ? "bottomLeft" : "topRight"}" state="frozen"/>` : "";
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${F.addr(m.r1, m.c1)}:${F.addr(m.r2, m.c2)}"/>`).join("")}</mergeCells>` : "";
    return XML_HEAD + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${F.addr(maxR, maxC)}"/><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}>${fr}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${body}</sheetData>${merges}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  });
  sheetXml.forEach((x, i) => { out[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  out["xl/sharedStrings.xml"] = XML_HEAD + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  out["xl/styles.xml"] = XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>` : ""}<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  out["xl/workbook.xml"] = XML_HEAD + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  out["xl/_rels/workbook.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wb.sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${wb.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${wb.sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  out["_rels/.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  out["docProps/core.xml"] = coreXml();
  out["[Content_Types].xml"] = XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${wb.sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  return zip(out);
}
const coreXml = () => XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:modified></cp:coreProperties>`;

// ------------------------------------------------------------------------------------------------ CSV

/** CSV (or semicolon/tab separated, worked out from the first line) into rows of strings. */
function readCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const sep = [",", ";", "\t"].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [[]];
  let field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; continue; }
    if (ch === '"' && field === "") q = true;
    else if (ch === sep) { rows[rows.length - 1].push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; rows[rows.length - 1].push(field); field = ""; rows.push([]); }
    else field += ch;
  }
  rows[rows.length - 1].push(field);
  while (rows.length && rows[rows.length - 1].every((f) => f === "")) rows.pop();
  return { rows, sep };
}
function writeCsv(rows, sep = ",") {
  return rows.map((r) => r.map((v) => { const s = v == null ? "" : String(v); return /["\r\n]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(sep)).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------------------------------------ documents

/**
 * A document: { page: { size: "A4"|"Letter", landscape, margins: { t, r, b, l } (mm) }, blocks, header, footer }.
 * Blocks: { id, type: "p", style: normal|title|h1|h2|h3|h4|quote|code, align, indent, list: { kind: bullet|number, level },
 * runs: [{ text, b, i, u, s, sup, sub, color, bg, font, size (pt), href }] }; { id, type: "table", rows: [{ cells: [{ blocks,
 * span, bg }] }], widths }; { id, type: "img", src (data URL), w, h, alt, align }; { id, type: "pagebreak" }; { id, type: "hr" }.
 */
let idSeq = 0;
const newId = () => "b" + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
const STYLE_FROM = { title: "title", subtitle: "h2", "heading 1": "h1", "heading 2": "h2", "heading 3": "h3", "heading 4": "h4", "heading 5": "h4", "heading 6": "h4", quote: "quote", "intense quote": "quote", "html preformatted": "code" };
const TWIP_MM = 1440 / 25.4;

async function readDocx(bytes) {
  const files = await unzip(bytes);
  const unsupported = new Set();
  if (files["word/vbaProject.bin"]) unsupported.add("macros");
  const docPart = "word/document.xml";
  if (!files[docPart]) throw new Error("This isn't a Word document the editor can read.");
  const rels = relsOf(files, docPart);
  const styles = {};
  if (files["word/styles.xml"]) for (const s of kids(parseXml(files["word/styles.xml"]), "style")) { const name = (attr(kid(s, "name"), "val") || "").toLowerCase(); styles[attr(s, "styleId")] = STYLE_FROM[name] || null; }
  const numbering = {};
  if (files["word/numbering.xml"]) {
    const nx = parseXml(files["word/numbering.xml"]);
    const abs = {};
    for (const a of kids(nx, "abstractNum")) abs[attr(a, "abstractNumId")] = Object.fromEntries(kids(a, "lvl").map((l) => [attr(l, "ilvl"), attr(kid(l, "numFmt"), "val")]));
    for (const n of kids(nx, "num")) numbering[attr(n, "numId")] = abs[attr(kid(n, "abstractNumId"), "val")] || {};
  }
  const media = (rid) => { const r = rels[rid]; if (!r || !files[r.target]) return null; const ext = r.target.split(".").pop().toLowerCase(); const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext]; if (!mime) { unsupported.add("pictures in formats other than PNG, JPEG and GIF"); return null; } let s = ""; const b = files[r.target]; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return `data:${mime};base64,` + (typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64")); };
  const runProps = (rPr, base = {}) => {
    const r = { ...base };
    if (!rPr) return r;
    const on = (n) => { const e = kid(rPr, n); return e ? !["0", "false", "off"].includes(attr(e, "val")) : undefined; };
    for (const [k, n] of [["b", "b"], ["i", "i"], ["s", "strike"]]) { const v = on(n); if (v !== undefined) r[k] = v; }
    const u = kid(rPr, "u"); if (u) r.u = attr(u, "val") !== "none";
    const c = attr(kid(rPr, "color"), "val"); if (c && /^[0-9a-f]{6}$/i.test(c)) r.color = "#" + c.toLowerCase();
    const sz = attr(kid(rPr, "sz"), "val"); if (sz) r.size = +sz / 2;
    const font = attr(kid(rPr, "rFonts"), "ascii"); if (font) r.font = font;
    const hl = attr(kid(rPr, "highlight"), "val"); const HL = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", lightGray: "#d3d3d3", darkGray: "#a9a9a9" };
    if (hl && HL[hl]) r.bg = HL[hl];
    const shd = attr(kid(rPr, "shd"), "fill"); if (shd && /^[0-9a-f]{6}$/i.test(shd)) r.bg = "#" + shd.toLowerCase();
    const va = attr(kid(rPr, "vertAlign"), "val"); if (va === "superscript") r.sup = true; if (va === "subscript") r.sub = true;
    for (const k of Object.keys(r)) if (r[k] === false) delete r[k];
    return r;
  };
  const paragraph = (p, out) => {
    const pPr = kid(p, "pPr");
    const block = { id: newId(), type: "p", runs: [] };
    const sid = attr(kid(pPr, "pStyle"), "val");
    const st = (sid && styles[sid]) || (sid && /^heading(\d)$/i.test(sid) ? "h" + Math.min(4, +sid.slice(7)) : null) || (sid && /^title$/i.test(sid) ? "title" : null);
    if (st) block.style = st;
    const jc = attr(kid(pPr, "jc"), "val");
    if (jc) block.align = { center: "center", right: "right", end: "right", both: "justify", distribute: "justify" }[jc] || undefined;
    const numPr = kid(pPr, "numPr");
    if (numPr) { const numId = attr(kid(numPr, "numId"), "val"); const lvl = +(attr(kid(numPr, "ilvl"), "val") || 0); if (numId && numId !== "0") block.list = { kind: (numbering[numId]?.[lvl] || "bullet") === "bullet" ? "bullet" : "number", level: lvl }; }
    const ind = attr(kid(pPr, "ind"), "left") || attr(kid(pPr, "ind"), "start");
    if (ind && !block.list && +ind >= 360) block.indent = Math.min(8, Math.round(+ind / 720));
    if (kid(pPr, "rPr") && kid(kid(pPr, "rPr"), "ins")) unsupported.add("tracked changes");
    const pushRuns = (el, base = {}) => {
      for (const c of el.children || []) {
        if (!c.name) continue;
        const n = local(c.name);
        if (n === "r") {
          const props = runProps(kid(c, "rPr"), base);
          for (const x of c.children || []) {
            const xn = local(x.name || "");
            if (xn === "t") block.runs.push({ text: textOf(x), ...props });
            else if (xn === "tab") block.runs.push({ text: "\t", ...props });
            else if (xn === "br") { if (attr(x, "type") === "page") { finish(); out.push({ id: newId(), type: "pagebreak" }); } else block.runs.push({ text: "\n", ...props }); }
            else if (xn === "drawing") { const blip = deep(x, "blip")[0]; const ext = deep(x, "extent")[0]; const pr = deep(x, "docPr")[0]; const src = blip && media(attr(blip, "embed")); if (deep(x, "anchor").length) unsupported.add("pictures placed around text"); if (src) { finish(); out.push({ id: newId(), type: "img", src, w: ext ? Math.round(+ext.attrs.cx / 9525) : 300, h: ext ? Math.round(+ext.attrs.cy / 9525) : 200, ...(pr?.attrs.descr ? { alt: pr.attrs.descr } : {}), align: block.align }); } }
            else if (xn === "fldChar" || xn === "instrText") unsupported.add("fields (page numbers, contents lists)");
            else if (xn === "footnoteReference" || xn === "endnoteReference") unsupported.add("footnotes");
            else if (xn === "AlternateContent" || xn === "pict" || xn === "object") unsupported.add("shapes, text boxes and objects");
          }
        } else if (n === "hyperlink") { const href = rels[attr(c, "id")]?.target; pushRuns(c, href ? { ...base, href } : base); }
        else if (n === "ins") { unsupported.add("tracked changes"); pushRuns(c, base); }
        else if (n === "del" || n === "moveFrom") unsupported.add("tracked changes");
        else if (n === "smartTag" || n === "sdt" || n === "customXml" || n === "fldSimple") { if (n === "fldSimple") unsupported.add("fields (page numbers, contents lists)"); pushRuns(n === "sdt" ? kid(c, "sdtContent") || c : c, base); }
        else if (n === "commentRangeStart" || n === "commentReference") unsupported.add("Word comments");
      }
    };
    let started = false;
    function finish() { if (started || block.runs.length) { out.push({ ...block, runs: merge(block.runs) }); } started = true; block.id = newId(); block.runs = []; }
    pushRuns(p);
    if (block.runs.length || !started) out.push({ ...block, runs: merge(block.runs) });
  };
  const body = (el) => {
    const out = [];
    for (const c of el.children || []) {
      if (!c.name) continue;
      const n = local(c.name);
      if (n === "p") paragraph(c, out);
      else if (n === "tbl") {
        const grid = kids(kid(c, "tblGrid"), "gridCol").map((g) => Math.round(+attr(g, "w") / TWIP_MM / 0.2645833));
        const rows = kids(c, "tr").map((tr) => ({ cells: kids(tr, "tc").map((tc) => { const tcPr = kid(tc, "tcPr"); const cell = { blocks: body(tc).filter((b) => b.type !== "table") }; const span = attr(kid(tcPr, "gridSpan"), "val"); if (span && +span > 1) cell.span = +span; const fill = attr(kid(tcPr, "shd"), "fill"); if (fill && /^[0-9a-f]{6}$/i.test(fill)) cell.bg = "#" + fill.toLowerCase(); if (kid(tcPr, "vMerge")) unsupported.add("cells merged down"); if (!cell.blocks.length) cell.blocks = [{ id: newId(), type: "p", runs: [] }]; return cell; }) }));
        if (deep(c, "tbl").length) unsupported.add("tables inside tables");
        out.push({ id: newId(), type: "table", rows, widths: grid.length ? grid : undefined });
      } else if (n === "sdt") out.push(...body(kid(c, "sdtContent") || c));
      else if (n === "AlternateContent") unsupported.add("shapes, text boxes and objects");
    }
    return out;
  };
  const doc = parseXml(files[docPart]);
  const b = kid(doc, "body");
  const blocks = body(b);
  const sect = kid(b, "sectPr");
  const page = { size: "A4", margins: { t: 25, r: 25, b: 25, l: 25 } };
  if (sect) {
    const sz = kid(sect, "pgSz"); const w = +attr(sz, "w"), h = +attr(sz, "h");
    if (w && h) { const short = Math.min(w, h); page.size = Math.abs(short - 12240) < 200 ? "Letter" : "A4"; if (w > h || attr(sz, "orient") === "landscape") page.landscape = true; }
    const mg = kid(sect, "pgMar");
    if (mg) page.margins = { t: Math.round(+attr(mg, "top") / TWIP_MM), r: Math.round(+attr(mg, "right") / TWIP_MM), b: Math.round(+attr(mg, "bottom") / TWIP_MM), l: Math.round(+attr(mg, "left") / TWIP_MM) };
    const part = (name) => { const r = kids(sect, name).find((x) => attr(x, "type") === "default") || kid(sect, name); const target = r && rels[attr(r, "id")]?.target; return target && files[target] ? body(parseXml(files[target])).filter((x) => x.type === "p") : null; };
    var header = part("headerReference"), footer = part("footerReference");
  }
  if (files["word/comments.xml"]) unsupported.add("Word comments");
  if (files["word/footnotes.xml"] && deep(parseXml(files["word/footnotes.xml"]), "footnote").length > 2) unsupported.add("footnotes");
  if (!blocks.length) blocks.push({ id: newId(), type: "p", runs: [] });
  return { doc: { page, blocks, header: header || null, footer: footer || null }, unsupported: [...unsupported] };
}
/** Neighbouring runs with the same formatting joined. */
function merge(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    const { text, ...p } = r;
    if (prev) { const { text: t2, ...q } = prev; if (JSON.stringify(p) === JSON.stringify(q)) { prev.text += text; continue; } }
    out.push({ ...r });
  }
  return out;
}

const PAGE_TWIPS = { A4: [11906, 16838], Letter: [12240, 15840] };
const STYLE_TO = { title: "Title", h1: "Heading1", h2: "Heading2", h3: "Heading3", h4: "Heading4", quote: "Quote", code: "Code" };

async function writeDocx(doc) {
  const media = {}; let mediaN = 0;
  const rels = []; // [id, type, target, external]
  const rel = (type, target, external = false) => { const id = "rId" + (rels.length + 10); rels.push([id, type, target, external]); return id; };
  const lists = []; // numbering instances: { kind }
  let currentList = null;
  const runXml = (r) => {
    const pr = [r.href ? '<w:rStyle w:val="Hyperlink"/>' : "", r.font ? `<w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>` : "", r.b ? "<w:b/>" : "", r.i ? "<w:i/>" : "", r.s ? "<w:strike/>" : "",
      r.color ? `<w:color w:val="${hex(r.color)}"/>` : "", r.size ? `<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>` : "",
      r.u ? '<w:u w:val="single"/>' : "", r.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(r.bg)}"/>` : "", r.sup ? '<w:vertAlign w:val="superscript"/>' : r.sub ? '<w:vertAlign w:val="subscript"/>' : ""].join("");
    const parts = r.text.split(/(\t|\n)/).map((t) => (t === "\t" ? "<w:tab/>" : t === "\n" ? "<w:br/>" : t ? `<w:t xml:space="preserve">${esc(t)}</w:t>` : "")).join("");
    const run = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}${parts}</w:r>`;
    return r.href ? `<w:hyperlink r:id="${rel("hyperlink", r.href, true)}">${run}</w:hyperlink>` : run;
  };
  const para = (b) => {
    if (b.list) { if (!currentList || currentList.kind !== b.list.kind) { currentList = { kind: b.list.kind }; lists.push(currentList); } }
    else currentList = null;
    const pPr = [b.style && b.style !== "normal" ? `<w:pStyle w:val="${STYLE_TO[b.style] || "Normal"}"/>` : b.list ? '<w:pStyle w:val="ListParagraph"/>' : "",
      b.list ? `<w:numPr><w:ilvl w:val="${b.list.level || 0}"/><w:numId w:val="${lists.length}"/></w:numPr>` : "",
      !b.list && b.indent ? `<w:ind w:left="${b.indent * 720}"/>` : "", b.align ? `<w:jc w:val="${b.align === "justify" ? "both" : b.align}"/>` : ""].join("");
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${(b.runs || []).map(runXml).join("")}</w:p>`;
  };
  const block = (b, avail) => {
    if (b.type === "p") return para(b);
    currentList = null;
    if (b.type === "pagebreak") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    if (b.type === "hr") return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
    if (b.type === "img") {
      const m = /^data:(image\/(png|jpeg|gif|webp|bmp));base64,(.+)$/.exec(b.src || "");
      if (!m) return "";
      const ext = m[2] === "jpeg" ? "jpg" : m[2];
      const name = `image${++mediaN}.${ext}`;
      media[`word/media/${name}`] = typeof atob === "function" ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(m[3], "base64"));
      const id = rel("image", `media/${name}`);
      const maxW = avail || 600, scale = Math.min(1, maxW / (b.w || 300));
      const cx = Math.round((b.w || 300) * scale * 9525), cy = Math.round((b.h || 200) * scale * 9525);
      return `<w:p>${b.align ? `<w:pPr><w:jc w:val="${b.align}"/></w:pPr>` : ""}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${mediaN}" name="${esc(b.alt || "Picture " + mediaN)}" descr="${esc(b.alt || "")}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${mediaN}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    if (b.type === "table") {
      const cols = Math.max(...b.rows.map((r) => r.cells.reduce((n, c) => n + (c.span || 1), 0)), 1);
      const widthTw = (avail ? avail * 15 : 9000);
      const widths = b.widths && b.widths.length === cols ? b.widths.map((w) => Math.round(w * 15)) : Array(cols).fill(Math.round(widthTw / cols));
      const rows = b.rows.map((r) => `<w:tr>${(() => { let col = 0; return r.cells.map((c) => { const span = c.span || 1; const w = widths.slice(col, col + span).reduce((s, x) => s + x, 0); col += span; return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${c.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.bg)}"/>` : ""}</w:tcPr>${(c.blocks?.length ? c.blocks : [{ type: "p", runs: [] }]).map((x) => block(x, w / 15)).join("") || "<w:p/>"}</w:tc>`; }).join(""); })()}</w:tr>`).join("");
      currentList = null;
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("")}</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>${b.needsPara ? "<w:p/>" : ""}`;
    }
    return "";
  };
  const page = doc.page || {};
  let [pw, ph] = PAGE_TWIPS[page.size] || PAGE_TWIPS.A4;
  if (page.landscape) [pw, ph] = [ph, pw];
  const m = page.margins || { t: 25, r: 25, b: 25, l: 25 };
  const avail = Math.round((pw - (m.l + m.r) * TWIP_MM) / 15);
  const list = doc.blocks || [];
  const body = list.map((b, i) => block(b.type === "table" && (i === list.length - 1 || list[i + 1].type === "table") ? { ...b, needsPara: true } : b, avail)).join("");
  const files = {};
  const hf = (kind, blocks) => { if (!blocks?.length) return ""; const name = `${kind}1.xml`; currentList = null; files[`word/${name}`] = XML_HEAD + `<w:${kind === "header" ? "hdr" : "ftr"} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${blocks.map((b) => block(b, avail)).join("")}</w:${kind === "header" ? "hdr" : "ftr"}>`; return `<w:${kind}Reference w:type="default" r:id="${rel(kind, name)}"/>`; };
  const hdr = hf("header", doc.header), ftr = hf("footer", doc.footer);
  const sect = `<w:sectPr>${hdr}${ftr}<w:pgSz w:w="${pw}" w:h="${ph}"${page.landscape ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${Math.round(m.t * TWIP_MM)}" w:right="${Math.round(m.r * TWIP_MM)}" w:bottom="${Math.round(m.b * TWIP_MM)}" w:left="${Math.round(m.l * TWIP_MM)}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  files["word/document.xml"] = XML_HEAD + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}${sect}</w:body></w:document>`;
  const bullets = ["•", "◦", "▪", "•", "◦", "▪", "•", "◦", "▪"];
  const numFmts = ["decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman"];
  const lvls = (kind) => Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${kind === "bullet" ? "bullet" : numFmts[i]}"/><w:lvlText w:val="${kind === "bullet" ? bullets[i] : `%${i + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${kind === "bullet" ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>' : ""}</w:lvl>`).join("");
  files["word/numbering.xml"] = XML_HEAD + `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls("number")}</w:abstractNum>${lists.map((l, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${l.kind === "bullet" ? 0 : 1}"/>${l.kind === "number" ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>` : ""}</w:num>`).join("")}</w:numbering>`;
  const heading = (id, name, size, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${+id.slice(-1) - 1 || 0}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/>${extra}</w:rPr></w:style>`;
  files["word/styles.xml"] = XML_HEAD + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr></w:style>${heading("Heading1", "heading 1", 36)}${heading("Heading2", "heading 2", 30)}${heading("Heading3", "heading 3", 26)}${heading("Heading4", "heading 4", 22, "<w:i/>")}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  files["word/_rels/document.xml.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${ext ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  files["_rels/.rels"] = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  files["docProps/core.xml"] = coreXml();
  const exts = [...new Set(Object.keys(media).map((n) => n.split(".").pop()))];
  const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  files["[Content_Types].xml"] = XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="${MIME[e]}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${files["word/header1.xml"] ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}${files["word/footer1.xml"] ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  return zip({ ...files, ...media });
}

return { unzip, zip, parseXml, crc32, readXlsx, writeXlsx, readCsv, writeCsv, readDocx, writeDocx, newId, merge, PAGE_TWIPS };
});
