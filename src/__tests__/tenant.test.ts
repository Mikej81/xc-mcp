import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTenant, validateTenantUrl, parseTenantEnvVars, resolveNamespace } from "../lib/tenant.js";
import type { TenantConfig } from "../types/index.js";

describe("resolveTenant", () => {
  const tenants: TenantConfig[] = [
    { name: "prod", apiToken: "tok1", tenantUrl: "https://prod.ves.volterra.io" },
    { name: "dev", apiToken: "tok2", tenantUrl: "https://dev.ves.volterra.io" },
  ];

  it("returns config when name matches", () => {
    const result = resolveTenant(tenants, "prod");
    expect(result).toEqual(tenants[0]);
  });

  it("matches name case-insensitively", () => {
    const result = resolveTenant(tenants, "PROD");
    expect(result).toEqual(tenants[0]);
  });

  it("returns error string when name not found", () => {
    const result = resolveTenant(tenants, "staging");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Unknown tenant");
    expect(result as string).toContain("prod");
    expect(result as string).toContain("dev");
  });

  it("auto-selects when single tenant and no name", () => {
    const single = [tenants[0]];
    expect(resolveTenant(single)).toEqual(tenants[0]);
  });

  it("returns error string when multiple tenants and no name", () => {
    const result = resolveTenant(tenants);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Multiple tenants");
    expect(result as string).toContain("prod");
    expect(result as string).toContain("dev");
  });
});

describe("validateTenantUrl", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns stripped URL for valid standard domain", () => {
    const result = validateTenantUrl("https://my-tenant.console.ves.volterra.io");
    expect(result).toBe("https://my-tenant.console.ves.volterra.io");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("strips trailing slashes", () => {
    expect(validateTenantUrl("https://my-tenant.console.ves.volterra.io///")).toBe(
      "https://my-tenant.console.ves.volterra.io",
    );
  });

  it("warns but returns URL for non-standard domain", () => {
    const result = validateTenantUrl("https://custom.example.com");
    expect(result).toBe("https://custom.example.com");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a standard F5 XC domain"),
    );
  });

  it("calls process.exit(1) for invalid URL", () => {
    expect(() => validateTenantUrl("not-a-url")).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("parseTenantEnvVars", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all XC_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("XC_")) {
        delete process.env[key];
      }
    }
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("parses named tenant pair", () => {
    process.env.XC_TENANT_PROD_URL = "https://prod.console.ves.volterra.io";
    process.env.XC_TENANT_PROD_TOKEN = "abc123";
    const result = parseTenantEnvVars();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("prod");
    expect(result[0].apiToken).toBe("abc123");
    expect(result[0].tenantUrl).toBe("https://prod.console.ves.volterra.io");
  });

  it("parses multiple named tenant pairs", () => {
    process.env.XC_TENANT_PROD_URL = "https://prod.console.ves.volterra.io";
    process.env.XC_TENANT_PROD_TOKEN = "tok1";
    process.env.XC_TENANT_DEV_URL = "https://dev.console.ves.volterra.io";
    process.env.XC_TENANT_DEV_TOKEN = "tok2";
    const result = parseTenantEnvVars();
    expect(result).toHaveLength(2);
    const names = result.map((t) => t.name).sort();
    expect(names).toEqual(["dev", "prod"]);
  });

  it("exits when named URL has no matching TOKEN", () => {
    process.env.XC_TENANT_PROD_URL = "https://prod.console.ves.volterra.io";
    expect(() => parseTenantEnvVars()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("parses legacy single tenant env vars", () => {
    process.env.XC_API_TOKEN = "legacy-token";
    process.env.XC_TENANT_URL = "https://legacy.console.ves.volterra.io";
    const result = parseTenantEnvVars();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("default");
    expect(result[0].apiToken).toBe("legacy-token");
  });

  it("exits when no env vars at all", () => {
    expect(() => parseTenantEnvVars()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("lowercases tenant name", () => {
    process.env.XC_TENANT_MYAPP_URL = "https://myapp.console.ves.volterra.io";
    process.env.XC_TENANT_MYAPP_TOKEN = "tok";
    const result = parseTenantEnvVars();
    expect(result[0].name).toBe("myapp");
  });

  it("parses XC_TENANT_<NAME>_DEFAULT_NAMESPACE for named tenants", () => {
    process.env.XC_TENANT_PROD_URL = "https://prod.console.ves.volterra.io";
    process.env.XC_TENANT_PROD_TOKEN = "abc123";
    process.env.XC_TENANT_PROD_DEFAULT_NAMESPACE = "production";
    const result = parseTenantEnvVars();
    expect(result).toHaveLength(1);
    expect(result[0].defaultNamespace).toBe("production");
  });

  it("omits defaultNamespace when env var not set for named tenant", () => {
    process.env.XC_TENANT_PROD_URL = "https://prod.console.ves.volterra.io";
    process.env.XC_TENANT_PROD_TOKEN = "abc123";
    const result = parseTenantEnvVars();
    expect(result[0].defaultNamespace).toBeUndefined();
  });

  it("parses XC_DEFAULT_NAMESPACE for legacy single tenant", () => {
    process.env.XC_API_TOKEN = "legacy-token";
    process.env.XC_TENANT_URL = "https://legacy.console.ves.volterra.io";
    process.env.XC_DEFAULT_NAMESPACE = "my-ns";
    const result = parseTenantEnvVars();
    expect(result).toHaveLength(1);
    expect(result[0].defaultNamespace).toBe("my-ns");
  });

  it("omits defaultNamespace when XC_DEFAULT_NAMESPACE not set for legacy tenant", () => {
    process.env.XC_API_TOKEN = "legacy-token";
    process.env.XC_TENANT_URL = "https://legacy.console.ves.volterra.io";
    const result = parseTenantEnvVars();
    expect(result[0].defaultNamespace).toBeUndefined();
  });
});

describe("resolveNamespace", () => {
  const tenant: TenantConfig = {
    name: "test",
    apiToken: "tok",
    tenantUrl: "https://test.ves.volterra.io",
  };

  const tenantWithDefault: TenantConfig = {
    ...tenant,
    defaultNamespace: "my-default",
  };

  it("returns explicit namespace when provided", () => {
    expect(resolveNamespace(tenant, "explicit")).toBe("explicit");
  });

  it("returns explicit namespace even when default is configured", () => {
    expect(resolveNamespace(tenantWithDefault, "explicit")).toBe("explicit");
  });

  it("returns default namespace when no explicit namespace provided", () => {
    expect(resolveNamespace(tenantWithDefault)).toBe("my-default");
  });

  it("returns guidance when no namespace and no default", () => {
    const result = resolveNamespace(tenant);
    expect(typeof result).toBe("object");
    expect((result as { guidance: string }).guidance).toContain("No namespace was specified");
  });
});
