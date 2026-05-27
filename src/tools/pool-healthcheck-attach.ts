import type { TenantConfig, PoolHealthcheckParams } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { stripReadOnlyFields, extractResourceVersion } from "../lib/resource-mutate.js";

async function mutate(
  config: TenantConfig,
  params: PoolHealthcheckParams,
  mode: "attach" | "detach",
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const ns = encodeURIComponent(params.namespace);
  const name = encodeURIComponent(params.pool_name);
  const path = `/api/config/namespaces/${ns}/origin_pools/${name}`;

  const getResp = await callApi(config, "GET", path, { skipTruncation: true });
  if (getResp.status >= 400) {
    return { content: [{ type: "text", text: `GET origin_pool failed: ${getResp.status} ${getResp.statusText}` }], isError: true };
  }
  const versionBefore = extractResourceVersion(getResp.body);
  const stripped: any = stripReadOnlyFields(getResp.body);
  if (!stripped.spec) stripped.spec = {};
  const current: Array<{ name: string; namespace?: string }> = Array.isArray(stripped.spec.healthcheck)
    ? stripped.spec.healthcheck
    : [];

  let next: typeof current;
  if (mode === "attach") {
    if (current.some((h) => h.name === params.healthcheck_name)) {
      next = current;
    } else {
      next = current.concat([{ name: params.healthcheck_name, namespace: params.namespace }]);
    }
  } else {
    next = current.filter((h) => h.name !== params.healthcheck_name);
  }
  stripped.spec.healthcheck = next;

  // resource_version is preserved by stripReadOnlyFields; strip it only on opt-out.
  if (params.check_resource_version === false) {
    delete stripped.resource_version;
  }

  const putResp = await callApi(config, "PUT", path, { body: stripped, skipTruncation: true });
  if (putResp.status >= 400) {
    return { content: [{ type: "text", text: `PUT origin_pool failed: ${putResp.status} ${putResp.statusText}\n${JSON.stringify(putResp.body)}` }], isError: true };
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        pool: `${params.namespace}/${params.pool_name}`,
        mode,
        healthcheck: params.healthcheck_name,
        healthchecks_after: next,
        resource_version_before: versionBefore ?? null,
      }),
    }],
  };
}

export function handlePoolAttachHealthcheck(config: TenantConfig, params: PoolHealthcheckParams) {
  return mutate(config, params, "attach");
}
export function handlePoolDetachHealthcheck(config: TenantConfig, params: PoolHealthcheckParams) {
  return mutate(config, params, "detach");
}
