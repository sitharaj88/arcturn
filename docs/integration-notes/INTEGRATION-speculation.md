# Wiring SPECULATIVE APPROVAL into the CLI

This document is the integration recipe for `packages/cli/src/speculation.ts`
(new file, already in the tree with `speculation.test.ts`, 21 passing tests).
Per the task's hard rules **no existing file was edited** to produce this
feature — the snippets below are exact instructions for whoever wires it into
`config.ts`, `args.ts` and `runtime.ts`.

The goal in one line: **branch prediction for agents.** A permission prompt is
a stall — the model has decided what to do next, and everything freezes while a
human reads a dialog. Speculative approval keeps the agent working during that
stall, with every file mutation redirected into a shadow overlay keyed by the
pending request id. Approve → the work is already done and lands instantly.
Deny → the shadow is deleted and the workspace never knew.

The bet is only safe because it is **narrow** (only `write`/`edit` may run
speculatively) and **fail-closed** (nothing is ever applied except by an
explicit `settle(id, true)`).

## 1. What's already built

`packages/cli/src/speculation.ts` exports:

```ts
createSpeculation(options: { overlayFor: (requestId: string) => Overlay }): SpeculationController

interface SpeculationController {
  begin(requestId: string): Speculation;                             // open a shadow
  settle(requestId: string, approved: boolean): Promise<SpeculationOutcome>;
  abandonAll(): Promise<void>;                                       // fail-closed drain
  active(): string[];                                                // open ids, oldest first
  current(): Speculation | undefined;                                // innermost open one
}

interface Speculation { readonly requestId: string; readonly overlay: Overlay }

interface SpeculationOutcome {
  requestId: string;
  approved: boolean;
  status: "applied" | "partial" | "discarded" | "unknown";
  applied: readonly string[];      // real paths written back
  discarded: readonly string[];    // real paths thrown away
  errors: readonly OverlayApplyError[];   // overlay's own {path, message} shape
}

isSpeculatable(toolName: string): boolean          // allowlist: write, edit — nothing else
wrapToolsWithSpeculation(tools, controller, options?): Tool[]
formatSpeculationOutcome(outcome, cwd?): string
defaultSpeculationBlockMessage(toolName, pending): string
```

A speculation *is* an `Overlay` (`overlay.ts`) whose fate is decided by a
permission answer. Nothing about the shadow mechanism is re-implemented here:
`materialize` / `redirect` / `changes` / `apply` / `discard`, the atomic
temp-file+rename writes, and — critically — the `#insideWorkspace` symlink
confinement in `apply()` are all the overlay's, unchanged and unweakened. The
symlink-escape case is re-tested end-to-end *through* this path
(`rule 4 > refuses a change whose real path escapes the workspace through a
symlink`) so a future refactor here cannot quietly lose it.

## 2. The four hard safety rules (read before changing anything)

1. **Never apply implicitly — fail closed.** The only line of code in the module
   that writes to the workspace is inside `settle(..., approved === true)`. A
   timeout, a dropped socket, an interrupt, an unanswered request, `abandonAll`,
   or process exit all discard. `abandonAll` hard-codes `approved: false`, so no
   argument exists that can make it write. A shadow directory orphaned by a
   crash is inert: nothing scans for or resumes it.
2. **Never speculate an irreversible side effect.** Only file mutations can be
   undone by deleting a directory. `wrapToolsWithSpeculation` therefore *blocks*
   every non-allowlisted tool while a speculation is open — the wrapped tool's
   `execute` is never called, so no shell command runs and no packet leaves the
   machine — and returns an `isError` result telling the model to keep editing
   files or wait for the decision.
3. **Concurrent speculations are isolated.** One overlay per request id. A
   nested speculation materialises from the **real** workspace, not from the
   outer speculation's shadow: a guess is never stacked on an unapproved guess.
4. **Failures are reported honestly.** `settle` resolves, never rejects. A
   partial apply comes back as `status: "partial"` with the overlay's own
   `{applied, errors}` split, and `formatSpeculationOutcome` prints both halves.

## 3. `runtime.ts` — wrapping the `#ask` funnel

`#ask` (runtime.ts:784) is the single funnel every permission question goes
through, so it is the only place that needs to change. Begin before asking,
settle with the decision after:

```ts
async #ask(request: PermissionRequest): Promise<PermissionDecision> {
  if (!this.#requester) {
    return {
      requestId: request.id,
      behavior: "deny",
      message: `Permission required for "${request.toolName}" but this session cannot prompt.`,
    };
  }
  if (!this.speculation) return this.#requester(request);

  // Branch prediction: open the shadow BEFORE the human is asked, so every
  // tool call made while the dialog is up is already sheltered.
  this.speculation.begin(request.id);
  let decision: PermissionDecision;
  try {
    decision = await this.#requester(request);
  } catch (error) {
    // Rule 1: any abnormal end to the question discards. Never applies.
    await this.speculation.settle(request.id, false);
    throw error;
  }

  const approved = decision.behavior === "allow";
  const spec = this.speculation.current();          // see the checkpoint note below
  if (approved && spec?.requestId === request.id) {
    for (const change of await spec.overlay.changes()) {
      await this.checkpoints?.snapshot(change.path); // undo-ability before the apply
    }
  }
  const outcome = await this.speculation.settle(request.id, approved);
  if (outcome.status !== "unknown" && (outcome.applied.length > 0 || outcome.errors.length > 0)) {
    this.notify(
      outcome.errors.length > 0 ? "warn" : "info",
      formatSpeculationOutcome(outcome, this.paths.cwd),
    );
  }
  return decision;
}
```

Notes on the snippet:

- The checkpoint loop must run **before** `settle`, because `settle` closes the
  speculation synchronously and then deletes the shadow. `checkpoints.ts`
  snapshots the *pre-write* content of a path, and the speculative apply happens
  outside the tool wrapper where checkpoints normally hook in — without this
  loop, `/undo` would not cover speculatively-applied files.
- `settle` is idempotent per id: a second call returns `status: "unknown"` and
  writes nothing, so a retry or a double-resolved dialog is harmless.
- Construction, next to the existing overlay wiring (runtime.ts:1098):

```ts
const speculation = config.speculation && !dryRun
  ? createSpeculation({
      overlayFor: (requestId) =>
        createOverlay({
          cwd: paths.cwd,
          dir: join(paths.home, "speculations", initialSessionId, requestId),
        }),
    })
  : undefined;
```

- Shutdown, wherever the runtime already tears a session down (session end,
  `SIGINT`, fatal provider error, `dispose`): `await speculation?.abandonAll();`
  It cannot write, so it is always safe to call, including twice.
- Startup hygiene: `rm(join(paths.home, "speculations"), { recursive: true,
  force: true })` before creating the controller. Orphans from a killed process
  are inert, but they are dead weight on disk.

## 4. Config key

Opt-in, default **off**. In `config.ts`, mirroring `dryRun` exactly:

- `ArcturnConfig`: `/** Keep working in a shadow while a permission prompt waits (default false). */ speculation: boolean;`
- `DEFAULT_CONFIG`: `speculation: false,`
- `KNOWN_KEYS`: add `"speculation"`.
- Validation, next to the `dryRun` block (config.ts:317):

```ts
if (raw.speculation !== undefined) {
  if (typeof raw.speculation === "boolean") out.speculation = raw.speculation;
  else warnings.push(`${where}: "speculation" must be a boolean`);
}
```

- Merge: `speculation: layer.speculation ?? base.speculation,`
- `args.ts`: `--speculation` / `--no-speculation`, plumbed like `--dry-run`.

Default-off is deliberate. Speculation changes what the model is allowed to do
while a prompt is up (rule 2 blocks tools that would otherwise merely queue), so
it must be a choice the user makes, not a surprise.

## 5. Wrap order

The existing chain in `createRuntime` is, innermost first:

```
lsp → verify → overlay(dry-run) → taint → hooks        (+ checkpoints per-agent)
```

Speculation goes **outside `overlay`/`verify`/`lsp`, inside `taint`/`hooks`**:

```ts
const speculativeTools = speculation
  ? wrapToolsWithSpeculation(overlayTools, speculation)
  : overlayTools;
const taintedTools = wrapToolsWithTaint(speculativeTools, taintTracker, { ... });
```

Why that seam:

- **Inside hooks and taint**: a `preToolUse` deny and a taint refusal must still
  kill a speculative call. Speculation is a *destination* change, never a policy
  change — it must not be able to launder a call past a security gate.
- **Outside verify and lsp**: a blocked tool must be rejected before anything
  downstream spawns a language server or a verify command. Nothing runs for a
  tool the speculation wrapper refuses.
- **Checkpoints** wrap per-agent in `#agentOptions`, i.e. outside all of this.
  During a speculation they snapshot real files that are never written, which is
  harmless but useless; the `#ask` snapshot loop in §3 is what actually makes a
  speculative apply undoable.
- **Verify caveat**: while a speculation is open, the verifier would run its
  command against a workspace the speculative edits have not touched and report
  a misleading pass. Hosts that enable both should skip verification while
  `speculation.active().length > 0`, exactly as dry-run mode disables verify
  outright (runtime.ts:1101).

## 6. Interaction with dry-run (both use overlays)

Both features are overlays, and stacking them is a real hazard, so the
recommendation is blunt: **when `dryRun` is on, do not create the speculation
controller** (the `&& !dryRun` in §3) and push a warning:

> `Dry-run mode is on, so speculative approval is disabled for this session.`

The reason is not tidiness. With speculation wrapping outside the dry-run
overlay, a speculative write is redirected to `~/.arcturn/speculations/...`, which
is outside `cwd` and therefore invisible to the dry-run overlay's `redirect`.
`settle(id, true)` would then apply that shadow **straight to the real
workspace** — breaking dry-run's one promise, that nothing lands without an
explicit `/apply`. With the wrappers in the other order the speculation silently
does nothing (the dry-run path is already outside `cwd`), which is safe but
pointless.

There is also no benefit to combine: in dry-run mode *every* write is already
deferred to a human review, so the prompt-stall the speculation exists to hide
is not on the critical path.

A future "both on" mode would have to build the speculation overlay with
`cwd` set to the dry-run shadow root so that `settle(true)` applies *into* the
dry-run shadow rather than the workspace. That is untested and out of scope.

## 7. What cannot be speculated, and why

| Tool | Speculated? | Why |
| --- | --- | --- |
| `write`, `edit` | **yes** | Whole effect is a file mutation the overlay can redirect and delete. |
| `read` | yes (routed) | Read-only; served from the shadow so the agent sees its own pending edits. |
| `grep`, `glob`, `ls` | allowed, **not** routed | Take patterns, not a single path, so they still see the real tree — the same documented boundary dry-run has. A speculative edit is invisible to `grep`. |
| `bash` | **blocked** | Cannot redirect a shell's writes, and nothing can un-run `git push`, `rm`, a migration or a daemon start. `sed -i` looks like an edit and is not one. |
| `fetch`, `websearch` | **blocked** | A request that left the machine cannot be recalled; a POST may have already changed someone else's state. |
| `mcp__*` | **blocked** | Arbitrary third-party effects, unknown reversibility. Assume the worst. |
| sub-agents (`task`) | **blocked** | A child agent has the full toolset, including `bash`; sheltering it would need the whole permission funnel re-entered inside the speculation. |
| `verify` command | not applicable | Runs outside the tool path; see the caveat in §5. |

Two limits worth stating plainly to users:

- **A speculative edit is invisible to `grep`/`glob` and to any process outside
  the agent.** Only `read` sees it.
- **A nested speculation does not see the outer one's writes.** If the model
  edits `a.ts` under request 1 and then edits it again under request 2, the
  second edit starts from the *real* file. Approving both applies request 2's
  version last. This is the conservative choice — never build on an unapproved
  guess — but it means back-to-back prompts on the same file are not a good
  speculation target.

## 8. UI

`formatSpeculationOutcome(outcome, cwd)` renders one line per fact:

```
Speculation req-7: approved — 2 files landed.
  landed src/app.ts
  landed src/util.ts

Speculation req-7: denied — 2 files discarded, workspace untouched.
  discarded src/app.ts
  discarded src/util.ts

Speculation req-7: approved — 1 file landed, 1 file failed and were not written.
  landed src/app.ts
  failed src/evil.ts: resolves outside the workspace (symlink); refused
```

A TUI can additionally show `controller.active().length` as a "working ahead"
indicator while the dialog is up, so the user understands why the agent's output
kept scrolling after the prompt appeared.

## 9. Tests

`packages/cli/src/speculation.test.ts` — 21 tests, all passing, grouped by the
safety rule each one defends:

- **Rule 1** — a write while open does not touch the real file; approve lands it
  and clears the shadow; deny leaves the file byte-identical *and* removes the
  shadow; settling twice cannot apply twice; `abandonAll` discards two open
  speculations without writing anything; an unused speculation settles cleanly.
- **Rule 2** — `bash` is blocked while open and a spy proves `execute` never
  ran; `fetch`/`websearch`/`mcp__server__send`/`task` likewise; the same `bash`
  tool runs normally when no speculation is open and again after settling;
  read-only tools are allowed and `read` is served from the shadow;
  `isSpeculatable` allows only `write`/`edit`.
- **Rule 3** — two concurrent speculations write the same file without seeing
  each other; settling the inner one routes later writes back to the outer;
  `begin` is idempotent.
- **Rule 4** — the symlink escape is refused through this path and the outside
  file is never created; a partial apply reports both halves; an unreadable
  destination is reported instead of thrown.
- `formatSpeculationOutcome` — landed / discarded / failed / unknown wording.

Verify:

```sh
npx vitest run packages/cli/src/speculation.test.ts
npx tsc -p packages/cli/tsconfig.json --noEmit
npx biome check packages/cli/src/speculation.ts packages/cli/src/speculation.test.ts
```
