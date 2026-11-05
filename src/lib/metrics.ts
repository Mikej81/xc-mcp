/**
 * Minimal Prometheus registry (text exposition format 0.0.4). Dependency-free.
 * Label values must come from fixed sets; never pass tenant, path or user data.
 */

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface Counter { inc(labels?: Record<string, string>, n?: number): void }
export interface Gauge { set(value: number, labels?: Record<string, string>): void }
export interface Histogram { observe(value: number, labels?: Record<string, string>): void }

type Labels = Record<string, string>;
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Validate labels against the declared names and render in declared order (no braces). */
function labelString(metric: string, names: readonly string[], labels?: Labels): string {
  const given = labels ?? {};
  for (const k of Object.keys(given)) {
    if (!names.includes(k)) throw new Error(`metric ${metric}: unknown label "${k}"`);
  }
  for (const n of names) {
    if (!(n in given)) throw new Error(`metric ${metric}: missing label "${n}"`);
  }
  return names.map((n) => `${n}="${escapeLabel(String(given[n]))}"`).join(",");
}

const braces = (s: string) => (s ? `{${s}}` : "");

interface Registered {
  render(): string[];
  reset(): void;
}
const registry: Registered[] = [];

function header(name: string, help: string, type: string): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
}

function scalar(name: string, help: string, type: "counter" | "gauge", initial?: number) {
  const values = new Map<string, number>();
  const seed = () => { if (initial !== undefined) values.set("", initial); };
  seed();
  registry.push({
    render() {
      const lines = header(name, help, type);
      for (const key of [...values.keys()].sort()) lines.push(`${name}${braces(key)} ${values.get(key)}`);
      return lines;
    },
    reset() { values.clear(); seed(); },
  });
  return values;
}

function counter(name: string, help: string, names: readonly string[] = []): Counter {
  // Unlabelled counters are exposed at 0 from the start (Prometheus convention).
  const values = scalar(name, help, "counter", names.length === 0 ? 0 : undefined);
  return {
    inc(labels, n = 1) {
      const k = labelString(name, names, labels);
      if (!Number.isFinite(n) || n < 0) return;
      values.set(k, (values.get(k) ?? 0) + n);
    },
  };
}

function gauge(name: string, help: string, names: readonly string[] = [], initial?: number): Gauge {
  const values = scalar(name, help, "gauge", initial);
  return {
    set(value, labels) {
      const k = labelString(name, names, labels);
      if (!Number.isFinite(value)) return;
      values.set(k, value);
    },
  };
}

function histogram(name: string, help: string, names: readonly string[] = []): Histogram {
  if (names.includes("le")) throw new Error(`metric ${name}: "le" is reserved`);
  interface Series { buckets: number[]; sum: number; count: number }
  const series = new Map<string, Series>();
  registry.push({
    render() {
      const lines = header(name, help, "histogram");
      for (const key of [...series.keys()].sort()) {
        const s = series.get(key)!;
        const pre = key ? `${key},` : "";
        BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{${pre}le="${b}"} ${s.buckets[i]}`));
        lines.push(`${name}_bucket{${pre}le="+Inf"} ${s.count}`);
        lines.push(`${name}_sum${braces(key)} ${s.sum}`);
        lines.push(`${name}_count${braces(key)} ${s.count}`);
      }
      return lines;
    },
    reset() { series.clear(); },
  });
  return {
    observe(value, labels) {
      const k = labelString(name, names, labels);
      if (!Number.isFinite(value)) return;
      let s = series.get(k);
      if (!s) { s = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; series.set(k, s); }
      BUCKETS.forEach((b, i) => { if (value <= b) s!.buckets[i]++; });
      s.sum += value;
      s.count++;
    },
  };
}

export const buildInfo = gauge("xc_mcp_build_info", "Build information; value is always 1.", ["version", "mode"]);
export const sessionsActive = gauge("xc_mcp_sessions_active", "Active MCP sessions, including reserved slots.", [], 0);
export const sessionsCreated = counter("xc_mcp_sessions_created_total", "MCP sessions created.");
export const sessionRefusals = counter("xc_mcp_session_refusals_total", "Session creations refused, by reason.", ["reason"]);
export const sessionEvictions = counter("xc_mcp_session_evictions_total", "Sessions evicted, by reason.", ["reason"]);
export const authFailures = counter("xc_mcp_auth_failures_total", "Authentication failures, by reason.", ["reason"]);
export const toolCalls = counter("xc_mcp_tool_calls_total", "Tool calls, by tool and outcome.", ["tool", "outcome"]);
export const upstreamRequests = counter("xc_mcp_upstream_requests_total", "Upstream XC requests, by tool, method and status class.", ["tool", "method", "status_class"]);
export const upstreamDuration = histogram("xc_mcp_upstream_request_duration_seconds", "Upstream XC request duration in seconds.", ["tool", "method"]);

export function renderMetrics(): string {
  return registry.flatMap((m) => m.render()).join("\n") + "\n";
}

/**
 * Clear all samples (labelled series disappear); sessions_active and unlabelled counters return to 0.
 * Definitions stay.
 * This also clears build_info, so callers must set it again.
 */
export function resetMetrics(): void {
  for (const m of registry) m.reset();
}

/** Map an HTTP status from callApi to a label value. 0 = network failure, 408 = abort/timeout. */
export function statusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" | "network" | "timeout" {
  if (status === 408) return "timeout";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "network";
}
