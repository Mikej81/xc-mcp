import type { ListResourcesParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

/**
 * Extract specified fields from an item.
 * Supports dot-notation paths like "spec.origin_servers".
 */
function projectFields(item: any, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split(".");
    let source = item;
    for (const part of parts) {
      if (source == null || typeof source !== "object") { source = undefined; break; }
      source = source[part];
    }
    if (source !== undefined) {
      result[field] = source;
    }
  }
  return result;
}

export async function handleListResources(
  config: TenantConfig,
  params: ListResourcesParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const path = `/api/config/namespaces/${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.resource_type)}`;

  const queryParams: Record<string, string> = {};
  if (params.label_selector) {
    queryParams.label_selector = params.label_selector;
  }

  const response = await callApi(config, "GET", path, { queryParams, skipTruncation: true });

  if (response.status !== 200) {
    return {
      content: [
        {
          type: "text",
          text: `Error listing ${params.resource_type} in namespace "${params.namespace}": ${response.status} ${response.statusText}\n${JSON.stringify(response.body, null, 2)}`,
        },
      ],
      isError: true,
    };
  }

  const body = response.body as any;
  let items: any[] = body?.items || [];
  const totalCount = items.length;

  // Apply max_items limit
  if (params.max_items && params.max_items > 0 && items.length > params.max_items) {
    items = items.slice(0, params.max_items);
  }

  if (totalCount === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No ${params.resource_type} found in namespace "${params.namespace}".`,
        },
      ],
    };
  }

  const truncatedNote = items.length < totalCount ? ` (showing ${items.length} of ${totalCount})` : "";
  const lines = [
    `Found ${totalCount} ${params.resource_type} in namespace "${params.namespace}"${truncatedNote}:\n`,
  ];

  // If fields are specified, use field projection; otherwise use default summary
  if (params.fields && params.fields.length > 0) {
    for (const item of items) {
      const name = item.name || item.metadata?.name || "unknown";
      const projected = projectFields(item, params.fields);
      const fieldStrs = Object.entries(projected)
        .map(([k, v]) => {
          if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
          return `${k}: ${v}`;
        })
        .join(", ");
      lines.push(`- ${name}${fieldStrs ? ` | ${fieldStrs}` : ""}`);
    }
  } else {
    for (const item of items) {
      const name = item.name || item.metadata?.name || "unknown";
      const labels = item.labels || item.metadata?.labels || {};
      const labelStr = Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- ${name}${labelStr ? ` [${labelStr}]` : ""}`);
    }
  }

  lines.push(
    `\nUse xc_call_api with GET and the resource name to get details.`,
    `Example path: /api/config/namespaces/${params.namespace}/${params.resource_type}/{name}`,
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
