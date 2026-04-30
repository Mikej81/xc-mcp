import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantConfig } from "../types/index.js";

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../lib/api-client.js";
import { handleQueryAccessLogs } from "../tools/query-access-logs.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

beforeEach(() => {
  mockCallApi.mockReset();
});

describe("handleQueryAccessLogs", () => {
  it("parses stringified log entries from a single page", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        logs: [
          JSON.stringify({ rsp_code: 500, rsp_code_details: "upstream_reset_before_response_started" }),
          JSON.stringify({ rsp_code: 502, rsp_code_details: "no_healthy_upstream" }),
        ],
      },
    });

    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      lb_name: "lb",
      start: "2026-04-30T00:00:00Z",
      end: "2026-04-30T01:00:00Z",
      rsp_code_class: "5xx",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entries).toBe(2);
    expect(parsed.entries_data).toHaveLength(2);
    expect(parsed.entries_data[0].rsp_code).toBe(500);
  });

  it("auto-paginates via scroll_id up to max_pages", async () => {
    mockCallApi
      .mockResolvedValueOnce({
        status: 200, statusText: "OK", headers: {},
        body: {
          logs: [JSON.stringify({ rsp_code: 200 })],
          scroll_id: "scroll-1",
        },
      })
      .mockResolvedValueOnce({
        status: 200, statusText: "OK", headers: {},
        body: {
          logs: [JSON.stringify({ rsp_code: 201 })],
          scroll_id: "",
        },
      });

    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      start: "2026-04-30T00:00:00Z",
      end: "2026-04-30T01:00:00Z",
      max_pages: 5,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pages_fetched).toBe(2);
    expect(parsed.entries).toBe(2);
    expect(parsed.truncated).toBe(false);

    // Second call uses scroll_id
    const [, , , secondOpts] = mockCallApi.mock.calls[1];
    expect((secondOpts as any).body.scroll_id).toBe("scroll-1");
  });

  it("aggregates by group_by field", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        logs: [
          JSON.stringify({ rsp_code_details: "upstream_reset" }),
          JSON.stringify({ rsp_code_details: "upstream_reset" }),
          JSON.stringify({ rsp_code_details: "no_healthy_upstream" }),
        ],
      },
    });

    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      start: "2026-04-30T00:00:00Z",
      end: "2026-04-30T01:00:00Z",
      group_by: "rsp_code_details",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.counts).toEqual({
      upstream_reset: 2,
      no_healthy_upstream: 1,
    });
    expect(parsed.entries_data).toBeUndefined();
  });

  it("counts parse errors but continues", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: {
        logs: [
          JSON.stringify({ ok: true }),
          "not-valid-json{",
          JSON.stringify({ ok: true }),
        ],
      },
    });

    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      start: "2026-04-30T00:00:00Z",
      end: "2026-04-30T01:00:00Z",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entries).toBe(2);
    expect(parsed.parse_errors).toBe(1);
  });

  it("returns isError when API call fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 401, statusText: "Unauthorized", headers: {},
      body: { code: 16, message: "auth" },
    });

    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      start: "2026-04-30T00:00:00Z",
      end: "2026-04-30T01:00:00Z",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects missing start/end", async () => {
    const result = await handleQueryAccessLogs(config, {
      namespace: "ns1",
      start: "",
      end: "",
    });
    expect(result.isError).toBe(true);
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});
