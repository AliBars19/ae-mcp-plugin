#!/usr/bin/env node
/**
 * AE MCP Server — Entry point.
 *
 * Registers all MCP tools and starts the stdio transport.
 * Connects to the CEP panel's WebSocket bridge on first tool call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Bridge } from "./bridge.js";
import { registerProjectTools } from "./tools/project.js";
import { registerLayerTools } from "./tools/layers.js";
import { registerExpressionTools } from "./tools/expressions.js";
import { registerExecuteTools } from "./tools/execute.js";
import { registerRenderTools } from "./tools/render.js";
import { registerContextTools } from "./tools/context.js";

const WS_PORT = parseInt(process.env.WS_PORT || "9741", 10);

const bridge = new Bridge(WS_PORT);

const server = new McpServer({
  name: "ae-mcp-bridge",
  version: "0.1.0",
});

// Register all tool groups
registerProjectTools(server, bridge);
registerLayerTools(server, bridge);
registerExpressionTools(server, bridge);
registerExecuteTools(server, bridge);
registerRenderTools(server, bridge);
registerContextTools(server, bridge);

// Start stdio transport
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Attempt bridge connection (non-fatal if AE isn't running yet)
  try {
    await bridge.connect();
  } catch {
    // Will auto-reconnect when AE starts
  }

  // Graceful shutdown
  process.on("SIGINT", () => {
    bridge.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bridge.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
