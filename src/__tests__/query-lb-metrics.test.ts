import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api-client.js", () => ({ callApi: vi.fn() }));

import { handleQueryLbMetrics } from "../tools/query-lb-metrics.js";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const config: TenantConfig = { name: "test", apiToken: "tok", tenantUrl: "https://t.ves.volterra.io" };

describe("handleQueryLbMetrics", () => {
  beforeEach(() => { mockCallApi.mockReset(); });

  it("buckets access-log entries into 1-minute windows and counts by rsp_code_class", async () => {
    const entries = [
      { time: "2026-05-27T10:00:15Z", rsp_code_class: "2xx" },
      { time: "2026-05-27T10:00:45Z", rsp_code_class: "2xx" },
      { time: "2026-05-27T10:01:05Z", rsp_code_class: "5xx" },
    ];
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { data: entries.map((e) => JSON.stringify(e)), scroll_id: "" },
    });

    const result = await handleQueryLbMetrics(config, {
      namespace: "default", lb_name: "my-lb",
      start: "2026-05-27T10:00:00Z", end: "2026-05-27T10:05:00Z",
      bucket: "1m",
    });

    const parsed = JSON.parse(result.content[0].text);
    const b0 = parsed.buckets.find((b: any) => b.time === "2026-05-27T10:00:00Z");
    expect(b0.total).toBe(2);
    expect(b0.by_class["2xx"]).toBe(2);
    const b1 = parsed.buckets.find((b: any) => b.time === "2026-05-27T10:01:00Z");
    expect(b1.total).toBe(1);
    expect(b1.by_class["5xx"]).toBe(1);
  });

  it("returns isError on a failed access_logs call", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 503, statusText: "Service Unavailable", headers: {}, body: {},
    });

    const result = await handleQueryLbMetrics(config, {
      namespace: "default", lb_name: "my-lb",
      start: "2026-05-27T10:00:00Z", end: "2026-05-27T10:05:00Z",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("503");
  });

  it("paginates over scroll_id up to 10 pages", async () => {
    const e1 = { time: "2026-05-27T10:00:15Z", rsp_code_class: "2xx" };
    const e2 = { time: "2026-05-27T10:00:25Z", rsp_code_class: "2xx" };
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { data: [JSON.stringify(e1)], scroll_id: "next1" },
    });
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { data: [JSON.stringify(e2)], scroll_id: "" },
    });

    const result = await handleQueryLbMetrics(config, {
      namespace: "default", lb_name: "my-lb",
      start: "2026-05-27T10:00:00Z", end: "2026-05-27T10:05:00Z",
      bucket: "1m",
    });
    const parsed = JSON.parse(result.content[0].text);
    const b0 = parsed.buckets.find((b: any) => b.time === "2026-05-27T10:00:00Z");
    expect(b0.total).toBe(2);
    expect(mockCallApi).toHaveBeenCalledTimes(2);
    // Second call should have scroll_id in the request body
    expect(mockCallApi.mock.calls[1][3].body.scroll_id).toBe("next1");
  });

  it("returns an empty buckets array when no entries match", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { data: [], scroll_id: "" },
    });

    const result = await handleQueryLbMetrics(config, {
      namespace: "default", lb_name: "my-lb",
      start: "2026-05-27T10:00:00Z", end: "2026-05-27T10:05:00Z",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.buckets).toEqual([]);
  });

  it("rejects an invalid bucket value", async () => {
    const result = await handleQueryLbMetrics(config, {
      namespace: "default", lb_name: "my-lb",
      start: "2026-05-27T10:00:00Z", end: "2026-05-27T10:05:00Z",
      bucket: "30s" as any,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid bucket");
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});
