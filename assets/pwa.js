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
    if (e.data?.open) location.href = e.data.open;
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
window.Notifications = {
  available: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext,

  afterSignIn(session) {
    vapidKey = session.app?.vapid_public_key || null;
    // Opened from a notification: show that message.
    const m = /^#m=(\d+)$/.exec(location.hash);
    if (m) { history.replaceState(null, "", location.pathname); window.Webmail.openMessage(Number(m[1])); }
    if (location.hash === "#compose") { history.replaceState(null, "", location.pathname); document.querySelector(".compose-btn")?.click(); }
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
