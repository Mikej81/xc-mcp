/**
 * Shared logic for parsing resource references and stripping read-only fields
 * before round-tripping a GET → mutate → PUT cycle.
 */

export interface ResourceRef {
  resourceType: string;
  namespace: string;
  name: string;
  /** API path including /api/config/namespaces/.../{type}/{name} */
  path: string;
}

/**
 * Parse "resource_type/namespace/name" or already-formed API paths into a ResourceRef.
 *
 * Accepted forms:
 *   "http_loadbalancers/m-coleman/bigip-coexist-test"
 *   "/api/config/namespaces/m-coleman/http_loadbalancers/bigip-coexist-test"
 */
export function parseResourceRef(input: string, defaultNamespace?: string): ResourceRef {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");

  if (trimmed.startsWith("api/config/namespaces/")) {
    const parts = trimmed.split("/");
    // api / config / namespaces / {ns} / {type} / {name}
    if (parts.length < 6) {
      throw new Error(`Invalid resource path: "${input}"`);
    }
    const [, , , namespace, resourceType, name] = parts;
    return {
      resourceType,
      namespace,
      name,
      path: `/api/config/namespaces/${encodeURIComponent(namespace)}/${encodeURIComponent(resourceType)}/${encodeURIComponent(name)}`,
    };
  }

  const parts = trimmed.split("/");
  if (parts.length === 3) {
    const [resourceType, namespace, name] = parts;
    return {
      resourceType,
      namespace,
      name,
      path: `/api/config/namespaces/${encodeURIComponent(namespace)}/${encodeURIComponent(resourceType)}/${encodeURIComponent(name)}`,
    };
  }
  if (parts.length === 2 && defaultNamespace) {
    const [resourceType, name] = parts;
    return {
      resourceType,
      namespace: defaultNamespace,
      name,
      path: `/api/config/namespaces/${encodeURIComponent(defaultNamespace)}/${encodeURIComponent(resourceType)}/${encodeURIComponent(name)}`,
    };
  }

  throw new Error(
    `Invalid resource reference: "${input}". ` +
      `Expected "resource_type/namespace/name" or "/api/config/namespaces/{ns}/{type}/{name}".`,
  );
}

/**
 * Read-only / server-managed fields that XC rejects (or silently ignores) on PUT.
 * Stripped from the GET'd body before mutation.
 */
const TOP_LEVEL_READONLY = new Set(["system_metadata", "status"]);
const METADATA_READONLY = new Set([
  "uid",
  "creation_timestamp",
  "modification_timestamp",
  "tenant",
  "creator_class",
  "creator_id",
]);
const SPEC_READONLY = new Set(["view_internal"]);

/**
 * Returns a deep-cloned copy of `body` with read-only fields stripped.
 * Preserves `metadata.namespace` and `metadata.name` (XC requires they match the URL).
 * Preserves top-level `resource_version` so callers may reuse it for concurrency.
 */
export function stripReadOnlyFields(body: unknown): Record<string, any> {
  if (!body || typeof body !== "object") {
    throw new Error("Resource body is not an object");
  }
  const cloned = JSON.parse(JSON.stringify(body));

  for (const key of TOP_LEVEL_READONLY) {
    delete cloned[key];
  }
  if (cloned.metadata && typeof cloned.metadata === "object") {
    for (const key of METADATA_READONLY) {
      delete cloned.metadata[key];
    }
  }
  if (cloned.spec && typeof cloned.spec === "object") {
    for (const key of SPEC_READONLY) {
      delete cloned.spec[key];
    }
  }

  return cloned;
}

/**
 * Extract a `resource_version` value if present on either the top-level body
 * or `body.metadata` (XC has historically returned it in both spots).
 */
export function extractResourceVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, any>;
  if (typeof b.resource_version === "string") return b.resource_version;
  if (b.metadata && typeof b.metadata === "object" && typeof b.metadata.resource_version === "string") {
    return b.metadata.resource_version;
  }
  return undefined;
}
