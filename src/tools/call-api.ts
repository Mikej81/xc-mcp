import type { CallApiParams, TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { encodePemFields } from "../lib/pem-encoding.js";

export async function handleCallApi(
  config: TenantConfig,
  params: CallApiParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const response = await callApi(config, params.method, params.path, {
    pathParams: params.path_params,
    queryParams: params.query_params,
    body: await encodePemFields(config, params.path, params.body),
  });

  const output: any = {
    status: response.status,
    statusText: response.statusText,
  };

  if (response.truncated) {
    output.warning = "Response was truncated at 50KB";
  }

  output.body = response.body;

  let text = JSON.stringify(output, null, 2);

  if (text.length > 60_000) {
    text = text.slice(0, 60_000) + "\n... [Output truncated]";
  }

  return { content: [{ type: "text", text }] };
}
