import { describe, it, expect, vi, beforeEach } from "vitest";
import { blindfoldEncrypt, modPow, fetchBlindfoldParams } from "../lib/blindfold.js";
import type { BlindfoldParams } from "../lib/blindfold.js";

const TEST_PARAMS: BlindfoldParams = {
  policyId: 12345,
  tenant: "test-tenant-abc123",
  keyVersion: 1,
  // Small 256-byte (2048-bit) RSA modulus for testing. Not a real key.
  modulusBase64: Buffer.alloc(256, 0xff).toString("base64"),
  exponentBase64: "AQAB", // 65537
};

describe("modPow", () => {
  it("computes 2^10 mod 1000 = 24", () => {
    expect(modPow(2n, 10n, 1000n)).toBe(24n);
  });

  it("computes 3^13 mod 50 = 7", () => {
    // 3^13 = 1594323, 1594323 mod 50 = 23
    expect(modPow(3n, 13n, 50n)).toBe(23n);
  });

  it("returns 0 when mod is 1", () => {
    expect(modPow(5n, 3n, 1n)).toBe(0n);
  });

  it("handles large exponents", () => {
    // Fermat's little theorem: 2^(p-1) mod p = 1 for prime p
    const p = 104729n; // prime
    expect(modPow(2n, p - 1n, p)).toBe(1n);
  });
});

describe("blindfoldEncrypt", () => {
  it("returns a valid base64 string", () => {
    const result = blindfoldEncrypt("test secret", TEST_PARAMS);
    // Should not throw and should be valid base64
    const decoded = Buffer.from(result, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    // Re-encode should match original
    expect(decoded.toString("base64")).toBe(result);
  });

  it("produces a bundle with correct header structure", () => {
    const result = blindfoldEncrypt("my private key", TEST_PARAMS);
    const buf = Buffer.from(result, "base64");

    let offset = 0;

    // version = 0 (uint16)
    expect(buf.readUInt16BE(offset)).toBe(0);
    offset += 2;

    // tenant length (uint16)
    const tenantLen = buf.readUInt16BE(offset);
    offset += 2;
    expect(tenantLen).toBe(Buffer.from(TEST_PARAMS.tenant).length);

    // tenant bytes
    const tenantStr = buf.subarray(offset, offset + tenantLen).toString("utf-8");
    expect(tenantStr).toBe(TEST_PARAMS.tenant);
    offset += tenantLen;

    // key version (uint32)
    expect(buf.readUInt32BE(offset)).toBe(1);
    offset += 4;

    // policy id (uint64 as two uint32)
    const policyHigh = buf.readUInt32BE(offset);
    offset += 4;
    const policyLow = buf.readUInt32BE(offset);
    offset += 4;
    expect(policyHigh * 0x100000000 + policyLow).toBe(12345);

    // algo id (uint8) = 2 (AES256)
    expect(buf.readUInt8(offset)).toBe(2);
    offset += 1;

    // exponent length + data
    const expLen = buf.readUInt32BE(offset);
    offset += 4;
    expect(expLen).toBe(3); // AQAB = 3 bytes
    offset += expLen;

    // modulus length + data
    const modLen = buf.readUInt32BE(offset);
    offset += 4;
    expect(modLen).toBe(256);
    offset += modLen;

    // encrypted key length + data
    const encKeyLen = buf.readUInt32BE(offset);
    offset += 4;
    expect(encKeyLen).toBeGreaterThan(0);
    offset += encKeyLen;

    // remaining bytes are the encrypted message (ciphertext + 16-byte tag)
    const encMsgLen = buf.length - offset;
    // message "my private key" = 14 bytes + 16-byte GCM tag = 30
    expect(encMsgLen).toBe(14 + 16);
  });

  it("produces different output each time (random nonce/key)", () => {
    const a = blindfoldEncrypt("same message", TEST_PARAMS);
    const b = blindfoldEncrypt("same message", TEST_PARAMS);
    expect(a).not.toBe(b);
  });
});

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const errRes = (status: number, statusText: string) => new Response("{}", { status, statusText });

describe("fetchBlindfoldParams", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls correct API endpoints and maps response fields", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonRes({
          data: { policy_id: 42, tenant: "my-tenant" },
        }))
      .mockResolvedValueOnce(jsonRes({
          data: {
            modulus_base64: "bW9kLWRhdGE=",
            public_exponent_base64: "AQAB",
          },
        }));

    vi.stubGlobal("fetch", mockFetch);

    const params = await fetchBlindfoldParams({
      name: "test",
      apiToken: "my-token",
      tenantUrl: "https://test.ves.volterra.io",
    });

    expect(params.policyId).toBe(42);
    expect(params.tenant).toBe("my-tenant");
    expect(params.keyVersion).toBe(1);
    expect(params.modulusBase64).toBe("bW9kLWRhdGE=");
    expect(params.exponentBase64).toBe("AQAB");

    // Verify URLs
    const call1Url = mockFetch.mock.calls[0][0] as string;
    const call2Url = mockFetch.mock.calls[1][0] as string;
    expect(call1Url).toContain("/secret_policys/ves-io-allow-volterra/get_policy_document");
    expect(call2Url).toContain("/secret_management/get_public_key");

    // Verify auth header
    const call1Headers = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(call1Headers.headers.Authorization).toBe("APIToken my-token");
  });

  it("throws on policy fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(errRes(403, "Forbidden"))
      .mockResolvedValueOnce(jsonRes({ data: {} })),
    );

    await expect(
      fetchBlindfoldParams({
        name: "test",
        apiToken: "bad-token",
        tenantUrl: "https://test.ves.volterra.io",
      }),
    ).rejects.toThrow("Failed to fetch policy document");
  });

  it("throws on public key fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonRes({ data: { policy_id: 1, tenant: "t" } }))
      .mockResolvedValueOnce(errRes(500, "Internal Server Error")),
    );

    await expect(
      fetchBlindfoldParams({
        name: "test",
        apiToken: "tok",
        tenantUrl: "https://test.ves.volterra.io",
      }),
    ).rejects.toThrow("Failed to fetch public key");
  });

  it("uses mTLS dispatcher and omits Authorization header for P12 tenants", async () => {
    const stubDispatcher = { stub: "dispatcher" };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonRes({ data: { policy_id: 7, tenant: "t" } }))
      .mockResolvedValueOnce(jsonRes({
          data: { modulus_base64: "bQ==", public_exponent_base64: "AQAB" },
        }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchBlindfoldParams({
      name: "test",
      p12Path: "/tmp/x.p12",
      p12Password: "pw",
      p12Dispatcher: stubDispatcher,
      tenantUrl: "https://test.ves.volterra.io",
    });

    const call1 = mockFetch.mock.calls[0][1] as {
      headers: Record<string, string>;
      dispatcher?: unknown;
    };
    expect(call1.headers.Authorization).toBeUndefined();
    expect(call1.dispatcher).toBe(stubDispatcher);
  });
});
