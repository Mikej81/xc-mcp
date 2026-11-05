import { describe, it, expect } from "vitest";
import {
  parseHostedConfig,
  findTenantEnvVars,
  validateHostedTenantUrl,
  parseCredentialHeaders,
  credentialFingerprint,
  HOSTED_HEADERS,
  DEFAULT_ALLOWED_DOMAINS,
} from "../lib/hosted.js";

const ALLOW = [".console.ves.volterra.io"];
const H = HOSTED_HEADERS;
const goodUrl = "https://acme.console.ves.volterra.io";

describe("parseHostedConfig", () => {
  it("returns defaults", () => {
    expect(parseHostedConfig({})).toEqual({
      allowedDomains: [".console.ves.volterra.io"],
      maxSessions: 500,
      maxSessionsPerCredential: 5,
      evictMinIdleMs: 300_000,
    });
    expect(DEFAULT_ALLOWED_DOMAINS).toEqual([".console.ves.volterra.io"]);
  });
  it("normalizes allowed domains", () => {
    const c = parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: "console.ves.volterra.io, .Example.gov, ," });
    expect(c.allowedDomains).toEqual([".console.ves.volterra.io", ".example.gov"]);
  });
  it("accepts a valid allowlist suffix", () => {
    expect(parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: "example.gov" }).allowedDomains).toEqual([".example.gov"]);
  });
  it("throws on a single-label suffix", () => {
    expect(() => parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: "com" })).toThrow(/XC_HOSTED_ALLOWED_DOMAINS/);
    expect(() => parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: ".com" })).toThrow();
  });
  it("throws when the allowlist normalizes to empty", () => {
    expect(() => parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: " , " })).toThrow(/XC_HOSTED_ALLOWED_DOMAINS/);
  });
  it("throws on suffixes with characters outside [a-z0-9.-]", () => {
    for (const bad of ["*.example.gov", "https://example.gov", "example.gov:443", "exa mple.gov"]) {
      expect(() => parseHostedConfig({ XC_HOSTED_ALLOWED_DOMAINS: bad })).toThrow();
    }
  });
  it("throws on non-positive-integer caps", () => {
    expect(() => parseHostedConfig({ MCP_HOSTED_MAX_SESSIONS: "0" })).toThrow();
    expect(() => parseHostedConfig({ MCP_HOSTED_MAX_SESSIONS: "abc" })).toThrow();
    expect(() => parseHostedConfig({ MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL: "-1" })).toThrow();
    expect(() => parseHostedConfig({ MCP_HOSTED_MAX_SESSIONS: "1.5" })).toThrow();
  });
  it("reads caps", () => {
    const c = parseHostedConfig({ MCP_HOSTED_MAX_SESSIONS: "10", MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL: "2" });
    expect(c.maxSessions).toBe(10);
    expect(c.maxSessionsPerCredential).toBe(2);
  });
  it("reads MCP_HOSTED_EVICT_MIN_IDLE_SECONDS as milliseconds", () => {
    expect(parseHostedConfig({ MCP_HOSTED_EVICT_MIN_IDLE_SECONDS: "60" }).evictMinIdleMs).toBe(60_000);
  });
  it("throws on an invalid MCP_HOSTED_EVICT_MIN_IDLE_SECONDS", () => {
    for (const bad of ["0", "-5", "abc", "1.5", "30s"]) {
      expect(() => parseHostedConfig({ MCP_HOSTED_EVICT_MIN_IDLE_SECONDS: bad })).toThrow(/MCP_HOSTED_EVICT_MIN_IDLE_SECONDS/);
    }
  });
});

describe("findTenantEnvVars", () => {
  it("finds tenant vars", () => {
    expect(findTenantEnvVars({ XC_TENANT_PROD_URL: "x", XC_DEFAULT_NAMESPACE: "d" })).toEqual(["XC_TENANT_PROD_URL"]);
    expect(findTenantEnvVars({})).toEqual([]);
    expect(findTenantEnvVars({ XC_API_TOKEN: "t", XC_TENANT_URL: "u", XC_API_P12_PATH: "p", XC_API_P12_PASSWORD: "w" })).toEqual([
      "XC_API_TOKEN", "XC_TENANT_URL", "XC_API_P12_PATH", "XC_API_P12_PASSWORD",
    ]);
  });
  it("ignores unset/empty", () => {
    expect(findTenantEnvVars({ XC_API_TOKEN: "" })).toEqual([]);
  });
});

describe("validateHostedTenantUrl", () => {
  it.each([
    "https://acme.console.ves.volterra.io",
    "https://ACME.console.ves.volterra.io/",
    "https://acme.console.ves.volterra.io./",
  ])("accepts %s", (u) => {
    expect(validateHostedTenantUrl(u, ALLOW)).toEqual({ ok: true, url: goodUrl });
  });
  it.each([
    "https://a.b.console.ves.volterra.io",
    "https://console.ves.volterra.io",
    "https://evil.com",
    "https://169.254.169.254",
  ])("url_not_allowed %s", (u) => {
    expect(validateHostedTenantUrl(u, ALLOW)).toEqual({ ok: false, reason: "url_not_allowed" });
  });
  it.each([
    "http://acme.console.ves.volterra.io",
    "https://u:p@acme.console.ves.volterra.io",
    "https://acme.console.ves.volterra.io:8443",
    "https://acme.console.ves.volterra.io/api",
    "https://acme.console.ves.volterra.io/?x=1",
    "https://acme.console.ves.volterra.io/#f",
    "not a url",
  ])("invalid_tenant_url %s", (u) => {
    expect(validateHostedTenantUrl(u, ALLOW)).toEqual({ ok: false, reason: "invalid_tenant_url" });
  });
});

describe("parseCredentialHeaders", () => {
  const ok = { [H.url]: goodUrl, [H.token]: "tok" };
  it("parses valid", () => {
    const r = parseCredentialHeaders(ok, ALLOW);
    expect(r).toEqual({ ok: true, tenant: { name: "default", tenantUrl: goodUrl, apiToken: "tok" } });
  });
  it("missing url", () => {
    expect(parseCredentialHeaders({ [H.token]: "t" }, ALLOW)).toEqual({ ok: false, reason: "missing_tenant_url" });
  });
  it.each([undefined, "", "   "])("missing token %j", (t) => {
    expect(parseCredentialHeaders({ [H.url]: goodUrl, [H.token]: t }, ALLOW)).toEqual({ ok: false, reason: "missing_token" });
  });
  it("duplicate headers", () => {
    expect(parseCredentialHeaders({ ...ok, [H.token]: "a, b" }, ALLOW)).toEqual({ ok: false, reason: "duplicate_header" });
    expect(parseCredentialHeaders({ ...ok, [H.token]: ["a", "b"] }, ALLOW)).toEqual({ ok: false, reason: "duplicate_header" });
    expect(parseCredentialHeaders({ ...ok, [H.url]: `${goodUrl}, ${goodUrl}` }, ALLOW)).toEqual({ ok: false, reason: "duplicate_header" });
  });
  it("single-element array uses element", () => {
    const r = parseCredentialHeaders({ ...ok, [H.token]: ["tok"] }, ALLOW);
    expect(r.ok).toBe(true);
  });
  it("propagates url errors", () => {
    expect(parseCredentialHeaders({ ...ok, [H.url]: "https://evil.com" }, ALLOW)).toEqual({ ok: false, reason: "url_not_allowed" });
    expect(parseCredentialHeaders({ ...ok, [H.url]: "nope" }, ALLOW)).toEqual({ ok: false, reason: "invalid_tenant_url" });
  });
  it("namespace handling", () => {
    const blank = parseCredentialHeaders({ ...ok, [H.namespace]: "  " }, ALLOW);
    expect(blank.ok && "defaultNamespace" in blank.tenant).toBe(false);
    const ns = parseCredentialHeaders({ ...ok, [H.namespace]: "prod" }, ALLOW);
    expect(ns.ok && ns.tenant.defaultNamespace).toBe("prod");
  });
});

describe("credentialFingerprint", () => {
  const t = (url: string, tok: string) => {
    const r = parseCredentialHeaders({ [H.url]: url, [H.token]: tok }, ALLOW);
    if (!r.ok) throw new Error("bad");
    return r.tenant;
  };
  it("stable across URL variants", () => {
    expect(credentialFingerprint(t("https://ACME.console.ves.volterra.io/", "x"))).toBe(
      credentialFingerprint(t(goodUrl, "x")),
    );
  });
  it("differs by token and hides it", () => {
    const a = credentialFingerprint(t(goodUrl, "secret-token"));
    expect(a).not.toBe(credentialFingerprint(t(goodUrl, "other")));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("secret-token");
  });
});
