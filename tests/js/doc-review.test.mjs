// node --test tests/js/doc-review.test.mjs — tracked changes and footnotes: typing with track changes on, accepting and
// rejecting, editing together, and keeping them in .docx files (ours, and ones LibreOffice wrote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const D = require("../../assets/office/doc-model.js");
const O = require("../../assets/office/ooxml.js");
const { Session } = require("../../assets/office/collab.js");
const soffice = ["/usr/bin/soffice", "/usr/bin/libreoffice"].find(existsSync);
const here = new URL(".", import.meta.url).pathname;
const T = new Date("2026-11-14T10:20:30Z");
const text = (runs) => runs.map((r) => r.text).join("");

test("typing with track changes on: deletions stay marked, typing is marked, your own insertions simply go", () => {
  const runs = [{ text: "Delivery every " }, { text: "Monday", ins: "2026-11-01T09:00:00Z|Kim Lee" }, { text: " at 7.80 a kilo." }];
  const t = D.tracked(runs, 15, 6, [{ text: "Tuesday" }], "Sarah Jones", T);
  assert.equal(t.mark, "2026-11-14T10:20:00Z|Sarah Jones", "to the minute, as Word records it");
  assert.deepEqual(t.runs, [{ text: "Monday", ins: "2026-11-01T09:00:00Z|Kim Lee", del: t.mark }, { text: "Tuesday", ins: t.mark }]);
  assert.equal(t.keptLen, 6);
  const own = D.tracked([{ text: "abc", ins: t.mark }], 1, 1, [], "Sarah Jones", T);
  assert.deepEqual(own.runs, [], "deleting your own tracked typing removes it");
  const again = D.tracked([{ text: "x", del: "2026-01-01T00:00:00Z|Kim Lee" }], 0, 1, [], "Sarah Jones", T);
  assert.deepEqual(again.runs, [{ text: "x", del: "2026-01-01T00:00:00Z|Kim Lee" }], "already deleted text keeps its first mark");
  assert.equal(D.author(t.mark), "Sarah Jones"); assert.equal(D.when(t.mark), "2026-11-14T10:20:00Z");
  assert.equal(D.author(D.stamp("Bad|name\u0001")), "Bad name ");
});

test("accepting and rejecting: everything, a range, or one person's change", () => {
  const S = "2026-11-14T10:20:00Z|Sarah", K = "2026-11-14T10:21:00Z|Kim";
  const runs = [{ text: "Hel" }, { text: "lo ", del: S }, { text: "bra", ins: K, del: S }, { text: "XY", ins: S }, { text: "ve", ins: K }, { text: " world" }];
  assert.equal(text(D.resolve(runs, 0, 99, true)), "HelXYve world");
  assert.equal(text(D.resolve(runs, 0, 99, false)), "Hello  world");
  assert.deepEqual(D.resolve(runs, 0, 99, false, (k, m) => k === "del" && m === S), [{ text: "Hello " }, { text: "bra", ins: K }, { text: "XY", ins: S }, { text: "ve", ins: K }, { text: " world" }]);
  assert.deepEqual(D.resolve(runs, 9, 11, true), [{ text: "Hel" }, { text: "lo ", del: S }, { text: "bra", ins: K, del: S }, { text: "XY" }, { text: "ve", ins: K }, { text: " world" }], "only the range");
  assert.deepEqual(D.changes(runs).map((c) => [c.from, c.to, c.kind, D.author(c.mark)]), [[3, 9, "del", "Sarah"], [6, 9, "ins", "Kim"], [9, 11, "ins", "Sarah"], [11, 13, "ins", "Kim"]]);
});

test("footnotes and endnotes are numbered in the order the text refers to them", () => {
  const ref = (fn) => ({ text: D.NOTE_CHAR, fn });
  const doc = { blocks: [{ id: "a", type: "p", runs: [{ text: "One" }, ref("x"), ref("e1")] }, { id: "t", type: "table", rows: [{ cells: [{ blocks: [{ id: "c", type: "p", runs: [ref("y"), ref("gone")] }] }] }] }, { id: "b", type: "p", runs: [ref("e2"), ref("x")] }],
    notes: { x: { kind: "foot", blocks: [] }, y: { kind: "foot", blocks: [] }, e1: { kind: "end", blocks: [] }, e2: { kind: "end", blocks: [] } } };
  assert.deepEqual(D.noteOrder(doc).map((o) => [o.id, D.noteLabel(o.kind, o.n)]), [["x", "1"], ["e1", "i"], ["y", "2"], ["e2", "ii"]]);
});

test("together: one person types with tracking on while another types in the same paragraph; accept all agrees", () => {
  const start = { page: {}, blocks: [{ id: "p", type: "p", runs: [{ text: "Pay within 30 days." }] }] };
  const server = [];
  const people = [0, 1].map((i) => new Session(D, D.clone(start), { client: "c" + i, seq: 0 }));
  const sync = (p) => { const batch = p.take(); if (batch) for (const x of batch) server.push({ seq: server.length + 1, client: p.client, seen: x.seen, op: JSON.parse(JSON.stringify(x.op)) }); p.receive(server.filter((s) => s.seq > p.seq)); };
  people[0].local({ t: "track", on: true });
  sync(people[0]); sync(people[1]);
  assert.equal(people[1].view.track, true);
  const v0 = people[0].view.blocks[0].runs, t0 = D.tracked(v0, 11, 2, [{ text: "60" }], "Sarah", T);
  people[0].local({ t: "text", id: "p", at: 11, del: 2, ins: t0.runs });
  people[1].local({ t: "text", id: "p", at: 0, del: 0, ins: [{ text: "Please " }] });
  people[1].local({ t: "note", id: "n1", note: { kind: "foot", blocks: [{ id: "q", type: "p", runs: [{ text: "From the invoice date." }] }] } });
  people[1].local({ t: "text", id: "p", at: 25, del: 0, ins: [{ text: D.NOTE_CHAR, fn: "n1" }] });
  sync(people[1]); sync(people[0]); sync(people[1]); sync(people[0]);
  const state = (p) => JSON.stringify([p.view.blocks, p.view.notes]);
  assert.equal(state(people[0]), state(people[1]));
  assert.equal(text(people[0].view.blocks[0].runs), `Please Pay within 3060 days${D.NOTE_CHAR}.`);
  const b = people[0].view.blocks[0];
  people[0].local({ t: "text", id: "p", at: 0, del: D.len(b.runs), ins: D.resolve(b.runs, 0, D.len(b.runs), true) });
  sync(people[0]); sync(people[1]);
  assert.equal(text(people[1].view.blocks[0].runs), `Please Pay within 60 days${D.NOTE_CHAR}.`);
  // Undo of turning tracking on, and of a note.
  assert.deepEqual(D.inverse(people[1].view, { t: "track", on: false }), { t: "track", on: true });
  assert.deepEqual(D.inverse(people[1].view, { t: "note", id: "n1", note: null }).note.blocks[0].runs, [{ text: "From the invoice date." }]);
});

const sample = () => ({ page: { size: "A4", margins: { t: 25, r: 25, b: 25, l: 25 } }, track: true, header: null, footer: null, blocks: [
  { id: "p1", type: "p", runs: [{ text: "Prices go up " }, { text: "4%", del: "2026-11-14T10:00:00Z|Sarah Jones" }, { text: "5%", ins: "2026-11-14T10:00:00Z|Sarah Jones" }, { text: " from January" }, { text: D.NOTE_CHAR, fn: "n1" }, { text: "." }] },
  { id: "p2", type: "p", runs: [{ text: "See the list", b: true }, { text: D.NOTE_CHAR, fn: "n2", ins: "2026-11-14T11:00:00Z|Kim & Co <Ltd>" }, { text: " and the " }, { text: "terms", href: "https://example.com/", del: "2026-11-14T11:00:00Z|Kim & Co <Ltd>" }, { text: D.NOTE_CHAR, fn: "n3" }] },
  { id: "t1", type: "table", rows: [{ cells: [{ blocks: [{ id: "c1", type: "p", runs: [{ text: "Cell " }, { text: "note", ins: "2026-11-14T12:00:00Z|Alex" }] }] }] }] },
  { id: "p3", type: "p", runs: [] }],
  notes: { n1: { kind: "foot", blocks: [{ id: "q1", type: "p", runs: [{ text: "Agreed at the " }, { text: "June", i: true }, { text: " meeting." }] }] }, n2: { kind: "foot", blocks: [{ id: "q2", type: "p", runs: [{ text: "Sent to cafés." }] }, { id: "q2b", type: "p", runs: [{ text: "Second paragraph." }] }] }, n3: { kind: "end", blocks: [{ id: "q3", type: "p", runs: [{ text: "Terms, version 3." }] }] }, orphan: { kind: "foot", blocks: [] } } });

test("docx: tracked changes, footnotes, endnotes and the tracking switch come back as saved", async () => {
  const doc = sample();
  const bytes = new Uint8Array(await (await O.writeDocx(doc)).arrayBuffer());
  const back = await O.readDocx(bytes);
  assert.deepEqual(back.unsupported, []);
  assert.equal(back.doc.track, true);
  assert.deepEqual(back.doc.blocks.map((b) => (b.type === "p" ? b.runs : b.rows[0].cells[0].blocks[0].runs)), doc.blocks.map((b) => (b.type === "p" ? b.runs : b.rows[0].cells[0].blocks[0].runs)));
  const strip = (n) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, { kind: v.kind, blocks: v.blocks.map((b) => b.runs) }]));
  const { orphan, ...used } = doc.notes; void orphan;
  assert.deepEqual(strip(back.doc.notes), strip(used), "unreferenced notes aren't kept");
  const files = await O.unzip(bytes);
  const xml = (n) => new TextDecoder().decode(files[n]);
  assert.match(xml("word/document.xml"), /<w:del w:id="\d+" w:author="Sarah Jones" w:date="2026-11-14T10:00:00Z"><w:r><w:delText xml:space="preserve">4%<\/w:delText><\/w:r><\/w:del>/);
  assert.match(xml("word/document.xml"), /w:author="Kim &amp; Co &lt;Ltd&gt;"/);
  assert.match(xml("word/footnotes.xml"), /<w:footnote w:type="separator" w:id="-1">.*<w:footnote w:id="2"><w:p><w:pPr><w:pStyle w:val="FootnoteText"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteRef\/><\/w:r>/);
  assert.match(xml("word/endnotes.xml"), /<w:endnote w:id="1">/);
  assert.match(xml("word/settings.xml"), /<w:trackRevisions\/>.*<w:footnotePr><w:footnote w:id="-1"\/><w:footnote w:id="0"\/><\/w:footnotePr>/);
  // Without tracking or notes: no trackRevisions, no notes parts.
  const plain = await O.unzip(new Uint8Array(await (await O.writeDocx({ ...doc, track: false, notes: {}, blocks: [{ id: "x", type: "p", runs: [{ text: "Hi" }] }] })).arrayBuffer()));
  assert.ok(!plain["word/footnotes.xml"] && !new TextDecoder().decode(plain["word/settings.xml"]).includes("trackRevisions"));
});

test("docx written by LibreOffice: its tracked changes and notes open to edit", async () => {
  const r = await O.readDocx(readFileSync(join(here, "fixtures/libreoffice-notes.docx")));
  assert.deepEqual(r.unsupported, []);
  assert.equal(r.doc.track, true);
  const [p1, p2] = r.doc.blocks;
  assert.deepEqual(p1.runs.filter((x) => x.ins || x.del).map((x) => [x.text, x.ins ? "ins" : "del", D.author(x.ins || x.del)]), [["4%", "del", "Sarah Jones"], ["5%", "ins", "Sarah Jones"]]);
  const notes = [...p1.runs, ...p2.runs].filter((x) => x.fn).map((x) => [r.doc.notes[x.fn].kind, text(r.doc.notes[x.fn].blocks[0].runs)]);
  assert.deepEqual(notes, [["foot", "Agreed at the June meeting."], ["foot", "Sent to cafés on 1 December."], ["end", "Terms of sale, version 3."]]);
});

test("docx with tracked changes and notes opens in LibreOffice with them in place", { skip: !soffice && "LibreOffice isn't installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-"));
  try {
    writeFileSync(join(dir, "t.docx"), new Uint8Array(await (await O.writeDocx(sample())).arrayBuffer()));
    execFileSync(soffice, ["--headless", "--convert-to", "odt", "--outdir", dir, join(dir, "t.docx")], { stdio: "ignore", timeout: 120000 });
    const odt = await O.unzip(readFileSync(join(dir, "t.odt")));
    const content = new TextDecoder().decode(odt["content.xml"]);
    assert.equal((content.match(/<text:changed-region /g) || []).length, 5, "every tracked change");
    assert.match(content, /<dc:creator>Kim &amp; Co &lt;Ltd&gt;<\/dc:creator>/);
    assert.equal((content.match(/text:note-class="footnote"/g) || []).length, 2);
    assert.equal((content.match(/text:note-class="endnote"/g) || []).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
