# Roadmap

Follow-up work after 0.6.0 (hosted mode). Check items off as they ship and note the release.

## 0.6.1 candidates

- [x] **Clear message for expired tokens.** XC API tokens expire. When a tool call gets 401 from XC mid-session, return a message telling the user to update `X-XC-Tenant-Token` (hosted) or `XC_API_TOKEN` (local) and reconnect, instead of the raw upstream error. Applies to every tool, so it belongs in one place (likely `callApi` error classification plus the tool result formatter). (0.6.1)
- [x] **Prometheus metrics.** A `/metrics` endpoint with active sessions (global and per mode), session refusals by reason (429 `too_many_sessions`, 503 `server_busy`), evictions by reason, `whoami` failures by upstream status, and XC upstream latency and error counts by tool. Needed to size `MCP_HOSTED_MAX_SESSIONS` and the per-credential cap from real traffic. Keep tenant hostnames out of label values unless the operator opts in, to bound cardinality. (0.6.1)
- [x] **Audit log for changes.** One structured log line per POST, PUT, PATCH, or DELETE sent to XC: tenant host, namespace, resource type and name, HTTP method, upstream status, session id prefix. Open question: whether to include a short credential identifier (for example the first 8 hex characters of the fingerprint) so an operator can tell users apart. That is a privacy trade-off and needs a decision before building. (0.6.1)
- [x] **Kubernetes example.** `deploy/k8s/` with a Deployment, Service, and Ingress for hosted mode: liveness probe on `/healthz`, readiness on `/readyz`, resource requests and limits, `terminationGracePeriodSeconds` longer than the server's shutdown timeout, `MCP_SHUTDOWN_DRAIN_SECONDS` set a little longer than the readiness probe period so the load balancer drains before shutdown, and the hosted env vars. Single replica, or sticky sessions on `Mcp-Session-Id` if scaled out. CI already publishes images to GHCR on version tags. (0.6.1)

## 0.7 candidates

- [ ] **OAuth (MCP authorization).** Lets claude.ai and ChatGPT web connectors use the hosted instance, and removes plaintext XC tokens from client config files such as Antigravity's `mcp_config.json`. Needs a design for mapping an OAuth identity to an XC tenant and token.
- [ ] **Structured tool output.** Declare `outputSchema` and return `structuredContent` for tools with stable result shapes (list tools, `xc_dns_zone_status`, `xc_query_lb_metrics`) so clients can use results without parsing text. Keep the text content for clients that ignore structured output.
- [ ] **Tool-selection evals.** A small set of real tasks (for example "create an HTTPS LB for app.example.com") run against a model, checking that it picks the expected tools and arguments. Protects the deliberately terse tool descriptions from regressions when they are edited.

## Small fixes

- [x] Hide or reword the `deploy-https-lb` prompt when `MCP_READ_ONLY=true`. It currently leads the model into tools that are hidden. (0.6.1)
- [x] Log an `initialize` refused during shutdown (503 `shutting_down`) at `info` instead of `error`; it is expected during a rollout. (0.6.1)
- [x] `xc_list_tenants` is annotated `openWorldHint: false`, but in local mode it calls GitHub for the update check. Decide whether that counts and annotate to match. (0.6.1)
- [ ] `xc_call_api` PEM auto-encrypt: a 401 from the blindfold key fetch throws out of `handleCallApi`, so the expired-token hint is not appended. Catch it and return an `isError` result so the registrar can add the hint.
- [ ] Blindfold network and timeout failures now read "0 Network Error" / "408 Request Timeout"; append the underlying error text for TLS and P12 diagnostics.
- [ ] README audit field table: add the `action` field (`cascade_delete`).
- [ ] `xc_diff_resource`: the server fills in defaults on GET (`metadata.labels: {}`, `spec.advanced_options.default_circuit_breaker: {}`, `snat_pool: null`, ...). A hand-written body that leaves them out gets one `remove` per default. Option: treat a key missing from the proposed body whose live value is `{}`, `[]` or `null` as unchanged, with `strict: true` to turn that off.
- [ ] Access-log pagination: a live query with `limit: 1` returned one entry, `total_hits: "410"` and an empty `scroll_id`. `xc_query_lb_metrics` sends no `limit`, and both tools stop when `scroll_id` is empty, so counts may cover only the first page. Check how XC pages results (default limit, when it returns `scroll_id`) and report `total_hits` or a truncation flag.
