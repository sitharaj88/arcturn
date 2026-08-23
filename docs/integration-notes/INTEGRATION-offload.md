# Wiring TOOL-OUTPUT OFFLOADING into the runtime

Integration recipe for `packages/core/src/offload.ts` (new file, already in the
tree with `offload.test.ts`, 35 passing tests). Per the task's hard rules **no
existing file was edited** — everything below is an exact instruction for
whoever wires it into `packages/core/src/index.ts`, `packages/cli/src/config.ts`
and `packages/cli/src/runtime.ts`.

The idea in one line: when a tool answers with more text than the context
window can afford, write the **whole** answer to a file and hand the model a
stub — head, tail, exact counts, absolute path — so the data is still there,
addressable with the `read` and `grep` tools it already has, instead of being
truncated into oblivion or eating half the window.

---

## 1. What's already built

`packages/core/src/offload.ts` exports:

```ts
// --- the wrapper ---------------------------------------------------------
function wrapToolsWithOffload(tools: readonly Tool[], options: OffloadOptions): Tool[];

// --- options / details ---------------------------------------------------
interface OffloadOptions {
  dir: string;                     // required; relative paths resolve against process.cwd()
  maxChars?: number;               // default 16_000  (combined length of text blocks)
  keepHead?: number;               // default 4_000   (excerpt head)
  keepTail?: number;               // default 1_000   (excerpt tail)
  exclude?: readonly string[];     // default ["read"]; pass [] to offload everything
  now?: () => number;              // default Date.now  (only the offloadedAt detail)
  createId?: () => string;         // default randomUUID().slice(0, 8) — filename collision suffix
  fs?: OffloadFileSystem;          // default node:fs/promises  { mkdir, writeFile }
}

interface OffloadDetails {         // merged into ToolResult.details on an offload
  offloaded: true;
  path: string;                    // absolute path of the full-output file
  originalChars: number;
  originalBytes: number;           // UTF-8 byte length of the file
  originalLines: number;
  stubChars: number;               // length of the stub that replaced it
  offloadedAt: number;             // from options.now
}

interface OffloadFileSystem {      // structural, so no fs import is needed to substitute one
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: string }): Promise<void>;
}

// --- constants + helpers (exported for hosts and tests) -------------------
const DEFAULT_OFFLOAD_MAX_CHARS = 16_000;
const DEFAULT_OFFLOAD_KEEP_HEAD = 4_000;
const DEFAULT_OFFLOAD_KEEP_TAIL = 1_000;
const DEFAULT_OFFLOAD_EXCLUDE: readonly string[] = ["read"];
function offloadableText(content: readonly ToolResultContent[]): string;      // text blocks, "\n"-joined
function offloadFileName(toolName: string, toolCallId: string): string;       // "bash-toolu_01ABC.txt"
function buildOffloadStub(params: {
  toolName: string; path: string; chars: number; bytes: number;
  lines: number; maxChars: number; excerpt: string;
}): string;
```

### Behaviour contract

| situation | what the wrapper does |
| --- | --- |
| tool name in `exclude` | the **original `Tool` object** is returned, unwrapped (`wrapped[i] === tools[i]`) |
| combined text ≤ `maxChars` | the **original `ToolResult` object** is returned, untouched (referential equality) |
| combined text > `maxChars` | full text written to `<dir>/<tool>-<toolCallId>.txt`; result rebuilt with one stub text block + every image block, `details` gains `OffloadDetails` |
| `ctx.signal.aborted` after `execute()` | result passed straight through, no file written |
| write/mkdir fails (ENOSPC, EACCES, bad dir) | the **original untruncated result** is returned; nothing is lost, no error surfaces |
| filename already exists | retried once as `<tool>-<toolCallId>-<createId()>.txt` (`wx` flag — an earlier file is never clobbered) |
| `execute()` throws | propagates unchanged (a programming error, per the `Tool` contract) |

Preserved verbatim across an offload: `isError`, `structuredContent`, every
pre-existing `details` key (offload details are merged on top), and all image
blocks — image data is never written to disk and never counted against
`maxChars`. Only text blocks are offloaded, joined with `"\n"` in their
original order, exactly as `hooks.ts` and `taint.ts` concatenate result text.

The module is silent by design: no `AgentEvent`, no `ctx.onUpdate` call, no
`console` output. The only observable trace outside the stub text is
`details.offloaded === true`, which a TUI can render as a one-line badge
("output offloaded → /path, 412 KB") off the existing `toolEnd` event without
any new event type.

### Why `read` is excluded by default

`read` already bounds itself three ways (2 000-line cap, 2 000-char line
truncation, auto-outline at 16 KB), it is the very tool the stub tells the
model to use, and offloading a file read would write a second copy of a file
that is already on disk and hand back a pointer to it — pure loss. Add other
self-limiting tools (`ls`, a paginated MCP tool) to `exclude` for the same
reason. Do **not** exclude `bash`, `grep` or MCP tools: those are the offenders
this feature exists for.

---

## 2. `packages/core/src/index.ts` — the export block

Insert between the `loop.js` and `permissions.js` blocks, keeping the file's
alphabetical-by-module order:

```ts
export type { OffloadDetails, OffloadFileSystem, OffloadOptions } from "./offload.js";
export {
  buildOffloadStub,
  DEFAULT_OFFLOAD_EXCLUDE,
  DEFAULT_OFFLOAD_KEEP_HEAD,
  DEFAULT_OFFLOAD_KEEP_TAIL,
  DEFAULT_OFFLOAD_MAX_CHARS,
  offloadableText,
  offloadFileName,
  wrapToolsWithOffload,
} from "./offload.js";
```

No other core file changes. `offload.ts` imports only `node:crypto`,
`node:fs/promises`, `node:path` and types from `@arcturn/types`; it adds no
dependency to `packages/core/package.json`.

---

## 3. `packages/cli/src/config.ts` — the config surface

Three edits, each mirroring how `lsp` / `taint` are already handled.

**3a. `ArcturnConfig` fields** (next to `lsp` and `sandbox`):

```ts
  /** Write oversized tool outputs to a file instead of the context window (default "on"). */
  offload: "off" | "on";
  /** Tunables for offloading; any omitted key uses the core default. */
  offloadLimits?: { maxChars?: number; keepHead?: number; keepTail?: number; exclude?: string[] };
```

**3b. defaults object** (beside `lsp: "off" as const`):

```ts
  offload: "on" as const,
```

Default **on**: the failure it prevents (a 400 KB `bash` output evicting the
conversation) is silent and expensive, while its own failure mode is one extra
`read`. Hosts that want the old behaviour set `"offload": "off"`.

**3c. `KNOWN_KEYS`** — add `"offload"` and `"offloadLimits"` to the set.

**3d. layer validation** (beside the `raw.lsp` block):

```ts
  if (raw.offload !== undefined) {
    if (raw.offload === "off" || raw.offload === "on") out.offload = raw.offload;
    else warnings.push(`${where}: "offload" must be "off" or "on"`);
  }
  if (raw.offloadLimits !== undefined) {
    const limits = raw.offloadLimits as Record<string, unknown>;
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      warnings.push(`${where}: "offloadLimits" must be an object`);
    } else {
      const out2: NonNullable<ArcturnConfig["offloadLimits"]> = {};
      for (const key of ["maxChars", "keepHead", "keepTail"] as const) {
        const value = limits[key];
        if (value === undefined) continue;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) out2[key] = value;
        else warnings.push(`${where}: "offloadLimits.${key}" must be a non-negative number`);
      }
      if (Array.isArray(limits.exclude) && limits.exclude.every((t) => typeof t === "string")) {
        out2.exclude = limits.exclude as string[];
      } else if (limits.exclude !== undefined) {
        warnings.push(`${where}: "offloadLimits.exclude" must be an array of tool names`);
      }
      out.offloadLimits = out2;
    }
  }
```

**3e. merge function** (beside `lsp: layer.lsp ?? base.lsp`):

```ts
    offload: layer.offload ?? base.offload,
    ...(layer.offloadLimits ?? base.offloadLimits
      ? { offloadLimits: { ...base.offloadLimits, ...layer.offloadLimits } }
      : {}),
```

Note the shallow merge on `offloadLimits`: a project layer setting only
`maxChars` must not erase a user layer's `exclude`. Out-of-range or malformed
numbers that slip through are still safe — `resolveOptions` inside `offload.ts`
falls back to the defaults for any non-finite or negative value.

---

## 4. `packages/cli/src/runtime.ts` — where in the wrapper stack

**Innermost — closest to the tool, inside every other wrapper.** In
`buildRuntime`, wrap `baseTools` (or `toolsWithSymbols`) *before* the LSP wrap:

```ts
// runtime.ts — buildRuntime(), just above `const lspTools = ...`
import { wrapToolsWithOffload } from "@arcturn/core";

const offloadDir = join(paths.home, "offload", initialSessionId);
const offloadedTools =
  config.offload === "off"
    ? toolsWithSymbols
    : wrapToolsWithOffload(toolsWithSymbols, { dir: offloadDir, ...config.offloadLimits });
const lspTools = lsp ? wrapToolsWithLsp(offloadedTools, lsp) : offloadedTools;
```

Innermost is deliberate, and it is the one decision worth arguing:

- Everything the outer layers **add** to a result — LSP diagnostics, a verify
  summary, a `[taint] WARNING:` line, a postToolUse hook's note — is small,
  high-signal, and must stay *inline* where the model reads it. Offloading
  outermost would sweep those into the file behind the stub.
- The stub is what gets persisted into the transcript and re-sent every turn,
  so the earlier in the chain it is produced, the less machinery downstream has
  to carry the full text around. Only the wrapper itself ever holds the whole
  output in memory, and only for the length of one write.

**Caveat, and it is a real one:** with offload innermost, `wrapToolsWithTaint`
and `wrapToolsWithCanary` observe the **stub**, not the full text, so a marker
that appears only in the omitted middle is not remembered. If your threat model
prefers full-text scanning over inline diagnostics, move the offload wrap to
the outermost position instead (`wrapToolsWithOffload(hookedTools, …)`) — the
module works identically there; only the ordering tradeoff changes. Note that
the head/tail excerpt still carries the majority of injected content in
practice, because prompt injections are placed where a reader will see them.

**MCP tools.** They arrive after construction and are wrapped separately in
`attachMcpTools`, which must traverse the same chain. Add the offload wrap as
the innermost step there too:

```ts
// runtime.ts — attachMcpTools(), replacing the `const speculated = ...` seed
const offloaded =
  this.config.offload === "off"
    ? [...tools]
    : wrapToolsWithOffload([...tools], {
        dir: this.#offloadDir,
        ...this.config.offloadLimits,
      });
const speculated = this.speculation
  ? wrapToolsWithSpeculation(offloaded, this.speculation)
  : offloaded;
```

Store `offloadDir` on the runtime (`readonly #offloadDir: string`, set from the
same `join(this.paths.home, "offload", initialSessionId)` in the constructor)
so `attachMcpTools` and any later re-wrap share one directory. Skipping MCP
here is the same class of bug the existing comment in `attachMcpTools` warns
about: MCP tools are the biggest producers of megabyte JSON in the whole tool
set.

**Sub-agents** (`createSubagent`) and `#agentOptions` need no change: both build
from `#preHookTools`, which already contains the offload-wrapped tools.

### Directory choice and lifetime

`<paths.home>/offload/<initialSessionId>/` follows the existing per-session
scratch convention (`checkpoints/<sessionId>`, `overlays/<sessionId>`,
`speculations/<sessionId>`). Deliberately **not** under `cwd`: offloaded output
is machine state, never something to commit, and writing it into the workspace
would show up in `git status` and in the model's own `ls`.

The directory is created lazily on the first offload, so a session that never
overflows leaves no trace. Nothing in this module deletes files — pick a
retention policy at the host level (the same place `checkpoints/` is pruned);
until then the files persist, which is the right default while `--resume` can
bring a session back and the transcript still cites those paths.

One nuance: the dir is keyed on `initialSessionId`, so a `/clear` or a resumed
session keeps writing into the first session's folder. Harmless (filenames are
keyed by `toolCallId`, and collisions are handled), but if you want strict
per-session folders, recompute the dir in `#agentOptions` and re-wrap
`#preHookTools` there.

### Permissions

The stub points at an absolute path **outside `cwd`**. `read` requires no
permission (see `createReadTool`), so the round trip works in every permission
mode including a read-only sub-agent. If a host ever adds a
workspace-confinement rule to `read`/`grep`, it must allow the offload
directory too — otherwise the model is told to read a file it is then refused,
which is worse than plain truncation.

---

## 5. Prompting: nothing required, one line recommended

The stub is written to be self-sufficient — it names the path, quotes it as
JSON ready to paste into `read({ path: … })`, states the byte/line counts, and
says "Nothing was lost … Do not re-run the tool just to see the output again"
(the failure mode worth pre-empting: a model that re-runs `bash` hoping for a
shorter answer). No system-prompt change is needed.

If `collectSystemPromptContext` gains a line anyway, keep it to the invariant:

> Large tool outputs are written to a file and replaced by an excerpt naming
> its path. Read or grep that path for the rest; never re-run the tool to see
> output you already have.

---

## 6. Tests

`pnpm vitest run packages/core/src/offload.test.ts` — 35 tests covering
identity pass-through (excluded tools, under-limit results, boundary at exactly
`maxChars`), stub content and size, multi-byte byte counts, multi-block and
image-bearing results, `isError`/`structuredContent`/`details` preservation,
directory creation, relative-dir resolution, filename sanitization
(`../../etc/passwd` → a flat, slash-free name), collision retry without
clobbering, all three write-failure fallbacks, abort pass-through, and
degenerate `keepHead`/`keepTail` clamping.
