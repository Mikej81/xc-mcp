import { describe, it, expect, vi, afterEach } from "vitest";
import { handleCreateCert } from "../tools/create-cert.js";
import type { TenantConfig } from "../types/index.js";
import { writeFileSync } from "node:fs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_file: string, args: string[]) => {
    // Stand-in for openssl: write the key and cert to the paths it was given.
    writeFileSync(args[args.indexOf("-keyout") + 1], "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
    writeFileSync(args[args.indexOf("-out") + 1], "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n");
    return Buffer.alloc(0);
  }),
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

vi.mock("../lib/blindfold.js", () => ({
  fetchBlindfoldParams: vi.fn().mockResolvedValue({
    policyId: 1,
    tenant: "test-tenant",
    keyVersion: 1,
    modulusBase64: "AAAA",
    exponentBase64: "AQAB",
  }),
  blindfoldEncrypt: vi.fn().mockReturnValue("encrypted-blob-base64"),
}));

import { callApi } from "../lib/api-client.js";
import { fetchBlindfoldParams, blindfoldEncrypt } from "../lib/blindfold.js";
import * as childProcess from "node:child_process";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const mockFetchBlindfold = fetchBlindfoldParams as ReturnType<typeof vi.fn>;
const mockBlindEncrypt = blindfoldEncrypt as ReturnType<typeof vi.fn>;
const mockExecFile = childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>;
const shellExecs = () => [childProcess.execSync, childProcess.exec, childProcess.spawn, childProcess.spawnSync]
  .map((f) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length)
  .reduce((a, b) => a + b, 0);
const ok200 = { status: 200, statusText: "OK", headers: {}, body: { metadata: { name: "c" } } };

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleCreateCert", () => {
  it("creates a certificate with blindfold-encrypted key", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { metadata: { name: "my-cert" } },
    });

    const result = await handleCreateCert(config, {
      name: "my-cert",
      namespace: "default",
      domain: "test.example.com",
    });

    const text = result.content[0].text;
    expect(text).toContain("my-cert");
    expect(text).toContain("default");
    expect(text).toContain("test.example.com");
    expect(text).toContain("blindfold-encrypted");
    expect(result.isError).toBeUndefined();

    // Verify blindfold was called
    expect(mockFetchBlindfold).toHaveBeenCalledWith(expect.objectContaining({
      tenantUrl: "https://test.ves.volterra.io",
      apiToken: "tok",
    }));
    expect(mockBlindEncrypt).toHaveBeenCalled();

    // Verify API call body has blindfold, not clear_secret
    const apiBody = mockCallApi.mock.calls[0][3].body;
    expect(apiBody.spec.private_key.blindfold_secret_info.location).toContain("string:///");
    expect(apiBody.spec.private_key.clear_secret_info).toBeUndefined();
    expect(apiBody.spec.certificate_url).toMatch(/^string:\/\/\//);
  });

  it("returns error on API failure", async () => {
    mockCallApi.mockResolvedValue({
      status: 409,
      statusText: "Conflict",
      headers: {},
      body: { message: "already exists" },
    });

    const result = await handleCreateCert(config, {
      name: "my-cert",
      namespace: "default",
      domain: "test.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("409");
  });

  it("includes LB reference hint in output", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { metadata: { name: "my-cert" } },
    });

    const result = await handleCreateCert(config, {
      name: "my-cert",
      namespace: "prod",
      domain: "app.example.com",
    });

    const text = result.content[0].text;
    expect(text).toContain('"namespace": "prod"');
    expect(text).toContain('"name": "my-cert"');
  });

  it("runs openssl with an args array and no shell", async () => {
    mockCallApi.mockResolvedValue(ok200);
    const result = await handleCreateCert(config, { name: "c", namespace: "default", domain: "app.example.com" });
    expect(result.isError).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExecFile.mock.calls[0];
    expect(file).toBe("openssl");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("/CN=app.example.com");
    expect(opts?.shell).toBeFalsy();
    expect(shellExecs()).toBe(0);
  });

  it("accepts a wildcard domain", async () => {
    mockCallApi.mockResolvedValue(ok200);
    const result = await handleCreateCert(config, { name: "c", namespace: "default", domain: "*.example.com" });
    expect(result.isError).toBeUndefined();
    expect(mockExecFile.mock.calls[0][1]).toContain("/CN=*.example.com");
  });

  it.each([
    'x"; id > /tmp/pwned; echo "',
    "a.example.com/O=evil",
    "$(id).example.com",
    "-bad.example.com",
    "bad-.example.com",
    "a..example.com",
    "*.*.example.com",
    "foo*.example.com",
    "",
    "a".repeat(64) + ".example.com",
    ("a".repeat(60) + ".").repeat(5) + "com",
  ])("rejects invalid domain %j without running anything", async (domain) => {
    const result = await handleCreateCert(config, { name: "c", namespace: "default", domain });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid domain");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(shellExecs()).toBe(0);
    expect(mockFetchBlindfold).not.toHaveBeenCalled();
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});

describe("xc_create_cert schema", () => {
  it("domain schema rejects the injection payload and accepts hostnames", async () => {
    const { CERT_DOMAIN_SCHEMA } = await import("../tools/create-cert.js");
    expect(CERT_DOMAIN_SCHEMA.safeParse('x"; id > /tmp/pwned; echo "').success).toBe(false);
    expect(CERT_DOMAIN_SCHEMA.safeParse("app.example.com").success).toBe(true);
    expect(CERT_DOMAIN_SCHEMA.safeParse("*.example.com").success).toBe(true);
    expect(CERT_DOMAIN_SCHEMA.safeParse(("a".repeat(60) + ".").repeat(5) + "com").success).toBe(false);
  });
});
