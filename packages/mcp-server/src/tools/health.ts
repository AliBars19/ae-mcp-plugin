import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerHealthTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_health",
    "Check bridge connection status, AE version, and uptime. Safe to call when AE is not running.",
    {},
    async () => {
      const status: Record<string, unknown> = {
        connected: bridge.isConnected,
        wsPort: 9741,
        uptime: bridge.uptime,
      };

      if (bridge.isConnected) {
        try {
          const info = await bridge.send("project.getInfo", {}, 5000);
          if (info && typeof info === "object") {
            const proj = info as Record<string, unknown>;
            status.aeVersion = proj.aeVersion ?? null;
            status.projectName = proj.name ?? null;
          }
        } catch {
          status.aeVersion = null;
          status.note = "Connected but project query failed";
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );
}
