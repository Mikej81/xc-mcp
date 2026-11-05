import { callApi } from "./api-client.js";
import type { TenantConfig } from "../types/index.js";

export const CREDENTIAL_CHECK_PATH = "/api/web/custom/namespaces/system/whoami";
export const CREDENTIAL_CHECK_TIMEOUT_MS = 10_000;

export type CredentialCheckResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 502;
      reason: "invalid_credentials" | "tenant_unreachable";
      upstreamStatus: number;
    };

/** Verify a tenant token with a whoami call. Never includes the token in the result. */
export async function verifyCredentials(tenant: TenantConfig): Promise<CredentialCheckResult> {
  const res = await callApi(tenant, "GET", CREDENTIAL_CHECK_PATH, {
    timeoutMs: CREDENTIAL_CHECK_TIMEOUT_MS,
  });
  if (res.status >= 200 && res.status < 300) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 401, reason: "invalid_credentials", upstreamStatus: res.status };
  }
  return { ok: false, status: 502, reason: "tenant_unreachable", upstreamStatus: res.status };
}
