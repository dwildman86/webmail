// The formula engine against Excel's answers. Run: node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const F = createRequire(import.meta.url)("../../assets/office/formula.js");

/** A little workbook: { Sheet1: { A1: 5, B2: "=A1*2" } } → value of each formula after calculating. */
function book(sheets) {
  const raw = new Map();
  const calc = new F.Calc((s, r, c) => raw.get(F.Calc.key(s, r, c)) ?? null, { has: (s) => s in sheets, used: () => ({ rows: 100, cols: 30 }) });
  for (const [sheet, cells] of Object.entries(sheets)) {
    for (const [a, v] of Object.entries(cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(a); const r = +m[2] - 1, c = F.colIndex(m[1]);
      if (typeof v === "string" && v.startsWith("=")) calc.set(sheet, r, c, v); else raw.set(F.Calc.key(sheet, r, c), v);
    }
  }
  calc.recalc();
  const get = (sheet, a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); const r = +m[2] - 1, c = F.colIndex(m[1]); return calc.value(sheet, r, c) ?? raw.get(F.Calc.key(sheet, r, c)); };
  return { calc, raw, get, set(sheet, a, v) { const m = /^([A-Z]+)(\d+)$/.exec(a); const r = +m[2] - 1, c = F.colIndex(m[1]); const k = F.Calc.key(sheet, r, c); if (typeof v === "string" && v.startsWith("=")) { calc.set(sheet, r, c, v); } else { calc.clear(sheet, r, c); raw.set(k, v); } return calc.recalc([k]); } };
}
const one = (formula, cells = {}) => book({ Sheet1: { ...cells, Z99: formula } }).get("Sheet1", "Z99");
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("arithmetic, precedence and text joining", () => {
  assert.equal(one("=1+2*3"), 7);
  assert.equal(one("=(1+2)*3"), 9);
  assert.equal(one("=2^3^2"), 64, "left to right, like Excel");
  assert.equal(one("=-2^2"), 4, "unary minus binds tighter than ^ in Excel");
  assert.equal(one("=50%*10"), 5);
  assert.equal(one('="a"&1&TRUE'), "a1TRUE");
  assert.equal(one("=1/0").code, "#DIV/0!");
  assert.equal(one('="x"+1').code, "#VALUE!");
  assert.equal(one('="3"+1'), 4, "numbers in text are numbers");
  assert.equal(one("=A1+1"), 1, "a blank cell is 0");
  assert.equal(one("=1=1"), true);
  assert.equal(one('="B">"a"'), true, "text compares ignoring case");
  assert.equal(one('=1<"a"'), true, "numbers sort before text");
  assert.equal(one("=nosuch(1)").code, "#NAME?");
});

test("references, ranges and other sheets", () => {
  const b = book({ Sheet1: { A1: 1, A2: 2, A3: 3, B1: "=SUM(A1:A3)", B2: "=SUM(A:A)", B3: "='Price list'!B2*2", B4: "=Sheet1!$A$2+A3", B5: "=SUM(2:2)" }, "Price list": { B2: 21 } });
  assert.equal(b.get("Sheet1", "B1"), 6);
  assert.equal(b.get("Sheet1", "B2"), 6);
  assert.equal(b.get("Sheet1", "B3"), 42);
  assert.equal(b.get("Sheet1", "B4"), 5);
  assert.equal(b.get("Sheet1", "B5"), 2 + 6, "row 2: A2 and B2's value");
  assert.equal(one("=Nowhere!A1").code, "#REF!");
});

test("only what depends on a change is calculated again, through ranges too", () => {
  const b = book({ Sheet1: { A1: 1, A2: 2, B1: "=A1*10", B2: "=SUM(A1:A2)", C1: "=B2+1", D1: "=7" } });
  const done = b.set("Sheet1", "A2", 5);
  assert.deepEqual([...done].sort(), ["Sheet1!0,2", "Sheet1!1,1"], "B2 (range) and C1 (B2's dependent), not B1 or D1");
  assert.equal(b.get("Sheet1", "C1"), 7);
  b.set("Sheet1", "A1", "=C1");
  assert.equal(b.get("Sheet1", "C1").code, "#CIRC!", "a loop is reported, not hung on");
});

test("maths and statistics", () => {
  const cells = { A1: 3, A2: 1, A3: 4, A4: 1, A5: 5, A6: "x", A7: true };
  assert.equal(one("=SUM(A1:A7)", cells), 14, "text and TRUE in a range are skipped");
  assert.equal(one("=AVERAGE(A1:A5)", cells), 2.8);
  assert.equal(one("=COUNT(A1:A7)", cells), 5);
  assert.equal(one("=COUNTA(A1:A7)", cells), 7);
  assert.equal(one("=MEDIAN(A1:A5)", cells), 3);
  assert.equal(one("=MODE(A1:A5)", cells), 1);
  assert.equal(one("=MAX(A1:A5)-MIN(A1:A5)", cells), 4);
  assert.equal(one("=LARGE(A1:A5,2)", cells), 4);
  assert.equal(one("=SMALL(A1:A5,2)", cells), 1);
  assert.equal(one("=RANK(4,A1:A5)", cells), 2);
  near(one("=STDEV(A1:A5)", cells), 1.7888543819998317);
  near(one("=STDEVP(A1:A5)", cells), 1.6);
  assert.equal(one("=PERCENTILE(A1:A5,0.5)", cells), 3);
  assert.equal(one("=SUMPRODUCT(A1:A2,A3:A4)", cells), 13);
  assert.equal(one("=ROUND(2.345,2)"), 2.35);
  assert.equal(one("=ROUND(-2.5,0)"), -3);
  assert.equal(one("=ROUND(1234.5,-2)"), 1200);
  assert.equal(one("=ROUNDUP(2.341,2)"), 2.35);
  assert.equal(one("=ROUNDDOWN(-2.349,2)"), -2.34);
  assert.equal(one("=MOD(-3,2)"), 1, "sign of the divisor, like Excel");
  assert.equal(one("=INT(-1.5)"), -2);
  assert.equal(one("=CEILING(4.1,0.5)"), 4.5);
  assert.equal(one("=FLOOR(4.9,2)"), 4);
  assert.equal(one("=MROUND(10,3)"), 9);
  assert.equal(one("=FACT(5)"), 120);
  assert.equal(one("=GCD(12,18)"), 6);
  assert.equal(one("=LCM(4,6)"), 12);
  assert.equal(one("=SQRT(-1)").code, "#NUM!");
  assert.equal(one("=SUBTOTAL(9,A1:A5)", cells), 14);
});

test("conditional sums and counts, with Excel's criteria", () => {
  const cells = { A1: "apple", A2: "banana", A3: "apricot", A4: "Apple", B1: 10, B2: 20, B3: 30, B4: 40, C1: "north", C2: "south", C3: "north", C4: "north" };
  assert.equal(one('=COUNTIF(A1:A4,"apple")', cells), 2, "ignoring case");
  assert.equal(one('=COUNTIF(A1:A4,"ap*")', cells), 3, "wildcards");
  assert.equal(one('=COUNTIF(B1:B4,">=20")', cells), 3);
  assert.equal(one('=COUNTIF(B1:B4,"<>20")', cells), 3);
  assert.equal(one('=SUMIF(A1:A4,"apple",B1:B4)', cells), 50);
  assert.equal(one('=SUMIFS(B1:B4,C1:C4,"north",B1:B4,">15")', cells), 70);
  assert.equal(one('=COUNTIFS(C1:C4,"north",A1:A4,"a*")', cells), 3);
  assert.equal(one('=AVERAGEIF(C1:C4,"north",B1:B4)', cells), 80 / 3);
  assert.equal(one('=MAXIFS(B1:B4,C1:C4,"north")', cells), 40);
  assert.equal(one('=MINIFS(B1:B4,C1:C4,"south")', cells), 20);
  assert.equal(one('=COUNTIF(D1:D4,"")', cells), 4, "blank cells match an empty criterion");
});

test("logic, including only working out the branch taken", () => {
  assert.equal(one("=IF(1>2,1/0,\"ok\")"), "ok");
  assert.equal(one("=IF(TRUE,5)"), 5);
  assert.equal(one("=IF(FALSE,5)"), false);
  assert.equal(one("=IFERROR(1/0,\"none\")"), "none");
  assert.equal(one("=IFNA(NA(),0)"), 0);
  assert.equal(one("=IFS(1>2,\"a\",2>1,\"b\")"), "b");
  assert.equal(one("=SWITCH(2,1,\"one\",2,\"two\",\"other\")"), "two");
  assert.equal(one("=SWITCH(9,1,\"one\",\"other\")"), "other");
  assert.equal(one("=CHOOSE(2,\"a\",\"b\",\"c\")"), "b");
  assert.equal(one("=AND(TRUE,1,2>1)"), true);
  assert.equal(one("=OR(FALSE,0)"), false);
  assert.equal(one("=XOR(TRUE,TRUE,TRUE)"), true);
  assert.equal(one("=NOT(0)"), true);
});

test("looking things up", () => {
  const cells = { A1: "Guji", A2: "Huila", A3: "Santos", B1: 12.5, B2: 11, B3: 9.75, D1: 0, D2: 100, D3: 500, E1: "bronze", E2: "silver", E3: "gold" };
  assert.equal(one('=VLOOKUP("Huila",A1:B3,2,FALSE)', cells), 11);
  assert.equal(one('=VLOOKUP("huila",A1:B3,2,FALSE)', cells), 11);
  assert.equal(one('=VLOOKUP("Kona",A1:B3,2,FALSE)', cells).code, "#N/A");
  assert.equal(one("=VLOOKUP(250,D1:E3,2)", cells), "silver", "approximate: the largest not over");
  assert.equal(one('=INDEX(B1:B3,MATCH("Santos",A1:A3,0))', cells), 9.75);
  assert.equal(one("=INDEX(A1:B3,2,2)", cells), 11);
  assert.equal(one('=XLOOKUP("Santos",A1:A3,B1:B3)', cells), 9.75);
  assert.equal(one('=XLOOKUP("Kona",A1:A3,B1:B3,"not sold")', cells), "not sold");
  assert.equal(one("=XLOOKUP(250,D1:D3,E1:E3,,-1)", cells), "silver", "next smaller");
  assert.equal(one('=HLOOKUP("b",{"a"},1)').code, "#NAME?", "array constants aren't supported: says so");
  assert.equal(one("=MATCH(100,D1:D3)", cells), 2);
  assert.equal(one("=ROWS(A1:B3)*COLUMNS(A1:B3)", cells), 6);
  assert.equal(one("=ROW(C7)+COLUMN(C7)"), 10);
  assert.equal(one('=SUM(INDIRECT("B1:B2"))', cells), 23.5);
});

test("text", () => {
  assert.equal(one('=CONCAT("a",1,"b")'), "a1b");
  assert.equal(one('=TEXTJOIN(", ",TRUE,"a","","b")'), "a, b");
  assert.equal(one('=LEFT("Northwind",5)&RIGHT("Coffee",3)'), "Northfee");
  assert.equal(one('=MID("Guji grade 1",6,5)'), "grade");
  assert.equal(one('=LEN("café")'), 4);
  assert.equal(one('=PROPER("ethiopia guji natural")'), "Ethiopia Guji Natural");
  assert.equal(one('=TRIM("  two   spaces ")'), "two spaces");
  assert.equal(one('=SUBSTITUTE("a-b-c","-","+")'), "a+b+c");
  assert.equal(one('=SUBSTITUTE("a-b-c","-","+",2)'), "a-b+c");
  assert.equal(one('=REPLACE("abcdef",2,3,"X")'), "aXef");
  assert.equal(one('=FIND("b","abcb")'), 2);
  assert.equal(one('=SEARCH("B?","xabc")'), 3);
  assert.equal(one('=SEARCH("B?","xab")').code, "#VALUE!", "? needs a character");
  assert.equal(one('=FIND("z","abc")').code, "#VALUE!");
  assert.equal(one('=EXACT("a","A")'), false);
  assert.equal(one('=VALUE("£1,200.50")'), 1200.5);
  assert.equal(one('=TEXT(1234.5,"#,##0.00")'), "1,234.50");
  assert.equal(one('=TEXTBEFORE("sales@northwind.test","@")'), "sales");
  assert.equal(one('=TEXTAFTER("sales@northwind.test","@")'), "northwind.test");
  assert.equal(one('=REPT("ab",3)'), "ababab");
});

test("dates are Excel serials", () => {
  assert.equal(F.serial(2026, 11, 13), 46339);
  assert.equal(one("=DATE(2026,11,13)"), 46339);
  assert.equal(one("=DATE(2026,13,1)"), F.serial(2027, 1, 1), "month 13 rolls over");
  assert.equal(one("=YEAR(46339)&\"-\"&MONTH(46339)&\"-\"&DAY(46339)"), "2026-11-13");
  assert.equal(one("=WEEKDAY(46339)"), 6, "a Friday");
  assert.equal(one("=WEEKDAY(46339,2)"), 5);
  assert.equal(one("=EDATE(DATE(2026,1,31),1)"), F.serial(2026, 2, 28));
  assert.equal(one("=EOMONTH(DATE(2024,2,10),0)"), F.serial(2024, 2, 29));
  assert.equal(one("=DATEDIF(DATE(2020,5,15),DATE(2026,11,13),\"Y\")"), 6);
  assert.equal(one("=DATEDIF(DATE(2020,5,15),DATE(2026,11,13),\"YM\")"), 5);
  assert.equal(one("=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,20))"), 10);
  assert.equal(one("=WORKDAY(DATE(2026,11,13),1)"), F.serial(2026, 11, 16), "Friday + 1 working day is Monday");
  assert.equal(one("=DAYS(DATE(2026,12,25),DATE(2026,11,13))"), 42);
  near(one("=TIME(9,30,0)"), 9.5 / 24);
  assert.equal(one("=HOUR(TIME(9,30,0))*100+MINUTE(TIME(9,30,0))"), 930);
  assert.equal(one('=DATEVALUE("13/11/2026")'), 46339);
  assert.equal(one("=ISOWEEKNUM(DATE(2026,11,13))"), 46);
});

test("money", () => {
  const r = 0.05 / 12, f = Math.pow(1 + r, 36), payment = -(r * 10000 * f) / (f - 1);
  near(one("=PMT(0.05/12,36,10000)"), payment, 1e-9);
  near(payment, -299.71, 0.005);
  near(one("=FV(0.04/12,12,-100)"), 100 * (Math.pow(1 + 0.04 / 12, 12) - 1) / (0.04 / 12), 1e-9);
  near(one("=FV(0.04/12,12,-100)"), 1222.25, 0.005, "Excel's answer");
  near(one("=PV(0.05,10,-1000)"), 7721.734929, 1e-5);
  near(one("=NPV(0.1,-1000,300,400,500)"), -1000 / 1.1 + 300 / 1.21 + 400 / 1.331 + 500 / 1.4641, 1e-9);
  near(one("=IRR(A1:A4)", { A1: -1000, A2: 300, A3: 400, A4: 500 }), 0.0889633947, 1e-8);
  near(one(`=RATE(36,${payment},10000)`), 0.05 / 12, 1e-8);
});

test("information functions", () => {
  assert.equal(one("=ISBLANK(A1)"), true);
  assert.equal(one("=ISNUMBER(A1)", { A1: 2 }), true);
  assert.equal(one("=ISTEXT(A1)", { A1: "x" }), true);
  assert.equal(one("=ISERROR(1/0)"), true);
  assert.equal(one("=ISNA(NA())"), true);
  assert.equal(one("=ISERR(NA())"), false);
  assert.equal(one("=ISEVEN(4)"), true);
});

test("what people type: numbers, money, percentages, dates and times", () => {
  assert.deepEqual(F.parseInput("1,234.50"), { value: 1234.5, format: "#,##0.00" });
  assert.deepEqual(F.parseInput("£12"), { value: 12, format: "£#,##0" });
  assert.deepEqual(F.parseInput("-£12.50"), { value: -12.5, format: "£#,##0.00" });
  assert.deepEqual(F.parseInput("12.5%"), { value: 0.125, format: "0.0%" });
  assert.equal(F.parseInput("13/11/2026").value, 46339);
  assert.equal(F.parseInput("11/13/2026", { dmy: false }).value, 46339);
  assert.equal(F.parseInput("2026-11-13").format, "yyyy-mm-dd");
  assert.equal(F.parseInput("13 Nov 2026").value, 46339);
  assert.equal(F.parseInput("31/02/2026").value, "31/02/2026", "not a real date: text");
  assert.equal(F.parseInput("09:30").type, "time");
  assert.equal(F.parseInput("TRUE").value, true);
  assert.deepEqual(F.parseInput("007"), { value: 7 }, "a number; leading zeros need text format, as in Excel");
  assert.equal(F.parseInput("Guji").value, "Guji");
});

test("number formats like Excel's", () => {
  const f = (v, fmt) => F.format(v, fmt).text;
  assert.equal(f(1234.567, "#,##0.00"), "1,234.57");
  assert.equal(f(-1234.5, "£#,##0.00"), "-£1,234.50");
  assert.equal(f(-5, "0.00;(0.00)"), "(5.00)");
  assert.equal(f(0, "0;-0;\"zero\""), "zero");
  assert.equal(f(0.256, "0.0%"), "25.6%");
  assert.equal(f(5, "000"), "005");
  assert.equal(f(1.5, "#.##"), "1.5");
  assert.equal(f(1234567, "#,##0,\"k\""), "1,235k");
  assert.equal(f(12345.678, "0.00E+00"), "1.23E+04");
  assert.equal(f(46339, "dd/mm/yyyy"), "13/11/2026");
  assert.equal(f(46339, "d mmm yyyy"), "13 Nov 2026");
  assert.equal(f(46339, "dddd d mmmm"), "Friday 13 November");
  assert.equal(f(46339.75, "hh:mm"), "18:00");
  assert.equal(f(46339.75, "h:mm AM/PM"), "6:00 PM");
  assert.equal(f(1.5, "[h]:mm"), "36:00");
  assert.equal(f("Guji", "\"Origin: \"@"), "Origin: Guji");
  assert.equal(F.format(-3, "0;[Red]-0").color, "red");
  assert.equal(F.formatGeneral(1 / 3), "0.33333333333");
  assert.equal(F.formatGeneral(123456789012345), "1.23457E+14");
  assert.equal(F.formatGeneral(0.1 + 0.2), "0.3");
});

test("copying and filling formulas moves their references", () => {
  assert.equal(F.shift("=A1+$B$1+C$2+$D3", 2, 1), "=B3+$B$1+D$2+$D5");
  assert.equal(F.shift("=SUM(A1:A3)*'My sheet'!B2", 1, 0), "=SUM(A2:A4)*'My sheet'!B3");
  assert.equal(F.shift("=A1", -1, 0), "=#REF!");
  assert.equal(F.shift('="A1"&A1', 0, 1), '="A1"&B1', "text that looks like a reference stays");
});

test("inserting and deleting rows and columns keeps references right", () => {
  assert.equal(F.adjust("=A5+SUM(A1:A10)", "Sheet1", "Sheet1", "r", 2, 3), "=A8+SUM(A1:A13)");
  assert.equal(F.adjust("=A5+SUM(A1:A10)", "Sheet1", "Sheet1", "r", 4, -1), "=#REF!+SUM(A1:A9)");
  assert.equal(F.adjust("=SUM(B1:D1)", "Sheet1", "Sheet1", "c", 1, -3), "=SUM(#REF!)", "as Excel writes it");
  assert.equal(F.adjust("=Other!A5", "Sheet1", "Sheet1", "r", 0, 1), "=Other!A5", "another sheet's rows didn't move");
  assert.equal(F.renameSheet("='Old name'!A1+Old!B2", "Old name", "Prices"), "=Prices!A1+Old!B2");
});

test("formulas that can't be read say so instead of breaking", () => {
  assert.throws(() => F.parse("=SUM(1,"));
  assert.throws(() => F.parse('="unclosed'));
  const b = book({ Sheet1: { A1: "=SUM(1," } });
  assert.equal(b.get("Sheet1", "A1").code, "#NAME?");
});
