import { describe, it, expect, vi } from "vitest";
import { handleListNamespaces } from "../tools/list-namespaces.js";
import type { TenantConfig } from "../types/index.js";

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../lib/api-client.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

describe("handleListNamespaces", () => {
  it("returns namespace list for 200 with items", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [
          { name: "default", description: "Default namespace" },
          { name: "staging" },
        ],
      },
    });

    const result = await handleListNamespaces(config);
    const text = result.content[0].text;
    expect(text).toContain("Found 2 namespaces");
    expect(text).toContain("default");
    expect(text).toContain("Default namespace");
    expect(text).toContain("staging");
  });

  it("falls back to metadata.name for item name", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [{ metadata: { name: "from-metadata" } }],
      },
    });

    const result = await handleListNamespaces(config);
    expect(result.content[0].text).toContain("from-metadata");
  });

  it("falls back to spec.description for description", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [{ name: "ns1", spec: { description: "From spec" } }],
      },
    });

    const result = await handleListNamespaces(config);
    expect(result.content[0].text).toContain("From spec");
  });

  it("returns warning for empty items", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [] },
    });

    const result = await handleListNamespaces(config);
    expect(result.content[0].text).toContain("No namespaces found");
  });

  it("returns error message for non-200 response", async () => {
    mockCallApi.mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      headers: {},
      body: { message: "access denied" },
    });

    const result = await handleListNamespaces(config);
    const text = result.content[0].text;
    expect(text).toContain("Error listing namespaces");
    expect(text).toContain("403");
    expect(result.isError).toBe(true);
  });
});
