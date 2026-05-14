/**
 * Auto-encode raw PEM values into string:///<base64> format
 * for F5 XC Certificate API calls.
 *
 * Private keys are blindfold-encrypted (RSA+AES-GCM envelope) rather
 * than sent as clear_secret_info.
 */
import type { TenantConfig } from "../types/index.js";
import { fetchBlindfoldParams, blindfoldEncrypt } from "./blindfold.js";

function isRawPem(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("-----BEGIN");
}

function isPrivateKeyPem(value: unknown): value is string {
  return typeof value === "string" && value.includes("PRIVATE KEY");
}

function encodeToStringUrl(pem: string): string {
  return `string:///${Buffer.from(pem).toString("base64")}`;
}

function isAlreadyEncoded(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("string:///");
}

type Body = Record<string, unknown>;

function getNestedValue(obj: Body, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Body)[key];
  }
  return current;
}

function setNestedValue(obj: Body, path: string[], value: unknown): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null || typeof current !== "object") return;
    current = (current as Body)[path[i]];
  }
  if (current != null && typeof current === "object") {
    (current as Body)[path[path.length - 1]] = value;
  }
}

function deleteNestedValue(obj: Body, path: string[]): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null || typeof current !== "object") return;
    current = (current as Body)[path[i]];
  }
  if (current != null && typeof current === "object") {
    delete (current as Body)[path[path.length - 1]];
  }
}

function ensureNestedObject(obj: Body, path: string[]): void {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return;
    const parent = current as Body;
    if (parent[key] == null || typeof parent[key] !== "object") {
      parent[key] = {};
    }
    current = parent[key];
  }
}

const CLEAR_SECRET_PATH = ["spec", "private_key", "clear_secret_info", "url"];
const BLINDFOLD_PATH = ["spec", "private_key", "blindfold_secret_info", "location"];
const CERT_URL_PATH = ["spec", "certificate_url"];

export async function encodePemFields(
  config: TenantConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!body || typeof body !== "object") return body;
  if (!path.includes("/certificates") && !path.includes("/certificate_chains")) {
    return body;
  }

  const cloned = JSON.parse(JSON.stringify(body)) as Body;

  // certificate_url: simple base64 encoding (not a secret)
  const certUrl = getNestedValue(cloned, CERT_URL_PATH);
  if (isRawPem(certUrl)) {
    setNestedValue(cloned, CERT_URL_PATH, encodeToStringUrl(certUrl));
  }

  // Private key handling — blindfold encrypt raw PEM private keys
  const clearSecretUrl = getNestedValue(cloned, CLEAR_SECRET_PATH);
  const blindfoldLocation = getNestedValue(cloned, BLINDFOLD_PATH);

  if (isRawPem(clearSecretUrl) && isPrivateKeyPem(clearSecretUrl)) {
    // Blindfold-encrypt and move from clear_secret_info to blindfold_secret_info
    const params = await fetchBlindfoldParams(config);
    const encrypted = blindfoldEncrypt(clearSecretUrl, params);

    // Remove clear_secret_info
    deleteNestedValue(cloned, ["spec", "private_key", "clear_secret_info"]);

    // Set blindfold_secret_info.location
    ensureNestedObject(cloned, ["spec", "private_key", "blindfold_secret_info"]);
    setNestedValue(cloned, BLINDFOLD_PATH, `string:///${encrypted}`);
  } else if (isRawPem(blindfoldLocation) && isPrivateKeyPem(blindfoldLocation)) {
    // Blindfold-encrypt in place
    const params = await fetchBlindfoldParams(config);
    const encrypted = blindfoldEncrypt(blindfoldLocation, params);
    setNestedValue(cloned, BLINDFOLD_PATH, `string:///${encrypted}`);
  }

  return cloned;
}
