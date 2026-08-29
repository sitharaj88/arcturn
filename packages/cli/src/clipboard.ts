/**
 * Writing to the system clipboard from a terminal app.
 *
 * The full-screen TUI lives in the alternate screen, where the terminal's own
 * selection can never span more than one visible frame — so "copy the answer"
 * cannot always be a mouse gesture. This goes straight to the OS instead:
 * every desktop platform ships a stdin-to-clipboard tool, and piping to it
 * needs no terminal cooperation, no escape-sequence support and no selection.
 *
 * OSC 52 was considered and set aside: it would also cover SSH sessions, but
 * it needs a raw escape channel to the terminal and per-emulator opt-in, and
 * the local case — which is every reported complaint — is fully served by the
 * pipe. The tool list is ordered: Wayland's tool before the X11 ones, so a
 * Wayland session with XWayland installed lands on the clipboard the user's
 * other apps actually read.
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";

/** One stdin-to-clipboard tool: the command and its arguments. */
export interface ClipboardTool {
  readonly command: string;
  readonly args: readonly string[];
}

/** The platform's clipboard tools, most preferred first. */
export function clipboardToolsFor(platform: NodeJS.Platform): ClipboardTool[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** What {@link copyToClipboard} needs from the outside world, injectable for tests. */
export interface CopyOptions {
  readonly tools?: readonly ClipboardTool[];
  readonly spawnImpl?: typeof spawn;
}

export type CopyResult = { ok: true; via: string } | { ok: false; why: string };

/**
 * Pipes `text` into the first clipboard tool that accepts it.
 *
 * A missing tool (ENOENT) falls through to the next; any other failure does
 * too, because a half-configured X session throwing from `xclip` should not
 * hide a working `xsel` right behind it. Only when every tool has refused
 * does the caller get a `why` naming what was tried — a copy that silently
 * went nowhere is the one outcome this must never produce.
 */
export async function copyToClipboard(
  text: string,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const tools = options.tools ?? clipboardToolsFor(process.platform);
  const spawnImpl = options.spawnImpl ?? spawn;
  for (const tool of tools) {
    const worked = await new Promise<boolean>((resolve) => {
      const child = spawnImpl(tool.command, [...tool.args], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
      child.stdin?.once("error", () => resolve(false));
      child.stdin?.end(text);
    });
    if (worked) return { ok: true, via: tool.command };
  }
  const tried = tools.map((tool) => tool.command).join(", ");
  return {
    ok: false,
    why:
      tried === ""
        ? "No clipboard tool is configured for this platform."
        : `No clipboard tool worked (tried ${tried}).`,
  };
}
