import type { TenantConfig, SearchResourcesParams } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

const DNS_API_GROUP_RESOURCES = new Set([
  "dns_zones", "dns_load_balancers", "dns_lb_pools", "dns_lb_health_checks",
]);

function listPath(namespace: string, resourceType: string): string {
  const ns = encodeURIComponent(namespace);
  const rt = encodeURIComponent(resourceType);
  if (DNS_API_GROUP_RESOURCES.has(resourceType)) {
    return `/api/config/dns/namespaces/${ns}/${rt}`;
  }
  return `/api/config/namespaces/${ns}/${rt}`;
}

function matches(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(name);
  }
  return name.toLowerCase().includes(pattern.toLowerCase());
}

export async function handleSearchResources(
  config: TenantConfig,
  params: SearchResourcesParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let namespaces = params.namespaces;
  if (!namespaces || namespaces.length === 0) {
    const nsResp = await callApi(config, "GET", "/api/web/namespaces", { skipTruncation: true });
    if (nsResp.status !== 200) {
      return {
        content: [{ type: "text", text: `Failed to list namespaces: ${nsResp.status} ${nsResp.statusText}` }],
        isError: true,
      };
    }
    namespaces = (((nsResp.body as any).items as any[]) || []).map((i: any) => i.name).filter(Boolean);
  }
  if (params.max_namespaces && namespaces.length > params.max_namespaces) {
    namespaces = namespaces.slice(0, params.max_namespaces);
  }

  const matchesOut: Array<{ namespace: string; name: string; labels?: Record<string, string> }> = [];
  const errors: string[] = [];

  for (const ns of namespaces) {
    const queryParams: Record<string, string> = {};
    if (params.label_selector) queryParams.label_selector = params.label_selector;
    const resp = await callApi(config, "GET", listPath(ns, params.resource_type), {
      queryParams, skipTruncation: true,
    });
    if (resp.status !== 200) {
      errors.push(`${ns}: ${resp.status}`);
      continue;
    }
    const items = (((resp.body as any).items as any[]) || []) as any[];
    for (const item of items) {
      const name = item.name || item.metadata?.name;
      if (!name) continue;
      if (!matches(name, params.name_pattern)) continue;
      const labels = item.labels || item.metadata?.labels || undefined;
      matchesOut.push({ namespace: ns, name, labels });
    }
  }

  const lines: string[] = [];
  lines.push(`Searched ${namespaces.length} namespace(s) for ${params.resource_type}${params.name_pattern ? ` matching "${params.name_pattern}"` : ""}. Found ${matchesOut.length}.`);
  for (const m of matchesOut) {
    const labelStr = m.labels ? ` [${Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(", ")}]` : "";
    lines.push(`- ${m.namespace}/${m.name}${labelStr}`);
  }
  if (errors.length > 0) {
    lines.push(`\n${errors.length} namespace(s) errored: ${errors.slice(0, 5).join(", ")}${errors.length > 5 ? ", ..." : ""}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
