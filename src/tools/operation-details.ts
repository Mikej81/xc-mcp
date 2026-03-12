import type { OperationsIndex, OperationDetailsParams } from "../types/index.js";
import { findOperation } from "../lib/spec-index.js";
import { getOperationSchema } from "../lib/schema-resolver.js";

/**
 * Strip verbose descriptions and validation rules from a schema,
 * keeping only types, required fields, oneof groups, and enums.
 */
function summarizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(summarizeSchema);

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    // Keep structural keys
    if (["type", "format", "enum", "default", "required", "name", "in"].includes(key)) {
      result[key] = value;
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      result.properties = {};
      for (const [pn, ps] of Object.entries(value as Record<string, any>)) {
        result.properties[pn] = summarizeSchema(ps);
      }
    } else if (key === "items" && typeof value === "object") {
      result.items = summarizeSchema(value);
    } else if (key === "additionalProperties" && typeof value === "object") {
      result.additionalProperties = summarizeSchema(value);
    } else if (key === "content" && typeof value === "object") {
      result.content = {};
      for (const [mt, mo] of Object.entries(value as Record<string, any>)) {
        if (mo && typeof mo === "object" && mo.schema) {
          result.content[mt] = { schema: summarizeSchema(mo.schema) };
        }
      }
    } else if (key === "schema" && typeof value === "object") {
      result.schema = summarizeSchema(value);
    } else if (key === "allOf" || key === "oneOf" || key === "anyOf") {
      result[key] = (value as any[]).map(summarizeSchema);
    } else if (key.startsWith("x-ves-oneof-field-")) {
      result[key] = value;
    } else if (key === "_note") {
      result[key] = value;
    }
    // Drop: description, title, x-displayname, x-ves-example, minimum, maximum,
    // minLength, maxLength, pattern — these are verbose and rarely needed for creation
  }
  return result;
}

export function handleOperationDetails(
  index: OperationsIndex,
  specsDir: string,
  params: OperationDetailsParams,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const entry = findOperation(index, params.operation_key);

  if (!entry) {
    return {
      content: [
        {
          type: "text",
          text: `Operation "${params.operation_key}" not found. Use xc_discover_apis to search for operations.`,
        },
      ],
      isError: true,
    };
  }

  const maxDepth = params.max_depth != null ? Math.min(Math.max(params.max_depth, 1), 10) : undefined;
  const schema = getOperationSchema(specsDir, entry.specFile, entry.method, entry.path, maxDepth);

  if (!schema) {
    return {
      content: [
        {
          type: "text",
          text: `Could not load schema for "${params.operation_key}" from spec file "${entry.specFile}".`,
        },
      ],
      isError: true,
    };
  }

  const useSummary = params.summary_mode === true;
  const includeResponses = params.include_response_schema === true;

  const output: any = {
    operation: params.operation_key,
    summary: schema.summary,
    category: entry.category,
    parameters: useSummary ? summarizeSchema(schema.parameters) : schema.parameters,
    requestBody: useSummary ? summarizeSchema(schema.requestBody) : schema.requestBody,
    usage: {
      tool: "xc_call_api",
      method: entry.method,
      path: entry.path,
      pathParams: entry.pathParams,
      queryParams: entry.queryParams,
      hasRequestBody: entry.hasRequestBody,
    },
  };

  // Only include description in non-summary mode
  if (!useSummary) {
    output.description = schema.description;
  }

  // Only include response schema when explicitly requested (defaults to omitted)
  if (includeResponses) {
    output.responses = useSummary ? summarizeSchema(schema.responses) : schema.responses;
  }

  // Add notes for certificate operations
  if (entry.path.includes("/certificates") && entry.hasRequestBody) {
    output.notes = output.notes || [];
    output.notes.push(
      "Private keys must be PEM-encoded. Both PKCS1 (BEGIN RSA PRIVATE KEY) and " +
        "PKCS8 (BEGIN PRIVATE KEY) formats are accepted. When passing keys inline, " +
        "base64-wrap with string:/// prefix.",
    );
  }

  let text = JSON.stringify(output, null, 2);

  if (text.length > 50_000) {
    text = text.slice(0, 50_000) + "\n... [Schema truncated at 50KB]";
  }

  return { content: [{ type: "text", text }] };
}
