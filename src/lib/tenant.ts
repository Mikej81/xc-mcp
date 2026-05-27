import type { TenantConfig } from "../types/index.js";

/**
 * Validate that a tenant URL parses correctly.
 * Warns on non-standard domains but does not reject them (allows custom/test environments).
 */
export function validateTenantUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) {
      console.error(`Warning: Tenant URL "${url}" uses non-HTTP protocol.`);
    }
    if (
      !parsed.hostname.endsWith(".ves.volterra.io") &&
      !parsed.hostname.endsWith(".volterra.io")
    ) {
      console.error(
        `Warning: Tenant URL "${url}" is not a standard F5 XC domain. Proceeding anyway.`,
      );
    }
    return url.replace(/\/+$/, "");
  } catch {
    console.error(`Error: Tenant URL "${url}" is not a valid URL.`);
    process.exit(1);
  }
}

/**
 * Scan environment variables for tenant configurations.
 *
 * Named tenants: XC_TENANT_<NAME>_URL + auth (TOKEN or P12_PATH/P12_PASSWORD)
 * Legacy single tenant: XC_TENANT_URL + auth (XC_API_TOKEN or XC_API_P12_PATH/PASSWORD)
 */
export function parseTenantEnvVars(): TenantConfig[] {
  const tenants: TenantConfig[] = [];

  // Scan for named tenant pairs: XC_TENANT_<NAME>_URL / XC_TENANT_<NAME>_TOKEN
  const urlPattern = /^XC_TENANT_(.+)_URL$/;
  const names = new Set<string>();

  for (const key of Object.keys(process.env)) {
    const match = key.match(urlPattern);
    if (match) {
      names.add(match[1]);
    }
  }

  for (const name of names) {
    const url = process.env[`XC_TENANT_${name}_URL`];
    if (!url) {
      console.error(`Error: XC_TENANT_${name}_URL is required.`);
      process.exit(1);
    }

    const auth = resolveAuthEnv(`XC_TENANT_${name}`);
    const defaultNamespace = process.env[`XC_TENANT_${name}_DEFAULT_NAMESPACE`];

    tenants.push({
      name: name.toLowerCase(),
      ...auth,
      tenantUrl: validateTenantUrl(url),
      ...(defaultNamespace ? { defaultNamespace } : {}),
    });
  }

  if (tenants.length > 0) {
    return tenants;
  }

  // Fall back to legacy single-tenant env vars
  const apiToken = process.env.XC_API_TOKEN;
  const p12Path = process.env.XC_API_P12_PATH;
  const p12Password = process.env.XC_API_P12_PASSWORD;
  const tenantUrl = process.env.XC_TENANT_URL;

  if (!apiToken && !p12Path && !p12Password && !tenantUrl) {
    console.error(
      "Error: No tenant configuration found.\n\n" +
        "Single tenant (API token):\n" +
        "  XC_API_TOKEN=your-token\n" +
        "  XC_TENANT_URL=https://your-tenant.console.ves.volterra.io\n\n" +
        "Single tenant (P12 mTLS):\n" +
        "  XC_API_P12_PATH=/path/to/cert.p12\n" +
        "  XC_API_P12_PASSWORD=your-p12-password\n" +
        "  XC_TENANT_URL=https://your-tenant.console.ves.volterra.io\n\n" +
        "Multiple tenants:\n" +
        "  XC_TENANT_PROD_URL=https://prod.console.ves.volterra.io\n" +
        "  XC_TENANT_PROD_TOKEN=your-prod-token\n" +
        "  XC_TENANT_DEV_URL=https://dev.console.ves.volterra.io\n" +
        "  XC_TENANT_DEV_TOKEN=your-dev-token",
    );
    process.exit(1);
  }

  if (!tenantUrl) {
    console.error("Error: XC_TENANT_URL environment variable is required.");
    process.exit(1);
  }

  const auth = resolveAuthEnv("XC_API");
  const defaultNamespace = process.env.XC_DEFAULT_NAMESPACE;

  tenants.push({
    name: "default",
    ...auth,
    tenantUrl: validateTenantUrl(tenantUrl),
    ...(defaultNamespace ? { defaultNamespace } : {}),
  });

  return tenants;
}

/**
 * Read auth env vars for a given prefix (e.g. "XC_API" or "XC_TENANT_PROD"),
 * enforcing exactly one method: `_TOKEN` or `_P12_PATH`+`_P12_PASSWORD`.
 * Exits the process on any misconfiguration.
 */
function resolveAuthEnv(
  envPrefix: string,
): { apiToken: string } | { p12Path: string; p12Password: string } {
  const tokenVar = `${envPrefix}_TOKEN`;
  const p12PathVar = `${envPrefix}_P12_PATH`;
  const p12PasswordVar = `${envPrefix}_P12_PASSWORD`;
  const token = process.env[tokenVar];
  const p12Path = process.env[p12PathVar];
  const p12Password = process.env[p12PasswordVar];

  if (token && (p12Path || p12Password)) {
    console.error(
      `Error: ${tokenVar} and ${p12PathVar}/${p12PasswordVar} are mutually exclusive. Use one auth method.`,
    );
    process.exit(1);
  }

  if (!!p12Path !== !!p12Password) {
    console.error(`Error: ${p12PathVar} and ${p12PasswordVar} must both be set together.`);
    process.exit(1);
  }

  if (token) {
    return { apiToken: token };
  }
  if (p12Path && p12Password) {
    return { p12Path, p12Password };
  }

  console.error(
    `Error: No auth configured. Set ${tokenVar} or ${p12PathVar}+${p12PasswordVar}.`,
  );
  process.exit(1);
}

/**
 * Resolve which tenant to use.
 *
 * - If tenantName is provided, look it up by name.
 * - If only one tenant is configured, auto-select it.
 * - If multiple tenants and no name provided, return an error message.
 */
export function resolveTenant(
  tenants: TenantConfig[],
  tenantName?: string,
): TenantConfig | string {
  if (tenantName) {
    const tenant = tenants.find(
      (t) => t.name === tenantName.toLowerCase(),
    );
    if (!tenant) {
      const available = tenants.map((t) => t.name).join(", ");
      return `Unknown tenant "${tenantName}". Available tenants: ${available}`;
    }
    return tenant;
  }

  if (tenants.length === 1) {
    return tenants[0];
  }

  const defaultTenantName = process.env.XC_DEFAULT_TENANT;
  if (defaultTenantName !== undefined && defaultTenantName !== "") {
    const match = tenants.find((t) => t.name === defaultTenantName.toLowerCase());
    if (match) return match;
    const available = tenants.map((t) => t.name).join(", ");
    return `XC_DEFAULT_TENANT="${defaultTenantName}" but that tenant is not configured. Available: ${available}`;
  }

  const available = tenants.map((t) => `${t.name} (${t.tenantUrl})`).join(", ");
  return `Multiple tenants configured. Specify the "tenant" parameter. Available: ${available}`;
}

/**
 * Resolve namespace from explicit parameter, tenant default, or return guidance.
 *
 * Returns a string namespace on success, or a guidance object when no namespace
 * could be determined. The guidance message is intended for the LLM to relay
 * to the user rather than being treated as a hard error.
 */
export function resolveNamespace(
  tenant: TenantConfig,
  namespace?: string,
): string | { guidance: string } {
  if (namespace) {
    return namespace;
  }
  if (tenant.defaultNamespace) {
    return tenant.defaultNamespace;
  }
  return {
    guidance:
      "No namespace was specified and no default namespace is configured. " +
      "Please ask the user which namespace to use. They can also set a default " +
      "namespace via the XC_DEFAULT_NAMESPACE environment variable. " +
      "Use xc_list_namespaces to see available namespaces.",
  };
}
