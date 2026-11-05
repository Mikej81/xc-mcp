/**
 * Blindfold encryption for F5 XC private key protection.
 *
 * Implements the RSA+AES-GCM envelope encryption scheme used by
 * the F5 XC secret management API, ported from the PowerShell
 * Venafi driver (example/venafi.ps1).
 */
import crypto from "node:crypto";
import type { TenantConfig } from "../types/index.js";
import { callApi } from "./api-client.js";

export interface BlindfoldParams {
  policyId: number;
  tenant: string;
  keyVersion: number;
  modulusBase64: string;
  exponentBase64: string;
}

const POLICY_URL =
  "/api/secret_management/namespaces/shared/secret_policys/ves-io-allow-volterra/get_policy_document";
const PUBLIC_KEY_URL = "/api/secret_management/get_public_key";

/**
 * Fetch blindfold parameters (policy ID, tenant, RSA public key) from the
 * F5 XC secret management API.
 */
export async function fetchBlindfoldParams(
  config: TenantConfig,
): Promise<BlindfoldParams> {
  if (!config.apiToken && !config.p12Dispatcher) {
    throw new Error(
      `Tenant "${config.name}" has no auth configured (neither API token nor loaded P12 dispatcher).`,
    );
  }

  // Through callApi so a 401 sets the expired-token hint and both GETs are
  // counted in the upstream metrics. GETs are never audited.
  const [policyRes, pubKeyRes] = await Promise.all([
    callApi(config, "GET", POLICY_URL, { skipTruncation: true }),
    callApi(config, "GET", PUBLIC_KEY_URL, { skipTruncation: true }),
  ]);

  if (policyRes.status < 200 || policyRes.status >= 300) {
    throw new Error(
      `Failed to fetch policy document: ${policyRes.status} ${policyRes.statusText}`,
    );
  }
  if (pubKeyRes.status < 200 || pubKeyRes.status >= 300) {
    throw new Error(
      `Failed to fetch public key: ${pubKeyRes.status} ${pubKeyRes.statusText}`,
    );
  }

  const policyData = policyRes.body as {
    data: { policy_id: number; tenant: string };
  };
  const pubKeyData = pubKeyRes.body as {
    data: { modulus_base64: string; public_exponent_base64: string };
  };

  return {
    policyId: policyData.data.policy_id,
    tenant: policyData.data.tenant,
    keyVersion: 1,
    modulusBase64: pubKeyData.data.modulus_base64,
    exponentBase64: pubKeyData.data.public_exponent_base64,
  };
}

// Constants matching the PowerShell implementation
const AES256_ALGO_ID = 2;
const MAGIC_NUMBER = 0xdeadbeef;
const K = 32; // AES-256 key size in bytes

/**
 * Modular exponentiation using native BigInt: base^exp mod mod.
 */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Convert a big-endian unsigned byte buffer to a positive BigInt.
 */
function bufToBigInt(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt("0x" + buf.toString("hex"));
}

/**
 * Convert a positive BigInt to a big-endian Buffer of exactly `len` bytes.
 */
function bigIntToBuf(n: bigint, len: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const raw = Buffer.from(hex, "hex");
  if (raw.length >= len) {
    return raw.subarray(raw.length - len);
  }
  const padded = Buffer.alloc(len);
  raw.copy(padded, len - raw.length);
  return padded;
}

/**
 * Pack the secret bundle in the binary format expected by F5 XC.
 *
 * Layout (all multi-byte integers are big-endian):
 *   version          uint16
 *   tenant_len       uint16
 *   tenant           [tenant_len]byte
 *   key_version      uint32
 *   policy_id        uint64  (written as two uint32)
 *   algo_id          uint8
 *   exp_len          uint32
 *   exp              [exp_len]byte
 *   mod_len          uint32
 *   mod              [mod_len]byte
 *   enc_key_len      uint32
 *   enc_key          [enc_key_len]byte
 *   enc_msg          remaining bytes
 */
function packSecretBundle(
  policyId: number,
  tenantBytes: Buffer,
  keyVersion: number,
  algoId: number,
  expBytes: Buffer,
  modBytes: Buffer,
  encryptedKeyBytes: Buffer,
  encryptedMsgBytes: Buffer,
): Buffer {
  const size =
    2 + // version
    2 +
    tenantBytes.length + // tenant length + tenant
    4 + // key version
    8 + // policy id
    1 + // algo id
    4 +
    expBytes.length + // exp length + exp
    4 +
    modBytes.length + // mod length + mod
    4 +
    encryptedKeyBytes.length + // enc key length + enc key
    encryptedMsgBytes.length; // enc msg (no length prefix)

  const buf = Buffer.alloc(size);
  let offset = 0;

  // version (uint16)
  buf.writeUInt16BE(0, offset);
  offset += 2;

  // tenant
  buf.writeUInt16BE(tenantBytes.length, offset);
  offset += 2;
  tenantBytes.copy(buf, offset);
  offset += tenantBytes.length;

  // key version (uint32)
  buf.writeUInt32BE(keyVersion, offset);
  offset += 4;

  // policy id (uint64 as two uint32)
  buf.writeUInt32BE(Math.floor(policyId / 0x100000000), offset);
  offset += 4;
  buf.writeUInt32BE(policyId >>> 0, offset);
  offset += 4;

  // algo id (uint8)
  buf.writeUInt8(algoId, offset);
  offset += 1;

  // exponent
  buf.writeUInt32BE(expBytes.length, offset);
  offset += 4;
  expBytes.copy(buf, offset);
  offset += expBytes.length;

  // modulus
  buf.writeUInt32BE(modBytes.length, offset);
  offset += 4;
  modBytes.copy(buf, offset);
  offset += modBytes.length;

  // encrypted key
  buf.writeUInt32BE(encryptedKeyBytes.length, offset);
  offset += 4;
  encryptedKeyBytes.copy(buf, offset);
  offset += encryptedKeyBytes.length;

  // encrypted message (no length prefix — remainder of bundle)
  encryptedMsgBytes.copy(buf, offset);

  return buf;
}

/**
 * Blindfold-encrypt a message (typically a PEM private key).
 *
 * Returns the base64-encoded secret bundle ready to be placed at
 * `blindfold_secret_info.location` (with a `string:///` prefix added by the caller).
 */
export function blindfoldEncrypt(
  message: string,
  params: BlindfoldParams,
): string {
  const messageBytes = Buffer.from(message, "utf-8");
  const tenantBytes = Buffer.from(params.tenant, "utf-8");
  const modBytes = Buffer.from(params.modulusBase64, "base64");
  const expBytes = Buffer.from(params.exponentBase64, "base64");

  // AES-256-GCM encryption
  const key = crypto.randomBytes(K);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(messageBytes), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // keyBytes = nonce (12) + key (32) = 44 bytes
  const keyBytes = Buffer.concat([nonce, key]);

  // Encrypted message = ciphertext + tag
  const encryptedMsgBytes = Buffer.concat([ciphertext, tag]);

  // Pad keyBytes for RSA: [DEADBEEF (4)] [keyBytes (44)] [random padding]
  const modSize = modBytes.length;
  const magicBuf = Buffer.alloc(4);
  magicBuf.writeUInt32BE(MAGIC_NUMBER, 0);

  const paddingSize = modSize - 2 - 4 - keyBytes.length;
  if (paddingSize < 0) {
    throw new Error("Modulus too small for key encryption");
  }
  const paddingBytes = crypto.randomBytes(paddingSize);
  const paddedKey = Buffer.concat([magicBuf, keyBytes, paddingBytes]);

  // RSA operation: c = m^(e * tau) mod N
  const N = bufToBigInt(modBytes);
  const e = bufToBigInt(expBytes);
  const m = bufToBigInt(paddedKey);

  // tau = 2^(K-1) + 2*policyId + 1
  const tau =
    (1n << BigInt(K - 1)) + BigInt(2 * params.policyId) + 1n;
  const eTau = e * tau;

  const c = modPow(m, eTau, N);
  const encryptedKeyBytes = bigIntToBuf(c, modSize);

  const bundle = packSecretBundle(
    params.policyId,
    tenantBytes,
    params.keyVersion,
    AES256_ALGO_ID,
    expBytes,
    modBytes,
    encryptedKeyBytes,
    encryptedMsgBytes,
  );

  return bundle.toString("base64");
}
