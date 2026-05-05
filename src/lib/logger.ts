export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function readConfiguredLevel(): LogLevel {
  const raw = (process.env.MCP_LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

/**
 * Write one structured JSON line to stderr.
 * Never throws; falls back to a minimal line on serialization failure.
 */
export function log(
  level: LogLevel,
  evt: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[readConfiguredLevel()]) return;
  const base = { ts: new Date().toISOString(), level, evt };
  let serialized: string;
  try {
    serialized = JSON.stringify({ ...base, ...(fields ?? {}) });
  } catch {
    serialized = JSON.stringify({ ...base, error: "log_serialize_failed" });
  }
  process.stderr.write(serialized + "\n");
}
