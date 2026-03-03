import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const config: TenantConfig = {
  name: "test",
  apiToken: "test-token",
  tenantUrl: "https://test.console.ves.volterra.io",
};

describe("callApi", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockFetch(response: {
    status?: number;
    statusText?: string;
    text?: string;
    headers?: Record<string, string>;
  }) {
    const headers = new Map(Object.entries(response.headers || {}));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      headers: {
        forEach: (cb: (value: string, key: string) => void) => {
          headers.forEach((v, k) => cb(v, k));
        },
      },
      text: () => Promise.resolve(response.text ?? "{}"),
    });
  }

  it("returns parsed JSON for 200 response", async () => {
    mockFetch({ text: '{"items": []}' });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [] });
  });

  it("returns non-200 status without throwing", async () => {
    mockFetch({ status: 404, statusText: "Not Found", text: '{"error": "not found"}' });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.status).toBe(404);
    expect(result.statusText).toBe("Not Found");
  });

  it("sets truncated flag for responses > 50KB", async () => {
    const largeText = "x".repeat(60 * 1024);
    mockFetch({ text: largeText });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.truncated).toBe(true);
  });

  it("returns raw string for non-JSON response", async () => {
    mockFetch({ text: "plain text response" });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.body).toBe("plain text response");
  });

  it("returns status 408 on timeout (AbortError)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);
    const result = await callApi(config, "GET", "/api/test");
    expect(result.status).toBe(408);
    expect(result.statusText).toBe("Request Timeout");
  });

  it("returns status 0 on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await callApi(config, "GET", "/api/test");
    expect(result.status).toBe(0);
    expect(result.statusText).toBe("Network Error");
    expect((result.body as any).error).toBe("ECONNREFUSED");
  });

  it("always includes auth header", async () => {
    mockFetch({});
    await callApi(config, "GET", "/api/test");
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe("APIToken test-token");
  });

  it("sets Content-Type only when body is provided", async () => {
    mockFetch({});
    await callApi(config, "POST", "/api/test", { body: { foo: "bar" } });
    const withBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(withBody[1].headers["Content-Type"]).toBe("application/json");

    mockFetch({});
    await callApi(config, "GET", "/api/test");
    const withoutBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(withoutBody[1].headers["Content-Type"]).toBeUndefined();
  });

  it("appends query params to URL", async () => {
    mockFetch({});
    await callApi(config, "GET", "/api/test", { queryParams: { foo: "bar" } });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toContain("foo=bar");
  });

  it("substitutes path params", async () => {
    mockFetch({});
    await callApi(config, "GET", "/api/{ns}/resources", { pathParams: { ns: "default" } });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toContain("/api/default/resources");
  });
});
