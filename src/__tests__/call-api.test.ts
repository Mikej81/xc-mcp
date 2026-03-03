import { describe, it, expect, vi } from "vitest";
import { handleCallApi } from "../tools/call-api.js";
import type { TenantConfig } from "../types/index.js";

// Mock the api-client module
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

describe("handleCallApi", () => {
  it("returns JSON with status and body for successful response", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: { items: [{ name: "lb1" }] },
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.body.items).toHaveLength(1);
  });

  it("includes warning when response was truncated", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "truncated data",
      truncated: true,
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain("truncated");
  });

  it("forwards params to callApi correctly", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: {},
    });

    await handleCallApi(config, {
      method: "POST",
      path: "/api/{ns}/items",
      path_params: { ns: "default" },
      query_params: { limit: "10" },
      body: { name: "new-item" },
    });

    expect(mockCallApi).toHaveBeenCalledWith(config, "POST", "/api/{ns}/items", {
      pathParams: { ns: "default" },
      queryParams: { limit: "10" },
      body: { name: "new-item" },
    });
  });

  it("truncates output > 60KB", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "x".repeat(70_000),
    });

    const result = await handleCallApi(config, {
      method: "GET",
      path: "/api/test",
    });
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(60_000 + 50);
    expect(text).toContain("[Output truncated]");
  });
});
