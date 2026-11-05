# Changelog

## 0.6.0 -- 2026-11-05

### Hosted mode and two security fixes

Adds a hosted deployment mode where one server serves many users, each with their own tenant credentials. Also closes two path-handling holes. No breaking changes for local mode.

- **Hosted mode (#2)** -- set `MCP_MODE=hosted` with `MCP_TRANSPORT=http`. The server holds no tenant credentials. Each request carries `X-XC-Tenant-Url`, `X-XC-Tenant-Token`, and an optional `X-XC-Tenant-Namespace`. Tools resolve the tenant from those headers, so the `tenant` parameter is ignored and `xc_list_tenants` shows only the caller's tenant, without update hints. Startup fails if `MCP_TRANSPORT` is not `http` or any XC tenant env var is set.
- **Tenant URL allowlist** -- the tenant URL must be a bare HTTPS origin under an allowed domain. `XC_HOSTED_ALLOWED_DOMAINS` sets the list (default `.console.ves.volterra.io`). FedRAMP tenants need their own domain added.
- **Credential check on initialize** -- the server calls `whoami` on the tenant (10 second timeout) before creating a session. A rejected token returns 401 `invalid_credentials`. An unreachable tenant returns 502 `tenant_unreachable`. Neither creates a session.
- **Session binding** -- each session is bound to a SHA-256 fingerprint of the tenant URL and token. A request on that session with different credentials gets 403 `session_credential_mismatch`. Raw tokens are never stored.
- **Session caps** -- `MCP_HOSTED_MAX_SESSIONS` (default 500) and `MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL` (default 5). At a cap, the server evicts the least recently active session in that scope only if it has been idle for `MCP_HOSTED_EVICT_MIN_IDLE_SECONDS` (default 300). Otherwise it evicts nothing and refuses the new session: 429 `too_many_sessions` at the per-credential cap, 503 `server_busy` at the global cap, both with `Retry-After`.
- **Request body cap** -- HTTP request bodies over 256 KiB get 413 `payload_too_large`, in local and hosted mode. The server stops reading at the limit, including for chunked bodies with no `Content-Length`. In hosted mode, a request that names an unknown or mismatched session is rejected before its body is read.
- **No redirects upstream** -- calls to the XC API no longer follow redirects. A 3xx comes back as a non-OK response, and the credential check treats it as `tenant_unreachable`.
- **Startup validation** -- an unrecognized `MCP_MODE` value now refuses to start. `XC_HOSTED_ALLOWED_DOMAINS` must hold at least one suffix, each with two or more labels and only letters, digits, dots and hyphens.
- **Logging** -- hosted access logs include the tenant hostname. Debug request-body logging is suppressed in hosted mode because tool arguments can contain secrets.
- **Security fix: `xc_call_api` origin pinning** -- `callApi` now rejects any path that resolves to a different origin than the tenant URL, such as an absolute URL, with a 400 `validation_error`. This applies in local mode too.
- **Security fix: `xc_resolve_schema_ref` path traversal** -- `spec_file` is resolved against the specs directory and rejected if it escapes it. Read failures no longer echo the underlying error message.
- **Refactor** -- tool registration moved to `src/server.ts` and the HTTP handler to `src/http.ts`. New libraries: `hosted.ts`, `credential-check.ts`, `session-registry.ts`.
- **Fix: update check** -- the startup and `xc_list_tenants` update notice compared versions for inequality, so any build newer than the latest release reported the older release as an update. It now compares semver and only reports a newer release.
- **Unit tests** -- 429 tests across 37 test files (up from 317/32).
- No removed tools. No changes to local-mode env vars or behavior beyond the fixes above. Drop-in upgrade from 0.5.0.

## 0.5.0 -- 2026-05-27

### New tools, ergonomics, and error classification

Adds six new MCP tools, three ergonomics improvements, and an error-classification layer for upstream failures. No breaking changes.

- **New `xc_search_resources` tool** -- finds resources by name across multiple namespaces in one call. Substring or glob name matching, optional label selector, optional namespace allow-list, and an auto-discovery fallback that lists every namespace visible to the tenant.
- **New `xc_dns_zone_status` tool** -- diagnostic roll-up for a DNS zone: deployment_status, assigned nameservers, the Operational condition, and an optional `local_zone_file` data-plane probe. Explicitly flags `control_plane_active_but_data_plane_unreachable` when those two disagree.
- **New `xc_lb_set_request_headers` tool** -- convenience wrapper that adds/removes entries in an HTTP LB's `spec.add_request_headers` via a single GET/strip/PUT cycle. Replaces (does not duplicate) entries whose names match case-insensitively. Preserves `resource_version` optimistic concurrency by default.
- **New `xc_pool_attach_healthcheck` / `xc_pool_detach_healthcheck` tools** -- attach or detach a named healthcheck from an origin_pool's `spec.healthcheck` list. Attach is idempotent. Detach removes by name.
- **New `xc_resolve_schema_ref` tool** -- expands a JSON Schema `$ref` from a named OpenAPI spec file. Useful when `xc_get_operation_details` truncated a deeply nested type and a caller needs just that component without re-traversing the whole operation. Configurable depth cap, default 8.
- **New `xc_query_lb_metrics` tool** -- per-LB time-bucketed request counts and response-code-class breakdown, derived from access logs (XC does not expose a dedicated HTTP LB metrics endpoint in the bundled specs). Buckets: `1m` / `5m` / `15m` / `1h`. Auto-paginates over `scroll_id` up to 10 pages.
- **`XC_DEFAULT_TENANT` env var** -- mirrors `XC_DEFAULT_NAMESPACE` for multi-tenant deployments. When multiple tenants are configured and the caller omits `tenant`, falls back to the named default (case-insensitive). An unknown name surfaces a specific error referencing the env var rather than the generic "Multiple tenants configured" message.
- **Pretty-print large outputs** -- `xc_call_api` now pretty-prints (2-space indent) responses that exceed the 60KB tool-output cap, so client-side spills to disk have normal line breaks. Small responses stay compact for token efficiency.
- **Optional `verify` flag on `xc_list_resources`** -- when set, the tool issues a GET against every returned name and filters out any that 404, defending against list/get cache-coherence drift. The response header reports both the listed count and the verified count.
- **Error classification** -- `ApiResponse` now carries an optional `error_category` field populated by a pure classifier in `src/lib/error-classifier.ts`. Categories: `auth_failure`, `permission_denied`, `not_found`, `timeout`, `config_conflict`, `rate_limited`, `validation_error`, `backend_unavailable`, `server_error`. 503 responses and 5xx bodies containing gRPC dial strings are bucketed as `backend_unavailable` so callers can branch on the field instead of regexing the body. Network errors and request timeouts on the client side also surface the category.
- **Tool count** -- 18 (up from 11).
- **Unit tests** -- 317 tests across 32 test files (up from 263/25).
- No protocol or schema changes beyond the new tool registrations. No removed tools. No breaking changes. Drop-in upgrade from 0.4.3.

## 0.4.3 -- 2026-05-27

### Bug fixes for generic API tool, response filtering, and DNS listing

Three confirmed bugs that surfaced while configuring resources through the generic `xc_call_api` escape hatch, filtering large response bodies, and listing DNS zones on the system namespace.

- **`xc_call_api` request body double-encoding** -- `callApi` in `src/lib/api-client.ts` ran every request body through `JSON.stringify`, including bodies that arrived already-encoded as a JSON string. The wire body was then a quoted, escaped JSON string rather than a JSON object, and XC rejected the request with `json: cannot unmarshal string into Go value of type map[string]json.RawMessage`. Strings that parse as a non-null JSON object or array are now forwarded verbatim. Strings that parse as JSON primitives (`"42"`, `"true"`, `"null"`) and strings that do not parse as JSON are still `JSON.stringify`-encoded, preserving the existing behavior for literal string-valued bodies.
- **`response_filter` applied after the 50KB body cap** -- README claimed projection ran before truncation; the implementation ran it after. `handleCallApi` now passes `skipTruncation: true` to `callApi` whenever a `response_filter` is supplied, so the filter sees the full parsed body. The 60KB tool-output cap at the end of `handleCallApi` remains the final guard. An empty-string filter (`""`) is treated identically to no filter, matching the prior short-circuit in `filterResponse`.
- **`xc_list_resources` 404 on DNS resource types** -- DNS resources live under `/api/config/dns/namespaces/...`, but the list tool unconditionally built `/api/config/namespaces/...` and got back `"API Group could not be determined"`. A file-local `DNS_API_GROUP_RESOURCES` set + `buildListPath` helper now route `dns_zones`, `dns_load_balancers`, `dns_lb_pools`, and `dns_lb_health_checks` to the DNS API group. The trailing "Example path" hint is derived from the same path the request used, so it cannot drift from the actual routing. The `xc_list_resources` tool description documents the routing explicitly.
- **Unit tests** -- 263 tests across 25 test files (up from 250/25). New coverage: object/JSON-string/JSON-primitive/non-JSON-string body serialization, response_filter pre-truncation behavior with a 60KB payload, empty-string filter handling, DNS list routing for all four known types, and footer-path correctness for both DNS and non-DNS responses.
- No protocol or schema changes. No new env vars. Drop-in upgrade from 0.4.2.

## 0.4.2 -- 2026-05-15

### Tool description steering for gateway use

When MCP tools are exposed to an LLM through a gateway like Bifrost, the model chooses which tool to call from the descriptions alone. The 0.4.1 descriptions said "for common operations you can call xc_call_api directly," which actively biased LLMs away from the specific listing tools (xc_list_namespaces, xc_list_resources, etc.) and toward the generic xc_call_api escape hatch. That mattered in deployments where xc_call_api was kept in a "manual approval" tool-execution policy while the specific tools were auto-executable -- the agent loop never closed.

- **`xc_call_api`** description rewritten to position it as a last-resort escape hatch. Lists the specific tools to prefer first (xc_list_namespaces, xc_list_resources, xc_list_tenants, xc_query_access_logs, xc_lb_wait_ready, xc_diff_resource, xc_patch_resource, xc_create_cert). Also clarifies that listing namespaces themselves is /api/web/namespaces (not /api/config/namespaces), since gpt-class models were guessing the wrong path from the resource pattern.
- **`xc_discover_apis`** description updated to recommend specific list tools first; removed xc_call_api from the "call directly" hint.
- No protocol or schema changes. No new env vars. Drop-in upgrade.

## 0.4.1 -- 2026-05-15

### MCP Tasks RFC compatibility shim

Fixes tool discovery failures for MCP clients that do not yet understand the Tasks RFC (Bifrost, some OpenWebUI builds). MCP SDK ≥1.24 injects `execution: { taskSupport: "forbidden" }` on every registered tool to mark it as a sync-only tool. Older clients misread that unknown field as "uncallable" and never invoke the tool, even though the connection, `initialize`, and `tools/list` all succeed.

- **Capability-aware shim** in `src/lib/tasks-rfc-compat.ts` wraps the SDK's `tools/list` handler. If the client advertised `capabilities.tasks` during `initialize`, the response is passed through untouched. Otherwise the `execution` field is stripped from each tool descriptor on the wire. Server-side call routing is unaffected -- the SDK validates `taskSupport` against the registered tool, not the wire response.
- **Wired in** `src/index.ts` immediately after `registerTools()` / `registerResources()` / `registerPrompts()`.
- **Unit tests** -- new `tasks-rfc-compat.test.ts` covers the strip helper edge cases plus an integration test that exercises both the with-tasks-capability and without-tasks-capability paths against a real `McpServer` instance.

## 0.4.0 -- 2026-05-12

### P12 mTLS as optional auth

Adds P12 certificate-based mTLS authentication as an alternative to the API token for the F5 XC tenant connection. Useful for environments where short-lived API tokens are not available or where mTLS is required by policy.

## 0.3.0 -- 2026-05-05

### HTTP header auth and structured access logging

Hardens the HTTP transport for public deployment behind an F5 XC LB. Adds an opt-in shared-secret header gate and emits one structured JSON log line per request so operators can diagnose 4xx responses from logs alone. Stdio transport is unchanged.

- **HTTP header auth gate** -- set `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE` to require a matching header on every `/mcp` request. Mismatches return `401` before request body parsing. Comparison uses `node:crypto` `timingSafeEqual` to avoid timing leaks. When neither env var is set, the server behaves exactly as before.
- **Structured access logs** -- one JSON line per `/mcp` request with method, status, latency, session id, and (for `tools/call`) the invoked tool name. Replaces the previous near-silent default, so 400s are now grep-able.
- **Session lifecycle events** -- `session.created`, `session.expired`, and `session.closed` now emit structured log entries, making it easier to correlate "session expired" with the next request's failure.
- **Configurable log level** -- `MCP_LOG_LEVEL` (default `info`) controls the structured logger. Levels: `debug`, `info`, `warn`, `error`.
- **Documentation** -- README documents the three new env vars and makes the `/mcp` endpoint path explicit.
- **Unit tests** -- new `auth.test.ts` and `logger.test.ts` cover env parsing, constant-time check, case-insensitive header lookup, level filtering, and JSON-shape edge cases.

## 0.2.0 -- 2026-04-30

### Patch, diff, wait, and access log tools

Adds four tools driven by real pain points hit while running an XC and BIG-IP coexistence test harness. Focus is on multi-step state mutations and access log observability that were previously verbose to build out of the generic `xc_call_api` tool.

- **New `xc_patch_resource` tool** -- applies JSON-Patch ops over a GET, strip, PUT cycle so callers stop hand-rolling that round-trip. Optimistic concurrency via `resource_version` is on by default. Set `check_resource_version: false` to skip the version check.
- **New `xc_diff_resource` tool** -- returns a JSON-Patch diff between the current resource and a proposed body without applying anything. Useful as a pre-flight before risky PUTs.
- **New `xc_lb_wait_ready` tool** -- polls an HTTP LB's `spec.cert_state` until it reaches `CertificateValid` or the timeout elapses. Returns `ready: false` on timeout rather than throwing, so callers can branch cleanly.
- **New `xc_query_access_logs` tool** -- queries the XC access log API, parses each stringified log entry into a real object, follows `scroll_id` for auto-pagination, and supports a `group_by` option for client-side count aggregation.
- **JSON-Patch implementation** in `src/lib/json-patch.ts` -- in-house, no new dependencies. Supports `add`, `replace`, `remove`. The diff helper treats array changes as a single `replace` rather than computing element-level patches; pragmatic for XC config arrays which are usually authored as wholes.
- **Read-only field stripping** -- `system_metadata`, `status`, `metadata.uid`, `metadata.creation_timestamp`, `metadata.modification_timestamp`, `metadata.tenant`, `metadata.creator_class`, `metadata.creator_id`, and `spec.view_internal` are removed before any PUT produced by `xc_patch_resource`. New rejected fields can be added in `src/lib/resource-mutate.ts`.
- **Live tenant smoke test** -- `scripts/smoke-test.ts` exercises the four new tools against a real tenant and surfaced the missing `status` strip on first run.
- **Tool count** -- 11 (up from 7)
- **Unit tests** -- 211 tests across 21 test files (up from 157/15)

## 0.1.0 -- 2026-03-20

### First stable release

7 MCP tools covering 1,764 F5 XC API endpoints with token-optimized output, resource templates, and server-side certificate management.

**Tools:** `xc_discover_apis`, `xc_get_operation_details`, `xc_call_api`, `xc_create_cert`, `xc_list_namespaces`, `xc_list_resources`, `xc_list_tenants`

**Highlights since 0.0.x:**
- Resource templates for 8 common types — 85% fewer tokens than full schema dumps
- `xc_create_cert` generates certs and blindfold-encrypts keys entirely server-side
- LB defaults (port 443, non_default_loadbalancer) prevent common API errors
- Compact JSON, trimmed tool descriptions, response filtering, field projection
- Multi-tenant support with per-tenant default namespaces
- Docker hardening (non-root, healthcheck, .dockerignore)
- HTTP session idle timeout (30 min)
- Auto-update check on startup
- 157 tests across 15 files

## 0.0.9 -- 2026-03-20

### xc_create_cert tool, resource templates, LB defaults, token optimization

- **New `xc_create_cert` tool** -- generates a self-signed certificate, blindfold-encrypts the private key, and creates the certificate object in XC, all server-side. No PEM content passes through the LLM conversation. Returns a ready-to-use object reference for LB configs
- **Resource templates** -- `xc_get_operation_details` now returns compact example bodies (~50 lines) instead of full schemas (~630 lines) for common create operations: HTTP LBs (auto-cert and custom cert), origin pools (public IP and K8s), app firewalls, and certificates. Saves ~10k tokens per schema lookup. Use `include_full_schema: true` to get the full schema when needed
- **LB body defaults** -- `xc_call_api` automatically sets `non_default_loadbalancer` and `port: 443` on HTTPS LB create/update unless explicitly overridden
- **Blindfold-only enforcement** -- all templates, tool descriptions, and notes reference `blindfold_secret_info` exclusively; `clear_secret_info` is never suggested. Tool description explicitly states "always use blindfold_secret_info, never clear_secret_info"
- **Correct HTTPS LB cert structure** -- templates use `tls_cert_params.certificates[]` (object refs) for custom certs, matching actual XC API behavior
- **Trimmed tool descriptions** -- ~28% reduction in per-turn tool schema overhead; discovery tool now says "only needed when you don't know the API path"
- **Skip truncation for list tools** -- `xc_list_resources` and `xc_list_namespaces` now read full API responses (no 50KB truncation), ensuring all items are returned from large namespaces
- **Unit tests** -- 157 tests across 15 test files (up from 154/14)

## 0.0.8 -- 2026-03-20

### Code quality, token optimization, and reliability

- **Compact JSON output** -- removed pretty-print (`null, 2`) from `xc_call_api` and `xc_get_operation_details` output, saving ~20% tokens per response
- **Compact discover output** -- operations now displayed as single-line entries instead of 4-5 lines each, ~60% smaller discovery results
- **Shared constants** -- extracted `MAX_RESPONSE_SIZE`, `MAX_TOOL_OUTPUT`, `MAX_SCHEMA_OUTPUT`, `REQUEST_TIMEOUT_MS` into `src/lib/constants.ts`
- **Blindfold fetch timeout** -- added 30s AbortController timeout to `fetchBlindfoldParams()`, preventing indefinite hangs on certificate uploads
- **Removed `as any` cast** -- explicit param destructuring in `xc_call_api` handler for type safety
- **Consolidated schema summarization** -- removed duplicate `summarizeSchema()` from operation-details; schema-resolver now accepts a `summarize` flag controlling which scalar fields are kept
- **O(1) operation lookup** -- `findOperation()` now uses a pre-built Map for constant-time lookups across 1,764 operations
- **Unit tests** -- 154 tests across 14 test files (up from 153/14)

## 0.0.7 -- 2026-03-12

### QA remediation

- **response_filter skips error responses** -- 4xx/5xx responses always return the full error body, never filtered
- **response_filter empty match warning** -- returns `filter_warning` with available top-level keys when filter matches nothing
- **include_response_schema option** -- `xc_get_operation_details` now omits response schemas by default (they duplicate request schemas). Set `include_response_schema: true` to include them
- **summary_mode** -- new option on `xc_get_operation_details` strips descriptions, examples, and validation rules, keeping only types, required fields, enums, and oneof groups
- **Namespace prefix filter** -- `xc_list_namespaces` now supports `prefix` and `label_selector` params to reduce token usage on large tenants
- **Field projection** -- `xc_list_resources` now supports a `fields` param with dot-notation (e.g., `["spec.origin_servers", "system_metadata.creation_timestamp"]`)
- **max_items** -- `xc_list_resources` now supports `max_items` to limit returned items
- **PKCS1/PKCS8 docs corrected** -- both PEM key formats are accepted by the XC API; documentation updated
- **Unit tests** -- 153 tests across 14 test files (up from 140/14)

## 0.0.6 -- 2026-03-10

### Response filtering, schema depth control, oneof docs, and version check

- **Response filtering** -- new `response_filter` parameter on `xc_call_api` extracts specific fields from large API responses before truncation. Supports dot notation and `[]` for arrays (e.g., `"items[].name,items[].labels"`)
- **Configurable schema depth** -- new `max_depth` parameter on `xc_get_operation_details` (default 4, max 10) lets you see deeper nested fields like origin_server types and advertise options
- **Oneof constraint visibility** -- F5 XC `x-ves-oneof-field-*` extensions are now preserved in schema output and parsed from JSON strings to arrays, so the LLM knows which fields are mutually exclusive
- **PKCS1 key format note** -- certificate operations now include a note that private keys must be in PKCS1 format (`BEGIN RSA PRIVATE KEY`), not PKCS8
- **Version & update check** -- server version now shown in startup log and `xc_list_tenants` output. On startup and when listing tenants, the server checks GitHub for newer releases and notifies if an update is available
- `xc_list_tenants` now also shows default namespace per tenant
- Truncation warning on `xc_call_api` now suggests using `response_filter`
- `package.json` version now tracks release tags
- **Unit tests** -- 140 tests across 14 test files (up from 119/13)

## 0.0.4 -- 2026-03-04

### Default namespace configuration

- **Default namespace** -- configure a default namespace via `XC_DEFAULT_NAMESPACE` (single-tenant) or `XC_TENANT_<NAME>_DEFAULT_NAMESPACE` (multi-tenant) so most operations can skip the namespace parameter
- `xc_list_resources` namespace parameter is now **optional** -- falls back to the configured default, or returns a guidance message prompting the user to specify one
- `xc_call_api` description updated to note default namespace availability
- New `resolveNamespace()` helper follows the same pattern as `resolveTenant()`
- **Unit tests** -- 119 tests across 13 test files (up from 108/13), covering env var parsing and namespace resolution logic

## 0.0.3 -- 2026-03-04

### Blindfold encryption for private keys

- **Automatic blindfold encryption** -- raw PEM private keys in certificate API calls are now blindfold-encrypted before transmission
- Private keys sent via `clear_secret_info.url` are automatically encrypted and moved to `blindfold_secret_info.location` -- the cleartext is never sent to the API
- Private keys placed directly in `blindfold_secret_info.location` are also encrypted in place
- Certificate PEM values (`certificate_url`) continue to use simple base64 encoding
- `encodePemFields` is now async and accepts `TenantConfig` to fetch encryption parameters from the tenant's secret management API
- New `src/lib/blindfold.ts` module with `fetchBlindfoldParams()` and `blindfoldEncrypt()` functions
- **Unit tests** -- 108 tests across 13 test files (up from 87/11), including blindfold crypto tests with binary bundle structure validation

## 0.0.2 -- 2026-03-03

### Github Actions plugged in

- Everything seems working so tagging an official release.

## 0.0.1 -- 2026-03-03

Initial release.

### Features

- **6 MCP tools** covering all 1,764 F5 Distributed Cloud API endpoints across 18 categories
  - `xc_discover_apis` -- search/browse operations by keyword, category, HTTP method, or resource type
  - `xc_get_operation_details` -- get full parameter schemas and request/response details for any operation
  - `xc_call_api` -- execute any F5 XC API call with automatic auth
  - `xc_list_namespaces` -- quick-list all namespaces in a tenant
  - `xc_list_resources` -- quick-list resources of a given type in a namespace
  - `xc_list_tenants` -- list all configured tenants and URLs
- **Multi-tenant support** -- configure multiple XC tenants via named environment variables (`XC_TENANT_<NAME>_URL` / `XC_TENANT_<NAME>_TOKEN`), with backwards-compatible single-tenant mode
- **Build-time index** -- 268 OpenAPI spec files parsed into a searchable index at build time; full schemas resolved on-demand with depth-limited `$ref` resolution
- **Dual transport** -- stdio (Claude Code, local clients) and Streamable HTTP (ChatGPT, remote clients) via `MCP_TRANSPORT` env var
- **Docker deployment** -- multi-stage Dockerfile for minimal runtime image
- **Response safety** -- API responses truncated at 50KB to prevent overwhelming the AI context window
- **MCP error signaling** -- `isError: true` on tool error responses for better AI error recovery
- **Unit tests** -- 87 tests across 11 test files covering all library and tool modules
- **CI** -- GitHub Actions workflow for automated build, test, and Docker image verification
