import { describe, it, expect, vi, afterEach } from "vitest";
import { handleCreateCert } from "../tools/create-cert.js";
import type { TenantConfig } from "../types/index.js";

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

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const mockFetchBlindfold = fetchBlindfoldParams as ReturnType<typeof vi.fn>;
const mockBlindEncrypt = blindfoldEncrypt as ReturnType<typeof vi.fn>;

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
    expect(mockFetchBlindfold).toHaveBeenCalledWith("https://test.ves.volterra.io", "tok");
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
});
