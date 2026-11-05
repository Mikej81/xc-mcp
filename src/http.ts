import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { OperationsIndex, ServerConfig, TenantConfig } from "./types/index.js";
import { checkAuth, type AuthConfig } from "./lib/auth.js";
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_EVICT_MIN_IDLE_SECONDS, credentialFingerprint, parseCredentialHeaders } from "./lib/hosted.js";
import { verifyCredentials } from "./lib/credential-check.js";
import { SessionRegistry } from "./lib/session-registry.js";
import { MAX_REQUEST_BODY_BYTES } from "./lib/constants.js";
import { log } from "./lib/logger.js";
import { createMcpServer } from "./server.js";

export const HEALTH_PATH = "/healthz";
export const READY_PATH = "/readyz";
/** Upper bound on closing sessions during shutdown, after any drain window. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

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

type BodyResult = { kind: "ok"; body: Buffer } | { kind: "too_large" } | { kind: "aborted" };

/**
 * Read the request body, stopping as soon as it exceeds the byte cap.
 *
 * Uses 'data' listeners rather than `for await`: the async iterator destroys the
 * request (and its socket) when the loop exits early, which would tear the
 * connection down before the 413 is written. On overflow we stop consuming and
 * leave the socket alone; the caller destroys it after the response finishes.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) return Promise.resolve({ kind: "too_large" });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onAbort);
      req.off("aborted", onAbort);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        cleanup();
        req.pause();
        // Swallow late socket errors (e.g. ECONNRESET) once we stop listening.
        req.on("error", () => {});
        resolve({ kind: "too_large" });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      cleanup();
      resolve({ kind: "ok", body: Buffer.concat(chunks) });
    };
    const onAbort = () => {
      cleanup();
      req.on("error", () => {});
      resolve({ kind: "aborted" });
    };
    const onClose = () => {
      if (!req.complete) onAbort();
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onAbort);
    req.on("aborted", onAbort);
    req.on("close", onClose);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Build the /mcp request handler. Each session gets its own McpServer + transport.
 *
 * Hosted mode: every request must carry X-XC-Tenant-* credential headers. On
 * initialize the credentials are verified upstream, and the session is bound to
 * a fingerprint of (tenant URL + token). Later requests on that session must
 * present credentials with the same fingerprint. Raw tokens are never stored.
 */
export function createHttpHandler(
  config: ServerConfig,
  index: OperationsIndex,
  authConfig: AuthConfig,
  options: { /** Clock for session activity tracking (tests). */ now?: () => number } = {},
): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
  drain: () => void;
} {
  const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
  const hosted = config.mode === "hosted";
  const allowedDomains = config.hosted?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;
  const registry = new SessionRegistry<StreamableHTTPServerTransport>({
    maxSessions: hosted ? config.hosted?.maxSessions ?? Infinity : Infinity,
    maxPerFingerprint: hosted ? config.hosted?.maxSessionsPerCredential ?? Infinity : Infinity,
    idleMs: SESSION_IDLE_MS,
    // Local mode has no caps, so this never matters there.
    minIdleForEvictMs: hosted ? config.hosted?.evictMinIdleMs ?? DEFAULT_EVICT_MIN_IDLE_SECONDS * 1000 : 0,
    now: options.now,
  });

  // Periodic cleanup of idle sessions
  const cleanupInterval = setInterval(() => {
    for (const { sid, value: transport } of registry.sweepIdle()) {
      transport.close().catch(() => {});
      log("info", "session_expired", {
        session_id: sid.slice(0, 8),
        idle_minutes: Math.round(SESSION_IDLE_MS / 60000),
      });
    }
  }, 60_000); // Check every minute
  cleanupInterval.unref();

  // Set by drain() or close(): /readyz turns 503 and new sessions are refused while existing ones finish.
  let shuttingDown = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", "http://localhost");

    // Probes for load balancers and Kubernetes. No auth, no access log (probes are frequent).
    if (url.pathname === HEALTH_PATH || url.pathname === READY_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
    }
    if (url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (url.pathname === READY_PATH) {
      if (shuttingDown) sendJson(res, 503, { status: "shutting_down" });
      else sendJson(res, 200, { status: "ready" });
      return;
    }

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const startTime = Date.now();
    // Captured up front: req.socket is null once the request has been destroyed.
    const peerIp = req.socket?.remoteAddress;
    let parsedBody: unknown = undefined;
    let tenantHost: string | undefined;
    let logged = false;
    const emitAccessLog = () => {
      if (logged) return;
      logged = true;
      try {
        writeAccessLog();
      } catch {
        // An event listener must never throw: that would crash the process.
      }
    };
    const writeAccessLog = () => {
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
        peer_ip: peerIp,
        peer_ip_xff: xffFirst,
        duration_ms: duration,
        mcp_method: mcpMethod,
        tool_name: toolName,
        ...(hosted ? { tenant_host: tenantHost } : {}),
        // Raw tool args can carry secrets (e.g. PEM keys); never logged in hosted mode.
        ...(!hosted && process.env.MCP_LOG_LEVEL?.toLowerCase() === "debug" && parsedBody !== undefined
          ? { request_body: truncateForLog(parsedBody) }
          : {}),
      });
    };
    res.on("finish", emitAccessLog);
    res.on("close", emitAccessLog);

    // Auth gate — must run before body parsing or session lookup.
    const authResult = checkAuth(authConfig, req.headers);
    if (!authResult.ok) {
      log("warn", "auth_failed", {
        reason: authResult.reason,
        peer_ip: peerIp,
        auth_header_name: authConfig.enabled ? authConfig.headerName : undefined,
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Hosted credential headers — also before body parsing or session lookup.
    let tenant: TenantConfig | undefined;
    let fingerprint = "";
    if (hosted) {
      const creds = parseCredentialHeaders(req.headers, allowedDomains);
      if (!creds.ok) {
        log("warn", "auth_failed", { reason: creds.reason, peer_ip: peerIp });
        sendJson(res, 401, { error: "unauthorized", reason: creds.reason });
        return;
      }
      tenant = creds.tenant;
      tenantHost = new URL(tenant.tenantUrl).hostname;
      fingerprint = credentialFingerprint(tenant);
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    /**
     * Look up the session for this request. Returns the transport, or undefined
     * after writing a response (hosted: 404 unknown / 403 credential mismatch).
     * In local mode an unknown session returns undefined without responding.
     */
    const lookupSession = (sid: string): StreamableHTTPServerTransport | undefined => {
      const entry = registry.get(sid);
      if (!entry) {
        if (hosted) sendJson(res, 404, { error: "session_not_found" });
        return undefined;
      }
      if (hosted && entry.fingerprint !== fingerprint) {
        log("warn", "auth_failed", {
          reason: "session_credential_mismatch",
          peer_ip: peerIp,
          session_id: sid.slice(0, 8),
        });
        sendJson(res, 403, { error: "session_credential_mismatch" });
        return undefined;
      }
      registry.touch(sid);
      return entry.value;
    };

    // Hosted: reject unknown / mismatched sessions before buffering any body.
    let sessionTransport: StreamableHTTPServerTransport | undefined;
    if (hosted && sessionId) {
      sessionTransport = lookupSession(sessionId);
      if (!sessionTransport) return;
    }

    // Parse body for POST requests
    let body: unknown = undefined;
    if (req.method === "POST") {
      const result = await readBody(req, MAX_REQUEST_BODY_BYTES);
      if (result.kind === "aborted") {
        // Client went away mid-body; nothing to answer.
        if (!res.headersSent) res.statusCode = 400;
        res.destroy();
        return;
      }
      if (result.kind === "too_large") {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      const raw = result.body;
      try {
        body = JSON.parse(raw.toString());
        parsedBody = body;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    if (req.method === "POST") {
      // Existing session
      if (sessionId) {
        const transport = sessionTransport ?? lookupSession(sessionId);
        if (transport) {
          await transport.handleRequest(req, res, body);
          return;
        }
        if (res.headersSent) return;
        // Local mode: unknown session falls through to today's 400.
      }

      // New initialization request
      if (!sessionId && isInitializeRequest(body)) {
        if (shuttingDown) {
          sendJson(res, 503, { error: "shutting_down" });
          return;
        }
        if (hosted) {
          const check = await verifyCredentials(tenant!);
          if (!check.ok) {
            log("warn", "auth_failed", {
              reason: check.reason,
              peer_ip: peerIp,
              upstream_status: check.upstreamStatus,
            });
            sendJson(res, check.status, { error: check.reason });
            return;
          }
        }

        // Admission: decide, then reserve the slot with registry.add, with no
        // await in between, so concurrent initializes can't overshoot the caps.
        // The session id is generated here so the slot can be keyed before the
        // transport assigns it during handleRequest.
        const admission = registry.admit(fingerprint);
        if (!admission.ok) {
          log("warn", "session_refused", { reason: admission.reason, peer_ip: peerIp });
          res.setHeader("Retry-After", String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))));
          if (admission.reason === "per_credential_cap") sendJson(res, 429, { error: "too_many_sessions" });
          else sendJson(res, 503, { error: "server_busy" });
          return;
        }
        for (const victim of admission.evicted) {
          victim.value.close().catch(() => {});
          log("info", "session_evicted", { session_id: victim.sid.slice(0, 8), reason: victim.reason });
        }
        const newSid = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSid,
          onsessioninitialized: (sid) => {
            log("info", "session_created", { session_id: sid.slice(0, 8) });
          },
        });
        registry.add(newSid, fingerprint, transport);

        transport.onclose = () => {
          registry.remove(newSid);
          if (transport.sessionId) log("info", "session_closed", { session_id: newSid.slice(0, 8) });
        };

        try {
          const server = createMcpServer(config, index);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } finally {
          // The transport rejected the initialize (e.g. bad Accept header): release the slot.
          if (transport.sessionId !== newSid && registry.remove(newSid)) {
            transport.close().catch(() => {});
          }
        }
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

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionTransport ?? (sessionId ? lookupSession(sessionId) : undefined);
      if (!transport) {
        if (res.headersSent) return;
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  };

  const close = async () => {
    shuttingDown = true;
    clearInterval(cleanupInterval);
    for (const [sid, transport] of [...registry.entries()]) {
      await transport.close();
      registry.remove(sid);
    }
  };

  const drain = () => {
    shuttingDown = true;
  };

  return { handler, close, drain };
}

/**
 * Start in HTTP mode. Used by ChatGPT and other remote MCP clients.
 */
export async function startHttp(config: ServerConfig, index: OperationsIndex, authConfig: AuthConfig): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const { handler, close, drain } = createHttpHandler(config, index, authConfig);
  const httpServer = createServer((req, res) => {
    handler(req, res).catch((err) => {
      log("error", "request_failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });

  httpServer.listen(port, () => {
    console.error(`F5 XC MCP Server running on http://localhost:${port}/mcp`);
    log("info", "http_listening", { port, path: "/mcp" });
  });

  const shutdown = createShutdown({ httpServer, close, beginDrain: drain, drainMs: config.shutdownDrainMs ?? 0 });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * Build a one-shot graceful shutdown. Order: mark not-ready (/readyz 503, new
 * sessions refused), wait `drainMs` so load balancers stop routing here, stop
 * accepting connections, close every session, exit 0. If closing takes longer
 * than `timeoutMs` after the drain window, exit 1. Repeat signals are ignored.
 * Running tool calls are not waited for; their connections close with the sessions.
 */
export function createShutdown(opts: {
  httpServer: Pick<Server, "close" | "closeAllConnections">;
  close: () => Promise<void>;
  beginDrain?: () => void;
  drainMs?: number;
  exit?: (code: number) => void;
  timeoutMs?: number;
}): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    const drainMs = opts.drainMs ?? 0;
    log("info", "shutdown", { reason: signal.toLowerCase(), drain_ms: drainMs, timeout_ms: timeoutMs });
    opts.beginDrain?.();
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
    // Not unref'd: if closing stalls, this timer is what turns the exit code into 1.
    const force = setTimeout(() => {
      log("warn", "shutdown_forced", { timeout_ms: timeoutMs });
      exit(1);
    }, timeoutMs);
    const serverClosed = new Promise<void>((resolve) => opts.httpServer.close(() => resolve()));
    try {
      await opts.close();
    } catch (err) {
      log("warn", "shutdown_close_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    opts.httpServer.closeAllConnections();
    await serverClosed;
    clearTimeout(force);
    exit(0);
  };
}
