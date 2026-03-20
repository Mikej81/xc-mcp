import type { OperationsIndex, OperationDetailsParams } from "../types/index.js";
import { findOperation } from "../lib/spec-index.js";
import { getOperationSchema } from "../lib/schema-resolver.js";
import { MAX_SCHEMA_OUTPUT } from "../lib/constants.js";
import { getTemplatesForPath } from "../lib/templates.js";

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

  // Check for templates first — if available for POST/PUT on known resource types,
  // return templates instead of the full schema (saves ~10k tokens for complex resources)
  const templates = getTemplatesForPath(entry.path);
  const isCreateOrUpdate = entry.method === "POST" || entry.method === "PUT";

  if (templates && isCreateOrUpdate && !params.include_full_schema) {
    const output: any = {
      operation: params.operation_key,
      summary: entry.summary,
      category: entry.category,
      usage: {
        tool: "xc_call_api",
        method: entry.method,
        path: entry.path,
        pathParams: entry.pathParams,
      },
      templates: templates.map((t) => ({
        description: t.description,
        example_body: t.example_body,
      })),
      note: "Use one of the templates above — replace <REPLACE> values. " +
        "For full schema, call again with include_full_schema: true.",
    };

    // Add certificate notes
    if (entry.path.includes("/certificates")) {
      output.notes = [
        "AUTOMATIC ENCRYPTION: Put raw PEM private key at spec.private_key.blindfold_secret_info.location " +
          "and raw PEM certificate at spec.certificate_url. The MCP server auto-blindfold-encrypts " +
          "the key and base64-encodes the cert. NEVER use clear_secret_info — always use blindfold_secret_info.",
      ];
    }

    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  }

  // Full schema path — used for non-templated resources or when explicitly requested
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

  if (!useSummary) {
    output.description = schema.description;
  }

  if (includeResponses) {
    output.responses = schema.responses;
  }

  // Include templates alongside schema if available
  if (templates && isCreateOrUpdate) {
    output.templates = templates.map((t) => ({
      description: t.description,
      example_body: t.example_body,
    }));
  }

  // Add notes for certificate operations
  if (entry.path.includes("/certificates") && entry.hasRequestBody) {
    output.notes = output.notes || [];
    output.notes.push(
      "AUTOMATIC ENCRYPTION: Put raw PEM private key at spec.private_key.blindfold_secret_info.location " +
        "and raw PEM certificate at spec.certificate_url. The MCP server auto-blindfold-encrypts " +
        "the key and base64-encodes the cert. NEVER use clear_secret_info — always use blindfold_secret_info.",
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
