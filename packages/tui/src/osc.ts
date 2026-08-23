/**
 * OSC 11: read and write the terminal's own default background colour.
 *
 * The screen-mode canvas paints every cell, but the terminal window's inner
 * margin (the few pixels between the window edge and the cell grid) belongs
 * to the emulator and always shows ITS default background. To make a themed
 * screen reach the window edge, the app temporarily sets the terminal's
 * background to the theme's ground — after first capturing the original so
 * teardown can restore the user's terminal exactly as it was. Nothing is set
 * when the original cannot be read: a terminal too old to answer OSC 11 is
 * also the one most likely to mishandle a set, and an unrestorable change is
 * worse than a margin.
 */

/** The streams an OSC round trip needs; injectable for tests. */
export interface OscIo {
  /** Usually `process.stdin`. */
  readonly input: NodeJS.ReadStream;
  /** Usually `process.stdout`. */
  readonly output: NodeJS.WriteStream;
}

/** Options for {@link queryTerminalBackground}. */
export interface QueryBackgroundOptions {
  /** Overrides the process streams (tests). */
  io?: OscIo;
  /** How long to wait for a reply before giving up (default 150). */
  timeoutMs?: number;
}

/**
 * Extract the colour spec out of an OSC 11 reply.
 *
 * @param data - Bytes read back from the terminal, possibly split/partial.
 * @returns The raw spec (e.g. `rgb:fafa/f6f6/efef`), or `undefined`.
 */
export function parseOsc11Reply(data: string): string | undefined {
  // Reply shape: OSC 11 ; <spec> then BEL or ST. Require the terminator so a
  // split reply is retried on the next chunk rather than truncated.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing the terminal's own reply is the point.
  const match = /\]11;([^\u001b\u0007]+)(?:\u0007|\u001b\\)/.exec(data);
  const spec = match?.[1]?.trim();
  return spec && spec !== "?" ? spec : undefined;
}

/**
 * Ask the terminal for its default background colour.
 *
 * Resolves `undefined` off a TTY, on timeout, or when the answer carries no
 * colour; never rejects and never leaves the terminal in raw mode. A DA1
 * query rides along so terminals that ignore OSC 11 still end the wait early
 * (every ANSI terminal answers DA1, and answers it last).
 *
 * @param options - Stream and timeout overrides.
 */
export function queryTerminalBackground(
  options: QueryBackgroundOptions = {},
): Promise<string | undefined> {
  const input = options.io?.input ?? process.stdin;
  const output = options.io?.output ?? process.stdout;
  const timeoutMs = options.timeoutMs ?? 150;
  if (!input.isTTY || !output.isTTY) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    let buffer = "";
    let settled = false;

    const finish = (result: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      try {
        if (!wasRaw) input.setRawMode?.(false);
        input.pause();
      } catch {
        // Losing the restore is not worth crashing startup over.
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString("latin1");
      const parsed = parseOsc11Reply(buffer);
      if (parsed) {
        finish(parsed);
        return;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal's own ESC reply is the point.
      if (/\u001b\[\?[\d;]*c/.test(buffer)) finish(undefined);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      if (!wasRaw) input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      output.write("\u001b]11;?\u0007\u001b[c");
    } catch {
      finish(undefined);
    }
  });
}

/**
 * The OSC 11 sequence that sets the terminal's default background.
 *
 * @param color - Any XParseColor spec the terminal accepts: the raw reply
 *   from {@link queryTerminalBackground}, or a `#rrggbb` hex.
 */
export function setBackgroundSequence(color: string): string {
  return `\u001b]11;${color}\u0007`;
}

/**
 * Convert a 24-bit SGR open sequence (`…48;2;R;G;Bm`) to a `#rrggbb` hex the
 * terminal accepts as an OSC 11 payload, or `undefined` when the style
 * carries no truecolour background (reduced colour levels, colour off).
 */
export function backgroundHexOf(sgrOpen: string): string | undefined {
  const match = /48;2;(\d+);(\d+);(\d+)/.exec(sgrOpen);
  if (!match) return undefined;
  const channel = (value: string): string =>
    Math.max(0, Math.min(255, Number(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(match[1] ?? "0")}${channel(match[2] ?? "0")}${channel(match[3] ?? "0")}`;
}
