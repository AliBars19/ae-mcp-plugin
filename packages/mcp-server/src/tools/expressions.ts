import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerExpressionTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_get_expressions",
    "Get all expressions on a layer or entire comp. Returns expression code, enabled state, and error info.",
    {
      comp: z.string().describe("Composition name"),
      layer: z.string().optional().describe("Layer name or index (omit for all layers in comp)"),
    },
    async ({ comp, layer }) => {
      const result = await bridge.send("expressions.get", { comp, layer: layer || "" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_eval_expression_at_time",
    "Evaluate a property (with its expression) at a specific time. Returns the resolved value.",
    {
      comp: z.string().describe("Composition name"),
      layer: z.string().describe("Layer name or index"),
      property: z.string().describe("Property path (e.g. 'Source Text', 'Transform/Position')"),
      time: z.number().describe("Time in seconds to evaluate at"),
    },
    async ({ comp, layer, property, time }) => {
      const result = await bridge.send("expressions.evalAtTime", { comp, layer, property, time });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
