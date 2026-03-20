/**
 * Minimal working example bodies for common F5 XC resource types.
 * Returned by xc_get_operation_details to avoid 10k+ token schema dumps.
 *
 * Each template includes placeholders marked with <REPLACE> for values
 * the LLM must fill in, and sensible defaults for everything else.
 */

export interface ResourceTemplate {
  description: string;
  example_body: Record<string, unknown>;
}

const HTTPS_LB_AUTO_CERT: ResourceTemplate = {
  description: "HTTPS LB with auto-cert (Let's Encrypt), WAF, and origin pool",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      domains: ["<REPLACE: domain>"],
      https_auto_cert: {
        http_redirect: true,
        add_hsts: false,
        port: 443,
        tls_config: { default_security: {} },
        no_mtls: {},
        default_header: {},
        enable_path_normalize: {},
        non_default_loadbalancer: {},
      },
      advertise_on_public_default_vip: {},
      default_route_pools: [
        {
          pool: { namespace: "<REPLACE>", name: "<REPLACE: origin pool name>" },
          weight: 1,
          priority: 1,
        },
      ],
      app_firewall: { namespace: "<REPLACE>", name: "<REPLACE: waf name>" },
      disable_rate_limit: {},
      round_robin: {},
      service_policies_from_namespace: {},
      no_challenge: {},
    },
  },
};

const HTTPS_LB_WITH_CERT: ResourceTemplate = {
  description: "HTTPS LB with custom certificate object. Use xc_create_cert to generate and create the cert, then reference it by name.",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      domains: ["<REPLACE: domain>"],
      https: {
        http_redirect: true,
        port: 443,
        tls_cert_params: {
          certificates: [
            { namespace: "<REPLACE>", name: "<REPLACE: certificate object name>" },
          ],
          no_mtls: {},
          tls_config: { default_security: {} },
        },
        default_header: {},
        enable_path_normalize: {},
        non_default_loadbalancer: {},
      },
      advertise_on_public_default_vip: {},
      default_route_pools: [
        {
          pool: { namespace: "<REPLACE>", name: "<REPLACE: origin pool name>" },
          weight: 1,
          priority: 1,
        },
      ],
      app_firewall: { namespace: "<REPLACE>", name: "<REPLACE: waf name>" },
      disable_rate_limit: {},
      round_robin: {},
      service_policies_from_namespace: {},
      no_challenge: {},
    },
  },
};

const ORIGIN_POOL: ResourceTemplate = {
  description: "Origin pool with public IP upstream",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      origin_servers: [
        { public_ip: { ip: "<REPLACE: upstream IP>" } },
      ],
      port: 80,
      no_tls: {},
      endpoint_selection: "LOCAL_PREFERRED",
      loadbalancer_algorithm: "LB_OVERRIDE",
    },
  },
};

const ORIGIN_POOL_K8S: ResourceTemplate = {
  description: "Origin pool with Kubernetes service upstream",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      origin_servers: [
        {
          k8s_service: {
            service_name: "<REPLACE: service.namespace>",
            site_locator: {
              virtual_site: {
                namespace: "shared",
                name: "<REPLACE: vsite name>",
              },
            },
          },
        },
      ],
      port: 80,
      no_tls: {},
      endpoint_selection: "LOCAL_PREFERRED",
      loadbalancer_algorithm: "LB_OVERRIDE",
    },
  },
};

const APP_FIREWALL: ResourceTemplate = {
  description: "App firewall (WAF) in blocking mode with default settings",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      blocking: {},
      detection_settings: {
        signature_selection_setting: {
          default_attack_type_settings: {},
          high_medium_accuracy_signatures: {},
        },
        enable_suppression: {},
        enable_threat_campaigns: {},
      },
      allow_all_response_codes: {},
      default_anonymization: {},
    },
  },
};

const CERTIFICATE: ResourceTemplate = {
  description: "Certificate object. Raw PEM values are auto-encoded and private keys are auto-blindfold-encrypted by the MCP server.",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      certificate_url: "<REPLACE: raw PEM certificate -- auto-encoded by MCP>",
      private_key: {
        blindfold_secret_info: {
          location: "<REPLACE: raw PEM private key -- auto-blindfold-encrypted by MCP>",
        },
      },
    },
  },
};

const TCP_LB: ResourceTemplate = {
  description: "TCP load balancer with origin pool",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      listen_port: 443,
      dns_volterra_managed: true,
      domains: ["<REPLACE: domain>"],
      advertise_on_public_default_vip: {},
      default_pool_list: {
        pools: [
          {
            pool: { namespace: "<REPLACE>", name: "<REPLACE: origin pool name>" },
            priority: 1, weight: 1,
          },
        ],
      },
      retract_cluster: {},
      hash_policy_choice_round_robin: {},
    },
  },
};

const HEALTHCHECK: ResourceTemplate = {
  description: "HTTP health check",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      http_health_check: {
        use_origin_server_name: {},
        path: "/",
        use_http2: false,
      },
      timeout: 3,
      interval: 15,
      unhealthy_threshold: 3,
      healthy_threshold: 2,
    },
  },
};

const DNS_ZONE: ResourceTemplate = {
  description: "DNS zone (primary)",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      primary: {
        default_soa_parameters: {},
        dnssec_mode: { disable: {} },
        rr_set_group: [],
      },
    },
  },
};

const SERVICE_POLICY: ResourceTemplate = {
  description: "Service policy with allow/deny rules",
  example_body: {
    metadata: { name: "<REPLACE>", namespace: "<REPLACE>" },
    spec: {
      algo: "FIRST_MATCH",
      any_server: {},
      rule_list: {
        rules: [
          {
            metadata: { name: "<REPLACE: rule name>" },
            spec: {
              action: "ALLOW",
              any_client: {},
              any_ip: {},
              challenge_action: "DEFAULT_CHALLENGE",
              waf_action: { none: {} },
            },
          },
        ],
      },
    },
  },
};

/**
 * Map of resource type (from API path) to templates.
 * Multiple templates per type when there are common variants.
 */
const TEMPLATES: Record<string, ResourceTemplate[]> = {
  http_loadbalancers: [HTTPS_LB_AUTO_CERT, HTTPS_LB_WITH_CERT],
  tcp_loadbalancers: [TCP_LB],
  origin_pools: [ORIGIN_POOL, ORIGIN_POOL_K8S],
  app_firewalls: [APP_FIREWALL],
  certificates: [CERTIFICATE],
  healthchecks: [HEALTHCHECK],
  dns_zones: [DNS_ZONE],
  service_policys: [SERVICE_POLICY],
};

/**
 * Get templates for a resource type extracted from an API path.
 * Returns undefined if no templates exist for this resource type.
 */
export function getTemplatesForPath(apiPath: string): ResourceTemplate[] | undefined {
  for (const [resourceType, templates] of Object.entries(TEMPLATES)) {
    if (apiPath.includes(`/${resourceType}`)) {
      return templates;
    }
  }
  return undefined;
}
