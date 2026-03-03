import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_DEPTH = 4;

// Cache loaded spec files in memory
const specCache = new Map<string, any>();

function loadSpec(specsDir: string, specFile: string): any {
  const cacheKey = specFile;
  if (specCache.has(cacheKey)) {
    return specCache.get(cacheKey);
  }
  const filePath = join(specsDir, specFile);
  const spec = JSON.parse(readFileSync(filePath, "utf-8"));
  specCache.set(cacheKey, spec);
  return spec;
}

/**
 * Resolve a $ref pointer within a spec.
 * Handles local refs like "#/components/schemas/FooBar"
 */
function resolveRef(spec: any, ref: string): any {
  if (!ref.startsWith("#/")) return { $ref: ref };
  const parts = ref.slice(2).split("/");
  let current = spec;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Recursively resolve $ref pointers and inline schemas up to a max depth.
 * Returns a simplified schema object suitable for LLM consumption.
 */
function resolveSchema(spec: any, schema: any, depth: number, visited: Set<string>): any {
  if (!schema || typeof schema !== "object") return schema;
  if (depth >= MAX_DEPTH) return { _note: "Schema truncated at max depth" };

  // Handle $ref
  if (schema.$ref) {
    const ref = schema.$ref as string;
    if (visited.has(ref)) {
      return { _note: `Circular reference: ${ref}` };
    }
    visited.add(ref);
    const resolved = resolveRef(spec, ref);
    if (!resolved) return { _note: `Unresolved ref: ${ref}` };
    return resolveSchema(spec, resolved, depth, visited);
  }

  // Handle arrays
  if (Array.isArray(schema)) {
    return schema.map((item) => resolveSchema(spec, item, depth, visited));
  }

  const result: any = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      result.properties = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
        result.properties[propName] = resolveSchema(spec, propSchema, depth + 1, visited);
      }
    } else if (key === "items" && typeof value === "object") {
      result.items = resolveSchema(spec, value, depth + 1, visited);
    } else if (key === "additionalProperties" && typeof value === "object") {
      result.additionalProperties = resolveSchema(spec, value, depth + 1, visited);
    } else if (key === "schema" && typeof value === "object") {
      result.schema = resolveSchema(spec, value, depth + 1, visited);
    } else if (key === "content" && typeof value === "object") {
      // Handle content (e.g., application/json in request bodies and responses)
      result.content = {};
      for (const [mediaType, mediaObj] of Object.entries(value as Record<string, any>)) {
        if (mediaObj && typeof mediaObj === "object" && mediaObj.schema) {
          result.content[mediaType] = {
            schema: resolveSchema(spec, mediaObj.schema, depth + 1, visited),
          };
        }
      }
    } else if (key === "allOf" || key === "oneOf" || key === "anyOf") {
      result[key] = (value as any[]).map((v) => resolveSchema(spec, v, depth + 1, visited));
    } else if (
      // Copy simple scalar properties
      ["type", "format", "description", "title", "enum", "default", "required",
       "minimum", "maximum", "minLength", "maxLength", "pattern",
       "name", "in", "x-displayname", "x-ves-example"].includes(key)
    ) {
      result[key] = value;
    }
  }

  return result;
}

export interface OperationSchema {
  method: string;
  path: string;
  summary: string;
  description: string;
  parameters: any[];
  requestBody: any | null;
  responses: Record<string, any>;
}

/**
 * Load the full schema for a specific operation from its source spec file.
 */
export function getOperationSchema(
  specsDir: string,
  specFile: string,
  method: string,
  path: string,
): OperationSchema | null {
  const spec = loadSpec(specsDir, specFile);
  const pathItem = spec.paths?.[path];
  if (!pathItem) return null;

  const operation = pathItem[method.toLowerCase()];
  if (!operation) return null;

  // Resolve parameters
  const parameters: any[] = [];

  // Path-level parameters
  if (Array.isArray(pathItem.parameters)) {
    for (const param of pathItem.parameters) {
      const resolved = resolveSchema(spec, param, 0, new Set());
      parameters.push(resolved);
    }
  }

  // Operation-level parameters
  if (Array.isArray(operation.parameters)) {
    for (const param of operation.parameters) {
      const resolved = resolveSchema(spec, param, 0, new Set());
      parameters.push(resolved);
    }
  }

  // Resolve request body
  let requestBody = null;
  if (operation.requestBody) {
    requestBody = resolveSchema(spec, operation.requestBody, 0, new Set());
  }

  // Resolve responses (just 200/201 to keep it manageable)
  const responses: Record<string, any> = {};
  if (operation.responses) {
    for (const [code, response] of Object.entries(operation.responses)) {
      if (code === "200" || code === "201" || code === "default") {
        responses[code] = resolveSchema(spec, response, 0, new Set());
      }
    }
  }

  return {
    method: method.toUpperCase(),
    path,
    summary: operation.summary || "",
    description: operation.description || "",
    parameters,
    requestBody,
    responses,
  };
}
