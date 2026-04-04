import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

interface Marker {
  time: number;
  text: string;
  words?: Array<{ word: string; start: number }>;
  end_time?: number;
}

interface JobData {
  markers?: Marker[];
  total_markers?: number;
}

export function registerValidateTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    "ae_validate_apollova_markers",
    "Validate that AE expressions match expected Apollova markers. Reads job data from disk and spot-checks lyrics at marker timestamps inside AE.",
    {
      comp: z.string().describe("Composition name (e.g. 'LYRIC FONT 1')"),
      jobDataPath: z.string().min(1).describe("Path to job_data.json or onyx_data.json"),
    },
    async ({ comp, jobDataPath }) => {
      // Path traversal prevention
      if (jobDataPath.includes("..")) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: "Path traversal not allowed" }, null, 2) }] };
      }
      const resolvedPath = resolve(jobDataPath);

      // Read job data from disk
      let jobData: JobData;
      try {
        const raw = await readFile(resolvedPath, "utf-8");
        jobData = JSON.parse(raw);
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: `Cannot read job data: ${err}` }, null, 2) }] };
      }

      const markers = jobData.markers || [];
      if (markers.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: "No markers in job data" }, null, 2) }] };
      }

      // Spot-check: evaluate Source Text at each marker's time
      const times = markers.map(m => m.time);
      let results: Array<{ time: number; value: unknown; error: string | null }>;
      try {
        results = await bridge.send("expressions.evalAtTimes", {
          comp, layer: "LYRIC_TEXT", property: "Source Text", times
        }) as typeof results;
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: `Bridge error: ${err}` }, null, 2) }] };
      }

      if (!Array.isArray(results)) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: "Unexpected response from AE" }, null, 2) }] };
      }

      const mismatches: Array<{ time: number; expected: string; actual: string }> = [];
      for (let i = 0; i < markers.length && i < results.length; i++) {
        const expected = markers[i].text.trim();
        const actual = String(results[i]?.value ?? "").trim();
        // Check if the actual text contains the first few words of expected
        const expectedStart = expected.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
        if (actual.toLowerCase().indexOf(expectedStart) === -1 && actual.length > 0) {
          mismatches.push({ time: markers[i].time, expected, actual });
        }
      }

      const valid = mismatches.length === 0;
      const coverage = markers.length > 0 ? ((markers.length - mismatches.length) / markers.length * 100).toFixed(1) : "0";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ valid, totalMarkers: markers.length, mismatches, coverage: `${coverage}%` }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "ae_diff_expressions",
    "Compare the current expression on a layer property in AE against an expected expression string. Returns line-by-line diff.",
    {
      comp: z.string().describe("Composition name"),
      layer: z.string().describe("Layer name or index"),
      property: z.string().optional().default("Source Text").describe("Property path"),
      expected: z.string().describe("Expected expression code"),
    },
    async ({ comp, layer, property, expected }) => {
      let expressions: Array<{ expression: string; propertyPath: string }>;
      try {
        expressions = await bridge.send("expressions.get", { comp, layer }) as typeof expressions;
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ match: false, error: `Bridge error: ${err}` }, null, 2) }] };
      }

      if (!Array.isArray(expressions) || expressions.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ match: false, error: "No expressions found" }, null, 2) }] };
      }

      // Find the expression matching the property path
      const target = expressions.find(e => e.propertyPath.includes(property));
      const current = target?.expression ?? "";

      const currentLines = current.split("\n");
      const expectedLines = expected.split("\n");
      const maxLen = Math.max(currentLines.length, expectedLines.length);

      const diff: string[] = [];
      for (let i = 0; i < maxLen; i++) {
        const cl = currentLines[i] ?? "";
        const el = expectedLines[i] ?? "";
        if (cl !== el) {
          diff.push(`Line ${i + 1}:`);
          if (cl) diff.push(`  - ${cl}`);
          if (el) diff.push(`  + ${el}`);
        }
      }

      const match = diff.length === 0;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ match, currentLines: currentLines.length, expectedLines: expectedLines.length, diff }, null, 2),
        }],
      };
    }
  );
}
