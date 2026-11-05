import { describe, it, expect, vi, beforeEach } from "vitest";

const parseTenantEnvVars = vi.fn(() => [
  { name: "default", apiToken: "t", tenantUrl: "https://acme.console.ves.volterra.io" },
]);

vi.mock("../lib/tenant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tenant.js")>();
  return { ...actual, parseTenantEnvVars: () => parseTenantEnvVars() };
});

import { buildServerConfig } from "../index.js";

const paths = { specsDir: "/specs", indexPath: "/index.json" };

describe("buildServerConfig", () => {
  beforeEach(() => parseTenantEnvVars.mockClear());

  it("rejects hosted mode without MCP_TRANSPORT=http", () => {
    expect(() => buildServerConfig({ MCP_MODE: "hosted" }, paths)).toThrow(/MCP_TRANSPORT=http/);
    expect(() => buildServerConfig({ MCP_MODE: "hosted", MCP_TRANSPORT: "stdio" }, paths)).toThrow(
      /MCP_TRANSPORT=http/,
    );
    expect(parseTenantEnvVars).not.toHaveBeenCalled();
  });

  it("rejects hosted mode with XC tenant env vars, naming them without values", () => {
    let message = "";
    try {
      buildServerConfig(
        { MCP_MODE: "hosted", MCP_TRANSPORT: "http", XC_API_TOKEN: "secret", XC_TENANT_PROD_URL: "https://x" },
        paths,
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("XC_API_TOKEN");
    expect(message).toContain("XC_TENANT_PROD_URL");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("https://x");
    expect(parseTenantEnvVars).not.toHaveBeenCalled();
  });

  it("builds a hosted config with no tenants", () => {
    const config = buildServerConfig(
      { MCP_MODE: "hosted", MCP_TRANSPORT: "HTTP", MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL: "2" },
      paths,
    );
    expect(config).toEqual({
      mode: "hosted",
      readOnly: false,
      shutdownDrainMs: 0,
      tenants: [],
      hosted: { allowedDomains: [".console.ves.volterra.io"], maxSessions: 500, maxSessionsPerCredential: 2, evictMinIdleMs: 300_000 },
      specsDir: "/specs",
      indexPath: "/index.json",
    });
    expect(parseTenantEnvVars).not.toHaveBeenCalled();
  });

  it("uses parseTenantEnvVars in local mode", () => {
    const config = buildServerConfig({}, paths);
    expect(parseTenantEnvVars).toHaveBeenCalledTimes(1);
    expect(config.mode).toBe("local");
    expect(config.hosted).toBeUndefined();
    expect(config.tenants.map((t) => t.name)).toEqual(["default"]);
  });

  it("rejects an unknown MCP_MODE", () => {
    expect(() => buildServerConfig({ MCP_MODE: "cloud" }, paths)).toThrow(/MCP_MODE/);
  });
});
