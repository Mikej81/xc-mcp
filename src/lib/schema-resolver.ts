import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_DEPTH = 4;

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
export function resolveRef(spec: any, ref: string): any {
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
/** Fields kept in full mode. */
const FULL_SCALAR_KEYS = new Set([
  "type", "format", "description", "title", "enum", "default", "required",
  "minimum", "maximum", "minLength", "maxLength", "pattern",
  "name", "in", "x-displayname", "x-ves-example",
]);

/** Fields kept in summary mode (types + required + enums only). */
const SUMMARY_SCALAR_KEYS = new Set([
  "type", "format", "enum", "default", "required", "name", "in",
]);

function resolveSchema(spec: any, schema: any, depth: number, visited: Set<string>, maxDepth: number = DEFAULT_MAX_DEPTH, summarize = false): any {
  if (!schema || typeof schema !== "object") return schema;
  if (depth >= maxDepth) return { _note: "Schema truncated at max depth" };

  // Handle $ref
  if (schema.$ref) {
    const ref = schema.$ref as string;
    if (visited.has(ref)) {
      return { _note: `Circular reference: ${ref}` };
    }
    visited.add(ref);
    const resolved = resolveRef(spec, ref);
    if (!resolved) return { _note: `Unresolved ref: ${ref}` };
    return resolveSchema(spec, resolved, depth, visited, maxDepth, summarize);
  }

  // Handle arrays
  if (Array.isArray(schema)) {
    return schema.map((item) => resolveSchema(spec, item, depth, visited, maxDepth, summarize));
  }

  const result: any = {};
  const allowedKeys = summarize ? SUMMARY_SCALAR_KEYS : FULL_SCALAR_KEYS;

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      result.properties = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
        result.properties[propName] = resolveSchema(spec, propSchema, depth + 1, visited, maxDepth, summarize);
      }
    } else if (key === "items" && typeof value === "object") {
      result.items = resolveSchema(spec, value, depth + 1, visited, maxDepth, summarize);
    } else if (key === "additionalProperties" && typeof value === "object") {
      result.additionalProperties = resolveSchema(spec, value, depth + 1, visited, maxDepth, summarize);
    } else if (key === "schema" && typeof value === "object") {
      result.schema = resolveSchema(spec, value, depth + 1, visited, maxDepth, summarize);
    } else if (key === "content" && typeof value === "object") {
      result.content = {};
      for (const [mediaType, mediaObj] of Object.entries(value as Record<string, any>)) {
        if (mediaObj && typeof mediaObj === "object" && mediaObj.schema) {
          result.content[mediaType] = {
            schema: resolveSchema(spec, mediaObj.schema, depth + 1, visited, maxDepth, summarize),
          };
        }
      }
    } else if (key === "allOf" || key === "oneOf" || key === "anyOf") {
      result[key] = (value as any[]).map((v) => resolveSchema(spec, v, depth + 1, visited, maxDepth, summarize));
    } else if (allowedKeys.has(key)) {
      result[key] = value;
    } else if (key === "_note") {
      result[key] = value;
    } else if (key.startsWith("x-ves-oneof-field-")) {
      try {
        result[key] = typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        result[key] = value;
      }
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
  maxDepth: number = DEFAULT_MAX_DEPTH,
  summarize = false,
): OperationSchema | null {
  const spec = loadSpec(specsDir, specFile);
  const pathItem = spec.paths?.[path];
  if (!pathItem) return null;

  const operation = pathItem[method.toLowerCase()];
  if (!operation) return null;

  const resolve = (schema: any) => resolveSchema(spec, schema, 0, new Set(), maxDepth, summarize);

  // Resolve parameters
  const parameters: any[] = [];

  if (Array.isArray(pathItem.parameters)) {
    for (const param of pathItem.parameters) {
      parameters.push(resolve(param));
    }
  }

  if (Array.isArray(operation.parameters)) {
    for (const param of operation.parameters) {
      parameters.push(resolve(param));
    }
  }

  // Resolve request body
  let requestBody = null;
  if (operation.requestBody) {
    requestBody = resolve(operation.requestBody);
  }

  // Resolve responses (just 200/201 to keep it manageable)
  const responses: Record<string, any> = {};
  if (operation.responses) {
    for (const [code, response] of Object.entries(operation.responses)) {
      if (code === "200" || code === "201" || code === "default") {
        responses[code] = resolve(response);
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
