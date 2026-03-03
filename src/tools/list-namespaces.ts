import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

export async function handleListNamespaces(
  config: TenantConfig,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const response = await callApi(config, "GET", "/api/web/namespaces");

  if (response.status !== 200) {
    return {
      content: [
        {
          type: "text",
          text: `Error listing namespaces: ${response.status} ${response.statusText}\n${JSON.stringify(response.body, null, 2)}`,
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
          text: "No namespaces found. This may indicate an authentication or permissions issue.",
        },
      ],
    };
  }

  const lines = [`Found ${items.length} namespaces:\n`];

  for (const item of items) {
    const name = item.name || item.metadata?.name || "unknown";
    const description = item.description || item.spec?.description || "";
    lines.push(`- ${name}${description ? ` -- ${description}` : ""}`);
  }

  lines.push(
    `\nUse these namespace names with xc_list_resources or xc_call_api to explore resources.`,
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
