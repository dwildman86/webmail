// node --test tests/js/collab.test.mjs — several people editing at once end up with the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Session } = require("../../assets/office/collab.js");
const D = require("../../assets/office/doc-model.js");
const S = require("../../assets/office/sheet-model.js");

// A tiny deterministic random number generator, so a failure can be replayed.
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function room(model, initial, n) {
  const server = [];
  const people = Array.from({ length: n }, (_, i) => new Session(model, model.clone(initial), { client: "c" + i, seq: 0 }));
  const sync = (p) => {
    const batch = p.take();
    if (batch) for (const b of batch) server.push({ seq: server.length + 1, client: p.client, seen: b.seen, op: JSON.parse(JSON.stringify(b.op, (k, v) => (v instanceof Map ? [...v] : v))) });
    p.receive(server.filter((s) => s.seq > p.seq));
  };
  return { people, server, sync };
}

const docState = (d) => JSON.stringify(d.blocks.map((b) => (b.type === "p" ? [b.id, D.textOf(b), b.style || "", b.runs.map((r) => Object.keys(D.props(r)).join("")).join("|")] : [b.id, b.type])));
const sheetState = (w) => JSON.stringify(w.sheets.map((s) => [s.id, s.name, [...s.cells].sort(), s.merges, s.cols, s.rows]));

function randomDocOp(doc, r, me) {
  const ps = doc.blocks.filter((b) => b.type === "p");
  const b = ps[Math.floor(r() * ps.length)];
  const n = D.len(b.runs), at = Math.floor(r() * (n + 1));
  const k = r();
  if (k < 0.45) return { t: "text", id: b.id, at, del: 0, ins: [{ text: me + "abc".slice(0, 1 + Math.floor(r() * 3)) }] };
  if (k < 0.6 && n) return { t: "text", id: b.id, at: Math.min(at, n - 1), del: 1 + Math.floor(r() * 3), ins: [] };
  if (k < 0.7 && n) return { t: "fmt", id: b.id, from: Math.min(at, n - 1), to: n, set: { b: r() < 0.5 ? true : null } };
  if (k < 0.8) return { t: "split", id: b.id, at, newId: D.newId() };
  if (k < 0.88) { const i = doc.blocks.indexOf(b); const nx = doc.blocks[i + 1]; if (nx?.type === "p") return { t: "join", id: b.id, next: nx.id, at: n }; }
  if (k < 0.93 && doc.blocks.length > 2) { const i = doc.blocks.indexOf(b); return { t: "delete", id: b.id, prev: i > 0 ? doc.blocks[i - 1].id : null }; }
  if (k < 0.97) return { t: "para", id: b.id, set: { style: r() < 0.5 ? "h1" : null } };
  return { t: "insert", after: b.id, block: { id: D.newId(), type: "p", runs: [{ text: "new" + me }] } };
}

test("documents: random edits from three people at once converge", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const initial = { page: {}, blocks: [{ id: "a", type: "p", runs: [{ text: "Hello world" }] }, { id: "b", type: "p", runs: [{ text: "Second line" }] }, { id: "c", type: "p", runs: [] }], header: null, footer: null };
    const { people, sync } = room(D, initial, 3);
    for (let step = 0; step < 120; step++) {
      const p = people[Math.floor(r() * people.length)];
      if (r() < 0.6) { const op = randomDocOp(p.view, r, p.client.slice(1)); if (op) { const inv = D.inverse(p.view, op); assert.ok(inv !== undefined); p.local(op); } }
      else sync(p);
    }
    for (let round = 0; round < 3; round++) people.forEach(sync);
    const want = docState(people[0].confirmed);
    for (const p of people) {
      assert.equal(docState(p.confirmed), want, `seed ${seed}: ${p.client} confirmed`);
      assert.equal(docState(p.view), want, `seed ${seed}: ${p.client} view`);
    }
  }
});

test("documents: typing in the same paragraph keeps both people's words", () => {
  const initial = { page: {}, blocks: [{ id: "a", type: "p", runs: [{ text: "The cat sat." }] }], header: null, footer: null };
  const { people: [ann, bob], sync } = room(D, initial, 2);
  ann.local({ t: "text", id: "a", at: 4, del: 0, ins: [{ text: "black " }] });   // The black cat sat.
  bob.local({ t: "text", id: "a", at: 11, del: 0, ins: [{ text: " down" }] });   // The cat sat down.
  bob.local({ t: "fmt", id: "a", from: 4, to: 7, set: { b: true } });           // cat in bold
  sync(ann); sync(bob); sync(ann);
  for (const p of [ann, bob]) {
    assert.equal(D.textOf(p.view.blocks[0]), "The black cat sat down.");
    assert.deepEqual(p.view.blocks[0].runs.find((x) => x.b), { text: "cat", b: true });
  }
  // Enter in the middle while the other person types after it: their words follow into the new paragraph.
  ann.local({ t: "split", id: "a", at: 14, newId: "n" });
  bob.local({ t: "text", id: "a", at: 22, del: 0, ins: [{ text: " now" }] });
  sync(ann); sync(bob); sync(ann);
  for (const p of [ann, bob]) assert.deepEqual(p.view.blocks.map(D.textOf), ["The black cat ", "sat down now."]);
});

test("documents: undo puts things back, even after someone else's edit", () => {
  const initial = { page: {}, blocks: [{ id: "a", type: "p", runs: [{ text: "abc" }] }, { id: "b", type: "p", runs: [{ text: "def" }] }], header: null, footer: null };
  const { people: [ann, bob], sync } = room(D, initial, 2);
  const op = { t: "join", id: "a", next: "b", at: 3 };
  const inv = D.inverse(ann.view, op);
  ann.local(op); sync(ann);
  bob.local({ t: "text", id: "a", at: 0, del: 0, ins: [{ text: "X" }] }); sync(bob); sync(ann);
  const mark = ann.log.length;
  ann.local(D.rebase(inv[0], ann.log.slice(mark - 1).filter((l) => l.client !== ann.client).flatMap((l) => l.op)));
  ann.local(inv[1]);
  sync(ann); sync(bob);
  assert.deepEqual(bob.view.blocks.map(D.textOf), ["Xabc", "def"]);
  assert.equal(bob.view.blocks[1].id, "b");
});

function randomSheetOp(wb, r) {
  const sh = wb.sheets[Math.floor(r() * wb.sheets.length)];
  const k = r(), row = Math.floor(r() * 8), col = Math.floor(r() * 5);
  if (k < 0.5) return { t: "set", sheet: sh.id, cells: [[row, col, r() < 0.2 ? { f: `=SUM(A1:A${1 + Math.floor(r() * 6)})+B${1 + row}` } : r() < 0.1 ? null : { v: Math.floor(r() * 100) }]] };
  if (k < 0.65) return { t: "style", sheet: sh.id, cells: [[row, col, { b: r() < 0.5 ? true : null, bg: r() < 0.3 ? "#ffff00" : null }]] };
  if (k < 0.75) return { t: "ins", sheet: sh.id, name: sh.name, axis: r() < 0.5 ? "r" : "c", at: Math.floor(r() * 6), n: 1 + Math.floor(r() * 2) };
  if (k < 0.85) return { t: "del", sheet: sh.id, name: sh.name, axis: r() < 0.5 ? "r" : "c", at: Math.floor(r() * 6), n: 1 };
  if (k < 0.9) return { t: "merge", sheet: sh.id, r1: row, c1: col, r2: row + 1, c2: col + 1, on: r() < 0.7 };
  if (k < 0.94) return { t: "size", sheet: sh.id, axis: "c", i: col, px: 60 + Math.floor(r() * 100) };
  if (k < 0.97) return { t: "sheetName", id: sh.id, name: "N" + Math.floor(r() * 9) };
  return { t: "sheet", id: "s" + Math.floor(r() * 1e9), name: "Sheet", at: 1 };
}

test("spreadsheets: random edits from three people at once converge", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 7);
    const initial = { sheets: [{ ...S.blank("s1", "Sheet1"), cells: new Map([["0,0", { v: 1 }], ["1,0", { v: 2 }], ["2,1", { f: "=A1+A2" }]]) }, S.blank("s2", "Other")] };
    const { people, sync } = room(S, initial, 3);
    for (let step = 0; step < 120; step++) {
      const p = people[Math.floor(r() * people.length)];
      if (r() < 0.6) { const op = randomSheetOp(p.view, r); S.inverse(p.view, op); p.local(op); } else sync(p);
    }
    for (let round = 0; round < 3; round++) people.forEach(sync);
    const want = sheetState(people[0].confirmed);
    for (const p of people) {
      assert.equal(sheetState(p.confirmed), want, `seed ${seed}: ${p.client}`);
      assert.equal(sheetState(p.view), want, `seed ${seed}: ${p.client} view`);
    }
  }
});

test("spreadsheets: a value typed while someone inserts a row above lands in the right cell; formulas follow", () => {
  const initial = { sheets: [{ ...S.blank("s1", "Sheet1"), cells: new Map([["0,0", { v: 5 }], ["4,0", { v: "Total" }]]) }] };
  const { people: [ann, bob], sync } = room(S, initial, 2);
  ann.local({ t: "ins", sheet: "s1", name: "Sheet1", axis: "r", at: 0, n: 2 });
  bob.local({ t: "set", sheet: "s1", cells: [[4, 1, { f: "=A1*2" }]] }); // next to "Total"
  sync(ann); sync(bob); sync(ann);
  for (const p of [ann, bob]) {
    assert.deepEqual(p.view.sheets[0].cells.get("6,1"), { v: null, f: "=A3*2" });
    assert.equal(p.view.sheets[0].cells.get("6,0").v, "Total");
  }
});

test("spreadsheets: undo of a row delete brings back cells, sizes and formulas", () => {
  const wb = { sheets: [{ ...S.blank("s1", "Sheet1"), rows: { 1: 40 }, cells: new Map([["0,0", { v: 1 }], ["1,0", { v: 2, s: { b: true } }], ["2,0", { f: "=A2*3" }]]) }, { ...S.blank("s2", "B"), cells: new Map([["0,0", { f: "=Sheet1!A2" }]]) }] };
  const op = { t: "del", sheet: "s1", name: "Sheet1", axis: "r", at: 1, n: 1 };
  const inv = S.inverse(wb, op);
  S.apply(wb, op);
  assert.equal(wb.sheets[0].cells.get("1,0").f, "=#REF!*3");
  assert.equal(wb.sheets[1].cells.get("0,0").f, "=#REF!");
  for (const o of inv) S.apply(wb, o);
  assert.deepEqual(wb.sheets[0].cells.get("1,0"), { v: 2, s: { b: true } });
  assert.equal(wb.sheets[0].cells.get("2,0").f, "=A2*3");
  assert.equal(wb.sheets[1].cells.get("0,0").f, "=Sheet1!A2");
  assert.equal(wb.sheets[0].rows[1], 40);
});
