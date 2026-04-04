import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Stress tests for every MCP tool handler.
 *
 * Mocks the McpServer.tool() to capture handlers, then invokes them directly
 * with controlled bridge mocks to verify input validation and bridge interaction.
 */

interface ToolEntry {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<any>;
}

function createMockBridge(sendImpl?: (...args: any[]) => any) {
  return {
    send: vi.fn(sendImpl ?? (async () => ({ ok: true }))),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isConnected: true,
  };
}

function captureMockServer(): { mockServer: any; tools: Map<string, ToolEntry> } {
  const tools = new Map<string, ToolEntry>();
  const mockServer = {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: (params: Record<string, unknown>) => Promise<any>) => {
      tools.set(name, { name, description, schema, handler });
    },
  } as any;
  return { mockServer, tools };
}

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

// ============================================================================
// ae_get_project_info (~10 tests)
// ============================================================================

describe("ae_get_project_info stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerProjectTools } = await import("../src/tools/project.js");
    registerProjectTools(cap.mockServer, bridge as any);
  });

  it("returns bridge result as formatted JSON", async () => {
    bridge.send.mockResolvedValueOnce({ name: "Test.aep", version: "25.0" });
    const result = await tools.get("ae_get_project_info")!.handler({});
    const parsed = parseResult(result);
    expect(parsed.name).toBe("Test.aep");
    expect(parsed.version).toBe("25.0");
  });

  it("bridge error propagates as thrown error", async () => {
    bridge.send.mockRejectedValueOnce(new Error("Bridge down"));
    await expect(tools.get("ae_get_project_info")!.handler({})).rejects.toThrow("Bridge down");
  });

  it("bridge returns null - handled gracefully", async () => {
    bridge.send.mockResolvedValueOnce(null);
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toBeNull();
  });

  it("bridge returns empty object - formatted", async () => {
    bridge.send.mockResolvedValueOnce({});
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toEqual({});
  });

  it("calls bridge with correct method", async () => {
    await tools.get("ae_get_project_info")!.handler({});
    expect(bridge.send).toHaveBeenCalledWith("project.getInfo");
  });

  it("bridge returns deeply nested result", async () => {
    const nested = { a: { b: { c: { d: 42 } } } };
    bridge.send.mockResolvedValueOnce(nested);
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toEqual(nested);
  });

  it("bridge returns string result", async () => {
    bridge.send.mockResolvedValueOnce("raw string");
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toBe("raw string");
  });

  it("bridge returns numeric result", async () => {
    bridge.send.mockResolvedValueOnce(42);
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toBe(42);
  });

  it("bridge returns array result", async () => {
    bridge.send.mockResolvedValueOnce([1, 2, 3]);
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(parseResult(result)).toEqual([1, 2, 3]);
  });

  it("result content has type text", async () => {
    const result = await tools.get("ae_get_project_info")!.handler({});
    expect(result.content[0].type).toBe("text");
  });
});

// ============================================================================
// ae_list_comps (~15 tests)
// ============================================================================

describe("ae_list_comps stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerProjectTools } = await import("../src/tools/project.js");
    registerProjectTools(cap.mockServer, bridge as any);
  });

  it("with filter passes filter to bridge", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "OUTPUT" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "OUTPUT" });
  });

  it("without filter passes empty string", async () => {
    await tools.get("ae_list_comps")!.handler({});
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "" });
  });

  it("with undefined filter passes empty string", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: undefined });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "" });
  });

  it("filter with regex special chars passed through", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "^OUT.*[0-9]+$" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "^OUT.*[0-9]+$" });
  });

  it("filter with parentheses passed through", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "(comp|pre)" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "(comp|pre)" });
  });

  it("bridge returns array of 100 comps - all returned", async () => {
    const comps = Array.from({ length: 100 }, (_, i) => ({ name: `Comp_${i}`, duration: 10 }));
    bridge.send.mockResolvedValueOnce(comps);
    const result = await tools.get("ae_list_comps")!.handler({});
    const parsed = parseResult(result);
    expect(parsed).toHaveLength(100);
    expect(parsed[99].name).toBe("Comp_99");
  });

  it("bridge returns empty array - formatted", async () => {
    bridge.send.mockResolvedValueOnce([]);
    const result = await tools.get("ae_list_comps")!.handler({});
    expect(parseResult(result)).toEqual([]);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("AE not running"));
    await expect(tools.get("ae_list_comps")!.handler({})).rejects.toThrow("AE not running");
  });

  it("filter with empty string passes empty string", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "" });
  });

  it("filter with Unicode characters passed through", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "日本語" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "日本語" });
  });

  it("filter with backslashes passed through", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "\\d+" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "\\d+" });
  });

  it("filter with pipe characters passed through", async () => {
    await tools.get("ae_list_comps")!.handler({ filter: "a|b|c" });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: "a|b|c" });
  });

  it("bridge returns single comp", async () => {
    bridge.send.mockResolvedValueOnce([{ name: "Solo", duration: 5 }]);
    const result = await tools.get("ae_list_comps")!.handler({ filter: "Solo" });
    expect(parseResult(result)).toHaveLength(1);
  });

  it("result is valid JSON string", async () => {
    bridge.send.mockResolvedValueOnce({ test: true });
    const result = await tools.get("ae_list_comps")!.handler({});
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it("filter with very long string passed through", async () => {
    const longFilter = "a".repeat(1000);
    await tools.get("ae_list_comps")!.handler({ filter: longFilter });
    expect(bridge.send).toHaveBeenCalledWith("project.listComps", { filter: longFilter });
  });
});

// ============================================================================
// ae_search_project (~15 tests)
// ============================================================================

describe("ae_search_project stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerProjectTools } = await import("../src/tools/project.js");
    registerProjectTools(cap.mockServer, bridge as any);
  });

  it("with query + type both passed", async () => {
    await tools.get("ae_search_project")!.handler({ query: "hero", type: "comp" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "hero", type: "comp" });
  });

  it("with only query - type is empty string", async () => {
    await tools.get("ae_search_project")!.handler({ query: "hero" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "hero", type: "" });
  });

  it("type 'comp' accepted", async () => {
    await tools.get("ae_search_project")!.handler({ query: "x", type: "comp" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "x", type: "comp" });
  });

  it("type 'folder' accepted", async () => {
    await tools.get("ae_search_project")!.handler({ query: "x", type: "folder" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "x", type: "folder" });
  });

  it("type 'footage' accepted", async () => {
    await tools.get("ae_search_project")!.handler({ query: "x", type: "footage" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "x", type: "footage" });
  });

  it("empty type passes empty string", async () => {
    await tools.get("ae_search_project")!.handler({ query: "x", type: "" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "x", type: "" });
  });

  it("undefined type passes empty string", async () => {
    await tools.get("ae_search_project")!.handler({ query: "x", type: undefined });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "x", type: "" });
  });

  it("bridge returns large result set", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `Item_${i}`, type: "comp" }));
    bridge.send.mockResolvedValueOnce(items);
    const result = await tools.get("ae_search_project")!.handler({ query: ".*" });
    expect(parseResult(result)).toHaveLength(500);
  });

  it("query with regex pattern passed through", async () => {
    await tools.get("ae_search_project")!.handler({ query: "^hero_[0-9]{2}$" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "^hero_[0-9]{2}$", type: "" });
  });

  it("query with special characters", async () => {
    await tools.get("ae_search_project")!.handler({ query: "name (copy)" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "name (copy)", type: "" });
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("search failed"));
    await expect(tools.get("ae_search_project")!.handler({ query: "x" })).rejects.toThrow("search failed");
  });

  it("bridge returns empty array", async () => {
    bridge.send.mockResolvedValueOnce([]);
    const result = await tools.get("ae_search_project")!.handler({ query: "nothing" });
    expect(parseResult(result)).toEqual([]);
  });

  it("query with Unicode characters", async () => {
    await tools.get("ae_search_project")!.handler({ query: "表示テスト" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "表示テスト", type: "" });
  });

  it("multiple calls don't interfere", async () => {
    bridge.send.mockResolvedValueOnce([{ name: "A" }]);
    bridge.send.mockResolvedValueOnce([{ name: "B" }]);
    const r1 = await tools.get("ae_search_project")!.handler({ query: "A" });
    const r2 = await tools.get("ae_search_project")!.handler({ query: "B" });
    expect(parseResult(r1)[0].name).toBe("A");
    expect(parseResult(r2)[0].name).toBe("B");
  });

  it("query with newlines passed through", async () => {
    await tools.get("ae_search_project")!.handler({ query: "line1\nline2" });
    expect(bridge.send).toHaveBeenCalledWith("project.search", { query: "line1\nline2", type: "" });
  });
});

// ============================================================================
// ae_list_layers (~15 tests)
// ============================================================================

describe("ae_list_layers stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerLayerTools } = await import("../src/tools/layers.js");
    registerLayerTools(cap.mockServer, bridge as any);
  });

  it("comp name passed correctly", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "MyComp" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "MyComp" });
  });

  it("empty comp name passed through", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "" });
  });

  it("comp with special chars passed through", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "My Comp (v2) [final]" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "My Comp (v2) [final]" });
  });

  it("comp with Unicode passed through", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "コンポ日本" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "コンポ日本" });
  });

  it("bridge returns 50 layers", async () => {
    const layers = Array.from({ length: 50 }, (_, i) => ({ name: `Layer ${i}`, type: "shape" }));
    bridge.send.mockResolvedValueOnce(layers);
    const result = await tools.get("ae_list_layers")!.handler({ comp: "Big" });
    expect(parseResult(result)).toHaveLength(50);
  });

  it("bridge returns empty array", async () => {
    bridge.send.mockResolvedValueOnce([]);
    const result = await tools.get("ae_list_layers")!.handler({ comp: "Empty" });
    expect(parseResult(result)).toEqual([]);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("comp not found"));
    await expect(tools.get("ae_list_layers")!.handler({ comp: "Missing" })).rejects.toThrow("comp not found");
  });

  it("comp with forward slashes", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "folder/subfolder/comp" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "folder/subfolder/comp" });
  });

  it("comp with backslashes", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "folder\\comp" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "folder\\comp" });
  });

  it("very long comp name", async () => {
    const longName = "C".repeat(500);
    await tools.get("ae_list_layers")!.handler({ comp: longName });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: longName });
  });

  it("comp with quotes", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: 'My "Comp"' });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: 'My "Comp"' });
  });

  it("comp with emoji", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "Fire Comp" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "Fire Comp" });
  });

  it("result is well-formed MCP content", async () => {
    bridge.send.mockResolvedValueOnce([{ name: "L1" }]);
    const result = await tools.get("ae_list_layers")!.handler({ comp: "X" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("multiple sequential calls with different comps", async () => {
    bridge.send.mockResolvedValueOnce([{ name: "A" }]);
    bridge.send.mockResolvedValueOnce([{ name: "B" }]);
    await tools.get("ae_list_layers")!.handler({ comp: "CompA" });
    await tools.get("ae_list_layers")!.handler({ comp: "CompB" });
    expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(bridge.send).toHaveBeenNthCalledWith(1, "layers.list", { comp: "CompA" });
    expect(bridge.send).toHaveBeenNthCalledWith(2, "layers.list", { comp: "CompB" });
  });

  it("comp with tab and newline characters", async () => {
    await tools.get("ae_list_layers")!.handler({ comp: "comp\twith\nnewline" });
    expect(bridge.send).toHaveBeenCalledWith("layers.list", { comp: "comp\twith\nnewline" });
  });
});

// ============================================================================
// ae_get_layer_properties (~15 tests)
// ============================================================================

describe("ae_get_layer_properties stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerLayerTools } = await import("../src/tools/layers.js");
    registerLayerTools(cap.mockServer, bridge as any);
  });

  it("comp + layer both passed", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "Main", layer: "Text 1" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "Main", layer: "Text 1" });
  });

  it("layer as name string", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "Main", layer: "Background" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "Main", layer: "Background" });
  });

  it("layer as numeric string", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "Main", layer: "1" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "Main", layer: "1" });
  });

  it("layer as zero index string", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "Main", layer: "0" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "Main", layer: "0" });
  });

  it("both params with Unicode", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "コンポ", layer: "レイヤー" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "コンポ", layer: "レイヤー" });
  });

  it("bridge returns complex property object", async () => {
    const props = { transform: { position: [960, 540], scale: [100, 100] }, effects: [] };
    bridge.send.mockResolvedValueOnce(props);
    const result = await tools.get("ae_get_layer_properties")!.handler({ comp: "X", layer: "Y" });
    expect(parseResult(result)).toEqual(props);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("layer not found"));
    await expect(tools.get("ae_get_layer_properties")!.handler({ comp: "X", layer: "Y" })).rejects.toThrow("layer not found");
  });

  it("layer with spaces", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "C", layer: "Layer With Spaces" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "C", layer: "Layer With Spaces" });
  });

  it("layer with special characters", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "C", layer: "layer (copy 2) [locked]" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "C", layer: "layer (copy 2) [locked]" });
  });

  it("empty layer string", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "C", layer: "" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "C", layer: "" });
  });

  it("empty comp string", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "", layer: "L" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "", layer: "L" });
  });

  it("bridge returns null", async () => {
    bridge.send.mockResolvedValueOnce(null);
    const result = await tools.get("ae_get_layer_properties")!.handler({ comp: "C", layer: "L" });
    expect(parseResult(result)).toBeNull();
  });

  it("large property result", async () => {
    const largeProps = { effects: Array.from({ length: 200 }, (_, i) => ({ name: `Effect_${i}`, enabled: true })) };
    bridge.send.mockResolvedValueOnce(largeProps);
    const result = await tools.get("ae_get_layer_properties")!.handler({ comp: "C", layer: "L" });
    expect(parseResult(result).effects).toHaveLength(200);
  });

  it("comp and layer with newlines", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "multi\nline", layer: "also\nmulti" });
    expect(bridge.send).toHaveBeenCalledWith("layers.getProperties", { comp: "multi\nline", layer: "also\nmulti" });
  });

  it("sequential calls use correct params", async () => {
    await tools.get("ae_get_layer_properties")!.handler({ comp: "A", layer: "1" });
    await tools.get("ae_get_layer_properties")!.handler({ comp: "B", layer: "2" });
    expect(bridge.send).toHaveBeenNthCalledWith(1, "layers.getProperties", { comp: "A", layer: "1" });
    expect(bridge.send).toHaveBeenNthCalledWith(2, "layers.getProperties", { comp: "B", layer: "2" });
  });
});

// ============================================================================
// ae_get_expressions (~15 tests)
// ============================================================================

describe("ae_get_expressions stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerExpressionTools } = await import("../src/tools/expressions.js");
    registerExpressionTools(cap.mockServer, bridge as any);
  });

  it("comp only - layer is empty string", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Main" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Main", layer: "" });
  });

  it("comp + layer both passed", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Main", layer: "Text 1" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Main", layer: "Text 1" });
  });

  it("undefined layer treated as empty string", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Main", layer: undefined });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Main", layer: "" });
  });

  it("bridge returns 20 expressions", async () => {
    const exprs = Array.from({ length: 20 }, (_, i) => ({ property: `prop_${i}`, code: `value * ${i}`, enabled: true }));
    bridge.send.mockResolvedValueOnce(exprs);
    const result = await tools.get("ae_get_expressions")!.handler({ comp: "X" });
    expect(parseResult(result)).toHaveLength(20);
  });

  it("bridge returns empty array", async () => {
    bridge.send.mockResolvedValueOnce([]);
    const result = await tools.get("ae_get_expressions")!.handler({ comp: "X" });
    expect(parseResult(result)).toEqual([]);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("no expressions"));
    await expect(tools.get("ae_get_expressions")!.handler({ comp: "X" })).rejects.toThrow("no expressions");
  });

  it("comp with special characters", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Comp [v2] (final)" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Comp [v2] (final)", layer: "" });
  });

  it("layer with numeric index string", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Main", layer: "3" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Main", layer: "3" });
  });

  it("bridge returns expressions with error info", async () => {
    const exprs = [{ property: "Position", code: "wiggle(", enabled: true, error: "Syntax error" }];
    bridge.send.mockResolvedValueOnce(exprs);
    const result = await tools.get("ae_get_expressions")!.handler({ comp: "X" });
    expect(parseResult(result)[0].error).toBe("Syntax error");
  });

  it("comp with Unicode", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "コンポ" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "コンポ", layer: "" });
  });

  it("empty string layer passed as empty string", async () => {
    await tools.get("ae_get_expressions")!.handler({ comp: "Main", layer: "" });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: "Main", layer: "" });
  });

  it("result is valid JSON", async () => {
    bridge.send.mockResolvedValueOnce({ code: "wiggle(5,10)" });
    const result = await tools.get("ae_get_expressions")!.handler({ comp: "X" });
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it("bridge returns null", async () => {
    bridge.send.mockResolvedValueOnce(null);
    const result = await tools.get("ae_get_expressions")!.handler({ comp: "X" });
    expect(parseResult(result)).toBeNull();
  });

  it("very long comp name", async () => {
    const longComp = "C".repeat(1000);
    await tools.get("ae_get_expressions")!.handler({ comp: longComp });
    expect(bridge.send).toHaveBeenCalledWith("expressions.get", { comp: longComp, layer: "" });
  });

  it("sequential calls don't interfere", async () => {
    bridge.send.mockResolvedValueOnce([{ code: "a" }]);
    bridge.send.mockResolvedValueOnce([{ code: "b" }]);
    const r1 = await tools.get("ae_get_expressions")!.handler({ comp: "A" });
    const r2 = await tools.get("ae_get_expressions")!.handler({ comp: "B" });
    expect(parseResult(r1)[0].code).toBe("a");
    expect(parseResult(r2)[0].code).toBe("b");
  });
});

// ============================================================================
// ae_eval_expression_at_time (~15 tests)
// ============================================================================

describe("ae_eval_expression_at_time stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerExpressionTools } = await import("../src/tools/expressions.js");
    registerExpressionTools(cap.mockServer, bridge as any);
  });

  it("all 4 params passed correctly", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "Main", layer: "Text", property: "Source Text", time: 2.5 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", { comp: "Main", layer: "Text", property: "Source Text", time: 2.5 });
  });

  it("time = 0 passed as 0", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 0 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", { comp: "C", layer: "L", property: "P", time: 0 });
  });

  it("time = 99.999 passed correctly", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 99.999 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ time: 99.999 }));
  });

  it("negative time passed through", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: -1.5 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ time: -1.5 }));
  });

  it("property path with slashes", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Transform/Position", time: 1 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ property: "Transform/Position" }));
  });

  it("property path with multiple slashes", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Effects/Glow/Radius", time: 1 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ property: "Effects/Glow/Radius" }));
  });

  it("bridge returns numeric value", async () => {
    bridge.send.mockResolvedValueOnce(42.5);
    const result = await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 1 });
    expect(parseResult(result)).toBe(42.5);
  });

  it("bridge returns array value (position)", async () => {
    bridge.send.mockResolvedValueOnce([960, 540, 0]);
    const result = await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Transform/Position", time: 1 });
    expect(parseResult(result)).toEqual([960, 540, 0]);
  });

  it("bridge returns string value (source text)", async () => {
    bridge.send.mockResolvedValueOnce("Hello World");
    const result = await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Source Text", time: 1 });
    expect(parseResult(result)).toBe("Hello World");
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("property not found"));
    await expect(tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Bad", time: 1 })).rejects.toThrow("property not found");
  });

  it("very large time value", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 999999.999 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ time: 999999.999 }));
  });

  it("time as integer", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 5 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ time: 5 }));
  });

  it("Unicode in all string params", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "コンポ", layer: "レイヤー", property: "プロパティ", time: 1 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", { comp: "コンポ", layer: "レイヤー", property: "プロパティ", time: 1 });
  });

  it("bridge returns null", async () => {
    bridge.send.mockResolvedValueOnce(null);
    const result = await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "P", time: 1 });
    expect(parseResult(result)).toBeNull();
  });

  it("property with spaces", async () => {
    await tools.get("ae_eval_expression_at_time")!.handler({ comp: "C", layer: "L", property: "Source Text", time: 1 });
    expect(bridge.send).toHaveBeenCalledWith("expressions.evalAtTime", expect.objectContaining({ property: "Source Text" }));
  });
});

// ============================================================================
// ae_eval_extendscript (~10 tests)
// ============================================================================

describe("ae_eval_extendscript stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerExecuteTools } = await import("../src/tools/execute.js");
    registerExecuteTools(cap.mockServer, bridge as any);
  });

  it("code passed to bridge", async () => {
    await tools.get("ae_eval_extendscript")!.handler({ code: "alert('hello')" });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code: "alert('hello')" });
  });

  it("very long code (50KB) passed through", async () => {
    const longCode = "var x = 1;\n".repeat(5000);
    await tools.get("ae_eval_extendscript")!.handler({ code: longCode });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code: longCode });
  });

  it("code with special characters", async () => {
    const code = 'var x = "hello \\"world\\""; // comment\n\ttab';
    await tools.get("ae_eval_extendscript")!.handler({ code });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code });
  });

  it("code with Unicode", async () => {
    await tools.get("ae_eval_extendscript")!.handler({ code: 'var x = "日本語";' });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code: 'var x = "日本語";' });
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("script error"));
    await expect(tools.get("ae_eval_extendscript")!.handler({ code: "bad();" })).rejects.toThrow("script error");
  });

  it("bridge returns execution result", async () => {
    bridge.send.mockResolvedValueOnce({ returnValue: 42 });
    const result = await tools.get("ae_eval_extendscript")!.handler({ code: "1+41" });
    expect(parseResult(result).returnValue).toBe(42);
  });

  it("code with newlines and tabs", async () => {
    const code = "function test() {\n\treturn 1;\n}";
    await tools.get("ae_eval_extendscript")!.handler({ code });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code });
  });

  it("code with backslashes", async () => {
    const code = 'var path = "C:\\\\Users\\\\test";';
    await tools.get("ae_eval_extendscript")!.handler({ code });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code });
  });

  it("multiline complex script", async () => {
    const code = [
      "var comp = app.project.activeItem;",
      "if (comp instanceof CompItem) {",
      "  var layers = comp.layers;",
      "  for (var i = 1; i <= layers.length; i++) {",
      "    layers[i].enabled = false;",
      "  }",
      "}",
    ].join("\n");
    await tools.get("ae_eval_extendscript")!.handler({ code });
    expect(bridge.send).toHaveBeenCalledWith("execute.eval", { code });
  });

  it("result is formatted JSON", async () => {
    bridge.send.mockResolvedValueOnce({ status: "ok" });
    const result = await tools.get("ae_eval_extendscript")!.handler({ code: "test()" });
    const text = result.content[0].text;
    // Pretty-printed JSON has newlines
    expect(text).toContain("\n");
  });
});

// ============================================================================
// ae_run_jsx_file (~20 tests)
// ============================================================================

describe("ae_run_jsx_file stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerExecuteTools } = await import("../src/tools/execute.js");
    registerExecuteTools(cap.mockServer, bridge as any);
  });

  it("valid .jsx path sent to bridge as resolved path", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.jsx" });
    const callArgs = bridge.send.mock.calls[0];
    expect(callArgs[0]).toBe("execute.runFile");
    expect(callArgs[1].path).toMatch(/test\.jsx$/);
  });

  it("path with '..' rejects with traversal error", async () => {
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/../secret.jsx" })).rejects.toThrow("traversal");
  });

  it(".jsxbin extension accepted", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/compiled.jsxbin" });
    const callArgs = bridge.send.mock.calls[0];
    expect(callArgs[1].path).toMatch(/compiled\.jsxbin$/);
  });

  it(".js extension rejected", async () => {
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.js" })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it(".txt extension rejected", async () => {
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.txt" })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it(".py extension rejected", async () => {
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.py" })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it(".JSX uppercase extension accepted", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.JSX" });
    expect(bridge.send).toHaveBeenCalled();
  });

  it(".JSXBIN uppercase extension accepted", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.JSXBIN" });
    expect(bridge.send).toHaveBeenCalled();
  });

  it("path with spaces resolved correctly", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/My Scripts/test file.jsx" });
    const callArgs = bridge.send.mock.calls[0];
    expect(callArgs[1].path).toContain("test file.jsx");
  });

  it("relative path without '..' resolved to absolute", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "test.jsx" });
    const callArgs = bridge.send.mock.calls[0];
    // resolve() makes it absolute
    expect(callArgs[1].path).toMatch(/^[A-Z]:|^\//);
  });

  it("just a filename 'test.jsx' resolved to absolute", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "test.jsx" });
    const callArgs = bridge.send.mock.calls[0];
    expect(callArgs[1].path).toMatch(/^[A-Z]:|^\//);
    expect(callArgs[1].path).toMatch(/test\.jsx$/);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("file not found in AE"));
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/missing.jsx" })).rejects.toThrow("file not found in AE");
  });

  it("bridge returns execution result", async () => {
    bridge.send.mockResolvedValueOnce({ returnValue: "done" });
    const result = await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/test.jsx" });
    expect(parseResult(result).returnValue).toBe("done");
  });

  it("path with multiple dots", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/my.script.v2.jsx" });
    expect(bridge.send).toHaveBeenCalled();
  });

  it("no extension rejected", async () => {
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/noext" })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it("path with only extension (dotfile) rejected - extname returns empty", async () => {
    // Node path.extname(".jsx") returns "" — treated as dotfile, not extension
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: ".jsx" })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it("double-dot in filename (not traversal) rejected as traversal", async () => {
    // "file..jsx" contains ".." so it triggers traversal check
    await expect(tools.get("ae_run_jsx_file")!.handler({ path: "/scripts/file..jsx" })).rejects.toThrow("traversal");
  });

  it("Windows-style path with backslashes", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "C:\\Scripts\\test.jsx" });
    expect(bridge.send).toHaveBeenCalled();
  });

  it("path with forward slashes on Windows", async () => {
    await tools.get("ae_run_jsx_file")!.handler({ path: "C:/Scripts/test.jsx" });
    expect(bridge.send).toHaveBeenCalled();
  });

  it("path with tilde", async () => {
    // ~ is not ".." so it should pass extension check
    await tools.get("ae_run_jsx_file")!.handler({ path: "~/scripts/test.jsx" });
    expect(bridge.send).toHaveBeenCalled();
  });
});

// ============================================================================
// ae_validate_jsx_file (~20 tests)
// ============================================================================

describe("ae_validate_jsx_file stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;
  let tempDir: string;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerExecuteTools } = await import("../src/tools/execute.js");
    registerExecuteTools(cap.mockServer, bridge as any);
    tempDir = await mkdtemp(join(tmpdir(), "ae-stress-jsx-"));
  });

  const afterEachCleanup = async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  it("path with '..' rejects with traversal error", async () => {
    await afterEachCleanup();
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: "/a/../b.jsx", dryRun: false })).rejects.toThrow("traversal");
  });

  it(".js extension rejected", async () => {
    await afterEachCleanup();
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: "/test.js", dryRun: false })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it(".txt extension rejected", async () => {
    await afterEachCleanup();
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: "/test.txt", dryRun: false })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it(".jsxbin extension accepted", async () => {
    const filePath = join(tempDir, "test.jsxbin");
    await writeFile(filePath, "compiled binary", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).valid).toBe(true);
    await afterEachCleanup();
  });

  it("dryRun=true passed to bridge", async () => {
    const filePath = join(tempDir, "test.jsx");
    await writeFile(filePath, "alert(1);", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: true });
    expect(bridge.send).toHaveBeenCalledWith("execute.validateFile", expect.objectContaining({ dryRun: true }));
    await afterEachCleanup();
  });

  it("dryRun=false passed to bridge", async () => {
    const filePath = join(tempDir, "test.jsx");
    await writeFile(filePath, "alert(1);", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(bridge.send).toHaveBeenCalledWith("execute.validateFile", expect.objectContaining({ dryRun: false }));
    await afterEachCleanup();
  });

  it("file doesn't exist returns valid:false with error", async () => {
    const filePath = join(tempDir, "nonexistent.jsx");
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0]).toContain("Cannot read file");
    await afterEachCleanup();
  });

  it("file exists returns bridge result + fileSize", async () => {
    const filePath = join(tempDir, "test.jsx");
    const content = "var x = 1; var y = 2;";
    await writeFile(filePath, content, "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.fileSize).toBe(content.length);
    await afterEachCleanup();
  });

  it("large file (100KB .jsx) has correct fileSize", async () => {
    const filePath = join(tempDir, "large.jsx");
    const content = "var x = 1;\n".repeat(10000);
    await writeFile(filePath, content, "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const parsed = parseResult(result);
    expect(parsed.fileSize).toBe(content.length);
    await afterEachCleanup();
  });

  it(".JSX uppercase accepted", async () => {
    const filePath = join(tempDir, "test.JSX");
    await writeFile(filePath, "alert(1);", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).valid).toBe(true);
    await afterEachCleanup();
  });

  it("bridge error propagates even when file exists", async () => {
    const filePath = join(tempDir, "test.jsx");
    await writeFile(filePath, "alert(1);", "utf-8");
    bridge.send.mockRejectedValueOnce(new Error("AE crashed"));
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false })).rejects.toThrow("AE crashed");
    await afterEachCleanup();
  });

  it("bridge returns validation errors in result", async () => {
    const filePath = join(tempDir, "bad.jsx");
    await writeFile(filePath, "function bad(", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: false, errors: ["Syntax error line 1"], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain("Syntax error line 1");
    await afterEachCleanup();
  });

  it("bridge returns warnings", async () => {
    const filePath = join(tempDir, "warn.jsx");
    await writeFile(filePath, "eval('code');", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: ["eval usage"] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).warnings).toContain("eval usage");
    await afterEachCleanup();
  });

  it("path with spaces works", async () => {
    const filePath = join(tempDir, "my script.jsx");
    await writeFile(filePath, "alert(1);", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).valid).toBe(true);
    await afterEachCleanup();
  });

  it("no extension rejected", async () => {
    await afterEachCleanup();
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: "/test", dryRun: false })).rejects.toThrow("Only .jsx and .jsxbin");
  });

  it("result merges bridge result with fileSize", async () => {
    const filePath = join(tempDir, "merge.jsx");
    await writeFile(filePath, "x;", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [], customField: "extra" });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const parsed = parseResult(result);
    expect(parsed.customField).toBe("extra");
    expect(parsed.fileSize).toBe(2);
    await afterEachCleanup();
  });

  it("double dot in path rejects", async () => {
    await afterEachCleanup();
    await expect(tools.get("ae_validate_jsx_file")!.handler({ path: "folder/../test.jsx", dryRun: false })).rejects.toThrow("traversal");
  });

  it("resolved path sent to bridge not original", async () => {
    const filePath = join(tempDir, "resolve.jsx");
    await writeFile(filePath, "1;", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    const sentPath = bridge.send.mock.calls[0][1].path;
    expect(sentPath).toBe(resolve(filePath));
    await afterEachCleanup();
  });

  it("fileSize is 0 for empty file", async () => {
    const filePath = join(tempDir, "empty.jsx");
    await writeFile(filePath, "", "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).fileSize).toBe(0);
    await afterEachCleanup();
  });

  it("file with Unicode content has correct fileSize", async () => {
    const filePath = join(tempDir, "unicode.jsx");
    const content = 'var x = "日本語テスト";';
    await writeFile(filePath, content, "utf-8");
    bridge.send.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const result = await tools.get("ae_validate_jsx_file")!.handler({ path: filePath, dryRun: false });
    expect(parseResult(result).fileSize).toBe(content.length);
    await afterEachCleanup();
  });
});

// ============================================================================
// ae_get_render_queue (~5 tests)
// ============================================================================

describe("ae_get_render_queue stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerRenderTools } = await import("../src/tools/render.js");
    registerRenderTools(cap.mockServer, bridge as any);
  });

  it("no params calls bridge", async () => {
    await tools.get("ae_get_render_queue")!.handler({});
    expect(bridge.send).toHaveBeenCalledWith("render.getQueue");
  });

  it("bridge returns queue with items", async () => {
    const queue = [{ status: "queued", comp: "Main", output: "/out/main.mp4" }];
    bridge.send.mockResolvedValueOnce(queue);
    const result = await tools.get("ae_get_render_queue")!.handler({});
    expect(parseResult(result)).toHaveLength(1);
    expect(parseResult(result)[0].status).toBe("queued");
  });

  it("bridge returns empty queue", async () => {
    bridge.send.mockResolvedValueOnce([]);
    const result = await tools.get("ae_get_render_queue")!.handler({});
    expect(parseResult(result)).toEqual([]);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("AE not responding"));
    await expect(tools.get("ae_get_render_queue")!.handler({})).rejects.toThrow("AE not responding");
  });

  it("bridge returns multiple queue items", async () => {
    const queue = Array.from({ length: 10 }, (_, i) => ({ index: i, status: i < 5 ? "done" : "queued" }));
    bridge.send.mockResolvedValueOnce(queue);
    const result = await tools.get("ae_get_render_queue")!.handler({});
    expect(parseResult(result)).toHaveLength(10);
  });
});

// ============================================================================
// ae_monitor_render (~15 tests)
// ============================================================================

describe("ae_monitor_render stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerRenderTools } = await import("../src/tools/render.js");
    registerRenderTools(cap.mockServer, bridge as any);
  });

  it("default timeout/interval used when omitted (via Zod defaults)", async () => {
    // Zod defaults are applied by MCP SDK before handler. When calling handler directly,
    // we must supply the defaults ourselves, matching what MCP SDK would provide.
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 2000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 60000, interval: 2000 }, 65000);
  });

  it("custom timeout passed to bridge with +5000 buffer", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 30000, interval: 2000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 30000, interval: 2000 }, 35000);
  });

  it("custom interval passed to bridge", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 5000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 60000, interval: 5000 }, 65000);
  });

  it("timeout=1000 accepted (boundary)", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 1000, interval: 500 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 1000, interval: 500 }, 6000);
  });

  it("timeout=600000 accepted (boundary)", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 600000, interval: 2000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 600000, interval: 2000 }, 605000);
  });

  it("interval=500 accepted (boundary)", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 500 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 60000, interval: 500 }, 65000);
  });

  it("interval=30000 accepted (boundary)", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 30000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 60000, interval: 30000 }, 65000);
  });

  it("bridge returns render status", async () => {
    bridge.send.mockResolvedValueOnce({ items: [{ status: "done" }], completed: true });
    const result = await tools.get("ae_monitor_render")!.handler({});
    expect(parseResult(result).completed).toBe(true);
  });

  it("bridge error propagates (timeout)", async () => {
    bridge.send.mockRejectedValueOnce(new Error("timed out"));
    await expect(tools.get("ae_monitor_render")!.handler({})).rejects.toThrow("timed out");
  });

  it("bridge returns partial progress", async () => {
    bridge.send.mockResolvedValueOnce({ items: [{ status: "rendering", progress: 0.5 }], completed: false });
    const result = await tools.get("ae_monitor_render")!.handler({});
    expect(parseResult(result).completed).toBe(false);
  });

  it("both defaults produce correct bridge call", async () => {
    // Supply Zod defaults manually since MCP SDK applies them
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 2000 });
    const [method, params, timeout] = bridge.send.mock.calls[0];
    expect(method).toBe("render.monitor");
    expect(params.timeout).toBe(60000);
    expect(params.interval).toBe(2000);
    expect(timeout).toBe(65000);
  });

  it("timeout only specified - interval defaults supplied", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 120000, interval: 2000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 120000, interval: 2000 }, 125000);
  });

  it("interval only specified - timeout defaults supplied", async () => {
    await tools.get("ae_monitor_render")!.handler({ timeout: 60000, interval: 1000 });
    expect(bridge.send).toHaveBeenCalledWith("render.monitor", { timeout: 60000, interval: 1000 }, 65000);
  });

  it("result is well-formed MCP content", async () => {
    bridge.send.mockResolvedValueOnce({ done: true });
    const result = await tools.get("ae_monitor_render")!.handler({});
    expect(result.content[0].type).toBe("text");
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it("bridge returns null result", async () => {
    bridge.send.mockResolvedValueOnce(null);
    const result = await tools.get("ae_monitor_render")!.handler({});
    expect(parseResult(result)).toBeNull();
  });
});

// ============================================================================
// ae_check_output (~5 tests)
// ============================================================================

describe("ae_check_output stress", () => {
  let tools: Map<string, ToolEntry>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    const cap = captureMockServer();
    tools = cap.tools;
    bridge = createMockBridge();
    const { registerRenderTools } = await import("../src/tools/render.js");
    registerRenderTools(cap.mockServer, bridge as any);
  });

  it("path passed to bridge", async () => {
    await tools.get("ae_check_output")!.handler({ path: "/output/render.mp4" });
    expect(bridge.send).toHaveBeenCalledWith("render.checkOutput", { path: "/output/render.mp4" });
  });

  it("bridge returns file info", async () => {
    bridge.send.mockResolvedValueOnce({ exists: true, size: 1024000, modified: "2026-01-01T00:00:00Z" });
    const result = await tools.get("ae_check_output")!.handler({ path: "/output/render.mp4" });
    expect(parseResult(result).exists).toBe(true);
    expect(parseResult(result).size).toBe(1024000);
  });

  it("bridge returns file not found", async () => {
    bridge.send.mockResolvedValueOnce({ exists: false });
    const result = await tools.get("ae_check_output")!.handler({ path: "/output/missing.mp4" });
    expect(parseResult(result).exists).toBe(false);
  });

  it("bridge error propagates", async () => {
    bridge.send.mockRejectedValueOnce(new Error("check failed"));
    await expect(tools.get("ae_check_output")!.handler({ path: "/out.mp4" })).rejects.toThrow("check failed");
  });

  it("path with spaces and special chars", async () => {
    const path = "/My Output/render (final) [v2].mp4";
    await tools.get("ae_check_output")!.handler({ path });
    expect(bridge.send).toHaveBeenCalledWith("render.checkOutput", { path });
  });
});
