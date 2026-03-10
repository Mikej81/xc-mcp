import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read the version from package.json at startup.
 */
function readPackageVersion(): string {
  const candidates = [
    join(__dirname, "../../package.json"),
    join(__dirname, "../../../package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch {
      // continue
    }
  }
  return "unknown";
}

export const VERSION = readPackageVersion();

const GITHUB_REPO = "Mikej81/xc-mcp";

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/**
 * Check GitHub for the latest release tag.
 * Non-blocking, never throws — returns null latest on any failure.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const result: UpdateCheckResult = {
    current: VERSION,
    latest: null,
    updateAvailable: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "f5-xc-mcp" },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);

    if (!res.ok) return result;

    const data = (await res.json()) as { tag_name?: string };
    if (!data.tag_name) return result;

    // tag_name is like "v0.0.5" — strip leading "v"
    const latest = data.tag_name.replace(/^v/, "");
    result.latest = latest;
    result.updateAvailable = latest !== VERSION;
  } catch {
    // Network error, timeout, etc. — silently ignore
  }

  return result;
}
