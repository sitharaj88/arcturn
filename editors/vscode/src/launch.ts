/**
 * Turning a resolved binary plus settings into the one line typed into a
 * fresh Arcturn terminal.
 *
 * The extension launches the TUI by typing a command, not by spawning a
 * process, so the user sees exactly what ran and can re-run it themselves.
 * That means quoting is on us, and it is shell-specific.
 */

/** Engine flags derived from extension settings. Empty means "engine default". */
export function launchArgs(defaultModel: string | undefined): string[] {
  const model = (defaultModel ?? "").trim();
  return model === "" ? [] : ["--model", model];
}

const POSIX_SAFE = /^[A-Za-z0-9._/:=@%+,-]+$/;

function quotePosix(value: string): string {
  if (value !== "" && POSIX_SAFE.test(value)) return value;
  // Single quotes protect everything except a single quote, which has to end
  // the span, escape itself, and start a new one.
  return `'${value.split("'").join("'\\''")}'`;
}

function quoteWindows(value: string): string {
  if (value !== "" && !/[\s"'`$&|<>^]/.test(value)) return value;
  return `"${value.split('"').join('`"')}"`;
}

/**
 * Compose the launch line for a shell.
 *
 * The win32 branch prefixes `& ` when the command ends up quoted: VS Code's
 * default Windows profile is PowerShell, where `"C:\path\arcturn.cmd"` is a
 * string expression that prints the path instead of running it. The call
 * operator is what makes a quoted command a command.
 */
export function buildLaunchCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): string {
  const quote = platform === "win32" ? quoteWindows : quotePosix;
  const head = quote(command);
  const needsCallOperator = platform === "win32" && head !== command;
  const parts = [needsCallOperator ? `& ${head}` : head, ...args.map(quote)];
  return parts.join(" ");
}
