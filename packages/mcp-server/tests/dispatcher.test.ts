import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tests for the CEP dispatcher logic (packages/cep-panel/js/dispatcher.js).
 *
 * The dispatcher is plain JS that uses `createDispatcher(evalExtendScript, log, updateRender)`.
 * We load it by evaluating the source and calling createDispatcher with mocks.
 */

// Load and evaluate the dispatcher source
const dispatcherSrc = readFileSync(
  join(__dirname, "..", "..", "cep-panel", "js", "dispatcher.js"),
  "utf-8",
);

// createDispatcher is defined as a function declaration in the source.
// We wrap it so it's callable in our test context.
function loadDispatcher(
  evalExtendScript: (code: string) => Promise<string>,
  log: (...args: unknown[]) => void,
  updateRender: (pct: number, msg: string) => void,
) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "evalExtendScript",
    "log",
    "updateRender",
    "require",
    "process",
    "Promise",
    dispatcherSrc + "\nreturn createDispatcher(evalExtendScript, log, updateRender);",
  );
  return factory(evalExtendScript, log, updateRender, require, process, Promise) as {
    handle: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
}

describe("Dispatcher", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;
  let updateRender: ReturnType<typeof vi.fn>;
  let dispatcher: ReturnType<typeof loadDispatcher>;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    log = vi.fn();
    updateRender = vi.fn();
    dispatcher = loadDispatcher(evalScript, log, updateRender);
  });

  // ── Unknown method ──

  it("unknown method rejects with 'Method not found'", async () => {
    await expect(dispatcher.handle("bogus.method", {})).rejects.toThrow(
      /Method not found/,
    );
  });

  // ── project.getInfo ──

  it("project.getInfo calls evalScript with correct function name", async () => {
    evalScript.mockResolvedValue('{"name":"Test"}');
    await dispatcher.handle("project.getInfo", {});
    expect(evalScript).toHaveBeenCalledWith("__bridge_getProjectInfo()");
  });

  // ── project.listComps ──

  it("project.listComps passes filter param", async () => {
    evalScript.mockResolvedValue("[]");
    await dispatcher.handle("project.listComps", { filter: "Main.*" });
    expect(evalScript).toHaveBeenCalledWith(expect.stringContaining("Main.*"));
  });

  // ── layers.list ──

  it("layers.list passes comp param", async () => {
    evalScript.mockResolvedValue("[]");
    await dispatcher.handle("layers.list", { comp: "MyComp" });
    expect(evalScript).toHaveBeenCalledWith(expect.stringContaining("MyComp"));
  });

  // ── execute.eval ──

  it("execute.eval passes code through", async () => {
    evalScript.mockResolvedValue("42");
    const result = await dispatcher.handle("execute.eval", { code: "1+1" });
    expect(evalScript).toHaveBeenCalledWith("1+1");
    expect((result as any).result).toBe("42");
    expect((result as any).executionTime).toBeTypeOf("number");
  });

  // ── render.checkOutput ──

  it("render.checkOutput returns exists:false for missing file", async () => {
    const result = (await dispatcher.handle("render.checkOutput", {
      path: "/nonexistent/file.mp4",
    })) as any;
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── context.write ──

  it("context.write rejects when key is missing", async () => {
    await expect(
      dispatcher.handle("context.write", { value: "test" }),
    ).rejects.toThrow(/Key is required/);
  });

  // ── escapeForJSX ──

  it("escapeForJSX handles special characters in params", async () => {
    evalScript.mockResolvedValue("null");
    await dispatcher.handle("project.listComps", {
      filter: 'He said "hello"',
    });
    const call = evalScript.mock.calls[0][0] as string;
    // Quotes should be escaped
    expect(call).toContain('\\"hello\\"');
  });

  it("escapeForJSX handles backslashes", async () => {
    evalScript.mockResolvedValue("null");
    await dispatcher.handle("layers.list", { comp: "path\\to\\comp" });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("path\\\\to\\\\comp");
  });

  it("escapeForJSX handles newlines", async () => {
    evalScript.mockResolvedValue("null");
    await dispatcher.handle("project.search", {
      query: "line1\nline2",
      type: "",
    });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("line1\\nline2");
  });

  it("escapeForJSX handles single quotes", async () => {
    evalScript.mockResolvedValue("null");
    await dispatcher.handle("layers.list", { comp: "it's" });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("it\\'s");
  });

  // ── execute.runFile ──

  it("execute.runFile passes escaped path", async () => {
    evalScript.mockResolvedValue('{"success":true}');
    await dispatcher.handle("execute.runFile", { path: "C:\\scripts\\test.jsx" });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("$.evalFile");
    expect(call).toContain("C:\\\\scripts\\\\test.jsx");
  });

  // ── expressions.get ──

  it("expressions.get passes comp and optional layer", async () => {
    evalScript.mockResolvedValue("[]");
    await dispatcher.handle("expressions.get", { comp: "MainComp", layer: "Text1" });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("MainComp");
    expect(call).toContain("Text1");
  });

  // ── project.search ──

  it("project.search passes query and type", async () => {
    evalScript.mockResolvedValue("[]");
    await dispatcher.handle("project.search", { query: "hero", type: "comp" });
    const call = evalScript.mock.calls[0][0] as string;
    expect(call).toContain("hero");
    expect(call).toContain("comp");
  });
});
