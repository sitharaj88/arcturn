# Audit receipts — integration

This documents how `packages/cli/src/audit.ts` (new file, plus its test file
`audit.test.ts`) would be wired into the running CLI. Per the task's hard
rules, **no existing file was edited** to build this — `runtime.ts`,
`hooks.ts`, `paths.ts`, `config.ts` and `args.ts` are exactly as they were.
Everything below is the concrete diff a follow-up change would make, with
real function names and line numbers from the current tree so it can be
applied mechanically.

## What `audit.ts` exports

| Export | Purpose |
| --- | --- |
| `AuditEntry` (+ `AuditToolEntry`, `AuditPermissionEntry`, `AuditHookEntry`) | The discriminated union written to the log. |
| `createAuditLog(file): AuditLog` | Append-only JSONL store — `record()`/`read()`, write-queue serialized like `JsonlSessionStore.append` (`packages/core/src/session/jsonl-store.ts:121-145`). |
| `auditFilePath(paths, sessionId)` | `<home>/audit/<cwdHash(cwd)>/<sessionId>.jsonl`, mirroring `ArcturnPaths.sessions` (`packages/cli/src/paths.ts:98`). |
| `auditObserver(log, now?)` | `AgentEventListener` that turns `toolEnd` into `"tool"` entries and matched `permissionRequest`/`permissionDecision` pairs into `"permission"` entries. |
| `auditedHookRunner(runner, log, now?)` | Wraps a `HookRunner` so every verdict it returns is also recorded as a `"hook"` entry, with no change to `hooks.ts`. |
| `renderAudit(entries)` | Human-readable lines + tally, for `arcturn audit <sessionId>`. |

## 1. `paths.ts` — a per-session audit directory

`resolveArcturnPaths` (`packages/cli/src/paths.ts:78-100`) already buckets
sessions by `cwdHash`:

```ts
sessions: join(sessionsRoot, cwdHash(cwd)),
```

The equivalent addition, mirroring that field one-for-one:

```ts
// ArcturnPaths interface
/** `~/.arcturn/audit`. */
readonly auditRoot: string;
/** Audit directory for this working directory, like `sessions`. */
readonly audit: string;

// resolveArcturnPaths body
const auditRoot = join(home, "audit");
// ...
auditRoot,
audit: join(auditRoot, cwdHash(cwd)),
```

`audit.ts`'s `auditFilePath(paths, sessionId)` computes the same path today
(`join(paths.home, "audit", cwdHash(paths.cwd), sessionId + ".jsonl")`)
without needing this field — it only reads `paths.home`/`paths.cwd`, both of
which already exist — so the field above is a convenience, not a
prerequisite; `buildRuntime` can call `auditFilePath(paths, sessionId)`
directly.

## 2. `config.ts` — the `audit: boolean` flag

`ArcturnConfig` (`packages/cli/src/config.ts:41-60`) and `DEFAULT_CONFIG`
(`config.ts:84-93`) would gain:

```ts
// ArcturnConfig
/** Record every tool call, permission decision and hook verdict (default false). */
audit: boolean;

// DEFAULT_CONFIG
audit: false,
```

plus `"audit"` added to `KNOWN_KEYS` (`config.ts:97-107`) and a boolean
parse branch alongside the existing `lsp`/`sandbox` parsing further down in
the same file, so `{"audit": true}` in `~/.arcturn/config.json` or
`<cwd>/.arcturn/config.json` turns it on. `--audit` could also be added to
`args.ts` as a bare flag next to `--mcp`/`--no-mcp`
(`packages/cli/src/args.ts` around the `--no-mcp` case at line ~270) for a
per-run override, following the same `args.audit === undefined ? config.audit : args.audit`
pattern `buildRuntime` already uses for `permissionMode`
(`runtime.ts:774`).

## 3. `runtime.ts` — constructing and subscribing the log

In `buildRuntime` (`packages/cli/src/runtime.ts:719`), right after
`sessionId` is known (the block at `runtime.ts:841-849`, which already
resolves `options.resume`/`continueSession` into a concrete id — and for a
brand-new session, `ArcturnRuntime`'s own `createSessionId()` call inside
`#agentOptions`, `runtime.ts:586`, is the id to use instead):

```ts
const hookRunner = config.audit
  ? auditedHookRunner(createHookRunner(config.hooks, { cwd: paths.cwd, env }), auditLog)
  : createHookRunner(config.hooks, { cwd: paths.cwd, env });
```

replacing the plain `createHookRunner(...)` call at `runtime.ts:803`. Because
`wrapToolsWithHooks` (`hooks.ts:440-442`, called at `runtime.ts:809`) and the
direct `hookRunner.run("sessionStart", ...)` / `hookRunner.run("runEnd", ...)`
calls (`runtime.ts:810` and `runtime.ts:572` in `dispose()`) all go through
the `HookRunner` interface, wrapping it once here captures every
`preToolUse`, `postToolUse`, `sessionStart` and `runEnd` verdict — no edits
needed inside `hooks.ts` itself.

The tool/permission side subscribes through the existing event pipe. `#attach`
(`runtime.ts:634-636`) already does `agent.subscribe((event) => this.#onEvent(event))`
for every agent (including sub-agents' parent-facing swap in `#swap`,
`runtime.ts:627-632`); `ArcturnRuntime.subscribe` (`runtime.ts:411-416`) is the
public surface UIs use for exactly this kind of side-channel listener. So in
`buildRuntime`, once `runtime` exists (`runtime.ts:839`, `runtimeRef = runtime;`):

```ts
if (config.audit) {
  const auditLog = createAuditLog(auditFilePath(paths, /* the resolved sessionId */));
  runtime.subscribe(auditObserver(auditLog));
}
```

`ArcturnRuntime.subscribe` is deliberately survives session swaps
(`runtime.ts:404-410`'s doc comment: "The subscription survives session
changes, unlike `agent.subscribe`"), so one `auditObserver` keeps recording
correctly across `/rewind` and `startNewSession`/`resumeSession` calls
without re-subscribing.

## 4. `runtime.ts#ask` — permission decisions

`#ask` (`runtime.ts:616-625`) is the single place a `PermissionRequest`
actually reaches a human (or the print-mode auto-deny):

```ts
async #ask(request: PermissionRequest): Promise<PermissionDecision> {
  if (!this.#requester) {
    return { requestId: request.id, behavior: "deny", message: `...` };
  }
  return this.#requester(request);
}
```

Note this duplicates what `auditObserver` already derives from the
`permissionRequest`/`permissionDecision` event pair emitted by
`PermissionEngine.#resolve` (`packages/core/src/permissions.ts:435-437`) and
`PermissionEngine.ask` (`permissions.ts:380-393`) — either the event-based
`auditObserver` wiring in step 3, *or* a direct `auditLog.record(...)` call
added to `#ask`, is sufficient; wiring both would double-record every ask.
The event-based path (step 3) is recommended since it needs no change to
`runtime.ts` at all — `#ask` is listed here for completeness, in case a host
embedding `ArcturnRuntime` directly (bypassing the `AgentEvent` stream) needs the
same audit trail.

## 5. `args.ts` / `main.ts` — `arcturn audit <sessionId>`

Mirroring `completions` exactly:

- `args.ts`: add `AUDIT_COMMAND_NAME = "audit"` next to
  `COMPLETIONS_COMMAND_NAME` (`args.ts:116`), a `ParsedAuditCommand` union
  member next to the `completions` one (`args.ts:40-44`), and a positional
  branch next to the one at `args.ts:305-313`:

  ```ts
  if (positional[0] === AUDIT_COMMAND_NAME && commandCandidates > 0) {
    const sessionId = positional[1];
    if (sessionId === undefined || positional.length > 2) {
      return { ok: false, error: "audit needs exactly one session id" };
    }
    args.command = { kind: "audit", sessionId };
    args.prompt = "";
    return { ok: true, args };
  }
  ```

- `main.ts`: a branch next to the `completions` handling at
  `main.ts:88-97`:

  ```ts
  if (args.command?.kind === "audit") {
    const { config, paths } = await loadConfig({
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
    const log = createAuditLog(auditFilePath(paths, args.command.sessionId));
    const entries = await log.read();
    process.stdout.write(`${renderAudit(entries).join("\n")}\n`);
    return 0;
  }
  ```

- `completions.ts`'s `DEFAULT_COMPLETION_SPEC.subcommands`
  (`completions.ts:184-202`) would gain an `audit` entry alongside `auth`
  and `completions`, so shell completion picks it up automatically — no
  change to the completion *generators* themselves, since they already
  render whatever is in the spec table.

## Verification performed

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/audit.test.ts   # 17 passed
npx tsc -p packages/cli/tsconfig.json --noEmit  # clean
npx biome check packages/cli/src/audit.ts packages/cli/src/audit.test.ts  # clean
```
