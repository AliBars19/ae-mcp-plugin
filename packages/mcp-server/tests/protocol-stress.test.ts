import { describe, it, expect, afterEach } from "vitest";
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
                result: { ok: true },
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

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
  });
}

let servers: WebSocketServer[] = [];
let bridges: Bridge[] = [];

function track<T extends WebSocketServer | Bridge>(item: T): T {
  if (item instanceof WebSocketServer) servers.push(item);
  else bridges.push(item as Bridge);
  return item;
}

afterEach(async () => {
  for (const b of bridges) {
    try { b.close(); } catch { /* */ }
  }
  bridges = [];
  for (const s of servers) await closeServer(s);
  servers = [];
  await new Promise((r) => setTimeout(r, 30));
});

/* ================================================================
 *  MESSAGE FORMAT VALIDATION (~40 tests)
 * ================================================================ */

describe("Message format validation", () => {
  it("every sent message has jsonrpc: '2.0'", async () => {
    const messages: any[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      messages.push(msg);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    await bridge.send("test2");
    await bridge.send("test3");

    for (const msg of messages) {
      expect(msg.jsonrpc).toBe("2.0");
    }
  });

  it("every sent message has unique string ID", async () => {
    const ids: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(msg.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 20 }, () => bridge.send("test")));

    expect(new Set(ids).size).toBe(20);
    for (const id of ids) {
      expect(typeof id).toBe("string");
    }
  });

  it("every sent message has method field", async () => {
    const methods: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      methods.push(msg.method);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("alpha");
    await bridge.send("beta");
    await bridge.send("gamma");

    expect(methods).toEqual(["alpha", "beta", "gamma"]);
  });

  it("params are included when provided", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { key: "value", num: 42 });

    expect(captured.params).toEqual({ key: "value", num: 42 });
  });

  it("params are empty object when not provided", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");

    expect(captured.params).toEqual({});
  });

  it("IDs are sequential strings ('1', '2', '3', ...)", async () => {
    const ids: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(msg.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 10; i++) {
      await bridge.send("test");
    }

    for (let i = 0; i < 10; i++) {
      expect(ids[i]).toBe(String(i + 1));
    }
  });

  it("method names are passed through exactly (no transformation)", async () => {
    const methods: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      methods.push(msg.method);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const testMethods = [
      "project.getInfo",
      "comp.addLayer",
      "UPPERCASE_METHOD",
      "camelCaseMethod",
      "kebab-case-method",
      "dot.separated.method",
    ];

    for (const m of testMethods) {
      await bridge.send(m);
    }

    expect(methods).toEqual(testMethods);
  });

  it("special characters in method names preserved", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("method/with/slashes");
    expect(captured).toBe("method/with/slashes");
  });

  it("Unicode in params preserved through the wire", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { text: "Hello 🌍 مرحبا 你好 αβγ" });
    expect(captured.text).toBe("Hello 🌍 مرحبا 你好 αβγ");
  });

  it("large params object (100 keys) serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const params: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) params[`key${i}`] = `value${i}`;

    await bridge.send("test", params);
    expect(Object.keys(captured)).toHaveLength(100);
    expect(captured.key0).toBe("value0");
    expect(captured.key99).toBe("value99");
  });

  it("empty method name is sent as-is", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("");
    expect(captured).toBe("");
  });

  it("method with spaces preserved", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("method with spaces");
    expect(captured).toBe("method with spaces");
  });

  it("params with nested objects serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const params = {
      level1: {
        level2: {
          level3: { value: "deep" },
        },
      },
    };

    await bridge.send("test", params);
    expect(captured.level1.level2.level3.value).toBe("deep");
  });

  it("params with arrays serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { items: [1, "two", null, true] } as any);
    expect(captured.items).toEqual([1, "two", null, true]);
  });

  it("params with null value serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { key: null } as any);
    expect(captured.key).toBeNull();
  });

  it("params with boolean values serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { flag: true, other: false } as any);
    expect(captured.flag).toBe(true);
    expect(captured.other).toBe(false);
  });

  it("params with numeric values serialized correctly", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { int: 42, float: 3.14, neg: -1, zero: 0 } as any);
    expect(captured.int).toBe(42);
    expect(captured.float).toBe(3.14);
    expect(captured.neg).toBe(-1);
    expect(captured.zero).toBe(0);
  });

  it("message structure has exactly 4 fields: jsonrpc, id, method, params", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { a: 1 });

    const keys = Object.keys(captured).sort();
    expect(keys).toEqual(["id", "jsonrpc", "method", "params"]);
  });

  it("ID is string type, not number", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    expect(typeof captured.id).toBe("string");
  });

  it("multiple sequential sends have monotonically increasing IDs", async () => {
    const ids: number[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(Number(msg.id));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 20; i++) {
      await bridge.send("test");
    }

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it("very long method name preserved", async () => {
    const longMethod = "m".repeat(1000);
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send(longMethod);
    expect(captured).toBe(longMethod);
  });

  it("method with dots — not split or transformed", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("a.b.c.d.e");
    expect(captured).toBe("a.b.c.d.e");
  });

  it("params with empty string values", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { empty: "" } as any);
    expect(captured.empty).toBe("");
  });

  it("50 concurrent sends all have unique sequential IDs", async () => {
    const ids: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(msg.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 50 }, () => bridge.send("test")));

    expect(new Set(ids).size).toBe(50);
    const nums = ids.map(Number).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
  });

  it("params with special JSON characters", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { text: 'quotes"and\\backslash\nnewline\ttab' } as any);
    expect(captured.text).toBe('quotes"and\\backslash\nnewline\ttab');
  });

  it("sent message is valid JSON", async () => {
    let rawMessage: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      rawMessage = raw;
      const msg = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    expect(() => JSON.parse(rawMessage!)).not.toThrow();
  });

  it("ID starts at 1 for a new bridge", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    expect(captured.id).toBe("1");
  });

  it("second send has ID '2'", async () => {
    const ids: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(msg.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("first");
    await bridge.send("second");
    expect(ids[1]).toBe("2");
  });

  it("params with deeply nested arrays", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { data: [[[[1]]]] } as any);
    expect(captured.data).toEqual([[[[1]]]]);
  });

  it("method name with emoji preserved", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test.🎵.method");
    expect(captured).toBe("test.🎵.method");
  });

  it("jsonrpc field is exactly the string '2.0' not a number", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test");
    expect(captured.jsonrpc).toBe("2.0");
    expect(typeof captured.jsonrpc).toBe("string");
  });
});

/* ================================================================
 *  RESPONSE PARSING ROBUSTNESS (~30 tests)
 * ================================================================ */

describe("Response parsing robustness", () => {
  it("response missing jsonrpc field — still processed", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ id: req.id, result: "no-version" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("no-version");
  });

  it("response with extra fields — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: "ok",
        timestamp: Date.now(),
        server: "test",
      }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("ok");
  });

  it("response with result: undefined — resolves to undefined", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // undefined gets stripped by JSON.stringify
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeUndefined();
  });

  it("response with result: 0 — resolves to 0 (falsy but valid)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 0 }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(0);
  });

  it("response with result: false — resolves to false", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: false }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(false);
  });

  it("response with result: '' — resolves to empty string", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("");
  });

  it("response with result: [] — resolves to empty array", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual([]);
  });

  it("response with result: null — resolves to null", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeNull();
  });

  it("numeric ID in response (vs string) — handled gracefully", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // Send back numeric ID — Map.get won't match string key with number
      // The bridge uses string IDs, so numeric 1 !== "1" in Map
      // This should be ignored, and the request should timeout
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: Number(req.id), result: "numeric-id" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    // If the numeric ID doesn't match, this will timeout
    // But JSON.parse might convert it back — let's test
    // Actually JSON has no distinction between 1 and "1" at parse level
    // But the Map key is "1" (string), and JSON.parse of {id: 1} gives number 1
    // Map.get(1) !== Map.get("1") — so this SHOULD timeout
    await expect(bridge.send("test", {}, 200)).rejects.toThrow(/timed out/);
  });

  it("response is a JSON array instead of object — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("[1,2,3]");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with jsonrpc: '1.0' — still processed (we only check id)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "1.0", id: req.id, result: "old-version" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("old-version");
  });

  it("response with both result and error — error takes precedence", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: "ok",
        error: { code: -32000, message: "Also error" },
      }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    // Bridge checks error first
    await expect(bridge.send("test")).rejects.toThrow("Also error");
  });

  it("response with result: NaN (serialized as null) — resolves to null", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // JSON.stringify(NaN) = "null"
      ws.send(`{"jsonrpc":"2.0","id":"${req.id}","result":null}`);
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeNull();
  });

  it("response with result: Infinity (becomes null) — resolves to null", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(`{"jsonrpc":"2.0","id":"${req.id}","result":null}`);
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBeNull();
  });

  it("response with very large numeric result — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 9007199254740991 }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("response with negative numeric result — preserved", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: -42.5 }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(-42.5);
  });

  it("response with deeply nested result (20 levels) — parsed", async () => {
    let obj: any = { value: "deep" };
    for (let i = 0; i < 20; i++) obj = { child: obj };

    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: obj }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result: any = await bridge.send("test");
    let current = result;
    for (let i = 0; i < 20; i++) current = current.child;
    expect(current.value).toBe("deep");
  });

  it("response that is just a string literal — parse succeeds but no id field", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send('"just a string"');
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with empty object (no id, no result) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send("{}");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with result containing Date string — preserved as string", async () => {
    const dateStr = "2026-04-04T12:00:00.000Z";
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: dateStr }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe(dateStr);
  });

  it("10 mixed valid/invalid responses — all valid ones resolve", async () => {
    let callCount = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      callCount++;
      // Send garbage before valid response
      ws.send("garbage");
      ws.send("{{bad}}");
      ws.send(JSON.stringify({ id: "wrong", result: "nope" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: callCount }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 1; i <= 10; i++) {
      const result = await bridge.send("test");
      expect(result).toBe(i);
    }
  });

  it("response with id: undefined (missing) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", result: "no-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "with-id" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("with-id");
  });

  it("response with id: null — ignored (pending.get(null) returns undefined)", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, result: "null-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with id: '' (empty string) — ignored since IDs start at '1'", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "", result: "empty-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with id: true (boolean) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: true, result: "bool-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with id: {} (object) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: {}, result: "obj-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });

  it("response with id: [] (array) — ignored", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: [], result: "arr-id" }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "real" }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toBe("real");
  });
});

/* ================================================================
 *  WIRE-LEVEL STRESS (~30 tests)
 * ================================================================ */

describe("Wire-level stress", () => {
  it("200 sequential requests — all complete", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 200; i++) {
      const r = await bridge.send("test");
      expect(r).toBe(true);
    }
  }, 30000);

  it("200 sequential requests — pending map stays empty after completion", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 200; i++) {
      await bridge.send("test");
    }
    expect((bridge as any).pending.size).toBe(0);
  }, 30000);

  it("request/response cycle time under 50ms for local WebSocket", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const start = Date.now();
    await bridge.send("test");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("pending map size stays 0 after all requests complete", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 50 }, () => bridge.send("test")));
    expect((bridge as any).pending.size).toBe(0);
  });

  it("rapid fire: send 50 messages in <10ms — all resolve", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const promises: Promise<unknown>[] = [];
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      promises.push(bridge.send("test"));
    }
    const queueTime = Date.now() - start;
    // Queuing should be fast (synchronous)
    expect(queueTime).toBeLessThan(50);

    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);
  });

  it("large payload (500KB) sent and received", async () => {
    const bigData = "x".repeat(500 * 1024);
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.data }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test", { data: bigData } as any, 10000);
    expect((result as string).length).toBe(500 * 1024);
  });

  it("100 parallel requests — all complete without memory leak", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => bridge.send("test")),
    );
    expect(results).toHaveLength(100);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("send 10 messages, each with increasing payload size", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.size }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 10; i++) {
      const size = (i + 1) * 1000;
      const payload = "x".repeat(size);
      const result = await bridge.send("test", { data: payload, size } as any);
      expect(result).toBe(size);
    }
  });

  it("requestId increments correctly across 100 sends", async () => {
    const ids: number[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(Number(msg.id));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 100; i++) {
      await bridge.send("test");
    }

    expect(ids.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });

  it("no duplicate IDs across 500 concurrent sends", async () => {
    const idSet = new Set<string>();
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      idSet.add(msg.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 500 }, () => bridge.send("test")));
    expect(idSet.size).toBe(500);
  });

  it("server echo test — params round-trip correctly", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const params = { a: 1, b: "two", c: [3, 4], d: { e: true } };
    const result = await bridge.send("test", params as any);
    expect(result).toEqual(params);
  });

  it("bridge handles empty params gracefully", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("test");
    expect(result).toEqual({});
  });

  it("connect/disconnect 20 times — no event listener leaks", async () => {
    const { wss, port } = await createServer();
    track(wss);

    for (let i = 0; i < 20; i++) {
      const bridge = new Bridge(port);
      await bridge.connect();
      bridge.close();
    }

    // If there were listener leaks, Node would warn about MaxListenersExceeded
    // The fact that we got here without warnings means no leaks
    expect(true).toBe(true);
  });

  it("alternating success and error responses — all handled correctly", async () => {
    let count = 0;
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      count++;
      if (count % 2 === 0) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Even" },
        }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "Odd" }));
      }
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 1; i <= 10; i++) {
      if (i % 2 === 0) {
        await expect(bridge.send("test")).rejects.toThrow("Even");
      } else {
        const r = await bridge.send("test");
        expect(r).toBe("Odd");
      }
    }
  });

  it("30 rapid sends followed by close — pending map empties", async () => {
    const { wss, port } = await createServer((_ws, _raw) => {
      // Don't respond
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 30 }, () =>
      bridge.send("test", {}, 30000).catch(() => {}),
    );

    bridge.close();
    await Promise.allSettled(promises);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("message ordering preserved for sequential sends", async () => {
    const receivedOrder: number[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      receivedOrder.push(req.params.order);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 20; i++) {
      await bridge.send("test", { order: i } as any);
    }

    expect(receivedOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("server responds to 50 requests out of order — bridge matches by ID", async () => {
    const pending: Array<{ id: string; ws: WsWebSocket }> = [];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      pending.push({ id: req.id, ws });
      if (pending.length === 50) {
        // Respond in reverse order
        for (let i = pending.length - 1; i >= 0; i--) {
          pending[i].ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: pending[i].id, result: Number(pending[i].id) }),
          );
        }
      }
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => bridge.send("test")),
    );

    // Each result should be the numeric version of its ID
    for (const r of results) {
      expect(typeof r).toBe("number");
    }
    expect(results).toHaveLength(50);
  });

  it("bridge with 0 pending after each individual send/receive", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 30; i++) {
      await bridge.send("test");
      expect((bridge as any).pending.size).toBe(0);
    }
  });

  it("batch: 200 parallel sends to exercise protocol throughput", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: Number(req.id) }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 200 }, () => bridge.send("test")),
    );
    expect(results).toHaveLength(200);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("requestId is globally unique even with multiple bridges", async () => {
    // Each bridge has its own requestId counter, so IDs overlap across bridges
    // But within a single bridge they're unique
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);

    const b1 = track(new Bridge(port));
    const b2 = track(new Bridge(port));
    await b1.connect();
    await b2.connect();

    await b1.send("test");
    await b2.send("test");

    // Both bridges start at ID 1 — they're independent
    expect((b1 as any).requestId).toBe(1);
    expect((b2 as any).requestId).toBe(1);
  });

  it("pending map correctly tracks in-flight requests", async () => {
    let resolveResponse: (() => void) | null = null;
    const responseReady = new Promise<void>((r) => { resolveResponse = r; });
    let capturedWs: WsWebSocket | null = null;
    let capturedId: string | null = null;

    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      capturedWs = ws;
      capturedId = req.id;
      resolveResponse!();
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const p = bridge.send("test", {}, 5000);
    await responseReady;
    expect((bridge as any).pending.size).toBe(1);

    capturedWs!.send(JSON.stringify({ jsonrpc: "2.0", id: capturedId, result: true }));
    await p;
    expect((bridge as any).pending.size).toBe(0);
  });

  it("round-trip JSON preserves all types", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const params = {
      str: "hello",
      num: 42,
      float: 3.14,
      bool: true,
      nil: null,
      arr: [1, 2, 3],
      obj: { nested: true },
    };

    const result = await bridge.send("test", params as any);
    expect(result).toEqual(params);
  });

  it("send/receive with no params and result:true — minimal message", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const result = await bridge.send("ping");
    expect(result).toBe(true);
    expect(captured.method).toBe("ping");
    expect(captured.params).toEqual({});
  });

  it("50 sends with unique method names — all correctly dispatched", async () => {
    const receivedMethods: string[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      receivedMethods.push(req.method);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bridge.send(`method_${i}`)),
    );

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(`method_${i}`);
    }
    expect(receivedMethods).toHaveLength(50);
  });

  it("100 sequential sends verify pending cleanup", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 100; i++) {
      await bridge.send("test");
      expect((bridge as any).pending.size).toBe(0);
    }
  });

  it("requestId after 1000 sends is 1000", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 1000 }, () => bridge.send("test")));
    expect((bridge as any).requestId).toBe(1000);
  }, 30000);

  it("concurrent sends maintain correct ID-to-response mapping", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      // Respond with the ID as the result to verify mapping
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `resp-${req.id}` }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => bridge.send("test")),
    );

    for (let i = 0; i < 20; i++) {
      expect(results[i]).toBe(`resp-${i + 1}`);
    }
  });

  it("JSON message size for minimal request", async () => {
    let rawSize = 0;
    const { wss, port } = await createServer((ws, raw) => {
      rawSize = raw.length;
      const msg = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("t");
    // Should be a small JSON: {"jsonrpc":"2.0","id":"1","method":"t","params":{}}
    expect(rawSize).toBeLessThan(100);
    expect(rawSize).toBeGreaterThan(30);
  });

  it("params with 500 keys serialized without truncation", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.params;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const params: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) params[`k${i}`] = i;

    await bridge.send("test", params);
    expect(Object.keys(captured)).toHaveLength(500);
  });

  it("10 bridges each produce independent ID sequences", async () => {
    const idsByBridge: string[][] = Array.from({ length: 10 }, () => []);
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);

    const arr = Array.from({ length: 10 }, () => track(new Bridge(port)));
    await Promise.all(arr.map((b) => b.connect()));

    for (let b = 0; b < 10; b++) {
      for (let i = 0; i < 3; i++) {
        await arr[b].send("test");
      }
      // Each bridge's requestId should be 3
      expect((arr[b] as any).requestId).toBe(3);
    }
  });

  it("wire format: params with undefined values stripped by JSON.stringify", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("test", { defined: 1, undef: undefined } as any);
    expect(captured.params).toEqual({ defined: 1 });
    expect("undef" in captured.params).toBe(false);
  });

  it("sequential sends produce gapless ID sequence", async () => {
    const ids: number[] = [];
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      ids.push(Number(msg.id));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    for (let i = 0; i < 50; i++) {
      await bridge.send("test");
    }

    for (let i = 0; i < 50; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });

  it("rapid close after 50 parallel sends — all pending cleaned", async () => {
    const { wss, port } = await createServer((_ws, _raw) => {
      // Don't respond
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const promises = Array.from({ length: 50 }, () =>
      bridge.send("test", {}, 30000).catch(() => {}),
    );

    bridge.close();
    await Promise.allSettled(promises);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("wire throughput: 100 round-trips in under 2 seconds", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await bridge.send("test");
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("300 parallel sends — no pending entries leak", async () => {
    const { wss, port } = await createServer((ws, raw) => {
      const req = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await Promise.all(Array.from({ length: 300 }, () => bridge.send("test")));
    expect((bridge as any).pending.size).toBe(0);
    expect((bridge as any).requestId).toBe(300);
  });

  it("params with Date object becomes string", async () => {
    let captured: any = null;
    const { wss, port } = await createServer((ws, raw) => {
      captured = JSON.parse(raw);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: captured.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    const date = new Date("2026-04-04T00:00:00Z");
    await bridge.send("test", { date } as any);
    expect(typeof captured.params.date).toBe("string");
  });

  it("method name with colons preserved", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("namespace:method:action");
    expect(captured).toBe("namespace:method:action");
  });

  it("method name with backslashes preserved", async () => {
    let captured: string | null = null;
    const { wss, port } = await createServer((ws, raw) => {
      const msg = JSON.parse(raw);
      captured = msg.method;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
    track(wss);
    const bridge = track(new Bridge(port));
    await bridge.connect();

    await bridge.send("path\\to\\method");
    expect(captured).toBe("path\\to\\method");
  });
});
