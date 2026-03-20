# F5 Distributed Cloud (XC) MCP Server

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants access to the full F5 Distributed Cloud API -- 1,764 endpoints across 18 categories. Works with **Claude Code**, **ChatGPT**, and any MCP-compatible client.

## How It Works

Instead of registering thousands of individual tools, this server exposes **6 smart tools** that let an AI discover, explore, and call any F5 XC API endpoint:

| Tool | What It Does |
|------|--------------|
| `xc_discover_apis` | Search/browse API operations by keyword, category, HTTP method |
| `xc_get_operation_details` | Get schema details with `summary_mode` and `max_depth` control |
| `xc_call_api` | Execute any API call with `response_filter` for large responses |
| `xc_list_namespaces` | List namespaces with `prefix` and `label_selector` filtering |
| `xc_list_resources` | List resources with `fields` projection and `max_items` limit |
| `xc_list_tenants` | List configured tenants, server version, and update status |

**Typical workflow:** The AI calls `xc_discover_apis` to find relevant endpoints > `xc_get_operation_details` to understand the schema > `xc_call_api` to make the actual request.

### Token optimization

The server is designed to minimize LLM context consumption:

- **Response filtering:** Use `response_filter` on `xc_call_api` to extract specific fields from large responses — e.g., `"items[].name,items[].labels"` extracts 200 bytes from a 50KB response. Never applied to error responses (4xx/5xx always return the full body).
- **Summary mode:** Use `summary_mode: true` on `xc_get_operation_details` to strip descriptions, examples, and validation rules — ~60% smaller schemas with only types, required fields, enums, and oneof groups.
- **Response schema omitted by default:** `xc_get_operation_details` omits the response schema (which typically duplicates the request schema). Set `include_response_schema: true` to include it.
- **Schema depth control:** Use `max_depth` (up to 10, default 4) to control how deep nested schemas are resolved.
- **Field projection:** Use `fields` on `xc_list_resources` to extract specific per-item data — e.g., `["spec.origin_servers", "system_metadata.creation_timestamp"]`.
- **Namespace filtering:** Use `prefix` on `xc_list_namespaces` to filter by name prefix, reducing output on tenants with 100+ namespaces.
- **Item limits:** Use `max_items` on `xc_list_resources` to cap the number of items returned.
- **Compact output:** All JSON output uses compact serialization (no whitespace), saving ~20% tokens per response.
- **Oneof constraints:** F5 XC `x-ves-oneof-field-*` extensions are preserved in schema output so the LLM knows which fields are mutually exclusive.

## Prerequisites

- An **F5 Distributed Cloud** account
- An **API Token** -- create one in XC Console > Administration > Personal Management > Credentials > "Add Credentials" > select "API Token"
- Your **Tenant URL** -- looks like `https://your-tenant.console.ves.volterra.io` (visible in your browser when logged into XC Console)
- **Docker** (recommended) or **Node.js 20+**

## Transport Modes

The server supports two transport modes:

| Mode | Set via | Used by | How it works |
|------|---------|---------|--------------|
| **stdio** (default) | `MCP_TRANSPORT=stdio` or unset | Claude Code | Client spawns the server as a subprocess, communicates over stdin/stdout |
| **http** | `MCP_TRANSPORT=http` | ChatGPT, remote clients | Server listens on HTTP (default port 3000), clients connect to `/mcp` |

---

## Setup: Claude Code

Claude Code uses **stdio** mode. It launches the server as a subprocess -- no ports, no background processes.

### Option A: Docker (recommended)

```bash
# 1. Authenticate with GHCR (one-time setup -- use a GitHub PAT with read:packages scope)
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# 2. Pull the image
docker pull ghcr.io/mikej81/xc-mcp:latest

# 3. Register with Claude Code
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_API_TOKEN","-e","XC_TENANT_URL","ghcr.io/mikej81/xc-mcp:latest"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'

# 4. Verify -- start Claude Code and type /mcp
```

Replace `YOUR_API_TOKEN_HERE` with your actual API token, and update the tenant URL.

**What `--scope user` means:** The server will be available in all your Claude Code sessions, not just the current project.

### Option A (alternative): Build Docker image locally

```bash
# 1. Clone and build
git clone https://github.com/Mikej81/xc-mcp.git
cd xc-mcp
docker build -t f5-xc-mcp .

# 2. Register with Claude Code
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_API_TOKEN","-e","XC_TENANT_URL","f5-xc-mcp"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'
```

### Option B: Node.js

```bash
# 1. Build
npm install && npm run build

# 2. Register with Claude Code
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"node","args":["/absolute/path/to/xc-mcp-container/dist/src/index.js"],"env":{"XC_API_TOKEN":"YOUR_API_TOKEN_HERE","XC_TENANT_URL":"https://your-tenant.console.ves.volterra.io"}}'
```

### Option C: Project-scoped config file

Create `.mcp.json` in your project root to share the setup with a team:

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

## Setup: ChatGPT

ChatGPT connects to MCP servers over **HTTP**. You need to run the server where ChatGPT can reach it (a public URL or a tunnel).

### Step 1: Start the server in HTTP mode

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

The server starts on `http://localhost:3000/mcp`.

### Step 2: Expose the server publicly

ChatGPT needs a public HTTPS URL. For development, use a tunnel:

```bash
# Using ngrok
ngrok http 3000

# Using Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3000
```

This gives you a URL like `https://abc123.ngrok.app`.

### Step 3: Connect in ChatGPT

1. Open ChatGPT > **Settings** > **Connectors** > **Advanced settings** > enable **Developer Mode**
2. Go to **Settings** > **Connectors** > click **Create**
3. Enter:
   - **Name:** F5 XC
   - **Description:** F5 Distributed Cloud API
   - **Connector URL:** `https://abc123.ngrok.app/mcp` (your tunnel URL + `/mcp`)
4. Save and start chatting

### Docker Compose (recommended for persistent setup)

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
# Create .env file (git-ignored) with your credentials
echo 'XC_API_TOKEN=your-token' >> .env
echo 'XC_TENANT_URL=https://your-tenant.console.ves.volterra.io' >> .env

docker compose up -d
```

---

## Multiple Tenants

Use named environment variables to configure multiple tenants:

```bash
XC_TENANT_PROD_URL=https://prod.console.ves.volterra.io
XC_TENANT_PROD_TOKEN=your-prod-api-token
XC_TENANT_DEV_URL=https://dev.console.ves.volterra.io
XC_TENANT_DEV_TOKEN=your-dev-api-token
```

The naming convention is `XC_TENANT_<NAME>_URL` and `XC_TENANT_<NAME>_TOKEN`. Both are required for each tenant.

When one tenant is configured, the `tenant` parameter is optional (auto-selected). When multiple tenants are configured, the `tenant` parameter is required -- use `xc_list_tenants` to see available names.

**Claude Code with multiple tenants:**
```bash
claude mcp add-json f5-xc --scope user '{"type":"stdio","command":"docker","args":["run","--rm","-i","-e","XC_TENANT_PROD_URL","-e","XC_TENANT_PROD_TOKEN","-e","XC_TENANT_DEV_URL","-e","XC_TENANT_DEV_TOKEN","ghcr.io/mikej81/xc-mcp:latest"],"env":{"XC_TENANT_PROD_URL":"https://prod.console.ves.volterra.io","XC_TENANT_PROD_TOKEN":"abc123","XC_TENANT_DEV_URL":"https://dev.console.ves.volterra.io","XC_TENANT_DEV_TOKEN":"def456"}}'
```

---

## Default Namespace

Most F5 XC API operations are scoped to a namespace. You can configure a default namespace so you don't have to specify it on every call.

**Single tenant:**
```bash
XC_DEFAULT_NAMESPACE=my-namespace
```

**Multi-tenant:** use `XC_TENANT_<NAME>_DEFAULT_NAMESPACE` per tenant:
```bash
XC_TENANT_PROD_DEFAULT_NAMESPACE=production
XC_TENANT_DEV_DEFAULT_NAMESPACE=dev-sandbox
```

When a default namespace is configured, the `namespace` parameter becomes optional on `xc_list_resources`. An explicit namespace always takes priority over the default. If no namespace is provided and no default is configured, the server returns a guidance message asking the user to specify one.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XC_API_TOKEN` | Yes* | -- | API token (single-tenant mode) |
| `XC_TENANT_URL` | Yes* | -- | Tenant URL (single-tenant mode) |
| `XC_TENANT_<NAME>_URL` | Yes* | -- | Named tenant URL (multi-tenant mode) |
| `XC_TENANT_<NAME>_TOKEN` | Yes* | -- | Named tenant token (multi-tenant mode) |
| `XC_DEFAULT_NAMESPACE` | No | -- | Default namespace (single-tenant mode) |
| `XC_TENANT_<NAME>_DEFAULT_NAMESPACE` | No | -- | Default namespace (multi-tenant mode) |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_HTTP_PORT` | No | `3000` | HTTP port (only used when `MCP_TRANSPORT=http`) |

*Either single-tenant (`XC_API_TOKEN` + `XC_TENANT_URL`) or multi-tenant (`XC_TENANT_<NAME>_URL` + `XC_TENANT_<NAME>_TOKEN`) variables are required.

---

## Example Interactions

Once connected, just ask in plain language:

**Basic inventory:**
- *"List all namespaces in my XC tenant"*
- *"Show me all HTTP load balancers in the default namespace"*
- *"What origin pools exist in namespace default?"*

**Configuration inspection:**
- *"Get the full configuration of my load balancer named 'prod-web'"*
- *"What API endpoints are available for managing DNS zones?"*
- *"Show me the WAF policy attached to my keepalive LB"*

**Cross-referencing and auditing:**
- *"Show me orphaned objects in my tenant"* -- the AI cross-references LBs, origin pools, WAFs, and healthchecks to find unreferenced resources
- *"Which origin pools aren't used by any load balancer?"*
- *"List all load balancers that have no origin pools configured"*

**Configuration changes:**
- *"Add a WAF policy to my existing load balancer"*
- *"Create an HTTP load balancer called my-app that routes to 10.0.0.1:8080"*
- *"Delete the load balancer named 'test-lb' from namespace staging"*

**Multi-tenant:**
- *"Show namespaces in the prod tenant"*
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
npm run build            # All of the above (download + index + compile)
npm test                 # Run unit tests
npm run test:watch       # Run tests in watch mode

# Run in dev mode (no compile step needed)
XC_API_TOKEN=your-token XC_TENANT_URL=https://your-tenant.console.ves.volterra.io npm run dev
```

## Architecture

- **Build time:** `scripts/build-index.ts` parses all 268 OpenAPI spec files > generates `data/operations-index.json` (searchable index with O(1) lookup)
- **Runtime:** Index loads into memory. Full schemas resolved on-demand from original spec files when `xc_get_operation_details` is called (depth-limited `$ref` resolution, configurable via `max_depth`)
- **Auth:** All API calls include `Authorization: APIToken <token>` automatically
- **Certificates:** PEM private keys are automatically blindfold-encrypted via the F5 XC secret management API (RSA+AES-GCM envelope encryption)
- **Safety:** Responses truncated at 50KB to prevent overwhelming the AI context window; `response_filter` extracts specific fields before truncation
- **Token optimization:** Compact JSON output, summary mode for schemas, field projection for lists, namespace prefix filtering
- **Version check:** On startup and via `xc_list_tenants`, the server checks GitHub for newer releases
- **Transports:** stdio (subprocess, used by Claude Code) and Streamable HTTP (remote, used by ChatGPT)
- **Tests:** 154 unit tests across 14 test files
