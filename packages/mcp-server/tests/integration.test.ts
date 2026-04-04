import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

/**
 * Integration tests — full round trip through the Bridge to a mock WS server.
 *
 * These test the complete flow: caller → Bridge.send() → WebSocket → mock server → response.
 */

let nextPort = 19200;
function getPort(): number {
  return nextPort++;
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => resolve());
  });
}

describe("Integration: Bridge ↔ Mock Server", () => {
  let server: WebSocketServer | null = null;
  let bridge: Bridge | null = null;

  afterEach(async () => {
    if (bridge) {
      bridge.close();
      bridge = null;
    }
    if (server) {
      await closeServer(server);
      server = null;
    }
    await new Promise((r) => setTimeout(r, 50));
  });

  it("full round trip: send JSON-RPC through bridge, mock server responds", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        // Verify JSON-RPC structure
        expect(req.jsonrpc).toBe("2.0");
        expect(req.id).toBeDefined();
        expect(req.method).toBe("project.getInfo");

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              name: "TestProject.aep",
              version: "24.0",
              numItems: 42,
            },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const result = (await bridge.send("project.getInfo")) as Record<string, unknown>;
    expect(result.name).toBe("TestProject.aep");
    expect(result.version).toBe("24.0");
    expect(result.numItems).toBe(42);
  });

  it("multiple sequential requests", async () => {
    const port = getPort();
    let callCount = 0;
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        callCount++;
        const req = JSON.parse(raw.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { call: callCount, method: req.method },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const r1 = (await bridge.send("method.one")) as Record<string, unknown>;
    const r2 = (await bridge.send("method.two")) as Record<string, unknown>;
    const r3 = (await bridge.send("method.three")) as Record<string, unknown>;

    expect(r1.call).toBe(1);
    expect(r2.call).toBe(2);
    expect(r3.call).toBe(3);
    expect(r1.method).toBe("method.one");
    expect(r2.method).toBe("method.two");
    expect(r3.method).toBe("method.three");
  });

  it("request timeout when mock server doesn't respond", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", () => {
      // Intentionally don't respond
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const start = Date.now();
    await expect(bridge.send("slow.method", {}, 300)).rejects.toThrow(
      /timed out/,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1000);
  });

  it("error propagation from mock server to bridge caller", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32603,
              message: "Internal error: composition not found",
            },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("layers.list", { comp: "Missing" })).rejects.toThrow(
      "Internal error: composition not found",
    );
  });

  it("params are correctly forwarded to server", async () => {
    const port = getPort();
    let receivedParams: Record<string, unknown> = {};
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedParams = req.params;
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { ok: true },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    await bridge.send("layers.list", { comp: "MyComp", filter: "text.*" });
    expect(receivedParams).toEqual({ comp: "MyComp", filter: "text.*" });
  });

  it("multiple parallel requests with different response times", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        // Vary response time by method
        const delay = req.method === "fast" ? 10 : req.method === "medium" ? 50 : 100;
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { method: req.method, delay },
            }),
          );
        }, delay);
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const [fast, medium, slow] = await Promise.all([
      bridge.send("fast"),
      bridge.send("medium"),
      bridge.send("slow"),
    ]);

    expect((fast as any).method).toBe("fast");
    expect((medium as any).method).toBe("medium");
    expect((slow as any).method).toBe("slow");
  });

  it("large payload round trip", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        // Echo back a large result
        const layers = Array.from({ length: 100 }, (_, i) => ({
          name: `Layer ${i}`,
          type: "text",
          index: i,
        }));
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { layers },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const result = (await bridge.send("layers.list", { comp: "Big" })) as any;
    expect(result.layers).toHaveLength(100);
    expect(result.layers[0].name).toBe("Layer 0");
    expect(result.layers[99].name).toBe("Layer 99");
  });

  it("bridge recovers after server restart mid-session", async () => {
    const port = getPort();
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { phase: "first" },
          }),
        );
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const r1 = (await bridge.send("test")) as any;
    expect(r1.phase).toBe("first");

    // Kill server
    await closeServer(server);
    await new Promise((r) => setTimeout(r, 200));

    // Restart with different response
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { phase: "second" },
          }),
        );
      });
    });

    // send() should auto-reconnect
    await new Promise((r) => setTimeout(r, 100));
    const r2 = (await bridge.send("test")) as any;
    expect(r2.phase).toBe("second");
  });

  it("empty params object is sent correctly", async () => {
    const port = getPort();
    let receivedParams: unknown;
    server = new WebSocketServer({ port });
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedParams = req.params;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge = new Bridge(port);
    await bridge.connect();
    await bridge.send("project.getInfo");

    expect(receivedParams).toEqual({});
  });
});
