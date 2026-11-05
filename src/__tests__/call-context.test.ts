import { describe, it, expect } from "vitest";
import { authFailureHint, runInCallContext, currentCallContext, type CallContext } from "../lib/call-context.js";
import type { TenantConfig } from "../types/index.js";

const HOSTED_HINT =
  "XC rejected the API token (401). It may have expired or been revoked. Update X-XC-Tenant-Token in your MCP client config, then reconnect: the current session stays bound to the old token.";

const base = (over: Partial<CallContext>): CallContext => ({ tool: "t", mode: "local", sawAuthFailure: false, ...over });
const tenant = (over: Partial<TenantConfig>): TenantConfig => ({
  name: "default", apiToken: "SECRET-TOKEN-VALUE", tenantUrl: "https://acme.console.ves.volterra.io", ...over,
});

describe("authFailureHint", () => {
  it("hosted text is exact", () => {
    expect(authFailureHint(base({ mode: "hosted", tenant: tenant({}) }))).toBe(HOSTED_HINT);
  });
  it("local single tenant names XC_API_TOKEN", () => {
    expect(authFailureHint(base({ tenant: tenant({}) }))).toContain("XC_API_TOKEN");
  });
  it("local named tenant names XC_TENANT_PROD_TOKEN", () => {
    expect(authFailureHint(base({ tenant: tenant({ name: "prod" }) }))).toContain("XC_TENANT_PROD_TOKEN");
  });
  it("local P12 tenant mentions renewing the certificate", () => {
    const h = authFailureHint(base({ tenant: tenant({ name: "prod", apiToken: undefined as unknown as string, p12Path: "/x.p12" }) }));
    expect(h).toMatch(/renew the P12 certificate/i);
  });
  it("never contains the token", () => {
    for (const ctx of [base({ mode: "hosted", tenant: tenant({}) }), base({ tenant: tenant({}) }), base({ tenant: tenant({ name: "prod" }) })]) {
      expect(authFailureHint(ctx)).not.toContain("SECRET-TOKEN-VALUE");
    }
  });
});

describe("runInCallContext", () => {
  it("isolates concurrent calls", async () => {
    const run = (tool: string, ms: number) =>
      runInCallContext(base({ tool }), async () => {
        await new Promise((r) => setTimeout(r, ms));
        return currentCallContext()?.tool;
      });
    expect(await Promise.all([run("a", 20), run("b", 5)])).toEqual(["a", "b"]);
    expect(currentCallContext()).toBeUndefined();
  });
});
