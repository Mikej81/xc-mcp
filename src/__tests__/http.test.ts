import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { createHttpHandler } from "../http.js";
import { loadIndex } from "../lib/spec-index.js";
import type { ServerConfig } from "../types/index.js";
import { MAX_REQUEST_BODY_BYTES } from "../lib/constants.js";
import { startTestServer, mcpRequest, chunkedPost } from "./helpers/mcp-client.js";

const checkForUpdateMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/version.js")>();
  checkForUpdateMock.mockImplementation(async () => ({ updateAvailable: true, current: actual.VERSION, latest: "99.0.0" }));
  return { ...actual, checkForUpdate: checkForUpdateMock };
});

const indexPath = join(__dirname, "../../data/operations-index.json");

const config: ServerConfig = {
  tenants: [{ name: "default", apiToken: "t", tenantUrl: "https://acme.console.ves.volterra.io" }],
  specsDir: join(__dirname, "../../f5-api"),
  indexPath,
  mode: "local",
};

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

describe("http handler (local mode)", () => {
  let port: number;
  let stop: () => Promise<void>;
  let closeHandler: () => Promise<void>;

  const prevLevel = process.env.MCP_LOG_LEVEL;

  beforeAll(async () => {
    process.env.MCP_LOG_LEVEL = "error"; // keep access logs out of test output
    const index = loadIndex(indexPath);
    const h = createHttpHandler(config, index, { enabled: false });
    closeHandler = h.close;
    const srv = await startTestServer(h.handler);
    port = srv.port;
    stop = srv.stop;
  });

  afterAll(async () => {
    await closeHandler();
    await stop();
    if (prevLevel === undefined) delete process.env.MCP_LOG_LEVEL;
    else process.env.MCP_LOG_LEVEL = prevLevel;
  });

  it("initialize returns 200 and mcp-session-id", async () => {
    const res = await mcpRequest(port, { method: "POST", body: initBody });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
  });

  it("tools/call xc_list_tenants on that session lists the env tenant", async () => {
    const init = await mcpRequest(port, { method: "POST", body: initBody });
    const sid = init.headers["mcp-session-id"] as string;
    const sessionHeaders = { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    await mcpRequest(port, {
      method: "POST",
      headers: sessionHeaders,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const res = await mcpRequest(port, {
      method: "POST",
      headers: sessionHeaders,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xc_list_tenants", arguments: {} } },
    });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).toContain("default");
    expect(text).toContain("acme.console.ves.volterra.io");
  });
});

/** Collect uncaught exceptions / unhandled rejections raised while `fn` runs. */
async function withProcessErrorSpy(fn: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const onErr = (e: unknown) => errors.push(e);
  process.on("uncaughtException", onErr);
  process.on("unhandledRejection", onErr);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 100)); // let socket teardown listeners run
  } finally {
    process.off("uncaughtException", onErr);
    process.off("unhandledRejection", onErr);
  }
  return errors;
}

describe("http handler request body cap", () => {
  const big = { jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES + 1024) } };

  it("cap is 256 KiB", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(256 * 1024);
  });

  it("local mode: a ~200 KiB body is accepted", async () => {
    const prev = process.env.MCP_LOG_LEVEL;
    process.env.MCP_LOG_LEVEL = "error";
    const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
    const srv = await startTestServer(h.handler);
    try {
      const res = await mcpRequest(srv.port, { method: "POST", body: { ...initBody, params: { ...initBody.params, pad: "x".repeat(200 * 1024) } } });
      expect(res.status).toBe(200);
      expect(res.headers["mcp-session-id"]).toBeTruthy();
    } finally {
      await h.close();
      await srv.stop();
      if (prev === undefined) delete process.env.MCP_LOG_LEVEL;
      else process.env.MCP_LOG_LEVEL = prev;
    }
  });

  it("local mode: oversized chunked body (no Content-Length) returns 413 without crashing; server keeps serving", async () => {
    const prev = process.env.MCP_LOG_LEVEL;
    process.env.MCP_LOG_LEVEL = "error";
    const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
    const srv = await startTestServer(h.handler);
    try {
      const errors = await withProcessErrorSpy(async () => {
        const res = await chunkedPost(srv.port, { totalBytes: MAX_REQUEST_BODY_BYTES * 4 });
        expect(res.status).toBe(413);
        expect(res.json).toEqual({ error: "payload_too_large" });
        expect(res.headers["mcp-session-id"]).toBeUndefined();
      });
      expect(errors).toEqual([]);
      const ok = await mcpRequest(srv.port, { method: "POST", body: initBody });
      expect(ok.status).toBe(200);
    } finally {
      await h.close();
      await srv.stop();
      if (prev === undefined) delete process.env.MCP_LOG_LEVEL;
      else process.env.MCP_LOG_LEVEL = prev;
    }
  });

  it("local mode: >256 KiB body returns 413 and creates no session; normal request still works", async () => {
    const prev = process.env.MCP_LOG_LEVEL;
    process.env.MCP_LOG_LEVEL = "error";
    const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
    const srv = await startTestServer(h.handler);
    try {
      const res = await mcpRequest(srv.port, { method: "POST", body: big });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(res.headers["mcp-session-id"]).toBeUndefined();
      const ok = await mcpRequest(srv.port, { method: "POST", body: initBody });
      expect(ok.status).toBe(200);
      expect(ok.headers["mcp-session-id"]).toBeTruthy();
    } finally {
      await h.close();
      await srv.stop();
      if (prev === undefined) delete process.env.MCP_LOG_LEVEL;
      else process.env.MCP_LOG_LEVEL = prev;
    }
  });
});

describe("http handler (local mode) unknown session", () => {
  it("POST, GET and DELETE with an unknown session id still return 400", async () => {
    const prev = process.env.MCP_LOG_LEVEL;
    process.env.MCP_LOG_LEVEL = "error";
    const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
    const srv = await startTestServer(h.handler);
    try {
      const headers = { "mcp-session-id": "nope" };
      const post = await mcpRequest(srv.port, {
        method: "POST",
        headers,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(post.status).toBe(400);
      expect((await mcpRequest(srv.port, { method: "GET", headers })).status).toBe(400);
      expect((await mcpRequest(srv.port, { method: "DELETE", headers })).status).toBe(400);
    } finally {
      await h.close();
      await srv.stop();
      if (prev === undefined) delete process.env.MCP_LOG_LEVEL;
      else process.env.MCP_LOG_LEVEL = prev;
    }
  });
});

describe("http handler (hosted mode)", () => {
  const ACME = "https://acme.console.ves.volterra.io";
  const BETA = "https://beta.console.ves.volterra.io";
  const credA = { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "tok-a" };
  const credB = { "x-xc-tenant-url": BETA, "x-xc-tenant-token": "tok-b" };
  const hostedConfig = (
    perCredential = 5,
    opts: { maxSessions?: number; evictMinIdleMs?: number } = {},
  ): ServerConfig => ({
    tenants: [],
    specsDir: join(__dirname, "../../f5-api"),
    indexPath,
    mode: "hosted",
    hosted: {
      allowedDomains: [".console.ves.volterra.io"],
      maxSessions: opts.maxSessions ?? 500,
      maxSessionsPerCredential: perCredential,
      evictMinIdleMs: opts.evictMinIdleMs ?? 300_000,
    },
  });

  const upstream: Array<{ origin: string; path: string; auth: string | undefined }> = [];
  const logLines: string[] = [];
  let index: ReturnType<typeof loadIndex>;
  let port: number;
  let stop: () => Promise<void>;
  let closeHandler: () => Promise<void>;
  const prevLevel = process.env.MCP_LOG_LEVEL;

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function initSession(p: number, creds: Record<string, string>) {
    const init = await mcpRequest(p, { method: "POST", body: initBody, headers: creds });
    expect(init.status).toBe(200);
    const sid = init.headers["mcp-session-id"] as string;
    expect(sid).toBeTruthy();
    await mcpRequest(p, {
      method: "POST",
      headers: sessionHeaders(sid, creds),
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    return sid;
  }

  function sessionHeaders(sid: string, creds: Record<string, string>) {
    return { ...creds, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
  }

  let nextId = 100;
  function callTool(p: number, sid: string, creds: Record<string, string>, name: string, args: unknown) {
    return mcpRequest(p, {
      method: "POST",
      headers: sessionHeaders(sid, creds),
      body: { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
    });
  }

  beforeAll(async () => {
    process.env.MCP_LOG_LEVEL = "debug";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logLines.push(String(chunk));
      return true;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const u = new URL(String(input));
      const auth = init?.headers?.Authorization;
      if (u.pathname === "/api/web/custom/namespaces/system/whoami") {
        if (auth === "APIToken tok-a" || auth === "APIToken tok-b") return jsonResponse(200, { user: "x" });
        if (auth === "APIToken tok-down") return jsonResponse(503, { error: "unavailable" });
        return jsonResponse(401, { error: "unauthorized" });
      }
      upstream.push({ origin: u.origin, path: u.pathname, auth });
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10)));
      return jsonResponse(200, { url: u.toString(), auth });
    }));
    index = loadIndex(indexPath);
    const h = createHttpHandler(hostedConfig(), index, { enabled: false });
    closeHandler = h.close;
    const srv = await startTestServer(h.handler);
    port = srv.port;
    stop = srv.stop;
  });

  afterAll(async () => {
    await closeHandler();
    await stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (prevLevel === undefined) delete process.env.MCP_LOG_LEVEL;
    else process.env.MCP_LOG_LEVEL = prevLevel;
  });

  it("rejects requests without credential headers", async () => {
    const res = await mcpRequest(port, { method: "POST", body: initBody });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized", reason: "missing_tenant_url" });
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("rejects GET and DELETE without credential headers with 401 missing_tenant_url", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await mcpRequest(port, { method, headers: { "mcp-session-id": "whatever" } });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized", reason: "missing_tenant_url" });
    }
  });

  it("rejects an oversized body with 413 and creates no session", async () => {
    const res = await mcpRequest(port, {
      method: "POST",
      headers: credA,
      body: { ...initBody, params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES + 1024) } },
    });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "payload_too_large" });
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("rejects an unknown or mismatched session before reading the body", async () => {
    const pad = { jsonrpc: "2.0", id: 2, method: "tools/list", params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES + 1024) } };
    const unknown = await mcpRequest(port, { method: "POST", headers: { ...credA, "mcp-session-id": "nope" }, body: pad });
    expect(unknown.status).toBe(404);
    const sid = await initSession(port, credA);
    const mismatch = await mcpRequest(port, {
      method: "POST",
      headers: sessionHeaders(sid, { ...credA, "x-xc-tenant-token": "tok-b" }),
      body: pad,
    });
    expect(mismatch.status).toBe(403);
  });

  it("rejects a tenant URL outside the allowlist", async () => {
    const res = await mcpRequest(port, {
      method: "POST",
      body: initBody,
      headers: { "x-xc-tenant-url": "https://evil.com", "x-xc-tenant-token": "tok-a" },
    });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized", reason: "url_not_allowed" });
  });

  it("initialize with a bad token returns 401 and creates no session", async () => {
    const before = upstream.length;
    const res = await mcpRequest(port, {
      method: "POST",
      body: initBody,
      headers: { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "tok-bad" },
    });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "invalid_credentials" });
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(upstream.length).toBe(before);
  });

  it("initialize when the tenant is unreachable returns 502 and creates no session", async () => {
    const res = await mcpRequest(port, {
      method: "POST",
      body: initBody,
      headers: { "x-xc-tenant-url": ACME, "x-xc-tenant-token": "tok-down" },
    });
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: "tenant_unreachable" });
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("unknown session id returns 404 for POST, GET and DELETE", async () => {
    const headers = { ...credA, "mcp-session-id": "does-not-exist" };
    const post = await mcpRequest(port, {
      method: "POST",
      headers,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(post.status).toBe(404);
    expect(post.json).toEqual({ error: "session_not_found" });
    const get = await mcpRequest(port, { method: "GET", headers });
    expect(get.status).toBe(404);
    expect(get.json).toEqual({ error: "session_not_found" });
    const del = await mcpRequest(port, { method: "DELETE", headers });
    expect(del.status).toBe(404);
    expect(del.json).toEqual({ error: "session_not_found" });
  });

  it("a session bound to A rejects B's credentials with 403 on POST, GET and DELETE", async () => {
    const sid = await initSession(port, credA);
    const wrong = sessionHeaders(sid, { ...credA, "x-xc-tenant-token": "tok-b" });
    const before = upstream.length;

    const post = await mcpRequest(port, {
      method: "POST",
      headers: wrong,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xc_call_api", arguments: { method: "GET", path: "/api/web/namespaces" } } },
    });
    expect(post.status).toBe(403);
    expect(post.json).toEqual({ error: "session_credential_mismatch" });
    const get = await mcpRequest(port, { method: "GET", headers: wrong });
    expect(get.status).toBe(403);
    expect(get.json).toEqual({ error: "session_credential_mismatch" });
    const del = await mcpRequest(port, { method: "DELETE", headers: wrong });
    expect(del.status).toBe(403);
    expect(del.json).toEqual({ error: "session_credential_mismatch" });
    expect(upstream.length).toBe(before);

    // Session survives the rejected DELETE and still works with A's credentials.
    const ok = await callTool(port, sid, credA, "xc_list_tenants", {});
    expect(ok.status).toBe(200);
  });

  it("isolates concurrent sessions: every upstream call uses only its own tenant and token", async () => {
    const sidA = await initSession(port, credA);
    const sidB = await initSession(port, credB);
    upstream.length = 0;

    const calls: Array<Promise<{ who: "a" | "b"; res: Awaited<ReturnType<typeof mcpRequest>> }>> = [];
    for (let i = 0; i < 10; i++) {
      calls.push(
        callTool(port, sidA, credA, "xc_call_api", { method: "GET", path: `/api/web/namespaces/a-${i}` }).then((res) => ({ who: "a" as const, res })),
      );
      calls.push(
        callTool(port, sidB, credB, "xc_call_api", { method: "GET", path: `/api/web/namespaces/b-${i}` }).then((res) => ({ who: "b" as const, res })),
      );
    }
    const results = await Promise.all(calls);

    for (const { who, res } of results) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.json);
      if (who === "a") {
        expect(text).toContain("acme.console.ves.volterra.io");
        expect(text).not.toContain("beta.console");
        expect(text).not.toContain("tok-b");
      } else {
        expect(text).toContain("beta.console.ves.volterra.io");
        expect(text).not.toContain("acme.console");
        expect(text).not.toContain("tok-a");
      }
    }

    const a = upstream.filter((u) => u.path.includes("/a-"));
    const b = upstream.filter((u) => u.path.includes("/b-"));
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    for (const u of a) {
      expect(u.origin).toBe(ACME);
      expect(u.auth).toBe("APIToken tok-a");
    }
    for (const u of b) {
      expect(u.origin).toBe(BETA);
      expect(u.auth).toBe("APIToken tok-b");
    }
  });

  it("ignores the tenant parameter and lists only the caller's tenant", async () => {
    const sid = await initSession(port, credA);
    upstream.length = 0;
    const res = await callTool(port, sid, credA, "xc_call_api", {
      method: "GET",
      path: "/api/web/namespaces",
      tenant: "other",
    });
    expect(res.status).toBe(200);
    expect(upstream).toEqual([{ origin: ACME, path: "/api/web/namespaces", auth: "APIToken tok-a" }]);

    checkForUpdateMock.mockClear();
    const list = await callTool(port, sid, credA, "xc_list_tenants", {});
    const text = JSON.stringify(list.json);
    expect(text).toContain("acme.console.ves.volterra.io");
    expect(text).toContain("1 tenant(s)");
    expect(text).not.toContain("docker pull");
    expect(text).not.toContain("git pull");
    expect(text).not.toContain("Update available");
    expect(checkForUpdateMock).not.toHaveBeenCalled();
    expect(text).not.toContain("beta");
    expect(text).not.toContain("tok-a");
  });

  it("runs the MCP_AUTH_HEADER gate before credential headers when enabled", async () => {
    const h = createHttpHandler(hostedConfig(), index, { enabled: true, headerName: "x-gate", headerValue: "g1" });
    const srv = await startTestServer(h.handler);
    try {
      const denied = await mcpRequest(srv.port, { method: "POST", body: initBody, headers: credA });
      expect(denied.status).toBe(401);
      expect(denied.json).toEqual({ error: "unauthorized" });
      const ok = await mcpRequest(srv.port, { method: "POST", body: initBody, headers: { ...credA, "x-gate": "g1" } });
      expect(ok.status).toBe(200);
    } finally {
      await h.close();
      await srv.stop();
    }
  });

  it("oversized chunked body (no Content-Length) returns 413 without crashing; server keeps serving", async () => {
    const errors = await withProcessErrorSpy(async () => {
      const res = await chunkedPost(port, { totalBytes: MAX_REQUEST_BODY_BYTES * 4, headers: credA });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    });
    expect(errors).toEqual([]);
    expect(logLines.some((l) => l.includes('"evt":"request"') && l.includes('"status":413') && l.includes('"peer_ip":"127.0.0.1"'))).toBe(true);
    await initSession(port, credA);
  });

  it("per-credential cap refuses with 429 while sessions are active, evicts once the LRU is idle", async () => {
    let t = 1_000_000;
    const h = createHttpHandler(hostedConfig(2, { evictMinIdleMs: 5000 }), index, { enabled: false }, { now: () => t });
    const srv = await startTestServer(h.handler);
    try {
      const first = await initSession(srv.port, credA);
      const second = await initSession(srv.port, credA);
      t += 1200;
      const refused = await mcpRequest(srv.port, { method: "POST", body: initBody, headers: credA });
      expect(refused.status).toBe(429);
      expect(refused.json).toEqual({ error: "too_many_sessions" });
      expect(refused.headers["retry-after"]).toBe("4"); // ceil((5000 - 1200) / 1000)
      expect(refused.headers["mcp-session-id"]).toBeUndefined();
      expect(logLines.some((l) => l.includes('"evt":"session_refused"') && l.includes('"reason":"per_credential_cap"'))).toBe(true);
      // Both sessions survived the refusal.
      expect((await callTool(srv.port, first, credA, "xc_list_tenants", {})).status).toBe(200);

      // Keep `first` active; let `second` go idle past the threshold.
      t += 5000;
      expect((await callTool(srv.port, first, credA, "xc_list_tenants", {})).status).toBe(200);
      const third = await initSession(srv.port, credA);
      const gone = await callTool(srv.port, second, credA, "xc_list_tenants", {});
      expect(gone.status).toBe(404);
      expect(gone.json).toEqual({ error: "session_not_found" });
      expect((await callTool(srv.port, first, credA, "xc_list_tenants", {})).status).toBe(200);
      expect((await callTool(srv.port, third, credA, "xc_list_tenants", {})).status).toBe(200);
      const evicted = logLines.filter((l) => l.includes('"evt":"session_evicted"'));
      expect(evicted.some((l) => l.includes(`"session_id":"${second.slice(0, 8)}"`) && l.includes('"reason":"per_credential_cap"'))).toBe(true);
    } finally {
      await h.close();
      await srv.stop();
    }
  });

  it("an initialize the transport rejects does not hold a session slot", async () => {
    const h = createHttpHandler(hostedConfig(1), index, { enabled: false }, { now: () => 1_000_000 });
    const srv = await startTestServer(h.handler);
    try {
      const bad = await mcpRequest(srv.port, { method: "POST", body: initBody, headers: { ...credA, Accept: "text/plain" } });
      expect(bad.status).toBe(406);
      await initSession(srv.port, credA);
    } finally {
      await h.close();
      await srv.stop();
    }
  });

  it("global cap refuses with 503 server_busy while every session is active", async () => {
    const t = 1_000_000;
    const h = createHttpHandler(hostedConfig(5, { maxSessions: 2, evictMinIdleMs: 300_000 }), index, { enabled: false }, { now: () => t });
    const srv = await startTestServer(h.handler);
    try {
      await initSession(srv.port, credA);
      const b = await initSession(srv.port, credB);
      const refused = await mcpRequest(srv.port, { method: "POST", body: initBody, headers: credA });
      expect(refused.status).toBe(503);
      expect(refused.json).toEqual({ error: "server_busy" });
      expect(refused.headers["retry-after"]).toBe("300");
      expect(refused.headers["mcp-session-id"]).toBeUndefined();
      expect(logLines.some((l) => l.includes('"evt":"session_refused"') && l.includes('"reason":"global_cap"'))).toBe(true);
      expect((await callTool(srv.port, b, credB, "xc_list_tenants", {})).status).toBe(200);
    } finally {
      await h.close();
      await srv.stop();
    }
  });

  it("never logs tokens or request bodies, and logs tenant_host and auth failure reasons", () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain("tok-a");
      expect(line).not.toContain("tok-b");
      expect(line).not.toContain("tok-bad");
      expect(line).not.toContain("tok-down");
      expect(line).not.toContain("request_body");
    }
    expect(logLines.some((l) => l.includes('"evt":"request"') && l.includes('"tenant_host":"acme.console.ves.volterra.io"'))).toBe(true);
    expect(logLines.some((l) => l.includes('"evt":"auth_failed"') && l.includes('"reason":"missing_tenant_url"') && l.includes('"peer_ip"'))).toBe(true);
    expect(logLines.some((l) => l.includes('"evt":"auth_failed"') && l.includes('"reason":"session_credential_mismatch"'))).toBe(true);
  });
});
