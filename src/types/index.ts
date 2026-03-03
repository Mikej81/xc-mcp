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
}

export interface CallApiParams {
  method: string;
  path: string;
  path_params?: Record<string, string>;
  query_params?: Record<string, string>;
  body?: unknown;
  tenant?: string;
}

export interface ListNamespacesParams {
  tenant?: string;
}

export interface ListResourcesParams {
  namespace: string;
  resource_type: string;
  label_selector?: string;
  tenant?: string;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  truncated?: boolean;
}

export interface TenantConfig {
  name: string;
  apiToken: string;
  tenantUrl: string;
}

export interface ServerConfig {
  tenants: TenantConfig[];
  specsDir: string;
  indexPath: string;
}
