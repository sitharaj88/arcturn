/**
 * The command line the extension hands `arcturn serve`, and the normalisation
 * of Builder A's resolved-CLI value into something spawnable.
 *
 * Every flag here exists in `packages/cli/src/args.ts` today
 * (`--host`, `--port`, `--cwd`, `--token`, `--model`); nothing is invented.
 * The defaults encode RFC 0004 §1's requirement literally: loopback interface,
 * ephemeral port, generated token.
 */

/**
 * The shape of Builder A's `ResolvedCli`, structurally.
 *
 * A's `src/cli.ts` owns the real type; this accepts either field name it is
 * likely to use so the seam does not break on a rename, and normalises both to
 * a spawnable `{ command, args }`. When A's type lands, `sidebar/index.ts` can
 * import it directly — this stays as the normaliser.
 */
export interface ResolvedCliLike {
  /** Executable to spawn. */
  readonly command?: string;
  /** Alternative spelling of {@link ResolvedCliLike.command}. */
  readonly path?: string;
  /** Leading arguments, for a resolution like `npx arcturn`. */
  readonly args?: readonly string[];
  /** Detected engine version, unused here. */
  readonly version?: string;
}

/** A spawnable invocation. */
export interface CliInvocation {
  command: string;
  args: string[];
}

/**
 * Normalise a resolved CLI into `{ command, args }`.
 *
 * @param cli - Whatever `resolveCli()` produced, possibly `undefined` when the
 *   engine could not be found.
 * @returns The invocation, or `undefined` when there is nothing to spawn.
 */
export function cliInvocation(cli: ResolvedCliLike | undefined): CliInvocation | undefined {
  if (cli === undefined || cli === null) return undefined;
  const raw = typeof cli.command === "string" ? cli.command : cli.path;
  if (typeof raw !== "string") return undefined;
  const command = raw.trim();
  if (command === "") return undefined;
  return { command, args: [...(cli.args ?? [])] };
}

/** Inputs for {@link buildServeArgs}. */
export interface ServeArgsOptions {
  /** Workspace folder the served sessions run in (`--cwd`). */
  cwd: string;
  /** Generated shared secret (`--token`). Must be non-empty. */
  token: string;
  /** `--port`; `0` (the default) asks the OS for an ephemeral port. */
  port?: number;
  /** `--model`, when the user picked one before the server started. */
  model?: string;
}

/** Loopback only. `serve.ts`'s threat model is the reason, not a preference. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Build the argument vector for `arcturn serve`.
 *
 * @param options - See {@link ServeArgsOptions}.
 * @throws {RangeError} When `port` is outside the range `args.ts` accepts.
 * @throws {TypeError} When `token` is empty — the engine reads `--token ""` as
 *   "run with authentication disabled", which is never what this extension
 *   wants even on loopback (any other local process could then attach).
 */
export function buildServeArgs(options: ServeArgsOptions): string[] {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("arcturn.serve.port must be an integer between 0 and 65535");
  }
  if (options.token === "") {
    throw new TypeError("Refusing to start arcturn serve with an empty token");
  }
  return [
    "serve",
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(port),
    "--cwd",
    options.cwd,
    "--token",
    options.token,
    ...(options.model === undefined ? [] : ["--model", options.model]),
  ];
}
