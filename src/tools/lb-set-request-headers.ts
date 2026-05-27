import type { TenantConfig, LbSetRequestHeadersParams } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { stripReadOnlyFields, extractResourceVersion } from "../lib/resource-mutate.js";

export async function handleLbSetRequestHeaders(
  config: TenantConfig,
  params: LbSetRequestHeadersParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if ((!params.add || params.add.length === 0) && (!params.remove || params.remove.length === 0)) {
    return { content: [{ type: "text", text: "Error: at least one of add/remove must be non-empty." }], isError: true };
  }

  const ns = encodeURIComponent(params.namespace);
  const name = encodeURIComponent(params.name);
  const path = `/api/config/namespaces/${ns}/http_loadbalancers/${name}`;

  const getResp = await callApi(config, "GET", path, { skipTruncation: true });
  if (getResp.status >= 400) {
    return {
      content: [{ type: "text", text: `GET failed: ${getResp.status} ${getResp.statusText}` }],
      isError: true,
    };
  }
  const versionBefore = extractResourceVersion(getResp.body);
  const stripped: any = stripReadOnlyFields(getResp.body);
  if (!stripped.spec) stripped.spec = {};
  const existing: Array<{ name: string; value: string }> = Array.isArray(stripped.spec.add_request_headers)
    ? stripped.spec.add_request_headers
    : [];

  const removeSet = new Set((params.remove || []).map((n) => n.toLowerCase()));
  let next = existing.filter((h) => !removeSet.has(h.name.toLowerCase()));

  if (params.add) {
    const addNames = new Set(params.add.map((h) => h.name.toLowerCase()));
    next = next.filter((h) => !addNames.has(h.name.toLowerCase()));
    next = next.concat(params.add.map(({ name, value }) => ({ name, value })));
  }

  stripped.spec.add_request_headers = next;
  // resource_version is preserved by stripReadOnlyFields, so we don't need to
  // reattach it explicitly. Strip it only when the caller opts out of the check.
  if (params.check_resource_version === false) {
    delete stripped.resource_version;
  }

  const putResp = await callApi(config, "PUT", path, { body: stripped, skipTruncation: true });
  if (putResp.status >= 400) {
    return {
      content: [{ type: "text", text: `PUT failed: ${putResp.status} ${putResp.statusText}\n${JSON.stringify(putResp.body)}` }],
      isError: true,
    };
  }
  const versionAfter = extractResourceVersion(putResp.body);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        lb: `${params.namespace}/${params.name}`,
        headers_after: next,
        resource_version_before: versionBefore ?? null,
        resource_version_after: versionAfter ?? null,
      }),
    }],
  };
}
