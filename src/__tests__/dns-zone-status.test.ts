import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api-client.js", () => ({ callApi: vi.fn() }));

import { handleDnsZoneStatus } from "../tools/dns-zone-status.js";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const config: TenantConfig = { name: "test", apiToken: "tok", tenantUrl: "https://t.ves.volterra.io" };

describe("handleDnsZoneStatus", () => {
  beforeEach(() => { mockCallApi.mockReset(); });

  it("returns a summary combining config, deployment_status, and data-plane reachability", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        spec: { domain: "example.com" },
        status: [{
          verification_status: {
            deployment_status: "DNS_ZONE_ACTIVE",
            volterra_nameservers: ["ns1.f5cloud.io", "ns2.f5cloud.io"],
          },
          conditions: [{ type: "Operational", status: "True", reason: "Complete" }],
        }],
      },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: { zone_file: "$ORIGIN example.com.\n..." } });

    const result = await handleDnsZoneStatus(config, {
      namespace: "system",
      name: "example.com",
      include_zone_file: true,
    });

    const text = result.content[0].text;
    expect(text).toContain("example.com");
    expect(text).toContain("DNS_ZONE_ACTIVE");
    expect(text).toContain("ns1.f5cloud.io");
    expect(text).toContain("data_plane_reachable");
  });

  it("flags a probe mismatch when control plane reports ACTIVE but data-plane fetch fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { status: [{ verification_status: { deployment_status: "DNS_ZONE_ACTIVE" } }] },
    });
    mockCallApi.mockResolvedValueOnce({ status: 503, statusText: "Service Unavailable", headers: {}, body: {} });

    const result = await handleDnsZoneStatus(config, {
      namespace: "system", name: "example.com", include_zone_file: true,
    });
    const text = result.content[0].text;
    expect(text).toContain("control_plane_active_but_data_plane_unreachable");
  });

  it("returns an isError when the zone GET fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 404, statusText: "Not Found", headers: {}, body: { error: "no such zone" },
    });

    const result = await handleDnsZoneStatus(config, {
      namespace: "system", name: "missing.com", include_zone_file: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  it("skips the data-plane probe when include_zone_file is false", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { status: [{ verification_status: { deployment_status: "DNS_ZONE_ACTIVE" } }] },
    });

    await handleDnsZoneStatus(config, {
      namespace: "system", name: "example.com", include_zone_file: false,
    });
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });

  it("handles an empty status array without erroring", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { spec: { domain: "newzone.com" }, status: [] },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: { zone_file: "" } });

    const result = await handleDnsZoneStatus(config, {
      namespace: "system", name: "newzone.com", include_zone_file: true,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.domain).toBe("newzone.com");
    expect(parsed.deployment_status).toBeUndefined();
    expect(parsed.operational_condition).toBeNull();
    expect(parsed.nameservers).toEqual([]);
    expect(parsed.flags).toEqual([]);
  });
});
