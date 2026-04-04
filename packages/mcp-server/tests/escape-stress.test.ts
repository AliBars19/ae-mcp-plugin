import { describe, it, expect } from "vitest";

/**
 * Stress tests for the escapeForJSX function from dispatcher.js.
 * Re-implemented here for direct unit testing (~120 tests).
 */

function escapeForJSX(str: string): string {
  if (!str) return "";
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ══════════════════════════════════════════════════════════════════════════════
// Basic Escaping (~20 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("escapeForJSX — basic escaping", () => {
  it("escapes backslash", () => {
    expect(escapeForJSX("\\")).toBe("\\\\");
  });

  it("escapes single quote", () => {
    expect(escapeForJSX("'")).toBe("\\'");
  });

  it("escapes double quote", () => {
    expect(escapeForJSX('"')).toBe('\\"');
  });

  it("escapes newline", () => {
    expect(escapeForJSX("\n")).toBe("\\n");
  });

  it("escapes carriage return", () => {
    expect(escapeForJSX("\r")).toBe("\\r");
  });

  it("escapes tab", () => {
    expect(escapeForJSX("\t")).toBe("\\t");
  });

  it("escapes null byte", () => {
    expect(escapeForJSX("\0")).toBe("\\0");
  });

  it("escapes line separator U+2028", () => {
    expect(escapeForJSX("\u2028")).toBe("\\u2028");
  });

  it("escapes paragraph separator U+2029", () => {
    expect(escapeForJSX("\u2029")).toBe("\\u2029");
  });

  it("escapes ALL special chars combined", () => {
    const input = "\\\'\"\n\r\t\0\u2028\u2029";
    const expected = "\\\\\\'\\\"\\n\\r\\t\\0\\u2028\\u2029";
    expect(escapeForJSX(input)).toBe(expected);
  });

  it("returns empty string for empty input", () => {
    expect(escapeForJSX("")).toBe("");
  });

  it("returns empty string for null (falsy check)", () => {
    expect(escapeForJSX(null as unknown as string)).toBe("");
  });

  it("returns empty string for undefined (falsy check)", () => {
    expect(escapeForJSX(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for 0 (falsy check)", () => {
    expect(escapeForJSX(0 as unknown as string)).toBe("");
  });

  it("leaves plain ASCII unchanged", () => {
    expect(escapeForJSX("hello world")).toBe("hello world");
  });

  it("leaves digits unchanged", () => {
    expect(escapeForJSX("1234567890")).toBe("1234567890");
  });

  it("leaves punctuation unchanged (non-special)", () => {
    expect(escapeForJSX("!@#$%^&*()")).toBe("!@#$%^&*()");
  });

  it("handles single space", () => {
    expect(escapeForJSX(" ")).toBe(" ");
  });

  it("handles very long plain string", () => {
    const long = "a".repeat(10000);
    expect(escapeForJSX(long)).toBe(long);
  });

  it("handles string with only whitespace (non-special)", () => {
    expect(escapeForJSX("   ")).toBe("   ");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Unicode Stress (~30 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("escapeForJSX — unicode stress", () => {
  it("handles emoji (😀)", () => {
    expect(escapeForJSX("😀")).toBe("😀");
  });

  it("handles multiple emoji (🎵🎶🎸)", () => {
    expect(escapeForJSX("🎵🎶🎸")).toBe("🎵🎶🎸");
  });

  it("handles CJK characters (中文测试)", () => {
    expect(escapeForJSX("中文测试")).toBe("中文测试");
  });

  it("handles Arabic (العربية)", () => {
    expect(escapeForJSX("العربية")).toBe("العربية");
  });

  it("handles Hebrew (שלום)", () => {
    expect(escapeForJSX("שלום")).toBe("שלום");
  });

  it("handles Cyrillic (Привет)", () => {
    expect(escapeForJSX("Привет")).toBe("Привет");
  });

  it("handles Thai (สวัสดี)", () => {
    expect(escapeForJSX("สวัสดี")).toBe("สวัสดี");
  });

  it("handles surrogate pair (𝄞 U+1D11E musical symbol)", () => {
    expect(escapeForJSX("𝄞")).toBe("𝄞");
  });

  it("handles surrogate pair (𝕳 mathematical double-struck)", () => {
    expect(escapeForJSX("𝕳")).toBe("𝕳");
  });

  it("handles zero-width space U+200B", () => {
    expect(escapeForJSX("\u200B")).toBe("\u200B");
  });

  it("handles zero-width non-joiner U+200C", () => {
    expect(escapeForJSX("\u200C")).toBe("\u200C");
  });

  it("handles zero-width joiner U+200D", () => {
    expect(escapeForJSX("\u200D")).toBe("\u200D");
  });

  it("handles BOM U+FEFF", () => {
    expect(escapeForJSX("\uFEFF")).toBe("\uFEFF");
  });

  it("handles right-to-left mark U+200F", () => {
    expect(escapeForJSX("\u200F")).toBe("\u200F");
  });

  it("handles left-to-right mark U+200E", () => {
    expect(escapeForJSX("\u200E")).toBe("\u200E");
  });

  it("handles combining diacriticals (e + combining acute = é)", () => {
    const input = "e\u0301"; // e + combining acute accent
    expect(escapeForJSX(input)).toBe("e\u0301");
  });

  it("handles precomposed vs decomposed (é)", () => {
    expect(escapeForJSX("\u00E9")).toBe("\u00E9");
  });

  it("handles musical symbols (𝅘𝅥𝅮)", () => {
    expect(escapeForJSX("𝅘𝅥𝅮")).toBe("𝅘𝅥𝅮");
  });

  it("handles mathematical operators (∑∏∫)", () => {
    expect(escapeForJSX("∑∏∫")).toBe("∑∏∫");
  });

  it("handles full-width characters (ＡＢＣ)", () => {
    expect(escapeForJSX("ＡＢＣ")).toBe("ＡＢＣ");
  });

  it("handles line feed U+000A (\\n)", () => {
    expect(escapeForJSX("\u000A")).toBe("\\n");
  });

  it("handles carriage return U+000D (\\r)", () => {
    expect(escapeForJSX("\u000D")).toBe("\\r");
  });

  it("handles line separator U+2028", () => {
    expect(escapeForJSX("\u2028")).toBe("\\u2028");
  });

  it("handles paragraph separator U+2029", () => {
    expect(escapeForJSX("\u2029")).toBe("\\u2029");
  });

  it("handles NEL U+0085 (passes through unchanged)", () => {
    expect(escapeForJSX("\u0085")).toBe("\u0085");
  });

  it("handles mixed emoji + special chars: Hello 🎵\\nworld", () => {
    expect(escapeForJSX("Hello 🎵\nworld")).toBe("Hello 🎵\\nworld");
  });

  it("handles emoji with skin tone modifier (👋🏽)", () => {
    expect(escapeForJSX("👋🏽")).toBe("👋🏽");
  });

  it("handles flag emoji (🇬🇧)", () => {
    expect(escapeForJSX("🇬🇧")).toBe("🇬🇧");
  });

  it("handles family emoji sequence (👨‍👩‍👧‍👦)", () => {
    expect(escapeForJSX("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
  });

  it("handles Devanagari (हिन्दी)", () => {
    expect(escapeForJSX("हिन्दी")).toBe("हिन्दी");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Injection Prevention (~40 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("escapeForJSX — injection prevention", () => {
  it("escapes classic JS injection: \"); alert(\"xss\"); //", () => {
    const input = '"); alert("xss"); //';
    const result = escapeForJSX(input);
    // All double quotes are escaped, so the raw unescaped " is neutralized
    expect(result).not.toContain('"; ');
    expect(result).toContain('\\"');
    expect(result).toBe('\\"); alert(\\"xss\\"); //');
  });

  it("escapes ExtendScript injection: \"); system.callSystem(\"cmd /c calc\"); //", () => {
    const input = '"); system.callSystem("cmd /c calc"); //';
    const result = escapeForJSX(input);
    // All double quotes are escaped
    expect(result).toContain('\\"');
    expect(result).toBe('\\"); system.callSystem(\\"cmd /c calc\\"); //');
  });

  it("escapes backtick template literal attempt", () => {
    const input = "`${process.env.SECRET}`";
    const result = escapeForJSX(input);
    expect(result).toBe("`${process.env.SECRET}`");
  });

  it("escapes double quote string termination", () => {
    const input = '"';
    expect(escapeForJSX(input)).toBe('\\"');
  });

  it("escapes single quote string termination", () => {
    const input = "'";
    expect(escapeForJSX(input)).toBe("\\'");
  });

  it("escapes escaped double quote (\\\")", () => {
    const input = '\\"';
    expect(escapeForJSX(input)).toBe('\\\\\\"');
  });

  it("escapes escaped single quote (\\')", () => {
    const input = "\\'";
    expect(escapeForJSX(input)).toBe("\\\\\\'");
  });

  it("escapes null byte injection: hello\\0world", () => {
    expect(escapeForJSX("hello\0world")).toBe("hello\\0world");
  });

  it("escapes line separator injection: hello\\u2028world", () => {
    expect(escapeForJSX("hello\u2028world")).toBe("hello\\u2028world");
  });

  it("escapes paragraph separator injection: hello\\u2029world", () => {
    expect(escapeForJSX("hello\u2029world")).toBe("hello\\u2029world");
  });

  it("handles nested escapes: \\\\n becomes \\\\\\\\n", () => {
    // Input is literal backslash + n (not a newline)
    const input = "\\n";
    // Backslash gets doubled, n stays
    expect(escapeForJSX(input)).toBe("\\\\n");
  });

  it("handles double escape: already-escaped \\\\\" → \\\\\\\\\\\"", () => {
    const input = '\\\\"'; // literal: \\"
    // \\ → \\\\ and " → \\"
    expect(escapeForJSX(input)).toBe('\\\\\\\\\\"');
  });

  it("escapes path traversal: ..\\\\..\\\\..\\\\secret.txt", () => {
    const input = "..\\..\\..\\secret.txt";
    expect(escapeForJSX(input)).toBe("..\\\\..\\\\..\\\\secret.txt");
  });

  it("handles unicode escape sequence literal \\u0041 (stays literal)", () => {
    const input = "\\u0041";
    expect(escapeForJSX(input)).toBe("\\\\u0041");
  });

  it("handles hex escape literal \\x41", () => {
    const input = "\\x41";
    expect(escapeForJSX(input)).toBe("\\\\x41");
  });

  it("handles regex special char: dot (.)", () => {
    expect(escapeForJSX(".")).toBe(".");
  });

  it("handles regex special char: asterisk (*)", () => {
    expect(escapeForJSX("*")).toBe("*");
  });

  it("handles regex special char: plus (+)", () => {
    expect(escapeForJSX("+")).toBe("+");
  });

  it("handles regex special char: question mark (?)", () => {
    expect(escapeForJSX("?")).toBe("?");
  });

  it("handles regex special char: open paren (()", () => {
    expect(escapeForJSX("(")).toBe("(");
  });

  it("handles regex special char: close paren ())", () => {
    expect(escapeForJSX(")")).toBe(")");
  });

  it("handles regex special char: open bracket ([)", () => {
    expect(escapeForJSX("[")).toBe("[");
  });

  it("handles regex special char: close bracket (])", () => {
    expect(escapeForJSX("]")).toBe("]");
  });

  it("handles regex special char: open brace ({)", () => {
    expect(escapeForJSX("{")).toBe("{");
  });

  it("handles regex special char: close brace (})", () => {
    expect(escapeForJSX("}")).toBe("}");
  });

  it("handles all regex special chars combined", () => {
    expect(escapeForJSX(".*+?()[]{}|^$")).toBe(".*+?()[]{}|^$");
  });

  it("handles HTML entity &lt;", () => {
    expect(escapeForJSX("&lt;")).toBe("&lt;");
  });

  it("handles HTML entity &gt;", () => {
    expect(escapeForJSX("&gt;")).toBe("&gt;");
  });

  it("handles HTML entity &amp;", () => {
    expect(escapeForJSX("&amp;")).toBe("&amp;");
  });

  it("handles script tag injection", () => {
    const input = "<script>alert(1)</script>";
    expect(escapeForJSX(input)).toBe("<script>alert(1)</script>");
  });

  it("handles multiple injection vectors in one string", () => {
    const input = '"); require("child_process").exec("rm -rf /"); //';
    const result = escapeForJSX(input);
    // All double quotes are escaped with backslash
    expect(result).toContain('\\"');
    expect(result).toBe('\\"); require(\\"child_process\\").exec(\\"rm -rf /\\"); //');
  });

  it("handles CRLF injection", () => {
    expect(escapeForJSX("\r\n")).toBe("\\r\\n");
  });

  it("handles triple backslash", () => {
    expect(escapeForJSX("\\\\\\")).toBe("\\\\\\\\\\\\");
  });

  it("handles quote sandwich: '\"'", () => {
    expect(escapeForJSX("'\"'")).toBe("\\'\\\"\\'");
  });

  it("handles deeply nested escape: \\\\\\\\", () => {
    const input = "\\\\\\\\"; // 4 literal backslashes
    expect(escapeForJSX(input)).toBe("\\\\\\\\\\\\\\\\"); // 8 escaped backslashes
  });

  it("handles JSON string value injection", () => {
    const input = '{"key":"value"}';
    const result = escapeForJSX(input);
    expect(result).toContain('\\"key\\"');
  });

  it("handles eval() attempt in string", () => {
    const input = "eval('malicious')";
    const result = escapeForJSX(input);
    expect(result).toContain("\\'malicious\\'");
  });

  it("handles Function constructor attempt", () => {
    const input = 'new Function("return this")()';
    const result = escapeForJSX(input);
    expect(result).toContain('\\"return this\\"');
  });

  it("handles multiline injection with tabs", () => {
    const input = "line1\n\tline2\n\tline3";
    expect(escapeForJSX(input)).toBe("line1\\n\\tline2\\n\\tline3");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Real-world Apollova Data (~30 tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("escapeForJSX — real-world Apollova data", () => {
  it("song title with apostrophe: Don't Stop Me Now", () => {
    expect(escapeForJSX("Don't Stop Me Now")).toBe("Don\\'t Stop Me Now");
  });

  it("song title with apostrophe: She's Got a Way", () => {
    expect(escapeForJSX("She's Got a Way")).toBe("She\\'s Got a Way");
  });

  it("song title with slash: AC/DC - Highway to Hell", () => {
    expect(escapeForJSX("AC/DC - Highway to Hell")).toBe("AC/DC - Highway to Hell");
  });

  it("band with apostrophe: Guns N' Roses", () => {
    expect(escapeForJSX("Guns N' Roses")).toBe("Guns N\\' Roses");
  });

  it("lyrics with newlines", () => {
    expect(escapeForJSX("Hello\nGoodbye\nForever")).toBe("Hello\\nGoodbye\\nForever");
  });

  it("lyrics with Unicode: Résumé", () => {
    expect(escapeForJSX("Résumé")).toBe("Résumé");
  });

  it("lyrics with Unicode: café", () => {
    expect(escapeForJSX("café")).toBe("café");
  });

  it("lyrics with Unicode: naïve", () => {
    expect(escapeForJSX("naïve")).toBe("naïve");
  });

  it("AE comp name: OUTPUT 1", () => {
    expect(escapeForJSX("OUTPUT 1")).toBe("OUTPUT 1");
  });

  it("AE comp name: LYRIC FONT 12", () => {
    expect(escapeForJSX("LYRIC FONT 12")).toBe("LYRIC FONT 12");
  });

  it("AE comp name: PRE-OUTPUT 3", () => {
    expect(escapeForJSX("PRE-OUTPUT 3")).toBe("PRE-OUTPUT 3");
  });

  it("AE layer name: LYRIC_TEXT", () => {
    expect(escapeForJSX("LYRIC_TEXT")).toBe("LYRIC_TEXT");
  });

  it("AE layer name: AUDIO", () => {
    expect(escapeForJSX("AUDIO")).toBe("AUDIO");
  });

  it("AE layer name: Gradient", () => {
    expect(escapeForJSX("Gradient")).toBe("Gradient");
  });

  it("Windows file path: C:\\Users\\aliba\\Downloads\\Apollova\\test.jsx", () => {
    expect(escapeForJSX("C:\\Users\\aliba\\Downloads\\Apollova\\test.jsx")).toBe(
      "C:\\\\Users\\\\aliba\\\\Downloads\\\\Apollova\\\\test.jsx"
    );
  });

  it("Windows path with spaces: C:\\Program Files\\Adobe\\script.jsx", () => {
    expect(escapeForJSX("C:\\Program Files\\Adobe\\script.jsx")).toBe(
      "C:\\\\Program Files\\\\Adobe\\\\script.jsx"
    );
  });

  it("Japanese song title: 米津玄師 - Lemon", () => {
    expect(escapeForJSX("米津玄師 - Lemon")).toBe("米津玄師 - Lemon");
  });

  it("Korean title: BTS - Dynamite 다이너마이트", () => {
    expect(escapeForJSX("BTS - Dynamite 다이너마이트")).toBe("BTS - Dynamite 다이너마이트");
  });

  it("Arabic title: فيروز - يا حبيبي", () => {
    expect(escapeForJSX("فيروز - يا حبيبي")).toBe("فيروز - يا حبيبي");
  });

  it("song with both quotes: He said \"it's fine\"", () => {
    expect(escapeForJSX("He said \"it's fine\"")).toBe("He said \\\"it\\'s fine\\\"");
  });

  it("lyrics with CRLF line endings", () => {
    expect(escapeForJSX("Verse 1\r\nChorus\r\nVerse 2")).toBe(
      "Verse 1\\r\\nChorus\\r\\nVerse 2"
    );
  });

  it("German title with umlaut: Ärzte - Schrei nach Liebe", () => {
    expect(escapeForJSX("Ärzte - Schrei nach Liebe")).toBe("Ärzte - Schrei nach Liebe");
  });

  it("French title with cedilla: François", () => {
    expect(escapeForJSX("François")).toBe("François");
  });

  it("Spanish title with tilde: Señorita", () => {
    expect(escapeForJSX("Señorita")).toBe("Señorita");
  });

  it("Portuguese: São Paulo", () => {
    expect(escapeForJSX("São Paulo")).toBe("São Paulo");
  });

  it("Turkish: İstanbul", () => {
    expect(escapeForJSX("İstanbul")).toBe("İstanbul");
  });

  it("mixed script lyrics: Hello こんにちは 你好 مرحبا", () => {
    expect(escapeForJSX("Hello こんにちは 你好 مرحبا")).toBe("Hello こんにちは 你好 مرحبا");
  });

  it("song title with ampersand: Simon & Garfunkel", () => {
    expect(escapeForJSX("Simon & Garfunkel")).toBe("Simon & Garfunkel");
  });

  it("complex real path: C:\\Users\\aliba\\Downloads\\Apollova\\Apollova-Aurora\\jobs\\song name's here.json", () => {
    const input = "C:\\Users\\aliba\\Downloads\\Apollova\\Apollova-Aurora\\jobs\\song name's here.json";
    const result = escapeForJSX(input);
    expect(result).toContain("\\\\");
    expect(result).toContain("\\'");
  });

  it("layer name with brackets: [BG] Layer (1)", () => {
    expect(escapeForJSX("[BG] Layer (1)")).toBe("[BG] Layer (1)");
  });
});
