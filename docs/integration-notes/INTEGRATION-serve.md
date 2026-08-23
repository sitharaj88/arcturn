# `arcturn serve` — integration plan

This documents how `arcturn serve [--host H] [--port N] [--token T]` wires into
the existing CLI. Per the task's hard rules, **no existing file was edited**
to build this feature — `packages/cli/src/serve.ts` and
`packages/cli/src/serve.test.ts` are new, self-contained, and export
everything a `serve` subcommand needs. This document specifies the (not yet
applied) changes to `packages/cli/package.json`, `args.ts` and `main.ts`
that would wire it in, mirroring the existing `completions`/`replay`/`audit`
positional-command pattern exactly.

## Required dependency (not applied)

**`packages/cli/package.json` does not currently depend on
`@arcturn/server`** — confirmed by reading the file and by checking
`packages/cli/node_modules/@arcturn/` (no `server` symlink there, unlike
every other `@arcturn/*` package `runtime.ts` imports). `serve.ts` imports
`SessionHost`, `ArcturnServer` and the type `AgentFactoryOptions` from
`@arcturn/server`, so this one-line addition to the `"dependencies"` block
of `packages/cli/package.json` is required before `serve.ts` will resolve or
build, in either `pnpm install` or TypeScript's `NodeNext` resolution:

```json
    "@arcturn/server": "workspace:*",
```

Insert it alphabetically, between `"@arcturn/protocol"` and
`"@arcturn/tools"`. No other dependency is needed — `serve.ts` otherwise
only imports `node:crypto`, `@arcturn/core` (already a dependency, for
`Agent`), `@arcturn/types` (already a dependency), and its own
`runtime.ts`/`paths.ts`.

Until that line is added, `serve.ts`/`serve.test.ts` cannot be resolved by
either `tsc` or `vitest` — see **Verification** below for exactly what fails
and why, and how it was confirmed to work once the dependency is present.

## What already exists (`packages/cli/src/serve.ts`)

- `runServe(options: { cwd?, host?, port?, token?, model? }): Promise<{ url,
  token, stop }>` — builds a `ArcturnRuntime` via `buildRuntime`, wires it into a
  `SessionHost`/`ArcturnServer` pair (see below), starts listening, and returns
  the `ws://` URL, the effective token, and a `stop()` that closes the
  server and disposes the runtime. Resolves the token — and refuses a
  doomed non-loopback-without-auth bind — **before** calling `buildRuntime`,
  so a bad invocation fails in microseconds instead of after paying for
  config/extension/skill loading.
- `createServeHost(runtime: ServableRuntime): SessionHost` — the pure-ish,
  separately-tested assembly step. `ServableRuntime` is the minimal slice of
  `ArcturnRuntime` this needs (`llm`, `model`, `cwd`, `env`, `store`,
  `systemPrompt`, `tools`, `config.{permissions,permissionMode}`,
  `dispose()`); a real `ArcturnRuntime` satisfies it structurally with no
  changes to `runtime.ts`. Its `agentFactory` builds a fresh `Agent` per
  served session from those pieces plus `runtime.ts`'s own exported
  `resolveModelSpec` (per-session `--model` override) and
  `compactionOptionsFor`.
- `resolveServeToken(host, token?)` / `generateServeToken()` /
  `isLoopbackHost(host)` — the token/security policy, pure functions:
  - No `token` → always auto-generate one (`32` hex chars via
    `randomBytes(16)`), on **every** host, including loopback.
  - `token: ""` → an explicit "run without authentication" request. Honoured
    only on a loopback host (`127.0.0.1`, `localhost`, `::1`); throws
    `ServeBindError` everywhere else.
  - Any other string → used as-is.
- `formatServeUrl(host, port)` — `ws://host:port`, bracketing a literal IPv6
  host (`ws://[::1]:1234`).
- `ServeBindError` — thrown by `resolveServeToken` (and so by `runServe`)
  for the non-loopback-without-auth case.

### Known limitation (documented in `serve.ts`'s `ServableRuntime` TSDoc)

`ServableRuntime.tools` is read once, from `ArcturnRuntime.tools` (itself
`this.agent.tools` — the runtime's own singleton agent, checkpoint-wrapped
against *that* agent's checkpoint store) at the moment `createServeHost` is
called, and reused for every served session's `Agent`. Consequences:

- `write`/`edit` tool calls from served sessions work, but their checkpoints
  land in the runtime's own session's checkpoint directory rather than each
  served session's own — `/rewind`-style recovery does not cleanly isolate
  concurrently served sessions from each other or from the runtime's own.
- Tools were built once against `runtime.cwd` (inside `buildRuntime`'s
  `createDefaultTools` call). `AgentFactoryOptions.cwd` is still threaded
  into the constructed `Agent` (so the session header and stored transcript
  record the right `cwd`), but the tool implementations themselves still
  operate against the runtime's original working directory — a served
  session opened with a different `cwd` will not actually sandbox tool
  execution to that directory.

Fixing both precisely needs one accessor `runtime.ts` does not have today —
called out in `serve.ts`'s `ServableRuntime` TSDoc rather than added, since
editing `runtime.ts` was out of scope for this task:

```ts
// On ArcturnRuntime, mirroring the private #createAgent/#agentOptions but
// parameterized instead of closing over the singleton this.checkpoints:
buildSessionAgent(opts: { sessionId: string; cwd: string; model?: string }): Agent
```

## New types needed only by the CLI wiring (not part of `serve.ts`)

These belong in `args.ts` alongside `AuthCommand` / `CompletionsCommand` /
`ReplayCommand` / `AuditCommand` (`packages/cli/src/args.ts:30-63`):

```ts
/** A parsed `serve [--host H] [--port N] [--token T]` command. */
export interface ServeCommand {
  /** Command family. */
  readonly kind: "serve";
  /** `--host`: interface to bind. Defaults to "127.0.0.1" in the handler. */
  readonly host?: string;
  /** `--port`: port to bind. Defaults to an OS-assigned ephemeral port. */
  readonly port?: number;
  /** `--token`: shared-secret token; "" explicitly disables auth (loopback only). */
  readonly token?: string;
}

export type CliCommand = AuthCommand | CompletionsCommand | ReplayCommand | AuditCommand | ServeCommand;

/** First positional that switches into serve-command parsing. */
export const SERVE_COMMAND_NAME = "serve";
```

`CliArgs` (`packages/cli/src/args.ts:78-111`) gains three generic optional
fields, parsed like any other value flag and only consumed by the `serve`
branch — exactly how `replay` reuses the already-generic `--model`/`args.model`:

```ts
/** `--host`: interface `arcturn serve` binds. */
host?: string;
/** `--port`: port `arcturn serve` binds. */
port?: number;
/** `--token`: shared-secret token for `arcturn serve`; "" disables auth (loopback only). */
token?: string;
```

### Parsing (`args.ts`)

`VALUE_FLAGS` (`packages/cli/src/args.ts:195-203`) gains `--host`, `--port`,
`--token`. Three new cases in the flag `switch` (`args.ts:266-336`), next to
`--cwd`/`--max-turns`:

```ts
case "--host":
  args.host = value;
  break;
case "--port": {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return { ok: false, error: "--port must be an integer between 0 and 65535" };
  }
  args.port = parsed;
  break;
}
case "--token":
  args.token = value;
  break;
```

A new command branch, alongside the existing `audit`/`replay`/`completions`
checks (`args.ts:339-367`) — `serve` takes no positionals, only flags:

```ts
if (positional[0] === SERVE_COMMAND_NAME && commandCandidates > 0) {
  if (positional.length > 1) {
    return { ok: false, error: "serve takes no positional arguments; use --host/--port/--token" };
  }
  args.command = {
    kind: "serve",
    ...(args.host === undefined ? {} : { host: args.host }),
    ...(args.port === undefined ? {} : { port: args.port }),
    ...(args.token === undefined ? {} : { token: args.token }),
  };
  args.prompt = "";
  return { ok: true, args };
}
```

`helpText()` (`packages/cli/src/args.ts:404-452`) gains a command line and
three option lines:

```
  ${PRODUCT_NAME} serve [options]               expose sessions over WebSocket

  ...

      --host <addr>              arcturn serve: interface to bind (default 127.0.0.1).
      --port <n>                 arcturn serve: port to bind (default: OS-assigned).
      --token <token>            arcturn serve: shared secret clients must present
                                 ("" explicitly disables auth; loopback only).
```

### Dispatch (`main.ts`)

Imports gain `runServe` and `ServeBindError` from `./serve.js`
(`packages/cli/src/main.ts:14-32`, next to the other `./*.js` imports).
`main()` gains a fourth command branch, next to the existing
`completions`/`audit`/`replay`/`auth` checks (`main.ts:92-116`):

```ts
if (args.command?.kind === "serve") {
  return runServeCommand(args.command, args.cwd);
}
```

`runServeCommand` is new, local to `main.ts` (same treatment as
`runAuditCommand`/`runReplayCommand`, `main.ts:224-308`):

```ts
async function runServeCommand(command: ServeCommand, cwd?: string): Promise<number> {
  try {
    const { url, token, stop } = await runServe({
      ...(cwd === undefined ? {} : { cwd }),
      ...(command.host === undefined ? {} : { host: command.host }),
      ...(command.port === undefined ? {} : { port: command.port }),
      ...(command.token === undefined ? {} : { token: command.token }),
    });
    process.stdout.write(`arcturn: serving on ${url}\n`);
    process.stdout.write(
      token === undefined
        ? "arcturn: authentication disabled (loopback, --token \"\").\n"
        : `arcturn: attach with: arcturn attach ${url} --token ${token}\n`,
    );
    // Keep the process alive until interrupted, then shut down cleanly.
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void stop().then(resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  } catch (error) {
    if (error instanceof ServeBindError) {
      process.stderr.write(`arcturn: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
```

Note: `arcturn attach` (the client half that would consume the printed hint) is
a separate command this task did not build — the printed hint is
forward-looking text matching the task's design spec, naming the command a
follow-up task should add. `arcturn serve` itself is fully self-sufficient
without it (any WebSocket client speaking `@arcturn/protocol`'s wire
format, e.g. `wscat` plus hand-written JSON frames, can attach today).

## Example usage

```sh
# Bind loopback only, auto-generated token (the safe default).
arcturn serve
# arcturn: serving on ws://127.0.0.1:54213
# arcturn: attach with: arcturn attach ws://127.0.0.1:54213 --token 3f9a1e...

# Fixed port, explicit token (e.g. for a reused SSH tunnel).
arcturn serve --port 8811 --token my-shared-secret

# Bind every interface — REQUIRES a token; refused otherwise.
arcturn serve --host 0.0.0.0 --port 8811
# (auto-generates a token since none was given — this succeeds)

arcturn serve --host 0.0.0.0 --port 8811 --token ""
# arcturn: Refusing to bind 0.0.0.0 without a token: anyone who can reach this
# port would get full tool execution as this user. ...
```

## Verification

- `npx vitest run packages/cli/src/serve.test.ts` — **16 tests, all
  passing** (`generateServeToken` shape/uniqueness, `isLoopbackHost`,
  `resolveServeToken`'s auto-generate/explicit/opt-out/refusal matrix,
  `formatServeUrl` IPv4/IPv6/already-bracketed, `createServeHost` wiring a
  scripted-LLM `ServableRuntime` into a working `SessionHost`
  (`createSession` → `prompt` → observed `runEnd`), a real `ArcturnServer`
  bound to `127.0.0.1:0` accepting a raw TCP connection and refusing one
  after `stop()`, and `runServe` refusing a non-loopback
  authentication-disabled bind before touching `buildRuntime` at all).
- `npx tsc -p packages/cli/tsconfig.json --noEmit` — clean for `serve.ts`
  (test files are excluded from that project by the existing `tsconfig.json`
  `exclude`, matching every other `*.test.ts` in the package).
  `serve.test.ts` was additionally typechecked directly against
  `tsconfig.base.json`'s strict settings (`--strict
  --noUncheckedIndexedAccess`, `NodeNext`/`NodeNext`) with no errors.
- **Both of the above were run twice**: once against the real state of the
  repo (import fails — `Cannot find package '@arcturn/server'`, exactly
  because of the missing dependency documented above) and once with a
  *temporary* `packages/cli/node_modules/@arcturn/server` symlink added
  purely to self-verify the code (not `pnpm install`, not a `package.json`
  edit — the file this task was told not to touch was never written to).
  The symlink was removed immediately after; `git status` before and after
  confirms `packages/cli/package.json` is untouched. With the dependency
  resolvable, all tests and both typechecks pass cleanly; without it, both
  commands fail in exactly the way adding the one dependency line above is
  expected to fix.
- No other existing files were read-then-left-unedited by accident — `args.ts`,
  `main.ts`, `runtime.ts` and `packages/server/*` were only ever `Read`, never
  `Edit`/`Write`.
