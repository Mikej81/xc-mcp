import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Per-tool MCP annotations plus whether the tool changes XC state.
 * Clients use the annotations to decide when to ask before running a tool.
 * `mutates` drives read-only mode: mutating tools are hidden when the server
 * runs with MCP_READ_ONLY and refused for requests carrying X-XC-Read-Only.
 * xc_call_api is special-cased: it stays available and only GET is allowed.
 */
export interface ToolPolicy {
  annotations: ToolAnnotations;
  mutates: boolean;
}

const localRead: ToolPolicy = {
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
};
const xcRead: ToolPolicy = {
  annotations: { readOnlyHint: true, openWorldHint: true },
  mutates: false,
};
const write = (destructiveHint: boolean, idempotentHint: boolean): ToolPolicy => ({
  annotations: { readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: true },
  mutates: true,
});

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  xc_discover_apis: localRead,
  xc_get_operation_details: localRead,
  xc_resolve_schema_ref: localRead,
  xc_list_tenants: localRead,
  xc_list_namespaces: xcRead,
  xc_list_resources: xcRead,
  xc_search_resources: xcRead,
  xc_diff_resource: xcRead,
  xc_lb_wait_ready: xcRead,
  xc_query_access_logs: xcRead,
  xc_dns_zone_status: xcRead,
  xc_query_lb_metrics: xcRead,
  xc_call_api: write(true, false),
  xc_create_cert: write(false, false),
  xc_patch_resource: write(true, false),
  xc_lb_set_request_headers: write(true, true),
  xc_pool_attach_healthcheck: write(false, true),
  xc_pool_detach_healthcheck: write(true, true),
};

export const READ_ONLY_HEADER = "x-xc-read-only";
export const GENERIC_API_TOOL = "xc_call_api";

const TRUE_VALUES = new Set(["true", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "no"]);

/** Parse MCP_READ_ONLY. Unset or empty is false; an unrecognized value throws. */
export function parseReadOnlyEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return false;
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new Error('MCP_READ_ONLY must be "true" or "false" (or 1/0, yes/no)');
}

/**
 * Interpret the X-XC-Read-Only request header. Absent, empty, or a false value
 * means writes are allowed. Any other value, including a repeated header,
 * fails safe to read-only, since the caller asked for protection.
 */
export function isReadOnlyHeader(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length === 1 ? isReadOnlyHeader(value[0]) : true;
  const v = value.trim().toLowerCase();
  if (v === "" || FALSE_VALUES.has(v)) return false;
  return true;
}

/**
 * Return a refusal message when this tool call must not run in read-only mode,
 * or null when it may proceed.
 */
export function readOnlyRefusal(toolName: string, params: unknown): string | null {
  const policy = TOOL_POLICIES[toolName];
  if (!policy?.mutates) return null;
  if (toolName === GENERIC_API_TOOL) {
    const method = (params as { method?: unknown } | undefined)?.method;
    if (method === "GET") return null;
    return `Read-only mode: ${toolName} only allows GET (got ${String(method)}).`;
  }
  return `Read-only mode: ${toolName} changes tenant state and is disabled.`;
}
