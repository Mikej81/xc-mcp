# Changelog

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
