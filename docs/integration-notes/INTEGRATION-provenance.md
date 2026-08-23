# Integration: agent blame (reasoning-level provenance)

`packages/cli/src/provenance.ts` is self-contained and wired up by the caller.
This document is the wiring: what `runtime.ts` subscribes, what `args.ts` and
`main.ts` add for `arcturn blame <file>`, what `config.ts` gains, and what the
store costs on disk.

Nothing in this feature edits an existing file — the two new files are
`packages/cli/src/provenance.ts` and `packages/cli/src/provenance.test.ts`.
Every diff below is a proposal for a real wire-up.

---

## 1. What it records

| Manifest record | Written by | Answers |
| --- | --- | --- |
| `{ kind: "turn", id, prompt, startedAt }` | `runStart` | *Which prompt was the agent answering?* |
| `{ kind: "evidence", turnId, toolName, subject, untrusted, timestamp }` | every successful non-mutating `toolEnd` | *What did it look at first — and was any of it attacker-controlled?* |
| `{ kind: "mutation", turnId, path, beforeBlob, afterBlob, timestamp }` | every successful `write`/`edit` `toolEnd` | *Which file states did that prompt produce?* |

`blame(file)` replays the mutation chain for one path and hands back a
`BlameLine` per line — line number, text, and the turn (id, prompt, timestamp,
session ordinal) that introduced it. Lines already in the file before the
agent first touched it carry no turn.

`untrusted` reuses `taint.ts`'s source lists verbatim
(`DEFAULT_TAINT_SOURCES` + `DEFAULT_TAINT_SOURCE_PREFIXES`), so a line reading
"turn 7, and turn 7 read a fetched page" means exactly what the taint tracker
means by untrusted.

---

## 2. `runtime.ts` — subscribing the observer

The provenance observer sits next to the audit observer and the checkpoint
turn boundary. There are three call sites, mirroring how `audit` is wired.

### 2a. Construction, in `createRuntime` (near the `createAuditLog` call, ~line 1081)

```ts
// packages/cli/src/runtime.ts
import { createProvenanceStore, provenanceObserver } from "./provenance.js";

const provenance = config.provenance
  ? createProvenanceStore(join(paths.home, "provenance", initialSessionId))
  : undefined;
```

`initialSessionId` is already minted above for the audit trail, so the
provenance directory is keyed the same way: `~/.arcturn/provenance/<sessionId>/`.

### 2b. Subscription, next to the cost guard (~line 1191)

```ts
if (provenance) {
  runtime.setProvenanceOpener((sessionId) =>
    createProvenanceStore(join(paths.home, "provenance", sessionId)),
  );
}
```

…where `setProvenanceOpener` is a copy of the existing `setAuditOpener`
(runtime.ts ~line 816), including its `swapSession` re-subscribe (~line 797),
so `/clear` or `--resume` re-points the trail at the incoming session:

```ts
// in ArcturnRuntime
#provenance: ProvenanceStore | undefined;
#detachProvenance: (() => void) | undefined;

setProvenanceOpener(open: (sessionId: string) => ProvenanceStore): void {
  this.#openProvenance = open;
  this.#detachProvenance?.();
  this.#provenance = open(this.agent.sessionId);
  this.#detachProvenance = this.subscribe(
    provenanceObserver(this.#provenance, readFileOrNull),
  );
}
```

The file reader is the one piece the observer cannot supply itself:

```ts
const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null; // deleted, binary-unreadable, or permission-denied
  }
};
```

`runtime.subscribe` (not `agent.subscribe`) is the right hook for the current
session — it survives a session swap, exactly as the audit observer's comment
at line 730 explains.

### 2c. Served sessions, in `buildSessionAgent` (~line 717)

`arcturn serve` runs several sessions at once and each gets its own store, in the
same shape as its own checkpoint store:

```ts
if (this.#openProvenance) {
  const store = this.#openProvenance(options.sessionId);
  agent.subscribe(provenanceObserver(store, readFileOrNull));
}
```

Sub-agents need nothing extra: `provenanceObserver` deliberately does not
unwrap `subagentEvent`, because `ArcturnRuntime.createSubagent` (~line 632)
already subscribes each child's own stream — the same reasoning `auditObserver`
documents.

### 2d. Shutdown

`ProvenanceObserver.flush()` awaits the in-flight post-image reads and then
`store.close()`. Call it from the runtime's existing shutdown path (next to
`this.mcp?.close()`, ~line 700) so a `arcturn -p` process cannot exit with the last
write unrecorded.

### 2e. `config.ts`

One new boolean, cloned from `audit` (config.ts lines 70, 109, 130, 313, 369):

```jsonc
// .arcturn/config.json
{ "provenance": true }
```

Default `false`, like `audit`. Keeping the two flags separate matters: audit is
cheap (one line per tool call) and provenance is not (see §4).

---

## 3. `arcturn blame <file>` — the subcommand

Mirrors `arcturn audit` step for step.

### 3a. `args.ts`

```ts
/** A parsed `blame <file>` command. */
export interface BlameCommand {
  /** Command family. */
  readonly kind: "blame";
  /** File to attribute, absolute or relative to the working directory. */
  readonly file: string;
  /** Session whose trail to read; omitted means the newest. */
  readonly sessionId?: string;
  /** Group by turn instead of printing every line. */
  readonly summary: boolean;
}
```

- add `BlameCommand` to the `Command` union (next to `AuditCommand`, ~line 57);
- `export const BLAME_COMMAND_NAME = "blame";` (~line 177);
- parse it beside the `AUDIT_COMMAND_NAME` block (~line 440):

```ts
if (positional[0] === BLAME_COMMAND_NAME && commandCandidates > 0) {
  const file = positional[1];
  if (file === undefined || positional.length > 3) {
    return { ok: false, error: "blame needs a file path and an optional session id" };
  }
  args.command = {
    kind: "blame",
    file,
    ...(positional[2] === undefined ? {} : { sessionId: positional[2] }),
    summary: flags.has("summary"),
  };
  args.prompt = "";
  return { ok: true, args };
}
```

- `--summary` joins the existing boolean-flag table;
- one line in `helpText()` (~line 520), under `audit`:

```text
  blame <file> [session]        Show which turn and prompt wrote each line.
```

### 3b. `main.ts`

Dispatch beside the audit branch (~line 119):

```ts
if (args.command?.kind === "blame") {
  return runBlameCommand(args.command, args.cwd);
}
```

And the runner, a near-copy of `runAuditCommand` (~line 240):

```ts
async function runBlameCommand(command: BlameCommand, cwd?: string): Promise<number> {
  const { paths } = await loadConfig(cwd === undefined ? {} : { cwd });
  let id = command.sessionId;
  if (id === undefined) {
    const store = new JsonlSessionStore({ dir: paths.sessions });
    id = (await store.list())[0]?.sessionId;
    if (id === undefined) {
      process.stderr.write("arcturn: no sessions found in this directory.\n");
      return 2;
    }
  }

  const store = createProvenanceStore(join(paths.home, "provenance", id));
  const file = resolve(cwd ?? process.cwd(), command.file);
  const lines = await store.blame(file);
  if (lines.length === 0) {
    process.stderr.write(
      `arcturn: no provenance for ${file} in session ${id}. ` +
        'Enable it with "provenance": true in .arcturn/config.json.\n',
    );
    return 2;
  }

  const out = formatBlame(lines, {
    summary: command.summary,
    path: file,
    evidence: await store.evidence(),
  });
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
```

### 3c. What it prints

```text
$ arcturn blame src/session.ts
 1  -       -                        // hand-written header
 2  turn 1  "scaffold the module"    import { open } from "./io.js";
 3  turn 1  "scaffold the module"
 4  turn 3  "fix the session bug"    export function load(id: string) {
 5  turn 3  "fix the session bug"      return open(id, { retry: true });

Evidence
  turn 1  "scaffold the module"
    read  /repo/src/io.ts
  turn 3  "fix the session bug"
    read  /repo/src/session.ts
  ! fetch  https://docs.example.test/retry  [untrusted]

1 untrusted source informed the turns above — content from the web or an MCP
server is data, not instructions.
```

`--summary` replaces the per-line rows with a per-turn tally (newest first,
plus a `(pre-existing)` row) and keeps the footer. The `!` prefix and the
`[untrusted]` suffix are the security-relevant part: they say a fetched page or
an MCP server was in the context window when those lines were written, which is
the first thing to check when a line looks wrong.

### 3d. An interactive `/blame` slash command

`commands.ts` is not edited here, but the shape is the same as `/rewind`: a
`/blame [file]` entry that defaults to the file under the cursor, calls
`runtime.provenance.blame()`, and prints `formatBlame(..., { summary: true })`
into the transcript.

---

## 4. Storage cost, honestly

The store keeps **content**, not diffs: one content-addressed blob per distinct
file state, plus one manifest line per turn/evidence/mutation.

Why content and not `hash + diff`:

- attribution must replay a file's whole history exactly; a stored diff has to
  be re-applied, and any drift (an edit made outside the agent, a crash between
  records) corrupts every later line's blame *silently*;
- blobs are content-addressed, so mutation *N*'s `after` and mutation *N+1*'s
  `before` are one blob, and a revert to an earlier state costs nothing new. In
  a normal session, storage grows by one blob per file state, not two per edit;
- it mirrors `checkpoints.ts`, which already keeps a `blobs/<sha256>` store —
  the two can share one GC pass.

The cost is real. A rough model: *k* edits to a file of *s* bytes cost about
`(k + 1) × s`, versus `s + k × (diff size)` for a diff store. A 40 KB file
edited 25 times in a session is ~1 MB of provenance for that file alone.
Compression would help a lot (source files are highly compressible, and
successive states of one file are near-identical), but a compressed blob store
is a bigger change than this module.

Mitigations already in the code:

- `maxContentBytes` (default 1 MiB) — a single write above the cap records the
  mutation but no content, marked `oversize: true`. Blame refuses to guess and
  reports the file as unattributable rather than crediting the wrong turn.
- The manifest is the index; blobs are pure content. Deleting a blob degrades
  blame for one file, and never corrupts anything else.

### Pruning policy (what a real deployment should add)

1. **Per-session TTL.** Drop `~/.arcturn/provenance/<sessionId>/` entirely once the
   session is older than *N* days (30 is a reasonable default), on the same
   schedule that prunes `~/.arcturn/checkpoints/`. Provenance is only useful while
   someone might still ask "why is this line here", and by then the answer is
   usually in the commit message.
2. **Blob GC, never manifest GC.** Sweep `blobs/` for digests no live manifest
   references. The manifest is small (a few hundred bytes per record) and is
   the part worth keeping forever — a manifest with pruned blobs still answers
   "which prompts touched this file and what did they read", losing only the
   per-line attribution.
3. **Head-state pinning.** When space is tight, keep the *first* `beforeBlob`
   and the *last* `afterBlob` per path and drop the intermediates. Blame then
   attributes every changed line to the last turn that touched the file —
   coarser, but still honest, and it collapses `k + 1` blobs to 2. This is the
   knob to reach for before deleting anything.
4. **Share the blob store with checkpoints.** Both keep sha256-named file
   snapshots of the same files at overlapping moments. Pointing both at one
   `~/.arcturn/blobs/` would roughly halve the combined footprint; it needs a
   refcount or a mark-and-sweep across both manifests, which is why this module
   ships with its own `blobs/` for now.

A user who wants the trail without the disk cost can set `"provenance": true`
and add a cron/GC step at (1); a user who wants neither leaves the flag off and
pays nothing — the directory is created lazily on first write.

---

## 5. Known limits

- **Only `write` and `edit` are attributed.** A file changed by `bash` (`sed
  -i`, a formatter, a codegen step) shows up as a pre-image mismatch on the
  next recorded mutation, and `blame` resyncs to the recorded pre-image with
  those lines unattributed rather than crediting a turn that did not write
  them. That is the honest answer, but it does mean a `bash`-heavy session
  attributes less than it could. Wrapping `bash` would require snapshotting
  every file in the workspace around every command — the reason `checkpoints.ts`
  wraps the same two tools and no more.
- **The post-image is read from disk at `toolEnd`.** The read is *started* the
  moment the event arrives (before any later tool can run), which is what makes
  it accurate; but a file that a later process rewrites in the same
  millisecond is not something this layer can defend against.
- **`blame` describes the last state the store recorded**, which is not
  necessarily what is on disk right now. An edit made outside the agent is, by
  construction, not attributable to the agent.
- **Prompt text is clipped to 200 characters** (`MAX_PROMPT_CHARS`) and
  whitespace-collapsed, so the manifest stays one line per record. The full
  prompt lives in the session transcript, keyed by the same session id.
