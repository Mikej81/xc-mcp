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
 * Named tenants: XC_TENANT_<NAME>_URL + XC_TENANT_<NAME>_TOKEN
 * Legacy single tenant: XC_API_TOKEN + XC_TENANT_URL
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
    const token = process.env[`XC_TENANT_${name}_TOKEN`];

    if (!url || !token) {
      console.error(
        `Error: Found XC_TENANT_${name}_URL but missing XC_TENANT_${name}_TOKEN (or vice versa). Both are required.`,
      );
      process.exit(1);
    }

    const defaultNamespace = process.env[`XC_TENANT_${name}_DEFAULT_NAMESPACE`];
    tenants.push({
      name: name.toLowerCase(),
      apiToken: token,
      tenantUrl: validateTenantUrl(url),
      ...(defaultNamespace ? { defaultNamespace } : {}),
    });
  }

  if (tenants.length > 0) {
    return tenants;
  }

  // Fall back to legacy single-tenant env vars
  const apiToken = process.env.XC_API_TOKEN;
  const tenantUrl = process.env.XC_TENANT_URL;

  if (!apiToken && !tenantUrl) {
    console.error(
      "Error: No tenant configuration found.\n\n" +
        "Single tenant:\n" +
        "  XC_API_TOKEN=your-token\n" +
        "  XC_TENANT_URL=https://your-tenant.console.ves.volterra.io\n\n" +
        "Multiple tenants:\n" +
        "  XC_TENANT_PROD_URL=https://prod.console.ves.volterra.io\n" +
        "  XC_TENANT_PROD_TOKEN=your-prod-token\n" +
        "  XC_TENANT_DEV_URL=https://dev.console.ves.volterra.io\n" +
        "  XC_TENANT_DEV_TOKEN=your-dev-token",
    );
    process.exit(1);
  }

  if (!apiToken) {
    console.error("Error: XC_API_TOKEN environment variable is required.");
    process.exit(1);
  }

  if (!tenantUrl) {
    console.error("Error: XC_TENANT_URL environment variable is required.");
    process.exit(1);
  }

  const defaultNamespace = process.env.XC_DEFAULT_NAMESPACE;
  tenants.push({
    name: "default",
    apiToken,
    tenantUrl: validateTenantUrl(tenantUrl),
    ...(defaultNamespace ? { defaultNamespace } : {}),
  });

  return tenants;
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
