import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api-client.js", () => ({ callApi: vi.fn() }));

import { handleLbSetRequestHeaders } from "../tools/lb-set-request-headers.js";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const config: TenantConfig = { name: "test", apiToken: "tok", tenantUrl: "https://t.ves.volterra.io" };

describe("handleLbSetRequestHeaders", () => {
  beforeEach(() => { mockCallApi.mockReset(); });

  it("issues GET then PUT and appends a new header", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { spec: { add_request_headers: [{ name: "X-Existing", value: "1" }] }, resource_version: "v1" },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: { resource_version: "v2" } });

    const result = await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
      add: [{ name: "X-Forwarded-Host", value: "example.com" }],
    });

    expect(mockCallApi).toHaveBeenCalledTimes(2);
    const putCall = mockCallApi.mock.calls[1];
    expect(putCall[1]).toBe("PUT");
    const sentBody = putCall[3].body;
    expect(sentBody.spec.add_request_headers).toEqual([
      { name: "X-Existing", value: "1" },
      { name: "X-Forwarded-Host", value: "example.com" },
    ]);
    expect(result.content[0].text).toContain("v2");
  });

  it("replaces (not duplicates) headers whose names match", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { add_request_headers: [{ name: "X-Forwarded-Host", value: "old" }] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
      add: [{ name: "X-Forwarded-Host", value: "new" }],
    });

    const sent = mockCallApi.mock.calls[1][3].body;
    expect(sent.spec.add_request_headers).toEqual([{ name: "X-Forwarded-Host", value: "new" }]);
  });

  it("removes named headers", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { add_request_headers: [{ name: "X-A", value: "1" }, { name: "X-B", value: "2" }] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
      remove: ["X-A"],
    });

    const sent = mockCallApi.mock.calls[1][3].body;
    expect(sent.spec.add_request_headers).toEqual([{ name: "X-B", value: "2" }]);
  });

  it("errors when neither add nor remove is provided", async () => {
    const result = await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
    });
    expect(result.isError).toBe(true);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("preserves resource_version by default for optimistic concurrency", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { add_request_headers: [] }, resource_version: "v42" },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
      add: [{ name: "X-New", value: "v" }],
    });

    expect(mockCallApi.mock.calls[1][3].body.resource_version).toBe("v42");
  });

  it("strips resource_version when check_resource_version is false", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { add_request_headers: [] }, resource_version: "v42" },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handleLbSetRequestHeaders(config, {
      namespace: "default", name: "my-lb",
      add: [{ name: "X-New", value: "v" }],
      check_resource_version: false,
    });

    expect(mockCallApi.mock.calls[1][3].body.resource_version).toBeUndefined();
  });
});
