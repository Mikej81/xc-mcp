import { readFileSync } from "fs";
import { resolve, sep } from "path";
import type { ServerConfig } from "../types/index.js";
import { resolveRef } from "../lib/schema-resolver.js";
import { MAX_SCHEMA_OUTPUT } from "../lib/constants.js";

export interface ResolveSchemaRefParams {
  spec_file: string;
  ref: string;
  max_depth?: number;
}

export async function handleResolveSchemaRef(
  config: ServerConfig,
  params: ResolveSchemaRefParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const maxDepth = Math.min(Math.max(params.max_depth ?? 8, 1), 12);

  const specPath = resolve(config.specsDir, params.spec_file);
  if (!specPath.startsWith(resolve(config.specsDir) + sep)) {
    return {
      content: [{ type: "text", text: "Invalid spec_file" }],
      isError: true,
    };
  }

  let spec: any;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf-8"));
  } catch {
    return {
      content: [{ type: "text", text: `Failed to read spec "${params.spec_file}"` }],
      isError: true,
    };
  }

  const resolved = resolveRef(spec, params.ref);
  if (!resolved || resolved.$ref === params.ref) {
    return {
      content: [{ type: "text", text: `Unresolved ref "${params.ref}" in spec "${params.spec_file}".` }],
      isError: true,
    };
  }

  const expanded = expand(spec, resolved, 0, new Set([params.ref]), maxDepth);
  let text = JSON.stringify(expanded, null, 2);
  if (text.length > MAX_SCHEMA_OUTPUT) {
    text = text.slice(0, MAX_SCHEMA_OUTPUT) + "\n... [Schema truncated]";
  }
  return { content: [{ type: "text", text }] };
}

function expand(spec: any, node: any, depth: number, visited: Set<string>, maxDepth: number): any {
  if (depth >= maxDepth) return { _note: "Schema truncated at max depth" };
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => expand(spec, n, depth + 1, visited, maxDepth));
  if (typeof node.$ref === "string") {
    if (visited.has(node.$ref)) return { _note: `Circular reference: ${node.$ref}` };
    const next = resolveRef(spec, node.$ref);
    if (!next) return { _note: `Unresolved ref: ${node.$ref}` };
    return expand(spec, next, depth + 1, new Set([...visited, node.$ref]), maxDepth);
  }
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = expand(spec, v, depth + 1, visited, maxDepth);
  }
  return out;
}
