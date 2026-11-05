# Kubernetes example

This directory has a minimal setup for running xc-mcp in hosted mode on Kubernetes. One server serves many users, and each user sends their own tenant URL and API token as request headers. The server holds no tenant credentials. See the Hosted Mode section of the main README for the headers and error codes.

Files:

- `deployment.yaml`: one replica of `ghcr.io/mikej81/xc-mcp:0.6.1`, with probes, a non-root security context, a read-only root filesystem and resource limits.
- `service.yaml`: a ClusterIP Service with port `http` (3000) and port `metrics` (9090).
- `ingress.yaml`: exposes only `/mcp` on a placeholder host with a placeholder TLS secret.

## Apply

1. Edit `ingress.yaml`. Replace `xc-mcp.example.com` with your host, set `ingressClassName` for your controller, and point `secretName` at your TLS secret.
2. Optional: turn on the shared-secret header. Create the Secret, then uncomment the `MCP_AUTH_HEADER_NAME` and `MCP_AUTH_HEADER_VALUE` entries in `deployment.yaml`. Set both or neither. Do this for any endpoint that is reachable from outside the cluster.

   ```
   kubectl create secret generic xc-mcp-auth --from-literal=value="$(openssl rand -hex 32)"
   ```

3. Optional: uncomment `XC_HOSTED_ALLOWED_DOMAINS` to allow tenant domains beyond `.console.ves.volterra.io`, such as a FedRAMP domain.
4. Check the manifests without changing anything, then apply them:

   ```
   kubectl apply --dry-run=client -f deploy/k8s/
   kubectl apply -f deploy/k8s/
   ```

## Connect Claude Code

Each user passes their own tenant URL and token. If you enabled the shared-secret header, add that header too.

```
claude mcp add --transport http f5-xc https://xc-mcp.example.com/mcp \
  --header "X-XC-Tenant-Url: https://your-tenant.console.ves.volterra.io" \
  --header "X-XC-Tenant-Token: YOUR_API_TOKEN" \
  --header "X-API-Key: YOUR_SHARED_SECRET"
```

Leave out the `X-API-Key` line if you did not set `MCP_AUTH_HEADER_NAME`. Use the header name you configured if it differs.

## Metrics stay in the cluster

The server serves `/metrics` on its own port (9090), separate from the MCP port. The Service exposes that port to the cluster, the pod carries Prometheus scrape annotations, and the Ingress routes only `/mcp`. Metrics have no authentication, so keep them off the public path. To limit who can reach the metrics port inside the cluster, add a NetworkPolicy that admits only your Prometheus pods. `/healthz` and `/readyz` stay off the Ingress too, since the kubelet calls them directly on the pod.

## Scaling past one replica

Hosted-mode sessions live in the memory of one pod. After `initialize`, every later request for that session must reach the same pod. If you raise `replicas` above 1, configure the Ingress or load balancer for sticky sessions keyed on the `Mcp-Session-Id` header. Session caps (`MCP_HOSTED_MAX_SESSIONS` and the others) apply per pod.

## Long-lived streams

MCP clients hold Server-Sent Events streams open. Most ingress controllers close idle connections after about 60 seconds. `ingress.yaml` has a commented example of NGINX annotations that raise the read and send timeouts and turn off buffering. Other controllers have their own settings.

## Shutdown timing

On `SIGTERM` the server fails `/readyz` and refuses new sessions, then waits `MCP_SHUTDOWN_DRAIN_SECONDS` (15 here) so Kubernetes stops sending traffic. It then closes open sessions, which takes up to 10 seconds. The total is 25 seconds at most, under the 30 second `terminationGracePeriodSeconds`. The readiness probe runs every 10 seconds, so a 15 second drain gives it time to notice. If you change one value, keep the drain above the probe period and the grace period above drain plus 10.

## Read-only root filesystem

The container runs with `readOnlyRootFilesystem: true`. The server itself writes nothing to disk, but `xc_create_cert` writes the generated key and certificate to a temporary directory under `/tmp` and deletes it after the call. The Deployment mounts a memory-backed `emptyDir` (16Mi) at `/tmp` for this. Without it, `xc_create_cert` fails with `EROFS`. The memory it uses counts toward the container's memory limit.
