import type { CallApiParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { encodePemFields } from "../lib/pem-encoding.js";
import { MAX_TOOL_OUTPUT } from "../lib/constants.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Merge two filtered fragments so paths that share a prefix keep each other's fields. */
function mergeFiltered(prev: unknown, next: unknown): unknown {
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(next)) {
      out[k] = k in out ? mergeFiltered(out[k], v) : v;
    }
    return out;
  }
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    return prev.map((p, i) => mergeFiltered(p, next[i]));
  }
  return next === undefined ? prev : next;
}

/**
 * Extract fields from a response body using dot-separated paths.
 * Supports comma-separated field list, e.g. "items[].name,items[].labels"
 * or simple top-level field names like "items,metadata".
 *
 * Returns { filtered, matchedAny } so callers can detect empty matches.
 */
export function filterResponse(body: unknown, filter: string): { filtered: unknown; matchedAny: boolean } {
  if (!body || typeof body !== "object" || !filter) return { filtered: body, matchedAny: true };

  const paths = filter.split(",").map((p) => p.trim()).filter(Boolean);
  const result: Record<string, unknown> = {};
  let matchedAny = false;

  for (const path of paths) {
    const parts = path.split(".");
    let source: any = body;
    let target: any = result;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isArrayAccess = part.endsWith("[]");
      const key = isArrayAccess ? part.slice(0, -2) : part;
      const isLast = i === parts.length - 1;

      if (source == null || typeof source !== "object") break;

      if (isLast) {
        if (source[key] !== undefined) {
          target[key] = target[key] === undefined ? source[key] : mergeFiltered(target[key], source[key]);
          matchedAny = true;
        }
      } else {
        if (isArrayAccess && Array.isArray(source[key])) {
          const remaining = parts.slice(i + 1).join(".");
          const inner = source[key].map((item: any) => filterResponse(item, remaining));
          const next = inner.map((r: { filtered: unknown }) => r.filtered);
          target[key] = target[key] === undefined ? next : mergeFiltered(target[key], next);
          if (inner.some((r: { matchedAny: boolean }) => r.matchedAny)) matchedAny = true;
          break;
        } else {
          if (target[key] === undefined) {
            target[key] = {};
          }
          source = source[key];
          target = target[key];
        }
      }
    }
  }

  return { filtered: result, matchedAny };
}

/**
 * Get sample top-level keys from a response body for diagnostic hints.
 */
function sampleKeys(body: unknown, max = 10): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body).slice(0, max);
}

/**
 * Apply LB body defaults:
 * - non_default_loadbalancer unless default_loadbalancer explicitly set
 * - port: 443 on https/https_auto_cert unless already specified
 */
function prepareLBBody(path: string, body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (!path.includes("/http_loadbalancers") && !path.includes("/tcp_loadbalancers")) return body;

  const b = body as Record<string, any>;
  const spec = b.spec;
  if (!spec || typeof spec !== "object") return body;

  const tlsLocations = [spec.https_auto_cert, spec.https, spec.http];

  for (const tls of tlsLocations) {
    if (tls && typeof tls === "object") {
      // Default to non_default_loadbalancer
      if (!("default_loadbalancer" in tls) && !("non_default_loadbalancer" in tls)) {
        tls.non_default_loadbalancer = {};
      }
      // Default port to 443 for HTTPS
      if (!("port" in tls) && (tls === spec.https || tls === spec.https_auto_cert)) {
        tls.port = 443;
      }
    }
  }

  return body;
}

export async function handleCallApi(
  config: TenantConfig,
  params: CallApiParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const preparedBody = prepareLBBody(params.path, params.body);
  const response = await callApi(config, params.method, params.path, {
    pathParams: params.path_params,
    queryParams: params.query_params,
    body: await encodePemFields(config, params.path, preparedBody),
    skipTruncation: !!params.response_filter,
  });

  const output: any = {
    status: response.status,
    statusText: response.statusText,
  };

  const isError = response.status >= 400;

  if (response.truncated && !params.response_filter) {
    output.warning = "Response was truncated at 50KB. Use response_filter to extract specific fields.";
  }

  // Never apply response_filter to error responses — always return the full error body
  if (params.response_filter && !isError && response.body && typeof response.body === "object") {
    const { filtered, matchedAny } = filterResponse(response.body, params.response_filter);
    output.body = filtered;
    output.filtered = true;
    if (!matchedAny) {
      const available = sampleKeys(response.body);
      output.filter_warning =
        `response_filter "${params.response_filter}" matched no fields. ` +
        `Available top-level keys: [${available.join(", ")}]`;
    }
  } else {
    output.body = response.body;
  }

  let text = JSON.stringify(output);

  // When the compact form would exceed the tool-output cap, switch to
  // pretty-print and truncate. The pretty form is always longer than compact
  // for object payloads, so it never fits in the cap on its own — but giving
  // the truncated text line breaks makes any client-side disk spill readable.
  if (text.length > MAX_TOOL_OUTPUT) {
    text = JSON.stringify(output, null, 2).slice(0, MAX_TOOL_OUTPUT) + "\n... [Output truncated]";
  }

  return { content: [{ type: "text", text }] };
}
