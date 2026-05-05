# MCP HTTP Transport: Header Auth, Access Logging, Session Lifecycle Logging

**Status:** approved
**Date:** 2026-05-05
**Scope:** `src/index.ts` HTTP transport (`startHttp`) only. Stdio transport unaffected.

## Motivation

The MCP server is being deployed to F5 XC vk8s (7 replicas, one per RE) behind a public HTTP LB (`xc-mcp-myedgedemo-com` in the `m-coleman` namespace) and consumed by Bifrost. Two operational gaps surfaced:

1. **No HTTP authentication.** `/mcp` accepts anyone on the internet who finds the LB. Bifrost's "Headers" auth type lets an operator configure a header name + value, so a header-gate on the server side closes the gap with no client-side complexity.
2. **No request-level visibility.** The server only logs startup, idle-session cleanup, and crashes. When Bifrost gets a 400, the server has no record of what came in. Bifrost is currently seeing a high volume of 400s and the operator has nothing to grep.

Source-IP persistence on the LB plus one-pod-per-RE means a given Bifrost source consistently lands on the same pod, so the in-memory `transports` map is not the cause of the 400s. Externalizing session state is **out of scope** for this change.

## Goals

- Reject unauthenticated callers when an auth header is configured.
- Emit one structured log line per `/mcp` request, including the JSON-RPC method and tool name when present.
- Make session-lifecycle events visible (created, expired, closed) so operators can correlate "session expired" with the next request's 400.
- Backward compatible: when no auth env vars are set, the server behaves exactly as today.

## Non-goals

- Externalized session storage (Redis, sticky cookies, etc.). Source-IP persistence is sufficient given current evidence.
- OAuth, JWT validation, or mTLS. The Bifrost integration only needs a static shared-secret header.
- Per-tenant or per-tool authorization. The header gate is server-wide.
- Changes to stdio transport.

## Design

### 1. Header authentication

Two new env vars, read once at startup in `startHttp`:

| Env var | Purpose | Required |
|---|---|---|
| `MCP_AUTH_HEADER_NAME` | Name of the header Bifrost will send (case-insensitive match). Example: `X-API-Key`. | If either is set, both must be set. |
| `MCP_AUTH_HEADER_VALUE` | Expected secret value. Compared with constant-time equality. | Same. |

Behavior:

- If **neither** is set: auth is disabled. Log `auth: disabled (set MCP_AUTH_HEADER_NAME and MCP_AUTH_HEADER_VALUE to enable)` once at startup. Backward compatible.
- If **exactly one** is set: refuse to start. `process.exit(1)` with a clear message — partial config is almost always a deploy bug.
- If **both** set:
  - Every request to `/mcp` (POST, GET, DELETE) must carry the header with an exact value match.
  - Missing header or wrong value → respond `401` with body `{"error":"unauthorized"}` and content-type `application/json`. (`401` not `403` because the caller can fix it by presenting credentials; not `400` because we want to distinguish "auth failure" from "MCP protocol error" in metrics.)
  - Auth check happens **before** body parsing, session lookup, and JSON-RPC dispatch. Failed auth never consumes the request body or creates a session.
  - Failed auth is logged at `warn` level (see §2) with the peer IP, the header name we expected, and whether the header was missing vs. mismatched (without logging the supplied value).
- Comparison uses `crypto.timingSafeEqual` over equal-length buffers to avoid timing attacks. When buffers differ in length, return false without comparing.

### 2. Tool-aware access logging

One JSON line per `/mcp` request, written to stderr (matches existing `console.error` convention; container log collectors already capture stderr).

Log shape:

```json
{
  "ts": "2026-05-05T14:02:13.412Z",
  "level": "info",
  "evt": "request",
  "method": "POST",
  "path": "/mcp",
  "status": 200,
  "session_id": "a1b2c3d4",
  "peer_ip": "10.1.2.3",
  "duration_ms": 47,
  "mcp_method": "tools/call",
  "tool_name": "xc_call_api"
}
```

Field rules:

- `ts`: ISO-8601 with milliseconds.
- `session_id`: first 8 characters of the session UUID (full UUID is unnecessary for correlation and shorter lines are easier to read). Omitted when no session id was on the request.
- `peer_ip`: `req.socket.remoteAddress`. Note: behind the XC LB this will be the LB's source IP, not Bifrost's. This is a known limitation; recording it anyway is useful for distinguishing LB nodes. If `X-Forwarded-For` is present we log the leftmost value as `peer_ip_xff`. We do **not** treat XFF as authoritative for auth decisions.
- `duration_ms`: wall-clock from request start to response end.
- `mcp_method`: parsed from the JSON-RPC body (`body.method`), only set on POST. Omitted on GET/DELETE/SSE.
- `tool_name`: when `mcp_method == "tools/call"`, set from `body.params.name`. Omitted otherwise.
- `status`: HTTP status code we returned. For requests handed off to the SDK transport, we capture the final status by listening on `res.on('finish')`.

Levels:

- `info` — successful (`status < 400`) requests.
- `warn` — auth failures, 4xx responses, invalid JSON.
- `error` — handler exceptions, 5xx responses.

Verbose mode: when `MCP_LOG_LEVEL=debug`, each line additionally carries `request_body` (the parsed JSON-RPC envelope, capped at 4 KB). Response bodies are **not** logged even in debug — they may contain sensitive data from F5 XC API responses.

### 3. Session lifecycle logging

Replace the existing free-text `console.error` calls in the session-cleanup interval and `transport.onclose` with structured lines:

```json
{ "ts": "...", "level": "info", "evt": "session_created", "session_id": "a1b2c3d4" }
{ "ts": "...", "level": "info", "evt": "session_expired", "session_id": "a1b2c3d4", "idle_minutes": 31 }
{ "ts": "...", "level": "info", "evt": "session_closed", "session_id": "a1b2c3d4" }
```

These let an operator grep for `session_expired` and find the session id, then grep the access log for that prefix to see the next 400 from that source — closing the loop on "did this 400 happen because the session timed out?"

### 4. Logger module

Add a tiny logger in `src/lib/logger.ts` (new file). It exports:

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";
export const log: (level: LogLevel, evt: string, fields?: Record<string, unknown>) => void;
```

Implementation notes:
- Reads `MCP_LOG_LEVEL` once at module load (default `info`). Drops lines below the configured level.
- Writes to `process.stderr` with a trailing newline.
- Never throws; if JSON.stringify fails for any reason, falls back to a plain string.
- Existing startup `console.error` calls in `main()` get migrated to `log("info", "startup", {...})` so all output is structured. The free-text "F5 XC MCP Server v0.2.0 starting..." line stays as a human-friendly first line, but the structured fields move to a separate event.

## Architecture changes

```
HTTP request
  │
  ▼
authMiddleware  ── 401 ────► access log (warn, evt=auth_failed)
  │
  ▼
parse body
  │
  ▼
session dispatch (existing logic)
  │
  ▼
res.on('finish') ──► access log (info|warn|error, evt=request)
```

Files touched:
- `src/index.ts` — wrap the existing `createServer` callback with the auth check and finish-listener; replace cleanup `console.error` calls.
- `src/lib/logger.ts` — new.
- `src/__tests__/logger.test.ts` — new (level filtering, JSON shape).
- `src/__tests__/http-auth.test.ts` — new (401 paths, missing-vs-mismatch, both-or-neither env var validation, timing-safe compare).
- `README.md` — document the new env vars.
- `Dockerfile` — no change. Operator passes env vars at deploy time.

## Error handling

- `MCP_AUTH_HEADER_NAME` set without `MCP_AUTH_HEADER_VALUE` (or vice versa) → log error and `process.exit(1)` at startup.
- Auth failure → 401 JSON body, never reaches the MCP transport.
- JSON parse failure on POST → 400 (existing behavior preserved) but now logged at warn with `evt=invalid_json`.
- Logger throws → swallow and write a fallback line; do not crash the request.

## Testing

Unit tests (vitest, alongside the existing 157):

- `logger.test.ts`
  - JSON shape includes ts/level/evt/fields
  - Filters out lines below configured level
  - Handles non-serializable values gracefully
- `http-auth.test.ts`
  - When neither env var set, request without header is accepted
  - When only one env var set, server start throws
  - When both set, request without header → 401
  - When both set, request with correct header → passes through to MCP dispatch
  - When both set, request with wrong header → 401
  - Constant-time compare handles different-length values without throwing

Manual verification (operator):
- Deploy with new env vars, hit `/mcp` from `curl` without header → 401, log line at warn.
- Hit with correct header but no body → 400, log line shows `mcp_method: undefined`.
- Initialize from a real MCP client → see `session_created` log followed by `request` log with `mcp_method: initialize`.

## Rollout

1. Land the change with auth env vars **unset** by default — backward compatible, no operator action required for existing deployments.
2. Deploy to vk8s with `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE` set in the workload env (use XC secret management for the value).
3. Update Bifrost config to send the matching header.
4. Within first 60 s of real traffic, grep stderr for `evt=request` lines with `status: 400` to identify what shape of request is failing. Decide whether session-resilience changes are needed based on that evidence.

## Open questions deferred

- Whether to add session externalization. Revisit only if logs show 400s that aren't explained by client behavior or idle timeout.
- Whether to expose Prometheus metrics. Not in this change.
- Whether to support multiple valid auth values (key rotation). Single value is sufficient for now; rotation is a redeploy.
