/**
 * Docker HEALTHCHECK entry point.
 * HTTP transport: GET /healthz on the local port and exit 0 only on a 200.
 * stdio transport: there is no port to probe, so report healthy while the process runs.
 */
const transport = (process.env.MCP_TRANSPORT ?? "").toLowerCase();
if (transport !== "http") process.exit(0);

const port = process.env.MCP_HTTP_PORT || "3000";
const controller = new AbortController();
setTimeout(() => controller.abort(), 2000).unref();

fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
  .then((res) => process.exit(res.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));
