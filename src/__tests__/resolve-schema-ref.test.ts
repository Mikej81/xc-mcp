import { describe, it, expect, vi } from "vitest";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      if (String(path).endsWith("/test.json")) {
        return JSON.stringify({
          components: {
            schemas: {
              Foo: { type: "object", properties: { bar: { $ref: "#/components/schemas/Bar" } } },
              Bar: { type: "object", properties: { value: { type: "string" } } },
            },
          },
        });
      }
      return (actual as any).readFileSync(path);
    }),
  };
});

import { handleResolveSchemaRef } from "../tools/resolve-schema-ref.js";

describe("handleResolveSchemaRef", () => {
  it("resolves a $ref and expands nested $refs by default to max_depth", async () => {
    const result = await handleResolveSchemaRef(
      { specsDir: "/specs", indexPath: "" } as any,
      { spec_file: "test.json", ref: "#/components/schemas/Foo", max_depth: 8 },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.type).toBe("object");
    expect(parsed.properties.bar.properties.value.type).toBe("string");
  });

  it("returns an error when the $ref does not resolve", async () => {
    const result = await handleResolveSchemaRef(
      { specsDir: "/specs", indexPath: "" } as any,
      { spec_file: "test.json", ref: "#/components/schemas/DoesNotExist" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unresolved ref");
  });

  it("truncates at max_depth", async () => {
    const result = await handleResolveSchemaRef(
      { specsDir: "/specs", indexPath: "" } as any,
      { spec_file: "test.json", ref: "#/components/schemas/Foo", max_depth: 1 },
    );
    const parsed = JSON.parse(result.content[0].text);
    // With max_depth: 1, we get one level into Foo and then hit the depth cap.
    expect(JSON.stringify(parsed)).toContain("_note");
    expect(JSON.stringify(parsed)).toContain("max depth");
  });
  it.each(["../package.json", "/etc/passwd"])("rejects spec_file %s outside specsDir", async (spec_file) => {
    const result = await handleResolveSchemaRef(
      { specsDir: "/specs", indexPath: "" } as any,
      { spec_file, ref: "#/components/schemas/Foo" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid spec_file");
    expect(result.content[0].text).not.toContain('"version"');
  });

  it("does not leak the underlying read error message", async () => {
    const result = await handleResolveSchemaRef(
      { specsDir: "/specs", indexPath: "" } as any,
      { spec_file: "missing.json", ref: "#/components/schemas/Foo" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Failed to read spec "missing.json"');
  });
});
