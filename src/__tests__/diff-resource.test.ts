import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantConfig } from "../types/index.js";

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../lib/api-client.js";
import { handleDiffResource } from "../tools/diff-resource.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("handleDiffResource", () => {
  it("returns empty patch when bodies match (after strip)", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        metadata: { name: "lb1", namespace: "ns1", uid: "abc" },
        spec: { connection_idle_timeout: 5000 },
        system_metadata: { tenant: "x" },
      },
    });

    const result = await handleDiffResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      body: {
        metadata: { name: "lb1", namespace: "ns1" },
        spec: { connection_idle_timeout: 5000 },
      },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.unchanged).toBe(true);
    expect(parsed.patch).toEqual([]);
  });

  it("ignores the GET envelope (create_form, referring_objects, ...) for an identical body", async () => {
    const metadata = { name: "pool1", namespace: "ns1", labels: { a: "b" }, annotations: {}, description: "d", disable: false };
    const spec = { origin_servers: [{ public_name: { dns_name: "x.example.com" } }], port: 443 };
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        object: null,
        create_form: { metadata: {}, spec: {} },
        replace_form: { metadata: {}, spec: {} },
        resource_version: "12345",
        metadata: { ...metadata, uid: "u-1" },
        system_metadata: { tenant: "t", uid: "u-1", creation_timestamp: "2026-11-05T00:00:00Z" },
        spec,
        status: [],
        referring_objects: [{ kind: "http_loadbalancer", name: "lb1" }],
        deleted_referred_objects: [],
        disabled_referred_objects: [],
      },
    });

    const result = await handleDiffResource(config, {
      resource: "origin_pools/ns1/pool1",
      body: { metadata, spec },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.patch).toEqual([]);
    expect(parsed.unchanged).toBe(true);
  });

  it("still reports a real metadata change next to the envelope", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        create_form: {}, resource_version: "1", referring_objects: [],
        metadata: { name: "pool1", namespace: "ns1", labels: { env: "prod" } },
        spec: { port: 443 },
      },
    });
    const result = await handleDiffResource(config, {
      resource: "origin_pools/ns1/pool1",
      body: { metadata: { name: "pool1", namespace: "ns1", labels: { env: "dev" } }, spec: { port: 443 } },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.patch).toEqual([{ op: "replace", path: "/metadata/labels/env", value: "dev" }]);
  });

  it("returns patch ops for actual changes", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        metadata: { name: "lb1", namespace: "ns1" },
        spec: { connection_idle_timeout: 5000, drop_me: true },
      },
    });

    const result = await handleDiffResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      body: {
        metadata: { name: "lb1", namespace: "ns1" },
        spec: { connection_idle_timeout: 30000, new_field: "x" },
      },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.unchanged).toBe(false);
    const paths = parsed.patch.map((o: any) => `${o.op}:${o.path}`);
    expect(paths).toContain("replace:/spec/connection_idle_timeout");
    expect(paths).toContain("remove:/spec/drop_me");
    expect(paths).toContain("add:/spec/new_field");
  });

  it("returns isError when GET fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 404, statusText: "Not Found", headers: {},
      body: { code: 5 },
    });

    const result = await handleDiffResource(config, {
      resource: "http_loadbalancers/ns1/missing",
      body: { metadata: { name: "missing" }, spec: {} },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects non-object body", async () => {
    const result = await handleDiffResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      body: null as any,
    });
    expect(result.isError).toBe(true);
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});
