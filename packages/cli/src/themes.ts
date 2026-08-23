/**
 * User-defined colour themes.
 *
 * Beyond the two built-in themes (`"dark"` / `"light"`) users can drop a JSON
 * file per theme under `~/.arcturn/themes/<name>.json` or `<cwd>/.arcturn/themes/<name>.json`.
 * A theme file names a {@link Theme} to derive from (`"dark"` or `"light"`) and a
 * `colors` map of {@link ThemeToken} → style. Style values are either a bare hex
 * string (foreground only) or an object with `fg`/`bg` hex colours and
 * `bold`/`italic`/`underline`/`dim` flags.
 *
 * Loading never throws: an unreadable directory, malformed JSON, an unknown
 * token or an invalid colour is reported as a warning and skipped so the rest
 * of the theme (and the rest of the load) still loads.
 *
 * @packageDocumentation
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bg,
  bold,
  combine,
  createTheme,
  darkTheme,
  dim,
  fg,
  italic,
  lightTheme,
  type Style,
  type Theme,
  type ThemeToken,
  underline,
} from "@arcturn/tui";

/** Suffix every theme file must have. */
const THEME_FILE_SUFFIX = ".json";

/** Matches `#rgb` and `#rrggbb` hex colours. */
const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The style-object form of a theme colour entry: `{ fg, bg, bold, italic,
 * underline, dim }`. All fields are optional, but at least one must be
 * present for the entry to be usable.
 */
interface StyleObjectSpec {
  fg?: unknown;
  bg?: unknown;
  bold?: unknown;
  italic?: unknown;
  underline?: unknown;
  dim?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidHex(value: unknown): value is `#${string}` {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

/**
 * Every token a theme file is allowed to override, derived at runtime from
 * the built-in dark theme so this list can never drift from the
 * {@link ThemeToken} union.
 */
export function themeTokens(): ThemeToken[] {
  return Object.keys(darkTheme.styles) as ThemeToken[];
}

/**
 * Parses one `colors` entry into a {@link Style}, or `undefined` (with a
 * warning pushed) when the value is not a valid hex string or style object.
 *
 * @param token - Theme token the value is for, used only in warning text.
 * @param value - Raw JSON value for the token.
 * @param where - File path, used to prefix warnings.
 * @param warnings - Collector for non-fatal problems.
 */
function parseStyleValue(
  token: string,
  value: unknown,
  where: string,
  warnings: string[],
): Style | undefined {
  if (typeof value === "string") {
    if (isValidHex(value)) return fg(value);
    warnings.push(`${where}: token "${token}" has an invalid color "${value}" (ignored)`);
    return undefined;
  }

  if (isRecord(value)) {
    const spec = value as StyleObjectSpec;
    const parts: Style[] = [];

    if (spec.fg !== undefined) {
      if (!isValidHex(spec.fg)) {
        warnings.push(
          `${where}: token "${token}" has an invalid "fg" color "${String(spec.fg)}" (ignored)`,
        );
        return undefined;
      }
      parts.push(fg(spec.fg));
    }
    if (spec.bg !== undefined) {
      if (!isValidHex(spec.bg)) {
        warnings.push(
          `${where}: token "${token}" has an invalid "bg" color "${String(spec.bg)}" (ignored)`,
        );
        return undefined;
      }
      parts.push(bg(spec.bg));
    }
    if (spec.bold === true) parts.push(bold);
    if (spec.italic === true) parts.push(italic);
    if (spec.underline === true) parts.push(underline);
    if (spec.dim === true) parts.push(dim);

    if (parts.length === 0) {
      warnings.push(`${where}: token "${token}" has no usable style properties (ignored)`);
      return undefined;
    }
    return combine(...parts);
  }

  warnings.push(
    `${where}: token "${token}" must be a hex color string or a style object (ignored)`,
  );
  return undefined;
}

/**
 * Parses a single theme file's already-JSON.parse'd contents into a
 * {@link Theme}.
 *
 * @param name - Theme name (the file's basename, without `.json`).
 * @param raw - Parsed JSON value.
 * @param where - File path, used to prefix warnings.
 * @param validTokens - Tokens a `colors` entry is allowed to name.
 * @param warnings - Collector for non-fatal problems.
 * @returns The derived theme, or `undefined` when the document is not an object.
 */
function parseThemeDocument(
  name: string,
  raw: unknown,
  where: string,
  validTokens: ReadonlySet<string>,
  warnings: string[],
): Theme | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: expected a JSON object`);
    return undefined;
  }

  let base: Theme = darkTheme;
  if (raw.base !== undefined) {
    if (raw.base === "dark") base = darkTheme;
    else if (raw.base === "light") base = lightTheme;
    else warnings.push(`${where}: "base" must be "dark" or "light" (defaulting to "dark")`);
  }

  const overrides: Partial<Record<ThemeToken, Style>> = {};
  if (raw.colors !== undefined) {
    if (!isRecord(raw.colors)) {
      warnings.push(`${where}: "colors" must be an object`);
    } else {
      for (const [token, value] of Object.entries(raw.colors)) {
        if (!validTokens.has(token)) {
          warnings.push(`${where}: unknown theme token "${token}" (ignored)`);
          continue;
        }
        const style = parseStyleValue(token, value, where, warnings);
        if (style) overrides[token as ThemeToken] = style;
      }
    }
  }

  return createTheme(name, overrides, base);
}

/**
 * Loads every `*.json` theme file found directly under each of `roots`.
 *
 * Roots are searched in order and later roots win name collisions (with a
 * warning), so callers typically pass the user themes directory first and
 * the project themes directory last. A missing root is not an error; a
 * malformed file is reported as a warning and skipped without failing the
 * rest of the load.
 *
 * @param roots - Directories to scan for `<name>.json` theme files, in
 *   increasing priority order.
 * @param warnings - Collector for non-fatal problems (unreadable directory,
 *   invalid JSON, unknown token, invalid colour, ...).
 * @returns A map of theme name → loaded {@link Theme}.
 */
export async function loadCustomThemes(
  roots: string[],
  warnings: string[],
): Promise<Map<string, Theme>> {
  const themes = new Map<string, Theme>();
  const validTokens = new Set<string>(themeTokens());

  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        warnings.push(`${root}: could not be read (${String(code ?? error)})`);
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(THEME_FILE_SUFFIX)) continue;
      const filePath = join(root, entry.name);
      const name = entry.name.slice(0, -THEME_FILE_SUFFIX.length);

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        warnings.push(`${filePath}: could not be read (${String(error)})`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        warnings.push(
          `${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }

      const theme = parseThemeDocument(name, parsed, filePath, validTokens, warnings);
      if (!theme) continue;

      if (themes.has(name)) {
        warnings.push(`${filePath}: theme "${name}" overrides one loaded from an earlier root`);
      }
      themes.set(name, theme);
    }
  }

  return themes;
}

/**
 * Resolves a theme name to a {@link Theme}: `"dark"` and `"light"` always
 * return the built-ins, anything else is looked up in `custom`.
 *
 * @param name - Theme name, e.g. from config or the `/theme` picker.
 * @param custom - Themes loaded by {@link loadCustomThemes}.
 * @returns The resolved theme, or `undefined` when `name` is neither a
 *   built-in nor a key of `custom`.
 */
export function resolveTheme(name: string, custom: Map<string, Theme>): Theme | undefined {
  if (name === "dark") return darkTheme;
  if (name === "light") return lightTheme;
  return custom.get(name);
}
