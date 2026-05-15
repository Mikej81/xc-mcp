import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Compatibility shim for the MCP Tasks RFC.
 *
 * The MCP SDK (≥1.24) injects `execution: { taskSupport: "forbidden" }` on
 * every registered tool. That field tells Tasks-RFC-aware clients "this tool
 * is a regular sync tool — do not invoke it as a task." However, older MCP
 * clients (Bifrost, some OpenWebUI builds) interpret an unknown `execution`
 * field as "this tool is uncallable" and never issue `tools/call`.
 *
 * This shim wraps the SDK's `tools/list` handler. If the connected client
 * advertised `capabilities.tasks` during `initialize`, the response is
 * passed through untouched. Otherwise, the `execution` field is stripped
 * from each tool descriptor so legacy clients see a clean tool listing.
 *
 * Server-side call routing is unaffected — the SDK validates `taskSupport`
 * against the registered tool, not the wire response.
 */

type RawHandler = (req: unknown, extra: unknown) => Promise<unknown>;

interface UnderlyingServer {
  _requestHandlers: Map<string, RawHandler>;
  getClientCapabilities: () => { tasks?: unknown } | undefined;
}

const LIST_TOOLS_METHOD = "tools/list";

export function installTasksRfcCompat(server: McpServer): void {
  const underlying = (server as unknown as { server: UnderlyingServer }).server;
  const original = underlying._requestHandlers.get(LIST_TOOLS_METHOD);
  if (!original) {
    // Tools/list handler hasn't been registered yet — call this AFTER tool
    // registration (i.e., after at least one server.tool(...) / registerTool).
    return;
  }

  underlying._requestHandlers.set(LIST_TOOLS_METHOD, async (req, extra) => {
    const result = await original(req, extra);
    if (clientSupportsTasks(underlying)) return result;
    return stripExecutionFromToolsList(result);
  });
}

function clientSupportsTasks(underlying: UnderlyingServer): boolean {
  const caps = underlying.getClientCapabilities();
  return caps?.tasks !== undefined;
}

/**
 * Returns a deep-ish copy of a `tools/list` result with the `execution`
 * field removed from every tool descriptor. Non-object inputs and
 * results missing a `tools` array are returned unchanged.
 */
export function stripExecutionFromToolsList(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  const tools = obj.tools;
  if (!Array.isArray(tools)) return result;
  return {
    ...obj,
    tools: tools.map(stripExecutionFromTool),
  };
}

function stripExecutionFromTool(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as Record<string, unknown>;
  if (!("execution" in t)) return tool;
  const { execution: _execution, ...rest } = t;
  return rest;
}
