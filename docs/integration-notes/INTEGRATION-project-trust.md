# Integration: project code trust

A cloned repository could put executable code in front of a user who did
nothing but `git clone` and `cd`. `packages/cli/src/project-trust.ts` is the
one consent decision that closes it.

New files:

- `packages/cli/src/project-trust.ts`
- `packages/cli/src/project-trust.test.ts`
- `packages/cli/src/security-review-5.test.ts`

## The four surfaces

`<cwd>/.arcturn` can declare four things that run as you:

| Surface | Declared in | Runs when |
| --- | --- | --- |
| lifecycle hooks | `config.json` `hooks` | `sessionStart` fires inside `buildRuntime`, before the first keystroke |
| verify command | `config.json` `verify` | after every successful `write`/`edit` |
| extensions | `extensions/**` | `jiti.import`ed at startup |
| stdio MCP servers | `mcp.json` | spawned by `connectMcp` |

They are transitively equivalent — a `sessionStart` hook can write the other
three, and `~/.arcturn/config.json` besides — so there is **one** decision, not
four. Three checkboxes that are secretly one checkbox costs the user three
decisions and buys no separation. `registry.ts` states the same doctrine for
package installs: the blast radius sets the gate, not the mechanism.

## The trust store

`~/.arcturn/trust.json`, reached as `ArcturnPaths.trust`. It is the one entry
in `ArcturnPaths` with **no `<cwd>/.arcturn` twin**, deliberately — every other
pair exists because a project may legitimately contribute to it, and consent is
the one thing a project may never contribute to. `security-review-5.test.ts`
asserts that structurally, so the day someone adds `projectTrust` "for
symmetry" the suite says no.

```jsonc
{
  "version": 1,
  "projects": {
    "/abs/path/to/repo": {
      "digest": "sha256:…",
      "decision": "allow",
      "decidedAt": "2026-08-30T12:00:00.000Z",
      "counts": { "hook": 2, "verify": 1, "extension": 3, "mcp": 1 }
    }
  }
}
```

Counts, never the commands. The surface is re-derived from disk every launch
anyway, so storing the attacker's text would buy nothing and would oblige every
future reader of the file to sanitise it. A missing, unreadable, corrupt or
wrong-version file reads as "no consent on record" — never a crash, and never
an approval.

## The digest

One canonical, versioned, sorted blob, sha256'd. Fields are `\0`-separated so
no value can forge a field boundary; lines are sorted so `readdir` order and
config key order cannot change the answer.

```
v1
hook <event> \0 <command> \0 <matcher|""> \0 <timeoutMs|"">
verify <command> \0 <globs \0-joined> \0 <runOn>
ext <relpath> \0 <sha256 of bytes>
mcp <name> \0 <command> \0 <args \0-joined> \0 <sorted env k=v> \0 <cwd|"">
```

**Declarations for hooks, verify and MCP; file CONTENTS for extensions.** The
extension tree is hashed **recursively over every regular file** — not just the
entry points `discoverExtensionFiles` returns — because an `index.ts` importing
a changed `helpers.ts` must re-ask. Symlinks hash as their target *string* and
are never followed.

The asymmetry is deliberate. An extension entry IS the code. A hook command is
a *pointer into a shell* whose eventual payload is undecidable (`eval $(cat x)`,
`$TOOL/bin/y`, PATH order), so there is no best-effort path extraction from hook
commands — its failure mode is false coverage, the ragged guarantee the
providers post-mortem punished. The prompt carries the limitation in words.

Consequence, which is a property to preserve: editing `src/**`, `README.md`,
`.arcturn/skills/*.md`, `.arcturn/agents/*.md` or the config's
`model`/`route`/`theme` does **not** re-ask. Adding or editing a hook, any file
under `extensions/`, `verify`, or a stdio MCP server does. A gate that re-asks
for nothing gets clicked through, so the no-noise property is itself a security
property.

## Enforcement

`resolveProjectTrust` is called from `buildRuntime` as its **first
side-effecting step** — before `registerConfiguredProviders`, and therefore long
before extensions load, hooks are wired, the verifier is built, `sessionStart`
fires, or `connectMcp` spawns anything. The decision is stored on
`runtime.projectTrust` because `connectMcp` runs later and must read it.

`ConfirmProjectTrust` defaults to a hard `() => false` at **every** call site.
The only real confirmer is `terminalProjectTrustConfirm`, whose first statement
is `if (!process.stdin.isTTY) return false`, and it is wired at exactly one
place: `cli-main.ts`'s interactive branch, gated on `!args.print &&
process.stdout.isTTY === true`. `serve`, `acp`, `replay`, `mcp-serve`, evals and
background agents get nothing, and therefore get "no".

Off a TTY the run **continues with project code disabled** — never a hard exit,
which would turn "your repo has a hook" into "arcturn no longer starts in CI" —
and warns loudly and unconditionally, because disabling a project's hooks can
remove a *protective* `preToolUse` guard, not only an offensive one.

## Ways in

| | Persisted | Content-addressed |
| --- | --- | --- |
| Answering the prompt `y` | yes | yes |
| `arcturn trust --allow` / `/trust allow` | yes | yes |
| `--trust-project` | no | n/a |
| `ARCTURN_TRUST_PROJECT=1` | no | n/a |
| `trustedProjects` in **`~/.arcturn/config.json`** | n/a | **no** |

`trustedProjects` is documented as the weaker thing it is: it approves a *path*,
so whatever that path later comes to contain runs. Entries are an exact
directory or one ending `/*` (that directory and everything beneath it). It is
honoured **only** from the user layer — `parseConfigFile` warns and drops it
from a project file, and `project-trust.ts` reads it out of `~/.arcturn/config.json`
directly rather than from the merged config, for the same reason `providers.ts`
reads its rules that way: `parseRule` lets a project file label a rule
`scope: "user"`.

`--no-project-code` is the kill switch: parse and list everything, run nothing,
ask nothing.

## `ARCTURN_HOME` inside the checkout

If `paths.home` is inside `paths.cwd`, `trust.json` and `config.json` are files
the repository can ship. Refusing outright is wrong — every sandboxed run and
every end-to-end test legitimately points the home into a scratch tree — so
instead a recorded **allow** from such a store is not honoured (a recorded
**deny** still is; that direction is fail-safe), `trustedProjects` is ignored,
and the run says so. `--trust-project` and the interactive prompt still work,
because both are gestures made outside the repository. `mcp-serve.ts` makes the
same call for the same configuration.

## The prompt

Every string in it is attacker-written — commands, matchers, globs, server
names, arguments, env pairs and filenames. All of it goes through
`sanitizeForTerminal`, which removes complete CSI/OSC sequences (and their C1
spellings) and turns every remaining control byte into a space — a space, not
nothing, so `rm -rf<LF>/` cannot render as `rm -rf/`. An adversarial pass found
exactly this bug in the providers dialog (`security-review-4.test.ts`), so it is
assumed to be attempted here.

Commands are cut at 400 characters and lists at 20 entries, always with
`… and N more (truncated; read <absolute path> before answering)` — never a bare
ellipsis, which would imply the list was complete.

The confirmer takes an `erase` callback so the boot banner comes down before its
first byte: `runCli` erases the banner only *after* `buildRuntime` returns.

## Commands

- `arcturn trust` — status for this directory
- `arcturn trust --list` — everything that would run, by name
- `arcturn trust --allow` / `--deny` / `--revoke`
- `--cwd <dir>` on any of them
- `/trust [status|list|allow|deny|revoke]` in the TUI

Every state-changing verb says **when** the change lands in the same breath as
saying it was saved: nothing re-reads `trust.json` mid-session and no extension
is imported into a running process, so "Saved" alone would be the
`/permissions suggest` mistake again.

## Deliberate fail-open, written down

An **untagged** hook or verify entry — one built in code by an embedder or a
test rather than parsed from a project file — reads as **trusted**. Only
`parseConfigFile` mints `scope: "project"`. This is defensible because code that
calls `buildRuntime` with a hand-built config is already trusted code running in
this process, and it is why the blast radius on the existing suite was small. It
is a decision, not an oversight; do not "fix" it into a cries-wolf gate.

`buildTestRuntime` passes `trustProject: true` for the same reason: the scratch
project directory is written by the test, not by a repository somebody cloned.
Tests that are *about* the gate build their runtimes directly.

## What this gate does NOT stop

State these as content, not fine print.

1. **A hook's eventual payload.** The digest pins the command *string*. `bash
   ./setup.sh` is approved once; `setup.sh` can be rewritten afterwards, by the
   repository or by anything else, and will not re-ask. Same for `eval $(cat x)`,
   `$TOOL/bin/y`, and anything PATH order decides. The prompt says so.
2. **`http` MCP servers the project declares.** Egress to a URL, not a process
   on this machine — the line `registry.ts` already draws. A project `mcp.json`
   can still point an HTTP server at a host it chose, and conversation content
   goes there. This is a real remaining gap.
3. **Anything after the first "yes".** Approval is total and permanent for those
   contents. There is no per-hook, per-file or per-session granularity, and an
   approved `sessionStart` hook can immediately write `~/.arcturn/config.json`,
   the extensions directory, `mcp.json` — and `trust.json` itself. One "yes" is
   the whole machine.
4. **`trustedProjects` and `--trust-project`.** Neither is content-addressed.
   `--trust-project` in CI runs whatever the checkout contains today.
5. **Project *data*.** Skills, agents, memory, themes and `ARCTURN.md` are not
   gated here — deliberately. They are untrusted *content*, and
   `skill-tool.ts`'s `isTrusted` handles them with the right mechanism (a
   project skill's description never reaches the model-facing index). This gate
   must not swallow that one. Prompt injection through repository text remains
   the domain of `taint.ts` and the canary guard.
6. **The user layer.** `~/.arcturn` hooks, verify, extensions and MCP servers
   run unconditionally. That is the point; gating them is the cries-wolf failure.
7. **A repository that can already write your home directory.** Nothing here
   defends against a process that has already escaped.
8. **Extension trees past 2000 files or 32 directories deep.** The walk stops
   and the surface is marked truncated, which suppresses stored-digest matching
   entirely — so such a project re-asks on every launch rather than riding an
   incomplete digest.
9. **TOCTOU between the digest and the load.** The tree is hashed, then loaded.
   A repository that can write the extensions directory *during* startup can
   change a file in between. It would already need code execution to do that.
