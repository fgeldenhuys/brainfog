import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env } from "../env";

/**
 * Streamable HTTP MCP scaffold (ADR-003), mounted at `/mcp` behind the
 * shared bearer-token middleware. Tool handlers will call the same
 * internal service layer as the REST API once the memory model lands
 * (specs/memory-model/spec.md) — for now this exposes only a placeholder
 * `ping` tool.
 */
export class BrainfogMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "brainfog", version: "0.1.0" });

  async init() {
    this.server.tool("ping", "Placeholder health-check tool.", async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));
  }
}
