# Wiring background agents into the CLI

Integration recipe for `packages/cli/src/background-agents.ts` (new file,
already in the tree with `background-agents.test.ts`). Per the task's rules
no existing file was edited — everything below is an exact instruction for
whoever wires it into `commands.ts` and the interactive app.

The idea in one line: `/bg <task>` hands a task to a child `Agent` that runs
in its own session, off the foreground thread, with its own durable status
record — `/bg` lists them, `/bg logs <id>` shows the transcript so far,
`/bg cancel <id>` aborts one, `/bg adopt <id>` folds its result back into the
live conversation.

---

## 1. What's already built

`packages/cli/src/background-agents.ts` exports:

```ts
// --- types -------------------------------------------------------------
type BackgroundAgentStatusValue =
  "running" | "done" | "failed" | "cancelled" | "interrupted";

interface BackgroundAgentStatus {
  id: string; sessionId: string; task: string; modelId: string;
  status: BackgroundAgentStatusValue;
  createdAt: number; startedAt?: number; endedAt?: number; elapsedMs: number;
  usage: Usage; costUsd: number;
  finalText?: string; error?: string;
}

interface StartBackgroundAgentOptions {
  task: string; model?: ModelSpec; cwd?: string;
  tools?: readonly Tool[]; permissionMode?: PermissionMode;
}

interface BackgroundAgentManagerOptions {
  dir: string; llm: LLMClient; model: ModelSpec; tools: readonly Tool[]; cwd: string;
  systemPrompt?: string; permissionMode?: PermissionMode;   // default "default", never "yolo"
  concurrency?: number;                                     // default 3
  maxTurns?: number; now?: () => number;
}

// --- the manager ---------------------------------------------------------
class BackgroundAgentManager {
  constructor(options: BackgroundAgentManagerOptions);
  setDefaults(defaults: { llm?; model?; tools?; cwd? }): void;
  start(options: StartBackgroundAgentOptions): { id: string; sessionId: string };  // sync, returns at once
  list(): BackgroundAgentStatus[];
  get(id: string): BackgroundAgentStatus | undefined;
  cancel(id: string): boolean;
  result(id: string): Promise<BackgroundAgentStatus | undefined>;   // resolves at a terminal status
  transcript(id: string): Promise<Message[] | undefined>;
  onUpdate(listener: (status: BackgroundAgentStatus) => void): () => void;
}

// --- runtime binding + commands ------------------------------------------
function getBackgroundAgentManager(runtime: ArcturnRuntime): BackgroundAgentManager;  // memoized per runtime
function createBackgroundAgentCommands(): SlashCommand[];  // one command: "bg"
```

`getBackgroundAgentManager` is a `WeakMap<ArcturnRuntime, BackgroundAgentManager>`
lookup: the first call for a given runtime constructs the manager (rooted at
`<paths.home>/background-agents`, cloning the runtime's current `llm` /
`model` / `tools` / `cwd`); every later call for the *same* runtime returns
the *same* instance and refreshes its model/tools/cwd defaults from the
runtime first. That means `background-agents.ts` has **zero** dependency on
anything mutable in `runtime.ts` beyond reading those four public fields plus
`paths.home` and `agent` — no method needed on `ArcturnRuntime`, unlike scouts.

Durability: every status record is written synchronously to
`<dir>/records/<id>.json` on every transition, and re-read synchronously at
construction (`list()`/`get()` are synchronous, so loading has to be too). A
session's messages live in a normal `JsonlSessionStore` at `<dir>/sessions/`,
so `arcturn --resume <sessionId>` (pointed at that directory) or any other
`JsonlSessionStore` reader can pick a background agent's conversation back up
like any other session.

---

## 2. `commands.ts` — the one registration line

`createBuiltInCommands()` returns a flat array; `createCommandRegistry()`
registers it and then extension commands (which cannot shadow a built-in).
Add the `/bg` command the same way, right after the built-ins:

```ts
// commands.ts — createCommandRegistry()
import { createBackgroundAgentCommands } from "./background-agents.js";

export function createCommandRegistry(
  extensionCommands: readonly ExtensionCommand[] = [],
  warn?: (message: string) => void,
): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll(createBuiltInCommands());
  registry.registerAll(createBackgroundAgentCommands());   // <-- add this line
  for (const command of extensionCommands) {
    /* ... unchanged ... */
  }
  return registry;
}
```

That is the entire required wiring. `/bg` follows the same "one command,
sub-verbs in `args`" shape as `/cost` and `/permissions`:

| input | effect |
| --- | --- |
| `/bg fix the flaky retry test in packages/tools` | starts a background agent, prints its id at once |
| `/bg` | lists known background agents: id, status, elapsed, cost, task |
| `/bg logs bg-a1b2c3d4` | prints the transcript so far |
| `/bg cancel bg-a1b2c3d4` | aborts it (no-op, reported, if already finished) |
| `/bg adopt bg-a1b2c3d4` | injects its final text into the live conversation as a user-visible message |

**Known ambiguity, same as `/cost limit` / `/cost preview`:** a task whose
*first word* is literally `logs`, `cancel` or `adopt` (e.g.
`/bg cancel the noisy CI job`) is parsed as that sub-verb instead of a new
task. This mirrors an existing, accepted tradeoff in this command's house
style rather than introducing a new one.

---

## 3. Wiring the finished-agent notification

Rule: background-agents.ts must not call into the interactive app itself — it
only exposes `onUpdate`. Wire it once, wherever the app subscribes to the
runtime's own event stream (near `runtime.subscribe(...)` in the TUI/print
host):

```ts
import { getBackgroundAgentManager } from "./background-agents.js";

const unsubscribeBg = getBackgroundAgentManager(runtime).onUpdate((status) => {
  if (status.status === "running") return;   // only terminal transitions
  const headline =
    status.status === "done"
      ? `Background agent ${status.id} finished: ${status.task.slice(0, 60)}`
      : `Background agent ${status.id} ${status.status}: ${status.task.slice(0, 60)}`;
  runtime.notify(status.status === "failed" ? "error" : "info", headline);
  // Optionally, a TUI can also render `status.finalText` in a toast/panel,
  // or point the user at it with a one-liner:
  //   runtime.notify("info", `Run /bg adopt ${status.id} to bring it into this conversation.`);
});
```

Call `getBackgroundAgentManager(runtime)` — never construct
`BackgroundAgentManager` directly in application code — so the app observes
the exact same manager the `/bg` commands drive. Unsubscribe (`unsubscribeBg()`)
wherever the runtime itself is torn down (`ArcturnRuntime.dispose()`'s caller).

---

## 4. Permission posture (why, not just what)

A background agent has no user to prompt, so:

- **Mode defaults to `"default"`, never `"yolo"`.** With no
  `onPermissionAsk` wired (there genuinely is nowhere to send the prompt),
  `default` mode already denies anything that isn't a read-only tool or
  already allowed by a stored rule — fail-closed by construction, not by a
  special case in this module.
- **The tool set is filtered to read-only-safe by default** — `read`, `grep`,
  `glob`, `ls`, plus `fetch` (still permission-gated, so it denies safely
  rather than running) — mirroring `ArcturnRuntime.createSubagent`'s own
  non-`yolo` posture exactly, read `runtime.ts` for the identical rationale.
  `subagent` is always excluded so a background agent can never fan out into
  further delegation.
- **Both are explicit, per-call opt-outs**, never a silent escalation:
  `BackgroundAgentManagerOptions.permissionMode` (all agents from one
  manager) and `StartBackgroundAgentOptions.permissionMode` /
  `StartBackgroundAgentOptions.tools` (one agent) let a caller — e.g. a
  future `/bg --yolo <task>` flag, deliberately **not** built here — grant
  more, but only if they ask for it by name.

## 5. Concurrency

`BackgroundAgentManagerOptions.concurrency` (default 3) caps agents actually
running at once; further `start()` calls queue FIFO and launch as slots free
up. A queued agent's `status` still reads `"running"` (there is no separate
"queued" state in the public API) — `startedAt` is what distinguishes "queued
since `createdAt`" from "already working" if a caller needs to tell them
apart.
