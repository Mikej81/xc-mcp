import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantConfig } from "../types/index.js";

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../lib/api-client.js";
import { handlePatchResource } from "../tools/patch-resource.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("handlePatchResource", () => {
  it("does GET then PUT with stripped+patched body", async () => {
    mockCallApi
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: {
          metadata: { name: "lb1", namespace: "ns1", uid: "abc", creation_timestamp: "t" },
          spec: { connection_idle_timeout: 5000, view_internal: { something: 1 } },
          system_metadata: { tenant: "x" },
          resource_version: "v1",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: { resource_version: "v2" },
      });

    const result = await handlePatchResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      ops: [{ op: "replace", path: "/spec/connection_idle_timeout", value: 30000 }],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.ops_applied).toBe(1);
    expect(parsed.resource_version_before).toBe("v1");
    expect(parsed.resource_version_after).toBe("v2");

    expect(mockCallApi).toHaveBeenCalledTimes(2);
    const [, getMethod, getPath] = mockCallApi.mock.calls[0];
    expect(getMethod).toBe("GET");
    expect(getPath).toBe("/api/config/namespaces/ns1/http_loadbalancers/lb1");

    const [, putMethod, putPath, putOpts] = mockCallApi.mock.calls[1];
    expect(putMethod).toBe("PUT");
    expect(putPath).toBe("/api/config/namespaces/ns1/http_loadbalancers/lb1");

    const putBody = (putOpts as any).body;
    expect(putBody.spec.connection_idle_timeout).toBe(30000);
    expect(putBody.system_metadata).toBeUndefined();
    expect(putBody.metadata.uid).toBeUndefined();
    expect(putBody.spec.view_internal).toBeUndefined();
    expect(putBody.resource_version).toBe("v1");
  });

  it("returns isError when GET fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 404,
      statusText: "Not Found",
      headers: {},
      body: { code: 5, message: "not found" },
    });

    const result = await handlePatchResource(config, {
      resource: "http_loadbalancers/ns1/missing",
      ops: [{ op: "replace", path: "/spec/foo", value: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GET failed");
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });

  it("returns isError when PUT fails", async () => {
    mockCallApi
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: { metadata: { name: "lb1" }, spec: {} },
      })
      .mockResolvedValueOnce({
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: { code: 3, message: "validation failed" },
      });

    const result = await handlePatchResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      ops: [{ op: "replace", path: "/spec/foo", value: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("PUT failed");
    expect(result.content[0].text).toContain("validation failed");
  });

  it("rejects empty ops array", async () => {
    const result = await handlePatchResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      ops: [],
    });
    expect(result.isError).toBe(true);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("skips resource_version inclusion when check_resource_version=false", async () => {
    mockCallApi
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: { metadata: { name: "lb1" }, spec: {}, resource_version: "v1" },
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      });

    await handlePatchResource(config, {
      resource: "http_loadbalancers/ns1/lb1",
      ops: [{ op: "add", path: "/spec/foo", value: 1 }],
      check_resource_version: false,
    });

    const [, , , putOpts] = mockCallApi.mock.calls[1];
    expect((putOpts as any).body.resource_version).toBeUndefined();
  });
});
