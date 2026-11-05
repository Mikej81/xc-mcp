import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { createMetricsHandler, startMetricsServer } from "../metrics-server.js";
import { METRICS_CONTENT_TYPE, resetMetrics, sessionsCreated } from "../lib/metrics.js";
import { startTestServer, mcpRequest } from "./helpers/mcp-client.js";

const closeServer = (s: Server) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });

beforeEach(() => resetMetrics());
afterEach(() => vi.restoreAllMocks());

/** Send raw bytes over a socket and resolve with everything the server writes back. */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.end(payload));
    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("close", () => resolve(Buffer.concat(chunks).toString()));
    sock.on("error", reject);
  });
}

describe("createMetricsHandler", () => {
  it("GET /metrics returns 200 with the Prometheus content type and current samples", async () => {
    sessionsCreated.inc();
    const srv = await startTestServer(createMetricsHandler());
    try {
      const res = await mcpRequest(srv.port, { method: "GET", path: "/metrics" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(METRICS_CONTENT_TYPE);
      expect(String(res.json)).toContain("xc_mcp_sessions_created_total 1");
    } finally {
      await srv.stop();
    }
  });

  it("other methods get 405, other paths 404", async () => {
    const srv = await startTestServer(createMetricsHandler());
    try {
      const post = await mcpRequest(srv.port, { method: "POST", path: "/metrics", body: {} });
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe("GET");
      expect((await mcpRequest(srv.port, { method: "GET", path: "/x" })).status).toBe(404);
      expect((await mcpRequest(srv.port, { method: "GET", path: "/mcp" })).status).toBe(404);
    } finally {
      await srv.stop();
    }
  });
});

describe("startMetricsServer", () => {
  it("serves /metrics on the given port", async () => {
    const server = await startMetricsServer(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await mcpRequest(port, { method: "GET", path: "/metrics" });
      expect(res.status).toBe(200);
      expect(String(res.json)).toContain("# TYPE xc_mcp_sessions_active gauge");
    } finally {
      await closeServer(server);
    }
  });

  it("a malformed request target cannot throw out of the listener", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    const server = await startMetricsServer(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const raw = await rawRequest(port, "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(raw).toMatch(/^HTTP\/1\.1 404 /);
      const res = await mcpRequest(port, { method: "GET", path: "/metrics" });
      expect(res.status).toBe(200);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await closeServer(server);
    }
  });

  it("a server error after listen is logged, not thrown", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const server = await startMetricsServer(0);
    try {
      expect(() => server.emit("error", new Error("boom"))).not.toThrow();
      expect(writes.some((w) => w.includes('"evt":"metrics_server_error"'))).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects with an error naming the port when it cannot listen", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(startMetricsServer(port)).rejects.toThrow(String(port));
    } finally {
      await closeServer(blocker);
    }
  });
});
