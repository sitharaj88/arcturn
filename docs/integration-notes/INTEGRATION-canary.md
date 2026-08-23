# Wiring CANARY EXFILTRATION DETECTION into the CLI

This document is the integration recipe for `packages/cli/src/canary.ts` (new
file, already in the tree with `canary.test.ts`, 21 passing tests). Per the
task's hard rules **no existing file was edited** to produce this feature —
the snippets below are exact instructions for whoever wires it into
`config.ts`, `args.ts` and `runtime.ts`.

The goal in one line: taint tracking (`taint.ts`) watches what comes *in* from
the untrusted internet. This watches what must never go back *out*. Plant a
few high-entropy decoy tokens ("canaries") in the workspace or session state;
if one ever appears as a substring of an argument passed to an egress-capable
tool (`fetch`, `websearch`, `bash`, any `mcp*` tool), that is not a heuristic
guess — it is direct proof that something read a planted secret and is trying
to send it off the machine. Block it.

## 1. What's already built

`packages/cli/src/canary.ts` exports:

```ts
generateCanary(options?: { label?: string }): string
// "arcturn-canary-<label->-<32 hex chars>" (128 bits of entropy)

createCanaryGuard(options?: { canaries?: readonly string[]; egressTools?: readonly string[] }): CanaryGuard

interface CanaryGuard {
  register(token: string): void;
  isEgress(toolName: string): boolean;         // fetch/websearch/bash/mcp*
  scan(toolName: string, input: Record<string, unknown>): CanaryHit | undefined;
  tokens(): string[];
}

interface CanaryHit { token: string; toolName: string; reason: string }

type CanaryPolicy = "warn" | "deny";

wrapToolsWithCanary(
  tools: readonly Tool[],
  guard: CanaryGuard,
  options: { policy: CanaryPolicy; onDetect?: (hit: CanaryHit) => void },
): Tool[]

plantCanaries(
  dir: string,
  canaries: readonly string[],
  options?: { filenames?: readonly string[] },
): Promise<string[]>
```

Plus `DEFAULT_EGRESS_TOOLS` (`fetch`, `websearch`, `bash`),
`DEFAULT_EGRESS_TOOL_PREFIXES` (`mcp`), `serializeToolInput` (input
flattening, mirrors `taint.ts`'s helper of the same name but is a separate
implementation — see §5), and the message builders `canaryWarningLine`,
`canaryDenialMessage`.

Behaviour of the wrapper, per policy, for an **egress** tool whose input
contains a registered canary:

| policy   | tool runs? | result                                                              |
| -------- | ---------- | -------------------------------------------------------------------- |
| `warn`   | yes        | a `[canary] CRITICAL: …` text block is prepended to the result       |
| `deny`   | no         | `isError` refusal naming the tool and the token, in terms the model can act on |

There is no `"off"`/`"confirm"` policy, unlike `taint.ts`: `"off"` is simply
"don't call `createCanaryGuard`/`wrapToolsWithCanary` at all" (the config key
below models this as a third state), and `"confirm"` makes little sense here
— a canary hit is not an ambiguous judgment call for a human to weigh, it is
proof an exfiltration attempt is already in flight, so the only sane choices
are "log it loudly" or "stop it".

Tools that are not egress sinks are returned unwrapped (passed through by
reference — verified by a test that checks `wrapped[i] === original`).

## 2. `packages/cli/src/config.ts` — add a `canary` key

**Import** (next to the existing `./taint.js` import):

```ts
import type { CanaryPolicy } from "./canary.js";
```

**Interface** (after `ArcturnConfig.taint`):

```ts
  /** How to handle an egress call whose argument contains a planted canary token (default "warn"). */
  canary: "off" | CanaryPolicy;
```

**Default** (in `DEFAULT_CONFIG`, after `taint`):

```ts
  canary: "warn" as const,
```

`"warn"` matches the same reasoning `taint.ts` gives for its own default:
useful from the first session, and never silently breaks a legitimate
workflow. `"deny"` is the right choice once a project actually plants
canaries and wants a hard stop; `"off"` is for a session with no canaries
registered, where scanning would be pure overhead.

**Known keys** (add to the `KNOWN_KEYS` set):

```ts
  "canary",
```

**Parse** (beside the `taint` parse block, following the same shape as lines
325–335 of the current `config.ts`):

```ts
  if (raw.canary !== undefined) {
    if (raw.canary === "off" || raw.canary === "warn" || raw.canary === "deny") {
      out.canary = raw.canary;
    } else {
      warnings.push(`${where}: "canary" must be off, warn or deny`);
    }
  }
```

**Merge** (in `mergeConfig`, after the `taint` line):

```ts
    canary: layer.canary ?? base.canary,
```

## 3. `packages/cli/src/args.ts` — optional `--canary <policy>` flag

Mirror the existing `--taint` flag exactly: add `"--canary"` to the
value-taking flag list, then a case beside it:

```ts
      case "--canary": {
        const value = next();
        if (value === "off" || value === "warn" || value === "deny") {
          out.canary = value;
        } else {
          errors.push(`--canary must be one of: off, warn, deny`);
        }
        break;
      }
```

## 4. `packages/cli/src/runtime.ts` — where to wrap, and why there

### 4a. Create the guard in `buildRuntime`

Next to the taint tracker:

```ts
import { createCanaryGuard, type CanaryGuard, wrapToolsWithCanary } from "./canary.js";

const canaryGuard = createCanaryGuard();
```

Construct it unconditionally, same reasoning as the taint tracker: even for
`canary: "off"`, having the guard ready means flipping the policy mid-session
(via a future `/canary` command) or planting canaries later needs no
re-wiring — `wrapToolsWithCanary` is what should be skipped for `"off"`, not
guard construction.

```ts
const canaryTools = config.canary === "off"
  ? taintedTools
  : wrapToolsWithCanary(taintedTools, canaryGuard, {
      policy: config.canary,
      onDetect: (hit) => {
        warnings.push(`canary: ${hit.toolName} call carried a planted token — ${hit.reason}`);
      },
    });
const hookedTools = wrapToolsWithHooks(canaryTools, hookRunner);
```

### 4b. Order: canary sits *inside* taint, both inside hooks

The full chain becomes:

```
verify/LSP  →  taint  →  canary  →  hooks  →  checkpoints (per-agent)
```

**Why hooks stay outermost:** identical reasoning to `taint.ts` §4b — a
user's own `preToolUse` deny must stay final and raise no dialog for an
already-dead call, and a canary refusal must still be visible to
`postToolUse` hooks and the audit trail (an exfiltration attempt is exactly
the kind of event a security-conscious user's hooks want to see, arguably
more so than a taint hit).

**Why canary sits inside taint, not the other way around, and not merged
into one wrapper:** these two guards answer different questions and must not
short-circuit each other.

- Taint asks "does this argument echo something untrusted that came *in*?" —
  a judgment call about provenance, deliberately fuzzy, and its refusal
  message is about *obedience to injected instructions*.
- Canary asks "does this argument contain a token we know for a fact should
  never leave?" — a fact, not a judgment call, and its refusal message is
  about *active exfiltration*.

A tool call can trip either, both, or neither independently (a canary token
could appear in an argument that was typed directly by the model with no
untrusted content in sight — e.g. it read a real-looking `.env.local` on its
own initiative — so canary detection must not depend on taint having fired
first). Keeping them as two separate wrapper stages, each able to veto on its
own, means a `"deny"` canary policy blocks exfiltration even when
`taint: "off"`, and a `"warn"` taint policy still lets a `"deny"` canary
policy make the hard stop. Nesting canary just inside taint (rather than
outside it) is the natural continuation of `taint.ts`'s own ordering
argument: the innermost wrapper sees the call last and closest to the real
`execute()`, and canary is the last line of defense before bytes actually
leave, so it should be the last gate before the underlying tool runs (besides
hooks/checkpoints, which are user- and infra-level policy layers that sit
outside *everything* domain-specific by convention in this codebase).

**Why outside verify/LSP:** same reasoning as taint — those wrappers append
diagnostics to a result after the underlying tool already ran; they don't
touch the arguments a canary would be found in, so wrapping order relative to
them doesn't affect detection, but wrapping canary outside keeps it
consistent with taint's placement.

### 4c. Wrap MCP tools too

Exactly as `attachMcpTools` must wrap late-arriving MCP tools with taint (see
`taint.ts` §4c), it must also wrap them with canary, in the same order:

```ts
  attachMcpTools(tools: Tool[]): void {
    this.#mcpTools = wrapToolsWithHooks(
      wrapToolsWithCanary(
        wrapToolsWithTaint([...tools], this.#taint, this.#taintOptions),
        this.#canaryGuard,
        this.#canaryOptions,
      ),
      this.#hookRunner,
    );
  }
```

MCP tools are egress by default (`mcp*` prefix), so skipping this step means
the exact channel the module doc calls out as "arguably the least visible
egress path" is also the one left unguarded.

### 4d. Per-session canary generation and (optional) planting

Canaries are session-scoped, same lifecycle as the taint tracker. In the
session-start path, alongside where the taint tracker would be reset:

```ts
import { generateCanary, plantCanaries } from "./canary.js";

if (config.canary !== "off") {
  const sessionCanary = generateCanary({ label: "session" });
  canaryGuard.register(sessionCanary);

  // Optional: only if the project wants a realistic decoy an agent might
  // stumble onto with `read`/`grep`/`bash cat`, not just one registered
  // in memory. Gate behind an explicit opt-in (e.g. a `canaryPlant: true`
  // config key) — writing files into the user's workspace on every session
  // start is not something "warn"/"deny" alone should imply.
  if (config.canaryPlant) {
    await plantCanaries(join(paths.cwd, ".arcturn"), [sessionCanary]).catch((error) => {
      warnings.push(`canary: failed to plant decoy file: ${(error as Error).message}`);
    });
  }
}
```

Do **not** reset canaries on `/clear` the way taint markers are reset. A
canary is a fact about the environment ("this decoy secret exists and must
never leave"), not a memory of something the model saw — clearing the
conversation does not un-plant a file on disk, so the guard must keep
watching for it for as long as the planted file (or the registered token)
exists. If `/clear` ever needs to *rotate* canaries (e.g. the model may have
seen the old one and a fresh session wants a fresh decoy), that is a new
canary generated and registered in addition to the old one, not a reset.

## 5. Why `canary.ts` reimplements `serializeToolInput` instead of importing it

`taint.ts` already exports a function with this exact name and behavior.
`canary.ts` deliberately does not import it, for two reasons stated in the
module TSDoc: it keeps this module's only internal dependency at
`@arcturn/types` + Node built-ins (matching the "depends on nothing inside
the CLI" discipline `taint.ts` itself follows), and it avoids a coupling
between two files that the task's own constraints assume may be edited
concurrently by different agents — importing from a file that is being
rewritten elsewhere is exactly the kind of cross-file risk this task's "never
edit an existing file" rule is designed to route around. If a future refactor
wants a single shared `serializeToolInput`, the natural home is a new
`tool-input.ts` both files import — not a dependency of one on the other.

## 6. The honest limitation — say this plainly to users

Canary detection is **exact substring matching**, and that is a deliberate,
documented trade-off (module TSDoc, "Exact matching, on purpose"): a
canary's whole value is that it's 128 bits of entropy that cannot occur by
accident, so plain substring containment has zero false-positive risk and
needs no tuning.

The cost of that exactness is real and should be told to users setting up
`canary: "deny"`: **an agent that transforms or encodes a canary before
sending it defeats this check.** Base64-encoding the token, reversing it,
splitting it across two arguments, ROT13, even just wrapping it in quotes the
scanner doesn't strip in some pathological case — any of these change the
bytes enough that substring matching finds nothing, and the call sails
through. This is not a bug to fix by adding fuzzier matching (fuzzy matching
against a *secret* token is a much weaker guarantee, and defeats the entire
point of using a canary instead of a taint-style heuristic in the first
place); it is a structural limit of "watch for known bytes" detection,
exactly parallel to the limit `taint.ts` already accepts for prose-only
injection with no command shape, URL, or token. Canary detection catches the
common, low-effort exfiltration path (a compromised or careless agent
`fetch`-ing or `bash curl`-ing a secret it just read, verbatim) and says
nothing about a sophisticated one. Layer it with `taint: "deny"`, sandboxing,
and network egress controls outside this process — this module is one gate,
not the whole fence.

## 7. Verification performed

```
npx vitest run packages/cli/src/canary.test.ts   # 21 passed
npx tsc -p packages/cli/tsconfig.json --noEmit   # no errors attributable to canary.ts/canary.test.ts
                                                  # (two pre-existing errors in cost-preview.ts/vcr.ts,
                                                  #  unrelated untracked files from other concurrent work)
npx biome check packages/cli/src/canary.ts packages/cli/src/canary.test.ts   # clean
```
