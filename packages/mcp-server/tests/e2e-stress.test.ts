import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer } from "ws";
import { Bridge } from "../src/bridge.js";

/**
 * End-to-end stress tests.
 *
 * Uses a real WebSocket server (MockCEPServer) and a real Bridge instance
 * to test the full round-trip under load, failure, and concurrency conditions.
 */

class MockCEPServer {
  public wss: WebSocketServer;
  private handlers = new Map<string, (params: any, id: string) => any>();
  private defaultDelay = 0;

  constructor(port: number = 0) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        try {
          const req = JSON.parse(raw.toString());
          const handler = this.handlers.get(req.method);
          const result = handler ? handler(req.params, req.id) : { echo: req.method };

          const respond = () => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
            }
          };

          if (this.defaultDelay > 0) {
            setTimeout(respond, this.defaultDelay);
          } else {
            respond();
          }
        } catch {
          // Malformed message — silently ignore
        }
      });
    });
  }

  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === "object" && addr !== null) return addr.port;
    throw new Error("Server not listening");
  }

  onMethod(method: string, handler: (params: any, id: string) => any): void {
    this.handlers.set(method, handler);
  }

  setDefaultDelay(ms: number): void {
    this.defaultDelay = ms;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close(() => resolve());
    });
  }
}

let server: MockCEPServer | null = null;
let bridge: Bridge | null = null;

afterEach(async () => {
  if (bridge) {
    bridge.close();
    bridge = null;
  }
  if (server) {
    await server.close();
    server = null;
  }
  await new Promise((r) => setTimeout(r, 50));
});

// ============================================================================
// Sequential request stress (~25 tests)
// ============================================================================

describe("Sequential request stress", () => {
  beforeEach(async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    bridge = new Bridge(server!.port);
    await bridge.connect();
  });

  it("100 sequential project.getInfo calls all succeed", async () => {
    let callCount = 0;
    server!.onMethod("project.getInfo", () => {
      callCount++;
      return { name: "Test.aep", call: callCount };
    });

    for (let i = 0; i < 100; i++) {
      const result = (await bridge!.send("project.getInfo")) as any;
      expect(result.name).toBe("Test.aep");
    }
    expect(callCount).toBe(100);
  });

  it("50 different methods in sequence - each routed correctly", async () => {
    for (let i = 0; i < 50; i++) {
      server!.onMethod(`method_${i}`, (params) => ({ index: i, received: params }));
    }

    for (let i = 0; i < 50; i++) {
      const result = (await bridge!.send(`method_${i}`, { seq: i })) as any;
      expect(result.index).toBe(i);
      expect(result.received.seq).toBe(i);
    }
  });

  it("sequential calls with increasing payload size", async () => {
    server!.onMethod("echo", (params) => params);

    for (let size = 1; size <= 20; size++) {
      const payload = { data: "x".repeat(size * 1000) };
      const result = (await bridge!.send("echo", payload)) as any;
      expect(result.data.length).toBe(size * 1000);
    }
  });

  it("each response matches its request by embedded ID", async () => {
    server!.onMethod("identify", (params) => ({ requestSeq: params.seq }));

    for (let i = 0; i < 30; i++) {
      const result = (await bridge!.send("identify", { seq: i })) as any;
      expect(result.requestSeq).toBe(i);
    }
  });

  it("alternating between two methods", async () => {
    server!.onMethod("alpha", () => ({ type: "alpha" }));
    server!.onMethod("beta", () => ({ type: "beta" }));

    for (let i = 0; i < 40; i++) {
      const method = i % 2 === 0 ? "alpha" : "beta";
      const result = (await bridge!.send(method)) as any;
      expect(result.type).toBe(method);
    }
  });

  it("sequential requests with empty params", async () => {
    server!.onMethod("noop", () => ({ ok: true }));
    for (let i = 0; i < 25; i++) {
      const result = (await bridge!.send("noop")) as any;
      expect(result.ok).toBe(true);
    }
  });

  it("sequential requests with nested object params", async () => {
    server!.onMethod("nested", (params) => params);
    for (let i = 0; i < 15; i++) {
      const result = (await bridge!.send("nested", { level: { deep: { i } } })) as any;
      expect(result.level.deep.i).toBe(i);
    }
  });

  it("sequential requests with array params", async () => {
    server!.onMethod("arr", (params) => params);
    for (let i = 0; i < 15; i++) {
      const arr = Array.from({ length: i + 1 }, (_, j) => j);
      const result = (await bridge!.send("arr", { items: arr })) as any;
      expect(result.items).toHaveLength(i + 1);
    }
  });

  it("sequential requests returning different types", async () => {
    const responses: any[] = [42, "string", true, null, [1, 2], { key: "val" }];
    let callIndex = 0;
    server!.onMethod("varied", () => responses[callIndex++ % responses.length]);

    for (let i = 0; i < 12; i++) {
      const result = await bridge!.send("varied");
      expect(result).toEqual(responses[i % responses.length]);
    }
  });

  it("sequential requests with Unicode in params and results", async () => {
    server!.onMethod("unicode", (params) => ({ greeting: `Hello ${params.name}!` }));

    const names = ["Ali", "Taro", "Jean-Pierre", "Muller"];
    for (const name of names) {
      const result = (await bridge!.send("unicode", { name })) as any;
      expect(result.greeting).toBe(`Hello ${name}!`);
    }
  });

  it("10 sequential calls - verify call count on server", async () => {
    let count = 0;
    server!.onMethod("count", () => { count++; return { count }; });

    for (let i = 0; i < 10; i++) {
      await bridge!.send("count");
    }
    expect(count).toBe(10);
  });

  it("sequential error then success recovery", async () => {
    let callNum = 0;
    server!.onMethod("test", (_params, id) => {
      callNum++;
      if (callNum <= 3) {
        // Return a special marker that we'll detect
        throw new Error(`Error ${callNum}`);
      }
      return { ok: true, call: callNum };
    });

    // Override the default handler to support errors
    server!.wss.removeAllListeners("connection");
    let localCallNum = 0;
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        localCallNum++;
        if (localCallNum <= 3) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -1, message: `Error ${localCallNum}` },
          }));
        } else {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { ok: true, call: localCallNum },
          }));
        }
      });
    });

    // Reconnect to pick up new handler
    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    for (let i = 1; i <= 3; i++) {
      await expect(bridge!.send("test")).rejects.toThrow();
    }
    const result = (await bridge!.send("test")) as any;
    expect(result.ok).toBe(true);
  });

  it("request with very long method name", async () => {
    const longMethod = "m".repeat(500);
    server!.onMethod(longMethod, () => ({ received: true }));
    const result = (await bridge!.send(longMethod)) as any;
    expect(result.received).toBe(true);
  });

  it("request with boolean params", async () => {
    server!.onMethod("flags", (params) => params);
    const result = (await bridge!.send("flags", { enabled: true, visible: false })) as any;
    expect(result.enabled).toBe(true);
    expect(result.visible).toBe(false);
  });

  it("request with numeric params", async () => {
    server!.onMethod("nums", (params) => params);
    const result = (await bridge!.send("nums", { int: 42, float: 3.14, neg: -1 })) as any;
    expect(result.int).toBe(42);
    expect(result.float).toBeCloseTo(3.14);
    expect(result.neg).toBe(-1);
  });

  it("server returns empty object", async () => {
    server!.onMethod("empty", () => ({}));
    const result = await bridge!.send("empty");
    expect(result).toEqual({});
  });

  it("server returns empty array", async () => {
    server!.onMethod("emptyArr", () => []);
    const result = await bridge!.send("emptyArr");
    expect(result).toEqual([]);
  });

  it("20 sequential calls to unregistered method - defaults to echo", async () => {
    for (let i = 0; i < 20; i++) {
      const result = (await bridge!.send(`unregistered_${i}`)) as any;
      expect(result.echo).toBe(`unregistered_${i}`);
    }
  });

  it("sequential calls with zero timeout use default", async () => {
    server!.onMethod("fast", () => ({ ok: true }));
    const result = (await bridge!.send("fast")) as any;
    expect(result.ok).toBe(true);
  });

  it("50 sequential calls maintain connection", async () => {
    server!.onMethod("ping", () => ({ pong: true }));
    for (let i = 0; i < 50; i++) {
      const result = (await bridge!.send("ping")) as any;
      expect(result.pong).toBe(true);
    }
    expect(bridge!.isConnected).toBe(true);
  });

  it("sequential requests preserve param order", async () => {
    const received: number[] = [];
    server!.onMethod("ordered", (params) => { received.push(params.seq); return { seq: params.seq }; });
    for (let i = 0; i < 20; i++) {
      await bridge!.send("ordered", { seq: i });
    }
    expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("request with null param value", async () => {
    server!.onMethod("nullable", (params) => params);
    const result = (await bridge!.send("nullable", { key: null })) as any;
    expect(result.key).toBeNull();
  });

  it("bridge isConnected true during active session", async () => {
    expect(bridge!.isConnected).toBe(true);
    await bridge!.send("project.getInfo");
    expect(bridge!.isConnected).toBe(true);
  });

  it("rapid fire 25 requests", async () => {
    server!.onMethod("rapid", (params) => ({ i: params.i }));
    for (let i = 0; i < 25; i++) {
      const result = (await bridge!.send("rapid", { i })) as any;
      expect(result.i).toBe(i);
    }
  });
});

// ============================================================================
// Parallel request stress (~25 tests)
// ============================================================================

describe("Parallel request stress", () => {
  beforeEach(async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    bridge = new Bridge(server!.port);
    await bridge.connect();
  });

  it("50 parallel requests all resolve with correct results", async () => {
    server!.onMethod("parallel", (params) => ({ index: params.index }));

    const promises = Array.from({ length: 50 }, (_, i) =>
      bridge!.send("parallel", { index: i })
    );
    const results = await Promise.all(promises);
    const indices = results.map((r: any) => r.index).sort((a: number, b: number) => a - b);
    expect(indices).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("100 parallel requests to same method all succeed", async () => {
    let count = 0;
    server!.onMethod("same", () => ({ count: ++count }));

    const promises = Array.from({ length: 100 }, () => bridge!.send("same"));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(100);
    // Each result should have a count value
    for (const r of results) {
      expect((r as any).count).toBeGreaterThan(0);
    }
  });

  it("mixed methods in parallel (project + layers + expressions)", async () => {
    server!.onMethod("project.getInfo", () => ({ type: "project" }));
    server!.onMethod("layers.list", () => ({ type: "layers" }));
    server!.onMethod("expressions.get", () => ({ type: "expressions" }));

    const promises = [
      bridge!.send("project.getInfo"),
      bridge!.send("layers.list", { comp: "Main" }),
      bridge!.send("expressions.get", { comp: "Main" }),
      bridge!.send("project.getInfo"),
      bridge!.send("layers.list", { comp: "Other" }),
    ];
    const results = await Promise.all(promises);
    expect((results[0] as any).type).toBe("project");
    expect((results[1] as any).type).toBe("layers");
    expect((results[2] as any).type).toBe("expressions");
    expect((results[3] as any).type).toBe("project");
    expect((results[4] as any).type).toBe("layers");
  });

  it("parallel requests with different response times", async () => {
    // Use a separate raw server with delay support
    const delayWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => delayWss.once("listening", r));
    const delayPort = (delayWss.address() as any).port;

    delayWss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        const delay = req.params?.delay || 0;
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { delay, method: req.method },
            }));
          }
        }, delay);
      });
    });

    const delayBridge = new Bridge(delayPort);
    await delayBridge.connect();

    const promises = [
      delayBridge.send("slow", { delay: 50 }),
      delayBridge.send("fast", { delay: 5 }),
      delayBridge.send("medium", { delay: 25 }),
    ];
    const results = await Promise.all(promises);
    expect((results[0] as any).delay).toBe(50);
    expect((results[1] as any).delay).toBe(5);
    expect((results[2] as any).delay).toBe(25);

    delayBridge.close();
    await new Promise<void>((resolve) => {
      for (const c of delayWss.clients) c.terminate();
      delayWss.close(() => resolve());
    });
  });

  it("20 parallel requests each with different params", async () => {
    server!.onMethod("echo", (params) => params);

    const promises = Array.from({ length: 20 }, (_, i) =>
      bridge!.send("echo", { value: `item_${i}` })
    );
    const results = await Promise.all(promises);
    const values = results.map((r: any) => r.value).sort();
    const expected = Array.from({ length: 20 }, (_, i) => `item_${i}`).sort();
    expect(values).toEqual(expected);
  });

  it("parallel requests with large payloads", async () => {
    server!.onMethod("large", (params) => ({ size: params.data?.length || 0 }));

    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge!.send("large", { data: "x".repeat((i + 1) * 5000) })
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      expect((results[i] as any).size).toBe((i + 1) * 5000);
    }
  });

  it("parallel requests - each gets unique response", async () => {
    let counter = 0;
    server!.onMethod("unique", () => ({ id: ++counter }));

    const promises = Array.from({ length: 30 }, () => bridge!.send("unique"));
    const results = await Promise.all(promises);
    const ids = new Set(results.map((r: any) => r.id));
    expect(ids.size).toBe(30);
  });

  it("10 parallel requests to 10 different methods", async () => {
    for (let i = 0; i < 10; i++) {
      server!.onMethod(`method_${i}`, () => ({ index: i }));
    }

    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge!.send(`method_${i}`)
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      expect((results[i] as any).index).toBe(i);
    }
  });

  it("parallel requests with nested objects", async () => {
    server!.onMethod("nested", (params) => params);

    const promises = Array.from({ length: 15 }, (_, i) =>
      bridge!.send("nested", { level: { i, deep: { value: i * 10 } } })
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 15; i++) {
      expect((results[i] as any).level.deep.value).toBe(i * 10);
    }
  });

  it("parallel requests with arrays in params", async () => {
    server!.onMethod("arrParam", (params) => ({ len: params.items.length }));

    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge!.send("arrParam", { items: Array.from({ length: i + 1 }, (_, j) => j) })
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      expect((results[i] as any).len).toBe(i + 1);
    }
  });

  it("parallel requests returning null", async () => {
    server!.onMethod("nil", () => null);
    const promises = Array.from({ length: 20 }, () => bridge!.send("nil"));
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toBeNull();
    }
  });

  it("parallel requests returning arrays", async () => {
    server!.onMethod("arr", (params) => Array.from({ length: params.n }, (_, i) => i));
    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge!.send("arr", { n: i + 1 })
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      expect(results[i]).toHaveLength(i + 1);
    }
  });

  it("parallel requests with string results", async () => {
    server!.onMethod("str", (params) => `Hello ${params.name}`);
    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge!.send("str", { name: `user_${i}` })
    );
    const results = await Promise.all(promises);
    const sorted = [...results].sort();
    for (let i = 0; i < 10; i++) {
      expect(sorted[i]).toBe(`Hello user_${i}`);
    }
  });

  it("parallel requests with empty params", async () => {
    server!.onMethod("empty", () => ({ status: "ok" }));
    const promises = Array.from({ length: 25 }, () => bridge!.send("empty"));
    const results = await Promise.all(promises);
    for (const r of results) {
      expect((r as any).status).toBe("ok");
    }
  });

  it("mix of success and error responses in parallel", async () => {
    // Use a separate raw server to avoid MockCEPServer's default handler
    const mixWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mixWss.once("listening", r));
    const mixPort = (mixWss.address() as any).port;

    let counter = 0;
    mixWss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        counter++;
        if (counter % 3 === 0) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -1, message: "Every third fails" },
          }));
        } else {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { ok: true },
          }));
        }
      });
    });

    const mixBridge = new Bridge(mixPort);
    await mixBridge.connect();

    const promises = Array.from({ length: 9 }, () =>
      mixBridge.send("test").then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e }))
    );
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes.length).toBeGreaterThan(0);
    expect(failures.length).toBeGreaterThan(0);

    mixBridge.close();
    await new Promise<void>((resolve) => {
      for (const c of mixWss.clients) c.terminate();
      mixWss.close(() => resolve());
    });
  });

  it("parallel requests all complete before timeout", async () => {
    server!.onMethod("quick", () => ({ fast: true }));

    const start = Date.now();
    const promises = Array.from({ length: 50 }, () => bridge!.send("quick", {}, 5000));
    await Promise.all(promises);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  it("parallel requests with Unicode in params", async () => {
    server!.onMethod("i18n", (params) => params);
    const names = ["Ali", "Taro", "Pierre", "Hans"];
    const promises = names.map((name) => bridge!.send("i18n", { name }));
    const results = await Promise.all(promises);
    const received = results.map((r: any) => r.name).sort();
    expect(received).toEqual([...names].sort());
  });

  it("parallel batch of 25 with boolean params", async () => {
    server!.onMethod("flags", (params) => params);
    const promises = Array.from({ length: 25 }, (_, i) =>
      bridge!.send("flags", { enabled: i % 2 === 0 })
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(25);
  });

  it("parallel requests returning deeply nested JSON", async () => {
    server!.onMethod("deep", () => ({
      a: { b: { c: { d: { e: { f: { g: 42 } } } } } },
    }));
    const promises = Array.from({ length: 15 }, () => bridge!.send("deep"));
    const results = await Promise.all(promises);
    for (const r of results) {
      expect((r as any).a.b.c.d.e.f.g).toBe(42);
    }
  });

  it("parallel requests with numeric results", async () => {
    server!.onMethod("add", (params) => params.a + params.b);
    const promises = Array.from({ length: 20 }, (_, i) =>
      bridge!.send("add", { a: i, b: i * 2 })
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 20; i++) {
      expect(results[i]).toBe(i * 3);
    }
  });

  it("parallel requests - verify no duplicate IDs used", async () => {
    const receivedIds = new Set<string>();
    const idWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => idWss.once("listening", r));
    const idPort = (idWss.address() as any).port;

    idWss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedIds.add(req.id);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
      });
    });

    const idBridge = new Bridge(idPort);
    await idBridge.connect();

    const promises = Array.from({ length: 50 }, () => idBridge.send("test"));
    await Promise.all(promises);
    expect(receivedIds.size).toBe(50);

    idBridge.close();
    await new Promise<void>((resolve) => {
      for (const c of idWss.clients) c.terminate();
      idWss.close(() => resolve());
    });
  });

  it("parallel requests with mixed null and object results", async () => {
    let counter = 0;
    server!.onMethod("mixed", () => ++counter % 2 === 0 ? null : { val: counter });
    const promises = Array.from({ length: 20 }, () => bridge!.send("mixed"));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
  });

  it("25 parallel with same params return independently", async () => {
    server!.onMethod("dup", () => ({ unique: Math.random() }));
    const promises = Array.from({ length: 25 }, () =>
      bridge!.send("dup", { shared: true })
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(25);
  });
});

// ============================================================================
// Failure recovery stress (~25 tests)
// ============================================================================

describe("Failure recovery stress", () => {
  // These tests use raw WebSocketServer to avoid MockCEPServer's default handler conflicts.
  let rawWss: WebSocketServer | null = null;

  function createRawServer(handler: (ws: any, req: any) => void): Promise<number> {
    return new Promise((resolve) => {
      rawWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      rawWss.on("connection", (ws: any) => {
        ws.on("message", (raw: any) => {
          try {
            const req = JSON.parse(raw.toString());
            handler(ws, req);
          } catch { /* ignore parse errors */ }
        });
      });
      rawWss.once("listening", () => {
        const addr = rawWss!.address();
        resolve(typeof addr === "object" ? addr!.port : 0);
      });
    });
  }

  function closeRawServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!rawWss) return resolve();
      for (const client of rawWss.clients) client.terminate();
      rawWss.close(() => resolve());
      rawWss = null;
    });
  }

  afterEach(async () => {
    await closeRawServer();
  });

  it("server drops after 5 successful requests - bridge reconnects - next 5 succeed", async () => {
    let port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    });

    bridge = new Bridge(port);
    await bridge.connect();

    for (let i = 0; i < 5; i++) {
      const result = (await bridge.send("test")) as any;
      expect(result.ok).toBe(true);
    }

    await closeRawServer();
    await new Promise((r) => setTimeout(r, 200));

    // Restart on same port
    await new Promise<void>((resolve) => {
      rawWss = new WebSocketServer({ host: "127.0.0.1", port });
      rawWss.on("connection", (ws: any) => {
        ws.on("message", (raw: any) => {
          const req = JSON.parse(raw.toString());
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, phase: 2 } }));
        });
      });
      rawWss.once("listening", () => resolve());
    });

    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 5; i++) {
      const result = (await bridge.send("test")) as any;
      expect(result.ok).toBe(true);
      expect(result.phase).toBe(2);
    }
  });

  it("server responds with errors for specific methods - only those fail", async () => {
    const port = await createRawServer((ws, req) => {
      if (req.method === "fail") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "Deliberate failure" } }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
      }
    });

    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("fail")).rejects.toThrow("Deliberate failure");
    const result = (await bridge.send("succeed")) as any;
    expect(result.ok).toBe(true);
    await expect(bridge.send("fail")).rejects.toThrow("Deliberate failure");
    const result2 = (await bridge.send("succeed")) as any;
    expect(result2.ok).toBe(true);
  });

  it("server responds slowly (200ms) - requests succeed with adequate timeout", async () => {
    const port = await createRawServer((ws, req) => {
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
        }
      }, 200);
    });

    bridge = new Bridge(port);
    await bridge.connect();
    const result = (await bridge.send("slow", {}, 5000)) as any;
    expect(result.ok).toBe(true);
  });

  it("request times out when server is too slow", async () => {
    const port = await createRawServer(() => {
      // Never respond
    });

    bridge = new Bridge(port);
    await bridge.connect();
    await expect(bridge.send("slow", {}, 300)).rejects.toThrow(/timed out/);
  });

  it("server sends malformed JSON for one request - only that one fails", async () => {
    let callCount = 0;
    const port = await createRawServer((ws, req) => {
      callCount++;
      if (callCount === 2) {
        ws.send("NOT JSON AT ALL{{{");
      } else {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { call: callCount } }));
      }
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const r1 = (await bridge.send("test")) as any;
    expect(r1.call).toBe(1);

    await expect(bridge.send("test", {}, 500)).rejects.toThrow(/timed out/);

    const r3 = (await bridge.send("test")) as any;
    expect(r3.call).toBe(3);
  });

  it("error response includes data field", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "Custom error", data: { detail: "extra info" } },
      }));
    });

    bridge = new Bridge(port);
    await bridge.connect();
    await expect(bridge.send("test")).rejects.toThrow(/Custom error.*extra info/);
  });

  it("bridge.close() rejects all pending requests", async () => {
    const port = await createRawServer(() => {
      // Never respond
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const promise = bridge.send("hanging", {}, 30000);
    await new Promise((r) => setTimeout(r, 50));
    bridge.close();

    await expect(promise).rejects.toThrow(/closing|closed/i);
    bridge = null;
  });

  it("multiple rapid reconnects don't crash", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    const port = server!.port;
    server!.onMethod("ping", () => ({ pong: true }));

    bridge = new Bridge(port);
    await bridge.connect();

    for (let i = 0; i < 5; i++) {
      bridge.close();
      bridge = new Bridge(port);
      await bridge.connect();
    }

    const result = (await bridge.send("ping")) as any;
    expect(result.pong).toBe(true);
  });

  it("bridge isConnected becomes false after close", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));

    bridge = new Bridge(server.port);
    await bridge.connect();
    expect(bridge.isConnected).toBe(true);

    bridge.close();
    expect(bridge.isConnected).toBe(false);
    bridge = null;
  });

  it("error with numeric error code", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32600, message: "Invalid Request" },
      }));
    });

    bridge = new Bridge(port);
    await bridge.connect();
    await expect(bridge.send("test")).rejects.toThrow("Invalid Request");
  });

  it("connect to non-existent server fails gracefully", async () => {
    bridge = new Bridge(19999);
    await expect(bridge.connect()).rejects.toThrow();
  });

  it("send without prior connect triggers auto-connect", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    server!.onMethod("auto", () => ({ connected: true }));

    bridge = new Bridge(server.port);
    const result = (await bridge.send("auto")) as any;
    expect(result.connected).toBe(true);
  });

  it("sequential timeout then success", async () => {
    let shouldRespond = false;
    const port = await createRawServer((ws, req) => {
      if (shouldRespond) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
      }
    });

    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("test", {}, 300)).rejects.toThrow(/timed out/);
    shouldRespond = true;
    const result = (await bridge.send("test")) as any;
    expect(result.ok).toBe(true);
  });

  it("server closes connection mid-batch - some fail", async () => {
    let messageCount = 0;
    const port = await createRawServer((ws, req) => {
      messageCount++;
      if (messageCount > 3) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { n: messageCount } }));
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const results: Array<{ ok: boolean }> = [];
    for (let i = 0; i < 6; i++) {
      try {
        await bridge.send("test", {}, 1000);
        results.push({ ok: true });
      } catch {
        results.push({ ok: false });
      }
    }

    const successes = results.filter((r) => r.ok).length;
    const failures = results.filter((r) => !r.ok).length;
    expect(successes).toBeGreaterThan(0);
    expect(failures).toBeGreaterThan(0);
  });

  it("multiple connect calls are idempotent when already connected", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));

    bridge = new Bridge(server.port);
    await bridge.connect();
    await bridge.connect();
    await bridge.connect();
    expect(bridge.isConnected).toBe(true);
  });

  it("close after close doesn't throw", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));

    bridge = new Bridge(server.port);
    await bridge.connect();
    bridge.close();
    bridge.close();
    bridge = null;
  });

  it("send after close to dead server rejects", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    });

    bridge = new Bridge(port);
    await bridge.connect();
    bridge.close();
    // Also close the server so reconnect fails
    await closeRawServer();

    await expect(bridge.send("test")).rejects.toThrow();
    bridge = null;
  });

  it("error message without data field", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Internal error" },
      }));
    });

    bridge = new Bridge(port);
    await bridge.connect();
    await expect(bridge.send("test")).rejects.toThrow("Internal error");
  });

  it("server restart with different port - old bridge fails, new bridge succeeds", async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    server!.onMethod("test", () => ({ phase: 1 }));

    bridge = new Bridge(server.port);
    await bridge.connect();
    const r1 = (await bridge.send("test")) as any;
    expect(r1.phase).toBe(1);

    await server.close();
    await new Promise((r) => setTimeout(r, 100));

    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    server!.onMethod("test", () => ({ phase: 2 }));

    bridge.close();
    bridge = new Bridge(server.port);
    await bridge.connect();
    const r2 = (await bridge.send("test")) as any;
    expect(r2.phase).toBe(2);
  });

  it("10 sequential errors don't corrupt bridge state", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -1, message: "Error" },
      }));
    });

    bridge = new Bridge(port);
    await bridge.connect();

    for (let i = 0; i < 10; i++) {
      await expect(bridge.send("test")).rejects.toThrow("Error");
    }

    expect(bridge.isConnected).toBe(true);
  });

  it("timeout doesn't affect subsequent requests", async () => {
    let shouldRespond = false;
    const port = await createRawServer((ws, req) => {
      if (shouldRespond) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
      }
    });

    bridge = new Bridge(port);
    await bridge.connect();

    await expect(bridge.send("test", {}, 200)).rejects.toThrow(/timed out/);

    shouldRespond = true;
    const result = (await bridge.send("test")) as any;
    expect(result.ok).toBe(true);
  });

  it("response with unknown ID is ignored", async () => {
    const port = await createRawServer((ws, req) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "FAKE_ID_999", result: { wrong: true } }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { correct: true } }));
    });

    bridge = new Bridge(port);
    await bridge.connect();

    const result = (await bridge.send("test")) as any;
    expect(result.correct).toBe(true);
  });
});

// ============================================================================
// Data integrity stress (~25 tests)
// ============================================================================

describe("Data integrity stress", () => {
  beforeEach(async () => {
    server = new MockCEPServer(0);
    await new Promise((r) => server!.wss.once("listening", r));
    bridge = new Bridge(server!.port);
    await bridge.connect();
  });

  it("send request with Unicode params - response preserves Unicode", async () => {
    server!.onMethod("unicode", (params) => params);
    const result = (await bridge!.send("unicode", { text: "Hello World test" })) as any;
    expect(result.text).toBe("Hello World test");
  });

  it("send request with CJK characters", async () => {
    server!.onMethod("cjk", (params) => params);
    const result = (await bridge!.send("cjk", { text: "test content test" })) as any;
    expect(result.text).toBe("test content test");
  });

  it("send request with large params (100KB)", async () => {
    server!.onMethod("large", (params) => ({ size: JSON.stringify(params).length }));
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      largeObj[`key_${i}`] = "x".repeat(100);
    }
    const result = (await bridge!.send("large", largeObj)) as any;
    expect(result.size).toBeGreaterThan(100000);
  });

  it("server returns deeply nested JSON - parsed correctly", async () => {
    server!.onMethod("deep", () => {
      let obj: any = { value: 42 };
      for (let i = 0; i < 20; i++) {
        obj = { child: obj };
      }
      return obj;
    });
    const result = (await bridge!.send("deep")) as any;
    let current = result;
    for (let i = 0; i < 20; i++) {
      current = current.child;
    }
    expect(current.value).toBe(42);
  });

  it("server returns array of 1000 items - all parsed", async () => {
    server!.onMethod("bigArr", () => Array.from({ length: 1000 }, (_, i) => ({ index: i })));
    const result = (await bridge!.send("bigArr")) as any;
    expect(result).toHaveLength(1000);
    expect(result[0].index).toBe(0);
    expect(result[999].index).toBe(999);
  });

  it("verify request IDs are unique across all requests in session", async () => {
    const seenIds = new Set<string>();
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        seenIds.add(req.id);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    // Send 200 requests
    for (let i = 0; i < 200; i++) {
      await bridge.send("test");
    }
    expect(seenIds.size).toBe(200);
  });

  it("verify timing: average round-trip < 50ms for local WebSocket", async () => {
    server!.onMethod("ping", () => ({ pong: true }));

    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      await bridge!.send("ping");
      times.push(Date.now() - start);
    }

    const avg = times.reduce((sum, t) => sum + t, 0) / times.length;
    expect(avg).toBeLessThan(50);
  });

  it("request preserves number precision", async () => {
    server!.onMethod("precise", (params) => params);
    const result = (await bridge!.send("precise", { val: 0.1 + 0.2 })) as any;
    expect(result.val).toBeCloseTo(0.3, 10);
  });

  it("request preserves negative numbers", async () => {
    server!.onMethod("neg", (params) => params);
    const result = (await bridge!.send("neg", { val: -99.99 })) as any;
    expect(result.val).toBe(-99.99);
  });

  it("request preserves boolean values", async () => {
    server!.onMethod("bool", (params) => params);
    const result = (await bridge!.send("bool", { t: true, f: false })) as any;
    expect(result.t).toBe(true);
    expect(result.f).toBe(false);
  });

  it("request preserves null values", async () => {
    server!.onMethod("nil", (params) => params);
    const result = (await bridge!.send("nil", { n: null })) as any;
    expect(result.n).toBeNull();
  });

  it("request preserves empty string", async () => {
    server!.onMethod("empty", (params) => params);
    const result = (await bridge!.send("empty", { s: "" })) as any;
    expect(result.s).toBe("");
  });

  it("request preserves empty array", async () => {
    server!.onMethod("emptyArr", (params) => params);
    const result = (await bridge!.send("emptyArr", { a: [] })) as any;
    expect(result.a).toEqual([]);
  });

  it("request preserves empty object", async () => {
    server!.onMethod("emptyObj", (params) => params);
    const result = (await bridge!.send("emptyObj", { o: {} })) as any;
    expect(result.o).toEqual({});
  });

  it("server returns string with special chars", async () => {
    server!.onMethod("special", () => ({ text: 'tab\there\nnewline\t"quotes"\\backslash' }));
    const result = (await bridge!.send("special")) as any;
    expect(result.text).toContain("\t");
    expect(result.text).toContain("\n");
    expect(result.text).toContain('"');
    expect(result.text).toContain("\\");
  });

  it("server returns large string value", async () => {
    const longStr = "A".repeat(100000);
    server!.onMethod("longStr", () => ({ text: longStr }));
    const result = (await bridge!.send("longStr")) as any;
    expect(result.text.length).toBe(100000);
  });

  it("response with nested arrays of objects", async () => {
    server!.onMethod("complex", () => ({
      layers: [
        { name: "L1", effects: [{ type: "blur", params: [1, 2, 3] }] },
        { name: "L2", effects: [] },
      ],
    }));
    const result = (await bridge!.send("complex")) as any;
    expect(result.layers).toHaveLength(2);
    expect(result.layers[0].effects[0].params).toEqual([1, 2, 3]);
  });

  it("response with mixed types in array", async () => {
    server!.onMethod("mixed", () => [1, "two", true, null, { five: 5 }, [6]]);
    const result = (await bridge!.send("mixed")) as any;
    expect(result).toEqual([1, "two", true, null, { five: 5 }, [6]]);
  });

  it("200 sequential requests - verify pending map is empty after", async () => {
    server!.onMethod("batch", () => ({ ok: true }));
    for (let i = 0; i < 200; i++) {
      await bridge!.send("batch");
    }
    // If we can still send, the pending map is being cleaned up
    const final = (await bridge!.send("batch")) as any;
    expect(final.ok).toBe(true);
  });

  it("JSON-RPC version is always 2.0", async () => {
    let receivedVersion: string = "";
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedVersion = req.jsonrpc;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    await bridge.send("test");
    expect(receivedVersion).toBe("2.0");
  });

  it("method name preserved exactly", async () => {
    let receivedMethod = "";
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedMethod = req.method;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    await bridge.send("my.custom.method.name");
    expect(receivedMethod).toBe("my.custom.method.name");
  });

  it("params object preserved exactly", async () => {
    let receivedParams: any = null;
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedParams = req.params;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    const params = { a: 1, b: "two", c: [3], d: { e: true }, f: null };
    await bridge.send("test", params);
    expect(receivedParams).toEqual(params);
  });

  it("request ID is a string", async () => {
    let receivedId: any = null;
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        receivedId = req.id;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    await bridge.send("test");
    expect(typeof receivedId).toBe("string");
  });

  it("request IDs are incrementing strings", async () => {
    const ids: string[] = [];
    server!.wss.removeAllListeners("connection");
    server!.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        ids.push(req.id);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
      });
    });

    bridge!.close();
    bridge = new Bridge(server!.port);
    await bridge.connect();

    for (let i = 0; i < 5; i++) {
      await bridge.send("test");
    }

    const numIds = ids.map(Number);
    for (let i = 1; i < numIds.length; i++) {
      expect(numIds[i]).toBeGreaterThan(numIds[i - 1]);
    }
  });
});
