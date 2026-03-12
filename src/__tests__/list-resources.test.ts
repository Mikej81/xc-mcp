import { describe, it, expect, vi } from "vitest";
import { handleListResources } from "../tools/list-resources.js";
import { resolveNamespace } from "../lib/tenant.js";
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

const configWithDefault: TenantConfig = {
  ...config,
  defaultNamespace: "my-default",
};

describe("handleListResources", () => {
  it("returns resource list for 200 with items", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [
          { name: "lb1" },
          { name: "lb2" },
        ],
      },
    });

    const result = await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
    });
    const text = result.content[0].text;
    expect(text).toContain("Found 2 http_loadbalancers");
    expect(text).toContain("lb1");
    expect(text).toContain("lb2");
  });

  it("shows labels in brackets", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [
          { name: "lb1", labels: { env: "prod", app: "web" } },
        ],
      },
    });

    const result = await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
    });
    const text = result.content[0].text;
    expect(text).toContain("env=prod");
    expect(text).toContain("app=web");
  });

  it("forwards label_selector as query param", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [] },
    });

    await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
      label_selector: "env=prod",
    });

    expect(mockCallApi).toHaveBeenCalledWith(
      config,
      "GET",
      expect.any(String),
      { queryParams: { label_selector: "env=prod" } },
    );
  });

  it("returns empty message when no items found", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [] },
    });

    const result = await handleListResources(config, {
      namespace: "staging",
      resource_type: "origin_pools",
    });
    const text = result.content[0].text;
    expect(text).toContain("No origin_pools found in namespace");
    expect(text).toContain("staging");
  });

  it("returns error message for non-200 response", async () => {
    mockCallApi.mockResolvedValue({
      status: 404,
      statusText: "Not Found",
      headers: {},
      body: { message: "not found" },
    });

    const result = await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
    });
    const text = result.content[0].text;
    expect(text).toContain("Error listing http_loadbalancers");
    expect(text).toContain("404");
    expect(result.isError).toBe(true);
  });

  it("limits items with max_items", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [
          { name: "lb1" },
          { name: "lb2" },
          { name: "lb3" },
          { name: "lb4" },
          { name: "lb5" },
        ],
      },
    });

    const result = await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
      max_items: 2,
    });
    const text = result.content[0].text;
    expect(text).toContain("Found 5 http_loadbalancers");
    expect(text).toContain("showing 2 of 5");
    expect(text).toContain("lb1");
    expect(text).toContain("lb2");
    expect(text).not.toContain("lb3");
  });

  it("extracts specific fields with fields param", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        items: [
          {
            name: "lb1",
            labels: { env: "prod" },
            spec: { origin_servers: [{ addr: "10.0.0.1" }] },
            system_metadata: { creation_timestamp: "2026-01-01" },
          },
        ],
      },
    });

    const result = await handleListResources(config, {
      namespace: "default",
      resource_type: "http_loadbalancers",
      fields: ["spec.origin_servers", "system_metadata.creation_timestamp"],
    });
    const text = result.content[0].text;
    expect(text).toContain("lb1");
    expect(text).toContain("spec.origin_servers");
    expect(text).toContain("10.0.0.1");
    expect(text).toContain("system_metadata.creation_timestamp");
    expect(text).toContain("2026-01-01");
  });
});

describe("namespace resolution with handleListResources", () => {
  it("uses default namespace when none provided", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "res1" }] },
    });

    const ns = resolveNamespace(configWithDefault);
    expect(ns).toBe("my-default");

    const result = await handleListResources(configWithDefault, {
      namespace: ns as string,
      resource_type: "http_loadbalancers",
    });
    const text = result.content[0].text;
    expect(text).toContain("my-default");
    expect(text).toContain("res1");
  });

  it("explicit namespace overrides default", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "res1" }] },
    });

    const ns = resolveNamespace(configWithDefault, "explicit-ns");
    expect(ns).toBe("explicit-ns");

    const result = await handleListResources(configWithDefault, {
      namespace: ns as string,
      resource_type: "http_loadbalancers",
    });
    const text = result.content[0].text;
    expect(text).toContain("explicit-ns");
  });

  it("returns guidance when no namespace and no default", () => {
    const ns = resolveNamespace(config);
    expect(typeof ns).toBe("object");
    expect((ns as { guidance: string }).guidance).toContain("No namespace was specified");
  });
});
