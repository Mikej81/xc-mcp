import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { createHttpHandler, createShutdown } from "../http.js";
import { loadIndex } from "../lib/spec-index.js";
import { buildServerConfig } from "../index.js";
import { TOOL_POLICIES, isReadOnlyHeader } from "../lib/tool-policy.js";
import type { ServerConfig } from "../types/index.js";
import { startTestServer, mcpRequest } from "./helpers/mcp-client.js";

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

beforeAll(() => {
  process.env.MCP_LOG_LEVEL = "error";
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string }) => {
    const u = new URL(String(input));
    if (u.pathname !== "/api/web/custom/namespaces/system/whoami") upstream.push({ method: init?.method ?? "GET", path: u.pathname });
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
