import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, logAudit } from "../lib/logger.js";

describe("logger", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalLevel: string | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    originalLevel = process.env.MCP_LOG_LEVEL;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (originalLevel === undefined) delete process.env.MCP_LOG_LEVEL;
    else process.env.MCP_LOG_LEVEL = originalLevel;
  });

  it("writes a JSON line with ts, level, evt, and extra fields", () => {
    log("info", "request", { status: 200, duration_ms: 47 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.level).toBe("info");
    expect(parsed.evt).toBe("request");
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBe(47);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("logAudit writes an info-level audit line even at MCP_LOG_LEVEL=error", () => {
    process.env.MCP_LOG_LEVEL = "error";
    logAudit({ tool: "xc_call_api", method: "POST" });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((writeSpy.mock.calls[0][0] as string).trimEnd());
    expect(parsed).toMatchObject({ level: "info", evt: "audit", tool: "xc_call_api", method: "POST" });
    expect(typeof parsed.ts).toBe("string");
  });

  it("drops lines below the configured level", () => {
    process.env.MCP_LOG_LEVEL = "warn";
    log("info", "ignored");
    log("debug", "ignored");
    log("warn", "kept");
    log("error", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults to info when MCP_LOG_LEVEL is unset", () => {
    delete process.env.MCP_LOG_LEVEL;
    log("debug", "dropped");
    log("info", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to info when MCP_LOG_LEVEL is invalid", () => {
    process.env.MCP_LOG_LEVEL = "verbose";
    log("debug", "dropped");
    log("info", "kept");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("survives non-serializable fields without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log("info", "evt", { circular })).not.toThrow();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.evt).toBe("evt");
    expect(parsed.error).toBe("log_serialize_failed");
  });
});
