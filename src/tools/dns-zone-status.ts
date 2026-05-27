import type { TenantConfig, DnsZoneStatusParams } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

export async function handleDnsZoneStatus(
  config: TenantConfig,
  params: DnsZoneStatusParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const ns = encodeURIComponent(params.namespace);
  const name = encodeURIComponent(params.name);

  const configResp = await callApi(config, "GET", `/api/config/dns/namespaces/${ns}/dns_zones/${name}`, { skipTruncation: true });
  if (configResp.status !== 200) {
    return {
      content: [{ type: "text", text: `Zone GET failed: ${configResp.status} ${configResp.statusText}\n${JSON.stringify(configResp.body)}` }],
      isError: true,
    };
  }

  const body = configResp.body as any;
  const status0 = (body.status && body.status[0]) || {};
  const verification = status0.verification_status || {};
  const deploymentStatus: string | undefined = verification.deployment_status;
  const nameservers: string[] = verification.volterra_nameservers || [];
  const conditions = (status0.conditions || []) as Array<{ type: string; status: string; reason?: string }>;
  const operational = conditions.find((c) => c.type === "Operational");

  let dataPlaneReachable: boolean | null = null;
  let dataPlaneStatus: number | null = null;
  if (params.include_zone_file) {
    const zfResp = await callApi(config, "GET", `/api/config/dns/namespaces/${ns}/dns_zone/${name}/local_zone_file`, { skipTruncation: true });
    dataPlaneStatus = zfResp.status;
    dataPlaneReachable = zfResp.status >= 200 && zfResp.status < 300;
  }

  const flags: string[] = [];
  if (deploymentStatus === "DNS_ZONE_ACTIVE" && dataPlaneReachable === false) {
    flags.push("control_plane_active_but_data_plane_unreachable");
  }
  if (deploymentStatus && deploymentStatus !== "DNS_ZONE_ACTIVE") {
    flags.push(`deployment_status_is_${deploymentStatus.toLowerCase()}`);
  }

  const summary = {
    name: params.name,
    namespace: params.namespace,
    domain: body.spec?.domain,
    deployment_status: deploymentStatus,
    operational_condition: operational || null,
    nameservers,
    data_plane_reachable: dataPlaneReachable,
    data_plane_probe_status: dataPlaneStatus,
    flags,
  };

  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
}
