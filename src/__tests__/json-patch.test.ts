import { describe, it, expect } from "vitest";
import { applyPatch, computeDiff, parsePointer, type JsonPatchOp } from "../lib/json-patch.js";

describe("parsePointer", () => {
  it("returns empty array for root", () => {
    expect(parsePointer("")).toEqual([]);
  });

  it("splits a pointer into tokens", () => {
    expect(parsePointer("/spec/routes/0")).toEqual(["spec", "routes", "0"]);
  });

  it("decodes ~1 and ~0 escapes", () => {
    expect(parsePointer("/foo~1bar/~0tilde")).toEqual(["foo/bar", "~tilde"]);
  });

  it("rejects pointers without a leading slash", () => {
    expect(() => parsePointer("spec/routes")).toThrow();
  });
});

describe("applyPatch", () => {
  it("replaces a nested scalar", () => {
    const out = applyPatch({ spec: { timeout: 10 } }, [
      { op: "replace", path: "/spec/timeout", value: 30 },
    ]);
    expect(out).toEqual({ spec: { timeout: 30 } });
  });

  it("adds a new key", () => {
    const out = applyPatch({ spec: {} }, [
      { op: "add", path: "/spec/new_key", value: { hello: "world" } },
    ]);
    expect(out).toEqual({ spec: { new_key: { hello: "world" } } });
  });

  it("removes a key", () => {
    const out = applyPatch({ spec: { drop: 1, keep: 2 } }, [
      { op: "remove", path: "/spec/drop" },
    ]);
    expect(out).toEqual({ spec: { keep: 2 } });
  });

  it("inserts into an array at index", () => {
    const out = applyPatch({ items: ["a", "c"] }, [
      { op: "add", path: "/items/1", value: "b" },
    ]);
    expect(out).toEqual({ items: ["a", "b", "c"] });
  });

  it("appends to an array with '-' index", () => {
    const out = applyPatch({ items: ["a"] }, [
      { op: "add", path: "/items/-", value: "b" },
    ]);
    expect(out).toEqual({ items: ["a", "b"] });
  });

  it("removes an array element", () => {
    const out = applyPatch({ items: ["a", "b", "c"] }, [
      { op: "remove", path: "/items/1" },
    ]);
    expect(out).toEqual({ items: ["a", "c"] });
  });

  it("does not mutate the input doc", () => {
    const input = { spec: { timeout: 10 } };
    applyPatch(input, [{ op: "replace", path: "/spec/timeout", value: 30 }]);
    expect(input.spec.timeout).toBe(10);
  });

  it("throws on invalid array index for replace", () => {
    expect(() =>
      applyPatch({ items: ["a"] }, [{ op: "replace", path: "/items/5", value: "x" }]),
    ).toThrow();
  });

  it("rejects remove on root", () => {
    expect(() => applyPatch({ a: 1 }, [{ op: "remove", path: "" } as JsonPatchOp])).toThrow();
  });
});

describe("computeDiff", () => {
  it("emits empty patch for identical objects", () => {
    const patch = computeDiff({ a: 1, b: 2 }, { a: 1, b: 2 });
    expect(patch).toEqual([]);
  });

  it("emits replace for changed scalar", () => {
    const patch = computeDiff({ a: 1 }, { a: 2 });
    expect(patch).toEqual([{ op: "replace", path: "/a", value: 2 }]);
  });

  it("emits add for new keys", () => {
    const patch = computeDiff({ a: 1 }, { a: 1, b: 2 });
    expect(patch).toEqual([{ op: "add", path: "/b", value: 2 }]);
  });

  it("emits remove for deleted keys", () => {
    const patch = computeDiff({ a: 1, b: 2 }, { a: 1 });
    expect(patch).toEqual([{ op: "remove", path: "/b" }]);
  });

  it("recurses into nested objects", () => {
    const patch = computeDiff(
      { spec: { timeout: 10, retries: 3 } },
      { spec: { timeout: 30, retries: 3 } },
    );
    expect(patch).toEqual([{ op: "replace", path: "/spec/timeout", value: 30 }]);
  });

  it("treats array changes as replace", () => {
    const patch = computeDiff({ items: ["a", "b"] }, { items: ["a", "b", "c"] });
    expect(patch).toEqual([{ op: "replace", path: "/items", value: ["a", "b", "c"] }]);
  });

  it("applying the diff makes from match to", () => {
    const from = { spec: { timeout: 10, headers: { a: "1" } }, drop: true };
    const to = { spec: { timeout: 30, headers: { a: "1", b: "2" } } };
    const patch = computeDiff(from, to);
    expect(applyPatch(from, patch)).toEqual(to);
  });
});
