# Changelog

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
