# Roadmap

Follow-up work after 0.6.0 (hosted mode). Check items off as they ship and note the release.

## 0.6.1 candidates

- [ ] **Clear message for expired tokens.** XC API tokens expire. When a tool call gets 401 from XC mid-session, return a message telling the user to update `X-XC-Tenant-Token` (hosted) or `XC_API_TOKEN` (local) and reconnect, instead of the raw upstream error. Applies to every tool, so it belongs in one place (likely `callApi` error classification plus the tool result formatter).
- [ ] **Prometheus metrics.** A `/metrics` endpoint with active sessions (global and per mode), session refusals by reason (429 `too_many_sessions`, 503 `server_busy`), evictions by reason, `whoami` failures by upstream status, and XC upstream latency and error counts by tool. Needed to size `MCP_HOSTED_MAX_SESSIONS` and the per-credential cap from real traffic. Keep tenant hostnames out of label values unless the operator opts in, to bound cardinality.
- [ ] **Audit log for changes.** One structured log line per POST, PUT, PATCH, or DELETE sent to XC: tenant host, namespace, resource type and name, HTTP method, upstream status, session id prefix. Open question: whether to include a short credential identifier (for example the first 8 hex characters of the fingerprint) so an operator can tell users apart. That is a privacy trade-off and needs a decision before building.
- [ ] **Kubernetes example.** `example/k8s/` with a Deployment, Service, and Ingress for hosted mode: liveness probe on `/healthz`, readiness on `/readyz`, resource requests and limits, `terminationGracePeriodSeconds` longer than the server's shutdown timeout, `MCP_SHUTDOWN_DRAIN_SECONDS` set a little longer than the readiness probe period so the load balancer drains before shutdown, and the hosted env vars. Single replica, or sticky sessions on `Mcp-Session-Id` if scaled out. CI already publishes images to GHCR on version tags.

## 0.7 candidates

- [ ] **OAuth (MCP authorization).** Lets claude.ai and ChatGPT web connectors use the hosted instance, and removes plaintext XC tokens from client config files such as Antigravity's `mcp_config.json`. Needs a design for mapping an OAuth identity to an XC tenant and token.
- [ ] **Structured tool output.** Declare `outputSchema` and return `structuredContent` for tools with stable result shapes (list tools, `xc_dns_zone_status`, `xc_query_lb_metrics`) so clients can use results without parsing text. Keep the text content for clients that ignore structured output.
- [ ] **Tool-selection evals.** A small set of real tasks (for example "create an HTTPS LB for app.example.com") run against a model, checking that it picks the expected tools and arguments. Protects the deliberately terse tool descriptions from regressions when they are edited.

## Small fixes

- [ ] Hide or reword the `deploy-https-lb` prompt when `MCP_READ_ONLY=true`. It currently leads the model into tools that are hidden.
- [ ] Log an `initialize` refused during shutdown (503 `shutting_down`) at `info` instead of `error`; it is expected during a rollout.
- [ ] `xc_list_tenants` is annotated `openWorldHint: false`, but in local mode it calls GitHub for the update check. Decide whether that counts and annotate to match.
