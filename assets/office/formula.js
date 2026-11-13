// The spreadsheet's formula engine: Excel-style formulas parsed and calculated here, with no eval and nothing from a
// file ever run as code. Cell references (A1, $A$1, Sheet2!B3, 'My sheet'!A1:C9, A:A, 2:5), about 140 functions,
// Excel's number formats and date serials, and a dependency-aware calculator: change a cell and only what depends on
// it is calculated again. Works in the browser (window.OfficeFormula) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OfficeFormula = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

// ------------------------------------------------------------------------------------------------ values

class FErr { constructor(code) { this.code = code; } toString() { return this.code; } }
const ERR = {};
for (const c of ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CIRC!", "#SPILL!"]) ERR[c] = new FErr(c);
const isErr = (v) => v instanceof FErr;
/** A range's values, rows of columns. */
class Matrix { constructor(rows) { this.rows = rows; } get h() { return this.rows.length; } get w() { return this.rows[0]?.length || 0; } *values() { for (const r of this.rows) yield* r; } }
const isM = (v) => v instanceof Matrix;

// ------------------------------------------------------------------------------------------------ addresses

const colName = (c) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const colIndex = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const addr = (r, c) => colName(c) + (r + 1);
const MAX_ROWS = 1048576, MAX_COLS = 16384;
const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

// ------------------------------------------------------------------------------------------------ tokens

const ERRORS = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CIRC!", "#SPILL!"];
const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
/** A formula's tokens, each with its text, so a formula can be rewritten (copied, filled, rows inserted). */
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const push = (t, v, start) => out.push({ t, v, s: start, e: i });
  while (i < n) {
    const ch = src[i], start = i;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') { let v = ""; i++; for (;;) { if (i >= n) throw new SyntaxError("Unclosed text"); if (src[i] === '"') { if (src[i + 1] === '"') { v += '"'; i += 2; continue; } i++; break; } v += src[i++]; } push("str", v, start); continue; }
    if (ch === "#") { const e = ERRORS.find((x) => src.toUpperCase().startsWith(x, i)); if (e) { i += e.length; push("err", e, start); continue; } throw new SyntaxError("Unknown error value"); }
    // A sheet name, then a reference: Sheet1!A1, 'My sheet'!A1:B2
    let sheet = null;
    if (ch === "'") {
      let v = ""; i++;
      for (;;) { if (i >= n) throw new SyntaxError("Unclosed sheet name"); if (src[i] === "'") { if (src[i + 1] === "'") { v += "'"; i += 2; continue; } i++; break; } v += src[i++]; }
      if (src[i] !== "!") throw new SyntaxError("Expected ! after a sheet name");
      i++; sheet = v;
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(src.slice(i));
      if (m) { sheet = m[1]; i += m[0].length; }
    }
    const rest = src.slice(i);
    let m;
    // Whole columns (A:C) and whole rows (2:5)
    if ((m = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9(])/.exec(rest))) { i += m[0].length; push("range", { sheet, c1: colIndex(m[2]), c2: colIndex(m[4]), r1: 0, r2: MAX_ROWS - 1, ac1: !!m[1], ac2: !!m[3], cols: true }, start); continue; }
    // Whole rows (2:5), when not straight after a value (where a number would be meant)
    const prevIsValue = ["num", "str", "ref", "range", ")"].includes(out[out.length - 1]?.t);
    if ((m = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![0-9.])/.exec(rest)) && (sheet || !prevIsValue)) {
      i += m[0].length; push("range", { sheet, r1: +m[2] - 1, r2: +m[4] - 1, c1: 0, c2: MAX_COLS - 1, ar1: !!m[1], ar2: !!m[3], rowsOnly: true }, start); continue;
    }
    if ((m = REF_RE.exec(rest)) && !/^[A-Za-z0-9_(]/.test(rest.slice(m[0].length))) {
      i += m[0].length;
      const a = { sheet, c: colIndex(m[2]), r: +m[4] - 1, ac: !!m[1], ar: !!m[3] };
      const m2 = /^:(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/.exec(src.slice(i));
      if (m2) { i += m2[0].length; push("range", { sheet, r1: a.r, c1: a.c, ar1: a.ar, ac1: a.ac, r2: +m2[4] - 1, c2: colIndex(m2[2]), ar2: !!m2[3], ac2: !!m2[1] }, start); }
      else push("ref", a, start);
      continue;
    }
    if (sheet !== null) throw new SyntaxError("Expected a reference after the sheet name");
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { i += m[0].length; push("num", parseFloat(m[0]), start); continue; }
    if ((m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(rest))) { i += m[0].length - 1; push("fn", m[1].toUpperCase().replace(/^_XLFN\./, ""), start); continue; }
    if ((m = /^(TRUE|FALSE)(?![A-Za-z0-9_.(])/i.exec(rest))) { i += m[0].length; push("bool", m[1].toUpperCase() === "TRUE", start); continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) { i += m[0].length; push("name", m[0], start); continue; }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>"].includes(two)) { i += 2; push("op", two, start); continue; }
    if ("+-*/^&=<>%".includes(ch)) { i++; push("op", ch, start); continue; }
    if (ch === "(" || ch === ")") { i++; push(ch, ch, start); continue; }
    if (ch === "," || ch === ";") { i++; push(",", ",", start); continue; }
    if (ch === "{" || ch === "}") throw new SyntaxError("Array constants aren't supported");
    throw new SyntaxError(`Unexpected “${ch}”`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ parser

const BIN = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };
function parse(src) {
  const toks = tokenize(src.replace(/^=/, ""));
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expr = (minPrec = 0) => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === "op" && t.v === "%") { p++; left = { k: "pct", a: left }; continue; }
      if (t.t !== "op" || !(t.v in BIN) || BIN[t.v] < minPrec) break;
      const prec = BIN[t.v];
      p++;
      const right = expr(prec + 1); // left to right, ^ included (Excel: 2^3^2 = 64)
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  };
  const unary = () => {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) { p++; const a = expr(6); return t.v === "-" ? { k: "neg", a } : a; }
    return primary();
  };
  const primary = () => {
    const t = next();
    if (!t) throw new SyntaxError("The formula ends too soon");
    switch (t.t) {
      case "num": return { k: "num", v: t.v };
      case "str": return { k: "str", v: t.v };
      case "bool": return { k: "bool", v: t.v };
      case "err": return { k: "err", v: t.v };
      case "ref": return { k: "ref", ...t.v };
      case "range": return { k: "range", ...t.v };
      case "name": return { k: "name", v: t.v };
      case "(": { const e = expr(); if (next()?.t !== ")") throw new SyntaxError("Missing )"); return e; }
      case "fn": {
        if (next()?.t !== "(") throw new SyntaxError("Expected (");
        const args = [];
        if (peek()?.t === ")") { p++; return { k: "fn", name: t.v, args }; }
        for (;;) {
          if (peek()?.t === "," || peek()?.t === ")") args.push({ k: "blank" }); else args.push(expr());
          const sep = next();
          if (!sep) throw new SyntaxError("Missing )");
          if (sep.t === ")") break;
          if (sep.t !== ",") throw new SyntaxError("Expected , or )");
        }
        return { k: "fn", name: t.v, args };
      }
    }
    throw new SyntaxError(`Unexpected “${src.slice(t.s, t.e) || t.v}”`);
  };
  const ast = expr();
  if (p < toks.length) throw new SyntaxError(`Unexpected “${toks[p].v}”`);
  return ast;
}

// ------------------------------------------------------------------------------------------------ coercion and comparison

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;
/** Excel's date serial for a calendar date (1900 date system). */
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - EPOCH) / DAY;
const fromSerial = (s) => { const dt = new Date(EPOCH + Math.floor(s) * DAY); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() }; };
function num(v) {
  if (isErr(v)) return v;
  if (v == null || v === "") return v === "" ? ERR["#VALUE!"] : 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isM(v)) return v.h === 1 && v.w === 1 ? num(v.rows[0][0] ?? 0) : ERR["#VALUE!"];
  const p = parseInput(String(v));
  return typeof p.value === "number" ? p.value : ERR["#VALUE!"];
}
const blankNum = (v) => (v == null ? 0 : num(v));
function str(v) {
  if (isErr(v)) return v;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatGeneral(v);
  if (isM(v)) return v.h === 1 && v.w === 1 ? str(v.rows[0][0]) : ERR["#VALUE!"];
  return String(v);
}
function bool(v) {
  if (isErr(v)) return v;
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (isM(v)) return v.h === 1 && v.w === 1 ? bool(v.rows[0][0]) : ERR["#VALUE!"];
  const u = String(v).toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return ERR["#VALUE!"];
}
const rank = (v) => (typeof v === "number" ? 1 : typeof v === "string" ? 2 : typeof v === "boolean" ? 3 : 0);
/** Excel's order: numbers, then text (ignoring case), then TRUE/FALSE; blank is 0 or "". */
function compare(a, b) {
  if (a == null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b == null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "string") { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------ evaluating

/**
 * $ctx: { sheet: the formula's sheet name, get(sheet, r, c) → its value, has(sheet) → whether it exists, row, col }.
 * Returns a value: number, string, boolean, null (blank) or FErr.
 */
function evaluate(ast, ctx) {
  const v = ev(ast, ctx);
  if (isM(v)) return v.h === 1 && v.w === 1 ? v.rows[0][0] ?? 0 : (v.rows[0]?.[0] ?? 0);
  return v === null ? 0 : v;
}
function rangeOf(node, ctx) {
  const sheet = node.sheet ?? ctx.sheet;
  if (!ctx.has(sheet)) return ERR["#REF!"];
  let r2 = node.r2, c2 = node.c2;
  if (node.cols || node.rowsOnly) { const used = ctx.used?.(sheet) || { rows: 0, cols: 0 }; if (node.cols) r2 = Math.min(r2, used.rows - 1); if (node.rowsOnly) c2 = Math.min(c2, used.cols - 1); }
  const r1 = Math.min(node.r1, r2), c1 = Math.min(node.c1, c2);
  const rows = [];
  for (let r = Math.min(node.r1, node.r2); r <= Math.max(r2, Math.min(node.r1, node.r2)) && r <= r2; r++) { const row = []; for (let c = Math.min(node.c1, c2); c <= c2; c++) row.push(ctx.get(sheet, r, c)); rows.push(row); }
  if (!rows.length) rows.push([null]);
  return Object.assign(new Matrix(rows), { top: r1, left: c1, sheet });
}
function ev(node, ctx) {
  switch (node.k) {
    case "num": case "str": case "bool": return node.v;
    case "err": return ERR[node.v];
    case "blank": return null;
    case "name": return ERR["#NAME?"];
    case "ref": { const sheet = node.sheet ?? ctx.sheet; if (!ctx.has(sheet)) return ERR["#REF!"]; const v = ctx.get(sheet, node.r, node.c); return v === undefined ? null : v; }
    case "range": return rangeOf(node, ctx);
    case "neg": { const a = num(scalar(ev(node.a, ctx))); return isErr(a) ? a : -a; }
    case "pct": { const a = num(scalar(ev(node.a, ctx))); return isErr(a) ? a : a / 100; }
    case "bin": return binary(node.op, scalar(ev(node.a, ctx)), scalar(ev(node.b, ctx)));
    case "fn": {
      const f = FN[node.name];
      if (!f) return ERR["#NAME?"];
      if (f.lazy) return f(node.args, ctx);
      const args = node.args.map((a) => ev(a, ctx));
      try { const r = f(args, ctx, node); return r === undefined ? ERR["#VALUE!"] : r; } catch (e) { if (e instanceof FErr) return e; throw e; }
    }
  }
  return ERR["#VALUE!"];
}
const scalar = (v) => (isM(v) ? (v.h === 1 && v.w === 1 ? v.rows[0][0] : ERR["#VALUE!"]) : v);
function binary(op, a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (op === "&") { const x = str(a), y = str(b); return isErr(x) ? x : isErr(y) ? y : x + y; }
  if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
    const c = compare(a, b);
    return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op];
  }
  const x = blankNum(a), y = blankNum(b);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? ERR["#DIV/0!"] : x / y;
    case "^": { if (x === 0 && y === 0) return ERR["#NUM!"]; const r = Math.pow(x, y); return Number.isFinite(r) ? r : ERR["#NUM!"]; }
  }
  return ERR["#VALUE!"];
}

// ------------------------------------------------------------------------------------------------ functions

const FN = Object.create(null);
const firstErr = (vals) => vals.find(isErr);
/** Every value in the arguments (ranges flattened). Numbers only from ranges; typed values coerced. */
function nums(args, { countText = false } = {}) {
  const out = [];
  for (const a of args) {
    if (isM(a)) { for (const v of a.values()) { if (isErr(v)) throw v; if (typeof v === "number") out.push(v); else if (countText && (typeof v === "string" || typeof v === "boolean")) out.push(typeof v === "boolean" ? +v : 0); } }
    else if (a != null) { const n = num(a); if (isErr(n)) throw n; out.push(n); }
  }
  return out;
}
const flat = (args) => { const out = []; for (const a of args) { if (isM(a)) for (const v of a.values()) out.push(v); else out.push(a); } return out; };
const reg = (names, f) => { for (const n of names.split(",")) FN[n.trim()] = f; };
const n1 = (v) => { const x = num(scalar(v)); if (isErr(x)) throw x; return x; };
const s1 = (v) => { const x = str(scalar(v)); if (isErr(x)) throw x; return x; };
const b1 = (v) => { const x = bool(scalar(v)); if (isErr(x)) throw x; return x; };
const opt = (args, i, d) => (args[i] === undefined || args[i] === null ? d : args[i]);
const finite = (x) => (Number.isFinite(x) ? x : ERR["#NUM!"]);
const roundTo = (x, d) => { const f = Math.pow(10, d); return Math.round((x + Math.sign(x) * Number.EPSILON * Math.abs(x)) * f) / f; };

// maths
reg("SUM", (a) => nums(a).reduce((s, x) => s + x, 0));
reg("PRODUCT", (a) => nums(a).reduce((s, x) => s * x, 1));
reg("AVERAGE", (a) => { const v = nums(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : ERR["#DIV/0!"]; });
reg("AVERAGEA", (a) => { const v = nums(a, { countText: true }); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : ERR["#DIV/0!"]; });
reg("MIN", (a) => { const v = nums(a); return v.length ? Math.min(...v) : 0; });
reg("MAX", (a) => { const v = nums(a); return v.length ? Math.max(...v) : 0; });
reg("COUNT", (a) => { let n = 0; for (const x of a) { if (isM(x)) { for (const v of x.values()) if (typeof v === "number") n++; } else if (typeof x === "number" || typeof x === "boolean" || (typeof x === "string" && typeof parseInput(x).value === "number")) n++; } return n; });
reg("COUNTA", (a) => flat(a).filter((v) => v != null && v !== "").length);
reg("COUNTBLANK", (a) => flat(a).filter((v) => v == null || v === "").length);
reg("ROUND", (a) => roundTo(n1(a[0]), n1(opt(a, 1, 0))));
reg("ROUNDUP", (a) => { const x = n1(a[0]), f = Math.pow(10, n1(opt(a, 1, 0))); return Math.sign(x) * Math.ceil(Math.abs(x) * f - 1e-9) / f; });
reg("ROUNDDOWN", (a) => { const x = n1(a[0]), f = Math.pow(10, n1(opt(a, 1, 0))); return Math.sign(x) * Math.floor(Math.abs(x) * f + 1e-9) / f; });
reg("INT", (a) => Math.floor(n1(a[0])));
reg("TRUNC", (a) => { const x = n1(a[0]), f = Math.pow(10, n1(opt(a, 1, 0))); return Math.trunc(x * f) / f; });
reg("ABS", (a) => Math.abs(n1(a[0])));
reg("SIGN", (a) => Math.sign(n1(a[0])));
reg("MOD", (a) => { const x = n1(a[0]), d = n1(a[1]); return d === 0 ? ERR["#DIV/0!"] : x - d * Math.floor(x / d); });
reg("POWER", (a) => binary("^", n1(a[0]), n1(a[1])));
reg("SQRT", (a) => { const x = n1(a[0]); return x < 0 ? ERR["#NUM!"] : Math.sqrt(x); });
reg("EXP", (a) => finite(Math.exp(n1(a[0]))));
reg("LN", (a) => { const x = n1(a[0]); return x <= 0 ? ERR["#NUM!"] : Math.log(x); });
reg("LOG", (a) => { const x = n1(a[0]), b = n1(opt(a, 1, 10)); return x <= 0 || b <= 0 || b === 1 ? ERR["#NUM!"] : Math.log(x) / Math.log(b); });
reg("LOG10", (a) => { const x = n1(a[0]); return x <= 0 ? ERR["#NUM!"] : Math.log10(x); });
reg("PI", () => Math.PI);
const vol = (f) => Object.assign(f, { volatile: true });
reg("RAND", vol(() => Math.random()));
reg("RANDBETWEEN", vol((a) => { const lo = Math.ceil(n1(a[0])), hi = Math.floor(n1(a[1])); return hi < lo ? ERR["#NUM!"] : lo + Math.floor(Math.random() * (hi - lo + 1)); }));
reg("CEILING,CEILING.MATH", (a) => { const x = n1(a[0]), s = n1(opt(a, 1, 1)); return s === 0 ? 0 : Math.ceil(x / s - 1e-12) * s; });
reg("FLOOR,FLOOR.MATH", (a) => { const x = n1(a[0]), s = n1(opt(a, 1, 1)); return s === 0 ? ERR["#DIV/0!"] : Math.floor(x / s + 1e-12) * s; });
reg("MROUND", (a) => { const x = n1(a[0]), s = n1(a[1]); return s === 0 ? 0 : x * s < 0 ? ERR["#NUM!"] : roundTo(Math.round(x / s) * s, 10); });
reg("EVEN", (a) => { const x = n1(a[0]); const r = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -r : r; });
reg("ODD", (a) => { const x = n1(a[0]); let r = Math.ceil(Math.abs(x)); if (r % 2 === 0) r++; return x < 0 ? -r : r; });
reg("FACT", (a) => { const x = Math.floor(n1(a[0])); if (x < 0) return ERR["#NUM!"]; let r = 1; for (let i = 2; i <= x; i++) r *= i; return finite(r); });
const gcd2 = (x, y) => (y ? gcd2(y, x % y) : x);
reg("GCD", (a) => nums(a).map(Math.floor).reduce(gcd2, 0));
reg("LCM", (a) => nums(a).map(Math.floor).reduce((x, y) => (x && y ? (x * y) / gcd2(x, y) : 0), 1));
reg("SUMSQ", (a) => nums(a).reduce((s, x) => s + x * x, 0));
reg("SUMPRODUCT", (a) => {
  const ms = a.map((x) => (isM(x) ? x : new Matrix([[x]])));
  if (ms.some((m) => m.h !== ms[0].h || m.w !== ms[0].w)) return ERR["#VALUE!"];
  let s = 0;
  for (let r = 0; r < ms[0].h; r++) for (let c = 0; c < ms[0].w; c++) { let p = 1; for (const m of ms) { const v = m.rows[r][c]; if (isErr(v)) return v; p *= typeof v === "number" ? v : 0; } s += p; }
  return s;
});
const sorted = (a) => nums(a).sort((x, y) => x - y);
reg("MEDIAN", (a) => { const v = sorted(a); if (!v.length) return ERR["#NUM!"]; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; });
reg("MODE,MODE.SNGL", (a) => { const c = new Map(); let best = null, bn = 1; for (const x of nums(a)) { const n = (c.get(x) || 0) + 1; c.set(x, n); if (n > bn) { bn = n; best = x; } } return best === null ? ERR["#N/A"] : best; });
const variance = (v, sample) => { if (v.length < (sample ? 2 : 1)) return ERR["#DIV/0!"]; const m = v.reduce((s, x) => s + x, 0) / v.length; return v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - (sample ? 1 : 0)); };
reg("VAR,VAR.S", (a) => variance(nums(a), true));
reg("VARP,VAR.P", (a) => variance(nums(a), false));
reg("STDEV,STDEV.S", (a) => { const v = variance(nums(a), true); return isErr(v) ? v : Math.sqrt(v); });
reg("STDEVP,STDEV.P", (a) => { const v = variance(nums(a), false); return isErr(v) ? v : Math.sqrt(v); });
reg("LARGE", (a) => { const v = sorted([a[0]]); const k = Math.ceil(n1(a[1])); return k < 1 || k > v.length ? ERR["#NUM!"] : v[v.length - k]; });
reg("SMALL", (a) => { const v = sorted([a[0]]); const k = Math.ceil(n1(a[1])); return k < 1 || k > v.length ? ERR["#NUM!"] : v[k - 1]; });
reg("RANK,RANK.EQ", (a) => { const x = n1(a[0]); const v = nums([a[1]]); const asc = n1(opt(a, 2, 0)) !== 0; if (!v.includes(x)) return ERR["#N/A"]; return 1 + v.filter((y) => (asc ? y < x : y > x)).length; });
const pct = (v, p) => { if (!v.length || p < 0 || p > 1) return ERR["#NUM!"]; const h = (v.length - 1) * p, lo = Math.floor(h); return v[lo] + (h - lo) * ((v[lo + 1] ?? v[lo]) - v[lo]); };
reg("PERCENTILE,PERCENTILE.INC", (a) => pct(sorted([a[0]]), n1(a[1])));
reg("QUARTILE,QUARTILE.INC", (a) => { const q = Math.floor(n1(a[1])); return q < 0 || q > 4 ? ERR["#NUM!"] : pct(sorted([a[0]]), q / 4); });
reg("SUBTOTAL", (a, ctx) => { const code = n1(a[0]) % 100; const map = { 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV", 8: "STDEVP", 9: "SUM", 10: "VAR", 11: "VARP" }; return map[code] ? FN[map[code]](a.slice(1), ctx) : ERR["#VALUE!"]; });

// conditions: ">=10", "<>done", "app*", "=", 5
function matcher(crit) {
  if (typeof crit === "number" || typeof crit === "boolean") return (v) => compare(v, crit) === 0 && rank(v) === rank(crit);
  const s = str(crit);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(s);
  const op = m[1] || "=", rhs = m[2];
  const n = parseInput(rhs).value;
  if (typeof n === "number" && rhs !== "") {
    return (v) => { if (typeof v !== "number") return op === "<>"; const c = v < n ? -1 : v > n ? 1 : 0; return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op]; };
  }
  if (op === "=" || op === "<>") {
    if (rhs === "") return op === "=" ? (v) => v == null || v === "" : (v) => !(v == null || v === "");
    const re = new RegExp("^" + rhs.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (x, esc, wild, sp) => (esc ? "\\" + esc : wild ? (wild === "*" ? ".*" : ".") : "\\" + sp)) + "$", "is");
    return op === "=" ? (v) => re.test(str(v ?? "")) : (v) => !re.test(str(v ?? ""));
  }
  return (v) => { if (typeof v !== "string") return false; const c = compare(v, rhs); return { "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op]; };
}
const asM = (v) => (isM(v) ? v : new Matrix([[v]]));
/** Rows/cols where every (range, condition) pair matches: [[r, c], …] into the first range's shape. */
function matching(pairs) {
  const ms = pairs.map(([r]) => asM(r));
  const fs = pairs.map(([, c]) => matcher(scalar(c)));
  if (ms.some((m) => m.h !== ms[0].h || m.w !== ms[0].w)) throw ERR["#VALUE!"];
  const out = [];
  for (let r = 0; r < ms[0].h; r++) for (let c = 0; c < ms[0].w; c++) if (fs.every((f, i) => f(ms[i].rows[r][c]))) out.push([r, c]);
  return out;
}
const pairsFrom = (a, start) => { const p = []; for (let i = start; i + 1 < a.length; i += 2) p.push([a[i], a[i + 1]]); return p; };
const pick = (m, cells) => cells.map(([r, c]) => asM(m).rows[r]?.[c]).filter((v) => typeof v === "number");
reg("COUNTIF", (a) => matching([[a[0], a[1]]]).length);
reg("COUNTIFS", (a) => matching(pairsFrom(a, 0)).length);
reg("SUMIF", (a) => pick(opt(a, 2, a[0]), matching([[a[0], a[1]]])).reduce((s, x) => s + x, 0));
reg("SUMIFS", (a) => pick(a[0], matching(pairsFrom(a, 1))).reduce((s, x) => s + x, 0));
reg("AVERAGEIF", (a) => { const v = pick(opt(a, 2, a[0]), matching([[a[0], a[1]]])); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : ERR["#DIV/0!"]; });
reg("AVERAGEIFS", (a) => { const v = pick(a[0], matching(pairsFrom(a, 1))); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : ERR["#DIV/0!"]; });
reg("MAXIFS", (a) => { const v = pick(a[0], matching(pairsFrom(a, 1))); return v.length ? Math.max(...v) : 0; });
reg("MINIFS", (a) => { const v = pick(a[0], matching(pairsFrom(a, 1))); return v.length ? Math.min(...v) : 0; });

// logic (the IF family only works out what it needs)
const lazy = (f) => Object.assign(f, { lazy: true });
reg("IF", lazy((args, ctx) => { const c = bool(scalar(ev(args[0], ctx))); if (isErr(c)) return c; const branch = c ? args[1] : args[2]; return branch ? ev(branch, ctx) ?? 0 : c; }));
reg("IFS", lazy((args, ctx) => { for (let i = 0; i + 1 < args.length; i += 2) { const c = bool(scalar(ev(args[i], ctx))); if (isErr(c)) return c; if (c) return ev(args[i + 1], ctx); } return ERR["#N/A"]; }));
reg("IFERROR", lazy((args, ctx) => { const v = ev(args[0], ctx); return isErr(v) ? ev(args[1], ctx) : v; }));
reg("IFNA", lazy((args, ctx) => { const v = ev(args[0], ctx); return v === ERR["#N/A"] ? ev(args[1], ctx) : v; }));
reg("SWITCH", lazy((args, ctx) => { const v = scalar(ev(args[0], ctx)); if (isErr(v)) return v; for (let i = 1; i + 1 < args.length; i += 2) { const w = scalar(ev(args[i], ctx)); if (compare(v, w) === 0 && rank(v) === rank(w)) return ev(args[i + 1], ctx); } return args.length % 2 === 0 ? ev(args[args.length - 1], ctx) : ERR["#N/A"]; }));
reg("CHOOSE", lazy((args, ctx) => { const i = num(scalar(ev(args[0], ctx))); if (isErr(i)) return i; const k = Math.floor(i); return k < 1 || k >= args.length ? ERR["#VALUE!"] : ev(args[k], ctx); }));
const bools = (a) => flat(a).filter((v) => v != null && typeof v !== "string").map((v) => { const b = bool(v); if (isErr(b)) throw b; return b; });
reg("AND", (a) => { const v = bools(a); return v.length ? v.every(Boolean) : ERR["#VALUE!"]; });
reg("OR", (a) => { const v = bools(a); return v.length ? v.some(Boolean) : ERR["#VALUE!"]; });
reg("XOR", (a) => bools(a).filter(Boolean).length % 2 === 1);
reg("NOT", (a) => !b1(a[0]));
reg("TRUE", () => true);
reg("FALSE", () => false);

// looking things up
function find1(list, key, mode) {
  // mode 0: exact (wildcards for text), 1: largest ≤ key (sorted), -1: smallest ≥ key (sorted descending)
  if (mode === 0) { const f = typeof key === "string" ? matcher(key) : (v) => compare(v, key) === 0 && rank(v) === rank(key); return list.findIndex((v) => f(v)); }
  let best = -1;
  for (let i = 0; i < list.length; i++) { const c = compare(list[i], key); if (mode === 1 ? c <= 0 : c >= 0) best = i; else break; }
  return best;
}
reg("VLOOKUP", (a) => { const key = scalar(a[0]); if (isErr(key)) return key; const m = asM(a[1]); const col = Math.floor(n1(a[2])); if (col < 1 || col > m.w) return ERR["#REF!"]; const approx = b1(opt(a, 3, true)); const i = find1(m.rows.map((r) => r[0]), key, approx ? 1 : 0); return i < 0 ? ERR["#N/A"] : m.rows[i][col - 1] ?? 0; });
reg("HLOOKUP", (a) => { const key = scalar(a[0]); if (isErr(key)) return key; const m = asM(a[1]); const row = Math.floor(n1(a[2])); if (row < 1 || row > m.h) return ERR["#REF!"]; const approx = b1(opt(a, 3, true)); const i = find1(m.rows[0], key, approx ? 1 : 0); return i < 0 ? ERR["#N/A"] : m.rows[row - 1][i] ?? 0; });
const line = (m) => (m.h === 1 ? m.rows[0] : m.rows.map((r) => r[0]));
reg("MATCH", (a) => { const key = scalar(a[0]); if (isErr(key)) return key; const t = Math.sign(n1(opt(a, 2, 1))); const i = find1(line(asM(a[1])), key, t); return i < 0 ? ERR["#N/A"] : i + 1; });
reg("XMATCH", (a) => { const key = scalar(a[0]); const i = find1(line(asM(a[1])), key, 0); return i < 0 ? ERR["#N/A"] : i + 1; });
reg("XLOOKUP", (a) => {
  const key = scalar(a[0]); if (isErr(key)) return key;
  const look = asM(a[1]), ret = asM(a[2]);
  const mode = Math.floor(n1(opt(a, 4, 0)));
  const keys = line(look);
  let i = find1(keys, key, 0);
  if (i < 0 && (mode === -1 || mode === 1)) { let best = -1; keys.forEach((v, j) => { if (typeof v !== typeof key) return; const c = compare(v, key); if ((mode === -1 && c < 0 && (best < 0 || compare(v, keys[best]) > 0)) || (mode === 1 && c > 0 && (best < 0 || compare(v, keys[best]) < 0))) best = j; }); i = best; }
  if (i < 0) return a[3] !== undefined && a[3] !== null ? a[3] : ERR["#N/A"];
  // Looking along a row returns from the same column of the return row; down a column, from the same row.
  if (look.h === 1 && look.w > 1) return ret.rows[0]?.[i] ?? 0;
  return ret.w === 1 ? ret.rows[i]?.[0] ?? 0 : new Matrix([ret.rows[i] || [null]]);
});
reg("INDEX", (a) => { const m = asM(a[0]); let r = Math.floor(n1(opt(a, 1, 0))), c = Math.floor(n1(opt(a, 2, 0))); if (m.h === 1 && a[2] === undefined) { c = r; r = 1; } if (r < 0 || c < 0 || r > m.h || c > m.w) return ERR["#REF!"]; if (r === 0 && c === 0) return m; if (r === 0) return new Matrix(m.rows.map((row) => [row[c - 1]])); if (c === 0) return m.w === 1 ? m.rows[r - 1][0] : new Matrix([m.rows[r - 1]]); return m.rows[r - 1][c - 1] ?? 0; });
reg("LOOKUP", (a) => { const key = scalar(a[0]); const keys = line(asM(a[1])); const res = a[2] ? line(asM(a[2])) : keys; const i = find1(keys, key, 1); return i < 0 ? ERR["#N/A"] : res[i] ?? ERR["#N/A"]; });
reg("ROWS", (a) => asM(a[0]).h);
reg("COLUMNS", (a) => asM(a[0]).w);
reg("ROW", (a, ctx, node) => { const ref = node.args[0]; if (!ref) return (ctx.row ?? 0) + 1; return ref.k === "ref" ? ref.r + 1 : ref.k === "range" ? ref.r1 + 1 : ERR["#VALUE!"]; });
reg("COLUMN", (a, ctx, node) => { const ref = node.args[0]; if (!ref) return (ctx.col ?? 0) + 1; return ref.k === "ref" ? ref.c + 1 : ref.k === "range" ? ref.c1 + 1 : ERR["#VALUE!"]; });
reg("INDIRECT", vol((a, ctx) => { const s = s1(a[0]); try { const ast = parse(s); if (ast.k !== "ref" && ast.k !== "range") return ERR["#REF!"]; return ev(ast, ctx); } catch { return ERR["#REF!"]; } }));

// text
reg("CONCAT,CONCATENATE", (a) => { let s = ""; for (const v of flat(a)) { const x = str(v); if (isErr(x)) return x; s += x; } return s; });
reg("TEXTJOIN", (a) => { const sep = s1(a[0]); const skip = b1(a[1]); const parts = []; for (const v of flat(a.slice(2))) { if (isErr(v)) return v; const x = str(v); if (skip && x === "") continue; parts.push(x); } return parts.join(sep); });
reg("LEFT", (a) => s1(a[0]).slice(0, Math.max(0, n1(opt(a, 1, 1)))));
reg("RIGHT", (a) => { const s = s1(a[0]), n = Math.max(0, n1(opt(a, 1, 1))); return n ? s.slice(-n) : ""; });
reg("MID", (a) => { const s = s1(a[0]), st = Math.floor(n1(a[1])), n = Math.floor(n1(a[2])); return st < 1 || n < 0 ? ERR["#VALUE!"] : s.substr(st - 1, n); });
reg("LEN", (a) => s1(a[0]).length);
reg("LOWER", (a) => s1(a[0]).toLowerCase());
reg("UPPER", (a) => s1(a[0]).toUpperCase());
reg("PROPER", (a) => s1(a[0]).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()));
reg("TRIM", (a) => s1(a[0]).replace(/ +/g, " ").trim());
reg("CLEAN", (a) => s1(a[0]).replace(/[\x00-\x1f]/g, ""));
reg("SUBSTITUTE", (a) => { const s = s1(a[0]), from = s1(a[1]), to = s1(a[2]); if (from === "") return s; if (a[3] === undefined) return s.split(from).join(to); const k = Math.floor(n1(a[3])); let i = -1; for (let n = 0; n < k; n++) { i = s.indexOf(from, i + 1); if (i < 0) return s; } return s.slice(0, i) + to + s.slice(i + from.length); });
reg("REPLACE", (a) => { const s = s1(a[0]), st = Math.floor(n1(a[1])), n = Math.floor(n1(a[2])); return s.slice(0, st - 1) + s1(a[3]) + s.slice(st - 1 + n); });
reg("FIND", (a) => { const f = s1(a[0]), s = s1(a[1]), st = Math.floor(n1(opt(a, 2, 1))); const i = s.indexOf(f, st - 1); return i < 0 ? ERR["#VALUE!"] : i + 1; });
reg("SEARCH", (a) => { const f = s1(a[0]), s = s1(a[1]), st = Math.floor(n1(opt(a, 2, 1))); const re = new RegExp(f.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (x, e, w, sp) => (e ? "\\" + e : w ? (w === "*" ? ".*" : ".") : "\\" + sp)), "i"); const m = re.exec(s.slice(st - 1)); return m ? m.index + st : ERR["#VALUE!"]; });
reg("REPT", (a) => { const n = Math.floor(n1(a[1])); return n < 0 ? ERR["#VALUE!"] : s1(a[0]).repeat(Math.min(n, 32767)); });
reg("EXACT", (a) => s1(a[0]) === s1(a[1]));
reg("CHAR", (a) => String.fromCharCode(Math.floor(n1(a[0]))));
reg("CODE", (a) => { const s = s1(a[0]); return s ? s.charCodeAt(0) : ERR["#VALUE!"]; });
reg("T", (a) => (typeof scalar(a[0]) === "string" ? scalar(a[0]) : ""));
reg("N", (a) => { const v = scalar(a[0]); return typeof v === "number" ? v : typeof v === "boolean" ? +v : 0; });
reg("VALUE,NUMBERVALUE", (a) => { const v = scalar(a[0]); if (typeof v === "number") return v; const p = parseInput(s1(v)); return typeof p.value === "number" ? p.value : ERR["#VALUE!"]; });
reg("TEXT", (a) => format(scalar(a[0]), s1(a[1])).text);
reg("FIXED", (a) => { const d = n1(opt(a, 1, 2)); return format(roundTo(n1(a[0]), d), (b1(opt(a, 2, false)) ? "0" : "#,##0") + (d > 0 ? "." + "0".repeat(d) : "")).text; });
reg("DOLLAR", (a) => { const d = n1(opt(a, 1, 2)); return format(n1(a[0]), "£#,##0" + (d > 0 ? "." + "0".repeat(d) : "")).text; });
reg("TEXTBEFORE", (a) => { const s = s1(a[0]), d = s1(a[1]); const i = s.indexOf(d); return i < 0 ? ERR["#N/A"] : s.slice(0, i); });
reg("TEXTAFTER", (a) => { const s = s1(a[0]), d = s1(a[1]); const i = s.indexOf(d); return i < 0 ? ERR["#N/A"] : s.slice(i + d.length); });

// dates and times (serials, like Excel)
const today = () => { const d = new Date(); return serial(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
reg("TODAY", vol(() => today()));
reg("NOW", vol(() => { const d = new Date(); return today() + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; }));
reg("DATE", (a) => { let y = Math.floor(n1(a[0])); if (y < 1900) y += 1900; const s = serial(y, Math.floor(n1(a[1])), Math.floor(n1(a[2]))); return s < 0 ? ERR["#NUM!"] : s; });
reg("TIME", (a) => ((n1(a[0]) * 3600 + n1(a[1]) * 60 + n1(a[2])) / 86400) % 1);
const dpart = (f) => (a) => { const x = n1(a[0]); return x < 0 ? ERR["#NUM!"] : f(fromSerial(x), x); };
reg("YEAR", dpart((d) => d.y));
reg("MONTH", dpart((d) => d.m));
reg("DAY", dpart((d) => d.d));
reg("HOUR", (a) => Math.floor(((n1(a[0]) % 1) * 24) + 1e-9));
reg("MINUTE", (a) => Math.floor((((n1(a[0]) % 1) * 1440) + 1e-9) % 60));
reg("SECOND", (a) => Math.round(((n1(a[0]) % 1) * 86400)) % 60);
reg("WEEKDAY", (a) => { const d = fromSerial(n1(a[0])).wd; const t = n1(opt(a, 1, 1)); return t === 2 ? ((d + 6) % 7) + 1 : t === 3 ? (d + 6) % 7 : d + 1; });
reg("WEEKNUM,ISOWEEKNUM", (a, ctx, node) => { const x = n1(a[0]); const d = fromSerial(x); if (node?.name === "ISOWEEKNUM" || n1(opt(a, 1, 1)) === 21) { const dt = new Date(Date.UTC(d.y, d.m - 1, d.d)); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const first = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return 1 + Math.round(((dt - first) / DAY - 3 + ((first.getUTCDay() + 6) % 7)) / 7); } const jan1 = serial(d.y, 1, 1); const start = n1(opt(a, 1, 1)) === 2 ? (fromSerial(jan1).wd + 6) % 7 : fromSerial(jan1).wd; return Math.floor((x - jan1 + start) / 7) + 1; });
const addMonths = (x, n) => { const d = fromSerial(x); const t = new Date(Date.UTC(d.y, d.m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return serial(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d.d, last)); };
reg("EDATE", (a) => addMonths(Math.floor(n1(a[0])), Math.trunc(n1(a[1]))));
reg("EOMONTH", (a) => { const d = fromSerial(n1(a[0])); const t = new Date(Date.UTC(d.y, d.m + Math.trunc(n1(a[1])), 0)); return serial(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); });
reg("DAYS", (a) => Math.floor(n1(a[0])) - Math.floor(n1(a[1])));
reg("DATEDIF", (a) => { const s = Math.floor(n1(a[0])), e = Math.floor(n1(a[1])); if (s > e) return ERR["#NUM!"]; const u = s1(a[2]).toUpperCase(); const A = fromSerial(s), B = fromSerial(e); let months = (B.y - A.y) * 12 + B.m - A.m - (B.d < A.d ? 1 : 0); return { D: e - s, M: months, Y: Math.floor(months / 12), YM: months % 12, MD: B.d >= A.d ? B.d - A.d : e - addMonths(s, months) , YD: e - serial(B.y - (B.m < A.m || (B.m === A.m && B.d < A.d) ? 1 : 0), A.m, A.d) }[u] ?? ERR["#NUM!"]; });
const holidays = (v) => new Set(v === undefined ? [] : nums([v]).map(Math.floor));
const workday = (x, hol) => { const wd = fromSerial(x).wd; return wd !== 0 && wd !== 6 && !hol.has(x); };
reg("NETWORKDAYS", (a) => { let s = Math.floor(n1(a[0])), e = Math.floor(n1(a[1])), sign = 1; if (s > e) { [s, e] = [e, s]; sign = -1; } const hol = holidays(a[2]); let n = 0; for (let x = s; x <= e; x++) if (workday(x, hol)) n++; return n * sign; });
reg("WORKDAY", (a) => { let x = Math.floor(n1(a[0])); let n = Math.trunc(n1(a[1])); const step = n < 0 ? -1 : 1; const hol = holidays(a[2]); while (n !== 0) { x += step; if (workday(x, hol)) n -= step; } return x; });
reg("DATEVALUE", (a) => { const p = parseInput(s1(a[0])); return p.type === "date" ? Math.floor(p.value) : ERR["#VALUE!"]; });
reg("TIMEVALUE", (a) => { const p = parseInput(s1(a[0])); return typeof p.value === "number" && p.type === "time" ? p.value % 1 : ERR["#VALUE!"]; });

// information
reg("ISBLANK", (a) => scalar(a[0]) == null);
reg("ISNUMBER", (a) => typeof scalar(a[0]) === "number");
reg("ISTEXT", (a) => typeof scalar(a[0]) === "string");
reg("ISNONTEXT", (a) => typeof scalar(a[0]) !== "string");
reg("ISLOGICAL", (a) => typeof scalar(a[0]) === "boolean");
reg("ISERROR", (a) => isErr(scalar(a[0])));
reg("ISERR", (a) => isErr(scalar(a[0])) && scalar(a[0]) !== ERR["#N/A"]);
reg("ISNA", (a) => scalar(a[0]) === ERR["#N/A"]);
reg("ISEVEN", (a) => Math.floor(Math.abs(n1(a[0]))) % 2 === 0);
reg("ISODD", (a) => Math.floor(Math.abs(n1(a[0]))) % 2 === 1);
reg("NA", () => ERR["#N/A"]);

// money
reg("PMT", (a) => { const r = n1(a[0]), n = n1(a[1]), pv = n1(a[2]), fv = n1(opt(a, 3, 0)), t = n1(opt(a, 4, 0)); if (r === 0) return -(pv + fv) / n; const f = Math.pow(1 + r, n); return -(r * (fv + pv * f)) / ((1 + r * t) * (f - 1)); });
reg("FV", (a) => { const r = n1(a[0]), n = n1(a[1]), pmt = n1(opt(a, 2, 0)), pv = n1(opt(a, 3, 0)), t = n1(opt(a, 4, 0)); if (r === 0) return -(pv + pmt * n); const f = Math.pow(1 + r, n); return -(pv * f + pmt * (1 + r * t) * (f - 1) / r); });
reg("PV", (a) => { const r = n1(a[0]), n = n1(a[1]), pmt = n1(opt(a, 2, 0)), fv = n1(opt(a, 3, 0)), t = n1(opt(a, 4, 0)); if (r === 0) return -(fv + pmt * n); const f = Math.pow(1 + r, n); return -(fv + pmt * (1 + r * t) * (f - 1) / r) / f; });
reg("NPER", (a) => { const r = n1(a[0]), pmt = n1(a[1]), pv = n1(a[2]), fv = n1(opt(a, 3, 0)), t = n1(opt(a, 4, 0)); if (r === 0) return -(pv + fv) / pmt; const z = pmt * (1 + r * t) / r; return finite(Math.log((z - fv) / (z + pv)) / Math.log(1 + r)); });
reg("NPV", (a) => { const r = n1(a[0]); return nums(a.slice(1)).reduce((s, v, i) => s + v / Math.pow(1 + r, i + 1), 0); });
const solve = (f, guess) => { let x = guess; for (let i = 0; i < 100; i++) { const y = f(x), d = (f(x + 1e-7) - y) / 1e-7; if (!Number.isFinite(d) || d === 0) break; const nx = x - y / d; if (Math.abs(nx - x) < 1e-10) return nx; x = nx; } return ERR["#NUM!"]; };
reg("IRR", (a) => { const v = nums([a[0]]); return solve((r) => v.reduce((s, x, i) => s + x / Math.pow(1 + r, i), 0), n1(opt(a, 1, 0.1))); });
reg("RATE", (a) => { const n = n1(a[0]), pmt = n1(a[1]), pv = n1(a[2]), fv = n1(opt(a, 3, 0)), t = n1(opt(a, 4, 0)); return solve((r) => (r === 0 ? pv + pmt * n + fv : pv * Math.pow(1 + r, n) + pmt * (1 + r * t) * (Math.pow(1 + r, n) - 1) / r + fv), n1(opt(a, 5, 0.1))); });

// ------------------------------------------------------------------------------------------------ what's typed into a cell

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * What someone typed: a number (with the format it suggests: "£1,200.50", "12%", "13/11/2026", "09:30"), TRUE/FALSE,
 * an error, or text. $dmy: day before month (UK and most of the world) or month first (US).
 */
function parseInput(raw, { dmy = true } = {}) {
  const s = String(raw).trim();
  if (s === "") return { value: null };
  if (/^(true|false)$/i.test(s)) return { value: s.toUpperCase() === "TRUE" };
  const errMatch = ERRORS.find((e) => e === s.toUpperCase());
  if (errMatch) return { value: ERR[errMatch] };
  let m;
  if ((m = /^([-+]?)\s*([£$€¥]?)\s*([-+]?)(\d{1,3}(,\d{3})+|\d*)(\.\d+)?\s*(%?)$/.exec(s)) && (m[4] !== "" || m[6])) {
    const neg = m[1] === "-" || m[3] === "-";
    let v = parseFloat((m[4].replace(/,/g, "") || "0") + (m[6] || ""));
    if (neg) v = -v;
    const decimals = m[6] ? m[6].length - 1 : 0;
    if (m[7]) return { value: v / 100, format: decimals ? "0." + "0".repeat(decimals) + "%" : "0%" };
    if (m[2]) return { value: v, format: `${m[2]}#,##0${decimals ? ".00" : ""}` };
    if (m[5]) return { value: v, format: "#,##0" + (decimals ? "." + "0".repeat(decimals) : "") };
    return { value: v };
  }
  if ((m = /^([-+]?\d+\.?\d*)[eE]([-+]?\d+)$/.exec(s))) return { value: parseFloat(s), format: "0.00E+00" };
  // Dates: 13/11/2026, 13-11-26, 2026-11-13, 13 Nov 2026, Nov 13 2026; with an optional time
  const time = (t) => { const x = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t.trim()); if (!x) return null; let h = +x[1]; if (x[4]) { if (h > 12) return null; h = (h % 12) + (x[4].toLowerCase() === "pm" ? 12 : 0); } if (h > 23 || +x[2] > 59) return null; return (h * 3600 + +x[2] * 60 + +(x[3] || 0)) / 86400; };
  const tOnly = time(s);
  if (tOnly !== null) return { value: tOnly, type: "time", format: /[ap]m/i.test(s) ? "h:mm AM/PM" : s.split(":").length > 2 ? "hh:mm:ss" : "hh:mm" };
  const [datePart, ...rest] = s.split(/\s+(?=\d{1,2}:\d{2})/);
  const t = rest.length ? time(rest.join(" ")) : 0;
  if (t === null) return { value: s };
  let y, mo, d;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(datePart))) [d, mo, y] = dmy ? [+m[1], +m[2], +m[3]] : [+m[2], +m[1], +m[3]];
  else if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})$/.exec(datePart)) && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) [d, mo, y] = [+m[1], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[3]];
  else if ((m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(datePart)) && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) [mo, d, y] = [MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2], +m[3]];
  else return { value: s };
  if (y < 100) y += y < 50 ? 2000 : 1900;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { value: s };
  return { value: serial(y, mo, d) + t, type: "date", format: rest.length ? (dmy ? "dd/mm/yyyy hh:mm" : "mm/dd/yyyy hh:mm") : /^\d{4}-/.test(datePart) ? "yyyy-mm-dd" : /[A-Za-z]/.test(datePart) ? "d mmm yyyy" : dmy ? "dd/mm/yyyy" : "mm/dd/yyyy" };
}

// ------------------------------------------------------------------------------------------------ number formats

/** Like Excel's General: up to 11 significant digits, then scientific. */
function formatGeneral(v) {
  if (typeof v !== "number") return v == null ? "" : isErr(v) ? v.code : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
  if (!Number.isFinite(v)) return "#NUM!";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e11 || a < 1e-9) return v.toExponential(5).replace(/\.?0+e/, "E").replace(/E([+-])(\d)$/, "E$10$2").toUpperCase();
  const s = String(Number(v.toPrecision(11)));
  return s.includes("e") ? v.toFixed(10).replace(/\.?0+$/, "") : s;
}
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** A format's sections (positive;negative;zero;text), split outside quotes. */
const sections = (fmt) => { const out = [""]; let q = false; for (let i = 0; i < fmt.length; i++) { const ch = fmt[i]; if (ch === '"') q = !q; if (ch === "\\" && !q) { out[out.length - 1] += ch + (fmt[++i] ?? ""); continue; } if (ch === ";" && !q) out.push(""); else out[out.length - 1] += ch; } return out; };
/** A value in an Excel number format: { text, color }. */
function format(v, fmt) {
  if (v == null) return { text: "" };
  if (isErr(v)) return { text: v.code };
  if (!fmt || /^general$/i.test(fmt)) return { text: formatGeneral(v) };
  const secs = sections(fmt);
  if (typeof v === "string" || typeof v === "boolean") {
    const textSec = secs.length >= 4 ? secs[3] : secs.find((s) => s.includes("@"));
    const sv = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v;
    return { text: textSec ? literal(textSec.replace(/@/g, "\u0000")).replace(/\u0000/g, sv) : sv };
  }
  let sec = secs[0], val = v;
  // [Red], [>100] and the like
  if (secs.length > 1 && v < 0) { sec = secs[1]; val = -v; } else if (secs.length > 2 && v === 0) sec = secs[2];
  let color = null;
  sec = sec.replace(/\[(red|blue|green|black|white|magenta|cyan|yellow|color\s*\d+)\]/gi, (m, c) => { color = c.toLowerCase(); return ""; }).replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, (m, sym) => sym).replace(/\[>=?<?=?-?\d+\]/g, "");
  if (/(^|[^"\\])[dmyhs]|\[h\]|AM\/PM|A\/P/i.test(sec.replace(/"[^"]*"/g, ""))) return { text: formatDate(val, sec), color };
  const neg = val < 0 && secs.length === 1;
  return { text: (neg ? "-" : "") + formatNumber(Math.abs(val), sec), color };
}
/** Quoted text and \x as themselves; _x as a space; *x dropped. */
const literal = (s) => s.replace(/"([^"]*)"|\\(.)|_(.)|\*(.)/g, (m, q, e, u) => (q !== undefined ? q : e !== undefined ? e : u !== undefined ? " " : ""));
function formatNumber(v, sec) {
  // Pieces of the format that aren't number placeholders stay as they are.
  const plain = sec.replace(/"[^"]*"|\\./g, (m) => "\u0001".repeat(m.length));
  if (/%/.test(plain)) v *= 100 ** (plain.match(/%/g).length);
  const sci = /E[+-]/i.exec(plain);
  const first = plain.search(/[0#?]/);
  if (first < 0) return literal(sec);
  let last = first;
  for (let i = first; i < plain.length; i++) if (/[0#?.,]/.test(plain[i]) || (sci && i >= sci.index && i < sci.index + 2 + (plain.slice(sci.index + 2).match(/^[0#]+/)?.[0].length || 0))) last = i; else if (!sci || i < sci.index) break;
  const before = sec.slice(0, first), body = sec.slice(first, last + 1), after = sec.slice(last + 1);
  let out;
  if (sci) {
    const [mant, expPat] = body.split(/E[+-]/i);
    const decs = (mant.split(".")[1] || "").length;
    const exp = v === 0 ? 0 : Math.floor(Math.log10(v));
    const m = v / Math.pow(10, exp);
    out = m.toFixed(decs) + "E" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart((expPat || "00").length, "0");
  } else {
    const [ip, dp = ""] = body.split(".");
    const comma = ip.includes(",");
    let scale = 0;
    let ipat = ip;
    while (ipat.endsWith(",")) { ipat = ipat.slice(0, -1); scale++; }
    v /= Math.pow(1000, scale);
    const minDec = (dp.match(/0/g) || []).length, maxDec = (dp.match(/[0#?]/g) || []).length;
    let s = roundTo(v, maxDec).toFixed(maxDec);
    let [i, d = ""] = s.split(".");
    while (d.length > minDec && d.endsWith("0")) d = d.slice(0, -1);
    const minInt = (ipat.match(/0/g) || []).length;
    if (i === "0" && minInt === 0) i = "";
    i = i.padStart(minInt, "0");
    if (comma) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    out = i + (dp ? "." + d : "");
    if (dp && !d && !/[0]/.test(dp)) out = i + ".";
  }
  return literal(before) + out + literal(after);
}
function formatDate(v, sec) {
  const days = Math.floor(v), secs = Math.round((v - days) * 86400);
  const d = fromSerial(days);
  const H = Math.floor(secs / 3600), M = Math.floor((secs % 3600) / 60), S = secs % 60;
  const ampm = /AM\/PM|A\/P/i.test(sec);
  const h12 = H % 12 || 12;
  const toks = sec.match(/"[^"]*"|\\.|\[h+\]|\[m+\]|AM\/PM|A\/P|y+|m+|d+|h+|s+|./gi) || [];
  // "m" is minutes after an hour or before seconds; months otherwise.
  return toks.map((t, i) => {
    const lt = t.toLowerCase();
    if (t[0] === '"') return t.slice(1, -1);
    if (t[0] === "\\") return t[1];
    if (/^\[h+\]$/.test(lt)) return String(days * 24 + H).padStart(lt.length - 2, "0");
    if (/^am\/pm$/.test(lt)) return H < 12 ? "AM" : "PM";
    if (lt === "a/p") return H < 12 ? "A" : "P";
    if (lt[0] === "y") return lt.length <= 2 ? String(d.y).slice(-2) : String(d.y);
    if (lt[0] === "d") return lt.length === 1 ? String(d.d) : lt.length === 2 ? String(d.d).padStart(2, "0") : lt.length === 3 ? DAYS_LONG[d.wd].slice(0, 3) : DAYS_LONG[d.wd];
    if (lt[0] === "h") return String(ampm ? h12 : H).padStart(lt.length, "0");
    if (lt[0] === "s") return String(S).padStart(lt.length, "0");
    if (lt[0] === "m") {
      const prev = toks.slice(0, i).reverse().find((x) => /^\[?[a-z]/i.test(x) && !/^(am\/pm|a\/p)$/i.test(x));
      const nextTok = toks.slice(i + 1).find((x) => /^[a-z]/i.test(x));
      if ((prev && /^\[?h/i.test(prev)) || (nextTok && /^s/i.test(nextTok))) return String(M).padStart(lt.length, "0");
      return lt.length === 1 ? String(d.m) : lt.length === 2 ? String(d.m).padStart(2, "0") : lt.length === 3 ? MONTHS_LONG[d.m - 1].slice(0, 3) : lt.length === 5 ? MONTHS_LONG[d.m - 1][0] : MONTHS_LONG[d.m - 1];
    }
    return t;
  }).join("");
}

// ------------------------------------------------------------------------------------------------ rewriting formulas

/** References in a formula moved by (dr, dc): copying or filling. Absolute parts ($) stay. Off the sheet → #REF!. */
function shift(src, dr, dc) {
  return rewrite(src, (t) => {
    const v = { ...t.v };
    const mv = (k, a, d, max) => { if (!v[a]) { v[k] += d; if (v[k] < 0 || v[k] >= max) return false; } return true; };
    if (t.t === "ref") return mv("r", "ar", dr, MAX_ROWS) && mv("c", "ac", dc, MAX_COLS) ? v : null;
    if (v.cols) return mv("c1", "ac1", dc, MAX_COLS) && mv("c2", "ac2", dc, MAX_COLS) ? v : null;
    if (v.rowsOnly) return mv("r1", "ar1", dr, MAX_ROWS) && mv("r2", "ar2", dr, MAX_ROWS) ? v : null;
    return mv("r1", "ar1", dr, MAX_ROWS) && mv("c1", "ac1", dc, MAX_COLS) && mv("r2", "ar2", dr, MAX_ROWS) && mv("c2", "ac2", dc, MAX_COLS) ? v : null;
  });
}
/**
 * References after rows (axis "r") or columns ("c") are inserted (n > 0) or deleted (n < 0) at $at on $sheet, from a
 * formula on $here. References into deleted cells become #REF!; ranges shrink or grow.
 */
function adjust(src, here, sheet, axis, at, n) {
  return rewrite(src, (t) => {
    if ((t.v.sheet ?? here) !== sheet) return t.v;
    const v = { ...t.v };
    const move = (x) => (n > 0 ? (x >= at ? x + n : x) : x >= at - n ? x + n : x >= at ? null : x);
    if (t.t === "ref") { const k = axis; const x = move(v[k]); if (x === null) return null; v[k] = x; return v; }
    if ((axis === "r" && v.cols) || (axis === "c" && v.rowsOnly)) return v;
    const k1 = axis + "1", k2 = axis + "2";
    let a = v[k1], b = v[k2];
    if (n > 0) { if (a >= at) a += n; if (b >= at) b += n; }
    else { const lo = at, hi = at - n - 1; if (a > hi) a += n; else if (a >= lo) a = lo; if (b > hi) b += n; else if (b >= lo) b = lo - 1; if (b < a) return null; }
    v[k1] = a; v[k2] = b;
    return v;
  });
}
/** References to a renamed sheet follow it. */
function renameSheet(src, from, to) { return rewrite(src, (t) => (t.v.sheet === from ? { ...t.v, sheet: to } : t.v)); }
function rewrite(src, fn) {
  const body = src.replace(/^=/, "");
  let toks;
  try { toks = tokenize(body); } catch { return src; }
  let out = "", pos = 0;
  for (const t of toks) {
    if (t.t !== "ref" && t.t !== "range") continue;
    const v = fn(t);
    out += body.slice(pos, t.s) + (v ? refText(t.t, v) : "#REF!");
    pos = t.e;
  }
  return "=" + out + body.slice(pos);
}
function refText(type, v) {
  const sh = v.sheet != null ? quoteSheet(v.sheet) + "!" : "";
  const col = (c, abs) => (abs ? "$" : "") + colName(c);
  const row = (r, abs) => (abs ? "$" : "") + (r + 1);
  if (type === "ref") return sh + col(v.c, v.ac) + row(v.r, v.ar);
  if (v.cols) return sh + col(v.c1, v.ac1) + ":" + col(v.c2, v.ac2);
  if (v.rowsOnly) return sh + row(v.r1, v.ar1) + ":" + row(v.r2, v.ar2);
  return sh + col(v.c1, v.ac1) + row(v.r1, v.ar1) + ":" + col(v.c2, v.ac2) + row(v.r2, v.ar2);
}

// ------------------------------------------------------------------------------------------------ the calculator

/**
 * Formulas across a workbook, calculated in dependency order. Cells are keys "Sheet!r,c". $read(sheet, r, c) gives a
 * cell's own (typed) value; formulas are held here. set() a formula or clear() it, then recalc(changed keys) works
 * out everything depending on them (directly or through ranges), each once; circular references give #CIRC!.
 */
class Calc {
  constructor(read, { has, used } = {}) {
    this.read = read;
    this.hasSheet = has || (() => true);
    this.used = used;
    this.formulas = new Map();   // key → { src, ast, refs: Set<key>, ranges: [{sheet, r1, c1, r2, c2}], volatile }
    this.values = new Map();     // key → calculated value
    this.dependents = new Map(); // key → Set<key>
  }
  static key(sheet, r, c) { return `${sheet}!${r},${c}`; }
  static unkey(k) { const i = k.lastIndexOf("!"); const [r, c] = k.slice(i + 1).split(",").map(Number); return { sheet: k.slice(0, i), r, c }; }
  set(sheet, r, c, src) {
    const key = Calc.key(sheet, r, c);
    this.clear(sheet, r, c, true);
    let ast;
    try { ast = parse(src); } catch (e) { ast = { k: "err", v: "#NAME?", bad: e.message }; }
    const refs = new Set(), ranges = [];
    let volatile = false;
    const walk = (n) => {
      if (!n) return;
      if (n.k === "ref") refs.add(Calc.key(n.sheet ?? sheet, n.r, n.c));
      if (n.k === "range") ranges.push({ sheet: n.sheet ?? sheet, r1: Math.min(n.r1, n.r2), r2: Math.max(n.r1, n.r2), c1: Math.min(n.c1, n.c2), c2: Math.max(n.c1, n.c2) });
      if (n.k === "fn" && FN[n.name]?.volatile) volatile = true;
      for (const x of [n.a, n.b, ...(n.args || [])]) walk(x);
    };
    walk(ast);
    this.formulas.set(key, { src, ast, refs, ranges, volatile, sheet, r, c });
    for (const ref of refs) { if (!this.dependents.has(ref)) this.dependents.set(ref, new Set()); this.dependents.get(ref).add(key); }
  }
  clear(sheet, r, c, keepValue = false) {
    const key = Calc.key(sheet, r, c);
    const f = this.formulas.get(key);
    if (!f) return;
    for (const ref of f.refs) this.dependents.get(ref)?.delete(key);
    this.formulas.delete(key);
    if (!keepValue) this.values.delete(key);
  }
  /** Everything to calculate again after these cells changed (including themselves if they're formulas). */
  affected(keys) {
    const out = new Set();
    const stack = [...keys];
    const rangeFormulas = [...this.formulas.entries()].filter(([, f]) => f.ranges.length);
    for (const [k, f] of this.formulas) if (f.volatile) stack.push(k);
    while (stack.length) {
      const k = stack.pop();
      if (this.formulas.has(k) && !out.has(k)) out.add(k);
      const { sheet, r, c } = Calc.unkey(k);
      for (const d of this.dependents.get(k) || []) if (!out.has(d)) { out.add(d); stack.push(d); }
      for (const [fk, f] of rangeFormulas) {
        if (out.has(fk)) continue;
        if (f.ranges.some((g) => g.sheet === sheet && r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2)) { out.add(fk); stack.push(fk); }
      }
    }
    return out;
  }
  /** Calculate what's affected by $keys (or everything). Returns the formula cells whose value was worked out. */
  recalc(keys = null) {
    const todo = keys ? this.affected(keys) : new Set(this.formulas.keys());
    const state = new Map(); // key → "busy" | "done"
    const ctxFor = (f) => ({
      sheet: f.sheet, row: f.r, col: f.c, has: this.hasSheet, used: this.used,
      get: (sheet, r, c) => {
        const k = Calc.key(sheet, r, c);
        if (this.formulas.has(k)) {
          if (todo.has(k) && state.get(k) !== "done") { if (state.get(k) === "busy") throw ERR["#CIRC!"]; calc(k); }
          return this.values.get(k);
        }
        return this.read(sheet, r, c);
      },
    });
    const calc = (k) => {
      const f = this.formulas.get(k);
      state.set(k, "busy");
      let v;
      try { v = evaluate(f.ast, ctxFor(f)); } catch (e) { if (e instanceof FErr) v = e; else throw e; }
      if (v === undefined) v = 0;
      this.values.set(k, v);
      state.set(k, "done");
    };
    for (const k of todo) if (state.get(k) !== "done") { try { calc(k); } catch (e) { if (e === ERR["#CIRC!"]) { for (const [kk, st] of state) if (st === "busy") { this.values.set(kk, ERR["#CIRC!"]); state.set(kk, "done"); } } else throw e; } }
    return todo;
  }
  value(sheet, r, c) { return this.values.get(Calc.key(sheet, r, c)); }
}

return { parse, tokenize, evaluate, format, formatGeneral, parseInput, shift, adjust, renameSheet, Calc, Matrix, FErr, ERR, isErr, colName, colIndex, addr,
  serial, fromSerial, compare, FUNCTIONS: Object.keys(FN).sort(), MAX_ROWS, MAX_COLS, quoteSheet };
});
