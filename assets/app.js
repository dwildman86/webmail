// Webmail: the interface. Plain JavaScript, no build step. It talks to api.php; message bodies are shown in a
// sandboxed frame (api.php?a=body), and nothing from an email is ever inserted as HTML here.
"use strict";

// ------------------------------------------------------------------------------------------------ helpers
const $app = document.getElementById("app");
const APP_NAME = $app.dataset.name || "Webmail";
let csrf = "";

/** h("div", { class: "x", onclick }, child, …): an element, with text children as text (never HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === "svg" || tag === "path" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "style") el.style.cssText = v; // through the style API: the page's CSP blocks style attributes
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string" && tag !== "svg" && tag !== "path") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  inbox: "M4 13h4l1.5 2.5h5L16 13h4M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.9z",
  sent: "M4 12l16-8-6 16-2.5-6.5z M11.5 13.5L20 4",
  drafts: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  archive: "M3 5h18v4H3z M5 9v10h14V9 M10 13h4",
  spam: "M12 3l9 16H3z M12 10v4 M12 17h.01",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  compose: "M12 5v14 M5 12h14",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z M20 20l-4-4",
  reply: "M10 7L4 12l6 5 M4 12h10a6 6 0 0 1 6 6",
  replyAll: "M8 7L3 12l5 5 M13 7l-5 5 5 5 M8 12h7a6 6 0 0 1 6 6",
  forward: "M14 7l6 5-6 5 M20 12H10a6 6 0 0 0-6 6",
  back: "M15 5l-7 7 7 7",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  close: "M6 6l12 12 M18 6L6 18",
  clip: "M16 7l-7.5 7.5a2 2 0 0 0 3 3L19 10a4 4 0 0 0-6-6l-7.5 7.5a6 6 0 0 0 8.5 8.5L20 14",
  unread: "M3 7l9 6 9-6 M3 6h18v12H3z",
  refresh: "M4 12a8 8 0 0 1 14-5.3L20 9 M20 4v5h-5 M20 12a8 8 0 0 1-14 5.3L4 15 M4 20v-5h5",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M10 5h8 M6 19h8 M14 5l-4 14",
  underline: "M7 4v7a5 5 0 0 0 10 0V4 M5 20h14",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  quote: "M7 7h4v6H5V9a2 2 0 0 1 2-2z M7 13c0 2-1 3-2 4 M15 7h4v6h-6V9a2 2 0 0 1 2-2z M15 13c0 2-1 3-2 4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  logout: "M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
};
const icon = (name) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
  h("path", { d: ICONS[name] }));

async function api(action, { method = "GET", body, query } = {}) {
  const qs = new URLSearchParams({ a: action, ...(query || {}) });
  const res = await fetch(`api.php?${qs}`, {
    method, credentials: "same-origin",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !["session", "login", "passkey/login"].includes(action)) {
    showLogin();
    throw new Error(data.message || "Sign in again");
  }
  if (!res.ok) throw Object.assign(new Error(data.message || `Error ${res.status}`), { status: res.status, data });
  return data;
}

const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0d9488", "#16a34a", "#9333ea", "#0891b2"];
function avatar(person) {
  const label = (person?.name || person?.address || "?").trim();
  const initials = label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  let n = 0;
  for (const ch of person?.address || label) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return h("div", { class: "avatar", style: `background:${COLORS[n % COLORS.length]}` }, initials);
}
const who = (p) => (p ? p.name || p.address : "(unknown)");
const fmtAddr = (p) => (p ? (p.name ? `${p.name} <${p.address}>` : p.address) : "");
function shortDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
const longDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

let toastTimer;
function toast(text, action) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = h("div", { class: "toast", role: "status" }, text, action && h("button", { onclick: () => { el.remove(); action.run(); } }, action.label));
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 5000);
}

// ------------------------------------------------------------------------------------------------ state
const FOLDERS = [["inbox", "Inbox", "inbox"], ["starred", "Starred", "star"], ["sent", "Sent", "sent"], ["drafts", "Drafts", "drafts"],
  ["archive", "Archive", "archive"], ["spam", "Spam", "spam"], ["trash", "Trash", "trash"]];
const state = { user: null, mailboxes: [], mailbox: 0, folder: "inbox", query: "", page: 1, messages: [], hasMore: false, selected: null, appInfo: {} };

// ------------------------------------------------------------------------------------------------ sign in
function showLogin(message) {
  const error = h("div", { class: "error", role: "alert" }, message || "");
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username webauthn" });
  const password = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const submit = h("button", { class: "btn btn-primary" }, "Sign in");
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      const r = await api("login", { method: "POST", body: { email: email.value, password: password.value } });
      csrf = r.csrf;
      await start();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  } },
  h("label", { class: "field" }, "Email", email),
  h("label", { class: "field" }, "Password", password),
  h("div", { class: "auth-actions" }, submit, window.Passkeys?.loginButton?.(error)),
  error);
  $app.replaceChildren(h("main", { class: "auth-wrap" },
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), APP_NAME),
    h("section", { class: "card" }, h("h1", {}, "Sign in"), h("p", {}, "to read and send your email."), form)));
  email.focus();
}

async function start() {
  try {
    const s = await api("session");
    csrf = s.csrf;
    state.user = s.user;
    state.mailboxes = s.mailboxes;
    state.appInfo = s.app;
    renderShell();
    await loadList();
    window.Notifications?.afterSignIn?.(s);
  } catch (err) {
    if (err.status === 401) showLogin();
    else $app.replaceChildren(h("div", { class: "auth-wrap" }, h("div", { class: "notice bad" }, err.message)));
  }
}

// ------------------------------------------------------------------------------------------------ the shell
let $shell, $folders, $list, $reader, $listTitle, $search;
function renderShell() {
  $folders = h("ul", { class: "folders" });
  $list = h("div", { class: "messages", role: "list" });
  $reader = h("section", { class: "reader" }, placeholder());
  $listTitle = h("div", { class: "list-title" });
  $search = h("input", { type: "search", placeholder: "Search mail", "aria-label": "Search mail", value: state.query, onkeydown: (e) => {
    if (e.key === "Enter") { state.query = $search.value.trim(); state.page = 1; loadList(); }
    if (e.key === "Escape") { $search.value = ""; state.query = ""; loadList(); }
  } });
  const mailboxSelect = state.mailboxes.length > 1 && h("select", { class: "input mailbox-select", "aria-label": "Mailbox", onchange: (e) => { state.mailbox = Number(e.target.value); state.page = 1; renderFolders(); loadList(); } },
    h("option", { value: "0" }, "All mailboxes"), state.mailboxes.map((m) => h("option", { value: String(m.id), selected: m.id === state.mailbox }, m.address)));
  $shell = h("div", { class: "shell" },
    h("aside", { class: "side" },
      h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), APP_NAME),
      h("button", { class: "btn btn-primary compose-btn", onclick: () => compose() }, icon("compose"), "Compose"),
      mailboxSelect,
      h("nav", { "aria-label": "Folders" }, $folders),
      h("div", { class: "side-foot" }, avatar({ name: state.user.name, address: state.user.email }),
        h("div", { class: "who" }, h("div", {}, state.user.name || state.user.email), h("div", { class: "muted small" }, state.user.email)),
        h("button", { class: "icon-btn", title: "Settings", "aria-label": "Settings", onclick: () => openSettings() }, icon("settings")),
        h("button", { class: "icon-btn", title: "Sign out", "aria-label": "Sign out", onclick: signOut }, icon("logout")))),
    h("section", { class: "list-pane" },
      h("div", { class: "list-head" },
        h("button", { class: "icon-btn menu-btn", "aria-label": "Menu", onclick: () => $shell.classList.toggle("menu") }, icon("menu")),
        h("div", { class: "search" }, icon("search"), $search),
        h("button", { class: "icon-btn", title: "Refresh", "aria-label": "Refresh", onclick: () => refresh() }, icon("refresh"))),
      $listTitle, $list),
    $reader);
  $app.replaceChildren($shell);
  if (!state.mailboxes.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon("mail"), h("p", {}, "You don't have a mailbox yet."),
      state.user.role === "admin" ? h("button", { class: "btn", onclick: () => openSettings("admin-mailboxes") }, "Add a mailbox") : h("p", {}, "Ask your administrator to give you one.")));
  }
  renderFolders();
}

async function signOut() {
  // A shared computer shouldn't keep getting this person's notifications or keep their mail for offline reading.
  await window.Notifications?.disable?.().catch(() => {});
  await api("logout", { method: "POST" }).catch(() => {});
  navigator.serviceWorker?.controller?.postMessage("signed-out");
  $shell = null;
  showLogin();
}

function unreadFor(folder) {
  return state.mailboxes.filter((m) => !state.mailbox || m.id === state.mailbox).reduce((n, m) => n + (m.unread?.[folder] || 0), 0);
}

function renderFolders() {
  $folders.replaceChildren(...FOLDERS.map(([key, label, ic]) => {
    const n = key === "starred" ? 0 : unreadFor(key);
    return h("li", {}, h("a", { href: "#", class: state.folder === key && !state.query ? "on" : "", onclick: (e) => {
      e.preventDefault();
      state.folder = key; state.query = ""; state.page = 1; $search.value = "";
      $shell.classList.remove("menu", "reading");
      renderFolders(); loadList();
    } }, icon(ic), label, n > 0 && key !== "sent" && key !== "drafts" && key !== "trash" ? h("span", { class: "badge" }, n > 99 ? "99+" : String(n)) : null));
  }));
}

function placeholder() {
  return h("div", { class: "placeholder" }, h("div", {}, icon("mail"), h("p", {}, "Choose a message to read it.")));
}

// ------------------------------------------------------------------------------------------------ the list
async function loadList(append = false) {
  const folder = state.query ? "all" : state.folder === "starred" ? "all" : state.folder;
  const label = state.query ? `Results for “${state.query}”` : FOLDERS.find((f) => f[0] === state.folder)[1];
  $listTitle.replaceChildren(h("h2", {}, label));
  if (!append) $list.replaceChildren(h("div", { class: "empty" }, "Loading…"));
  try {
    const r = await api("messages", { query: { folder, mailbox: String(state.mailbox || ""), page: String(state.page), q: state.query, starred: state.folder === "starred" && !state.query ? "1" : "" } });
    state.messages = append ? state.messages.concat(r.messages) : r.messages;
    state.hasMore = r.has_more;
    renderList();
  } catch (err) {
    $list.replaceChildren(h("div", { class: "empty" }, err.message));
  }
}

function renderList() {
  if (!state.messages.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon(state.query ? "search" : "inbox"), h("p", {}, state.query ? "Nothing matches." : "Nothing here.")));
    return;
  }
  const rows = state.messages.map((m) => {
    const person = state.folder === "sent" || state.folder === "drafts" || m.folder === "sent" || m.folder === "drafts" ? (m.to[0] || m.from) : m.from;
    return h("div", { class: `msg${m.read ? "" : " unread"}${state.selected === m.id ? " on" : ""}`, role: "listitem", tabindex: "0", dataset: { id: String(m.id) },
      onclick: () => (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)),
      onkeydown: (e) => { if (e.key === "Enter") (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)); } },
    avatar(person),
    h("div", { class: "from" }, (m.folder === "sent" || m.folder === "drafts") ? `To: ${who(person)}` : who(person)),
    h("div", { class: "date" }, shortDate(m.date)),
    h("div", { class: "line" }, h("span", { class: "subject" }, m.subject || "(no subject)"), h("span", { class: "snippet" }, m.snippet ? `— ${m.snippet}` : ""),
      h("span", { class: "flags" }, m.has_attachments && icon("clip"), m.starred && h("span", { class: "star" }, icon("star")), m.auth === "fail" && h("span", { class: "pill bad", title: "Failed SPF, DKIM and DMARC: be careful" }, "unverified"))));
  });
  $list.replaceChildren(...rows, ...(state.hasMore ? [h("button", { class: "btn more", onclick: () => { state.page += 1; loadList(true); } }, "Load more")] : []));
}

async function refresh() {
  try {
    const s = await api("session");
    state.mailboxes = s.mailboxes;
    renderFolders();
  } catch { /* the list call reports problems */ }
  await loadList();
}

// ------------------------------------------------------------------------------------------------ reading
let current = null;
async function openMessage(id) {
  state.selected = id;
  renderList();
  $shell.classList.add("reading");
  $reader.replaceChildren(h("div", { class: "placeholder" }, "Loading…"));
  try {
    current = await api("message", { query: { id: String(id) } });
  } catch (err) {
    $reader.replaceChildren(h("div", { class: "placeholder" }, err.message));
    return;
  }
  const m = current.message;
  const listed = state.messages.find((x) => x.id === id);
  if (listed && !listed.read) { listed.read = true; renderList(); refreshCounts(); }
  const move = (folder, label) => async () => {
    await api("messages/update", { method: "POST", body: { ids: current.thread.filter((t) => t.folder === m.folder).map((t) => t.id), folder } });
    toast(label, { label: "Undo", run: async () => { await api("messages/update", { method: "POST", body: { ids: [m.id], folder: m.folder } }); refresh(); } });
    closeReader(); refresh();
  };
  const bar = h("div", { class: "reader-bar" },
    h("button", { class: "icon-btn back", "aria-label": "Back", onclick: closeReader }, icon("back")),
    m.folder !== "archive" && m.folder !== "sent" && h("button", { class: "icon-btn", title: "Archive (e)", "aria-label": "Archive", onclick: move("archive", "Archived") }, icon("archive")),
    m.folder !== "spam" && m.folder !== "sent" && h("button", { class: "icon-btn", title: "Spam", "aria-label": "Report spam", onclick: move("spam", "Moved to Spam") }, icon("spam")),
    m.folder === "spam" && h("button", { class: "btn btn-sm", onclick: move("inbox", "Moved to Inbox") }, "Not spam"),
    m.folder !== "trash" ? h("button", { class: "icon-btn", title: "Delete (#)", "aria-label": "Delete", onclick: move("trash", "Moved to Trash") }, icon("trash"))
      : h("button", { class: "btn btn-sm btn-danger", onclick: async () => { if (!confirm("Delete this message for good?")) return; await api("messages/delete", { method: "POST", body: { ids: [m.id] } }); closeReader(); refresh(); } }, "Delete for good"),
    m.folder === "trash" && h("button", { class: "btn btn-sm", onclick: move("inbox", "Moved to Inbox") }, "Restore"),
    h("button", { class: "icon-btn", title: "Mark unread", "aria-label": "Mark unread", onclick: async () => { await api("messages/update", { method: "POST", body: { ids: [m.id], read: false } }); closeReader(); refresh(); } }, icon("unread")),
    h("button", { class: `icon-btn${m.starred ? " on" : ""}`, title: "Star", "aria-label": "Star", onclick: async (e) => {
      m.starred = !m.starred;
      e.currentTarget.classList.toggle("on", m.starred);
      await api("messages/update", { method: "POST", body: { ids: [m.id], starred: m.starred } });
      if (listed) { listed.starred = m.starred; renderList(); }
    } }, icon("star")),
    h("span", { class: "spacer" }),
    h("button", { class: "icon-btn", title: "Reply (r)", "aria-label": "Reply", onclick: () => compose({ mode: "reply", of: last() }) }, icon("reply")),
    h("button", { class: "icon-btn", title: "Reply all", "aria-label": "Reply all", onclick: () => compose({ mode: "replyAll", of: last() }) }, icon("replyAll")),
    h("button", { class: "icon-btn", title: "Forward (f)", "aria-label": "Forward", onclick: () => compose({ mode: "forward", of: last() }) }, icon("forward")));
  const mails = current.thread.map((t, i) => mailCard(t, i === current.thread.length - 1 || t.id === m.id));
  $reader.replaceChildren(bar, h("div", { class: "reader-body" }, h("h1", {}, m.subject || "(no subject)"), mails,
    h("div", { class: "reply-row" },
      h("button", { class: "btn", onclick: () => compose({ mode: "reply", of: last() }) }, icon("reply"), "Reply"),
      h("button", { class: "btn", onclick: () => compose({ mode: "replyAll", of: last() }) }, icon("replyAll"), "Reply all"),
      h("button", { class: "btn", onclick: () => compose({ mode: "forward", of: last() }) }, icon("forward"), "Forward"))));
}
const last = () => [...current.thread].reverse().find((t) => t.folder !== "sent") || current.thread[current.thread.length - 1];

// Each message frame reports its height; only messages from our own frames (matched by window) are believed.
const frames = new Map();
window.addEventListener("message", (e) => {
  const id = e.data?.webmailFrame;
  const frame = frames.get(id);
  if (!frame || e.source !== frame.contentWindow || typeof e.data.height !== "number") return;
  frame.style.height = `${Math.min(Math.max(120, e.data.height), 20000)}px`;
});

function mailCard(t, open) {
  // allow-scripts lets only the frame's own height reporter run (api.php gives it a nonce); without allow-same-origin
  // the message can't reach this page.
  const frame = h("iframe", { title: `Message from ${who(t.from)}`, sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer", loading: "lazy" });
  frames.set(t.id, frame);
  const content = h("div", { class: "mail-content" });
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(t.html || "");
  const load = (images) => {
    frame.src = `api.php?a=body&id=${t.id}${images ? "&images=1" : ""}`;
  };
  const bar = hasRemote && h("div", { class: "images-bar" }, "Remote images are hidden, so the sender can't tell you've opened this.",
    h("button", { class: "btn btn-sm", onclick: (e) => { load(true); e.currentTarget.parentElement.remove(); } }, "Show images"));
  content.append(...[bar, frame, t.attachments.length > 0 && h("div", { class: "atts" }, t.attachments.map((a) =>
    a.url ? h("a", { class: "att", href: a.url, target: "_blank", rel: "noopener noreferrer" }, icon("clip"), h("span", {}, a.filename), h("small", { class: "muted" }, size(a.size)))
      : h("a", { class: "att", href: `api.php?a=attachment&id=${a.id}`, download: a.filename }, icon("clip"), h("span", {}, a.filename), h("small", { class: "muted" }, size(a.size)))))].filter(Boolean));
  const recipients = [...(t.to || []), ...(t.cc || [])].map(fmtAddr).join(", ");
  const card = h("article", { class: `mail${open ? "" : " collapsed"}` },
    h("div", { class: "mail-head", onclick: () => { card.classList.toggle("collapsed"); if (!frame.src) load(false); } },
      avatar(t.from),
      h("div", { class: "who" },
        h("div", {}, h("span", { class: "name" }, who(t.from)), " ", h("span", { class: "addr" }, t.from?.name ? `<${t.from.address}>` : ""),
          t.authentication?.verdict === "fail" && h("span", { class: "pill bad", title: "This email failed SPF, DKIM and DMARC: it may not be from who it says" }, icon("shield"), "unverified sender")),
        h("div", { class: "to" }, `To ${recipients}`),
        h("div", { class: "preview" }, (t.reply_text || t.text || "").slice(0, 160))),
      h("div", { class: "date", title: longDate(t.date) }, shortDate(t.date))),
    content);
  if (open) load(false);
  return card;
}

function closeReader() {
  state.selected = null;
  current = null;
  $shell.classList.remove("reading");
  $reader.replaceChildren(placeholder());
  renderList();
}

async function refreshCounts() {
  try { state.mailboxes = (await api("session")).mailboxes; renderFolders(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------------------------------------ compose
let contacts = null;
async function compose(opts = {}) {
  document.querySelector(".overlay.compose-overlay")?.remove();
  if (!state.mailboxes.length) { toast("You don't have a mailbox to send from."); return; }
  contacts ??= api("contacts").then((r) => r.contacts).catch(() => []);
  const of = opts.of;
  const draft = opts.draft;
  const mine = new Set(state.mailboxes.map((m) => m.address.toLowerCase()));
  let fromId = draft?.mailbox_id || of?.mailbox_id || state.mailbox || state.mailboxes[0].id;
  const replyTarget = of && (of.reply_to?.length ? of.reply_to : [of.from]).filter(Boolean);
  let to = [], cc = [], subject = "", quoted = null;
  if (of && opts.mode !== "forward") {
    to = of.folder === "sent" ? of.to.map((a) => a.address) : replyTarget.map((a) => a.address);
    if (opts.mode === "replyAll") cc = [...of.to, ...(of.cc || [])].map((a) => a.address).filter((a) => !mine.has(a.toLowerCase()) && !to.includes(a));
    subject = /^re:/i.test(of.subject || "") ? of.subject : `Re: ${of.subject || ""}`;
  } else if (of) {
    subject = /^fwd?:/i.test(of.subject || "") ? of.subject : `Fwd: ${of.subject || ""}`;
  }
  if (of) {
    const header = opts.mode === "forward"
      ? ["---------- Forwarded message ----------", `From: ${fmtAddr(of.from)}`, `Date: ${longDate(of.date)}`, `Subject: ${of.subject || ""}`, `To: ${of.to.map(fmtAddr).join(", ")}`]
      : [`On ${longDate(of.date)}, ${fmtAddr(of.from)} wrote:`];
    quoted = h("blockquote", {}, ...header.flatMap((l) => [l, h("br")]), h("br"), ...(of.text || "").split("\n").flatMap((l) => [l, h("br")]));
  }
  if (draft) { to = draft.to.map((a) => a.address); cc = (draft.cc || []).map((a) => a.address); subject = draft.subject || ""; }

  const fromSel = h("select", { "aria-label": "From", onchange: (e) => { fromId = Number(e.target.value); swapSignature(); } },
    state.mailboxes.map((m) => h("option", { value: String(m.id), selected: m.id === fromId }, m.display_name ? `${m.display_name} <${m.address}>` : m.address)));
  const toIn = h("input", { type: "text", value: to.join(", "), "aria-label": "To", autocomplete: "off" });
  const ccIn = h("input", { type: "text", value: cc.join(", "), "aria-label": "Cc", autocomplete: "off" });
  const bccIn = h("input", { type: "text", value: "", "aria-label": "Bcc", autocomplete: "off" });
  const ccRow = h("div", { class: "cf", hidden: !cc.length }, h("label", {}, "Cc"), ccIn);
  const bccRow = h("div", { class: "cf", hidden: true }, h("label", {}, "Bcc"), bccIn);
  const subjIn = h("input", { type: "text", value: subject, "aria-label": "Subject" });
  const editor = h("div", { class: "editor", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Message", "data-placeholder": "Write your message…" });
  const sig = h("div", { class: "signature" });
  const swapSignature = () => {
    const mb = state.mailboxes.find((m) => m.id === fromId);
    sig.replaceChildren(...(mb?.signature ? ["-- ", h("br"), ...mb.signature.split("\n").flatMap((l) => [l, h("br")])] : []));
  };
  if (draft) {
    const full = await api("message", { query: { id: String(draft.id), peek: "1" } }).catch(() => null);
    editor.append(...(full?.message.text || "").split("\n").flatMap((l) => [l, h("br")]));
  } else {
    editor.append(h("div", {}, h("br")));
    swapSignature();
    editor.append(sig);
    if (quoted) editor.append(h("br"), quoted);
  }
  const files = [];
  const attList = h("div", { class: "compose-atts" });
  const renderAtts = () => attList.replaceChildren(...files.map((f, i) => h("span", { class: "att" }, icon("clip"), h("span", {}, f.filename), h("small", { class: "muted" }, size(f.size)),
    h("button", { type: "button", "aria-label": `Remove ${f.filename}`, onclick: () => { files.splice(i, 1); renderAtts(); } }, "✕"))));
  const fileIn = h("input", { type: "file", multiple: true, hidden: true, onchange: async () => {
    for (const f of fileIn.files) {
      if (files.reduce((n, x) => n + x.size, 0) + f.size > 20 * 1024 * 1024) { toast("Attachments can add up to 20 MB."); break; }
      const content = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.readAsDataURL(f); });
      files.push({ filename: f.name, content_type: f.type || "application/octet-stream", size: f.size, content });
    }
    fileIn.value = "";
    renderAtts();
  } });
  const cmd = (name, value) => () => { editor.focus(); document.execCommand(name, false, value); };
  const status = h("span", { class: "muted small", role: "status" });
  let draftId = draft?.id || null;
  const payload = () => {
    const clone = editor.cloneNode(true);
    return { mailbox_id: fromId, to: toIn.value, cc: ccIn.value, bcc: bccIn.value, subject: subjIn.value, html: clone.innerHTML, text: editor.innerText,
      reply_to_id: of && opts.mode !== "forward" ? of.id : undefined, forward_of: of && opts.mode === "forward" ? of.id : undefined, attachments: files, draft_id: draftId || undefined };
  };
  const sendBtn = h("button", { class: "btn btn-primary", onclick: async () => {
    sendBtn.disabled = true;
    status.textContent = "Sending…";
    try {
      const r = await api("send", { method: "POST", body: payload() });
      overlay.remove();
      toast(r.suppressed?.length ? `Sent. Not sent to ${r.suppressed.join(", ")}: they bounced or complained before.` : "Sent.");
      refresh();
      if (current) openMessage(current.message.id);
    } catch (err) {
      status.textContent = "";
      toast(err.message);
      sendBtn.disabled = false;
    }
  } }, "Send");
  const saveDraft = async () => {
    try {
      const r = await api("draft", { method: "POST", body: payload() });
      draftId = r.id;
      status.textContent = `Draft saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch (err) { status.textContent = err.message; }
  };
  const overlay = h("div", { class: "overlay compose-overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h("div", { class: "compose", role: "dialog", "aria-label": "New message" },
      h("div", { class: "compose-head" }, opts.mode === "forward" ? "Forward" : of ? "Reply" : "New message", h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))),
      h("div", { class: "compose-fields" },
        h("div", { class: "cf" }, h("label", {}, "From"), fromSel),
        h("div", { class: "cf" }, h("label", {}, "To"), toIn,
          h("button", { type: "button", class: "toggle", onclick: () => { ccRow.hidden = false; ccIn.focus(); } }, "Cc"),
          h("button", { type: "button", class: "toggle", onclick: () => { bccRow.hidden = false; bccIn.focus(); } }, "Bcc")),
        ccRow, bccRow,
        h("div", { class: "cf" }, h("label", {}, "Subject"), subjIn)),
      h("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatting" },
        h("button", { class: "icon-btn", type: "button", title: "Bold", "aria-label": "Bold", onclick: cmd("bold") }, icon("bold")),
        h("button", { class: "icon-btn", type: "button", title: "Italic", "aria-label": "Italic", onclick: cmd("italic") }, icon("italic")),
        h("button", { class: "icon-btn", type: "button", title: "Underline", "aria-label": "Underline", onclick: cmd("underline") }, icon("underline")),
        h("button", { class: "icon-btn", type: "button", title: "List", "aria-label": "Bulleted list", onclick: cmd("insertUnorderedList") }, icon("list")),
        h("button", { class: "icon-btn", type: "button", title: "Quote", "aria-label": "Quote", onclick: cmd("formatBlock", "blockquote") }, icon("quote")),
        h("button", { class: "icon-btn", type: "button", title: "Link", "aria-label": "Link", onclick: () => { const u = prompt("Link address (https://…)"); if (u && /^https?:\/\//i.test(u)) cmd("createLink", u)(); } }, icon("link")),
        h("button", { class: "icon-btn", type: "button", title: "Attach files", "aria-label": "Attach files", onclick: () => fileIn.click() }, icon("clip")), fileIn),
      editor, attList,
      h("div", { class: "compose-foot" }, sendBtn, h("button", { class: "btn", onclick: saveDraft }, "Save draft"), status, h("span", { class: "spacer" }),
        draftId && h("button", { class: "icon-btn", title: "Discard draft", "aria-label": "Discard draft", onclick: async () => { await api("messages/delete", { method: "POST", body: { ids: [draftId] } }); overlay.remove(); refresh(); } }, icon("trash")))));
  document.body.append(overlay);
  suggest(toIn, contacts); suggest(ccIn, contacts); suggest(bccIn, contacts);
  (to.length ? editor : toIn).focus();
  if (to.length) { const r = document.createRange(); r.setStart(editor, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }
}

async function openDraft(m) {
  compose({ draft: m });
}

/** Address suggestions from the people you've written to. */
function suggest(input, contactsPromise) {
  let box = null, items = [], index = 0;
  const close = () => { box?.remove(); box = null; };
  const pick = (address) => {
    const parts = input.value.split(",");
    parts[parts.length - 1] = ` ${address}`;
    input.value = `${parts.join(",").trim()}, `;
    close();
    input.focus();
  };
  input.addEventListener("input", async () => {
    const term = input.value.split(",").pop().trim().toLowerCase();
    close();
    if (term.length < 2) return;
    items = (await contactsPromise).filter((c) => c.includes(term)).slice(0, 8);
    if (!items.length) return;
    index = 0;
    const r = input.getBoundingClientRect();
    box = h("div", { class: "suggest", style: `left:${r.left}px;top:${r.bottom + 2}px` }, items.map((c, i) => h("div", { class: i === 0 ? "on" : "", onmousedown: (e) => { e.preventDefault(); pick(c); } }, c)));
    document.body.append(box);
  });
  input.addEventListener("keydown", (e) => {
    if (!box) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      [...box.children].forEach((c, i) => c.classList.toggle("on", i === index));
    } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[index]); } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// ------------------------------------------------------------------------------------------------ settings
async function openSettings(tab = "account") {
  document.querySelector(".overlay.settings-overlay")?.remove();
  const body = h("div", { class: "tab-body" });
  const tabs = [["account", "Account"], ["mailboxes", "Mailboxes"], ["security", "Sign-in & alerts"],
    ...(state.user.role === "admin" ? [["admin-users", "Users"], ["admin-mailboxes", "Connect addresses"], ["admin-status", "Status"]] : [])];
  const nav = h("nav", { class: "tabs" });
  const show = async (key) => {
    nav.replaceChildren(...tabs.map(([k, label]) => h("button", { class: k === key ? "on" : "", onclick: () => show(k) }, label)));
    body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try { body.replaceChildren(await SETTINGS[key]()); } catch (err) { body.replaceChildren(h("div", { class: "notice bad" }, err.message)); }
  };
  const overlay = h("div", { class: "overlay center settings-overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h("div", { class: "dialog", role: "dialog", "aria-label": "Settings" },
      h("div", { class: "dialog-head" }, h("h2", {}, "Settings"), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => overlay.remove() }, icon("close"))),
      h("div", { class: "dialog-body" }, nav, body)));
  document.body.append(overlay);
  show(tab);
}

function formFor(fields, label, onSubmit) {
  const error = h("div", { class: "error", role: "alert" });
  const button = h("button", { class: "btn btn-primary" }, label);
  return h("form", { onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true; error.textContent = "";
    try { await onSubmit(Object.fromEntries(new FormData(e.target))); } catch (err) { error.textContent = err.message; }
    button.disabled = false;
  } }, fields, button, error);
}

const SETTINGS = {
  async account() {
    return h("div", {},
      h("section", {}, h("h3", {}, "You"), h("p", {}, state.user.name, " · ", h("span", { class: "muted" }, state.user.email), " · ", state.user.role === "admin" ? "Administrator" : "User")),
      h("section", {}, h("h3", {}, "Change your password"),
        formFor([h("label", { class: "field" }, "Current password", h("input", { type: "password", name: "current", required: true, autocomplete: "current-password" })),
          h("label", { class: "field" }, "New password (10+ characters)", h("input", { type: "password", name: "new", minlength: 10, required: true, autocomplete: "new-password" }))],
        "Change password", async (v) => { await api("password", { method: "POST", body: v }); toast("Password changed."); })));
  },
  async mailboxes() {
    if (!state.mailboxes.length) return h("p", { class: "muted" }, "You don't have a mailbox yet.");
    return h("div", {}, ...state.mailboxes.map((m) => h("section", {}, h("h3", {}, m.address),
      formFor([h("label", { class: "field" }, "Name people see", h("input", { name: "display_name", value: m.display_name, maxlength: 100 })),
        h("label", { class: "field" }, "Signature", h("textarea", { name: "signature", rows: 4, maxlength: 5000 }, m.signature))],
      "Save", async (v) => { await api("mailbox", { method: "POST", body: { id: m.id, ...v } }); Object.assign(m, v); toast("Saved."); }))));
  },
  async security() {
    return h("div", {}, window.Passkeys?.settings?.() || h("section", {}, h("h3", {}, "Passkeys"), h("p", { class: "muted" }, "Not available in this browser.")),
      window.Notifications?.settings?.() || null);
  },
  async "admin-users"() {
    const [{ users }, { mailboxes }] = await Promise.all([api("admin/users"), api("admin/mailboxes")]);
    const boxes = (selected) => h("div", {}, mailboxes.map((m) => h("label", { class: "check" }, h("input", { type: "checkbox", name: `mb_${m.id}`, checked: selected.includes(m.id) }), m.address)));
    const pickBoxes = (v) => mailboxes.filter((m) => v[`mb_${m.id}`] === "on").map((m) => m.id);
    const table = h("table", { class: "list" }, h("tr", {}, h("th", {}, "User"), h("th", {}, "Role"), h("th", {}, "Mailboxes"), h("th", {}, "")),
      users.map((u) => h("tr", {}, h("td", {}, u.name, h("div", { class: "muted small" }, u.email), u.disabled && h("span", { class: "pill bad" }, "disabled")),
        h("td", {}, u.role), h("td", {}, mailboxes.filter((m) => u.mailbox_ids.includes(m.id)).map((m) => m.address).join(", ") || h("span", { class: "muted" }, "none")),
        h("td", {}, h("button", { class: "btn btn-sm", onclick: () => editUser(u) }, "Edit")))));
    const editUser = (u) => {
      const dlg = h("section", {}, h("h3", {}, `Edit ${u.email}`),
        formFor([h("label", { class: "field" }, "Name", h("input", { name: "name", value: u.name })),
          h("label", { class: "field" }, "Role", h("select", { name: "role" }, h("option", { value: "user", selected: u.role === "user" }, "User"), h("option", { value: "admin", selected: u.role === "admin" }, "Administrator"))),
          h("label", { class: "field" }, "New password (leave empty to keep)", h("input", { type: "password", name: "password", minlength: 10, autocomplete: "new-password" })),
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "disabled", checked: u.disabled }), "Can't sign in (disabled)"),
          h("div", { class: "field" }, "Mailboxes", boxes(u.mailbox_ids))],
        "Save", async (v) => {
          await api("admin/users/update", { method: "POST", body: { id: u.id, name: v.name, role: v.role, password: v.password || undefined, disabled: v.disabled === "on", mailbox_ids: pickBoxes(v) } });
          toast("Saved."); openSettings("admin-users");
        }));
      body2.replaceChildren(dlg);
      dlg.scrollIntoView({ behavior: "smooth" });
    };
    const body2 = h("div");
    return h("div", {}, h("section", {}, h("h3", {}, "Users"), table, body2),
      h("section", {}, h("h3", {}, "Add a user"),
        formFor([h("div", { class: "row" }, h("label", { class: "field grow" }, "Name", h("input", { name: "name", required: true })),
          h("label", { class: "field grow" }, "Email to sign in with", h("input", { type: "email", name: "email", required: true }))),
          h("label", { class: "field" }, "Password (10+ characters)", h("input", { type: "password", name: "password", minlength: 10, required: true, autocomplete: "new-password" })),
          h("label", { class: "field" }, "Role", h("select", { name: "role" }, h("option", { value: "user" }, "User"), h("option", { value: "admin" }, "Administrator"))),
          h("div", { class: "field" }, "Mailboxes", boxes([]))],
        "Add user", async (v) => { await api("admin/users", { method: "POST", body: { ...v, mailbox_ids: pickBoxes(v) } }); toast("User added."); openSettings("admin-users"); })));
  },
  async "admin-mailboxes"() {
    const { addresses } = await api("admin/addresses");
    const rows = addresses.map((a) => h("tr", {}, h("td", {}, a.address, (!a.inbound_ready || !a.sending_ready) && h("div", { class: "muted small" }, [!a.inbound_ready && "not receiving yet", !a.sending_ready && "not verified for sending"].filter(Boolean).join(" · "))),
      h("td", {}, a.connected ? h("span", { class: "pill" }, "connected") : ""),
      h("td", {}, h("button", { class: "btn btn-sm", onclick: async (e) => {
        e.target.disabled = true;
        try { await api("admin/mailboxes", { method: "POST", body: { address: a.address } }); toast(`${a.address} delivers here now.`); await refreshCounts(); renderShell(); loadList(); openSettings("admin-mailboxes"); } catch (err) { toast(err.message); e.target.disabled = false; }
      } }, a.connected ? "Connect again" : "Connect"))));
    return h("div", {}, h("section", {}, h("h3", {}, "Your GhostParse addresses"),
      h("p", { class: "muted" }, "Connecting an address makes it a mailbox here: it can send and receive, and its webhook is pointed at this webmail. You get access to it; give other users access under Users."),
      addresses.length ? h("table", { class: "list" }, h("tr", {}, h("th", {}, "Address"), h("th", {}, ""), h("th", {}, "")), rows)
        : h("p", {}, "No addresses yet: add them in GhostParse under Domains.")));
  },
  async "admin-status"() {
    const s = await api("admin/status");
    return h("div", {}, h("section", {}, h("h3", {}, "GhostParse"),
      s.account && h("p", {}, "Connected to ", h("strong", {}, s.account.name), s.account.plan ? ` (${s.account.plan} plan)` : ""),
      s.problems.length ? h("div", { class: "notice warn" }, s.problems.map((p) => h("div", {}, p))) : h("div", { class: "notice ok" }, "Everything's working.")));
  },
};

// ------------------------------------------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  if (!$shell || e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay")) return;
  const idx = state.messages.findIndex((m) => m.id === state.selected);
  if (e.key === "c") { e.preventDefault(); compose(); }
  else if (e.key === "/") { e.preventDefault(); $search.focus(); }
  else if (e.key === "j" && state.messages[idx + 1]) openMessage(state.messages[idx + 1].id);
  else if (e.key === "k" && idx > 0) openMessage(state.messages[idx - 1].id);
  else if (current && e.key === "r") compose({ mode: "reply", of: last() });
  else if (current && e.key === "f") compose({ mode: "forward", of: last() });
  else if (current && e.key === "e") $reader.querySelector('[aria-label="Archive"]')?.click();
  else if (current && e.key === "#") $reader.querySelector('[aria-label="Delete"]')?.click();
  else if (e.key === "Escape" && current) closeReader();
});

// New mail: check every 30 seconds while the page is open and visible.
setInterval(() => { if ($shell && document.visibilityState === "visible" && !document.querySelector(".overlay")) refresh(); }, 30000);
document.addEventListener("visibilitychange", () => { if ($shell && document.visibilityState === "visible") refresh(); });

window.Webmail = { api, h, icon, toast, state, start, openMessage, refresh };
start();
