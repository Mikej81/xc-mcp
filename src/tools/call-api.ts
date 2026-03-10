import type { CallApiParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { encodePemFields } from "../lib/pem-encoding.js";

/**
 * Extract fields from a response body using dot-separated paths.
 * Supports comma-separated field list, e.g. "items[].name,items[].labels"
 * or simple top-level field names like "items,metadata".
 */
export function filterResponse(body: unknown, filter: string): unknown {
  if (!body || typeof body !== "object" || !filter) return body;

  const paths = filter.split(",").map((p) => p.trim()).filter(Boolean);
  const result: Record<string, unknown> = {};

  for (const path of paths) {
    const parts = path.split(".");
    let source: any = body;
    let target: any = result;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isArrayAccess = part.endsWith("[]");
      const key = isArrayAccess ? part.slice(0, -2) : part;
      const isLast = i === parts.length - 1;

      if (source == null || typeof source !== "object") break;

      if (isLast) {
        if (isArrayAccess && Array.isArray(source[key])) {
          // Last part with [] — include the full array
          target[key] = source[key];
        } else if (source[key] !== undefined) {
          target[key] = source[key];
        }
      } else {
        // Navigate deeper
        if (isArrayAccess && Array.isArray(source[key])) {
          // For array traversal mid-path, extract the nested field from each element
          const remaining = parts.slice(i + 1).join(".");
          target[key] = source[key].map((item: any) => {
            const extracted = filterResponse(item, remaining);
            return extracted;
          });
          break;
        } else {
          if (target[key] === undefined) {
            target[key] = {};
          }
          source = source[key];
          target = target[key];
        }
      }
    }
  }

  return result;
}

export async function handleCallApi(
  config: TenantConfig,
  params: CallApiParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const response = await callApi(config, params.method, params.path, {
    pathParams: params.path_params,
    queryParams: params.query_params,
    body: await encodePemFields(config, params.path, params.body),
  });

  const output: any = {
    status: response.status,
    statusText: response.statusText,
  };

  if (response.truncated && !params.response_filter) {
    output.warning = "Response was truncated at 50KB. Use response_filter to extract specific fields.";
  }

  if (params.response_filter && response.body && typeof response.body === "object") {
    output.body = filterResponse(response.body, params.response_filter);
    output.filtered = true;
  } else {
    output.body = response.body;
  }

  let text = JSON.stringify(output, null, 2);

  if (text.length > 60_000) {
    text = text.slice(0, 60_000) + "\n... [Output truncated]";
  }

  return { content: [{ type: "text", text }] };
}
