import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { computeDiff } from "../lib/json-patch.js";
import { parseResourceRef, stripReadOnlyFields } from "../lib/resource-mutate.js";

export interface DiffResourceParams {
  resource: string;
  body: Record<string, unknown>;
  tenant?: string;
}

const DIFF_METADATA_FIELDS = ["name", "namespace", "labels", "annotations", "description", "disable"] as const;

/**
 * Reduce a resource body to the user-editable parts: selected metadata fields and spec.
 * A single-object GET also returns envelope keys (create_form, replace_form,
 * resource_version, referring_objects, ...) that a proposed body never carries,
 * so diffing the whole response reports them as removals.
 */
export function diffableView(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const md = body.metadata;
  if (md && typeof md === "object") {
    const picked: Record<string, unknown> = {};
    for (const k of DIFF_METADATA_FIELDS) {
      if (md[k] !== undefined) picked[k] = md[k];
    }
    out.metadata = picked;
  }
  if (body.spec !== undefined) out.spec = body.spec;
  return out;
}

export async function handleDiffResource(
  config: TenantConfig,
  params: DiffResourceParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!params.body || typeof params.body !== "object") {
    return {
      content: [{ type: "text", text: "Error: body must be an object representing the proposed resource state." }],
      isError: true,
    };
  }

  let ref;
  try {
    ref = parseResourceRef(params.resource, config.defaultNamespace);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }

  const getResp = await callApi(config, "GET", ref.path, { skipTruncation: true });
  if (getResp.status >= 400) {
    return {
      content: [
        {
          type: "text",
          text: `GET failed: ${getResp.status} ${getResp.statusText}\n${JSON.stringify(getResp.body)}`,
        },
      ],
      isError: true,
    };
  }

  let currentStripped: Record<string, any>;
  let proposedStripped: Record<string, any>;
  try {
    currentStripped = diffableView(stripReadOnlyFields(getResp.body));
    proposedStripped = diffableView(stripReadOnlyFields(params.body));
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }

  const patch = computeDiff(currentStripped, proposedStripped);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          resource: `${ref.resourceType}/${ref.namespace}/${ref.name}`,
          unchanged: patch.length === 0,
          patch,
        }),
      },
    ],
  };
}
