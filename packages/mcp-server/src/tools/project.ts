import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerProjectTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_get_project_info",
    "Get After Effects project info: name, path, AE version, item counts",
    {},
    async () => {
      const result = await bridge.send("project.getInfo");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_list_comps",
    "List all compositions in the AE project with name, duration, dimensions, layer count. Optional regex filter.",
    { filter: z.string().optional().describe("Regex filter for comp names") },
    async ({ filter }) => {
      const result = await bridge.send("project.listComps", { filter: filter || "" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_search_project",
    "Search AE project items by name (regex) and/or type (comp, folder, footage)",
    {
      query: z.string().describe("Regex search query"),
      type: z.enum(["comp", "folder", "footage", ""]).optional().describe("Filter by item type"),
    },
    async ({ query, type }) => {
      const result = await bridge.send("project.search", { query, type: type || "" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
