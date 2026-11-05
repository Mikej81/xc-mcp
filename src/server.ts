import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

import { resolveTenant, resolveNamespace } from "./lib/tenant.js";
import { parseCredentialHeaders, credentialFingerprint, DEFAULT_ALLOWED_DOMAINS } from "./lib/hosted.js";
import { runInCallContext, authFailureHint, type CallContext } from "./lib/call-context.js";
import { toolCalls } from "./lib/metrics.js";
import type { OperationsIndex } from "./types/index.js";
import type { ServerConfig, TenantConfig } from "./types/index.js";
import { handleDiscover } from "./tools/discover.js";
import { handleOperationDetails } from "./tools/operation-details.js";
import { handleCallApi } from "./tools/call-api.js";
import { handleListNamespaces } from "./tools/list-namespaces.js";
import { handleListResources } from "./tools/list-resources.js";
import { handleCreateCert, CERT_DOMAIN_SCHEMA } from "./tools/create-cert.js";
import { handlePatchResource } from "./tools/patch-resource.js";
import { handleWaitReady } from "./tools/wait-ready.js";
import { handleDiffResource } from "./tools/diff-resource.js";
import { handleQueryAccessLogs } from "./tools/query-access-logs.js";
import { handleSearchResources } from "./tools/search-resources.js";
import { handleDnsZoneStatus } from "./tools/dns-zone-status.js";
import { handleResolveSchemaRef } from "./tools/resolve-schema-ref.js";
import { handleLbSetRequestHeaders } from "./tools/lb-set-request-headers.js";
import { handlePoolAttachHealthcheck, handlePoolDetachHealthcheck } from "./tools/pool-healthcheck-attach.js";
import { handleQueryLbMetrics } from "./tools/query-lb-metrics.js";
import { VERSION, checkForUpdate } from "./lib/version.js";
import { installTasksRfcCompat } from "./lib/tasks-rfc-compat.js";
import {
  TOOL_POLICIES,
  READ_ONLY_HEADER,
  GENERIC_API_TOOL,
  isReadOnlyHeader,
  readOnlyRefusal,
} from "./lib/tool-policy.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Hosted mode: build the caller's tenant from this request's credential headers.
 * Returns an error string (never containing header values) when unavailable.
 */
function hostedCallerTenant(config: ServerConfig, extra: Extra | undefined): TenantConfig | string {
  const headers = extra?.requestInfo?.headers;
  if (!headers) {
    return "Hosted mode: request credentials are unavailable for this call.";
  }
  const allowed = config.hosted?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;
  const parsed = parseCredentialHeaders(headers, allowed);
  if (!parsed.ok) {
    return `Hosted mode: tenant credentials rejected (${parsed.reason}). ` +
      "Send X-XC-Tenant-Url and X-XC-Tenant-Token headers.";
  }
  return parsed.tenant;
}

/**
 * Tenants this caller may see: the request-scoped tenant in hosted mode,
 * the configured tenants in local mode. Returns an error string on failure.
 */
function visibleTenants(config: ServerConfig, extra: Extra | undefined): TenantConfig[] | string {
  if (config.mode !== "hosted") return config.tenants;
  const tenant = hostedCallerTenant(config, extra);
  return typeof tenant === "string" ? tenant : [tenant];
}

/**
 * Resolve a tenant, returning either the TenantConfig or an MCP error response.
 * Hosted mode ignores `tenantName` and resolves only from the request's
 * credential headers in `extra`; the caller can never reach another tenant.
 */
export function withTenant(
  config: ServerConfig,
  tenantName: string | undefined,
  extra?: Extra,
): TenantConfig | ToolResult {
  if (config.mode === "hosted") {
    const tenant = hostedCallerTenant(config, extra);
    if (typeof tenant === "string") {
      return { content: [{ type: "text", text: tenant }], isError: true };
    }
    return tenant;
  }
  const result = resolveTenant(config.tenants, tenantName);
  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }],
      isError: true,
    };
  }
  return result;
}

/** Best-effort per-call context; tenant resolution failures leave the tenant fields undefined. */
function buildCallContext(config: ServerConfig, tool: string, params: unknown, extra: Extra | undefined): CallContext {
  const ctx: CallContext = {
    tool,
    mode: config.mode === "hosted" ? "hosted" : "local",
    sessionId: extra?.sessionId,
    sawAuthFailure: false,
  };
  try {
    const tenant = config.mode === "hosted"
      ? hostedCallerTenant(config, extra)
      : resolveTenant(config.tenants, (params as { tenant?: string } | undefined)?.tenant);
    if (typeof tenant !== "string") {
      ctx.tenant = tenant;
      ctx.tenantHost = new URL(tenant.tenantUrl).hostname;
      ctx.callerId = config.mode === "hosted" ? credentialFingerprint(tenant).slice(0, 8) : tenant.name;
    }
  } catch {
    // leave fields undefined
  }
  return ctx;
}

/**
 * Register tools with their TOOL_POLICIES annotations and read-only enforcement.
 * MCP_READ_ONLY hides mutating tools entirely (xc_call_api stays, GET only).
 * An X-XC-Read-Only request header refuses mutating calls for that request.
 */
function makeToolRegistrar(server: McpServer, config: ServerConfig) {
  return function tool<A extends ZodRawShape>(
    name: string,
    description: string,
    schema: A,
    cb: ToolCallback<A>,
  ): void {
    const policy = TOOL_POLICIES[name];
    if (!policy) throw new Error(`No TOOL_POLICIES entry for tool "${name}"`);
    if (config.readOnly && policy.mutates && name !== GENERIC_API_TOOL) return;
    const desc = config.readOnly && name === GENERIC_API_TOOL
      ? `${description} Server is read-only: only GET is allowed.`
      : description;
    const run = (params: unknown, extra: Extra): ToolResult | Promise<ToolResult> => {
      const readOnly = config.readOnly === true ||
        isReadOnlyHeader(extra?.requestInfo?.headers?.[READ_ONLY_HEADER]);
      if (readOnly) {
        const refusal = readOnlyRefusal(name, params);
        if (refusal) return { content: [{ type: "text" as const, text: refusal }], isError: true };
      }
      const ctx = buildCallContext(config, name, params, extra);
      return runInCallContext(ctx, async () => {
        const result = await (cb as unknown as (p: unknown, e: Extra) => Promise<ToolResult>)(params, extra);
        if (ctx.sawAuthFailure && result && Array.isArray(result.content)) {
          result.content.push({ type: "text", text: authFailureHint(ctx) });
        }
        return result;
      });
    };
    const guarded = (async (params: unknown, extra: Extra) => {
      let outcome: "ok" | "error" = "error";
      try {
        const result = await run(params, extra);
        if (!result?.isError) outcome = "ok";
        return result;
      } finally {
        toolCalls.inc({ tool: name, outcome });
      }
    }) as unknown as ToolCallback<A>;
    // With MCP_READ_ONLY, xc_call_api only runs GET, so it advertises itself as read-only.
    const annotations = config.readOnly && name === GENERIC_API_TOOL
      ? { readOnlyHint: true, openWorldHint: true }
      : policy.annotations;
    server.tool(name, desc, schema, annotations, guarded);
  };
}

/**
 * Register all tools on an McpServer instance.
 */
function registerTools(server: McpServer, config: ServerConfig, index: OperationsIndex) {
  const tool = makeToolRegistrar(server, config);

  tool(
    "xc_discover_apis",
    "Search F5 XC API operations. Only needed when no specific tool fits and you don't " +
      "know the API path. For common reads, prefer xc_list_namespaces, xc_list_resources, " +
      "xc_list_tenants, xc_query_access_logs.",
    {
      query: z.string().optional().describe("Search text (AND-matched). Example: 'load balancer'"),
      category: z.string().optional().describe("Category filter"),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method filter"),
      resource_type: z.string().optional().describe("Resource type filter. Example: 'http_loadbalancers'"),
      limit: z.number().optional().describe("Max results (default 20, max 50)"),
      offset: z.number().optional().describe("Pagination offset"),
    },
    async (params) => handleDiscover(index, params),
  );

  tool(
    "xc_get_operation_details",
    "Get request body schema for an API operation. Use summary_mode=true to reduce size. " +
      "x-ves-oneof-field-* marks mutually exclusive fields -- only set ONE per group.",
    {
      operation_key: z.string().describe('Format: "METHOD:/path". Example: "POST:/api/config/namespaces/{namespace}/http_loadbalancers"'),
      max_depth: z.number().optional().describe("Schema depth (default 4, max 10)"),
      include_response_schema: z.boolean().optional().describe("Include response schema (default false)"),
      include_full_schema: z.boolean().optional().describe("Return full schema instead of templates for known resource types (default false)"),
      summary_mode: z.boolean().optional().describe("Strip descriptions, keep only types/required/enums (default false)"),
    },
    async (params) => handleOperationDetails(index, config.specsDir, params),
  );

  tool(
    "xc_resolve_schema_ref",
    "Resolve and expand a JSON Schema $ref within an OpenAPI spec file. " +
      "Useful when xc_get_operation_details truncated a nested type at max_depth. " +
      "Pass the spec_file (from xc_discover_apis output) and the ref string starting with '#/'.",
    {
      spec_file: z.string().describe("Spec filename (relative to f5-api/), e.g. 'docs-cloud-f5-com.0079...json'"),
      ref: z.string().describe('JSON Schema $ref, e.g. "#/components/schemas/ves.io.schema.http_loadbalancer.SpecType"'),
      max_depth: z.number().optional().describe("Max expansion depth (1-12, default 8)"),
    },
    async (params) => {
      return handleResolveSchemaRef(config, params);
    },
  );

  tool(
    "xc_call_api",
    "Generic escape hatch for any F5 XC API call. Prefer specific tools when one fits: " +
      "xc_list_namespaces / xc_list_resources / xc_list_tenants for listing, " +
      "xc_query_access_logs for logs, xc_lb_wait_ready for LB readiness, " +
      "xc_diff_resource / xc_patch_resource for state changes, xc_create_cert for certs. " +
      "Use xc_call_api only when no specific tool fits. Path pattern for resources in a namespace: " +
      "/api/config/namespaces/{namespace}/{resource_type} (add /{name} for individual). " +
      "Listing namespaces themselves lives at /api/web/namespaces -- prefer xc_list_namespaces. " +
      "PEM keys in certificate bodies are auto-blindfold-encrypted. " +
      "Always use blindfold_secret_info for private keys, never clear_secret_info.",
    {
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP method"),
      path: z.string().describe('API path. Example: "/api/config/namespaces/{namespace}/http_loadbalancers"'),
      path_params: z.record(z.string(), z.string()).optional().describe('Path params. Example: {"namespace":"default"}'),
      query_params: z.record(z.string(), z.string()).optional().describe("Query params"),
      body: z.any().optional().describe("Request body for POST/PUT/PATCH"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants configured)"),
      response_filter: z.string().optional().describe('Extract fields from response. Example: "items[].name,spec.origin_servers"'),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleCallApi(tenant, {
        method: params.method,
        path: params.path,
        path_params: params.path_params,
        query_params: params.query_params,
        body: params.body,
        response_filter: params.response_filter,
      });
    },
  );

  tool(
    "xc_list_namespaces",
    "List namespaces. Use prefix to filter.",
    {
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      prefix: z.string().optional().describe("Filter by name prefix"),
      label_selector: z.string().optional().describe("Filter by labels"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleListNamespaces(tenant, params);
    },
  );

  tool(
    "xc_list_resources",
    "List resources in a namespace. Common types: http_loadbalancers, tcp_loadbalancers, " +
      "origin_pools, healthchecks, app_firewalls, certificates, service_policys. " +
      "DNS types (dns_zones, dns_load_balancers, dns_lb_pools, dns_lb_health_checks) " +
      "are routed to the DNS API group automatically.",
    {
      namespace: z.string().optional().describe("Namespace (optional if default configured)"),
      resource_type: z.string().describe('Resource type. Example: "http_loadbalancers"'),
      label_selector: z.string().optional().describe("Label filter"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      fields: z.array(z.string()).optional().describe('Per-item fields. Example: ["spec.origin_servers"]'),
      max_items: z.number().optional().describe("Max items to return"),
      verify: z.boolean().optional().describe("If true, probe each returned name with a GET and drop any that 404. Adds N extra requests; use sparingly."),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      const ns = resolveNamespace(tenant, params.namespace);
      if (typeof ns !== "string") {
        return { content: [{ type: "text", text: ns.guidance }] };
      }
      return handleListResources(tenant, { ...params, namespace: ns });
    },
  );

  tool(
    "xc_search_resources",
    "Find resources by name across multiple namespaces in one call. " +
      "If 'namespaces' is omitted, scans every namespace visible to the tenant. " +
      "name_pattern accepts a substring match or a glob with '*'.",
    {
      resource_type: z.string().describe('Resource type, e.g. "http_loadbalancers"'),
      name_pattern: z.string().optional().describe("Substring or glob (* allowed)"),
      namespaces: z.array(z.string()).optional().describe("Specific namespaces. Omit to scan all."),
      label_selector: z.string().optional().describe("Label selector applied to each list call"),
      max_namespaces: z.number().optional().describe("Cap on namespaces scanned"),
      tenant: z.string().optional().describe("Tenant name"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleSearchResources(tenant, params);
    },
  );

  tool(
    "xc_create_cert",
    "Generate a self-signed certificate and create it in XC with blindfold-encrypted private key. " +
      "No PEM handling needed — cert is generated and encrypted server-side.",
    {
      name: z.string().describe("Certificate object name"),
      namespace: z.string().describe("Namespace"),
      domain: CERT_DOMAIN_SCHEMA.describe("Hostname for the CN, optionally *.-prefixed (e.g. mcp.myedgedemo.com)"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleCreateCert(tenant, params);
    },
  );

  tool(
    "xc_patch_resource",
    "Mutate an XC resource via JSON-Patch. Performs GET → strip read-only fields → apply ops → PUT. " +
      "Avoids the GET-mutate-PUT round-trip the caller would otherwise hand-roll. " +
      "Preserves resource_version unless check_resource_version=false.",
    {
      resource: z.string().describe('Resource ref. Format: "<resource_type>/<namespace>/<name>" or full /api path. Example: "http_loadbalancers/default/my-lb"'),
      ops: z.array(z.object({
        op: z.enum(["add", "replace", "remove"]),
        path: z.string().describe("RFC 6901 JSON Pointer. Example: /spec/connection_idle_timeout"),
        value: z.any().optional(),
      })).describe("JSON-Patch ops"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      check_resource_version: z.boolean().optional().describe("Pass current resource_version through the PUT for concurrency check (default true)"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handlePatchResource(tenant, {
        resource: params.resource,
        ops: params.ops as any,
        check_resource_version: params.check_resource_version,
      });
    },
  );

  tool(
    "xc_diff_resource",
    "Show what xc_call_api PUT or xc_patch_resource would change. Returns a JSON-Patch diff " +
      "between the current resource and a proposed body, without applying anything.",
    {
      resource: z.string().describe('Resource ref. Format: "<resource_type>/<namespace>/<name>"'),
      body: z.any().describe("Proposed full resource body"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleDiffResource(tenant, { resource: params.resource, body: params.body });
    },
  );

  tool(
    "xc_lb_wait_ready",
    "Poll an HTTP LB until spec.cert_state == CertificateValid (or timeout). " +
      "Returns ready=false on timeout rather than throwing.",
    {
      namespace: z.string().describe("Namespace"),
      lb_name: z.string().describe("HTTP LB name"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      timeout_seconds: z.number().optional().describe("Max wait (default 600)"),
      poll_interval_seconds: z.number().optional().describe("Poll cadence (default 30)"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleWaitReady(tenant, params);
    },
  );

  tool(
    "xc_query_access_logs",
    "Query XC access logs for an LB / time window. Parses stringified log entries, " +
      "auto-paginates via scroll_id, and supports group_by aggregation.",
    {
      namespace: z.string().describe("Namespace"),
      lb_name: z.string().optional().describe("HTTP LB name, plain (vh_name prefix added)"),
      start: z.string().describe("RFC3339 start time"),
      end: z.string().describe("RFC3339 end time"),
      rsp_code_class: z.string().optional().describe("1xx/2xx/3xx/4xx/5xx"),
      query: z.string().optional().describe("Raw Loki-style override"),
      group_by: z.string().optional().describe("Dot-path field to count by. Example: rsp_code_details"),
      max_pages: z.number().optional().describe("Pagination cap (default 5)"),
      page_size: z.number().optional().describe("Per-page limit (default 100, max 500)"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleQueryAccessLogs(tenant, params);
    },
  );

  tool(
    "xc_dns_zone_status",
    "Diagnostic roll-up for a DNS zone: deployment status, assigned nameservers, " +
      "Operational condition, and optional data-plane reachability probe via local_zone_file. " +
      "Surfaces 'control_plane_active_but_data_plane_unreachable' when the two disagree.",
    {
      namespace: z.string().describe("Namespace (typically 'system' for tenant-wide zones)"),
      name: z.string().describe("Zone name"),
      include_zone_file: z.boolean().optional().describe("Probe local_zone_file to detect data-plane outages (default true)"),
      tenant: z.string().optional().describe("Tenant name"),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleDnsZoneStatus(tenant, { ...params, include_zone_file: params.include_zone_file ?? true });
    },
  );

  tool(
    "xc_lb_set_request_headers",
    "Add or remove request headers on an HTTP LB (LB-level spec.add_request_headers). " +
      "Convenience wrapper over a GET/strip/PUT cycle; preserves optimistic concurrency by default.",
    {
      namespace: z.string(),
      name: z.string(),
      add: z.array(z.object({
        name: z.string(),
        value: z.string(),
      })).optional(),
      remove: z.array(z.string()).optional(),
      tenant: z.string().optional(),
      check_resource_version: z.boolean().optional().describe("Default true. Set false to skip optimistic-lock check."),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleLbSetRequestHeaders(tenant, params);
    },
  );

  tool(
    "xc_pool_attach_healthcheck",
    "Attach a named healthcheck to an origin_pool's spec.healthcheck list. Idempotent.",
    {
      namespace: z.string(),
      pool_name: z.string(),
      healthcheck_name: z.string(),
      tenant: z.string().optional(),
      check_resource_version: z.boolean().optional(),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handlePoolAttachHealthcheck(tenant, params);
    },
  );

  tool(
    "xc_pool_detach_healthcheck",
    "Remove a named healthcheck from an origin_pool's spec.healthcheck list.",
    {
      namespace: z.string(),
      pool_name: z.string(),
      healthcheck_name: z.string(),
      tenant: z.string().optional(),
      check_resource_version: z.boolean().optional(),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handlePoolDetachHealthcheck(tenant, params);
    },
  );

  tool(
    "xc_query_lb_metrics",
    "Time-bucketed request counts for an HTTP LB derived from access logs. " +
      "Returns per-bucket total + response-code-class breakdown (2xx/3xx/4xx/5xx). " +
      "Use bucket=1m/5m/15m/1h. For raw access logs use xc_query_access_logs.",
    {
      namespace: z.string(),
      lb_name: z.string(),
      start: z.string().describe("ISO timestamp"),
      end: z.string().describe("ISO timestamp"),
      bucket: z.enum(["1m", "5m", "15m", "1h"]).optional(),
      tenant: z.string().optional(),
    },
    async (params, extra) => {
      const tenant = withTenant(config, params.tenant, extra);
      if ("content" in tenant) return tenant;
      return handleQueryLbMetrics(tenant, params);
    },
  );

  tool(
    "xc_list_tenants",
    "List all configured F5 XC tenants. Shows tenant names, URLs, and server version.",
    {},
    async (_params, extra) => {
      const tenants = visibleTenants(config, extra);
      if (typeof tenants === "string") {
        return { content: [{ type: "text", text: tenants }], isError: true };
      }
      const lines = [`F5 XC MCP Server v${VERSION}\n`];
      lines.push(`${tenants.length} tenant(s) configured:\n`);
      for (const t of tenants) {
        const ns = t.defaultNamespace ? ` (default namespace: ${t.defaultNamespace})` : "";
        lines.push(`- ${t.name} -- ${t.tenantUrl}${ns}`);
      }
      if (tenants.length > 1) {
        lines.push(
          `\nPass the tenant name to xc_call_api, xc_list_namespaces, or xc_list_resources.`,
        );
      }

      // Remote users can't act on update hints, so hosted mode skips the check.
      const update = config.mode === "hosted"
        ? { updateAvailable: false, current: VERSION, latest: null }
        : await checkForUpdate();
      if (update.updateAvailable && update.latest) {
        lines.push(
          `\n⚠ Update available: v${update.latest} (current: v${update.current})`,
          `  Docker: docker pull ghcr.io/mikej81/xc-mcp:latest`,
          `  Git: git pull && npm run build`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

/**
 * Register MCP resource templates for discoverable data.
 */
function registerResources(server: McpServer, config: ServerConfig, index: OperationsIndex) {
  // Static resource: API categories and operation counts
  server.resource(
    "api-categories",
    "xc://api/categories",
    { description: "F5 XC API categories with operation counts" },
    async () => {
      const counts = new Map<string, number>();
      for (const op of index.operations) {
        counts.set(op.category, (counts.get(op.category) || 0) + 1);
      }
      const categories = Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name}: ${count} operations`);
      return {
        contents: [{
          uri: "xc://api/categories",
          text: `${index.totalOperations} operations across ${categories.length} categories:\n\n${categories.join("\n")}`,
          mimeType: "text/plain",
        }],
      };
    },
  );

  // Static resource: common resource types with templates
  server.resource(
    "resource-types",
    "xc://api/resource-types",
    { description: "Common F5 XC resource types that have create templates" },
    async () => ({
      contents: [{
        uri: "xc://api/resource-types",
        text: [
          "Resource types with built-in create templates:",
          "",
          "  http_loadbalancers  — HTTPS LB with auto-cert or custom cert",
          "  tcp_loadbalancers   — TCP LB with origin pool",
          "  origin_pools        — Public IP or Kubernetes service upstream",
          "  app_firewalls       — WAF in blocking mode",
          "  certificates        — TLS cert with blindfold-encrypted key",
          "  healthchecks        — HTTP health check",
          "  dns_zones           — Primary DNS zone",
          "  service_policys     — Allow/deny service policy",
          "",
          "Use xc_get_operation_details with the POST operation to get the template.",
          "Use xc_list_resources to list existing resources of any type.",
        ].join("\n"),
        mimeType: "text/plain",
      }],
    }),
  );

  // Resource template: tenant info (parameterized by tenant name)
  server.resource(
    "tenant-info",
    "xc://tenants/{name}",
    { description: "F5 XC tenant configuration details" },
    async (uri, extra) => {
      const tenants = visibleTenants(config, extra);
      if (typeof tenants === "string") {
        return { contents: [{ uri: uri.href, text: tenants, mimeType: "text/plain" }] };
      }
      const name = uri.pathname.split("/").pop() || "";
      const tenant = tenants.find((t) => t.name === name);
      if (!tenant) {
        return {
          contents: [{
            uri: uri.href,
            text: `Tenant "${name}" not found. Available: ${tenants.map((t) => t.name).join(", ")}`,
            mimeType: "text/plain",
          }],
        };
      }
      const lines = [
        `Tenant: ${tenant.name}`,
        `URL: ${tenant.tenantUrl}`,
      ];
      if (tenant.defaultNamespace) {
        lines.push(`Default namespace: ${tenant.defaultNamespace}`);
      }
      return {
        contents: [{
          uri: uri.href,
          text: lines.join("\n"),
          mimeType: "text/plain",
        }],
      };
    },
  );
}

/**
 * Register MCP prompts — pre-built templates for common workflows.
 */
function registerPrompts(server: McpServer, config: ServerConfig) {
  server.prompt(
    "audit-namespace",
    "Audit all resources in a namespace — lists LBs, origin pools, WAFs, certs, and identifies orphaned objects",
    { namespace: z.string().describe("Namespace to audit"), tenant: z.string().optional().describe("Tenant name") },
    (params) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Audit the "${params.namespace}" namespace${params.tenant ? ` on the ${params.tenant} tenant` : ""}. ` +
            "List all HTTP load balancers, origin pools, app firewalls, certificates, and healthchecks. " +
            "Then cross-reference them to find: (1) origin pools not referenced by any LB, " +
            "(2) WAF policies not attached to any LB, (3) certificates not used by any LB, " +
            "(4) LBs with no origin pools configured. Summarize findings in a table.",
        },
      }],
    }),
  );

  if (!config.readOnly) server.prompt(
    "deploy-https-lb",
    "Deploy an HTTPS load balancer with WAF, origin pool, and certificate",
    {
      domain: z.string().describe("Domain name for the LB"),
      origin: z.string().describe("Upstream origin (host:port)"),
      namespace: z.string().describe("Namespace"),
      tenant: z.string().optional().describe("Tenant name"),
    },
    (params) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Deploy an HTTPS load balancer for ${params.domain} in namespace ${params.namespace}` +
            `${params.tenant ? ` on the ${params.tenant} tenant` : ""}. ` +
            `Create a self-signed certificate, an origin pool pointing to ${params.origin}, ` +
            "and an app firewall in blocking mode. Advertise on the default public VIP. " +
            "Name all resources based on the domain.",
        },
      }],
    }),
  );

  server.prompt(
    "compare-tenants",
    "Compare resources between two tenants",
    {
      namespace: z.string().describe("Namespace to compare"),
      resource_type: z.string().optional().describe("Resource type (default: http_loadbalancers)"),
    },
    (params, extra) => {
      const tenants = visibleTenants(config, extra);
      if (typeof tenants === "string") {
        return { messages: [{ role: "user", content: { type: "text", text: tenants } }] };
      }
      const tenantNames = tenants.map((t) => t.name).join(" and ");
      const rt = params.resource_type || "http_loadbalancers";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Compare ${rt} in the "${params.namespace}" namespace between the ${tenantNames} tenants. ` +
              "List what exists in each, highlight differences in configuration, " +
              "and flag any resources that exist in one tenant but not the other.",
          },
        }],
      };
    },
  );

  server.prompt(
    "inventory",
    "Full inventory of a namespace — all resource types and counts",
    { namespace: z.string().describe("Namespace to inventory"), tenant: z.string().optional().describe("Tenant name") },
    (params) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Give me a full inventory of the "${params.namespace}" namespace` +
            `${params.tenant ? ` on the ${params.tenant} tenant` : ""}. ` +
            "List counts for: http_loadbalancers, tcp_loadbalancers, origin_pools, " +
            "app_firewalls, certificates, healthchecks, dns_zones, service_policys. " +
            "Present as a table with resource type and count.",
        },
      }],
    }),
  );
}

export function createMcpServer(config: ServerConfig, index: OperationsIndex): McpServer {
  const server = new McpServer({
    name: "f5-xc-mcp",
    version: VERSION,
  });
  registerTools(server, config, index);
  registerResources(server, config, index);
  registerPrompts(server, config);
  installTasksRfcCompat(server);
  return server;
}
