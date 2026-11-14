// The editor around documents, spreadsheets and text files: opens a file from Files, keeps it in step with everyone
// else editing it (about once a second), shows who's here, saves (one editor's browser does, for everyone), undo and
// redo, comments, downloads, and keeps unsent changes on this device if the connection drops.
// The editors themselves are in doc.js, sheet.js and text.js; they register in window.OfficeKinds.
"use strict";

(() => {
const W = () => window.Webmail;
const h = (...a) => W().h(...a);

// Icons the editors use, drawn like the webmail's own (24×24, stroked).
const PATHS = {
  undo: "M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3",
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M10 5h8 M6 19h8 M14 5l-4 14",
  underline: "M7 4v7a5 5 0 0 0 10 0V4 M5 20h14",
  strike: "M5 12h14 M16 6.5C15 5 13.6 4.5 12 4.5c-2.5 0-4 1.3-4 3 0 1.4.9 2.3 2.5 2.9 M8 17.5c1 1.5 2.4 2 4 2 2.6 0 4.2-1.3 4.2-3.2 0-.7-.2-1.3-.6-1.8",
  alignLeft: "M4 6h16 M4 10h10 M4 14h16 M4 18h10",
  alignCenter: "M4 6h16 M7 10h10 M4 14h16 M7 18h10",
  alignRight: "M4 6h16 M10 10h10 M4 14h16 M10 18h10",
  justify: "M4 6h16 M4 10h16 M4 14h16 M4 18h16",
  bullets: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
  numbers: "M10 6h10 M10 12h10 M10 18h10 M4 5l1.5-1v5 M3.5 15.5a1.5 1.5 0 1 1 2.5 1.2L3.5 19H6",
  indent: "M4 6h16 M11 10h9 M11 14h9 M4 18h16 M4 9.5l3 2.5-3 2.5",
  outdent: "M4 6h16 M11 10h9 M11 14h9 M4 18h16 M7 9.5L4 12l3 2.5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  image: "M4 5h16v14H4z M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18 M15 9.5h.01",
  table: "M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14",
  textColor: "M6 16L12 4l6 12 M8.2 12h7.6 M4 20h16",
  fill: "M5 13l7-7 6 6-7 7z M12 6L9.5 3.5 M19 15s2 2.3 2 3.5a2 2 0 0 1-4 0c0-1.2 2-3.5 2-3.5z",
  borders: "M4 4h16v16H4z M4 12h16 M12 4v16",
  merge: "M4 5h16v14H4z M9 12H4 M20 12h-5 M7 9.5L9.5 12 7 14.5 M17 9.5L14.5 12l2.5 2.5",
  wrap: "M4 6h16 M4 12h13a3 3 0 0 1 0 6h-4 M14.5 15.5L12 18l2.5 2.5 M4 18h5",
  sigma: "M18 5H6l6 7-6 7h12",
  sort: "M7 4v16 M4 17l3 3 3-3 M14 6h6 M14 12h4 M14 18h2",
  filter: "M4 5h16l-6 7.5V19l-4 1v-7.5z",
  comment: "M5 5h14v10H10l-4 4v-4H5z",
  print: "M7 9V4h10v5 M7 17H5V9h14v8h-2 M7 14h10v6H7z",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  freeze: "M4 4h16v16H4z M4 9h16 M9 4v16",
  heading: "M6 4v16 M18 4v16 M6 12h12",
  pagebreak: "M4 4v5h16V4 M4 20v-5h16v5 M4 12h2 M9 12h2 M13 12h2 M18 12h2",
  hr: "M4 12h16",
  preview: "M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  page: "M6 3h9l4 4v14H6z M14 3v5h5",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5L20 20",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  close: "M6 6l12 12 M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  download: "M12 4v11 M7.5 10.5L12 15l4.5-4.5 M5 19h14",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14.5c1.7.7 2.8 2.6 3 5.5",
  check: "M5 12.5l4.5 4.5L19 7",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  cloud: "M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z",
  cloudOff: "M3 3l18 18 M7 18a4.5 4.5 0 0 1-1.6-8.7 M10 6.3A6 6 0 0 1 18 9.5a4 4 0 0 1 2.3 7.2 M17 18H7",
  superscript: "M4 18l8-10 M4 8l8 10 M16 4.5a1.8 1.8 0 1 1 3 1.5L16 9h4",
  subscript: "M4 16l8-10 M4 6l8 10 M16 15.5a1.8 1.8 0 1 1 3 1.5L16 20h4",
  clear: "M6 18h6 M8 4h10 M13 4l-4 14 M15 13l5 5 M20 13l-5 5",
  insertRow: "M4 4h16v6H4z M4 14h16v6H4z M12 11v2",
  insertCol: "M4 4h6v16H4z M14 4h6v16h-6z M11 12h2",
  chart: "M4 20h16 M7 16v-4 M12 16V7 M17 16v-7",
  pivot: "M4 4h16v16H4z M4 9h16 M9 4v16 M13 13h4 M15 11l2 2-2 2",
  condFormat: "M4 4h16v16H4z M4 12h16 M12 4v16 M14.5 14.5h3v3h-3z",
  track: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4 M13 20h7",
  review: "M4 6h10 M4 10h10 M4 14h6 M14 17l2.5 2.5L21 15",
  footnote: "M4 6h12 M4 10h12 M4 14h7 M17 15h3v6 M16 21h5 M4 19h7",
};
const icon = (name) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
  h("path", { d: PATHS[name] || "" }));
/** A toolbar button. */
const tool = (name, label, onclick, extra = {}) => h("button", { type: "button", class: "ox-tool", title: label, "aria-label": label, onmousedown: (e) => e.preventDefault(), onclick, ...extra }, icon(name));
const initials = (name) => (name || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join("");
const rid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("").padEnd(16, "0").slice(0, 16); };
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: recovery is best effort */ } },
};
const jsonable = (op) => JSON.parse(JSON.stringify(op, (k, v) => (v instanceof Map ? [...v] : v)));

let current = null;

/** Opens $item (a Files item: id, name, role…). $opts.onClose runs when the editor closes. */
async function open(item, opts = {}) {
  if (current) await current.close();
  const ed = new Editor(item, opts);
  current = ed;
  try { await ed.start(); } catch (err) { ed.fail(err); }
  return ed;
}

class Editor {
  constructor(item, opts) {
    this.item = item;
    this.opts = opts;
    this.client = rid();
    this.undoStack = [];
    this.redoStack = [];
    this.presenceState = null;
    this.presenceDirty = false;
    this.others = [];
    this.timer = null;
    this.closed = false;
    this.saving = false;
    this.savedSeq = 0;
    this.failures = 0;
    this.lastLocal = 0;
    this.comments = [];
    this.build();
  }

  build() {
    this.$people = h("div", { class: "ox-people", "aria-label": "Also here" });
    this.$status = h("span", { class: "ox-status", role: "status", "aria-live": "polite" }, "Opening…");
    this.$undo = tool("undo", "Undo (Ctrl+Z)", () => this.undo(), { disabled: true });
    this.$redo = tool("redo", "Redo (Ctrl+Y)", () => this.redo(), { disabled: true });
    this.$commentsBtn = h("button", { type: "button", class: "ox-tool ox-comments-btn", title: "Comments", "aria-label": "Comments", onclick: () => this.toggleComments() }, icon("comment"), h("span", { class: "ox-badge", hidden: true }));
    this.$title = h("div", { class: "ox-title" }, h("strong", { class: "ox-name" }, this.item.name), this.$status);
    this.$tools = h("div", { class: "ox-toolbar", role: "toolbar", "aria-label": "Formatting" });
    this.$body = h("div", { class: "ox-body" });
    this.$side = h("aside", { class: "ox-side", hidden: true, "aria-label": "Comments" });
    this.$banner = h("div", { class: "ox-banner", hidden: true });
    this.root = h("div", { class: "ox", role: "dialog", "aria-label": this.item.name, onkeydown: (e) => this.keys(e) },
      h("header", { class: "ox-bar" },
        h("button", { type: "button", class: "ox-tool", title: "Close", "aria-label": "Close", onclick: () => this.close() }, icon("back")),
        h("span", { class: "ox-icon" }, icon("page")), this.$title, h("span", { class: "grow" }), this.$people,
        this.$undo, this.$redo, this.$commentsBtn,
        h("button", { type: "button", class: "ox-tool", title: "Download", "aria-label": "Download", onclick: (e) => this.downloadMenu(e.currentTarget) }, icon("download")),
        h("button", { type: "button", class: "ox-tool", title: "More", "aria-label": "More", onclick: (e) => this.moreMenu(e.currentTarget) }, icon("more"))),
      this.$tools, this.$banner, h("div", { class: "ox-main" }, this.$body, this.$side));
    document.body.append(this.root);
    document.body.classList.add("ox-open");
    this.onUnload = (e) => { if (this.session?.dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", this.onUnload);
    this.onVisible = () => { if (!document.hidden) this.schedule(50); };
    document.addEventListener("visibilitychange", this.onVisible);
    // Back online: send what was kept here now, not after the back-off from the failed tries.
    this.onOnline = () => { this.failures = 0; this.schedule(0); };
    window.addEventListener("online", this.onOnline);
  }

  async start() {
    const api = W().api;
    const o = await api("files/edit/open", { method: "POST", body: { id: this.item.id, client: this.client } });
    this.kindName = o.file.kind;
    this.kind = window.OfficeKinds?.[o.file.kind];
    if (!this.kind) throw new Error("This kind of file can't be edited here yet.");
    this.file = o.file;
    this.me = o.me;
    this.generation = o.generation;
    this.canEdit = o.can_edit;
    this.savedSeq = o.base_seq;
    this.isSaver = o.saver;
    this.root.querySelector(".ox-name").textContent = o.file.name;
    // The file as last saved…
    const res = await fetch(`api.php?a=files/download&id=${this.item.id}${o.version_id ? `&version=${o.version_id}` : ""}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("The file couldn't be loaded.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { state, unsupported } = await this.kind.load(bytes, o.file);
    this.unsupported = unsupported || [];
    // …plus everyone's changes since.
    const S = window.OfficeCollab.Session;
    this.session = new S(this.kind.model, state, { seq: o.base_seq, client: this.client });
    for (const c of o.context || []) this.session.log.push({ seq: c.seq, client: c.client, op: this.kind.model.revive ? this.kind.model.revive(c.op) : c.op });
    this.session.receive(o.ops);
    this.others = o.others;
    this.readOnly = !this.canEdit;
    if (this.canEdit && this.unsupported.length) this.readOnly = true; // until they choose (banner)
    this.recover();
    this.mount();
    this.drawPeople();
    this.banner();
    this.status();
    this.loadComments();
    this.schedule(this.session.queue.length ? 100 : 1000);
  }

  mount() {
    this.view?.destroy?.();
    this.$body.replaceChildren();
    this.$tools.replaceChildren();
    const ed = this;
    this.ctx = {
      get state() { return ed.session.view; },
      get readOnly() { return ed.readOnly; },
      get me() { return ed.me; },
      get others() { return ed.others; },
      file: this.file,
      toolbar: this.$tools,
      icon, tool, h,
      toast: (m) => W().toast(m),
      commit: (ops, o) => this.commit(ops, o),
      presence: (p) => { this.presenceState = p; this.presenceDirty = true; this.schedule(400); },
      comment: (anchor) => this.openComments(anchor),
      commentCount: (anchor) => this.comments.filter((c) => c.anchor === anchor && !c.resolved && !c.parent_id).length,
      commentAnchors: () => new Set(this.comments.filter((c) => !c.resolved && !c.parent_id).map((c) => c.anchor)),
      undo: () => this.undo(), redo: () => this.redo(),
    };
    this.view = this.kind.mount(this.$body, this.ctx);
    this.root.classList.toggle("ox-readonly", this.readOnly);
    setTimeout(() => this.view?.focus?.(), 50);
  }

  banner() {
    const b = this.$banner;
    b.replaceChildren();
    b.hidden = true;
    if (!this.canEdit) {
      b.hidden = false;
      b.append(h("span", {}, this.file.role === "viewer" ? "Shared with you to view. You'll see others' changes as they make them." : "Changing files needs an active plan. You can view and download it."));
      return;
    }
    if (this.unsupported.length && this.readOnly) {
      b.hidden = false;
      b.classList.add("warn");
      b.append(h("span", { class: "grow" }, `This file has things the editor can't keep yet: ${this.unsupported.join(", ")}. Editing it here would remove them.`),
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => this.editCopy() }, "Edit a copy"),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => { if (confirm(`Edit anyway? When it's saved, ${this.unsupported.join(", ")} will be gone (earlier versions stay in its history).`)) { this.readOnly = false; this.unsupported = []; this.banner(); this.mount(); } } }, "Edit anyway"));
    }
  }

  async editCopy() {
    try {
      const copy = await W().api("files/copy", { method: "POST", body: { id: this.item.id, to: null } });
      W().toast(`Made “${copy.name}” in My files.`);
      await this.close();
      const ed = await open({ ...copy, role: "owner" }, this.opts);
      ed.readOnly = false; ed.unsupported = []; ed.banner(); ed.mount();
    } catch (err) { W().toast(err.message); }
  }

  fail(err) {
    this.$body.replaceChildren(h("div", { class: "ox-fail" }, icon("page"), h("p", {}, err.message || "This file couldn't be opened."),
      h("button", { type: "button", class: "btn", onclick: () => this.close() }, "Close")));
    this.$status.textContent = "";
  }

  // ---------------------------------------------------------------------------------------------- changes

  /** Changes from the editor. $o.undo false: not undoable (e.g. changes made by undo itself). $o.group: typing in one place joins into one undo step. */
  commit(ops, o = {}) {
    if (this.readOnly || this.closed) return [];
    const list = (Array.isArray(ops) ? ops : [ops]).filter(Boolean);
    if (!list.length) return [];
    const m = this.kind.model;
    const inv = [];
    const results = [];
    for (const op of list) {
      if (o.undo !== false) { const x = m.inverse(this.session.view, op); if (x) inv.unshift(...(Array.isArray(x) ? x.slice().reverse() : [x])); }
      results.push(...this.session.local(op));
    }
    if (o.undo !== false && inv.length) {
      const top = this.undoStack[this.undoStack.length - 1];
      const now = Date.now();
      if (o.group && top && top.group === o.group && now - top.at < 1500) { top.ops = [...inv, ...top.ops]; top.at = now; }
      else this.undoStack.push({ ops: inv, mark: this.session.seq, group: o.group || null, at: now });
      if (this.undoStack.length > 200) this.undoStack.shift();
      if (!o.redoing) this.redoStack = [];
    }
    this.lastLocal = Date.now();
    this.saveRecovery();
    this.status();
    this.schedule(250);
    return results;
  }

  /** Undo's changes, worked out again past anything others changed since. */
  replay(entry) {
    const m = this.kind.model;
    const against = this.session.log.filter((l) => l.seq > entry.mark && l.client !== this.client).flatMap((l) => (Array.isArray(l.op) ? l.op : [l.op]));
    const out = [];
    for (const op of entry.ops) { const r = against.length ? m.rebase(op, against) : op; if (r) out.push(...(Array.isArray(r) ? r : [r])); }
    return out;
  }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    const ops = this.replay(e);
    const m = this.kind.model;
    const inv = [];
    for (const op of ops) { const x = m.inverse(this.session.view, op); if (x) inv.unshift(...(Array.isArray(x) ? x.slice().reverse() : [x])); this.session.local(op); }
    this.redoStack.push({ ops: inv, mark: this.session.seq });
    this.after(ops);
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    const ops = this.replay(e);
    const m = this.kind.model;
    const inv = [];
    for (const op of ops) { const x = m.inverse(this.session.view, op); if (x) inv.unshift(...(Array.isArray(x) ? x.slice().reverse() : [x])); this.session.local(op); }
    this.undoStack.push({ ops: inv, mark: this.session.seq, at: 0 });
    this.after(ops);
  }
  after(ops) {
    this.view.refresh({ local: true, ops });
    this.saveRecovery();
    this.status();
    this.schedule(250);
  }

  keys(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && !e.altKey && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); this.schedule(0); W().toast("Changes save on their own, as you go."); }
    else if (mod && e.key.toLowerCase() === "p" && this.view?.print) { e.preventDefault(); this.view.print(); }
    else if (e.key === "Escape" && !document.querySelector(".pop-menu, .overlay") && this.view?.escape?.() !== true) { /* editors use Escape themselves */ }
  }

  // ---------------------------------------------------------------------------------------------- sync

  /** Syncs in `ms`, unless one is already due sooner: steady typing must not keep pushing the next sync back. */
  schedule(ms) {
    if (this.closed) return;
    const due = Date.now() + ms;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = null; this.sync(); }, ms);
  }
  idleDelay() {
    if (document.hidden) return 8000;
    if (this.failures) return Math.min(30000, 2000 * 2 ** Math.min(this.failures, 4));
    return this.others.length ? 1000 : 3000;
  }

  async sync() {
    if (this.closed || this.syncing || !this.session) return;
    this.syncing = true;
    const batch = this.readOnly ? null : this.session.take();
    const presence = this.presenceDirty ? this.presenceState : null;
    this.presenceDirty = false;
    try {
      const r = await W().api("files/edit/sync", { method: "POST", body: {
        id: this.item.id, client: this.client, generation: this.generation, since: this.session.seq,
        ops: batch ? batch.map((b) => ({ seen: b.seen, op: jsonable(b.op) })) : [], presence } });
      this.failures = 0;
      if (r.reload) return this.reload(r.reason);
      const { changed } = this.session.receive(r.ops || []);
      if (r.ops?.length >= 2000) this.schedule(0);
      if (changed) { this.lastRemote = Date.now(); this.view.refresh({ remote: true }); }
      if (r.base_seq > this.savedSeq) this.savedSeq = r.base_seq;
      if (this.canEdit !== r.can_edit) { this.canEdit = r.can_edit; if (!r.can_edit) { this.readOnly = true; this.mount(); this.banner(); } }
      this.isSaver = r.saver;
      this.others = r.others || [];
      this.drawPeople();
      this.view.others?.(this.others);
      this.saveRecovery();
      this.maybeSave();
    } catch (err) {
      if (batch) this.session.failed();
      this.failures++;
      if (err.status === 403 && batch) { this.readOnly = true; this.mount(); this.banner(); }
      if (err.status === 404) { this.fail(new Error("This file was deleted, or it's no longer shared with you.")); this.closed = true; return; }
    } finally {
      this.syncing = false;
      this.status();
      if (!this.closed) this.schedule(this.session.queue.length && !this.failures ? 150 : this.idleDelay());
    }
  }

  /** The saving browser saves the server's copy of the file (everyone's changes, in order) a few seconds after the last change. */
  maybeSave(force = false) {
    if (!this.isSaver || this.saving || this.readOnly || !this.canEdit) return null;
    if (this.session.seq <= this.savedSeq) return null;
    const lastChange = Math.max(this.lastLocal, this.lastRemote || 0);
    if (!force && Date.now() - lastChange < 3000 && Date.now() - (this.lastSaveAt || 0) < 30000) return null;
    return this.save();
  }
  async save() {
    this.saving = true;
    this.status();
    const seq = this.session.seq;
    try {
      const blob = await this.kind.save(this.kind.model.clone(this.session.confirmed), this.file);
      await upload(blob, this.item.id, this.file.name, { seq, generation: this.generation });
      this.savedSeq = Math.max(this.savedSeq, seq);
      this.lastSaveAt = Date.now();
    } catch (err) {
      this.saveError = err.message;
      setTimeout(() => { this.saveError = null; }, 15000);
    } finally {
      this.saving = false;
      this.status();
    }
  }

  async reload(reason) {
    W().toast(reason || "This file changed. It's opening again.");
    const lost = this.session.dirty;
    store.set(this.recoveryKey(), null);
    if (lost) W().toast("A few seconds of your latest changes couldn't be kept: someone uploaded a new version over them.");
    this.closed = true;
    clearTimeout(this.timer);
    this.root.remove();
    current = null;
    document.body.classList.remove("ox-open");
    window.removeEventListener("beforeunload", this.onUnload);
    open(this.item, this.opts);
  }

  status() {
    const s = this.session;
    let text, cls = "";
    if (!s) return;
    if (this.readOnly) text = this.canEdit ? "View only" : "View only";
    else if (this.failures) { text = s.dirty ? "Offline: changes kept on this device" : "Offline"; cls = "bad"; }
    else if (this.saveError) { text = "Couldn't save: retrying"; cls = "bad"; }
    else if (s.dirty) text = "Saving…";
    else if (this.saving) text = "Saving…";
    else if (s.seq > this.savedSeq) text = "All changes saved";
    else text = "All changes saved";
    this.$status.textContent = text;
    this.$status.className = `ox-status ${cls}`;
    this.$undo.disabled = this.readOnly || !this.undoStack.length;
    this.$redo.disabled = this.readOnly || !this.redoStack.length;
  }

  drawPeople() {
    this.$people.replaceChildren(...this.others.slice(0, 6).map((p) => {
      const el = h("span", { class: "ox-avatar", title: `${p.name}${p.can_edit ? "" : " (viewing)"}` }, initials(p.name));
      el.style.background = p.color;
      return el;
    }), ...(this.others.length > 6 ? [h("span", { class: "ox-avatar more", title: this.others.slice(6).map((p) => p.name).join(", ") }, `+${this.others.length - 6}`)] : []));
  }

  // ---------------------------------------------------------------------------------------------- recovery

  recoveryKey() { return `office.pending.${W().state.user?.id || 0}.${this.item.id}`; }
  saveRecovery() {
    if (!this.session) return;
    const ops = [...this.session.inflight, ...this.session.queue];
    store.set(this.recoveryKey(), ops.length ? { generation: this.generation, at: Date.now(), ops: ops.map((p) => ({ seen: p.seen, op: jsonable(p.op) })) } : null);
  }
  /** Changes made here that never reached the server (the tab closed while offline): sent now, if the file's the same. */
  recover() {
    const saved = store.get(this.recoveryKey());
    if (!saved?.ops?.length || this.readOnly) return;
    if (saved.generation !== this.generation) { store.set(this.recoveryKey(), null); W().toast("Some changes made while offline couldn't be added: the file was replaced since."); return; }
    const m = this.kind.model;
    for (const p of saved.ops) {
      const op = m.revive ? m.revive(p.op) : p.op;
      const against = this.session.log.filter((l) => l.seq > p.seen).flatMap((l) => (Array.isArray(l.op) ? l.op : [l.op]));
      const r = against.length ? m.rebase(op, against) : op;
      if (r) this.session.local(r);
    }
    W().toast("Changes you made while offline have been added.");
  }

  // ---------------------------------------------------------------------------------------------- menus

  async downloadAs(fmt) {
    try {
      const blob = await fmt.make(this.kind.model.clone(this.session.view), this.file);
      const a = h("a", { href: URL.createObjectURL(blob), download: fmt.ext ? this.file.name.replace(/\.[^.]+$/, "") + "." + fmt.ext : this.file.name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (err) { W().toast(err.message); }
  }
  downloadMenu(anchor) {
    const items = (this.kind.formats || []).map((f) => ({ label: f.label, icon: "download", run: () => this.downloadAs(f) }));
    if (this.view?.print) items.push(null, { label: "Print or save as PDF", icon: "file", run: () => this.view.print() });
    W().popMenu(anchor, items);
  }
  moreMenu(anchor) {
    const items = [];
    if (this.view?.menu) items.push(...this.view.menu(), null);
    items.push({ label: "Share", icon: "people", run: () => window.FilesUI?.share?.(this.item) },
      { label: "Make a copy", icon: "file", run: () => this.editCopy() },
      { label: "Version history", icon: "history", run: () => window.FilesUI?.versions?.(this.item) });
    W().popMenu(anchor, items.filter((x, i, a) => !(x === null && (i === 0 || a[i - 1] === null))));
  }

  // ---------------------------------------------------------------------------------------------- comments

  async loadComments() {
    try {
      const r = await W().api("files/comments", { query: { id: this.item.id } });
      this.comments = r.comments || [];
      const open = this.comments.filter((c) => !c.resolved && !c.parent_id).length;
      const badge = this.$commentsBtn.querySelector(".ox-badge");
      badge.hidden = !open;
      badge.textContent = open;
      this.view?.commentsChanged?.();
      if (!this.$side.hidden) this.drawComments();
    } catch { /* comments are optional */ }
    clearTimeout(this.commentTimer);
    if (!this.closed) this.commentTimer = setTimeout(() => this.loadComments(), this.$side.hidden ? 30000 : 8000);
  }
  toggleComments() { if (this.$side.hidden) this.openComments(null); else { this.$side.hidden = true; this.root.classList.remove("ox-with-side"); } }
  openComments(anchor) {
    this.$side.hidden = false;
    this.root.classList.add("ox-with-side");
    this.newAnchor = anchor;
    this.drawComments();
    this.loadComments();
  }
  drawComments() {
    // Whatever's being typed in a comment box stays through a redraw.
    const drafts = new Map([...this.$side.querySelectorAll("textarea")].map((t) => [t.dataset.key, t.value]));
    const focused = document.activeElement?.closest?.(".ox-side") ? document.activeElement.dataset.key : null;
    const by = (c) => h("div", { class: "ox-c-head" }, h("strong", {}, c.by), h("span", { class: "muted small" }, new Date(c.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
    const send = async (body, anchor, parent) => {
      try { this.comments = (await W().api("files/comments", { method: "POST", body: { id: this.item.id, anchor: anchor || "", body, parent_id: parent } })).comments; this.newAnchor = null; this.$side.querySelector(`textarea[data-key="${parent ? `r${parent}` : "new"}"]`).value = ""; this.drawComments(); this.view?.commentsChanged?.(); this.loadComments(); }
      catch (err) { W().toast(err.message); }
    };
    const form = (anchor, parent, placeholder) => {
      const key = parent ? `r${parent}` : "new";
      const ta = h("textarea", { rows: 2, placeholder, "aria-label": placeholder, maxlength: 4000, dataset: { key } });
      if (drafts.get(key)) ta.value = drafts.get(key);
      if (focused === key) setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
      return h("form", { class: "ox-c-form", onsubmit: (e) => { e.preventDefault(); if (ta.value.trim()) send(ta.value.trim(), anchor, parent); } }, ta,
        h("div", { class: "row end" }, h("button", { class: "btn btn-sm btn-primary" }, parent ? "Reply" : "Comment")));
    };
    const roots = this.comments.filter((c) => !c.parent_id).sort((a, b) => (a.resolved - b.resolved) || b.id - a.id);
    const label = (anchor) => this.view?.anchorLabel?.(anchor) || "";
    const list = roots.map((c) => h("div", { class: `ox-c${c.resolved ? " resolved" : ""}`, onclick: (e) => { if (c.anchor && !e.target.closest("button, textarea, form")) this.view?.reveal?.(c.anchor); } },
      label(c.anchor) && h("div", { class: "ox-c-anchor" }, label(c.anchor)),
      by(c), h("p", {}, c.body),
      this.comments.filter((r) => r.parent_id === c.id).map((r) => h("div", { class: "ox-c-reply" }, by(r), h("p", {}, r.body),
        (r.user_id === this.me.user_id || this.file.role === "owner") && h("button", { type: "button", class: "linkish small", onclick: async () => { this.comments = (await W().api("files/comments/delete", { method: "POST", body: { comment_id: r.id } })).comments; this.drawComments(); } }, "Delete"))),
      h("div", { class: "row ox-c-actions" },
        h("button", { type: "button", class: "linkish small", onclick: async () => { this.comments = (await W().api("files/comments/resolve", { method: "POST", body: { comment_id: c.id, resolved: !c.resolved } })).comments; this.drawComments(); this.view?.commentsChanged?.(); } }, c.resolved ? "Reopen" : "Resolve"),
        (c.user_id === this.me.user_id || this.file.role === "owner") && h("button", { type: "button", class: "linkish small", onclick: async () => { if (!confirm("Delete this comment and its replies?")) return; this.comments = (await W().api("files/comments/delete", { method: "POST", body: { comment_id: c.id } })).comments; this.drawComments(); this.view?.commentsChanged?.(); } }, "Delete")),
      !c.resolved && form(c.anchor, c.id, "Reply")));
    this.$side.replaceChildren(
      h("div", { class: "ox-side-head" }, h("h2", {}, "Comments"), h("button", { type: "button", class: "ox-tool", "aria-label": "Close comments", onclick: () => this.toggleComments() }, icon("close"))),
      h("div", { class: "ox-c-new" }, this.newAnchor ? h("div", { class: "ox-c-anchor" }, label(this.newAnchor) || "On the selection") : h("p", { class: "muted small" }, "Select something first to comment on it, or comment on the whole file."),
        form(this.newAnchor, null, "Add a comment")),
      ...(roots.length ? list : [h("p", { class: "muted small pad" }, "No comments yet.")]));
    if (this.newAnchor && !focused) setTimeout(() => this.$side.querySelector(".ox-c-new textarea")?.focus(), 30);
  }

  // ---------------------------------------------------------------------------------------------- closing

  async close() {
    if (this.closed && !this.root.isConnected) return;
    // Last changes out, and saved if this browser is the one saving.
    if (!this.closed && this.session?.queue.length) { for (let i = 0; i < 3 && this.session.queue.length && !this.failures; i++) { await this.sync(); } }
    if (!this.closed && this.session && this.isSaver && this.session.seq > this.savedSeq) await this.save();
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.commentTimer);
    if (this.session && !this.failures) W().api("files/edit/leave", { method: "POST", body: { id: this.item.id, client: this.client } }).catch(() => {});
    if (this.session && !this.session.dirty) store.set(this.recoveryKey(), null);
    this.view?.destroy?.();
    this.root.remove();
    document.body.classList.remove("ox-open");
    window.removeEventListener("beforeunload", this.onUnload);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onOnline);
    if (current === this) current = null;
    this.opts.onClose?.();
  }
}

/** A new version of the file, in pieces, as the saving editor. */
async function upload(blob, nodeId, name, edit) {
  const api = W().api;
  const start = await api("files/upload/start", { method: "POST", body: { node_id: nodeId, name, size: blob.size, edit } });
  if (start.done) return start.file;
  let result = null;
  for (let offset = 0; offset < blob.size || (blob.size === 0 && offset === 0); offset += start.piece) {
    const res = await fetch(`api.php?a=files/upload/piece&u=${encodeURIComponent(start.upload)}&offset=${offset}`, {
      method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": W().csrf(), "Content-Type": "application/octet-stream" }, body: blob.slice(offset, offset + start.piece) });
    result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.message || "Saving didn't go through.");
    if (blob.size === 0) break;
  }
  return result?.file;
}

/** The editors' shared pop-up: a small panel under $anchor (colour pickers, sizes). Closes on a click outside. */
function popover(anchor, build) {
  document.querySelector(".ox-pop")?.remove();
  const pop = h("div", { class: "ox-pop", role: "dialog" });
  const close = () => { pop.remove(); document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", esc, true); };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus?.(); } };
  build(pop, close);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, ht = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  pop.style.top = `${r.bottom + ht + 8 > window.innerHeight ? Math.max(8, r.top - ht - 4) : r.bottom + 4}px`;
  setTimeout(() => { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", esc, true); });
  return close;
}
const SWATCHES = ["#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#ffffff", "#c00000", "#e06666", "#ff0000", "#f6b26b", "#ffc000", "#ffd966", "#ffff00",
  "#93c47d", "#00b050", "#38761d", "#76a5af", "#00b0f0", "#0070c0", "#1f4e79", "#6fa8dc", "#8e7cc3", "#7030a0", "#c27ba0", "#ead1dc", "#fce5cd", "#d9ead3"];
/** A colour picker: $pick(colour or null). */
function colorPicker(anchor, { none = "Automatic", pick }) {
  popover(anchor, (pop, close) => {
    pop.append(h("button", { type: "button", class: "ox-pop-none", onclick: () => { close(); pick(null); } }, none),
      h("div", { class: "ox-swatches" }, SWATCHES.map((c) => { const b = h("button", { type: "button", class: "ox-swatch", title: c, "aria-label": c, onclick: () => { close(); pick(c); } }); b.style.background = c; return b; })),
      h("label", { class: "ox-pop-custom" }, "Custom ", h("input", { type: "color", onchange: (e) => { close(); pick(e.target.value); } })));
  });
}
/** A <select> for the toolbar. */
function select(label, options, onchange, cls = "") {
  return h("select", { class: `ox-select ${cls}`, title: label, "aria-label": label, onchange: (e) => onchange(e.target.value) },
    options.map(([v, t]) => h("option", { value: v }, t)));
}
const FONTS = ["Calibri", "Arial", "Helvetica", "Georgia", "Times New Roman", "Cambria", "Garamond", "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Consolas", "Aptos"];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

/** Printing: $html in a hidden frame, with $css. Styles go in a stylesheet built through the CSSOM (the page's CSP). */
function printHtml(title, body, css) {
  const frame = h("iframe", { class: "ox-print-frame", title: "Print" });
  document.body.append(frame);
  const d = frame.contentDocument;
  d.title = title;
  const style = d.createElement("style");
  d.head.append(style);
  try { for (const rule of css.split(/\n(?=\S)/)) if (rule.trim()) style.sheet.insertRule(rule, style.sheet.cssRules.length); } catch { /* a rule the browser doesn't know */ }
  d.body.append(d.importNode(body, true));
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 1000); }, 200);
}

window.OfficeEditor = { open, upload, get current() { return current; } };
window.OfficeUI = { icon, tool, popover, colorPicker, select, FONTS, SIZES, initials, printHtml, store };
window.OfficeKinds = window.OfficeKinds || {};
})();
