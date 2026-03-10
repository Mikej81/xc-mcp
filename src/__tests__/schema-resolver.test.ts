import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOperationSchema } from "../lib/schema-resolver.js";

// Mock node:fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

function makeSpec(paths: Record<string, any>, components?: Record<string, any>) {
  return JSON.stringify({
    openapi: "3.0.0",
    paths,
    components: components || {},
  });
}

describe("getOperationSchema", () => {
  beforeEach(() => {
    // Clear the internal spec cache by resetting the module mock each time
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns populated schema for valid spec/method/path", () => {
    const spec = makeSpec({
      "/api/test": {
        get: {
          summary: "Test endpoint",
          description: "A test",
          parameters: [{ name: "limit", in: "query", type: "integer" }],
          responses: {
            "200": { description: "Success" },
          },
        },
      },
    });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "test.json", "GET", "/api/test");
    expect(result).not.toBeNull();
    expect(result!.method).toBe("GET");
    expect(result!.path).toBe("/api/test");
    expect(result!.summary).toBe("Test endpoint");
    expect(result!.parameters).toHaveLength(1);
    expect(result!.responses).toHaveProperty("200");
  });

  it("returns null when path not found", () => {
    const spec = makeSpec({ "/api/other": { get: { responses: {} } } });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "test2.json", "GET", "/api/missing");
    expect(result).toBeNull();
  });

  it("returns null when method not found", () => {
    const spec = makeSpec({ "/api/test": { get: { responses: {} } } });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "test3.json", "POST", "/api/test");
    expect(result).toBeNull();
  });

  it("resolves inline $ref", () => {
    const spec = makeSpec(
      {
        "/api/test": {
          post: {
            summary: "Create",
            responses: { "200": { description: "OK" } },
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MyBody" },
                },
              },
            },
          },
        },
      },
      {
        schemas: {
          MyBody: {
            type: "object",
            properties: {
              name: { type: "string", description: "The name" },
            },
          },
        },
      },
    );
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "ref-test.json", "POST", "/api/test");
    expect(result).not.toBeNull();
    expect(result!.requestBody).toBeDefined();
    const bodySchema =
      result!.requestBody?.content?.["application/json"]?.schema;
    expect(bodySchema?.properties?.name?.type).toBe("string");
  });

  it("handles circular $ref with _note marker", () => {
    const spec = makeSpec(
      {
        "/api/test": {
          get: {
            summary: "Circular",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" },
                  },
                },
              },
            },
          },
        },
      },
      {
        schemas: {
          Node: {
            type: "object",
            properties: {
              child: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
    );
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "circular.json", "GET", "/api/test");
    expect(result).not.toBeNull();
    // The circular ref should produce a _note
    const responseSchema =
      result!.responses["200"]?.content?.["application/json"]?.schema;
    expect(responseSchema?.properties?.child?._note).toContain("Circular reference");
  });

  it("truncates at default max depth (4)", () => {
    // Build deeply nested schema
    const spec = makeSpec(
      {
        "/api/test": {
          get: {
            summary: "Deep",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        l1: {
                          type: "object",
                          properties: {
                            l2: {
                              type: "object",
                              properties: {
                                l3: {
                                  type: "object",
                                  properties: {
                                    l4: {
                                      type: "object",
                                      properties: {
                                        l5: { type: "string" },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    );
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "deep.json", "GET", "/api/test");
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain("Schema truncated at max depth");
  });

  it("resolves deeper when maxDepth is increased", () => {
    const spec = makeSpec(
      {
        "/api/test": {
          get: {
            summary: "Deep",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        l1: {
                          type: "object",
                          properties: {
                            l2: {
                              type: "object",
                              properties: {
                                l3: {
                                  type: "object",
                                  properties: {
                                    l4: {
                                      type: "object",
                                      properties: {
                                        l5: { type: "string" },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    );
    mockReadFileSync.mockReturnValue(spec);

    // Default depth 4 truncates
    const resultDefault = getOperationSchema("/specs", "deep-default.json", "GET", "/api/test");
    expect(JSON.stringify(resultDefault)).toContain("Schema truncated at max depth");

    // Depth 8 resolves fully
    const resultDeep = getOperationSchema("/specs", "deep-8.json", "GET", "/api/test", 8);
    const text = JSON.stringify(resultDeep);
    expect(text).not.toContain("Schema truncated at max depth");
    // Should reach l5
    const schema = resultDeep!.responses["200"]?.content?.["application/json"]?.schema;
    expect(schema?.properties?.l1?.properties?.l2?.properties?.l3?.properties?.l4?.properties?.l5?.type).toBe("string");
  });

  it("merges path-level and operation-level parameters", () => {
    const spec = makeSpec({
      "/api/{ns}/items": {
        parameters: [{ name: "ns", in: "path", type: "string" }],
        get: {
          summary: "List",
          parameters: [{ name: "limit", in: "query", type: "integer" }],
          responses: { "200": { description: "OK" } },
        },
      },
    });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "params.json", "GET", "/api/{ns}/items");
    expect(result!.parameters).toHaveLength(2);
  });

  it("only includes 200/201/default responses", () => {
    const spec = makeSpec({
      "/api/test": {
        post: {
          summary: "Create",
          responses: {
            "200": { description: "OK" },
            "201": { description: "Created" },
            "400": { description: "Bad Request" },
            "500": { description: "Server Error" },
            default: { description: "Default" },
          },
        },
      },
    });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "responses.json", "POST", "/api/test");
    expect(Object.keys(result!.responses).sort()).toEqual(["200", "201", "default"]);
  });

  it("preserves x-ves-oneof-field extensions", () => {
    const spec = makeSpec({
      "/api/test": {
        post: {
          summary: "Create cert",
          responses: { "200": { description: "OK" } },
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  "x-ves-oneof-field-ocsp_stapling_choice": '["custom_hash_algorithms","disable_ocsp_stapling","use_system_defaults"]',
                  properties: {
                    custom_hash_algorithms: { type: "object" },
                    disable_ocsp_stapling: { type: "object" },
                    use_system_defaults: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });
    mockReadFileSync.mockReturnValue(spec);

    const result = getOperationSchema("/specs", "oneof.json", "POST", "/api/test");
    const bodySchema = result!.requestBody?.content?.["application/json"]?.schema;
    // Should be parsed from JSON string to array
    expect(bodySchema["x-ves-oneof-field-ocsp_stapling_choice"]).toEqual([
      "custom_hash_algorithms",
      "disable_ocsp_stapling",
      "use_system_defaults",
    ]);
    // All three properties should exist
    expect(bodySchema.properties.custom_hash_algorithms).toBeDefined();
    expect(bodySchema.properties.disable_ocsp_stapling).toBeDefined();
    expect(bodySchema.properties.use_system_defaults).toBeDefined();
  });
});
