import { describe, it, expect } from "vitest";
import { parseAuthConfig, checkAuth } from "../lib/auth.js";

describe("parseAuthConfig", () => {
  it("returns disabled when neither env var is set", () => {
    const cfg = parseAuthConfig({});
    expect(cfg).toEqual({ enabled: false });
  });

  it("returns enabled config when both env vars are set", () => {
    const cfg = parseAuthConfig({
      MCP_AUTH_HEADER_NAME: "X-API-Key",
      MCP_AUTH_HEADER_VALUE: "s3cr3t",
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      // Header name lookups happen against Node's lower-cased header dict.
      expect(cfg.headerName).toBe("x-api-key");
      expect(cfg.headerValue).toBe("s3cr3t");
    }
  });

  it("throws when only the name is set", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_NAME: "X-API-Key" }),
    ).toThrow(/both/i);
  });

  it("throws when only the value is set", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_VALUE: "s3cr3t" }),
    ).toThrow(/both/i);
  });

  it("treats empty string as unset", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_NAME: "X-API-Key", MCP_AUTH_HEADER_VALUE: "" }),
    ).toThrow(/both/i);
  });
});

describe("checkAuth", () => {
  it("passes everything when auth is disabled", () => {
    const result = checkAuth({ enabled: false }, {});
    expect(result).toEqual({ ok: true });
  });

  it("returns missing when header is absent", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      {},
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("returns mismatch on wrong value", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "wrong" },
    );
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("returns ok on exact match", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "s3cr3t" },
    );
    expect(result).toEqual({ ok: true });
  });

  it("handles different-length supplied value without throwing", () => {
    expect(() =>
      checkAuth(
        { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
        { "x-api-key": "x" },
      ),
    ).not.toThrow();
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "x" },
    );
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("uses the first value when header is sent as an array", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": ["s3cr3t", "ignored"] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns missing when header value is empty string", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "" },
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });
});
