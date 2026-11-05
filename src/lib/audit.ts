import type { CallContext } from "./call-context.js";
import { logAudit } from "./logger.js";
import { TOOL_POLICIES } from "./tool-policy.js";

const NAMESPACE_PATH = /^\/api\/[^/]+\/namespaces(?:\/([^/]+))?\/?$/;
/** /api/<group>/namespaces/<ns>/<action> for an action on the namespace itself. */
const NAMESPACE_ACTION_PATH = /^\/api\/[^/]+\/namespaces\/([^/]+)\/(cascade_delete)\/?$/;
const RESOURCE_PATH = /^\/api\/[^/]+\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?/;

type ParsedPath = { namespace?: string; resource_type?: string; name?: string; action?: string };

/**
 * Best-effort parse of /api/<group>/namespaces/<ns>/<type>[/<name>].
 * /api/<group>/namespaces/<ns>/<action> for a known action parses as the namespace itself plus `action`.
 */
export function parseResourcePath(path: string): ParsedPath {
  const a = NAMESPACE_ACTION_PATH.exec(path);
  if (a) return { resource_type: "namespaces", name: a[1], action: a[2] };
  const m = RESOURCE_PATH.exec(path);
  if (!m) {
    const n = NAMESPACE_PATH.exec(path);
    if (!n) return {};
    return n[1] ? { resource_type: "namespaces", name: n[1] } : { resource_type: "namespaces" };
  }
  const out: ParsedPath = { namespace: m[1], resource_type: m[2] };
  if (m[3]) out.name = m[3];
  return out;
}

/**
 * Log one audit line for a non-GET XC request sent from inside a mutating tool.
 * Never logs bodies, query strings, headers or tokens.
 */
export function auditWrite(
  ctx: CallContext | undefined,
  req: { method: string; path: string; status: number; durationMs: number },
): void {
  if (!ctx || req.method === "GET") return;
  if (TOOL_POLICIES[ctx.tool]?.mutates !== true) return;
  logAudit({
    tool: ctx.tool,
    method: req.method,
    path: req.path,
    ...parseResourcePath(req.path),
    status: req.status,
    duration_ms: req.durationMs,
    session_id: ctx.sessionId?.slice(0, 8),
    caller_id: ctx.callerId,
    tenant_host: ctx.tenantHost,
  });
}
