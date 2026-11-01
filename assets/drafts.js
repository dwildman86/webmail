// Drafts kept on this device (IndexedDB) as you type, so a crash, a closed tab or a lost connection doesn't lose them,
// and saved to the server's Drafts folder when there's a connection. Used by the page (assets/app.js) and by the
// service worker (sw.js), which finishes saving them in the background (Background Sync, where the browser has it).
"use strict";

(function (global) {
  const DB = "webmail-local";
  const STORE = "drafts";
  // Drafts on the device are forgotten after this long (they're on the server by then, or abandoned).
  const KEEP_MS = 30 * 24 * 3600 * 1000;
  let opening = null;

  function open() {
    if (!global.indexedDB) return Promise.reject(new Error("no IndexedDB"));
    opening ??= new Promise((resolve, reject) => {
      const req = global.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      req.onerror = () => { opening = null; reject(req.error); };
    });
    return opening;
  }

  // Plain callbacks inside each transaction (not awaits), so it stays open on every browser.
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let result;
      fn(t.objectStore(STORE), (r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const get = (key) => tx("readonly", (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); });
  const all = () => tx("readonly", (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result || []); });
  const remove = (key) => tx("readwrite", (s) => { s.delete(key); });
  const clear = () => tx("readwrite", (s) => { s.clear(); });
  /** Read, change and write one draft in a single step: fn(current) returns the new record, or null to leave it. */
  const update = (key, fn) => tx("readwrite", (s, done) => {
    const r = s.get(key);
    r.onsuccess = () => { const next = fn(r.result); if (next) s.put(next); done(next || r.result); };
  });

  /** One thing at a time per draft, across the page's tabs and the service worker, so a draft isn't saved twice. */
  function locked(name, fn) {
    if (global.navigator?.locks?.request) return global.navigator.locks.request(`webmail-draft:${name}`, fn);
    return fn();
  }

  /**
   * Save one draft on the server, if it has changes the server hasn't got. `csrf` is the session's token. Returns the
   * draft's record afterwards (with the server's draft id), or null if there was nothing to do. Throws if the server
   * can't be reached or says no; the draft stays on this device, marked unsaved.
   */
  function sync(key, csrf, base = "") {
    return locked(key, async () => {
      const rec = await get(key);
      if (!rec || !rec.dirty) return rec || null;
      const res = await fetch(`${base}api.php?a=draft`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ ...rec.payload, draft_id: rec.draft_id || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.message || `Error ${res.status}`), { status: res.status });
      // Typing that happened while it was saving is still to be saved. If the draft was sent or discarded meanwhile,
      // it isn't brought back.
      return update(key, (now) => now && { ...now, draft_id: data.id, dirty: now.updated !== rec.updated, synced_at: Date.now() });
    });
  }

  /** Save every unsaved draft of this user; returns how many were saved. Stops at the first problem with the connection. */
  async function syncAll(userId, csrf, base = "") {
    let n = 0;
    for (const rec of await all()) {
      if (rec.updated < Date.now() - KEEP_MS) { await remove(rec.key); continue; }
      if (!rec.dirty || rec.user !== userId) continue;
      try {
        if (await sync(rec.key, csrf, base)) n++;
      } catch (err) {
        if (!err.status || err.status === 401 || err.status === 403 || err.status >= 500) break; // offline or signed out: later
      }
    }
    return n;
  }

  /** In the service worker: the session's user and token, to save drafts with. Null when signed out. */
  async function session(base = "") {
    const res = await fetch(`${base}api.php?a=session`, { credentials: "same-origin" });
    if (!res.ok) return null;
    const s = await res.json().catch(() => null);
    return s?.user ? { user: s.user.id, csrf: s.csrf } : null;
  }

  global.LocalDrafts = { get, update, remove, all, clear, sync, syncAll, session, locked };
})(typeof self !== "undefined" ? self : window);
