# F5 Distributed Cloud (XC) MCP Server

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants access to the full F5 Distributed Cloud API. Covers 1,764 endpoints across 18 categories. Works with **Claude Code**, **ChatGPT**, and any MCP-compatible client.

## How It Works

Instead of registering thousands of individual tools, the server exposes 18 tools that let an AI discover, explore, and call any F5 XC API endpoint. For common resources like load balancers and origin pools, the AI can skip discovery entirely and use built-in templates. For multi-step state mutations, dedicated patch, diff, and convenience tools handle the GET, strip, and PUT round-trip so callers do not have to.

| Tool | Purpose |
|------|---------|
| `xc_discover_apis` | Search API operations by keyword, category, or HTTP method |
| `xc_get_operation_details` | Get request body templates or full schemas for an operation |
| `xc_resolve_schema_ref` | Expand a JSON Schema `$ref` from an OpenAPI spec file to a configurable depth |
| `xc_call_api` | Execute any API call with optional response filtering |
| `xc_create_cert` | Generate a self-signed cert with blindfold-encrypted private key |
| `xc_patch_resource` | Apply JSON-Patch ops to a resource, handling the GET, strip, and PUT round-trip |
| `xc_diff_resource` | Show what a PUT would change as a JSON-Patch diff, without applying anything |
| `xc_lb_wait_ready` | Poll an HTTP LB until its certificate state becomes valid or a timeout elapses |
| `xc_lb_set_request_headers` | Add or remove request headers on an HTTP LB, handling the GET, strip, and PUT round-trip |
| `xc_pool_attach_healthcheck` | Attach a named healthcheck to an origin pool (idempotent) |
| `xc_pool_detach_healthcheck` | Detach a named healthcheck from an origin pool |
| `xc_dns_zone_status` | DNS zone diagnostic roll-up: deployment status, nameservers, and an optional data-plane probe |
| `xc_query_access_logs` | Query access logs with parsing, auto-pagination, and optional group-by aggregation |
| `xc_query_lb_metrics` | Time-bucketed request counts and response-code-class breakdown for an HTTP LB |
| `xc_list_namespaces` | List namespaces with optional prefix filtering |
| `xc_list_resources` | List resources with field projection and item limits, plus an optional `verify` flag that drops names that 404 on a follow-up GET |
| `xc_search_resources` | Find resources by name across multiple namespaces, with substring or glob matching |
| `xc_list_tenants` | Show configured tenants, version, and update availability |

The server also exposes [MCP resources](#mcp-resources) for browsing API categories and resource types, and [MCP prompts](#mcp-prompts) for common workflows like auditing a namespace or deploying a load balancer.

### Keeping token usage low

The biggest challenge with API-heavy MCP tools is context bloat. Every response the AI sees costs tokens. This server tackles that at multiple levels:

- **Templates instead of schemas.** When you ask for the create schema of an HTTP LB, origin pool, WAF, or cert, the server returns a compact working example (~50 lines) instead of the full OpenAPI schema (~630 lines). That's 85% fewer tokens. Pass `include_full_schema: true` if you need the real thing.
- **Server-side cert generation.** `xc_create_cert` generates the cert, blindfold-encrypts the private key, and creates the XC object without any PEM content ever entering the conversation. The `domain` argument must be a DNS hostname, optionally starting with `*.` for a wildcard, up to 253 characters. The server runs `openssl` to make the key pair, so a container image needs the `openssl` binary (the published image includes it) and a writable `/tmp`.
- **Response filtering.** `response_filter` on `xc_call_api` extracts specific fields from large API responses before they reach the AI. Useful for quota endpoints that return 50KB+.
- **Smart defaults.** The server automatically sets `port: 443` and `non_default_loadbalancer` on HTTPS LB creates so the AI doesn't need to look up those requirements.
- **Compact output.** All JSON is serialized without whitespace. Tool descriptions are intentionally terse. Discovery output is one line per operation.

## Prerequisites

- An **F5 Distributed Cloud** account
- An **API Token** (create in XC Console > Administration > Personal Management > Credentials > "Add Credentials" > select "API Token"), or an **API Certificate** P12 file (same menu, pick "API Certificate") if you'd rather use mTLS
- Your **Tenant URL**, e.g. `https://your-tenant.console.ves.volterra.io` (visible in your browser when logged into XC Console)
- **Docker** (recommended) or **Node.js 20+**

## Transport Modes

| Mode | Set via | Used by | How it works |
|------|---------|---------|--------------|
| **stdio** (default) | `MCP_TRANSPORT=stdio` or unset | Claude Code | Client spawns the server as a subprocess, communicates over stdin/stdout |
| **http** | `MCP_TRANSPORT=http` | ChatGPT, Bifrost, remote clients | Server listens on HTTP (default port 3000). Clients connect to **`/mcp`**. Pointing at `/` returns 404. |
| **http + hosted** | `MCP_TRANSPORT=http` and `MCP_MODE=hosted` | Shared deployments | One server, many users. Each user sends their own tenant credentials as request headers. See [Hosted Mode](#hosted-mode). |

---

## Setup: Claude Code

Claude Code uses stdio mode. It launches the server as a subprocess. No ports, no background processes.

### Option A: Docker (recommended)

```bash
# 1. Authenticate with GHCR (one-time, use a GitHub PAT with read:packages scope)
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# 2. Pull the image
docker pull ghcr.io/mikej81/xc-mcp:latest

# 3. Register with Claude Code
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_API_TOKEN","-e","XC_TENANT_URL","ghcr.io/mikej81/xc-mcp:latest"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'

# 4. Verify: start Claude Code and type /mcp
```

Replace `YOUR_API_TOKEN_HERE` and the tenant URL with your actual values. `--scope user` makes the server available across all your Claude Code sessions.

### Option A (alternative): Build Docker image locally

```bash
git clone https://github.com/Mikej81/xc-mcp.git
cd xc-mcp
docker build -t f5-xc-mcp .

claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_API_TOKEN","-e","XC_TENANT_URL","f5-xc-mcp"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'
```

### Option B: Node.js

```bash
npm install && npm run build

claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"node","args":["/absolute/path/to/xc-mcp/dist/src/index.js"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'
```

### Option C: Project-scoped config

Drop a `.mcp.json` in your project root so the whole team gets the same setup:

```json
{
  "mcpServers": {
    "f5-xc": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "XC_API_TOKEN", "-e", "XC_TENANT_URL", "ghcr.io/mikej81/xc-mcp:latest"],
      "env": {
        "XC_API_TOKEN": "YOUR_API_TOKEN_HERE",
        "XC_TENANT_URL": "https://your-tenant.console.ves.volterra.io"
      }
    }
  }
}
```

### Managing the server

```bash
claude mcp list          # See all registered servers
claude mcp remove f5-xc  # Remove this server
/mcp                     # View status inside Claude Code
```

---

## Setup: Google Antigravity

Antigravity reads MCP servers from a single `mcp_config.json`. Servers sit under an `mcpServers` object, keyed by name. The format below follows [Antigravity's MCP docs](https://antigravity.google/docs/mcp).

### Find the config file

- **IDE:** click **...** at the top of the agent side panel, choose **MCP Servers**, then **Manage MCP Servers**, then **View raw config**.
- **App:** open **Customizations**, then **Installed**, and find the **MCP Servers** section. **Copy Config File Path** gives you the file location. The docs describe no form for custom entries, so edit the file.
- **CLI:** edit the file directly. The paths below also apply to the IDE.

Both the IDE and the CLI use `~/.gemini/config/mcp_config.json` for all projects and `<workspace>/.agents/mcp_config.json` for one workspace.

A third-party guide lists `~/.gemini/antigravity/mcp_config.json`, so trust the path the IDE or App shows you.

### Local mode (Docker)

Pull the image as in [Claude Code Option A](#option-a-docker-recommended), then add this entry:

```json
{
  "mcpServers": {
    "f5-xc": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "XC_API_TOKEN", "-e", "XC_TENANT_URL", "ghcr.io/mikej81/xc-mcp:latest"],
      "env": {
        "XC_API_TOKEN": "YOUR_API_TOKEN_HERE",
        "XC_TENANT_URL": "https://your-tenant.console.ves.volterra.io"
      }
    }
  }
}
```

### Local mode (Node.js)

Run `npm install && npm run build`, then point `command` at the built entry point:

```json
{
  "mcpServers": {
    "f5-xc": {
      "command": "node",
      "args": ["/absolute/path/to/xc-mcp/dist/src/index.js"],
      "env": {
        "XC_API_TOKEN": "YOUR_API_TOKEN_HERE",
        "XC_TENANT_URL": "https://your-tenant.console.ves.volterra.io"
      }
    }
  }
}
```

### Hosted mode

If your team runs a shared server, use a remote entry with your own credentials as headers. Antigravity takes `serverUrl` for the endpoint, and the docs say `url` also works. Remote servers must speak Streamable HTTP, which this server does. See [Hosted Mode](#hosted-mode) for the headers, error codes and operator notes. The token sits in plaintext in this file, so keep it in the global file and never commit a workspace `.agents/mcp_config.json` that contains it.

```json
{
  "mcpServers": {
    "f5-xc": {
      "serverUrl": "https://<host>/mcp",
      "headers": {
        "X-XC-Tenant-Url": "https://your-tenant.console.ves.volterra.io",
        "X-XC-Tenant-Token": "YOUR_API_TOKEN_HERE",
        "X-API-Key": "YOUR_SHARED_SECRET"
      }
    }
  }
}
```

Leave out `X-API-Key` if the server has no shared secret (see [Shared-secret header](#shared-secret-header-x-api-key)). For several tenants, add one entry per tenant (see [Multiple tenants in hosted mode](#multiple-tenants-in-hosted-mode)).

### Verify

- **CLI:** type `/mcp` and press Enter. The MCP Manager shows each server as active, disconnected or loading, with connection logs.
- **App:** the server's status dot in the MCP Servers section turns green with its tools listed, or red with an error such as "Unauthorized".
- **IDE:** the docs describe no check for custom servers. Reopen **Manage MCP Servers** and look for `f5-xc`. If it is missing, check the raw config for JSON errors.

---

## Setup: ChatGPT

ChatGPT connects over HTTP. You need to run the server somewhere ChatGPT can reach it.

### Start the server

**Docker:**
```bash
docker run --rm -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_PORT=3000 \
  -e XC_API_TOKEN=YOUR_API_TOKEN_HERE \
  -e XC_TENANT_URL=https://your-tenant.console.ves.volterra.io \
  ghcr.io/mikej81/xc-mcp:latest
```

**Node.js:**
```bash
MCP_TRANSPORT=http XC_API_TOKEN=your-token XC_TENANT_URL=https://your-tenant.console.ves.volterra.io node dist/src/index.js
```

### Expose publicly

ChatGPT needs a public HTTPS URL. For development, use a tunnel:

```bash
ngrok http 3000
# or
cloudflared tunnel --url http://localhost:3000
```

### Connect in ChatGPT

1. **Settings** > **Connectors** > **Advanced settings** > enable **Developer Mode**
2. **Settings** > **Connectors** > **Create**
3. Enter your tunnel URL + `/mcp` as the Connector URL
4. Save and start chatting

### Docker Compose

```yaml
services:
  f5-xc-mcp:
    image: ghcr.io/mikej81/xc-mcp:latest
    ports:
      - "3000:3000"
    environment:
      MCP_TRANSPORT: http
      MCP_HTTP_PORT: 3000
      XC_API_TOKEN: ${XC_API_TOKEN}
      XC_TENANT_URL: ${XC_TENANT_URL}
    restart: unless-stopped
```

```bash
echo 'XC_API_TOKEN=your-token' >> .env
echo 'XC_TENANT_URL=https://your-tenant.console.ves.volterra.io' >> .env
docker compose up -d
```

---

## Multiple Tenants

This section covers local mode (stdio, or HTTP without `MCP_MODE=hosted`). For a shared hosted server, see [Multiple tenants in hosted mode](#multiple-tenants-in-hosted-mode).

Use named environment variables to configure multiple tenants:

```bash
XC_TENANT_PROD_URL=https://prod.console.ves.volterra.io
XC_TENANT_PROD_TOKEN=your-prod-api-token
XC_TENANT_DEV_URL=https://dev.console.ves.volterra.io
XC_TENANT_DEV_TOKEN=your-dev-api-token
```

The naming convention is `XC_TENANT_<NAME>_URL` and `XC_TENANT_<NAME>_TOKEN`. When only one tenant is configured, the `tenant` parameter is optional. With multiple tenants, you'll need to specify which one on each call.

For multi-tenant deployments where most operations target one tenant, set `XC_DEFAULT_TENANT=prod` (or another configured name) so callers can omit the `tenant` parameter for that tenant. This mirrors the existing `XC_DEFAULT_NAMESPACE` behavior.

```bash
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_TENANT_PROD_URL","-e","XC_TENANT_PROD_TOKEN","-e","XC_TENANT_DEV_URL","-e","XC_TENANT_DEV_TOKEN","ghcr.io/mikej81/xc-mcp:latest"],"env":{"XC_TENANT_PROD_URL":"https://prod.console.ves.volterra.io","XC_TENANT_PROD_TOKEN":"abc123","XC_TENANT_DEV_URL":"https://dev.console.ves.volterra.io","XC_TENANT_DEV_TOKEN":"def456"}}'
```

## Default Namespace

Most XC resources live in a namespace. Set a default so you don't have to specify it every time:

```bash
# Single tenant
XC_DEFAULT_NAMESPACE=my-namespace

# Multi-tenant (per tenant)
XC_TENANT_PROD_DEFAULT_NAMESPACE=production
XC_TENANT_DEV_DEFAULT_NAMESPACE=dev-sandbox
```

An explicit namespace always takes priority. If neither is set, the server asks the user to pick one.

## Read-Only Mode

Set `MCP_READ_ONLY=true` to stop the server from changing anything in a tenant. The tools that write (`xc_create_cert`, `xc_patch_resource`, `xc_lb_set_request_headers`, `xc_pool_attach_healthcheck`, `xc_pool_detach_healthcheck`) disappear from the tool list, and `xc_call_api` accepts only `GET`. The query tools keep working, including `xc_query_access_logs` and `xc_query_lb_metrics`, which send `POST` requests that only read. This works in every transport and mode.

Over HTTP, a client can also ask for read-only on its own requests by sending `X-XC-Read-Only: true`. The tools stay listed, but any call that would write returns an error. The values `false`, `0`, `no`, or an empty header leave writes on. Any other value turns read-only on, so a typo fails safe. Use it when you want to explore a production tenant without any chance of a change:

```bash
claude mcp add --transport http f5-xc-readonly https://<host>/mcp \
  --header "X-XC-Tenant-Url: https://your-tenant.console.ves.volterra.io" \
  --header "X-XC-Tenant-Token: <token>" \
  --header "X-XC-Read-Only: true"
```

Every tool also declares MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Clients such as Claude Code use them to decide when to ask before running a tool. `xc_call_api` is marked destructive because it can send `DELETE`.

## HTTP Endpoint and Security

The HTTP transport serves MCP on a **single endpoint**: `/mcp`. All MCP traffic goes to this path: `POST` for client-to-server messages, `GET` for the SSE streaming channel, and `DELETE` for session teardown. Pointing a client at the bare host (`/`) returns 404. When configuring Bifrost, the ChatGPT connector, or any other MCP HTTP client, the connector URL must end in `/mcp` (for example: `https://xc-mcp.example.com/mcp`).

When deploying the HTTP transport publicly (for example, behind an F5 XC public load balancer), set both `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE`. Without them, anything that can reach `/mcp` can use the server. That's fine for local development, but never appropriate on the open internet.

```bash
# Example: require X-API-Key on every request
MCP_AUTH_HEADER_NAME=X-API-Key
MCP_AUTH_HEADER_VALUE=<long-random-secret>
```

Clients hold the `GET /mcp` SSE stream open, so raise the idle timeout of any proxy in front of the server. Behind an F5 XC load balancer, that is the origin pool's `spec.advanced_options.http_idle_timeout`, which XC caps at 600000 ms (10 minutes). Streams idle longer than that are closed and the client reconnects.

The check runs before body parsing, so failed requests never create a session. Failed auth events are logged at `warn` level with the peer IP and the expected header name (the supplied value is never logged).

Configure your client (Bifrost, ChatGPT connector, etc.) to send the matching header on every request to `/mcp`.

### Shared-secret header (`X-API-Key`)

`X-API-Key` is not built into the server. It is the header name most deployments pick for `MCP_AUTH_HEADER_NAME`, and the one the examples in this README and `deploy/k8s/` use. Any header name works.

- **What it protects.** The header decides who may talk to the server at all. It is not a user identity: everyone who connects shares the same value. In hosted mode each user still sends their own XC token in `X-XC-Tenant-Token`, and that token decides what they can do in XC.
- **Where it applies.** Every request to `/mcp` in local and hosted mode, checked before the hosted credential headers. `/healthz`, `/readyz` and the `/metrics` listener don't check it, so probes and Prometheus need no secret.
- **Matching.** The header name is case-insensitive (`x-api-key` matches `X-API-Key`). The value must match exactly and is compared in constant time.
- **On failure.** A missing or wrong value gets 401 `{"error":"unauthorized"}` with no `reason` field. A 401 that carries a `reason` (such as `missing_token`) comes from the hosted credential check instead, which means the shared secret was accepted.
- **Generating a value.** Use a long random string, for example `openssl rand -hex 32`, and inject it from a secret store, not the image or a committed file.
- **Rotation.** The server accepts one value. To rotate, restart the server with the new value and update every client config. Clients still on the old value get 401 until they are updated.

The header goes in each client config next to the other headers. For Claude Code:

```bash
claude mcp add --transport http f5-xc https://<host>/mcp \
  --header "X-API-Key: <shared-secret>"
```

In JSON configs (Cursor, Antigravity, `.mcp.json`) add `"X-API-Key": "<shared-secret>"` to the `headers` object. If you chose a different `MCP_AUTH_HEADER_NAME`, use that name instead.

### Health checks and shutdown

Two probe endpoints sit outside `/mcp` and skip the auth header, so a load balancer or Kubernetes can reach them. They answer `GET` and `HEAD`; other methods get 405.

| Path | Returns |
|------|---------|
| `/healthz` | 200 `{"status":"ok"}` while the process is up. Use it for liveness. |
| `/readyz` | 200 `{"status":"ready"}`, or 503 `{"status":"shutting_down"}` once shutdown starts. Use it for readiness. |

Probe requests are not written to the access log.

On `SIGTERM` or `SIGINT` the server turns `/readyz` to 503 and refuses new sessions with 503 `shutting_down`. It then waits `MCP_SHUTDOWN_DRAIN_SECONDS` (default 0) so the load balancer sees the failed readiness check and stops sending traffic, stops accepting connections, closes open sessions and exits 0. Tool calls still running at that point are cut off, not waited for. If closing takes more than 10 seconds after the drain window, the server exits 1.

On Kubernetes, set `MCP_SHUTDOWN_DRAIN_SECONDS` to a few seconds longer than your readiness probe's `periodSeconds`, and set `terminationGracePeriodSeconds` above the drain time plus 10. With the default of 0, the server stops accepting connections as soon as it gets the signal, which suits `docker stop`.

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
```

A complete Deployment, Service and Ingress with these probes and timings is in [`deploy/k8s/`](deploy/k8s/).

The Docker image's `HEALTHCHECK` calls `/healthz` when `MCP_TRANSPORT=http`. In stdio mode there is no port to probe, so it reports healthy while the process runs.

### Client compatibility (MCP Tasks RFC)

The MCP SDK marks every tool with `execution.taskSupport: "forbidden"` per the Tasks RFC. Some current clients (Bifrost, certain OpenWebUI builds) misread that field and skip the tool. The server detects clients that did not advertise `capabilities.tasks` during `initialize` and strips the field from the `tools/list` response for those sessions only. Tasks-RFC-aware clients still receive the full descriptor. No configuration needed.

---

## Hosted Mode

Hosted mode runs one server for many users with no local install. The server holds no tenant credentials. Each user sends their own tenant URL and API token as headers on every request, and the server uses them for that user's session only.

### Server setup

```bash
MCP_TRANSPORT=http
MCP_MODE=hosted
# Optional: tenant domains the server may call (default: .console.ves.volterra.io)
XC_HOSTED_ALLOWED_DOMAINS=.console.ves.volterra.io,.<your-fedramp-domain>
```

The server refuses to start if `MCP_MODE=hosted` is set without `MCP_TRANSPORT=http`, or if any `XC_API_TOKEN`, `XC_TENANT_URL`, `XC_API_P12_*` or `XC_TENANT_<NAME>_*` variable is set. Hosted mode never reads tenant credentials from the environment.

`XC_HOSTED_ALLOWED_DOMAINS` is a comma-separated list of domain suffixes. A leading dot is added if you leave it out. A tenant URL must be `https://<tenant><suffix>`, with exactly one label in front of the suffix. FedRAMP tenants live outside `ves.volterra.io`, so add their domain here. Anything off the list gets a 401.

To serve commercial and FedRAMP tenants from one server, list each console suffix, keeping the commercial one:

```bash
XC_HOSTED_ALLOWED_DOMAINS=.console.ves.volterra.io,.console.<fedramp-domain>,.console.<fedramp-staging-domain>
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HOSTED_MAX_SESSIONS` | `500` | Process-wide session cap. |
| `MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL` | `5` | Cap per tenant URL and token pair. |
| `MCP_HOSTED_EVICT_MIN_IDLE_SECONDS` | `300` | How long a session must sit idle before a cap can evict it. |

All three must be positive integers. The server fails at startup on anything else.

When a new `initialize` hits a cap, the server looks at the least recently active session in that scope: the caller's own sessions for the per-credential cap, all sessions for the global cap. If that session has been idle for at least `MCP_HOSTED_EVICT_MIN_IDLE_SECONDS`, the server closes it and admits the new one. If it was active more recently, the server evicts nothing and refuses the new session with 429 `too_many_sessions` (per-credential cap) or 503 `server_busy` (global cap). The `Retry-After` header gives the seconds until that session crosses the idle threshold.

`MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE` still work in hosted mode and are checked first. Use them to keep the endpoint closed to anyone without the shared secret.

### Request headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-XC-Tenant-Url` | Yes | Tenant URL, for example `https://your-tenant.console.ves.volterra.io`. Must be HTTPS with no port, path, query or userinfo. |
| `X-XC-Tenant-Token` | Yes | XC API token. P12 (mTLS) auth is not supported in hosted mode. |
| `X-XC-Tenant-Namespace` | No | Default namespace for the session. |
| `X-XC-Read-Only` | No | `true` refuses any tool call that would write. See [Read-Only Mode](#read-only-mode). |

Send all of them on every request, not only on `initialize`. A repeated or comma-joined value is rejected.

On `initialize`, the server verifies the token with a `whoami` call to the tenant (10 second timeout) before it creates a session. Later requests on the session must carry the same URL and token.

| Status | Body | Cause |
|--------|------|-------|
| 401 | `{"error":"unauthorized","reason":"missing_tenant_url"}` | `X-XC-Tenant-Url` absent or empty |
| 401 | `...,"reason":"missing_token"` | `X-XC-Tenant-Token` absent or empty |
| 401 | `...,"reason":"invalid_tenant_url"` | URL is not a bare HTTPS origin |
| 401 | `...,"reason":"url_not_allowed"` | Host is not under an allowed domain |
| 401 | `...,"reason":"duplicate_header"` | A credential header was sent more than once |
| 401 | `{"error":"invalid_credentials"}` | The tenant rejected the token (401 or 403) |
| 502 | `{"error":"tenant_unreachable"}` | The tenant timed out, errored, or was unreachable |
| 404 | `{"error":"session_not_found"}` | Unknown or expired session id |
| 429 | `{"error":"too_many_sessions"}` | Per-credential cap reached and none of the caller's sessions has been idle long enough to evict. Sent with `Retry-After`. |
| 503 | `{"error":"server_busy"}` | Global cap reached and no session has been idle long enough to evict. Sent with `Retry-After`. |
| 403 | `{"error":"session_credential_mismatch"}` | The credentials differ from the ones that opened the session |

### Client configuration

The examples include `X-API-Key` for a server that sets `MCP_AUTH_HEADER_NAME=X-API-Key` (see [Shared-secret header](#shared-secret-header-x-api-key)). Leave that line out if the server has no shared secret, or use the header name it was configured with.

Claude Code:

```bash
claude mcp add --transport http f5-xc https://<host>/mcp \
  --header "X-XC-Tenant-Url: https://your-tenant.console.ves.volterra.io" \
  --header "X-XC-Tenant-Token: <your-api-token>" \
  --header "X-API-Key: <shared-secret>"
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "f5-xc": {
      "url": "https://<host>/mcp",
      "headers": {
        "X-XC-Tenant-Url": "https://your-tenant.console.ves.volterra.io",
        "X-XC-Tenant-Token": "<your-api-token>",
        "X-API-Key": "<shared-secret>"
      }
    }
  }
}
```

Antigravity: see [Setup: Google Antigravity](#setup-google-antigravity). It uses `serverUrl` and the same `headers` object.

### Multiple tenants in hosted mode

A hosted session is bound to one tenant: the URL and token sent on `initialize`. The `XC_TENANT_<NAME>_*` variables and the `tenant` tool parameter don't apply. To work with several tenants, add one MCP server entry per tenant, each with its own name and headers. Each entry opens its own session.

Claude Code:

```bash
claude mcp add --transport http --scope user f5-xc-prod https://<host>/mcp \
  --header "X-XC-Tenant-Url: https://prod-tenant.console.ves.volterra.io" \
  --header "X-XC-Tenant-Token: <prod-api-token>" \
  --header "X-XC-Read-Only: true" \
  --header "X-API-Key: <shared-secret>"

claude mcp add --transport http --scope user f5-xc-dev https://<host>/mcp \
  --header "X-XC-Tenant-Url: https://dev-tenant.console.ves.volterra.io" \
  --header "X-XC-Tenant-Token: <dev-api-token>" \
  --header "X-XC-Tenant-Namespace: dev-apps" \
  --header "X-API-Key: <shared-secret>"
```

The same setup as JSON, for `claude mcp add-json` or a project `.mcp.json`. Claude Code expands `${VAR}` in `headers`, so the tokens can come from your shell environment instead of the file:

```json
{
  "mcpServers": {
    "f5-xc-prod": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": {
        "X-XC-Tenant-Url": "https://prod-tenant.console.ves.volterra.io",
        "X-XC-Tenant-Token": "${XC_PROD_TOKEN}",
        "X-XC-Read-Only": "true",
        "X-API-Key": "${XC_MCP_SHARED_SECRET}"
      }
    },
    "f5-xc-dev": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": {
        "X-XC-Tenant-Url": "https://dev-tenant.console.ves.volterra.io",
        "X-XC-Tenant-Token": "${XC_DEV_TOKEN}",
        "X-XC-Tenant-Namespace": "dev-apps",
        "X-API-Key": "${XC_MCP_SHARED_SECRET}"
      }
    }
  }
}
```

How this behaves:

- **The model picks the tenant by picking the server.** Claude Code prefixes tool names with the server name (`mcp__f5-xc-prod__xc_list_resources`, `mcp__f5-xc-dev__xc_list_resources`), so name each entry after its tenant. Say which tenant you mean in the prompt, for example "list the LBs in prod".
- **Settings are per entry.** `X-XC-Tenant-Namespace` and `X-XC-Read-Only` apply only to the entry that sends them. The example keeps prod read-only and dev writable.
- **Each entry adds 18 tools to the model's context.** With many tenants that costs tokens on every turn. Add entries only for the tenants you use, and remove the rest with `claude mcp remove <name>`.
- **Session caps count each entry separately.** `MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL` is per tenant URL and token pair, so two tenants don't share a cap. Every entry counts toward `MCP_HOSTED_MAX_SESSIONS`.
- **Tenant domains must be allowed.** Each tenant URL has to fall under `XC_HOSTED_ALLOWED_DOMAINS` on the server, or that entry gets 401 `url_not_allowed`.
- **Don't commit tokens.** A `.mcp.json` with literal tokens or a literal shared secret must stay out of git. Use the `${VAR}` form, or keep the entries at user scope (`--scope user`), which lives in `~/.claude.json`.

Cursor and Antigravity work the same way: one entry under `mcpServers` per tenant, each with its own `headers`.

### What changes for tools

- The `tenant` parameter is ignored. Every call goes to the tenant in the request headers, and `xc_list_tenants` shows only that tenant.
- `xc_call_api` rejects any path that resolves outside the tenant origin, such as an absolute URL. This check applies in local mode too.
- `xc_resolve_schema_ref` rejects any `spec_file` that resolves outside the specs directory, such as one containing `../`. This check applies in local mode too.

### Expired tokens

XC API tokens expire. When XC answers 401 during a tool call, the server appends one extra text block to that tool's result:

> XC rejected the API token (401). It may have expired or been revoked. Update X-XC-Tenant-Token in your MCP client config, then reconnect: the current session stays bound to the old token.

The original result stays as it was. A 403 is a permission problem, so it gets no hint. In local mode the hint names the setting to change instead: `XC_API_TOKEN` for a single tenant, `XC_TENANT_<NAME>_TOKEN` for a named tenant, or "Renew the P12 certificate" for a P12 tenant, followed by "then restart the server". The hint never contains the token.

### Operator notes

- A ready-made Kubernetes setup (Deployment, Service, Ingress, metrics port) lives in [`deploy/k8s/`](deploy/k8s/).
- Run it behind TLS. The token travels in a header on every request.
- Rate-limit at the proxy. The server does not throttle requests.
- It runs as a single process. Sessions live in memory, so scaling out needs sticky routing on `Mcp-Session-Id`.
- Rotating a token means a new session. The old session keeps returning 403 until the client reconnects.
- Request bodies over 256 KiB get 413 `payload_too_large`. The largest XC API bodies are around 164 KB, and a certificate plus key fits well under the limit.
- A session cap can only evict a session idle for `MCP_HOSTED_EVICT_MIN_IDLE_SECONDS` or longer, and the global cap can pick any user's session. While every session is active, new users get 503 `server_busy`, so size `MCP_HOSTED_MAX_SESSIONS` for the number of users you expect.
- Idle sessions expire after 30 minutes. A client that reuses an evicted or expired session gets 404 `session_not_found` and should reconnect.
- Access logs carry the tenant hostname. They never carry tokens. Request-body logging at `MCP_LOG_LEVEL=debug` is suppressed in hosted mode, because tool arguments can hold secrets.

---

## Metrics

Set `MCP_METRICS_PORT` to serve Prometheus metrics (text format 0.0.4) from a second HTTP listener on that port, for example `MCP_METRICS_PORT=9090`. Only `GET /metrics` answers; other paths get 404 and other methods get 405. The MCP port never serves `/metrics`. Metrics are off when the variable is unset. They need `MCP_TRANSPORT=http`: with stdio the server logs `metrics_disabled_stdio` and starts no listener. The port must be an integer from 1 to 65535 and differ from `MCP_HTTP_PORT`, or the server refuses to start. It also refuses to start if it cannot bind the port.

The listener binds all interfaces and has no authentication. Keep it off the public path: do not route it through a public load balancer or Ingress, and publish it only to a network your Prometheus can reach. In Docker, map it to localhost (`-p 127.0.0.1:9090:9090`). On Kubernetes, expose it on a ClusterIP Service only, as `deploy/k8s/` does, and consider a NetworkPolicy to limit who can reach it. The listener keeps answering during the shutdown drain and closes with the sessions.

| Metric | Type | Labels |
|--------|------|--------|
| `xc_mcp_build_info` | gauge | `version`, `mode` |
| `xc_mcp_sessions_active` | gauge | none |
| `xc_mcp_sessions_created_total` | counter | none |
| `xc_mcp_session_refusals_total` | counter | `reason`: `per_credential_cap`, `global_cap`, `shutting_down` |
| `xc_mcp_session_evictions_total` | counter | `reason`: `per_credential_cap`, `global_cap`, `idle` |
| `xc_mcp_auth_failures_total` | counter | `reason`: `missing_tenant_url`, `missing_token`, `invalid_tenant_url`, `url_not_allowed`, `duplicate_header`, `invalid_credentials`, `tenant_unreachable`, `session_credential_mismatch`, `auth_header_missing`, `auth_header_mismatch` |
| `xc_mcp_tool_calls_total` | counter | `tool`, `outcome` (`ok` or `error`) |
| `xc_mcp_upstream_requests_total` | counter | `tool`, `method`, `status_class` (`2xx`, `3xx`, `4xx`, `5xx`, `network`, `timeout`) |
| `xc_mcp_upstream_request_duration_seconds` | histogram | `tool`, `method` |

The histogram buckets are 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 and 30 seconds. `tool` is `none` for XC requests made outside a tool call, such as the `whoami` credential check on initialize. Labels come from fixed sets only. No tenant, path, namespace or user appears in any label.

## Audit Log

Every write the server sends to XC leaves one structured log line on stderr with `evt` set to `audit`. A write is any non-`GET` request made by a tool that changes state, so `xc_patch_resource`, `xc_call_api` with `POST`, `PUT`, `PATCH` or `DELETE`, and the other writing tools are covered. Tools that only read are not audited, including `xc_query_access_logs` and `xc_query_lb_metrics`, which use `POST` to read. Failed writes are audited too. Audit lines are always on and need no setting. `MCP_LOG_LEVEL` does not suppress them: they are written at level `info` even when the level is `warn` or `error`. To drop them, filter on `evt=audit` downstream. A `POST` to `/api/web/namespaces/<ns>/cascade_delete` is logged with `resource_type` `namespaces`, `name` set to the namespace and `action` set to `cascade_delete`.

| Field | Value |
|-------|-------|
| `tool` | The tool that made the request. |
| `method` | `POST`, `PUT`, `PATCH` or `DELETE`. |
| `path` | The request path after parameter substitution, without the query string. |
| `namespace`, `resource_type`, `name` | Parsed from `/api/<group>/namespaces/<ns>/<type>[/<name>]` when the path matches. Left out otherwise. |
| `status` | The upstream HTTP status. 0 for a network error, 408 for a timeout. |
| `duration_ms` | Request time in milliseconds. |
| `session_id` | The first 8 characters of the MCP session id, when there is a session. |
| `caller_id` | Who made the call. In hosted mode, the first 8 hex characters of the SHA-256 fingerprint of the tenant URL and token, which tells users apart without revealing the token. In local mode, the configured tenant name. |
| `tenant_host` | The tenant hostname. |

The line never contains request or response bodies, query strings, headers or tokens.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XC_API_TOKEN` | Yes* | -- | API token (single-tenant mode) |
| `XC_API_P12_PATH` | Yes* | -- | Path to P12 (PKCS#12) cert for mTLS auth (single-tenant mode). Alternative to `XC_API_TOKEN`. |
| `XC_API_P12_PASSWORD` | Yes* | -- | Passphrase for the P12 file. Required with `XC_API_P12_PATH`. |
| `XC_TENANT_URL` | Yes* | -- | Tenant URL (single-tenant mode) |
| `XC_TENANT_<NAME>_URL` | Yes* | -- | Named tenant URL (multi-tenant mode) |
| `XC_TENANT_<NAME>_TOKEN` | Yes* | -- | Named tenant token (multi-tenant mode) |
| `XC_TENANT_<NAME>_P12_PATH` | Yes* | -- | Named tenant P12 path. Alternative to `_TOKEN`. |
| `XC_TENANT_<NAME>_P12_PASSWORD` | Yes* | -- | Passphrase for `_P12_PATH`. Required when `_P12_PATH` is set. |
| `XC_DEFAULT_NAMESPACE` | No | -- | Default namespace (single-tenant mode) |
| `XC_TENANT_<NAME>_DEFAULT_NAMESPACE` | No | -- | Default namespace (multi-tenant mode) |
| `XC_DEFAULT_TENANT` | No | -- | Name of the tenant to use when `tenant` is omitted and multiple tenants are configured. Must match one of the `XC_TENANT_<NAME>_URL` names (case-insensitive). |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_HTTP_PORT` | No | `3000` | HTTP port (only when `MCP_TRANSPORT=http`) |
| `MCP_SHUTDOWN_DRAIN_SECONDS` | No | `0` | HTTP only. Seconds to report not-ready on `/readyz` after `SIGTERM` before the server stops accepting connections. See [Health checks and shutdown](#health-checks-and-shutdown). |
| `MCP_METRICS_PORT` | No | -- | HTTP transport only. Port (1-65535) for the Prometheus `/metrics` listener. Must differ from `MCP_HTTP_PORT`. With stdio the server logs a warning and ignores it. See [Metrics](#metrics). |
| `MCP_READ_ONLY` | No | `false` | `true` hides the tools that write and limits `xc_call_api` to `GET`. See [Read-Only Mode](#read-only-mode). |
| `MCP_MODE` | No | `local` | Set to `hosted` for [Hosted Mode](#hosted-mode). Requires `MCP_TRANSPORT=http` and no tenant variables. |
| `XC_HOSTED_ALLOWED_DOMAINS` | No | `.console.ves.volterra.io` | Hosted mode only. Comma-separated tenant domain suffixes. |
| `MCP_HOSTED_MAX_SESSIONS` | No | `500` | Hosted mode only. Process-wide session cap. |
| `MCP_HOSTED_MAX_SESSIONS_PER_CREDENTIAL` | No | `5` | Hosted mode only. Session cap per tenant URL and token pair. |
| `MCP_HOSTED_EVICT_MIN_IDLE_SECONDS` | No | `300` | Hosted mode only. Minimum idle time before a session cap can evict a session. |
| `MCP_AUTH_HEADER_NAME` | No* | -- | Name of the auth header required on every `/mcp` HTTP request (e.g. `X-API-Key`). Optional but strongly recommended for any public deployment. |
| `MCP_AUTH_HEADER_VALUE` | No* | -- | Expected value for the auth header. Compared in constant time. Inject via secret-store; never bake into the image. |
| `MCP_LOG_LEVEL` | No | `info` | Log level: `debug` \| `info` \| `warn` \| `error`. At `debug`, each access-log line additionally includes the parsed JSON-RPC request body (capped at 4 KB chars). Response bodies are never logged. |

*Per tenant, pick one auth method: a token (`*_TOKEN`) or a P12 cert (`*_P12_PATH` plus `*_P12_PASSWORD`). Setting both stops the server from starting. Same rule for `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE`: both set or both unset.

### P12 (mTLS) auth

API tokens are the default. If your environment needs cert-based auth instead, point at a P12 file with `XC_API_P12_PATH` plus its password and the server uses mTLS for every API call. The P12 loads once at startup, so a bad path or wrong password fails fast before the server takes any requests. Under mTLS no `Authorization` header is sent. The cert is the auth.

Running in Docker? Bind-mount the P12 into the container and pass the in-container path:

```bash
docker run --rm -i \
  -v /host/path/cert.p12:/secrets/cert.p12:ro \
  -e XC_API_P12_PATH=/secrets/cert.p12 \
  -e XC_API_P12_PASSWORD=your-p12-password \
  -e XC_TENANT_URL=https://your-tenant.console.ves.volterra.io \
  ghcr.io/mikej81/xc-mcp:latest
```

---

## MCP Resources

The server exposes read-only resources that MCP clients can browse:

| Resource URI | Description |
|-------------|-------------|
| `xc://api/categories` | All 18 API categories with operation counts |
| `xc://api/resource-types` | The 8 resource types that have built-in create templates |
| `xc://tenants/{name}` | Configuration details for a specific tenant |

## MCP Prompts

Pre-built prompt templates for common workflows:

| Prompt | Description |
|--------|-------------|
| `audit-namespace` | Audit all resources in a namespace, find orphaned objects |
| `deploy-https-lb` | Deploy an LB with cert, origin pool, and WAF from a few params |
| `compare-tenants` | Compare resources between two tenants |
| `inventory` | Full resource count table for a namespace |

---

## Example Interactions

Once connected, just ask in plain language:

**Inventory and inspection:**
- *"List all namespaces in my XC tenant"*
- *"Show me all HTTP load balancers in the default namespace"*
- *"Get the full config of my load balancer named prod-web"*

**Auditing:**
- *"Which origin pools aren't used by any load balancer?"*
- *"Show me orphaned objects in my tenant"*

**Creating resources:**
- *"Create an HTTPS load balancer for app.example.com with a WAF and origin at 10.0.0.1:8080"*
- *"Generate a self-signed certificate for api.example.com"*

**Multi-tenant:**
- *"Compare load balancers between prod and dev"*

## API Categories

The server indexes 1,764 operations across these categories:

| Category | Description |
|----------|-------------|
| AI/ML | AI assistant and ML data endpoints |
| API Security | API definitions, discovery, groups, endpoints |
| Billing | Usage and billing |
| Bot Protection | Bot defense and client-side defense |
| Certificates | Certificate and CA list management |
| Cloud Sites | AWS VPC/TGW, Azure VNET, GCP VPC, AppStack sites |
| DDoS Protection | DDoS mitigation and fast ACLs |
| DNS | DNS zones, domains, load balancers |
| IAM | Users, roles, API credentials, tenants |
| Load Balancing | HTTP/TCP load balancers, origin pools, healthchecks |
| Monitoring | Alerts, logs, audit |
| Networking | Virtual networks, network policies, BGP, tunnels |
| Operations | Stored objects, secrets, terraform, introspection |
| Security | App firewalls, service policies, rate limiters |
| Support | Support tickets |

## Development

```bash
npm install              # Install dependencies
npm run download-specs   # Download 268 OpenAPI specs from F5
npm run build:index      # Parse specs into searchable index
npm run build:ts         # Compile TypeScript
npm run build            # All of the above
npm test                 # Run 523 unit tests
npm run test:watch       # Run tests in watch mode
```

### Live tenant smoke test

`scripts/smoke-test.ts` exercises the four 0.2.0 tools (`xc_query_access_logs`, `xc_lb_wait_ready`, `xc_diff_resource`, `xc_patch_resource`) against a real XC tenant. Reads the same env vars as the server.

```bash
# Read-only checks against an existing HTTP LB
XC_API_TOKEN=... XC_TENANT_URL=... \
  npx tsx scripts/smoke-test.ts <namespace> <lb_name>

# Include the patch path (adds a temporary label, verifies it, removes it)
XC_API_TOKEN=... XC_TENANT_URL=... \
  npx tsx scripts/smoke-test.ts <namespace> <lb_name> --allow-mutations

# Multi-tenant
npx tsx scripts/smoke-test.ts <namespace> <lb_name> --tenant prod
```

## Architecture

At build time, 268 OpenAPI spec files are parsed into a searchable index with O(1) operation lookup. At runtime, schemas are resolved on demand from the original spec files with configurable depth and optional summarization. Common resource types return pre-built templates instead of full schemas.

All API calls go through a shared HTTP client that handles auth headers, request timeouts (30s), and response truncation (50KB for `xc_call_api`, unlimited for list tools that do their own extraction). Non-2xx responses carry an `error_category` field (`auth_failure`, `permission_denied`, `not_found`, `timeout`, `config_conflict`, `rate_limited`, `validation_error`, `backend_unavailable`, `server_error`) so callers can branch on the category without parsing the body. Private keys are always blindfold-encrypted using the tenant's RSA public key before transmission.

The server runs as either a stdio subprocess (for Claude Code) or an HTTP server with session management and 30-minute idle cleanup (for ChatGPT). The Docker image runs as a non-root user. Its health check calls `/healthz` in HTTP mode.

On startup, the server checks GitHub for newer releases and logs a notice if an update is available. The version is also shown in `xc_list_tenants` output.
