// A file request (share.php): files sent in pieces, like the webmail's own uploads. No sign-in; the link is the key.
"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const box = document.getElementById("share-upload");
  if (!box) return;
  const input = document.getElementById("share-files");
  const list = document.getElementById("share-progress");
  const drop = box.querySelector(".drop");
  const max = Number(box.dataset.max) || Infinity;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const human = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function send(file) {
    const li = el("li"); const name = el("span", null, file.name); const bar = el("progress"); bar.max = file.size || 1; bar.value = 0;
    li.append(name, bar); list.append(li);
    const fail = (msg) => { bar.replaceWith(el("span", "bad", msg)); };
    if (file.size > max) return fail(`Too big (over ${human(max)})`);
    try {
      const res = await fetch(box.dataset.start, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size }) });
      const start = await res.json();
      if (!res.ok) return fail(start.message || "Not accepted");
      for (let offset = 0; !start.done && offset < file.size; offset += start.piece) {
        const r = await fetch(`${box.dataset.piece}&u=${encodeURIComponent(start.upload)}&offset=${offset}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + start.piece) });
        const d = await r.json();
        if (!r.ok) return fail(d.message || "It didn't go through");
        bar.value = d.received;
      }
      bar.replaceWith(el("span", "done", "Sent ✓"));
    } catch { fail("It didn't go through: check your connection and try again"); }
  }
  const take = async (files) => { for (const f of files) await send(f); };
  input.addEventListener("change", () => { take([...input.files]); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dropping"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dropping"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dropping"); take([...e.dataTransfer.files]); });
});
