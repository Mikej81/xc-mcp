import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type Dispatcher } from "undici";

/**
 * Synchronous on purpose: a bad path or password should fail startup before
 * the server starts accepting requests.
 */
export function loadP12Dispatcher(
  p12Path: string,
  p12Password: string,
): Dispatcher {
  const absolutePath = resolve(p12Path);
  let pfx: Buffer;
  try {
    pfx = readFileSync(absolutePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`P12 file at "${absolutePath}" could not be read: ${reason}`);
  }

  return new Agent({
    connect: { pfx, passphrase: p12Password },
  });
}
