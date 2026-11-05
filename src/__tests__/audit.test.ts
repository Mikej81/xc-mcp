import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createHttpHandler } from "../http.js";
import { loadIndex } from "../lib/spec-index.js";
import { credentialFingerprint } from "../lib/hosted.js";
import { parseResourcePath } from "../lib/audit.js";
import { callApi } from "../lib/api-client.js";
import type { ServerConfig } from "../types/index.js";
import { startTestServer, mcpRequest } from "./helpers/mcp-client.js";

vi.mock("node:child_process", async () => {
  const { writeFileSync } = await import("node:fs");
  return {
    execFileSync: vi.fn((_file: string, args: string[]) => {
      // Stand-in for openssl req: write a key and cert to the given paths.
      writeFileSync(args[args.indexOf("-keyout") + 1], "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
      writeFileSync(args[args.indexOf("-out") + 1], "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n");
      return Buffer.alloc(0);
    }),
  };
});

vi.mock("../lib/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/version.js")>();
  return { ...actual, checkForUpdate: async () => ({ updateAvailable: false, current: actual.VERSION, latest: null }) };
});

const indexPath = join(__dirname, "../../data/operations-index.json");
const specsDir = join(__dirname, "../../f5-api");
const ACME = "https://acme.console.ves.volterra.io";
const TOKEN = "audit-secret-token";

const localConfig = (): ServerConfig => ({
  tenants: [{ name: "default", apiToken: TOKEN, tenantUrl: ACME, defaultNamespace: "default" }],
  specsDir, indexPath, mode: "local", readOnly: false,
});
const hostedConfig = (): ServerConfig => ({
  tenants: [], specsDir, indexPath, mode: "hosted", readOnly: false,
  hosted: { allowedDomains: [".console.ves.volterra.io"], maxSessions: 500, maxSessionsPerCredential: 5, evictMinIdleMs: 300_000 },
});
const initBody = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
const b64 = (u: string) => Buffer.from(u, "base64url").toString("base64");
const BLINDFOLD: Record<string, unknown> = {
  "/api/secret_management/namespaces/shared/secret_policys/ves-io-allow-volterra/get_policy_document": { data: { policy_id: 1, tenant: "acme" } },
  "/api/secret_management/get_public_key": { data: { modulus_base64: b64(jwk.n), public_exponent_base64: b64(jwk.e) } },
};

let upstreamFail: false | "network" | "timeout" = false;
const prevLevel = process.env.MCP_LOG_LEVEL;
beforeAll(() => {
  process.env.MCP_LOG_LEVEL = "info";
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    if (upstreamFail === "network") throw new TypeError("fetch failed");
    if (upstreamFail === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const bf = BLINDFOLD[new URL(String(input)).pathname];
    if (bf) return new Response(JSON.stringify(bf), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ items: [], metadata: { name: "web" }, spec: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (prevLevel === undefined) delete process.env.MCP_LOG_LEVEL;
  else process.env.MCP_LOG_LEVEL = prevLevel;
});

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  upstreamFail = false;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const auditLines = () =>
  lines.flatMap((l) => l.split("\n")).filter(Boolean).filter((l) => l.includes('"evt":"audit"')).map((l) => JSON.parse(l));

async function session(config: ServerConfig, headers: Record<string, string> = {}) {
  const h = createHttpHandler(config, loadIndex(indexPath), { enabled: false });
  const srv = await startTestServer(h.handler);
  const init = await mcpRequest(srv.port, { method: "POST", body: initBody, headers });
  const sid = init.headers["mcp-session-id"] as string;
  const hh = { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
  await mcpRequest(srv.port, { method: "POST", headers: hh, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  let id = 100;
  return {
    sid,
    call: async (name: string, args: unknown) => {
      const r = await mcpRequest(srv.port, { method: "POST", headers: hh, body: { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } } });
      return (r.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    },
    done: async () => { await h.close(); await srv.stop(); },
  };
}

describe("parseResourcePath", () => {
  it("parses namespaced item and collection paths", () => {
    expect(parseResourcePath("/api/config/namespaces/prod/http_loadbalancers/web")).toEqual({ namespace: "prod", resource_type: "http_loadbalancers", name: "web" });
    expect(parseResourcePath("/api/config/namespaces/prod/http_loadbalancers")).toEqual({ namespace: "prod", resource_type: "http_loadbalancers" });
    expect(parseResourcePath("/api/web/namespaces")).toEqual({ resource_type: "namespaces" });
    expect(parseResourcePath("/api/web/namespaces/team-a")).toEqual({ resource_type: "namespaces", name: "team-a" });
    expect(parseResourcePath("/api/other")).toEqual({});
  });

  it("parses a namespace action such as cascade_delete", () => {
    expect(parseResourcePath("/api/web/namespaces/team-a/cascade_delete")).toEqual({ resource_type: "namespaces", name: "team-a", action: "cascade_delete" });
  });
});

describe("audit log", () => {
  it("xc_patch_resource writes one PUT audit line (local caller_id is the tenant name)", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      await s.call("xc_patch_resource", { resource: "http_loadbalancers/default/web", ops: [{ op: "replace", path: "/spec/x", value: 1 }] });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        level: "info", tool: "xc_patch_resource", method: "PUT",
        path: "/api/config/namespaces/default/http_loadbalancers/web",
        namespace: "default", resource_type: "http_loadbalancers", name: "web",
        status: 200, caller_id: "default", session_id: s.sid.slice(0, 8), tenant_host: "acme.console.ves.volterra.io",
      });
      expect(typeof a[0].duration_ms).toBe("number");
    } finally { await s.done(); }
  });

  it("xc_call_api POST is audited, GET is not; hosted caller_id is the fingerprint prefix; no secrets or query", async () => {
    const creds = { "x-xc-tenant-url": ACME, "x-xc-tenant-token": TOKEN };
    const s = await session(hostedConfig(), creds);
    try {
      lines = [];
      await s.call("xc_call_api", { method: "POST", path: "/api/config/namespaces/default/healthchecks?x=1", body: { secretbody: "zzz" } });
      await s.call("xc_call_api", { method: "GET", path: "/api/config/namespaces/default/healthchecks" });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ tool: "xc_call_api", method: "POST", path: "/api/config/namespaces/default/healthchecks", status: 200 });
      expect(a[0].caller_id).toBe(credentialFingerprint({ name: "x", apiToken: TOKEN, tenantUrl: ACME }).slice(0, 8));
      const raw = JSON.stringify(a);
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain("secretbody");
      expect(raw).not.toContain("?");
    } finally { await s.done(); }
  });

  it("xc_query_access_logs (POST, read-only tool) is not audited", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      await s.call("xc_query_access_logs", { namespace: "default", lb_name: "web" });
      expect(auditLines()).toEqual([]);
    } finally { await s.done(); }
  });

  it("a network failure is audited with status 0", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      upstreamFail = "network";
      await s.call("xc_call_api", { method: "DELETE", path: "/api/config/namespaces/default/healthchecks/x" });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ method: "DELETE", status: 0 });
    } finally { await s.done(); }
  });

  it("a write that times out is audited with status 408", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      upstreamFail = "timeout";
      await s.call("xc_call_api", { method: "POST", path: "/api/web/namespaces", body: { metadata: { name: "x" } } });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ method: "POST", status: 408, resource_type: "namespaces" });
    } finally { await s.done(); }
  });

  it("audit lines are written even when MCP_LOG_LEVEL=error", async () => {
    const s = await session(localConfig());
    try {
      process.env.MCP_LOG_LEVEL = "error";
      lines = [];
      await s.call("xc_patch_resource", { resource: "http_loadbalancers/default/web", ops: [{ op: "replace", path: "/spec/x", value: 1 }] });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ level: "info", evt: "audit", tool: "xc_patch_resource", method: "PUT" });
    } finally {
      process.env.MCP_LOG_LEVEL = "info";
      await s.done();
    }
  });

  it("POST cascade_delete on a namespace records the action", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      await s.call("xc_call_api", { method: "POST", path: "/api/web/namespaces/team-a/cascade_delete", body: { name: "team-a" } });
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ resource_type: "namespaces", name: "team-a", action: "cascade_delete" });
      expect(a[0].namespace).toBeUndefined();
    } finally { await s.done(); }
  });

  it("xc_create_cert writes exactly one audit line, for its POST", async () => {
    const s = await session(localConfig());
    try {
      lines = [];
      const r = await s.call("xc_create_cert", { name: "c1", namespace: "default", domain: "app.example.com" });
      expect(r.isError).toBeFalsy();
      const a = auditLines();
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        tool: "xc_create_cert", method: "POST", path: "/api/config/namespaces/default/certificates",
        namespace: "default", resource_type: "certificates", status: 200,
      });
    } finally { await s.done(); }
  });

  it("callApi without a call context does not audit", async () => {
    await callApi({ name: "default", apiToken: TOKEN, tenantUrl: ACME }, "POST", "/api/config/namespaces/default/healthchecks", { body: {} });
    expect(auditLines()).toEqual([]);
  });
});
