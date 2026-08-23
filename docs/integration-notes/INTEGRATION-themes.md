# Custom themes — integration notes

This describes how to wire `packages/cli/src/themes.ts` (new, already added) into
the rest of the CLI. Nothing outside `themes.ts` / `themes.test.ts` has been
changed — this file is a sketch for whoever does that follow-up work.

## 1. Loosen `config.ts`'s `theme` key

Today:

```ts
export type ArcturnThemeName = "dark" | "light";
...
const THEMES: readonly ArcturnThemeName[] = ["dark", "light"];
...
if (raw.theme !== undefined) {
  if (typeof raw.theme === "string" && THEMES.includes(raw.theme as ArcturnThemeName)) {
    out.theme = raw.theme as ArcturnThemeName;
  } else {
    warnings.push(`${where}: "theme" must be one of ${THEMES.join(", ")}`);
  }
}
```

`config.ts` validates `theme` against a closed `"dark" | "light"` enum at
parse time, before any custom themes have been loaded — `parseConfigFile` has
no access to the filesystem roots `loadCustomThemes` needs. That means the
enum has to be loosened to "any non-empty string", and the *real* validation
(does this name resolve to a built-in or a loaded custom theme?) has to move
to where both the config and the custom-theme map are available: `app.ts`.

Proposed change to `config.ts`:

```ts
/** TUI colour theme: a built-in name or a user-defined theme's file name. */
export type ArcturnThemeName = string;
```

and in `parseConfigFile`:

```ts
if (raw.theme !== undefined) {
  if (typeof raw.theme === "string" && raw.theme.length > 0) {
    out.theme = raw.theme;
  } else {
    warnings.push(`${where}: "theme" must be a non-empty string`);
  }
}
```

`DEFAULT_CONFIG.theme` stays `"dark"`. `THEMES` and the `ArcturnThemeName` union
export are removed (or `THEMES` becomes an internal `["dark", "light"]` for
documentation only, since it can no longer reject values). This is a narrow,
purely-additive loosening: every config file that validates today still
validates identically.

## 2. Resolving the theme in `app.ts`

`app.ts` currently does:

```ts
setTheme(options.runtime.config.theme === "light" ? lightTheme : darkTheme);
```

That line should become, near where the runtime's `paths` are already
available (the same object `persistPermissionRule`/`persistSetting` take):

```ts
import { loadCustomThemes, resolveTheme } from "../themes.js";

const themeWarnings: string[] = [];
const customThemes = await loadCustomThemes(
  [join(paths.home, "themes"), join(paths.project, "themes")],
  themeWarnings,
);
for (const warning of themeWarnings) {
  // surface via the same channel other config warnings use today
  ui.notice("warn", warning);
}

const resolved = resolveTheme(options.runtime.config.theme, customThemes);
setTheme(resolved ?? darkTheme);
if (!resolved) {
  ui.notice(
    "warn",
    `Unknown theme "${options.runtime.config.theme}"; falling back to "dark". ` +
      `Run /theme to pick an installed one.`,
  );
}
```

Notes:
- `join(paths.home, "themes")` → `~/.arcturn/themes`; `join(paths.project, "themes")` →
  `<cwd>/.arcturn/themes`. Project themes are loaded second so they win name
  collisions with user-level themes of the same name — consistent with how
  `config.ts` layers project over user for every other setting.
- `customThemes` (the `Map<string, Theme>`) needs to be stashed somewhere
  reachable by the `/theme` command — e.g. a field on `ArcturnRuntime`
  (`runtime.customThemes`) populated once at startup, since re-scanning the
  themes directories on every command invocation is wasteful and themes are
  not expected to change mid-session.
- Because `loadCustomThemes` never throws, this block cannot fail startup —
  the worst case is a warning plus a fallback to `dark`, matching the
  "malformed config is a warning, not a crash" rule `config.ts` already
  documents.

## 3. `/theme` picker command sketch

A new entry in `createBuiltInCommands()` (`packages/cli/src/commands.ts`),
following the existing `/model` command's shape (`ui.select` + a notice, see
lines ~187-238 of `commands.ts`):

```ts
{
  name: "theme",
  description: "Switch the colour theme",
  source: "built-in",
  async run({ ui, runtime }) {
    const current = runtime.config.theme;
    const builtins: SelectOption<string>[] = [
      { value: "dark", label: current === "dark" ? "dark  (current)" : "dark", data: "dark" },
      { value: "light", label: current === "light" ? "light  (current)" : "light", data: "light" },
    ];
    const customs: SelectOption<string>[] = [...runtime.customThemes.keys()].map((name) => ({
      value: name,
      label: name === current ? `${name}  (current)` : name,
      description: "custom",
      data: name,
    }));

    const choice = await ui.select("Select a theme", [...builtins, ...customs], {
      filterable: true,
    });
    if (!choice) return;

    const resolved = resolveTheme(choice, runtime.customThemes);
    if (!resolved) {
      ui.notice("error", `Theme "${choice}" is no longer available.`);
      return;
    }

    setTheme(resolved);
    runtime.config.theme = choice;
    const file = await persistSetting("theme", choice, "user", runtime.paths);
    ui.notice("info", `Theme set to "${choice}" (saved to ${file}).`);
  },
},
```

Points worth calling out to whoever implements this:
- `persistSetting("theme", choice, "user", runtime.paths)` reuses the
  existing generic setting-writer in `config.ts` verbatim — no new
  persistence code needed, and it already writes to `~/.arcturn/config.json`
  with the read-merge-write behaviour the rest of config persistence relies
  on. A project-scoped variant (`"project"`) could be offered as a second
  picker action later, but isn't required for parity with `/model`.
- `resolveTheme`/`runtime.customThemes` guards against a theme file being
  deleted between session start and the picker being opened; the command
  degrades to an error notice rather than crashing.
- No new dependency: `select`, `notice`, `persistSetting`, `setTheme` are all
  already imported by neighbouring code in `commands.ts` / `app.ts`.

## 4. Theme file format (for user-facing docs)

`~/.arcturn/themes/<name>.json` or `<cwd>/.arcturn/themes/<name>.json`:

```json
{
  "base": "dark",
  "colors": {
    "accent": "#ff8800",
    "border": { "fg": "#334455", "bold": true },
    "diffAdded": { "fg": "#00ff88", "bg": "#001a10", "dim": true }
  }
}
```

- `base` — `"dark"` or `"light"` (defaults to `"dark"` if omitted); every
  token not named under `colors` falls through to this base theme unchanged.
- `colors` — a map from {@link ThemeToken} name (see
  `packages/tui/src/theme.ts`, or call `themeTokens()` from the new
  `themes.ts` for the authoritative runtime list) to either:
  - a bare hex string (`"#rrggbb"` or `"#rgb"`) — foreground colour only, or
  - an object `{ fg?, bg?, bold?, italic?, underline?, dim? }`.
- Unknown token names and invalid hex colours are dropped with a warning;
  the rest of the file still loads.
- The file's base name (without `.json`) is the theme's name, e.g.
  `sunset.json` → select it with `theme: "sunset"` in config or `/theme`.
