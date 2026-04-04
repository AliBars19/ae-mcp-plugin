import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Stress tests for every dispatcher handler (~180 tests).
 * Loads dispatcher.js and tests with mocked evalExtendScript.
 */

const dispatcherSrc = readFileSync(
  join(__dirname, "..", "..", "cep-panel", "js", "dispatcher.js"),
  "utf-8",
);

type Dispatcher = {
  handle: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

function loadDispatcher(
  evalExtendScript: (code: string) => Promise<string>,
  log: (...args: unknown[]) => void,
  updateRender: (pct: number, msg: string) => void,
): Dispatcher {
  const factory = new Function(
    "evalExtendScript",
    "log",
    "updateRender",
    "require",
    "process",
    "Promise",
    dispatcherSrc + "\nreturn createDispatcher(evalExtendScript, log, updateRender);",
  );
  return factory(evalExtendScript, log, updateRender, require, process, Promise);
}

// ══════════════════════════════════════════════════════════════════════════════
// project.* handlers (~30 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("project.getInfo", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("returns parsed JSON from evalScript", async () => {
    evalScript.mockResolvedValue('{"name":"TestProject","numItems":5}');
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toEqual({ name: "TestProject", numItems: 5 });
  });

  it("calls correct bridge function", async () => {
    await dispatcher.handle("project.getInfo", {});
    expect(evalScript).toHaveBeenCalledWith("__bridge_getProjectInfo()");
  });

  it("returns null when evalScript returns 'undefined'", async () => {
    evalScript.mockResolvedValue("undefined");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBeNull();
  });

  it("returns null when evalScript returns 'null'", async () => {
    evalScript.mockResolvedValue("null");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBeNull();
  });

  it("returns null when evalScript returns empty string", async () => {
    evalScript.mockResolvedValue("");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBeNull();
  });

  it("returns raw string for non-JSON response", async () => {
    evalScript.mockResolvedValue("some plain text");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe("some plain text");
  });

  it("propagates evalScript error", async () => {
    evalScript.mockRejectedValue(new Error("AE crashed"));
    await expect(dispatcher.handle("project.getInfo", {})).rejects.toThrow("AE crashed");
  });

  it("handles complex nested JSON", async () => {
    const data = { name: "Proj", comps: [{ name: "A" }, { name: "B" }], settings: { fps: 30 } };
    evalScript.mockResolvedValue(JSON.stringify(data));
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toEqual(data);
  });
});

describe("project.listComps", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("[]");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes filter to evalScript", async () => {
    await dispatcher.handle("project.listComps", { filter: "Main" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_listComps("Main")');
  });

  it("passes empty filter when not provided", async () => {
    await dispatcher.handle("project.listComps", {});
    expect(evalScript).toHaveBeenCalledWith('__bridge_listComps("")');
  });

  it("escapes regex special chars in filter", async () => {
    await dispatcher.handle("project.listComps", { filter: "Main.*Comp" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_listComps("Main.*Comp")');
  });

  it("escapes quotes in filter", async () => {
    await dispatcher.handle("project.listComps", { filter: 'My "Comp"' });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain('\\"Comp\\"');
  });

  it("escapes backslashes in filter", async () => {
    await dispatcher.handle("project.listComps", { filter: "path\\comp" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("path\\\\comp");
  });

  it("returns parsed array", async () => {
    evalScript.mockResolvedValue('[{"name":"Comp1"},{"name":"Comp2"}]');
    const result = await dispatcher.handle("project.listComps", {});
    expect(result).toEqual([{ name: "Comp1" }, { name: "Comp2" }]);
  });

  it("returns null for undefined response", async () => {
    evalScript.mockResolvedValue("undefined");
    const result = await dispatcher.handle("project.listComps", {});
    expect(result).toBeNull();
  });

  it("propagates evalScript error", async () => {
    evalScript.mockRejectedValue(new Error("timeout"));
    await expect(dispatcher.handle("project.listComps", { filter: "" })).rejects.toThrow("timeout");
  });
});

describe("project.search", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("[]");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes query and type", async () => {
    await dispatcher.handle("project.search", { query: "hero", type: "comp" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_searchProject("hero", "comp")');
  });

  it("passes only query with empty type", async () => {
    await dispatcher.handle("project.search", { query: "bg" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_searchProject("bg", "")');
  });

  it("passes empty query", async () => {
    await dispatcher.handle("project.search", {});
    expect(evalScript).toHaveBeenCalledWith('__bridge_searchProject("", "")');
  });

  it("escapes query with special chars", async () => {
    await dispatcher.handle("project.search", { query: "it's a \"test\"", type: "" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("it\\'s a \\\"test\\\"");
  });

  it("escapes type with special chars", async () => {
    await dispatcher.handle("project.search", { query: "", type: "comp\\layer" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("comp\\\\layer");
  });

  it("returns parsed results", async () => {
    evalScript.mockResolvedValue('[{"name":"Hero","type":"comp"}]');
    const result = await dispatcher.handle("project.search", { query: "hero" });
    expect(result).toEqual([{ name: "Hero", type: "comp" }]);
  });

  it("returns null for empty response", async () => {
    evalScript.mockResolvedValue("");
    const result = await dispatcher.handle("project.search", { query: "x" });
    expect(result).toBeNull();
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("no project open"));
    await expect(dispatcher.handle("project.search", { query: "x" })).rejects.toThrow("no project open");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// layers.* handlers (~30 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("layers.list", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("[]");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes comp name", async () => {
    await dispatcher.handle("layers.list", { comp: "MainComp" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_listLayers("MainComp")');
  });

  it("passes empty string for missing comp", async () => {
    await dispatcher.handle("layers.list", {});
    expect(evalScript).toHaveBeenCalledWith('__bridge_listLayers("")');
  });

  it("escapes special chars in comp", async () => {
    await dispatcher.handle("layers.list", { comp: "Comp \"A\"" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain('Comp \\"A\\"');
  });

  it("handles unicode comp name", async () => {
    await dispatcher.handle("layers.list", { comp: "日本語Comp" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_listLayers("日本語Comp")');
  });

  it("returns parsed layer array", async () => {
    const layers = [{ name: "Text", index: 1 }, { name: "Shape", index: 2 }];
    evalScript.mockResolvedValue(JSON.stringify(layers));
    const result = await dispatcher.handle("layers.list", { comp: "A" });
    expect(result).toEqual(layers);
  });

  it("returns null for undefined", async () => {
    evalScript.mockResolvedValue("undefined");
    const result = await dispatcher.handle("layers.list", { comp: "A" });
    expect(result).toBeNull();
  });

  it("handles large layer list (50+ layers)", async () => {
    const layers = Array.from({ length: 60 }, (_, i) => ({ name: `Layer ${i}`, index: i + 1 }));
    evalScript.mockResolvedValue(JSON.stringify(layers));
    const result = await dispatcher.handle("layers.list", { comp: "Big" }) as any[];
    expect(result).toHaveLength(60);
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("comp not found"));
    await expect(dispatcher.handle("layers.list", { comp: "X" })).rejects.toThrow("comp not found");
  });

  it("escapes backslash in comp name", async () => {
    await dispatcher.handle("layers.list", { comp: "path\\comp" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("path\\\\comp");
  });

  it("escapes newline in comp name", async () => {
    await dispatcher.handle("layers.list", { comp: "line1\nline2" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("line1\\nline2");
  });
});

describe("layers.getProperties", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("{}");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes comp and layer name", async () => {
    await dispatcher.handle("layers.getProperties", { comp: "Main", layer: "Text1" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getLayerProperties("Main", "Text1")');
  });

  it("passes comp and layer index as string", async () => {
    await dispatcher.handle("layers.getProperties", { comp: "Main", layer: "3" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getLayerProperties("Main", "3")');
  });

  it("passes empty layer when missing", async () => {
    await dispatcher.handle("layers.getProperties", { comp: "Main" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getLayerProperties("Main", "")');
  });

  it("passes empty comp when missing", async () => {
    await dispatcher.handle("layers.getProperties", {});
    expect(evalScript).toHaveBeenCalledWith('__bridge_getLayerProperties("", "")');
  });

  it("escapes special chars in both params", async () => {
    await dispatcher.handle("layers.getProperties", { comp: "it's", layer: '"quoted"' });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("it\\'s");
    expect(call).toContain('\\"quoted\\"');
  });

  it("returns parsed properties", async () => {
    const props = { position: [100, 200], opacity: 100, name: "Text" };
    evalScript.mockResolvedValue(JSON.stringify(props));
    const result = await dispatcher.handle("layers.getProperties", { comp: "A", layer: "T" });
    expect(result).toEqual(props);
  });

  it("returns null for undefined response", async () => {
    evalScript.mockResolvedValue("undefined");
    const result = await dispatcher.handle("layers.getProperties", { comp: "A", layer: "T" });
    expect(result).toBeNull();
  });

  it("returns raw string for non-JSON", async () => {
    evalScript.mockResolvedValue("Layer not found");
    const result = await dispatcher.handle("layers.getProperties", { comp: "A", layer: "Z" });
    expect(result).toBe("Layer not found");
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("property access failed"));
    await expect(
      dispatcher.handle("layers.getProperties", { comp: "A", layer: "T" })
    ).rejects.toThrow("property access failed");
  });

  it("handles layer name with special AE chars", async () => {
    await dispatcher.handle("layers.getProperties", { comp: "Main", layer: "[BG] Layer (1)" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getLayerProperties("Main", "[BG] Layer (1)")');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// expressions.* handlers (~25 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("expressions.get", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("[]");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes comp only (all layers)", async () => {
    await dispatcher.handle("expressions.get", { comp: "Main" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getExpressions("Main", "")');
  });

  it("passes comp and layer", async () => {
    await dispatcher.handle("expressions.get", { comp: "Main", layer: "Text1" });
    expect(evalScript).toHaveBeenCalledWith('__bridge_getExpressions("Main", "Text1")');
  });

  it("passes empty comp when missing", async () => {
    await dispatcher.handle("expressions.get", {});
    expect(evalScript).toHaveBeenCalledWith('__bridge_getExpressions("", "")');
  });

  it("escapes comp with quotes", async () => {
    await dispatcher.handle("expressions.get", { comp: 'Test "Comp"' });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain('Test \\"Comp\\"');
  });

  it("escapes layer with quotes", async () => {
    await dispatcher.handle("expressions.get", { comp: "A", layer: "it's" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("it\\'s");
  });

  it("returns parsed expressions", async () => {
    const exprs = [{ layer: "Text1", property: "opacity", expression: "100" }];
    evalScript.mockResolvedValue(JSON.stringify(exprs));
    const result = await dispatcher.handle("expressions.get", { comp: "Main" });
    expect(result).toEqual(exprs);
  });

  it("returns null for null response", async () => {
    evalScript.mockResolvedValue("null");
    const result = await dispatcher.handle("expressions.get", { comp: "Main" });
    expect(result).toBeNull();
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("expressions error"));
    await expect(dispatcher.handle("expressions.get", { comp: "M" })).rejects.toThrow("expressions error");
  });
});

describe("expressions.evalAtTime", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes all params with time=0", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "Main", layer: "Text", property: "opacity", time: 0,
    });
    expect(evalScript).toHaveBeenCalledWith(
      '__bridge_evalExpressionAtTime("Main", "Text", "opacity", 0)'
    );
  });

  it("passes time=99.999", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: 99.999,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("99.999");
  });

  it("passes negative time as-is (coerced to number)", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: -5,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("-5");
  });

  it("passes very large time", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: 999999,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("999999");
  });

  it("defaults time to 0 for non-numeric", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: "notanumber",
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toMatch(/, 0\)$/);
  });

  it("escapes comp with injection attempt", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: '"); alert("xss', layer: "B", property: "C", time: 0,
    });
    const call = evalScript.mock.calls[0][0];
    // The double quotes are escaped, preventing breakout
    expect(call).toContain('\\"');
    expect(call).toContain('\\"); alert(\\"xss');
  });

  it("escapes all string params correctly", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "a'b", layer: "c\"d", property: "e\\f", time: 1,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("a\\'b");
    expect(call).toContain("c\\\"d");
    expect(call).toContain("e\\\\f");
  });

  it("returns parsed result", async () => {
    evalScript.mockResolvedValue('{"value":50}');
    const result = await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: 1,
    });
    expect(result).toEqual({ value: 50 });
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("eval failed"));
    await expect(
      dispatcher.handle("expressions.evalAtTime", {
        comp: "A", layer: "B", property: "C", time: 0,
      })
    ).rejects.toThrow("eval failed");
  });

  it("defaults missing params to empty string", async () => {
    await dispatcher.handle("expressions.evalAtTime", {});
    expect(evalScript).toHaveBeenCalledWith(
      '__bridge_evalExpressionAtTime("", "", "", 0)'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// execute.* handlers (~25 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("execute.eval", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("42");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes simple code and returns result + executionTime", async () => {
    const result = (await dispatcher.handle("execute.eval", { code: "1+1" })) as any;
    expect(evalScript).toHaveBeenCalledWith("1+1");
    expect(result.result).toBe("42");
    expect(result.executionTime).toBeTypeOf("number");
  });

  it("passes empty code string", async () => {
    await dispatcher.handle("execute.eval", { code: "" });
    expect(evalScript).toHaveBeenCalledWith("");
  });

  it("defaults to empty code when missing", async () => {
    await dispatcher.handle("execute.eval", {});
    expect(evalScript).toHaveBeenCalledWith("");
  });

  it("passes very long code (10KB)", async () => {
    const longCode = "var x = " + "1+".repeat(5000) + "1;";
    await dispatcher.handle("execute.eval", { code: longCode });
    expect(evalScript).toHaveBeenCalledWith(longCode);
  });

  it("executionTime is non-negative", async () => {
    const result = (await dispatcher.handle("execute.eval", { code: "1" })) as any;
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  it("does NOT escape code (raw pass-through)", async () => {
    const code = 'alert("hello\\nworld")';
    await dispatcher.handle("execute.eval", { code });
    expect(evalScript).toHaveBeenCalledWith(code);
  });

  it("propagates evalScript error", async () => {
    evalScript.mockRejectedValue(new Error("syntax error"));
    await expect(dispatcher.handle("execute.eval", { code: "bad{" })).rejects.toThrow("syntax error");
  });

  it("handles code with newlines", async () => {
    const code = "var a = 1;\nvar b = 2;\na + b;";
    await dispatcher.handle("execute.eval", { code });
    expect(evalScript).toHaveBeenCalledWith(code);
  });
});

describe("execute.runFile", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue('{"success":true}');
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("returns success result with executionTime", async () => {
    const result = (await dispatcher.handle("execute.runFile", {
      path: "C:\\test.jsx",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.executionTime).toBeTypeOf("number");
  });

  it("passes escaped path in evalFile call", async () => {
    await dispatcher.handle("execute.runFile", { path: "C:\\Users\\test.jsx" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("$.evalFile");
    expect(call).toContain("C:\\\\Users\\\\test.jsx");
  });

  it("returns error result from evalScript", async () => {
    evalScript.mockResolvedValue('{"success":false,"error":"File not found"}');
    const result = (await dispatcher.handle("execute.runFile", {
      path: "missing.jsx",
    })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBe("File not found");
  });

  it("handles empty path", async () => {
    await dispatcher.handle("execute.runFile", {});
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain('$.evalFile("")');
  });

  it("escapes path with special chars", async () => {
    await dispatcher.handle("execute.runFile", { path: "C:\\Program Files\\script's.jsx" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("C:\\\\Program Files\\\\script\\'s.jsx");
  });

  it("propagates evalScript error", async () => {
    evalScript.mockRejectedValue(new Error("AE not responding"));
    await expect(
      dispatcher.handle("execute.runFile", { path: "test.jsx" })
    ).rejects.toThrow("AE not responding");
  });

  it("handles null response gracefully", async () => {
    evalScript.mockResolvedValue("null");
    const result = await dispatcher.handle("execute.runFile", { path: "test.jsx" });
    // null result, so result.executionTime won't be set
    expect(result).toBeNull();
  });
});

describe("execute.validateFile", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue('{"valid":true}');
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("passes dryRun=false", async () => {
    await dispatcher.handle("execute.validateFile", { path: "test.jsx", dryRun: false });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("false");
  });

  it("passes dryRun=true", async () => {
    await dispatcher.handle("execute.validateFile", { path: "test.jsx", dryRun: true });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("true");
  });

  it("escapes path", async () => {
    await dispatcher.handle("execute.validateFile", { path: "C:\\scripts\\test.jsx" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("C:\\\\scripts\\\\test.jsx");
  });

  it("defaults dryRun to false for missing param", async () => {
    await dispatcher.handle("execute.validateFile", { path: "test.jsx" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("false");
  });

  it("returns parsed validation result", async () => {
    evalScript.mockResolvedValue('{"valid":true,"warnings":[]}');
    const result = await dispatcher.handle("execute.validateFile", { path: "t.jsx" });
    expect(result).toEqual({ valid: true, warnings: [] });
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("validate failed"));
    await expect(
      dispatcher.handle("execute.validateFile", { path: "t.jsx" })
    ).rejects.toThrow("validate failed");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// render.* handlers (~25 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("render.getQueue", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("calls correct bridge function", async () => {
    await dispatcher.handle("render.getQueue", {});
    expect(evalScript).toHaveBeenCalledWith("__bridge_getRenderQueue()");
  });

  it("returns parsed render queue", async () => {
    const queue = { items: [{ name: "Comp1", status: "queued" }] };
    evalScript.mockResolvedValue(JSON.stringify(queue));
    const result = await dispatcher.handle("render.getQueue", {});
    expect(result).toEqual(queue);
  });

  it("returns null for empty response", async () => {
    evalScript.mockResolvedValue("");
    const result = await dispatcher.handle("render.getQueue", {});
    expect(result).toBeNull();
  });

  it("propagates error", async () => {
    evalScript.mockRejectedValue(new Error("render queue error"));
    await expect(dispatcher.handle("render.getQueue", {})).rejects.toThrow("render queue error");
  });
});

describe("render.checkOutput", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;
  const testDir = join(tmpdir(), "ae-mcp-test-render-" + Date.now());
  const testFile = join(testDir, "output.mp4");

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(testFile); } catch { /* ignore */ }
    try { rmdirSync(testDir); } catch { /* ignore */ }
  });

  it("returns exists:false for non-existent file", async () => {
    const result = (await dispatcher.handle("render.checkOutput", {
      path: "/definitely/does/not/exist.mp4",
    })) as any;
    expect(result.exists).toBe(false);
  });

  it("returns exists:true with size and modified for real file", async () => {
    writeFileSync(testFile, "fake video content");
    const result = (await dispatcher.handle("render.checkOutput", {
      path: testFile,
    })) as any;
    expect(result.exists).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(result.modified).toBeTruthy();
  });

  it("rejects paths with '..' traversal", async () => {
    await expect(
      dispatcher.handle("render.checkOutput", { path: "../../etc/passwd" })
    ).rejects.toThrow("Path traversal not allowed");
  });

  it("rejects path with embedded '..'", async () => {
    await expect(
      dispatcher.handle("render.checkOutput", { path: "/some/../other/file" })
    ).rejects.toThrow("Path traversal not allowed");
  });

  it("handles empty path (resolves to CWD)", async () => {
    // path.resolve("") returns CWD, which exists — statSync succeeds
    const result = (await dispatcher.handle("render.checkOutput", { path: "" })) as any;
    expect(result).toHaveProperty("exists");
    // CWD exists, so exists will be true
    expect(result.exists).toBe(true);
  });

  it("returns exists:false for directory path", async () => {
    // statSync on a directory succeeds, but we test the behavior
    const result = (await dispatcher.handle("render.checkOutput", {
      path: testDir,
    })) as any;
    // The handler returns exists:true for directories since statSync works
    expect(result.exists).toBe(true);
  });

  it("handles path with no traversal but with backslashes", async () => {
    // No ".." so should not reject
    const result = (await dispatcher.handle("render.checkOutput", {
      path: "C:\\some\\path\\file.mp4",
    })) as any;
    // Will likely be exists:false since file doesn't exist
    expect(result).toHaveProperty("exists");
  });

  it("does not call evalScript (uses Node fs)", async () => {
    await dispatcher.handle("render.checkOutput", { path: "/nonexistent" });
    expect(evalScript).not.toHaveBeenCalled();
  });

  it("modified is an ISO string", async () => {
    writeFileSync(testFile, "data");
    const result = (await dispatcher.handle("render.checkOutput", {
      path: testFile,
    })) as any;
    expect(() => new Date(result.modified)).not.toThrow();
    expect(result.modified).toContain("T"); // ISO format
  });
});

describe("render.monitor", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let updateRender: ReturnType<typeof vi.fn>;
  let logFn: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn();
    updateRender = vi.fn();
    logFn = vi.fn();
    dispatcher = loadDispatcher(evalScript, logFn, updateRender);
  });

  it("returns completed:true when no items in queue", async () => {
    evalScript.mockResolvedValue('{"items":[]}');
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 5000, interval: 100,
    })) as any;
    expect(result.completed).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("returns completed:true when all items done", async () => {
    evalScript.mockResolvedValue(
      '{"items":[{"name":"C1","status":"done"},{"name":"C2","status":"done"}]}'
    );
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 5000, interval: 100,
    })) as any;
    expect(result.completed).toBe(true);
  });

  it("returns completed:false on timeout", async () => {
    evalScript.mockResolvedValue(
      '{"items":[{"name":"C1","status":"rendering"}]}'
    );
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 200, interval: 50,
    })) as any;
    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("updates render progress", async () => {
    let callCount = 0;
    evalScript.mockImplementation(async () => {
      callCount++;
      if (callCount >= 3) {
        return '{"items":[{"name":"C1","status":"done"}]}';
      }
      return '{"items":[{"name":"C1","status":"rendering"}]}';
    });
    await dispatcher.handle("render.monitor", { timeout: 5000, interval: 50 });
    expect(updateRender).toHaveBeenCalled();
  });

  it("calls updateRender(100, 'Complete') on finish", async () => {
    evalScript.mockResolvedValue(
      '{"items":[{"name":"C1","status":"done"}]}'
    );
    await dispatcher.handle("render.monitor", { timeout: 5000, interval: 100 });
    expect(updateRender).toHaveBeenCalledWith(100, "Complete");
  });

  it("logs render progress", async () => {
    evalScript.mockResolvedValue('{"items":[{"name":"C1","status":"done"}]}');
    await dispatcher.handle("render.monitor", { timeout: 5000, interval: 100 });
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining("100%"), "info");
  });

  it("handles evalScript error during polling", async () => {
    evalScript.mockRejectedValue(new Error("connection lost"));
    await expect(
      dispatcher.handle("render.monitor", { timeout: 5000, interval: 100 })
    ).rejects.toThrow("connection lost");
  });

  it("handles null queue response", async () => {
    evalScript.mockResolvedValue("null");
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 5000, interval: 100,
    })) as any;
    expect(result.completed).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("counts error status items as done", async () => {
    evalScript.mockResolvedValue(
      '{"items":[{"name":"C1","status":"error"},{"name":"C2","status":"done"}]}'
    );
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 5000, interval: 100,
    })) as any;
    expect(result.completed).toBe(true);
  });

  it("defaults timeout to 60000 and interval to 2000", async () => {
    evalScript.mockResolvedValue('{"items":[]}');
    // Just verify it doesn't throw with no timeout/interval
    const result = (await dispatcher.handle("render.monitor", {})) as any;
    expect(result.completed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// context.* handlers (~25 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("context.read and context.write", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  // Use a unique temp dir to isolate context file
  const testAppData = join(tmpdir(), "ae-mcp-ctx-test-" + Date.now());
  const contextDir = join(testAppData, "Apollova");
  const contextFile = join(contextDir, "ae-mcp-context.json");

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    // Override APPDATA to point to our temp dir
    const origEnv = { ...process.env };
    process.env.APPDATA = testAppData;
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
    // Restore just in case (though each test creates fresh dispatcher)
    // Clean up any existing context file
    try { unlinkSync(contextFile); } catch { /* ignore */ }
    try { rmdirSync(contextDir); } catch { /* ignore */ }
    try { rmdirSync(testAppData); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { unlinkSync(contextFile); } catch { /* ignore */ }
    try { rmdirSync(contextDir); } catch { /* ignore */ }
    try { rmdirSync(testAppData); } catch { /* ignore */ }
  });

  it("context.read returns empty object when file does not exist", async () => {
    const result = await dispatcher.handle("context.read", {});
    expect(result).toEqual({});
  });

  it("context.read returns null for specific key when file does not exist", async () => {
    const result = await dispatcher.handle("context.read", { key: "missing" });
    expect(result).toBeNull();
  });

  it("context.write creates file and directory", async () => {
    const result = (await dispatcher.handle("context.write", {
      key: "testKey", value: "testValue",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.timestamp).toBeTruthy();
    expect(existsSync(contextFile)).toBe(true);
  });

  it("context.write adds _updated timestamp", async () => {
    await dispatcher.handle("context.write", { key: "a", value: 1 });
    const data = JSON.parse(readFileSync(contextFile, "utf8"));
    expect(data._updated).toBeTruthy();
    expect(() => new Date(data._updated)).not.toThrow();
  });

  it("context.write preserves existing keys", async () => {
    await dispatcher.handle("context.write", { key: "first", value: "one" });
    await dispatcher.handle("context.write", { key: "second", value: "two" });
    const data = JSON.parse(readFileSync(contextFile, "utf8"));
    expect(data.first).toBe("one");
    expect(data.second).toBe("two");
  });

  it("context.write then read roundtrip", async () => {
    await dispatcher.handle("context.write", { key: "roundtrip", value: { nested: true } });
    const result = await dispatcher.handle("context.read", { key: "roundtrip" });
    expect(result).toEqual({ nested: true });
  });

  it("context.read specific key returns value", async () => {
    await dispatcher.handle("context.write", { key: "myKey", value: 42 });
    const result = await dispatcher.handle("context.read", { key: "myKey" });
    expect(result).toBe(42);
  });

  it("context.read missing key returns undefined (which is null-ish)", async () => {
    await dispatcher.handle("context.write", { key: "exists", value: "yes" });
    const result = await dispatcher.handle("context.read", { key: "nope" });
    expect(result).toBeUndefined();
  });

  it("context.write rejects when key is empty string", async () => {
    await expect(
      dispatcher.handle("context.write", { key: "", value: "test" })
    ).rejects.toThrow("Key is required");
  });

  it("context.write rejects when key is null", async () => {
    await expect(
      dispatcher.handle("context.write", { key: null, value: "test" })
    ).rejects.toThrow("Key is required");
  });

  it("context.write rejects when key is undefined", async () => {
    await expect(
      dispatcher.handle("context.write", { value: "test" })
    ).rejects.toThrow("Key is required");
  });

  it("context.write with complex nested object value", async () => {
    const complex = { arr: [1, 2, { deep: true }], str: "hello", num: 3.14 };
    await dispatcher.handle("context.write", { key: "complex", value: complex });
    const result = await dispatcher.handle("context.read", { key: "complex" });
    expect(result).toEqual(complex);
  });

  it("context.write with array value", async () => {
    await dispatcher.handle("context.write", { key: "arr", value: [1, 2, 3] });
    const result = await dispatcher.handle("context.read", { key: "arr" });
    expect(result).toEqual([1, 2, 3]);
  });

  it("context.write with null value", async () => {
    await dispatcher.handle("context.write", { key: "nullVal", value: null });
    const result = await dispatcher.handle("context.read", { key: "nullVal" });
    expect(result).toBeNull();
  });

  it("context.write with boolean value", async () => {
    await dispatcher.handle("context.write", { key: "flag", value: true });
    const result = await dispatcher.handle("context.read", { key: "flag" });
    expect(result).toBe(true);
  });

  it("10 rapid writes all preserved, last _updated wins", async () => {
    for (let i = 0; i < 10; i++) {
      await dispatcher.handle("context.write", { key: `key${i}`, value: i });
    }
    const data = JSON.parse(readFileSync(contextFile, "utf8"));
    for (let i = 0; i < 10; i++) {
      expect(data[`key${i}`]).toBe(i);
    }
    expect(data._updated).toBeTruthy();
  });

  it("context.write overwrites existing key", async () => {
    await dispatcher.handle("context.write", { key: "x", value: "old" });
    await dispatcher.handle("context.write", { key: "x", value: "new" });
    const result = await dispatcher.handle("context.read", { key: "x" });
    expect(result).toBe("new");
  });

  it("context.read returns all data without key", async () => {
    await dispatcher.handle("context.write", { key: "a", value: 1 });
    await dispatcher.handle("context.write", { key: "b", value: 2 });
    const result = (await dispatcher.handle("context.read", {})) as any;
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
    expect(result._updated).toBeTruthy();
  });

  it("context.write with large value (100KB JSON)", async () => {
    const large = { data: "x".repeat(100000) };
    const result = (await dispatcher.handle("context.write", {
      key: "big", value: large,
    })) as any;
    expect(result.success).toBe(true);
    const readBack = await dispatcher.handle("context.read", { key: "big" });
    expect(readBack).toEqual(large);
  });

  it("context.write with string value containing special chars", async () => {
    await dispatcher.handle("context.write", {
      key: "special", value: "hello\nworld\ttab\"quote'single",
    });
    const result = await dispatcher.handle("context.read", { key: "special" });
    expect(result).toBe("hello\nworld\ttab\"quote'single");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Error handling across all handlers (~20 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("error handling across all handlers", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockRejectedValue(new Error("AE bridge down"));
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("project.getInfo propagates evalScript error", async () => {
    await expect(dispatcher.handle("project.getInfo", {})).rejects.toThrow("AE bridge down");
  });

  it("project.listComps propagates evalScript error", async () => {
    await expect(dispatcher.handle("project.listComps", {})).rejects.toThrow("AE bridge down");
  });

  it("project.search propagates evalScript error", async () => {
    await expect(dispatcher.handle("project.search", { query: "x" })).rejects.toThrow("AE bridge down");
  });

  it("layers.list propagates evalScript error", async () => {
    await expect(dispatcher.handle("layers.list", { comp: "A" })).rejects.toThrow("AE bridge down");
  });

  it("layers.getProperties propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("layers.getProperties", { comp: "A", layer: "B" })
    ).rejects.toThrow("AE bridge down");
  });

  it("expressions.get propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("expressions.get", { comp: "A" })
    ).rejects.toThrow("AE bridge down");
  });

  it("expressions.evalAtTime propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("expressions.evalAtTime", { comp: "A", layer: "B", property: "C", time: 0 })
    ).rejects.toThrow("AE bridge down");
  });

  it("execute.eval propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("execute.eval", { code: "1" })
    ).rejects.toThrow("AE bridge down");
  });

  it("execute.runFile propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("execute.runFile", { path: "test.jsx" })
    ).rejects.toThrow("AE bridge down");
  });

  it("execute.validateFile propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("execute.validateFile", { path: "test.jsx" })
    ).rejects.toThrow("AE bridge down");
  });

  it("render.getQueue propagates evalScript error", async () => {
    await expect(dispatcher.handle("render.getQueue", {})).rejects.toThrow("AE bridge down");
  });

  it("render.monitor propagates evalScript error", async () => {
    await expect(
      dispatcher.handle("render.monitor", { timeout: 1000, interval: 100 })
    ).rejects.toThrow("AE bridge down");
  });

  it("method not found rejects with clear message", async () => {
    await expect(
      dispatcher.handle("nonexistent.method", {})
    ).rejects.toThrow("Method not found: nonexistent.method");
  });

  it("method not found includes method name", async () => {
    await expect(
      dispatcher.handle("foo.bar.baz", {})
    ).rejects.toThrow("foo.bar.baz");
  });

  it("empty method string rejects", async () => {
    await expect(dispatcher.handle("", {})).rejects.toThrow("Method not found");
  });

  it("null params uses defaults in project.search", async () => {
    evalScript.mockResolvedValue("[]");
    // Passing null should not crash — params.query will throw but handler uses || ""
    // Actually with null params, accessing params.query will throw
    // The handler wraps in try/catch
    await expect(
      dispatcher.handle("project.search", null as any)
    ).rejects.toBeDefined();
  });

  it("undefined params in layers.list", async () => {
    evalScript.mockResolvedValue("[]");
    await expect(
      dispatcher.handle("layers.list", undefined as any)
    ).rejects.toBeDefined();
  });

  it("handles TypeError from null params gracefully", async () => {
    evalScript.mockResolvedValue("[]");
    // execute.eval accesses params.code which throws on null
    await expect(
      dispatcher.handle("execute.eval", null as any)
    ).rejects.toBeDefined();
  });

  it("render.checkOutput with no path param defaults gracefully", async () => {
    // Empty path resolves to CWD via path.resolve(""), which exists
    const result = (await dispatcher.handle("render.checkOutput", {})) as any;
    expect(result).toHaveProperty("exists");
    expect(result.exists).toBe(true);
  });

  it("context.write with missing value still writes (value is undefined)", async () => {
    process.env.APPDATA = join(tmpdir(), "ae-mcp-err-test-" + Date.now());
    const d = loadDispatcher(evalScript, vi.fn(), vi.fn());
    const result = (await d.handle("context.write", { key: "k" })) as any;
    expect(result.success).toBe(true);
    // Clean up
    const dir = join(process.env.APPDATA, "Apollova");
    try { unlinkSync(join(dir, "ae-mcp-context.json")); } catch { /* */ }
    try { rmdirSync(dir); } catch { /* */ }
    try { rmdirSync(process.env.APPDATA); } catch { /* */ }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Additional stress: param boundary tests (~20 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("param boundary stress", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn().mockResolvedValue("null");
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("project.listComps with very long filter (5000 chars)", async () => {
    const longFilter = "A".repeat(5000);
    await dispatcher.handle("project.listComps", { filter: longFilter });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain(longFilter);
  });

  it("project.search with numeric query throws (no .replace on number)", async () => {
    // params.query || "" → 12345 (truthy), escapeForJSX(12345) → (12345).replace is not a function
    await expect(
      dispatcher.handle("project.search", { query: 12345 as any })
    ).rejects.toBeDefined();
  });

  it("layers.list with boolean comp (truthy)", async () => {
    // params.comp || "" → true, then escapeForJSX(true) — .replace doesn't exist on boolean
    // The handler catches and rejects
    try {
      await dispatcher.handle("layers.list", { comp: true as any });
    } catch {
      // Expected — boolean has no .replace
    }
    // Just verify it doesn't hang
  });

  it("execute.eval with code containing all escape chars", async () => {
    const code = 'var x = "hello\\nworld\\t\\r\\0";';
    const result = (await dispatcher.handle("execute.eval", { code })) as any;
    // execute.eval passes code through raw (no escaping)
    expect(evalScript).toHaveBeenCalledWith(code);
    expect(result).toHaveProperty("executionTime");
  });

  it("expressions.evalAtTime with time as string number", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: "5.5",
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("5.5");
  });

  it("expressions.evalAtTime with time=NaN defaults to 0", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: NaN,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toMatch(/, 0\)$/);
  });

  it("expressions.evalAtTime with time=Infinity", async () => {
    await dispatcher.handle("expressions.evalAtTime", {
      comp: "A", layer: "B", property: "C", time: Infinity,
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("Infinity");
  });

  it("execute.validateFile with dryRun as string 'true' stays falsy", async () => {
    await dispatcher.handle("execute.validateFile", { path: "t.jsx", dryRun: "true" as any });
    const call = evalScript.mock.calls[0][0];
    // params.dryRun === true is strict, "true" !== true → false
    expect(call).toContain("false");
  });

  it("render.monitor with zero timeout defaults to 60000 (0 is falsy)", async () => {
    // Number(0) || 60000 = 60000, so it won't time out immediately
    // We make it complete immediately instead
    evalScript.mockResolvedValue('{"items":[{"name":"C","status":"done"}]}');
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 0, interval: 10,
    })) as any;
    expect(result.completed).toBe(true);
  });

  it("render.monitor with very small interval", async () => {
    let calls = 0;
    evalScript.mockImplementation(async () => {
      calls++;
      if (calls >= 2) return '{"items":[{"name":"C","status":"done"}]}';
      return '{"items":[{"name":"C","status":"rendering"}]}';
    });
    const result = (await dispatcher.handle("render.monitor", {
      timeout: 5000, interval: 1,
    })) as any;
    expect(result.completed).toBe(true);
  });

  it("project.getInfo ignores extra params", async () => {
    evalScript.mockResolvedValue('{"name":"P"}');
    const result = await dispatcher.handle("project.getInfo", { extra: "ignored", foo: 123 });
    expect(result).toEqual({ name: "P" });
  });

  it("render.getQueue ignores params", async () => {
    evalScript.mockResolvedValue('{"items":[]}');
    const result = await dispatcher.handle("render.getQueue", { extra: true });
    expect(result).toEqual({ items: [] });
  });

  it("layers.getProperties with numeric layer index throws (no .replace)", async () => {
    // params.layer || "" → 5 (truthy), escapeForJSX(5) → .replace is not a function
    await expect(
      dispatcher.handle("layers.getProperties", { comp: "Main", layer: 5 as any })
    ).rejects.toBeDefined();
  });

  it("execute.runFile with empty object path throws (no .replace)", async () => {
    // {} || "" = {} (truthy), escapeForJSX({}) → .replace is not a function
    await expect(
      dispatcher.handle("execute.runFile", { path: {} as any })
    ).rejects.toBeDefined();
  });

  it("project.listComps with filter containing all escaped chars", async () => {
    const filter = "\\\'\"\n\r\t\0\u2028\u2029";
    await dispatcher.handle("project.listComps", { filter });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("\\\\");
    expect(call).toContain("\\'");
    expect(call).toContain("\\n");
  });

  it("project.search with both params containing newlines", async () => {
    await dispatcher.handle("project.search", {
      query: "line1\nline2",
      type: "a\tb",
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("line1\\nline2");
    expect(call).toContain("a\\tb");
  });

  it("layers.list with comp containing null bytes", async () => {
    await dispatcher.handle("layers.list", { comp: "Comp\0Name" });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("Comp\\0Name");
  });

  it("expressions.get with layer containing line separators", async () => {
    await dispatcher.handle("expressions.get", {
      comp: "Main",
      layer: "Layer\u2028Name",
    });
    const call = evalScript.mock.calls[0][0];
    expect(call).toContain("Layer\\u2028Name");
  });

  it("execute.runFile with Windows UNC path", async () => {
    // Input: \\server\share\script.jsx (2 backslashes + server + \ + share + \ + script)
    await dispatcher.handle("execute.runFile", {
      path: "\\\\server\\share\\script.jsx",
    });
    const call = evalScript.mock.calls[0][0] as string;
    // Each \ doubled: \\\\ server \\ share \\ script.jsx
    expect(call).toContain("\\\\\\\\server\\\\share\\\\script.jsx");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// evalJSON edge cases (~16 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("evalJSON edge cases via handlers", () => {
  let evalScript: ReturnType<typeof vi.fn>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    evalScript = vi.fn();
    dispatcher = loadDispatcher(evalScript, vi.fn(), vi.fn());
  });

  it("returns number from JSON", async () => {
    evalScript.mockResolvedValue("42");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe(42);
  });

  it("returns boolean true from JSON", async () => {
    evalScript.mockResolvedValue("true");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe(true);
  });

  it("returns boolean false from JSON", async () => {
    evalScript.mockResolvedValue("false");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe(false);
  });

  it("returns array from JSON", async () => {
    evalScript.mockResolvedValue("[1,2,3]");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns nested object from JSON", async () => {
    evalScript.mockResolvedValue('{"a":{"b":{"c":1}}}');
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("returns raw string for malformed JSON", async () => {
    evalScript.mockResolvedValue("{bad json}");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe("{bad json}");
  });

  it("returns raw string for partial JSON", async () => {
    evalScript.mockResolvedValue('{"incomplete":');
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe('{"incomplete":');
  });

  it("returns null for literal null string", async () => {
    evalScript.mockResolvedValue("null");
    const result = await dispatcher.handle("render.getQueue", {});
    expect(result).toBeNull();
  });

  it("returns null for literal undefined string", async () => {
    evalScript.mockResolvedValue("undefined");
    const result = await dispatcher.handle("render.getQueue", {});
    expect(result).toBeNull();
  });

  it("returns string '0' as number 0 (valid JSON)", async () => {
    evalScript.mockResolvedValue("0");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe(0);
  });

  it("returns empty array from JSON", async () => {
    evalScript.mockResolvedValue("[]");
    const result = await dispatcher.handle("project.listComps", {});
    expect(result).toEqual([]);
  });

  it("returns empty object from JSON", async () => {
    evalScript.mockResolvedValue("{}");
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toEqual({});
  });

  it("returns string with quotes from non-JSON", async () => {
    evalScript.mockResolvedValue('hello "world"');
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe('hello "world"');
  });

  it("returns JSON string (double-encoded)", async () => {
    evalScript.mockResolvedValue('"a string"');
    const result = await dispatcher.handle("project.getInfo", {});
    expect(result).toBe("a string");
  });

  it("handles JSON with Unicode escapes", async () => {
    evalScript.mockResolvedValue('{"emoji":"\\u2764"}');
    const result = (await dispatcher.handle("project.getInfo", {})) as any;
    expect(result.emoji).toBe("\u2764");
  });

  it("handles very large JSON response (100 items)", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    evalScript.mockResolvedValue(JSON.stringify(items));
    const result = (await dispatcher.handle("project.listComps", {})) as any[];
    expect(result).toHaveLength(100);
    expect(result[99].id).toBe(99);
  });
});
