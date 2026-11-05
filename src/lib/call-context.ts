import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantConfig } from "../types/index.js";

export interface CallContext {
  tool: string;
  mode: "local" | "hosted";
  sessionId?: string;
  callerId?: string;
  tenantHost?: string;
  /** Resolved tenant, for hint wording only; never logged. */
  tenant?: TenantConfig;
  sawAuthFailure: boolean;
}

const storage = new AsyncLocalStorage<CallContext>();

export function runInCallContext<T>(ctx: CallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentCallContext(): CallContext | undefined {
  return storage.getStore();
}

/** Hint appended to a tool result when XC answered 401 during the call. Never includes secrets. */
export function authFailureHint(ctx: CallContext): string {
  const base = "XC rejected the API token (401). It may have expired or been revoked. ";
  if (ctx.mode === "hosted") {
    return base +
      "Update X-XC-Tenant-Token in your MCP client config, then reconnect: the current session stays bound to the old token.";
  }
  const t = ctx.tenant;
  if (t?.p12Path) {
    return base + "Renew the P12 certificate, then restart the server.";
  }
  if (t && t.name !== "default") {
    return base + `Update XC_TENANT_${t.name.toUpperCase()}_TOKEN, then restart the server.`;
  }
  if (t) {
    return base + "Update XC_API_TOKEN, then restart the server.";
  }
  return base +
    "Update XC_API_TOKEN (or XC_TENANT_<NAME>_TOKEN), or renew the P12 certificate, then restart the server.";
}
