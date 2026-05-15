import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  installTasksRfcCompat,
  stripExecutionFromToolsList,
} from "../lib/tasks-rfc-compat.js";

describe("stripExecutionFromToolsList", () => {
  it("removes execution from every tool", () => {
    const input = {
      tools: [
        { name: "a", execution: { taskSupport: "forbidden" }, description: "x" },
        { name: "b", execution: { taskSupport: "forbidden" } },
      ],
    };
    const out = stripExecutionFromToolsList(input) as { tools: Array<Record<string, unknown>> };
    expect(out.tools[0]).toEqual({ name: "a", description: "x" });
    expect(out.tools[1]).toEqual({ name: "b" });
  });

  it("leaves tools without execution unchanged", () => {
    const input = { tools: [{ name: "a" }, { name: "b" }] };
    const out = stripExecutionFromToolsList(input);
    expect(out).toEqual(input);
  });

  it("preserves siblings on the result object (e.g. nextCursor)", () => {
    const input = {
      tools: [{ name: "a", execution: { taskSupport: "forbidden" } }],
      nextCursor: "abc",
    };
    const out = stripExecutionFromToolsList(input) as Record<string, unknown>;
    expect(out.nextCursor).toBe("abc");
  });

  it("returns input unchanged when tools is missing or non-array", () => {
    expect(stripExecutionFromToolsList({ foo: 1 })).toEqual({ foo: 1 });
    expect(stripExecutionFromToolsList({ tools: "nope" })).toEqual({ tools: "nope" });
    expect(stripExecutionFromToolsList(null)).toBeNull();
    expect(stripExecutionFromToolsList(undefined)).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const input = {
      tools: [{ name: "a", execution: { taskSupport: "forbidden" } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    stripExecutionFromToolsList(input);
    expect(input).toEqual(snapshot);
  });
});

describe("installTasksRfcCompat (integration)", () => {
  function makeServerWithTool() {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.tool(
      "echo",
      "Echo back the input",
      { msg: z.string() },
      async ({ msg }) => ({ content: [{ type: "text", text: msg }] }),
    );
    return server;
  }

  type Handlers = Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;

  function getListToolsHandler(server: McpServer) {
    const underlying = (server as unknown as { server: { _requestHandlers: Handlers } }).server;
    const h = underlying._requestHandlers.get("tools/list");
    if (!h) throw new Error("tools/list handler not registered");
    return h;
  }

  function setClientCapabilities(server: McpServer, caps: Record<string, unknown> | undefined) {
    const underlying = server as unknown as { server: { _clientCapabilities: typeof caps } };
    underlying.server._clientCapabilities = caps;
  }

  const rawListToolsReq = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

  it("strips execution when client does not advertise tasks capability", async () => {
    const server = makeServerWithTool();
    installTasksRfcCompat(server);
    setClientCapabilities(server, {});

    const handler = getListToolsHandler(server);
    const result = (await handler(rawListToolsReq, {})) as {
      tools: Array<Record<string, unknown>>;
    };

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("echo");
    expect(result.tools[0]).not.toHaveProperty("execution");
  });

  it("strips execution when client capabilities object is undefined", async () => {
    const server = makeServerWithTool();
    installTasksRfcCompat(server);
    setClientCapabilities(server, undefined);

    const handler = getListToolsHandler(server);
    const result = (await handler(rawListToolsReq, {})) as {
      tools: Array<Record<string, unknown>>;
    };

    expect(result.tools[0]).not.toHaveProperty("execution");
  });

  it("preserves execution when client advertises tasks capability", async () => {
    const server = makeServerWithTool();
    installTasksRfcCompat(server);
    setClientCapabilities(server, { tasks: {} });

    const handler = getListToolsHandler(server);
    const result = (await handler(rawListToolsReq, {})) as {
      tools: Array<Record<string, unknown>>;
    };

    expect(result.tools[0]).toHaveProperty("execution");
    expect((result.tools[0].execution as { taskSupport: string }).taskSupport).toBe(
      "forbidden",
    );
  });

  it("is a no-op if tools/list is not yet registered", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    // No tools registered → no tools/list handler installed yet.
    expect(() => installTasksRfcCompat(server)).not.toThrow();
  });
});
