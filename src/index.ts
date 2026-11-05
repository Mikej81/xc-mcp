import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, realpathSync } from "node:fs";

import { loadIndex } from "./lib/spec-index.js";
import { parseTenantEnvVars } from "./lib/tenant.js";
import { findTenantEnvVars, parseHostedConfig } from "./lib/hosted.js";
import { loadP12Dispatcher } from "./lib/p12.js";
import type { OperationsIndex } from "./types/index.js";
import type { ServerConfig } from "./types/index.js";
import { VERSION, checkForUpdate } from "./lib/version.js";
import { parseAuthConfig, type AuthConfig } from "./lib/auth.js";
import { log } from "./lib/logger.js";
import { createMcpServer } from "./server.js";
import { startHttp } from "./http.js";
import { parseReadOnlyEnv } from "./lib/tool-policy.js";

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

/**
 * Build the server config from env. Throws instead of exiting so it is testable.
 * Hosted mode never reads XC tenant env vars (and refuses to start if any are set).
 */
/** Parse MCP_SHUTDOWN_DRAIN_SECONDS: a non-negative integer, default 0. */
function parseDrainSeconds(value: string | undefined): number {
  const v = (value ?? "").trim();
  if (v === "") return 0;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new Error("MCP_SHUTDOWN_DRAIN_SECONDS must be a non-negative integer");
  }
  return Number(v);
}

export function buildServerConfig(
  env: NodeJS.ProcessEnv,
  paths: { specsDir: string; indexPath: string },
): ServerConfig {
  const mode = (env.MCP_MODE ?? "").trim().toLowerCase();
  const readOnly = parseReadOnlyEnv(env.MCP_READ_ONLY);
  const shutdownDrainMs = parseDrainSeconds(env.MCP_SHUTDOWN_DRAIN_SECONDS) * 1000;
  if (mode !== "" && mode !== "local" && mode !== "hosted") {
    throw new Error(`MCP_MODE must be "hosted" or "local" (or unset), got "${env.MCP_MODE}"`);
  }

  if (mode === "hosted") {
    if (env.MCP_TRANSPORT?.toLowerCase() !== "http") {
      throw new Error("MCP_MODE=hosted requires MCP_TRANSPORT=http");
    }
    const tenantVars = findTenantEnvVars(env);
    if (tenantVars.length > 0) {
      throw new Error(
        `MCP_MODE=hosted must not have XC tenant env vars set; remove: ${tenantVars.join(", ")}`,
      );
    }
    return {
      mode: "hosted",
      readOnly,
      shutdownDrainMs,
      tenants: [],
      hosted: parseHostedConfig(env),
      specsDir: paths.specsDir,
      indexPath: paths.indexPath,
    };
  }

  const tenants = parseTenantEnvVars();

  // Eagerly load P12 dispatchers so a bad path/password fails fast at startup.
  for (const tenant of tenants) {
    if (tenant.p12Path && tenant.p12Password) {
      try {
        tenant.p12Dispatcher = loadP12Dispatcher(tenant.p12Path, tenant.p12Password);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load P12 for tenant "${tenant.name}": ${reason}`);
      }
    }
  }

  return {
    tenants,
    specsDir: paths.specsDir,
    indexPath: paths.indexPath,
    mode: "local",
    readOnly,
    shutdownDrainMs,
  };
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

async function main() {
  let config: ServerConfig;
  try {
    config = buildServerConfig(process.env, resolvePaths());
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!existsSync(config.indexPath)) {
    console.error(`Error: Operations index not found at ${config.indexPath}`);
    console.error('Run "npm run build:index" first.');
    process.exit(1);
  }

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
  const hosted = config.mode === "hosted";
  log("info", "startup", {
    version: VERSION,
    mode: config.mode,
    read_only: config.readOnly === true,
    ...(hosted
      ? {
          allowed_domains: config.hosted?.allowedDomains,
          ...(process.env.MCP_LOG_LEVEL?.toLowerCase() === "debug"
            ? { request_body_logging: "suppressed" }
            : {}),
        }
      : {}),
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

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
