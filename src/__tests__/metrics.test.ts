import { describe, it, expect, beforeEach } from "vitest";
import {
  renderMetrics, resetMetrics, statusClass, METRICS_CONTENT_TYPE,
  buildInfo, sessionsActive, sessionsCreated, sessionRefusals, toolCalls, upstreamDuration, upstreamRequests,
} from "../lib/metrics.js";

const NAMES = [
  "xc_mcp_build_info", "xc_mcp_sessions_active", "xc_mcp_sessions_created_total",
  "xc_mcp_session_refusals_total", "xc_mcp_session_evictions_total", "xc_mcp_auth_failures_total",
  "xc_mcp_tool_calls_total", "xc_mcp_upstream_requests_total", "xc_mcp_upstream_request_duration_seconds",
];

describe("metrics registry", () => {
  beforeEach(() => resetMetrics());

  it("content type", () => {
    expect(METRICS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("fresh registry has HELP/TYPE for all nine metrics and no labelled samples", () => {
    const out = renderMetrics();
    for (const n of NAMES) {
      expect(out).toContain(`# HELP ${n} `);
      expect(out).toMatch(new RegExp(`# TYPE ${n} (counter|gauge|histogram)\\n`));
    }
    const samples = out.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(samples).toEqual(["xc_mcp_sessions_active 0", "xc_mcp_sessions_created_total 0"]);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("counter inc with labels", () => {
    toolCalls.inc({ tool: "xc_list_namespaces", outcome: "ok" });
    expect(renderMetrics()).toContain('xc_mcp_tool_calls_total{tool="xc_list_namespaces",outcome="ok"} 1\n');
    toolCalls.inc({ tool: "xc_list_namespaces", outcome: "ok" }, 2);
    expect(renderMetrics()).toContain('outcome="ok"} 3\n');
  });

  it("unlabelled counter", () => {
    sessionsCreated.inc();
    expect(renderMetrics()).toContain("\nxc_mcp_sessions_created_total 1\n");
  });

  it("gauge set overwrites", () => {
    sessionsActive.set(5);
    sessionsActive.set(2);
    const out = renderMetrics();
    expect(out).toContain("\nxc_mcp_sessions_active 2\n");
    expect(out).not.toContain("xc_mcp_sessions_active 5");
    buildInfo.set(1, { version: "0.6.1", mode: "hosted" });
    expect(renderMetrics()).toContain('xc_mcp_build_info{version="0.6.1",mode="hosted"} 1\n');
  });

  it("histogram buckets are cumulative with sum and count", () => {
    upstreamDuration.observe(0.3, { tool: "t", method: "GET" });
    const out = renderMetrics();
    const p = "xc_mcp_upstream_request_duration_seconds";
    const l = 'tool="t",method="GET"';
    expect(out).toContain(`${p}_bucket{${l},le="0.05"} 0\n`);
    expect(out).toContain(`${p}_bucket{${l},le="0.25"} 0\n`);
    expect(out).toContain(`${p}_bucket{${l},le="0.5"} 1\n`);
    expect(out).toContain(`${p}_bucket{${l},le="30"} 1\n`);
    expect(out).toContain(`${p}_bucket{${l},le="+Inf"} 1\n`);
    expect(out).toContain(`${p}_sum{${l}} 0.3\n`);
    expect(out).toContain(`${p}_count{${l}} 1\n`);
    upstreamDuration.observe(100, { tool: "t", method: "GET" });
    const out2 = renderMetrics();
    expect(out2).toContain(`le="30"} 1\n`);
    expect(out2).toContain(`le="+Inf"} 2\n`);
  });

  it("resetMetrics zeroes values", () => {
    sessionsActive.set(4);
    sessionsCreated.inc(2);
    sessionRefusals.inc({ reason: "global_cap" });
    upstreamDuration.observe(1, { tool: "t", method: "GET" });
    resetMetrics();
    const out = renderMetrics();
    expect(out).toContain("xc_mcp_sessions_active 0");
    expect(out).toContain("\nxc_mcp_sessions_created_total 0\n");
    expect(out).not.toContain("global_cap");
    expect(out).not.toContain("_count");
    expect(out).toContain("# HELP xc_mcp_session_refusals_total");
  });

  it("escapes label values", () => {
    upstreamRequests.inc({ tool: 'a\\b"c\nd', method: "GET", status_class: "2xx" });
    expect(renderMetrics()).toContain('tool="a\\\\b\\"c\\nd"');
  });

  it("sample lines are sorted deterministically", () => {
    toolCalls.inc({ tool: "b", outcome: "ok" });
    toolCalls.inc({ tool: "a", outcome: "ok" });
    const lines = renderMetrics().split("\n").filter((l) => l.startsWith("xc_mcp_tool_calls_total{"));
    expect(lines).toEqual([...lines].sort());
    expect(lines[0]).toContain('tool="a"');
  });
});

describe("label schema and guards", () => {
  beforeEach(() => resetMetrics());

  it("key order does not matter; rendered in declared order", () => {
    toolCalls.inc({ outcome: "ok", tool: "a" });
    toolCalls.inc({ tool: "a", outcome: "ok" });
    const lines = renderMetrics().split("\n").filter((l) => l.startsWith("xc_mcp_tool_calls_total{"));
    expect(lines).toEqual(['xc_mcp_tool_calls_total{tool="a",outcome="ok"} 2']);
  });
  it("missing label throws", () => {
    expect(() => toolCalls.inc({ tool: "a" })).toThrow(/missing label "outcome"/);
    expect(() => toolCalls.inc()).toThrow();
  });
  it("extra or unknown label throws", () => {
    expect(() => toolCalls.inc({ tool: "a", outcome: "ok", x: "y" })).toThrow(/unknown label "x"/);
    expect(() => sessionsCreated.inc({ a: "b" })).toThrow();
  });
  it("negative or non-finite values are ignored", () => {
    toolCalls.inc({ tool: "a", outcome: "ok" });
    toolCalls.inc({ tool: "a", outcome: "ok" }, -1);
    toolCalls.inc({ tool: "a", outcome: "ok" }, NaN);
    expect(renderMetrics()).toContain('outcome="ok"} 1\n');
    sessionsActive.set(3);
    sessionsActive.set(NaN);
    sessionsActive.set(Infinity);
    expect(renderMetrics()).toContain("xc_mcp_sessions_active 3\n");
    upstreamDuration.observe(0.3, { tool: "t", method: "GET" });
    upstreamDuration.observe(NaN, { tool: "t", method: "GET" });
    expect(renderMetrics()).toContain('_count{tool="t",method="GET"} 1\n');
  });
  it("100s observation lands only in +Inf", () => {
    upstreamDuration.observe(100, { tool: "t", method: "GET" });
    const out = renderMetrics();
    expect(out).toContain('le="30"} 0\n');
    expect(out).toContain('le="+Inf"} 1\n');
  });
});

describe("statusClass", () => {
  it("maps statuses", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(302)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe("network");
    expect(statusClass(408)).toBe("timeout");
  });
});
