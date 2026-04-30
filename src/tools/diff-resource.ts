import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { computeDiff } from "../lib/json-patch.js";
import { parseResourceRef, stripReadOnlyFields } from "../lib/resource-mutate.js";

export interface DiffResourceParams {
  resource: string;
  body: Record<string, unknown>;
  tenant?: string;
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
    currentStripped = stripReadOnlyFields(getResp.body);
    proposedStripped = stripReadOnlyFields(params.body);
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
