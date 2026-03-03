import { describe, it, expect, vi } from "vitest";
import { handleOperationDetails } from "../tools/operation-details.js";
import type { OperationsIndex, OperationIndexEntry } from "../types/index.js";

// Mock the schema resolver
vi.mock("../lib/schema-resolver.js", () => ({
  getOperationSchema: vi.fn(),
}));

import { getOperationSchema } from "../lib/schema-resolver.js";

const mockGetSchema = getOperationSchema as ReturnType<typeof vi.fn>;

function makeOp(overrides: Partial<OperationIndexEntry> = {}): OperationIndexEntry {
  return {
    key: "GET:/api/test",
    method: "GET",
    path: "/api/test",
    summary: "Test operation",
    description: "A test",
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

describe("handleOperationDetails", () => {
  const op = makeOp({ key: "GET:/api/lb", pathParams: ["namespace"], queryParams: ["limit"] });
  const index = makeIndex([op]);

  it("returns JSON output for valid key", () => {
    mockGetSchema.mockReturnValue({
      method: "GET",
      path: "/api/lb",
      summary: "List load balancers",
      description: "Lists all LBs",
      parameters: [{ name: "namespace", in: "path" }],
      requestBody: null,
      responses: { "200": { description: "OK" } },
    });

    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.operation).toBe("GET:/api/lb");
    expect(parsed.summary).toBe("List load balancers");
    expect(parsed.usage.tool).toBe("xc_call_api");
    expect(parsed.usage.pathParams).toEqual(["namespace"]);
  });

  it("returns error when key not found in index", () => {
    const result = handleOperationDetails(index, "/specs", { operation_key: "DELETE:/api/unknown" });
    const text = result.content[0].text;
    expect(text).toContain("not found");
    expect(text).toContain("xc_discover_apis");
    expect(result.isError).toBe(true);
  });

  it("returns error when schema load fails", () => {
    mockGetSchema.mockReturnValue(null);
    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const text = result.content[0].text;
    expect(text).toContain("Could not load schema");
    expect(result.isError).toBe(true);
  });

  it("truncates output > 50KB", () => {
    mockGetSchema.mockReturnValue({
      method: "GET",
      path: "/api/lb",
      summary: "Big",
      description: "x".repeat(60_000),
      parameters: [],
      requestBody: null,
      responses: {},
    });

    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(50_000 + 50); // 50KB + truncation message
    expect(text).toContain("[Schema truncated at 50KB]");
  });
});
