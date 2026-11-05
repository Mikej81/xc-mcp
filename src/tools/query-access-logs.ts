import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { MAX_TOOL_OUTPUT } from "../lib/constants.js";
import { lbVhName } from "../lib/access-logs.js";

export interface QueryAccessLogsParams {
  namespace: string;
  lb_name?: string;
  start: string;
  end: string;
  rsp_code_class?: string;
  query?: string;
  group_by?: string;
  max_pages?: number;
  page_size?: number;
  tenant?: string;
}

interface AccessLogResponse {
  logs?: string[];
  scroll_id?: string;
  [k: string]: unknown;
}

/**
 * Build a Loki-style label query from convenience filters, e.g.:
 *   { vh_name="ves-io-http-loadbalancer-bigip-coexist-test", rsp_code_class="5xx" }
 */
function buildQuery(params: QueryAccessLogsParams): string {
  if (params.query) return params.query;
  const labels: string[] = [];
  if (params.lb_name) labels.push(`vh_name="${lbVhName(params.lb_name)}"`);
  if (params.rsp_code_class) labels.push(`rsp_code_class="${params.rsp_code_class}"`);
  return `{${labels.join(",")}}`;
}

/**
 * Resolve a dot-path against a parsed log entry, returning a string key for grouping.
 */
function resolvePath(entry: any, path: string): string {
  const parts = path.split(".");
  let cur: any = entry;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return "(missing)";
    cur = cur[part];
  }
  if (cur == null) return "(missing)";
  if (typeof cur === "object") return JSON.stringify(cur);
  return String(cur);
}

export async function handleQueryAccessLogs(
  config: TenantConfig,
  params: QueryAccessLogsParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!params.start || !params.end) {
    return {
      content: [{ type: "text", text: "Error: start and end are required (RFC3339 timestamps)." }],
      isError: true,
    };
  }

  const path = `/api/data/namespaces/${encodeURIComponent(params.namespace)}/access_logs`;
  const maxPages = Math.max(1, params.max_pages ?? 5);
  const pageSize = Math.max(1, Math.min(params.page_size ?? 100, 500));
  const query = buildQuery(params);

  const entries: any[] = [];
  let scrollId: string | undefined;
  let pages = 0;
  let parseErrors = 0;

  while (pages < maxPages) {
    const body: Record<string, unknown> = scrollId
      ? { scroll_id: scrollId }
      : {
          query,
          start_time: params.start,
          end_time: params.end,
          limit: pageSize,
          // XC supports "aggs" and "namespace" — leave defaults
          namespace: params.namespace,
        };

    const resp = await callApi(config, "POST", path, { body, skipTruncation: true });
    pages += 1;

    if (resp.status >= 400) {
      return {
        content: [
          {
            type: "text",
            text: `Access log query failed at page ${pages}: ${resp.status} ${resp.statusText}\n${JSON.stringify(resp.body)}`,
          },
        ],
        isError: true,
      };
    }

    const data = resp.body as AccessLogResponse;
    const rawLogs = Array.isArray(data?.logs) ? data.logs : [];

    for (const raw of rawLogs) {
      try {
        entries.push(typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch {
        parseErrors += 1;
      }
    }

    scrollId = typeof data?.scroll_id === "string" && data.scroll_id.length > 0 ? data.scroll_id : undefined;
    if (!scrollId || rawLogs.length === 0) break;
  }

  const summary: any = {
    namespace: params.namespace,
    query,
    pages_fetched: pages,
    entries: entries.length,
    parse_errors: parseErrors,
    truncated: pages >= maxPages && scrollId !== undefined,
  };

  if (params.group_by) {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      const key = resolvePath(entry, params.group_by);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const sorted = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .reduce<Record<string, number>>((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {});
    summary.group_by = params.group_by;
    summary.counts = sorted;
  } else {
    summary.entries_data = entries;
  }

  let text = JSON.stringify(summary);
  if (text.length > MAX_TOOL_OUTPUT) {
    if (!params.group_by) {
      summary.entries_data = `[${entries.length} entries omitted -- output exceeded limit; use group_by or narrow the time range]`;
      text = JSON.stringify(summary);
    }
    if (text.length > MAX_TOOL_OUTPUT) {
      text = text.slice(0, MAX_TOOL_OUTPUT) + "\n... [Output truncated]";
    }
  }

  return { content: [{ type: "text", text }] };
}
