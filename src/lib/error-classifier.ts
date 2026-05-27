import type { ApiResponse } from "../types/index.js";

export type ErrorCategory = NonNullable<ApiResponse["error_category"]>;

const GRPC_DIAL_RX = /connection error|grpc[_-]?dial|lookup .* no such host|powerdns-/i;

export function classifyError(status: number, _statusText: string, body: unknown): ErrorCategory | undefined {
  if (status >= 200 && status < 400) return undefined;
  if (status === 400) return "validation_error";
  if (status === 401) return "auth_failure";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 409) return "config_conflict";
  if (status === 429) return "rate_limited";
  if (status === 503) return "backend_unavailable";
  if (status === 504) return "timeout";
  if (status >= 500) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body || {});
    if (GRPC_DIAL_RX.test(bodyStr)) return "backend_unavailable";
    return "server_error";
  }
  return undefined;
}
