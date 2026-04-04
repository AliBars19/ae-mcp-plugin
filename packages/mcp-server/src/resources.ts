import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "./bridge.js";

export function registerResources(server: McpServer, bridge: Bridge): void {
  server.resource(
    "ae-bridge-status",
    "ae://bridge/status",
    async () => {
      const status: Record<string, unknown> = {
        connected: bridge.isConnected,
        uptime: bridge.uptime,
      };

      if (bridge.isConnected) {
        try {
          const info = await bridge.send("project.getInfo", {}, 5000) as Record<string, unknown>;
          status.aeVersion = info?.aeVersion ?? null;
          status.projectName = info?.name ?? null;
          status.numComps = info?.numComps ?? null;
        } catch {
          status.note = "Connected but query failed";
        }
      }

      return {
        contents: [{
          uri: "ae://bridge/status",
          text: JSON.stringify(status, null, 2),
          mimeType: "application/json",
        }],
      };
    }
  );

  server.resource(
    "ae-project-comps",
    "ae://project/comps",
    async () => {
      if (!bridge.isConnected) {
        return {
          contents: [{
            uri: "ae://project/comps",
            text: JSON.stringify({ error: "Not connected to After Effects" }),
            mimeType: "application/json",
          }],
        };
      }

      try {
        const comps = await bridge.send("project.listComps", { filter: "" }, 10000);
        return {
          contents: [{
            uri: "ae://project/comps",
            text: JSON.stringify(comps, null, 2),
            mimeType: "application/json",
          }],
        };
      } catch (err) {
        return {
          contents: [{
            uri: "ae://project/comps",
            text: JSON.stringify({ error: String(err) }),
            mimeType: "application/json",
          }],
        };
      }
    }
  );
}
