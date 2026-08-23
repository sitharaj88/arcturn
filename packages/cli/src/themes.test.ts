import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darkTheme, lightTheme } from "@arcturn/tui";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomThemes, resolveTheme, themeTokens } from "./themes.js";

const roots: string[] = [];

async function scratchDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-cli-themes-"));
  roots.push(root);
  return root;
}

async function writeThemeFile(dir: string, name: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), contents, "utf8");
}

afterEach(() => {
  roots.length = 0;
});

describe("themeTokens", () => {
  it("mirrors darkTheme's style keys", () => {
    expect(themeTokens().sort()).toEqual(Object.keys(darkTheme.styles).sort());
  });
});

describe("loadCustomThemes", () => {
  it("loads a full theme document", async () => {
    const root = await scratchDir();
    await writeThemeFile(
      root,
      "sunset",
      JSON.stringify({
        base: "light",
        colors: {
          accent: "#ff8800",
          border: { fg: "#112233", bold: true },
        },
      }),
    );

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings).toEqual([]);
    const theme = themes.get("sunset");
    expect(theme).toBeDefined();
    expect(theme?.name).toBe("sunset");
    // Derived from light: untouched tokens fall through to the light base.
    expect(theme?.styles.muted).toBe(lightTheme.styles.muted);
    // Overridden tokens differ from both bases.
    expect(theme?.styles.accent).not.toBe(darkTheme.styles.accent);
    expect(theme?.styles.accent).not.toBe(lightTheme.styles.accent);
    expect(theme?.styles.accent("x")).toContain("x");
  });

  it("accepts hex-only shorthand for a colour entry", async () => {
    const root = await scratchDir();
    await writeThemeFile(root, "shorthand", JSON.stringify({ colors: { text: "#abcdef" } }));

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings).toEqual([]);
    const theme = themes.get("shorthand");
    expect(theme).toBeDefined();
    // Defaults to the dark base when "base" is omitted.
    expect(theme?.styles.muted).toBe(darkTheme.styles.muted);
    expect(theme?.styles.text).not.toBe(darkTheme.styles.text);
  });

  it("accepts the style-object form with fg/bg and modifier flags", async () => {
    const root = await scratchDir();
    await writeThemeFile(
      root,
      "boxy",
      JSON.stringify({
        colors: {
          diffAdded: { fg: "#00ff00", bg: "#001100", italic: true, underline: true, dim: true },
        },
      }),
    );

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings).toEqual([]);
    const theme = themes.get("boxy");
    const rendered = theme?.styles.diffAdded("hi") ?? "";
    expect(rendered).toContain("hi");
    expect(theme?.styles.diffAdded).not.toBe(darkTheme.styles.diffAdded);
  });

  it("warns and skips unknown tokens", async () => {
    const root = await scratchDir();
    await writeThemeFile(
      root,
      "typo",
      JSON.stringify({ colors: { accnet: "#ff0000", accent: "#00ff00" } }),
    );

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings.join("\n")).toContain('unknown theme token "accnet"');
    const theme = themes.get("typo");
    expect(theme?.styles.accent).not.toBe(darkTheme.styles.accent);
  });

  it("warns and skips invalid hex colours", async () => {
    const root = await scratchDir();
    await writeThemeFile(
      root,
      "badcolor",
      JSON.stringify({ colors: { accent: "not-a-color", text: "#fff" } }),
    );

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings.join("\n")).toContain('invalid color "not-a-color"');
    const theme = themes.get("badcolor");
    // The invalid token falls back to the base theme's style.
    expect(theme?.styles.accent).toBe(darkTheme.styles.accent);
    // The valid sibling token still applies.
    expect(theme?.styles.text).not.toBe(darkTheme.styles.text);
  });

  it("lets a later root win a name collision, with a warning", async () => {
    const rootA = await scratchDir();
    const rootB = await scratchDir();
    await writeThemeFile(rootA, "shared", JSON.stringify({ colors: { accent: "#111111" } }));
    await writeThemeFile(rootB, "shared", JSON.stringify({ colors: { accent: "#222222" } }));

    const warnings: string[] = [];
    const themes = await loadCustomThemes([rootA, rootB], warnings);

    expect(warnings.join("\n")).toContain(
      'theme "shared" overrides one loaded from an earlier root',
    );
    const theme = themes.get("shared");

    // Sanity: the two roots really did produce different accents (compare the
    // styles' raw escape sequences, which encode colour regardless of the
    // test environment's detected colour level), and the winner is root B's.
    const onlyA = await loadCustomThemes([rootA], []);
    const onlyB = await loadCustomThemes([rootB], []);
    expect(theme?.styles.accent.open).not.toBe(onlyA.get("shared")?.styles.accent.open);
    expect(theme?.styles.accent.open).toBe(onlyB.get("shared")?.styles.accent.open);
  });

  it("warns and skips a file with malformed JSON", async () => {
    const root = await scratchDir();
    await writeThemeFile(root, "broken", "{ not valid json");

    const warnings: string[] = [];
    const themes = await loadCustomThemes([root], warnings);

    expect(warnings.join("\n")).toContain("invalid JSON");
    expect(themes.has("broken")).toBe(false);
  });

  it("treats a missing root directory as fine", async () => {
    const warnings: string[] = [];
    const themes = await loadCustomThemes([join(await scratchDir(), "does-not-exist")], warnings);

    expect(warnings).toEqual([]);
    expect(themes.size).toBe(0);
  });
});

describe("resolveTheme", () => {
  it("resolves the built-in names regardless of the custom map", async () => {
    const custom = await loadCustomThemes([], []);
    expect(resolveTheme("dark", custom)).toBe(darkTheme);
    expect(resolveTheme("light", custom)).toBe(lightTheme);
  });

  it("resolves a custom theme by name", async () => {
    const root = await scratchDir();
    await writeThemeFile(root, "mine", JSON.stringify({ colors: { accent: "#123456" } }));
    const warnings: string[] = [];
    const custom = await loadCustomThemes([root], warnings);

    const resolved = resolveTheme("mine", custom);
    expect(resolved).toBe(custom.get("mine"));
    expect(resolved?.name).toBe("mine");
  });

  it("returns undefined for an unknown name", async () => {
    const custom = await loadCustomThemes([], []);
    expect(resolveTheme("does-not-exist", custom)).toBeUndefined();
  });
});
