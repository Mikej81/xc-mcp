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

  it("omits Authorization header and passes dispatcher when tenant has P12 dispatcher", async () => {
    mockFetch({});
    const stubDispatcher = { stub: "dispatcher" };
    const p12Config: TenantConfig = {
      name: "mtls",
      p12Path: "/tmp/cert.p12",
      p12Password: "pw",
      p12Dispatcher: stubDispatcher,
      tenantUrl: "https://mtls.console.ves.volterra.io",
    };
    await callApi(p12Config, "GET", "/api/test");
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBeUndefined();
    expect(callArgs[1].dispatcher).toBe(stubDispatcher);
  });

  it("uses APIToken header when tenant has apiToken (no dispatcher)", async () => {
    mockFetch({});
    await callApi(config, "GET", "/api/test");
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe("APIToken test-token");
    expect(callArgs[1].dispatcher).toBeUndefined();
  });

  it("sends an object body as a JSON object on the wire", async () => {
    mockFetch({});
    await callApi(config, "POST", "/api/test", { body: { foo: "bar" } });
    const sentBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(sentBody).toBe('{"foo":"bar"}');
  });

  it("passes a JSON-string body through without double-encoding", async () => {
    mockFetch({});
    const preEncoded = '{"foo":"bar"}';
    await callApi(config, "POST", "/api/test", { body: preEncoded });
    const sentBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(sentBody).toBe('{"foo":"bar"}');
  });

  it("encodes a plain (non-JSON) string body as a JSON string", async () => {
    mockFetch({});
    await callApi(config, "POST", "/api/test", { body: "hello" });
    const sentBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(sentBody).toBe('"hello"');
  });

  it("passes a JSON-array string body through without re-encoding", async () => {
    mockFetch({});
    await callApi(config, "POST", "/api/test", { body: "[1,2,3]" });
    const sentBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(sentBody).toBe("[1,2,3]");
  });

  it("encodes JSON-primitive strings (numbers, booleans, null) as JSON strings", async () => {
    for (const input of ["42", "true", "null"]) {
      (fetch as ReturnType<typeof vi.fn>).mockClear();
      mockFetch({});
      await callApi(config, "POST", "/api/test", { body: input });
      const sentBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      expect(sentBody).toBe(JSON.stringify(input));
    }
  });

  it("attaches error_category=backend_unavailable for 503 with gRPC dial string", async () => {
    mockFetch({
      status: 503, statusText: "Service Unavailable",
      text: '{"error":"From server powerdns-config.tenant.int.f5fed.com:50552 connection error"}',
    });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.status).toBe(503);
    expect(result.error_category).toBe("backend_unavailable");
  });

  it("attaches error_category=timeout on AbortError", async () => {
    const abortError = new Error("aborted"); abortError.name = "AbortError";
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);
    const result = await callApi(config, "GET", "/api/test");
    expect(result.error_category).toBe("timeout");
  });

  it("does not set error_category on 2xx", async () => {
    mockFetch({ text: '{"items":[]}' });
    const result = await callApi(config, "GET", "/api/test");
    expect(result.error_category).toBeUndefined();
  });
});
