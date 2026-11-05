/** Prefix XC puts on the `vh_name` label of HTTP load balancer access logs. */
export const HTTP_LB_VH_PREFIX = "ves-io-http-loadbalancer-";

/**
 * Map an HTTP LB name to its access-log `vh_name` label value.
 * Accepts the plain LB name or the already-prefixed form.
 */
export function lbVhName(name: string): string {
  return name.startsWith(HTTP_LB_VH_PREFIX) ? name : HTTP_LB_VH_PREFIX + name;
}
