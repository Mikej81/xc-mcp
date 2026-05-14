import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadP12Dispatcher } from "../lib/p12.js";

describe("loadP12Dispatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "xc-mcp-p12-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a clear error when the P12 file does not exist", () => {
    expect(() => loadP12Dispatcher("/nonexistent/cert.p12", "x")).toThrow(
      /P12 file/i,
    );
  });

  it("includes the missing path in the error message", () => {
    expect(() => loadP12Dispatcher("/nonexistent/cert.p12", "x")).toThrow(
      /\/nonexistent\/cert\.p12/,
    );
  });

  it("returns a dispatcher object when the file is readable", () => {
    const p12Path = join(tmpDir, "cert.p12");
    writeFileSync(p12Path, Buffer.alloc(128));
    const dispatcher = loadP12Dispatcher(p12Path, "password");
    expect(dispatcher).toBeDefined();
    // undici Agent exposes a dispatch() method
    expect(typeof (dispatcher as { dispatch?: unknown }).dispatch).toBe(
      "function",
    );
  });

  it("resolves relative paths against cwd", () => {
    // sanity: relative path that does not exist should still surface in the error
    expect(() => loadP12Dispatcher("./missing.p12", "x")).toThrow(/missing\.p12/);
  });
});
