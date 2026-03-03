import { describe, it, expect } from "vitest";
import { categorize, CATEGORIES } from "../lib/categories.js";

describe("CATEGORIES", () => {
  it("is a non-empty array with expected structure", () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
    for (const cat of CATEGORIES) {
      expect(cat).toHaveProperty("name");
      expect(cat).toHaveProperty("specKeywords");
      expect(Array.isArray(cat.specKeywords)).toBe(true);
    }
  });
});

describe("categorize", () => {
  it("matches spec filename keyword to correct category", () => {
    expect(categorize("/some/path", "op1", "http_loadbalancer.ves.json")).toBe(
      "Load Balancing",
    );
  });

  it("matches path keyword when spec does not match", () => {
    expect(categorize("/api/config/dns/zones", "op1", "unknown_spec.json")).toBe(
      "DNS",
    );
  });

  it("returns Other when nothing matches", () => {
    expect(categorize("/api/something/random", "op1", "nope.json")).toBe(
      "Other",
    );
  });

  it("matches case-insensitively", () => {
    expect(categorize("/some/path", "op1", "HTTP_LOADBALANCER.json")).toBe(
      "Load Balancing",
    );
  });

  it("spec match takes precedence over path match", () => {
    // spec file matches DNS, path matches Load Balancing
    expect(
      categorize("/http_loadbalancers/foo", "op1", "dns_zone.swagger.json"),
    ).toBe("DNS");
  });

  it("matches pathKeywords correctly", () => {
    expect(
      categorize("/api/config/namespaces/ns/app_firewalls", "op1", "generic.json"),
    ).toBe("Security");
  });
});
