import { describe, it, expect, vi, afterEach } from "vitest";
import { VERSION, checkForUpdate } from "../lib/version.js";

describe("VERSION", () => {
  it("reads version from package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe("unknown");
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns updateAvailable=true when remote version differs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v99.99.99" }),
    } as Response);

    const result = await checkForUpdate();
    expect(result.current).toBe(VERSION);
    expect(result.latest).toBe("99.99.99");
    expect(result.updateAvailable).toBe(true);
  });

  it("returns updateAvailable=false when versions match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: `v${VERSION}` }),
    } as Response);

    const result = await checkForUpdate();
    expect(result.latest).toBe(VERSION);
    expect(result.updateAvailable).toBe(false);
  });

  it("returns gracefully on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const result = await checkForUpdate();
    expect(result.current).toBe(VERSION);
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("returns gracefully on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
    } as Response);

    const result = await checkForUpdate();
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("returns gracefully when tag_name is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await checkForUpdate();
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });
});
