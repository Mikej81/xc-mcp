export interface CategoryDefinition {
  name: string;
  /** Match against the spec file's schema identifier (e.g., "http_loadbalancer", "dns_zone") */
  specKeywords: string[];
  /** Match against API path segments (more specific than spec keywords) */
  pathKeywords?: string[];
}

/**
 * Categories ordered from most specific to least specific.
 * More specific categories should come first to avoid false matches.
 */
export const CATEGORIES: CategoryDefinition[] = [
  {
    name: "AI/ML",
    specKeywords: ["ai_assistant", "ai_data", "inference"],
    pathKeywords: ["/api/gen-ai/", "/api/ai_data/", "/api/ml/"],
  },
  {
    name: "Bot Protection",
    specKeywords: ["bot_defense", "client_side_defense", "shape"],
  },
  {
    name: "DDoS Protection",
    specKeywords: ["ddos", "slow_ddos", "fast_acl"],
  },
  {
    name: "API Security",
    specKeywords: ["api_definition", "api_sec", "api_discovery", "api_group_element", "api_group", "api_endpoint", "api_inventory"],
    pathKeywords: ["/api_definitions/", "/api_endpoints/", "/api_inventory/"],
  },
  {
    name: "BIG-IP",
    specKeywords: ["uztna", "bigip"],
    pathKeywords: ["/api/bigipconnector/", "/api/uztna/"],
  },
  {
    name: "NGINX",
    specKeywords: ["nginx"],
    pathKeywords: ["/api/nginx/"],
  },
  {
    name: "Billing",
    specKeywords: ["billing", "usage", "pricing"],
    pathKeywords: ["/api/billing/"],
  },
  {
    name: "Support",
    specKeywords: ["support"],
    pathKeywords: ["/api/support/"],
  },
  {
    name: "Certificates",
    specKeywords: ["certificate", "trusted_ca_list"],
  },
  {
    name: "DNS",
    specKeywords: ["dns_zone", "dns_domain", "dns_lb"],
    pathKeywords: ["/api/config/dns/", "/dns_zone", "/dns_domain", "/dns_lb"],
  },
  {
    name: "Load Balancing",
    specKeywords: ["http_loadbalancer", "tcp_loadbalancer", "origin_pool", "healthcheck"],
    pathKeywords: ["/http_loadbalancers", "/tcp_loadbalancers", "/origin_pools", "/healthchecks"],
  },
  {
    name: "Security",
    specKeywords: ["app_firewall", "service_policy", "waf", "malicious_user", "ip_prefix_set", "rate_limiter", "enhanced_firewall_policy", "forward_proxy_policy", "policy_rule", "protocol_policer"],
    pathKeywords: ["/app_firewalls", "/service_policys", "/malicious_users"],
  },
  {
    name: "Networking",
    specKeywords: ["virtual_network", "network_policy", "network_connector", "network_interface", "fleet", "site_mesh_group", "virtual_site", "bgp", "network_firewall", "virtual_host", "proxy", "srv6_network"],
    pathKeywords: ["/virtual_networks", "/network_policys", "/network_connectors", "/fleets"],
  },
  {
    name: "Cloud Sites",
    specKeywords: ["aws_vpc_site", "aws_tgw_site", "azure_vnet_site", "gcp_vpc_site", "voltstack_site", "appstack_site", "securemesh_site", "k8s_cluster", "registration", "site.ves-swagger", "cloud_site_info", "views.site"],
    pathKeywords: ["/aws_vpc_sites", "/aws_tgw_sites", "/azure_vnet_sites", "/gcp_vpc_sites", "/registrations"],
  },
  {
    name: "IAM",
    specKeywords: ["api_credential", "service_credential", "known_label", "known_label_key", "tenant_management", "signup", "pbac", "user.ves-swagger", "role.ves-swagger"],
    pathKeywords: ["/api_credentials", "/service_credentials", "/roles/", "/users/", "/api/web/"],
  },
  {
    name: "Monitoring",
    specKeywords: ["alert_policy", "alert_receiver", "alert.ves-swagger", "global_log", "access_log", "log_receiver", "log.ves-swagger"],
    pathKeywords: ["/alert_policys", "/alert_receivers", "/alerts/", "/logs/", "/log/"],
  },
  {
    name: "Operations",
    specKeywords: ["stored_object", "object_store", "secret_policy", "terraform_parameters", "token.ves-swagger", "views.status", "introspect"],
    pathKeywords: ["/introspect/", "/terraform/"],
  },
];

/**
 * Determine category for an operation based on its path, operationId, and spec filename.
 * Uses a two-pass approach: first tries spec filename (strongest signal), then path.
 */
export function categorize(path: string, operationId: string, specFile: string): string {
  const specLower = specFile.toLowerCase();
  const pathLower = path.toLowerCase();

  // First pass: match against spec filename (strongest signal)
  for (const cat of CATEGORIES) {
    for (const kw of cat.specKeywords) {
      if (specLower.includes(kw.toLowerCase())) {
        return cat.name;
      }
    }
  }

  // Second pass: match against path keywords
  for (const cat of CATEGORIES) {
    if (cat.pathKeywords) {
      for (const kw of cat.pathKeywords) {
        if (pathLower.includes(kw.toLowerCase())) {
          return cat.name;
        }
      }
    }
  }

  return "Other";
}
