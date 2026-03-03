import type { ListResourcesParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

export async function handleListResources(
  config: TenantConfig,
  params: ListResourcesParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const path = `/api/config/namespaces/${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.resource_type)}`;

  const queryParams: Record<string, string> = {};
  if (params.label_selector) {
    queryParams.label_selector = params.label_selector;
  }

  const response = await callApi(config, "GET", path, { queryParams });

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
  const items = body?.items || [];

  if (items.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No ${params.resource_type} found in namespace "${params.namespace}".`,
        },
      ],
    };
  }

  const lines = [
    `Found ${items.length} ${params.resource_type} in namespace "${params.namespace}":\n`,
  ];

  for (const item of items) {
    const name = item.name || item.metadata?.name || "unknown";
    const labels = item.labels || item.metadata?.labels || {};
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`- ${name}${labelStr ? ` [${labelStr}]` : ""}`);
  }

  lines.push(
    `\nUse xc_call_api with GET and the resource name to get details.`,
    `Example path: /api/config/namespaces/${params.namespace}/${params.resource_type}/{name}`,
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
