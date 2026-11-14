// Starting points for new documents and spreadsheets (Files → New). Each makes the editor's own model, saved as a
// real .docx or .xlsx, so it opens anywhere.
"use strict";

(() => {
const D = () => window.OfficeDocModel;
const M = () => window.OfficeSheetModel;
const today = () => new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const page = () => ({ size: /^en-US|^en-CA/i.test(navigator.language) ? "Letter" : "A4", margins: { t: 25, r: 25, b: 25, l: 25 } });
const P = (text, extra = {}) => ({ id: D().newId(), type: "p", runs: text ? (Array.isArray(text) ? text : [{ text }]) : [], ...extra });
const bullet = (text) => P(text, { list: { kind: "bullet", level: 0 } });
const num = (text) => P(text, { list: { kind: "number", level: 0 } });
const cell = (text, extra = {}) => ({ blocks: [P(text)], ...extra });
const table = (rows, header = true) => ({ id: D().newId(), type: "table", rows: rows.map((r, i) => ({ cells: r.map((t) => cell(t && header && i === 0 ? [{ text: t, b: true }] : t, header && i === 0 ? { bg: "#e7e6e6" } : {})) })) });
const doc = (blocks, extra = {}) => ({ page: page(), blocks, header: null, footer: null, ...extra });

const DOCS = [
  { id: "blank", name: "Blank document", make: () => doc([P("")]) },
  { id: "letter", name: "Letter", make: () => doc([
    P("Your name", { align: "right" }), P("Your address", { align: "right" }), P(today(), { align: "right" }), P(""),
    P("Recipient's name"), P("Their address"), P(""), P("Dear …,"), P(""),
    P("Write your letter here."), P(""), P("Yours sincerely,"), P(""), P(""), P("Your name"),
  ]) },
  { id: "meeting", name: "Meeting notes", make: () => doc([
    P("Meeting notes", { style: "title" }), P([{ text: "Date: ", b: true }, { text: today() }]), P([{ text: "Attendees: ", b: true }]),
    P("Agenda", { style: "h1" }), num("First topic"), num("Second topic"),
    P("Notes", { style: "h1" }), bullet(""),
    P("Actions", { style: "h1" }), table([["Action", "Who", "By when"], ["", "", ""], ["", "", ""]]), P(""),
  ]) },
  { id: "report", name: "Report", make: () => doc([
    P("Report title", { style: "title" }), P([{ text: today(), color: "#595959" }]),
    P("Summary", { style: "h1" }), P("A short overview of what this report covers and what it found."),
    P("Background", { style: "h1" }), P(""),
    P("Findings", { style: "h1" }), P("First finding", { style: "h2" }), P(""), P("Second finding", { style: "h2" }), P(""),
    P("Recommendations", { style: "h1" }), bullet(""),
  ], { footer: [P([{ text: "Confidential" }], { align: "center" })] }) },
  { id: "cv", name: "CV", make: () => doc([
    P("Your Name", { style: "title" }), P("you@example.com · 07700 900000 · Town"),
    P("Profile", { style: "h1" }), P("Two or three lines about you and what you're looking for."),
    P("Experience", { style: "h1" }), P([{ text: "Job title", b: true }, { text: " — Company, 2022 to now" }]), bullet("What you did and what came of it"),
    P("Education", { style: "h1" }), P([{ text: "Qualification", b: true }, { text: " — Place, year" }]),
    P("Skills", { style: "h1" }), bullet(""),
  ]) },
];

const sheet = (name, rows, opts = {}) => {
  const s = M().blank("s1", name);
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === null || v === undefined || v === "") return;
    const x = typeof v === "object" && !Array.isArray(v) ? v : { v };
    const { s: st, ...content } = x;
    s.cells.set(`${r},${c}`, { v: content.f ? null : content.v ?? null, ...(content.f ? { f: content.f } : {}), ...(st ? { s: st } : {}) });
  }));
  Object.assign(s, opts);
  return { sheets: [s] };
};
const H = (v) => ({ v, s: { b: true, bg: "#dbe5f1", border: { b: 1 } } });
const cur = /^en-GB/i.test(navigator.language) ? "£" : /^en-(US|CA|AU)/i.test(navigator.language) ? "$" : "€";
const money = (v) => ({ v, s: { nf: `${cur}#,##0.00` } });
const moneyF = (f, extra = {}) => ({ f, s: { nf: `${cur}#,##0.00`, ...extra } });

const SHEETS = [
  { id: "blank", name: "Blank spreadsheet", make: () => ({ sheets: [M().blank("s1", "Sheet1")] }) },
  { id: "budget", name: "Monthly budget", make: () => sheet("Budget", [
    [{ v: "Monthly budget", s: { b: true, size: 16 } }],
    [],
    [H("Income"), H("Planned"), H("Actual"), H("Difference")],
    ["Salary", money(2500), money(2500), moneyF("=C4-B4")],
    ["Other", money(0), money(0), moneyF("=C5-B5")],
    [{ v: "Total income", s: { b: true } }, moneyF("=SUM(B4:B5)", { b: true, border: { t: 1 } }), moneyF("=SUM(C4:C5)", { b: true, border: { t: 1 } }), moneyF("=C6-B6", { b: true, border: { t: 1 } })],
    [],
    [H("Spending"), H("Planned"), H("Actual"), H("Difference")],
    ["Rent or mortgage", money(1000), money(1000), moneyF("=B9-C9")],
    ["Bills", money(250), money(0), moneyF("=B10-C10")],
    ["Food", money(400), money(0), moneyF("=B11-C11")],
    ["Travel", money(150), money(0), moneyF("=B12-C12")],
    ["Other", money(200), money(0), moneyF("=B13-C13")],
    [{ v: "Total spending", s: { b: true } }, moneyF("=SUM(B9:B13)", { b: true, border: { t: 1 } }), moneyF("=SUM(C9:C13)", { b: true, border: { t: 1 } }), moneyF("=B14-C14", { b: true, border: { t: 1 } })],
    [],
    [{ v: "Left over", s: { b: true } }, moneyF("=B6-B14", { b: true, bg: "#e2efda" }), moneyF("=C6-C14", { b: true, bg: "#e2efda" })],
  ], { cols: { 0: 170, 1: 110, 2: 110, 3: 110 }, freeze: { r: 3, c: 0 } }) },
  { id: "invoice", name: "Invoice", make: () => sheet("Invoice", [
    [{ v: "INVOICE", s: { b: true, size: 20 } }, "", "", { v: "Invoice no.", s: { h: "right" } }, "0001"],
    ["Your business name", "", "", { v: "Date", s: { h: "right" } }, { f: "=TODAY()", s: { nf: "dd/mm/yyyy", h: "left" } }],
    ["Your address", "", "", { v: "Due", s: { h: "right" } }, { f: "=E2+30", s: { nf: "dd/mm/yyyy", h: "left" } }],
    [],
    [{ v: "Bill to", s: { b: true } }],
    ["Customer name"], ["Customer address"],
    [],
    [H("Description"), H("Quantity"), H("Unit price"), H(""), H("Amount")],
    ["Item or service", 1, money(100), "", moneyF("=B10*C10")],
    ["", "", "", "", moneyF('=IF(B11="","",B11*C11)')],
    ["", "", "", "", moneyF('=IF(B12="","",B12*C12)')],
    [],
    ["", "", "", { v: "Subtotal", s: { h: "right" } }, moneyF("=SUM(E10:E12)")],
    ["", "", "", { v: "VAT", s: { h: "right" } }, moneyF("=E14*0.2")],
    ["", "", "", { v: "Total", s: { b: true, h: "right" } }, moneyF("=E14+E15", { b: true, border: { t: 1, b: 3 } })],
  ], { cols: { 0: 240, 1: 80, 2: 100, 3: 90, 4: 110 } }) },
  { id: "timesheet", name: "Timesheet", make: () => sheet("Timesheet", [
    [{ v: "Timesheet", s: { b: true, size: 16 } }], ["Name"], [],
    [H("Date"), H("Start"), H("End"), H("Break (min)"), H("Hours")],
    ...Array.from({ length: 7 }, (_, i) => [{ v: null, s: { nf: "ddd dd/mm" } }, { v: null, s: { nf: "hh:mm" } }, { v: null, s: { nf: "hh:mm" } }, 30, { f: `=IF(C${5 + i}="","",(C${5 + i}-B${5 + i})*24-D${5 + i}/60)`, s: { nf: "0.00" } }]),
    [{ v: "Total", s: { b: true } }, "", "", "", { f: "=SUM(E5:E11)", s: { b: true, nf: "0.00", border: { t: 1 } } }],
  ], { cols: { 0: 120 }, freeze: { r: 4, c: 0 } }) },
  { id: "todo", name: "To-do list", make: () => sheet("To do", [
    [H("Task"), H("Who"), H("Due"), H("Done")],
    ["", "", { v: null, s: { nf: "dd/mm/yyyy" } }, false],
  ], { cols: { 0: 280, 1: 120, 2: 100, 3: 70 }, freeze: { r: 1, c: 0 } }) },
];

// Presentations: slides from the editor's layouts, with words in them.
const PR = () => window.OfficePresModel;
const SIZE = { w: 1280, h: 720 };
const fill = (els, texts) => els.map((e, i) => { const t = texts[i]; if (t === undefined || !e.blocks) return e; const def = e.blocks[0].def || {}; const lines = Array.isArray(t) ? t : [t];
  return { ...e, blocks: lines.map((x) => { const [text, level] = Array.isArray(x) ? x : [x, 0]; return { ...e.blocks[0], id: D().newId(), runs: text ? [{ text, ...def }] : [], ...(e.blocks[0].list ? { list: { ...e.blocks[0].list, level } } : {}), hint: undefined }; }) }; });
const slideOf = (kind, texts, theme = {}, extra = {}) => ({ id: "s" + PR().newId().slice(1), bg: "#ffffff", ...extra, els: [...(extra.shapes || []), ...fill(PR().layout(kind, SIZE, theme), texts)] });
const bar = (color, x, y, w, h) => ({ id: PR().newId(), type: "shape", shape: "rect", x, y, w, h, fill: color });
const deck = (slides) => ({ size: SIZE, slides: slides.map(({ shapes, ...s }) => s) });
const PRES = [
  { id: "blank", name: "Blank presentation", make: () => deck([slideOf("title", [])]) },
  { id: "pitch", name: "Pitch", make: () => { const t = { accent: "#ffffff", ink: "#dbeafe" }, c = { accent: "#1e3a5f", ink: "#1f2937" }; return deck([
    slideOf("title", ["Your company", "One line about what you do"], t, { bg: "#1e3a5f", shapes: [bar("#f59e0b", 560, 400, 160, 6)] }),
    slideOf("content", ["The problem", ["Who has it", "What it costs them", "Why now"]], c, { shapes: [bar("#f59e0b", 83, 150, 120, 6)] }),
    slideOf("content", ["Our answer", ["What we do", "How it works", "Why it's better"]], c, { shapes: [bar("#f59e0b", 83, 150, 120, 6)] }),
    slideOf("two", ["The numbers", ["Customers", "Revenue"], ["Growth", "Plans"]], c, { shapes: [bar("#f59e0b", 83, 150, 120, 6)] }),
    slideOf("section", ["Thank you", "your@email.com"], t, { bg: "#1e3a5f" }),
  ]); } },
  { id: "update", name: "Project update", make: () => { const c = { accent: "#0f766e", ink: "#1f2937" }; return deck([
    slideOf("title", ["Project update", new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })], c, { shapes: [bar("#0f766e", 0, 0, 1280, 24)] }),
    slideOf("content", ["Where we are", ["Done since last time", "In progress", "Next up"]], c, { shapes: [bar("#0f766e", 0, 0, 1280, 12)] }),
    slideOf("content", ["Risks and help needed", ["Risk, and what we're doing about it", "Decision needed from…"]], c, { shapes: [bar("#0f766e", 0, 0, 1280, 12)] }),
  ]); } },
  { id: "meeting", name: "Team meeting", make: () => { const c = { accent: "#7c3aed", ink: "#1f2937" }; return deck([
    slideOf("title", ["Team meeting", "Agenda and notes"], c, { shapes: [bar("#7c3aed", 0, 0, 40, 720)] }),
    slideOf("content", ["Agenda", ["Last week", "This week", "Anything else"]], c, { shapes: [bar("#7c3aed", 0, 0, 20, 720)] }),
    slideOf("content", ["Actions", ["Who does what, by when"]], c, { shapes: [bar("#7c3aed", 0, 0, 20, 720)] }),
  ]); } },
];

window.OfficeTemplates = { document: DOCS, spreadsheet: SHEETS, presentation: PRES };
})();
