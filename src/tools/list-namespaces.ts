import type { ListNamespacesParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

export async function handleListNamespaces(
  config: TenantConfig,
  params?: ListNamespacesParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const queryParams: Record<string, string> = {};
  if (params?.label_selector) {
    queryParams.label_selector = params.label_selector;
  }

  const response = await callApi(config, "GET", "/api/web/namespaces", { queryParams });

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
  let items: any[] = body?.items || [];

  // Client-side prefix filter (XC API doesn't support server-side prefix filtering)
  if (params?.prefix) {
    const prefix = params.prefix.toLowerCase();
    items = items.filter((item: any) => {
      const name = (item.name || item.metadata?.name || "").toLowerCase();
      return name.startsWith(prefix);
    });
  }

  if (items.length === 0) {
    const suffix = params?.prefix ? ` matching prefix "${params.prefix}"` : "";
    return {
      content: [
        {
          type: "text",
          text: `No namespaces found${suffix}. This may indicate an authentication or permissions issue.`,
        },
      ],
    };
  }

  const totalCount = (body?.items || []).length;
  const filteredNote = params?.prefix ? ` (filtered from ${totalCount} total)` : "";
  const lines = [`Found ${items.length} namespaces${filteredNote}:\n`];

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
