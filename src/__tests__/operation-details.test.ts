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

const fullSchema = {
  method: "GET",
  path: "/api/lb",
  summary: "List load balancers",
  description: "Lists all LBs",
  parameters: [{ name: "namespace", in: "path", description: "The namespace" }],
  requestBody: null,
  responses: { "200": { description: "OK" } },
};

describe("handleOperationDetails", () => {
  const op = makeOp({ key: "GET:/api/lb", path: "/api/lb", pathParams: ["namespace"], queryParams: ["limit"] });
  const index = makeIndex([op]);

  it("returns JSON output for valid key", () => {
    mockGetSchema.mockReturnValue(fullSchema);

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
      ...fullSchema,
      summary: "Big",
      description: "x".repeat(60_000),
    });

    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(50_000 + 50);
    expect(text).toContain("[Schema truncated at 50KB]");
  });

  it("passes max_depth to getOperationSchema", () => {
    mockGetSchema.mockReturnValue(fullSchema);
    mockGetSchema.mockClear();
    handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb", max_depth: 8 });
    expect(mockGetSchema).toHaveBeenLastCalledWith("/specs", "test.json", "GET", "/api/lb", 8);
  });

  it("clamps max_depth between 1 and 10", () => {
    mockGetSchema.mockReturnValue(fullSchema);

    mockGetSchema.mockClear();
    handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb", max_depth: 99 });
    expect(mockGetSchema).toHaveBeenLastCalledWith("/specs", "test.json", "GET", "/api/lb", 10);

    mockGetSchema.mockClear();
    handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb", max_depth: 0 });
    expect(mockGetSchema).toHaveBeenLastCalledWith("/specs", "test.json", "GET", "/api/lb", 1);
  });

  it("adds PEM note for certificate operations with request body", () => {
    const certOp = makeOp({
      key: "POST:/api/config/namespaces/{namespace}/certificates",
      method: "POST",
      path: "/api/config/namespaces/{namespace}/certificates",
      hasRequestBody: true,
    });
    const certIndex = makeIndex([certOp]);

    mockGetSchema.mockReturnValue({
      ...fullSchema,
      method: "POST",
      path: "/api/config/namespaces/{namespace}/certificates",
      summary: "Create certificate",
      requestBody: { content: {} },
    });

    const result = handleOperationDetails(certIndex, "/specs", {
      operation_key: "POST:/api/config/namespaces/{namespace}/certificates",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.notes).toBeDefined();
    expect(parsed.notes[0]).toContain("PEM-encoded");
    expect(parsed.notes[0]).toContain("PKCS1");
    expect(parsed.notes[0]).toContain("PKCS8");
  });

  it("does not add PEM note for non-certificate operations", () => {
    mockGetSchema.mockReturnValue(fullSchema);

    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.notes).toBeUndefined();
  });

  it("omits response schema by default", () => {
    mockGetSchema.mockReturnValue(fullSchema);

    const result = handleOperationDetails(index, "/specs", { operation_key: "GET:/api/lb" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.responses).toBeUndefined();
  });

  it("includes response schema when include_response_schema is true", () => {
    mockGetSchema.mockReturnValue(fullSchema);

    const result = handleOperationDetails(index, "/specs", {
      operation_key: "GET:/api/lb",
      include_response_schema: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.responses).toBeDefined();
    expect(parsed.responses["200"]).toBeDefined();
  });

  it("strips descriptions in summary_mode", () => {
    mockGetSchema.mockReturnValue({
      ...fullSchema,
      parameters: [{ name: "namespace", in: "path", description: "The namespace to use", type: "string" }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "Request body for LBs",
              properties: {
                name: { type: "string", description: "Name of the LB", "x-ves-example": "my-lb" },
              },
            },
          },
        },
      },
    });

    const result = handleOperationDetails(index, "/specs", {
      operation_key: "GET:/api/lb",
      summary_mode: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    // description should be omitted from top-level output
    expect(parsed.description).toBeUndefined();
    // parameter descriptions should be stripped
    expect(parsed.parameters[0].description).toBeUndefined();
    expect(parsed.parameters[0].name).toBe("namespace");
    expect(parsed.parameters[0].type).toBe("string");
    // Nested descriptions and examples should be stripped
    const bodySchema = parsed.requestBody?.content?.["application/json"]?.schema;
    expect(bodySchema.description).toBeUndefined();
    expect(bodySchema.properties.name.description).toBeUndefined();
    expect(bodySchema.properties.name["x-ves-example"]).toBeUndefined();
    expect(bodySchema.properties.name.type).toBe("string");
  });

  it("preserves oneof fields in summary_mode", () => {
    mockGetSchema.mockReturnValue({
      ...fullSchema,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              "x-ves-oneof-field-choice": ["opt_a", "opt_b"],
              properties: {
                opt_a: { type: "object" },
                opt_b: { type: "object" },
              },
            },
          },
        },
      },
    });

    const result = handleOperationDetails(index, "/specs", {
      operation_key: "GET:/api/lb",
      summary_mode: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    const bodySchema = parsed.requestBody?.content?.["application/json"]?.schema;
    expect(bodySchema["x-ves-oneof-field-choice"]).toEqual(["opt_a", "opt_b"]);
  });
});
