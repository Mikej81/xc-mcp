#!/usr/bin/env tsx
/**
 * Smoke test for the four 0.2.0 tools against a live F5 XC tenant.
 *
 * Reads the same env vars as the server: XC_API_TOKEN + XC_TENANT_URL, or
 * XC_TENANT_<NAME>_URL / XC_TENANT_<NAME>_TOKEN for multi-tenant setups.
 *
 * Usage:
 *   tsx scripts/smoke-test.ts <namespace> <lb_name> [--tenant <name>] [--allow-mutations]
 *
 * Without --allow-mutations only the read-only tools (query_access_logs,
 * lb_wait_ready, diff_resource) run. With it, xc_patch_resource adds a
 * label, verifies it via GET, then removes the label to leave the resource
 * exactly as it started.
 */

import { parseTenantEnvVars, resolveTenant } from "../src/lib/tenant.js";
import { callApi } from "../src/lib/api-client.js";
import { handleQueryAccessLogs } from "../src/tools/query-access-logs.js";
import { handleWaitReady } from "../src/tools/wait-ready.js";
import { handleDiffResource } from "../src/tools/diff-resource.js";
import { handlePatchResource } from "../src/tools/patch-resource.js";
import type { TenantConfig } from "../src/types/index.js";

interface Args {
  namespace: string;
  lbName: string;
  tenantName?: string;
  allowMutations: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let tenantName: string | undefined;
  let allowMutations = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") {
      tenantName = argv[++i];
    } else if (a === "--allow-mutations") {
      allowMutations = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 2) {
    throw new Error(
      "Expected: <namespace> <lb_name> [--tenant <name>] [--allow-mutations]",
    );
  }

  return { namespace: positional[0], lbName: positional[1], tenantName, allowMutations };
}

function header(title: string) {
  const bar = "=".repeat(72);
  console.log(`\n${bar}\n${title}\n${bar}`);
}

function step(title: string) {
  console.log(`\n--- ${title} ---`);
}

function printResult(label: string, result: { content: Array<{ text: string }>; isError?: boolean }) {
  const text = result.content[0]?.text ?? "(no output)";
  if (result.isError) {
    console.log(`${label}: ISERROR`);
  } else {
    console.log(`${label}: ok`);
  }
  // Try to pretty-print JSON; fall back to raw
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

async function testQueryAccessLogs(tenant: TenantConfig, args: Args) {
  header("xc_query_access_logs (read-only)");

  // Last 5 minutes
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60 * 1000);

  step("Plain query, no aggregation");
  const r1 = await handleQueryAccessLogs(tenant, {
    namespace: args.namespace,
    lb_name: args.lbName,
    start: start.toISOString(),
    end: end.toISOString(),
    page_size: 25,
    max_pages: 2,
  });
  printResult("plain", r1);

  step("Same window grouped by rsp_code_details");
  const r2 = await handleQueryAccessLogs(tenant, {
    namespace: args.namespace,
    lb_name: args.lbName,
    start: start.toISOString(),
    end: end.toISOString(),
    group_by: "rsp_code_details",
    page_size: 100,
    max_pages: 5,
  });
  printResult("group_by", r2);
}

async function testWaitReady(tenant: TenantConfig, args: Args) {
  header("xc_lb_wait_ready (read-only)");
  step("Polling LB cert_state with 30s timeout");
  const r = await handleWaitReady(tenant, {
    namespace: args.namespace,
    lb_name: args.lbName,
    timeout_seconds: 30,
    poll_interval_seconds: 5,
  });
  printResult("wait_ready", r);
}

async function testDiffResource(tenant: TenantConfig, args: Args) {
  header("xc_diff_resource (read-only)");

  step("Diff against current LB body (echoed back)");
  const path = `/api/config/namespaces/${encodeURIComponent(args.namespace)}/http_loadbalancers/${encodeURIComponent(args.lbName)}`;
  const get = await callApi(tenant, "GET", path, { skipTruncation: true });
  if (get.status >= 400) {
    console.log(`GET failed: ${get.status} ${get.statusText}`);
    console.log(JSON.stringify(get.body, null, 2));
    return;
  }
  const echoed = await handleDiffResource(tenant, {
    resource: `http_loadbalancers/${args.namespace}/${args.lbName}`,
    body: get.body as any,
  });
  printResult("echoed (expect unchanged: true)", echoed);

  step("Diff with description modified");
  const modified = JSON.parse(JSON.stringify(get.body));
  if (!modified.metadata) modified.metadata = {};
  modified.metadata.description = `${modified.metadata.description ?? ""} [smoke-test ${Date.now()}]`;
  const r = await handleDiffResource(tenant, {
    resource: `http_loadbalancers/${args.namespace}/${args.lbName}`,
    body: modified,
  });
  printResult("modified (expect 1 op on /metadata/description)", r);
}

async function testPatchResource(tenant: TenantConfig, args: Args) {
  header("xc_patch_resource (mutations)");

  const labelKey = "xc_mcp_smoke_test";
  const labelVal = String(Date.now());
  const resourceRef = `http_loadbalancers/${args.namespace}/${args.lbName}`;
  const path = `/api/config/namespaces/${encodeURIComponent(args.namespace)}/http_loadbalancers/${encodeURIComponent(args.lbName)}`;

  step(`Add label ${labelKey}=${labelVal}`);
  const addOp = await handlePatchResource(tenant, {
    resource: resourceRef,
    ops: [{ op: "add", path: `/metadata/labels/${labelKey}`, value: labelVal } as any],
  });
  printResult("add label", addOp);
  if (addOp.isError) {
    console.log("Stopping: add failed. Resource not modified, no cleanup needed.");
    return;
  }

  step("GET to confirm the label is present");
  const verify = await callApi(tenant, "GET", path, { skipTruncation: true });
  const seen = (verify.body as any)?.metadata?.labels?.[labelKey];
  console.log(`label value seen: ${JSON.stringify(seen)} (expected ${JSON.stringify(labelVal)})`);

  step(`Remove label ${labelKey} (cleanup)`);
  const rmOp = await handlePatchResource(tenant, {
    resource: resourceRef,
    ops: [{ op: "remove", path: `/metadata/labels/${labelKey}` } as any],
  });
  printResult("remove label", rmOp);

  step("GET to confirm the label is gone");
  const after = await callApi(tenant, "GET", path, { skipTruncation: true });
  const stillThere = (after.body as any)?.metadata?.labels?.[labelKey];
  console.log(`label after cleanup: ${stillThere === undefined ? "absent (good)" : `STILL PRESENT: ${stillThere}`}`);
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const tenants = parseTenantEnvVars();
  const resolved = resolveTenant(tenants, args.tenantName);
  if (typeof resolved === "string") {
    console.error(`Error: ${resolved}`);
    process.exit(1);
  }
  const tenant = resolved;

  console.log(`Tenant: ${tenant.name} (${tenant.tenantUrl})`);
  console.log(`Target: http_loadbalancers/${args.namespace}/${args.lbName}`);
  console.log(`Mutations allowed: ${args.allowMutations}`);

  await testQueryAccessLogs(tenant, args);
  await testWaitReady(tenant, args);
  await testDiffResource(tenant, args);

  if (args.allowMutations) {
    await testPatchResource(tenant, args);
  } else {
    header("xc_patch_resource: SKIPPED");
    console.log("Pass --allow-mutations to test the patch path. The script");
    console.log("adds a temporary label, verifies it, then removes it.");
  }

  console.log("\nSmoke test complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
