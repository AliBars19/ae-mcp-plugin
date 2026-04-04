import { describe, it, expect, vi, beforeEach } from "vitest";

interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function createMockServer() {
  const registrations: ToolRegistration[] = [];
  const tool = vi.fn(
    (name: string, description: string, schema: Record<string, unknown>, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      registrations.push({ name, description, schema, handler });
    },
  );
  return { tool, registrations };
}

describe("ae_health tool", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
  });

  it("connected returns aeVersion", async () => {
    const mockBridge = {
      send: vi.fn().mockResolvedValue({ aeVersion: "25.0", name: "TestProject" }),
      isConnected: true,
      uptime: 42,
    };

    const { registerHealthTools } = await import("../src/tools/health.js");
    registerHealthTools(mockServer as any, mockBridge as any);

    const tool = mockServer.registrations.find((r) => r.name === "ae_health");
    expect(tool).toBeDefined();

    const result = (await tool!.handler({})) as { content: Array<{ type: string; text: string }> };
    const status = JSON.parse(result.content[0].text);

    expect(status.connected).toBe(true);
    expect(status.aeVersion).toBe("25.0");
    expect(status.projectName).toBe("TestProject");
    expect(status.uptime).toBe(42);
  });

  it("disconnected returns connected:false without throwing", async () => {
    const mockBridge = {
      send: vi.fn(),
      isConnected: false,
      uptime: 10,
    };

    const { registerHealthTools } = await import("../src/tools/health.js");
    registerHealthTools(mockServer as any, mockBridge as any);

    const tool = mockServer.registrations.find((r) => r.name === "ae_health");
    const result = (await tool!.handler({})) as { content: Array<{ type: string; text: string }> };
    const status = JSON.parse(result.content[0].text);

    expect(status.connected).toBe(false);
    expect(mockBridge.send).not.toHaveBeenCalled();
  });

  it("uptime is a number >= 0", async () => {
    const mockBridge = {
      send: vi.fn().mockResolvedValue({}),
      isConnected: true,
      uptime: 0,
    };

    const { registerHealthTools } = await import("../src/tools/health.js");
    registerHealthTools(mockServer as any, mockBridge as any);

    const tool = mockServer.registrations.find((r) => r.name === "ae_health");
    const result = (await tool!.handler({})) as { content: Array<{ type: string; text: string }> };
    const status = JSON.parse(result.content[0].text);

    expect(typeof status.uptime).toBe("number");
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });
});
