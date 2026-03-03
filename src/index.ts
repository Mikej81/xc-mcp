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
import { parseTenantEnvVars, resolveTenant } from "./lib/tenant.js";
import type { OperationsIndex } from "./types/index.js";
import type { ServerConfig, TenantConfig } from "./types/index.js";
import { handleDiscover } from "./tools/discover.js";
import { handleOperationDetails } from "./tools/operation-details.js";
import { handleCallApi } from "./tools/call-api.js";
import { handleListNamespaces } from "./tools/list-namespaces.js";
import { handleListResources } from "./tools/list-resources.js";

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
    "Search and browse F5 XC API operations by keyword, category, HTTP method, or resource type. " +
      "Returns matching operations with method, path, summary, and category. " +
      "Use xc_get_operation_details to get full schema for a specific operation.",
    {
      query: z.string().optional().describe(
        "Search text to match against summaries, descriptions, paths, and operation IDs. " +
          "Multiple words are AND-matched. Examples: 'load balancer', 'create namespace'",
      ),
      category: z.string().optional().describe(
        "Filter by category: AI/ML, API Security, BIG-IP, Billing, Bot Protection, Certificates, " +
          "Cloud Sites, DDoS Protection, DNS, IAM, Load Balancing, Monitoring, NGINX, Networking, " +
          "Operations, Other, Security, Support",
      ),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("Filter by HTTP method"),
      resource_type: z.string().optional().describe(
        "Filter by resource type from the path. Examples: 'http_loadbalancers', 'namespaces'",
      ),
      limit: z.number().optional().describe("Max results to return (default 20, max 50)"),
      offset: z.number().optional().describe("Offset for pagination (default 0)"),
    },
    async (params) => handleDiscover(index, params),
  );

  server.tool(
    "xc_get_operation_details",
    "Get full schema details for a specific F5 XC API operation including parameters, " +
      "request body schema, and response schema. Use xc_discover_apis first to find the operation_key.",
    {
      operation_key: z.string().describe(
        'The operation key in "METHOD:path" format from xc_discover_apis. ' +
          'Example: "GET:/api/config/namespaces/{namespace}/http_loadbalancers"',
      ),
    },
    async (params) => handleOperationDetails(index, config.specsDir, params),
  );

  server.tool(
    "xc_call_api",
    "Execute an F5 XC API call. Use xc_discover_apis and xc_get_operation_details first " +
      "to understand the endpoint. Supports all HTTP methods with path params, query params, and body.",
    {
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP method"),
      path: z.string().describe(
        'API path template. Example: "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"',
      ),
      path_params: z.record(z.string(), z.string()).optional().describe(
        'Path parameter values. Example: { "namespace": "default", "name": "my-lb" }',
      ),
      query_params: z.record(z.string(), z.string()).optional().describe("Query string parameters"),
      body: z.any().optional().describe(
        "Request body (for POST/PUT/PATCH). Use xc_get_operation_details to see expected schema.",
      ),
      tenant: z.string().optional().describe(
        "Tenant name to use. Required when multiple tenants are configured. " +
          "Use xc_list_tenants to see available tenants.",
      ),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleCallApi(tenant, params as any);
    },
  );

  server.tool(
    "xc_list_namespaces",
    "List all namespaces in the F5 XC tenant. Typically the first step -- most resources are scoped to a namespace.",
    {
      tenant: z.string().optional().describe(
        "Tenant name to use. Required when multiple tenants are configured. " +
          "Use xc_list_tenants to see available tenants.",
      ),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleListNamespaces(tenant);
    },
  );

  server.tool(
    "xc_list_resources",
    "List resources of a specific type within a namespace. Common types: http_loadbalancers, " +
      "tcp_loadbalancers, origin_pools, healthchecks, app_firewalls, service_policys, dns_zones, virtual_networks.",
    {
      namespace: z.string().describe('Namespace to list resources in. Example: "default"'),
      resource_type: z.string().describe(
        'Resource type as it appears in the API path. Example: "http_loadbalancers"',
      ),
      label_selector: z.string().optional().describe(
        'Optional label selector. Example: "app=web,environment=production"',
      ),
      tenant: z.string().optional().describe(
        "Tenant name to use. Required when multiple tenants are configured. " +
          "Use xc_list_tenants to see available tenants.",
      ),
    },
    async (params) => {
      const tenant = withTenant(config, params.tenant);
      if ("content" in tenant) return tenant;
      return handleListResources(tenant, params);
    },
  );

  server.tool(
    "xc_list_tenants",
    "List all configured F5 XC tenants. Shows tenant names and URLs.",
    {},
    async () => {
      const lines = [`${config.tenants.length} tenant(s) configured:\n`];
      for (const t of config.tenants) {
        lines.push(`- ${t.name} -- ${t.tenantUrl}`);
      }
      if (config.tenants.length > 1) {
        lines.push(
          `\nPass the tenant name to xc_call_api, xc_list_namespaces, or xc_list_resources.`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

function createMcpServer(config: ServerConfig, index: OperationsIndex): McpServer {
  const server = new McpServer({
    name: "f5-xc-mcp",
    version: "1.0.0",
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

  console.error(`F5 XC MCP Server starting...`);
  console.error(`  Tenants: ${config.tenants.map((t) => `${t.name} (${t.tenantUrl})`).join(", ")}`);
  console.error(`  Operations indexed: ${index.totalOperations}`);
  console.error(`  Categories: ${index.categories.length}`);
  console.error(`  Transport: ${transport === "http" ? "HTTP" : "stdio"}`);

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
