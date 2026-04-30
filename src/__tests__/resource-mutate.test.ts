import { describe, it, expect } from "vitest";
import {
  extractResourceVersion,
  parseResourceRef,
  stripReadOnlyFields,
} from "../lib/resource-mutate.js";

describe("parseResourceRef", () => {
  it("parses type/namespace/name shorthand", () => {
    const ref = parseResourceRef("http_loadbalancers/m-coleman/my-lb");
    expect(ref.resourceType).toBe("http_loadbalancers");
    expect(ref.namespace).toBe("m-coleman");
    expect(ref.name).toBe("my-lb");
    expect(ref.path).toBe("/api/config/namespaces/m-coleman/http_loadbalancers/my-lb");
  });

  it("parses full /api path form", () => {
    const ref = parseResourceRef("/api/config/namespaces/default/origin_pools/pool-x");
    expect(ref.resourceType).toBe("origin_pools");
    expect(ref.namespace).toBe("default");
    expect(ref.name).toBe("pool-x");
  });

  it("uses defaultNamespace for type/name shorthand", () => {
    const ref = parseResourceRef("http_loadbalancers/my-lb", "ns1");
    expect(ref.namespace).toBe("ns1");
    expect(ref.name).toBe("my-lb");
  });

  it("throws when shorthand is ambiguous and no default is provided", () => {
    expect(() => parseResourceRef("http_loadbalancers/my-lb")).toThrow();
  });

  it("URL-encodes namespace/name in the path", () => {
    const ref = parseResourceRef("http_loadbalancers/my ns/my-lb");
    expect(ref.path).toContain("my%20ns");
  });
});

describe("stripReadOnlyFields", () => {
  it("removes top-level system_metadata", () => {
    const out = stripReadOnlyFields({ metadata: {}, spec: {}, system_metadata: { tenant: "x" } });
    expect((out as any).system_metadata).toBeUndefined();
  });

  it("removes uid and timestamps from metadata", () => {
    const out = stripReadOnlyFields({
      metadata: {
        name: "x",
        namespace: "n",
        uid: "abc",
        creation_timestamp: "2025-01-01",
        modification_timestamp: "2025-01-02",
        tenant: "t",
      },
      spec: {},
    });
    expect(out.metadata.uid).toBeUndefined();
    expect(out.metadata.creation_timestamp).toBeUndefined();
    expect(out.metadata.modification_timestamp).toBeUndefined();
    expect(out.metadata.tenant).toBeUndefined();
    expect(out.metadata.name).toBe("x");
    expect(out.metadata.namespace).toBe("n");
  });

  it("removes top-level status", () => {
    const out = stripReadOnlyFields({
      metadata: { name: "x" },
      spec: {},
      status: [{ conditions: [{ status: "Success" }] }],
    });
    expect((out as any).status).toBeUndefined();
  });

  it("removes spec.view_internal", () => {
    const out = stripReadOnlyFields({
      metadata: { name: "x" },
      spec: { view_internal: { foo: 1 }, keep: true },
    });
    expect(out.spec.view_internal).toBeUndefined();
    expect(out.spec.keep).toBe(true);
  });

  it("preserves resource_version", () => {
    const out = stripReadOnlyFields({
      metadata: { name: "x" },
      spec: {},
      resource_version: "v1",
    });
    expect(out.resource_version).toBe("v1");
  });

  it("does not mutate the input", () => {
    const input = { metadata: { uid: "abc", name: "x" }, spec: {} };
    stripReadOnlyFields(input);
    expect(input.metadata.uid).toBe("abc");
  });

  it("throws on non-object body", () => {
    expect(() => stripReadOnlyFields(null)).toThrow();
  });
});

describe("extractResourceVersion", () => {
  it("reads top-level resource_version", () => {
    expect(extractResourceVersion({ resource_version: "v1" })).toBe("v1");
  });

  it("reads metadata.resource_version", () => {
    expect(extractResourceVersion({ metadata: { resource_version: "v2" } })).toBe("v2");
  });

  it("returns undefined when missing", () => {
    expect(extractResourceVersion({ metadata: {} })).toBeUndefined();
  });
});
