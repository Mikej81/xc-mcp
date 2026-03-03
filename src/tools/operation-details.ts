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

  const schema = getOperationSchema(specsDir, entry.specFile, entry.method, entry.path);

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

  let text = JSON.stringify(output, null, 2);

  if (text.length > 50_000) {
    text = text.slice(0, 50_000) + "\n... [Schema truncated at 50KB]";
  }

  return { content: [{ type: "text", text }] };
}
