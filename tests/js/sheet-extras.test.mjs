// node --test tests/js/sheet-extras.test.mjs — conditional formatting, charts and pivot tables: working them out,
// editing them together, and keeping them in .xlsx files (ours, and ones LibreOffice wrote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const X = require("../../assets/office/sheet-extras.js");
const M = require("../../assets/office/sheet-model.js");
const O = require("../../assets/office/ooxml.js");
const F = require("../../assets/office/formula.js");
const { Session } = require("../../assets/office/collab.js");
const soffice = ["/usr/bin/soffice", "/usr/bin/libreoffice"].find(existsSync);
const here = new URL(".", import.meta.url).pathname;

const grid = (rows) => (r, c) => rows[r]?.[c] ?? null;
const evalWith = (read) => (src, r, c) => F.evaluate(F.parse(src), { sheet: "S", row: r, col: c, has: () => true, get: (s, rr, cc) => read(rr, cc) });
const cf = (rules, rows) => { const read = grid(rows); return X.conditional(rules.map((x, i) => ({ id: "r" + i, pri: i, style: {}, ...x })), read, evalWith(read)); };
const col = (r1, r2, c = 0) => [{ r1, c1: c, r2, c2: c }];

test("conditional formatting: comparisons, text, top 10, averages, duplicates, blanks", () => {
  const rows = [[5], [10], [15], ["Apple pie"], [null], [10]];
  const red = { bg: "#ffc7ce" };
  const at = (rule, r) => cf([{ ranges: col(0, 5), rule, style: red }], rows).at(r, 0)?.bg === "#ffc7ce";
  assert.deepEqual([0, 1, 2].map((r) => at({ type: "cell", op: "gt", a: "7" }, r)), [false, true, true]);
  assert.deepEqual([0, 1, 2].map((r) => at({ type: "cell", op: "between", a: "6", b: "12" }, r)), [false, true, false]);
  assert.ok(!at({ type: "cell", op: "gt", a: "7" }, 4), "a blank is never greater than");
  assert.ok(at({ type: "text", op: "contains", text: "PIE" }, 3), "text matches ignore case");
  assert.ok(at({ type: "text", op: "begins", text: "apple" }, 3));
  assert.deepEqual([0, 1, 2].map((r) => at({ type: "top", n: 1 }, r)), [false, false, true]);
  assert.deepEqual([0, 1, 2].map((r) => at({ type: "top", n: 1, bottom: true }, r)), [true, false, false]);
  assert.deepEqual([0, 1, 2].map((r) => at({ type: "avg" }, r)), [false, false, true], "average of 5, 10, 15, 10 is 10");
  assert.deepEqual([0, 1, 2, 5].map((r) => at({ type: "dup" }, r)), [false, true, false, true]);
  assert.ok(at({ type: "blank" }, 4) && !at({ type: "blank" }, 0));
  // A formula rule, relative to the range's top left: the cell is more than the one above it.
  const rel = cf([{ ranges: col(1, 2), rule: { type: "expr", f: "A2>A1" }, style: red }], rows);
  assert.equal(rel.at(1, 0)?.bg, "#ffc7ce"); assert.equal(rel.at(2, 0)?.bg, "#ffc7ce");
});

test("conditional formatting: priority, stop if true, colour scales, data bars and icons", () => {
  const rows = [[0], [50], [100]];
  const first = { ranges: col(0, 2), rule: { type: "cell", op: "ge", a: "50" }, style: { bg: "#111111" } };
  const second = { ranges: col(0, 2), rule: { type: "cell", op: "ge", a: "0" }, style: { bg: "#222222", b: true } };
  const c = cf([first, second], rows);
  assert.deepEqual(c.at(2, 0), { bg: "#111111", b: true }, "the higher rule wins the fill; the lower still adds bold");
  assert.deepEqual(cf([{ ...first, stop: true }, second], rows).at(2, 0), { bg: "#111111" }, "stop if true");
  const scale = cf([{ ranges: col(0, 2), rule: { type: "scale", stops: [{ kind: "min", color: "#000000" }, { kind: "max", color: "#ffffff" }] } }], rows);
  assert.deepEqual([0, 1, 2].map((r) => scale.at(r, 0).bg), ["#000000", "#808080", "#ffffff"]);
  const bar = cf([{ ranges: col(0, 2), rule: { type: "bar", color: "#638ec6" } }], rows);
  assert.deepEqual(bar.at(1, 0).bar, { from: 0, to: 0.5, color: "#638ec6", neg: false });
  const icons = cf([{ ranges: col(0, 2), rule: { type: "icons", set: "3Arrows" } }], rows);
  assert.deepEqual([0, 1, 2].map((r) => icons.at(r, 0).icon.g), ["↓", "→", "↑"]);
});

test("charts: series from a table with headings; data and SVG", () => {
  const rows = [["Month", "Coffee", "Note", "Tea"], ["Jan", 10, "x", 4], ["Feb", 20, "y", 6]];
  const series = X.seriesFrom("Shop's sales", { r1: 0, c1: 0, r2: 2, c2: 3 }, grid(rows), false);
  // Wider than tall, as in Excel: a series per row unless asked.
  assert.deepEqual(X.seriesFrom("S", { r1: 0, c1: 0, r2: 2, c2: 3 }, grid(rows)).map((x) => x.val), ["S!$B$2:$D$2", "S!$B$3:$D$3"]);
  assert.deepEqual(series, [
    { name: "'Shop''s sales'!$B$1", cat: "'Shop''s sales'!$A$2:$A$3", val: "'Shop''s sales'!$B$2:$B$3" },
    { name: "'Shop''s sales'!$D$1", cat: "'Shop''s sales'!$A$2:$A$3", val: "'Shop''s sales'!$D$2:$D$3" },
  ], "the text column isn't a series");
  const read = (s, r, c) => (s === "Shop's sales" ? grid(rows)(r, c) : null);
  const data = X.chartData({ type: "column", series }, read, (s, r, c) => String(read(s, r, c) ?? ""));
  assert.deepEqual(data, { cats: ["Jan", "Feb"], series: [{ name: "Coffee", vals: [10, 20] }, { name: "Tea", vals: [4, 6] }] });
  for (const type of ["column", "bar", "line", "area", "pie", "doughnut", "scatter"]) {
    const svg = X.chartSvg({ type, title: "Sales <& more>" }, data, 400, 260);
    assert.match(svg, /^<svg [^>]*width="400" height="260"/);
    assert.ok(svg.includes("Sales &lt;&amp; more&gt;") && !svg.includes("<&"), `${type}: title escaped`);
  }
  assert.deepEqual(X.ticks(0, 95, 5), [0, 20, 40, 60, 80, 100]);
});

test("pivot tables: rows, columns, several values, blanks, every summary", () => {
  const t = [["Region", "Product", "Sales", "Units"], ["North", "Beans", 100, 2], ["South", "Beans", 50, 1], ["North", "Cups", 30, 3], [null, "Cups", 20, 5], ["North", "Beans", 20, 1]];
  const v = (def) => X.pivot(t, def).cells.map((r) => r.map((c) => c.v));
  assert.deepEqual(v({ rows: ["Region"], vals: [{ field: "Sales", fn: "sum" }] }), [["Region", "Sum of Sales"], ["North", 150], ["South", 50], ["(blank)", 20], ["Grand Total", 220]]);
  assert.deepEqual(v({ rows: ["Region"], cols: ["Product"], vals: [{ field: "Sales", fn: "sum" }] }), [
    ["Sum of Sales", "Product"], ["Region", "Beans", "Cups", "Grand Total"], ["North", 120, 30, 150], ["South", 50, null, 50], ["(blank)", null, 20, 20], ["Grand Total", 170, 50, 220]]);
  assert.deepEqual(v({ rows: ["Product"], vals: ["count", "average", "max", "min"].map((fn) => ({ field: "Units", fn })) }), [
    ["Product", "Count of Units", "Average of Units", "Max of Units", "Min of Units"], ["Beans", 3, 4 / 3, 2, 1], ["Cups", 2, 4, 5, 3], ["Grand Total", 5, 12 / 5, 5, 1]]);
  assert.deepEqual(v({ rows: [], vals: [{ field: "Sales", fn: "sum" }] }), [["", "Sum of Sales"], ["Total", 220]]);
  assert.match(X.pivot(t, { rows: ["Nope"], vals: [] }).error, /isn't in the source/);
});

test("objects follow inserted and deleted rows and columns, and renamed sheets; undo puts them back", () => {
  const wb = { sheets: [M.blank("a", "Data"), M.blank("b", "Report")] };
  const set = (kind, sheet, id, data) => M.apply(wb, { t: "obj", sheet, kind, id, data });
  set("cf", "a", "r1", { ranges: [{ r1: 2, c1: 1, r2: 9, c2: 1 }], pri: 0, rule: { type: "expr", f: "B3>$C$1" }, style: { b: true } });
  set("chart", "b", "c1", { type: "line", series: [{ name: "Data!$B$2", cat: "Data!$A$3:$A$10", val: "Data!$B$3:$B$10" }], anchor: { r: 4, c: 2, dx: 0, dy: 0, w: 300, h: 200 } });
  set("pivot", "b", "p1", { src: "Data!$A$2:$B$10", at: { r: 0, c: 0 }, rows: ["Month"], vals: [{ field: "Sales", fn: "sum" }], size: { rows: 3, cols: 2 } });
  const inv = M.inverse(wb, { t: "ins", sheet: "a", name: "Data", axis: "r", at: 0, n: 2 });
  M.apply(wb, { t: "ins", sheet: "a", name: "Data", axis: "r", at: 0, n: 2 });
  assert.deepEqual(wb.sheets[0].cf[0].ranges, [{ r1: 4, c1: 1, r2: 11, c2: 1 }]);
  assert.equal(wb.sheets[0].cf[0].rule.f, "B5>$C$3", "its formula follows the cells");
  assert.deepEqual(wb.sheets[1].charts[0].series[0], { name: "Data!$B$4", cat: "Data!$A$5:$A$12", val: "Data!$B$5:$B$12" });
  assert.deepEqual(wb.sheets[1].charts[0].anchor, { r: 4, c: 2, dx: 0, dy: 0, w: 300, h: 200 }, "on another sheet: it stays put");
  assert.equal(wb.sheets[1].pivots[0].src, "Data!$A$4:$B$12");
  M.apply(wb, inv);
  assert.equal(wb.sheets[1].pivots[0].src, "Data!$A$2:$B$10", "undone");
  M.apply(wb, { t: "sheetName", id: "a", name: "Sales 2026" });
  assert.equal(wb.sheets[1].charts[0].series[0].val, "'Sales 2026'!$B$3:$B$10");
  assert.equal(wb.sheets[1].pivots[0].src, "'Sales 2026'!$A$2:$B$10");
  // Undoing the delete of an object brings it back; deleting all the rows its data is in removes it.
  const back = M.inverse(wb, { t: "obj", sheet: "b", kind: "chart", id: "c1", data: null });
  M.apply(wb, { t: "obj", sheet: "b", kind: "chart", id: "c1", data: null });
  assert.equal(wb.sheets[1].charts.length, 0);
  M.apply(wb, back);
  assert.equal(wb.sheets[1].charts[0].id, "c1");
  M.apply(wb, { t: "del", sheet: "a", name: "Sales 2026", axis: "r", at: 2, n: 8 });
  assert.equal(wb.sheets[0].cf.length, 0);
  assert.equal(wb.sheets[1].charts.length, 0);
  assert.equal(wb.sheets[1].pivots[0].src, "'Sales 2026'!$A$2:$B$2", "the pivot's heading row is still there");
});

test("together: a chart added while someone inserts rows above its data comes out the same for both", () => {
  const start = { sheets: [M.blank("a", "Data")] };
  const server = [];
  const people = [0, 1].map((i) => new Session(M, M.clone(start), { client: "c" + i, seq: 0 }));
  const sync = (p) => { const batch = p.take(); if (batch) for (const x of batch) server.push({ seq: server.length + 1, client: p.client, seen: x.seen, op: JSON.parse(JSON.stringify(x.op)) }); p.receive(server.filter((s) => s.seq > p.seq)); };
  people[0].local({ t: "obj", sheet: "a", kind: "chart", id: "c1", data: { type: "column", series: [{ name: null, cat: "Data!$A$2:$A$5", val: "Data!$B$2:$B$5" }], anchor: { r: 1, c: 4, dx: 0, dy: 0, w: 300, h: 200 } } });
  people[0].local({ t: "obj", sheet: "a", kind: "cf", id: "r1", data: { ranges: [{ r1: 1, c1: 1, r2: 4, c2: 1 }], pri: 0, rule: { type: "bar" }, style: {} } });
  people[1].local({ t: "ins", sheet: "a", name: "Data", axis: "r", at: 0, n: 3 });
  sync(people[1]); sync(people[0]); sync(people[1]); sync(people[0]);
  const state = (p) => JSON.stringify(p.view.sheets.map((s) => [s.charts, s.cf]));
  assert.equal(state(people[0]), state(people[1]));
  assert.equal(people[0].view.sheets[0].charts[0].series[0].val, "Data!$B$5:$B$8");
  assert.equal(people[0].view.sheets[0].charts[0].anchor.r, 4);
  assert.deepEqual(people[1].view.sheets[0].cf[0].ranges, [{ r1: 4, c1: 1, r2: 7, c2: 1 }]);
});

async function workbook() {
  const s1 = M.blank("s1", "Sales"), s2 = M.blank("s2", "Summary");
  const rows = [["Region", "Product", "Sales", "Units"], ["North", "Beans", 100, 2], ["South", "Beans", 50, 1], ["North", "Cups", 30, 3]];
  rows.forEach((r, i) => r.forEach((v, c) => s1.cells.set(`${i},${c}`, { v })));
  s1.cf = [
    { id: "a", ranges: [{ r1: 1, c1: 2, r2: 3, c2: 2 }], pri: 1, rule: { type: "cell", op: "between", a: "40", b: "$D$1" }, style: { bg: "#ffc7ce", color: "#9c0006", b: true } },
    { id: "b", ranges: [{ r1: 1, c1: 0, r2: 3, c2: 0 }, { r1: 1, c1: 1, r2: 3, c2: 1 }], pri: 2, stop: true, rule: { type: "text", op: "ends", text: 'th "x"' }, style: { i: true } },
    { id: "c", ranges: [{ r1: 1, c1: 3, r2: 3, c2: 3 }], pri: 3, rule: { type: "icons", set: "3TrafficLights1", reverse: true, hideValue: true }, style: {} },
    { id: "d", ranges: [{ r1: 1, c1: 2, r2: 3, c2: 2 }], pri: 4, rule: { type: "date", period: "lastMonth" }, style: { u: true } },
    { id: "e", ranges: [{ r1: 1, c1: 2, r2: 3, c2: 2 }], pri: 5, rule: { type: "top", n: 20, percent: true, bottom: true }, style: { s: true } },
  ];
  s1.charts = [{ id: "c1", type: "bar", grouping: "percent", title: "Mix & match", legend: "bottom", labels: true, series: X.seriesFrom("Sales", { r1: 0, c1: 0, r2: 3, c2: 3 }, (r, c) => rows[r]?.[c] ?? null), anchor: { r: 1, c: 5, dx: 4, dy: 2, w: 420, h: 260 } },
    { id: "c2", type: "scatter", series: [{ name: '"Units v sales"', cat: "Sales!$D$2:$D$4", val: "Sales!$C$2:$C$4" }], anchor: { r: 20, c: 5, dx: 0, dy: 0, w: 300, h: 200 } }];
  const def = { src: "Sales!$A$1:$D$4", at: { r: 2, c: 1 }, rows: ["Region"], cols: ["Product"], vals: [{ field: "Sales", fn: "sum" }, { field: "Units", fn: "average" }] };
  const pv = X.pivot(rows, def);
  pv.cells.forEach((row, r) => row.forEach((x, c) => { if (x.v !== null && x.v !== "") s2.cells.set(`${r + 2},${c + 1}`, { v: x.v }); }));
  s2.pivots = [{ id: "p1", ...def, size: { rows: pv.cells.length, cols: Math.max(...pv.cells.map((r) => r.length)) } }];
  const wb = { sheets: [s1, s2] };
  return { wb, bytes: new Uint8Array(await (await O.writeXlsx(wb, (si, r, c) => wb.sheets[si].cells.get(`${r},${c}`)?.v ?? null)).arrayBuffer()) };
}

test("xlsx: conditional formatting, charts and pivot tables come back as they were saved", async () => {
  const { wb, bytes } = await workbook();
  const back = await O.readXlsx(bytes);
  assert.deepEqual(back.unsupported, []);
  const strip = (o) => { const { id, ...d } = o; void id; return d; };
  assert.deepEqual(back.sheets[0].cf.map((o) => { const d = strip(o); delete d.pri; return d; }), wb.sheets[0].cf.map((o) => { const d = strip(o); delete d.pri; if (d.rule.type === "icons") d.rule.stops = [{ kind: "percent", val: "33" }, { kind: "percent", val: "67" }]; return d; }));
  assert.deepEqual(back.sheets[0].charts.map(strip), wb.sheets[0].charts.map((c) => ({ legend: c.type === "bar" ? "bottom" : "none", ...strip(c) })));
  assert.deepEqual(back.sheets[1].pivots.map((p) => { const d = strip(p); delete d.name; return d; }), wb.sheets[1].pivots.map(strip));
  // What Excel needs to find them.
  const files = await O.unzip(bytes);
  const xml = (n) => new TextDecoder().decode(files[n]);
  assert.match(xml("xl/workbook.xml"), /<pivotCaches><pivotCache cacheId="100" r:id="rIdPc1"\/><\/pivotCaches>/);
  assert.match(xml("xl/pivotCache/pivotCacheDefinition1.xml"), /refreshOnLoad="1".*<worksheetSource ref="A1:D4" sheet="Sales"\/>.*<cacheField name="Region" numFmtId="0"><sharedItems count="2"><s v="North"\/><s v="South"\/><\/sharedItems>/);
  assert.match(xml("xl/pivotTables/pivotTable1.xml"), /<colFields count="2"><field x="1"\/><field x="-2"\/><\/colFields>.*subtotal="average"/);
  assert.match(xml("xl/charts/chart1.xml"), /<c:barDir val="bar"\/><c:grouping val="percentStacked"\/>.*<c:numCache><c:formatCode>General<\/c:formatCode><c:ptCount val="3"\/><c:pt idx="0"><c:v>100<\/c:v>/);
  assert.match(xml("xl/styles.xml"), /<dxfs count="4">/);
  assert.match(xml("[Content_Types].xml"), /chart\+xml.*drawing\+xml.*pivotCacheDefinition\+xml/);
});

test("xlsx written by LibreOffice: its conditional formatting, charts and pivot table open to edit", async () => {
  const r = await O.readXlsx(readFileSync(join(here, "fixtures/libreoffice-extras.xlsx")));
  assert.deepEqual(r.unsupported, []);
  const [sales, summary] = r.sheets;
  assert.deepEqual(sales.cf.map((o) => o.rule.type).sort(), ["bar", "cell", "icons", "scale", "text"]);
  assert.deepEqual(sales.charts.map((c) => [c.type, c.title, c.series.length]), [["column", "Sales by region", 2], ["pie", "Units", 1]]);
  assert.deepEqual(summary.pivots.map((p) => [p.src, p.rows, p.cols, p.vals]), [["Sales!$A$1:$D$6", ["Region"], ["Product"], [{ field: "Sales", fn: "sum" }]]]);
});

test("xlsx with charts and pivot tables opens in LibreOffice with them in place", { skip: !soffice && "LibreOffice isn't installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sx-"));
  try {
    const { bytes } = await workbook();
    writeFileSync(join(dir, "t.xlsx"), bytes);
    execFileSync(soffice, ["--headless", "--convert-to", "ods", "--outdir", dir, join(dir, "t.xlsx")], { stdio: "ignore", timeout: 120000 });
    const ods = await O.unzip(readFileSync(join(dir, "t.ods")));
    const content = new TextDecoder().decode(ods["content.xml"]);
    assert.match(content, /<table:data-pilot-table table:name="PivotTable1"/);
    assert.equal((content.match(/<draw:object /g) || []).length, 2, "both charts");
    assert.match(content, /calcext:conditional-format calcext:target-range-address="Sales.C2:Sales.C4"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
