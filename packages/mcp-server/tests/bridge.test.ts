import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

/**
 * Helper — spin up a local WS server that echoes JSON-RPC responses.
 * By default it responds with { jsonrpc: "2.0", id, result: { ok: true } }.
 * Pass a custom `onMessage` to override behaviour.
 */
function createMockServer(
  port: number,
  onMessage?: (ws: WsWebSocket, data: string) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ port });

  if (!onMessage) {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { ok: true, method: req.method },
          }),
        );
      });
    });
  } else {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => onMessage(ws, raw.toString()));
    });
  }

  return wss;
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    // Close all connected clients first
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => resolve());
  });
}

// Use a different port range per describe to avoid EADDRINUSE across parallel tests
let nextPort = 19100;
function getPort(): number {
  return nextPort++;
}

describe("Bridge", () => {
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
    // Small delay so OS releases the port
    await new Promise((r) => setTimeout(r, 50));
  });

  // ── connect() ──

  it("connect() resolves when server is up", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    await expect(bridge.connect()).resolves.toBeUndefined();
    expect(bridge.isConnected).toBe(true);
  });

  it("connect() rejects when server is down", async () => {
    const port = getPort();
    bridge = new Bridge(port);

    await expect(bridge.connect()).rejects.toThrow(/Cannot connect/);
    expect(bridge.isConnected).toBe(false);
  });

  it("connect() is idempotent when already connected", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    await bridge.connect();
    // Second call should resolve immediately
    await expect(bridge.connect()).resolves.toBeUndefined();
    expect(bridge.isConnected).toBe(true);
  });

  // ── send() ──

  it("send() sends JSON-RPC request and receives response", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    await bridge.connect();
    const result = await bridge.send("project.getInfo");

    expect(result).toEqual({ ok: true, method: "project.getInfo" });
  });

  it("send() rejects on timeout", async () => {
    const port = getPort();
    // Server that never responds
    server = createMockServer(port, () => {
      /* silence */
    });
    bridge = new Bridge(port);

    await bridge.connect();
    await expect(bridge.send("slow.method", {}, 200)).rejects.toThrow(
      /timed out/,
    );
  });

  it("send() rejects when not connected and server unavailable", async () => {
    const port = getPort();
    bridge = new Bridge(port);

    // send() tries connect() internally, which should fail
    await expect(bridge.send("test.method")).rejects.toThrow(
      /Cannot connect/,
    );
  });

  it("send() auto-connects if disconnected but server available", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    // Don't call connect() — send() should do it automatically
    const result = await bridge.send("project.getInfo");
    expect(result).toEqual({ ok: true, method: "project.getInfo" });
    expect(bridge.isConnected).toBe(true);
  });

  // ── Concurrent requests ──

  it("multiple concurrent requests resolve independently", async () => {
    const port = getPort();
    // Server that echoes back the method name as the result
    server = createMockServer(port, (ws, raw) => {
      const req = JSON.parse(raw);
      // Add slight delay for realism
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { method: req.method },
          }),
        );
      }, 10);
    });
    bridge = new Bridge(port);
    await bridge.connect();

    const [r1, r2, r3] = await Promise.all([
      bridge.send("method.a"),
      bridge.send("method.b"),
      bridge.send("method.c"),
    ]);

    expect(r1).toEqual({ method: "method.a" });
    expect(r2).toEqual({ method: "method.b" });
    expect(r3).toEqual({ method: "method.c" });
  });

  // ── Error responses ──

  it("error responses are properly rejected", async () => {
    const port = getPort();
    server = createMockServer(port, (ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32600, message: "Invalid Request" },
        }),
      );
    });
    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("bad.method")).rejects.toThrow("Invalid Request");
  });

  it("error response with data is still rejected with message", async () => {
    const port = getPort();
    server = createMockServer(port, (ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "AE crashed", data: { details: "segfault" } },
        }),
      );
    });
    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("crash.method")).rejects.toThrow("AE crashed");
  });

  // ── Auto-reconnect ──

  it("auto-reconnects on disconnect", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);
    await bridge.connect();

    expect(bridge.isConnected).toBe(true);

    // Kill the server
    await closeServer(server);

    // Wait for disconnect to register
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.isConnected).toBe(false);

    // Restart server on same port
    server = createMockServer(port);

    // Wait for auto-reconnect (initial delay is 1s, but send() also tries connect)
    await new Promise((r) => setTimeout(r, 100));
    const result = await bridge.send("project.getInfo");
    expect(result).toEqual({ ok: true, method: "project.getInfo" });
    expect(bridge.isConnected).toBe(true);
  });

  // ── close() ──

  it("close() cleans up pending requests", async () => {
    const port = getPort();
    // Server that never responds
    server = createMockServer(port, () => {
      /* silence */
    });
    bridge = new Bridge(port);
    await bridge.connect();

    const pending = bridge.send("slow.method", {}, 30000);
    // Close immediately — should reject the pending request
    bridge.close();

    await expect(pending).rejects.toThrow(/Bridge closing/);
  });

  it("close() prevents reconnection", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);
    await bridge.connect();

    bridge.close();
    expect(bridge.isConnected).toBe(false);

    // After closing, isConnected stays false (no auto-reconnect)
    await new Promise((r) => setTimeout(r, 1500));
    expect(bridge.isConnected).toBe(false);
  });

  // ── isConnected ──

  it("isConnected returns false before connecting", () => {
    const port = getPort();
    bridge = new Bridge(port);
    expect(bridge.isConnected).toBe(false);
  });

  it("isConnected returns true after successful connect", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    await bridge.connect();
    expect(bridge.isConnected).toBe(true);
  });

  it("isConnected returns false after close", async () => {
    const port = getPort();
    server = createMockServer(port);
    bridge = new Bridge(port);

    await bridge.connect();
    bridge.close();
    expect(bridge.isConnected).toBe(false);
  });

  // ── Invalid JSON ──

  it("invalid JSON response is silently ignored", async () => {
    const port = getPort();
    let clientWs: WsWebSocket | null = null;
    server = createMockServer(port, (ws, raw) => {
      clientWs = ws;
      // Send garbage first
      ws.send("not-valid-json{{{");
      // Then send a valid response
      const req = JSON.parse(raw);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { ok: true },
        }),
      );
    });
    bridge = new Bridge(port);
    await bridge.connect();

    // Should still resolve despite the invalid JSON message
    const result = await bridge.send("test.method");
    expect(result).toEqual({ ok: true });
  });

  it("response with unknown id is silently ignored", async () => {
    const port = getPort();
    server = createMockServer(port, (ws, raw) => {
      const req = JSON.parse(raw);
      // Send response with wrong ID first
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "wrong-id-9999",
          result: { wrong: true },
        }),
      );
      // Then correct response
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { correct: true },
        }),
      );
    });
    bridge = new Bridge(port);
    await bridge.connect();

    const result = await bridge.send("test.method");
    expect(result).toEqual({ correct: true });
  });
});
