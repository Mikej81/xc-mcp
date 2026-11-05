import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../lib/session-registry.js";

function make(
  opts: Partial<{ maxSessions: number; maxPerFingerprint: number; idleMs: number; minIdleForEvictMs: number }> = {},
) {
  let t = 0;
  const clock = { advance: (n: number) => (t += n) };
  const reg = new SessionRegistry<string>({
    maxSessions: Infinity, maxPerFingerprint: Infinity, idleMs: 1000, minIdleForEvictMs: 0, ...opts, now: () => t,
  });
  return { reg, clock };
}

function evictedSids(r: ReturnType<SessionRegistry<string>["admit"]>): string[] {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.evicted.map((e) => e.sid);
}

describe("SessionRegistry", () => {
  it("evicts oldest same-fingerprint session at per-credential cap", () => {
    const { reg, clock } = make({ maxPerFingerprint: 2 });
    reg.add("a1", "a", "v1"); clock.advance(1);
    reg.add("b1", "b", "vb"); clock.advance(1);
    reg.add("a2", "a", "v2"); clock.advance(1);
    const ev = reg.admit("a");
    expect(ev).toEqual({ ok: true, evicted: [{ sid: "a1", value: "v1", reason: "per_credential_cap" }] });
    expect(reg.get("b1")).toBeDefined();
    expect(reg.size).toBe(2);
  });

  it("evicts globally oldest at global cap", () => {
    const { reg, clock } = make({ maxSessions: 3 });
    reg.add("x", "a", "1"); clock.advance(1);
    reg.add("y", "b", "2"); clock.advance(1);
    reg.add("z", "c", "3"); clock.advance(1);
    expect(reg.admit("d")).toEqual({ ok: true, evicted: [{ sid: "x", value: "1", reason: "global_cap" }] });
  });

  it("breaks lastActive ties by insertion order", () => {
    const { reg } = make({ maxSessions: 2 });
    reg.add("first", "a", "1");
    reg.add("second", "b", "2");
    expect(evictedSids(reg.admit("c"))).toEqual(["first"]);
  });

  it("applies per-credential then global eviction", () => {
    const { reg, clock } = make({ maxSessions: 2, maxPerFingerprint: 1 });
    reg.add("b1", "b", "1"); clock.advance(1);
    reg.add("a1", "a", "2"); clock.advance(1);
    const ev = reg.admit("a");
    expect(ev.ok && ev.evicted.map((e) => [e.sid, e.reason])).toEqual([["a1", "per_credential_cap"]]);
    reg.add("a2", "a", "3"); clock.advance(1);
    const ev2 = reg.admit("c");
    expect(ev2.ok && ev2.evicted.map((e) => [e.sid, e.reason])).toEqual([["b1", "global_cap"]]);
  });

  it("touch changes LRU order", () => {
    const { reg, clock } = make({ maxSessions: 2 });
    reg.add("x", "a", "1"); clock.advance(1);
    reg.add("y", "b", "2"); clock.advance(1);
    reg.touch("x"); clock.advance(1);
    expect(evictedSids(reg.admit("c"))).toEqual(["y"]);
  });

  it("sweepIdle removes sessions idle longer than idleMs", () => {
    const { reg, clock } = make({ idleMs: 1000 });
    reg.add("old", "a", "1"); clock.advance(600);
    reg.add("new", "a", "2"); clock.advance(600);
    expect(reg.sweepIdle()).toEqual([{ sid: "old", value: "1", reason: "idle" }]);
    expect(reg.size).toBe(1);
  });

  it("remove returns false for unknown sid; entries yields [sid, value]", () => {
    const { reg } = make();
    expect(reg.remove("nope")).toBe(false);
    reg.add("s", "f", "val");
    expect([...reg.entries()]).toEqual([["s", "val"]]);
    expect(reg.remove("s")).toBe(true);
  });

  it("admit below caps evicts nothing", () => {
    const { reg } = make({ maxSessions: 3, maxPerFingerprint: 2 });
    reg.add("a1", "a", "1");
    reg.add("b1", "b", "2");
    expect(reg.admit("a")).toEqual({ ok: true, evicted: [] });
    expect(reg.size).toBe(2);
  });

  it("sweepIdle keeps a session idle for exactly idleMs", () => {
    const { reg, clock } = make({ idleMs: 1000 });
    reg.add("s", "a", "1"); clock.advance(1000);
    expect(reg.sweepIdle()).toEqual([]);
    clock.advance(1);
    expect(reg.sweepIdle()).toHaveLength(1);
  });

  it("touch on unknown sid is a no-op", () => {
    const { reg } = make();
    expect(() => reg.touch("nope")).not.toThrow();
    expect(reg.size).toBe(0);
  });

  describe("inactivity-gated eviction", () => {
    it("refuses at the per-credential cap when the LRU session is still active", () => {
      const { reg, clock } = make({ maxPerFingerprint: 2, minIdleForEvictMs: 300_000 });
      reg.add("a1", "a", "1"); clock.advance(10_000);
      reg.add("a2", "a", "2"); clock.advance(5_000);
      expect(reg.admit("a")).toEqual({ ok: false, reason: "per_credential_cap", retryAfterMs: 285_000 });
      expect(reg.size).toBe(2);
      expect(reg.get("a1")).toBeDefined();
    });

    it("evicts the LRU session once it has been idle for the threshold", () => {
      const { reg, clock } = make({ maxPerFingerprint: 2, minIdleForEvictMs: 300_000 });
      reg.add("a1", "a", "1"); clock.advance(10_000);
      reg.add("a2", "a", "2"); clock.advance(290_000);
      expect(reg.admit("a")).toEqual({ ok: true, evicted: [{ sid: "a1", value: "1", reason: "per_credential_cap" }] });
      expect(reg.get("a2")).toBeDefined();
    });

    it("a touch resets the idle clock for eviction", () => {
      const { reg, clock } = make({ maxPerFingerprint: 1, minIdleForEvictMs: 1000 });
      reg.add("a1", "a", "1"); clock.advance(900);
      reg.touch("a1"); clock.advance(900);
      expect(reg.admit("a")).toEqual({ ok: false, reason: "per_credential_cap", retryAfterMs: 100 });
    });

    it("per-credential refusal leaves other users' idle sessions alone", () => {
      const { reg, clock } = make({ maxPerFingerprint: 1, minIdleForEvictMs: 1000 });
      reg.add("b1", "b", "vb"); clock.advance(5000);
      reg.add("a1", "a", "va"); clock.advance(10);
      const r = reg.admit("a");
      expect(r).toEqual({ ok: false, reason: "per_credential_cap", retryAfterMs: 990 });
      expect(reg.get("b1")).toBeDefined();
      expect(reg.size).toBe(2);
    });

    it("refuses at the global cap when the global LRU session is still active", () => {
      const { reg, clock } = make({ maxSessions: 2, minIdleForEvictMs: 1000 });
      reg.add("x", "a", "1"); clock.advance(200);
      reg.add("y", "b", "2"); clock.advance(300);
      expect(reg.admit("c")).toEqual({ ok: false, reason: "global_cap", retryAfterMs: 500 });
      expect(reg.size).toBe(2);
    });

    it("does not evict for the per-credential cap when the global check then refuses", () => {
      const { reg, clock } = make({ maxSessions: 2, maxPerFingerprint: 2, minIdleForEvictMs: 1000 });
      reg.add("a1", "a", "1"); clock.advance(2000);
      reg.add("b1", "b", "2"); clock.advance(10);
      // Global cap hit; global LRU a1 is idle long enough, so it goes.
      expect(evictedSids(reg.admit("c"))).toEqual(["a1"]);
      reg.add("c1", "c", "3"); clock.advance(10);
      // Global LRU is now b1 (idle 20ms): refused, nothing removed.
      expect(reg.admit("d")).toEqual({ ok: false, reason: "global_cap", retryAfterMs: 980 });
      expect(reg.size).toBe(2);
    });

    it("local-mode settings (no caps, zero threshold) never refuse", () => {
      const reg = new SessionRegistry<string>({
        maxSessions: Infinity, maxPerFingerprint: Infinity, idleMs: 1000, minIdleForEvictMs: 0, now: () => 0,
      });
      for (let i = 0; i < 50; i++) {
        expect(reg.admit("")).toEqual({ ok: true, evicted: [] });
        reg.add(`s${i}`, "", "v");
      }
      expect(reg.size).toBe(50);
    });
  });
});
