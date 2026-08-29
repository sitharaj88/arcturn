/**
 * Writing to the system clipboard from a terminal app.
 *
 * The full-screen TUI lives in the alternate screen, where the terminal's own
 * selection can never span more than one visible frame — so "copy the answer"
 * cannot always be a mouse gesture. This goes straight to the OS instead:
 * every desktop platform ships a stdin-to-clipboard tool, and piping to it
 * needs no terminal cooperation, no escape-sequence support and no selection.
 *
 * Two transports, chosen by where the session lives. Locally, the pipe wins:
 * every desktop platform ships a stdin-to-clipboard tool, and piping needs no
 * terminal cooperation. Over SSH the pipe is a trap — a remote `pbcopy` or
 * `xclip` writes the *remote* clipboard, which is never the one the user
 * means — so a remote session leads with OSC 52, the escape sequence that
 * asks the user's own terminal to do the copy, and the pipe becomes the
 * fallback. The tool list is ordered: Wayland's tool before the X11 ones, so
 * a Wayland session with XWayland installed lands on the clipboard the
 * user's other apps actually read.
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

/**
 * The ceiling on an OSC 52 payload, in base64 characters. Terminals cap the
 * whole sequence (xterm's historical limit is ~100KB); staying under it is
 * the difference between a copy and a silently truncated one — and a copy
 * this transport cannot make whole is refused, never truncated.
 */
const OSC52_MAX_BASE64 = 99_000;

/** What {@link copyToClipboard} needs from the outside world, injectable for tests. */
export interface CopyOptions {
  readonly tools?: readonly ClipboardTool[];
  readonly spawnImpl?: typeof spawn;
  /**
   * Writes a raw escape sequence to the controlling terminal — the OSC 52
   * channel. Absent in headless hosts, and then OSC 52 is simply not tried.
   */
  readonly writeToTerminal?: (sequence: string) => void;
  /** Environment consulted for remote-session and tmux detection. */
  readonly env?: NodeJS.ProcessEnv;
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
  const env = options.env ?? process.env;
  const remote = env.SSH_TTY !== undefined || env.SSH_CONNECTION !== undefined;

  // Over SSH the local tools write the wrong machine's clipboard, so the
  // terminal's own channel goes first; locally it is the last resort.
  if (remote) {
    const sent = tryOsc52(text, options.writeToTerminal, env);
    if (sent.ok) return sent;
  }
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
  if (!remote) {
    const sent = tryOsc52(text, options.writeToTerminal, env);
    if (sent.ok) return sent;
  }
  const tried = [
    ...tools.map((tool) => tool.command),
    ...(options.writeToTerminal ? ["osc52"] : []),
  ].join(", ");
  return {
    ok: false,
    why:
      tried === ""
        ? "No clipboard tool is configured for this platform."
        : `No clipboard tool worked (tried ${tried}).`,
  };
}

/**
 * Asks the user's terminal to make the copy (OSC 52), wrapped for tmux when
 * a tmux socket is in the environment. Fire-and-forget by design: the
 * protocol has no acknowledgement, so a sequence that was written counts as
 * sent — which is also why it never truncates. A payload over the size cap
 * is declined here and left to the caller's remaining transports.
 */
function tryOsc52(
  text: string,
  writeToTerminal: ((sequence: string) => void) | undefined,
  env: NodeJS.ProcessEnv,
): CopyResult {
  if (writeToTerminal === undefined) {
    return { ok: false, why: "No terminal channel for OSC 52." };
  }
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (payload.length > OSC52_MAX_BASE64) {
    return { ok: false, why: "Selection too large for the terminal clipboard protocol." };
  }
  let sequence = `\u001b]52;c;${payload}\u0007`;
  if (env.TMUX !== undefined) {
    // tmux passes an escape through to the outer terminal only when wrapped
    // in its DCS passthrough, with every inner ESC doubled.
    sequence = `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
  }
  writeToTerminal(sequence);
  return { ok: true, via: "osc52" };
}
