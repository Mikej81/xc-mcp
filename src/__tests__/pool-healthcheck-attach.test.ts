import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api-client.js", () => ({ callApi: vi.fn() }));

import { handlePoolAttachHealthcheck, handlePoolDetachHealthcheck } from "../tools/pool-healthcheck-attach.js";
import { callApi } from "../lib/api-client.js";
import type { TenantConfig } from "../types/index.js";

const mockCallApi = callApi as ReturnType<typeof vi.fn>;
const config: TenantConfig = { name: "test", apiToken: "tok", tenantUrl: "https://t.ves.volterra.io" };

describe("pool healthcheck attach/detach", () => {
  beforeEach(() => { mockCallApi.mockReset(); });

  it("attach: adds an object_ref to spec.healthcheck", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: {},
      body: { spec: { healthcheck: [] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolAttachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc1",
    });

    const sent = mockCallApi.mock.calls[1][3].body;
    expect(sent.spec.healthcheck).toEqual([{ name: "hc1", namespace: "default" }]);
  });

  it("attach is idempotent — re-attaching the same name keeps one entry", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { healthcheck: [{ name: "hc1", namespace: "default" }] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolAttachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc1",
    });

    expect(mockCallApi.mock.calls[1][3].body.spec.healthcheck).toEqual([{ name: "hc1", namespace: "default" }]);
  });

  it("attach handles missing spec.healthcheck (initializes as empty array)", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: {} },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolAttachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc-new",
    });

    expect(mockCallApi.mock.calls[1][3].body.spec.healthcheck).toEqual([{ name: "hc-new", namespace: "default" }]);
  });

  it("detach: removes the named ref", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { healthcheck: [{ name: "hc1", namespace: "default" }, { name: "hc2", namespace: "default" }] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolDetachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc1",
    });

    expect(mockCallApi.mock.calls[1][3].body.spec.healthcheck).toEqual([{ name: "hc2", namespace: "default" }]);
  });

  it("detach: no-op (still PUTs) when the name is not attached", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { healthcheck: [{ name: "hc1", namespace: "default" }] } },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolDetachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc-not-there",
    });

    expect(mockCallApi.mock.calls[1][3].body.spec.healthcheck).toEqual([{ name: "hc1", namespace: "default" }]);
  });

  it("preserves resource_version by default", async () => {
    mockCallApi.mockResolvedValueOnce({
      status: 200, headers: {}, statusText: "OK",
      body: { spec: { healthcheck: [] }, resource_version: "v9" },
    });
    mockCallApi.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, body: {} });

    await handlePoolAttachHealthcheck(config, {
      namespace: "default", pool_name: "p", healthcheck_name: "hc1",
    });

    expect(mockCallApi.mock.calls[1][3].body.resource_version).toBe("v9");
  });
});
