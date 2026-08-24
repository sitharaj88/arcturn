/**
 * The `arcturn` command implementations.
 *
 * Everything heavier than argument parsing lives here, loaded lazily by
 * `main.ts` so that startup pays only for the command actually being run.
 * Decides between the interactive TUI and the headless `--print` runner, and
 * translates thrown errors into tidy stderr messages plus a non-zero exit code.
 */

// Every subcommand's implementation is imported inside its own branch below:
// the interactive path — the one whose time-to-first-paint the user feels —
// must not pay for the ACP host, the WebSocket server, VCR or provenance.
import type { SessionEntry } from "@arcturn/types";
import type { CliArgs, RegistryCliCommand } from "./args.js";
import { loadConfig } from "./config.js";
import { loadExtensions } from "./extensions.js";
import { runInteractive } from "./interactive/app.js";
import type { BootScreen } from "./main.js";
import { version } from "./meta.js";
import { runPrint } from "./print.js";
import {
  BUILT_IN_TOOL_NAMES,
  buildRuntime,
  connectMcp,
  formatModelCatalog,
  formatProviderCatalog,
  ModelResolutionError,
  registerBundledCatalog,
} from "./runtime.js";

/**
 * Load extensions purely for their side effect of registering models.
 *
 * @param cwd - Working directory override from the command line.
 * @returns Warnings to report; failures here are never fatal to a listing.
 */
async function loadExtensionsForCatalog(cwd: string | undefined): Promise<string[]> {
  try {
    const { config, paths } = await loadConfig(cwd === undefined ? {} : { cwd });
    const host = await loadExtensions({
      directories: [...new Set([paths.userExtensions, paths.projectExtensions])],
      config,
      cwd: paths.cwd,
      version: version(),
      reservedToolNames: BUILT_IN_TOOL_NAMES,
    });
    return host.warnings;
  } catch (error) {
    return [`could not load extensions: ${error instanceof Error ? error.message : error}`];
  }
}

/** Options for {@link runCli}. */
export interface RunCliOptions {
  /** A boot banner `main.ts` painted, erased as the real UI takes over. */
  readonly bootScreen?: BootScreen;
}

/**
 * Run an already-parsed command line.
 *
 * @param args - Parsed arguments (see `parseArgs`).
 * @param options - See {@link RunCliOptions}.
 * @returns The process exit code.
 */
export async function runCli(args: CliArgs, options: RunCliOptions = {}): Promise<number> {
  if (args.listModels || args.listProviders) {
    // The preset models and OAuth adapters are registered here for the same
    // reason `buildRuntime` registers them: a listing must show exactly what
    // `--model` will accept.
    registerBundledCatalog();
    // Extensions register models, so they must load before the catalog is
    // printed — otherwise a model that `--model` accepts is missing from the
    // very list that is supposed to enumerate the valid values.
    const warnings = await loadExtensionsForCatalog(args.cwd);
    for (const warning of warnings) process.stderr.write(`arcturn: ${warning}\n`);
    process.stdout.write(`${args.listModels ? formatModelCatalog() : formatProviderCatalog()}\n`);
    return 0;
  }

  if (args.command?.kind === "completions") {
    const { generateCompletions, isCompletionShell } = await import("./completions.js");
    if (!isCompletionShell(args.command.shell)) {
      process.stderr.write(
        `arcturn: unknown shell "${args.command.shell}". Supported: bash, zsh, fish.\n`,
      );
      return 2;
    }
    process.stdout.write(generateCompletions(args.command.shell));
    return 0;
  }

  // `arcturn mcp-serve` — arcturn as an MCP *server*, driven by another agent.
  //
  // Matched on the positional prompt rather than on `args.command`: the `mcp`
  // family owns its entire argument list inside the parser, so `mcp serve`
  // there would read as "serve that client configuration", and a hyphenated
  // word keeps the two directions from sharing a noun. The comparison is
  // exact, excludes `--print`, and the command itself refuses to start on a
  // terminal, so the one thing this could collide with — someone typing the
  // bare word as a prompt — gets an explanation instead of a silent server.
  // The literal here is only a pre-filter, deliberately BROADER than the real
  // rule, so startup pays one string compare instead of a module load;
  // `isMcpServeInvocation` is the single tested statement of what counts.
  if (args.prompt.trim() === "mcp-serve") {
    const { isMcpServeInvocation, runMcpServe } = await import("./mcp-serve.js");
    if (isMcpServeInvocation(args)) {
      return runMcpServe({
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.model === undefined ? {} : { model: args.model }),
        // Typing a mode is the opt-in that adds the agent tool; its absence
        // leaves the server read-only. See mcp-serve.ts's module doc.
        ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
        ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
        ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
      });
    }
  }

  if (args.command?.kind === "attach") {
    return runAttachCommand(args.command.url, args);
  }

  if (args.command?.kind === "registry") {
    return runRegistryCommand(args.command);
  }

  if (args.command?.kind === "mcp") {
    const { runMcpCommand } = await import("./mcp-cli.js");
    return runMcpCommand(args.command, args.cwd === undefined ? {} : { cwd: args.cwd });
  }

  if (args.command?.kind === "acp") {
    return runAcpCommand(args);
  }

  if (args.command?.kind === "serve") {
    return runServeCommand(args);
  }

  if (args.command?.kind === "bisect") {
    return runBisectCommand(args.command.target, args);
  }

  if (args.command?.kind === "blame") {
    return runBlameCommand(args.command.file, args.command.sessionId, args.cwd);
  }

  if (args.command?.kind === "audit") {
    return runAuditCommand(args.command.sessionId, args.cwd);
  }

  if (args.command?.kind === "replay") {
    return runReplayCommand(args.command.target, args.cwd, args.model);
  }

  if (args.command?.kind === "auth") {
    const command = args.command;
    const [{ oauth }, { runAuthCommand }] = await Promise.all([
      import("@arcturn/ai"),
      import("./auth.js"),
    ]);
    if (command.action === "login" || command.action === "logout") {
      const provider = command.provider ?? "";
      const known = oauth.listOAuthProviders().map((id) => String(id));
      if (!known.includes(provider)) {
        process.stderr.write(
          `arcturn: Unknown OAuth provider "${provider}". ` +
            `Providers that support sign-in: ${known.join(", ")}\n`,
        );
        return 2;
      }
    }
    return runAuthCommand({
      command,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
  }

  try {
    const runtime = await buildRuntime({
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
      ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
      ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
      ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      continueSession: args.continueSession,
    });

    if (args.trace === true) {
      // Runtime-level subscription survives /clear and session swaps, unlike
      // agent.subscribe. Spans land on stderr so --print output stays clean.
      const { createConsoleTelemetry, createTelemetryListener } = await import("@arcturn/core");
      runtime.subscribe(
        createTelemetryListener({
          tracer: createConsoleTelemetry((line) => process.stderr.write(`${line}\n`)),
        }),
      );
    }

    if (args.mcp) {
      try {
        // A browser authorization may only interrupt a session a human is
        // watching; --print must fail with "run arcturn mcp auth" instead.
        await connectMcp(runtime, { interactive: !args.print && process.stdout.isTTY === true });
      } catch (error) {
        runtime.warnings.push(
          `MCP startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (args.print) {
      for (const warning of runtime.warnings) process.stderr.write(`arcturn: ${warning}\n`);
      // Piped stdin becomes the prompt (`cat q.txt | arcturn -p`), or leading
      // context when a prompt argument is also given. See {@link readPipedStdin}
      // for why the second case must not block on a pipe that never closes.
      const piped = (await readPipedStdin(process.stdin, args.prompt !== "")).trim();
      const prompt =
        piped === "" ? args.prompt : args.prompt === "" ? piped : `${piped}\n\n${args.prompt}`;
      if (prompt === "") {
        process.stderr.write("arcturn: --print needs a prompt (argument or piped stdin).\n");
        await runtime.dispose();
        return 2;
      }
      const result = await runPrint({
        runtime,
        prompt,
        outputFormat: args.outputFormat,
      });
      await runtime.dispose();
      return result.exitCode;
    }

    if (!process.stdout.isTTY) {
      process.stderr.write(
        "arcturn: stdout is not a terminal. Use --print for non-interactive runs.\n",
      );
      await runtime.dispose();
      return 2;
    }

    // Erased here — not earlier — so the banner stays up through runtime
    // construction and its replacement paints in the same breath.
    options.bootScreen?.erase();
    return await runInteractive({
      runtime,
      ...(args.prompt === "" ? {} : { initialPrompt: args.prompt }),
    });
  } catch (error) {
    if (error instanceof ModelResolutionError) {
      process.stderr.write(`arcturn: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * How long a `--print` run with its own prompt waits for a first byte of stdin
 * before deciding the pipe is not carrying anything for it.
 *
 * Long enough that a real producer (`cat file | arcturn -p "..."`) always wins
 * the race on any machine this runs on; short enough that nobody notices it on
 * a run that was never piped to.
 */
const STDIN_FIRST_BYTE_GRACE_MS = 250;

/** The slice of `process.stdin` {@link readPipedStdin} needs — a test seam. */
export interface StdinLike extends AsyncIterable<Buffer | string> {
  isTTY?: boolean | undefined;
  /** Present on the real `process.stdin`; lets an abandoned pipe stop holding the loop open. */
  unref?: () => void;
}

/**
 * Read the stdin a `--print` run should treat as input, without hanging on one
 * that will never end.
 *
 * `isTTY === false` means only "not a terminal", and that covers two cases
 * wanting opposite behaviour. A pipe carrying a prompt closes when its writer
 * is done (`cat q.txt | arcturn -p`), and reading to EOF is exactly right. A
 * pipe a parent process opened and kept — every CI runner, Makefile recipe,
 * `subprocess.run` and agent that spawns this binary — never closes, and
 * reading to EOF hangs forever, before a single event is emitted, with no
 * output and no diagnostic saying why. Inferring intent from one end's
 * TTY-ness is the same mistake `runMcpServe` makes if it reads only stdout.
 *
 * So the prompt argument decides which case this is:
 *
 * - **No prompt argument** — stdin *is* the prompt. Blocking to EOF is the
 *   documented behaviour and the only thing that could be correct.
 * - **A prompt argument was given** — stdin is optional leading context. Wait
 *   {@link STDIN_FIRST_BYTE_GRACE_MS} for a first byte: if one arrives the
 *   writer is really feeding us, so read to EOF as before; if none does, treat
 *   the pipe as empty and run the prompt that was actually asked for.
 *
 * The residue is a producer that takes longer than the grace period to emit
 * its first byte *and* a prompt argument beside it — its context is dropped
 * rather than the run hanging. That is the safe direction: a run that ignores
 * a slow pipe finishes and says what it did, where the old behaviour produced
 * nothing at all, forever.
 */
export async function readPipedStdin(
  stdin: StdinLike,
  hasPromptArgument: boolean,
  graceMs: number = STDIN_FIRST_BYTE_GRACE_MS,
): Promise<string> {
  if (stdin.isTTY === true) return "";
  const iterator = stdin[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];

  let first: IteratorResult<Buffer | string>;
  if (hasPromptArgument) {
    // `undefined` marks the deadline winning, which no chunk can produce.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), graceMs);
      // Never hold the process open for a pipe we have already decided to
      // give up on — the whole point is that this run gets to finish.
      timer.unref?.();
    });
    const raced = await Promise.race([iterator.next(), deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (raced === undefined) {
      // Giving up on the *value* is not enough. That `next()` is still pending
      // on a real `process.stdin`, and a pending read holds a handle, which
      // holds the event loop: the run would finish its work, emit `runEnd`,
      // and then never exit — the same hang this function exists to prevent,
      // moved to the end of the run. Close the iterator and let the handle go.
      void iterator.return?.();
      stdin.unref?.();
      return "";
    }
    first = raced;
  } else {
    first = await iterator.next();
  }

  for (let step = first; step.done !== true; step = await iterator.next()) {
    const chunk = step.value;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Print a session's audit trail.
 *
 * @param sessionId - Session to render; the newest in this directory when omitted.
 * @param cwd - Working-directory override.
 */
async function runAuditCommand(sessionId: string | undefined, cwd?: string): Promise<number> {
  const [{ JsonlSessionStore }, { auditFilePath, createAuditLog, renderAudit }] = await Promise.all(
    [import("@arcturn/core"), import("./audit.js")],
  );
  const { paths } = await loadConfig(cwd === undefined ? {} : { cwd });
  let id = sessionId;
  if (id === undefined) {
    const store = new JsonlSessionStore({ dir: paths.sessions });
    const headers = await store.list();
    id = headers[0]?.sessionId;
    if (id === undefined) {
      process.stderr.write("arcturn: no sessions found in this directory.\n");
      return 2;
    }
  }
  const log = createAuditLog(auditFilePath(paths, id));
  const entries = await log.read();
  if (entries.length === 0) {
    process.stderr.write(
      `arcturn: no audit trail for session ${id}. Enable it with "audit": true in .arcturn/config.json.\n`,
    );
    return 2;
  }
  process.stdout.write(`${renderAudit(entries).join("\n")}\n`);
  return 0;
}

/**
 * Re-run a stored session's prompts, optionally against a different model.
 *
 * @param target - Session id, or a path to a session JSONL file.
 * @param cwd - Working-directory override.
 * @param model - Model override for the replay.
 */
async function runReplayCommand(
  target: string,
  cwd?: string,
  model?: string | string[],
): Promise<number> {
  const [{ JsonlSessionStore }, { extractPrompts, replaySession }] = await Promise.all([
    import("@arcturn/core"),
    import("./replay.js"),
  ]);
  const { paths } = await loadConfig(cwd === undefined ? {} : { cwd });
  const store = new JsonlSessionStore({ dir: paths.sessions });
  let entries: SessionEntry[];
  try {
    entries = await store.entries(target);
  } catch (error) {
    process.stderr.write(
      `arcturn: could not read session "${target}": ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const prompts = extractPrompts(entries);
  if (prompts.length === 0) {
    process.stderr.write(`arcturn: session "${target}" has no user prompts to replay.\n`);
    return 2;
  }

  const runtime = await buildRuntime({
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
  });
  for (const warning of runtime.warnings) process.stderr.write(`arcturn: ${warning}\n`);
  process.stderr.write(
    `arcturn: replaying ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} on ${runtime.model.displayName}\n`,
  );

  const result = await replaySession({
    prompts,
    runtime,
    onTurn: (index, prompt) => {
      process.stderr.write(`arcturn: [${index + 1}/${prompts.length}] ${prompt.slice(0, 60)}\n`);
    },
  });
  await runtime.dispose();

  for (const turn of result.turns) {
    process.stdout.write(
      `${JSON.stringify({
        prompt: turn.prompt,
        finalText: turn.finalText,
        toolCalls: turn.toolCalls,
        costUsd: turn.costUsd,
        ...(turn.error === undefined ? {} : { error: turn.error }),
      })}\n`,
    );
  }
  process.stderr.write(`arcturn: replay total $${result.totalCostUsd.toFixed(4)}\n`);
  return result.turns.some((turn) => turn.error !== undefined) ? 1 : 0;
}

/**
 * The stderr warning `runServeCommand` prints once, right after it reports
 * the bound URL, when that bind is not loopback: `arcturn serve` only ever
 * speaks plain `ws://`, so anyone who can reach a non-loopback interface and
 * also holds the token gets full tool execution as the user running it (see
 * `serve.ts`'s module doc for the fuller threat model). Pulled out as a pure
 * function — `host in, warning-or-undefined out` — so this decision is
 * testable without exercising the rest of `runServeCommand`'s control flow
 * (a live runtime, real sockets, SIGINT/SIGTERM).
 *
 * @param host - The interface actually bound (`args.host`, defaulted).
 * @param isLoopback - Injected so the test doesn't need its own copy of the
 *   loopback address list; `runServeCommand` passes `serve.js`'s
 *   `isLoopbackHost`, the same predicate `resolveServeToken` already uses
 *   for the equivalent no-token refusal.
 */
/**
 * Run one of the package-registry or authoring verbs.
 *
 * Every implementation already takes `argv` in and an exit code out, with its
 * IO injectable, because the same functions back the `/add`-family slash
 * commands inside the TUI; this is the thin shell that hands them the argument
 * list the parser kept whole and returns their code unchanged. Both modules are
 * imported lazily, and separately, for the reason the rest of this file is: an
 * interactive launch must not pay for the registry, and `arcturn new` must not
 * pay for git.
 *
 * The home directory comes from {@link resolveArcturnPaths} rather than each
 * command's `~/.arcturn` default, so `ARCTURN_HOME` moves an install the way it
 * moves everything else Arcturn writes.
 *
 * @param command - The parsed verb and its arguments.
 * @returns The process exit code.
 */
async function runRegistryCommand(command: RegistryCliCommand): Promise<number> {
  const { resolveArcturnPaths } = await import("./paths.js");
  const paths = resolveArcturnPaths();
  const { cwd, home } = paths;

  const code = await dispatchRegistryVerb(command, cwd, home);
  // Every one of these verbs is an ordinary English word, so a prompt that was
  // not quoted lands here rather than on the model, and the usage error it gets
  // reads like a bug in Arcturn. Exit 2 is exactly the case where that is a
  // live possibility, so the escape hatch is printed there and only there.
  if (code === 2) {
    process.stderr.write(
      `arcturn: to send this as a prompt instead, quote it: arcturn "${command.verb} ..."\n`,
    );
  }
  return code;
}

/**
 * Hand one verb's arguments to its implementation.
 *
 * @param command - The parsed verb and its arguments.
 * @param cwd - Working directory for a relative local-path source.
 * @param home - Arcturn user directory.
 */
async function dispatchRegistryVerb(
  command: RegistryCliCommand,
  cwd: string,
  home: string,
): Promise<number> {
  if (command.verb === "new") {
    const { runNewCommand } = await import("./scaffold.js");
    return runNewCommand({ argv: command.argv, cwd, home });
  }

  const registry = await import("./registry.js");
  switch (command.verb) {
    case "add":
      return registry.runAddCommand({ argv: command.argv, cwd, home });
    case "inspect":
      return registry.runInspectCommand({ argv: command.argv, cwd, home });
    case "packages":
      return registry.runPackagesCommand({ argv: command.argv, home });
    case "update":
      return registry.runUpdateCommand({ argv: command.argv, cwd, home });
    case "remove":
      return registry.runRemoveCommand({ argv: command.argv, home });
  }
}

export function nonLoopbackWarning(
  host: string,
  isLoopback: (host: string) => boolean,
): string | undefined {
  if (isLoopback(host)) return undefined;
  return (
    "arcturn: serving unencrypted ws:// on a non-loopback interface; anyone with the token " +
    "has full tool execution as your user\n"
  );
}

/**
 * Host sessions over WebSocket until interrupted.
 *
 * @param args - Parsed command line, for `--host`/`--port`/`--token`/`--cwd`/`--max-cost`.
 */
async function runServeCommand(args: CliArgs): Promise<number> {
  const { runServe, isLoopbackHost } = await import("./serve.js");
  let server: Awaited<ReturnType<typeof runServe>>;
  try {
    server = await runServe({
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.host === undefined ? {} : { host: args.host }),
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(args.token === undefined ? {} : { token: args.token }),
      ...(args.model === undefined ? {} : { model: args.model }),
      // Each served session gets this ceiling independently — see
      // serve.ts's `attachCostGuard` and ACP-STATUS.md's `--max-cost` gap.
      ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
      ...(args.web === true ? { web: true } : {}),
      ...(args.webPort === undefined ? {} : { webPort: args.webPort }),
      ...(args.webOrigins === undefined ? {} : { webOrigins: args.webOrigins }),
    });
  } catch (error) {
    process.stderr.write(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  process.stdout.write(`arcturn serving on ${server.url}\n`);
  const warning = nonLoopbackWarning(args.host ?? "127.0.0.1", isLoopbackHost);
  if (warning !== undefined) process.stderr.write(warning);
  if (server.token !== undefined && server.token !== "") {
    process.stdout.write(`  attach with: arcturn attach ${server.url} --token ${server.token}\n`);
  } else {
    process.stdout.write(`  attach with: arcturn attach ${server.url}\n`);
  }
  if (server.webUrl !== undefined) {
    // The token rides in the fragment, which browsers never send to a server:
    // the page itself is unauthenticated and must never hand out the secret.
    const fragment = server.token ? `#token=${server.token}` : "";
    process.stdout.write(`  open in a browser: ${server.webUrl}${fragment}\n`);
  }
  process.stdout.write("  press Ctrl+C to stop\n");

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.stdout.write("\narcturn: shutting down\n");
  await server.stop();
  return 0;
}

/**
 * Speak the Agent Client Protocol on stdio, so an ACP-capable editor (Zed,
 * JetBrains, Neovim) can drive arcturn.
 *
 * Nothing may be written to stdout except ACP messages — the spec is explicit
 * — so every diagnostic here goes to stderr.
 *
 * @param args - Parsed command line, for `--cwd`, `--model`, `--permission-mode`,
 *   `--max-turns` and `--max-cost`.
 */
async function runAcpCommand(args: CliArgs): Promise<number> {
  const [{ createAcpAgent }, { createAcpHost }, { AcpConnection }] = await Promise.all([
    import("./acp/adapter.js"),
    import("./acp/host.js"),
    import("./acp/protocol.js"),
  ]);
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime({
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.model === undefined ? {} : { model: args.model }),
      // ACP has no `session/set_mode` handler yet (see ACP-STATUS.md), so
      // `--permission-mode` at startup is the only way to control it today.
      ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
      // `--max-turns` is enforced per `Agent` (core's own loop), so every
      // session `buildSessionAgent` builds inherits it automatically.
      ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
      // `--max-cost` is deliberately NOT forwarded here: `buildRuntime`'s own
      // cost guard only ever watches `runtime.agent`, which `arcturn acp` never
      // prompts (see createAcpHost's `maxCostUsd` below for the real wiring).
    });
  } catch (error) {
    process.stderr.write(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  for (const warning of runtime.warnings) process.stderr.write(`arcturn: ${warning}\n`);

  // `host` owns the mapping from each ACP `sessionId` to its own isolated
  // `Agent` (see acp/host.ts) — `runtime.agent`, the TUI/`--print` "live"
  // agent, is never touched here. `maxCostUsd` gives each session its own
  // `--max-cost` ceiling, since `runtime`'s own cost guard cannot see these
  // agents at all.
  const host = createAcpHost(runtime, {
    agentInfo: { name: "arcturn", version: version() },
    ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
  });
  const agent = createAcpAgent(host);
  // Permission approvals must round-trip through the editor's
  // `session/request_permission`, not arcturn's TUI dialog; `bindPermissions`
  // closes the loop between the adapter (which owns the ACP-facing prompt
  // factory) and the host (which binds each session's own `Agent` to it, once,
  // at session-creation time — never a shared, rebindable slot).
  host.bindPermissions((sessionId) => agent.permissionPrompt(sessionId));

  const connection = new AcpConnection({
    input: process.stdin,
    output: process.stdout,
    onError: (error) => {
      process.stderr.write(`arcturn acp: ${error.message}\n`);
    },
  });
  agent.attach(connection);
  connection.listen();

  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  connection.dispose();
  // Closes every per-session MCP connection host.ts opened for `session/new`'s
  // `mcpServers` (see ACP-STATUS.md) — `runtime.dispose()` only knows about
  // the process-wide MCP servers `--mcp` connected, not these.
  await host.dispose();
  await runtime.dispose();
  return 0;
}

/**
 * Attach this terminal to a session hosted by `arcturn serve`.
 *
 * @param url - WebSocket URL of the serving instance.
 * @param args - Parsed command line, for `--token` and `--cwd`.
 */
async function runAttachCommand(url: string, args: CliArgs): Promise<number> {
  if (!process.stdout.isTTY) {
    process.stderr.write("arcturn: attach needs a terminal.\n");
    return 2;
  }
  const { runAttach } = await import("./attach.js");
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(url);
  try {
    return await runAttach({
      socket,
      url,
      ...(args.token === undefined ? {} : { token: args.token }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
  } catch (error) {
    process.stderr.write(
      `arcturn: could not attach to ${url}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

/**
 * Explain a file: which turn wrote each line, and on what evidence.
 *
 * @param file - File to explain, relative to the working directory.
 * @param sessionId - Session to read provenance from; newest when omitted.
 * @param cwd - Working-directory override.
 */
async function runBlameCommand(
  file: string,
  sessionId: string | undefined,
  cwd?: string,
): Promise<number> {
  const [
    { JsonlSessionStore },
    { createProvenanceStore, formatBlame },
    { cwdHash },
    { join, resolve },
  ] = await Promise.all([
    import("@arcturn/core"),
    import("./provenance.js"),
    import("./paths.js"),
    import("node:path"),
  ]);
  const { paths } = await loadConfig(cwd === undefined ? {} : { cwd });
  let id = sessionId;
  if (id === undefined) {
    const store = new JsonlSessionStore({ dir: paths.sessions });
    const headers = await store.list();
    id = headers[0]?.sessionId;
    if (id === undefined) {
      process.stderr.write("arcturn: no sessions found in this directory.\n");
      return 2;
    }
  }
  const provenance = createProvenanceStore(join(paths.home, "provenance", cwdHash(paths.cwd), id));
  const lines = await provenance.blame(resolve(paths.cwd, file));
  if (lines.length === 0) {
    process.stderr.write(
      `arcturn: no provenance for ${file} in session ${id}. Enable it with "provenance": true.\n`,
    );
    return 2;
  }
  process.stdout.write(`${formatBlame(lines).join("\n")}\n`);
  return 0;
}

/**
 * Binary-search a session for the turn where behaviour left its recording.
 *
 * @param target - Session id whose prompts are replayed.
 * @param args - Parsed command line, for `--cassette` and `--cwd`.
 */
async function runBisectCommand(target: string, args: CliArgs): Promise<number> {
  if (args.cassette === undefined) {
    process.stderr.write("arcturn: bisect needs --cassette <file> (record one with VCR first).\n");
    return 2;
  }
  const [
    { JsonlSessionStore },
    { bisectTurns, cassetteProbe, formatBisectResult },
    { extractPrompts, replaySession },
    { replayingClient, replayTools },
  ] = await Promise.all([
    import("@arcturn/core"),
    import("./bisect.js"),
    import("./replay.js"),
    import("./vcr.js"),
  ]);
  const { paths } = await loadConfig(args.cwd === undefined ? {} : { cwd: args.cwd });
  const store = new JsonlSessionStore({ dir: paths.sessions });
  let prompts: string[];
  try {
    prompts = extractPrompts(await store.entries(target));
  } catch (error) {
    process.stderr.write(
      `arcturn: could not read session "${target}": ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  if (prompts.length === 0) {
    process.stderr.write(`arcturn: session "${target}" has no prompts to bisect.\n`);
    return 2;
  }

  const probe = cassetteProbe(args.cassette, prompts, async (cassette, slice) => {
    const runtime = await buildRuntime({
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      // The cassette is keyed on the model id, so replaying under a different
      // model misses on turn 0 and reports a confident, wrong "turn 0".
      ...(args.model === undefined ? {} : { model: args.model }),
      replay: true,
      extensions: false,
      llm: replayingClient(cassette),
      wrapAgentTools: (tools) => replayTools(tools, cassette),
    });
    try {
      await replaySession({ prompts: [...slice], runtime });
    } finally {
      await runtime.dispose();
    }
  });

  const result = await bisectTurns(prompts, probe);
  process.stdout.write(`${formatBisectResult(result, { label: (prompt) => prompt })}\n`);
  return result.firstBadIndex === undefined ? 0 : 1;
}
