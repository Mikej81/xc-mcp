import { describe, it, expect, vi } from "vitest";
import { handleCallApi, filterResponse } from "../tools/call-api.js";
import type { TenantConfig } from "../types/index.js";

// Mock the api-client module
vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

// Mock pem-encoding (now async)
vi.mock("../lib/pem-encoding.js", () => ({
  encodePemFields: vi.fn((_config, _path, body) => Promise.resolve(body)),
}));

import { callApi } from "../lib/api-client.js";
import { encodePemFields } from "../lib/pem-encoding.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const mockEncodePemFields = encodePemFields as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

describe("handleCallApi", () => {
  it("returns JSON with status and body for successful response", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "lb1" }] },
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.body.items).toHaveLength(1);
  });

  it("includes warning when response was truncated", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "truncated data",
      truncated: true,
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain("truncated");
    expect(parsed.warning).toContain("response_filter");
  });

  it("forwards params to callApi correctly", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {},
    });

    await handleCallApi(config, {
      method: "POST",
      path: "/api/{ns}/items",
      path_params: { ns: "default" },
      query_params: { limit: "10" },
      body: { name: "new-item" },
    });

    expect(mockCallApi).toHaveBeenCalledWith(config, "POST", "/api/{ns}/items", {
      pathParams: { ns: "default" },
      queryParams: { limit: "10" },
      body: { name: "new-item" },
      skipTruncation: false,
    });
  });

  it("passes config to encodePemFields", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {},
    });

    await handleCallApi(config, {
      method: "POST",
      path: "/api/config/namespaces/default/certificates",
      body: { spec: { certificate_url: "some-pem" } },
    });

    expect(mockEncodePemFields).toHaveBeenCalledWith(
      config,
      "/api/config/namespaces/default/certificates",
      { spec: { certificate_url: "some-pem" } },
    );
  });

  it("truncates output > 60KB", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "x".repeat(70_000),
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(60_000 + 50);
    expect(text).toContain("[Output truncated]");
  });

  it("applies response_filter and sets filtered flag", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [{ name: "lb1", spec: { big: "data" } }, { name: "lb2", spec: { big: "data2" } }],
        metadata: { total: 2 },
      },
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
      response_filter: "items,metadata",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filtered).toBe(true);
    expect(parsed.body.items).toHaveLength(2);
    expect(parsed.body.metadata).toEqual({ total: 2 });
  });

  it("suppresses truncation warning when response_filter is set", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "lb1" }] },
      truncated: true,
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
      response_filter: "items",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.filtered).toBe(true);
  });

  it("does NOT apply response_filter to error responses", async () => {
    mockCallApi.mockResolvedValue({
      status: 400,
      statusText: "Bad Request",
      headers: {},
      body: { message: "CN mismatch", code: 3, details: ["cert error"] },
    });

    const result = await handleCallApi(config, {
      method: "POST",
      path: "/api/test",
      response_filter: "items",
    });
    const parsed = JSON.parse(result.content[0].text);
    // Full error body should be returned, not filtered
    expect(parsed.body.message).toBe("CN mismatch");
    expect(parsed.body.code).toBe(3);
    expect(parsed.body.details).toEqual(["cert error"]);
    expect(parsed.filtered).toBeUndefined();
  });

  it("includes filter_warning when response_filter matches nothing", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "lb1" }], metadata: { total: 1 } },
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
      response_filter: "nonexistent_field",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filter_warning).toContain("matched no fields");
    expect(parsed.filter_warning).toContain("items");
    expect(parsed.filter_warning).toContain("metadata");
  });

  it("applies response_filter even when the raw body would exceed the 50KB cap", async () => {
    const bigPayload = "x".repeat(60 * 1024);
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [{ name: "lb1", giant_field: bigPayload }],
        metadata: { total: 1 },
      },
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
      response_filter: "metadata",
    });

    expect(mockCallApi).toHaveBeenCalledWith(
      config,
      "GET",
      "/api/test",
      expect.objectContaining({ skipTruncation: true }),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filtered).toBe(true);
    expect(parsed.body.metadata).toEqual({ total: 1 });
    expect(parsed.body.items).toBeUndefined();
    expect(parsed.warning).toBeUndefined();
  });

  it("does NOT request skipTruncation when no response_filter is provided", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [] },
    });

    await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });

    const opts = mockCallApi.mock.calls[0][3];
    expect(opts.skipTruncation).not.toBe(true);
  });
});

describe("filterResponse", () => {
  const data = {
    items: [
      { name: "a", labels: { env: "prod" }, spec: { nested: true } },
      { name: "b", labels: { env: "dev" }, spec: { nested: false } },
    ],
    metadata: { total: 2, page: 1 },
    extra: "large-data",
  };

  it("extracts top-level fields", () => {
    const { filtered } = filterResponse(data, "metadata");
    expect((filtered as any).metadata).toEqual({ total: 2, page: 1 });
    expect((filtered as any).items).toBeUndefined();
  });

  it("extracts multiple top-level fields", () => {
    const { filtered } = filterResponse(data, "items,metadata");
    expect((filtered as any).items).toHaveLength(2);
    expect((filtered as any).metadata).toEqual({ total: 2, page: 1 });
    expect((filtered as any).extra).toBeUndefined();
  });

  it("extracts nested fields via dot notation", () => {
    const { filtered } = filterResponse(data, "metadata.total");
    expect((filtered as any).metadata.total).toBe(2);
    expect((filtered as any).metadata.page).toBeUndefined();
  });

  it("extracts array fields with [] notation", () => {
    const { filtered } = filterResponse(data, "items[].name");
    expect((filtered as any).items).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("returns body unchanged when filter is empty", () => {
    const { filtered } = filterResponse(data, "");
    expect(filtered).toEqual(data);
  });

  it("returns body unchanged for non-object body", () => {
    const { filtered } = filterResponse("string-body", "items");
    expect(filtered).toBe("string-body");
  });

  it("reports matchedAny=false when no fields match", () => {
    const { filtered, matchedAny } = filterResponse(data, "nonexistent");
    expect(matchedAny).toBe(false);
    expect((filtered as any).nonexistent).toBeUndefined();
  });

  it("reports matchedAny=true when fields match", () => {
    const { matchedAny } = filterResponse(data, "items");
    expect(matchedAny).toBe(true);
  });
});
