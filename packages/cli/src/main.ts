#!/usr/bin/env node
/**
 * The `arcturn` entry point, kept deliberately thin.
 *
 * Time-to-first-paint is a feature: this module parses the command line and
 * answers `--help`/`--version` with only the argument parser loaded, then
 * lazily imports the command implementations in `cli-main.ts`. The V8 compile
 * cache is enabled first so every later import compiles from bytecode on warm
 * starts.
 */

import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import { helpText, parseArgs } from "./args.js";
import { version } from "./meta.js";

try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  // Node without compile-cache support, or an unwritable cache dir: run as-is.
}

/**
 * Run the CLI.
 *
 * @param argv - Arguments without the node binary and script path.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`arcturn: ${parsed.error}\n\nRun "arcturn --help" for usage.\n`);
    return 2;
  }
  const args = parsed.args;

  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const bootScreen = await paintBootScreen(args);
  const { runCli } = await import("./cli-main.js");
  return runCli(args, bootScreen === undefined ? {} : { bootScreen });
}

/** Bytes that erase a painted boot screen, provided to `runCli`. */
export interface BootScreen {
  /** Erase the boot banner (called right before the real UI paints). */
  erase(): void;
}

/**
 * Paint the welcome banner immediately for interactive sessions.
 *
 * The command implementations are a few hundred milliseconds of module
 * loading away; painting the banner first (with placeholder session facts)
 * makes startup feel instant. `runCli` erases it in the same breath as the
 * real UI's first frame, so the swap is invisible.
 */
async function paintBootScreen(args: {
  command?: unknown;
  print: boolean;
  listModels: boolean;
  listProviders: boolean;
  cwd?: string;
}): Promise<BootScreen | undefined> {
  const interactive =
    args.command === undefined && !args.print && !args.listModels && !args.listProviders;
  if (!interactive || !process.stdout.isTTY) return undefined;
  // The banner belongs to inline mode only. A screen-mode session paints its
  // own welcome into the alternate buffer, and a banner flashed into the
  // normal buffer first reads as a second, mismatched UI (and lingers in
  // scrollback behind the app). Screen mode therefore boots dark, like any
  // full-screen terminal program.
  if ((await peekUiMode(args.cwd)) === "screen") return undefined;
  try {
    const [{ bannerLines }, { resolveGlyphs }, { homedir }] = await Promise.all([
      import("./banner.js"),
      import("./glyphs.js"),
      import("node:os"),
    ]);
    const cwd = args.cwd ?? process.cwd();
    const home = homedir();
    const displayCwd =
      home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
    const lines = bannerLines({
      // Capped at 72 columns to match the app's banner (see its #bannerAt):
      // a narrow card survives later window narrowing without wrapping.
      width: Math.min(Math.max(20, process.stdout.columns ?? 80), 72),
      glyphs: resolveGlyphs(),
      model: "starting…",
      mode: "",
      cwd: displayCwd,
      version: version(),
    });
    process.stdout.write(`${lines.join("\r\n")}\r\n`);
    // A resize while the splash is up rewraps it and breaks the erase count,
    // so the first resize event takes the splash down immediately — the size
    // has only moved one step, where the climb is still exact.
    let painted = true;
    const eraseNow = (): void => {
      if (!painted) return;
      painted = false;
      // Climb to the banner's top row and erase down (CSI nA, CSI 0J).
      process.stdout.write(`\u001b[${lines.length}A\r\u001b[0J`);
    };
    process.stdout.once("resize", eraseNow);
    return {
      erase(): void {
        process.stdout.removeListener("resize", eraseNow);
        eraseNow();
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Cheaply resolve the UI mode the session will use, without loading the full
 * config machinery (this runs before `cli-main.ts` is even imported, and its
 * only job is the boot-banner decision — `ARCTURN_UI`, then the project file,
 * then the user file, then the default; unreadable files just fall through).
 *
 * @param cwd - Working directory override from the command line.
 */
export async function peekUiMode(cwd?: string): Promise<"screen" | "inline"> {
  const env = process.env.ARCTURN_UI;
  if (env === "inline" || env === "screen") return env;
  const [{ readFile }, { resolve }, { homedir }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
  ]);
  const home = process.env.ARCTURN_HOME ?? resolve(homedir(), ".arcturn");
  const files = [
    resolve(cwd ?? process.cwd(), ".arcturn", "config.json"),
    resolve(home, "config.json"),
  ];
  for (const file of files) {
    try {
      const ui = (JSON.parse(await readFile(file, "utf8")) as { ui?: unknown }).ui;
      if (ui === "inline" || ui === "screen") return ui;
    } catch {
      // Missing or malformed file: the real config loader reports that later.
    }
  }
  return "inline";
}

/**
 * Whether this module is the process entry point.
 *
 * `process.argv[1]` may be a bin symlink while `import.meta.url` always points
 * at the real file, so both are resolved through `realpath` before comparing.
 */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint() || process.env.ARCTURN_FORCE_MAIN === "1") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`arcturn: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
