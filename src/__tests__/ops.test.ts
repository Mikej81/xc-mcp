import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { join } from "node:path";
import { createHttpHandler, createShutdown } from "../http.js";
import { loadIndex } from "../lib/spec-index.js";
import { buildServerConfig } from "../index.js";
import { TOOL_POLICIES, isReadOnlyHeader } from "../lib/tool-policy.js";
import type { ServerConfig } from "../types/index.js";
import { startTestServer, mcpRequest } from "./helpers/mcp-client.js";
import { renderMetrics, resetMetrics } from "../lib/metrics.js";
import { callApi } from "../lib/api-client.js";

vi.mock("node:child_process", async () => {
  const { writeFileSync } = await import("node:fs");
  return {
    execFileSync: vi.fn((_file: string, args: string[]) => {
      // Stand-in for openssl req: write a key and cert to the given paths.
      writeFileSync(args[args.indexOf("-keyout") + 1], "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
      writeFileSync(args[args.indexOf("-out") + 1], "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n");
      return Buffer.alloc(0);
    }),
  };
});

vi.mock("../lib/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/version.js")>();
  return { ...actual, checkForUpdate: async () => ({ updateAvailable: false, current: actual.VERSION, latest: null }) };
});

const indexPath = join(__dirname, "../../data/operations-index.json");
const specsDir = join(__dirname, "../../f5-api");
const ACME = "https://acme.console.ves.volterra.io";

const localConfig = (readOnly = false): ServerConfig => ({
  tenants: [{ name: "default", apiToken: "t", tenantUrl: ACME, defaultNamespace: "default" }],
  specsDir,
  indexPath,
  mode: "local",
  readOnly,
});

const hostedConfig = (): ServerConfig => ({
  tenants: [],
  specsDir,
  indexPath,
  mode: "hosted",
  readOnly: false,
  hosted: { allowedDomains: [".console.ves.volterra.io"], maxSessions: 500, maxSessionsPerCredential: 5, evictMinIdleMs: 300_000 },
});

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

const MUTATING = ["xc_create_cert", "xc_patch_resource", "xc_lb_set_request_headers", "xc_pool_attach_healthcheck", "xc_pool_detach_healthcheck"];

type Harness = { port: number; close: () => Promise<void>; stop: () => Promise<void> };

async function start(config: ServerConfig, auth: { enabled: false } | { enabled: true; headerName: string; headerValue: string } = { enabled: false }): Promise<Harness> {
  const h = createHttpHandler(config, loadIndex(indexPath), auth);
  const srv = await startTestServer(h.handler);
  return { port: srv.port, close: h.close, stop: srv.stop };
}

async function startWithDrain(config: ServerConfig) {
  const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
  const srv = await startTestServer(h.handler);
  return { port: srv.port, close: h.close, drain: h.drain, stop: srv.stop };
}

let nextId = 10;
async function session(port: number, headers: Record<string, string> = {}) {
  const init = await mcpRequest(port, { method: "POST", body: initBody, headers });
  expect(init.status).toBe(200);
  const sid = init.headers["mcp-session-id"] as string;
  const h = { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
  await mcpRequest(port, { method: "POST", headers: h, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  return {
    listTools: async () => {
      const r = await mcpRequest(port, { method: "POST", headers: h, body: { jsonrpc: "2.0", id: nextId++, method: "tools/list" } });
      return (r.json as { result: { tools: Array<{ name: string; description: string; annotations?: Record<string, unknown> }> } }).result.tools;
    },
    call: async (name: string, args: unknown, extraHeaders: Record<string, string> = {}) => {
      const r = await mcpRequest(port, {
        method: "POST",
        headers: { ...h, ...extraHeaders },
        body: { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
      });
      return (r.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    },
  };
}

const prevLevel = process.env.MCP_LOG_LEVEL;
const upstream: Array<{ method: string; path: string }> = [];
let upstreamStatus = 200;
let whoamiStatus = 200;
let upstreamFail: "network" | "timeout" | undefined;

beforeAll(() => {
  process.env.MCP_LOG_LEVEL = "error";
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string }) => {
    const u = new URL(String(input));
    if (upstreamFail === "network") throw new TypeError("fetch failed");
    if (upstreamFail === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (u.pathname !== "/api/web/custom/namespaces/system/whoami") upstream.push({ method: init?.method ?? "GET", path: u.pathname });
    return new Response(JSON.stringify({ items: [] }), { status: u.pathname === "/api/web/custom/namespaces/system/whoami" ? whoamiStatus : upstreamStatus, headers: { "content-type": "application/json" } });
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (prevLevel === undefined) delete process.env.MCP_LOG_LEVEL;
  else process.env.MCP_LOG_LEVEL = prevLevel;
});

describe("health endpoints", () => {
  it("/healthz and /readyz return 200 without auth, /readyz returns 503 once shutdown begins", async () => {
    const s = await start(localConfig(), { enabled: true, headerName: "x-mcp-auth", headerValue: "secret" });
    try {
      const live = await mcpRequest(s.port, { method: "GET", path: "/healthz" });
      expect(live.status).toBe(200);
      expect(live.json).toEqual({ status: "ok" });
      const ready = await mcpRequest(s.port, { method: "GET", path: "/readyz" });
      expect(ready.status).toBe(200);
      expect(ready.json).toEqual({ status: "ready" });
      await s.close();
      const draining = await mcpRequest(s.port, { method: "GET", path: "/readyz" });
      expect(draining.status).toBe(503);
      expect(draining.json).toEqual({ status: "shutting_down" });
      expect((await mcpRequest(s.port, { method: "GET", path: "/healthz" })).status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it("probe endpoints answer GET and HEAD only", async () => {
    const s = await start(localConfig());
    try {
      expect((await mcpRequest(s.port, { method: "POST", path: "/healthz", body: {} })).status).toBe(405);
      expect((await mcpRequest(s.port, { method: "DELETE", path: "/readyz" })).status).toBe(405);
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("drain() turns /readyz to 503 and refuses new sessions while existing work continues", async () => {
    const s = await startWithDrain(localConfig());
    try {
      s.drain();
      expect((await mcpRequest(s.port, { method: "GET", path: "/readyz" })).status).toBe(503);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody })).status).toBe(503);
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("refuses new sessions with 503 after shutdown begins", async () => {
    const s = await start(localConfig());
    try {
      await s.close();
      const res = await mcpRequest(s.port, { method: "POST", body: initBody });
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "shutting_down" });
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      await s.stop();
    }
  });
});

describe("createShutdown", () => {
  function fakeServer() {
    return {
      closed: false,
      close(cb?: (err?: Error) => void) { this.closed = true; cb?.(); return this; },
      closeAllConnections() {},
    };
  }

  it("closes sessions and the server, then exits 0; repeat signals are ignored", async () => {
    const server = fakeServer();
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdown({ httpServer: server as never, close, exit, timeoutMs: 1000 });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.closed).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("with a drain window, flips readiness first and stops accepting only after drainMs", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      const beginDrain = vi.fn();
      const exit = vi.fn();
      const shutdown = createShutdown({ httpServer: server as never, close: async () => {}, beginDrain, drainMs: 5000, exit, timeoutMs: 1000 });
      const done = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(0);
      expect(beginDrain).toHaveBeenCalledTimes(1);
      expect(server.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(4999);
      expect(server.closed).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(server.closed).toBe(true);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces exit 1 when closing hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdown({ httpServer: fakeServer() as never, close: () => new Promise(() => {}), exit, timeoutMs: 1000 });
      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tool annotations", () => {
  it("every registered tool declares annotations matching TOOL_POLICIES", async () => {
    const s = await start(localConfig());
    try {
      const tools = await (await session(s.port)).listTools();
      expect(tools.length).toBe(18);
      for (const t of tools) {
        expect(TOOL_POLICIES[t.name], `policy for ${t.name}`).toBeDefined();
        expect(t.annotations).toMatchObject(TOOL_POLICIES[t.name].annotations);
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
      expect(byName.xc_list_namespaces).toMatchObject({ readOnlyHint: true });
      expect(byName.xc_call_api).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.xc_patch_resource).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.xc_pool_attach_healthcheck).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(byName.xc_create_cert).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    } finally {
      await s.close();
      await s.stop();
    }
  });
});

describe("read-only mode", () => {
  it("MCP_READ_ONLY parsing in buildServerConfig", () => {
    const paths = { specsDir, indexPath };
    const base = { MCP_TRANSPORT: "http", MCP_MODE: "hosted" };
    expect(buildServerConfig({ ...base }, paths).readOnly).toBe(false);
    expect(buildServerConfig({ ...base, MCP_READ_ONLY: "true" }, paths).readOnly).toBe(true);
    expect(buildServerConfig({ ...base, MCP_READ_ONLY: "1" }, paths).readOnly).toBe(true);
    expect(buildServerConfig({ ...base, MCP_READ_ONLY: "false" }, paths).readOnly).toBe(false);
    expect(buildServerConfig({ ...base }, paths).shutdownDrainMs).toBe(0);
    expect(buildServerConfig({ ...base, MCP_SHUTDOWN_DRAIN_SECONDS: "5" }, paths).shutdownDrainMs).toBe(5000);
    expect(() => buildServerConfig({ ...base, MCP_SHUTDOWN_DRAIN_SECONDS: "-1" }, paths)).toThrow(/MCP_SHUTDOWN_DRAIN_SECONDS/);
    expect(() => buildServerConfig({ ...base, MCP_READ_ONLY: "maybe" }, paths)).toThrow(/MCP_READ_ONLY/);
  });

  it("isReadOnlyHeader: true/1/yes enable it, false/0/no/absent do not, anything else fails safe to read-only", () => {
    expect(isReadOnlyHeader(undefined)).toBe(false);
    for (const v of ["true", "TRUE", "1", "yes"]) expect(isReadOnlyHeader(v)).toBe(true);
    for (const v of ["false", "0", "no", ""]) expect(isReadOnlyHeader(v)).toBe(false);
    expect(isReadOnlyHeader("garbage")).toBe(true);
    expect(isReadOnlyHeader(["true", "false"])).toBe(true);
  });

  it("server-wide read-only hides mutating tools and limits xc_call_api to GET", async () => {
    const s = await start(localConfig(true));
    try {
      const sess = await session(s.port);
      const tools = await sess.listTools();
      const names = tools.map((t) => t.name);
      expect(tools.find((t) => t.name === "xc_call_api")?.annotations).toMatchObject({ readOnlyHint: true });
      for (const m of MUTATING) expect(names).not.toContain(m);
      expect(names).toContain("xc_call_api");
      expect(names).toContain("xc_query_access_logs");

      upstream.length = 0;
      const blocked = await sess.call("xc_call_api", { method: "DELETE", path: "/api/config/namespaces/default/http_loadbalancers/x" });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toMatch(/read-only/i);
      expect(upstream).toEqual([]);

      const ok = await sess.call("xc_call_api", { method: "GET", path: "/api/config/namespaces/default/http_loadbalancers" });
      expect(ok.isError).toBeFalsy();
      expect(upstream).toEqual([{ method: "GET", path: "/api/config/namespaces/default/http_loadbalancers" }]);
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("X-XC-Read-Only header blocks mutating tools for that request only (hosted)", async () => {
    const s = await start(hostedConfig());
    const creds = { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "tok" };
    try {
      const sess = await session(s.port, creds);
      expect((await sess.listTools()).map((t) => t.name)).toContain("xc_patch_resource");

      upstream.length = 0;
      const ro = { "x-xc-read-only": "true" };
      const patch = await sess.call("xc_patch_resource", {
        resource: "http_loadbalancers/default/x",
        ops: [{ op: "replace", path: "/spec/x", value: 1 }],
      }, ro);
      expect(patch.isError).toBe(true);
      expect(patch.content[0].text).toMatch(/read-only/i);
      const post = await sess.call("xc_call_api", { method: "POST", path: "/api/config/namespaces/default/healthchecks", body: {} }, ro);
      expect(post.isError).toBe(true);
      expect(upstream).toEqual([]);

      const get = await sess.call("xc_call_api", { method: "GET", path: "/api/web/namespaces" }, ro);
      expect(get.isError).toBeFalsy();

      upstream.length = 0;
      const allowed = await sess.call("xc_call_api", { method: "POST", path: "/api/config/namespaces/default/healthchecks", body: {} });
      expect(allowed.isError).toBeFalsy();
      expect(upstream.map((u) => u.method)).toEqual(["POST"]);
    } finally {
      await s.close();
      await s.stop();
    }
  });
});

describe("expired-token hint", () => {
  const callWith = async (config: ServerConfig, status: number, headers: Record<string, string> = {}) => {
    const s = await start(config);
    upstreamStatus = status;
    try {
      const sess = await session(s.port, headers);
      return await sess.call("xc_list_namespaces", {});
    } finally {
      upstreamStatus = 200;
      await s.close();
      await s.stop();
    }
  };

  it("local 401 appends one hint naming XC_API_TOKEN", async () => {
    const plain = await callWith(localConfig(), 403);
    const r = await callWith(localConfig(), 401);
    expect(r.content.length).toBe(plain.content.length + 1);
    expect(r.content[r.content.length - 1].text).toContain("XC_API_TOKEN");
  });

  it("xc_create_cert: a 401 on the blindfold policy fetch adds the hint and a GET 4xx upstream sample", async () => {
    resetMetrics();
    const s = await start(localConfig());
    upstreamStatus = 401;
    try {
      const sess = await session(s.port);
      const r = await sess.call("xc_create_cert", { name: "c1", namespace: "default", domain: "app.example.com" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Failed to fetch policy document: 401");
      expect(r.content[r.content.length - 1].text).toContain("XC_API_TOKEN");
      expect(renderMetrics()).toMatch(/xc_mcp_upstream_requests_total\{tool="xc_create_cert",method="GET",status_class="4xx"\} [12]\n/);
    } finally {
      upstreamStatus = 200;
      await s.close();
      await s.stop();
    }
  });

  it("local 403 and 200 add no hint", async () => {
    for (const status of [403, 200]) {
      const r = await callWith(localConfig(), status);
      expect(r.content.some((c) => c.text.includes("XC rejected the API token"))).toBe(false);
    }
  });

  it("hosted 401 names X-XC-Tenant-Token and not the token", async () => {
    const r = await callWith(hostedConfig(), 401, { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "hosted-secret-token" });
    const text = r.content.map((c) => c.text).join("\n");
    expect(text).toContain("X-XC-Tenant-Token");
    expect(text).not.toContain("hosted-secret-token");
  });
});

describe("metrics instrumentation", () => {
  const TOKEN = "metrics-secret-token";
  const creds = (token = TOKEN) => ({ "x-xc-tenant-url": ACME, "x-xc-tenant-token": token });
  const hostedWith = (h: Partial<NonNullable<ServerConfig["hosted"]>>): ServerConfig => {
    const c = hostedConfig();
    return { ...c, hosted: { ...c.hosted!, ...h } };
  };
  const metrics = () => renderMetrics();
  const expectNoSecrets = () => {
    const text = metrics();
    expect(text).not.toContain("acme");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("/api/");
  };

  beforeEach(() => {
    resetMetrics();
    whoamiStatus = 200;
    upstreamStatus = 200;
    upstreamFail = undefined;
  });

  /** For tests whose refusals produce 5xx access-log lines at error level. */
  const muteStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the MCP port does not serve /metrics", async () => {
    const s = await start(localConfig());
    try {
      expect((await mcpRequest(s.port, { method: "GET", path: "/metrics" })).status).toBe(404);
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("local session and one tool call move session, tool and upstream counters", async () => {
    const s = await start(localConfig());
    try {
      const sess = await session(s.port);
      expect(metrics()).toContain("xc_mcp_sessions_active 1");
      const r = await sess.call("xc_list_namespaces", {});
      expect(r.isError).toBeFalsy();
      const text = metrics();
      expect(text).toContain("xc_mcp_sessions_created_total 1");
      expect(text).toContain('xc_mcp_tool_calls_total{tool="xc_list_namespaces",outcome="ok"} 1');
      expect(text).toContain('xc_mcp_upstream_requests_total{tool="xc_list_namespaces",method="GET",status_class="2xx"} 1');
      expect(text).toContain('xc_mcp_upstream_request_duration_seconds_count{tool="xc_list_namespaces",method="GET"} 1');
      expectNoSecrets();
    } finally {
      await s.close();
      await s.stop();
    }
    expect(metrics()).toContain("xc_mcp_sessions_active 0");
  });

  it("tool calls that return isError count as outcome=error (including read-only refusals)", async () => {
    const s = await start(localConfig(true));
    try {
      const sess = await session(s.port);
      const r = await sess.call("xc_call_api", { method: "DELETE", path: "/api/config/namespaces/default/http_loadbalancers/x" });
      expect(r.isError).toBe(true);
      expect(metrics()).toContain('xc_mcp_tool_calls_total{tool="xc_call_api",outcome="error"} 1');
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("upstream network failures and timeouts outside a tool call count under tool=none", async () => {
    const tenant = { name: "default", apiToken: TOKEN, tenantUrl: ACME };
    upstreamFail = "network";
    expect((await callApi(tenant, "GET", "/api/web/namespaces")).status).toBe(0);
    upstreamFail = "timeout";
    expect((await callApi(tenant, "post", "/api/web/namespaces")).status).toBe(408);
    const text = metrics();
    expect(text).toContain('xc_mcp_upstream_requests_total{tool="none",method="GET",status_class="network"} 1');
    expect(text).toContain('xc_mcp_upstream_requests_total{tool="none",method="POST",status_class="timeout"} 1');
    expectNoSecrets();
  });

  it("hosted bad token: invalid_credentials auth failure and a tool=none 4xx upstream request", async () => {
    whoamiStatus = 401;
    const s = await start(hostedConfig());
    try {
      const init = await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() });
      expect(init.status).toBe(401);
      const text = metrics();
      expect(text).toContain('xc_mcp_auth_failures_total{reason="invalid_credentials"} 1');
      expect(text).toContain('xc_mcp_upstream_requests_total{tool="none",method="GET",status_class="4xx"} 1');
      expect(text).toContain("\nxc_mcp_sessions_created_total 0\n");
      expectNoSecrets();
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("hosted unreachable tenant: tenant_unreachable", async () => {
    muteStderr();
    whoamiStatus = 500;
    const s = await start(hostedConfig());
    try {
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() })).status).toBe(502);
      expect(metrics()).toContain('xc_mcp_auth_failures_total{reason="tenant_unreachable"} 1');
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("hosted header failures count with the parseCredentialHeaders reason", async () => {
    const s = await start(hostedConfig());
    try {
      expect((await mcpRequest(s.port, { method: "POST", body: initBody })).status).toBe(401);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: { "x-xc-tenant-url": ACME } })).status).toBe(401);
      const text = metrics();
      expect(text).toContain('xc_mcp_auth_failures_total{reason="missing_tenant_url"} 1');
      expect(text).toContain('xc_mcp_auth_failures_total{reason="missing_token"} 1');
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("hosted session reused with other credentials: session_credential_mismatch", async () => {
    const s = await start(hostedConfig());
    try {
      const init = await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() });
      const sid = init.headers["mcp-session-id"] as string;
      const res = await mcpRequest(s.port, {
        method: "POST",
        headers: { ...creds("other-token"), "mcp-session-id": sid },
        body: { jsonrpc: "2.0", id: 99, method: "tools/list" },
      });
      expect(res.status).toBe(403);
      expect(metrics()).toContain('xc_mcp_auth_failures_total{reason="session_credential_mismatch"} 1');
      expectNoSecrets();
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("MCP_AUTH_HEADER gate failures map to auth_header_missing / auth_header_mismatch", async () => {
    const s = await start(localConfig(), { enabled: true, headerName: "x-mcp-auth", headerValue: "gate-secret" });
    try {
      expect((await mcpRequest(s.port, { method: "POST", body: initBody })).status).toBe(401);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: { "x-mcp-auth": "wrong" } })).status).toBe(401);
      const text = metrics();
      expect(text).toContain('xc_mcp_auth_failures_total{reason="auth_header_missing"} 1');
      expect(text).toContain('xc_mcp_auth_failures_total{reason="auth_header_mismatch"} 1');
      expect(text).not.toContain("gate-secret");
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("cap refusals count per_credential_cap and global_cap", async () => {
    muteStderr();
    const s = await start(hostedWith({ maxSessionsPerCredential: 1, maxSessions: 2, evictMinIdleMs: 3_600_000 }));
    try {
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() })).status).toBe(200);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() })).status).toBe(429);
      expect(metrics()).toContain('xc_mcp_session_refusals_total{reason="per_credential_cap"} 1');
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds("t2") })).status).toBe(200);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds("t3") })).status).toBe(503);
      const text = metrics();
      expect(text).toContain('xc_mcp_session_refusals_total{reason="global_cap"} 1');
      expect(text).toContain("xc_mcp_sessions_active 2");
      expectNoSecrets();
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("an initialize the transport rejects releases its slot and sessions_active returns to 0", async () => {
    const s = await start(localConfig());
    try {
      const bad = await mcpRequest(s.port, { method: "POST", body: initBody, headers: { Accept: "text/plain" } });
      expect(bad.status).toBe(406);
      const text = metrics();
      expect(text).toContain("\nxc_mcp_sessions_active 0\n");
      expect(text).toContain("\nxc_mcp_sessions_created_total 0\n");
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("refusal during shutdown counts shutting_down", async () => {
    muteStderr();
    const s = await start(localConfig());
    try {
      await s.close();
      expect((await mcpRequest(s.port, { method: "POST", body: initBody })).status).toBe(503);
      expect(metrics()).toContain('xc_mcp_session_refusals_total{reason="shutting_down"} 1');
    } finally {
      await s.stop();
    }
  });

  it("cap evictions count per_credential_cap and global_cap; sessions_active tracks the registry", async () => {
    const s = await start(hostedWith({ maxSessionsPerCredential: 1, maxSessions: 1, evictMinIdleMs: 0 }));
    try {
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() })).status).toBe(200);
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds() })).status).toBe(200);
      expect(metrics()).toContain('xc_mcp_session_evictions_total{reason="per_credential_cap"} 1');
      expect((await mcpRequest(s.port, { method: "POST", body: initBody, headers: creds("t2") })).status).toBe(200);
      const text = metrics();
      expect(text).toContain('xc_mcp_session_evictions_total{reason="global_cap"} 1');
      expect(text).toContain("xc_mcp_sessions_active 1");
      expect(text).toContain("xc_mcp_sessions_created_total 3");
    } finally {
      await s.close();
      await s.stop();
    }
  });

  it("idle sweep counts reason=idle and updates sessions_active", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let clock = 1_000_000;
    const h = createHttpHandler(localConfig(), loadIndex(indexPath), { enabled: false }, { now: () => clock });
    const srv = await startTestServer(h.handler);
    try {
      await session(srv.port);
      expect(metrics()).toContain("xc_mcp_sessions_active 1");
      clock += 31 * 60 * 1000;
      vi.advanceTimersByTime(60_000);
      const text = metrics();
      expect(text).toContain('xc_mcp_session_evictions_total{reason="idle"} 1');
      expect(text).toContain("xc_mcp_sessions_active 0");
    } finally {
      vi.useRealTimers();
      await h.close();
      await srv.stop();
    }
  });

  it("buildServerConfig parses MCP_METRICS_PORT", () => {
    const paths = { specsDir, indexPath };
    const base = { MCP_TRANSPORT: "http", MCP_MODE: "hosted" };
    expect(buildServerConfig({ ...base }, paths).metricsPort).toBeUndefined();
    expect(buildServerConfig({ ...base, MCP_METRICS_PORT: "9090" }, paths).metricsPort).toBe(9090);
    expect(buildServerConfig({ ...base, MCP_METRICS_PORT: "65535" }, paths).metricsPort).toBe(65535);
    expect(() => buildServerConfig({ ...base, MCP_METRICS_PORT: "3000" }, paths)).toThrow(/MCP_METRICS_PORT.*MCP_HTTP_PORT/);
    expect(() => buildServerConfig({ ...base, MCP_HTTP_PORT: "8080", MCP_METRICS_PORT: "8080" }, paths)).toThrow(/MCP_METRICS_PORT.*MCP_HTTP_PORT/);
    expect(buildServerConfig({ ...base, MCP_HTTP_PORT: "8080", MCP_METRICS_PORT: "3000" }, paths).metricsPort).toBe(3000);
    for (const bad of ["0", "70000", "abc", "-1", "90.5", "65536"]) {
      expect(() => buildServerConfig({ ...base, MCP_METRICS_PORT: bad }, paths), bad).toThrow(/MCP_METRICS_PORT/);
    }
  });
});

describe("small fixes (0.6.1)", () => {
  afterEach(() => vi.restoreAllMocks());

  const listPrompts = async (port: number) => {
    const init = await mcpRequest(port, { method: "POST", body: initBody });
    const h = { "mcp-session-id": init.headers["mcp-session-id"] as string, "mcp-protocol-version": "2025-03-26" };
    await mcpRequest(port, { method: "POST", headers: h, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    const r = await mcpRequest(port, { method: "POST", headers: h, body: { jsonrpc: "2.0", id: nextId++, method: "prompts/list" } });
    return (r.json as { result: { prompts: Array<{ name: string }> } }).result.prompts.map((p) => p.name);
  };

  it("deploy-https-lb prompt is hidden under MCP_READ_ONLY and present otherwise", async () => {
    const ro = await start(localConfig(true));
    try {
      const names = await listPrompts(ro.port);
      expect(names).not.toContain("deploy-https-lb");
      expect(names).toContain("audit-namespace");
    } finally {
      await ro.close();
      await ro.stop();
    }
    const rw = await start(localConfig());
    try {
      expect(await listPrompts(rw.port)).toContain("deploy-https-lb");
    } finally {
      await rw.close();
      await rw.stop();
    }
  });

  it("only the shutting_down initialize refusal drops to info; other 5xx stay error", async () => {
    const prev = process.env.MCP_LOG_LEVEL;
    process.env.MCP_LOG_LEVEL = "info";
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { lines.push(String(c)); return true; });
    const accessLevel = async (status: number) => {
      await vi.waitFor(() => {
        const found = lines.flatMap((l) => l.split("\n")).filter((l) => l.includes('"evt":"request"')).map((l) => JSON.parse(l)).find((l) => l.status === status);
        expect(found).toBeDefined();
      });
      return lines.flatMap((l) => l.split("\n")).filter((l) => l.includes('"evt":"request"')).map((l) => JSON.parse(l)).find((l) => l.status === status).level;
    };
    try {
      const s = await start(localConfig());
      try {
        await s.close();
        expect((await mcpRequest(s.port, { method: "POST", body: initBody })).status).toBe(503);
        expect(await accessLevel(503)).toBe("info");
      } finally {
        await s.stop();
      }
      lines.length = 0;
      whoamiStatus = 500;
      const h = await start(hostedConfig());
      try {
        const res = await mcpRequest(h.port, { method: "POST", body: initBody, headers: { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "tok" } });
        expect(res.status).toBe(502);
        expect(await accessLevel(502)).toBe("error");
      } finally {
        whoamiStatus = 200;
        await h.close();
        await h.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_LOG_LEVEL;
      else process.env.MCP_LOG_LEVEL = prev;
    }
  });

  it("xc_list_tenants is read-only and open-world", () => {
    expect(TOOL_POLICIES.xc_list_tenants.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });
});
