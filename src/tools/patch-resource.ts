import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { applyPatch, type JsonPatchOp } from "../lib/json-patch.js";
import {
  extractResourceVersion,
  parseResourceRef,
  stripReadOnlyFields,
} from "../lib/resource-mutate.js";

export interface PatchResourceParams {
  resource: string;
  ops: JsonPatchOp[];
  tenant?: string;
  check_resource_version?: boolean;
}

export async function handlePatchResource(
  config: TenantConfig,
  params: PatchResourceParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!Array.isArray(params.ops) || params.ops.length === 0) {
    return {
      content: [{ type: "text", text: "Error: ops must be a non-empty array of JSON-Patch operations." }],
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

  const versionBefore = extractResourceVersion(getResp.body);

  let stripped: Record<string, any>;
  try {
    stripped = stripReadOnlyFields(getResp.body);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }

  let mutated: Record<string, any>;
  try {
    mutated = applyPatch(stripped, params.ops);
  } catch (err) {
    return {
      content: [{ type: "text", text: `JSON-Patch apply failed: ${(err as Error).message}` }],
      isError: true,
    };
  }

  // Concurrency: by default echo resource_version back to XC for optimistic-lock check.
  // Opting out strips it so XC accepts the PUT regardless of version drift.
  if (params.check_resource_version === false) {
    delete mutated.resource_version;
  } else if (versionBefore && !mutated.resource_version) {
    mutated.resource_version = versionBefore;
  }

  const putResp = await callApi(config, "PUT", ref.path, { body: mutated, skipTruncation: true });
  if (putResp.status >= 400) {
    return {
      content: [
        {
          type: "text",
          text: `PUT failed: ${putResp.status} ${putResp.statusText}\n${JSON.stringify(putResp.body)}`,
        },
      ],
      isError: true,
    };
  }

  const versionAfter = extractResourceVersion(putResp.body);
  const summary = {
    resource: `${ref.resourceType}/${ref.namespace}/${ref.name}`,
    status: putResp.status,
    ops_applied: params.ops.length,
    resource_version_before: versionBefore ?? null,
    resource_version_after: versionAfter ?? null,
  };

  return { content: [{ type: "text", text: JSON.stringify(summary) }] };
}
