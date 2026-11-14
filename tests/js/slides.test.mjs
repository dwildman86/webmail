// node --test tests/js/slides.test.mjs — presentations: editing together (slides, boxes, typing in the same box), undo,
// and .pptx files (ours, and ones LibreOffice wrote; LibreOffice opening ours).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const P = require("../../assets/office/pres-model.js");
const X = require("../../assets/office/pptx.js");
const D = require("../../assets/office/doc-model.js");
const O = require("../../assets/office/ooxml.js");
const { Session } = require("../../assets/office/collab.js");
const soffice = ["/usr/bin/soffice", "/usr/bin/libreoffice"].find(existsSync);
const here = new URL(".", import.meta.url).pathname;
const size = { w: 1280, h: 720 };
const text = (e) => (e.blocks || []).map((b) => D.textOf(b)).join("/");

function room(start, n = 2) {
  const server = [];
  const people = Array.from({ length: n }, (_, i) => new Session(P, P.clone(start), { client: "c" + i, seq: 0 }));
  const sync = (p) => { const batch = p.take(); if (batch) for (const x of batch) server.push({ seq: server.length + 1, client: p.client, seen: x.seen, op: JSON.parse(JSON.stringify(x.op)) }); p.receive(server.filter((s) => s.seq > p.seq)); };
  const settle = () => { for (let i = 0; i < 3; i++) for (const p of people) sync(p); };
  return { people, settle };
}
const start = () => ({ size, slides: [{ id: "s1", bg: "#ffffff", els: [
  { id: "t", type: "text", ph: "title", x: 80, y: 40, w: 1100, h: 120, blocks: [{ id: "p1", type: "p", runs: [{ text: "Plans" }] }] },
  { id: "b", type: "text", ph: "body", x: 80, y: 200, w: 1100, h: 400, blocks: [{ id: "p2", type: "p", runs: [{ text: "Open a café" }], list: { kind: "bullet", level: 0 } }] },
  { id: "sh", type: "shape", shape: "star5", x: 900, y: 400, w: 200, h: 200, fill: "#4472c4" }] }] });

test("together: typing in the same box, moving and recolouring it, and adding slides all come out the same", () => {
  const { people: [a, b], settle } = room(start());
  a.local({ t: "tx", slide: "s1", el: "b", op: { t: "text", id: "p2", at: 11, del: 0, ins: [{ text: " near the station" }] } });
  b.local({ t: "tx", slide: "s1", el: "b", op: { t: "text", id: "p2", at: 0, del: 0, ins: [{ text: "We'll " }] } });
  b.local({ t: "tx", slide: "s1", el: "b", op: { t: "split", id: "p2", at: 6, newId: "p3" } });
  a.local({ t: "elSet", slide: "s1", id: "sh", set: { x: 100, y: 120 } });
  b.local({ t: "elSet", slide: "s1", id: "sh", set: { fill: "#ff0000", rot: 15 } });
  a.local({ t: "slide", id: "s2", at: 1, slide: { bg: "#ffffff", els: P.layout("content", size) } });
  b.local({ t: "slide", id: "s3", at: 1, slide: { bg: "#000000", els: [] } });
  settle();
  assert.equal(JSON.stringify(a.view), JSON.stringify(b.view));
  assert.equal(text(a.view.slides[0].els[1]), "We'll /Open a café near the station");
  assert.deepEqual([a.view.slides[0].els[2].x, a.view.slides[0].els[2].fill, a.view.slides[0].els[2].rot], [100, "#ff0000", 15]);
  assert.equal(a.view.slides.length, 3);
});

test("together: a box deleted while someone types in it goes; their typing goes with it", () => {
  const { people: [a, b], settle } = room(start());
  a.local({ t: "el", slide: "s1", id: "b", el: null });
  b.local({ t: "tx", slide: "s1", el: "b", op: { t: "text", id: "p2", at: 0, del: 0, ins: [{ text: "x" }] } });
  b.local({ t: "elSet", slide: "s1", id: "b", set: { x: 5 } });
  a.local({ t: "slideDel", id: "s1" }); // the only slide: refused
  settle();
  assert.equal(JSON.stringify(a.view), JSON.stringify(b.view));
  assert.deepEqual(a.view.slides[0].els.map((e) => e.id), ["t", "sh"]);
});

test("undo: every op has an inverse that puts things back", () => {
  const p = start();
  const before = JSON.stringify(p);
  const ops = [
    { t: "tx", slide: "s1", el: "t", op: { t: "text", id: "p1", at: 5, del: 0, ins: [{ text: " for 2027", b: true }] } },
    { t: "elSet", slide: "s1", id: "sh", set: { x: 1, w: 50, fill: null } },
    { t: "elZ", slide: "s1", id: "sh", at: 0 },
    { t: "el", slide: "s1", id: "b", el: null },
    { t: "el", slide: "s1", id: "n", el: { type: "img", x: 0, y: 0, w: 10, h: 10, src: "data:image/png;base64,AA==" } },
    { t: "slide", id: "s2", at: 0, slide: { bg: "#000000", els: [] } },
    { t: "slideSet", id: "s1", set: { bg: "#123456", notes: "Hi", hidden: true } },
    { t: "slideMove", id: "s1", at: 0 },
    { t: "size", w: 960, h: 720 },
  ];
  const undo = [];
  for (const op of ops) { const inv = P.inverse(p, op); undo.unshift(...(Array.isArray(inv) ? inv.slice().reverse() : [inv])); assert.notEqual(P.apply(p, op), null, op.t); }
  for (const op of undo) P.apply(p, op);
  assert.equal(JSON.stringify(p), before);
  // A line can be flat; other things keep a little size.
  const q = start();
  P.apply(q, { t: "el", slide: "s1", id: "ln", el: { type: "shape", shape: "line", x: 0, y: 0, w: 100, h: 0 } });
  P.apply(q, { t: "elSet", slide: "s1", id: "ln", set: { w: 300 } });
  P.apply(q, { t: "elSet", slide: "s1", id: "sh", set: { h: 0 } });
  assert.deepEqual([q.slides[0].els.at(-1).h, q.slides[0].els[2].h], [0, 4]);
});

async function deck() {
  const s1 = { id: "a", bg: "#1e3a5f", els: P.layout("title", size, { accent: "#ffffff", ink: "#dbeafe" }) };
  s1.els[0].blocks[0].runs = [{ text: "Northwind Coffee", b: true, size: 48, color: "#ffffff" }]; delete s1.els[0].blocks[0].hint;
  const s2 = { id: "b", bg: "#ffffff", notes: "Mention the roaster.\nThank Kim & <team>.", els: P.layout("two", size) };
  s2.els[1].blocks = [P.para([{ text: "Second café", size: 22, font: "Georgia" }], { list: { kind: "bullet", level: 0 } }), P.para([{ text: "Near the station", size: 18, i: true, u: true }], { list: { kind: "bullet", level: 1 } }), P.para([{ text: "Wholesale", size: 22, href: "https://example.com/", sup: true }], { list: { kind: "number", level: 0 }, align: "right" })];
  s2.els.push({ id: "sh1", type: "shape", shape: "roundRect", x: 900, y: 420, w: 280, h: 160, fill: "#f59e0b", line: { color: "#92400e", w: 2 }, anchor: "ctr", blocks: [P.para([{ text: "+40%", b: true, size: 32, color: "#ffffff" }], { align: "center" })] });
  s2.els.push({ id: "ln1", type: "shape", shape: "line", x: 100, y: 650, w: 1080, h: 0, line: { color: "#1e3a5f", w: 3, end: "arrow" }, flipH: true });
  s2.els.push({ id: "el1", type: "shape", shape: "ellipse", x: 1100, y: 40, w: 120, h: 120, fill: "#10b981", rot: 15, flipV: true });
  s2.els.push({ id: "im1", type: "img", x: 1000, y: 200, w: 160, h: 160, src: "data:image/png;base64," + readFileSync(join(here, "../../assets/icons/icon-192.png")).toString("base64"), alt: "Logo" });
  const pres = { size, slides: [s1, s2, { id: "c", bg: "#ffffff", hidden: true, els: [] }] };
  return { pres, bytes: new Uint8Array(await (await X.writePptx(pres)).arrayBuffer()) };
}
const norm = (p) => JSON.stringify(p.slides.map((s) => [s.id, s.bg, s.notes || "", !!s.hidden, s.els.map((e) => [e.id, e.type, e.shape, e.x, e.y, e.w, e.h, e.rot, e.flipH, e.flipV, e.fill, e.line, e.ph, e.anchor, e.alt, e.src?.length, (e.blocks || []).map((b) => [b.id, b.align, b.list, b.runs.map((r) => Object.fromEntries(Object.entries(r).sort()))])])]));

test("pptx: slides, boxes, shapes, lines, pictures, notes and hidden slides come back as saved", async () => {
  const { pres, bytes } = await deck();
  const back = await X.readPptx(bytes);
  assert.deepEqual(back.unsupported, []);
  assert.deepEqual(back.pres.size, size);
  assert.equal(norm(back.pres), norm(pres));
  const files = await O.unzip(bytes);
  const xml = (n) => new TextDecoder().decode(files[n]);
  assert.match(xml("ppt/presentation.xml"), /<p:sldIdLst><p:sldId id="256" r:id="rId10"\/><p:sldId id="257" r:id="rId11"\/><p:sldId id="258" r:id="rId12"\/><\/p:sldIdLst><p:sldSz cx="12192000" cy="6858000"\/>/);
  assert.match(xml("ppt/slides/slide2.xml"), /<p:ph type="title"\/>.*<p:ph idx="1"\/>.*<p:ph idx="2"\/>/);
  assert.match(xml("ppt/notesSlides/notesSlide2.xml"), /Thank Kim &amp; &lt;team&gt;\./);
  assert.match(xml("ppt/slides/slide3.xml"), /<p:sld [^>]* show="0">/);
  assert.ok(!files["ppt/notesSlides/notesSlide1.xml"], "no notes, no notes part");
});

test("pptx written by LibreOffice opens to edit, with its slides, notes and pictures", async () => {
  const r = await X.readPptx(readFileSync(join(here, "fixtures/libreoffice-deck.pptx")));
  assert.deepEqual(r.unsupported, []);
  const [s1, s2, s3] = r.pres.slides;
  assert.deepEqual(s1.els.map((e) => [e.ph, text(e)]), [["title", "Northwind Coffee"], ["subtitle", "Plans for 2027 & beyond"]]);
  assert.equal(s1.bg, "#1e3a5f");
  assert.deepEqual(s2.els.map((e) => e.type + ":" + (e.shape || e.ph || "")), ["text:title", "text:body", "shape:roundRect", "shape:line", "shape:ellipse", "img:"]);
  assert.deepEqual(s2.els[1].blocks.map((b) => [D.textOf(b), b.list?.kind, b.list?.level]), [["Open a second café", "bullet", 0], ["Near the station", "bullet", 1], ["Wholesale to 40 cafés", "number", 0]]);
  assert.equal(s2.notes, "Mention the roaster.\nThank Kim.");
  assert.ok(s3.hidden);
});

test("pptx: what the editor can't keep is listed, not lost silently", async () => {
  const { bytes } = await deck();
  const z = await O.unzip(bytes);
  const s = new TextDecoder().decode(z["ppt/slides/slide2.xml"]);
  z["ppt/slides/slide2.xml"] = s.replace("</p:spTree>", '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="99" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"/></a:graphic></p:graphicFrame></p:spTree>')
    .replace("</p:cSld>", "</p:cSld>").replace("</p:sld>", '<p:transition><p:fade/></p:transition><p:timing><p:tnLst><p:par><p:cTn id="1"/></p:par></p:tnLst></p:timing></p:sld>');
  const r = await X.readPptx(await new Uint8Array(await (await O.zip(z)).arrayBuffer()));
  assert.deepEqual(r.unsupported.sort(), ["animations", "slide transitions", "tables in slides"]);
});

test("pptx opens in LibreOffice with every slide, shape and note", { skip: !soffice && "LibreOffice isn't installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "px-"));
  try {
    const { bytes } = await deck();
    writeFileSync(join(dir, "t.pptx"), bytes);
    execFileSync(soffice, ["--headless", "--convert-to", "odp", "--outdir", dir, join(dir, "t.pptx")], { stdio: "ignore", timeout: 120000 });
    const odp = await O.unzip(readFileSync(join(dir, "t.odp")));
    const content = new TextDecoder().decode(odp["content.xml"]);
    assert.equal((content.match(/<draw:page /g) || []).length, 3);
    assert.match(content, /Northwind Coffee/);
    assert.match(content, /<draw:custom-shape [^>]*>.*\+40%/s);
    assert.match(content, /<draw:connector /, "the line, as a connector");
    assert.match(content, /<draw:image /);
    assert.match(content, /<presentation:notes[^>]*>.*Thank Kim &amp; &lt;team&gt;\./s);
    assert.match(content, /presentation:visibility="hidden"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
