export interface OperationIndexEntry {
  /** method:path composite key */
  key: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  operationId: string;
  category: string;
  /** Tags from spec */
  tags: string[];
  /** Path parameters */
  pathParams: string[];
  /** Query parameters */
  queryParams: string[];
  /** Whether operation has a request body */
  hasRequestBody: boolean;
  /** Source spec filename */
  specFile: string;
  /** Resource type extracted from path (e.g. "http_loadbalancers") */
  resourceType: string;
}

export interface OperationsIndex {
  version: string;
  generatedAt: string;
  totalOperations: number;
  categories: string[];
  operations: OperationIndexEntry[];
}

export interface DiscoverParams {
  query?: string;
  category?: string;
  method?: string;
  resource_type?: string;
  limit?: number;
  offset?: number;
}

export interface OperationDetailsParams {
  operation_key: string;
  max_depth?: number;
  include_response_schema?: boolean;
  include_full_schema?: boolean;
  summary_mode?: boolean;
}

export interface CallApiParams {
  method: string;
  path: string;
  path_params?: Record<string, string>;
  query_params?: Record<string, string>;
  body?: unknown;
  tenant?: string;
  response_filter?: string;
}

export interface ListNamespacesParams {
  tenant?: string;
  prefix?: string;
  label_selector?: string;
}

export interface ListResourcesParams {
  namespace: string;
  resource_type: string;
  label_selector?: string;
  tenant?: string;
  fields?: string[];
  max_items?: number;
  verify?: boolean;
}

export interface SearchResourcesParams {
  resource_type: string;
  name_pattern?: string;
  namespaces?: string[];
  label_selector?: string;
  tenant?: string;
  max_namespaces?: number;
}

export interface DnsZoneStatusParams {
  namespace: string;
  name: string;
  tenant?: string;
  include_zone_file?: boolean;
}

export interface LbSetRequestHeadersParams {
  namespace: string;
  name: string;
  add?: Array<{ name: string; value: string }>;
  remove?: string[];
  tenant?: string;
  check_resource_version?: boolean;
}

export interface PoolHealthcheckParams {
  namespace: string;
  pool_name: string;
  healthcheck_name: string;
  tenant?: string;
  check_resource_version?: boolean;
}

export interface QueryLbMetricsParams {
  namespace: string;
  lb_name: string;
  start: string;
  end: string;
  bucket?: "1m" | "5m" | "15m" | "1h";
  tenant?: string;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  truncated?: boolean;
  error_category?:
    | "backend_unavailable"
    | "timeout"
    | "auth_failure"
    | "not_found"
    | "permission_denied"
    | "rate_limited"
    | "validation_error"
    | "config_conflict"
    | "server_error";
}

import type { Dispatcher } from "undici";

export interface TenantConfig {
  name: string;
  /** API token auth. Mutually exclusive with p12Path. */
  apiToken?: string;
  /** P12 (PKCS#12) file path for mTLS auth. Mutually exclusive with apiToken. */
  p12Path?: string;
  /** Passphrase for the P12 file. Required when p12Path is set. */
  p12Password?: string;
  /** Populated at startup from p12Path/p12Password; consumed by fetch via its dispatcher option. */
  p12Dispatcher?: Dispatcher;
  tenantUrl: string;
  defaultNamespace?: string;
}

export type ServerMode = "local" | "hosted";

export interface HostedConfig {
  allowedDomains: string[];
  maxSessions: number;
  maxSessionsPerCredential: number;
  /** A session must be idle at least this long before a session cap may evict it. */
  evictMinIdleMs: number;
}

export interface ServerConfig {
  tenants: TenantConfig[];
  specsDir: string;
  indexPath: string;
  mode: ServerMode;
  hosted?: HostedConfig;
}
