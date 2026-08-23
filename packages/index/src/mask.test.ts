import { describe, expect, it } from "vitest";
import { LANGUAGE_RULES } from "./language.js";
import { maskSource, splitLines } from "./mask.js";

const TS = LANGUAGE_RULES.typescript.syntax;
const PY = LANGUAGE_RULES.python.syntax;
const RUST = LANGUAGE_RULES.rust.syntax;

describe("maskSource", () => {
  it("preserves line and column structure", () => {
    const text = 'const a = "hello world";\nconst b = 2;';
    const masked = maskSource(text, TS);
    expect(masked.masked).toHaveLength(2);
    for (let i = 0; i < masked.lines.length; i++) {
      expect(masked.masked[i]?.length).toBe(masked.lines[i]?.length);
    }
  });

  it("blanks string contents so braces inside strings do not count", () => {
    const masked = maskSource('const a = "} } }";', TS);
    expect(masked.masked[0]?.includes("}")).toBe(false);
  });

  it("blanks line and block comments", () => {
    const masked = maskSource(
      ["// class Fake {", "/* class Also {", "*/", "const x = 1;"].join("\n"),
      TS,
    );
    expect(masked.masked[0]?.trim()).toBe("");
    expect(masked.isComment[0]).toBe(true);
    expect(masked.isComment[1]).toBe(true);
    expect(masked.isComment[2]).toBe(true);
    expect(masked.isComment[3]).toBe(false);
    expect(masked.masked[3]).toBe("const x = 1;");
  });

  it("lets template literals span lines but not single quotes", () => {
    const masked = maskSource(
      ["const a = `open", "still in string`;", "const b = 1;"].join("\n"),
      TS,
    );
    expect(masked.masked[1]?.includes("still")).toBe(false);
    expect(masked.masked[2]).toBe("const b = 1;");

    const stray = maskSource(["const a = 'unterminated", "const b = 1;"].join("\n"), TS);
    expect(stray.masked[1]).toBe("const b = 1;");
  });

  it("handles Python triple-quoted strings across lines", () => {
    const masked = maskSource(['x = """', "def not_real():", '"""', "y = 1"].join("\n"), PY);
    expect(masked.masked[1]?.trim()).toBe("");
    expect(masked.masked[3]).toBe("y = 1");
  });

  it("nests block comments only where the language allows it", () => {
    const rust = maskSource(["/* outer /* inner */ still */", "fn real() {}"].join("\n"), RUST);
    expect(rust.masked[0]?.trim()).toBe("");
    expect(rust.masked[1]).toBe("fn real() {}");
  });

  it("keeps Rust lifetimes out of the string machinery", () => {
    const rust = maskSource("pub fn f<'a>(x: &'a str) -> &'a str { x }", RUST);
    expect(rust.masked[0]?.includes("(")).toBe(true);
    expect(rust.masked[0]?.includes("{")).toBe(true);
  });

  it("marks blank lines", () => {
    const masked = maskSource("a\n\n   \nb", TS);
    expect([...masked.isBlank]).toEqual([false, true, true, false]);
  });

  it("never throws on unterminated constructs", () => {
    expect(() => maskSource("/* never closed\nconst x = 1;", TS)).not.toThrow();
    expect(() => maskSource('"', TS)).not.toThrow();
  });
});

describe("splitLines", () => {
  it("handles all three line terminators", () => {
    expect(splitLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("regex literals", () => {
  it("does not let a delimiter inside a regex open a string", () => {
    // Regression: `permissions.ts` line 134 splits on a pattern containing a
    // backtick. The masker read it as a template literal and blanked the
    // remaining 360 lines, hiding matchSpecifier, matchRules and
    // class PermissionEngine from the index entirely.
    const source = ["const re = /(?:\\|\\||`|;)/g;", "export class Visible {}"].join("\n");
    const { masked } = maskSource(source, TS);

    // The class on the following line must survive as code.
    expect(masked[1]).toContain("class Visible");
  });

  it("still treats division as division", () => {
    // The risk of regex detection is misreading `a / b` as a literal and
    // blanking the rest of the line.
    const source = "const ratio = total / count; const other = 4 / 2;";
    const { masked } = maskSource(source, TS);
    expect(masked[0]).toBe(source);
  });

  it("keeps a slash inside a character class from ending the literal", () => {
    const source = ["const re = /[/`]/g;", "export class After {}"].join("\n");
    const { masked } = maskSource(source, TS);
    expect(masked[1]).toContain("class After");
  });

  it("leaves regex handling off for languages without them", () => {
    // Python has no regex literal syntax; `/` is always division there.
    const source = "x = a / b";
    const { masked } = maskSource(source, PY);
    expect(masked[0]).toBe(source);
  });
});
