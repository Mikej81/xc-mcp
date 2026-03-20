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
import type { OperationsIndex } from "./types/index.js";
import type { ServerConfig, TenantConfig } from "./types/index.js";
import { handleDiscover } from "./tools/discover.js";
import { handleOperationDetails } from "./tools/operation-details.js";
import { handleCallApi } from "./tools/call-api.js";
import { handleListNamespaces } from "./tools/list-namespaces.js";
import { handleListResources } from "./tools/list-resources.js";
import { VERSION, checkForUpdate } from "./lib/version.js";

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
 * Register all 6 tools on an McpServer instance.
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
      summary_mode: z.boolean().optional().describe("Strip descriptions, keep only types/required/enums (default false)"),
    },
    async (params) => handleOperationDetails(index, config.specsDir, params),
  );

  server.tool(
    "xc_call_api",
    "Execute an F5 XC API call. For common operations you can call this directly -- " +
      "standard path pattern: /api/config/namespaces/{namespace}/{resource_type} for GET/list, " +
      "add /{name} for individual resources. PEM keys in certificate bodies are auto-blindfold-encrypted.",
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
    "List resources in a namespace. Call directly for common types: http_loadbalancers, " +
      "origin_pools, healthchecks, app_firewalls, certificates, dns_zones.",
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

function createMcpServer(config: ServerConfig, index: OperationsIndex): McpServer {
  const server = new McpServer({
    name: "f5-xc-mcp",
    version: VERSION,
  });
  registerTools(server, config, index);
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
async function startHttp(config: ServerConfig, index: OperationsIndex) {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
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
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
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
  });

  process.on("SIGINT", async () => {
    console.error("Shutting down...");
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

  console.error(`F5 XC MCP Server v${VERSION} starting...`);
  console.error(`  Tenants: ${config.tenants.map((t) => `${t.name} (${t.tenantUrl})`).join(", ")}`);
  console.error(`  Operations indexed: ${index.totalOperations}`);
  console.error(`  Categories: ${index.categories.length}`);
  console.error(`  Transport: ${transport === "http" ? "HTTP" : "stdio"}`);

  // Non-blocking update check — log to stderr, never delay startup
  checkForUpdate().then((update) => {
    if (update.updateAvailable && update.latest) {
      console.error(`\n  Update available: v${update.latest} (current: v${update.current})`);
      console.error(`  Run: docker pull ghcr.io/mikej81/xc-mcp:latest`);
    }
  }).catch(() => { /* ignore */ });

  if (transport === "http") {
    await startHttp(config, index);
  } else {
    await startStdio(config, index);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
