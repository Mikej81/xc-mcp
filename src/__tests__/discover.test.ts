import { describe, it, expect } from "vitest";
import { handleDiscover } from "../tools/discover.js";
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

describe("handleDiscover", () => {
  const ops = [
    makeOp({ key: "GET:/api/lb", summary: "List LBs", category: "Load Balancing", pathParams: ["namespace"], hasRequestBody: false }),
    makeOp({ key: "POST:/api/lb", summary: "Create LB", category: "Load Balancing", pathParams: ["namespace"], hasRequestBody: true }),
    makeOp({ key: "GET:/api/dns", summary: "List DNS", category: "DNS" }),
  ];
  const index = makeIndex(ops);

  it("returns category listing when no params provided", () => {
    const result = handleDiscover(index, {});
    const text = result.content[0].text;
    expect(text).toContain("3 operations");
    expect(text).toContain("Load Balancing");
    expect(text).toContain("DNS");
    expect(text).toContain("Use query");
  });

  it("returns formatted results for search with matches", () => {
    const result = handleDiscover(index, { category: "Load Balancing" });
    const text = result.content[0].text;
    expect(text).toContain("Found 2 operations");
    expect(text).toContain("GET:/api/lb");
    expect(text).toContain("POST:/api/lb");
  });

  it("returns no-match message when nothing found", () => {
    const result = handleDiscover(index, { query: "nonexistent" });
    const text = result.content[0].text;
    expect(text).toContain("No operations found");
  });

  it("shows path params when present", () => {
    const result = handleDiscover(index, { query: "List LBs" });
    const text = result.content[0].text;
    expect(text).toContain("Path params: namespace");
  });

  it("shows request body indicator when present", () => {
    const result = handleDiscover(index, { query: "Create LB" });
    const text = result.content[0].text;
    expect(text).toContain("Has request body: yes");
  });

  it("shows pagination hint when more results exist", () => {
    const result = handleDiscover(index, { query: "L", limit: 1 });
    const text = result.content[0].text;
    expect(text).toContain("more results");
    expect(text).toContain("offset");
  });
});
