import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerLayerTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_list_layers",
    "List all layers in a composition: name, type, in/out points, expression status",
    { comp: z.string().describe("Composition name") },
    async ({ comp }) => {
      const result = await bridge.send("layers.list", { comp });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_get_layer_properties",
    "Get detailed properties of a layer: transform, source text, effects, source info",
    {
      comp: z.string().describe("Composition name"),
      layer: z.string().describe("Layer name or index"),
    },
    async ({ comp, layer }) => {
      const result = await bridge.send("layers.getProperties", { comp, layer });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
