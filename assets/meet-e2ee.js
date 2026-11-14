// End-to-end encryption for meetings on GhostParse's media server: every audio and video frame is encrypted in the
// sender's browser and decrypted in each receiver's, with the meeting's key (AES-GCM, 256 bits) that only the people
// in the meeting have. The media server forwards frames it can't read.
//
// What stays readable: the first byte of each audio frame (Opus's table of contents) and the first bytes of each VP8
// video frame (10 for a key frame, 3 otherwise: its frame tag, and a key frame's size), which is what lets the server
// forward each person the right video quality and lets the browser's packetiser work. Everything else, the picture and
// the sound, is encrypted.
//
// A frame: [readable header] [ciphertext and its 16-byte tag] [12-byte nonce] [0xE2]
// The header is authenticated too (it's the AES-GCM additional data), so nobody can alter it unnoticed.
//
// Runs as a worker. Browsers give it frames one of two ways: Chrome's own (createEncodedStreams, streams posted from
// the page) or the standard one (RTCRtpScriptTransform: Safari, Firefox). Each pipe reports the frames it has handled,
// so the page can prove what it sends is encrypted, and stops sending anything that isn't.
"use strict";

let key = null;
let failures = 0;
const MARK = 0xe2;

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.type === "key") {
    key = await crypto.subtle.importKey("raw", d.key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } else if (d.readable && d.writable) {
    pipe(d.readable, d.writable, d.op, d.kind, d.id); // Chrome's way
  }
};

// The standard way: the browser hands the worker each sender's or receiver's frames.
self.onrtctransform = (event) => {
  const t = event.transformer;
  pipe(t.readable, t.writable, t.options.op, t.options.kind, t.options.id);
};

function headerLength(frame, kind) {
  if (kind === "audio") return 1;
  return frame.type === "key" ? 10 : 3;
}

function pipe(readable, writable, op, kind, id) {
  let done = 0;
  const transform = new TransformStream({
    async transform(frame, controller) {
      if (!key) return; // no key yet: nothing leaves unencrypted, nothing arrives undecrypted
      const data = new Uint8Array(frame.data);
      try {
        if (op === "encrypt") {
          const h = Math.min(headerLength(frame, kind), data.length);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: data.subarray(0, h) }, key, data.subarray(h)));
          const out = new Uint8Array(h + ct.length + 13);
          out.set(data.subarray(0, h), 0);
          out.set(ct, h);
          out.set(iv, h + ct.length);
          out[out.length - 1] = MARK;
          frame.data = out.buffer;
          controller.enqueue(frame);
          // Proof for the page that this pipe really encrypts (first frame, then now and then).
          if (++done === 1 || done % 500 === 0) self.postMessage({ type: "encrypted", id, frames: done });
        } else {
          if (data.length < 30 || data[data.length - 1] !== MARK) { failed(); return; }
          const h = headerLength(frame, kind);
          const iv = data.subarray(data.length - 13, data.length - 1);
          const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: data.subarray(0, h) }, key, data.subarray(h, data.length - 13)));
          const out = new Uint8Array(h + plain.length);
          out.set(data.subarray(0, h), 0);
          out.set(plain, h);
          frame.data = out.buffer;
          controller.enqueue(frame);
          if (++done === 1 || done % 500 === 0) self.postMessage({ type: "decrypted", id, frames: done });
        }
      } catch {
        if (op === "decrypt") failed(); // a frame that isn't ours (or was altered): dropped, never played
      }
    },
  });
  readable.pipeThrough(transform).pipeTo(writable).catch(() => {});
}

function failed() {
  failures++;
  if (failures === 1 || failures % 200 === 0) self.postMessage({ type: "undecryptable", count: failures });
}
