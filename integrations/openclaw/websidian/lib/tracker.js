// Notes written per session: `all` for the websidian_links tool, `pending` for the next reply footer.
const MAX_TRACKED_PER_SESSION = 200;
const MAX_SESSIONS = 256;

export class ChangeTracker {
  constructor() { this.sessions = new Map(); }

  session(sid) {
    const key = sid || 'default';
    let s = this.sessions.get(key);
    if (s) { this.sessions.delete(key); this.sessions.set(key, s); return s; } // move to the end (LRU)
    s = { all: new Map(), pending: new Map() };
    this.sessions.set(key, s);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    return s;
  }

  record(sid, entry) {
    const s = this.session(sid);
    const key = entry.rel + '\0' + entry.vault;
    for (const bucket of [s.all, s.pending]) {
      bucket.delete(key);
      bucket.set(key, entry);
      while (bucket.size > MAX_TRACKED_PER_SESSION) bucket.delete(bucket.keys().next().value);
    }
  }

  all(sid) {
    const s = this.sessions.get(sid || 'default');
    return s ? [...s.all.values()] : [];
  }

  hasPending(sid) {
    const s = this.sessions.get(sid || 'default');
    return !!s && s.pending.size > 0;
  }

  takePending(sid) {
    const s = this.sessions.get(sid || 'default');
    if (!s) return [];
    const items = [...s.pending.values()];
    s.pending.clear();
    return items;
  }
}
