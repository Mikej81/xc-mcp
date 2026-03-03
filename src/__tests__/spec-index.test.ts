import { describe, it, expect } from "vitest";
import { searchOperations, findOperation, getCategories } from "../lib/spec-index.js";
import type { OperationsIndex, OperationIndexEntry } from "../types/index.js";

function makeOp(overrides: Partial<OperationIndexEntry> = {}): OperationIndexEntry {
  return {
    key: "GET:/api/test",
    method: "GET",
    path: "/api/test",
    summary: "Test operation",
    description: "A test operation",
    operationId: "testOp",
    category: "Other",
    tags: [],
    pathParams: [],
    queryParams: [],
    hasRequestBody: false,
    specFile: "test.json",
    resourceType: "tests",
    ...overrides,
  };
}

function makeIndex(ops: OperationIndexEntry[]): OperationsIndex {
  return {
    version: "1.0",
    generatedAt: "2024-01-01",
    totalOperations: ops.length,
    categories: [...new Set(ops.map((o) => o.category))],
    operations: ops,
  };
}

describe("searchOperations", () => {
  const ops = [
    makeOp({ key: "GET:/api/lb", method: "GET", summary: "List load balancers", category: "Load Balancing", resourceType: "http_loadbalancers" }),
    makeOp({ key: "POST:/api/lb", method: "POST", summary: "Create load balancer", category: "Load Balancing", resourceType: "http_loadbalancers" }),
    makeOp({ key: "GET:/api/dns", method: "GET", summary: "List DNS zones", category: "DNS", resourceType: "dns_zones", tags: ["dns"] }),
    makeOp({ key: "DELETE:/api/fw", method: "DELETE", summary: "Delete firewall", category: "Security", resourceType: "app_firewalls" }),
  ];
  const index = makeIndex(ops);

  it("returns all operations (up to limit 20) with no filters", () => {
    const { results, total } = searchOperations(index, {});
    expect(total).toBe(4);
    expect(results).toHaveLength(4);
  });

  it("filters by category (case-insensitive)", () => {
    const { results, total } = searchOperations(index, { category: "load balancing" });
    expect(total).toBe(2);
    expect(results.every((r) => r.category === "Load Balancing")).toBe(true);
  });

  it("filters by method", () => {
    const { results, total } = searchOperations(index, { method: "get" });
    expect(total).toBe(2);
    expect(results.every((r) => r.method === "GET")).toBe(true);
  });

  it("filters by resource_type", () => {
    const { results, total } = searchOperations(index, { resource_type: "dns" });
    expect(total).toBe(1);
    expect(results[0].key).toBe("GET:/api/dns");
  });

  it("searches by single query term", () => {
    const { results } = searchOperations(index, { query: "firewall" });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("DELETE:/api/fw");
  });

  it("searches by multiple query terms (AND logic)", () => {
    const { results } = searchOperations(index, { query: "load create" });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("POST:/api/lb");
  });

  it("caps limit at 50", () => {
    const manyOps = Array.from({ length: 60 }, (_, i) =>
      makeOp({ key: `GET:/api/op${i}` }),
    );
    const bigIndex = makeIndex(manyOps);
    const { results } = searchOperations(bigIndex, { limit: 100 });
    expect(results).toHaveLength(50);
  });

  it("applies offset for pagination", () => {
    const { results, total } = searchOperations(index, { offset: 2, limit: 10 });
    expect(total).toBe(4);
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("GET:/api/dns");
  });

  it("returns total reflecting pre-pagination count", () => {
    const { total, results } = searchOperations(index, { limit: 1 });
    expect(total).toBe(4);
    expect(results).toHaveLength(1);
  });

  it("returns empty results when nothing matches", () => {
    const { results, total } = searchOperations(index, { query: "nonexistent" });
    expect(total).toBe(0);
    expect(results).toHaveLength(0);
  });

  it("searches across tags", () => {
    const { results } = searchOperations(index, { query: "dns" });
    expect(results.some((r) => r.key === "GET:/api/dns")).toBe(true);
  });
});

describe("findOperation", () => {
  const ops = [
    makeOp({ key: "GET:/api/lb" }),
    makeOp({ key: "POST:/api/lb" }),
  ];
  const index = makeIndex(ops);

  it("returns the operation when key matches", () => {
    const result = findOperation(index, "GET:/api/lb");
    expect(result).toBeDefined();
    expect(result!.key).toBe("GET:/api/lb");
  });

  it("returns undefined when key not found", () => {
    expect(findOperation(index, "DELETE:/api/lb")).toBeUndefined();
  });
});

describe("getCategories", () => {
  it("returns categories sorted alphabetically with counts", () => {
    const ops = [
      makeOp({ category: "DNS" }),
      makeOp({ category: "Load Balancing" }),
      makeOp({ category: "DNS" }),
      makeOp({ category: "Security" }),
    ];
    const index = makeIndex(ops);
    const cats = getCategories(index);
    expect(cats).toEqual([
      { name: "DNS", count: 2 },
      { name: "Load Balancing", count: 1 },
      { name: "Security", count: 1 },
    ]);
  });

  it("returns empty array for empty operations", () => {
    const index = makeIndex([]);
    expect(getCategories(index)).toEqual([]);
  });
});
