import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodePemFields } from "../lib/pem-encoding.js";
import type { TenantConfig } from "../types/index.js";

// Mock the blindfold module
vi.mock("../lib/blindfold.js", () => ({
  fetchBlindfoldParams: vi.fn().mockResolvedValue({
    policyId: 1,
    tenant: "test-tenant",
    keyVersion: 1,
    modulusBase64: Buffer.alloc(256, 0xff).toString("base64"),
    exponentBase64: "AQAB",
  }),
  blindfoldEncrypt: vi.fn().mockReturnValue("BLINDFOLDED_BASE64_DATA"),
}));

import { fetchBlindfoldParams, blindfoldEncrypt } from "../lib/blindfold.js";

const mockFetchBlindfoldParams = fetchBlindfoldParams as ReturnType<typeof vi.fn>;
const mockBlindfoldEncrypt = blindfoldEncrypt as ReturnType<typeof vi.fn>;

const RAW_PEM = `-----BEGIN CERTIFICATE-----
MIIBxTCCAWugAwIBAgIJALc0fW1234567
-----END CERTIFICATE-----`;

const RAW_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAHudeSA/x3hB2f
-----END RSA PRIVATE KEY-----`;

const ENCODED_PEM = `string:///${Buffer.from(RAW_PEM).toString("base64")}`;

const CERT_PATH = "/api/config/namespaces/default/certificates";

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

describe("encodePemFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encodes raw PEM in certificate_url", async () => {
    const body = { spec: { certificate_url: RAW_PEM } };
    const result = (await encodePemFields(config, CERT_PATH, body)) as any;
    expect(result.spec.certificate_url).toBe(ENCODED_PEM);
  });

  it("blindfold-encrypts raw PEM private key in clear_secret_info.url", async () => {
    const body = {
      spec: {
        private_key: { clear_secret_info: { url: RAW_KEY_PEM } },
      },
    };
    const result = (await encodePemFields(config, CERT_PATH, body)) as any;

    // clear_secret_info should be removed
    expect(result.spec.private_key.clear_secret_info).toBeUndefined();

    // blindfold_secret_info.location should be set
    expect(result.spec.private_key.blindfold_secret_info.location).toBe(
      "string:///BLINDFOLDED_BASE64_DATA",
    );

    // Verify blindfold functions were called
    expect(mockFetchBlindfoldParams).toHaveBeenCalledWith(
      config.tenantUrl,
      config.apiToken,
    );
    expect(mockBlindfoldEncrypt).toHaveBeenCalledWith(RAW_KEY_PEM, expect.any(Object));
  });

  it("blindfold-encrypts raw PEM in blindfold_secret_info.location", async () => {
    const body = {
      spec: {
        private_key: { blindfold_secret_info: { location: RAW_KEY_PEM } },
      },
    };
    const result = (await encodePemFields(config, CERT_PATH, body)) as any;

    expect(result.spec.private_key.blindfold_secret_info.location).toBe(
      "string:///BLINDFOLDED_BASE64_DATA",
    );
    expect(mockBlindfoldEncrypt).toHaveBeenCalledWith(RAW_KEY_PEM, expect.any(Object));
  });

  it("leaves already-encoded string:/// values alone", async () => {
    const body = { spec: { certificate_url: ENCODED_PEM } };
    const result = (await encodePemFields(config, CERT_PATH, body)) as any;
    expect(result.spec.certificate_url).toBe(ENCODED_PEM);
  });

  it("leaves already-encoded blindfold_secret_info alone", async () => {
    const body = {
      spec: {
        private_key: {
          blindfold_secret_info: { location: "string:///already-encoded" },
        },
      },
    };
    const result = (await encodePemFields(config, CERT_PATH, body)) as any;
    expect(result.spec.private_key.blindfold_secret_info.location).toBe(
      "string:///already-encoded",
    );
    expect(mockFetchBlindfoldParams).not.toHaveBeenCalled();
  });

  it("returns body unchanged for non-certificate paths", async () => {
    const body = { spec: { certificate_url: RAW_PEM } };
    const result = await encodePemFields(
      config,
      "/api/config/namespaces/default/http_loadbalancers",
      body,
    );
    expect(result).toBe(body);
  });

  it("handles missing/undefined fields without errors", async () => {
    expect(await encodePemFields(config, CERT_PATH, {})).toEqual({});
    expect(await encodePemFields(config, CERT_PATH, { spec: {} })).toEqual({
      spec: {},
    });
    expect(
      await encodePemFields(config, CERT_PATH, { spec: { private_key: {} } }),
    ).toEqual({ spec: { private_key: {} } });
    expect(await encodePemFields(config, CERT_PATH, null)).toBeNull();
    expect(await encodePemFields(config, CERT_PATH, undefined)).toBeUndefined();
  });

  it("works for certificate_chains paths", async () => {
    const body = { spec: { certificate_url: RAW_PEM } };
    const result = (await encodePemFields(
      config,
      "/api/config/namespaces/default/certificate_chains",
      body,
    )) as any;
    expect(result.spec.certificate_url).toBe(ENCODED_PEM);
  });

  it("does not mutate the original body", async () => {
    const body = { spec: { certificate_url: RAW_PEM } };
    await encodePemFields(config, CERT_PATH, body);
    expect(body.spec.certificate_url).toBe(RAW_PEM);
  });

  it("does not call blindfold for non-private-key PEM in clear_secret_info", async () => {
    // A certificate PEM (not a private key) in clear_secret_info — shouldn't blindfold
    const body = {
      spec: {
        private_key: { clear_secret_info: { url: RAW_PEM } },
      },
    };
    await encodePemFields(config, CERT_PATH, body);
    expect(mockFetchBlindfoldParams).not.toHaveBeenCalled();
  });
});
