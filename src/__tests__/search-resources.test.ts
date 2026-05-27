import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api-client.js", () => ({ callApi: vi.fn() }));

import { handleSearchResources } from "../tools/search-resources.js";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const config: TenantConfig = { name: "test", apiToken: "tok", tenantUrl: "https://t.ves.volterra.io" };

describe("handleSearchResources", () => {
  beforeEach(() => {
    mockCallApi.mockReset();
  });

  it("scans the provided namespaces and returns matches with namespace tags", async () => {
    mockCallApi.mockImplementation((_c: any, _m: any, path: string) => {
      if (path.endsWith("/ns-a/http_loadbalancers")) {
        return Promise.resolve({ status: 200, statusText: "OK", headers: {}, body: { items: [{ name: "alpha" }, { name: "beta" }] } });
      }
      if (path.endsWith("/ns-b/http_loadbalancers")) {
        return Promise.resolve({ status: 200, statusText: "OK", headers: {}, body: { items: [{ name: "gamma" }] } });
      }
      return Promise.resolve({ status: 404, statusText: "Not Found", headers: {}, body: {} });
    });

    const result = await handleSearchResources(config, {
      resource_type: "http_loadbalancers",
      namespaces: ["ns-a", "ns-b"],
    });

    const text = result.content[0].text;
    expect(text).toContain("ns-a/alpha");
    expect(text).toContain("ns-a/beta");
    expect(text).toContain("ns-b/gamma");
  });

  it("filters by substring name_pattern", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { items: [{ name: "prod-lb" }, { name: "staging-lb" }] },
    });

    const result = await handleSearchResources(config, {
      resource_type: "http_loadbalancers",
      namespaces: ["ns-x"],
      name_pattern: "prod",
    });
    const text = result.content[0].text;
    expect(text).toContain("prod-lb");
    expect(text).not.toContain("staging-lb");
  });

  it("falls back to listing namespaces when none provided", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { items: [{ name: "auto-ns" }] },
    });
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { items: [{ name: "lb-from-auto" }] },
    });

    const result = await handleSearchResources(config, { resource_type: "http_loadbalancers" });
    expect(result.content[0].text).toContain("auto-ns/lb-from-auto");
  });

  it("filters by glob name_pattern", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { items: [{ name: "web-prod-1" }, { name: "web-staging-1" }, { name: "api-prod-1" }] },
    });

    const result = await handleSearchResources(config, {
      resource_type: "http_loadbalancers",
      namespaces: ["ns-x"],
      name_pattern: "web-*",
    });
    const text = result.content[0].text;
    expect(text).toContain("web-prod-1");
    expect(text).toContain("web-staging-1");
    expect(text).not.toContain("api-prod-1");
  });
});
