// Files: your documents, folders shared with people and mailbox teams, share links, and a private vault encrypted
// in this browser. Plain JavaScript like app.js (it uses app.js's h, icon, api, toast, popMenu and formFor).
// Uploads go in pieces (api.php?a=files/upload/…), so big files and slow connections are fine.
"use strict";

(() => {
const W = () => window.Webmail;
const FS = {
  view: "mine", folder: null, data: null, query: "",
  uploads: [],       // { name, size, sent, state: "sending"|"done"|"failed", error }
};
let $pane = null;

const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);
const fmtWhen = (iso) => {
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};
const VIEWS = [["mine", "My files", "folder"], ["shared", "Shared with me", "people"], ["recent", "Recent", "clock"], ["vault", "Private vault", "lock"], ["trash", "Bin", "trash"]];
const kindIcon = (it) => it.kind === "folder" ? "folder" : /^image\//.test(it.mime) ? "image" : "file";
/** Files the editors open: documents, spreadsheets, text. */
const EDITABLE = /\.(docx|xlsx|pptx|csv|txt|md)$/i;
const editable = (it) => it.kind === "file" && EDITABLE.test(it.name || "") && FS.view !== "vault" && FS.view !== "trash";

// ------------------------------------------------------------------------------------------------ the editors (assets/office), loaded the first time they're needed

let officeLoading = null;
function loadOffice() {
  if (officeLoading) return officeLoading;
  const v = (document.querySelector('script[src*="files.js"]')?.getAttribute("src") || "").split("?v=")[1] || "";
  document.head.append(W().h("link", { rel: "stylesheet", href: `assets/office/office.css?v=${v}` }));
  const names = ["formula", "ooxml", "collab", "sheet-model", "sheet-extras", "doc-model", "pres-model", "pptx", "editor", "text", "sheet", "doc", "slides", "templates"];
  // In order (async off), all requested at once.
  officeLoading = Promise.all(names.map((n) => new Promise((ok, bad) => {
    const el = document.createElement("script");
    el.src = `assets/office/${n}.js?v=${v}`;
    el.async = false;
    el.onload = ok;
    el.onerror = () => bad(new Error("The editor couldn't be loaded. Check your connection and try again."));
    document.head.append(el);
  })));
  officeLoading.catch(() => { officeLoading = null; });
  return officeLoading;
}
async function openEditor(it) {
  try { await loadOffice(); } catch (err) { W().toast(err.message); return; }
  window.OfficeEditor.open(it, { onClose: () => { if (document.querySelector(".files")) show(); } });
}
/** Files → New: a document, spreadsheet or text file, from a template, opened to edit. */
async function newOffice(kind) {
  try { await loadOffice(); } catch (err) { W().toast(err.message); return; }
  const { h } = W();
  const ext = { document: "docx", spreadsheet: "xlsx", presentation: "pptx", text: "txt" }[kind];
  const templates = window.OfficeTemplates[kind] || [{ id: "blank", name: "Blank", make: () => window.OfficeKinds.text.blank() }];
  const chosen = templates.length === 1 ? templates[0] : await dialog(kind === "document" ? "New document" : kind === "presentation" ? "New presentation" : "New spreadsheet", (body, done) => {
    body.append(h("div", { class: "files-templates" }, templates.map((t) => h("button", { type: "button", class: "files-template", onclick: () => done(t) },
      h("span", { class: `files-template-art ${kind} ${t.id}` }), h("span", {}, t.name)))));
  }, { wide: true });
  if (!chosen) return;
  const base = chosen.id === "blank" ? (kind === "document" ? "Untitled document" : kind === "spreadsheet" ? "Untitled spreadsheet" : kind === "presentation" ? "Untitled presentation" : "Notes") : chosen.name;
  const name = await ask("Name", "Name", `${base}.${ext}`);
  if (!name) return;
  const finalName = new RegExp(`\\.${ext}$`, "i").test(name) || (kind === "spreadsheet" && /\.csv$/i.test(name)) || (kind === "text" && /\.md$/i.test(name)) ? name : `${name}.${ext}`;
  try {
    const blob = await window.OfficeKinds[kind].save(chosen.make(), { name: finalName });
    const node = await uploadOne(new File([blob], finalName, { type: blob.type }), FS.folder, { track: false, name: finalName });
    show();
    openEditor({ ...node, name: node?.name || finalName, role: "owner" });
  } catch (err) { W().toast(err.message); }
}

// ------------------------------------------------------------------------------------------------ dialogs

const openDialogs = [];
/** A dialog: resolves with what done() is called with (null when closed). */
function dialog(title, build, { wide = false } = {}) {
  const { h, icon } = W();
  return new Promise((resolve) => {
    // Escape closes it wherever the focus is (a redraw can leave it on the page behind).
    const esc = (e) => { if (e.key === "Escape" && openDialogs[openDialogs.length - 1] === overlay && !document.querySelector(".pop-menu")) { e.stopPropagation(); done(null); } };
    const done = (v) => { document.removeEventListener("keydown", esc, true); openDialogs.splice(openDialogs.indexOf(overlay), 1); overlay.remove(); resolve(v ?? null); };
    const body = h("div", { class: "pad files-dialog-body" });
    const overlay = h("div", { class: "overlay center", onclick: (e) => { if (e.target === overlay) done(null); } },
      h("div", { class: `dialog ${wide ? "" : "small-dialog"} files-dialog`, role: "dialog", "aria-label": title },
        h("div", { class: "dialog-head" }, h("h2", {}, title), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => done(null) }, icon("close"))), body));
    document.body.append(overlay);
    openDialogs.push(overlay);
    document.addEventListener("keydown", esc, true);
    Promise.resolve(build(body, done)).then(() => body.querySelector("input, select, button.btn-primary")?.focus());
  });
}

const ask = (title, label, value = "") => dialog(title, (body, done) => {
  const { h } = W();
  const input = h("input", { value, required: true });
  body.append(h("form", { onsubmit: (e) => { e.preventDefault(); done(input.value.trim() || null); } },
    h("label", { class: "field" }, label, input), h("div", { class: "row end" }, h("button", { class: "btn btn-primary" }, "OK"))));
  setTimeout(() => { input.focus(); const dot = value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : value.length); });
});

// ------------------------------------------------------------------------------------------------ the view

async function show(opts = {}) {
  $pane = document.querySelector(".cal-pane");
  if (!$pane) return;
  // The webmail's 30-second refresh: quietly, and not while something's open or uploading.
  const again = !Object.keys(opts).length && $pane.querySelector(".files-head");
  if (again && (document.querySelector(".pop-menu, .overlay") || FS.uploads.some((u) => u.state === "sending"))) return;
  if (opts.view) { FS.view = opts.view; FS.folder = null; FS.query = ""; }
  if ("folder" in opts) FS.folder = opts.folder;
  if (FS.view === "vault") return Vault.show();
  try {
    const q = FS.folder ? { folder: FS.folder } : FS.query ? { view: "search", q: FS.query } : { view: FS.view };
    FS.data = await W().api("files", { query: q });
  } catch (err) {
    if (!again) $pane.replaceChildren(W().h("div", { class: "placeholder" }, W().h("div", {}, W().icon("folder"), W().h("p", {}, err.message))));
    return;
  }
  render();
}

function sideNav() {
  const { h, icon } = W();
  const d = FS.data;
  const u = d?.usage;
  return h("nav", { class: "files-nav", "aria-label": "Files" },
    VIEWS.map(([key, label, ic]) => h("button", { type: "button", class: `files-nav-item${FS.view === key && !FS.query ? " on" : ""}`,
      onclick: () => show({ view: key }) }, icon(ic), label)),
    u && h("div", { class: "files-usage" }, h("div", { class: "files-usage-bar" }, h("span", { class: "files-usage-fill", "data-pct": u.quota ? Math.min(100, Math.round(100 * u.used / u.quota)) : 0 })),
      h("small", { class: "muted" }, u.quota ? `${fmtSize(u.used)} of ${fmtSize(u.quota)} used` : `${fmtSize(u.used)} used`)));
}

function render() {
  const { h, icon } = W();
  const d = FS.data;
  const canAdd = d.allowed && (d.role === "owner" || d.role === "editor") && ["mine", "shared"].includes(d.view) && !(d.view === "shared" && !d.folder);
  const title = FS.query ? `Results for “${FS.query}”` : d.folder ? d.folder.name : VIEWS.find(([k]) => k === d.view)?.[1] || "Files";
  const crumbs = d.folder ? h("div", { class: "files-crumbs" },
    h("button", { type: "button", class: "linkish", onclick: () => show({ view: d.view === "shared" ? "shared" : "mine" }) }, d.view === "shared" ? "Shared with me" : "My files"),
    d.folder.path.map((p, i) => [" / ", i === d.folder.path.length - 1 ? h("strong", {}, p.name) : h("button", { type: "button", class: "linkish", onclick: () => show({ folder: p.id }) }, p.name)])) : null;
  const search = h("input", { type: "search", class: "input files-search", placeholder: "Search files", value: FS.query, "aria-label": "Search files",
    onkeydown: (e) => { if (e.key === "Enter") { FS.query = e.target.value.trim(); FS.folder = null; show(); } if (e.key === "Escape") { FS.query = ""; show(); } } });
  const fileIn = h("input", { type: "file", multiple: true, hidden: true, onchange: () => { uploadMany([...fileIn.files], d.folder?.id ?? null); fileIn.value = ""; } });
  const head = h("div", { class: "files-head" },
    h("div", { class: "files-title" }, h("h2", {}, title), crumbs),
    h("div", { class: "files-actions" }, search,
      canAdd && h("button", { class: "btn", type: "button", "aria-haspopup": "menu", onclick: (e) => W().popMenu(e.currentTarget, [
        { label: "Folder", icon: "folder", run: newFolder },
        { label: "Document", icon: "file", hint: ".docx", run: () => newOffice("document") },
        { label: "Spreadsheet", icon: "layers", hint: ".xlsx", run: () => newOffice("spreadsheet") },
        { label: "Presentation", icon: "file", hint: ".pptx", run: () => newOffice("presentation") },
        { label: "Text file", icon: "note", hint: ".txt", run: () => newOffice("text") }]) }, icon("compose"), "New"),
      canAdd && h("button", { class: "btn btn-primary", type: "button", onclick: () => fileIn.click() }, icon("upload"), "Upload"), fileIn,
      d.view === "trash" && d.items.length > 0 && h("button", { class: "btn", type: "button", onclick: emptyBin }, "Empty bin")));
  const notice = !d.allowed ? h("div", { class: "notice warn" }, "Adding files needs an active GhostParse plan. Your files are still here to open, download or delete.")
    : d.view === "trash" ? h("p", { class: "muted small files-hint" }, `Things in the bin are deleted for good after ${d.rules.trash_days} days.`)
      : d.view === "shared" && !d.folder ? h("p", { class: "muted small files-hint" }, "Files and folders other people have shared with you, or with a mailbox you read.") : null;
  const list = d.items.length ? h("div", { class: "files-list", role: "table" },
    h("div", { class: "files-row files-row-head", role: "row" }, h("span", {}, "Name"), h("span", {}, d.view === "trash" ? "Deleted" : "Modified"), h("span", {}, "Size"), h("span", {})),
    d.items.map(row)) : h("div", { class: "files-empty" }, icon(d.view === "trash" ? "trash" : "folder"),
    h("p", {}, FS.query ? "Nothing matches." : d.view === "trash" ? "The bin is empty." : d.view === "shared" && !d.folder ? "Nothing's been shared with you yet." : d.view === "recent" ? "No files yet." : "Drop files here, or choose Upload."));
  const main = h("div", { class: "files-main" }, head, notice, list, uploadsPanel());
  if (canAdd) dropTarget(main, d.folder?.id ?? null);
  $pane.replaceChildren(h("div", { class: "files" }, sideNav(), main));
  $pane.querySelectorAll(".files-usage-fill").forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
}

function row(it) {
  const { h, icon } = W();
  const open = () => it.kind === "folder" ? (FS.view === "trash" ? null : show({ folder: it.id })) : FS.view === "trash" ? null : editable(it) ? openEditor(it) : preview(it);
  const more = h("button", { type: "button", class: "icon-btn", "aria-label": `More for ${it.name}`, onclick: (e) => { e.stopPropagation(); W().popMenu(e.currentTarget, menuFor(it)); } }, icon("more"));
  return h("div", { class: "files-row", role: "row", tabindex: "0", onclick: open, onkeydown: (e) => { if (e.key === "Enter") open(); },
    oncontextmenu: (e) => { e.preventDefault(); W().popMenu(more, menuFor(it)); } },
    h("span", { class: "files-name" }, h("span", { class: `files-icon ${it.kind}` }, icon(kindIcon(it))), h("span", { class: "files-label" }, it.name),
      it.shared && h("span", { class: "pill", title: "Shared" }, icon("people")), it.role && it.role !== "owner" && h("span", { class: "pill quiet" }, it.role === "editor" ? "can edit" : "view only")),
    h("span", { class: "muted small" }, fmtWhen(it.trashed_at || it.updated_at)), h("span", { class: "muted small" }, it.kind === "file" ? fmtSize(it.size) : ""), more);
}

function menuFor(it) {
  const items = [];
  const edit = it.role === "owner" || it.role === "editor";
  if (FS.view === "trash") {
    return [{ label: "Restore", icon: "restore", run: () => act("files/restore", { id: it.id }, `${it.name} is back.`) },
      { label: "Delete for good", icon: "trash", class: "danger", run: async () => { if (confirm(`Delete “${it.name}” for good? It can't be undone.`)) act("files/delete", { id: it.id }, "Deleted."); } }];
  }
  if (it.kind === "file") {
    if (editable(it)) items.push({ label: edit && FS.data?.allowed ? "Edit" : "Open", icon: edit && FS.data?.allowed ? "compose" : "eye", run: () => openEditor(it) });
    else items.push({ label: "Open", icon: "eye", run: () => preview(it) });
    items.push({ label: "Download", icon: "download", run: () => download(it) });
  } else {
    items.push({ label: "Open", icon: "folder", run: () => show({ folder: it.id }) }, { label: "Download as ZIP", icon: "download", run: () => { location.href = `api.php?a=files/zip&id=${it.id}`; } });
  }
  items.push(null, { label: "Share", icon: "people", run: () => shareDialog(it) });
  if (edit) {
    items.push({ label: "Rename", icon: "compose", run: async () => { const n = await ask("Rename", "Name", it.name); if (n && n !== it.name) act("files/rename", { id: it.id, name: n }); } },
      { label: "Move to…", icon: "archive", run: () => moveDialog(it) });
  }
  if (it.kind === "file") {
    items.push({ label: "Make a copy", icon: "layers", run: () => act("files/copy", { id: it.id }, "Copied.") });
    if (edit) items.push({ label: "Upload a new version", icon: "upload", run: () => newVersion(it) });
    items.push({ label: "Versions", icon: "history", run: () => versionsDialog(it) });
  }
  items.push({ label: "Activity", icon: "clock", run: () => activityDialog(it) });
  if (edit) items.push(null, { label: "Delete", icon: "trash", class: "danger", run: () => act("files/trash", { id: it.id }, `${it.name} is in the bin.`, () => act("files/restore", { id: it.id }, "Restored.")) });
  return items;
}

async function act(action, body, message, undo) {
  try {
    await W().api(action, { method: "POST", body });
    if (message) W().toast(message, undo ? { label: "Undo", run: undo } : undefined);
  } catch (err) { W().toast(err.message); }
  show();
}

async function newFolder() {
  const name = await ask("New folder", "Name");
  if (name) act("files/folder", { parent_id: FS.folder, name });
}

async function emptyBin() {
  if (confirm("Delete everything in the bin for good? It can't be undone.")) act("files/empty-trash", {}, "The bin is empty.");
}

function download(it) {
  location.href = `api.php?a=files/download&id=${it.id}`;
}

// ------------------------------------------------------------------------------------------------ uploading

/** One file, in pieces. $bytes: a Blob (or an encrypted stream's producer for the vault). Resolves with the new file. */
async function uploadOne(file, parentId, { nodeId = null, vault = false, size = file.size, pieces = null, name = file.name, track = true } = {}) {
  const job = { name: track ? file.name : name, size, sent: 0, state: "sending" };
  if (track) { FS.uploads.push(job); renderUploads(); }
  try {
    const start = await W().api("files/upload/start", { method: "POST", body: { parent_id: parentId, name, size, node_id: nodeId, vault } });
    let result = start;
    if (!start.done) {
      const send = async (blob, offset) => {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(`api.php?a=files/upload/piece&u=${encodeURIComponent(start.upload)}&offset=${offset}`, {
            method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": W().csrf(), "Content-Type": "application/octet-stream" }, body: blob });
          const data = await res.json().catch(() => ({}));
          if (res.ok) return data;
          if (attempt >= 2 || res.status < 500) throw new Error(data.message || "The upload didn't go through.");
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      };
      if (pieces) {
        let offset = 0;
        for await (const piece of pieces(start.piece)) { result = await send(piece, offset); offset += piece.size ?? piece.byteLength; job.sent = offset; renderUploads(); }
      } else {
        for (let offset = 0; offset < size; offset += start.piece) {
          result = await send(file.slice(offset, offset + start.piece), offset);
          job.sent = Math.min(size, offset + start.piece);
          renderUploads();
        }
      }
    }
    job.state = "done"; job.sent = size; renderUploads();
    return result.file;
  } catch (err) {
    job.state = "failed"; job.error = err.message; renderUploads();
    throw err;
  }
}

async function uploadMany(files, parentId) {
  const max = FS.data?.rules?.max_file || Infinity;
  for (const f of files) {
    if (f.size > max) { W().toast(`${f.name} is bigger than the ${fmtSize(max)} allowed.`); continue; }
    try { await uploadOne(f, parentId); } catch (err) { W().toast(`${f.name}: ${err.message}`); }
  }
  setTimeout(() => { FS.uploads = FS.uploads.filter((u) => u.state === "sending"); renderUploads(); }, 4000);
  show();
}

async function newVersion(it) {
  const { h } = W();
  const input = h("input", { type: "file", hidden: true, onchange: async () => {
    const f = input.files[0];
    if (f) { try { await uploadOne(f, null, { nodeId: it.id, name: it.name }); W().toast(`New version of ${it.name} saved.`); } catch (err) { W().toast(err.message); } show(); }
  } });
  document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
}

function uploadsPanel() {
  return W().h("div", { class: "files-uploads", "aria-live": "polite" });
}

function renderUploads() {
  const { h, icon } = W();
  const box = document.querySelector(".files-uploads");
  if (!box) return;
  box.replaceChildren(...FS.uploads.map((u) => h("div", { class: `files-upload ${u.state}` },
    icon(u.state === "done" ? "check" : u.state === "failed" ? "close" : "upload"), h("span", { class: "files-label" }, u.name),
    u.state === "failed" ? h("small", { class: "bad" }, u.error) : h("progress", { max: u.size || 1, value: u.sent }), h("small", { class: "muted" }, fmtSize(u.size)))));
}

function dropTarget(el, parentId) {
  let depth = 0;
  el.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); depth++; el.classList.add("dropping"); } });
  el.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  el.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.classList.remove("dropping"); } });
  el.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; el.classList.remove("dropping");
    if (e.dataTransfer.files.length) uploadMany([...e.dataTransfer.files], parentId);
  });
}

// ------------------------------------------------------------------------------------------------ preview

function preview(it, url = `api.php?a=files/download&id=${it.id}&inline=1`, blobDownload = null) {
  const { h, icon } = W();
  const m = it.mime || "";
  const view = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m) ? h("img", { src: url, alt: it.name })
    : m === "application/pdf" || m.startsWith("text/") ? h("iframe", { src: url, title: it.name })
      : /^video\//.test(m) ? h("video", { src: url, controls: true, preload: "metadata" })
        : /^audio\//.test(m) ? h("audio", { src: url, controls: true, preload: "metadata" })
          : h("div", { class: "files-noprev" }, icon("file"), h("p", {}, "There's no preview for this kind of file."));
  const close = () => { overlay.remove(); if (url.startsWith("blob:")) URL.revokeObjectURL(url); };
  const overlay = h("div", { class: "overlay center files-preview", onclick: (e) => { if (e.target === overlay) close(); }, onkeydown: (e) => { if (e.key === "Escape") close(); } },
    h("div", { class: "files-preview-box" },
      h("div", { class: "files-preview-head" }, h("strong", { class: "files-label" }, it.name), h("span", { class: "muted small" }, fmtSize(it.size)), h("span", { class: "grow" }),
        h("button", { class: "btn btn-sm", onclick: () => (blobDownload ? blobDownload() : download(it)) }, icon("download"), "Download"),
        !blobDownload && h("button", { class: "btn btn-sm", onclick: () => { close(); shareDialog(it); } }, icon("people"), "Share"),
        h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
      h("div", { class: "files-preview-body" }, view)));
  document.body.append(overlay);
  overlay.querySelector(".icon-btn").focus();
}

// ------------------------------------------------------------------------------------------------ sharing

async function shareDialog(it) {
  const { h, api, toast } = W();
  await dialog(`Share “${it.name}”`, async (body) => {
    const [shares, who] = await Promise.all([api("files/shares", { query: { id: it.id } }), api("files/share-candidates")]);
    const canEdit = it.role === "owner" || it.role === "editor";
    const rules = FS.data?.rules || {};
    const draw = (s) => {
      const people = h("section", {}, h("h3", {}, "People and teams"),
        s.people.length ? h("ul", { class: "files-shares" }, s.people.map((p) => h("li", {}, h("span", { class: "grow" }, p.label), h("span", { class: "pill quiet" }, p.role === "editor" ? "Can edit" : "Can view"),
          canEdit && h("button", { class: "btn btn-sm", onclick: async () => { await api("files/unshare", { method: "POST", body: { share_id: p.id } }); draw(await api("files/shares", { query: { id: it.id } })); } }, "Remove"))))
          : h("p", { class: "muted small" }, "Not shared with anyone here yet."));
      if (canEdit) {
        const target = h("select", {}, h("optgroup", { label: "People" }, who.users.filter((u) => u.id !== W().state.user.id).map((u) => h("option", { value: `u${u.id}` }, `${u.name} (${u.email})`))),
          h("optgroup", { label: "Everyone who reads a mailbox" }, who.mailboxes.map((m) => h("option", { value: `m${m.id}` }, m.address))));
        const role = h("select", {}, h("option", { value: "viewer" }, "Can view"), h("option", { value: "editor" }, "Can edit"));
        people.append(h("form", { class: "row files-share-add", onsubmit: async (e) => {
          e.preventDefault();
          const v = target.value;
          try { draw(await api("files/share", { method: "POST", body: { id: it.id, [v[0] === "u" ? "user_id" : "mailbox_id"]: Number(v.slice(1)), role: role.value } })); toast("Shared."); }
          catch (err) { toast(err.message); }
        } }, target, role, h("button", { class: "btn btn-primary" }, "Share")));
      }
      const links = h("section", {}, h("h3", {}, "Share links"));
      if (!rules.links) links.append(h("p", { class: "muted small" }, "Share links are turned off. An administrator can turn them on in Settings → Files."));
      else {
        links.append(...s.links.map((l) => h("div", { class: "files-link" },
          h("div", { class: "grow" }, h("div", {}, l.kind === "request" ? "File request" : "Anyone with the link can view and download",
            l.expired && h("span", { class: "pill bad" }, "used up or expired")),
          h("small", { class: "muted" }, [l.password && "password", l.expires_at && `until ${new Date(l.expires_at).toLocaleDateString()}`,
            l.max_downloads && `${l.downloads}/${l.max_downloads} downloads`].filter(Boolean).join(" · ") || "no password, no expiry")),
          h("button", { class: "btn btn-sm", onclick: async () => { await navigator.clipboard.writeText(l.url); toast("Link copied."); } }, "Copy"),
          canEdit && h("button", { class: "btn btn-sm", onclick: async () => { await api("files/links/revoke", { method: "POST", body: { id: l.id } }); draw(await api("files/shares", { query: { id: it.id } })); toast("Link turned off."); } }, "Turn off"))));
        if (canEdit) {
          const kind = h("select", { name: "kind" }, h("option", { value: "view" }, "View and download"), it.kind === "folder" && h("option", { value: "request" }, "File request (people send files in)"));
          const password = h("input", { type: "password", name: "password", placeholder: rules.links_password ? "Required" : "Optional", autocomplete: "new-password", minlength: 6 });
          const days = h("input", { type: "number", name: "days", min: 1, max: rules.links_max_days || 3650, placeholder: rules.links_max_days ? `Up to ${rules.links_max_days}` : "Never" });
          const limit = h("input", { type: "number", name: "limit", min: 1, placeholder: "No limit" });
          links.append(h("form", { class: "files-link-new", onsubmit: async (e) => {
            e.preventDefault();
            try {
              const l = await api("files/links", { method: "POST", body: { id: it.id, kind: kind.value, password: password.value || null, days: days.value ? Number(days.value) : null, max_downloads: limit.value ? Number(limit.value) : null } });
              await navigator.clipboard?.writeText(l.url).catch(() => {});
              toast("Link made and copied.");
              draw(await api("files/shares", { query: { id: it.id } }));
            } catch (err) { toast(err.message); }
          } }, h("div", { class: "row wrap" }, h("label", { class: "field" }, "Lets people", kind), h("label", { class: "field" }, "Password", password)),
          h("div", { class: "row wrap" }, h("label", { class: "field" }, "Expires after (days)", days), h("label", { class: "field" }, "Download limit", limit)),
          h("button", { class: "btn btn-primary" }, "Make a link")));
        }
      }
      body.replaceChildren(people, links);
    };
    draw(shares);
  }, { wide: true });
  show();
}

// ------------------------------------------------------------------------------------------------ move, versions, activity

/** Choose a folder (in the same tree: the user's own files, or the shared folder's). Resolves with its id (null = top level). */
function folderPicker(title, { startFolder = null, ownTop = true, exclude = null, vault = false } = {}) {
  const { h, icon, api } = W();
  return dialog(title, (body, done) => {
    let at = startFolder;
    const draw = async () => {
      const d = await api("files", { query: at ? { folder: at } : { view: vault ? "vault" : "mine" } });
      const folders = d.items.filter((i) => i.kind === "folder" && i.id !== exclude);
      body.replaceChildren(
        h("div", { class: "files-crumbs" }, ownTop && h("button", { type: "button", class: "linkish", onclick: () => { at = null; draw(); } }, vault ? "Vault" : "My files"),
          (d.folder?.path || []).map((p) => [" / ", h("button", { type: "button", class: "linkish", onclick: () => { at = p.id; draw(); } }, vault ? Vault.label(p.name) : p.name)])),
        h("ul", { class: "files-picker" }, folders.length ? folders.map((f) => h("li", {}, h("button", { type: "button", onclick: () => { at = f.id; draw(); } }, icon("folder"), vault ? Vault.label(f.name) : f.name)))
          : h("li", { class: "muted small" }, "No folders here.")),
        h("div", { class: "row end" }, h("button", { class: "btn btn-primary", disabled: !at && !ownTop, onclick: () => done({ id: at }) }, "Choose this folder")));
    };
    return draw();
  });
}

async function moveDialog(it) {
  const top = FS.data?.folder?.path?.[0]?.id ?? null;
  const own = it.owner_id === W().state.user.id;
  const picked = await folderPicker(`Move “${it.name}”`, { startFolder: own ? null : top, ownTop: own, exclude: it.id });
  if (picked) act("files/move", { id: it.id, to: picked.id }, "Moved.");
}

async function versionsDialog(it) {
  const { h, api, toast } = W();
  await dialog(`Versions of “${it.name}”`, async (body, done) => {
    const { versions } = await api("files/versions", { query: { id: it.id } });
    body.append(h("ul", { class: "files-versions" }, versions.map((v) => h("li", {},
      h("span", { class: "grow" }, new Date(v.at).toLocaleString(), h("small", { class: "muted" }, ` · ${fmtSize(v.size)}${v.by ? ` · ${v.by}` : ""}`)),
      v.current ? h("span", { class: "pill" }, "Current") : [
        h("a", { class: "btn btn-sm", href: `api.php?a=files/download&id=${it.id}&version=${v.id}` }, "Download"),
        (it.role === "owner" || it.role === "editor") && h("button", { class: "btn btn-sm", onclick: async () => { await api("files/versions/restore", { method: "POST", body: { id: it.id, version_id: v.id } }); toast("That version is the current one now."); done(); show(); } }, "Restore")]))));
  });
}

const ACTIONS = { upload: "uploaded it", version: "uploaded a new version", folder: "made it", rename: "renamed it", move: "moved it", trash: "put it in the bin", restore: "restored it",
  delete: "deleted it", share: "shared it", unshare: "stopped sharing it", link: "made a share link", link_off: "turned a share link off", link_download: "downloaded it with a link",
  zip: "downloaded it as a ZIP", version_restore: "restored an earlier version" };
async function activityDialog(it) {
  const { h, api } = W();
  await dialog(`Activity: “${it.name}”`, async (body) => {
    const { activity } = await api("files/activity", { query: { id: it.id } });
    body.append(activity.length ? h("ul", { class: "files-activity" }, activity.map((a) => h("li", {}, h("strong", {}, a.by || "Someone"), ` ${ACTIONS[a.action] || a.action}`,
      h("small", { class: "muted" }, ` · ${new Date(a.at).toLocaleString()}`)))) : h("p", { class: "muted" }, "Nothing yet."));
  });
}

// ------------------------------------------------------------------------------------------------ with email

/** An email attachment into Files: choose the folder. */
async function saveAttachment(a) {
  const picked = await folderPicker(`Save “${a.filename}” to Files`);
  if (!picked) return;
  try { await W().api("files/from-attachment", { method: "POST", body: { attachment_id: a.id, parent_id: picked.id } }); W().toast(`${a.filename} is in Files.`); }
  catch (err) { W().toast(err.message); }
}

const b64 = (buf) => { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Compose → Attach from Files: choose files; attach them, or (with share links on) send links instead. */
function pick({ title = "Choose files", links = false } = {}) {
  const { h, icon, api, toast } = W();
  return dialog(title, (body, done) => {
    let at = null;
    const chosen = new Map();
    const draw = async () => {
      const d = await api("files", { query: at ? { folder: at } : { view: "mine" } });
      const rules = d.rules;
      body.replaceChildren(
        h("div", { class: "files-crumbs" }, h("button", { type: "button", class: "linkish", onclick: () => { at = null; draw(); } }, "My files"),
          (d.folder?.path || []).map((p) => [" / ", h("button", { type: "button", class: "linkish", onclick: () => { at = p.id; draw(); } }, p.name)])),
        h("ul", { class: "files-picker" }, d.items.length ? d.items.map((i) => h("li", {}, i.kind === "folder"
          ? h("button", { type: "button", onclick: () => { at = i.id; draw(); } }, icon("folder"), i.name)
          : h("label", { class: "check" }, h("input", { type: "checkbox", checked: chosen.has(i.id), onchange: (e) => (e.target.checked ? chosen.set(i.id, i) : chosen.delete(i.id)) }),
            icon(kindIcon(i)), h("span", {}, i.name, h("small", { class: "muted" }, ` ${fmtSize(i.size)}`)))))
          : h("li", { class: "muted small" }, "Nothing here.")),
        h("div", { class: "row end" },
          links && rules.links && h("button", { class: "btn", onclick: async () => {
            if (!chosen.size) return toast("Choose a file first.");
            try {
              const out = [];
              for (const f of chosen.values()) out.push({ name: f.name, url: (await api("files/links", { method: "POST", body: { id: f.id, kind: "view" } })).url });
              done({ asLink: true, files: out });
            } catch (err) { toast(err.message); }
          } }, icon("link"), "Send links"),
          h("button", { class: "btn btn-primary", onclick: async () => {
            if (!chosen.size) return toast("Choose a file first.");
            const out = [];
            for (const f of chosen.values()) {
              const res = await fetch(`api.php?a=files/download&id=${f.id}`, { credentials: "same-origin" });
              if (!res.ok) { toast(`${f.name} couldn't be read.`); return; }
              out.push({ name: f.name, size: f.size, mime: f.mime, content: b64(await res.arrayBuffer()) });
            }
            done({ asLink: false, files: out });
          } }, icon("clip"), "Attach")));
    };
    return draw();
  }, { wide: true });
}

/** Compose: a file too big to attach. Upload it to Files and send a link instead? Only with share links on. */
async function offerLink(file) {
  const { api, toast } = W();
  let rules;
  try { rules = (await api("files", { query: { view: "recent" } })).rules; } catch { return null; }
  if (!rules.links) return null;
  if (!confirm(`“${file.name}” is too big to attach (${fmtSize(file.size)}). Upload it to Files and send a link instead?`)) return null;
  try {
    const f = await uploadOne(file, null);
    const l = await api("files/links", { method: "POST", body: { id: f.id, kind: "view" } });
    toast("Uploaded. The link is in your email.");
    return l;
  } catch (err) { toast(err.message); return null; }
}

/** Shared to the installed app from another app (Share → the webmail): those files, uploaded to My files. */
async function takeShared() {
  if (!("caches" in window)) return;
  const cache = await caches.open("wm-share-target");
  const keys = await cache.keys();
  if (!keys.length) return;
  W().openFiles({ view: "mine" });
  const files = [];
  for (const req of keys) {
    const res = await cache.match(req);
    const name = decodeURIComponent(new URL(req.url).searchParams.get("name") || "shared file");
    files.push(new File([await res.blob()], name, { type: res.headers.get("Content-Type") || "" }));
    await cache.delete(req);
  }
  await uploadMany(files, null);
  W().toast(`${files.length === 1 ? "The file is" : `${files.length} files are`} in My files.`);
}

// ------------------------------------------------------------------------------------------------ the private vault

/**
 * Encrypted here, in the browser, with a key the server never sees (WebCrypto, AES-256-GCM).
 * The vault key is random; it's wrapped with each way in: a passphrase (PBKDF2-SHA-256, 600,000 rounds), a passkey
 * (WebAuthn's PRF extension) and a recovery key, and only those wrapped copies go to the server.
 * A file: "WMV1", an 8-byte nonce prefix, its own key wrapped by the vault key, then 64 KB chunks each sealed with
 * AES-GCM (the nonce is the prefix and the chunk number; the chunk number and whether it's the last are in the
 * additional data, so chunks can't be moved or the file cut short). Names are sealed with the vault key too.
 */
const Vault = (() => {
  const CHUNK = 65536, TAG = 16, HEAD = 4 + 8 + 12 + 32 + TAG;
  const PBKDF2_ROUNDS = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  let key = null;          // the vault key (CryptoKey), only while open
  let raw = null;          // its bytes, only while open (to wrap with a new way in)
  let idle = null;
  const IDLE_MS = 15 * 60 * 1000;
  const b64u = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const aes = (bytes, usages = ["encrypt", "decrypt"]) => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
  const seal = async (k, data, aad) => { const iv = rand(12); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, k, data); return { iv, ct: new Uint8Array(ct) }; };
  const open = async (k, iv, ct, aad) => new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, k, ct));

  const touch = () => { clearTimeout(idle); idle = setTimeout(lock, IDLE_MS); };
  function lock() { key = null; raw = null; clearTimeout(idle); if (FS.view === "vault") show(); }

  // ---- ways in
  async function kekFromPassphrase(pass, salt, rounds = PBKDF2_ROUNDS) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: rounds, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function kekFromSecret(secret, info) {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const wrapWith = async (kek, extra) => { const { iv, ct } = await seal(kek, raw); return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct), ...extra }); };
  const unwrapWith = async (kek, w) => open(kek, unb64(w.iv), unb64(w.ct));

  /** A secret only this passkey can make (PRF), for the vault: the person confirms with Face ID, Touch ID, a PIN… */
  async function passkeySecret(credentialId, salt) {
    if (!window.PublicKeyCredential) throw new Error("This browser can't use passkeys.");
    const cred = await navigator.credentials.get({ publicKey: { challenge: rand(32), allowCredentials: [{ type: "public-key", id: unb64u(credentialId) }],
      userVerification: "required", timeout: 60000, extensions: { prf: { eval: { first: salt } } } } });
    const out = cred.getClientExtensionResults()?.prf?.results?.first;
    if (!out) throw new Error("This passkey can't open a vault (it doesn't support it). Use a passphrase instead, or another passkey.");
    return new Uint8Array(out);
  }

  /** The recovery key: 32 random bytes, written as 13 groups of 4 letters and digits (base32). */
  const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const toRecovery = (bytes) => { let bits = "", out = ""; for (const b of bytes) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return out.match(/.{1,4}/g).join("-"); };
  const fromRecovery = (text) => { const s = text.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1"); let bits = ""; for (const c of s) { const v = B32.indexOf(c); if (v < 0) throw new Error("That isn't a recovery key."); bits += v.toString(2).padStart(5, "0"); } const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2); return out; };

  async function makePassphrase(pass) { const salt = rand(16); return { method: "passphrase", wrapped: await wrapWith(await kekFromPassphrase(pass, salt), { kdf: "pbkdf2", rounds: PBKDF2_ROUNDS, salt: b64(salt) }) }; }
  async function makePasskey(credentialId, label) { const salt = rand(32); return { method: "passkey", credential_id: credentialId, label, wrapped: await wrapWith(await kekFromSecret(await passkeySecret(credentialId, salt), "wm-vault-passkey"), { kdf: "prf", salt: b64(salt) }) }; }
  async function makeRecovery() { const secret = rand(32); return { text: toRecovery(secret), method: { method: "recovery", wrapped: await wrapWith(await kekFromSecret(secret, "wm-vault-recovery"), { kdf: "hkdf" }) } }; }

  async function adopt(bytes) { raw = bytes; key = await aes(bytes); touch(); }

  // ---- names and files
  // URL-safe base64: names may not contain "/" (the server tidies names).
  async function sealName(name) { const { iv, ct } = await seal(key, enc.encode(name)); return "v1:" + b64u(new Uint8Array([...iv, ...ct])); }
  const names = new Map();
  async function openName(sealed) {
    if (names.has(sealed)) return names.get(sealed);
    try { const b = unb64u(sealed.slice(3)); const n = dec.decode(await open(key, b.slice(0, 12), b.slice(12))); names.set(sealed, n); return n; } catch { return "(can't be read)"; }
  }
  const label = (sealed) => names.get(sealed) || "…";
  const plainSize = (stored) => { const n = Math.max(0, stored - HEAD); const chunks = Math.max(1, Math.ceil(n / (CHUNK + TAG))); return Math.max(0, n - chunks * TAG); };
  const storedSize = (plain) => HEAD + plain + Math.max(1, Math.ceil(plain / CHUNK)) * TAG;
  const chunkAad = (i, last) => enc.encode(`wmv1|${i}|${last ? 1 : 0}`);
  const chunkIv = (prefix, i) => { const iv = new Uint8Array(12); iv.set(prefix); new DataView(iv.buffer).setUint32(8, i); return iv; };

  /** The file as encrypted pieces of $piece bytes, made as they're sent (a big file never sits in memory whole). */
  function encryptedPieces(file) {
    return async function* (piece) {
      const fileKey = rand(32), prefix = rand(8);
      const wrapped = await seal(key, fileKey);
      const fk = await aes(fileKey);
      let buf = new Uint8Array([...enc.encode("WMV1"), ...prefix, ...wrapped.iv, ...wrapped.ct]);
      const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
      for (let i = 0; i < chunks; i++) {
        const plain = new Uint8Array(await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(prefix, i), additionalData: chunkAad(i, i === chunks - 1) }, fk, plain));
        const next = new Uint8Array(buf.length + ct.length); next.set(buf); next.set(ct, buf.length); buf = next;
        while (buf.length >= piece) { yield new Blob([buf.slice(0, piece)]); buf = buf.slice(piece); }
      }
      if (buf.length) yield new Blob([buf]);
    };
  }

  async function decryptFile(bytes) {
    const b = new Uint8Array(bytes);
    if (dec.decode(b.slice(0, 4)) !== "WMV1") throw new Error("This isn't a vault file.");
    const prefix = b.slice(4, 12);
    const fk = await aes(await open(key, b.slice(12, 24), b.slice(24, HEAD)));
    const body = b.subarray(HEAD);
    const chunks = Math.max(1, Math.ceil(body.length / (CHUNK + TAG)));
    const parts = [];
    for (let i = 0; i < chunks; i++) {
      parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(prefix, i), additionalData: chunkAad(i, i === chunks - 1) }, fk, body.subarray(i * (CHUNK + TAG), (i + 1) * (CHUNK + TAG)))));
    }
    return new Blob(parts);
  }

  const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", mp4: "video/mp4", mp3: "audio/mpeg" };
  const mimeOf = (name) => MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

  // ---- the view
  async function show() {
    const { h, icon, api } = W();
    FS.view = "vault";
    let status;
    try { status = await api("vault"); } catch (err) { $pane.replaceChildren(h("div", { class: "placeholder" }, h("p", {}, err.message))); return; }
    const frame = (...content) => $pane.replaceChildren(h("div", { class: "files" }, sideNav(), h("div", { class: "files-main vault" }, ...content)));
    if (!window.crypto?.subtle) return frame(h("div", { class: "notice warn" }, "The vault needs a secure connection (https://) and a recent browser."));
    if (!status.set_up) return frame(...setupIntro(status));
    if (!key) return frame(...unlockForm(status));
    touch();
    const d = await api("files", { query: FS.folder ? { folder: FS.folder } : { view: "vault" } });
    for (const it of d.items) it.label = await openName(it.name);
    if (d.folder) for (const p of d.folder.path) await openName(p.name);
    d.items.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "folder" ? -1 : 1));
    const fileIn = h("input", { type: "file", multiple: true, hidden: true, onchange: async () => { await uploadFiles([...fileIn.files], d.folder?.id ?? null); fileIn.value = ""; } });
    const main = h("div", { class: "files-main vault" },
      h("div", { class: "files-head" },
        h("div", { class: "files-title" }, h("h2", {}, icon("lock"), " Private vault"),
          h("div", { class: "files-crumbs" }, h("button", { type: "button", class: "linkish", onclick: () => { FS.folder = null; Vault.show(); } }, "Vault"),
            (d.folder?.path || []).map((p) => [" / ", h("button", { type: "button", class: "linkish", onclick: () => { FS.folder = p.id; Vault.show(); } }, label(p.name))]))),
        h("div", { class: "files-actions" },
          d.allowed && h("button", { class: "btn", onclick: async () => { const n = await ask("New folder", "Name"); if (n) { await api("files/folder", { method: "POST", body: { parent_id: FS.folder, name: await sealName(n), vault: true } }); Vault.show(); } } }, icon("folder"), "New folder"),
          d.allowed && h("button", { class: "btn btn-primary", onclick: () => fileIn.click() }, icon("upload"), "Upload"), fileIn,
          h("button", { class: "btn", onclick: () => manage(status) }, icon("key"), "Vault settings"),
          h("button", { class: "btn", onclick: lock }, icon("lock"), "Lock"))),
      h("p", { class: "muted small files-hint" }, "Encrypted in this browser before it's uploaded: nobody else can open these files, not your administrator, not GhostParse. It locks after 15 minutes without use."),
      d.items.length ? h("div", { class: "files-list" }, d.items.map((it) => vaultRow(it))) : h("div", { class: "files-empty" }, icon("lock"), h("p", {}, "Nothing here yet.")),
      uploadsPanel());
    dropTargetVault(main, d.folder?.id ?? null);
    $pane.replaceChildren(h("div", { class: "files" }, sideNav(), main));
  }

  function vaultRow(it) {
    const { h, icon, popMenu } = W();
    const openIt = () => (it.kind === "folder" ? (FS.folder = it.id, Vault.show()) : openFile(it));
    const more = h("button", { type: "button", class: "icon-btn", "aria-label": `More for ${it.label}`, onclick: (e) => { e.stopPropagation(); popMenu(e.currentTarget, [
      it.kind === "file" && { label: "Open", icon: "eye", run: () => openFile(it) },
      it.kind === "file" && { label: "Download", icon: "download", run: () => openFile(it, true) },
      { label: "Rename", icon: "compose", run: async () => { const n = await ask("Rename", "Name", it.label); if (n) { await W().api("files/rename", { method: "POST", body: { id: it.id, name: await sealName(n) } }); Vault.show(); } } },
      { label: "Move to…", icon: "archive", run: async () => { const p = await folderPicker(`Move “${it.label}”`, { exclude: it.id, vault: true }); if (p) { await W().api("files/move", { method: "POST", body: { id: it.id, to: p.id } }); Vault.show(); } } },
      null, { label: "Delete for good", icon: "trash", class: "danger", run: async () => { if (confirm(`Delete “${it.label}” for good? Vault files don't go to the bin.`)) { await W().api("files/delete", { method: "POST", body: { id: it.id } }); Vault.show(); } } },
    ].filter((x) => x !== false)); } }, icon("more"));
    return h("div", { class: "files-row", tabindex: "0", onclick: openIt, onkeydown: (e) => { if (e.key === "Enter") openIt(); } },
      h("span", { class: "files-name" }, h("span", { class: `files-icon ${it.kind}` }, icon(it.kind === "folder" ? "folder" : "file")), h("span", { class: "files-label" }, it.label)),
      h("span", { class: "muted small" }, fmtWhen(it.updated_at)), h("span", { class: "muted small" }, it.kind === "file" ? fmtSize(plainSize(it.size)) : ""), more);
  }

  async function openFile(it, save = false) {
    touch();
    W().toast("Opening…");
    try {
      const res = await fetch(`api.php?a=files/download&id=${it.id}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "It couldn't be downloaded.");
      const blob = new Blob([await decryptFile(await res.arrayBuffer())], { type: mimeOf(it.label) });
      const url = URL.createObjectURL(blob);
      const saveIt = () => { const a = document.createElement("a"); a.href = url; a.download = it.label; document.body.append(a); a.click(); a.remove(); };
      if (save) { saveIt(); setTimeout(() => URL.revokeObjectURL(url), 60000); return; }
      preview({ name: it.label, size: blob.size, mime: blob.type }, url, saveIt);
    } catch (err) { W().toast(err.message === "The operation failed for an operation-specific reason" ? "This file failed its integrity check." : err.message); }
  }

  async function uploadFiles(files, parentId) {
    for (const f of files) {
      touch();
      try { await uploadOne(f, parentId, { vault: true, size: storedSize(f.size), pieces: encryptedPieces(f), name: await sealName(f.name) }); }
      catch (err) { W().toast(`${f.name}: ${err.message}`); }
    }
    setTimeout(() => { FS.uploads = FS.uploads.filter((u) => u.state === "sending"); renderUploads(); }, 4000);
    Vault.show();
  }

  function dropTargetVault(el, parentId) {
    el.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    el.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files], parentId); });
  }

  // ---- setting up, opening, managing
  function setupIntro(status) {
    const { h, icon } = W();
    return [h("div", { class: "vault-intro" }, h("span", { class: "vault-badge" }, icon("lock")), h("h2", {}, "Your private vault"),
      h("p", {}, "For your most private files. They're encrypted here, in your browser, before they're uploaded, with a key only you have: nobody else can open them, not your administrator, not GhostParse."),
      h("p", { class: "muted" }, "You'll open it with a passphrase or a passkey, and get a recovery key to keep safe. If you lose every way in, the files can't be recovered by anyone."),
      h("button", { class: "btn btn-primary", onclick: () => setupDialog(status) }, "Set up my vault"))];
  }

  async function setupDialog(status) {
    const { h, api, toast } = W();
    await dialog("Set up your vault", (body, done) => {
      const pass = h("input", { type: "password", minlength: 12, autocomplete: "new-password", placeholder: "At least 12 characters" });
      const pass2 = h("input", { type: "password", autocomplete: "new-password" });
      const pk = h("select", {}, h("option", { value: "" }, "No passkey"), status.passkeys.map((p) => h("option", { value: p.credential_id }, p.name || "Passkey")));
      body.append(h("form", { onsubmit: async (e) => {
        e.preventDefault();
        if (!pass.value && !pk.value) return toast("Choose a passphrase or a passkey.");
        if (pass.value && pass.value.length < 12) return toast("Use a passphrase of at least 12 characters.");
        if (pass.value !== pass2.value) return toast("The passphrases don't match.");
        try {
          await adopt(rand(32));
          const methods = [];
          if (pass.value) methods.push(await makePassphrase(pass.value));
          if (pk.value) methods.push(await makePasskey(pk.value, pk.selectedOptions[0].textContent));
          const rec = await makeRecovery();
          methods.push(rec.method);
          if (!(await showRecovery(rec.text))) { key = raw = null; return; }
          await api("vault/setup", { method: "POST", body: { methods } });
          toast("Your vault is ready.");
          done(true); Vault.show();
        } catch (err) { key = raw = null; toast(err.message); }
      } },
      h("label", { class: "field" }, "Passphrase", pass), h("label", { class: "field" }, "The passphrase again", pass2),
      status.passkeys.length ? h("label", { class: "field" }, "And/or open it with a passkey", pk, h("small", { class: "muted" }, "Face ID, Touch ID, Windows Hello or a security key: if your passkey supports it.")) : h("p", { class: "muted small" }, "Add a passkey under Sign-in & alerts to open your vault with one too."),
      h("div", { class: "row end" }, h("button", { class: "btn btn-primary" }, "Next"))));
    });
  }

  /** The recovery key, once: saved (copied or downloaded) before carrying on. */
  function showRecovery(text) {
    const { h, toast } = W();
    return dialog("Your recovery key", (body, done) => {
      const ok = h("input", { type: "checkbox" });
      body.append(h("p", {}, "If you forget your passphrase or lose your passkey, this is the only way into your vault. Keep it somewhere safe, like a password manager. It won't be shown again."),
        h("code", { class: "secret vault-recovery" }, text),
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async () => { await navigator.clipboard.writeText(text); toast("Copied."); } }, "Copy"),
          h("button", { class: "btn", type: "button", onclick: () => { const a = h("a", { href: URL.createObjectURL(new Blob([`Vault recovery key\n\n${text}\n`], { type: "text/plain" })), download: "vault-recovery-key.txt" }); document.body.append(a); a.click(); a.remove(); } }, "Download")),
        h("label", { class: "check" }, ok, h("span", {}, "I've saved my recovery key")),
        h("div", { class: "row end" }, h("button", { class: "btn btn-primary", onclick: () => (ok.checked ? done(true) : toast("Save it first, then tick the box.")) }, "Done")));
    });
  }

  function unlockForm(status) {
    const { h, icon, api, toast } = W();
    const pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "Passphrase" });
    const tryKeys = async (fn) => {
      try {
        const { keys } = await api("vault/keys");
        for (const k of keys) { const bytes = await fn(k).catch(() => null); if (bytes) { await adopt(bytes); Vault.show(); return; } }
        toast("That didn't open the vault.");
      } catch (err) { toast(err.message); }
    };
    const passkeys = status.methods.filter((m) => m.method === "passkey");
    return [h("div", { class: "vault-intro" }, h("span", { class: "vault-badge" }, icon("lock")), h("h2", {}, "Your vault is locked"),
      ...passkeys.map((m) => h("button", { class: "btn btn-primary", onclick: () => tryKeys(async (k) => { if (k.method !== "passkey" || k.credential_id !== m.credential_id) return null; const w = JSON.parse(k.wrapped); return unwrapWith(await kekFromSecret(await passkeySecret(k.credential_id, unb64(w.salt)), "wm-vault-passkey"), w); }) },
        icon("key"), `Open with ${m.label || "passkey"}`)),
      status.methods.some((m) => m.method === "passphrase") && h("form", { class: "row vault-pass", onsubmit: (e) => { e.preventDefault(); const p = pass.value; pass.value = ""; tryKeys(async (k) => { if (k.method !== "passphrase") return null; const w = JSON.parse(k.wrapped); return unwrapWith(await kekFromPassphrase(p, unb64(w.salt), w.rounds), w); }); } },
        pass, h("button", { class: "btn" + (passkeys.length ? "" : " btn-primary") }, "Open")),
      h("button", { class: "linkish", onclick: async () => {
        const text = await ask("Use your recovery key", "Recovery key");
        if (text) tryKeys(async (k) => { if (k.method !== "recovery") return null; return unwrapWith(await kekFromSecret(fromRecovery(text), "wm-vault-recovery"), JSON.parse(k.wrapped)); });
      } }, "Use my recovery key"),
      h("button", { class: "linkish danger", onclick: () => resetVault() }, "I can't get in: start again"))];
  }

  async function manage(status) {
    const { h, api, toast } = W();
    touch();
    await dialog("Vault settings", (body, done) => {
      const names = { passphrase: "Passphrase", passkey: "Passkey", recovery: "Recovery key" };
      const pk = h("select", {}, status.passkeys.filter((p) => !status.methods.some((m) => m.credential_id === p.credential_id)).map((p) => h("option", { value: p.credential_id }, p.name || "Passkey")));
      const refresh = async (s) => { done(); await manage(s); };
      body.append(h("h3", {}, "Ways in"), h("ul", { class: "files-shares" }, status.methods.map((m) => h("li", {}, h("span", { class: "grow" }, names[m.method], m.label ? h("small", { class: "muted" }, ` · ${m.label}`) : null),
        m.method !== "recovery" && h("button", { class: "btn btn-sm", onclick: async () => { try { await refresh(await api("vault/remove", { method: "POST", body: { id: m.id } })); } catch (err) { toast(err.message); } } }, "Remove")))),
      h("div", { class: "row wrap" },
        h("button", { class: "btn", onclick: async () => { const p = await ask("New passphrase", "Passphrase (12+ characters)"); if (!p) return; if (p.length < 12) return toast("At least 12 characters."); await refresh(await api("vault/add", { method: "POST", body: { method: await makePassphrase(p) } })); toast("Passphrase changed."); } }, "Set a new passphrase"),
        pk.options.length ? [pk, h("button", { class: "btn", onclick: async () => { try { await refresh(await api("vault/add", { method: "POST", body: { method: await makePasskey(pk.value, pk.selectedOptions[0].textContent) } })); toast("Passkey added."); } catch (err) { toast(err.message); } } }, "Add passkey")] : null,
        h("button", { class: "btn", onclick: async () => { const rec = await makeRecovery(); if (await showRecovery(rec.text)) { await refresh(await api("vault/add", { method: "POST", body: { method: rec.method } })); toast("New recovery key saved. The old one no longer works."); } } }, "New recovery key")),
      h("h3", {}, "Start again"), h("p", { class: "muted small" }, "Deletes the vault and everything in it."), h("button", { class: "btn danger", onclick: () => { done(); resetVault(); } }, "Delete my vault"));
    });
  }

  async function resetVault() {
    const { api, toast, confirmPw, formFor } = W();
    await dialog("Delete your vault", (body, done) => {
      body.append(W().h("p", {}, "Everything in your vault is deleted for good, and you can set up a new one. This can't be undone."),
        formFor([confirmPw()], "Delete my vault", async (v) => { await api("vault/reset", { method: "POST", body: v }); key = raw = null; toast("Your vault is deleted."); done(true); Vault.show(); }));
    });
  }

  return { show, label, lock };
})();

window.FilesUI = { show, saveAttachment, pick, offerLink, takeShared, vault: Vault, share: shareDialog, versions: versionsDialog, openEditor, loadOffice };
if (location.hash === "#files-shared") {
  history.replaceState(null, "", location.pathname);
  const wait = setInterval(() => { if (W()?.state?.user) { clearInterval(wait); takeShared().catch(() => {}); } }, 300);
  setTimeout(() => clearInterval(wait), 30000);
}
})();
