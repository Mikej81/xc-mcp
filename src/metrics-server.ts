import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { METRICS_CONTENT_TYPE, renderMetrics } from "./lib/metrics.js";
import { log } from "./lib/logger.js";

export const METRICS_PATH = "/metrics";

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain", ...headers });
  res.end(text);
}

/**
 * GET /metrics only. No auth: the port must never be routed publicly.
 * Never throws out of the listener: any request target, however malformed, gets a response.
 */
export function createMetricsHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    try {
      // No URL parsing: a raw target like "//[" would make `new URL` throw.
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname !== METRICS_PATH) {
        sendText(res, 404, "Not found\n");
        return;
      }
      if (req.method !== "GET") {
        sendText(res, 405, "Method not allowed\n", { Allow: "GET" });
        return;
      }
      res.writeHead(200, { "Content-Type": METRICS_CONTENT_TYPE });
      res.end(renderMetrics());
    } catch (err) {
      log("error", "metrics_request_failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendText(res, 500, "Internal error\n");
      else res.destroy();
    }
  };
}

/** Listen on all interfaces. Rejects (naming the port) when the port cannot be bound. */
export function startMetricsServer(port: number): Promise<Server> {
  const server = createServer(createMetricsHandler());
  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => {
      reject(new Error(`Metrics server failed to listen on port ${port}: ${err.message}`));
    };
    server.once("error", onListenError);
    server.listen(port, () => {
      server.off("error", onListenError);
      // Later errors are logged; an unhandled 'error' event would crash the process.
      server.on("error", (err) => {
        log("error", "metrics_server_error", { error: err.message });
      });
      resolve(server);
    });
  });
}
