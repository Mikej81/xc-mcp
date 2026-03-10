import type { OperationsIndex, OperationDetailsParams } from "../types/index.js";
import { findOperation } from "../lib/spec-index.js";
import { getOperationSchema } from "../lib/schema-resolver.js";

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

  const output: any = {
    operation: params.operation_key,
    summary: schema.summary,
    description: schema.description,
    category: entry.category,
    parameters: schema.parameters,
    requestBody: schema.requestBody,
    responses: schema.responses,
    usage: {
      tool: "xc_call_api",
      method: entry.method,
      path: entry.path,
      pathParams: entry.pathParams,
      queryParams: entry.queryParams,
      hasRequestBody: entry.hasRequestBody,
    },
  };

  // Add notes for certificate operations
  if (entry.path.includes("/certificates") && entry.hasRequestBody) {
    output.notes = output.notes || [];
    output.notes.push(
      "Private keys MUST be in PKCS1 format (BEGIN RSA PRIVATE KEY). " +
        "PKCS8 format (BEGIN PRIVATE KEY) will fail with 'failed to parse private key'. " +
        "Convert with: openssl rsa -in key.pem -out key-pkcs1.pem -traditional",
    );
  }

  let text = JSON.stringify(output, null, 2);

  if (text.length > 50_000) {
    text = text.slice(0, 50_000) + "\n... [Schema truncated at 50KB]";
  }

  return { content: [{ type: "text", text }] };
}
