export type EvictReason = "per_credential_cap" | "global_cap" | "idle";
export type RefuseReason = "per_credential_cap" | "global_cap";
export interface Evicted<T> {
  sid: string;
  value: T;
  reason: EvictReason;
}

export type AdmitResult<T> =
  | { ok: true; evicted: Evicted<T>[] }
  | { ok: false; reason: RefuseReason; retryAfterMs: number };

interface Entry<T> {
  value: T;
  fingerprint: string;
  lastActive: number;
}

export class SessionRegistry<T> {
  private readonly sessions = new Map<string, Entry<T>>();
  private readonly maxSessions: number;
  private readonly maxPerFingerprint: number;
  private readonly idleMs: number;
  private readonly minIdleForEvictMs: number;
  private readonly now: () => number;

  constructor(opts: {
    maxSessions: number;
    maxPerFingerprint: number;
    idleMs: number;
    /** A session must be idle at least this long before a cap may evict it. */
    minIdleForEvictMs: number;
    now?: () => number;
  }) {
    this.maxSessions = opts.maxSessions;
    this.maxPerFingerprint = opts.maxPerFingerprint;
    this.idleMs = opts.idleMs;
    this.minIdleForEvictMs = opts.minIdleForEvictMs;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Decide whether one more session for `fingerprint` fits. At a cap, the
   * least-recently-active session in that scope is evicted only if it has been
   * idle for at least minIdleForEvictMs; otherwise the new session is refused
   * and nothing is evicted. On success the victims are already removed.
   */
  admit(fingerprint: string): AdmitResult<T> {
    const now = this.now();
    const victims = new Map<string, Evicted<T>>();
    const lru = (fp?: string): [string, Entry<T>] | undefined => {
      let best: [string, Entry<T>] | undefined;
      for (const [sid, e] of this.sessions) {
        if (victims.has(sid) || (fp !== undefined && e.fingerprint !== fp)) continue;
        if (!best || e.lastActive < best[1].lastActive) best = [sid, e];
      }
      return best;
    };
    const countFp = () => {
      let n = 0;
      for (const [sid, e] of this.sessions) if (e.fingerprint === fingerprint && !victims.has(sid)) n++;
      return n;
    };
    const tryEvict = (reason: RefuseReason, fp?: string): AdmitResult<T> | "evicted" | "none" => {
      const candidate = lru(fp);
      if (!candidate) return "none";
      const [sid, e] = candidate;
      const idle = now - e.lastActive;
      if (idle < this.minIdleForEvictMs) {
        return { ok: false, reason, retryAfterMs: this.minIdleForEvictMs - idle };
      }
      victims.set(sid, { sid, value: e.value, reason });
      return "evicted";
    };

    while (countFp() >= this.maxPerFingerprint) {
      const r = tryEvict("per_credential_cap", fingerprint);
      if (r === "none") break;
      if (r !== "evicted") return r;
    }
    while (this.sessions.size - victims.size >= this.maxSessions) {
      const r = tryEvict("global_cap");
      if (r === "none") break;
      if (r !== "evicted") return r;
    }
    for (const sid of victims.keys()) this.sessions.delete(sid);
    return { ok: true, evicted: [...victims.values()] };
  }

  add(sid: string, fingerprint: string, value: T): void {
    this.sessions.set(sid, { value, fingerprint, lastActive: this.now() });
  }

  get(sid: string): { value: T; fingerprint: string } | undefined {
    const e = this.sessions.get(sid);
    return e ? { value: e.value, fingerprint: e.fingerprint } : undefined;
  }

  touch(sid: string): void {
    const e = this.sessions.get(sid);
    if (e) e.lastActive = this.now();
  }

  remove(sid: string): boolean {
    return this.sessions.delete(sid);
  }

  sweepIdle(): Evicted<T>[] {
    const cutoff = this.now();
    const out: Evicted<T>[] = [];
    for (const [sid, e] of [...this.sessions]) {
      if (cutoff - e.lastActive > this.idleMs) {
        out.push({ sid, value: e.value, reason: "idle" });
        this.sessions.delete(sid);
      }
    }
    return out;
  }

  *entries(): IterableIterator<[string, T]> {
    for (const [sid, e] of this.sessions) yield [sid, e.value];
  }
}
