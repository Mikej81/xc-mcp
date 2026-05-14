import type { ApiResponse, TenantConfig } from "../types/index.js";
import { MAX_RESPONSE_SIZE, REQUEST_TIMEOUT_MS } from "./constants.js";

/**
 * Substitute path parameters into a URL path template.
 * e.g., "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"
 * with { namespace: "default", name: "my-lb" }
 * becomes "/api/config/namespaces/default/http_loadbalancers/my-lb"
 */
export function substitutePath(
  pathTemplate: string,
  pathParams: Record<string, string>,
): string {
  let result = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    // Handle both {key} and {metadata.key} patterns
    result = result.replace(new RegExp(`\\{${escapeRegex(key)}\\}`, "g"), encodeURIComponent(value));
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function callApi(
  config: TenantConfig,
  method: string,
  pathTemplate: string,
  options: {
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: unknown;
    skipTruncation?: boolean;
  } = {},
): Promise<ApiResponse> {
  const { pathParams = {}, queryParams = {}, body, skipTruncation = false } = options;

  const path = substitutePath(pathTemplate, pathParams);
  const url = new URL(path, config.tenantUrl);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.apiToken) {
    headers.Authorization = `APIToken ${config.apiToken}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      ...(config.p12Dispatcher ? { dispatcher: config.p12Dispatcher } : {}),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const text = await response.text();
    let truncated = false;
    let responseBody: unknown;

    if (!skipTruncation && text.length > MAX_RESPONSE_SIZE) {
      truncated = true;
      const truncatedText = text.slice(0, MAX_RESPONSE_SIZE);
      try {
        responseBody = JSON.parse(truncatedText);
      } catch {
        responseBody = truncatedText + "\n... [TRUNCATED at 50KB]";
      }
    } else {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      truncated,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          status: 408,
          statusText: "Request Timeout",
          headers: {},
          body: { error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` },
        };
      }
      return {
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: { error: error.message },
      };
    }
    return {
      status: 0,
      statusText: "Unknown Error",
      headers: {},
      body: { error: String(error) },
    };
  } finally {
    clearTimeout(timeout);
  }
}
