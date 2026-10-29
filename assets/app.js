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
  contacts: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20a8 8 0 0 1 16 0",
  personAdd: "M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 20a8 8 0 0 1 13-6.2 M19 14v6 M16 17h6",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  upload: "M12 16V4 M7 9l5-5 5 5 M4 20h16",
  download: "M12 4v12 M7 11l5 5 5-5 M4 20h16",
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
function showLogin(message, { signedOut = false } = {}) {
  const error = h("div", { class: "error", role: "alert" }, message || "");
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username webauthn" });
  const password = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  // One blue button: the passkey's, on a device that has used one.
  const submit = h("button", { class: window.Passkeys?.usedHere?.() ? "btn" : "btn btn-primary" }, "Sign in");
  const form = h("form", { onsubmit: async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      const r = await api("login", { method: "POST", body: { email: email.value, password: password.value } });
      window.Passkeys?.pending?.abort(); // the passkey suggestion isn't needed now
      csrf = r.csrf;
      if (r.mfa) showSecondStep(r); else await start();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  } },
  h("label", { class: "field" }, "Email", email),
  h("label", { class: "field" }, "Password", password),
  // On a device that has signed in with a passkey, that comes first.
  h("div", { class: "auth-actions" }, ...(window.Passkeys?.usedHere?.() ? [window.Passkeys.loginButton(error), submit] : [submit, window.Passkeys?.loginButton?.(error)])),
  error);
  $app.replaceChildren(h("main", { class: "auth-wrap" },
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), APP_NAME),
    h("section", { class: "card" }, h("h1", {}, "Sign in"), h("p", {}, "to read and send your email."), form)));
  // In the installed app with a passkey used before, Face ID comes up by itself: no keyboard in the way.
  if (signedOut || !(window.Passkeys?.usedHere?.() && (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true))) email.focus();
  // Just signed out: don't bring Face ID straight back up (the button and the keyboard suggestion are still there).
  window.Passkeys?.offer?.({ prompt: !signedOut });
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
    runImports().catch(() => {}); // an import left running carries on
    // Back from signing in with Google or Microsoft to import email.
    const q = new URLSearchParams(location.search);
    if (q.has("mail_oauth") || q.has("mail_oauth_error")) {
      pendingImportOAuth = { handle: q.get("mail_oauth"), error: q.get("mail_oauth_error") };
      history.replaceState(null, "", location.pathname + location.hash);
      openSettings("import");
    }
    if (state.user.role === "admin") offerUpdate();
  } catch (err) {
    if (err.status === 401 && err.data?.mfa) { csrf = err.data.csrf || csrf; showSecondStep(err.data); }
    else if (err.status === 401) showLogin();
    else $app.replaceChildren(h("div", { class: "auth-wrap" }, h("div", { class: "notice bad" }, err.message)));
  }
}

// ------------------------------------------------------------------------------------------------ two-step verification
// Required for everyone: after the password, a code from an authenticator app (or a recovery code, or a passkey).
// Someone without one sets it up here before they can see any mail.
function authCard(title, intro, ...body) {
  $app.replaceChildren(h("main", { class: "auth-wrap" },
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), APP_NAME),
    h("section", { class: "card" }, h("h1", {}, title), h("p", {}, intro), ...body),
    h("button", { class: "linkish", onclick: signOut }, "Sign out")));
}

const codeInput = (extra = {}) => h("input", { name: "code", required: true, inputmode: "numeric", autocomplete: "one-time-code", maxlength: 12,
  spellcheck: false, autocapitalize: "off", class: "input code-input", placeholder: "123456", ...extra });

async function showSecondStep(data) {
  if (data.mfa === "enrol") return showEnrol();
  const error = h("div", { class: "error", role: "alert" });
  const code = codeInput();
  const submit = h("button", { class: "btn btn-primary" }, "Continue");
  const m = data.methods || {};
  authCard("Two-step verification", m.totp ? "Enter the 6-digit code from your authenticator app." : "Use your passkey to finish signing in.",
    h("form", { onsubmit: async (ev) => {
      ev.preventDefault();
      submit.disabled = true; error.textContent = "";
      try {
        const r = await api("mfa/verify", { method: "POST", body: { code: code.value } });
        csrf = r.csrf;
        await start();
      } catch (err) { error.textContent = err.message; submit.disabled = false; code.select(); }
    } },
    h("label", { class: "field" }, m.totp ? "Code" : "Recovery code", code),
    h("div", { class: "auth-actions" }, submit, m.passkeys > 0 ? window.Passkeys?.loginButton?.(error) : null),
    error),
    h("p", { class: "muted small" }, m.recovery_codes_left > 0
      ? "Lost your phone? Type one of your recovery codes in the box instead."
      : "Lost your phone? Ask your administrator to reset your two-step verification."));
  code.focus();
}

async function showEnrol() {
  const usePasskey = window.Passkeys?.available?.() && h("button", { type: "button", class: "btn", onclick: async () => {
    try {
      const r = await window.Passkeys.register(/iPhone|iPad|Mac/.test(navigator.userAgent) ? "Apple passkey" : "Passkey");
      csrf = r.csrf;
      showRecoveryCodes(r.recovery_codes, start);
    } catch (err) { toast(err.name === "NotAllowedError" ? "Cancelled." : err.message); }
  } }, icon("shield"), "Use a passkey instead");
  let setup;
  try { setup = await api("mfa/setup"); } catch (err) { if (err.status === 401) showLogin(err.message); else toast(err.message); return; }
  authCard("Set up two-step verification", "To keep your email safe, signing in needs a second step as well as your password.",
    totpSetupForm(setup, false, async (r) => { csrf = r.csrf; showRecoveryCodes(r.recovery_codes, start); }),
    usePasskey && h("div", { class: "or" }, h("span", {}, "or")), usePasskey || null);
}

/** Scan (or tap, on a phone), then prove it with a code. With needPassword, for changing it from Settings. */
function totpSetupForm(setup, needPassword, done) {
  const error = h("div", { class: "error", role: "alert" });
  const code = codeInput({ maxlength: 7 });
  const password = needPassword && h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const submit = h("button", { class: "btn btn-primary" }, "Turn on");
  const grouped = setup.secret.match(/.{1,4}/g).join(" ");
  return h("form", { class: "totp-setup", onsubmit: async (ev) => {
    ev.preventDefault();
    submit.disabled = true; error.textContent = "";
    try { done(await api("mfa/setup", { method: "POST", body: { code: code.value, ...(password ? { password: password.value } : {}) } })); }
    catch (err) { error.textContent = err.message; submit.disabled = false; }
  } },
  h("ol", { class: "totp-steps" },
    h("li", {}, "Install an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password."),
    h("li", {}, "Scan this code with it:",
      h("img", { class: "qr", src: setup.qr_code, width: 196, height: 196, alt: "QR code to add this webmail to your authenticator app" }),
      h("span", { class: "muted small" }, "On this phone? ", h("a", { href: setup.otpauth_uri }, "Open it in your authenticator app"), ". Or type this key: "),
      h("code", { class: "secret" }, grouped)),
    h("li", {}, "Enter the 6-digit code it shows:", code)),
  password && h("label", { class: "field" }, "Your password", password),
  h("div", { class: "auth-actions" }, submit), error);
}

/** Shown once: the codes that get someone in if they lose their phone. */
function showRecoveryCodes(codes, next) {
  if (!codes?.length) return next();
  const ok = h("button", { class: "btn btn-primary", disabled: true, onclick: () => next() }, "Continue");
  const text = `${APP_NAME} recovery codes\nEach works once, instead of a code from your authenticator app.\n\n${codes.join("\n")}\n`;
  authCard("Save your recovery codes", "If you lose your phone, each of these gets you in once. Keep them somewhere safe, such as a password manager. They won't be shown again.",
    recoveryCodesBox(codes, text),
    h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { ok.disabled = !e.target.checked; } }), "I've saved my recovery codes"),
    h("div", { class: "auth-actions" }, ok));
}

function recoveryCodesBox(codes, text) {
  const download = () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "recovery-codes.txt" });
    document.body.append(a); a.click(); a.remove();
  };
  return h("div", { class: "codes-box" },
    h("ul", { class: "codes" }, codes.map((c) => h("li", {}, h("code", {}, c)))),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn btn-sm", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Copy didn't work: select the codes instead."); } } }, "Copy"),
      h("button", { type: "button", class: "btn btn-sm", onclick: download }, "Download")));
}

// ------------------------------------------------------------------------------------------------ the shell
let $shell, $folders, $list, $reader, $listTitle, $search, $tabbar;
function renderShell() {
  $folders = h("ul", { class: "folders" });
  $list = h("div", { class: "messages", role: "list" });
  $reader = h("section", { class: "reader" }, placeholder());
  $listTitle = h("div", { class: "list-title" });
  $search = h("input", { type: "search", placeholder: "Search mail", "aria-label": "Search mail", value: state.query, oninput: () => {
    if (state.folder === "contacts") renderContacts();
  }, onkeydown: (e) => {
    if (state.folder === "contacts") { if (e.key === "Escape") { $search.value = ""; renderContacts(); } return; }
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
    $reader,
    // On a phone, tapping anywhere outside the open menu closes it.
    h("div", { class: "scrim", "aria-hidden": "true", onclick: () => $shell.classList.remove("menu") }),
    ($tabbar = h("nav", { class: "tabbar", "aria-label": "Quick links" })));
  renderTabbar();
  $app.replaceChildren($shell);
  if (!state.mailboxes.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon("mail"), h("p", {}, "You don't have a mailbox yet."),
      state.user.role === "admin" ? h("button", { class: "btn", onclick: () => openSettings("admin-mailboxes") }, "Add a mailbox") : h("p", {}, "Ask your administrator to give you one.")));
  }
  renderFolders();
}

async function signOut() {
  // A shared computer shouldn't keep getting this person's notifications or keep their mail for offline reading. The
  // installed app is the person's own phone or computer: notifications keep coming after signing out there.
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!installed) await window.Notifications?.disable?.().catch(() => {});
  await api("logout", { method: "POST" }).catch(() => {});
  navigator.serviceWorker?.controller?.postMessage("signed-out");
  $shell = null;
  showLogin("", { signedOut: true });
}

function unreadFor(folder) {
  return state.mailboxes.filter((m) => !state.mailbox || m.id === state.mailbox).reduce((n, m) => n + (m.unread?.[folder] || 0), 0);
}

function renderFolders() {
  renderTabbar();
  $search.placeholder = state.folder === "contacts" ? "Search contacts" : "Search mail";
  $search.setAttribute("aria-label", $search.placeholder);
  $folders.replaceChildren(...[...FOLDERS, ["contacts", "Contacts", "contacts"]].map(([key, label, ic]) => {
    const n = key === "starred" ? 0 : unreadFor(key);
    return h("li", { class: key === "contacts" ? "sep" : "" }, h("a", { href: "#", class: state.folder === key && !state.query ? "on" : "", onclick: (e) => {
      e.preventDefault();
      openFolder(key);
    } }, icon(ic), label, n > 0 && key !== "sent" && key !== "drafts" && key !== "trash" ? h("span", { class: "badge" }, n > 99 ? "99+" : String(n)) : null));
  }));
}

function openFolder(key) {
  state.folder = key; state.query = ""; state.page = 1; $search.value = "";
  $shell.classList.remove("menu", "reading");
  renderFolders(); loadList();
  $list.scrollTop = 0;
}

/**
 * Phones: quick buttons along the bottom of the screen, in reach of a thumb. Inbox, Sent, a raised Compose in the
 * middle, Contacts, and More for the rest (the side menu: every folder, mailboxes, settings).
 */
function renderTabbar() {
  if (!$tabbar) return;
  const unread = unreadFor("inbox");
  const tab = (key, label, ic, badge) => h("button", { type: "button", class: `tab${state.folder === key && !state.query ? " on" : ""}`,
    "aria-current": state.folder === key && !state.query ? "page" : null, onclick: () => {
      // Tapping the open folder again goes back to the top of it.
      if (state.folder === key && !state.query && !$shell.classList.contains("reading")) { $list.scrollTo({ top: 0, behavior: "smooth" }); return; }
      openFolder(key);
    } },
    h("span", { class: "tab-icon" }, icon(ic), badge ? h("span", { class: "tab-badge" }, badge > 99 ? "99+" : String(badge)) : null), h("span", { class: "tab-label" }, label));
  $tabbar.replaceChildren(
    tab("inbox", "Inbox", "inbox", unread),
    tab("sent", "Sent", "sent"),
    h("button", { type: "button", class: "tab tab-compose", "aria-label": "Compose", onclick: () => compose() }, h("span", { class: "tab-fab" }, icon("compose"))),
    tab("contacts", "Contacts", "contacts"),
    h("button", { type: "button", class: `tab${["inbox", "sent", "contacts"].includes(state.folder) || state.query ? "" : " on"}`, onclick: () => $shell.classList.add("menu") },
      h("span", { class: "tab-icon" }, icon("menu")), h("span", { class: "tab-label" }, "More")));
}

/** Administrators hear about a new webmail release once per session, with a way straight to updating it. */
async function offerUpdate() {
  try {
    if (sessionStorage.getItem("wm.update-offered")) return;
    const u = await api("admin/update");
    if (!u.available) return;
    sessionStorage.setItem("wm.update-offered", "1");
    toast(`Webmail ${u.latest} is available (you have ${u.current}).`, { label: "Update", run: () => openSettings("admin-status") });
  } catch { /* checking is a nicety: nothing to say if it fails */ }
}

/** Settings → Status: the installed version, the newest one, and the Update now button. */
async function updateSection() {
  const box = h("section", {}, h("h3", {}, "Webmail version"));
  const render = async (refresh) => {
    box.replaceChildren(h("h3", {}, "Webmail version"), h("p", { class: "muted" }, "Checking…"));
    let u;
    try { u = await api("admin/update", { query: refresh ? { refresh: "1" } : {} }); } catch (err) { box.append(h("div", { class: "notice bad" }, err.message)); return; }
    const again = h("button", { class: "btn btn-sm", type: "button", onclick: () => render(true) }, "Check again");
    const parts = [h("h3", {}, "Webmail version")];
    if (u.error) parts.push(h("div", { class: "notice warn" }, u.error));
    if (!u.available) {
      parts.push(h("div", { class: "notice ok" }, `You have the newest version, ${u.current}.`), h("div", { class: "row" }, again,
        u.checked_at ? h("span", { class: "muted small" }, `Checked ${new Date(u.checked_at * 1000).toLocaleString()}`) : null));
      box.replaceChildren(...parts);
      return;
    }
    parts.push(h("p", {}, "Version ", h("strong", {}, u.latest), " is available. You have ", u.current, "."));
    if (u.notes) parts.push(h("div", { class: "release-notes" }, h("div", { class: "muted small" }, "What's new"), h("pre", {}, u.notes)));
    if (!u.can_update) {
      parts.push(h("div", { class: "notice warn" }, ...u.blockers.map((b) => h("div", {}, b))),
        h("p", { class: "muted small" }, "To update by hand, download the new zip from GhostParse and upload its files over these ones, keeping config.php."), again);
      box.replaceChildren(...parts);
      return;
    }
    parts.push(h("p", { class: "muted small" }, "The new files are downloaded from GhostParse, checked, and copied over these ones. Your settings, mail and users stay as they are, and the old files are kept in storage/updates in case they're needed. It takes a few seconds."),
      formFor([h("label", { class: "field" }, "Your password, to confirm", h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" }))],
        `Update to ${u.latest}`, async (v) => {
          const r = await api("admin/update", { method: "POST", body: { password: v.password } });
          box.replaceChildren(h("h3", {}, "Webmail version"), h("div", { class: "notice ok" }, `Updated to ${r.version}. Reloading…`));
          setTimeout(() => location.reload(), 1500);
        }), again);
    box.replaceChildren(...parts);
  };
  await render(false);
  return box;
}

function placeholder() {
  return h("div", { class: "placeholder" }, h("div", {}, icon("mail"), h("p", {}, "Choose a message to read it.")));
}

// ------------------------------------------------------------------------------------------------ the list
async function loadList(append = false) {
  if (state.folder === "contacts") return loadContacts();
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
    return swipeable(m, h("div", { class: `msg${m.read ? "" : " unread"}${state.selected === m.id ? " on" : ""}`, role: "listitem", tabindex: "0", dataset: { id: String(m.id) },
      onclick: () => (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)),
      onkeydown: (e) => { if (e.key === "Enter") (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)); } },
    avatar(person),
    h("div", { class: "from" }, (m.folder === "sent" || m.folder === "drafts") ? `To: ${who(person)}` : who(person)),
    h("div", { class: "date" }, shortDate(m.date)),
    h("div", { class: "line" }, h("span", { class: "subject" }, m.subject || "(no subject)"), h("span", { class: "snippet" }, m.snippet ? `— ${m.snippet}` : ""),
      h("span", { class: "flags" }, m.has_attachments && icon("clip"), m.starred && h("span", { class: "star" }, icon("star")), m.auth === "fail" && h("span", { class: "pill bad", title: "Failed SPF, DKIM and DMARC: be careful" }, "unverified")))));
  });
  $list.replaceChildren(...rows, ...(state.hasMore ? [h("button", { class: "btn more", onclick: () => { state.page += 1; loadList(true); } }, "Load more")] : []));
}

// On touch screens, swipe an email right to delete it or left to archive it. Past the line it goes, with Undo; short of
// it, it springs back. Up and down still scroll the list (touch-action: pan-y), and a swipe never opens the email.
function swipeable(m, row) {
  const can = { trash: m.folder !== "trash" && m.folder !== "drafts", archive: m.folder === "inbox" || m.folder === "spam" };
  if (!can.trash && !can.archive) return row;
  const wrap = h("div", { class: "swipe" },
    h("div", { class: "swipe-bg", "aria-hidden": "true" },
      h("span", { class: "swipe-trash" }, icon("trash"), "Delete"), h("span", { class: "swipe-archive" }, "Archive", icon("archive"))),
    row);
  let start = null, dx = 0, swiped = false;
  const target = (d) => (d > 0 ? "trash" : "archive");
  const line = () => Math.min(120, row.offsetWidth * 0.35);
  const reset = () => {
    row.style.transition = "transform .2s ease-out";
    row.style.transform = "";
    wrap.classList.remove("swiping", "armed");
    start = null;
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false };
    dx = 0;
  });
  row.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    let d = e.clientX - start.x;
    if (!start.dragging) {
      // Only a mostly sideways move is a swipe; anything else is left to the browser.
      if (Math.abs(e.clientY - start.y) > 10 && Math.abs(e.clientY - start.y) > Math.abs(d)) { start = null; return; }
      if (Math.abs(d) < 12) return;
      start.dragging = true;
      row.setPointerCapture(e.pointerId);
      row.style.transition = "none";
      wrap.classList.add("swiping");
    }
    if (!can[target(d)]) d /= 5; // Can't go that way here: it barely moves.
    dx = d;
    row.style.transform = `translateX(${dx}px)`;
    wrap.dataset.side = target(dx);
    const armed = can[target(dx)] && Math.abs(dx) > line();
    if (armed !== wrap.classList.contains("armed")) {
      wrap.classList.toggle("armed", armed);
      if (armed) navigator.vibrate?.(8);
    }
  });
  row.addEventListener("pointerup", (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!start.dragging) { start = null; return; }
    swiped = true;
    setTimeout(() => { swiped = false; }, 400);
    const folder = target(dx);
    if (!can[folder] || Math.abs(dx) <= line()) { reset(); return; }
    start = null;
    row.style.transition = "transform .18s ease-in";
    row.style.transform = `translateX(${dx > 0 ? 100 : -100}%)`;
    setTimeout(() => {
      wrap.style.height = `${wrap.offsetHeight}px`;
      void wrap.offsetHeight; // starts the collapse from its full height
      wrap.classList.add("gone");
      wrap.style.height = "0";
    }, 180);
    swipeMove(m, folder);
  });
  row.addEventListener("pointercancel", () => { if (start?.dragging) reset(); start = null; });
  // The tap that ends a swipe isn't a click on the email.
  wrap.addEventListener("click", (e) => { if (swiped) { e.stopPropagation(); e.preventDefault(); } }, true);
  return wrap;
}

async function swipeMove(m, folder) {
  const from = m.folder;
  state.messages = state.messages.filter((x) => x.id !== m.id);
  if (state.selected === m.id) { state.selected = null; current = null; $shell.classList.remove("reading"); $reader.replaceChildren(placeholder()); }
  setTimeout(renderList, 400);
  try {
    await api("messages/update", { method: "POST", body: { ids: [m.id], folder } });
  } catch (err) {
    toast(err.message);
    refresh();
    return;
  }
  toast(folder === "trash" ? "Moved to Trash" : "Archived", { label: "Undo", run: async () => { await api("messages/update", { method: "POST", body: { ids: [m.id], folder: from } }); refresh(); } });
  refreshCounts();
}

async function refresh() {
  try {
    const s = await api("session");
    state.mailboxes = s.mailboxes;
    renderFolders();
  } catch { /* the list call reports problems */ }
  await loadList();
}

// ------------------------------------------------------------------------------------------------ contacts
// Two address books: "My contacts" (only you) and "Shared" (everyone; administrators change it).
const book = { tab: "personal", personal: [], shared: [], canEditShared: false, selected: null };

async function loadContacts() {
  try {
    const r = await api("book");
    Object.assign(book, { personal: r.personal, shared: r.shared, canEditShared: r.can_edit_shared });
  } catch (err) { $list.replaceChildren(h("div", { class: "empty" }, err.message)); return; }
  renderContacts();
}

const canEdit = (which) => which === "personal" || book.canEditShared;

function renderContacts() {
  const term = $search.value.trim().toLowerCase();
  const all = book[book.tab];
  const shown = term ? all.filter((c) => [c.name, c.email, c.company, c.phone].some((v) => v.toLowerCase().includes(term))) : all;
  const fileIn = h("input", { type: "file", accept: ".vcf,.csv,text/vcard,text/csv", hidden: true, onchange: async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      const r = await api("book/import", { method: "POST", body: { book: book.tab, filename: f.name, text: await f.text() } });
      toast(`Imported: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} without a valid address skipped` : ""}.`);
      contacts = null;
      loadContacts();
    } catch (err) { toast(err.message); }
  } });
  const tab = (key, label) => h("button", { class: book.tab === key ? "on" : "", role: "tab", "aria-selected": String(book.tab === key), onclick: () => { book.tab = key; book.selected = null; $reader.replaceChildren(placeholderFor("contacts")); renderContacts(); } },
    label, h("span", { class: "count" }, String(book[key].length)));
  $listTitle.replaceChildren(h("div", { class: "book-head" }, h("h2", {}, "Contacts"),
    h("div", { class: "book-tabs", role: "tablist" }, tab("personal", "My contacts"), tab("shared", "Shared")),
    h("div", { class: "book-actions" },
      canEdit(book.tab) && h("button", { class: "btn btn-sm btn-primary", onclick: () => editContact(null) }, icon("personAdd"), "New"),
      canEdit(book.tab) && h("button", { class: "btn btn-sm", title: "Import contacts from a .vcf or .csv file (Gmail, Outlook, iPhone…)", onclick: () => fileIn.click() }, icon("upload"), "Import"),
      all.length > 0 && h("a", { class: "btn btn-sm", href: `api.php?a=book/export&book=${book.tab}`, download: "", title: "Download as a .vcf file" }, icon("download"), "Export"),
      fileIn),
    book.tab === "shared" && !book.canEditShared && h("p", { class: "muted small book-note" }, "Everyone can see these. Only an administrator can change them.")));
  if (!shown.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon("contacts"), h("p", {}, term ? "No contacts match." : book.tab === "personal"
      ? "No contacts yet. Add one, import a file, or use “Add to contacts” on an email." : "The shared address book is empty.")));
    return;
  }
  $list.replaceChildren(...shown.map((c) => h("div", { class: `msg contact${book.selected === c.id ? " on" : ""}`, role: "listitem", tabindex: "0",
    onclick: () => showContact(c), onkeydown: (e) => { if (e.key === "Enter") showContact(c); } },
  avatar({ name: c.name, address: c.email }),
  h("div", { class: "from" }, c.name || c.email),
  h("div", { class: "line" }, h("span", { class: "snippet" }, c.name ? c.email : ""), c.company && h("span", { class: "snippet" }, ` · ${c.company}`)))));
}

function placeholderFor(kind) {
  return kind === "contacts" ? h("div", { class: "placeholder" }, h("div", {}, icon("contacts"), h("p", {}, "Choose a contact."))) : placeholder();
}

function showContact(c) {
  book.selected = c.id;
  renderContacts();
  $shell.classList.add("reading");
  const which = c.book;
  const other = which === "personal" ? "shared" : "personal";
  const copy = canEdit(other) && h("button", { class: "btn", onclick: async () => {
    try { await api("book/save", { method: "POST", body: { ...c, id: undefined, book: other } }); toast(other === "shared" ? "Copied to the shared address book." : "Copied to your contacts."); loadContacts(); }
    catch (err) { toast(err.data?.error === "duplicate" ? "It's already there." : err.message); }
  } }, other === "shared" ? "Copy to shared" : "Copy to my contacts");
  const row = (ic, label, value) => value && h("div", { class: "contact-row" }, icon(ic), h("div", {}, h("div", { class: "muted small" }, label), value));
  $reader.replaceChildren(
    h("div", { class: "reader-bar" }, h("button", { class: "icon-btn back", "aria-label": "Back", onclick: closeContact }, icon("back")), h("span", { class: "spacer" }),
      canEdit(which) && h("button", { class: "icon-btn", title: "Delete", "aria-label": "Delete contact", onclick: async () => {
        if (!confirm(`Delete ${c.name || c.email} from ${which === "shared" ? "the shared address book" : "your contacts"}?`)) return;
        await api("book/delete", { method: "POST", body: { book: which, ids: [c.id] } }); contacts = null; closeContact(); loadContacts();
      } }, icon("trash"))),
    h("div", { class: "reader-body contact-card" },
      h("div", { class: "contact-head" }, avatar({ name: c.name, address: c.email }), h("div", {}, h("h1", {}, c.name || c.email),
        h("span", { class: "pill" }, which === "shared" ? "Shared address book" : "My contacts"))),
      h("div", { class: "row" }, h("button", { class: "btn btn-primary", onclick: () => compose({ to: c.email }) }, icon("compose"), "Write an email"),
        canEdit(which) && h("button", { class: "btn", onclick: () => editContact(c) }, "Edit"), copy || null),
      row("mail", "Email", c.email),
      row("phone", "Phone", c.phone && h("a", { href: `tel:${c.phone.replace(/[^+\d]/g, "")}` }, c.phone)),
      row("inbox", "Company", c.company),
      c.notes && h("div", { class: "contact-row" }, icon("drafts"), h("div", {}, h("div", { class: "muted small" }, "Notes"), h("div", { class: "notes" }, c.notes)))));
}

function closeContact() {
  book.selected = null;
  $shell.classList.remove("reading");
  $reader.replaceChildren(placeholderFor("contacts"));
  renderContacts();
}

function editContact(c) {
  const which = c ? c.book : book.tab;
  const field = (name, label, attrs = {}) => h("label", { class: "field" }, label, h(attrs.rows ? "textarea" : "input", { name, value: c?.[name] || "", ...attrs }, attrs.rows ? c?.[name] || "" : null));
  $shell.classList.add("reading");
  $reader.replaceChildren(
    h("div", { class: "reader-bar" }, h("button", { class: "icon-btn back", "aria-label": "Back", onclick: () => (c ? showContact(c) : closeContact()) }, icon("back"))),
    h("div", { class: "reader-body contact-card" }, h("h1", {}, c ? "Edit contact" : which === "shared" ? "New shared contact" : "New contact"),
      formFor([field("name", "Name", { maxlength: 200, autocomplete: "off" }), field("email", "Email", { type: "email", required: true, autocomplete: "off" }),
        field("phone", "Phone", { type: "tel", maxlength: 60 }), field("company", "Company", { maxlength: 200 }), field("notes", "Notes", { rows: 4, maxlength: 2000 })],
      "Save", async (v) => {
        const r = await api("book/save", { method: "POST", body: { ...v, book: which, id: c?.id } });
        contacts = null;
        await loadContacts();
        const saved = book[which].find((x) => x.id === r.id);
        if (saved) showContact(saved);
      })));
  $reader.querySelector("input[name=name]").focus();
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
        h("div", { class: "to" }, `To ${recipients}`, t.from?.address && t.folder !== "sent" && h("button", { class: "linkish add-contact", title: "Add the sender to your contacts", onclick: async (e) => {
          e.stopPropagation();
          try { await api("book/save", { method: "POST", body: { book: "personal", email: t.from.address, name: t.from.name || "" } }); toast(`${who(t.from)} is in your contacts now.`); contacts = null; }
          catch (err) { toast(err.data?.error === "duplicate" ? `${who(t.from)} is already in your contacts.` : err.message); }
        } }, icon("personAdd"), "Add to contacts")),
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
  let to = opts.to ? [opts.to] : [], cc = [], subject = "", quoted = null;
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
  // The signature is the From address's on GhostParse, added when it's sent: shown here, with a switch to leave it out.
  const sigOn = h("input", { type: "checkbox", checked: true });
  const sigBox = h("div", { class: "compose-sig" });
  const swapSignature = async () => {
    const id = fromId;
    const s = await loadSignature(id).catch(() => null);
    if (id !== fromId) return;
    const preview = s && signaturePreview(s);
    sigBox.replaceChildren(preview
      ? h("label", { class: "check" }, sigOn, h("span", {}, "Add my signature", preview))
      : h("span", { class: "muted small" }, s ? "No signature for this address yet: add one in Settings → Mailboxes." : "The signature couldn't be loaded; GhostParse adds it as usual."));
  };
  if (draft) {
    const full = await api("message", { query: { id: String(draft.id), peek: "1" } }).catch(() => null);
    editor.append(...(full?.message.text || "").split("\n").flatMap((l) => [l, h("br")]));
    // Drafts from before 1.5.0 have the signature in their text already.
    if (/\n-- \n/.test(full?.message.text || "")) sigOn.checked = false;
  } else {
    editor.append(h("div", {}, h("br")));
    if (quoted) editor.append(h("br"), quoted);
  }
  swapSignature();
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
      reply_to_id: of && opts.mode !== "forward" ? of.id : undefined, forward_of: of && opts.mode === "forward" ? of.id : undefined, attachments: files, draft_id: draftId || undefined,
      signature: sigOn.checked };
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
      editor, sigBox, attList,
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
    items = (await contactsPromise).filter((c) => c.email.includes(term) || c.name.toLowerCase().includes(term)).slice(0, 8);
    if (!items.length) return;
    index = 0;
    const r = input.getBoundingClientRect();
    box = h("div", { class: "suggest", style: `left:${r.left}px;top:${r.bottom + 2}px` }, items.map((c, i) => h("div", { class: i === 0 ? "on" : "", onmousedown: (e) => { e.preventDefault(); pick(c.email); } },
      c.name ? h("span", {}, h("strong", {}, c.name), " ", h("span", { class: "muted" }, c.email)) : c.email,
      c.source !== "recent" && h("span", { class: "pill" }, c.source === "shared" ? "shared" : "my contacts"))));
    document.body.append(box);
  });
  input.addEventListener("keydown", (e) => {
    if (!box) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      [...box.children].forEach((c, i) => c.classList.toggle("on", i === index));
    } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[index].email); } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// ------------------------------------------------------------------------------------------------ settings
async function openSettings(tab = "account") {
  document.querySelector(".overlay.settings-overlay")?.remove();
  const body = h("div", { class: "tab-body" });
  const tabs = [["account", "Account"], ["mailboxes", "Mailboxes"], ["import", "Import email"], ["security", "Sign-in & alerts"],
    ...(state.user.role === "admin" ? [["admin-users", "Users"], ["admin-mailboxes", "Connect addresses"], ["admin-status", "Status"]] : [])];
  const nav = h("nav", { class: "tabs" });
  const show = async (key) => {
    nav.replaceChildren(...tabs.map(([k, label]) => h("button", { class: k === key ? "on" : "", "aria-current": k === key ? "page" : null, onclick: () => show(k) }, label)));
    // On a phone the tabs scroll sideways: keep the chosen one in view.
    nav.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center" });
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

// ------------------------------------------------------------------------------------------------ importing email

/** Common providers' IMAP servers, and what they need instead of the normal password. */
const IMPORT_PROVIDERS = [
  ["Gmail or Google Workspace", "imap.gmail.com", "Gmail needs an app password: turn on 2-Step Verification, then make one at myaccount.google.com/apppasswords."],
  ["Outlook.com or Hotmail", "outlook.office365.com", "If Microsoft won't accept the password, export your mail to an .mbox file (Thunderbird can) and import the file below."],
  ["Yahoo Mail", "imap.mail.yahoo.com", "Yahoo needs an app password: Account security → Generate app password."],
  ["iCloud Mail", "imap.mail.me.com", "iCloud needs an app-specific password: appleid.apple.com → Sign-In and Security."],
  ["AOL", "imap.aol.com", "AOL needs an app password, made in your account's security settings."],
  ["Fastmail", "imap.fastmail.com", "Fastmail needs an app password: Settings → Privacy & Security."],
  ["Zoho Mail", "imap.zoho.com", "For an EU Zoho account, use imap.zoho.eu."],
  ["IONOS", "imap.ionos.co.uk", ""],
  ["GoDaddy", "imap.secureserver.net", ""],
  ["Your web hosting (cPanel and others)", "", "Usually mail.yourdomain.com: your host's email settings page gives it. Use the mailbox's full email address and password."],
  ["Another provider", "", "Your provider's help pages give the IMAP server's name."],
];
const IMPORT_TARGETS = [["inbox", "Inbox"], ["sent", "Sent"], ["drafts", "Drafts"], ["archive", "Archive"], ["spam", "Spam"], ["trash", "Trash"], ["", "Don't copy"]];

/** A Google or Microsoft sign-in to finish (from the address it came back to). */
let pendingImportOAuth = null;
const IMPORT_OAUTH_ERRORS = {
  denied: "The sign-in was cancelled, so nothing was copied.",
  no_refresh: "The sign-in didn't allow ongoing access. Try again, and allow access to your email.",
  failed: "The sign-in didn't finish. Try again, or use an app password instead.",
};

/** Imports carry on while the webmail is open: one step at a time, ~20 seconds each. */
const importRunner = { running: false, listeners: new Set(), imports: [] };
function importsChanged(list) {
  importRunner.imports = list;
  importRunner.listeners.forEach((fn) => fn(list));
}
async function runImports() {
  if (importRunner.running) return;
  importRunner.running = true;
  try {
    while (true) {
      const { imports } = await api("imports");
      importsChanged(imports);
      const job = imports.find((i) => i.status === "running");
      if (!job) break;
      const before = job.imported;
      const r = await api("import/step", { method: "POST", body: { id: job.id } }).catch((err) => ({ ...job, note: err.message }));
      importsChanged(importRunner.imports.map((i) => (i.id === r.id ? r : i)));
      if (r.status === "done") {
        toast(`Import finished: ${r.imported.toLocaleString()} email${r.imported === 1 ? "" : "s"} copied.`);
        refresh();
      } else if (r.imported > before) {
        refresh();
      }
      // Waiting on something (the old server, GhostParse, another tab): try again in a minute.
      if (r.note || r.busy) await new Promise((res) => setTimeout(res, 60000));
    }
  } finally {
    importRunner.running = false;
  }
}

function importRow(job, reload) {
  const what = job.kind === "imap" ? (job.provider ? `${job.username} (signed in with ${job.provider === "google" ? "Google" : "Microsoft"})` : `${job.username} on ${job.host}`) : job.kind === "maildir" ? `${job.address} (this hosting account)` : job.filename;
  const mailbox = state.mailboxes.find((m) => m.id === job.mailbox_id)?.address ?? "";
  const counts = `${job.imported.toLocaleString()} copied` + (job.skipped ? `, ${job.skipped.toLocaleString()} already here or too large` : "") + (job.failed ? `, ${job.failed} unreadable` : "");
  const progress = job.status === "uploading"
    ? `Uploading: ${Math.round((job.received / Math.max(job.size, 1)) * 100)}%`
    : job.status === "running" ? (job.kind !== "file"
      ? `Copying ${job.folders.find((f) => !f.done)?.name ?? ""}… ${counts}`
      : `Copying… ${Math.round((job.offset / Math.max(job.size, 1)) * 100)}%, ${counts}`)
    : job.status === "done" ? `Done: ${counts}` : `Stopped: ${job.note ?? ""}`;
  const act = (label, action, cls = "btn btn-sm") => h("button", { class: cls, onclick: async () => {
    await api(`import/${action}`, { method: "POST", body: { id: job.id } }).catch((err) => toast(err.message));
    reload(); runImports();
  } }, label);
  return h("div", { class: "import-row" },
    h("div", {}, h("strong", {}, what), h("span", { class: "muted small" }, ` → ${mailbox}`)),
    h("div", { class: "small" }, progress),
    job.note && job.status !== "failed" ? h("div", { class: "muted small" }, job.note) : null,
    job.status === "running" && job.kind !== "file" ? h("div", { class: "muted small" }, "It carries on while the webmail is open. You can keep using it, or close it and come back.") : null,
    h("div", { class: "row" },
      job.kind !== "file" && job.status === "done" && job.can_check_again ? act("Check for new mail", "again", "btn btn-sm btn-primary") : null,
      job.kind === "imap" && job.can_check_again && job.status === "done" ? act(job.provider ? "Forget the sign-in" : "Forget the password", "forget") : null,
      job.status !== "running" && job.status !== "uploading" ? act("Remove from list", "delete") : null),
    job.kind !== "file" && job.status === "done" && job.can_check_again
      ? h("p", { class: "muted small" }, "After your domain's email has moved here, choose Check for new mail once to copy anything that reached the old mailbox in the meantime."
        + (job.kind === "imap" ? (job.provider ? " Then forget the sign-in." : " Then forget the password.") : "")) : null);
}

/** Choose where each of the old mailbox's folders goes, then start. */
function folderPicker(folders, mailboxSelect, start, heading = "Choose what to copy") {
  const rows = folders.map((f) => ({ f, select: h("select", { "aria-label": `Copy ${f.name} into` }, IMPORT_TARGETS.map(([v, l]) => h("option", { value: v, selected: v === (f.target ?? "") }, l))) }));
  const total = () => rows.reduce((n, r) => n + (r.select.value ? (r.f.count ?? 0) : 0), 0);
  const summary = h("p", { class: "small" });
  const update = () => { summary.textContent = `${total().toLocaleString()} emails to copy. Trash and Spam (and Gmail's All Mail and Starred) are left out unless you choose them.`; };
  rows.forEach((r) => r.select.addEventListener("change", update));
  update();
  return h("div", {}, h("h4", {}, heading),
    h("table", { class: "list" }, h("tr", {}, h("th", {}, "Folder"), h("th", {}, "Emails"), h("th", {}, "Copy into")),
      rows.map((r) => h("tr", {}, h("td", {}, r.f.name), h("td", {}, r.f.count ?? "?"), h("td", {}, r.select)))),
    summary,
    formFor([mailboxSelect()], "Start copying", (w) => start(rows.map((r) => ({ raw: r.f.raw, target: r.select.value || null })), Number(w.mailbox_id || state.mailboxes[0].id))));
}

async function importSettings() {
  if (!state.mailboxes.length) return h("p", { class: "muted" }, "You don't have a mailbox to import into yet.");
  const listBox = h("div", { class: "imports" });
  const render = (list) => listBox.replaceChildren(...(list.length ? [h("h3", {}, "Your imports"), ...list.map((j) => importRow(j, reload))] : []));
  const reload = async () => render((await api("imports")).imports);
  importRunner.listeners.clear();
  importRunner.listeners.add(render);
  await reload();
  const mailboxSelect = () => h("label", { class: "field", hidden: state.mailboxes.length < 2 }, "Into", h("select", { name: "mailbox_id" },
    state.mailboxes.map((m) => h("option", { value: String(m.id) }, m.address))));

  // From an IMAP server: sign in, choose folders, copy.
  const hint = h("p", { class: "muted small" });
  const host = h("input", { name: "host", required: true, placeholder: "imap.example.com", autocomplete: "off" });
  const provider = h("select", { onchange: () => {
    const [, server, tip] = IMPORT_PROVIDERS[provider.value];
    host.value = server; hint.textContent = tip;
  } }, IMPORT_PROVIDERS.map(([name], i) => h("option", { value: String(i) }, name)));
  provider.value = "0"; host.value = IMPORT_PROVIDERS[0][1]; hint.textContent = IMPORT_PROVIDERS[0][2];
  const step2 = h("div");
  let login = null;
  const imapForm = formFor([
    h("label", { class: "field" }, "Your old provider", provider), hint,
    h("label", { class: "field" }, "IMAP server", host),
    h("div", { class: "row" },
      h("label", { class: "field" }, "Security", h("select", { name: "security" }, h("option", { value: "ssl" }, "SSL/TLS (port 993)"), h("option", { value: "starttls" }, "STARTTLS (port 143)")))),
    h("label", { class: "field" }, "Email address or username", h("input", { name: "username", required: true, autocomplete: "off" })),
    h("label", { class: "field" }, "Password (or app password)", h("input", { name: "password", type: "password", required: true, autocomplete: "off" })),
  ], "Connect", async (v) => {
    login = { host: v.host.trim(), security: v.security, port: v.security === "starttls" ? 143 : 993, username: v.username.trim(), password: v.password };
    step2.replaceChildren(h("p", { class: "muted" }, "Signing in and reading the folders…"));
    const { folders } = await api("import/probe", { method: "POST", body: login }).catch((err) => { step2.replaceChildren(); throw err; });
    step2.replaceChildren(folderPicker(folders, mailboxSelect, async (choices, mailboxId) => {
      await api("import/imap", { method: "POST", body: { ...login, mailbox_id: mailboxId, folders: choices } });
      step2.replaceChildren(); imapForm.reset(); login = null;
      host.value = IMPORT_PROVIDERS[provider.value][1];
      toast("Copying has started.");
      await reload(); runImports();
    }));
  });

  // Signed in with Google or Microsoft: no password.
  const providers = (await api("import/oauth/providers").catch(() => ({ providers: [] }))).providers;
  const oauthBox = h("div");
  const signIn = providers.length ? h("div", { class: "row oauth-buttons" }, providers.map((p) => h("button", { class: "btn", type: "button", onclick: async (e) => {
    e.target.disabled = true;
    try {
      location.href = (await api("import/oauth/start", { method: "POST", body: { provider: p.id } })).url;
    } catch (err) { toast(err.message); e.target.disabled = false; }
  } }, `Sign in with ${p.name}`)), h("span", { class: "muted small" }, "No app password needed.")) : null;
  if (pendingImportOAuth) {
    const { handle, error } = pendingImportOAuth;
    pendingImportOAuth = null;
    if (error || !handle) {
      oauthBox.replaceChildren(h("div", { class: "notice warn" }, IMPORT_OAUTH_ERRORS[error] ?? IMPORT_OAUTH_ERRORS.failed));
    } else {
      oauthBox.replaceChildren(h("p", { class: "muted" }, "Signed in: reading your folders…"));
      try {
        const who = await api("import/oauth/claim", { method: "POST", body: { handle } });
        const { folders } = await api("import/probe", { method: "POST", body: { oauth: true } });
        oauthBox.replaceChildren(folderPicker(folders, mailboxSelect, async (choices, mailboxId) => {
          await api("import/imap", { method: "POST", body: { oauth: true, mailbox_id: mailboxId, folders: choices } });
          oauthBox.replaceChildren();
          toast("Copying has started.");
          await reload(); runImports();
        }, `Copy ${who.email}`));
      } catch (err) {
        oauthBox.replaceChildren(h("div", { class: "notice bad" }, err.message));
      }
    }
  }

  // From a file: uploaded in pieces, then copied.
  const fileIn = h("input", { type: "file", name: "file", required: true, accept: ".mbox,.mbx,.eml,application/mbox,message/rfc822" });
  const upload = h("div", { class: "small" });
  const fileForm = formFor([
    h("label", { class: "field" }, "File", fileIn, h("small", { class: "muted" }, "An .mbox file (Google Takeout, Thunderbird, Apple Mail) or a single .eml. Unzip a Google Takeout download first.")),
    h("label", { class: "field" }, "Put emails without a folder in", h("select", { name: "folder" }, h("option", { value: "archive" }, "Archive"), h("option", { value: "inbox" }, "Inbox"), h("option", { value: "sent" }, "Sent"))),
    mailboxSelect(), upload,
  ], "Upload and import", async (v) => {
    const file = fileIn.files[0];
    if (!file) throw new Error("Choose a file.");
    let job = await api("import/file", { method: "POST", body: { mailbox_id: Number(v.mailbox_id || state.mailboxes[0].id), filename: file.name, size: file.size, folder: v.folder } });
    const { chunk_bytes: chunk } = await api("imports");
    while (job.status === "uploading") {
      upload.textContent = `Uploading… ${Math.round((job.received / file.size) * 100)}%`;
      const res = await fetch(`api.php?${new URLSearchParams({ a: "import/chunk", id: String(job.id), offset: String(job.received) })}`, {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/octet-stream" },
        body: file.slice(job.received, job.received + chunk),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Upload stopped (error ${res.status}). Choose the file again to carry on.`);
      job = data;
    }
    upload.textContent = "";
    fileForm.reset();
    await reload(); runImports();
  });

  // The mailboxes on this hosting account (cPanel's own email accounts): no password needed.
  const local = (await api("import/local").catch(() => ({ mailboxes: [] }))).mailboxes;
  const localPick = h("div");
  const localSection = local.length ? h("section", {}, h("h3", {}, "From this hosting account"),
    h("p", { class: "muted small" }, "The email accounts on the hosting where this webmail is installed. They're read straight from the server: no password needed."),
    h("table", { class: "list" }, local.map((m) => h("tr", {}, h("td", {}, m.address), h("td", {}, `${m.total.toLocaleString()} emails`),
      h("td", {}, h("button", { class: "btn btn-sm", onclick: () => localPick.replaceChildren(folderPicker(m.folders, mailboxSelect, async (choices, mailboxId) => {
        await api("import/maildir", { method: "POST", body: { address: m.address, mailbox_id: mailboxId, folders: choices } });
        localPick.replaceChildren();
        toast("Copying has started.");
        await reload(); runImports();
      }, `Copy ${m.address}`)) }, "Choose folders"))))),
    localPick) : null;

  return h("div", {},
    h("p", { class: "muted" }, "Bring your old email here: everything is copied into your encrypted mailbox, keeping folders, dates, read and starred. Nothing on the old server is changed or deleted."),
    listBox, localSection,
    h("section", {}, h("h3", {}, "From your old provider"), signIn, oauthBox,
      signIn ? h("p", { class: "muted small" }, "Or sign in with a password or app password (any provider with IMAP):") : null, imapForm, step2),
    h("section", {}, h("h3", {}, "From a file"), fileForm));
}

/** Each mailbox's signature on GhostParse, loaded once per mailbox while the app is open. */
const signatures = new Map();
function loadSignature(mailboxId) {
  if (!signatures.has(mailboxId)) {
    signatures.set(mailboxId, api("mailbox/signature", { query: { id: String(mailboxId) } }).catch((err) => { signatures.delete(mailboxId); throw err; }));
  }
  return signatures.get(mailboxId);
}

/** The signature as it's added to an email (as GhostParse does: a block only when there's more than a name), and the disclaimer. */
function signaturePreview(s, { disclaimer = true } = {}) {
  const lines = s.position || s.signature ? [s.display_name, s.position, s.signature].filter(Boolean) : [];
  if (!lines.length && !(disclaimer && s.disclaimer)) return null;
  const text = (t) => t.split("\n").flatMap((l, i) => (i ? [h("br"), l] : [l]));
  return h("div", { class: "sig-preview" },
    lines.length ? h("div", { class: "signature" }, "-- ", h("br"), ...lines.flatMap((l, i) => [i ? h("br") : null, ...(i === 0 && s.display_name ? [h("strong", {}, l)] : text(l))]).filter(Boolean)) : null,
    disclaimer && s.disclaimer ? h("div", { class: "disclaimer" }, ...text(s.disclaimer)) : null);
}

/** Settings → Mailboxes: one mailbox's From name, position and signature, and its domain's disclaimer. */
async function signatureSettings(m) {
  const box = h("section", {}, h("h3", {}, m.address));
  let s;
  try {
    s = await loadSignature(m.id);
  } catch (err) {
    box.append(h("p", { class: "error" }, err.message));
    return box;
  }
  const preview = h("div", { class: "sig-preview-wrap" });
  const form = formFor([
    h("label", { class: "field" }, "Name people see", h("input", { name: "display_name", value: s.display_name, maxlength: 100, placeholder: state.user.name })),
    h("label", { class: "field" }, "Position", h("input", { name: "position", value: s.position, maxlength: 100, placeholder: "Customer support" })),
    h("label", { class: "field" }, "Signature", h("textarea", { name: "signature", rows: 4, maxlength: 2000, placeholder: "Phone, website, opening hours…" }, s.signature)),
    s.can_edit_disclaimer
      ? h("label", { class: "field" }, `Disclaimer for everyone at ${s.domain}`, h("textarea", { name: "disclaimer", rows: 3, maxlength: 4000 }, s.disclaimer),
        h("small", { class: "muted" }, "Added under the signature on every email from the domain, whoever sends it."))
      : s.disclaimer && h("p", { class: "muted small" }, `Your administrator's disclaimer for ${s.domain} is added below it.`),
    h("div", {}, h("span", { class: "muted small" }, "How it looks:"), preview),
  ], "Save", async (v) => {
    const saved = await api("mailbox/signature", { method: "POST", body: { id: m.id, ...v } });
    signatures.set(m.id, Promise.resolve(saved));
    m.display_name = saved.display_name;
    toast("Saved.");
  });
  const show = () => {
    const v = Object.fromEntries(new FormData(form));
    preview.replaceChildren(signaturePreview({ ...s, ...v }) || h("p", { class: "muted small" }, "No signature: only the name is used, as the sender's name."));
  };
  form.addEventListener("input", show);
  show();
  box.append(form);
  return box;
}

/** Settings: the authenticator app and recovery codes. Two-step verification can't be turned off. */
async function twoStepSettings() {
  const st = await api("mfa/status");
  const box = h("section", {}, h("h3", {}, "Two-step verification"));
  const area = h("div");
  const passwordForm = (label, onPassword) => {
    const pw = h("input", { type: "password", required: true, autocomplete: "current-password" });
    return formFor([h("label", { class: "field" }, "Your password", pw)], label, async () => onPassword(pw.value));
  };
  box.append(
    h("p", { class: "muted" }, "Required for everyone: after your password, you confirm it's you with your authenticator app or a passkey."),
    h("div", { class: "row between" }, h("div", {}, h("strong", {}, "Authenticator app"),
      h("div", { class: "muted small" }, st.totp ? `On since ${new Date(st.totp_since).toLocaleDateString()}` : "Not set up")),
      h("button", { class: "btn btn-sm", onclick: async () => {
        const setup = await api("mfa/setup");
        area.replaceChildren(totpSetupForm(setup, true, (r) => {
          toast("Your authenticator app is set up.");
          area.replaceChildren(r.recovery_codes?.length ? h("div", {}, h("p", {}, "Your new recovery codes. Save them now: they won't be shown again."),
            recoveryCodesBox(r.recovery_codes, r.recovery_codes.join("\n"))) : "");
        }));
      } }, st.totp ? "Change" : "Set up")),
    h("div", { class: "row between" }, h("div", {}, h("strong", {}, "Recovery codes"),
      h("div", { class: "muted small" }, `${st.recovery_codes_left} of 10 left. Each gets you in once if you lose your phone.`)),
      h("button", { class: "btn btn-sm", onclick: () => area.replaceChildren(passwordForm("Make new codes", async (password) => {
        const r = await api("mfa/recovery-codes", { method: "POST", body: { password } });
        area.replaceChildren(h("p", {}, "Your old codes no longer work. Save these now: they won't be shown again."),
          recoveryCodesBox(r.recovery_codes, r.recovery_codes.join("\n")));
      })) }, "New codes")),
    area);
  return box;
}

const SETTINGS = {
  import: () => importSettings(),
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
    return h("div", {}, h("p", { class: "muted" }, "Signatures are kept on GhostParse, so they're added to this address's email wherever it's sent from: here, your website or your shop."),
      ...await Promise.all(state.mailboxes.map(signatureSettings)));
  },
  async security() {
    return h("div", {}, await twoStepSettings(), window.Passkeys?.settings?.() || h("section", {}, h("h3", {}, "Passkeys"), h("p", { class: "muted" }, "Not available in this browser.")),
      window.Notifications?.settings?.() || null);
  },
  async "admin-users"() {
    const [{ users }, { mailboxes }] = await Promise.all([api("admin/users"), api("admin/mailboxes")]);
    const boxes = (selected) => h("div", {}, mailboxes.map((m) => h("label", { class: "check" }, h("input", { type: "checkbox", name: `mb_${m.id}`, checked: selected.includes(m.id) }), m.address)));
    const pickBoxes = (v) => mailboxes.filter((m) => v[`mb_${m.id}`] === "on").map((m) => m.id);
    const table = h("table", { class: "list" }, h("tr", {}, h("th", {}, "User"), h("th", {}, "Role"), h("th", {}, "Mailboxes"), h("th", {}, "")),
      users.map((u) => h("tr", {}, h("td", {}, u.name, h("div", { class: "muted small" }, u.email), u.disabled && h("span", { class: "pill bad" }, "disabled"),
          !u.two_step && h("span", { class: "pill", title: "Sets it up at their next sign-in" }, "two-step not set up")),
        h("td", {}, u.role), h("td", {}, mailboxes.filter((m) => u.mailbox_ids.includes(m.id)).map((m) => m.address).join(", ") || h("span", { class: "muted" }, "none")),
        h("td", {}, h("button", { class: "btn btn-sm", onclick: () => editUser(u) }, "Edit")))));
    const editUser = (u) => {
      const dlg = h("section", {}, h("h3", {}, `Edit ${u.email}`),
        formFor([h("label", { class: "field" }, "Name", h("input", { name: "name", value: u.name })),
          h("label", { class: "field" }, "Role", h("select", { name: "role" }, h("option", { value: "user", selected: u.role === "user" }, "User"), h("option", { value: "admin", selected: u.role === "admin" }, "Administrator"))),
          h("label", { class: "field" }, "New password (leave empty to keep)", h("input", { type: "password", name: "password", minlength: 10, autocomplete: "new-password" })),
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "disabled", checked: u.disabled }), "Can't sign in (disabled)"),
          h("div", { class: "field" }, "Mailboxes", boxes(u.mailbox_ids)),
          u.id !== state.user.id && u.two_step && h("div", { class: "field" }, "Two-step verification",
            h("p", { class: "muted small" }, "Lost their phone? A reset removes their authenticator app, passkeys and recovery codes and signs them out. They set up a new one when they next sign in."),
            h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: async () => {
              if (!confirm(`Reset two-step verification for ${u.email}?`)) return;
              await api("admin/users/mfa-reset", { method: "POST", body: { id: u.id } });
              toast("Reset. They'll set it up again at their next sign-in."); openSettings("admin-users");
            } }, "Reset two-step verification"))],
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
    const [s, update] = await Promise.all([api("admin/status"), updateSection()]);
    return h("div", {}, update, h("section", {}, h("h3", {}, "GhostParse"),
      s.account && h("p", {}, "Connected to ", h("strong", {}, s.account.name), s.account.plan ? ` (${s.account.plan} plan)` : ""),
      s.problems.length ? h("div", { class: "notice warn" }, s.problems.map((p) => h("div", {}, p))) : h("div", { class: "notice ok" }, "Everything's working.")));
  },
};

// ------------------------------------------------------------------------------------------------ keyboard
// Escape closes the menu on a phone, as tapping outside it does.
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $shell?.classList.contains("menu")) $shell.classList.remove("menu"); });
document.addEventListener("keydown", (e) => {
  if (!$shell || e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay")) return;
  if (state.folder === "contacts" && !["c", "/"].includes(e.key)) return; // mail shortcuts don't apply to contacts
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
