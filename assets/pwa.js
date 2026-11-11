// The app-like parts: installing the service worker, passkeys (Face ID, Touch ID, Windows Hello, fingerprint) and
// new-mail notifications. app.js asks window.Passkeys and window.Notifications for their buttons and settings.
"use strict";

const b64u = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
};

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* the app works without it */ });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (!e.data?.open) return;
    // A link from a notification to this page (#m=…, #reply=…): followed without reloading, once signed in.
    const url = new URL(e.data.open);
    if (url.origin === location.origin && url.pathname === location.pathname && window.Webmail?.state?.user) {
      history.replaceState(null, "", url.pathname + url.hash);
      window.Notifications?.followHash?.();
    } else location.href = e.data.open;
  });
}

// ------------------------------------------------------------------------------------------------ passkeys
window.Passkeys = {
  available: () => !!window.PublicKeyCredential && window.isSecureContext,

  /** What to call it here: on Apple devices people know it as Face ID or Touch ID. */
  label() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "Sign in with Face ID";
    if (/iPad|Macintosh/.test(ua)) return "Sign in with Touch ID or Face ID";
    if (/Windows/.test(ua)) return "Sign in with Windows Hello";
    if (/Android/.test(ua)) return "Sign in with your fingerprint";
    return "Sign in with a passkey";
  },

  /** This device has signed in with a passkey before (not a secret: it only decides which button comes first). */
  usedHere() {
    try { return localStorage.getItem("wm.passkey") === "1"; } catch { return false; }
  },
  rememberHere() {
    try { localStorage.setItem("wm.passkey", "1"); } catch { /* private browsing: fine */ }
  },

  /** The passkey button on the sign-in page; first and blue on a device that has used one. */
  loginButton(errorEl) {
    if (!this.available()) return null;
    const { h, icon } = window.Webmail;
    const btn = h("button", { type: "button", class: this.usedHere() ? "btn btn-primary" : "btn", onclick: async () => {
      btn.disabled = true;
      errorEl.textContent = "";
      try {
        await this.login();
        await window.Webmail.start();
      } catch (err) {
        errorEl.textContent = err.name === "NotAllowedError" ? "Passkey sign-in was cancelled." : err.message;
        btn.disabled = false;
      }
    } }, icon("shield"), this.label());
    return btn;
  },

  /**
   * The sign-in page offers the passkey by itself: in the keyboard's suggestions when the email box is tapped (where
   * the browser supports it), and, in the installed app on a device that has used a passkey, straight away.
   */
  async offer({ prompt = true } = {}) {
    if (!this.available()) return;
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (prompt && standalone && this.usedHere()) {
      try {
        await this.login();
        await window.Webmail.start();
        return;
      } catch {
        // Not now (the browser may want a tap first, or it was cancelled): the button is there.
      }
    }
    try {
      if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
      await this.login({ conditional: true });
      await window.Webmail.start();
    } catch {
      // Offered, not asked for: nothing to report. The button says what's wrong if someone uses it.
    }
  },

  /** Only one passkey request at a time: a new one (the button) cancels the waiting keyboard suggestion. */
  pending: null,

  async login({ conditional = false } = {}) {
    const { api } = window.Webmail;
    this.pending?.abort();
    const ctl = new AbortController();
    this.pending = ctl;
    const o = await api("passkey/login/options");
    const cred = await navigator.credentials.get({
      publicKey: { challenge: b64u.decode(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout },
      signal: ctl.signal, ...(conditional ? { mediation: "conditional" } : {}),
    });
    if (this.pending === ctl) this.pending = null;
    const r = cred.response;
    // Sign-in has no CSRF token yet; the signature over the challenge is what proves it.
    const done = await api("passkey/login", { method: "POST", body: { id: b64u.encode(cred.rawId), clientDataJSON: b64u.encode(r.clientDataJSON),
      authenticatorData: b64u.encode(r.authenticatorData), signature: b64u.encode(r.signature), userHandle: r.userHandle ? b64u.encode(r.userHandle) : null } });
    this.rememberHere();
    return done;
  },

  /** A passkey's answer to a new challenge, to confirm a sensitive change (passkeys only: no password). */
  async assertion() {
    const { api } = window.Webmail;
    const o = await api("passkey/login/options");
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64u.decode(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout } });
    const r = cred.response;
    return { id: b64u.encode(cred.rawId), clientDataJSON: b64u.encode(r.clientDataJSON), authenticatorData: b64u.encode(r.authenticatorData),
      signature: b64u.encode(r.signature), userHandle: r.userHandle ? b64u.encode(r.userHandle) : null };
  },

  async register(name) {
    const { api } = window.Webmail;
    const o = await api("passkey/register/options");
    const cred = await navigator.credentials.create({ publicKey: {
      ...o, challenge: b64u.decode(o.challenge), user: { ...o.user, id: b64u.decode(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: b64u.decode(c.id) })),
    } });
    const done = await api("passkey/register", { method: "POST", body: { name, clientDataJSON: b64u.encode(cred.response.clientDataJSON), attestationObject: b64u.encode(cred.response.attestationObject) } });
    this.rememberHere();
    return done;
  },

  /** The Passkeys section in Settings. */
  settings() {
    const { h, api, toast } = window.Webmail;
    const box = h("section", {}, h("h3", {}, "Passkeys"));
    if (!this.available()) {
      box.append(h("p", { class: "muted" }, "This browser can't use passkeys here. They need a recent browser and the webmail on https://."));
      return box;
    }
    const list = h("div", { class: "passkeys" }, h("p", { class: "muted" }, "Loading…"));
    const guess = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone or iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : /Android/.test(navigator.userAgent) ? "Android phone" : /Windows/.test(navigator.userAgent) ? "Windows PC" : "This device";
    const load = async () => {
      const { passkeys } = await api("passkey/list");
      list.replaceChildren(...(passkeys.length ? passkeys.map((p) => h("div", { class: "row between" },
        h("div", {}, h("strong", {}, p.name), h("div", { class: "muted small" }, `Added ${new Date(p.created_at).toLocaleDateString()}`, p.last_used_at ? ` · last used ${new Date(p.last_used_at).toLocaleDateString()}` : "")),
        h("button", { class: "btn btn-sm", onclick: async () => { if (!confirm(`Remove “${p.name}”? You won't be able to sign in with it.`)) return; await api("passkey/delete", { method: "POST", body: { id: p.id } }); load(); } }, "Remove")))
        : [h("p", { class: "muted" }, "You haven't added a passkey yet.")]));
    };
    const add = h("button", { class: "btn btn-primary", onclick: async () => {
      const name = prompt("Name this passkey", guess);
      if (name === null) return;
      add.disabled = true;
      try { await this.register(name); toast("Passkey added. Next time, sign in with it."); load(); } catch (err) { toast(err.name === "NotAllowedError" ? "Cancelled." : err.message); }
      add.disabled = false;
    } }, "Add a passkey");
    box.append(h("p", { class: "muted" }, "Sign in with Face ID, Touch ID, Windows Hello or your fingerprint instead of typing your password. Your fingerprint or face never leaves your device."), list, add);
    load().catch((err) => list.replaceChildren(h("p", { class: "error" }, err.message)));
    return box;
  },
};

// ------------------------------------------------------------------------------------------------ notifications
let vapidKey = null;
// A notification link followed while the webmail is open (only the # part changes, so the page doesn't reload).
addEventListener("hashchange", () => { if (window.Webmail?.state?.user) window.Notifications?.followHash?.(); });
window.Notifications = {
  available: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext,

  afterSignIn(session) {
    vapidKey = session.app?.vapid_public_key || null;
    this.followHash();
    window.AppPrompt?.schedule();
  },

  /**
   * Opened from a notification: #m=<id> shows that email, #reply=<id> opens a reply to it (with &text=… a reply typed
   * in the notification that couldn't be sent from there), #compose a new email, #scheduled the Scheduled folder,
   * #calendar the calendar and #event=<id>:<when> an event (from a reminder).
   */
  followHash() {
    const hash = location.hash;
    if (!/^#(m=|reply=|compose$|scheduled$|calendar$|event=)/.test(hash)) return;
    history.replaceState(null, "", location.pathname);
    const p = new URLSearchParams(hash.slice(1));
    if (p.has("m")) window.Webmail.openMessage(Number(p.get("m")));
    else if (p.has("reply")) window.Webmail.replyTo(Number(p.get("reply")), p.get("text") || "");
    else if (hash === "#compose") document.querySelector(".compose-btn")?.click();
    else if (hash === "#scheduled") window.Webmail.openFolder("scheduled");
    else if (hash === "#calendar") window.Webmail.openCalendar();
    else if (p.has("event")) {
      // A calendar reminder: #event=<id>:<occurrence>.
      const [id, occurrence] = p.get("event").split(/:(.*)/s);
      window.Webmail.openCalendar({ eventId: Number(id), occurrence: occurrence || null });
    }
  },

  async subscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  },

  async enable() {
    const { api } = window.Webmail;
    if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked. Allow them in your browser's site settings.");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.decode(vapidKey) });
    await api("push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
  },

  async disable() {
    const sub = await this.subscription();
    if (!sub) return;
    await window.Webmail.api("push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  },

  /** The Notifications section in Settings. */
  settings() {
    const { h, api, toast } = window.Webmail;
    const box = h("section", {}, h("h3", {}, "New-mail notifications"));
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) {
      box.append(h("p", { class: "muted" }, "On iPhone and iPad, add the webmail to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on in Settings."));
      return box;
    }
    if (!this.available() || !vapidKey) {
      box.append(h("p", { class: "muted" }, "This browser can't show notifications from the webmail. They need a recent browser and the webmail on https://."));
      return box;
    }
    const state = h("p", { class: "muted" }, "Checking…");
    const actions = h("div", { class: "row" });
    const render = async () => {
      const sub = await this.subscription();
      state.textContent = sub ? "On for this device. You'll be told about new email in your inbox, even when the webmail is closed." : "Off for this device.";
      actions.replaceChildren(...[sub
        ? h("button", { class: "btn", onclick: async () => { await this.disable(); toast("Notifications are off for this device."); render(); } }, "Turn off")
        : h("button", { class: "btn btn-primary", onclick: async () => { try { await this.enable(); toast("Notifications are on."); } catch (err) { toast(err.message); } render(); } }, "Turn on"),
      sub && h("button", { class: "btn", onclick: async () => { const r = await api("push/test", { method: "POST" }); toast(r.sent ? "Sent a test notification." : "The test didn't go through. Turn notifications off and on again."); } }, "Send a test")].filter(Boolean));
    };
    box.append(state, actions);
    render().catch((err) => { state.textContent = err.message; });
    return box;
  },
};

// ------------------------------------------------------------------------------------- suggesting the app and notifications
// Chrome, Edge and Android offer installing through their own event, saved for the Install button. Safari on iPhone and iPad
// has no such event: there, the suggestion shows how to add the webmail to the Home Screen, which iOS needs for notifications.
let installEvent = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });
addEventListener("appinstalled", () => { installEvent = null; window.AppPrompt?.hide(); });

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const onPhone = () => matchMedia("(max-width: 900px)").matches;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private browsing: it just asks again */ } },
};
const DAY = 86400000;
/** "Not now" waits longer each time: 3 days, then 2 weeks, then a month, and after the third it stops asking on this device. */
const SNOOZE_DAYS = [3, 14, 30];

window.AppPrompt = {
  el: null,

  /** Called once the inbox is on screen. Waits a few seconds, so it never greets someone the moment they sign in. */
  schedule(delay = 6000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show().catch(() => {}), delay);
  },

  snoozed(kind) {
    const s = store.get(`wm.prompt.${kind}`);
    return !!s && (s.count >= SNOOZE_DAYS.length || Date.now() < s.until);
  },

  canInstall() { return !standalone() && (!!installEvent || appleMobile()); },

  async wantsNotifications() {
    if (!window.Notifications?.available() || !vapidKey || Notification.permission === "denied") return false;
    return !(await window.Notifications.subscription());
  },

  /** What to suggest on this device now, if anything. On a phone the app comes first (iOS needs it for notifications). */
  async next() {
    if (window.Webmail?.state?.prefs?.app_prompts === false) return null;
    const install = this.canInstall() && !this.snoozed("install");
    const notify = !this.snoozed("notify") && await this.wantsNotifications();
    if (onPhone() || appleMobile()) return install ? "install" : notify ? "notify" : null;
    return notify ? "notify" : install ? "install" : null;
  },

  async show() {
    if (this.el || document.hidden || document.querySelector(".overlay")) { if (!this.el) this.schedule(20000); return; }
    const kind = await this.next();
    if (!kind) return;
    const { h, icon, state } = window.Webmail;
    const name = state.appInfo?.name || "the webmail";
    const ios = appleMobile() && !installEvent;
    const copy = kind === "notify"
      ? { icon: "bell", title: "Know when email arrives", text: "Get a notification for new email in your inbox, even when the webmail is closed. You can turn it off any time in Settings.", go: "Turn on" }
      : ios
        ? { icon: "homeAdd", title: `Add ${name} to your Home Screen`, text: "It opens like an app, full screen, and it's how iPhone and iPad allow notifications for new email.", go: "Show me how" }
        : { icon: "download", title: `Install ${name}`, text: onPhone() ? "Open it from your home screen like an app, with notifications for new email." : "Open it in its own window, from your dock or taskbar, with notifications for new email.", go: "Install" };
    const body = h("div", { class: "app-prompt-body" }, h("strong", {}, copy.title), h("p", {}, copy.text));
    const actions = h("div", { class: "app-prompt-actions" },
      h("button", { class: "btn btn-primary", onclick: () => this.accept(kind, body, actions) }, copy.go),
      h("button", { class: "btn", onclick: () => this.notNow(kind) }, "Not now"));
    body.append(actions);
    this.el = h("aside", { class: "app-prompt", role: "dialog", "aria-label": copy.title },
      h("span", { class: "app-prompt-icon" }, icon(copy.icon)), body,
      h("button", { class: "icon-btn app-prompt-close", title: "Not now", "aria-label": "Not now", onclick: () => this.notNow(kind) }, icon("close")));
    document.body.append(this.el);
    requestAnimationFrame(() => this.el?.classList.add("in"));
  },

  hide() {
    const el = this.el;
    this.el = null;
    if (!el) return;
    el.classList.remove("in");
    setTimeout(() => el.remove(), 250);
  },

  notNow(kind) {
    const s = store.get(`wm.prompt.${kind}`) || { count: 0 };
    s.until = Date.now() + SNOOZE_DAYS[Math.min(s.count, SNOOZE_DAYS.length - 1)] * DAY;
    s.count += 1;
    store.set(`wm.prompt.${kind}`, s);
    this.hide();
  },

  async accept(kind, body, actions) {
    const { toast } = window.Webmail;
    if (kind === "notify") {
      this.hide();
      try { await window.Notifications.enable(); toast("Notifications are on for this device."); }
      catch (err) { toast(err.message); }
      return;
    }
    if (installEvent) {
      const ev = installEvent;
      installEvent = null; // each one can only be used once
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === "accepted") this.hide(); else this.notNow("install");
      return;
    }
    // iPhone and iPad: the steps, in place of the buttons.
    actions.replaceWith(this.iosSteps(() => this.notNow("install")));
  },

  /** How to add the webmail to the Home Screen in Safari (and Chrome, which has the same Share menu on iOS). */
  iosSteps(done) {
    const { h, icon, state } = window.Webmail;
    const name = state.appInfo?.name || "the webmail";
    return h("div", { class: "ios-steps" },
      h("ol", {},
        h("li", {}, "Tap ", h("span", { class: "ios-key" }, icon("share"), "Share"), " in the toolbar (at the top in Chrome)."),
        h("li", {}, "Scroll down and tap ", h("span", { class: "ios-key" }, icon("homeAdd"), "Add to Home Screen"), ", then Add."),
        h("li", {}, `Open ${name} from your Home Screen, sign in, and turn on notifications when it asks.`)),
      done && h("button", { class: "btn", onclick: done }, "Done"));
  },

  /** The "Use it like an app" section in Settings, with the same suggestions and the switch to stop them. */
  settings() {
    const { h, api, toast, state } = window.Webmail;
    const box = h("section", {}, h("h3", {}, "Use it like an app"));
    if (standalone()) box.append(h("p", { class: "muted" }, "You're using the installed app on this device."));
    else if (installEvent) {
      box.append(h("p", { class: "muted" }, "Install the webmail to open it in its own window or from your home screen, like an app."),
        h("div", { class: "row" }, h("button", { class: "btn btn-primary", onclick: async () => {
          const ev = installEvent;
          if (!ev) return toast("Use your browser's menu to install it.");
          installEvent = null;
          await ev.prompt();
          if ((await ev.userChoice).outcome === "accepted") toast("Installed.");
        } }, "Install")));
    } else if (appleMobile()) box.append(h("p", { class: "muted" }, "Add the webmail to your Home Screen: it opens like an app, and it's how iPhone and iPad allow notifications."), this.iosSteps());
    else box.append(h("p", { class: "muted" }, "If your browser can install web apps, its menu (or an icon in the address bar) offers to install the webmail."));
    box.append(h("label", { class: "check address" }, h("input", { type: "checkbox", checked: state.prefs?.app_prompts !== false, onchange: async (e) => {
      try {
        state.prefs = await api("prefs", { method: "POST", body: { app_prompts: e.target.checked } });
        if (!e.target.checked) this.hide();
        toast(e.target.checked ? "We'll suggest the app and notifications where they're not set up." : "No more suggestions.");
      } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    } }), h("span", {}, h("strong", {}, "Suggest the app and notifications"),
      h("small", { class: "muted" }, "Now and then, on a device where the app isn't installed or notifications aren't on. It's for all your devices."))));
    return box;
  },
};
