import { describe, it, expect } from "vitest";
import { classifyError } from "../lib/error-classifier.js";

describe("classifyError", () => {
  it("returns undefined for 2xx", () => {
    expect(classifyError(200, "OK", {})).toBeUndefined();
    expect(classifyError(204, "No Content", null)).toBeUndefined();
  });

  it("classifies 401/403 as auth/permission", () => {
    expect(classifyError(401, "Unauthorized", {})).toBe("auth_failure");
    expect(classifyError(403, "Forbidden", {})).toBe("permission_denied");
  });

  it("classifies 404 as not_found", () => {
    expect(classifyError(404, "Not Found", {})).toBe("not_found");
  });

  it("classifies 408/504 as timeout", () => {
    expect(classifyError(408, "Request Timeout", {})).toBe("timeout");
    expect(classifyError(504, "Gateway Timeout", {})).toBe("timeout");
  });

  it("classifies 409 as config_conflict", () => {
    expect(classifyError(409, "Conflict", {})).toBe("config_conflict");
  });

  it("classifies 429 as rate_limited", () => {
    expect(classifyError(429, "Too Many Requests", {})).toBe("rate_limited");
  });

  it("classifies 400 as validation_error", () => {
    expect(classifyError(400, "Bad Request", { error: "schema" })).toBe("validation_error");
  });

  it("classifies 503 with gRPC dial string as backend_unavailable", () => {
    const body = { error: "From server powerdns-config.dns-us-gov.tenant.int.f5fed.com:50552 connection error: lookup ... on 10.127.0.10:53: no such host" };
    expect(classifyError(503, "Service Unavailable", body)).toBe("backend_unavailable");
  });

  it("classifies plain 503 as backend_unavailable", () => {
    expect(classifyError(503, "Service Unavailable", {})).toBe("backend_unavailable");
  });

  it("classifies 5xx with gRPC dial string as backend_unavailable", () => {
    const body = "From server powerdns-config.tenant.int.f5fed.com:50552 connection error";
    expect(classifyError(500, "Internal Server Error", body)).toBe("backend_unavailable");
  });

  it("classifies other 5xx as server_error", () => {
    expect(classifyError(500, "Internal Server Error", {})).toBe("server_error");
    expect(classifyError(502, "Bad Gateway", {})).toBe("server_error");
  });

  it("returns undefined for 3xx redirects", () => {
    expect(classifyError(301, "Moved Permanently", {})).toBeUndefined();
  });
});
