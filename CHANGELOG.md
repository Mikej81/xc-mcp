# Changelog

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
