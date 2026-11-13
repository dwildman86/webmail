// node --test tests/js/ooxml.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const O = require("../../assets/office/ooxml.js");
const F = require("../../assets/office/formula.js");
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const soffice = ["/usr/bin/soffice", "/usr/bin/libreoffice"].find(existsSync);

test("zip round trip, stored and deflated, with a correct CRC", async () => {
  const big = "hello ".repeat(1000);
  const z = await bytes(await O.zip({ "a.txt": "hi", "dir/b.txt": big, "c.bin": new Uint8Array([0, 1, 2, 255]) }));
  const f = await O.unzip(z);
  assert.equal(new TextDecoder().decode(f["a.txt"]), "hi");
  assert.equal(new TextDecoder().decode(f["dir/b.txt"]), big);
  assert.deepEqual([...f["c.bin"]], [0, 1, 2, 255]);
  assert.ok(z.length < big.length, "deflated");
  assert.equal(O.crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  await assert.rejects(O.unzip(new Uint8Array(100)), /zip/);
});

test("XML reader: entities, CDATA, namespaces; no external entities", () => {
  const x = O.parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:a w:v="1 &amp; 2"><b>x &lt; y &#169; &#x41;</b><![CDATA[<raw>]]><c/>&x;</w:a>');
  assert.equal(x.name, "w:a");
  assert.equal(x.attrs["w:v"], "1 & 2");
  assert.equal(x.children[0].children[0].text, "x < y © A");
  assert.equal(x.children[1].text, "<raw>");
  assert.ok(!JSON.stringify(x).includes("root:"), "never expanded");
});

test("CSV: quotes, separators, line endings", () => {
  const { rows, sep } = O.readCsv('﻿name;note\r\n"Smith; J";"said ""hi""\nthen left"\r\nx;\r\n');
  assert.equal(sep, ";");
  assert.deepEqual(rows, [["name", "note"], ["Smith; J", 'said "hi"\nthen left'], ["x", ""]]);
  const out = O.writeCsv(rows, ",");
  assert.deepEqual(O.readCsv(out).rows, rows);
});

const workbook = () => ({
  sheets: [
    { id: "s1", name: "Budget & plan", cols: { 0: 180 }, rows: { 0: 30 }, merges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }], freeze: { r: 1, c: 0 }, cells: new Map([
      ["0,0", { v: "Q1 <budget>", s: { b: true, size: 14, h: "center", bg: "#ffeeaa" } }],
      ["1,0", { v: "Rent" }], ["1,1", { v: 1200.5, s: { nf: "#,##0.00", border: { b: 2 } } }],
      ["2,0", { v: "Food" }], ["2,1", { v: 300, s: { nf: "£#,##0;[Red]-£#,##0" } }],
      ["3,0", { v: true }], ["3,1", { f: "=SUM(B2:B3)", s: { b: true, color: "#c00000", i: true } }],
      ["4,0", { v: 45658, s: { nf: "dd/mm/yyyy" } }], ["4,1", { f: '=IF(B4>1000,"big","small")' }],
      ["5,0", { v: "wrapped text here", s: { wrap: true, va: "top" } }],
    ]) },
    { id: "s2", name: "Other", cols: {}, rows: {}, merges: [], freeze: null, cells: new Map([["0,0", { f: "='Budget & plan'!B4*2" }]]) },
  ],
});
function values(wb) {
  const calc = new F.Calc((s, r, c) => wb.sheets.find((x) => x.name === s)?.cells.get(`${r},${c}`)?.v ?? null, { has: (s) => wb.sheets.some((x) => x.name === s) });
  wb.sheets.forEach((s) => { for (const [k, cell] of s.cells) { const [r, c] = k.split(",").map(Number); if (cell.f) calc.set(s.name, r, c, cell.f); } });
  calc.recalc();
  return (si, r, c) => calc.value(wb.sheets[si].name, r, c);
}

test("xlsx: our file reads back the same", async () => {
  const wb = workbook();
  const v = values(wb);
  assert.equal(v(0, 3, 1), 1500.5);
  const back = await O.readXlsx(await bytes(await O.writeXlsx(wb, v)));
  assert.deepEqual(back.unsupported, []);
  const [a, b] = back.sheets;
  assert.equal(a.name, "Budget & plan");
  assert.deepEqual(a.cells.get("0,0"), { v: "Q1 <budget>", s: { b: true, size: 14, h: "center", bg: "#ffeeaa" } });
  assert.deepEqual(a.cells.get("1,1"), { v: 1200.5, s: { nf: "#,##0.00", border: { b: 2 } } });
  assert.deepEqual(a.cells.get("2,1").s, { nf: "£#,##0;[Red]-£#,##0" });
  assert.deepEqual(a.cells.get("3,0"), { v: true });
  assert.deepEqual(a.cells.get("3,1"), { v: 1500.5, f: "=SUM(B2:B3)", s: { b: true, i: true, color: "#c00000" } });
  assert.deepEqual(a.cells.get("4,1"), { v: "big", f: '=IF(B4>1000,"big","small")' });
  assert.deepEqual(a.cells.get("5,0").s, { wrap: true, va: "top" });
  assert.equal(a.cells.get("4,0").s.nf, "dd/mm/yyyy");
  assert.deepEqual(a.merges, [{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  assert.deepEqual(a.freeze, { r: 1, c: 0 });
  assert.equal(a.cols[0], 180);
  assert.equal(a.rows[0], 30);
  assert.deepEqual(b.cells.get("0,0"), { v: 3001, f: "='Budget & plan'!B4*2" });
});

const blocks = () => [
  { id: "1", type: "p", style: "title", runs: [{ text: "Project plan" }] },
  { id: "2", type: "p", runs: [{ text: "Plain, " }, { text: "bold", b: true }, { text: " and " }, { text: "red italic", i: true, color: "#c00000" }, { text: " & " }, { text: "a link", href: "https://example.com/?a=1&b=2" }] },
  { id: "3", type: "p", style: "h1", align: "center", runs: [{ text: "Heading <one>" }] },
  { id: "4", type: "p", list: { kind: "bullet", level: 0 }, runs: [{ text: "First" }] },
  { id: "5", type: "p", list: { kind: "bullet", level: 1 }, runs: [{ text: "Nested" }] },
  { id: "6", type: "p", list: { kind: "number", level: 0 }, runs: [{ text: "One", font: "Georgia", size: 14 }] },
  { id: "7", type: "p", indent: 1, align: "justify", runs: [{ text: "Tab\there\nnew line", u: true, bg: "#ffff00", sup: true }] },
  { id: "8", type: "table", rows: [{ cells: [{ blocks: [{ id: "c1", type: "p", runs: [{ text: "A", b: true }] }], bg: "#dddddd" }, { blocks: [{ id: "c2", type: "p", runs: [{ text: "B" }] }] }] }, { cells: [{ span: 2, blocks: [{ id: "c3", type: "p", runs: [{ text: "Both" }] }] }] }] },
  { id: "9", type: "pagebreak" },
  { id: "10", type: "img", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", w: 120, h: 80, alt: "dot" },
  { id: "11", type: "p", style: "quote", runs: [{ text: "Quoted" }] },
];
const strip = (bs) => bs.map(({ id, ...b }) => (b.type === "table" ? { ...b, rows: b.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c, blocks: strip(c.blocks) })) })) } : b));

test("docx: our file reads back the same", async () => {
  const doc = { page: { size: "Letter", landscape: true, margins: { t: 20, r: 15, b: 20, l: 15 } }, blocks: blocks(), header: [{ id: "h", type: "p", align: "right", runs: [{ text: "Acme Ltd" }] }], footer: null };
  const back = await O.readDocx(await bytes(await O.writeDocx(doc)));
  assert.deepEqual(back.unsupported, []);
  assert.deepEqual(back.doc.page, doc.page);
  const got = strip(back.doc.blocks);
  const want = strip(blocks());
  want[7].widths = got[7].widths; // widths are filled in on save
  want[9].align = undefined; got[9].align = undefined;
  assert.deepEqual(got, want);
  assert.deepEqual(strip(back.doc.header), [{ type: "p", align: "right", runs: [{ text: "Acme Ltd" }] }]);
});

test("files made by LibreOffice open, and LibreOffice opens ours", { skip: !soffice && "LibreOffice isn't installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ooxml-"));
  try {
    const run = (...a) => execFileSync(soffice, ["--headless", "--norestore", `-env:UserInstallation=file://${dir}/profile`, ...a], { cwd: dir, stdio: "pipe", timeout: 120000 });
    // A spreadsheet: a CSV with a formula, converted.
    writeFileSync(join(dir, "in.csv"), "Item,Cost\nRent,1200\nFood,300.5\nTotal,=SUM(B2:B3)\n");
    run("--convert-to", "xlsx", "in.csv");
    const x = await O.readXlsx(readFileSync(join(dir, "in.xlsx")));
    const s = x.sheets[0];
    assert.equal(s.cells.get("0,0").v, "Item");
    assert.equal(s.cells.get("2,1").v, 300.5);
    assert.equal(s.cells.get("3,1").f, "=SUM(B2:B3)");
    assert.equal(s.cells.get("3,1").v, 1500.5);
    // A document: HTML with headings, a list, a table and formatting, converted.
    writeFileSync(join(dir, "in.html"), "<h1>Title one</h1><p>Some <b>bold</b> and <i>italic</i> text.</p><ul><li>Apple</li><li>Pear</li></ul><table border=1><tr><td>A</td><td>B</td></tr></table><p style='text-align:center'>Centred</p>");
    run("--convert-to", "docx:MS Word 2007 XML", "in.html");
    const d = await O.readDocx(readFileSync(join(dir, "in.docx")));
    const ps = d.doc.blocks.filter((b) => b.type === "p" && b.runs.length);
    const text = (b) => b.runs.map((r) => r.text).join("");
    assert.equal(ps[0].style, "h1");
    assert.equal(text(ps[0]), "Title one");
    assert.ok(ps[1].runs.some((r) => r.text === "bold" && r.b));
    assert.ok(ps[1].runs.some((r) => r.text === "italic" && r.i));
    const apple = ps.find((b) => text(b) === "Apple");
    assert.equal(apple.list?.kind, "bullet");
    assert.ok(d.doc.blocks.some((b) => b.type === "table"));
    assert.equal(ps.find((b) => text(b) === "Centred").align, "center");

    // Ours, opened by LibreOffice: convert our files to CSV / text and compare.
    const wb = workbook();
    writeFileSync(join(dir, "ours.xlsx"), await bytes(await O.writeXlsx(wb, values(wb))));
    run("--convert-to", "csv", "ours.xlsx");
    const csv = readFileSync(join(dir, "ours.csv"), "utf8");
    assert.match(csv, /Rent,1200\.5/);
    assert.match(csv, /TRUE,1500\.5/);
    writeFileSync(join(dir, "ours.docx"), await bytes(await O.writeDocx({ page: { size: "A4", margins: { t: 25, r: 25, b: 25, l: 25 } }, blocks: blocks(), header: null, footer: null })));
    run("--convert-to", "txt:Text", "ours.docx");
    const txt = readFileSync(join(dir, "ours.txt"), "utf8");
    for (const s of ["Project plan", "red italic", "Heading <one>", "Nested", "Both", "Quoted"]) assert.ok(txt.includes(s), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported parts are listed, not lost silently", async () => {
  const wb = workbook();
  const z = await O.unzip(await bytes(await O.writeXlsx(wb, values(wb))));
  z["xl/vbaProject.bin"] = new Uint8Array([1]);
  z["xl/charts/chart1.xml"] = "<c/>";
  const back = await O.readXlsx(await bytes(await O.zip(z)));
  assert.deepEqual(back.unsupported.sort(), ["charts", "macros"]);
});

test("the editors' ids survive saving, so everyone editing agrees on them; files from elsewhere get the same ids for everyone", async () => {
  const doc = { page: { size: "A4" }, blocks: [{ id: "bA", type: "p", runs: [{ text: "One" }] }, { id: "bT", type: "table", rows: [{ cells: [{ blocks: [{ id: "c", type: "p", runs: [{ text: "x" }] }] }] }] }], header: null, footer: null };
  const back = await O.readDocx(await bytes(await O.writeDocx({ ...doc, blocks: [...doc.blocks, { id: "bE", type: "p", runs: [] }] })));
  assert.deepEqual(back.doc.blocks.map((b) => b.id), ["bA", "bT", "bE"]);
  const ending = await O.readDocx(await bytes(await O.writeDocx(doc)));
  assert.equal(ending.doc.blocks.length, 3, "a document always ends with a paragraph to type in");
  assert.deepEqual(ending.doc.blocks.slice(0, 2).map((b) => b.id), ["bA", "bT"]);
  const z = await O.unzip(await bytes(await O.writeDocx(doc)));
  delete z["docProps/custom.xml"];
  const a = await O.readDocx(await bytes(await O.zip(z))), b = await O.readDocx(await bytes(await O.zip(z)));
  assert.deepEqual(a.doc.blocks.map((x) => x.id), b.doc.blocks.map((x) => x.id));
  const wb = { sheets: [{ ...workbook().sheets[0], id: "sXYZ" }, { ...workbook().sheets[1], id: "s9" }] };
  const xb = await O.readXlsx(await bytes(await O.writeXlsx(wb, values(wb))));
  assert.deepEqual(xb.sheets.map((s) => s.id), ["sXYZ", "s9"]);
});
