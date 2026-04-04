import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

export function registerExecuteTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_eval_extendscript",
    "Execute arbitrary ExtendScript code in After Effects and return the result",
    { code: z.string().describe("ExtendScript code to evaluate") },
    async ({ code }) => {
      const result = await bridge.send("execute.eval", { code });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_run_jsx_file",
    "Execute a JSX file from disk in After Effects via $.evalFile()",
    { path: z.string().describe("Absolute file path to the JSX file") },
    async ({ path }) => {
      const result = await bridge.send("execute.runFile", { path });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_validate_jsx_file",
    "Validate a JSX file: syntax check + optional dry-run (experimental — wraps in undo group). Reports errors and warnings.",
    {
      path: z.string().describe("Absolute file path to the JSX file"),
      dryRun: z.boolean().optional().default(false).describe("Run the file in an undo group then revert (experimental)"),
    },
    async ({ path, dryRun }) => {
      // Also read the file locally to show contents if needed
      let fileSize = 0;
      try {
        const content = await readFile(path, "utf-8");
        fileSize = content.length;
      } catch {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ valid: false, errors: [`Cannot read file: ${path}`], warnings: [] }, null, 2),
          }],
        };
      }

      const result = await bridge.send("execute.validateFile", { path, dryRun }) as Record<string, unknown>;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...result, fileSize }, null, 2),
        }],
      };
    }
  );
}
