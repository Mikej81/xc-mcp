import { createHash } from "node:crypto";
import type { HostedConfig, TenantConfig } from "../types/index.js";

export const HOSTED_HEADERS = {
  url: "x-xc-tenant-url",
  token: "x-xc-tenant-token",
  namespace: "x-xc-tenant-namespace",
} as const;

export const DEFAULT_ALLOWED_DOMAINS = [".console.ves.volterra.io"];

const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_SESSIONS_PER_CREDENTIAL = 5;
export const DEFAULT_EVICT_MIN_IDLE_SECONDS = 300;

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (!/^\d+$/.test(v) || Number(v) < 1 || !Number.isSafeInteger(Number(v))) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Number(v);
}

export function parseHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const rawDomains = env.XC_HOSTED_ALLOWED_DOMAINS;
  let allowedDomains = DEFAULT_ALLOWED_DOMAINS;
  if (rawDomains !== undefined && rawDomains.trim() !== "") {
    allowedDomains = rawDomains
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0)
      .map((d) => (d.startsWith(".") ? d : `.${d}`));
    if (allowedDomains.length === 0) {
      throw new Error("XC_HOSTED_ALLOWED_DOMAINS is set but contains no domain suffixes");
    }
    for (const d of allowedDomains) {
      if (!/^[a-z0-9.-]+$/.test(d) || d.slice(1).split(".").some((l) => l === "") || d.slice(1).split(".").length < 2) {
        throw new Error(
          `XC_HOSTED_ALLOWED_DOMAINS entry "${d}" is invalid: use bare domain suffixes with at least two labels, e.g. example.gov`,
        );
      }
    }
  }
  return {
    allowedDomains: [...allowedDomains],
    maxSessions: parsePositiveInt("MCP_HOSTED_MAX_SESSIONS", env.MCP_HOSTED_MAX_SESSIONS, DEFAULT_MAX_SESSIONS),
    maxSessionsPerCredential: parsePositiveInt(
      "MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL",
      env.MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL,
      DEFAULT_MAX_SESSIONS_PER_CREDENTIAL,
    ),
    evictMinIdleMs:
      parsePositiveInt(
        "MCP_HOSTED_EVICT_MIN_IDLE_SECONDS",
        env.MCP_HOSTED_EVICT_MIN_IDLE_SECONDS,
        DEFAULT_EVICT_MIN_IDLE_SECONDS,
      ) * 1000,
  };
}

const FIXED_TENANT_VARS = ["XC_API_TOKEN", "XC_TENANT_URL", "XC_API_P12_PATH", "XC_API_P12_PASSWORD"];
const NAMED_TENANT_VAR = /^XC_TENANT_.+_(URL|TOKEN|P12_PATH|P12_PASSWORD)$/;

export function findTenantEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(
    (k) => (FIXED_TENANT_VARS.includes(k) || NAMED_TENANT_VAR.test(k)) && env[k] !== undefined && env[k] !== "",
  ).sort((a, b) => {
    const ai = FIXED_TENANT_VARS.indexOf(a);
    const bi = FIXED_TENANT_VARS.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export type CredentialRejectReason =
  | "missing_tenant_url"
  | "missing_token"
  | "invalid_tenant_url"
  | "url_not_allowed"
  | "duplicate_header";

export function validateHostedTenantUrl(
  raw: string,
  allowedDomains: string[],
): { ok: true; url: string } | { ok: false; reason: "invalid_tenant_url" | "url_not_allowed" } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_tenant_url" };
  }
  if (
    u.protocol !== "https:" ||
    u.username !== "" ||
    u.password !== "" ||
    u.port !== "" ||
    u.pathname !== "/" ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    return { ok: false, reason: "invalid_tenant_url" };
  }
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = allowedDomains.some(
    (suffix) =>
      hostname.length > suffix.length &&
      hostname.endsWith(suffix) &&
      !hostname.slice(0, -suffix.length).includes("."),
  );
  if (!allowed) return { ok: false, reason: "url_not_allowed" };
  return { ok: true, url: `https://${hostname}` };
}

type HeaderValue = string | string[] | undefined;

/** Returns the single value, "duplicate" for multi-valued, or undefined when absent. */
function singleHeader(value: HeaderValue): string | undefined | "duplicate" {
  if (Array.isArray(value)) {
    if (value.length > 1) return "duplicate";
    value = value[0];
  }
  if (value === undefined) return undefined;
  if (value.includes(",")) return "duplicate";
  return value;
}

export function parseCredentialHeaders(
  headers: Record<string, HeaderValue>,
  allowedDomains: string[],
): { ok: true; tenant: TenantConfig } | { ok: false; reason: CredentialRejectReason } {
  const rawUrl = singleHeader(headers[HOSTED_HEADERS.url]);
  const rawToken = singleHeader(headers[HOSTED_HEADERS.token]);
  const rawNs = singleHeader(headers[HOSTED_HEADERS.namespace]);

  if (rawUrl === "duplicate" || rawToken === "duplicate" || rawNs === "duplicate") {
    return { ok: false, reason: "duplicate_header" };
  }
  if (rawUrl === undefined || rawUrl.trim() === "") return { ok: false, reason: "missing_tenant_url" };
  if (rawToken === undefined || rawToken.trim() === "") return { ok: false, reason: "missing_token" };

  const v = validateHostedTenantUrl(rawUrl, allowedDomains);
  if (!v.ok) return { ok: false, reason: v.reason };

  const tenant: TenantConfig = { name: "default", tenantUrl: v.url, apiToken: rawToken.trim() };
  const ns = rawNs?.trim();
  if (ns) tenant.defaultNamespace = ns;
  return { ok: true, tenant };
}

export function credentialFingerprint(tenant: TenantConfig): string {
  return createHash("sha256").update(`${tenant.tenantUrl}\n${tenant.apiToken}`).digest("hex");
}
