// Meet: a video meeting in the browser. Everyone connects directly to everyone else (WebRTC, encrypted end to end
// by DTLS-SRTP); the webmail only passes on the connection details (meet.php?a=signal / poll) and forgets them once
// fetched. Up to six people: each sends their video to each of the others.
//
// Who starts each connection: the newer person (the higher id) makes the offer, so two people never offer to each
// other at once; the older one answers on the transceivers the offer brought, so each connection has one audio and
// one video line each way. Camera on and off, a different camera and sharing the screen swap the track being sent
// (replaceTrack): no new offer needed. A connection that fails is restarted by whoever offered it.
"use strict";

(() => {
  const D = document.body.dataset;
  const ROOM = D.room;
  let MAX = Number(D.max || 6); // the most people in a meeting (6, or less if the organisation's limit is lower)
  const MEMBER = D.member || "";
  const $root = document.getElementById("meet");

  // ---------------------------------------------------------------------------------------------- small helpers
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "vars") for (const [n, x] of Object.entries(v)) el.style.setProperty(n, String(x)); // CSSOM: inline style attributes are blocked here
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const ICONS = {
    mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
    micOff: "M12 3a3 3 0 0 1 3 3v4 M9 9v3a3 3 0 0 0 4.5 2.6 M5 11a7 7 0 0 0 11.3 5.5 M19 11a7 7 0 0 1-.6 2.8 M12 18v3 M3 3l18 18",
    cam: "M3 7h12v10H3z M15 10l6-3v10l-6-3",
    camOff: "M3 7h9 M15 10l6-3v10l-6-3 M15 13v4H5 M3 7v10 M3 3l18 18",
    screen: "M3 4h18v12H3z M8 20h8 M12 16v4 M9 10l3-3 3 3 M12 7v6",
    hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V11 M11 11V4.5a1.5 1.5 0 0 1 3 0V11 M14 11V5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L3.5 15a1.5 1.5 0 0 1 2.3-1.9L8 15",
    chat: "M4 5h16v11H9l-5 4z",
    people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14.5a6.5 6.5 0 0 1 3.5 5.5",
    rec: "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
    leave: "M10 15l-3-3 3-3 M7 12h9 M14 4h5v16h-5",
    more: "M5 12h.01 M12 12h.01 M19 12h.01",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    lock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
    gear: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1",
    close: "M6 6l12 12 M18 6L6 18",
    send: "M4 12l16-8-6 16-2.5-6.5z",
    grid: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
    check: "M5 12l5 5 9-10",
  };
  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "i"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", ICONS[name] || ""); svg.append(p);
    return svg;
  };
  const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let toastTimer;
  function toast(text, action) {
    document.querySelector(".mt-toast")?.remove();
    const el = h("div", { class: "mt-toast", role: "status" }, h("span", {}, text),
      action && h("button", { class: "mt-link", onclick: () => { el.remove(); action.run(); } }, action.label));
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), action ? 9000 : 4000);
  }

  // ---------------------------------------------------------------------------------------------- talking to the webmail
  let secret = "";
  async function call(action, body = {}, { quiet = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (secret) headers["X-Meet-Peer"] = secret;
    if (action === "join" && D.csrf) headers["X-CSRF-Token"] = D.csrf;
    const res = await fetch(`meet.php?r=${encodeURIComponent(ROOM)}&a=${action}`, { method: "POST", credentials: "same-origin", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || "Something went wrong. Try again.");
      err.status = res.status; err.code = data.error;
      if (!quiet) throw err;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------------------------------- the state of things
  const me = { id: 0, name: MEMBER, member: !!MEMBER, host: D.host === "1", status: "out" };
  const local = {
    stream: new MediaStream(), // what others get: the microphone and the camera (or the screen)
    mic: null, cam: null, screen: null,
    audioOn: true, videoOn: true, hand: false, recording: false,
    micId: "", camId: "",
  };
  let iceServers = [];
  /** Everyone else in the meeting, by id: { id, name, member, host, state, conn } */
  const people = new Map();
  let lobby = [];
  let lastSignal = 0;
  let polling = false;
  let lastActivity = Date.now();
  let failures = 0;
  const chat = [];
  let unreadChat = 0;
  let panel = null; // "chat" | "people" | null
  let pinned = 0;
  let startedAt = 0;

  // ---------------------------------------------------------------------------------------------- camera and microphone
  async function openMic(deviceId) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const t = s.getAudioTracks()[0];
      local.mic?.stop();
      local.mic = t; local.micId = t.getSettings().deviceId || deviceId || "";
      t.enabled = local.audioOn;
      return t;
    } catch (err) { return null; }
  }
  async function openCam(deviceId) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } });
      const t = s.getVideoTracks()[0];
      local.cam?.stop();
      local.cam = t; local.camId = t.getSettings().deviceId || deviceId || "";
      return t;
    } catch (err) { return null; }
  }
  function closeCam() { local.cam?.stop(); local.cam = null; }
  /** The video being sent now: the screen while sharing it, else the camera when it's on. */
  const sendingVideo = () => local.screen || (local.videoOn ? local.cam : null);
  function syncLocalStream() {
    for (const t of local.stream.getTracks()) local.stream.removeTrack(t);
    if (local.mic) local.stream.addTrack(local.mic);
    const v = sendingVideo(); if (v) local.stream.addTrack(v);
  }
  /** Every connection sends what we're sending now. */
  async function pushTracks() {
    syncLocalStream();
    for (const p of people.values()) await p.conn?.sendTracks();
    render();
  }

  // ---------------------------------------------------------------------------------------------- one connection to one person
  const outbox = [];
  let flushTimer = null;
  function send(to, kind, data) {
    outbox.push({ to, kind, data });
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  }
  async function flush() {
    flushTimer = null;
    if (!outbox.length) return;
    const messages = outbox.splice(0, 60);
    try { await call("signal", { messages }); } catch (err) { if (err.status >= 500 || !err.status) { outbox.unshift(...messages); await wait(800); } }
    lastActivity = Date.now();
    if (outbox.length && !flushTimer) flushTimer = setTimeout(flush, 40);
  }

  class Conn {
    constructor(person, offerer) {
      this.person = person;
      this.offerer = offerer;
      this.polite = !offerer;
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.stream = new MediaStream();
      this.failedAt = 0;
      this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
      // A data channel both ends create with the same id: chat and quick updates (microphone off, hand up).
      this.dc = this.pc.createDataChannel("meet", { negotiated: true, id: 0 });
      this.dc.onmessage = (e) => { try { onData(this.person, JSON.parse(e.data)); } catch { /* not ours */ } };
      this.dc.onopen = () => { this.say({ t: "state", state: myState() }); render(); };
      this.pc.onicecandidate = ({ candidate }) => { if (candidate) send(person.id, "ice", candidate.toJSON()); };
      this.pc.ontrack = ({ track }) => {
        for (const t of this.stream.getTracks()) if (t.kind === track.kind) this.stream.removeTrack(t);
        this.stream.addTrack(track);
        track.onunmute = () => render();
        track.onmute = () => render();
        watchVoice(this.person.id, this.stream);
        render();
      };
      this.pc.onnegotiationneeded = async () => {
        if (!this.offerer) return; // the other end offers; we answer on its transceivers
        try {
          this.makingOffer = true;
          await this.pc.setLocalDescription();
          send(person.id, "offer", this.pc.localDescription.toJSON());
        } catch (err) { console.warn("offer", err); } finally { this.makingOffer = false; }
      };
      this.pc.onconnectionstatechange = () => {
        const s = this.pc.connectionState;
        if (s === "connected") { this.failedAt = 0; }
        if (s === "failed" || s === "disconnected") {
          this.failedAt ||= Date.now();
          if (s === "failed" && this.offerer) this.pc.restartIce();
        }
        render();
      };
      if (offerer) {
        this.audio = this.pc.addTransceiver("audio", { direction: "sendrecv", streams: [local.stream] });
        this.video = this.pc.addTransceiver("video", { direction: "sendrecv", streams: [local.stream] });
        this.sendTracks();
      }
    }
    say(msg) { if (this.dc.readyState === "open") this.dc.send(JSON.stringify(msg)); }
    async sendTracks() {
      if (!this.audio || !this.video) return;
      await this.audio.sender.replaceTrack(local.mic || null).catch(() => {});
      await this.video.sender.replaceTrack(sendingVideo() || null).catch(() => {});
      this.tuneVideo();
    }
    /** Less to send when more people are in the meeting (everyone sends to everyone). */
    tuneVideo() {
      const sender = this.video?.sender; if (!sender) return;
      const n = Math.max(1, people.size);
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const screen = !!local.screen;
      params.encodings[0].maxBitrate = screen ? 2_500_000 : n <= 1 ? 1_500_000 : n <= 2 ? 1_000_000 : n <= 3 ? 700_000 : 450_000;
      params.encodings[0].maxFramerate = screen ? 15 : 24;
      sender.setParameters(params).catch(() => {});
    }
    async onSignal(kind, data) {
      const pc = this.pc;
      if (kind === "offer" || kind === "answer") {
        const collision = kind === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(data);
        if (kind === "offer") {
          // The answering end: send on the lines the offer brought.
          for (const tr of pc.getTransceivers()) {
            const k = tr.receiver.track?.kind;
            if (k === "audio" && !this.audio) this.audio = tr;
            if (k === "video" && !this.video) this.video = tr;
          }
          if (this.audio) this.audio.direction = "sendrecv";
          if (this.video) this.video.direction = "sendrecv";
          await this.sendTracks();
          await pc.setLocalDescription();
          send(this.person.id, "answer", pc.localDescription.toJSON());
        }
      } else if (kind === "ice") {
        try { await pc.addIceCandidate(data); } catch (err) { if (!this.ignoreOffer) console.warn("ice", err); }
      }
    }
    close() {
      try { this.dc.close(); } catch { /* fine */ }
      try { this.pc.close(); } catch { /* fine */ }
      stopVoice(this.person.id);
    }
  }

  function connectTo(person) {
    if (person.conn) return person.conn;
    person.conn = new Conn(person, me.id > person.id);
    return person.conn;
  }

  // Connection details arrive in order; each person's are dealt with one after another.
  const chains = new Map();
  function onSignal(s) {
    const person = people.get(s.from) || { id: s.from, name: "", state: {} };
    if (!people.has(s.from)) people.set(s.from, person);
    if (s.kind === "bye") { person.conn?.close(); person.conn = null; return; }
    const prev = chains.get(s.from) || Promise.resolve();
    const next = prev.then(async () => {
      if (s.kind === "offer" && person.conn && person.conn.offerer) { /* they restarted: only the newer one offers */ }
      if (s.kind === "offer" && person.conn && person.conn.pc.connectionState === "failed") { person.conn.close(); person.conn = null; }
      await connectTo(person).onSignal(s.kind, s.data);
    }).catch((err) => console.warn("signal", err));
    chains.set(s.from, next);
  }

  // ---------------------------------------------------------------------------------------------- who's talking
  let audioCtx = null;
  const voices = new Map(); // id → { analyser, data, level, source }
  function ctx() { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {}); return audioCtx; }
  function watchVoice(id, stream) {
    const track = stream.getAudioTracks()[0];
    const v = voices.get(id);
    if (!track || (v && v.track === track)) return;
    stopVoice(id);
    try {
      const c = ctx();
      const source = c.createMediaStreamSource(new MediaStream([track]));
      const analyser = c.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser);
      voices.set(id, { track, source, analyser, data: new Uint8Array(analyser.fftSize), level: 0 });
      recorder?.addVoice(track);
    } catch { /* no audio context: no speaking ring */ }
  }
  function stopVoice(id) { const v = voices.get(id); if (v) { try { v.source.disconnect(); } catch { /* fine */ } voices.delete(id); } }
  let speaking = 0;
  setInterval(() => {
    let best = 0, loud = 0.035;
    for (const [id, v] of voices) {
      v.analyser.getByteTimeDomainData(v.data);
      let sum = 0; for (const x of v.data) { const d = (x - 128) / 128; sum += d * d; }
      v.level = v.level * 0.6 + Math.sqrt(sum / v.data.length) * 0.4;
      if (id === me.id && !local.audioOn) continue;
      if (v.level > loud) { loud = v.level; best = id; }
    }
    if (best !== speaking) {
      speaking = best;
      for (const tile of document.querySelectorAll(".mt-tile")) tile.classList.toggle("speaking", Number(tile.dataset.id) === speaking);
    }
    if (local.audioOn === false && voices.get(me.id)?.level > 0.06) mutedHint();
  }, 150);
  let hintAt = 0;
  function mutedHint() { if (Date.now() - hintAt > 30000 && me.status === "in") { hintAt = Date.now(); toast("You're muted. Press Ctrl+D or the microphone to talk."); } }

  // ---------------------------------------------------------------------------------------------- what others see of me
  const myState = () => ({ a: local.audioOn && !!local.mic, v: !!sendingVideo(), s: !!local.screen, h: local.hand, r: local.recording });
  let stateTimer = null;
  function shareState() {
    const state = myState();
    for (const p of people.values()) p.conn?.say({ t: "state", state });
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => call("state", { state }).catch(() => {}), 150);
    render();
  }
  function onData(person, msg) {
    if (msg.t === "state" && msg.state && typeof msg.state === "object") {
      const was = person.state || {};
      person.state = msg.state;
      if (msg.state.h && !was.h) toast(`${person.name || "Someone"} raised their hand.`);
      if (msg.state.r && !was.r) toast(`${person.name || "Someone"} started recording this meeting.`);
      render();
    } else if (msg.t === "chat" && typeof msg.text === "string") {
      chat.push({ from: person.name || "Someone", text: msg.text.slice(0, 2000), at: Date.now() });
      if (panel !== "chat") { unreadChat++; toast(`${person.name || "Someone"}: ${msg.text.slice(0, 80)}`, { label: "Open chat", run: () => openPanel("chat") }); }
      render();
    }
  }

  // ---------------------------------------------------------------------------------------------- asking the webmail
  async function poll() {
    if (polling || me.status === "out") return;
    polling = true;
    try {
      const r = await call("poll", { after: lastSignal });
      failures = 0;
      document.querySelector(".mt-offline")?.remove();
      if (r.status !== me.status) {
        const before = me.status;
        me.status = r.status;
        if (before === "lobby" && r.status === "in") { await admitted(); }
        else if (r.status !== "in" && r.status !== "lobby") { ended(r.status); return; }
      }
      if (r.max) MAX = r.max;
      if (r.status === "lobby" && !!r.full !== meeting.full) { meeting.full = !!r.full; renderLobby(); }
      if (r.status === "in") {
        for (const s of r.signals) { lastSignal = Math.max(lastSignal, s.id); onSignal(s); lastActivity = Date.now(); }
        meeting.full = !!r.full; // before the knocks below, so a knock on a full meeting doesn't offer "Let in"
        roster(r.people);
        const known = new Set(lobby.map((x) => x.id));
        lobby = r.lobby || [];
        for (const g of lobby) if (!known.has(g.id)) knock(g);
        if (r.locked !== meeting.locked) { meeting.locked = r.locked; render(); }
        render();
      }
    } catch (err) {
      if (err.status === 401) { ended("left"); return; }
      failures++;
      if (failures >= 3 && !document.querySelector(".mt-offline")) document.body.append(h("div", { class: "mt-offline", role: "status" }, "Reconnecting to the webmail… (you can still see and hear each other)"));
    } finally {
      polling = false;
    }
  }
  const meeting = { locked: false, full: false };
  function roster(list) {
    const here = new Set();
    for (const p of list) {
      if (p.id === me.id) continue;
      here.add(p.id);
      let person = people.get(p.id);
      const fresh = !person || !person.name;
      if (!person) { person = { id: p.id, state: {} }; people.set(p.id, person); }
      Object.assign(person, { name: p.name, member: p.member, host: p.host, joined_at: p.joined_at });
      if (!person.conn?.dc || person.conn.dc.readyState !== "open") person.state = p.state || {};
      if (fresh && startedAt && Date.now() - startedAt > 3000) toast(`${p.name} joined.`);
      // The newer of two people offers the connection.
      if (me.id > person.id && !person.conn) connectTo(person);
    }
    for (const [id, person] of people) {
      if (!here.has(id)) {
        person.conn?.close();
        people.delete(id); chains.delete(id);
        if (person.name) toast(`${person.name} left.`);
        if (pinned === id) pinned = 0;
      }
    }
    // A connection that won't come back: started again from scratch by its offerer.
    for (const person of people.values()) {
      const c = person.conn;
      if (c && c.offerer && c.failedAt && Date.now() - c.failedAt > 12000) {
        c.close(); person.conn = null; send(person.id, "bye", null);
        setTimeout(() => { if (people.has(person.id) && !person.conn) connectTo(person); }, 1500);
      }
    }
    for (const p of people.values()) p.conn?.tuneVideo();
    render();
  }
  function pollLoop() {
    if (me.status === "out") return;
    // Quick while connections are being made; every two seconds once everyone's connected.
    const settling = [...people.values()].some((p) => !p.conn || p.conn.pc.connectionState !== "connected") || Date.now() - lastActivity < 6000 || lobby.length;
    const delay = me.status === "lobby" ? 2000 : settling ? 700 : 2000;
    setTimeout(async () => { await poll(); pollLoop(); }, document.visibilityState === "hidden" ? Math.max(delay, 1500) : delay);
  }

  // ---------------------------------------------------------------------------------------------- the lobby (people with an account let guests in)
  function knock(g) {
    if (meeting.full) toast(`${g.name} wants to join, but the meeting is full (${MAX} people).`);
    else toast(`${g.name} wants to join.`, { label: "Let in", run: () => admit(g.id, true) });
    render();
  }
  async function admit(id, allow) {
    try { await call("admit", { peer_id: id, allow }); lobby = lobby.filter((x) => x.id !== id); render(); }
    catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------------------------------------- recording
  let recorder = null;
  function makeRecorder() {
    const W = 1280, H = 720;
    const canvas = h("canvas", { width: W, height: H });
    const g = canvas.getContext("2d");
    const c = ctx();
    const dest = c.createMediaStreamDestination();
    const added = new Set();
    const addVoice = (track) => {
      if (!track || added.has(track)) return;
      added.add(track);
      try { c.createMediaStreamSource(new MediaStream([track])).connect(dest); } catch { /* skipped */ }
    };
    if (local.mic) addVoice(local.mic);
    for (const p of people.values()) addVoice(p.conn?.stream.getAudioTracks()[0]);
    // Each frame: the tiles as they are on screen, drawn into the recording.
    const draw = () => {
      g.fillStyle = "#0b0e13"; g.fillRect(0, 0, W, H);
      const tiles = [...document.querySelectorAll(".mt-stage .mt-tile")];
      const stage = document.querySelector(".mt-stage")?.getBoundingClientRect();
      if (!stage || !tiles.length) return;
      const sx = W / stage.width, sy = H / stage.height, sc = Math.min(sx, sy);
      const ox = (W - stage.width * sc) / 2, oy = (H - stage.height * sc) / 2;
      for (const tile of tiles) {
        const r = tile.getBoundingClientRect();
        const x = ox + (r.left - stage.left) * sc, y = oy + (r.top - stage.top) * sc, w = r.width * sc, hh = r.height * sc;
        g.fillStyle = "#1b212b"; g.fillRect(x, y, w, hh);
        const v = tile.querySelector("video");
        if (v && v.videoWidth && !tile.classList.contains("no-video")) {
          const fit = tile.classList.contains("screen") ? Math.min(w / v.videoWidth, hh / v.videoHeight) : Math.max(w / v.videoWidth, hh / v.videoHeight);
          const vw = v.videoWidth * fit, vh = v.videoHeight * fit;
          g.save(); g.beginPath(); g.rect(x, y, w, hh); g.clip();
          g.drawImage(v, x + (w - vw) / 2, y + (hh - vh) / 2, vw, vh); // as others see it: the self-view's mirroring is only on screen
          g.restore();
        } else {
          const name = tile.dataset.name || "";
          g.fillStyle = `hsl(${hue(name)} 45% 40%)`;
          g.beginPath(); g.arc(x + w / 2, y + hh / 2, Math.min(w, hh) * 0.16, 0, Math.PI * 2); g.fill();
          g.fillStyle = "#fff"; g.font = `600 ${Math.round(Math.min(w, hh) * 0.12)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
          g.fillText(initials(name), x + w / 2, y + hh / 2);
        }
        g.fillStyle = "rgba(0,0,0,.55)"; g.font = "500 18px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "alphabetic";
        const label = tile.dataset.name || ""; const tw = g.measureText(label).width;
        g.fillRect(x + 8, y + hh - 34, tw + 16, 26); g.fillStyle = "#fff"; g.fillText(label, x + 16, y + hh - 15);
      }
    };
    const timer = setInterval(draw, 1000 / 20);
    const stream = new MediaStream([...canvas.captureStream(20).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 96_000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const began = new Date();
    mr.start(5000);
    return {
      addVoice, began,
      stop: () => new Promise((resolve) => {
        mr.onstop = () => { clearInterval(timer); for (const t of stream.getTracks()) t.stop(); resolve(new Blob(chunks, { type: (type || "video/webm").split(";")[0] })); };
        mr.stop();
      }),
    };
  }
  async function toggleRecording() {
    if (!me.member) return;
    if (!recorder) {
      if (!window.MediaRecorder) { toast("This browser can't record. Try Chrome, Edge or Firefox."); return; }
      const ok = await confirmBox("Record this meeting?", "Everyone in the meeting will see that it's being recorded. The recording is made on this computer and saved to your Files, encrypted, when you stop. Nothing is recorded on any server while the meeting goes on.", "Start recording");
      if (!ok) return;
      try { recorder = makeRecorder(); } catch (err) { toast(`Couldn't start recording: ${err.message}`); return; }
      local.recording = true; shareState();
      return;
    }
    const r = recorder; recorder = null;
    local.recording = false; shareState();
    const blob = await r.stop();
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const stamp = r.began.toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
    const name = `${(D.title || "Meeting").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120)} ${stamp}.${ext}`;
    saveRecording(blob, name);
  }
  async function saveRecording(blob, name) {
    const status = h("div", { class: "mt-toast mt-saving", role: "status" }, `Saving the recording to Files… 0%`);
    document.querySelector(".mt-toast")?.remove();
    document.body.append(status);
    const download = () => { const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); };
    try {
      const api = async (a, body, query = "") => {
        const res = await fetch(`${D.webmail}api.php?a=${a}${query}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": D.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "The upload didn't go through.");
        return data;
      };
      const list = await api("files", undefined, "&view=mine");
      let folder = (list.items || []).find((i) => i.kind === "folder" && i.name === "Meeting recordings");
      if (!folder) folder = (await api("files/folder", { parent_id: null, name: "Meeting recordings" })).folder || null;
      const folderId = folder?.id ?? null;
      const start = await api("files/upload/start", { parent_id: folderId, name, size: blob.size });
      if (!start.done) {
        for (let offset = 0; offset < blob.size; offset += start.piece) {
          for (let attempt = 0; ; attempt++) {
            const res = await fetch(`${D.webmail}api.php?a=files/upload/piece&u=${encodeURIComponent(start.upload)}&offset=${offset}`, {
              method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": D.csrf, "Content-Type": "application/octet-stream" }, body: blob.slice(offset, offset + start.piece) });
            if (res.ok) break;
            const data = await res.json().catch(() => ({}));
            if (attempt >= 2 || res.status < 500) throw new Error(data.message || "The upload didn't go through.");
            await wait(1500 * (attempt + 1));
          }
          status.textContent = `Saving the recording to Files… ${Math.min(100, Math.round(((offset + start.piece) / blob.size) * 100))}%`;
        }
      }
      status.remove();
      toast(`Saved to Files → Meeting recordings: ${name}`, { label: "Download a copy", run: download });
    } catch (err) {
      status.remove();
      toast(`Couldn't save it to Files (${err.message}).`, { label: "Download it", run: download });
    }
  }

  // ---------------------------------------------------------------------------------------------- dialogs
  function confirmBox(title, text, yes) {
    return new Promise((resolve) => {
      const done = (v) => { overlay.remove(); resolve(v); };
      const overlay = h("div", { class: "mt-overlay", onclick: (e) => { if (e.target === overlay) done(false); } },
        h("div", { class: "mt-dialog", role: "dialog", "aria-label": title }, h("h2", {}, title), h("p", {}, text),
          h("div", { class: "mt-row end" }, h("button", { class: "mt-btn", onclick: () => done(false) }, "Cancel"), h("button", { class: "mt-btn primary", onclick: () => done(true) }, yes))));
      document.body.append(overlay);
      overlay.querySelector(".primary").focus();
    });
  }
  async function deviceDialog() {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const pick = (kind, current, label) => {
      const list = devices.filter((d) => d.kind === kind);
      return h("label", { class: "mt-field" }, label, h("select", { "data-kind": kind }, list.length ? list.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === current }, d.label || `${label} ${i + 1}`)) : h("option", { value: "" }, "None found")));
    };
    const overlay = h("div", { class: "mt-overlay", onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      h("div", { class: "mt-dialog", role: "dialog", "aria-label": "Camera and microphone" }, h("h2", {}, "Camera and microphone"),
        pick("audioinput", local.micId, "Microphone"), pick("videoinput", local.camId, "Camera"),
        h("div", { class: "mt-row end" }, h("button", { class: "mt-btn primary", onclick: async () => {
          const mic = overlay.querySelector("[data-kind=audioinput]").value, cam = overlay.querySelector("[data-kind=videoinput]").value;
          overlay.remove();
          if (mic && mic !== local.micId) { await openMic(mic); if (local.mic) watchVoice(me.id, new MediaStream([local.mic])); }
          if (cam && cam !== local.camId && local.videoOn) await openCam(cam); else if (cam) local.camId = cam;
          await pushTracks(); shareState();
        } }, "Done"))));
    document.body.append(overlay);
  }

  // ---------------------------------------------------------------------------------------------- controls
  async function toggleMic() {
    if (!local.mic) { await openMic(local.micId); if (!local.mic) { toast("Your microphone isn't available. Check the browser lets this page use it."); return; } local.audioOn = true; watchVoice(me.id, new MediaStream([local.mic])); await pushTracks(); }
    else { local.audioOn = !local.audioOn; local.mic.enabled = local.audioOn; }
    shareState();
  }
  async function toggleCam() {
    if (local.videoOn) { local.videoOn = false; closeCam(); }
    else {
      local.videoOn = true;
      if (!(await openCam(local.camId))) { local.videoOn = false; toast("Your camera isn't available. Check the browser lets this page use it, and that nothing else is using it."); }
    }
    await pushTracks(); shareState();
  }
  async function toggleScreen() {
    if (local.screen) { local.screen.stop(); local.screen = null; await pushTracks(); shareState(); return; }
    if (!navigator.mediaDevices.getDisplayMedia) { toast("This browser can't share its screen."); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      local.screen = s.getVideoTracks()[0];
      local.screen.contentHint = "detail";
      local.screen.onended = () => { if (local.screen) { local.screen = null; pushTracks().then(shareState); } };
      await pushTracks(); shareState();
    } catch { /* cancelled */ }
  }
  function toggleHand() { local.hand = !local.hand; shareState(); }
  function openPanel(which) { panel = panel === which ? null : which; if (panel === "chat") unreadChat = 0; render(); if (panel === "chat") setTimeout(() => document.querySelector(".mt-chat-input")?.focus()); }
  function sendChat(text) {
    text = text.trim(); if (!text) return;
    for (const p of people.values()) p.conn?.say({ t: "chat", text });
    chat.push({ from: "You", text, at: Date.now(), mine: true });
    render();
  }
  async function copyLink() {
    const url = location.href.split("#")[0];
    try { await navigator.clipboard.writeText(url); toast("Meeting link copied. Anyone you send it to can ask to join."); }
    catch { prompt("The meeting link:", url); }
  }
  async function leave() {
    if (recorder) await toggleRecording();
    me.status = "out";
    try { await call("leave"); } catch { /* fine */ }
    teardown();
    ended("left");
  }
  function teardown() {
    for (const p of people.values()) p.conn?.close();
    people.clear();
    for (const t of [local.mic, local.cam, local.screen]) t?.stop();
    local.mic = local.cam = local.screen = null;
  }
  addEventListener("pagehide", () => {
    if (me.status === "in" || me.status === "lobby") navigator.sendBeacon(`meet.php?r=${encodeURIComponent(ROOM)}&a=leave`, new Blob([JSON.stringify({ peer: secret })], { type: "text/plain" }));
  });
  addEventListener("keydown", (e) => {
    if (me.status !== "in" || e.target.closest?.("input, textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); toggleMic(); }
    else if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); toggleCam(); }
  });

  // ---------------------------------------------------------------------------------------------- joining
  let preview = null;
  async function prejoin() {
    // Ask for the camera and microphone first, so the browser's question comes now and not mid-meeting.
    await Promise.all([openMic(), openCam()]);
    if (!local.cam) local.videoOn = false;
    if (!local.mic) local.audioOn = false;
    syncLocalStream();
    renderPrejoin();
  }
  function renderPrejoin(error = "") {
    preview = h("video", { class: "mt-preview mirror", autoplay: true, muted: true, playsInline: true });
    preview.srcObject = local.stream;
    const name = h("input", { class: "mt-input", name: "name", maxlength: 60, placeholder: "Your name", autocomplete: "name", required: true, value: localStorageGet("meet.name") || "" });
    const btn = (on, ic, offIc, label, run) => h("button", { type: "button", class: `mt-round${on ? "" : " off"}`, title: label, "aria-label": label, "aria-pressed": String(!on), onclick: run }, icon(on ? ic : offIc));
    const go = h("button", { class: "mt-btn primary big", type: "submit" }, MEMBER ? "Join now" : "Ask to join");
    $root.replaceChildren(h("main", { class: "mt-prejoin" },
      h("div", { class: "mt-preview-box" }, preview, !sendingVideo() && h("div", { class: "mt-preview-off" }, local.cam === null && local.videoOn === false && !local.camId ? "No camera" : "Camera is off"),
        h("div", { class: "mt-preview-bar" },
          btn(local.audioOn && !!local.mic, "mic", "micOff", local.audioOn ? "Turn microphone off" : "Turn microphone on", async () => { await toggleMicPre(); }),
          btn(!!sendingVideo(), "cam", "camOff", local.videoOn ? "Turn camera off" : "Turn camera on", async () => { await toggleCamPre(); }),
          h("button", { type: "button", class: "mt-round", title: "Camera and microphone", "aria-label": "Choose camera and microphone", onclick: deviceDialog }, icon("gear")))),
      h("form", { class: "mt-join", onsubmit: async (e) => { e.preventDefault(); go.disabled = true; await join(MEMBER ? "" : name.value); go.disabled = false; } },
        h("p", { class: "mt-brand" }, D.app || "Webmail"),
        h("h1", {}, D.title || "Meeting"),
        MEMBER ? h("p", { class: "muted" }, `Joining as ${MEMBER}.`) : h("label", { class: "mt-field" }, "What's your name?", name),
        !MEMBER && h("p", { class: "muted small" }, "Someone in the meeting will let you in."),
        error && h("p", { class: "mt-error", role: "alert" }, error),
        go,
        h("p", { class: "muted small" }, "Sound and video go directly between the people in the meeting, encrypted. Nothing is recorded unless someone in it records it, and everyone sees when they do."))));
    if (!MEMBER) setTimeout(() => name.focus());
  }
  async function toggleMicPre() {
    if (!local.mic) { await openMic(); local.audioOn = !!local.mic; if (!local.mic) toast("No microphone: allow this page to use it in the browser's address bar."); }
    else { local.audioOn = !local.audioOn; local.mic.enabled = local.audioOn; }
    syncLocalStream(); renderPrejoin();
  }
  async function toggleCamPre() {
    if (local.videoOn && local.cam) { local.videoOn = false; closeCam(); }
    else { local.videoOn = true; if (!(await openCam(local.camId))) { local.videoOn = false; toast("No camera: allow this page to use it in the browser's address bar."); } }
    syncLocalStream(); renderPrejoin();
  }
  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private browsing */ } }

  async function join(name) {
    if (!MEMBER) {
      name = name.trim();
      if (!name) { renderPrejoin("Say who you are, so they know whom to let in."); return; }
      localStorageSet("meet.name", name);
      me.name = name;
    }
    try {
      const r = await call("join", { name });
      secret = r.secret; me.id = r.id; me.status = r.status; me.host = !!r.host;
      iceServers = r.ice_servers || [];
      if (local.mic) watchVoice(me.id, new MediaStream([local.mic]));
      if (r.status === "lobby") renderLobby(); else await admitted();
      pollLoop();
    } catch (err) {
      renderPrejoin(err.message);
    }
  }
  async function admitted() {
    if (!iceServers.length) { try { iceServers = (await call("ice")).ice_servers || []; } catch { /* STUN-less still works on one network */ } }
    startedAt = Date.now();
    lastActivity = Date.now();
    render();
    shareState();
    await poll();
  }
  function renderLobby() {
    $root.replaceChildren(h("main", { class: "mt-card" }, h("p", { class: "mt-brand" }, D.app || "Webmail"), h("h1", {}, D.title || "Meeting"),
      h("div", { class: "mt-spinner", "aria-hidden": "true" }),
      h("p", {}, "Asking to join…"),
      meeting.full ? h("p", { class: "mt-full-note" }, `The meeting is full right now: it already has ${MAX} people, the most a meeting can have. You can be let in as soon as someone leaves.`)
        : h("p", { class: "muted" }, "You'll join as soon as someone in the meeting lets you in."),
      h("button", { class: "mt-btn", onclick: leave }, "Cancel")));
  }
  function ended(status) {
    me.status = "out";
    teardown();
    const why = { denied: "Nobody let you in this time.", removed: "You were taken out of the meeting.", ended: "The meeting has ended.", left: "You left the meeting." }[status] || "You left the meeting.";
    $root.replaceChildren(h("main", { class: "mt-card" }, h("p", { class: "mt-brand" }, D.app || "Webmail"), h("h1", {}, why), h("p", { class: "muted" }, D.title || ""),
      status !== "removed" && status !== "ended" && h("button", { class: "mt-btn primary", onclick: () => location.reload() }, status === "denied" ? "Ask again" : "Rejoin"),
      MEMBER && h("a", { class: "mt-btn", href: D.webmail }, "Back to email")));
  }

  // ---------------------------------------------------------------------------------------------- the meeting
  const videoEls = new Map(); // tile id → its video element, kept between redraws so video doesn't blink
  function videoFor(key, stream, muted) {
    let v = videoEls.get(key);
    if (!v) { v = h("video", { autoplay: true, playsInline: true }); v.muted = muted; videoEls.set(key, v); }
    if (v.srcObject !== stream) v.srcObject = stream;
    v.play?.().catch(() => {});
    return v;
  }
  function tile(id, name, stream, state, opts = {}) {
    const hasVideo = !!state.v && stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
    const v = videoFor(id, stream, !!opts.self);
    const conn = opts.conn;
    const status = conn && conn.pc.connectionState !== "connected" ? (conn.pc.connectionState === "failed" || conn.pc.connectionState === "disconnected" ? "Reconnecting…" : "Connecting…") : "";
    return h("div", { class: `mt-tile${hasVideo ? "" : " no-video"}${state.s ? " screen" : ""}${opts.self && !state.s ? " mirror" : ""}${speaking === id ? " speaking" : ""}${pinned === id ? " pinned" : ""}`,
      "data-id": id, "data-name": name, ondblclick: () => { pinned = pinned === id ? 0 : id; render(); } },
      v,
      !hasVideo && h("div", { class: "mt-avatar", vars: { "--h": hue(name) } }, initials(name)),
      h("div", { class: "mt-name" }, !state.a && icon("micOff"), h("span", {}, name + (opts.self ? " (you)" : "")), state.s && h("small", {}, " · presenting")),
      state.h && h("div", { class: "mt-hand", title: "Hand raised" }, icon("hand")),
      state.r && h("div", { class: "mt-recdot", title: "Recording" }, "REC"),
      status && h("div", { class: "mt-status" }, status));
  }
  let clock = null;
  let lastKey = "";
  /** Drawn again only when something shown changed (polls come every second or two). */
  function render(force = false) {
    if (me.status !== "in") return;
    const others = [...people.values()].filter((p) => p.name);
    const key = JSON.stringify([others.map((p) => [p.id, p.name, p.member, p.host, p.state, p.conn?.pc.connectionState, p.conn?.stream.getTracks().map((t) => [t.id, t.muted, t.readyState])]),
      lobby.map((g) => g.id), panel, chat.length, unreadChat, myState(), local.mic?.id, sendingVideo()?.id, pinned, meeting.locked, meeting.full, MAX, me.host, me.name]);
    if (!force && key === lastKey) return;
    lastKey = key;
    const focused = document.activeElement?.classList.contains("mt-chat-input") ? document.activeElement : null;
    const sel = focused ? [focused.selectionStart, focused.selectionEnd] : null;
    const all = [{ id: me.id, name: me.name || "You", stream: local.stream, state: myState(), self: true }, ...others.map((p) => ({ id: p.id, name: p.name, stream: p.conn?.stream || new MediaStream(), state: p.state || {}, conn: p.conn }))];
    // Someone sharing their screen (or a tile double-clicked) takes the stage; everyone else in a strip beside it.
    const presenter = all.find((x) => x.id === pinned) || all.find((x) => x.state.s && !x.self) || all.find((x) => x.state.s);
    const tiles = all.map((x) => tile(x.id, x.name, x.stream, x.state, { self: x.self, conn: x.conn }));
    const n = all.length;
    const stage = presenter
      ? h("div", { class: "mt-stage spotlight" }, h("div", { class: "mt-main" }, tiles[all.indexOf(presenter)]), h("div", { class: "mt-strip" }, tiles.filter((_, i) => all[i] !== presenter)))
      : h("div", { class: `mt-stage grid n${n}` }, tiles);
    const recordingBy = all.filter((x) => x.state.r).map((x) => (x.self ? "You are" : `${x.name} is`));
    const ctl = (on, ic, offIc, label, run, extra = "") => h("button", { class: `mt-round${on ? "" : " off"}${extra}`, title: label, "aria-label": label, onclick: run }, icon(on ? ic : offIc));
    const toggle = (pressed, ic, label, run, badge) => h("button", { class: `mt-round${pressed ? " on" : ""}`, title: label, "aria-label": label, "aria-pressed": String(pressed), onclick: run }, icon(ic),
      badge ? h("span", { class: "mt-badge" }, String(badge)) : null);
    const bar = h("div", { class: "mt-bar" },
      h("div", { class: "mt-bar-left" }, h("span", { class: "mt-clock" }, ""), h("span", { class: "mt-title" }, D.title || "")),
      h("div", { class: "mt-bar-mid" },
        ctl(local.audioOn && !!local.mic, "mic", "micOff", local.audioOn && local.mic ? "Turn microphone off (Ctrl+D)" : "Turn microphone on (Ctrl+D)", toggleMic),
        ctl(local.videoOn && !!local.cam, "cam", "camOff", local.videoOn ? "Turn camera off (Ctrl+E)" : "Turn camera on (Ctrl+E)", toggleCam),
        navigator.mediaDevices.getDisplayMedia && toggle(!!local.screen, "screen", local.screen ? "Stop presenting" : "Present your screen", toggleScreen),
        toggle(local.hand, "hand", local.hand ? "Lower your hand" : "Raise your hand", toggleHand),
        me.member && D.recording !== "0" && h("button", { class: `mt-round${local.recording ? " rec" : ""}`, title: local.recording ? "Stop recording" : "Record the meeting", "aria-label": local.recording ? "Stop recording" : "Record the meeting", "aria-pressed": String(local.recording), onclick: toggleRecording }, icon("rec")),
        h("button", { class: "mt-round", title: "More", "aria-label": "More", onclick: (e) => moreMenu(e.currentTarget) }, icon("more")),
        h("button", { class: "mt-round leave", title: "Leave the meeting", "aria-label": "Leave the meeting", onclick: leave }, icon("leave"))),
      h("div", { class: "mt-bar-right" },
        toggle(panel === "people", "people", "People", () => openPanel("people"), (lobby.length ? `${lobby.length}!` : null) || String(n)),
        toggle(panel === "chat", "chat", "Chat", () => openPanel("chat"), unreadChat || null)));
    $root.replaceChildren(h("div", { class: `mt-room${panel ? " with-panel" : ""}` },
      recordingBy.length ? h("div", { class: "mt-recording", role: "status" }, h("span", { class: "mt-dot" }), `${recordingBy.join(", ")} recording this meeting.`) : null,
      lobby.length && panel !== "people" ? h("div", { class: "mt-knock", role: "status" }, `${lobby.map((g) => g.name).join(", ")} ${lobby.length > 1 ? "want" : "wants"} to join`,
        meeting.full ? `, but the meeting is full (${MAX} people). Someone has to leave first.` : ".",
        !meeting.full && me.member && h("button", { class: "mt-btn small primary", onclick: () => admit(lobby[0].id, true) }, lobby.length > 1 ? `Let ${lobby[0].name} in` : "Let in"),
        h("button", { class: "mt-btn small", onclick: () => openPanel("people") }, "See all")) : null,
      stage, panel && sidePanel(), bar));
    tickClock();
    clock ??= setInterval(tickClock, 1000);
    const input = document.querySelector(".mt-chat-input");
    if (input && chatDraft !== null) input.value = chatDraft;
    if (input && sel) { input.focus(); input.setSelectionRange(...sel); }
  }
  function tickClock() {
    const el = document.querySelector(".mt-clock"); if (!el || !startedAt) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor(s / 60) % 60).padStart(Math.floor(s / 3600) ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  let chatDraft = null;
  function sidePanel() {
    const close = h("button", { class: "mt-icon", "aria-label": "Close", onclick: () => openPanel(panel) }, icon("close"));
    if (panel === "chat") {
      const list = h("div", { class: "mt-chat-list" }, chat.length ? chat.map((m) => h("div", { class: `mt-msg${m.mine ? " mine" : ""}` }, h("strong", {}, m.from), h("span", { class: "muted small" }, ` ${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`), h("p", {}, m.text)))
        : h("p", { class: "muted small" }, "Messages go to everyone in the meeting now, directly. They aren't kept: someone joining later won't see them."));
      const input = h("input", { class: "mt-input mt-chat-input", placeholder: "Send a message to everyone", maxlength: 2000, oninput: (e) => { chatDraft = e.target.value; } });
      setTimeout(() => { list.scrollTop = list.scrollHeight; });
      return h("aside", { class: "mt-panel", "aria-label": "Chat" }, h("div", { class: "mt-panel-head" }, h("h2", {}, "Chat"), close), list,
        h("form", { class: "mt-chat-form", onsubmit: (e) => { e.preventDefault(); sendChat(input.value); chatDraft = ""; input.value = ""; setTimeout(() => document.querySelector(".mt-chat-input")?.focus()); } },
          input, h("button", { class: "mt-icon", "aria-label": "Send" }, icon("send"))));
    }
    const person = (p, self) => h("li", { class: "mt-person" }, h("span", { class: "mt-avatar small", vars: { "--h": hue(p.name) } }, initials(p.name)),
      h("span", { class: "grow" }, p.name, self ? " (you)" : "", p.host ? h("small", { class: "muted" }, " · started the meeting") : !p.member ? h("small", { class: "muted" }, " · guest") : null),
      p.state?.h && icon("hand"), !p.state?.a && icon("micOff"),
      !self && me.host && h("button", { class: "mt-btn small", onclick: async () => { if (await confirmBox(`Remove ${p.name}?`, "They'll leave the meeting now. They can ask to join again unless you lock the meeting.", "Remove")) call("remove", { peer_id: p.id }).catch((err) => toast(err.message)); } }, "Remove"));
    return h("aside", { class: "mt-panel", "aria-label": "People" }, h("div", { class: "mt-panel-head" }, h("h2", {}, `People (${people.size + 1} of ${MAX})`), close),
      lobby.length ? h("div", { class: "mt-lobby" }, h("h3", {}, "Waiting to join"), h("ul", {}, lobby.map((g) => h("li", { class: "mt-person" }, h("span", { class: "mt-avatar small", vars: { "--h": hue(g.name) } }, initials(g.name)), h("span", { class: "grow" }, g.name),
        me.member ? [h("button", { class: "mt-btn small primary", disabled: meeting.full, title: meeting.full ? `The meeting is full (${MAX} people)` : null, onclick: () => admit(g.id, true) }, "Let in"), h("button", { class: "mt-btn small", onclick: () => admit(g.id, false) }, "Deny")] : null)))) : null,
      h("h3", {}, "In the meeting"),
      h("ul", {}, person({ name: me.name || "You", member: me.member, host: me.host, state: myState() }, true), [...people.values()].filter((p) => p.name).map((p) => person(p, false))),
      people.size + 1 >= MAX ? h("p", { class: "muted small" }, `The meeting is full: up to ${MAX} people can be in a meeting at once. Anyone else waits until someone leaves.`) : null,
      h("div", { class: "mt-row" }, h("button", { class: "mt-btn", onclick: copyLink }, icon("link"), "Copy the meeting link")));
  }
  function moreMenu(anchor) {
    document.querySelector(".mt-menu")?.remove();
    const item = (ic, label, run) => h("button", { role: "menuitem", onclick: () => { menu.remove(); run(); } }, icon(ic), label);
    const menu = h("div", { class: "mt-menu", role: "menu" },
      item("link", "Copy the meeting link", copyLink),
      item("gear", "Camera and microphone", deviceDialog),
      pinned && item("grid", "Show everyone", () => { pinned = 0; render(); }),
      me.host && item("lock", meeting.locked ? "Unlock the meeting" : "Lock the meeting (nobody new joins)", async () => {
        try { await call("lock", { locked: !meeting.locked }); meeting.locked = !meeting.locked; toast(meeting.locked ? "Locked: nobody else can join." : "Unlocked."); render(); } catch (err) { toast(err.message); }
      }));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.left + r.width / 2 - menu.offsetWidth / 2))}px`;
    menu.style.bottom = `${innerHeight - r.top + 8}px`;
    setTimeout(() => document.addEventListener("pointerdown", function off(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", off); } }));
  }

  // ---------------------------------------------------------------------------------------------- start
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    $root.replaceChildren(h("main", { class: "mt-card" }, h("h1", {}, D.title || "Meeting"), h("p", {}, "This browser can't join video meetings. Use a recent Chrome, Edge, Firefox or Safari.")));
    return;
  }
  if (!window.isSecureContext) {
    $root.replaceChildren(h("main", { class: "mt-card" }, h("h1", {}, D.title || "Meeting"), h("p", {}, "Meetings need the webmail's https:// address: browsers only allow cameras and microphones on secure pages.")));
    return;
  }
  $root.replaceChildren(h("main", { class: "mt-card" }, h("div", { class: "mt-spinner", "aria-hidden": "true" }), h("p", {}, "Getting your camera and microphone ready…"), h("p", { class: "muted small" }, "Your browser may ask whether this page can use them.")));
  window.Meet = { people, me, local, state: () => ({ status: me.status, id: me.id, people: [...people.values()].map((p) => ({ id: p.id, name: p.name, state: p.state, connection: p.conn?.pc.connectionState, tracks: p.conn?.stream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? "muted" : "live"}`) })), lobby }) };
  prejoin();
})();
