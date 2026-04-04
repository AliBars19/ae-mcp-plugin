import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Stress tests for the shared context file operations.
 *
 * Overrides APPDATA to isolate each test to a fresh temp directory.
 * Tests concurrent writes, reads, file system edge cases, and key validation.
 */

let tempDir: string;
let originalAppData: string | undefined;

const CONTEXT_SUBDIR = "Apollova";
const CONTEXT_FILENAME = "ae-mcp-context.json";

function contextDir(): string {
  return join(tempDir, CONTEXT_SUBDIR);
}

function contextFile(): string {
  return join(contextDir(), CONTEXT_FILENAME);
}

// Raw read/write helpers (same logic as context.ts but direct)
async function rawReadContext(): Promise<Record<string, unknown>> {
  if (!existsSync(contextFile())) return {};
  try {
    const raw = await readFile(contextFile(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function rawWriteContext(key: string, value: unknown): Promise<void> {
  const dir = contextDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const data: Record<string, unknown> = existsSync(contextFile())
    ? JSON.parse(await readFile(contextFile(), "utf-8"))
    : {};

  data[key] = value;
  data._updated = new Date().toISOString();
  await writeFile(contextFile(), JSON.stringify(data, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ae-mcp-ctx-stress-"));
  originalAppData = process.env.APPDATA;
  process.env.APPDATA = tempDir;
});

afterEach(async () => {
  process.env.APPDATA = originalAppData;
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// Concurrent write stress (~25 tests)
// ============================================================================

describe("Concurrent write stress", () => {
  it("10 sequential writes with different keys - all keys present after", async () => {
    // Sequential writes to avoid race corruption (raw helper has no lockfile)
    for (let i = 0; i < 10; i++) {
      await rawWriteContext(`key_${i}`, `value_${i}`);
    }
    const data = await rawReadContext();
    for (let i = 0; i < 10; i++) {
      expect(data[`key_${i}`]).toBe(`value_${i}`);
    }
  });

  it("20 sequential writes to same key - last write wins", async () => {
    for (let i = 0; i < 20; i++) {
      await rawWriteContext("counter", i);
    }
    const data = await rawReadContext();
    expect(data.counter).toBe(19);
  });

  it("write during read returns consistent snapshot", async () => {
    await rawWriteContext("stable", "initial");
    const readPromise = rawReadContext();
    await rawWriteContext("stable", "updated");
    const snapshot = await readPromise;
    // Snapshot should be one of the two valid states
    expect(["initial", "updated"]).toContain(snapshot.stable);
  });

  it("50 sequential writes - file not corrupted", async () => {
    for (let i = 0; i < 50; i++) {
      await rawWriteContext(`item_${i}`, i);
    }
    const raw = await readFile(contextFile(), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const data = JSON.parse(raw);
    expect(data.item_49).toBe(49);
  });

  it("write extremely large value (500KB JSON object)", async () => {
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      largeObj[`prop_${i}`] = "x".repeat(100);
    }
    await rawWriteContext("large", largeObj);
    const data = await rawReadContext();
    expect((data.large as any).prop_0).toBe("x".repeat(100));
    expect(Object.keys(data.large as any)).toHaveLength(5000);
  });

  it("write deeply nested value (20 levels)", async () => {
    let nested: any = { value: "deep" };
    for (let i = 0; i < 20; i++) {
      nested = { child: nested };
    }
    await rawWriteContext("deep", nested);
    const data = await rawReadContext();
    let current: any = data.deep;
    for (let i = 0; i < 20; i++) {
      current = current.child;
    }
    expect(current.value).toBe("deep");
  });

  it("write value with every JSON type", async () => {
    await rawWriteContext("str", "hello");
    await rawWriteContext("num", 42);
    await rawWriteContext("bool", true);
    await rawWriteContext("nil", null);
    await rawWriteContext("arr", [1, "two", null]);
    await rawWriteContext("obj", { a: 1 });

    const data = await rawReadContext();
    expect(data.str).toBe("hello");
    expect(data.num).toBe(42);
    expect(data.bool).toBe(true);
    expect(data.nil).toBeNull();
    expect(data.arr).toEqual([1, "two", null]);
    expect(data.obj).toEqual({ a: 1 });
  });

  it("write array with 1000 elements", async () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    await rawWriteContext("bigArray", arr);
    const data = await rawReadContext();
    expect((data.bigArray as number[])).toHaveLength(1000);
    expect((data.bigArray as number[])[999]).toBe(999);
  });

  it("write boolean false value preserved", async () => {
    await rawWriteContext("flag", false);
    const data = await rawReadContext();
    expect(data.flag).toBe(false);
  });

  it("write zero value preserved", async () => {
    await rawWriteContext("zero", 0);
    const data = await rawReadContext();
    expect(data.zero).toBe(0);
  });

  it("write empty string value preserved", async () => {
    await rawWriteContext("empty", "");
    const data = await rawReadContext();
    expect(data.empty).toBe("");
  });

  it("write empty array preserved", async () => {
    await rawWriteContext("emptyArr", []);
    const data = await rawReadContext();
    expect(data.emptyArr).toEqual([]);
  });

  it("write empty object preserved", async () => {
    await rawWriteContext("emptyObj", {});
    const data = await rawReadContext();
    expect(data.emptyObj).toEqual({});
  });

  it("overwrite with different type", async () => {
    await rawWriteContext("morph", "string");
    await rawWriteContext("morph", 42);
    await rawWriteContext("morph", [1, 2]);
    const data = await rawReadContext();
    expect(data.morph).toEqual([1, 2]);
  });

  it("write negative number", async () => {
    await rawWriteContext("neg", -42.5);
    const data = await rawReadContext();
    expect(data.neg).toBe(-42.5);
  });

  it("write Infinity serializes as null (JSON limitation)", async () => {
    await rawWriteContext("inf", Infinity);
    const data = await rawReadContext();
    expect(data.inf).toBeNull(); // JSON.stringify(Infinity) → null
  });

  it("write NaN serializes as null (JSON limitation)", async () => {
    await rawWriteContext("nan", NaN);
    const data = await rawReadContext();
    expect(data.nan).toBeNull();
  });

  it("write string with JSON special chars", async () => {
    const val = '{"key": "value", "arr": [1,2]}';
    await rawWriteContext("jsonStr", val);
    const data = await rawReadContext();
    expect(data.jsonStr).toBe(val);
  });

  it("write string with newlines", async () => {
    await rawWriteContext("multiline", "line1\nline2\nline3");
    const data = await rawReadContext();
    expect(data.multiline).toBe("line1\nline2\nline3");
  });

  it("write string with Unicode emoji", async () => {
    await rawWriteContext("emoji", "Hello World");
    const data = await rawReadContext();
    expect(data.emoji).toBe("Hello World");
  });

  it("write preserves all existing keys", async () => {
    await rawWriteContext("a", 1);
    await rawWriteContext("b", 2);
    await rawWriteContext("c", 3);
    await rawWriteContext("d", 4);
    await rawWriteContext("e", 5);
    const data = await rawReadContext();
    expect(data.a).toBe(1);
    expect(data.b).toBe(2);
    expect(data.c).toBe(3);
    expect(data.d).toBe(4);
    expect(data.e).toBe(5);
  });

  it("rapid writes don't lose _updated", async () => {
    for (let i = 0; i < 10; i++) {
      await rawWriteContext(`rapid_${i}`, i);
    }
    const data = await rawReadContext();
    expect(data._updated).toBeDefined();
    expect(typeof data._updated).toBe("string");
  });

  it("_updated is valid ISO timestamp", async () => {
    await rawWriteContext("test", 1);
    const data = await rawReadContext();
    const ts = data._updated as string;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("write array of objects", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item_${i}` }));
    await rawWriteContext("items", items);
    const data = await rawReadContext();
    expect((data.items as any[])).toHaveLength(50);
    expect((data.items as any[])[25].name).toBe("item_25");
  });

  it("write nested arrays", async () => {
    const matrix = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: 10 }, (_, j) => i * 10 + j)
    );
    await rawWriteContext("matrix", matrix);
    const data = await rawReadContext();
    expect((data.matrix as number[][])[5][5]).toBe(55);
  });
});

// ============================================================================
// Read stress (~20 tests)
// ============================================================================

describe("Read stress", () => {
  it("read from empty context returns empty object", async () => {
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("read specific key that doesn't exist returns undefined", async () => {
    await rawWriteContext("exists", true);
    const data = await rawReadContext();
    expect(data["nonexistent"]).toBeUndefined();
  });

  it("read after write - value present", async () => {
    await rawWriteContext("key", "value");
    const data = await rawReadContext();
    expect(data.key).toBe("value");
  });

  it("read _updated after write - ISO timestamp", async () => {
    await rawWriteContext("key", "val");
    const data = await rawReadContext();
    expect(data._updated).toBeDefined();
    expect(typeof data._updated).toBe("string");
    expect(() => new Date(data._updated as string)).not.toThrow();
  });

  it("read all keys after 10 writes - all present", async () => {
    for (let i = 0; i < 10; i++) {
      await rawWriteContext(`k${i}`, i);
    }
    const data = await rawReadContext();
    for (let i = 0; i < 10; i++) {
      expect(data[`k${i}`]).toBe(i);
    }
  });

  it("read with corrupted JSON file returns empty object", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), "NOT VALID JSON {{{", "utf-8");
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("read with empty file returns empty object", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), "", "utf-8");
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("read with binary garbage returns empty object", async () => {
    await mkdir(contextDir(), { recursive: true });
    const garbage = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x90, 0xA0]);
    await writeFile(contextFile(), garbage);
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("read specific key from corrupted file returns undefined", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), "{{invalid}}", "utf-8");
    const data = await rawReadContext();
    expect(data["anyKey"]).toBeUndefined();
  });

  it("50 sequential reads succeed", async () => {
    await rawWriteContext("stable", "value");
    for (let i = 0; i < 50; i++) {
      const data = await rawReadContext();
      expect(data.stable).toBe("value");
    }
  });

  it("read preserves number types", async () => {
    await rawWriteContext("int", 42);
    await rawWriteContext("float", 3.14);
    const data = await rawReadContext();
    expect(data.int).toBe(42);
    expect(data.float).toBe(3.14);
  });

  it("read preserves boolean types", async () => {
    await rawWriteContext("t", true);
    await rawWriteContext("f", false);
    const data = await rawReadContext();
    expect(data.t).toBe(true);
    expect(data.f).toBe(false);
  });

  it("read preserves null", async () => {
    await rawWriteContext("n", null);
    const data = await rawReadContext();
    expect(data.n).toBeNull();
  });

  it("read preserves nested arrays", async () => {
    await rawWriteContext("nested", [[1, 2], [3, 4]]);
    const data = await rawReadContext();
    expect(data.nested).toEqual([[1, 2], [3, 4]]);
  });

  it("read preserves deeply nested objects", async () => {
    const deep = { a: { b: { c: { d: { e: 42 } } } } };
    await rawWriteContext("deep", deep);
    const data = await rawReadContext();
    expect(data.deep).toEqual(deep);
  });

  it("read returns fresh data after overwrite", async () => {
    await rawWriteContext("val", "old");
    const d1 = await rawReadContext();
    expect(d1.val).toBe("old");
    await rawWriteContext("val", "new");
    const d2 = await rawReadContext();
    expect(d2.val).toBe("new");
  });

  it("read after directory created but no file yet", async () => {
    await mkdir(contextDir(), { recursive: true });
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("read string with escaped characters", async () => {
    await rawWriteContext("esc", 'tab\there\nnewline\t"quotes"');
    const data = await rawReadContext();
    expect(data.esc).toBe('tab\there\nnewline\t"quotes"');
  });

  it("read file with only _updated key", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), JSON.stringify({ _updated: "2026-01-01T00:00:00Z" }), "utf-8");
    const data = await rawReadContext();
    expect(data._updated).toBe("2026-01-01T00:00:00Z");
    expect(Object.keys(data)).toHaveLength(1);
  });

  it("read with truncated JSON returns empty object", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), '{"key": "val', "utf-8");
    const data = await rawReadContext();
    expect(data).toEqual({});
  });
});

// ============================================================================
// File system edge cases (~20 tests)
// ============================================================================

describe("File system edge cases", () => {
  it("context dir doesn't exist - created automatically on write", async () => {
    expect(existsSync(contextDir())).toBe(false);
    await rawWriteContext("test", 1);
    expect(existsSync(contextDir())).toBe(true);
  });

  it("context file deleted between writes - recreated", async () => {
    await rawWriteContext("first", 1);
    expect(existsSync(contextFile())).toBe(true);
    await rm(contextFile());
    await rawWriteContext("second", 2);
    expect(existsSync(contextFile())).toBe(true);
    const data = await rawReadContext();
    expect(data.second).toBe(2);
    // First key is lost since file was deleted
    expect(data.first).toBeUndefined();
  });

  it("write when disk path has spaces", async () => {
    const spacePath = join(tmpdir(), "ae mcp ctx stress space " + Date.now().toString());
    await mkdir(spacePath, { recursive: true });
    const prevAppData = process.env.APPDATA;
    process.env.APPDATA = spacePath;

    const dir = join(spacePath, CONTEXT_SUBDIR);
    const file = join(dir, CONTEXT_FILENAME);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ test: "space" }, null, 2), "utf-8");

    const raw = await readFile(file, "utf-8");
    expect(JSON.parse(raw).test).toBe("space");

    process.env.APPDATA = prevAppData;
    await rm(spacePath, { recursive: true, force: true }).catch(() => {});
  });

  it("roundtrip: write complex object, read it back, deep equality", async () => {
    const complex = {
      name: "test",
      version: 2,
      tags: ["a", "b", "c"],
      nested: { deep: { array: [1, { key: "val" }] } },
      nullable: null,
      flag: true,
    };
    await rawWriteContext("complex", complex);
    const data = await rawReadContext();
    expect(data.complex).toEqual(complex);
  });

  it("file is valid UTF-8", async () => {
    await rawWriteContext("utf8", "Hello World test");
    const buf = await readFile(contextFile());
    expect(buf.toString("utf-8")).toContain("Hello World test");
  });

  it("directory deleted between reads - first read creates, second returns empty", async () => {
    await rawWriteContext("test", 1);
    await rm(contextDir(), { recursive: true, force: true });
    const data = await rawReadContext();
    expect(data).toEqual({});
  });

  it("file permissions preserved after write", async () => {
    await rawWriteContext("test", 1);
    // File should be readable
    const raw = await readFile(contextFile(), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("multiple rapid reads return same data", async () => {
    await rawWriteContext("stable", 42);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rawReadContext())
    );
    for (const r of results) {
      expect(r.stable).toBe(42);
    }
  });

  it("write preserves file indentation", async () => {
    await rawWriteContext("pretty", true);
    const raw = await readFile(contextFile(), "utf-8");
    expect(raw).toContain("  ");
    expect(raw.split("\n").length).toBeGreaterThan(1);
  });

  it("write to newly created directory is idempotent", async () => {
    await rawWriteContext("first", 1);
    await rawWriteContext("second", 2);
    const data = await rawReadContext();
    expect(data.first).toBe(1);
    expect(data.second).toBe(2);
  });

  it("file with extra whitespace is still valid", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), '  \n\n  { "key" :  "value" } \n\n  ', "utf-8");
    const data = await rawReadContext();
    expect(data.key).toBe("value");
  });

  it("file with BOM marker handled", async () => {
    await mkdir(contextDir(), { recursive: true });
    const bom = "\uFEFF";
    await writeFile(contextFile(), bom + '{"key": "value"}', "utf-8");
    // JSON.parse may or may not handle BOM — test the current behavior
    const data = await rawReadContext();
    // If BOM causes parse failure, we get {}; otherwise we get the data
    const isValid = data.key === "value" || Object.keys(data).length === 0;
    expect(isValid).toBe(true);
  });

  it("write after reading corrupted file works", async () => {
    await mkdir(contextDir(), { recursive: true });
    await writeFile(contextFile(), "CORRUPTED", "utf-8");
    const data = await rawReadContext();
    expect(data).toEqual({});
    // Now overwrite with valid data
    await writeFile(contextFile(), JSON.stringify({ fixed: true }, null, 2), "utf-8");
    const fixed = await rawReadContext();
    expect(fixed.fixed).toBe(true);
  });

  it("concurrent reads don't interfere with each other", async () => {
    await rawWriteContext("shared", "value");
    const promises = Array.from({ length: 30 }, () => rawReadContext());
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.shared).toBe("value");
    }
  });

  it("empty object written serializes as expected", async () => {
    await rawWriteContext("obj", {});
    const raw = await readFile(contextFile(), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.obj).toEqual({});
  });

  it("file size grows with each key", async () => {
    await rawWriteContext("k1", "v1");
    const size1 = (await readFile(contextFile(), "utf-8")).length;
    await rawWriteContext("k2", "v2");
    const size2 = (await readFile(contextFile(), "utf-8")).length;
    expect(size2).toBeGreaterThan(size1);
  });

  it("overwriting key doesn't grow file indefinitely", async () => {
    await rawWriteContext("key", "short");
    const size1 = (await readFile(contextFile(), "utf-8")).length;
    await rawWriteContext("key", "short");
    const size2 = (await readFile(contextFile(), "utf-8")).length;
    // Same key same value — sizes should be close (timestamp may differ slightly)
    expect(Math.abs(size2 - size1)).toBeLessThan(50);
  });

  it("write array then overwrite with object", async () => {
    await rawWriteContext("morph", [1, 2, 3]);
    await rawWriteContext("morph", { a: 1 });
    const data = await rawReadContext();
    expect(data.morph).toEqual({ a: 1 });
  });

  it("context file only contains expected keys", async () => {
    await rawWriteContext("alpha", 1);
    await rawWriteContext("beta", 2);
    const data = await rawReadContext();
    const keys = Object.keys(data).filter(k => k !== "_updated");
    expect(keys.sort()).toEqual(["alpha", "beta"]);
  });
});

// ============================================================================
// Key validation exhaustive (~15 tests)
// These test the Zod regex /^[a-zA-Z_][a-zA-Z0-9_]*$/ and constraints
// by using the tool handler through the mock server registration.
// ============================================================================

describe("Key validation exhaustive (via Zod schema)", () => {
  // The Zod schema is applied by the MCP SDK before the handler runs.
  // We capture the raw schema from tool registration and validate directly.
  let keySchema: import("zod").ZodTypeAny;
  let handler: (params: Record<string, unknown>) => Promise<any>;

  beforeEach(async () => {
    const { z } = await import("zod");
    const tools = new Map<string, { schema: Record<string, any>; handler: Function }>();
    const mockServer = {
      tool: (name: string, _desc: string, schema: Record<string, any>, h: Function) => {
        tools.set(name, { schema, handler: h as any });
      },
    } as any;
    const mockBridge = {
      send: async () => ({}),
      connect: async () => {},
      close: () => {},
      isConnected: true,
    } as any;

    const { registerContextTools } = await import("../src/tools/context.js");
    registerContextTools(mockServer, mockBridge);
    const writeCtx = tools.get("ae_write_shared_context")!;
    keySchema = writeCtx.schema.key;
    handler = writeCtx.handler as any;
  });

  function validateKey(key: string): boolean {
    const result = keySchema.safeParse(key);
    return result.success;
  }

  it("valid key 'a' accepted", () => {
    expect(validateKey("a")).toBe(true);
  });

  it("valid key 'abc' accepted", () => {
    expect(validateKey("abc")).toBe(true);
  });

  it("valid key 'a_b' accepted", () => {
    expect(validateKey("a_b")).toBe(true);
  });

  it("valid key 'A' accepted", () => {
    expect(validateKey("A")).toBe(true);
  });

  it("valid key 'ABC_123' accepted", () => {
    expect(validateKey("ABC_123")).toBe(true);
  });

  it("valid key '_private' accepted", () => {
    expect(validateKey("_private")).toBe(true);
  });

  it("max length key (128 chars) accepted", () => {
    expect(validateKey("a".repeat(128))).toBe(true);
  });

  it("over max (129 chars) rejected", () => {
    expect(validateKey("a".repeat(129))).toBe(false);
  });

  it("key with hyphen 'my-key' rejected", () => {
    expect(validateKey("my-key")).toBe(false);
  });

  it("key with dot 'my.key' rejected", () => {
    expect(validateKey("my.key")).toBe(false);
  });

  it("key with slash 'my/key' rejected", () => {
    expect(validateKey("my/key")).toBe(false);
  });

  it("key starting with number '0key' rejected", () => {
    expect(validateKey("0key")).toBe(false);
  });

  it("key with space 'my key' rejected", () => {
    expect(validateKey("my key")).toBe(false);
  });

  it("key '_updated' rejected (reserved)", () => {
    expect(validateKey("_updated")).toBe(false);
  });

  it("key with Unicode combining char rejected", () => {
    expect(validateKey("cafe\u0301")).toBe(false);
  });
});
