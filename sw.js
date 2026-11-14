// The service worker: the app opens without a connection, recently read mail stays readable offline, and new-mail
// notifications arrive even when the webmail isn't open.
"use strict";

// Drafts kept on the device, finished saving here in the background (Background Sync).
importScripts("assets/drafts.js?v=1.27.0");

const VERSION = "wm-1.27.0";
const SHELL = `${VERSION}-shell`;
const MAIL = `${VERSION}-mail`;
const SHELL_FILES = ["./", "assets/app.css?v=1.27.0", "assets/app.js?v=1.27.0", "assets/calendar.js?v=1.27.0", "assets/files.js?v=1.27.0", "assets/pwa.js?v=1.27.0", "assets/drafts.js?v=1.27.0", "assets/icons/icon.svg", "assets/icons/icon-192.png", "manifest.php"];
// API reads worth keeping for offline: the session, the lists and the messages you open.
const OFFLINE_READS = new Set(["session", "messages", "message", "body", "contacts", "book", "calendar", "calendar/events"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Shared from another app to the installed webmail (Share → the webmail): the files wait here until the app,
  // opened at #files-shared, uploads them to Files. Nothing leaves the device until then.
  if (req.method === "POST" && url.origin === location.origin && url.searchParams.has("share-target")) {
    event.respondWith((async () => {
      const form = await req.formData();
      const cache = await caches.open("wm-share-target");
      let n = 0;
      for (const f of form.getAll("files")) {
        if (!(f instanceof File)) continue;
        await cache.put(new Request(`share-target-file?n=${Date.now()}-${n++}&name=${encodeURIComponent(f.name)}`), new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }));
      }
      return Response.redirect(new URL("./#files-shared", self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);

  if (path === "api.php") {
    const action = url.searchParams.get("a") || "";
    if (action === "attachment" || !OFFLINE_READS.has(action)) return;
    // Fresh when online; the last copy when not.
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(MAIL).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.open(MAIL).then((c) => c.match(req)).then((hit) => hit || offlineJson())));
    return;
  }
  if (req.mode === "navigate") {
    if (path !== "" && path !== "index.php") return; // the installer and other pages go straight to the server
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put("./", copy)); }
      return res;
    }).catch(() => caches.match("./")));
    return;
  }
  if (path.startsWith("assets/") || path === "manifest.php") {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

function offlineJson() {
  return new Response(JSON.stringify({ error: "offline", message: "You're offline, and this hasn't been opened on this device before." }),
    { status: 503, headers: { "Content-Type": "application/json" } });
}

// Sign-out: forget the mail kept for offline reading.
self.addEventListener("message", (event) => {
  if (event.data === "signed-out") event.waitUntil(caches.delete(MAIL));
});

// Back online (Chrome, Edge, Android): drafts typed offline are saved to the server's Drafts folder. If some still
// can't be, the browser tries again later.
self.addEventListener("sync", (event) => {
  if (event.tag !== "drafts") return;
  event.waitUntil((async () => {
    const s = await LocalDrafts.session().catch(() => null);
    if (!s) return; // signed out: the webmail saves them after the next sign-in
    await LocalDrafts.syncAll(s.user, s.csrf);
    const left = (await LocalDrafts.all()).filter((r) => r.user === s.user && r.dirty).length;
    if (left) throw new Error(`${left} drafts still to save`);
  })());
});

/** The app icon's badge: the unread count GhostParse's push says, where the device shows badges. */
function setBadge(n) {
  if (typeof n !== "number" || !self.navigator.setAppBadge) return Promise.resolve();
  return (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
}

/**
 * New-mail notifications have buttons that work without opening the app: Mark as read, Reply (typed right in the
 * notification where the system offers that: Chrome and Edge on Windows, Mac, Linux and Android) and, where there's room
 * for a third, Archive. Elsewhere Reply opens the reply window. iPhone and iPad don't show notification buttons yet:
 * there, tapping the notification opens the email as before.
 */
function mailActions() {
  const max = self.Notification?.maxActions ?? 2;
  const actions = [{ action: "read", title: "Mark as read" }, { action: "reply", title: "Reply", type: "text", placeholder: "Write a reply…" }];
  if (max >= 3) actions.push({ action: "archive", title: "Archive" });
  return actions.slice(0, Math.max(0, max));
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "New email" }; }
  const mail = !!(data.token && data.message_id);
  event.waitUntil(Promise.all([setBadge(data.unread), self.registration.showNotification(data.title || "New email", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "assets/icons/icon-192.png",
    badge: "assets/icons/badge-96.png",
    actions: mail ? mailActions() : [],
    data: { url: data.url || "./", message_id: mail ? data.message_id : null, token: mail ? data.token : null },
  })]));
});

/** Open the webmail at a page (#m=…, #reply=…), in a window that's open already if there is one. */
function openApp(url) {
  const target = new URL(url || "./", self.registration.scope).href;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { w.postMessage({ open: target }); return w.focus(); }
    }
    return self.clients.openWindow(target);
  });
}

/** A notification button, done on the server with the notification's own token. Returns the answer, or throws. */
async function notificationAction(data, action, text) {
  const res = await fetch(new URL("api.php?a=push/action", self.registration.scope).href, {
    method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: data.token, action, text }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.message || `Error ${res.status}`), { status: res.status });
  return out;
}

/** A short note in place of the notification ("Reply sent"), gone after a few seconds where the system allows. */
async function note(tag, title, body, url) {
  await self.registration.showNotification(title, { body, tag, icon: "assets/icons/icon-192.png", badge: "assets/icons/badge-96.png", silent: true, data: { url } });
  if (!url) {
    await new Promise((r) => setTimeout(r, 4000));
    (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
  }
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  const id = data.message_id;
  if (!event.action || !id || !data.token) { event.waitUntil(openApp(data.url)); return; }
  const reply = typeof event.reply === "string" ? event.reply.trim() : "";
  // Reply where the notification has no box to type in: the reply window, ready to write.
  if (event.action === "reply" && !reply) { event.waitUntil(openApp(`./#reply=${id}`)); return; }
  event.waitUntil((async () => {
    try {
      const out = await notificationAction(data, event.action, reply);
      await setBadge(out.unread);
      if (event.action === "reply") await note(n.tag || `m${id}`, "Reply sent", reply.slice(0, 120));
    } catch (err) {
      // Too old, signed out, or no connection: the webmail does it instead (a typed reply is kept, ready to send).
      if (event.action === "reply") {
        const why = err.status ? err.message : "No connection";
        await note(n.tag || `m${id}`, "Reply not sent", `${why}. Tap to send it from the webmail: what you wrote is kept.`, `./#reply=${id}&text=${encodeURIComponent(reply)}`);
      } else {
        await openApp(`./#m=${id}`);
      }
    }
  })());
});
