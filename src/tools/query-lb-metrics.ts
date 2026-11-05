import type { TenantConfig, QueryLbMetricsParams } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { lbVhName } from "../lib/access-logs.js";

const BUCKET_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

function bucketStart(iso: string, bucketSec: number): string {
  const t = Math.floor(new Date(iso).getTime() / 1000);
  const b = t - (t % bucketSec);
  return new Date(b * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function handleQueryLbMetrics(
  config: TenantConfig,
  params: QueryLbMetricsParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const bucket = params.bucket || "1m";
  const bucketSec = BUCKET_SECONDS[bucket];
  if (!bucketSec) {
    return { content: [{ type: "text", text: `Invalid bucket: ${params.bucket}. Use 1m, 5m, 15m, or 1h.` }], isError: true };
  }

  const ns = encodeURIComponent(params.namespace);
  const baseBody = {
    query: `{vh_name="${lbVhName(params.lb_name)}"}`,
    namespace: params.namespace,
    start_time: params.start,
    end_time: params.end,
    aggregator: "FIELD_AGGREGATOR_NONE",
  };

  const buckets: Record<string, { total: number; by_class: Record<string, number> }> = {};
  let scroll: string | undefined;
  let pages = 0;
  do {
    const reqBody = scroll ? { ...baseBody, scroll_id: scroll } : baseBody;
    const resp = await callApi(config, "POST", `/api/data/namespaces/${ns}/access_logs`, {
      body: reqBody, skipTruncation: true,
    });
    if (resp.status >= 400) {
      return { content: [{ type: "text", text: `access_logs query failed: ${resp.status} ${resp.statusText}` }], isError: true };
    }
    const logs = (resp.body as any)?.logs;
    const data = (Array.isArray(logs) ? logs : []) as unknown[];
    for (const raw of data) {
      let entry: any;
      try {
        entry = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        continue;
      }
      if (!entry?.time) continue;
      const b = bucketStart(entry.time, bucketSec);
      if (!buckets[b]) buckets[b] = { total: 0, by_class: {} };
      buckets[b].total += 1;
      const cls = entry.rsp_code_class || "unknown";
      buckets[b].by_class[cls] = (buckets[b].by_class[cls] || 0) + 1;
    }
    scroll = (resp.body as any).scroll_id || undefined;
    pages += 1;
  } while (scroll && pages < 10);

  const sorted = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, v]) => ({ time, ...v }));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        lb: `${params.namespace}/${params.lb_name}`,
        bucket,
        start: params.start,
        end: params.end,
        buckets: sorted,
      }, null, 2),
    }],
  };
}
