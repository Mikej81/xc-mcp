import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Start an ephemeral HTTP server that delegates to the given handler. */
export async function startTestServer(
  handler: Handler,
): Promise<{ port: number; stop(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Send an MCP request to /mcp using node:http (global fetch is stubbed by other tests).
 * Parses JSON or SSE `data:` responses into `json`.
 */
export function mcpRequest(
  port: number,
  opts: { method: "POST" | "GET" | "DELETE"; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: opts.method,
        headers: {
          Accept: "application/json, text/event-stream",
          ...(payload !== undefined
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = undefined;
          if ((res.headers["content-type"] || "").includes("text/event-stream")) {
            const datas = text
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .filter(Boolean);
            const last = datas[datas.length - 1];
            if (last) json = JSON.parse(last);
          } else if (text) {
            try { json = JSON.parse(text); } catch { json = text; }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * POST `totalBytes` of filler to /mcp with Transfer-Encoding: chunked (no Content-Length).
 * Resolves with the response; write errors after the response arrives (the server
 * closing the socket on a 413) are ignored.
 */
export function chunkedPost(
  port: number,
  opts: { totalBytes: number; headers?: Record<string, string> },
): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown }> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
          ...opts.headers,
        },
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = text;
          try { json = JSON.parse(text); } catch { /* keep text */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
        res.on("error", () => {});
      },
    );
    req.on("error", (err) => {
      if (!responded) reject(err);
    });
    const chunk = Buffer.alloc(64 * 1024, "x");
    let sent = 0;
    const write = () => {
      while (sent < opts.totalBytes) {
        if (responded || req.destroyed) return;
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", write);
          return;
        }
      }
      req.end();
    };
    write();
  });
}
