import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";

export interface WaitReadyParams {
  namespace: string;
  lb_name: string;
  tenant?: string;
  timeout_seconds?: number;
  poll_interval_seconds?: number;
}

const READY_STATE = "CertificateValid";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export async function handleWaitReady(
  config: TenantConfig,
  params: WaitReadyParams,
  deps: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const sleepFn = deps.sleep ?? sleep;
  const nowFn = deps.now ?? Date.now;

  const timeoutMs = Math.max(1, params.timeout_seconds ?? 600) * 1000;
  const intervalMs = Math.max(1, params.poll_interval_seconds ?? 30) * 1000;
  const path = `/api/config/namespaces/${encodeURIComponent(params.namespace)}/http_loadbalancers/${encodeURIComponent(params.lb_name)}`;

  const start = nowFn();
  let polls = 0;
  let lastState: string | undefined;

  while (true) {
    polls += 1;
    const resp = await callApi(config, "GET", path, { skipTruncation: true });

    if (resp.status >= 400) {
      const elapsedSec = Math.round((nowFn() - start) / 1000);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ready: false,
              error: `GET failed: ${resp.status} ${resp.statusText}`,
              cert_state: null,
              elapsed_s: elapsedSec,
              polls,
              last_response: resp.body,
            }),
          },
        ],
        isError: true,
      };
    }

    const body = resp.body as any;
    lastState = body?.spec?.cert_state;

    if (lastState === READY_STATE) {
      const elapsedSec = Math.round((nowFn() - start) / 1000);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ready: true,
              cert_state: lastState,
              elapsed_s: elapsedSec,
              polls,
            }),
          },
        ],
      };
    }

    if (nowFn() - start >= timeoutMs) {
      const elapsedSec = Math.round((nowFn() - start) / 1000);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ready: false,
              cert_state: lastState ?? null,
              elapsed_s: elapsedSec,
              polls,
              timeout: true,
            }),
          },
        ],
      };
    }

    await sleepFn(intervalMs);
  }
}
