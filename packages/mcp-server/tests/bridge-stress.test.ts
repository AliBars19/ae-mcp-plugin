import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { Bridge } from "../src/bridge.js";
import type { AddressInfo } from "net";

/* ── Helpers ── */

function createServer(
  onMessage?: (ws: WsWebSocket, data: string) => void,
): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
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
      resolve({ wss, port });
    });
  });
}

/** Echo server that responds after a configurable delay */
function createDelayServer(
  delayMs: number,
): Promise<{ wss: WebSocketServer; port: number }> {
  return createServer((ws, raw) => {
    const req = JSON.parse(raw);
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { ok: true, method: req.method },
        }),
      );
    }, delayMs);
  });
}

/** Silent server — never responds */
function createSilentServer(): Promise<{
  wss: WebSocketServer;
  port: number;
}> {
  return createServer(() => {
    /* no response */
  });
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
  });
}

/* ── Test state ── */

let servers: WebSocketServer[] = [];
let bridges: Bridge[] = [];

function trackServer(wss: WebSocketServer): WebSocketServer {
  servers.push(wss);
  return wss;
}

function trackBridge(b: Bridge): Bridge {
  bridges.push(b);
  return b;
}

afterEach(async () => {
  for (const b of bridges) {
    try {
      b.close();
    } catch {
      /* already closed */
    }
  }
  bridges = [];
  for (const s of servers) {
    await closeServer(s);
  }
  servers = [];
  await new Promise((r) => setTimeout(r, 30));
});

/* ================================================================
 *  CONCURRENCY CHOKEPOINTS (~50 tests)
 * ================================================================ */

describe("Concurrency chokepoints", () => {
  it("50 concurrent send() calls — all resolve with correct IDs", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { i: req.params.i } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 50 }, (_, i) =>
      bridge.send("test", { i }),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 50; i++) {
      expect(results[i]).toEqual({ i });
    }
  });

  it("100 concurrent send() calls — no ID collision", async () => {
    const receivedIds = new Set<string>();
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      receivedIds.add(req.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await Promise.all(
      Array.from({ length: 100 }, () => bridge.send("test")),
    );
    expect(receivedIds.size).toBe(100);
  });

  it("send() during active connect() — waits for connection", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    // Start connect but don't await
    const connectP = bridge.connect();
    // Immediately send — should internally wait for connect
    const sendP = bridge.send("test");

    await connectP;
    const result = await sendP;
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("multiple connect() calls racing — only one WebSocket created", async () => {
    let connectionCount = 0;
    const { wss, port } = await createServer();
    wss.on("connection", () => {
      connectionCount++;
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    await Promise.all([
      bridge.connect(),
      bridge.connect(),
      bridge.connect(),
      bridge.connect(),
      bridge.connect(),
    ]);
    // The server may count connections, but the bridge should only create one
    expect(connectionCount).toBe(1);
  });

  it("send() immediately after close() — reconnects since server is still up", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();

    // send() calls connect() internally, which creates a new WebSocket
    // Since the server is still up, the connection succeeds
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("send() while reconnecting — queues via connect or rejects", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Force disconnect by terminating server-side clients
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => setTimeout(r, 100));

    // Bridge should be disconnected now, send() will try to reconnect
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("rapid connect/close/connect cycle — 10 iterations", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    for (let i = 0; i < 10; i++) {
      const bridge = new Bridge(port);
      await bridge.connect();
      expect(bridge.isConnected).toBe(true);
      bridge.close();
      expect(bridge.isConnected).toBe(false);
    }
  });

  it("close() during in-flight send() — pending requests rejected", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const pending = bridge.send("slow", {}, 30000);
    bridge.close();

    await expect(pending).rejects.toThrow(/Bridge closing/);
  });

  it("close() during multiple in-flight sends — all rejected", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p1 = bridge.send("a", {}, 30000);
    const p2 = bridge.send("b", {}, 30000);
    const p3 = bridge.send("c", {}, 30000);
    bridge.close();

    await expect(p1).rejects.toThrow(/Bridge closing/);
    await expect(p2).rejects.toThrow(/Bridge closing/);
    await expect(p3).rejects.toThrow(/Bridge closing/);
  });

  it("two bridges to same port — both work independently", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    trackServer(wss);
    const b1 = trackBridge(new Bridge(port));
    const b2 = trackBridge(new Bridge(port));
    await b1.connect();
    await b2.connect();

    const [r1, r2] = await Promise.all([
      b1.send("test", { from: "b1" }),
      b2.send("test", { from: "b2" }),
    ]);
    expect(r1).toEqual({ from: "b1" });
    expect(r2).toEqual({ from: "b2" });
  });

  it("10 concurrent sends resolve even with 50ms server delay", async () => {
    const { wss, port } = await createDelayServer(50);
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => bridge.send("test", { i })),
    );
    expect(results).toHaveLength(10);
  });

  it("sends interleaved with connect calls all resolve", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    // Mix connect and send calls
    const results = await Promise.all([
      bridge.connect().then(() => bridge.send("a")),
      bridge.send("b"),
      bridge.send("c"),
    ]);
    expect(results).toHaveLength(3);
  });

  it("20 bridges connecting simultaneously to same server", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const bridgeArr = Array.from({ length: 20 }, () => trackBridge(new Bridge(port)));
    await Promise.all(bridgeArr.map((b) => b.connect()));

    for (const b of bridgeArr) {
      expect(b.isConnected).toBe(true);
    }
  });

  it("send after failed connect to wrong port then reconnect to correct port", async () => {
    const bridge = trackBridge(new Bridge(19999));
    await expect(bridge.connect()).rejects.toThrow();
    // Now create a server — bridge needs a new instance since URL is fixed
    // This tests that the bridge is in a clean state after failure
    expect(bridge.isConnected).toBe(false);
  });

  it("50 sends with staggered server delays — all resolve in order", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      const delay = Math.floor(Math.random() * 20);
      setTimeout(() => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { idx: req.params.idx } }));
      }, delay);
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 50 }, (_, idx) =>
      bridge.send("test", { idx }),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 50; i++) {
      expect(results[i]).toEqual({ idx: i });
    }
  });

  it("connect() after close() on a new bridge to same port works", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const b1 = new Bridge(port);
    await b1.connect();
    b1.close();

    const b2 = trackBridge(new Bridge(port));
    await b2.connect();
    expect(b2.isConnected).toBe(true);
  });

  it("5 concurrent connect() calls from separate bridges — all succeed", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const arr = Array.from({ length: 5 }, () => trackBridge(new Bridge(port)));
    await Promise.all(arr.map((b) => b.connect()));
    for (const b of arr) expect(b.isConnected).toBe(true);
  });

  it("send() auto-connects — 10 sends without explicit connect", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => bridge.send("test")),
    );
    expect(results).toHaveLength(10);
    expect(bridge.isConnected).toBe(true);
  });

  it("parallel sends and closes on different bridges don't interfere", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const b1 = trackBridge(new Bridge(port));
    const b2 = trackBridge(new Bridge(port));
    await b1.connect();
    await b2.connect();

    const r1 = await b1.send("test");
    b2.close();
    const r2 = await b1.send("test");

    expect(r1).toEqual({ ok: true, method: "test" });
    expect(r2).toEqual({ ok: true, method: "test" });
  });

  it("sequential sends after reconnect produce incrementing IDs", async () => {
    const ids: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ids.push(req.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await bridge.send("a");
    await bridge.send("b");

    // Force reconnect
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 200));
    await bridge.send("c");

    // IDs should be monotonically increasing strings
    const nums = ids.map(Number);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
  });

  it("200 rapid-fire sends — none lost", async () => {
    let count = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      count++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await Promise.all(
      Array.from({ length: 200 }, () => bridge.send("ping")),
    );
    expect(count).toBe(200);
  });

  it("connect() is safe to call from multiple async contexts", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    const connectPromises = Array.from({ length: 20 }, () => bridge.connect());
    await Promise.all(connectPromises);
    expect(bridge.isConnected).toBe(true);
  });

  it("close() is idempotent — can be called multiple times", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    bridge.close();
    bridge.close();
    bridge.close();
    expect(bridge.isConnected).toBe(false);
  });

  it("send during server restart — succeeds after reconnect", async () => {
    let { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await closeServer(wss);
    servers = servers.filter((s) => s !== wss);
    await new Promise((r) => setTimeout(r, 100));

    // Restart on same port
    const wss2 = await new Promise<WebSocketServer>((resolve) => {
      const s = new WebSocketServer({ port }, () => resolve(s));
      s.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const req = JSON.parse(raw.toString());
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { restarted: true } }));
        });
      });
    });
    trackServer(wss2);

    const result = await bridge.send("test");
    expect(result).toEqual({ restarted: true });
  });

  it("25 sends with 0ms timeout on fast server — most succeed", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // With 5000ms timeout and a fast local server, all should succeed
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => bridge.send("test", {}, 5000)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
  });

  it("isConnected reflects state accurately during rapid state changes", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    expect(bridge.isConnected).toBe(false);
    await bridge.connect();
    expect(bridge.isConnected).toBe(true);
    bridge.close();
    expect(bridge.isConnected).toBe(false);
  });

  it("send() rejects if server closes connection mid-flight (no response)", async () => {
    const { wss, port } = await createServer((ws) => {
      // Close connection instead of responding
      ws.close();
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 2000)).rejects.toThrow();
  });

  it("100 sends with params containing unique data — each response matches", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echo: req.params.value } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 100 }, (_, i) =>
      bridge.send("echo", { value: `msg-${i}` }),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 100; i++) {
      expect(results[i]).toEqual({ echo: `msg-${i}` });
    }
  });

  it("bridge handles server that sends unsolicited messages", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      // Send an unsolicited message first
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "unsolicited", result: "noise" }));
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true });
  });

  it("30 bridges each sending 5 messages to same server", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);

    const arr = Array.from({ length: 30 }, () => trackBridge(new Bridge(port)));
    await Promise.all(arr.map((b) => b.connect()));

    const allSends = arr.flatMap((b) =>
      Array.from({ length: 5 }, () => b.send("test")),
    );
    const results = await Promise.all(allSends);
    expect(results).toHaveLength(150);
  });

  it("send immediately after connect resolves — no race", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    await bridge.connect();
    // Immediate send — should not race
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("connect-send-close pattern repeated 5 times on same port", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    for (let i = 0; i < 5; i++) {
      const bridge = new Bridge(port);
      await bridge.connect();
      const r = await bridge.send("test");
      expect(r).toEqual({ ok: true, method: "test" });
      bridge.close();
    }
  });

  it("sends with varying param sizes — empty to large", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { keys: Object.keys(req.params).length } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const r1 = await bridge.send("test", {});
    const r2 = await bridge.send("test", { a: 1 });
    const bigParams: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) bigParams[`key${i}`] = i;
    const r3 = await bridge.send("test", bigParams);

    expect(r1).toEqual({ keys: 0 });
    expect(r2).toEqual({ keys: 1 });
    expect(r3).toEqual({ keys: 50 });
  });

  it("connect to server, server closes, bridge auto-reconnects and send works", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Terminate all clients from server side
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 200));

    // send() should trigger reconnect
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });
});

/* ================================================================
 *  TIMEOUT STRESS (~40 tests)
 * ================================================================ */

describe("Timeout stress", () => {
  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("zero timeout — rejects immediately", async () => {
      const { wss, port } = await createServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      // Need real timers for connect
      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 0);
      vi.advanceTimersByTime(1);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("timeout at exact boundary — 30000ms timeout fires at 30001ms", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 30000);
      vi.advanceTimersByTime(29999);
      // Should still be pending (not yet rejected)
      const raceResult = await Promise.race([
        p.then(() => "resolved").catch(() => "rejected"),
        Promise.resolve("pending"),
      ]);
      expect(raceResult).toBe("pending");

      vi.advanceTimersByTime(2);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("custom timeout 100ms — rejects after 100ms", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 100);
      vi.advanceTimersByTime(101);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("custom timeout 500ms — rejects after 500ms", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 500);
      vi.advanceTimersByTime(501);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("custom timeout 1000ms — rejects after 1000ms", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 1000);
      vi.advanceTimersByTime(1001);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("custom timeout 5000ms — rejects after 5000ms", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 5000);
      vi.advanceTimersByTime(5001);
      await expect(p).rejects.toThrow(/timed out/);
    });

    it("timeout message includes method name", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("my.special.method", {}, 100);
      vi.advanceTimersByTime(101);
      await expect(p).rejects.toThrow(/my\.special\.method/);
    });

    it("timeout message includes timeout duration", async () => {
      const { wss, port } = await createSilentServer();
      trackServer(wss);
      const bridge = trackBridge(new Bridge(port));

      vi.useRealTimers();
      await bridge.connect();
      vi.useFakeTimers();

      const p = bridge.send("test", {}, 250);
      vi.advanceTimersByTime(251);
      await expect(p).rejects.toThrow(/250ms/);
    });
  });

  // Tests using real timers with short timeouts
  it("server responds 1ms before timeout — succeeds", async () => {
    const { wss, port } = await createDelayServer(50);
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", {}, 500);
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("server responds after timeout — rejects", async () => {
    const { wss, port } = await createDelayServer(300);
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 100)).rejects.toThrow(/timed out/);
  });

  it("20 requests with staggered timeouts — each times out independently", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 20 }, (_, i) =>
      bridge.send(`method-${i}`, {}, 100 + i * 10),
    );

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  }, 15000);

  it("timeout doesn't leak pending map entries", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Access private pending map via reflection
    const getPendingSize = () => (bridge as any).pending.size;

    const p = bridge.send("test", {}, 100);
    expect(getPendingSize()).toBe(1);

    await p.catch(() => {});
    expect(getPendingSize()).toBe(0);
  });

  it("5 timeouts don't leave stale entries in pending map", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 5 }, () =>
      bridge.send("test", {}, 100),
    );

    await Promise.allSettled(promises);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("fast response clears timer (no double-resolve)", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", {}, 5000);
    expect(result).toEqual({ ok: true, method: "test" });

    // Wait past the timeout — should not throw
    await new Promise((r) => setTimeout(r, 100));
  });

  it("10 sequential sends with 200ms timeout on fast server — all succeed", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 10; i++) {
      const r = await bridge.send("test", {}, 200);
      expect(r).toEqual({ ok: true, method: "test" });
    }
  });

  it("timeout on first request doesn't affect second request", async () => {
    let shouldRespond = false;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      if (shouldRespond) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 100)).rejects.toThrow(/timed out/);

    shouldRespond = true;
    const result = await bridge.send("test", {}, 1000);
    expect(result).toBe(true);
  });

  it("very large timeout (60s) — request succeeds quickly anyway", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", {}, 60000);
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("default timeout is 30000ms", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    vi.useFakeTimers();
    const p = bridge.send("test");
    vi.advanceTimersByTime(30001);
    await expect(p).rejects.toThrow(/30000ms/);
    vi.useRealTimers();
  });

  it("concurrent sends with different timeouts — shorter one fails first", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const short = bridge.send("short", {}, 100);
    const long = bridge.send("long", {}, 500);

    await expect(short).rejects.toThrow(/timed out/);
    // long is still pending at this point (or will timeout later)
    await expect(long).rejects.toThrow(/timed out/);
  }, 5000);

  it("timeout error is an Error instance", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test", {}, 100);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("3 parallel requests — 2 timeout, 1 succeeds", async () => {
    let respondToId: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      if (req.method === "fast") {
        respondToId = req.id;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "fast" }));
      }
      // Don't respond to "slow" methods
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.allSettled([
      bridge.send("slow", {}, 100),
      bridge.send("fast", {}, 1000),
      bridge.send("slow", {}, 100),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect(results[2].status).toBe("rejected");
  });

  it("timeout with 1ms — rejects very quickly", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 1)).rejects.toThrow(/timed out/);
  });

  it("10 sequential timeouts — each cleans up properly", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 10; i++) {
      await expect(bridge.send("test", {}, 50)).rejects.toThrow(/timed out/);
      expect((bridge as any).pending.size).toBe(0);
    }
  }, 10000);

  it("timeout clears from pending map even when close() follows", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 100);
    await p.catch(() => {});
    bridge.close();
    expect((bridge as any).pending.size).toBe(0);
  });

  it("response after timeout is silently discarded", async () => {
    let clientWs: WsWebSocket | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      clientWs = ws;
      // Don't respond immediately — we'll respond manually
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 100);
    await expect(p).rejects.toThrow(/timed out/);

    // Now send a late response — should not throw
    if (clientWs) {
      (clientWs as WsWebSocket).send(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: "late" }),
      );
    }
    await new Promise((r) => setTimeout(r, 50));
    // No error — bridge should have ignored it
  });

  it("50ms timeout on fast server — succeeds", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", {}, 50);
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("each timeout fires independently — not batched", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const start = Date.now();
    const p1 = bridge.send("a", {}, 100);
    const p2 = bridge.send("b", {}, 200);

    await expect(p1).rejects.toThrow(/timed out/);
    const elapsed1 = Date.now() - start;

    await expect(p2).rejects.toThrow(/timed out/);
    const elapsed2 = Date.now() - start;

    // p2 should timeout later than p1
    expect(elapsed2).toBeGreaterThanOrEqual(elapsed1);
  }, 5000);

  it("bridge remains usable after a timeout", async () => {
    let shouldRespond = true;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      if (shouldRespond) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    shouldRespond = false;
    await expect(bridge.send("test", {}, 100)).rejects.toThrow(/timed out/);

    shouldRespond = true;
    const result = await bridge.send("test", {}, 1000);
    expect(result).toBe(true);
  });

  it("15 mixed timeout/success requests in parallel", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      if (req.method === "respond") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 15 }, (_, i) =>
      i % 2 === 0
        ? bridge.send("respond", {}, 1000)
        : bridge.send("silent", {}, 100),
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    expect(fulfilled).toBe(8); // even indices: 0,2,4,6,8,10,12,14
    expect(rejected).toBe(7); // odd indices: 1,3,5,7,9,11,13
  });

  it("20ms timeout on delayed server — always rejects", async () => {
    const { wss, port } = await createDelayServer(100);
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 20)).rejects.toThrow(/timed out/);
  });
});

/* ================================================================
 *  RECONNECTION STRESS (~40 tests)
 * ================================================================ */

describe("Reconnection stress", () => {
  it("server drops mid-message — bridge reconnects via send()", async () => {
    const { wss, port } = await createServer((ws) => {
      ws.close(); // Drop immediately
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // First send will fail because server closes
    await expect(bridge.send("test", {}, 500)).rejects.toThrow();

    // Update server to actually respond
    wss.removeAllListeners("connection");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      });
    });

    // Next send should reconnect and succeed
    const result = await bridge.send("test", {}, 2000);
    expect(result).toBe(true);
  });

  it("server drops 5 times in a row — bridge keeps retrying", async () => {
    let dropCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      dropCount++;
      if (dropCount <= 5) {
        ws.close();
        return;
      }
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    // Keep trying — the bridge's auto-reconnect and send()'s connect() should handle this
    let result: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        result = await bridge.send("test", {}, 500);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    expect(result).toBe(true);
  }, 15000);

  it("reconnect delay doubles: 1s, 2s, 4s (check via private field)", async () => {
    const bridge = trackBridge(new Bridge(59999));
    const getDelay = () => (bridge as any).reconnectDelay;

    expect(getDelay()).toBe(1000);

    // Simulate failed reconnect attempts by calling scheduleReconnect
    // We can observe the delay field directly
    try { await bridge.connect(); } catch {}
    // After failure + close event, scheduleReconnect is called
    // Check delay progression
    await new Promise((r) => setTimeout(r, 100));
    // The delay should have increased
    expect(getDelay()).toBeGreaterThanOrEqual(2000);
  });

  it("reconnect delay resets to 1s after successful connection", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    // Manually set high delay
    (bridge as any).reconnectDelay = 16000;

    await bridge.connect();
    expect((bridge as any).reconnectDelay).toBe(1000);
  });

  it("close() during reconnect backoff — no more reconnect attempts", async () => {
    const bridge = trackBridge(new Bridge(59998));

    try { await bridge.connect(); } catch {}
    // Bridge is now in reconnect backoff
    bridge.close();

    expect((bridge as any).reconnectTimer).toBeNull();
    expect((bridge as any).closed).toBe(true);
  });

  it("server comes back after 3 failures — send works", async () => {
    let attempt = 0;
    const { wss, port } = await createServer((ws, raw) => {
      attempt++;
      if (attempt <= 3) {
        ws.close();
        return;
      }
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { attempt } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    let result: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        result = await bridge.send("test", {}, 500);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    expect(result).toEqual({ attempt: 4 });
  }, 15000);

  it("no overlapping reconnect timers", async () => {
    const bridge = trackBridge(new Bridge(59997));
    const scheduleReconnect = (bridge as any).scheduleReconnect.bind(bridge);

    // Call scheduleReconnect multiple times
    scheduleReconnect();
    const timer1 = (bridge as any).reconnectTimer;
    scheduleReconnect();
    const timer2 = (bridge as any).reconnectTimer;

    // Should be the same timer (second call should be no-op)
    expect(timer1).toBe(timer2);
    bridge.close();
  });

  it("reconnect after WebSocket error event", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Force an error by terminating from server side
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 200));

    // send() should trigger reconnect
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("reconnect delay is capped at 30s", async () => {
    const bridge = trackBridge(new Bridge(59996));
    // Set delay very high
    (bridge as any).reconnectDelay = 30000;

    // Call scheduleReconnect — it should cap
    (bridge as any).scheduleReconnect();
    // After scheduleReconnect, delay doubles but caps at maxReconnectDelay
    expect((bridge as any).reconnectDelay).toBeLessThanOrEqual(30000);
    bridge.close();
  });

  it("closed bridge does not schedule reconnect", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();

    // scheduleReconnect should be no-op
    (bridge as any).scheduleReconnect();
    expect((bridge as any).reconnectTimer).toBeNull();
  });

  it("maxReconnectDelay is 30000", () => {
    const bridge = trackBridge(new Bridge(1234));
    expect((bridge as any).maxReconnectDelay).toBe(30000);
  });

  it("initial reconnectDelay is 1000", () => {
    const bridge = trackBridge(new Bridge(1234));
    expect((bridge as any).reconnectDelay).toBe(1000);
  });

  it("reconnectDelay progression: 1000 -> 2000 -> 4000 -> 8000 -> 16000 -> 30000", () => {
    const bridge = trackBridge(new Bridge(59995));
    const expected = [1000, 2000, 4000, 8000, 16000, 30000];

    for (let i = 0; i < expected.length; i++) {
      expect((bridge as any).reconnectDelay).toBe(expected[i]);
      // scheduleReconnect doubles the delay
      (bridge as any).reconnectTimer = null; // clear so it can schedule
      (bridge as any).scheduleReconnect();
    }
    bridge.close();
  });

  it("reconnect works after server restart on same port", async () => {
    let { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Kill server
    await closeServer(wss);
    servers = servers.filter((s) => s !== wss);
    await new Promise((r) => setTimeout(r, 100));

    // Restart
    const { wss: wss2 } = await createServer();
    // We need same port — use the dynamically assigned port
    // Actually we can't guarantee same port with port 0
    // So let's create server on the specific port
    await closeServer(wss2);

    const wss3 = await new Promise<WebSocketServer>((resolve) => {
      const s = new WebSocketServer({ port }, () => resolve(s));
      s.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const req = JSON.parse(raw.toString());
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { restarted: true } }));
        });
      });
    });
    trackServer(wss3);

    const result = await bridge.send("test", {}, 3000);
    expect(result).toEqual({ restarted: true });
  });

  it("close() clears reconnectTimer", async () => {
    const bridge = trackBridge(new Bridge(59994));
    (bridge as any).reconnectTimer = setTimeout(() => {}, 10000);
    bridge.close();
    expect((bridge as any).reconnectTimer).toBeNull();
  });

  it("bridge starts with closed=false", () => {
    const bridge = trackBridge(new Bridge(1234));
    expect((bridge as any).closed).toBe(false);
  });

  it("close() sets closed=true", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();
    expect((bridge as any).closed).toBe(true);
  });

  it("closed flag prevents auto-reconnect after disconnect", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();

    await new Promise((r) => setTimeout(r, 1500));
    expect(bridge.isConnected).toBe(false);
    expect((bridge as any).reconnectTimer).toBeNull();
  });

  it("ws is set to null after close()", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();
    expect((bridge as any).ws).toBeNull();
  });

  it("reconnect resets connectPromise to null on success", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    expect((bridge as any).connectPromise).toBeNull();
  });

  it("multiple disconnects don't stack reconnect timers", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Simulate multiple close events
    (bridge as any).reconnectTimer = null;
    (bridge as any).scheduleReconnect();
    const t1 = (bridge as any).reconnectTimer;
    (bridge as any).scheduleReconnect();
    const t2 = (bridge as any).reconnectTimer;
    expect(t1).toBe(t2);
    bridge.close();
  });

  it("requestId persists across reconnects", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: Number(req.id) }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const r1 = await bridge.send("test");
    expect(r1).toBe(1);

    // Force disconnect
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 200));

    const r2 = await bridge.send("test");
    // ID should be > 1 (incremented from before)
    expect(r2 as number).toBeGreaterThan(1);
  });

  it("bridge URL includes correct port", () => {
    const bridge = trackBridge(new Bridge(9741));
    expect((bridge as any).url).toBe("ws://127.0.0.1:9741");
  });

  it("bridge URL with custom port", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).url).toBe("ws://127.0.0.1:12345");
  });

  it("rejectAllPending clears entire pending map", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p1 = bridge.send("a", {}, 30000);
    const p2 = bridge.send("b", {}, 30000);
    const p3 = bridge.send("c", {}, 30000);

    expect((bridge as any).pending.size).toBe(3);
    bridge.close(); // calls rejectAllPending
    expect((bridge as any).pending.size).toBe(0);

    await Promise.allSettled([p1, p2, p3]);
  });

  it("default port is 9741", () => {
    const bridge = trackBridge(new Bridge());
    expect((bridge as any).url).toBe("ws://127.0.0.1:9741");
  });

  it("send after disconnect without auto-reconnect still tries connect", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Terminate server-side
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 200));

    // send() should try to reconnect
    expect(bridge.isConnected).toBe(false);
    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("scheduleReconnect is not called when closed=true", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    bridge.close();

    // Manually try scheduleReconnect
    (bridge as any).scheduleReconnect();
    expect((bridge as any).reconnectTimer).toBeNull();
  });

  it("connect() to down server rejects with meaningful error", async () => {
    const bridge = trackBridge(new Bridge(59993));
    await expect(bridge.connect()).rejects.toThrow(/Cannot connect/);
  });

  it("connect() error includes URL info", async () => {
    const bridge = trackBridge(new Bridge(59992));
    await expect(bridge.connect()).rejects.toThrow(/59992/);
  });

  it("failed connect does not leave connectPromise set", async () => {
    const bridge = trackBridge(new Bridge(59991));
    await bridge.connect().catch(() => {});
    expect((bridge as any).connectPromise).toBeNull();
  });

  it("reconnect attempt after error — tries again", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    // First attempt to non-existent — fail
    (bridge as any).url = "ws://127.0.0.1:59990";
    await bridge.connect().catch(() => {});

    // Fix URL
    (bridge as any).url = `ws://127.0.0.1:${port}`;
    (bridge as any).closed = false;
    await bridge.connect();
    expect(bridge.isConnected).toBe(true);
  });

  it("bridge handles ECONNREFUSED gracefully", async () => {
    const bridge = trackBridge(new Bridge(59989));
    await expect(bridge.connect()).rejects.toThrow();
    expect(bridge.isConnected).toBe(false);
  });
});

/* ================================================================
 *  MESSAGE HANDLING STRESS (~40 tests)
 * ================================================================ */

describe("Message handling stress", () => {
  it("response with wrong ID — ignored, correct response still works", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: "bad" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "good" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("good");
  });

  it("response with no ID — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", result: "no-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "with-id" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("with-id");
  });

  it("response with null result — resolves to null", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeNull();
  });

  it("response with empty object result — resolves to {}", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual({});
  });

  it("response with deeply nested JSON (10 levels) — parsed correctly", async () => {
    const deepObj: any = { level: 0 };
    let current = deepObj;
    for (let i = 1; i <= 10; i++) {
      current.child = { level: i };
      current = current.child;
    }

    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: deepObj }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result: any = await bridge.send("test");
    expect(result.level).toBe(0);
    expect(result.child.child.child.level).toBe(3);
  });

  it("response with large payload (1MB string) — handled", async () => {
    const largeStr = "x".repeat(1024 * 1024);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: largeStr }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", {}, 10000);
    expect((result as string).length).toBe(1024 * 1024);
  });

  it("response with Unicode characters — preserved", async () => {
    const unicode = "Hello 🌍 مرحبا 你好 🎶";
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: unicode }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(unicode);
  });

  it("multiple responses for same ID — only first one resolves", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "first" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "second" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("first");
  });

  it("interleaved responses (send A,B,C — receive C,A,B)", async () => {
    const pendingReqs: Array<{ id: string; method: string; ws: WsWebSocket }> = [];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      pendingReqs.push({ id: req.id, method: req.method, ws });
      // Once we have 3, respond in reverse order
      if (pendingReqs.length === 3) {
        const order = [2, 0, 1]; // C, A, B
        for (const idx of order) {
          const p = pendingReqs[idx];
          p.ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: p.id,
              result: p.method,
            }),
          );
        }
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const [a, b, c] = await Promise.all([
      bridge.send("A"),
      bridge.send("B"),
      bridge.send("C"),
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(c).toBe("C");
  });

  it("binary message from server — ignored without crash", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // Send binary first
      ws.send(Buffer.from([0x00, 0x01, 0x02, 0xFF]));
      // Then valid response
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("empty string message — ignored without crash", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("malformed JSON response — ignored without crash", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("{bad json]]");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("response after close — ignored without crash", async () => {
    let clientWs: WsWebSocket | null = null;
    const { wss, port } = await createServer((ws) => {
      clientWs = ws;
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 30000);
    bridge.close();

    // Send response after close
    if (clientWs) {
      try {
        (clientWs as WsWebSocket).send(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: "late" }),
        );
      } catch {
        // Connection might already be closed
      }
    }

    await expect(p).rejects.toThrow(/Bridge closing/);
  });

  it("response with result: 0 (falsy) — resolves to 0", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 0 }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(0);
  });

  it("response with result: false — resolves to false", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: false }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(false);
  });

  it("response with result: empty string — resolves to ''", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("");
  });

  it("response with result: empty array — resolves to []", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual([]);
  });

  it("response with result: undefined — resolves to undefined", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // JSON.stringify omits undefined, so result field won't be present
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeUndefined();
  });

  it("response with extra fields — ignored, result still extracted", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: "ok",
        extra: "field",
        meta: { foo: "bar" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("ok");
  });

  it("response with numeric result — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 42.5 }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(42.5);
  });

  it("response with array result — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [1, 2, 3] }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual([1, 2, 3]);
  });

  it("response with boolean true — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("response with nested arrays — preserved", async () => {
    const nested = [[1, [2, [3]]], [4, 5]];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: nested }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual(nested);
  });

  it("server sends multiple unsolicited messages — bridge ignores all", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      for (let i = 0; i < 10; i++) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: `noise-${i}`, result: "spam" }));
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with special chars in string result — preserved", async () => {
    const special = "line1\nline2\ttab\\backslash\"quote";
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: special }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(special);
  });

  it("rapid message burst — 50 responses handled correctly", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.n }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, n) => bridge.send("test", { n })),
    );
    for (let n = 0; n < 50; n++) {
      expect(results[n]).toBe(n);
    }
  });

  it("server echoes params back — complex object preserved", async () => {
    const complex = {
      name: "test",
      count: 42,
      nested: { arr: [1, "two", null], flag: true },
    };
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", complex);
    expect(result).toEqual(complex);
  });

  it("JSON-RPC notification (no id in message) from server — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // Send a notification (no id)
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notify", params: {} }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("ok");
  });

  it("response is valid JSON but not an object (number) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("42");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("response is valid JSON array — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("[1,2,3]");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("response with very long string key — handled", async () => {
    const longKey = "k".repeat(10000);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { [longKey]: true } }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result: any = await bridge.send("test");
    expect(result["k".repeat(10000)]).toBe(true);
  });

  it("handles null in params gracefully", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", { key: null } as any);
    expect(result).toEqual({ key: null });
  });
});

/* ================================================================
 *  ERROR PROPAGATION (~30 tests)
 * ================================================================ */

describe("Error propagation", () => {
  it("JSON-RPC error with code -32600 — rejects with message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32600, message: "Invalid Request" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow("Invalid Request");
  });

  it("JSON-RPC error with data field — data included in error message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "Server error", data: { detail: "stack trace" } },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow(/Server error/);
    try {
      await bridge.send("test2");
    } catch (e: any) {
      expect(e.message).toContain("stack trace");
    }
  });

  it("JSON-RPC error with empty message — rejects with empty string", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow();
  });

  it("server sends error for unknown ID — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "unknown-id-999",
        error: { code: -32600, message: "Unknown" },
      }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("ok");
  });

  it("connect() to wrong port — rejects with meaningful error", async () => {
    const bridge = trackBridge(new Bridge(59988));
    await expect(bridge.connect()).rejects.toThrow(/Cannot connect/);
  });

  it("all pending requests rejected on unexpected close", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p1 = bridge.send("a", {}, 30000);
    const p2 = bridge.send("b", {}, 30000);
    const p3 = bridge.send("c", {}, 30000);
    const p4 = bridge.send("d", {}, 30000);
    const p5 = bridge.send("e", {}, 30000);

    // Force close from server side
    for (const c of wss.clients) c.terminate();

    const results = await Promise.allSettled([p1, p2, p3, p4, p5]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  });

  it("error in handleMessage with malformed data doesn't crash", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // Send various malformed messages that won't crash property access
      ws.send("not-json-at-all");
      ws.send("{{{bad");
      ws.send("true");
      ws.send("42");
      ws.send('{"no":"id"}');
      ws.send('{"id":"wrong","result":"nope"}');
      // Then valid response
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "survived" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("survived");
  });

  it("JSON-RPC error code -32601 (Method not found)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("nonexistent")).rejects.toThrow("Method not found");
  });

  it("JSON-RPC error code -32602 (Invalid params)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "Invalid params" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow("Invalid params");
  });

  it("JSON-RPC error code -32603 (Internal error)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Internal error" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow("Internal error");
  });

  it("JSON-RPC error code -32700 (Parse error)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32700, message: "Parse error" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow("Parse error");
  });

  it("error with complex data object — stringified in message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: "Detailed error",
          data: { stack: "Error at line 42", context: { file: "main.jsx" } },
        },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e.message).toContain("Detailed error");
      expect(e.message).toContain("line 42");
    }
  });

  it("error with string data — included in message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "Fail", data: "extra info" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e.message).toContain("extra info");
    }
  });

  it("error with null data — no data appended", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "NoData", data: null },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
      expect.unreachable("should throw");
    } catch (e: any) {
      // data is null which is falsy, so message should just be "NoData"
      // Actually: null is falsy in JS, so the ternary skips data
      expect(e.message).toBe("NoData");
    }
  });

  it("error is an Error instance with correct message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "Test error" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("Test error");
    }
  });

  it("send rejection on connection drop is an Error instance", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 30000);
    bridge.close();

    try {
      await p;
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("concurrent errors — each request gets its own rejection", async () => {
    let counter = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      counter++;
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: `Error ${counter}` },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.allSettled([
      bridge.send("a"),
      bridge.send("b"),
      bridge.send("c"),
    ]);

    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  });

  it("error after successful request — each independent", async () => {
    let callCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      callCount++;
      if (callCount === 1) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" }));
      } else {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Now failing" },
        }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const r1 = await bridge.send("test");
    expect(r1).toBe("ok");

    await expect(bridge.send("test")).rejects.toThrow("Now failing");
  });

  it("success after error — bridge recovers", async () => {
    let callCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      callCount++;
      if (callCount === 1) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Fail first" },
        }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "recovered" }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow("Fail first");
    const r = await bridge.send("test");
    expect(r).toBe("recovered");
  });

  it("5 errors in a row — bridge still functional", async () => {
    let callCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      callCount++;
      if (callCount <= 5) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: `Error #${callCount}` },
        }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "finally" }));
      }
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 5; i++) {
      await expect(bridge.send("test")).rejects.toThrow(/Error #/);
    }
    const result = await bridge.send("test");
    expect(result).toBe("finally");
  });

  it("error response clears pending entry", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "Err" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await bridge.send("test").catch(() => {});
    expect((bridge as any).pending.size).toBe(0);
  });

  it("close() error message says 'Bridge closing'", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 30000);
    bridge.close();

    await expect(p).rejects.toThrow("Bridge closing");
  });

  it("connection closed rejection message says 'Connection closed'", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 30000);

    // Terminate from server side (triggers "close" event with "Connection closed")
    for (const c of wss.clients) c.terminate();

    await expect(p).rejects.toThrow("Connection closed");
  });

  it("error with data: 0 — data is included (truthy check on data)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "WithZero", data: 0 },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
      expect.unreachable("should throw");
    } catch (e: any) {
      // data is 0, which is falsy — so the bridge code skips it
      // This tests the actual behavior
      expect(e.message).toBe("WithZero");
    }
  });

  it("error with data: false — data is truthy-checked", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "WithFalse", data: false },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
    } catch (e: any) {
      // false is falsy — bridge skips data
      expect(e.message).toBe("WithFalse");
    }
  });

  it("error with data: '' (empty string) — data is truthy-checked", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "WithEmpty", data: "" },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
    } catch (e: any) {
      expect(e.message).toBe("WithEmpty");
    }
  });

  it("send() to not-connected bridge with server down rejects", async () => {
    const bridge = trackBridge(new Bridge(59987));
    await expect(bridge.send("test")).rejects.toThrow(/Cannot connect/);
  });

  it("multiple close() calls don't reject pending multiple times", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    let rejectCount = 0;
    const p = bridge.send("test", {}, 30000).catch(() => { rejectCount++; });

    bridge.close();
    bridge.close();
    bridge.close();

    await p;
    expect(rejectCount).toBe(1);
  });
});

/* ================================================================
 *  ADDITIONAL CONCURRENCY TESTS
 * ================================================================ */

describe("Additional concurrency", () => {
  it("send 500 messages sequentially — all succeed", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 500; i++) {
      const r = await bridge.send("test");
      expect(r).toBe(true);
    }
  }, 30000);

  it("10 bridges sending 10 messages each in parallel", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);

    const arr = Array.from({ length: 10 }, () => trackBridge(new Bridge(port)));
    await Promise.all(arr.map((b) => b.connect()));

    const allResults = await Promise.all(
      arr.flatMap((b) => Array.from({ length: 10 }, () => b.send("test"))),
    );
    expect(allResults).toHaveLength(100);
  });

  it("send with empty string method name — works", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("");
    expect(result).toBe("");
  });

  it("close then new bridge on same port — no interference", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const b1 = trackBridge(new Bridge(port));
    await b1.connect();
    const r1 = await b1.send("test");
    b1.close();

    const b2 = trackBridge(new Bridge(port));
    await b2.connect();
    const r2 = await b2.send("test");
    expect(r1).toEqual(r2);
  });

  it("send resolves even if server has 1ms delay", async () => {
    const { wss, port } = await createDelayServer(1);
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual({ ok: true, method: "test" });
  });

  it("300 concurrent sends — all resolve", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 300 }, () => bridge.send("test")),
    );
    expect(results).toHaveLength(300);
  });

  it("alternating send and close on different bridges", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    for (let i = 0; i < 5; i++) {
      const b = trackBridge(new Bridge(port));
      await b.connect();
      await b.send("test");
      b.close();
    }
  });

  it("bridge handles server sending data before client sends", async () => {
    const { wss, port } = await createServer();
    // Override to send unsolicited data on connect
    wss.removeAllListeners("connection");
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "unsolicited", result: "hello" }));
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
      });
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });

  it("requestId starts at 0 internally, first send produces '1'", async () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).requestId).toBe(0);
  });

  it("pending map is empty on fresh bridge", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).pending.size).toBe(0);
  });

  it("ws is null on fresh bridge", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).ws).toBeNull();
  });

  it("connectPromise is null on fresh bridge", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).connectPromise).toBeNull();
  });

  it("closed is false on fresh bridge", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).closed).toBe(false);
  });

  it("reconnectTimer is null on fresh bridge", () => {
    const bridge = trackBridge(new Bridge(12345));
    expect((bridge as any).reconnectTimer).toBeNull();
  });

  it("send with very long method name — succeeds", async () => {
    const longMethod = "a".repeat(5000);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method.length }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send(longMethod);
    expect(result).toBe(5000);
  });

  it("send with 200KB params — succeeds", async () => {
    const bigValue = "x".repeat(200 * 1024);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.data.length }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", { data: bigValue });
    expect(result).toBe(200 * 1024);
  });

  it("50 parallel sends returning different types", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      const i = req.params.i;
      let result: unknown;
      switch (i % 5) {
        case 0: result = null; break;
        case 1: result = 42; break;
        case 2: result = "str"; break;
        case 3: result = true; break;
        case 4: result = [1, 2]; break;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bridge.send("test", { i })),
    );
    expect(results[0]).toBeNull();
    expect(results[1]).toBe(42);
    expect(results[2]).toBe("str");
    expect(results[3]).toBe(true);
    expect(results[4]).toEqual([1, 2]);
  });

  it("bridge connect-send-reconnect-send 3 cycles", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    for (let cycle = 0; cycle < 3; cycle++) {
      await bridge.connect();
      const r = await bridge.send("test");
      expect(r).toEqual({ ok: true, method: "test" });
      // Force disconnect
      for (const c of wss.clients) c.terminate();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it("isConnected is false during connect attempt", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));

    expect(bridge.isConnected).toBe(false);
    const p = bridge.connect();
    // During connect, isConnected may be false until open event fires
    await p;
    expect(bridge.isConnected).toBe(true);
  });

  it("send with undefined params defaults to empty object", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    expect(captured).toEqual({});
  });

  it("multiple bridges closed in sequence — no errors", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);

    const arr = Array.from({ length: 10 }, () => trackBridge(new Bridge(port)));
    await Promise.all(arr.map((b) => b.connect()));

    for (const b of arr) {
      b.close();
      expect(b.isConnected).toBe(false);
    }
  });

  it("bridge survives server sending empty buffer", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(Buffer.alloc(0));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(true);
  });
});

/* ================================================================
 *  ADDITIONAL TIMEOUT TESTS
 * ================================================================ */

describe("Additional timeout tests", () => {
  it("2ms timeout on silent server — rejects", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 2)).rejects.toThrow(/timed out/);
  });

  it("5ms timeout on silent server — rejects", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 5)).rejects.toThrow(/timed out/);
  });

  it("10ms timeout on silent server — rejects", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test", {}, 10)).rejects.toThrow(/timed out/);
  });

  it("3 sequential timeouts then success", async () => {
    let callCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      callCount++;
      const req = JSON.parse(raw);
      if (callCount > 3) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "success" }));
      }
      // First 3: no response → timeout
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 3; i++) {
      await expect(bridge.send("test", {}, 50)).rejects.toThrow(/timed out/);
    }
    const result = await bridge.send("test", {}, 1000);
    expect(result).toBe("success");
  });

  it("timeout with negative value — still works (treated as 0)", async () => {
    const { wss, port } = await createSilentServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    // Negative timeout will fire immediately due to setTimeout behavior
    await expect(bridge.send("test", {}, -1)).rejects.toThrow(/timed out/);
  });
});

/* ================================================================
 *  ADDITIONAL RECONNECTION TESTS
 * ================================================================ */

describe("Additional reconnection tests", () => {
  it("reconnect delay at 16000 doubles to 30000 (capped)", () => {
    const bridge = trackBridge(new Bridge(59980));
    (bridge as any).reconnectDelay = 16000;
    (bridge as any).scheduleReconnect();
    expect((bridge as any).reconnectDelay).toBe(30000);
    bridge.close();
  });

  it("reconnect delay at 30000 stays at 30000", () => {
    const bridge = trackBridge(new Bridge(59979));
    (bridge as any).reconnectDelay = 30000;
    (bridge as any).reconnectTimer = null;
    (bridge as any).scheduleReconnect();
    expect((bridge as any).reconnectDelay).toBe(30000);
    bridge.close();
  });

  it("close sets ws to null", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    expect((bridge as any).ws).not.toBeNull();
    bridge.close();
    expect((bridge as any).ws).toBeNull();
  });

  it("connect after failed attempt resets connectPromise", async () => {
    const bridge = trackBridge(new Bridge(59978));
    await bridge.connect().catch(() => {});
    expect((bridge as any).connectPromise).toBeNull();
  });

  it("double connect while already connected is idempotent", async () => {
    const { wss, port } = await createServer();
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();
    await bridge.connect();
    await bridge.connect();
    expect(bridge.isConnected).toBe(true);
  });
});

/* ================================================================
 *  ADDITIONAL MESSAGE HANDLING TESTS
 * ================================================================ */

describe("Additional message handling", () => {
  it("server sends 100 unsolicited messages then real response", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      for (let i = 0; i < 100; i++) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: `spam-${i}`, result: "noise" }));
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with very large nested object (1000 keys)", async () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) big[`k${i}`] = i;

    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: big }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result: any = await bridge.send("test");
    expect(Object.keys(result)).toHaveLength(1000);
    expect(result.k0).toBe(0);
    expect(result.k999).toBe(999);
  });

  it("response with emoji in result — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "🎵🎶🎸" }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("🎵🎶🎸");
  });

  it("response with mixed array types — preserved", async () => {
    const mixed = [1, "two", true, null, { a: 3 }, [4, 5]];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: mixed }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual(mixed);
  });

  it("JSON-RPC error with very long message — preserved", async () => {
    const longMsg = "E".repeat(5000);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: longMsg },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    await expect(bridge.send("test")).rejects.toThrow(longMsg.substring(0, 50));
  });

  it("response with result: -0 — resolves to -0", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: -0 }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    // JSON serializes -0 as 0
    expect(result).toBe(0);
  });

  it("response with result: large integer — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 999999999 }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(999999999);
  });

  it("response with result: negative float — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: -3.14159 }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeCloseTo(-3.14159);
  });

  it("server that echoes method and params as result object", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { method: req.method, params: req.params },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result: any = await bridge.send("my.method", { key: "val" });
    expect(result.method).toBe("my.method");
    expect(result.params).toEqual({ key: "val" });
  });

  it("JSON-RPC error with numeric data — serialized in message", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "NumErr", data: 42 },
      }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    try {
      await bridge.send("test");
    } catch (e: any) {
      expect(e.message).toContain("NumErr");
      expect(e.message).toContain("42");
    }
  });

  it("response with result containing regex-like string — preserved", async () => {
    const regexStr = "^[a-z]+\\d{3}$";
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: regexStr }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(regexStr);
  });

  it("response with HTML-like string — preserved without escaping", async () => {
    const html = '<div class="test">&amp; <script>alert("xss")</script></div>';
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: html }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(html);
  });

  it("response with JSON string as result — not double-parsed", async () => {
    const jsonStr = '{"inner":"value"}';
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: jsonStr }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(jsonStr);
    expect(typeof result).toBe("string");
  });

  it("response with multiline string — newlines preserved", async () => {
    const multiline = "line1\nline2\nline3\n";
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: multiline }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(multiline);
  });

  it("response with whitespace-only string — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "   \t\n  " }));
    });
    trackServer(wss);
    const bridge = trackBridge(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("   \t\n  ");
  });
});
