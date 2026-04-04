import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerRenderTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_get_render_queue",
    "List all render queue items with status, comp name, output path",
    {},
    async () => {
      const result = await bridge.send("render.getQueue");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_monitor_render",
    "Poll render queue until all items complete or timeout. Returns final status of all items.",
    {
      timeout: z.number().min(1000).max(600000).optional().default(60000).describe("Timeout in milliseconds (default 60s, max 10min)"),
      interval: z.number().min(500).max(30000).optional().default(2000).describe("Poll interval in milliseconds (default 2s)"),
    },
    async ({ timeout, interval }) => {
      const result = await bridge.send("render.monitor", { timeout, interval }, timeout + 5000);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_check_output",
    "Check if a render output file exists and get its size/modification date",
    { path: z.string().min(1).describe("Absolute path to the output file") },
    async ({ path }) => {
      const result = await bridge.send("render.checkOutput", { path });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
