import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

const CONTEXT_DIR = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Apollova");
const CONTEXT_FILE = join(CONTEXT_DIR, "ae-mcp-context.json");

async function ensureContextDir(): Promise<void> {
  await mkdir(CONTEXT_DIR, { recursive: true });
}

async function readContext(): Promise<Record<string, unknown>> {
  await ensureContextDir();
  if (!existsSync(CONTEXT_FILE)) return {};
  try {
    const raw = await readFile(CONTEXT_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Corrupted file — reset to empty
    return {};
  }
}

async function writeContext(data: Record<string, unknown>): Promise<string> {
  await ensureContextDir();
  const timestamp = new Date().toISOString();
  const output = { ...data, _updated: timestamp };
  await writeFile(CONTEXT_FILE, JSON.stringify(output, null, 2), "utf-8");
  return timestamp;
}

export function registerContextTools(server: McpServer, _bridge: Bridge): void {
  server.tool(
    "ae_read_shared_context",
    "Read the shared context file. Returns a specific key or the entire context object. Used for cross-session communication between AE agent and Apollova agent.",
    { key: z.string().optional().describe("Specific key to read (omit for entire context)") },
    async ({ key }) => {
      const data = await readContext();
      const result = key ? data[key] ?? null : data;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "ae_write_shared_context",
    "Write a key-value pair to the shared context file. File-locked for safe concurrent access.",
    {
      key: z.string().min(1).describe("Key to write"),
      value: z.unknown().describe("Value to store (any JSON-serializable value)"),
    },
    async ({ key, value }) => {
      await ensureContextDir();

      // Create the file if it doesn't exist (lockfile needs it to exist)
      if (!existsSync(CONTEXT_FILE)) {
        await writeFile(CONTEXT_FILE, "{}", "utf-8");
      }

      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(CONTEXT_FILE, {
          stale: 10000,
          retries: { retries: 5, minTimeout: 200, maxTimeout: 1000 },
        });

        const data = await readContext();
        data[key] = value;
        const timestamp = await writeContext(data);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, timestamp }, null, 2),
          }],
        };
      } finally {
        if (release) await release();
      }
    }
  );
}
