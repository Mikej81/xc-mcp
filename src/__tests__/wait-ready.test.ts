import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantConfig } from "../types/index.js";

vi.mock("../lib/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../lib/api-client.js";
import { handleWaitReady } from "../tools/wait-ready.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;

const config: TenantConfig = {
  name: "test",
  apiToken: "tok",
  tenantUrl: "https://test.ves.volterra.io",
};

beforeEach(() => {
  mockCallApi.mockReset();
});

function fakeClock(starts: number = 0) {
  let t = starts;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("handleWaitReady", () => {
  it("returns ready=true when cert_state hits CertificateValid", async () => {
    mockCallApi
      .mockResolvedValueOnce({
        status: 200, statusText: "OK", headers: {},
        body: { spec: { cert_state: "DomainChallengePending" } },
      })
      .mockResolvedValueOnce({
        status: 200, statusText: "OK", headers: {},
        body: { spec: { cert_state: "CertificateValid" } },
      });

    const clock = fakeClock();
    const result = await handleWaitReady(
      config,
      { namespace: "n", lb_name: "lb", poll_interval_seconds: 1, timeout_seconds: 60 },
      { sleep: clock.sleep, now: clock.now },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready).toBe(true);
    expect(parsed.cert_state).toBe("CertificateValid");
    expect(parsed.polls).toBe(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  it("returns ready=false on timeout", async () => {
    mockCallApi.mockResolvedValue({
      status: 200, statusText: "OK", headers: {},
      body: { spec: { cert_state: "DomainChallengePending" } },
    });

    const clock = fakeClock();
    const result = await handleWaitReady(
      config,
      { namespace: "n", lb_name: "lb", poll_interval_seconds: 30, timeout_seconds: 60 },
      { sleep: clock.sleep, now: clock.now },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready).toBe(false);
    expect(parsed.timeout).toBe(true);
    expect(parsed.cert_state).toBe("DomainChallengePending");
  });

  it("returns isError when GET fails", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 404, statusText: "Not Found", headers: {},
      body: { code: 5 },
    });

    const clock = fakeClock();
    const result = await handleWaitReady(
      config,
      { namespace: "n", lb_name: "missing", poll_interval_seconds: 1, timeout_seconds: 10 },
      { sleep: clock.sleep, now: clock.now },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready).toBe(false);
    expect(parsed.error).toContain("404");
  });

  it("calls /api/config/namespaces/{ns}/http_loadbalancers/{name}", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { spec: { cert_state: "CertificateValid" } },
    });

    const clock = fakeClock();
    await handleWaitReady(
      config,
      { namespace: "ns1", lb_name: "lb-x" },
      { sleep: clock.sleep, now: clock.now },
    );
    expect(mockCallApi).toHaveBeenCalledWith(
      config,
      "GET",
      "/api/config/namespaces/ns1/http_loadbalancers/lb-x",
      expect.any(Object),
    );
  });
});
