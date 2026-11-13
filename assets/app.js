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
  share: "M12 3v12 M8 7l4-4 4 4 M8 11H6v10h12V11h-2",
  homeAdd: "M5 4h14v16H5z M12 8v8 M8 12h8",
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
  note: "M5 4h14v12l-4 4H5z M15 20v-4h4 M8 9h8 M8 13h5",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2 20a7 7 0 0 1 14 0 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14a6 6 0 0 1 4 6",
  assign: "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 20a7 7 0 0 1 11-5.7 M16 17l2 2 4-4",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 7v5l3 2",
  sendLater: "M3 11l14-7-4 9 M3 11l6 2 M9 13l1.5 4.5 M17 13a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M17 15.5V17l1 .8",
  label: "M3 12V4h8l9 9-8 8z M7.5 8h.01",
  template: "M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5",
  filter: "M4 5h16l-6 8v5l-4 2v-7z",
  up: "M12 19V5 M6 11l6-6 6 6",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 17h2",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  check: "M5 12l5 5 9-10",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  pin: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z M12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 21h4",
  down: "M12 5v14 M6 13l6 6 6-6",
};
const icon = (name) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
  h("path", { d: ICONS[name] }));

async function api(action, { method = "GET", body, query } = {}) {
  const qs = new URLSearchParams({ a: action, ...(query || {}) });
  const res = await fetch(`api.php?${qs}`, {
    method, credentials: "same-origin",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      // The installed app or a browser tab: for the list of where you're signed in.
      "X-Webmail-App": matchMedia("(display-mode: standalone)").matches || navigator.standalone === true ? "1" : "0" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !["session", "login", "passkey/login"].includes(action)) {
    // Off the trusted networks: signed out, with the reason.
    showLogin(data.error === "network_not_allowed" ? data.message : undefined);
    throw new Error(data.message || "Sign in again");
  }
  // Passkeys only: a change that needs confirming is confirmed with the passkey (Face ID, Touch ID…), then sent again.
  if (res.status === 422 && data.error === "passkey_required" && body && !body.passkey && window.Passkeys?.available?.()) {
    return api(action, { method, query, body: { ...body, password: undefined, passkey: await window.Passkeys.assertion() } });
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
const FOLDERS = [["inbox", "Inbox", "inbox"], ["starred", "Starred", "star"], ["snoozed", "Snoozed", "clock"], ["sent", "Sent", "sent"], ["drafts", "Drafts", "drafts"],
  ["scheduled", "Scheduled", "sendLater"], ["archive", "Archive", "archive"], ["spam", "Spam", "spam"], ["trash", "Trash", "trash"]];
// folder "label": state.label's email. prefs: the person's own settings (Undo send). scheduledCount: emails waiting to be sent.
const state = { user: null, mailboxes: [], mailbox: 0, folder: "inbox", query: "", page: 1, messages: [], hasMore: false, selected: null, appInfo: {}, team: "",
  label: 0, prefs: { undo_send: 10 }, scheduledCount: 0 };
/** Shared mailboxes (more than one person reads them) have notes, assignment and replies written together. */
const sharedInView = () => state.mailboxes.some((m) => m.members > 1 && (!state.mailbox || m.id === state.mailbox));
const TEAM_FILTERS = [["", "Everything"], ["mine", "Assigned to me"], ["unassigned", "Unassigned"], ["open", "Open"], ["in_progress", "In progress"], ["resolved", "Resolved"]];
const STATUS_LABELS = { open: "Open", in_progress: "In progress", resolved: "Resolved" };

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
    state.prefs = s.prefs || state.prefs;
    state.scheduledCount = s.scheduled || 0;
    if (s.user.passkey_setup) { showPasskeySetup(); return; }
    renderShell();
    await loadList();
    window.Notifications?.afterSignIn?.(s);
    runImports().catch(() => {}); // an import left running carries on
    recoverDrafts().catch(() => {});
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
  if (data.mfa === "enrol") return data.passkeys_only ? showPasskeySetup(true) : showEnrol();
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

/**
 * Passkeys only, and none yet: add one before anything else (after the password, or as the second step). With
 * pending, it's the sign-in's second step (and recovery codes come back); else the session is signed in already.
 */
function showPasskeySetup(pending = false) {
  const error = h("div", { class: "error", role: "alert" });
  const add = h("button", { class: "btn btn-primary", onclick: async () => {
    add.disabled = true; error.textContent = "";
    try {
      const r = await window.Passkeys.register(/iPhone|iPad|Mac/.test(navigator.userAgent) ? "Apple passkey" : /Windows/.test(navigator.userAgent) ? "Windows Hello" : "Passkey");
      if (pending) { csrf = r.csrf; showRecoveryCodes(r.recovery_codes, start); } else { toast("Passkey added. Next time, sign in with it."); start(); }
    } catch (err) { error.textContent = err.name === "NotAllowedError" ? "Cancelled. Try again when you're ready." : err.message; add.disabled = false; }
  } }, icon("shield"), "Add a passkey");
  authCard("Add a passkey to carry on", "Your organisation signs in with passkeys instead of passwords: Face ID, Touch ID, Windows Hello or your fingerprint. Add one now; next time, that's how you sign in.",
    window.Passkeys?.available?.() ? h("div", { class: "auth-actions" }, add)
      : h("div", { class: "notice warn" }, "This browser can't make a passkey here. Use a recent Chrome, Edge, Safari or Firefox, on the webmail's https:// address."),
    error, h("p", { class: "muted small" }, "Your face or fingerprint never leaves your device. You can add more devices later, under Settings → Sign-in & alerts."));
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
let $shell, $folders, $list, $reader, $listTitle, $search, $tabbar, $calPane;
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
    // The calendar takes the list's and the reader's place (assets/calendar.js).
    ($calPane = h("section", { class: "cal-pane", "aria-label": "Calendar" })),
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
  // Drafts on the device go to the server first, then are deleted from it (it may be a shared computer).
  if (window.LocalDrafts && state.user) {
    flushCompose?.();
    await LocalDrafts.syncAll(state.user.id, csrf).catch(() => 0);
    const unsaved = (await LocalDrafts.all().catch(() => [])).filter((r) => r.user === state.user.id && r.dirty).length;
    if (unsaved && !confirm(`${unsaved === 1 ? "A draft hasn't" : `${unsaved} drafts haven't`} been saved to the server yet (you're offline). Sign out and delete ${unsaved === 1 ? "it" : "them"} from this device?`)) return;
    const mine = (await LocalDrafts.all().catch(() => [])).filter((r) => r.user === state.user.id);
    for (const r of mine) await LocalDrafts.remove(r.key).catch(() => {});
  }
  document.querySelector(".overlay.compose-overlay")?.remove();
  flushCompose = null;
  try { navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* not supported */ }
  await api("logout", { method: "POST" }).catch(() => {});
  navigator.serviceWorker?.controller?.postMessage("signed-out");
  $shell = null;
  showLogin("", { signedOut: true });
}

function unreadFor(folder) {
  return state.mailboxes.filter((m) => !state.mailbox || m.id === state.mailbox).reduce((n, m) => n + (m.unread?.[folder] || 0), 0);
}

/** The app icon's badge (installed app on iPhone, iPad, Android, Mac and Windows): unread email in the inbox. */
function updateBadge() {
  const n = state.user ? state.mailboxes.reduce((t, m) => t + (m.unread?.inbox || 0), 0) : 0;
  try { (n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.())?.catch?.(() => {}); } catch { /* not supported */ }
}

function renderFolders() {
  updateBadge();
  renderTabbar();
  $search.placeholder = state.folder === "contacts" ? "Search contacts" : "Search mail";
  $search.setAttribute("aria-label", $search.placeholder);
  $shell.classList.toggle("cal-mode", state.folder === "calendar");
  $folders.replaceChildren(...[...FOLDERS, ["contacts", "Contacts", "contacts"], ["calendar", "Calendar", "calendar"]].map(([key, label, ic]) => {
    const n = key === "scheduled" ? state.scheduledCount : ["starred", "snoozed", "contacts", "calendar"].includes(key) ? 0 : unreadFor(key);
    return h("li", { class: key === "contacts" ? "sep" : "" }, h("a", { href: "#", class: state.folder === key && !state.query ? "on" : "", onclick: (e) => {
      e.preventDefault();
      openFolder(key);
    } }, icon(ic), label, n > 0 && key !== "sent" && key !== "drafts" && key !== "trash" ? h("span", { class: `badge${key === "scheduled" ? " quiet" : ""}` }, n > 99 ? "99+" : String(n)) : null));
  }), ...labelLinks());
}

/** The labels of the mailboxes in view, under the folders (like folders of their own), with a way to the rules. */
function labelLinks() {
  const boxes = state.mailboxes.filter((m) => !state.mailbox || m.id === state.mailbox);
  const many = boxes.filter((m) => m.labels?.length).length > 1;
  const links = boxes.flatMap((m) => (m.labels || []).map((l) => h("li", {}, h("a", { href: "#", class: state.folder === "label" && state.label === l.id && !state.query ? "on" : "",
    title: many ? `${l.name} (${m.address})` : l.name, onclick: (e) => { e.preventDefault(); openFolder("label", l.id); } },
  icon("label"), h("span", { class: "label-name" }, l.name, many ? h("small", { class: "muted" }, ` ${m.address.split("@")[0]}`) : null),
  l.unread > 0 ? h("span", { class: "badge" }, l.unread > 99 ? "99+" : String(l.unread)) : null))));
  if (!state.mailboxes.length) return [];
  return [h("li", { class: "sep folders-head" }, h("span", {}, "Labels"),
    h("button", { type: "button", class: "icon-btn small-btn", title: "Rules & labels", "aria-label": "Rules and labels", onclick: () => openSettings("rules") }, icon("filter"))), ...links];
}

/** A label by id, from the mailboxes' lists: { id, name, mailbox }. */
function labelById(id) {
  for (const m of state.mailboxes) for (const l of m.labels || []) if (l.id === id) return { ...l, mailbox: m };
  return null;
}

function openFolder(key, label = 0) {
  state.folder = key; state.label = label; state.query = ""; state.page = 1; $search.value = "";
  $shell.classList.remove("menu", "reading");
  renderFolders(); loadList();
  $list.scrollTop = 0;
}

/**
 * Phones: quick buttons along the bottom of the screen, in reach of a thumb. Inbox, Sent, a raised Compose in the
 * middle, Contacts, and More for the rest (the side menu: every folder, mailboxes, settings). Calendar is second.
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
    tab("calendar", "Calendar", "calendar"),
    // In the calendar, the middle button makes an event instead of an email.
    state.folder === "calendar" && window.Calendar
      ? h("button", { type: "button", class: "tab tab-compose", "aria-label": "New event", onclick: () => window.Calendar.newEvent() }, h("span", { class: "tab-fab" }, icon("compose")))
      : h("button", { type: "button", class: "tab tab-compose", "aria-label": "Compose", onclick: () => compose() }, h("span", { class: "tab-fab" }, icon("compose"))),
    tab("contacts", "Contacts", "contacts"),
    h("button", { type: "button", class: `tab${["inbox", "calendar", "contacts"].includes(state.folder) || state.query ? "" : " on"}`, onclick: () => $shell.classList.add("menu") },
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
      formFor([confirmPw("Your password, to confirm")],
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
  if (state.folder === "calendar") return window.Calendar?.showCalendar();
  if (state.folder === "contacts") return loadContacts();
  if (state.folder === "scheduled" && !state.query) return loadScheduled();
  if (state.folder === "label" && !labelById(state.label)) { state.folder = "inbox"; state.label = 0; renderFolders(); }
  const folder = state.query ? "all" : state.folder === "starred" ? "all" : state.folder;
  const label = state.query ? `Results for “${state.query}”` : state.folder === "label" ? labelById(state.label).name : FOLDERS.find((f) => f[0] === state.folder)[1];
  const teamOn = sharedInView() && !["sent", "drafts", "snoozed"].includes(state.folder);
  if (!teamOn) state.team = "";
  $listTitle.replaceChildren(h("h2", {}, label), teamOn ? h("select", { class: "input team-filter", "aria-label": "Show", onchange: (e) => { state.team = e.target.value; state.page = 1; loadList(); } },
    TEAM_FILTERS.map(([v, l]) => h("option", { value: v, selected: state.team === v }, l))) : "");
  if (!append) $list.replaceChildren(h("div", { class: "empty" }, "Loading…"));
  try {
    const r = await api("messages", { query: { folder, mailbox: String(state.mailbox || ""), page: String(state.page), q: state.query, starred: state.folder === "starred" && !state.query ? "1" : "", team: state.team,
      label: state.folder === "label" && !state.query ? String(state.label) : "" } });
    state.messages = append ? state.messages.concat(r.messages) : r.messages;
    state.hasMore = r.has_more;
    renderList();
  } catch (err) {
    $list.replaceChildren(h("div", { class: "empty" }, err.message));
  }
}

function renderList() {
  if (!state.messages.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon(state.query ? "search" : state.folder === "snoozed" ? "clock" : "inbox"),
      h("p", {}, state.query ? "Nothing matches." : state.folder === "snoozed" ? "Nothing snoozed. Snooze an email to have it come back to the top of your inbox when you're ready for it." : "Nothing here.")));
    return;
  }
  const rows = state.messages.map((m) => {
    const person = state.folder === "sent" || state.folder === "drafts" || m.folder === "sent" || m.folder === "drafts" ? (m.to[0] || m.from) : m.from;
    return swipeable(m, h("div", { class: `msg${m.read ? "" : " unread"}${state.selected === m.id ? " on" : ""}`, role: "listitem", tabindex: "0", dataset: { id: String(m.id) },
      onclick: () => (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)),
      onkeydown: (e) => { if (e.key === "Enter") (m.folder === "drafts" ? openDraft(m) : openMessage(m.id)); } },
    avatar(person),
    h("div", { class: "from" }, (m.folder === "sent" || m.folder === "drafts") ? `To: ${who(person)}` : who(person)),
    m.snoozed_until ? h("div", { class: "date snoozed", title: `Snoozed until ${longDate(m.snoozed_until)}` }, icon("clock"), whenShort(m.snoozed_until)) : h("div", { class: "date" }, shortDate(m.date)),
    h("div", { class: "line" }, h("span", { class: "subject" }, m.subject || "(no subject)"),
      ...(m.labels || []).filter((l) => !(state.folder === "label" && l.id === state.label)).map((l) => h("span", { class: "label-pill" }, l.name)),
      h("span", { class: "snippet" }, m.snippet ? `— ${m.snippet}` : ""),
      h("span", { class: "flags" }, m.has_attachments && icon("clip"), m.starred && h("span", { class: "star" }, icon("star")), m.auth === "fail" && h("span", { class: "pill bad", title: "Failed SPF, DKIM and DMARC: be careful" }, "unverified"))),
    m.team && (m.team.assignee || m.team.status !== "open") && h("div", { class: "team-line" },
      m.team.status !== "open" && h("span", { class: `status-pill ${m.team.status}` }, STATUS_LABELS[m.team.status]),
      m.team.assignee && h("span", { class: `assignee${m.team.assignee_id === state.user.id ? " me" : ""}` }, icon("assign"), m.team.assignee_id === state.user.id ? "You" : m.team.assignee))));
  });
  $list.replaceChildren(...rows, ...(state.hasMore ? [h("button", { class: "btn more", onclick: () => { state.page += 1; loadList(true); } }, "Load more")] : []));
}

// ------------------------------------------------------------------------------------------------ menus and times
/** A small menu under a button: items are { label, run } (or a node, or null for a line). Closes on a pick, Escape or a click outside. */
function popMenu(anchor, items, { className = "" } = {}) {
  document.querySelector(".pop-menu")?.remove();
  const close = () => { box.remove(); document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", esc, true); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus?.(); } };
  const box = h("div", { class: `pop-menu ${className}`, role: "menu" }, items.map((it) => it == null ? h("hr")
    : it instanceof Node ? it
      : h("button", { type: "button", role: "menuitem", class: it.class || "", onclick: () => { close(); it.run(); } }, it.icon ? icon(it.icon) : null, h("span", {}, it.label), it.hint ? h("small", { class: "muted" }, it.hint) : null)));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, hgt = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  box.style.top = `${r.bottom + hgt + 8 > innerHeight && r.top - hgt - 4 > 0 ? r.top - hgt - 4 : r.bottom + 4}px`;
  setTimeout(() => { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", esc, true); });
  box.querySelector("button, input")?.focus();
  return { box, close };
}

const whenShort = (iso) => {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], d - now < 6 * 86400000 ? { weekday: "short" } : { day: "numeric", month: "short" })} ${time}`;
};
const at = (days, hour, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };

/** Times to choose from for snooze or send later, and a date and time of your own. onPick(Date). */
function pickTime(anchor, kind, onPick) {
  const now = new Date();
  const presets = [];
  if (kind === "snooze") {
    if (now.getHours() < 18) { const later = new Date(now); later.setHours(now.getHours() + 3, 0, 0, 0); presets.push(["Later today", later]); }
    presets.push(["Tomorrow", at(1, 8)]);
    if (now.getDay() >= 1 && now.getDay() <= 4) presets.push(["This weekend", at(6 - now.getDay(), 8)]);
    presets.push(["Next week", at(((8 - now.getDay()) % 7) || 7, 8)]);
  } else {
    presets.push(["Tomorrow morning", at(1, 8)], ["Tomorrow afternoon", at(1, 13)]);
    if (now.getDay() !== 1) presets.push(["Monday morning", at(((8 - now.getDay()) % 7) || 7, 8)]);
  }
  // The same time twice (on a Sunday, tomorrow is next week): only the first.
  const seen = new Set();
  const unique = presets.filter(([, d]) => !seen.has(d.getTime()) && seen.add(d.getTime()));
  const pad = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const input = h("input", { type: "datetime-local", class: "input", min: local(now), value: local(at(1, 8)), "aria-label": "Date and time" });
  const custom = h("form", { class: "pop-custom", onsubmit: (e) => {
    e.preventDefault();
    const d = new Date(input.value);
    if (Number.isNaN(d.getTime()) || d < new Date(Date.now() + 60000)) { input.setCustomValidity("Choose a time in the future"); input.reportValidity(); return; }
    menu.close(); onPick(d);
  } }, h("div", { class: "muted small" }, "Pick a date and time"), input, h("button", { class: "btn btn-sm btn-primary" }, kind === "snooze" ? "Snooze" : "Schedule send"));
  input.addEventListener("input", () => input.setCustomValidity(""));
  const menu = popMenu(anchor, [h("div", { class: "pop-title" }, kind === "snooze" ? "Snooze until…" : "Send it…"),
    ...unique.map(([label, d]) => ({ label, hint: whenShort(d.toISOString()), run: () => onPick(d) })), null, custom], { className: "time-menu" });
}

// ------------------------------------------------------------------------------------------------ scheduled
// Emails waiting to be sent later (and ones that couldn't be), soonest first.
let scheduledList = [];
async function loadScheduled() {
  $listTitle.replaceChildren(h("h2", {}, "Scheduled"));
  $list.replaceChildren(h("div", { class: "empty" }, "Loading…"));
  try { scheduledList = (await api("scheduled")).scheduled; } catch (err) { $list.replaceChildren(h("div", { class: "empty" }, err.message)); return; }
  state.messages = [];
  state.scheduledCount = scheduledList.length;
  renderFolders();
  if (!scheduledList.length) {
    $list.replaceChildren(h("div", { class: "empty" }, icon("sendLater"), h("p", {}, "Nothing waiting to be sent. Choose Send later (the clock beside Send) to write an email now and have it go when you choose.")));
    return;
  }
  $list.replaceChildren(...scheduledList.map((x) => h("div", { class: `msg${x.status === "failed" ? " failed" : ""}${state.selected === `s${x.id}` ? " on" : ""}`, role: "listitem", tabindex: "0",
    onclick: () => showScheduled(x), onkeydown: (e) => { if (e.key === "Enter") showScheduled(x); } },
  avatar({ address: x.to[0] || "?" }),
  h("div", { class: "from" }, `To: ${x.to.join(", ") || "(nobody)"}`),
  h("div", { class: "date snoozed", title: longDate(x.send_at) }, icon("sendLater"), whenShort(x.send_at)),
  h("div", { class: "line" }, h("span", { class: "subject" }, x.subject || "(no subject)"), h("span", { class: "snippet" }, x.snippet ? `— ${x.snippet}` : ""),
    h("span", { class: "flags" }, x.attachments > 0 && icon("clip"), x.status === "failed" && h("span", { class: "pill bad" }, "not sent"), x.status === "sending" && h("span", { class: "pill" }, "sending"))))));
}

/** Open an email that's waiting to be sent from the Scheduled list or a page of its own (#scheduled). */
function showScheduled(x) {
  state.selected = `s${x.id}`;
  current = null;
  $shell.classList.add("reading");
  loadScheduledRowsOn();
  const done = (message) => { toast(message); closeReader(); loadScheduled(); };
  const act = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { toast(err.message); } b.disabled = false; };
  const box = state.mailboxes.find((m) => m.id === x.mailbox_id);
  $reader.replaceChildren(
    h("div", { class: "reader-bar" }, h("button", { class: "icon-btn back", "aria-label": "Back", onclick: closeReader }, icon("back")), h("span", { class: "spacer" })),
    h("div", { class: "reader-body" }, h("h1", {}, x.subject || "(no subject)"),
      x.status === "failed" ? h("div", { class: "notice bad" }, h("strong", {}, "Not sent. "), x.error || "")
        : h("div", { class: "notice ok scheduled-note" }, icon("sendLater"), ` Sends ${longDate(x.send_at)}`, x.error ? h("div", { class: "small" }, `Trying again: ${x.error}`) : null),
      h("p", {}, h("span", { class: "muted" }, "From "), box ? box.address : "", h("br"), h("span", { class: "muted" }, "To "), x.to.join(", ")),
      x.snippet && h("p", { class: "muted" }, x.snippet, x.snippet.length >= 180 ? "…" : ""),
      x.attachments > 0 && h("p", { class: "muted small" }, icon("clip"), ` ${x.attachments} attachment${x.attachments === 1 ? "" : "s"}`),
      h("div", { class: "reply-row" },
        h("button", { class: "btn btn-primary", onclick: act(async () => { await api("scheduled/send", { method: "POST", body: { id: x.id } }); done("Sent."); refreshCounts(); }) }, icon("sent"), "Send now"),
        h("button", { class: "btn", onclick: (e) => pickTime(e.currentTarget, "send", async (d) => {
          try { await api("scheduled/time", { method: "POST", body: { id: x.id, send_at: d.toISOString() } }); done(`Sends ${whenShort(d.toISOString())}.`); } catch (err) { toast(err.message); }
        }) }, icon("clock"), x.status === "failed" ? "Try again at…" : "Change time"),
        h("button", { class: "btn", onclick: act(async () => {
          const { payload } = await api("scheduled/cancel", { method: "POST", body: { id: x.id } });
          closeReader(); loadScheduled(); openPayload(payload);
        }) }, icon("drafts"), "Edit"),
        h("button", { class: "btn btn-danger", onclick: act(async () => {
          if (!confirm("Don't send this email? It's deleted.")) return;
          await api("scheduled/cancel", { method: "POST", body: { id: x.id } }); done("It won't be sent.");
        }) }, icon("trash"), "Delete"))));
}
function loadScheduledRowsOn() {
  [...$list.querySelectorAll(".msg")].forEach((row, i) => row.classList.toggle("on", scheduledList[i] && state.selected === `s${scheduledList[i].id}`));
}

/** Open what a compose window sent (taken back from Undo send or send later) in a compose window again, as it was. */
function openPayload(payload) {
  const { attachments = [], ...rest } = payload || {};
  compose({ local: { key: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, user: state.user.id, updated: Date.now(), dirty: true, payload: rest,
    attachments: attachments.map((a) => ({ ...a, size: a.size ?? Math.floor((a.content || "").length * 3 / 4) })) } });
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
    !["sent", "drafts", "trash", "spam"].includes(m.folder) && h("button", { class: "icon-btn", title: "Snooze (b)", "aria-label": "Snooze", onclick: (e) => snoozeMenu(e.currentTarget) }, icon("clock")),
    m.folder !== "drafts" && h("button", { class: "icon-btn", title: "Labels (l)", "aria-label": "Labels", onclick: (e) => labelMenu(e.currentTarget, m) }, icon("label")),
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
    m.folder !== "drafts" && h("button", { class: `icon-btn customer-toggle${customerPanelOpen() ? " on-soft" : ""}`, title: "Customer: their history and details (i)", "aria-label": "Customer details",
      "aria-pressed": String(customerPanelOpen()), onclick: (e) => { toggleCustomerPanel(); e.currentTarget.classList.toggle("on-soft", customerPanelOpen()); e.currentTarget.setAttribute("aria-pressed", String(customerPanelOpen())); } }, icon("contacts")),
    h("button", { class: "icon-btn", title: "Reply (r)", "aria-label": "Reply", onclick: () => compose({ mode: "reply", of: last() }) }, icon("reply")),
    h("button", { class: "icon-btn", title: "Reply all", "aria-label": "Reply all", onclick: () => compose({ mode: "replyAll", of: last() }) }, icon("replyAll")),
    h("button", { class: "icon-btn", title: "Forward (f)", "aria-label": "Forward", onclick: () => compose({ mode: "forward", of: last() }) }, icon("forward")));
  const mails = current.thread.map((t, i) => mailCard(t, i === current.thread.length - 1 || t.id === m.id));
  const shared = state.mailboxes.find((x) => x.id === m.mailbox_id)?.members > 1;
  const teamTop = h("div", { class: "team-top" });
  const teamNotes = h("section", { class: "team-notes", "aria-label": "Team notes" });
  // Snooze: the conversation's email in this folder goes until then, and comes back to the top of the Inbox.
  const snoozeMenu = (anchor) => pickTime(anchor, "snooze", async (d) => {
    const ids = current.thread.filter((t) => t.folder === m.folder).map((t) => t.id);
    try { await api("messages/snooze", { method: "POST", body: { ids, until: d.toISOString() } }); } catch (err) { toast(err.message); return; }
    toast(`Snoozed until ${whenShort(d.toISOString())}`, { label: "Undo", run: async () => { await api("messages/snooze", { method: "POST", body: { ids, until: null } }); refresh(); } });
    closeReader(); refresh();
  });
  const labelChips = (m.labels || []).length ? h("div", { class: "label-chips" }, m.labels.map((l) => h("span", { class: "label-pill big" }, icon("label"), l.name,
    h("button", { type: "button", title: `Remove ${l.name}`, "aria-label": `Remove the label ${l.name}`, onclick: async () => {
      try { await api("labels/apply", { method: "POST", body: { ids: [m.id], remove: [l.id] } }); } catch (err) { toast(err.message); return; }
      refreshCounts(); openMessage(m.id); refresh();
    } }, "✕")))) : null;
  const snoozedNote = m.snoozed_until ? h("div", { class: "notice warn row between" }, h("span", {}, icon("clock"), ` Snoozed until ${longDate(m.snoozed_until)}`),
    h("button", { class: "btn btn-sm", onclick: async () => { await api("messages/snooze", { method: "POST", body: { ids: [m.id], until: null } }); toast("Back in its folder."); openMessage(m.id); refresh(); } }, "Unsnooze")) : null;
  const panel = m.folder !== "drafts" ? h("aside", { class: "customer-panel", "aria-label": "Customer" }, h("p", { class: "muted small" }, "Loading…")) : null;
  $reader.replaceChildren(bar, h("div", { class: `reader-split${panel && customerPanelOpen() ? " with-customer" : ""}` }, h("div", { class: "reader-body" }, h("h1", {}, m.subject || "(no subject)"), labelChips, snoozedNote, shared && teamTop, mails,
    h("div", { class: "reply-row" },
      h("button", { class: "btn", onclick: () => compose({ mode: "reply", of: last() }) }, icon("reply"), "Reply"),
      h("button", { class: "btn", onclick: () => compose({ mode: "replyAll", of: last() }) }, icon("replyAll"), "Reply all"),
      h("button", { class: "btn", onclick: () => compose({ mode: "forward", of: last() }) }, icon("forward"), "Forward"),
      shared && h("button", { class: "btn", title: "A reply the team writes together, live", onclick: () => compose({ mode: "reply", of: last(), share: true }) }, icon("people"), "Write together")),
    shared && teamNotes), panel));
  if (shared) teamPanel(m, teamTop, teamNotes);
  if (panel) customerPanel(m, panel);
}

// ------------------------------------------------------------------------------------------------ the customer panel
// Beside an email: who it's with, every conversation with them, and the fields GhostParse's parsers found in their email.

function customerPanelOpen() {
  // Open by default on wide screens; a drawer to open when wanted on smaller ones. The choice is remembered.
  try { const v = localStorage.getItem("wm.customer"); if (v !== null) return v === "1"; } catch { /* private browsing */ }
  return matchMedia("(min-width: 1400px)").matches;
}
function toggleCustomerPanel(force) {
  const on = force ?? !customerPanelOpen();
  try { localStorage.setItem("wm.customer", on ? "1" : "0"); } catch { /* fine */ }
  $reader.querySelector(".reader-split")?.classList.toggle("with-customer", on);
}

async function customerPanel(m, panel) {
  let r;
  try { r = await api("customer", { query: { id: String(m.id) } }); } catch (err) { panel.replaceChildren(h("p", { class: "muted small" }, err.message)); return; }
  if (current?.message?.id !== m.id) return; // another email is open now
  const c = r.customer;
  const close = h("button", { class: "icon-btn small-btn panel-close", "aria-label": "Close", onclick: () => toggleCustomerPanel(false) }, icon("close"));
  if (!c) { panel.replaceChildren(close, h("p", { class: "muted small" }, "Only your own addresses are on this email.")); return; }
  const day = (iso) => iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "—";
  const status = { open: "Open", in_progress: "In progress", resolved: "Resolved" };
  const multi = new Set(c.conversations.map((t) => t.mailbox)).size > 1;
  const stat = (n, label) => h("div", { class: "stat" }, h("strong", {}, String(n)), h("span", {}, label));
  const contact = c.contact;
  panel.replaceChildren(close,
    h("div", { class: "cust-head" }, avatar({ name: c.name, address: c.address }),
      h("div", { class: "grow" }, h("div", { class: "cust-name" }, c.name || c.address), h("a", { class: "muted small", href: `mailto:${c.address}`, onclick: (e) => { e.preventDefault(); compose({ to: c.address }); } }, c.address))),
    contact ? h("div", { class: "cust-contact" },
      contact.company && h("div", {}, icon("people"), contact.company), contact.phone && h("div", {}, icon("phone"), h("a", { href: `tel:${contact.phone.replace(/[^\d+]/g, "")}` }, contact.phone)),
      contact.notes && h("div", { class: "cust-notes" }, contact.notes), h("div", { class: "muted small" }, contact.book === "shared" ? "From the shared address book" : "From your contacts"))
      : h("button", { class: "linkish add-contact", onclick: async (e) => {
        try { await api("book/save", { method: "POST", body: { book: "personal", email: c.address, name: c.name } }); e.currentTarget.replaceWith(h("span", { class: "muted small" }, "Added to your contacts.")); }
        catch (err) { toast(err.message); }
      } }, icon("personAdd"), "Add to contacts"),
    h("div", { class: "cust-stats" }, stat(c.stats.conversations + (c.stats.more ? "+" : ""), c.stats.conversations === 1 ? "conversation" : "conversations"),
      c.stats.open + c.stats.resolved > 0 ? stat(c.stats.open, "open") : stat(c.stats.messages, c.stats.messages === 1 ? "email" : "emails"),
      h("div", { class: "stat", title: day(c.stats.first_at) }, h("strong", {}, c.stats.first_at ? new Date(c.stats.first_at).toLocaleDateString([], { month: "short", year: "numeric" }) : "—"), h("span", {}, "first contact"))),
    c.fields.length > 0 && h("section", { class: "cust-section" }, h("h4", {}, "From their email"),
      h("dl", { class: "cust-fields" }, c.fields.map((f) => [h("dt", { title: `${f.parser ? `${f.parser} parser, ` : ""}${day(f.at)}` }, f.label),
        h("dd", { class: f.this_conversation ? "here" : "" }, f.value, !f.this_conversation && h("button", { class: "when", title: "Open the email it came from", onclick: () => openMessage(f.message_id) }, day(f.at)))])),
      h("p", { class: "muted tiny" }, "Found by GhostParse's parsers. The newest value of each; ones from other conversations show when.")),
    h("section", { class: "cust-section" }, h("h4", {}, "Conversations"),
      h("ul", { class: "cust-threads" }, c.conversations.map((t) => h("li", { class: t.current ? "current" : "" },
        h("button", { onclick: () => { if (!t.current) openMessage(t.message_id); } },
          h("span", { class: `subj${t.unread ? " unread" : ""}` }, t.subject || "(no subject)"),
          h("span", { class: "meta" }, day(t.last_at), t.messages > 1 ? ` · ${t.messages} emails` : "", multi ? ` · ${t.mailbox}` : "", t.current ? " · this one" : ""),
          (t.status || t.assignee) && h("span", { class: "chips" }, t.status && h("span", { class: `status-chip ${t.status}` }, status[t.status]), t.assignee && h("span", { class: "muted tiny" }, t.assignee)))))),
      c.stats.conversations > c.conversations.length && h("p", { class: "muted tiny" }, `The latest ${c.conversations.length}. Search for ${c.address} to see them all.`)));
}

/**
 * Labels for an email: tick them on or off, move it to one (labelled, and out of the Inbox), or make a new one. Labels
 * belong to a mailbox, so only the email's own mailbox's are offered.
 */
function labelMenu(anchor, m) {
  const box = state.mailboxes.find((x) => x.id === m.mailbox_id);
  const labels = box?.labels || [];
  const has = new Set((m.labels || []).map((l) => l.id));
  const apply = async (body, message) => {
    try { await api("labels/apply", { method: "POST", body: { ids: [m.id], ...body } }); } catch (err) { toast(err.message); return; }
    await refreshCounts();
    if (message) toast(message);
    if (body.move) { closeReader(); refresh(); } else { openMessage(m.id); refresh(); }
  };
  const name = h("input", { class: "input", placeholder: "New label", maxlength: 50, "aria-label": "New label name" });
  const make = h("form", { class: "pop-custom", onsubmit: async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    try {
      const l = await api("labels/save", { method: "POST", body: { mailbox_id: m.mailbox_id, name: name.value } });
      menu.close();
      await apply({ add: [l.id] }, `Labelled ${l.name}.`);
    } catch (err) { toast(err.message); }
  } }, name, h("button", { class: "btn btn-sm" }, "Add"));
  const menu = popMenu(anchor, [
    h("div", { class: "pop-title" }, "Label as"),
    ...labels.map((l) => h("label", { class: "pop-check" }, h("input", { type: "checkbox", checked: has.has(l.id), onchange: (e) => { menu.close(); apply(e.target.checked ? { add: [l.id] } : { remove: [l.id] }); } }), l.name)),
    labels.length ? null : h("p", { class: "muted small pop-pad" }, "No labels yet."),
    make,
    ...(labels.length && m.folder === "inbox" ? [null, h("div", { class: "pop-title" }, "Move to"),
      ...labels.map((l) => h("button", { type: "button", role: "menuitem", onclick: () => { menu.close(); apply({ add: [l.id], move: true }, `Moved to ${l.name}.`); } }, icon("label"), h("span", {}, l.name)))] : []),
    null, h("button", { type: "button", role: "menuitem", onclick: () => { menu.close(); openSettings("rules"); } }, icon("filter"), h("span", {}, "Rules & labels…")),
  ], { className: "label-menu" });
}

// ------------------------------------------------------------------------------------------------ shared mailboxes
// Who a conversation is assigned to and where it's up to, the team's private notes, and the reply someone's writing
// with the team. Checked every 15 seconds while the conversation is open.
let teamTimer = null;
async function teamPanel(m, top, notesBox) {
  clearTimeout(teamTimer);
  const id = m.id;
  let data = null;
  const still = () => current?.message.id === id && top.isConnected;
  const load = async () => {
    try { data = await api("team/thread", { query: { id: String(id) } }); } catch { return; }
    if (!still()) return;
    render();
  };
  const assign = async (body) => {
    try { data = await api("team/assign", { method: "POST", body: { message_id: id, ...body } }); render(); loadList(); }
    catch (err) { toast(err.message); }
  };
  const render = () => {
    const keepNote = notesBox.querySelector("textarea")?.value || "";
    const focused = document.activeElement?.closest?.(".team-notes textarea") != null;
    top.replaceChildren(...[
      h("label", { class: "team-field" }, icon("assign"), h("span", { class: "sr" }, "Assigned to"),
        h("select", { "aria-label": "Assigned to", onchange: (e) => assign({ assignee_id: e.target.value ? Number(e.target.value) : null }) },
          h("option", { value: "" }, "Unassigned"),
          data.members.map((p) => h("option", { value: String(p.id), selected: p.id === data.assignee_id }, p.id === state.user.id ? `${p.name} (you)` : p.name)))),
      h("div", { class: "status-seg", role: "group", "aria-label": "Status" }, Object.entries(data.statuses).map(([k, label]) =>
        h("button", { type: "button", class: `${k}${data.status === k ? " on" : ""}`, "aria-pressed": String(data.status === k), onclick: () => data.status !== k && assign({ status: k }) }, label))),
      data.assignee_id !== state.user.id && h("button", { class: "btn btn-sm", onclick: () => assign({ assignee_id: state.user.id, ...(data.status === "open" ? { status: "in_progress" } : {}) }) }, "Take it"),
      data.draft && h("div", { class: "team-draft" }, icon("people"),
        data.draft.editors.length ? `${data.draft.editors.map((e) => e.name).join(" and ")} ${data.draft.editors.length > 1 ? "are" : "is"} writing a reply` : `${data.draft.started_by} started a shared reply`,
        h("button", { class: "btn btn-sm btn-primary", onclick: () => compose({ mode: "reply", of: last(), share: true }) }, "Join"))].filter(Boolean));
    const box = h("textarea", { rows: 2, placeholder: "Add a note for the team… type @ to mention someone", maxlength: 5000,
      onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } } });
    box.value = keepNote;
    const post = async () => {
      const body = box.value.trim();
      if (!body) return;
      box.disabled = true;
      try { await api("team/note", { method: "POST", body: { message_id: id, body } }); box.value = ""; await load(); notesBox.querySelector("textarea")?.focus(); }
      catch (err) { toast(err.message); box.disabled = false; }
    };
    notesBox.replaceChildren(
      h("h3", {}, icon("note"), "Team notes", h("span", { class: "muted small" }, ` Only people who share ${state.mailboxes.find((x) => x.id === m.mailbox_id)?.address || "this mailbox"} see these. They're never sent.`)),
      data.notes.length ? h("ol", { class: "notes" }, data.notes.map((n) => noteItem(n, load))) : h("p", { class: "muted small" }, "No notes yet."),
      h("div", { class: "note-write" }, box, h("button", { class: "btn btn-primary btn-sm", onclick: post }, "Add note")));
    mentionPicker(box, data.members.filter((p) => p.id !== state.user.id));
    if (focused) box.focus();
  };
  await load();
  const tick = async () => { if (!still()) return; if (document.visibilityState === "visible") await load(); teamTimer = setTimeout(tick, 15000); };
  teamTimer = setTimeout(tick, 15000);
}

function noteItem(n, reload) {
  const when = h("time", { datetime: n.date, title: longDate(n.date) }, shortDate(n.date));
  if (n.kind === "event") return h("li", { class: "event" }, h("strong", {}, n.name || "Webmail"), ` ${n.body} · `, when);
  // Mentions stand out; the text is only ever text.
  const body = h("div", { class: "note-body" }, ...n.body.split(/(@[\p{L}\p{N}][\p{L}\p{N}._-]*)/u).map((part, i) => (i % 2 ? h("span", { class: "mention" }, part) : part)));
  return h("li", { class: `note${n.mentions.includes(state.user.id) ? " to-me" : ""}` },
    h("div", { class: "note-head" }, avatar({ name: n.name, address: n.name }), h("strong", {}, n.mine ? "You" : n.name), when,
      (n.mine || state.user.role === "admin") && h("button", { class: "icon-btn", title: "Delete note", "aria-label": "Delete note", onclick: async () => {
        if (!confirm("Delete this note?")) return;
        try { await api("team/note/delete", { method: "POST", body: { id: n.id } }); reload(); } catch (err) { toast(err.message); }
      } }, icon("trash"))),
    body);
}

/** Typing "@" in a note offers the people on the mailbox; picking one writes their first name. */
function mentionPicker(box, people) {
  const list = h("ul", { class: "mentions", role: "listbox", hidden: true });
  box.after(list);
  let matches = [], at = -1, pick = 0;
  const handle = (p) => (p.name.split(/\s+/)[0] || p.email.split("@")[0]);
  const close = () => { list.hidden = true; at = -1; };
  const choose = (p) => {
    const before = box.value.slice(0, at), after = box.value.slice(box.selectionStart);
    box.value = `${before}@${handle(p)} ${after}`;
    const pos = before.length + handle(p).length + 2;
    box.setSelectionRange(pos, pos); close(); box.focus();
  };
  const show = () => {
    list.replaceChildren(...matches.map((p, i) => h("li", { role: "option", class: i === pick ? "on" : "", onmousedown: (e) => { e.preventDefault(); choose(p); } },
      avatar({ name: p.name, address: p.email }), h("span", {}, p.name), h("small", { class: "muted" }, p.email))));
    list.hidden = !matches.length;
  };
  box.addEventListener("input", () => {
    const upto = box.value.slice(0, box.selectionStart);
    const mm = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u.exec(upto);
    if (!mm) return close();
    at = upto.length - mm[1].length - 1;
    const q = mm[1].toLowerCase();
    matches = people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.email.toLowerCase().startsWith(q)).slice(0, 6);
    pick = 0; show();
  });
  box.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length; show(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); choose(matches[pick]); }
    else if (e.key === "Escape") close();
  });
  box.addEventListener("blur", () => setTimeout(close, 150));
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
  // A calendar invitation (or any .ics file): what it is, with Add to calendar.
  const invite = t.attachments.find((a) => a.id && !a.url && (/^(text|application)\/(calendar|ics)/i.test(a.content_type || "") || /\.ics$/i.test(a.filename || "")));
  const inviteSlot = invite && window.Calendar ? h("div", { class: "invite-slot" }) : null;
  if (inviteSlot) window.Calendar.invitationCard(invite).then((card) => inviteSlot.replaceChildren(card));
  content.append(...[inviteSlot, bar, frame, t.attachments.length > 0 && h("div", { class: "atts" }, t.attachments.map((a) =>
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
  clearTimeout(teamTimer);
  state.selected = null;
  current = null;
  $shell.classList.remove("reading");
  $reader.replaceChildren(placeholder());
  renderList();
}

async function refreshCounts() {
  try { const s = await api("session"); state.mailboxes = s.mailboxes; state.scheduledCount = s.scheduled || 0; renderFolders(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------------------------------------ checks before sending

/**
 * Words that say a file comes with the email ("see attached", "I've included…"): the first one found in what you wrote
 * (not the quoted email you're replying to), or null.
 */
const ATTACH_PHRASES = [
  /\b(?:please\s+)?(?:see|find|view|check)\s+(?:the\s+)?(?:attached|enclosed|attachments?)\b/i,
  /\battached\s+(?:is|are|you(?:'|’)ll\s+find|you\s+will\s+find|please\s+find|herewith|here|to\s+this\s+(?:email|message)|(?:the\s+|a\s+|my\s+|our\s+)?(?:file|files|document|documents|doc|docs|pdf|copy|invoice|quote|contract|report|form|photo|photos|picture|pictures|image|images|spreadsheet|cv|resume|résumé|statement|receipt|proposal|agreement|letter|brochure|slides|presentation))\b/i,
  /\b(?:i|we)(?:(?:'|’)ve|\s+have)\s+(?:also\s+|now\s+|just\s+)?(?:attached|enclosed|included)\b/i,
  /\b(?:i|we)(?:(?:'|’)m|\s+am|\s+are|(?:'|’)re)\s+(?:also\s+)?(?:attaching|enclosing|including)\b/i,
  /\b(?:i|we)\s+(?:attach|enclose)\b/i,
  /\b(?:attached|enclosed)\s*(?::|please|for\s+your|is\s+the)/i,
  /\bin\s+the\s+(?:attached|attachment|enclosed)\b/i,
  /\b(?:included|enclosed)\s+(?:is|are)\s+(?:the|a|my|our)\b/i,
  /\bhere(?:'|’)?s\s+the\s+(?:file|document|attachment|pdf|invoice|spreadsheet)\b/i,
  /\battachment\s*:/i,
];
function attachmentMention(text) {
  // Lines quoted the plain-text way ("> …") and anything after "On … wrote:" belong to the email being answered.
  const own = String(text || "").split(/\n[^\n]*\bwrote:\s*\n|\n-{5,}\s*Forwarded message/i)[0]
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  for (const re of ATTACH_PHRASES) {
    const m = own.match(re);
    if (m) return m[0].trim().replace(/\s*[:]$/, "");
  }
  return null;
}

/** Addresses in a To, Cc or Bcc box ("Jane <jane@x.com>, bob@y.com"), lower case. */
const addressesIn = (v) => [...String(v || "").matchAll(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g)].map((m) => m[0].toLowerCase());
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "zoho.com", "yandex.com", "btinternet.com",
  "sky.com", "virginmedia.com", "talktalk.net", "fastmail.com", "hey.com", "qq.com", "163.com"]);
/**
 * People in Cc who probably don't know each other, and would see each other's addresses: two or more outside your own
 * domain, from different companies (or personal addresses, like Gmail). Not colleagues on your domain, and not people
 * already on the conversation you're replying to (they've seen each other). Returns them, or [] when it looks fine.
 */
function ccShouldBeBcc(cc, fromAddress, already = []) {
  const ownDomain = String(fromAddress || "").toLowerCase().split("@")[1] || "";
  const seen = new Set(already.map((a) => String(a).toLowerCase()));
  const outside = [...new Set(addressesIn(cc))].filter((a) => a.split("@")[1] !== ownDomain);
  if (outside.length < 2 || outside.every((a) => seen.has(a))) return [];
  const domains = new Set(outside.map((a) => a.split("@")[1]));
  const strangers = domains.size > 1 || outside.some((a) => FREEMAIL.has(a.split("@")[1]));
  return strangers ? outside : [];
}

/** A question before sending, with buttons: resolves to the chosen one's value (null: closed). */
function askBeforeSend({ title, text, buttons }) {
  return new Promise((resolve) => {
    const done = (v) => { overlay.remove(); resolve(v); };
    const overlay = h("div", { class: "overlay center send-check", onclick: (e) => { if (e.target === overlay) done(null); }, onkeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } } },
      h("div", { class: "dialog small-dialog", role: "alertdialog", "aria-label": title },
        h("div", { class: "dialog-head" }, h("h2", {}, title)),
        h("div", { class: "pad" }, ...[].concat(text).map((t) => (t instanceof Node ? t : h("p", {}, t)))),
        h("div", { class: "dialog-foot" }, h("span", { class: "grow" }),
          ...buttons.map((b) => h("button", { type: "button", class: `btn${b.primary ? " btn-primary" : ""}`, onclick: () => done(b.value) }, b.icon ? icon(b.icon) : null, b.label)))));
    document.body.append(overlay);
    overlay.querySelector(".btn-primary")?.focus();
  });
}

// ------------------------------------------------------------------------------------------------ compose
let contacts = null;
async function compose(opts = {}) {
  document.querySelector(".overlay.compose-overlay")?.remove();
  if (!state.mailboxes.length) { toast("You don't have a mailbox to send from."); return; }
  contacts ??= api("contacts").then((r) => r.contacts).catch(() => []);
  const of = opts.of;
  const draft = opts.draft;
  // A reply written with the team (shared mailboxes): the conversation's one shared reply, started or joined below.
  let shared = null;
  // The copy of this draft on the device: one being recovered, or a server draft's (newer, if it wasn't saved yet).
  let local = opts.local || null;
  if (!local && draft && window.LocalDrafts) {
    local = (await LocalDrafts.all().catch(() => [])).find((r) => r.draft_id === draft.id && r.user === state.user.id) || null;
  }
  const lp = local?.payload;
  const mine = new Set(state.mailboxes.map((m) => m.address.toLowerCase()));
  let fromId = lp?.mailbox_id || draft?.mailbox_id || of?.mailbox_id || state.mailbox || state.mailboxes[0].id;
  if (!state.mailboxes.some((m) => m.id === fromId)) fromId = state.mailboxes[0].id;
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
  if (lp) { to = lp.to ? [lp.to] : []; cc = lp.cc ? [lp.cc] : []; subject = lp.subject || ""; }

  const fromSel = h("select", { "aria-label": "From", onchange: (e) => { fromId = Number(e.target.value); swapSignature(); } },
    state.mailboxes.map((m) => h("option", { value: String(m.id), selected: m.id === fromId }, m.display_name ? `${m.display_name} <${m.address}>` : m.address)));
  const toIn = h("input", { type: "text", value: to.join(", "), "aria-label": "To", autocomplete: "off" });
  const ccIn = h("input", { type: "text", value: cc.join(", "), "aria-label": "Cc", autocomplete: "off" });
  const bccIn = h("input", { type: "text", value: lp?.bcc || "", "aria-label": "Bcc", autocomplete: "off" });
  const ccRow = h("div", { class: "cf", hidden: !cc.length }, h("label", {}, "Cc"), ccIn);
  const bccRow = h("div", { class: "cf", hidden: !lp?.bcc }, h("label", {}, "Bcc"), bccIn);
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
  if (lp) {
    // Typed by this person on this device: put back as it was (the page's security policy stops any script in it).
    editor.innerHTML = lp.html || "";
    sigOn.checked = lp.signature !== false;
  } else if (draft) {
    const full = await api("message", { query: { id: String(draft.id), peek: "1" } }).catch(() => null);
    editor.append(...(full?.message.text || "").split("\n").flatMap((l) => [l, h("br")]));
    // Drafts from before 1.5.0 have the signature in their text already.
    if (/\n-- \n/.test(full?.message.text || "")) sigOn.checked = false;
  } else {
    // opts.text: a reply typed in a notification that couldn't be sent from there.
    editor.append(...(opts.text ? opts.text.split("\n").map((l) => h("div", {}, l || h("br"))) : [h("div", {}, h("br"))]));
    if (quoted) editor.append(h("br"), quoted);
  }
  swapSignature();
  if (opts.share && of) {
    // Start the conversation's shared reply with what's here, or join the one someone's already writing.
    try {
      shared = await api("team/draft/start", { method: "POST", body: { message_id: of.id, fields: { to: toIn.value, cc: ccIn.value, bcc: bccIn.value, subject: subjIn.value, html: editor.innerHTML, text: editor.innerText, signature: sigOn.checked } } });
    } catch (err) { toast(err.message); return; }
    fromId = shared.mailbox_id;
    fromSel.value = String(fromId);
    fromSel.disabled = true;
    swapSignature();
    toIn.value = shared.fields.to; ccIn.value = shared.fields.cc; bccIn.value = shared.fields.bcc; subjIn.value = shared.fields.subject;
    ccRow.hidden = !shared.fields.cc; bccRow.hidden = !shared.fields.bcc;
    sigOn.checked = shared.fields.signature !== false;
    editor.innerHTML = shared.fields.html;
  }
  const files = [...(local?.attachments || [])];
  const attList = h("div", { class: "compose-atts" });
  const renderAtts = () => attList.replaceChildren(...files.map((f, i) => h("span", { class: "att" }, icon("clip"), h("span", {}, f.filename), h("small", { class: "muted" }, size(f.size)),
    h("button", { type: "button", "aria-label": `Remove ${f.filename}`, onclick: () => { files.splice(i, 1); renderAtts(); changed(); } }, "✕"))));
  const fileIn = h("input", { type: "file", multiple: true, hidden: true, onchange: async () => {
    for (const f of fileIn.files) {
      if (files.reduce((n, x) => n + x.size, 0) + f.size > 20 * 1024 * 1024) { toast("Attachments can add up to 20 MB."); break; }
      const content = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.readAsDataURL(f); });
      files.push({ filename: f.name, content_type: f.type || "application/octet-stream", size: f.size, content });
    }
    fileIn.value = "";
    renderAtts();
    changed();
  } });
  const cmd = (name, value) => () => { editor.focus(); document.execCommand(name, false, value); };
  const status = h("span", { class: "muted small", role: "status" });
  let draftId = local?.draft_id || draft?.id || null;
  const payload = () => {
    const clone = editor.cloneNode(true);
    return { mailbox_id: fromId, to: toIn.value, cc: ccIn.value, bcc: bccIn.value, subject: subjIn.value, html: clone.innerHTML, text: editor.innerText,
      reply_to_id: shared ? shared.reply_to_id : of && opts.mode !== "forward" ? of.id : lp?.reply_to_id, forward_of: of && opts.mode === "forward" ? of.id : lp?.forward_of, attachments: files,
      draft_id: shared ? undefined : draftId || undefined, shared_draft_id: shared?.id, signature: sigOn.checked };
  };
  /**
   * Send it now. Returns whether it went (if not, the compose window is as it was, with the reason shown). $frozen: the
   * email as it was when Send was pressed (Undo send hides the window, and a hidden editor's text loses its line breaks).
   */
  const reallySend = async (frozen = null) => {
    sendBtn.disabled = true;
    status.textContent = "Sending…";
    try {
      // Any save that's under way finishes first, and nothing saves it again while it sends: the draft it made is the
      // one the server deletes once it's sent.
      await settle(false);
      if (shared) await team.flush();
      const r = await api("send", { method: "POST", body: frozen ? { ...frozen, draft_id: shared ? undefined : draftId || undefined } : payload() });
      team.stop();
      finished = gone = true;
      if (flushCompose === flushThis) flushCompose = null;
      window.LocalDrafts?.remove(key).catch(() => {});
      overlay.remove();
      toast(r.suppressed?.length ? `Sent. Not sent to ${r.suppressed.join(", ")}: they bounced or complained before.` : "Sent.");
      refresh();
      if (current) openMessage(current.message.id);
      return true;
    } catch (err) {
      status.textContent = "";
      toast(err.message);
      sendBtn.disabled = false;
      edited = true;
      saveLocal(); // still unsent: kept on the device, and saved again
      return false;
    }
  };
  /**
   * Before it goes: placeholders a template left that nothing filled in ({company} with no company known), a file
   * mentioned but not attached, and people in Cc who'd see each other's addresses. Each is asked about.
   */
  const okToSend = async () => {
    const left = [...new Set([...`${subjIn.value}\n${editor.innerText}`.matchAll(PLACEHOLDER_RE)].map((x) => x[0]))];
    if (left.length && !confirm(`This email still has ${left.join(", ")} in it. Send it anyway?`)) return false;
    // What you wrote: not the email you're replying to or forwarding (quoted below it).
    const mine = editor.cloneNode(true);
    mine.querySelectorAll("blockquote").forEach((q) => q.remove());
    const forwarding = of && opts.mode === "forward" && of.attachments?.length > 0;
    const mention = state.prefs?.attach_check !== false && !files.length && !forwarding && attachmentMention(`${subjIn.value}\n${mine.innerText}`);
    if (mention) {
      const go = await askBeforeSend({ title: "Did you mean to attach something?", buttons: [
        { label: "Send without", value: "send" }, { label: "Attach a file", value: "attach", icon: "clip", primary: true }],
      text: [`You wrote “${mention}”, but nothing is attached.`] });
      if (go === "attach") fileIn.click();
      if (go !== "send") return false;
    }
    const from = state.mailboxes.find((x) => x.id === fromId)?.address;
    const already = of ? [of.from?.address, ...(of.to || []).map((a) => a.address), ...(of.cc || []).map((a) => a.address)].filter(Boolean) : [];
    const exposed = state.prefs?.cc_check !== false ? ccShouldBeBcc(ccIn.value, from, already) : [];
    if (exposed.length) {
      const go = await askBeforeSend({ title: "Should these be Bcc?", buttons: [
        { label: "Send as it is", value: "send" }, { label: "Move to Bcc", value: "bcc", primary: true }],
      text: [`Everyone in Cc sees everyone else's address: ${exposed.slice(0, 4).join(", ")}${exposed.length > 4 ? ` and ${exposed.length - 4} more` : ""}.`,
        "If they don't know each other (customers, say), put them in Bcc: each sees only their own address and yours."] });
      if (go === null) return false;
      if (go === "bcc") {
        bccIn.value = [bccIn.value.trim(), ccIn.value.trim()].filter(Boolean).join(", ");
        ccIn.value = "";
        bccRow.hidden = false; ccRow.hidden = true;
        // Nobody left in To: it goes to your own address, with everyone else in Bcc.
        if (!addressesIn(toIn.value).length && from) toIn.value = from;
        changed();
        toast("Moved to Bcc.");
      }
    }
    return true;
  };
  // Undo send: the window goes, and the email waits a few seconds (Settings → Account) before it's sent, with Undo.
  // It's kept on this device meanwhile, so closing the page then leaves it in Drafts, unsent (the browser asks first).
  const holdForUndo = (seconds) => {
    pendingSend?.now();
    const frozen = payload();
    overlay.hidden = true;
    overlay.classList.remove("compose-overlay"); // a new compose window doesn't close this one meanwhile
    let left = seconds;
    const count = h("span", { class: "undo-count" }, `Sending in ${left}s…`);
    const restore = () => { overlay.hidden = false; overlay.classList.add("compose-overlay"); sendBtn.disabled = false; };
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    const finish = () => { clearInterval(tick); clearTimeout(timer); el.remove(); removeEventListener("beforeunload", warn); if (pendingSend === mine) pendingSend = null; };
    const undo = () => { finish(); restore(); status.textContent = "Not sent: change it and send it again when you're ready."; editor.focus(); };
    const now = async () => { finish(); if (!(await reallySend(frozen))) restore(); };
    const mine = { now };
    const el = h("div", { class: "undo-toast", role: "status" }, count,
      h("button", { type: "button", onclick: undo }, "Undo"), h("button", { type: "button", class: "quiet", onclick: now }, "Send now"));
    const tick = setInterval(() => { left -= 1; count.textContent = `Sending in ${Math.max(0, left)}s…`; }, 1000);
    const timer = setTimeout(now, seconds * 1000);
    addEventListener("beforeunload", warn);
    pendingSend = mine;
    document.body.append(el);
    el.querySelector("button").focus();
  };
  const sendBtn = h("button", { class: "btn btn-primary", onclick: async () => {
    if (!(await okToSend())) return;
    const delay = shared ? 0 : Number(state.prefs?.undo_send ?? 10);
    if (!delay) { reallySend(); return; }
    sendBtn.disabled = true;
    clearTimeout(localTimer); clearTimeout(serverTimer);
    await saveLocal();
    holdForUndo(delay);
  } }, "Send");
  // Send later: kept on the server until then, and listed under Scheduled.
  const scheduleAt = async (d) => {
    if (!(await okToSend())) return;
    sendBtn.disabled = true;
    status.textContent = "Scheduling…";
    try {
      await settle(false);
      const r = await api("scheduled", { method: "POST", body: { ...payload(), send_at: d.toISOString() } });
      finished = gone = true;
      if (flushCompose === flushThis) flushCompose = null;
      window.LocalDrafts?.remove(key).catch(() => {});
      overlay.remove();
      state.scheduledCount += 1;
      renderFolders();
      toast(`Scheduled for ${whenShort(r.send_at)}.`, { label: "Undo", run: async () => {
        try {
          const back = await api("scheduled/cancel", { method: "POST", body: { id: r.id } });
          state.scheduledCount = Math.max(0, state.scheduledCount - 1);
          renderFolders();
          openPayload(back.payload);
        } catch (err) { toast(err.message); }
      } });
      refresh();
    } catch (err) {
      status.textContent = "";
      toast(err.message);
      sendBtn.disabled = false;
      edited = true;
      saveLocal();
    }
  };
  const laterBtn = shared ? null : h("button", { class: "icon-btn", type: "button", title: "Send later", "aria-label": "Send later", onclick: () => pickTime(laterBtn, "send", scheduleAt) }, icon("sendLater"));

  // Templates: the Templates button, Ctrl+/ (⌘/ on a Mac) while writing, or typing / and the template's shortcut or name.
  let lastRange = null;
  const keepRange = () => { const sel = getSelection(); if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) lastRange = sel.getRangeAt(0).cloneRange(); };
  ["keyup", "mouseup", "input", "focus"].forEach((ev) => editor.addEventListener(ev, keepRange));
  const insertTemplate = async (t, range) => {
    const values = await placeholderValues({ to: toIn.value, subject: subjIn.value, mailbox: state.mailboxes.find((x) => x.id === fromId), of });
    if (t.subject && !subjIn.value.trim()) subjIn.value = fillText(t.subject, values);
    editor.focus();
    insertAt(editor, range, templateNodes(t.html, values));
    const left = [...new Set([...`${subjIn.value}\n${editor.innerText}`.matchAll(PLACEHOLDER_RE)].map((x) => x[0]))];
    if (left.length) toast(`Fill in ${left.join(", ")}: nothing was found for ${left.length === 1 ? "it" : "them"}.`);
  };
  const tplBtn = h("button", { class: "icon-btn", type: "button", title: "Templates (type / or press Ctrl+/)", "aria-label": "Templates", onclick: () => templatePicker(tplBtn, lastRange, insertTemplate) }, icon("template"));
  let slash = null, slashTurn = 0;
  const closeSlash = () => { slash?.box.remove(); slash = null; };
  const slashCheck = async () => {
    const turn = ++slashTurn;
    const sel = getSelection();
    const r = sel.rangeCount && sel.isCollapsed ? sel.getRangeAt(0) : null;
    const node = r?.startContainer;
    const m = node?.nodeType === 3 && editor.contains(node) ? /(?:^|\s)\/([\p{L}\p{N}_-]{0,32})$/u.exec(node.textContent.slice(0, r.startOffset)) : null;
    if (!m) { closeSlash(); return; }
    const term = m[1].toLowerCase();
    const list = await loadTemplates().catch(() => []);
    if (turn !== slashTurn) return;
    closeSlash();
    const items = list.filter((t) => !term || t.shortcut.startsWith(term) || t.name.toLowerCase().includes(term)).slice(0, 8);
    if (!items.length) return;
    const rect = r.getBoundingClientRect();
    const box = h("div", { class: "suggest slash-menu", role: "listbox", style: `left:${Math.min(rect.left || editor.getBoundingClientRect().left, innerWidth - 300)}px;top:${(rect.bottom || editor.getBoundingClientRect().top + 24) + 4}px` },
      items.map((t, i) => h("div", { class: i === 0 ? "on" : "", role: "option", onmousedown: (e) => { e.preventDefault(); pickSlash(i); } },
        h("strong", {}, t.name), t.shortcut ? h("span", { class: "muted" }, ` /${t.shortcut}`) : null, t.shared ? h("span", { class: "pill" }, "shared") : null)));
    document.body.append(box);
    slash = { box, items, index: 0, node, start: r.startOffset - m[1].length - 1, end: r.startOffset };
  };
  const pickSlash = (i) => {
    const sl = slash;
    closeSlash();
    const range = document.createRange();
    range.setStart(sl.node, Math.min(sl.start, sl.node.length));
    range.setEnd(sl.node, Math.min(sl.end, sl.node.length));
    insertTemplate(sl.items[i], range);
  };
  editor.addEventListener("input", slashCheck);
  editor.addEventListener("blur", () => setTimeout(closeSlash, 150));
  editor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); keepRange(); templatePicker(tplBtn, lastRange, insertTemplate); return; }
    if (!slash) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slash.index = (slash.index + (e.key === "ArrowDown" ? 1 : slash.items.length - 1)) % slash.items.length;
      [...slash.box.children].forEach((c, i) => c.classList.toggle("on", i === slash.index));
    } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slash.index); } else if (e.key === "Escape") { e.stopPropagation(); closeSlash(); }
  });

  // Autosave. Every change is kept on this device straight away (IndexedDB), then saved to Drafts on the server a few
  // seconds after you stop typing. Offline, it stays on the device and is saved when the connection is back (by the
  // service worker in the background where the browser can, or when the webmail next opens).
  const key = local?.key || (draft ? `draft-${draft.id}` : `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // finished: closed, sent or discarded (no more timers); gone: sent or discarded (nothing to keep on the device).
  let edited = !!local?.dirty, finished = false, gone = false, localTimer = null, serverTimer = null;
  const savedAt = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const saveLocal = async () => {
    clearTimeout(localTimer);
    if (!window.LocalDrafts || !edited || gone || shared) return;
    const { attachments, draft_id: _ignored, ...rest } = payload();
    await LocalDrafts.update(key, (cur) => ({ ...(cur || {}), key, user: state.user.id, updated: Date.now(), dirty: true, payload: rest, attachments }))
      .catch(() => {});
  };
  const saveServer = async () => {
    clearTimeout(serverTimer);
    if (!edited || gone) return;
    if (shared) return team.flush();
    if (!window.LocalDrafts) { // no IndexedDB (some private windows): straight to the server, as before
      try { draftId = (await api("draft", { method: "POST", body: payload() })).id; status.textContent = `Draft saved ${savedAt()}`; } catch (err) { status.textContent = err.message; }
      return;
    }
    await saveLocal();
    if (navigator.onLine === false) { status.textContent = "Saved on this device. It goes to Drafts when you're back online."; backgroundSave(); return; }
    try {
      const rec = await LocalDrafts.sync(key, csrf);
      if (rec?.draft_id) draftId = rec.draft_id;
      status.textContent = `Draft saved ${savedAt()}`;
    } catch (err) {
      if (err.status === 401) { status.textContent = "Saved on this device. Sign in again to save it to Drafts."; return; }
      if (err.status && err.status < 500) { status.textContent = err.message; return; }
      status.textContent = "Saved on this device. It goes to Drafts when the connection is back.";
      backgroundSave();
    }
  };
  /** Stop the timers and let a save that's under way finish; `keep` false: not saved again (it's being sent or discarded). */
  const settle = async (keep) => {
    clearTimeout(localTimer); clearTimeout(serverTimer);
    if (!window.LocalDrafts) return;
    await LocalDrafts.locked(key, async () => {
      const rec = await LocalDrafts.update(key, (cur) => cur && !keep ? { ...cur, dirty: false } : null).catch(() => null);
      if (rec?.draft_id) draftId = rec.draft_id;
    });
  };
  function changed() {
    if (finished) return;
    if (shared) return team.changed();
    edited = true;
    status.textContent = "";
    clearTimeout(localTimer); clearTimeout(serverTimer);
    localTimer = setTimeout(saveLocal, 300);
    serverTimer = setTimeout(saveServer, 4000);
  }
  const saveDraft = () => { edited = true; return saveServer(); };
  /** Closing: anything not saved yet is saved now (and kept on the device until it is). */
  const close = async () => {
    overlay.remove();
    if (flushCompose === flushThis) flushCompose = null;
    if (shared) { finished = true; await team.flush(); team.leave(); return; }
    if (finished) return;
    finished = true;
    if (edited) { await saveServer(); refresh(); }
  };
  const flushThis = () => saveLocal();
  flushCompose = flushThis;
  const discard = async () => {
    if (shared) {
      if (!confirm("Delete this shared reply for everyone writing it?")) return;
      team.stop();
      try { await api("team/draft/delete", { method: "POST", body: { id: shared.id } }); } catch (err) { if (err.status !== 404) { toast(err.message); return; } }
      overlay.remove();
      toast("Shared reply deleted.");
      if (current) openMessage(current.message.id);
      return;
    }
    finished = gone = true;
    await settle(false);
    await window.LocalDrafts?.remove(key).catch(() => {});
    if (draftId) await api("messages/delete", { method: "POST", body: { ids: [draftId] } }).catch(() => {});
    overlay.remove();
    if (flushCompose === flushThis) flushCompose = null;
    toast("Draft discarded.");
    refresh();
  };
  const team = shared ? sharedReply({ shared, editor, status, inputs: { to: toIn, cc: ccIn, bcc: bccIn, subject: subjIn }, sigOn, ccRow, bccRow,
    gone: (message) => { overlay.remove(); finished = gone = true; toast(message); if (current) openMessage(current.message.id); } }) : { stop() {}, flush() {} };
  const overlay = h("div", { class: "overlay compose-overlay", oninput: changed, onchange: changed, onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "compose", role: "dialog", "aria-label": "New message" },
      h("div", { class: "compose-head" }, shared ? "Reply with the team" : opts.mode === "forward" ? "Forward" : of ? "Reply" : "New message", shared && team.presence, h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
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
        h("button", { class: "icon-btn", type: "button", title: "Attach files", "aria-label": "Attach files", onclick: () => fileIn.click() }, icon("clip")), fileIn, tplBtn),
      editor, sigBox, attList,
      shared && h("p", { class: "muted small shared-note" }, "Everyone writing this sees each change as it's made. Attachments you add are only on your screen until you send."),
      h("div", { class: "compose-foot" }, h("div", { class: "send-group" }, sendBtn, laterBtn), !shared && h("button", { class: "btn", onclick: saveDraft }, "Save draft"), status, h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", title: shared ? "Delete the shared reply" : "Discard draft", "aria-label": "Discard draft", onclick: discard }, icon("trash")))));
  document.body.append(overlay);
  if (local?.dirty) status.textContent = "Recovered from this device.";
  if (shared) team.start(overlay);
  suggest(toIn, contacts); suggest(ccIn, contacts); suggest(bccIn, contacts);
  (to.length ? editor : toIn).focus();
  if (to.length) { const r = document.createRange(); r.setStart(editor, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }
}

/** The email that's waiting for its Undo send seconds to pass (sending another one sends it straight away). */
let pendingSend = null;

// ------------------------------------------------------------------------------------------------ templates
const PLACEHOLDER_RE = /\{(first_name|last_name|name|email|company|ticket_id|subject|my_name|my_first_name|my_email|date)\}/g;
let templatesCache = null;
/** Your templates, then the shared ones: [{ id, name, shortcut, subject, html, shared }]. */
function loadTemplates(fresh = false) {
  if (fresh || !templatesCache) {
    templatesCache = api("templates").then((r) => [...r.personal.map((t) => ({ ...t, shared: false })), ...r.shared.map((t) => ({ ...t, shared: true }))])
      .catch((err) => { templatesCache = null; throw err; });
  }
  return templatesCache;
}

/** A conversation's reference for {ticket_id}: the same for everyone replying to it (from its thread), six letters and digits. */
function ticketId(key) {
  let n = 0x811c9dc5;
  for (const ch of String(key)) { n ^= ch.codePointAt(0); n = Math.imul(n, 0x01000193) >>> 0; }
  return n.toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

/** What the placeholders stand for in this email: the first recipient (and your contacts' name and company for them), you, and the conversation. */
async function placeholderValues({ to, subject, mailbox, of }) {
  const first = (to || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)[0] || "";
  const address = (/<([^>]+)>/.exec(first)?.[1] || first).trim().toLowerCase();
  const people = await (contacts ??= api("contacts").then((r) => r.contacts).catch(() => []));
  const c = people.find((x) => x.email === address);
  const name = (c?.name || (of?.from?.address?.toLowerCase() === address ? of.from.name : "") || /^"?([^"<]*?)"?\s*</.exec(first)?.[1] || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const me = mailbox?.display_name || state.user.name || "";
  const values = { email: address, name, first_name: parts[0] || "", last_name: parts.length > 1 ? parts[parts.length - 1] : "", company: c?.company || "",
    ticket_id: of ? ticketId(of.thread_key || `m${of.id}`) : "", subject: subject || "", my_name: me, my_first_name: me.split(/\s+/)[0] || "",
    my_email: mailbox?.address || "", date: new Date().toLocaleDateString([], { dateStyle: "long" }) };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v));
}
const fillText = (text, values) => text.replace(PLACEHOLDER_RE, (m, k) => values[k] ?? m);

/**
 * A template's text as nodes for the editor: simple formatting only (the server keeps only that too), links only to
 * web and mail addresses, and the placeholders that are known filled in (as text, never as HTML).
 */
function templateNodes(html, values) {
  const t = document.createElement("template"); // inert: nothing in it runs or loads
  t.innerHTML = html;
  const keep = new Set(["P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "A", "SPAN", "H1", "H2", "H3", "HR"]);
  const clean = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) { ch.textContent = fillText(ch.textContent, values); continue; }
      if (ch.nodeType !== 1) { ch.remove(); continue; }
      if (!keep.has(ch.tagName)) {
        if (["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "IMG"].includes(ch.tagName.toUpperCase())) { ch.remove(); continue; }
        clean(ch);
        ch.replaceWith(...ch.childNodes);
        continue;
      }
      const href = ch.tagName === "A" ? ch.getAttribute("href") : null;
      for (const a of [...ch.attributes]) ch.removeAttribute(a.name);
      if (href && /^(https?:|mailto:)/i.test(href.trim())) ch.setAttribute("href", href.trim());
      clean(ch);
    }
  };
  clean(t.content);
  return t.content;
}

/** Put nodes into the editor where the caret was (or at the end), and the caret after them. */
function insertAt(editor, range, frag) {
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(after);
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The Templates menu in a compose window: search by name or shortcut, pick one to put it in. */
async function templatePicker(anchor, range, insert) {
  const where = range?.cloneRange();
  let list;
  try { list = await loadTemplates(); } catch (err) { toast(err.message); return; }
  if (!list.length) {
    popMenu(anchor, [h("p", { class: "muted small pop-pad" }, "No templates yet: replies you write often, with placeholders like {first_name}."),
      { label: "Make one", icon: "template", run: () => openSettings("templates") }], { className: "template-menu" });
    return;
  }
  const search = h("input", { class: "input", placeholder: "Search templates", "aria-label": "Search templates", autocomplete: "off" });
  const box = h("div", { class: "pop-list" });
  const shown = () => { const q = search.value.trim().toLowerCase().replace(/^\//, ""); return list.filter((t) => !q || t.name.toLowerCase().includes(q) || t.shortcut.startsWith(q)); };
  const render = () => box.replaceChildren(...shown().map((t) => h("button", { type: "button", role: "menuitem", onclick: () => { menu.close(); insert(t, where); } },
    icon("template"), h("span", {}, t.name), h("small", { class: "muted" }, [t.shortcut && `/${t.shortcut}`, t.shared && "shared"].filter(Boolean).join(" · ")))));
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); box.querySelector("button")?.click(); } });
  const menu = popMenu(anchor, [search, box, null, { label: "Manage templates…", icon: "settings", run: () => openSettings("templates") }], { className: "template-menu" });
  render();
  search.focus();
}

/** Reply to an email from outside the app (a notification's Reply button): open it, then a reply window, with any text already typed. */
async function replyTo(id, text = "") {
  await openMessage(id);
  if (current?.message.id === id) compose({ mode: "reply", of: last(), text });
}

async function openDraft(m) {
  compose({ draft: m });
}

// ------------------------------------------------------------------------------------------------ writing together
// A shared reply is saved with the version it was based on. If someone saved first, the server says so with theirs, and
// the two are merged: per field, and in the message paragraph by paragraph (and within a paragraph, if the two changed
// different parts of it). What's merged is saved again. Everyone's copy is checked every 1.5 seconds.

const escapeText = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const blockHtml = (n) => (n.nodeType === 1 ? n.outerHTML : escapeText(n.textContent));
function blocksOf(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return [...t.content.childNodes].map(blockHtml);
}
/** Matching items of a and b, in order (longest common subsequence): [[i, j], …]. */
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}
/** Both people's changes to one piece of text, if they changed different parts of it; else null. */
function mergeText(base, mine, theirs) {
  const region = (x) => {
    let p = 0;
    while (p < base.length && p < x.length && base[p] === x[p]) p++;
    let q = 0;
    while (q < base.length - p && q < x.length - p && base[base.length - 1 - q] === x[x.length - 1 - q]) q++;
    return { start: p, end: base.length - q, text: x.slice(p, x.length - q) };
  };
  const a = region(mine), b = region(theirs);
  if (a.end <= b.start) return base.slice(0, a.start) + a.text + base.slice(a.end, b.start) + b.text + base.slice(b.end);
  if (b.end <= a.start) return base.slice(0, b.start) + b.text + base.slice(b.end, a.start) + a.text + base.slice(a.end);
  return null;
}
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
/** What one side changed, as hunks: base[start, end) became lines. */
function hunks(base, x) {
  const out = [];
  let b = 0, j0 = 0;
  for (const [i, j] of [...lcsPairs(base, x), [base.length, x.length]]) {
    if (i > b || j > j0) out.push({ start: b, end: i, lines: x.slice(j0, j) });
    b = i + 1; j0 = j + 1;
  }
  return out;
}
function applyHunks(base, list, from, to) {
  const out = [];
  let k = from;
  for (const hk of list) { out.push(...base.slice(k, hk.start), ...hk.lines); k = hk.end; }
  return out.concat(base.slice(k, to));
}
/** A three-way merge of two people's changes to the same paragraphs; where they touch the same ones, see resolveBlocks. */
function mergeBlocks(base, mine, theirs) {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (base.length * Math.max(mine.length, theirs.length) > 250000) return mine; // too long to compare: keep what's typed here
  const all = [...hunks(base, mine).map((x) => ({ ...x, mine: true })), ...hunks(base, theirs).map((x) => ({ ...x, mine: false }))]
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];
  for (const hk of all) {
    const g = groups[groups.length - 1];
    if (g && (hk.start < g.end || hk.start === g.start)) { g.list.push(hk); g.end = Math.max(g.end, hk.end); }
    else groups.push({ start: hk.start, end: hk.end, list: [hk] });
  }
  const out = [];
  let k = 0;
  for (const g of groups) {
    out.push(...base.slice(k, g.start));
    const m = g.list.filter((x) => x.mine), t = g.list.filter((x) => !x.mine);
    if (!t.length) out.push(...applyHunks(base, m, g.start, g.end));
    else if (!m.length) out.push(...applyHunks(base, t, g.start, g.end));
    else {
      const mc = applyHunks(base, m, g.start, g.end), tc = applyHunks(base, t, g.start, g.end);
      out.push(...(same(mc, tc) ? mc : resolveBlocks(base.slice(g.start, g.end), mc, tc)));
    }
    k = g.end;
  }
  return out.concat(base.slice(k));
}
/** Both changed the same stretch of paragraphs. */
function resolveBlocks(bc, mc, tc) {
  // Different parts of the same text (one split a paragraph, the other added to its end): both.
  const merged = mergeText(bc.join(""), mc.join(""), tc.join(""));
  if (merged !== null) return blocksOf(merged);
  if (bc.length === 1) {
    // One side left the paragraph as it was and added others around it: the other side's change to it goes in its place.
    const plain = (x) => { const t = document.createElement("template"); t.innerHTML = x; return t.content.textContent.replace(/\s+/g, " ").trim(); };
    const was = plain(bc[0]);
    const i = mc.findIndex((x) => x === bc[0] || plain(x) === was);
    if (i >= 0) return [...mc.slice(0, i), ...tc, ...mc.slice(i + 1)];
    const j = tc.findIndex((x) => x === bc[0] || plain(x) === was);
    if (j >= 0) return [...tc.slice(0, j), ...mc, ...tc.slice(j + 1)];
  }
  return [...tc, ...mc.filter((x) => !tc.includes(x))]; // really both changed the same words: keep both, theirs first
}
const mergeHtml = (base, mine, theirs) => mergeBlocks(blocksOf(base), blocksOf(mine), blocksOf(theirs)).join("");

/** Replace the message's content, keeping the cursor where it was (in the same paragraph, at the same place). */
function setEditorHtml(editor, html) {
  if (editor.innerHTML === html) return;
  const sel = getSelection();
  let caret = null;
  if (sel.rangeCount && sel.anchorNode !== editor && editor.contains(sel.anchorNode)) {
    let blk = sel.anchorNode;
    while (blk.parentNode !== editor) blk = blk.parentNode;
    const r = document.createRange();
    r.setStart(blk, 0); r.setEnd(sel.anchorNode, sel.anchorOffset);
    caret = { idx: [...editor.childNodes].indexOf(blk), html: blockHtml(blk), offset: r.toString().length };
  }
  editor.innerHTML = html;
  if (!caret || !editor.childNodes.length) return;
  const blocks = [...editor.childNodes].map(blockHtml);
  let best = -1;
  blocks.forEach((b, i) => { if (b === caret.html && (best < 0 || Math.abs(i - caret.idx) < Math.abs(best - caret.idx))) best = i; });
  const node = editor.childNodes[best >= 0 ? best : Math.min(caret.idx, blocks.length - 1)];
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let left = caret.offset, at = null;
  for (let t = node.nodeType === 3 ? node : walk.nextNode(); t; t = walk.nextNode()) {
    if (left <= t.textContent.length) { at = [t, left]; break; }
    left -= t.textContent.length;
  }
  const r = document.createRange();
  if (at) r.setStart(at[0], at[1]); else { r.selectNodeContents(node); r.collapse(false); }
  r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}

function sharedReply({ shared, editor, status, inputs, sigOn, ccRow, bccRow, gone }) {
  let base = shared.version, baseFields = shared.fields, stopped = false, pushing = null, pushTimer = null, pollTimer = null, composing = false, overlay = null;
  const presence = h("span", { class: "presence" });
  const fieldsNow = () => ({ to: inputs.to.value, cc: inputs.cc.value, bcc: inputs.bcc.value, subject: inputs.subject.value, html: editor.innerHTML, text: editor.innerText, signature: sigOn.checked });
  const comparable = (f) => JSON.stringify([f.to, f.cc, f.bcc, f.subject, f.html, f.signature !== false]);
  const showPresence = (d) => presence.replaceChildren(...(d.editors?.length
    ? [icon("people"), d.editors.map((e) => `${e.name}${e.typing ? " is typing…" : ""}`).join(", ")]
    : [h("span", { class: "muted" }, "No one else has it open")]));
  showPresence(shared);
  editor.addEventListener("compositionstart", () => { composing = true; });
  editor.addEventListener("compositionend", () => { composing = false; });
  /** Merge someone else's version with what's here; true if what's here has more to save. */
  const merge = (remote) => {
    const mine = fieldsNow(), theirs = remote.fields, out = {};
    for (const k of ["to", "cc", "bcc", "subject", "signature"]) out[k] = mine[k] === baseFields[k] ? theirs[k] : mine[k];
    out.html = mine.html === baseFields.html ? theirs.html : mergeHtml(baseFields.html, mine.html, theirs.html);
    for (const k of ["to", "cc", "bcc", "subject"]) if (inputs[k].value !== out[k]) inputs[k].value = out[k];
    ccRow.hidden = ccRow.hidden && !out.cc; bccRow.hidden = bccRow.hidden && !out.bcc;
    sigOn.checked = out.signature !== false;
    setEditorHtml(editor, out.html);
    base = remote.version; baseFields = theirs;
    if (remote.updated_by_id !== state.user.id) status.textContent = `${remote.updated_by} changed it just now`;
    return comparable(fieldsNow()) !== comparable(theirs);
  };
  const push = async () => {
    clearTimeout(pushTimer);
    if (stopped) return;
    const mine = fieldsNow();
    if (comparable(mine) === comparable(baseFields)) return;
    try {
      const r = await api("team/draft/save", { method: "POST", body: { id: shared.id, version: base, fields: mine } });
      base = r.version; baseFields = mine;
      showPresence(r);
      status.textContent = `Saved for the team ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch (err) {
      if (err.status === 409 && err.data?.draft) { merge(err.data.draft); return push(); }
      if (err.status === 404) { stop(); gone("This shared reply has been sent or deleted by someone else."); return; }
      status.textContent = "Couldn't save just now; trying again…";
      pushTimer = setTimeout(() => flush(), 3000);
    }
  };
  /** Save now (one save at a time). */
  const flush = () => (pushing ??= push().finally(() => { pushing = null; }));
  const poll = async () => {
    if (stopped) return;
    if (!overlay?.isConnected) return stop();
    if (!pushing && !composing && document.visibilityState === "visible") {
      try {
        const d = await api("team/draft", { query: { id: String(shared.id) } });
        showPresence(d);
        if (!pushing && d.version > base && merge(d)) flush();
      } catch (err) {
        if (err.status === 404) { stop(); gone("This shared reply has been sent or deleted by someone else."); return; }
      }
    }
    pollTimer = setTimeout(poll, 1500);
  };
  const stop = () => { stopped = true; clearTimeout(pushTimer); clearTimeout(pollTimer); };
  return {
    presence,
    start(o) { overlay = o; pollTimer = setTimeout(poll, 1500); },
    changed() { clearTimeout(pushTimer); pushTimer = setTimeout(flush, 600); },
    flush: () => (stopped ? Promise.resolve() : flush()),
    stop,
    leave() { stop(); api("team/draft/leave", { method: "POST", body: { id: shared.id } }).catch(() => {}); },
  };
}

// The open compose window's "save it now" (when the page is hidden or closed: the browser may not come back to it).
let flushCompose = null;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushCompose?.(); });
addEventListener("pagehide", () => flushCompose?.());

/** Ask the service worker to save drafts in the background once there's a connection (Chrome, Edge, Android). */
function backgroundSave() {
  navigator.serviceWorker?.ready.then((r) => r.sync?.register("drafts")).catch(() => {});
}

/**
 * Drafts left on this device unsaved (the browser crashed, the tab was closed, or the connection dropped): saved to
 * Drafts now, or offered back if there's still no connection.
 */
async function recoverDrafts() {
  if (!window.LocalDrafts || !state.user) return;
  const left = (await LocalDrafts.all().catch(() => [])).filter((r) => r.user === state.user.id && r.dirty);
  if (!left.length) return;
  const saved = navigator.onLine === false ? 0 : await LocalDrafts.syncAll(state.user.id, csrf).catch(() => 0);
  if (saved) {
    toast(saved === 1 ? "A draft that wasn't saved has been put back in Drafts." : `${saved} drafts that weren't saved have been put back in Drafts.`,
      { label: "Open Drafts", run: () => openFolder("drafts") });
    refresh();
    return;
  }
  const newest = left.sort((a, b) => b.updated - a.updated)[0];
  toast(left.length === 1 ? "You have an unsent draft saved on this device." : `You have ${left.length} unsent drafts saved on this device.`,
    { label: "Open", run: () => compose({ local: newest }) });
}
addEventListener("online", () => { if (state.user && csrf) recoverDrafts(); });

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
  const tabs = [["account", "Account"], ["mailboxes", "Mailboxes"], ["templates", "Templates"], ["rules", "Rules & labels"], ["import", "Import email"], ["security", "Sign-in & alerts"],
    ...(state.user.role === "admin" ? [["admin-users", "Users"], ["admin-security", "Security"], ["admin-firewall", "Firewall"], ["admin-mailboxes", "Connect addresses"], ["admin-data-requests", "Data requests"], ["admin-status", "Status"]] : [])];
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

/** "Your password" to confirm a change; with passkeys only, nothing to type (the passkey is asked for when it's sent). */
function confirmPw(label = "Your password", name = "password") {
  if (state.user?.passkeys_only) return h("p", { class: "muted small" }, "You'll confirm this with your passkey.");
  return h("label", { class: "field" }, label, h("input", { type: "password", name, required: true, autocomplete: "current-password" }));
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

/** A small editor for formatted text (bold, italic, underline, lists, links), for templates. */
function richEditor(html, label) {
  const ed = h("div", { class: "editor small-editor", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": label });
  ed.append(templateNodes(html || "", {}));
  const cmd = (name, value) => () => { ed.focus(); document.execCommand(name, false, value); };
  const bar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatting" },
    h("button", { class: "icon-btn", type: "button", title: "Bold", "aria-label": "Bold", onclick: cmd("bold") }, icon("bold")),
    h("button", { class: "icon-btn", type: "button", title: "Italic", "aria-label": "Italic", onclick: cmd("italic") }, icon("italic")),
    h("button", { class: "icon-btn", type: "button", title: "Underline", "aria-label": "Underline", onclick: cmd("underline") }, icon("underline")),
    h("button", { class: "icon-btn", type: "button", title: "List", "aria-label": "Bulleted list", onclick: cmd("insertUnorderedList") }, icon("list")),
    h("button", { class: "icon-btn", type: "button", title: "Link", "aria-label": "Link", onclick: () => { const u = prompt("Link address (https://…)"); if (u && /^(https?:\/\/|mailto:)/i.test(u)) cmd("createLink", u)(); } }, icon("link")));
  return { ed, bar };
}

/** Settings → Templates: your own, and the shared ones (administrators change those). */
async function templateSettings() {
  const r = await api("templates");
  templatesCache = Promise.resolve([...r.personal.map((t) => ({ ...t, shared: false })), ...r.shared.map((t) => ({ ...t, shared: true }))]);
  const area = h("div");
  const reload = () => openSettings("templates");
  const edit = (book, t = null) => {
    const { ed, bar } = richEditor(t?.html || "", "Template text");
    const chips = h("div", { class: "chips" }, h("span", { class: "muted small" }, "Insert:"), Object.entries(r.placeholders).map(([k, about]) => h("button", { type: "button", class: "chip", title: about, onmousedown: (e) => e.preventDefault(), onclick: () => {
      if (!ed.contains(getSelection().anchorNode)) { ed.focus(); const rr = document.createRange(); rr.selectNodeContents(ed); rr.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(rr); }
      document.execCommand("insertText", false, `{${k}}`);
    } }, `{${k}}`)));
    const form = formFor([
      h("div", { class: "row" }, h("label", { class: "field grow" }, "Name", h("input", { name: "name", required: true, maxlength: 80, value: t?.name || "", placeholder: "Refund processed" })),
        h("label", { class: "field short-field" }, "Shortcut", h("input", { name: "shortcut", maxlength: 32, value: t?.shortcut || "", placeholder: "refund", autocapitalize: "none", spellcheck: "false" }))),
      h("label", { class: "field" }, "Subject (optional: used when the email has none yet)", h("input", { name: "subject", maxlength: 200, value: t?.subject || "" })),
      h("div", { class: "field" }, "Text", bar, ed, chips,
        h("small", {}, "Placeholders are filled in from the email you're writing: the first recipient (and their name and company from your contacts), you, and the conversation. One that can't be filled in stays as it is, and you're asked before sending it.")),
    ], t ? "Save" : "Add template", async (v) => {
      await api("templates/save", { method: "POST", body: { ...v, html: ed.innerHTML, book, id: t?.id } });
      templatesCache = null;
      toast("Saved.");
      reload();
    });
    area.replaceChildren(h("section", {}, h("h3", {}, t ? `Edit ${t.name}` : book === "shared" ? "New shared template" : "New template"), form,
      h("button", { type: "button", class: "btn btn-sm", onclick: () => area.replaceChildren() }, "Cancel")));
    area.scrollIntoView({ behavior: "smooth" });
  };
  const listOf = (items, book, canEdit) => items.length ? h("table", { class: "list" }, items.map((t) => h("tr", {},
    h("td", {}, h("strong", {}, t.name), t.shortcut ? h("span", { class: "muted" }, ` /${t.shortcut}`) : null,
      h("div", { class: "muted small clamp" }, templateNodes(t.html, {}).textContent.slice(0, 140))),
    h("td", { class: "actions" }, canEdit && h("button", { class: "btn btn-sm", onclick: () => edit(book, t) }, "Edit"),
      canEdit && h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
        if (!confirm(`Delete the template ${t.name}?`)) return;
        try { await api("templates/delete", { method: "POST", body: { id: t.id, book } }); templatesCache = null; reload(); } catch (err) { toast(err.message); }
      } }, "Delete")))))
    : h("p", { class: "muted" }, book === "shared" ? "No shared templates." : "None yet.");
  return h("div", {},
    h("p", { class: "muted" }, "Replies you write often, ready to put in an email: type / and the shortcut (or name) while writing, press Ctrl+/ (⌘/ on a Mac), or use the Templates button."),
    h("section", {}, h("div", { class: "row between" }, h("h3", {}, "Your templates"), h("button", { class: "btn btn-sm", onclick: () => edit("personal") }, "New template")),
      listOf(r.personal, "personal", true)),
    h("section", {}, h("div", { class: "row between" }, h("h3", {}, "Shared templates"), r.can_edit_shared && h("button", { class: "btn btn-sm", onclick: () => edit("shared") }, "New shared template")),
      h("p", { class: "muted small" }, r.can_edit_shared ? "Everyone can use these. Only administrators change them." : "Your administrator's, for everyone."),
      listOf(r.shared, "shared", r.can_edit_shared)),
    area);
}

/** Settings → Rules & labels: a mailbox's labels, and the rules that file its new email. */
let rulesMailbox = 0;
async function rulesSettings() {
  if (!state.mailboxes.length) return h("p", { class: "muted" }, "You don't have a mailbox yet.");
  if (!state.mailboxes.some((m) => m.id === rulesMailbox)) rulesMailbox = state.mailbox || state.mailboxes[0].id;
  const mb = state.mailboxes.find((m) => m.id === rulesMailbox);
  const r = await api("rules", { query: { mailbox: String(rulesMailbox) } });
  const reload = async () => { await refreshCounts(); openSettings("rules"); };
  const labelName = (id) => r.labels.find((l) => l.id === Number(id))?.name || "(a label that's gone)";
  const area = h("div");
  const pick = state.mailboxes.length > 1 ? h("label", { class: "field" }, "Mailbox", h("select", { onchange: (e) => { rulesMailbox = Number(e.target.value); openSettings("rules"); } },
    state.mailboxes.map((m) => h("option", { value: String(m.id), selected: m.id === rulesMailbox }, m.address)))) : null;

  // Labels: add, rename, delete.
  const labelRows = r.labels.length ? h("div", { class: "chips" }, r.labels.map((l) => h("span", { class: "label-pill big" }, icon("label"), l.name,
    h("button", { type: "button", title: "Rename", "aria-label": `Rename ${l.name}`, onclick: async () => {
      const name = prompt("New name for the label", l.name);
      if (!name || name === l.name) return;
      try { await api("labels/save", { method: "POST", body: { id: l.id, name } }); reload(); } catch (err) { toast(err.message); }
    } }, "✎"),
    h("button", { type: "button", title: "Delete", "aria-label": `Delete ${l.name}`, onclick: async () => {
      if (!confirm(`Delete the label ${l.name}? Its email stays where it is, without the label.`)) return;
      try { await api("labels/delete", { method: "POST", body: { id: l.id } }); reload(); } catch (err) { toast(err.message); }
    } }, "✕"))))
    : h("p", { class: "muted" }, "No labels yet.");
  const addLabel = formFor([h("label", { class: "field grow" }, "New label", h("input", { name: "name", required: true, maxlength: 50, placeholder: "Accounting" }))], "Add label", async (v) => {
    await api("labels/save", { method: "POST", body: { mailbox_id: rulesMailbox, name: v.name } });
    reload();
  });
  addLabel.classList.add("row");

  const describe = (rule) => {
    const conds = rule.conditions.map((c) => `${(r.fields[c.field] || c.field).toLowerCase()} ${r.ops[c.op] || c.op} “${c.value}”`).join(rule.match === "any" ? " or " : " and ");
    const a = rule.actions;
    const does = [a.move === "label" ? `move to ${labelName(a.move_label)}` : a.move ? `move to ${a.move[0].toUpperCase()}${a.move.slice(1)}` : null,
      a.tags?.length ? `label ${a.tags.map(labelName).join(", ")}` : null, a.read ? "mark read" : null, a.star ? "star" : null].filter(Boolean).join(", ");
    return `If ${conds}: ${does}.`;
  };
  const move = async (i, by) => {
    const ids = r.rules.map((x) => x.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    try { await api("rules/order", { method: "POST", body: { mailbox_id: rulesMailbox, ids } }); reload(); } catch (err) { toast(err.message); }
  };
  const ruleRows = r.rules.length ? h("table", { class: "list rules" }, r.rules.map((rule, i) => h("tr", { class: rule.enabled ? "" : "off" },
    h("td", {}, h("label", { class: "check", title: rule.enabled ? "On" : "Off" }, h("input", { type: "checkbox", checked: rule.enabled, "aria-label": "On", onchange: async (e) => {
      try { await api("rules/enable", { method: "POST", body: { id: rule.id, enabled: e.target.checked } }); reload(); } catch (err) { toast(err.message); }
    } }))),
    h("td", {}, rule.name ? h("strong", {}, rule.name) : null, h("div", { class: rule.name ? "muted small" : "" }, describe(rule))),
    h("td", { class: "actions" },
      h("button", { class: "icon-btn", type: "button", title: "Earlier", "aria-label": "Move up", disabled: i === 0, onclick: () => move(i, -1) }, icon("up")),
      h("button", { class: "icon-btn", type: "button", title: "Later", "aria-label": "Move down", disabled: i === r.rules.length - 1, onclick: () => move(i, 1) }, icon("down")),
      h("button", { class: "btn btn-sm", onclick: () => edit(rule) }, "Edit"),
      h("button", { class: "btn btn-sm", title: "Run it on the email in the Inbox now", onclick: async (e) => {
        e.target.disabled = true;
        try { const x = await api("rules/run", { method: "POST", body: { id: rule.id } }); toast(x.applied ? `Done: it matched ${x.applied} email${x.applied === 1 ? "" : "s"} in the Inbox.` : "Nothing in the Inbox matches it."); refreshCounts(); refresh(); }
        catch (err) { toast(err.message); }
        e.target.disabled = false;
      } }, "Run now"),
      h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
        if (!confirm("Delete this rule?")) return;
        try { await api("rules/delete", { method: "POST", body: { id: rule.id } }); reload(); } catch (err) { toast(err.message); }
      } }, "Delete")))))
    : h("p", { class: "muted" }, "No rules yet.");

  const edit = (rule = null) => {
    const conds = h("div", { class: "conditions" });
    const condRow = (c = { field: "from", op: "contains", value: "" }) => {
      const row = h("div", { class: "row condition" },
        h("select", { class: "input", "aria-label": "What it looks at", dataset: { k: "field" } }, Object.entries(r.fields).map(([k, l]) => h("option", { value: k, selected: c.field === k }, l))),
        h("select", { class: "input", "aria-label": "How", dataset: { k: "op" } }, Object.entries(r.ops).map(([k, l]) => h("option", { value: k, selected: c.op === k }, l))),
        h("input", { class: "input grow", "aria-label": "Text", value: c.value, maxlength: 200, placeholder: "@example.com", dataset: { k: "value" } }),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Remove this condition", onclick: () => { if (conds.children.length > 1) row.remove(); } }, icon("close")));
      conds.append(row);
    };
    (rule?.conditions.length ? rule.conditions : [undefined]).forEach((c) => condRow(c));
    const a = rule?.actions || { move: "", tags: [] };
    const moveSel = h("select", { name: "move", class: "input" },
      [["", "Leave it in the Inbox"], ["archive", "Archive"], ["spam", "Spam"], ["trash", "Trash"]].map(([v, l]) => h("option", { value: v, selected: a.move === v }, l)),
      r.labels.length ? h("optgroup", { label: "A label (like a folder)" }, r.labels.map((l) => h("option", { value: `label:${l.id}`, selected: a.move === "label" && a.move_label === l.id }, l.name))) : null);
    const form = formFor([
      h("label", { class: "field" }, "Name (optional)", h("input", { name: "name", maxlength: 80, value: rule?.name || "", placeholder: "Invoices" })),
      h("div", { class: "field" }, h("span", {}, "If ", h("select", { name: "match", class: "inline-select" }, h("option", { value: "all", selected: rule?.match !== "any" }, "all"),
        h("option", { value: "any", selected: rule?.match === "any" }, "any")), " of these match"), conds,
      h("div", {}, h("button", { type: "button", class: "btn btn-sm", onclick: () => condRow() }, "Add a condition"))),
      h("label", { class: "field" }, "Move it to", moveSel),
      h("div", { class: "field" }, "Label it", r.labels.length ? h("div", { class: "chips" }, r.labels.map((l) => h("label", { class: "check chip-check" },
        h("input", { type: "checkbox", name: `tag_${l.id}`, checked: (a.tags || []).includes(l.id) }), l.name)))
        : h("small", {}, "Add labels above to use them here.")),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "read", checked: !!a.read }), "Mark it read"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "star", checked: !!a.star }), "Star it"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "apply_now", checked: !rule }), "Also apply it to the email in the Inbox now"),
    ], rule ? "Save rule" : "Add rule", async (v) => {
      const conditions = [...conds.children].map((row) => Object.fromEntries([...row.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.value])));
      const mv = String(v.move || "");
      const body = { mailbox_id: rulesMailbox, id: rule?.id, name: v.name, match: v.match, conditions, apply_now: v.apply_now === "on", enabled: rule ? rule.enabled : true,
        actions: { move: mv.startsWith("label:") ? "label" : mv, move_label: mv.startsWith("label:") ? Number(mv.slice(6)) : undefined,
          tags: r.labels.filter((l) => v[`tag_${l.id}`] === "on").map((l) => l.id), read: v.read === "on", star: v.star === "on" } };
      const saved = await api("rules/save", { method: "POST", body });
      toast(saved.applied ? `Saved, and it filed ${saved.applied} email${saved.applied === 1 ? "" : "s"} from the Inbox.` : "Saved.");
      refresh();
      reload();
    });
    area.replaceChildren(h("section", {}, h("h3", {}, rule ? "Edit rule" : "New rule"), form, h("button", { type: "button", class: "btn btn-sm", onclick: () => area.replaceChildren() }, "Cancel")));
    area.scrollIntoView({ behavior: "smooth" });
  };

  return h("div", {}, pick,
    h("section", {}, h("h3", {}, "Labels"),
      h("p", { class: "muted" }, "Your own folders and tags for ", mb.address, mb.members > 1 ? " (everyone on this shared mailbox has the same ones)" : "", ". Moving an email to a label takes it out of the Inbox; labelling it leaves it where it is."),
      labelRows, addLabel),
    h("section", {}, h("div", { class: "row between" }, h("h3", {}, "Rules"), h("button", { class: "btn btn-sm", onclick: () => edit() }, "New rule")),
      h("p", { class: "muted" }, "They run in this order on new email as it arrives in the Inbox", mb.members > 1 ? ", for everyone on the mailbox" : "", ". Every rule that matches labels it; the first one that moves it decides where it goes."),
      ruleRows),
    area);
}

/** Settings: the authenticator app and recovery codes. Two-step verification can't be turned off. */
async function twoStepSettings() {
  const st = await api("mfa/status");
  const box = h("section", {}, h("h3", {}, "Two-step verification"));
  const area = h("div");
  const passwordForm = (label, onPassword) => formFor([confirmPw()], label, async (v) => onPassword(v.password));
  box.append(
    h("p", { class: "muted" }, "Required for everyone: after your password, you confirm it's you with your authenticator app or a passkey."),
    h("div", { class: "row between" }, h("div", {}, h("strong", {}, "Authenticator app"),
      h("div", { class: "muted small" }, st.totp ? `On since ${new Date(st.totp_since).toLocaleDateString()}` : "Not set up")),
      h("button", { class: "btn btn-sm", onclick: async () => {
        const setup = await api("mfa/setup");
        area.replaceChildren(totpSetupForm(setup, !state.user.passkeys_only, (r) => {
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

/**
 * Where someone is signed in: each browser and installed app, from where, and when it was last used, with Sign out.
 * Yours (Settings → Sign-in & alerts), or, for an administrator, someone else's (Users → Devices).
 */
function sessionList(of = null) {
  const box = h("section", {}, h("h3", {}, of ? `Where ${of.name || of.email} is signed in` : "Where you're signed in"), h("p", { class: "muted" }, "Loading…"));
  const when = (iso) => { const d = new Date(iso); const mins = Math.round((Date.now() - d) / 60000);
    return mins < 2 ? "Active now" : mins < 60 ? `${mins} minutes ago` : mins < 1440 ? `${Math.round(mins / 60)} hours ago` : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }); };
  const revoke = async (id, what) => {
    const r = await api(of ? "admin/users/sessions/revoke" : "sessions/revoke", { method: "POST", body: of ? { user_id: of.id, id } : { id } });
    toast(r.signed_out === 1 ? `${what} is signed out.` : `${r.signed_out} devices signed out.`);
    load();
  };
  const load = async () => {
    try {
      const { sessions } = await api(of ? "admin/users/sessions" : "sessions", { query: of ? { id: String(of.id) } : {} });
      const others = sessions.filter((x) => !x.current);
      box.replaceChildren(box.firstChild,
        h("p", { class: "muted" }, of ? "Sign a device out if it's lost, or they've left. Their notifications on it stop too." : "Don't recognise one, or lost a phone? Sign it out: it needs your password (or passkey) again, and its notifications stop."),
        sessions.length ? h("ul", { class: "sessions" }, sessions.map((x) => h("li", { class: x.current ? "current" : "" },
          h("span", { class: "dev-icon" }, icon(/iPhone|Android/.test(x.device) ? "phone" : x.app ? "inbox" : "mail")),
          h("div", { class: "grow" }, h("strong", {}, x.device), x.current && h("span", { class: "pill ok" }, "This device"),
            h("div", { class: "muted small" }, [when(x.last_active_at), x.ip, x.signed_in_at && `signed in ${new Date(x.signed_in_at).toLocaleDateString([], { day: "numeric", month: "short" })}`].filter(Boolean).join(" · "))),
          !x.current && h("button", { class: "btn btn-sm btn-danger", onclick: async (e) => { e.currentTarget.disabled = true; await revoke(x.id, x.device).catch((err) => toast(err.message)); } }, "Sign out"))))
          : h("p", { class: "muted" }, of ? "Not signed in anywhere." : "Only here."),
        (of ? sessions.length > 0 : others.length > 0) && h("button", { class: "btn btn-sm", onclick: async () => {
          if (!confirm(of ? `Sign ${of.email} out everywhere?` : "Sign out everywhere except here?")) return;
          await revoke(of ? "all" : "others", "").catch((err) => toast(err.message));
        } }, of ? "Sign out everywhere" : "Sign out everywhere else"));
    } catch (err) { box.replaceChildren(box.firstChild, h("div", { class: "notice bad" }, err.message)); }
  };
  load();
  return box;
}

/** Settings → Security (administrators): trusted networks, and passkeys instead of passwords. */
async function securityPolicy() {
  const p = await api("admin/security");
  const ranges = (name, value, placeholder) => h("textarea", { name, rows: 4, class: "mono-input", placeholder }, (value || []).join("\n"));
  const choice = (v, label, hint) => h("label", { class: "check address" }, h("input", { type: "radio", name: "passkeys_only", value: v, checked: p.passkeys_only === v }),
    h("span", {}, h("strong", {}, label), h("small", { class: "muted" }, hint)));
  const without = p.without_passkey || [];
  return h("div", {},
    h("section", {}, h("h3", {}, "Trusted networks"),
      h("p", { class: "muted" }, "Limit where the webmail can be used from: your office's and VPN's IP addresses. Someone signed in who leaves them is signed out at their next click. One address or range a line: ", h("code", {}, "203.0.113.7"), ", ", h("code", {}, "203.0.113.0/24"), ", ", h("code", {}, "2001:db8::/32"), "."),
      h("p", { class: "notice info" }, "Your address now: ", h("strong", { class: "mono" }, p.your_ip), ". Behind Cloudflare or another proxy? Say so under Settings → Firewall, so visitors' own addresses are used."),
      formFor([
        h("label", { class: "field" }, "Administration only from", h("small", {}, "Elsewhere, administrators can read and send their email but not change settings or users. Empty: anywhere."),
          ranges("admin_ips", p.admin_ips, "203.0.113.0/24  # office\n198.51.100.7  # VPN")),
        h("label", { class: "field" }, "Everyone only from", h("small", {}, "Signing in and using the webmail at all. Empty: anywhere. A person's own networks (Users → Edit) replace these for them."),
          ranges("user_ips", p.user_ips, "")),
        confirmPw()],
      "Save networks", async (v) => { await api("admin/security", { method: "POST", body: { admin_ips: v.admin_ips, user_ips: v.user_ips, password: v.password } }); toast("Saved."); openSettings("admin-security"); })),
    h("section", {}, h("h3", {}, "Passkeys only"),
      h("p", { class: "muted" }, "Sign in with a passkey (Face ID, Touch ID, Windows Hello or a fingerprint) and never a password: nothing to phish or guess. Someone without a passkey yet signs in with their password once and has to add one straight away. Lost it? Reset their two-step verification under Users, and they add a new one the same way."),
      formFor([
        choice("off", "Off", "Passwords and a second step (an authenticator app or a passkey), as now."),
        choice("admins", "Administrators", "Administrators sign in with passkeys only."),
        choice("everyone", "Everyone", "Nobody signs in with a password."),
        without.length > 0 && h("div", { class: "notice warn small" }, `Without a passkey yet (they'll add one at their next sign-in): `, without.map((u) => `${u.name || u.email}${u.role === "admin" ? " (administrator)" : ""}`).join(", "), "."),
        h("p", { class: "muted small" }, "You need a passkey yourself first, and the webmail on https://. If you're ever locked out, on the server: ", h("code", {}, "php security-reset.php"), "."),
        confirmPw()],
      "Save", async (v) => { await api("admin/security", { method: "POST", body: { passkeys_only: v.passkeys_only, password: v.password } }); toast("Saved."); openSettings("admin-security"); })));
}

const WAF_RULES = { sqli: "SQL injection", xss: "Script injection (XSS)", traversal: "Reading server files", command: "Running commands", php_object: "PHP object injection",
  template: "Template injection", ssrf: "Server-side request", log4shell: "Log4Shell", shellshock: "Shellshock", scanner: "Attack tool", no_agent: "No browser name",
  method: "Wrong request type", bad_action: "Made-up action", path_probe: "Probing for files", oversize: "Oversized request", null_byte: "Hidden bytes", crlf: "Line breaks in the address",
  bad_utf8: "Garbled text", cross_site: "From another website", rate_limit: "Too many requests", deny_list: "On the block list", failed_invalid_login: "Wrong password",
  failed_invalid_code: "Wrong two-step code", failed_rate_limited: "Kept trying after a limit", failed_csrf: "Expired or forged form", failed_unknown_passkey: "Unknown passkey",
  failed_invalid_passkey: "Bad passkey signature", failed_cloned_passkey: "Copied passkey", failed_unauthorized: "Bad API key", failed_not_found: "Made-up action" };
const wafRule = (r) => WAF_RULES[r] || r.replace(/^failed_/, "").replace(/_/g, " ");

/** Settings → Firewall (administrators): what it's seen and blocked, and how it works. */
async function firewallSettings() {
  const f = await api("admin/firewall");
  const s = f.settings;
  const when = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const stat = (n, label) => h("div", { class: "fw-stat" }, h("strong", {}, String(n)), h("span", {}, label));
  const radio = (name, v, label, hint, checked) => h("label", { class: "check address" }, h("input", { type: "radio", name, value: v, checked }),
    h("span", {}, h("strong", {}, label), hint && h("small", { class: "muted" }, hint)));
  const ranges = (name, list, placeholder) => h("textarea", { name, rows: 3, class: "mono-input", placeholder }, (list || []).join("\n"));
  const proxyRanges = h("label", { class: "field", hidden: s.proxy !== "custom" }, "The proxy's addresses", h("small", {}, "Its X-Forwarded-For header is only believed when the request comes from these."),
    ranges("proxy_ranges", s.proxy_ranges, "10.0.0.0/8"));
  const actionPill = (a) => h("span", { class: `pill fw-${a}` }, { blocked: "Refused", limited: "Slowed", banned: "Address blocked", logged: "Logged" }[a] || a);
  const blockForm = formFor([h("div", { class: "row" },
    h("label", { class: "field grow" }, "Block an address", h("input", { name: "ip", required: true, placeholder: "203.0.113.7", class: "mono-input" })),
    h("label", { class: "field" }, "For", h("select", { name: "hours" }, [[1, "an hour"], [24, "a day"], [168, "a week"], [720, "30 days"], [8760, "a year"]].map(([v, l]) => h("option", { value: String(v), selected: v === 24 }, l)))))],
  "Block", async (v) => { await api("admin/firewall/block", { method: "POST", body: { ip: v.ip.trim(), hours: Number(v.hours) } }); toast(`${v.ip} is blocked.`); openSettings("admin-firewall"); });
  const unblock = (ip) => async (e) => { e.currentTarget.disabled = true; try { await api("admin/firewall/unblock", { method: "POST", body: { ip } }); toast(`${ip} is unblocked.`); openSettings("admin-firewall"); } catch (err) { toast(err.message); } };
  const quickBlock = (ip) => async (e) => {
    if (!confirm(`Block ${ip} for a day?`)) return;
    e.currentTarget.disabled = true;
    try { await api("admin/firewall/block", { method: "POST", body: { ip, hours: 24 } }); toast(`${ip} is blocked for a day.`); openSettings("admin-firewall"); } catch (err) { toast(err.message); }
  };
  return h("div", {},
    h("section", {}, h("h3", {}, "Firewall ", h("span", { class: `pill fw-mode-${s.mode}` }, { block: "On", monitor: "Monitoring only", off: "Off" }[s.mode])),
      h("p", { class: "muted" }, "It checks every request before the webmail answers it: attacks hidden in addresses and headers (SQL injection, scripts, reading server files, running commands, Log4Shell), attack tools, other websites posting here, password guessing and floods of requests. An address that keeps at it is blocked: 15 minutes, then an hour, then a day. It never reads the email people write or receive."),
      f.cloudflare_detected && h("div", { class: "notice warn" }, "Requests come through Cloudflare, but the firewall is set to Directly: it can't tell visitors apart, so it isn't blocking anyone. Choose Cloudflare below."),
      h("div", { class: "fw-stats" }, stat(f.stats.refused_24h, "refused today"), stat(f.stats.blocked_now, "addresses blocked now"),
        stat(f.stats.addresses_24h, "addresses seen today"), stat(f.stats.logged_24h, "logged only")),
      f.rules_24h.length > 0 && h("p", { class: "muted small" }, "Today: ", f.rules_24h.map((r) => `${wafRule(r.rule)} (${r.n})`).join(", "), ".")),
    h("section", {}, h("h3", {}, `Blocked now (${f.blocked.length})`),
      f.blocked.length ? h("table", { class: "list" }, h("tr", {}, h("th", {}, "Address"), h("th", {}, "Until"), h("th", {}, "Why"), h("th", {}, "")),
        f.blocked.map((b) => h("tr", {}, h("td", { class: "mono" }, b.ip), h("td", {}, when(b.until)), h("td", {}, (b.reason || "").replace(/\(last: ([\w]+)\)/, (m, r) => `(last: ${wafRule(r).toLowerCase()})`), b.blocks > 1 && h("div", { class: "muted small" }, `Blocked ${b.blocks} times this week`)),
          h("td", {}, h("button", { class: "btn btn-sm", onclick: unblock(b.ip) }, "Unblock")))))
        : h("p", { class: "muted" }, "Nobody is blocked."),
      blockForm),
    h("section", {}, h("h3", {}, "What it's seen"),
      f.events.length ? h("div", { class: "fw-events" }, h("table", { class: "list" }, h("tr", {}, h("th", {}, "When"), h("th", {}, "Address"), h("th", {}, "What"), h("th", {}, "")),
        f.events.map((e) => h("tr", {},
          h("td", { class: "nowrap" }, when(e.at), h("div", { class: "muted tiny" }, e.ref)),
          h("td", { class: "mono" }, e.ip),
          h("td", {}, h("strong", {}, wafRule(e.rule)), " ", actionPill(e.action), h("div", { class: "muted small fw-detail", title: `${e.detail || ""}\n${e.agent || ""}` }, `${e.method} ${e.target}`, e.detail ? ` · ${e.detail}` : "")),
          h("td", {}, !f.blocked.some((b) => b.ip === e.ip) && e.ip !== f.your_ip && h("button", { class: "btn btn-sm", onclick: quickBlock(e.ip) }, "Block")))))) : h("p", { class: "muted" }, "Nothing yet.")),
    h("section", {}, h("h3", {}, "Settings"),
      h("p", { class: "notice info" }, "Your address now: ", h("strong", { class: "mono" }, f.your_ip), ". It's never blocked while you're signed in as an administrator, and neither are the trusted networks (Settings → Security)."),
      formFor([
        h("div", { class: "field" }, "Mode",
          radio("mode", "block", "On", "Refuses attacks and blocks addresses that keep at it. Recommended.", s.mode === "block"),
          radio("mode", "monitor", "Monitoring only", "Logs what it would refuse and block, without doing it: to try it out first.", s.mode === "monitor"),
          radio("mode", "off", "Off", null, s.mode === "off")),
        h("label", { class: "field short-field" }, "Requests a minute from one address", h("select", { name: "sensitivity" },
          h("option", { value: "normal", selected: s.sensitivity === "normal" }, "Normal: 300 (60 before signing in)"), h("option", { value: "strict", selected: s.sensitivity === "strict" }, "Strict: 150 (25 before signing in)"))),
        h("div", { class: "field" }, "Visitors reach the webmail",
          h("small", {}, "Behind Cloudflare or another proxy, every request comes from the proxy: the firewall needs the visitor's own address, from the proxy's header."),
          ...[["direct", "Directly", null], ["cloudflare", "Through Cloudflare", "Its CF-Connecting-IP header, only from Cloudflare's own addresses."], ["custom", "Through another proxy or load balancer", "Its X-Forwarded-For header."]]
            .map(([v, l, hint]) => { const r = radio("proxy", v, l, hint, s.proxy === v); r.querySelector("input").addEventListener("change", () => { proxyRanges.hidden = v !== "custom"; }); return r; }),
          proxyRanges),
        h("label", { class: "field" }, "Always allow", h("small", {}, "Never refused or blocked: your office, your monitoring service. One address or range a line."), ranges("allow", s.allow, "203.0.113.0/24  # office")),
        h("label", { class: "field" }, "Always block", h("small", {}, "Refused every time."), ranges("deny", s.deny, "")),
        confirmPw()],
      "Save", async (v) => {
        await api("admin/firewall", { method: "POST", body: { mode: v.mode, sensitivity: v.sensitivity, proxy: v.proxy, proxy_ranges: v.proxy_ranges || "", allow: v.allow, deny: v.deny, password: v.password } });
        toast("Saved."); openSettings("admin-firewall");
      }),
      h("p", { class: "muted small" }, "Locked yourself out? On the server: ", h("code", {}, "php security-reset.php"), " clears its blocks and block list.")));
}

const SETTINGS = {
  import: () => importSettings(),
  async account() {
    return h("div", {},
      h("section", {}, h("h3", {}, "You"), h("p", {}, state.user.name, " · ", h("span", { class: "muted" }, state.user.email), " · ", state.user.role === "admin" ? "Administrator" : "User")),
      !state.user.passkeys_only && h("section", {}, h("h3", {}, "Change your password"),
        formFor([h("label", { class: "field" }, "Current password", h("input", { type: "password", name: "current", required: true, autocomplete: "current-password" })),
          h("label", { class: "field" }, "New password (10+ characters)", h("input", { type: "password", name: "new", minlength: 10, required: true, autocomplete: "new-password" }))],
        "Change password", async (v) => { await api("password", { method: "POST", body: v }); toast("Password changed."); })),
      h("section", {}, h("h3", {}, "Undo send"),
        h("p", { class: "muted" }, "After you press Send, the email waits this long before it goes, with Undo to take it back and change it. It's on every device you sign in on."),
        h("label", { class: "field short-field" }, "Wait before sending", h("select", { onchange: async (e) => {
          try { state.prefs = await api("prefs", { method: "POST", body: { undo_send: Number(e.target.value) } }); toast(state.prefs.undo_send ? `Emails wait ${state.prefs.undo_send} seconds before they go.` : "Emails go straight away."); }
          catch (err) { toast(err.message); }
        } }, [0, 5, 10, 20, 30].map((n) => h("option", { value: String(n), selected: Number(state.prefs?.undo_send ?? 10) === n }, n ? `${n} seconds` : "Don't wait (no Undo)"))))),
      h("section", {}, h("h3", {}, "Before sending"),
        h("p", { class: "muted" }, "Questions asked when you press Send, in case something's not right."),
        ...[["attach_check", "Forgotten attachments", "When the email says “see attached”, “I've included…” and the like, but nothing is attached."],
          ["cc_check", "Cc that should be Bcc", "When people outside your organisation who may not know each other are in Cc, and would see each other's addresses."]].map(([k, label, hint]) =>
          h("label", { class: "check address" }, h("input", { type: "checkbox", checked: state.prefs?.[k] !== false, onchange: async (e) => {
            try { state.prefs = await api("prefs", { method: "POST", body: { [k]: e.target.checked } }); toast(e.target.checked ? `${label}: on.` : `${label}: off.`); }
            catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
          } }), h("span", {}, h("strong", {}, label), h("small", { class: "muted" }, hint))))));
  },
  templates: () => templateSettings(),
  rules: () => rulesSettings(),
  async mailboxes() {
    if (!state.mailboxes.length) return h("p", { class: "muted" }, "You don't have a mailbox yet.");
    return h("div", {}, h("p", { class: "muted" }, "Signatures are kept on GhostParse, so they're added to this address's email wherever it's sent from: here, your website or your shop."),
      ...await Promise.all(state.mailboxes.map(signatureSettings)));
  },
  async security() {
    return h("div", {}, sessionList(), !state.user.passkeys_only ? await twoStepSettings() : h("section", {}, h("h3", {}, "Signing in"),
      h("p", { class: "muted" }, "Your organisation signs in with passkeys only: no password. Add one for each device you use (or use one that syncs, like iCloud Keychain or Google Password Manager).")),
    window.Passkeys?.settings?.() || h("section", {}, h("h3", {}, "Passkeys"), h("p", { class: "muted" }, "Not available in this browser.")),
    window.Notifications?.settings?.() || null, window.AppPrompt?.settings?.() || null);
  },
  async "admin-security"() { return securityPolicy(); },
  async "admin-firewall"() { return firewallSettings(); },
  async "admin-users"() {
    const [{ users }, { mailboxes }] = await Promise.all([api("admin/users"), api("admin/mailboxes")]);
    const boxes = (selected) => h("div", {}, mailboxes.map((m) => h("label", { class: "check" }, h("input", { type: "checkbox", name: `mb_${m.id}`, checked: selected.includes(m.id) }), m.address)));
    const pickBoxes = (v) => mailboxes.filter((m) => v[`mb_${m.id}`] === "on").map((m) => m.id);
    const table = h("table", { class: "list" }, h("tr", {}, h("th", {}, "User"), h("th", {}, "Role"), h("th", {}, "Mailboxes"), h("th", {}, "")),
      users.map((u) => h("tr", {}, h("td", {}, u.name, h("div", { class: "muted small" }, u.email), u.disabled && h("span", { class: "pill bad" }, "disabled"),
          !u.two_step && h("span", { class: "pill", title: "Sets it up at their next sign-in" }, "two-step not set up"),
          u.passkeys > 0 && h("span", { class: "pill", title: "Has a passkey" }, icon("shield"), "passkey"),
          u.allowed_ips?.length > 0 && h("span", { class: "pill", title: u.allowed_ips.join(", ") }, "trusted networks only")),
        h("td", {}, u.role), h("td", {}, mailboxes.filter((m) => u.mailbox_ids.includes(m.id)).map((m) => m.address).join(", ") || h("span", { class: "muted" }, "none")),
        h("td", { class: "nowrap" }, h("button", { class: "btn btn-sm", onclick: () => editUser(u) }, "Edit"), " ",
          h("button", { class: "btn btn-sm", title: "Where they're signed in", onclick: () => { body2.replaceChildren(sessionList(u)); body2.scrollIntoView({ behavior: "smooth" }); } },
            `Devices (${u.sessions})`)))));
    const editUser = (u) => {
      const dlg = h("section", {}, h("h3", {}, `Edit ${u.email}`),
        formFor([h("label", { class: "field" }, "Name", h("input", { name: "name", value: u.name })),
          h("label", { class: "field" }, "Role", h("select", { name: "role" }, h("option", { value: "user", selected: u.role === "user" }, "User"), h("option", { value: "admin", selected: u.role === "admin" }, "Administrator"))),
          h("label", { class: "field" }, "New password (leave empty to keep)", h("input", { type: "password", name: "password", minlength: 10, autocomplete: "new-password" })),
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "disabled", checked: u.disabled }), "Can't sign in (disabled)"),
          h("div", { class: "field" }, "Mailboxes", boxes(u.mailbox_ids)),
          h("label", { class: "field" }, "Only from these networks (optional)",
            h("small", {}, "IP addresses or ranges, one a line (203.0.113.0/24, 2001:db8::/32). Empty: wherever Settings → Security allows. Signed in from elsewhere, they're signed out."),
            h("textarea", { name: "allowed_ips", rows: 3, class: "mono-input", placeholder: "203.0.113.0/24  # office" }, (u.allowed_ips || []).join("\n"))),
          u.id !== state.user.id && u.two_step && h("div", { class: "field" }, "Two-step verification",
            h("p", { class: "muted small" }, "Lost their phone? A reset removes their authenticator app, passkeys and recovery codes and signs them out. They set up a new one when they next sign in."),
            h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: async () => {
              if (!confirm(`Reset two-step verification for ${u.email}?`)) return;
              await api("admin/users/mfa-reset", { method: "POST", body: { id: u.id } });
              toast("Reset. They'll set it up again at their next sign-in."); openSettings("admin-users");
            } }, "Reset two-step verification"))],
        "Save", async (v) => {
          await api("admin/users/update", { method: "POST", body: { id: u.id, name: v.name, role: v.role, password: v.password || undefined, disabled: v.disabled === "on", mailbox_ids: pickBoxes(v),
            allowed_ips: v.allowed_ips || "" } });
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
    const { addresses, domains = [] } = await api("admin/addresses");
    const rows = addresses.map((a) => h("tr", {}, h("td", {}, a.address, (!a.inbound_ready || !a.sending_ready) && h("div", { class: "muted small" }, [!a.inbound_ready && "not receiving yet", !a.sending_ready && "not verified for sending"].filter(Boolean).join(" · "))),
      h("td", {}, a.connected ? h("span", { class: "pill" }, "connected") : ""),
      h("td", {}, h("button", { class: "btn btn-sm", onclick: async (e) => {
        e.target.disabled = true;
        try { await api("admin/mailboxes", { method: "POST", body: { address: a.address } }); toast(`${a.address} delivers here now.`); await refreshCounts(); renderShell(); loadList(); openSettings("admin-mailboxes"); } catch (err) { toast(err.message); e.target.disabled = false; }
      } }, a.connected ? "Connect again" : "Connect"))));
    return h("div", {}, domains.length ? receivingSection(domains) : null, h("section", {}, h("h3", {}, "Your GhostParse addresses"),
      h("p", { class: "muted" }, "Connecting an address makes it a mailbox here: it can send and receive, and its webhook is pointed at this webmail. You get access to it; give other users access under Users."),
      addresses.length ? h("table", { class: "list" }, h("tr", {}, h("th", {}, "Address"), h("th", {}, ""), h("th", {}, "")), rows)
        : h("p", {}, domains.length ? "No addresses yet: add one below." : "No addresses yet: add a domain in GhostParse under Domains first.")),
      domains.length ? h("section", {}, h("h3", {}, "Add a new address"),
        h("p", { class: "muted" }, "It's made in your GhostParse account, able to send and receive, and connected here as a mailbox."),
        formFor([h("div", { class: "row" },
          h("label", { class: "field grow" }, "Address", h("input", { name: "local_part", placeholder: "sales", required: true, autocomplete: "off", autocapitalize: "none", spellcheck: "false" })),
          h("label", { class: "field grow" }, "Domain", h("select", { name: "domain_id" }, domains.map((d) => h("option", { value: d.id }, `@${d.name}${d.ready ? "" : " (not receiving yet)"}`)))))],
        "Add address", async (v) => {
          const made = await api("admin/addresses", { method: "POST", body: v });
          toast(`${made.address} delivers here now.`); await refreshCounts(); renderShell(); loadList(); openSettings("admin-mailboxes");
        })) : null);
  },
  /** GDPR data requests: find and export everything about one person, here or from another system with a key. */
  async "admin-data-requests"() {
    const { data_requests: requests, keys } = await api("admin/data-requests");
    const again = () => openSettings("admin-data-requests");
    const when = (iso) => iso ? new Date(iso).toLocaleString() : "";
    const status = (r) => r.status === "searching" ? h("span", { class: "pill" }, `searching ${r.progress.total ? Math.floor(100 * r.progress.scanned / r.progress.total) : 0}%`)
      : r.status === "ready" ? h("span", { class: "pill" }, `${r.matches} email${r.matches === 1 ? "" : "s"}`) : h("span", { class: "pill", title: "The results have been removed; the record stays" }, "results removed");
    const actions = (r) => h("td", {},
      r.status === "searching" && h("button", { class: "btn btn-sm", onclick: async (e) => { e.target.disabled = true; await api("admin/data-requests/one", { query: { id: r.id } }).catch((err) => toast(err.message)); again(); } }, "Carry on"),
      r.status === "ready" && h("a", { class: "btn btn-sm", href: `api.php?${new URLSearchParams({ a: "admin/data-requests/export", id: r.id })}`, download: "" }, "Download ZIP"),
      r.status === "ready" && h("button", { class: "btn btn-sm", onclick: async () => {
        if (!confirm("Remove these results now? The record of the request stays.")) return;
        await api("admin/data-requests/discard", { method: "POST", body: { id: r.id } }); again();
      } }, "Remove results"));
    const list = requests.length ? h("table", { class: "list" }, h("tr", {}, h("th", {}, "Person"), h("th", {}, "Asked"), h("th", {}, "Found"), h("th", {}, "")),
      requests.map((r) => h("tr", {},
        h("td", {}, r.email, r.terms.length ? h("div", { class: "muted small" }, `and ${r.terms.map((t) => `“${t}”`).join(", ")}`) : null, r.reference && h("div", { class: "muted small" }, `Ref: ${r.reference}`)),
        h("td", {}, when(r.created_at), h("div", { class: "muted small" }, r.requested_by.key ? `API key: ${r.requested_by.key}` : r.requested_by.user || ""),
          r.downloads ? h("div", { class: "muted small" }, `Downloaded ${when(r.last_downloaded_at)}`) : null),
        h("td", {}, status(r)), actions(r))))
      : h("p", { class: "muted" }, "No requests yet.");
    const newKey = h("div");
    const keyList = keys.length ? h("table", { class: "list" }, h("tr", {}, h("th", {}, "Key"), h("th", {}, "Last used"), h("th", {}, "")),
      keys.map((k) => h("tr", {}, h("td", {}, k.name, h("div", { class: "muted small" }, k.hint, k.allowed_ips.length ? ` · only from ${k.allowed_ips.join(", ")}` : "")),
        h("td", {}, k.last_used_at ? when(k.last_used_at) : h("span", { class: "muted" }, "never")),
        h("td", {}, h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
          if (!confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return;
          await api("admin/data-requests/keys/revoke", { method: "POST", body: { id: k.id } }); again();
        } }, "Revoke")))))
      : h("p", { class: "muted" }, "No keys yet.");
    const endpoint = new URL("api.php", location.href).href;
    return h("div", {},
      h("section", {}, h("h3", {}, "Find everything about one person"),
        h("p", { class: "muted" }, "For a GDPR subject access request. Every mailbox and folder is searched (Trash, Spam and Drafts too): email the address sent or received, and email that mentions the address or the other terms. The ZIP has each email with its attachments, a spreadsheet of them, the person's address book entries and your team's notes on those conversations. Check it before sending: the emails may hold other people's personal data."),
        formFor([h("label", { class: "field" }, "Their email address", h("input", { type: "email", name: "email", required: true, autocomplete: "off" })),
          h("label", { class: "field" }, "Also look for (optional, one per line: their name, phone number, customer number)", h("textarea", { name: "terms", rows: 3 })),
          h("label", { class: "field" }, "Your reference (optional)", h("input", { name: "reference", maxlength: 200, placeholder: "e.g. the ticket number" })),
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "include_attachments", checked: true }), "Include attachments")],
        "Search", async (v) => {
          const r = await api("admin/data-requests", { method: "POST", body: { email: v.email, reference: v.reference || undefined,
            terms: (v.terms || "").split("\n").map((t) => t.trim()).filter(Boolean), include_attachments: v.include_attachments === "on" } });
          toast(r.status === "ready" ? `Found ${r.matches} email${r.matches === 1 ? "" : "s"}.` : "Searching: a big mailbox takes a few steps. Press Carry on to continue.");
          again();
        })),
      h("section", {}, h("h3", {}, "Requests"), list,
        h("p", { class: "muted small" }, "Results are kept for 30 days, then removed. The record of each request stays.")),
      h("section", {}, h("h3", {}, "From another system"),
        h("p", { class: "muted" }, "Your CRM, help desk or website can start a request itself (a “GDPR request” button) and download the ZIP, with a key made here. ",
          "POST ", h("code", {}, `${endpoint}?a=data-requests`), " with ", h("code", {}, `{"email": "…"}`), " and the header ", h("code", {}, "Authorization: Bearer wmk_…"), ". The README has the details."),
        keyList, newKey,
        formFor([h("div", { class: "row" },
            h("label", { class: "field grow" }, "Name (the system that will use it)", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Our CRM" })),
            h("label", { class: "field grow" }, "Only from these IP addresses (optional)", h("input", { name: "ips", placeholder: "203.0.113.10, 2001:db8::1" }))),
          confirmPw()],
        "Make a key", async (v) => {
          const k = await api("admin/data-requests/keys", { method: "POST", body: { name: v.name, password: v.password, allowed_ips: (v.ips || "").split(/[\s,]+/).filter(Boolean) } });
          newKey.replaceChildren(h("div", { class: "notice ok" }, h("p", {}, h("strong", {}, "Copy this key now: it isn't shown again.")), h("p", {}, h("code", { class: "secret" }, k.key)),
            h("button", { type: "button", class: "btn btn-sm", onclick: async () => { try { await navigator.clipboard.writeText(k.key); toast("Copied."); } catch { toast("Select the key and copy it."); } } }, "Copy")));
        })));
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
  if (!$shell || e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay:not([hidden]), .pop-menu")) return;
  if (state.folder === "contacts" && !["c", "/"].includes(e.key)) return; // mail shortcuts don't apply to contacts
  const idx = state.messages.findIndex((m) => m.id === state.selected);
  if (e.key === "c") { e.preventDefault(); compose(); }
  else if (e.key === "/") { e.preventDefault(); $search.focus(); }
  else if (e.key === "j" && state.messages[idx + 1]) openMessage(state.messages[idx + 1].id);
  else if (e.key === "k" && idx > 0) openMessage(state.messages[idx - 1].id);
  else if (current && e.key === "r") compose({ mode: "reply", of: last() });
  else if (current && e.key === "f") compose({ mode: "forward", of: last() });
  else if (current && e.key === "e") $reader.querySelector('[aria-label="Archive"]')?.click();
  else if (current && e.key === "b") $reader.querySelector('[aria-label="Snooze"]')?.click();
  else if (current && e.key === "l") $reader.querySelector('[aria-label="Labels"]')?.click();
  else if (current && e.key === "#") $reader.querySelector('[aria-label="Delete"]')?.click();
  else if (current && e.key === "i") $reader.querySelector(".customer-toggle")?.click();
  else if (e.key === "Escape" && current) closeReader();
});

// New mail: check every 30 seconds while the page is open and visible.
setInterval(() => { if ($shell && document.visibilityState === "visible" && !document.querySelector(".overlay:not([hidden])")) refresh(); }, 30000);
document.addEventListener("visibilitychange", () => { if ($shell && document.visibilityState === "visible") refresh(); });

/** The last DNS check per domain, so its answer stays on screen when the page is drawn again. */
const lastMxCheck = {};
/**
 * Whether each domain can receive: receiving switched on at GhostParse, and its MX record sending email there first.
 * Turns receiving on from here, shows the MX record to add, and checks the DNS again on request.
 */
function receivingSection(domains) {
  const again = () => openSettings("admin-mailboxes");
  const mxTable = (d) => d.mx && h("table", { class: "list dns-record" },
    h("tr", {}, h("th", {}, "Type"), h("th", {}, "Host"), h("th", {}, "Priority"), h("th", {}, "Points to")),
    h("tr", {}, h("td", {}, "MX"), h("td", { class: "mono" }, d.mx.host), h("td", {}, String(d.mx.priority)), h("td", { class: "mono" }, d.mx.value)));
  const checked = (d) => {
    const mx = lastMxCheck[d.id];
    return mx && !mx.ok && h("div", { class: "notice warn small mx-check" }, h("strong", {}, "Checked just now: "), mx.error || "The MX record isn't there yet.",
      mx.found?.length ? h("div", {}, "Found: ", h("span", { class: "mono" }, mx.found.join(", "))) : null,
      h("div", { class: "muted" }, "DNS changes can take a few minutes to an hour to show."));
  };
  const button = (d, label, path, done, primary = true) => h("button", { class: primary ? "btn btn-primary btn-sm" : "btn btn-sm", onclick: async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(path, { method: "POST", body: { domain_id: d.id } });
      lastMxCheck[d.id] = r.mx;
      if (r.domain?.ready) toast(`${d.name} receives email here now.`); else if (done) toast(done);
      again();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  } }, label);
  const card = (d) => {
    if (d.ready) return h("div", { class: "notice ok receiving" }, icon("check"), ` ${d.name} receives email here.`);
    if (!d.receiving) return h("div", { class: "notice warn receiving" },
      h("p", {}, h("strong", {}, `Receiving is off for ${d.name}`), ` at GhostParse, so email to its addresses is turned away${d.mailboxes ? ", including the mailboxes here" : ""}.`),
      h("div", { class: "row" }, button(d, "Turn on receiving", "admin/domains/receiving", `Receiving is on for ${d.name}.`)));
    if (!d.mx_ok) return h("div", { class: "notice warn receiving" },
      h("p", {}, h("strong", {}, `${d.name}'s email doesn't come to GhostParse yet.`), " Add this record where its DNS is managed:"), mxTable(d),
      h("p", { class: "small" }, `Then remove ${d.name}'s other MX records. Email goes to the lowest priority number first, so with another server ahead of GhostParse it never arrives here. To keep email for ${d.name} where it is now, receive here on a subdomain instead (such as inbound.${d.name}).`),
      checked(d), h("div", { class: "row" }, button(d, "Check again", "admin/domains/verify", null, false)));
    return h("div", { class: "notice receiving" }, `${d.name} is ready to receive: connect one of its addresses below.`);
  };
  return h("section", {}, h("h3", {}, "Receiving email"), ...domains.map(card));
}

window.Webmail = { api, h, icon, toast, state, start, openMessage, refresh, openFolder, replyTo,
  openCalendar: (opts = {}) => {
    state.folder = "calendar"; state.label = 0; state.query = ""; $search.value = "";
    $shell.classList.remove("menu", "reading"); renderFolders(); window.Calendar?.showCalendar(opts);
  } };
start();
