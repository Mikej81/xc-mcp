import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { loadIndex } from "./lib/spec-index.js";
import { parseTenantEnvVars, resolveTenant, resolveNamespace } from "./lib/tenant.js";
import { loadP12Dispatcher } from "./lib/p12.js";
import type { OperationsIndex } from "./types/index.js";
import type { ServerConfig, TenantConfig } from "./types/index.js";
import { handleDiscover } from "./tools/discover.js";
import { handleOperationDetails } from "./tools/operation-details.js";
import { handleCallApi } from "./tools/call-api.js";
import { handleListNamespaces } from "./tools/list-namespaces.js";
import { handleListResources } from "./tools/list-resources.js";
import { handleCreateCert } from "./tools/create-cert.js";
import { handlePatchResource } from "./tools/patch-resource.js";
import { handleWaitReady } from "./tools/wait-ready.js";
import { handleDiffResource } from "./tools/diff-resource.js";
import { handleQueryAccessLogs } from "./tools/query-access-logs.js";
import { VERSION, checkForUpdate } from "./lib/version.js";
import { parseAuthConfig, checkAuth, type AuthConfig } from "./lib/auth.js";
import { log } from "./lib/logger.js";
import { installTasksRfcCompat } from "./lib/tasks-rfc-compat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePaths() {
  const candidates = [
    join(__dirname, ".."),
    join(__dirname, "../.."),
  ];

  for (const base of candidates) {
    const trySpecs = join(base, "f5-api");
    const tryIndex = join(base, "data", "operations-index.json");
    if (existsSync(trySpecs) && existsSync(tryIndex)) {
      return { specsDir: trySpecs, indexPath: tryIndex };
    }
  }

  const projectRoot = join(__dirname, "../..");
  return {
    specsDir: join(projectRoot, "f5-api"),
    indexPath: join(projectRoot, "data", "operations-index.json"),
  };
}

function validateEnv(): ServerConfig {
  const tenants = parseTenantEnvVars();

  // Eagerly load P12 dispatchers so a bad path/password fails fast at startup.
  for (const tenant of tenants) {
    if (tenant.p12Path && tenant.p12Password) {
      try {
        tenant.p12Dispatcher = loadP12Dispatcher(tenant.p12Path, tenant.p12Password);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `Error: Failed to load P12 for tenant "${tenant.name}": ${reason}`,
        );
        process.exit(1);
      }
    }
  }

  const { specsDir, indexPath } = resolvePaths();

  if (!existsSync(indexPath)) {
    console.error(`Error: Operations index not found at ${indexPath}`);
    console.error('Run "npm run build:index" first.');
    process.exit(1);
  }

  return {
    tenants,
    specsDir,
    indexPath,
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Resolve a tenant from the config, returning either the TenantConfig
 * or an MCP error response if resolution fails.
 */
function withTenant(
  config: ServerConfig,
  tenantName: string | undefined,
): TenantConfig | ToolResult {
  const result = resolveTenant(config.tenants, tenantName);
  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }],
      isError: true,
    };
  }
  return result;
}

/**
 * Register all tools on an McpServer instance.
 */
function registerTools(server: McpServer, config: ServerConfig, index: OperationsIndex) {
  server.tool(
    "xc_discover_apis",
    "Search F5 XC API operations. Only needed when you don't know the API path -- " +
      "for common resources, call xc_list_resources or xc_call_api directly.",
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

  server.tool(
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

  server.tool(
    "xc_call_api",
    "Execute an F5 XC API call. For common operations you can call this directly -- " +
      "standard path pattern: /api/config/namespaces/{namespace}/{resource_type} for GET/list, " +
      "add /{name} for individual resources. PEM keys in certificate bodies are auto-blindfold-encrypted. " +
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
    async (params) => {
      const tenant = withTenant(config, params.tenant);
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

  server.tool(
    "xc_list_namespaces",
    "List namespaces. Use prefix to filter.",
    {
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      prefix: z.string().optional().describe("Filter by name prefix"),
      label_selector: z.string().optional().describe("Filter by labels"),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleListNamespaces(tenant, params);
    },
  );

  server.tool(
    "xc_list_resources",
    "List resources in a namespace. Common types: http_loadbalancers, tcp_loadbalancers, " +
      "origin_pools, healthchecks, app_firewalls, certificates, dns_zones, service_policys.",
    {
      namespace: z.string().optional().describe("Namespace (optional if default configured)"),
      resource_type: z.string().describe('Resource type. Example: "http_loadbalancers"'),
      label_selector: z.string().optional().describe("Label filter"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
      fields: z.array(z.string()).optional().describe('Per-item fields. Example: ["spec.origin_servers"]'),
      max_items: z.number().optional().describe("Max items to return"),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      const ns = resolveNamespace(tenant, params.namespace);
      if (typeof ns !== "string") {
        return { content: [{ type: "text", text: ns.guidance }] };
      }
      return handleListResources(tenant, { ...params, namespace: ns });
    },
  );

  server.tool(
    "xc_create_cert",
    "Generate a self-signed certificate and create it in XC with blindfold-encrypted private key. " +
      "No PEM handling needed — cert is generated and encrypted server-side.",
    {
      name: z.string().describe("Certificate object name"),
      namespace: z.string().describe("Namespace"),
      domain: z.string().describe("Domain for the CN (e.g. mcp.myedgedemo.com)"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleCreateCert(tenant, params);
    },
  );

  server.tool(
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
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handlePatchResource(tenant, {
        resource: params.resource,
        ops: params.ops as any,
        check_resource_version: params.check_resource_version,
      });
    },
  );

  server.tool(
    "xc_diff_resource",
    "Show what xc_call_api PUT or xc_patch_resource would change. Returns a JSON-Patch diff " +
      "between the current resource and a proposed body, without applying anything.",
    {
      resource: z.string().describe('Resource ref. Format: "<resource_type>/<namespace>/<name>"'),
      body: z.any().describe("Proposed full resource body"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleDiffResource(tenant, { resource: params.resource, body: params.body });
    },
  );

  server.tool(
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
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleWaitReady(tenant, params);
    },
  );

  server.tool(
    "xc_query_access_logs",
    "Query XC access logs for an LB / time window. Parses stringified log entries, " +
      "auto-paginates via scroll_id, and supports group_by aggregation.",
    {
      namespace: z.string().describe("Namespace"),
      lb_name: z.string().optional().describe("LB name (sets vh_name label)"),
      start: z.string().describe("RFC3339 start time"),
      end: z.string().describe("RFC3339 end time"),
      rsp_code_class: z.string().optional().describe("1xx/2xx/3xx/4xx/5xx"),
      query: z.string().optional().describe("Raw Loki-style override"),
      group_by: z.string().optional().describe("Dot-path field to count by. Example: rsp_code_details"),
      max_pages: z.number().optional().describe("Pagination cap (default 5)"),
      page_size: z.number().optional().describe("Per-page limit (default 100, max 500)"),
      tenant: z.string().optional().describe("Tenant name (required if multiple tenants)"),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleQueryAccessLogs(tenant, params);
    },
  );

  server.tool(
    "xc_list_tenants",
    "List all configured F5 XC tenants. Shows tenant names, URLs, and server version.",
    {},
    async () => {
      const lines = [`F5 XC MCP Server v${VERSION}\n`];
      lines.push(`${config.tenants.length} tenant(s) configured:\n`);
      for (const t of config.tenants) {
        const ns = t.defaultNamespace ? ` (default namespace: ${t.defaultNamespace})` : "";
        lines.push(`- ${t.name} -- ${t.tenantUrl}${ns}`);
      }
      if (config.tenants.length > 1) {
        lines.push(
          `\nPass the tenant name to xc_call_api, xc_list_namespaces, or xc_list_resources.`,
        );
      }

      const update = await checkForUpdate();
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
    async (uri) => {
      const name = uri.pathname.split("/").pop() || "";
      const tenant = config.tenants.find((t) => t.name === name);
      if (!tenant) {
        return {
          contents: [{
            uri: uri.href,
            text: `Tenant "${name}" not found. Available: ${config.tenants.map((t) => t.name).join(", ")}`,
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

  server.prompt(
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
    (params) => {
      const tenantNames = config.tenants.map((t) => t.name).join(" and ");
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

function truncateForLog(value: unknown, maxChars = 4096): unknown {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxChars) return value;
    return { _truncated: true, preview: s.slice(0, maxChars) };
  } catch {
    return { _truncated: true, error: "stringify_failed" };
  }
}

function extractMcpFields(body: unknown): { mcpMethod?: string; toolName?: string } {
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;
  const mcpMethod = typeof obj.method === "string" ? obj.method : undefined;
  let toolName: string | undefined;
  if (mcpMethod === "tools/call" && obj.params && typeof obj.params === "object") {
    const params = obj.params as Record<string, unknown>;
    if (typeof params.name === "string") toolName = params.name;
  }
  return { mcpMethod, toolName };
}

function createMcpServer(config: ServerConfig, index: OperationsIndex): McpServer {
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

/**
 * Start in stdio mode (default). Used by Claude Code and other local MCP clients.
 */
async function startStdio(config: ServerConfig, index: OperationsIndex) {
  const server = createMcpServer(config, index);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("F5 XC MCP Server running on stdio");
}

/**
 * Start in HTTP mode. Used by ChatGPT and other remote MCP clients.
 * Each session gets its own McpServer + transport instance.
 */
async function startHttp(config: ServerConfig, index: OperationsIndex, authConfig: AuthConfig) {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActive = new Map<string, number>();
  const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes

  // Periodic cleanup of idle sessions
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_IDLE_MS) {
        const transport = transports.get(sid);
        if (transport) {
          transport.close().catch(() => {});
          transports.delete(sid);
        }
        sessionLastActive.delete(sid);
        log("info", "session_expired", {
          session_id: sid.slice(0, 8),
          idle_minutes: Math.round((now - lastActive) / 60000),
        });
      }
    }
  }, 60_000); // Check every minute

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const startTime = Date.now();
    let parsedBody: unknown = undefined;
    let logged = false;
    const emitAccessLog = () => {
      if (logged) return;
      logged = true;
      const duration = Date.now() - startTime;
      const status = res.statusCode;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const xff = req.headers["x-forwarded-for"];
      const xffFirst = Array.isArray(xff) ? xff[0] : (typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined);
      const { mcpMethod, toolName } = extractMcpFields(parsedBody);
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      log(level, "request", {
        method: req.method,
        path: url.pathname,
        status,
        session_id: sessionId ? sessionId.slice(0, 8) : undefined,
        peer_ip: req.socket.remoteAddress,
        peer_ip_xff: xffFirst,
        duration_ms: duration,
        mcp_method: mcpMethod,
        tool_name: toolName,
        ...(process.env.MCP_LOG_LEVEL?.toLowerCase() === "debug" && parsedBody !== undefined
          ? { request_body: truncateForLog(parsedBody) }
          : {}),
      });
    };
    res.on("finish", emitAccessLog);
    res.on("close", emitAccessLog);

    // Auth gate — must run before body parsing or session lookup.
    const authResult = checkAuth(authConfig, req.headers);
    if (!authResult.ok) {
      const peerIp = req.socket.remoteAddress;
      log("warn", "auth_failed", {
        reason: authResult.reason,
        peer_ip: peerIp,
        auth_header_name: authConfig.enabled ? authConfig.headerName : undefined,
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Parse body for POST requests
    let body: unknown = undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
        parsedBody = body;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Existing session
      if (sessionId && transports.has(sessionId)) {
        sessionLastActive.set(sessionId, Date.now());
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
        return;
      }

      // New initialization request
      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            sessionLastActive.set(sid, Date.now());
            log("info", "session_created", { session_id: sid.slice(0, 8) });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            sessionLastActive.delete(sid);
            log("info", "session_closed", { session_id: sid.slice(0, 8) });
          }
        };

        const server = createMcpServer(config, index);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // Bad request
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      }));
      return;
    }

    if (req.method === "GET") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  });

  httpServer.listen(port, () => {
    console.error(`F5 XC MCP Server running on http://localhost:${port}/mcp`);
    log("info", "http_listening", { port, path: "/mcp" });
  });

  process.on("SIGINT", async () => {
    log("info", "shutdown", { reason: "sigint" });
    clearInterval(cleanupInterval);
    for (const [sid, transport] of transports) {
      await transport.close();
      transports.delete(sid);
    }
    httpServer.close();
    process.exit(0);
  });
}

async function main() {
  const config = validateEnv();
  const index = loadIndex(config.indexPath);

  const transport = process.env.MCP_TRANSPORT?.toLowerCase();

  // Auth gate is HTTP-only. Parsing it here for stdio would surface fatal
  // errors on partial config to users who don't use HTTP at all.
  let authConfig: AuthConfig = { enabled: false };
  if (transport === "http") {
    try {
      authConfig = parseAuthConfig();
    } catch (err) {
      console.error(`Fatal: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  console.error(`F5 XC MCP Server v${VERSION} starting...`);
  log("info", "startup", {
    version: VERSION,
    tenants: config.tenants.map((t) => ({ name: t.name, url: t.tenantUrl })),
    operations_indexed: index.totalOperations,
    categories: index.categories.length,
    transport: transport === "http" ? "http" : "stdio",
    auth_enabled: authConfig.enabled,
    auth_header: authConfig.enabled ? authConfig.headerName : null,
  });

  // Non-blocking update check — log to stderr, never delay startup
  checkForUpdate().then((update) => {
    if (update.updateAvailable && update.latest) {
      console.error(`\n  Update available: v${update.latest} (current: v${update.current})`);
      console.error(`  Run: docker pull ghcr.io/mikej81/xc-mcp:latest`);
    }
  }).catch(() => { /* ignore */ });

  if (transport === "http") {
    await startHttp(config, index, authConfig);
  } else {
    await startStdio(config, index);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
