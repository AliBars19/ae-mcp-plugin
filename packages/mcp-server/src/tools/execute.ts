import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

function validateJsxPath(path: string): string {
  if (path.includes("..")) {
    throw new Error("Path traversal (..) not allowed");
  }
  const resolved = resolve(path);
  const ext = extname(resolved).toLowerCase();
  if (ext !== ".jsx" && ext !== ".jsxbin") {
    throw new Error("Only .jsx and .jsxbin files are allowed");
  }
  return resolved;
}

export function registerExecuteTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_eval_extendscript",
    "[CAUTION] Execute arbitrary ExtendScript code in After Effects. This runs with full AE process permissions — treat as privileged.",
    { code: z.string().min(1).describe("ExtendScript code to evaluate") },
    async ({ code }) => {
      const result = await bridge.send("execute.eval", { code });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_run_jsx_file",
    "Execute a .jsx file from disk in After Effects via $.evalFile(). Path must be a .jsx/.jsxbin file with no traversal.",
    { path: z.string().min(1).describe("Absolute file path to the JSX file") },
    async ({ path }) => {
      const resolved = validateJsxPath(path);
      const result = await bridge.send("execute.runFile", { path: resolved });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_validate_jsx_file",
    "Validate a .jsx file: syntax check + optional dry-run (experimental — wraps in undo group). Reports errors and warnings.",
    {
      path: z.string().min(1).describe("Absolute file path to the JSX file"),
      dryRun: z.boolean().optional().default(false).describe("Run the file in an undo group then revert (experimental)"),
    },
    async ({ path, dryRun }) => {
      const resolved = validateJsxPath(path);

      let fileSize = 0;
      try {
        const content = await readFile(resolved, "utf-8");
        fileSize = content.length;
      } catch {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ valid: false, errors: ["Cannot read file"], warnings: [] }, null, 2),
          }],
        };
      }

      const result = await bridge.send("execute.validateFile", { path: resolved, dryRun }) as Record<string, unknown>;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...result, fileSize }, null, 2),
        }],
      };
    }
  );
}
