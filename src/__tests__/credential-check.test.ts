import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyCredentials, CREDENTIAL_CHECK_PATH, CREDENTIAL_CHECK_TIMEOUT_MS } from "../lib/credential-check.js";
import type { TenantConfig } from "../types/index.js";

const tenant: TenantConfig = { name: "acme", apiToken: "t", tenantUrl: "https://acme.console.ves.volterra.io" };

function resp(status: number) {
  return { status, statusText: "x", headers: { forEach: () => {} }, text: () => Promise.resolve("{}") };
}

describe("verifyCredentials", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const f = () => fetch as ReturnType<typeof vi.fn>;

  it("returns ok on 200 and calls whoami with the token", async () => {
    f().mockResolvedValue(resp(200));
    expect(await verifyCredentials(tenant)).toEqual({ ok: true });
    const [url, init] = f().mock.calls[0];
    expect(url).toBe(`https://acme.console.ves.volterra.io${CREDENTIAL_CHECK_PATH}`);
    expect(url).toBe("https://acme.console.ves.volterra.io/api/web/custom/namespaces/system/whoami");
    expect(init.headers.Authorization).toBe("APIToken t");
  });

  it.each([401, 403])("maps %i to invalid_credentials", async (s) => {
    f().mockResolvedValue(resp(s));
    expect(await verifyCredentials(tenant)).toEqual({
      ok: false, status: 401, reason: "invalid_credentials", upstreamStatus: s,
    });
  });

  it.each([301, 302, 307, 404, 500, 503])("maps %i to tenant_unreachable", async (s) => {
    f().mockResolvedValue(resp(s));
    expect(await verifyCredentials(tenant)).toEqual({
      ok: false, status: 502, reason: "tenant_unreachable", upstreamStatus: s,
    });
  });

  it("maps network error to upstreamStatus 0", async () => {
    f().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await verifyCredentials(tenant)).toEqual({
      ok: false, status: 502, reason: "tenant_unreachable", upstreamStatus: 0,
    });
  });

  it("maps timeout to upstreamStatus 408 and never leaks the token", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    f().mockRejectedValue(err);
    const r = await verifyCredentials(tenant);
    expect(r).toEqual({ ok: false, status: 502, reason: "tenant_unreachable", upstreamStatus: 408 });
    expect(JSON.stringify(r)).not.toContain("APIToken");
  });

  it("aborts the request after CREDENTIAL_CHECK_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      f().mockImplementation((_u: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
      );
      const p = verifyCredentials(tenant);
      await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS - 1);
      expect(f().mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toMatchObject({ ok: false, status: 502, upstreamStatus: 408 });
    } finally {
      vi.useRealTimers();
    }
  });
});
