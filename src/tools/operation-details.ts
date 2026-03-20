import type { OperationsIndex, OperationDetailsParams } from "../types/index.js";
import { findOperation } from "../lib/spec-index.js";
import { getOperationSchema } from "../lib/schema-resolver.js";
import { MAX_SCHEMA_OUTPUT } from "../lib/constants.js";

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
  const useSummary = params.summary_mode === true;
  const schema = getOperationSchema(specsDir, entry.specFile, entry.method, entry.path, maxDepth, useSummary);

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

  const includeResponses = params.include_response_schema === true;

  const output: any = {
    operation: params.operation_key,
    summary: schema.summary,
    category: entry.category,
    parameters: schema.parameters,
    requestBody: schema.requestBody,
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
    output.responses = schema.responses;
  }

  // Add notes for certificate operations
  if (entry.path.includes("/certificates") && entry.hasRequestBody) {
    output.notes = output.notes || [];
    output.notes.push(
      "AUTOMATIC ENCRYPTION: The MCP server automatically handles PEM encoding and blindfold encryption. " +
        "Just put the raw PEM private key at spec.private_key.clear_secret_info.url and the raw PEM " +
        "certificate at spec.certificate_url. The server will: (1) blindfold-encrypt the private key " +
        "using the tenant's public key and move it to blindfold_secret_info.location, (2) base64-encode " +
        "the certificate with string:/// prefix. No manual encryption or encoding needed.",
    );
    output.notes.push(
      "Both PKCS1 (BEGIN RSA PRIVATE KEY) and PKCS8 (BEGIN PRIVATE KEY) formats are accepted.",
    );
  }

  let text = JSON.stringify(output);

  if (text.length > MAX_SCHEMA_OUTPUT) {
    text = text.slice(0, MAX_SCHEMA_OUTPUT) + "\n... [Schema truncated]";
  }

  return { content: [{ type: "text", text }] };
}
