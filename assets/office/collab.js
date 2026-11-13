// Editing together: one browser's view of a shared file. The server keeps every change in one order; each browser
// shows that ("confirmed") plus its own changes the server hasn't sent back yet ("pending"), worked out again on top
// whenever other people's changes arrive. Everyone applies the same changes in the same order, so everyone ends with
// the same file. The model (spreadsheet or document) supplies apply, rebase, clone and revive.
// Works in the browser (window.OfficeCollab) and in Node (its tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OfficeCollab = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const LOG_KEEP = 5000;

class Session {
  /**
   * @param model  { apply(state, op), rebase(op, against) → op | op[] | null, clone(state), revive?(op) }
   * @param state  the file as stored, with the server's changes after it already applied (seq = the last of them)
   */
  constructor(model, state, { seq = 0, client }) {
    this.m = model;
    this.client = client;
    this.confirmed = state;
    this.view = model.clone(state);
    this.seq = seq;          // the last server change in $confirmed
    this.inflight = [];      // sent, not yet back: [{ seen, op }]
    this.queue = [];         // made since: [{ seen, op }]
    this.log = [];           // server changes as applied: [{ seq, client, op }] (newest last)
  }
  get dirty() { return this.inflight.length > 0 || this.queue.length > 0; }

  /** Changes made here: applied to the view at once and queued. Returns what apply() said about each. */
  local(ops) {
    const out = [];
    for (const op of flat(ops)) { this.queue.push({ seen: this.seq, op }); out.push(this.m.apply(this.view, op)); }
    return out;
  }
  /** The next batch to send (null while one is on its way, or there's nothing). */
  take() {
    if (this.inflight.length || !this.queue.length) return null;
    this.inflight = this.queue;
    this.queue = [];
    return this.inflight.map(({ seen, op }) => ({ seen, op }));
  }
  /** The batch didn't arrive (network): it's sent again with the next. */
  failed() { this.queue = [...this.inflight, ...this.queue]; this.inflight = []; }

  /**
   * Changes from the server (all after $this.seq, in order; this browser's own batch among them).
   * Returns { changed: bool } — whether the view has others' changes in it to draw.
   */
  receive(ops) {
    let others = false, mine = 0;
    for (const s of ops) {
      if (s.seq <= this.seq) continue;
      let op = this.m.revive ? this.m.revive(s.op) : s.op;
      // Worked out against what its author hadn't seen: others' changes after s.seen.
      const against = [];
      for (let i = this.log.length - 1; i >= 0 && this.log[i].seq > s.seen; i--) if (this.log[i].client !== s.client) against.unshift(...flat(this.log[i].op));
      const effective = against.length ? this.m.rebase(op, against) : op;
      for (const e of flat(effective)) this.m.apply(this.confirmed, e);
      this.log.push({ seq: s.seq, client: s.client, op: effective == null ? [] : effective });
      this.seq = s.seq;
      if (s.client === this.client) mine++; else others = true;
    }
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
    if (mine) this.inflight = this.inflight.slice(mine);
    if (!others) return { changed: false };
    // Others' changes arrived: the view is the server's file, with ours (not back yet) worked out again on top.
    this.view = this.m.clone(this.confirmed);
    const redo = (list) => list.map((p) => {
      const against = [];
      for (const l of this.log) if (l.seq > p.seen && l.client !== this.client) against.push(...flat(l.op));
      const r = against.length ? this.m.rebase(p.op, against) : p.op;
      for (const e of flat(r)) this.m.apply(this.view, e);
      return r == null ? null : { seen: this.seq, op: r };
    }).flatMap((x) => (x == null ? [] : Array.isArray(x.op) ? x.op.map((op) => ({ seen: this.seq, op })) : [x]));
    // In-flight changes are already on the server (they'll come back in order); only the queue is rewritten.
    if (this.inflight.length) redo(this.inflight.map((p) => ({ ...p })));
    this.queue = redo(this.queue);
    return { changed: true };
  }
}

return { Session };
});
