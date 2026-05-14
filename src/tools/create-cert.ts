import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TenantConfig } from "../types/index.js";
import { callApi } from "../lib/api-client.js";
import { fetchBlindfoldParams, blindfoldEncrypt } from "../lib/blindfold.js";

export interface CreateCertParams {
  name: string;
  namespace: string;
  domain: string;
  tenant?: string;
}

/**
 * Generate a self-signed certificate, blindfold-encrypt the private key,
 * and create the certificate object in XC — all server-side.
 * No PEM content ever passes through the LLM conversation.
 */
export async function handleCreateCert(
  config: TenantConfig,
  params: CreateCertParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "xc-cert-"));
  const keyPath = join(tmpDir, "key.pem");
  const certPath = join(tmpDir, "cert.pem");

  try {
    // Generate self-signed cert
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=${params.domain}"`,
      { stdio: "pipe" },
    );

    const certPem = readFileSync(certPath, "utf-8").trim();
    const keyPem = readFileSync(keyPath, "utf-8").trim();

    // Blindfold-encrypt the private key
    const blindfoldParams = await fetchBlindfoldParams(config);
    const encryptedKey = blindfoldEncrypt(keyPem, blindfoldParams);

    // Create the certificate object
    const body = {
      metadata: { name: params.name, namespace: params.namespace },
      spec: {
        certificate_url: `string:///${Buffer.from(certPem).toString("base64")}`,
        private_key: {
          blindfold_secret_info: {
            location: `string:///${encryptedKey}`,
          },
        },
      },
    };

    const response = await callApi(
      config,
      "POST",
      `/api/config/namespaces/${encodeURIComponent(params.namespace)}/certificates`,
      { body },
    );

    if (response.status !== 200) {
      return {
        content: [{
          type: "text",
          text: `Error creating certificate "${params.name}": ${response.status} ${response.statusText}\n${JSON.stringify(response.body)}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Certificate "${params.name}" created in namespace "${params.namespace}".\n` +
          `CN: ${params.domain}\n` +
          `Private key: blindfold-encrypted\n` +
          `Expires: 365 days\n` +
          `\nReference in LB: { "namespace": "${params.namespace}", "name": "${params.name}" }`,
      }],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Failed to create certificate: ${msg}` }],
      isError: true,
    };
  } finally {
    // Clean up temp files
    try { unlinkSync(keyPath); } catch { /* ignore */ }
    try { unlinkSync(certPath); } catch { /* ignore */ }
    try { execSync(`rmdir ${tmpDir}`, { stdio: "pipe" }); } catch { /* ignore */ }
  }
}
