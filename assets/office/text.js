// Plain text and Markdown files (.txt, .md): one text area, edited together. Markdown has a preview beside it.
"use strict";

(() => {
const UI = () => window.OfficeUI;

// ---------------------------------------------------------------------------------------------- the model
// state: { text }. Op: { t: "text", at, del, ins }.
function mapPos(p, a, end = false) {
  const L = a.ins.length, d = a.del;
  if (p < a.at || (end && p === a.at && d === 0)) return p;
  if (p > a.at + d || (p === a.at + d && !end)) return p - d + L;
  return end ? a.at : a.at + L;
}
const model = {
  apply(st, op) { if (op.t !== "text") return null; const at = Math.max(0, Math.min(op.at, st.text.length)); st.text = st.text.slice(0, at) + op.ins + st.text.slice(at + Math.max(0, op.del)); return true; },
  clone: (st) => ({ text: st.text }),
  rebase(op, against) {
    let o = op;
    for (const a of against) {
      if (a.t !== "text") continue;
      const s = mapPos(o.at, a);
      const e = o.del ? Math.max(s, mapPos(o.at + o.del, a, true)) : s;
      o = { ...o, at: s, del: e - s };
    }
    return o;
  },
  inverse: (st, op) => ({ t: "text", at: op.at, del: op.ins.length, ins: st.text.slice(op.at, op.at + op.del) }),
};

// ---------------------------------------------------------------------------------------------- Markdown preview (escaped first: nothing in the file runs)
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (/^(https?:|mailto:|#)/i.test(u.replace(/&amp;/g, "&")) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : t));
}
function markdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(l)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${markdown(q.join("\n"))}</blockquote>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { const t = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""); items.push(t.replace(/^\[( |x)\]\s*/i, (mm, x) => (x.trim() ? "☑ " : "☐ "))); }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-+/.test(lines[i + 1] || "")) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------- the view
function mount(host, ctx) {
  const { h } = ctx;
  const md = /\.md$/i.test(ctx.file.name);
  const ta = h("textarea", { class: "ox-text", spellcheck: true, "aria-label": ctx.file.name, readOnly: ctx.readOnly, wrap: "soft" });
  ta.value = ctx.state.text;
  let last = ta.value;
  const preview = h("div", { class: "ox-md", hidden: true });
  const wrap = h("div", { class: "ox-text-wrap" }, ta, preview);
  host.append(wrap);
  // Markdown preview on wide screens beside, on phones instead of the text.
  let showing = md && window.innerWidth > 900;
  const drawPreview = () => {
    preview.hidden = !showing;
    wrap.classList.toggle("split", showing);
    if (!showing) return;
    // Parsed into an inert document first, so nothing in it runs or loads before it's checked.
    const doc = new DOMParser().parseFromString(`<div>${markdown(ta.value)}</div>`, "text/html");
    preview.replaceChildren(...doc.body.firstChild.childNodes);
  };
  if (md) {
    ctx.toolbar.append(
      ctx.tool("bold", "Bold", () => surround("**")), ctx.tool("italic", "Italic", () => surround("_")), ctx.tool("heading", "Heading", () => prefix("## ")),
      ctx.tool("bullets", "List", () => prefix("- ")), ctx.tool("numbers", "Numbered list", () => prefix("1. ")), ctx.tool("link", "Link", () => surround("[", "](https://)")),
      h("span", { class: "ox-sep" }), ctx.tool("preview", "Preview", () => { showing = !showing; drawPreview(); }));
  } else ctx.toolbar.hidden = true;
  drawPreview();

  const send = (group = "type") => {
    const now = ta.value;
    if (now === last) return;
    let a = 0;
    while (a < now.length && a < last.length && now[a] === last[a]) a++;
    let b = 0;
    while (b < now.length - a && b < last.length - a && now[now.length - 1 - b] === last[last.length - 1 - b]) b++;
    const op = { t: "text", at: a, del: last.length - a - b, ins: now.slice(a, now.length - b) };
    last = now;
    ctx.commit(op, { group });
    if (showing) drawPreview();
  };
  ta.addEventListener("input", () => send());
  const sel = () => ctx.presence({ at: ta.selectionStart, end: ta.selectionEnd });
  ta.addEventListener("select", sel);
  ta.addEventListener("keyup", sel);
  ta.addEventListener("click", sel);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !ctx.readOnly) { e.preventDefault(); ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end"); send(); }
  });
  function surround(before, after = before) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(before + ta.value.slice(s, e) + after, s, e, "select");
    ta.setSelectionRange(s + before.length, e + before.length);
    send("fmt"); ta.focus();
  }
  function prefix(p) {
    const s = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    ta.setRangeText(p, s, s, "end");
    send("fmt"); ta.focus();
  }
  return {
    refresh() {
      // Others' typing: the text changes, and the cursor stays where it was among the words.
      const now = ctx.state.text;
      if (now === ta.value) { last = now; return; }
      const old = ta.value;
      let a = 0;
      while (a < now.length && a < old.length && now[a] === old[a]) a++;
      let b = 0;
      while (b < now.length - a && b < old.length - a && now[now.length - 1 - b] === old[old.length - 1 - b]) b++;
      const op = { at: a, del: old.length - a - b, ins: now.slice(a, now.length - b) };
      const s = mapPos(ta.selectionStart, op), e = mapPos(ta.selectionEnd, op, true);
      const top = ta.scrollTop;
      ta.value = now;
      last = now;
      if (document.activeElement === ta) ta.setSelectionRange(s, Math.max(s, e));
      ta.scrollTop = top;
      if (showing) drawPreview();
    },
    focus: () => ta.focus(),
    anchorLabel: () => "",
    print: () => {
      const body = document.createElement("div");
      if (md) body.append(...new DOMParser().parseFromString(`<div>${markdown(ta.value)}</div>`, "text/html").body.firstChild.childNodes);
      else { const pre = document.createElement("pre"); pre.textContent = ta.value; body.append(pre); }
      UI().printHtml(ctx.file.name, body, "body { font: 11pt/1.5 Georgia, serif; margin: 0; }\npre { white-space: pre-wrap; font: 10pt/1.4 Consolas, monospace; }\ntable { border-collapse: collapse; }\ntd, th { border: 1px solid #999; padding: 4px 8px; }");
    },
    destroy() {},
  };
}

window.OfficeKinds = window.OfficeKinds || {};
window.OfficeKinds.text = {
  model,
  async load(bytes) { return { state: { text: new TextDecoder().decode(bytes).replace(/^﻿/, "") }, unsupported: [] }; },
  async save(st, file) { return new Blob([st.text], { type: /\.md$/i.test(file.name) ? "text/markdown" : "text/plain" }); },
  get formats() { return [{ label: "Download", ext: null, make: (st, file) => new Blob([st.text], { type: "text/plain" }) }]; },
  mount,
  blank: () => ({ text: "" }),
  markdown,
};
})();
