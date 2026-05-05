import { timingSafeEqual } from "node:crypto";

export type AuthConfig =
  | { enabled: false }
  | { enabled: true; headerName: string; headerValue: string };

/**
 * Parse MCP_AUTH_HEADER_NAME / MCP_AUTH_HEADER_VALUE from the given env.
 * Both must be set together or both unset; partial config throws.
 * Header name is lower-cased to match Node's incoming header dict.
 */
export function parseAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const name = env.MCP_AUTH_HEADER_NAME?.trim();
  // Value is intentionally NOT trimmed — secret is compared byte-for-byte.
  const value = env.MCP_AUTH_HEADER_VALUE;
  const hasName = !!name;
  const hasValue = !!value;
  if (!hasName && !hasValue) return { enabled: false };
  if (hasName !== hasValue) {
    throw new Error(
      "MCP_AUTH_HEADER_NAME and MCP_AUTH_HEADER_VALUE must both be set or both unset",
    );
  }
  return { enabled: true, headerName: name!.toLowerCase(), headerValue: value! };
}

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" };

/**
 * Check the supplied request headers against the configured auth.
 * Always returns ok=true when auth is disabled.
 */
export function checkAuth(
  config: AuthConfig,
  headers: NodeJS.Dict<string | string[]>,
): AuthResult {
  if (!config.enabled) return { ok: true };
  const supplied = headers[config.headerName];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!value) return { ok: false, reason: "missing" };
  if (!constantTimeEqual(value, config.headerValue)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
