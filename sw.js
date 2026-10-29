// The service worker: the app opens without a connection, recently read mail stays readable offline, and new-mail
// notifications arrive even when the webmail isn't open.
"use strict";

const VERSION = "wm-1.8.3";
const SHELL = `${VERSION}-shell`;
const MAIL = `${VERSION}-mail`;
const SHELL_FILES = ["./", "assets/app.css?v=1.8.3", "assets/app.js?v=1.8.3", "assets/pwa.js?v=1.8.3", "assets/icons/icon.svg", "assets/icons/icon-192.png", "manifest.php"];
// API reads worth keeping for offline: the session, the lists and the messages you open.
const OFFLINE_READS = new Set(["session", "messages", "message", "body", "contacts", "book"]);

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

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "New email" }; }
  event.waitUntil(self.registration.showNotification(data.title || "New email", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "assets/icons/icon-192.png",
    badge: "assets/icons/badge-96.png",
    data: { url: data.url || "./" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { w.postMessage({ open: target }); return w.focus(); }
    }
    return self.clients.openWindow(target);
  }));
});
