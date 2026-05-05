# MCP HTTP Auth + Access Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable header-based authentication and structured per-request access logging to the MCP server's HTTP transport, so the server can be safely deployed publicly behind an F5 XC LB and operators can diagnose request failures from logs.

**Architecture:** Two new helper modules (`src/lib/logger.ts`, `src/lib/auth.ts`) keep concerns separable and unit-testable. The HTTP request handler in `src/index.ts` is wrapped with an auth check (runs before body parsing) and a response-finish listener (writes one structured access-log line per request). Session lifecycle events and startup get migrated to the same structured logger. Stdio transport is untouched.

**Tech Stack:** Node.js 20, TypeScript (ESM, `.js` import suffix convention), vitest for tests, `@modelcontextprotocol/sdk` for transport, `node:crypto` `timingSafeEqual` for constant-time auth compare.

**Spec:** `docs/superpowers/specs/2026-05-05-mcp-http-auth-and-logging-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/logger.ts` | new | Structured JSON-line logger with level filtering. Single export `log(level, evt, fields)`. Reads `MCP_LOG_LEVEL` once at module load. |
| `src/lib/auth.ts` | new | Parses `MCP_AUTH_HEADER_NAME` / `MCP_AUTH_HEADER_VALUE` env vars; performs constant-time header value comparison. No HTTP dependency — pure functions over Node header dicts. |
| `src/index.ts` | modify | Wire auth check + access log + session lifecycle logs into `startHttp`. Migrate startup `console.error` to structured logger. Stdio path unchanged. |
| `src/__tests__/logger.test.ts` | new | Level filtering, JSON shape, non-serializable value safety. |
| `src/__tests__/auth.test.ts` | new | `parseAuthConfig` (both/neither/one), `checkAuth` (ok / missing / mismatch / case-insensitive header lookup / different-length values). |
| `README.md` | modify | Document the two new env vars and the new `MCP_LOG_LEVEL` knob. |

Note: the spec mentioned a separate `http-auth.test.ts`. Both `auth.test.ts` and what would be in `http-auth.test.ts` are exercises of the same pure functions, so this plan consolidates them into `auth.test.ts`. End-to-end HTTP testing of the integration is covered by manual smoke verification in Task 8.

---

## Task 1: Logger module

**Files:**
- Create: `src/lib/logger.ts`
- Test: `src/__tests__/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/logger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, refreshLogLevel } from "../lib/logger.js";

describe("logger", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalLevel: string | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    originalLevel = process.env.MCP_LOG_LEVEL;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (originalLevel === undefined) delete process.env.MCP_LOG_LEVEL;
    else process.env.MCP_LOG_LEVEL = originalLevel;
    refreshLogLevel();
  });

  it("writes a JSON line with ts, level, evt, and extra fields", () => {
    log("info", "request", { status: 200, duration_ms: 47 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.level).toBe("info");
    expect(parsed.evt).toBe("request");
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBe(47);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops lines below the configured level", () => {
    process.env.MCP_LOG_LEVEL = "warn";
    refreshLogLevel();
    log("info", "ignored");
    log("debug", "ignored");
    log("warn", "kept");
    log("error", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults to info when MCP_LOG_LEVEL is unset", () => {
    delete process.env.MCP_LOG_LEVEL;
    refreshLogLevel();
    log("debug", "dropped");
    log("info", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to info when MCP_LOG_LEVEL is invalid", () => {
    process.env.MCP_LOG_LEVEL = "verbose";
    refreshLogLevel();
    log("debug", "dropped");
    log("info", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("survives non-serializable fields without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log("info", "evt", { circular })).not.toThrow();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.evt).toBe("evt");
    expect(parsed.error).toBe("log_serialize_failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/logger.test.ts`
Expected: FAIL — `Cannot find module '../lib/logger.js'`.

- [ ] **Step 3: Write the logger implementation**

Create `src/lib/logger.ts`:

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function readConfiguredLevel(): LogLevel {
  const raw = (process.env.MCP_LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

let configuredLevel: LogLevel = readConfiguredLevel();

/** Re-read MCP_LOG_LEVEL. Used by tests; not needed in normal runtime. */
export function refreshLogLevel(): void {
  configuredLevel = readConfiguredLevel();
}

export function getConfiguredLevel(): LogLevel {
  return configuredLevel;
}

/**
 * Write one structured JSON line to stderr.
 * Never throws; falls back to a minimal line on serialization failure.
 */
export function log(
  level: LogLevel,
  evt: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;
  const base = { ts: new Date().toISOString(), level, evt };
  let serialized: string;
  try {
    serialized = JSON.stringify({ ...base, ...(fields || {}) });
  } catch {
    serialized = JSON.stringify({ ...base, error: "log_serialize_failed" });
  }
  process.stderr.write(serialized + "\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/logger.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npm test`
Expected: PASS, all prior tests + 5 new logger tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logger.ts src/__tests__/logger.test.ts
git commit -m "feat: structured JSON logger with level filtering"
```

---

## Task 2: Auth config parsing

**Files:**
- Create: `src/lib/auth.ts`
- Test: `src/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAuthConfig } from "../lib/auth.js";

describe("parseAuthConfig", () => {
  it("returns disabled when neither env var is set", () => {
    const cfg = parseAuthConfig({});
    expect(cfg).toEqual({ enabled: false });
  });

  it("returns enabled config when both env vars are set", () => {
    const cfg = parseAuthConfig({
      MCP_AUTH_HEADER_NAME: "X-API-Key",
      MCP_AUTH_HEADER_VALUE: "s3cr3t",
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      // Header name lookups happen against Node's lower-cased header dict.
      expect(cfg.headerName).toBe("x-api-key");
      expect(cfg.headerValue).toBe("s3cr3t");
    }
  });

  it("throws when only the name is set", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_NAME: "X-API-Key" }),
    ).toThrow(/both/i);
  });

  it("throws when only the value is set", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_VALUE: "s3cr3t" }),
    ).toThrow(/both/i);
  });

  it("treats empty string as unset", () => {
    expect(() =>
      parseAuthConfig({ MCP_AUTH_HEADER_NAME: "X-API-Key", MCP_AUTH_HEADER_VALUE: "" }),
    ).toThrow(/both/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/auth.test.ts`
Expected: FAIL — `Cannot find module '../lib/auth.js'`.

- [ ] **Step 3: Write the auth config parser**

Create `src/lib/auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";

export type AuthConfig =
  | { enabled: false }
  | { enabled: true; headerName: string; headerValue: string };

/**
 * Parse MCP_AUTH_HEADER_NAME / MCP_AUTH_HEADER_VALUE from the given env.
 * Both must be set together or both unset; partial config throws.
 * Header name is lower-cased to match Node's incoming header dict.
 */
export function parseAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const name = env.MCP_AUTH_HEADER_NAME?.trim();
  const value = env.MCP_AUTH_HEADER_VALUE;
  const hasName = !!name;
  const hasValue = !!value;
  if (!hasName && !hasValue) return { enabled: false };
  if (hasName !== hasValue) {
    throw new Error(
      "MCP_AUTH_HEADER_NAME and MCP_AUTH_HEADER_VALUE must both be set or both unset",
    );
  }
  return { enabled: true, headerName: name!.toLowerCase(), headerValue: value! };
}

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" };

/**
 * Check the supplied request headers against the configured auth.
 * Always returns ok=true when auth is disabled.
 */
export function checkAuth(
  config: AuthConfig,
  headers: NodeJS.Dict<string | string[]>,
): AuthResult {
  if (!config.enabled) return { ok: true };
  const supplied = headers[config.headerName];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!value) return { ok: false, reason: "missing" };
  if (!constantTimeEqual(value, config.headerValue)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/auth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/__tests__/auth.test.ts
git commit -m "feat: parse MCP_AUTH_HEADER_* env vars into AuthConfig"
```

---

## Task 3: Auth header check

**Files:**
- Modify: `src/__tests__/auth.test.ts`

(`checkAuth` itself was added in Task 2 alongside `parseAuthConfig` because they share types. This task adds its tests.)

- [ ] **Step 1: Append failing tests**

Append to `src/__tests__/auth.test.ts`:

```ts
import { checkAuth } from "../lib/auth.js";

describe("checkAuth", () => {
  it("passes everything when auth is disabled", () => {
    const result = checkAuth({ enabled: false }, {});
    expect(result).toEqual({ ok: true });
  });

  it("returns missing when header is absent", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      {},
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("returns mismatch on wrong value", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "wrong" },
    );
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("returns ok on exact match", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "s3cr3t" },
    );
    expect(result).toEqual({ ok: true });
  });

  it("handles different-length supplied value without throwing", () => {
    expect(() =>
      checkAuth(
        { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
        { "x-api-key": "x" },
      ),
    ).not.toThrow();
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "x" },
    );
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("uses the first value when header is sent as an array", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": ["s3cr3t", "ignored"] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns missing when header value is empty string", () => {
    const result = checkAuth(
      { enabled: true, headerName: "x-api-key", headerValue: "s3cr3t" },
      { "x-api-key": "" },
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/__tests__/auth.test.ts`
Expected: PASS, 12 tests total (5 from Task 2 + 7 new).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/auth.test.ts
git commit -m "test: cover checkAuth match/mismatch/missing paths"
```

---

## Task 4: Wire auth into startHttp

**Files:**
- Modify: `src/index.ts`

The current handler structure is:

```
createServer(async (req, res) => {
  if (url.pathname !== "/mcp") → 404
  if (req.method === "POST") parse body
  if (sessionId && transports.has(sessionId)) dispatch
  if (no session && initialize) create session, dispatch
  → 400 Bad Request
  ...
})
```

We add an auth check at the top, before any of that.

- [ ] **Step 1: Add imports**

Open `src/index.ts`. Find the existing import block at the top (around lines 1–11). Add two new imports immediately after the existing local imports (after the `import { VERSION, checkForUpdate } from "./lib/version.js";` line, around line 26):

```ts
import { parseAuthConfig, checkAuth, type AuthConfig } from "./lib/auth.js";
import { log } from "./lib/logger.js";
```

- [ ] **Step 2: Parse auth config in main()**

Find `main()` (around line 659). Inside `main`, after `const config = validateEnv();` and before `const index = loadIndex(...)`, add:

```ts
  let authConfig: AuthConfig;
  try {
    authConfig = parseAuthConfig();
  } catch (err) {
    console.error(`Fatal: ${(err as Error).message}`);
    process.exit(1);
  }
```

- [ ] **Step 3: Pass authConfig to startHttp**

Update the `startHttp` signature. Find:

```ts
async function startHttp(config: ServerConfig, index: OperationsIndex) {
```

Change to:

```ts
async function startHttp(config: ServerConfig, index: OperationsIndex, authConfig: AuthConfig) {
```

Find the call site at the bottom of `main()`:

```ts
  if (transport === "http") {
    await startHttp(config, index);
  } else {
    await startStdio(config, index);
  }
```

Change to:

```ts
  if (transport === "http") {
    await startHttp(config, index, authConfig);
  } else {
    await startStdio(config, index);
  }
```

- [ ] **Step 4: Insert the auth gate at the top of the request handler**

Find the request handler inside `startHttp`:

```ts
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
```

Immediately after the `/mcp` 404 block, insert the auth check:

```ts
    // Auth gate — must run before body parsing or session lookup.
    const authResult = checkAuth(authConfig, req.headers);
    if (!authResult.ok) {
      const peerIp = req.socket.remoteAddress;
      log("warn", "auth_failed", {
        reason: authResult.reason,
        peer_ip: peerIp,
        expected_header: authConfig.enabled ? authConfig.headerName : undefined,
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
```

- [ ] **Step 5: Update the startup log to record auth status**

Find the existing startup logging in `main()`:

```ts
  console.error(`F5 XC MCP Server v${VERSION} starting...`);
  console.error(`  Tenants: ${config.tenants.map((t) => `${t.name} (${t.tenantUrl})`).join(", ")}`);
  console.error(`  Operations indexed: ${index.totalOperations}`);
  console.error(`  Categories: ${index.categories.length}`);
  console.error(`  Transport: ${transport === "http" ? "HTTP" : "stdio"}`);
```

Replace with:

```ts
  console.error(`F5 XC MCP Server v${VERSION} starting...`);
  log("info", "startup", {
    version: VERSION,
    tenants: config.tenants.map((t) => ({ name: t.name, url: t.tenantUrl })),
    operations_indexed: index.totalOperations,
    categories: index.categories.length,
    transport: transport === "http" ? "http" : "stdio",
    auth_enabled: authConfig.enabled,
    auth_header: authConfig.enabled ? authConfig.headerName : null,
  });
```

(The plain-text "starting..." line is preserved for human readability; everything else moves to structured logging.)

- [ ] **Step 6: Build to verify TypeScript**

Run: `npm run build:ts`
Expected: clean compile, no errors.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS — no behavioral changes to anything covered by tests.

- [ ] **Step 8: Manual smoke test — auth disabled (default)**

In a terminal:

```bash
MCP_TRANSPORT=http VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io node dist/src/index.js &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{}'
kill $SERVER_PID 2>/dev/null
```

Expected: `400` (bad request from session lookup, NOT 401 — auth is disabled). And one `auth_failed` log line should NOT appear in stderr.

- [ ] **Step 9: Manual smoke test — auth enabled**

```bash
MCP_TRANSPORT=http MCP_AUTH_HEADER_NAME=X-API-Key MCP_AUTH_HEADER_VALUE=secret \
  VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io \
  node dist/src/index.js 2> /tmp/mcp.log &
SERVER_PID=$!
sleep 1

# No header → 401
curl -s -o /dev/null -w "no-header: %{http_code}\n" -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{}'

# Wrong value → 401
curl -s -o /dev/null -w "wrong: %{http_code}\n" -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -H "X-API-Key: nope" -d '{}'

# Correct value, but bogus body → 400 (not 401)
curl -s -o /dev/null -w "good-auth: %{http_code}\n" -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -H "X-API-Key: secret" -d '{}'

kill $SERVER_PID 2>/dev/null
grep auth_failed /tmp/mcp.log
```

Expected output:
```
no-header: 401
wrong: 401
good-auth: 400
```
And two `auth_failed` JSON lines in `/tmp/mcp.log` (one with `reason: "missing"`, one with `reason: "mismatch"`).

- [ ] **Step 10: Manual smoke test — partial config refuses to start**

```bash
MCP_TRANSPORT=http MCP_AUTH_HEADER_NAME=X-API-Key \
  VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io \
  node dist/src/index.js
echo "exit=$?"
```

Expected: process exits non-zero with `Fatal: MCP_AUTH_HEADER_NAME and MCP_AUTH_HEADER_VALUE must both be set or both unset`.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts
git commit -m "feat(http): header-based auth gate via MCP_AUTH_HEADER_*"
```

---

## Task 5: Per-request access logging

**Files:**
- Modify: `src/index.ts`

Goal: one structured log line per `/mcp` request, with method, path, status, session id (truncated), peer IP, duration, JSON-RPC method, and tool name. Emitted from `res.on('finish')` so we always capture the final status the SDK transport wrote.

- [ ] **Step 1: Add a small helper for extracting JSON-RPC method/tool name**

In `src/index.ts`, just above the `function createMcpServer(...)` definition (around line 501), add:

```ts
function extractMcpFields(body: unknown): { mcpMethod?: string; toolName?: string } {
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;
  const mcpMethod = typeof obj.method === "string" ? obj.method : undefined;
  let toolName: string | undefined;
  if (mcpMethod === "tools/call" && obj.params && typeof obj.params === "object") {
    const params = obj.params as Record<string, unknown>;
    if (typeof params.name === "string") toolName = params.name;
  }
  return { mcpMethod, toolName };
}
```

- [ ] **Step 2: Wrap the request handler with timing + finish-listener**

Find the `createServer(async (req, res) => { ... })` block. We're going to capture the request start time, the parsed body, and then attach an `'finish'` listener on `res` that writes the access log.

Inside the handler, **after** the `/mcp` 404 check and **before** the auth gate, insert:

```ts
    const startTime = Date.now();
    let parsedBody: unknown = undefined;
    res.on("finish", () => {
      const duration = Date.now() - startTime;
      const status = res.statusCode;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const xff = req.headers["x-forwarded-for"];
      const xffFirst = Array.isArray(xff) ? xff[0] : (typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined);
      const { mcpMethod, toolName } = extractMcpFields(parsedBody);
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      log(level, "request", {
        method: req.method,
        path: url.pathname,
        status,
        session_id: sessionId ? sessionId.slice(0, 8) : undefined,
        peer_ip: req.socket.remoteAddress,
        peer_ip_xff: xffFirst,
        duration_ms: duration,
        mcp_method: mcpMethod,
        tool_name: toolName,
        ...(process.env.MCP_LOG_LEVEL?.toLowerCase() === "debug" && parsedBody !== undefined
          ? { request_body: truncateForLog(parsedBody) }
          : {}),
      });
    });
```

- [ ] **Step 3: Capture parsed body for the finish listener**

Find the existing body parsing block:

```ts
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }
```

After the line `body = JSON.parse(Buffer.concat(chunks).toString());`, add:

```ts
        parsedBody = body;
```

So that closure has visibility into the parsed JSON-RPC envelope when `res.on('finish')` fires.

- [ ] **Step 4: Add the truncate helper**

Just above `extractMcpFields` (the helper added in Step 1), add:

```ts
function truncateForLog(value: unknown, maxBytes = 4096): unknown {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxBytes) return value;
    return { _truncated: true, preview: s.slice(0, maxBytes) };
  } catch {
    return { _truncated: true, error: "stringify_failed" };
  }
}
```

- [ ] **Step 5: Build to verify TypeScript**

Run: `npm run build:ts`
Expected: clean compile.

- [ ] **Step 6: Manual smoke test — request line shape**

```bash
MCP_TRANSPORT=http VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io \
  node dist/src/index.js 2> /tmp/mcp.log &
SERVER_PID=$!
sleep 1

# 400 path — non-init POST without session id
curl -s -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' > /dev/null

kill $SERVER_PID 2>/dev/null
grep '"evt":"request"' /tmp/mcp.log
```

Expected: at least one line containing `"evt":"request"`, `"status":400`, `"mcp_method":"tools/list"`, `"level":"warn"`, and a `duration_ms` field.

- [ ] **Step 7: Manual smoke test — debug mode logs body**

```bash
MCP_TRANSPORT=http MCP_LOG_LEVEL=debug VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io \
  node dist/src/index.js 2> /tmp/mcp.log &
SERVER_PID=$!
sleep 1

curl -s -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' > /dev/null

kill $SERVER_PID 2>/dev/null
grep request_body /tmp/mcp.log
```

Expected: a JSON line that includes a `"request_body"` field carrying the full JSON-RPC envelope.

- [ ] **Step 8: Run unit tests**

Run: `npm test`
Expected: all 162+ tests pass (157 prior + 5 logger + 12 auth = 174).

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat(http): structured per-request access log with tool name"
```

---

## Task 6: Session lifecycle logging

**Files:**
- Modify: `src/index.ts`

Replace the existing free-text session log lines with structured events.

- [ ] **Step 1: Replace the cleanup-interval log line**

Find this block in `startHttp` (around line 533):

```ts
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_IDLE_MS) {
        const transport = transports.get(sid);
        if (transport) {
          transport.close().catch(() => {});
          transports.delete(sid);
        }
        sessionLastActive.delete(sid);
        console.error(`Session ${sid} cleaned up (idle ${Math.round((now - lastActive) / 60000)}m)`);
      }
    }
  }, 60_000);
```

Replace the `console.error(...)` line with:

```ts
        log("info", "session_expired", {
          session_id: sid.slice(0, 8),
          idle_minutes: Math.round((now - lastActive) / 60000),
        });
```

- [ ] **Step 2: Add session_created log on init**

Find the `onsessioninitialized` callback (around line 589):

```ts
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            sessionLastActive.set(sid, Date.now());
          },
        });
```

Change the `onsessioninitialized` body to:

```ts
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            sessionLastActive.set(sid, Date.now());
            log("info", "session_created", { session_id: sid.slice(0, 8) });
          },
```

- [ ] **Step 3: Add session_closed log on transport close**

Find the `transport.onclose` block (around line 595):

```ts
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            sessionLastActive.delete(sid);
          }
        };
```

Change to:

```ts
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            sessionLastActive.delete(sid);
            log("info", "session_closed", { session_id: sid.slice(0, 8) });
          }
        };
```

- [ ] **Step 4: Replace SIGINT shutdown free-text log**

Find:

```ts
  process.on("SIGINT", async () => {
    console.error("Shutting down...");
    clearInterval(cleanupInterval);
    for (const [sid, transport] of transports) {
      await transport.close();
      transports.delete(sid);
    }
    httpServer.close();
    process.exit(0);
  });
```

Change `console.error("Shutting down...");` to:

```ts
    log("info", "shutdown", { reason: "sigint" });
```

- [ ] **Step 5: Replace the listen() banner**

Find:

```ts
  httpServer.listen(port, () => {
    console.error(`F5 XC MCP Server running on http://localhost:${port}/mcp`);
  });
```

Keep the human-readable line but add a structured event:

```ts
  httpServer.listen(port, () => {
    console.error(`F5 XC MCP Server running on http://localhost:${port}/mcp`);
    log("info", "http_listening", { port, path: "/mcp" });
  });
```

- [ ] **Step 6: Build**

Run: `npm run build:ts`
Expected: clean compile.

- [ ] **Step 7: Manual smoke test — session lifecycle**

```bash
MCP_TRANSPORT=http VOLT_API_TOKEN=dummy VOLT_API_URL=https://example.console.ves.volterra.io \
  node dist/src/index.js 2> /tmp/mcp.log &
SERVER_PID=$!
sleep 1

# Initialize a real MCP session
curl -s -D /tmp/headers.txt -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  > /dev/null
SESSION=$(grep -i mcp-session-id /tmp/headers.txt | awk '{print $2}' | tr -d '\r')

# Tear it down
curl -s -X DELETE http://localhost:3000/mcp -H "mcp-session-id: $SESSION" > /dev/null

kill $SERVER_PID 2>/dev/null
grep -E '"evt":"(session_created|session_closed|http_listening)"' /tmp/mcp.log
```

Expected: lines for `http_listening`, `session_created` (with the first 8 chars of `$SESSION`), and `session_closed`.

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat(http): structured session lifecycle log events"
```

---

## Task 7: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the configuration section**

Open `README.md`. Find the section that documents environment variables (search for `VOLT_API_TOKEN` or `MCP_TRANSPORT`).

- [ ] **Step 2: Add the auth env vars**

Add a subsection (or rows in the env-var table — match the existing convention) documenting:

```
MCP_AUTH_HEADER_NAME   Optional. Name of the auth header the server requires
                       on every /mcp request (e.g. X-API-Key). Must be set
                       together with MCP_AUTH_HEADER_VALUE; setting only one
                       is a fatal startup error. When unset, no auth is
                       enforced (default; backward compatible).

MCP_AUTH_HEADER_VALUE  Optional. Expected value for the auth header. Compared
                       with constant-time equality. Use F5 XC secret
                       management or the host orchestrator's secret store to
                       inject this — do not bake it into the image.

MCP_LOG_LEVEL          Optional. One of debug | info | warn | error. Default
                       info. At debug, each access-log line includes the
                       parsed JSON-RPC request body (capped at 4 KB). Response
                       bodies are never logged.
```

- [ ] **Step 3: Add a brief "HTTP transport security" note**

Add a short paragraph (under the HTTP transport section, or wherever HTTP is first mentioned):

> When deploying the HTTP transport publicly (e.g. behind an F5 XC load balancer), set `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE` so unauthenticated callers receive a `401`. Configure your client (e.g. Bifrost) to send the matching header on every request. The check runs before body parsing, so failed-auth requests never create a session.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document MCP_AUTH_HEADER_* and MCP_LOG_LEVEL"
```

---

## Task 8: Final verification + deploy notes

**Files:** none modified.

- [ ] **Step 1: Full test run**

Run: `npm test`
Expected: 174+ tests pass (157 prior + 5 logger + 12 auth).

- [ ] **Step 2: Type-check the whole tree**

Run: `npm run build:ts`
Expected: clean compile.

- [ ] **Step 3: Build the index + binary**

Run: `npm run build`
Expected: clean. (This re-downloads specs and rebuilds the operations index; should match the prior CI output.)

- [ ] **Step 4: Confirm the commit log**

Run: `git log --oneline -7`
Expected (newest first):
```
docs: document MCP_AUTH_HEADER_* and MCP_LOG_LEVEL
feat(http): structured session lifecycle log events
feat(http): structured per-request access log with tool name
feat(http): header-based auth gate via MCP_AUTH_HEADER_*
test: cover checkAuth match/mismatch/missing paths
feat: parse MCP_AUTH_HEADER_* env vars into AuthConfig
feat: structured JSON logger with level filtering
```

- [ ] **Step 5: Write a deploy note**

Add a short post-merge checklist to the PR description (or a follow-up issue):

1. Bump container image tag.
2. Add `MCP_AUTH_HEADER_NAME` / `MCP_AUTH_HEADER_VALUE` to the vk8s workload env (use XC secret-backed env).
3. Update Bifrost connector "Headers" auth with the same name/value.
4. After traffic resumes, grep stderr in any pod for `evt=request status:400` to identify what shape of request is failing — feed findings back to spec rollout step 4.

---

## Self-review checklist (pre-handoff)

- [x] Spec coverage: header auth (Task 4), tool-aware access logging (Task 5), session lifecycle logging (Task 6), README (Task 7), unit tests for logger (Task 1) and auth (Tasks 2–3). Startup migration covered in Task 4 step 5.
- [x] No placeholders, no "TBD", no "implement appropriate error handling" hand-waving — every code step shows the actual code.
- [x] Type consistency: `AuthConfig`, `AuthResult`, `LogLevel`, and the `log(level, evt, fields)` signature are referenced identically across tasks.
- [x] File paths exact; line-number references are approximate ("around line N") because the file will shift as tasks land.
