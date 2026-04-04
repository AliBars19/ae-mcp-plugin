import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

/**
 * Tool registration tests.
 *
 * Strategy: mock McpServer.tool() to capture registration calls,
 * then verify names, descriptions, schemas, and handler behaviour.
 */

interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function createMockServer(): { tool: ReturnType<typeof vi.fn>; registrations: ToolRegistration[] } {
  const registrations: ToolRegistration[] = [];
  const tool = vi.fn(
    (name: string, description: string, schema: Record<string, unknown>, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      registrations.push({ name, description, schema, handler });
    },
  );
  return { tool, registrations };
}

function createMockBridge() {
  return {
    send: vi.fn().mockResolvedValue({ ok: true }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isConnected: true,
  };
}

function findTool(registrations: ToolRegistration[], name: string): ToolRegistration {
  const found = registrations.find((r) => r.name === name);
  if (!found) throw new Error(`Tool "${name}" not found. Registered: ${registrations.map((r) => r.name).join(", ")}`);
  return found;
}

// ── Project tools ──

describe("Project tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerProjectTools } = await import("../src/tools/project.js");
    registerProjectTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_get_project_info", () => {
    const tool = findTool(mockServer.registrations, "ae_get_project_info");
    expect(tool.description).toContain("project info");
  });

  it("registers ae_list_comps", () => {
    const tool = findTool(mockServer.registrations, "ae_list_comps");
    expect(tool.description).toContain("compositions");
  });

  it("registers ae_search_project", () => {
    const tool = findTool(mockServer.registrations, "ae_search_project");
    expect(tool.description).toContain("Search");
  });

  it("ae_list_comps has optional filter param", () => {
    const tool = findTool(mockServer.registrations, "ae_list_comps");
    // The schema should have a filter key
    expect(tool.schema).toHaveProperty("filter");
  });

  it("ae_search_project has query param", () => {
    const tool = findTool(mockServer.registrations, "ae_search_project");
    expect(tool.schema).toHaveProperty("query");
  });

  it("ae_search_project has optional type param", () => {
    const tool = findTool(mockServer.registrations, "ae_search_project");
    expect(tool.schema).toHaveProperty("type");
  });
});

// ── Layer tools ──

describe("Layer tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerLayerTools } = await import("../src/tools/layers.js");
    registerLayerTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_list_layers", () => {
    const tool = findTool(mockServer.registrations, "ae_list_layers");
    expect(tool.description).toContain("layers");
  });

  it("ae_list_layers requires comp param", () => {
    const tool = findTool(mockServer.registrations, "ae_list_layers");
    expect(tool.schema).toHaveProperty("comp");
  });

  it("registers ae_get_layer_properties", () => {
    const tool = findTool(mockServer.registrations, "ae_get_layer_properties");
    expect(tool.description).toContain("properties");
  });

  it("ae_get_layer_properties requires comp and layer", () => {
    const tool = findTool(mockServer.registrations, "ae_get_layer_properties");
    expect(tool.schema).toHaveProperty("comp");
    expect(tool.schema).toHaveProperty("layer");
  });
});

// ── Expression tools ──

describe("Expression tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerExpressionTools } = await import("../src/tools/expressions.js");
    registerExpressionTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_get_expressions with comp param", () => {
    const tool = findTool(mockServer.registrations, "ae_get_expressions");
    expect(tool.schema).toHaveProperty("comp");
  });

  it("ae_get_expressions has optional layer param", () => {
    const tool = findTool(mockServer.registrations, "ae_get_expressions");
    expect(tool.schema).toHaveProperty("layer");
  });

  it("registers ae_eval_expression_at_time", () => {
    const tool = findTool(mockServer.registrations, "ae_eval_expression_at_time");
    expect(tool.schema).toHaveProperty("comp");
    expect(tool.schema).toHaveProperty("layer");
    expect(tool.schema).toHaveProperty("property");
    expect(tool.schema).toHaveProperty("time");
  });
});

// ── Execute tools ──

describe("Execute tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerExecuteTools } = await import("../src/tools/execute.js");
    registerExecuteTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_eval_extendscript with code param", () => {
    const tool = findTool(mockServer.registrations, "ae_eval_extendscript");
    expect(tool.schema).toHaveProperty("code");
  });

  it("registers ae_run_jsx_file with path param", () => {
    const tool = findTool(mockServer.registrations, "ae_run_jsx_file");
    expect(tool.schema).toHaveProperty("path");
  });

  it("registers ae_validate_jsx_file with path and dryRun params", () => {
    const tool = findTool(mockServer.registrations, "ae_validate_jsx_file");
    expect(tool.schema).toHaveProperty("path");
    expect(tool.schema).toHaveProperty("dryRun");
  });

  it("ae_validate_jsx_file handles missing file path", async () => {
    const tool = findTool(mockServer.registrations, "ae_validate_jsx_file");
    const result = (await tool.handler({ path: "/nonexistent/file.jsx", dryRun: false })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain("Cannot read file");
  });
});

// ── Render tools ──

describe("Render tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerRenderTools } = await import("../src/tools/render.js");
    registerRenderTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_get_render_queue", () => {
    findTool(mockServer.registrations, "ae_get_render_queue");
  });

  it("registers ae_monitor_render with timeout and interval params", () => {
    const tool = findTool(mockServer.registrations, "ae_monitor_render");
    expect(tool.schema).toHaveProperty("timeout");
    expect(tool.schema).toHaveProperty("interval");
  });

  it("registers ae_check_output with path param", () => {
    const tool = findTool(mockServer.registrations, "ae_check_output");
    expect(tool.schema).toHaveProperty("path");
  });
});

// ── Context tools ──

describe("Context tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockBridge: ReturnType<typeof createMockBridge>;

  beforeEach(async () => {
    mockServer = createMockServer();
    mockBridge = createMockBridge();

    const { registerContextTools } = await import("../src/tools/context.js");
    registerContextTools(mockServer as any, mockBridge as any);
  });

  it("registers ae_read_shared_context with optional key param", () => {
    const tool = findTool(mockServer.registrations, "ae_read_shared_context");
    expect(tool.schema).toHaveProperty("key");
  });

  it("registers ae_write_shared_context with key param", () => {
    const tool = findTool(mockServer.registrations, "ae_write_shared_context");
    expect(tool.schema).toHaveProperty("key");
  });

  it("registers ae_write_shared_context with value param", () => {
    const tool = findTool(mockServer.registrations, "ae_write_shared_context");
    expect(tool.schema).toHaveProperty("value");
  });
});
