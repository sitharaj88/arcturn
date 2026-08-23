---
title: Dry run & sandbox
description: The --dry-run shadow-tree overlay, /diff /apply /discard, and the opt-in OS filesystem sandbox.
section: Core concepts
order: 5.2
---

## What dry run is

`--dry-run` (or `"dryRun": true` in config) is plan mode for *files*: instead of asking
"may the model touch anything," it lets the model work completely normally and reroutes
every file mutation into a private shadow copy of the workspace. You review one aggregate
diff at the end and decide whether it lands for real. Nothing under `plan` mode's "look
but don't touch" restriction — the agent can `write`, `edit`, run its usual loop — but the
result never reaches your real files until you say so.

This is a different control than [permissions](/docs/permissions): permissions decide
*whether* a tool call is allowed to run at all; dry run decides *where its effects go*
once it's allowed. For the broader story of what each layer defends against, see
[/security](/security) — this page covers only how dry run and the OS sandbox behave.

## Lifecycle of a dry run

1. **Start the session with `--dry-run`.** The CLI creates a shadow directory at
   `~/.arcturn/overlays/<sessionId>/` and wraps the `write`, `edit`, and `read` tools so
   their `path` argument is redirected there whenever it falls inside the workspace.
2. **The agent works normally.** The first time a sheltered file is written or edited, it
   is copied into the shadow tree (so `edit`'s diff-and-patch logic has real content to
   match against) — a no-op if a shadow copy already exists, so the agent's own pending
   edits are never clobbered by a later touch, and a no-op for a brand-new file, which
   simply gets created directly in the shadow. `read` is redirected **only when a shadow
   copy already exists** for that path, so the agent sees its own pending edits but falls
   through to the real file for everything it hasn't touched yet.
3. **Review with `/diff`.** Prints one aggregate unified diff across every pending change,
   paths shown relative to the workspace root, 3 lines of context per hunk, each file
   capped at 200 body lines before a truncation marker (`... diff truncated: N more lines
   for <path>`).
4. **Commit with `/apply`, or throw it away with `/discard`.**

```text
> /diff
--- a/src/app.ts
+++ b/src/app.ts
@@ -12,3 +12,4 @@
  export function start() {
-  console.log("boot");
+  console.log("booting");
+  return true;
  }
```

`/apply` first asks "Apply N file(s) to the workspace?" with an Apply/Keep-pending choice.
On confirmation, each pending change is written back over the real file via a temp-file-
plus-rename in the destination directory, so an interrupted apply can never leave a
half-written file behind. A per-file failure is collected and reported without blocking
the rest:

```text
Applied 4, failed 1. Pending changes kept.
```

If every file applies cleanly, the shadow tree is discarded automatically and you see
`Applied N file(s).`. `/discard` asks "Discard N pending file change(s)?" and, on
confirmation, deletes the whole shadow tree — safe to call even if nothing is pending.

## Symlink-safe apply

`bash` is not wrapped by the overlay (see [the boundary](#the-boundary-bash-grep-and-glob-see-the-real-tree)
below), so nothing stops the agent from creating a symlink inside the workspace that
points somewhere else entirely — `ln -s /etc /repo/src/escape`. If `write`/`edit` then
targeted a path through that link, the shadow tree's *relative* structure would still put
the pending change under `<shadowDir>/src/escape/passwd`, but the *real* destination
`/apply` would write to is wherever the link actually resolves — potentially far outside
the workspace the reviewed diff described.

`apply()` guards against this per file: before writing, it resolves symlinks on the
target's existing ancestors (walking up to the nearest ancestor that exists, since an
added file may not exist yet) and checks that the resolved path is still the workspace
root or a strict descendant of it. A path that resolves outside is refused with:

```text
resolves outside the workspace (symlink); refused
```

and reported as an apply error rather than silently written. This check runs at apply
time, not at write time, because the symlink might not have existed yet when the shadow
copy was made.

## The boundary: `bash`, `grep`, and `glob` see the real tree

Only `write`, `edit`, and `read` are wrapped. `bash`, `grep`, and `glob` take a command or
a pattern rather than a single `path` argument, so there is no one field to redirect —
they are intentionally left alone. This means:

- A shell command (`bash`) still reads and **mutates the real filesystem**, dry run or
  not. `rm file.ts`, `git commit`, `npm install` — none of it is sheltered.
- `grep` and `glob` search the real tree, so they will not see a pending `edit` that
  hasn't been applied yet, and they may surface files a pending `write` would have
  removed.

If you need bash-driven changes reviewed before they land too, dry run is not a substitute
for a real sandbox or a disposable checkout — it only covers the three tools it wraps.

## Interplay with checkpoints and `/rewind`

[Checkpoints](/docs/checkpoints) snapshot a file's content immediately before the first
`write`/`edit` touches it in a turn — but the checkpoint layer wraps *outside* the overlay
and reads the tool call's raw `path` argument, which is the **real** path, before the
overlay's own wrapping redirects the write into the shadow tree. In practice this means:

- Under dry run, checkpoints keep snapshotting the real file's (unchanged) content, since
  the real file never actually changes until `/apply`. There is nothing for `/rewind` to
  restore from a dry-run session's pending edits — the shadow tree, not the checkpoint
  store, is the record of what changed.
- Once you `/apply`, those writes land as ordinary file mutations from that point forward;
  any *later* edit in the same session is checkpointed normally, against the post-apply
  content.
- Dry run and [speculative editing](/docs/configuration) both want to own the shadow tree,
  so they cannot run together: enabling both disables speculation for the session with a
  startup warning, and dry run wins.

`verify` (a command run after edits) is also disabled under dry run for the same reason —
it would run against an untouched workspace and report a pass on code the model never
actually wrote.

## The OS sandbox

Dry run controls where `write`/`edit` land; the sandbox controls what a `bash` command is
*allowed* to touch on disk, regardless of dry run. It is a separate, opt-in layer.

```json
{ "sandbox": "workspace-write" }
```

- **`"off"`** (default) — commands run exactly as they always have; nothing is restricted.
- **`"workspace-write"`** — the command is wrapped by an OS-level sandbox that denies file
  writes everywhere except three roots: the command's working directory, the OS temp
  directory, and `$HOME/.arcturn`. Reads, network access, and process spawning are left
  alone — this narrows *write* access only.

### Platforms and backends

| Platform | Backend | Binary |
| --- | --- | --- |
| macOS | `sandbox-exec` | `/usr/bin/sandbox-exec` |
| Linux | Bubblewrap | `bwrap` on `PATH` |
| Windows (and anything else) | — | no backend exists |

Windows is not a gap in the implementation that might close with a missing binary — there
is no OS-level filesystem-confinement primitive Arcturn can reach for there today, full
stop. Asking for `"workspace-write"` on Windows never fails the command and never claims a
confinement that isn't real; see **Unavailable fallback** below for the exact note that
appears instead. If you need the sandbox, run under **WSL2**, which gets you the Linux
`bwrap` backend.

On macOS, the profile is built as:

```text
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<cwd>"))
(allow file-write* (subpath "<tmpdir>"))
(allow file-write* (subpath "<home>/.arcturn"))
```

`(allow default)` plus a narrower `(deny file-write*)` means only file writes are
restricted — nothing here touches sockets. On Linux, `bwrap` binds `/` read-only and binds
each writable root read-write, with `--share-net` so networking is unaffected. Writable
roots are resolved through `realpath` before being embedded (macOS's `/var`, under which
`os.tmpdir()` lives, is itself a symlink to `/private/var` — embedding the un-resolved path
would make every temp-dir write fail against the profile's canonicalized check).

### Unavailable fallback

If the mode is anything other than `"off"` but sandboxing can't actually happen, the
command still runs — arcturn never blocks the command or fails the session over this —
but it runs **unsandboxed**, and the result text says so instead of staying silent. The
note is different depending on why:

- **The binary is missing on a platform that does support it** (`/usr/bin/sandbox-exec`
  not present on macOS, `bwrap` not on `PATH` on Linux):

  ```text
  note: sandbox requested but unavailable on this platform
  ```

- **There is no backend for this platform at all** — Windows today:

  ```text
  note: sandbox requested but Arcturn has no filesystem sandbox backend for "win32"
  (only macOS's sandbox-exec and Linux's bwrap are implemented) — the command below ran
  WITHOUT confinement: nothing restricted its writes to the working directory, the OS
  temp dir, or $HOME/.arcturn, and nothing stopped it writing anywhere else this user can.
  ```

Either way, this is a narrowing control, not a jail even when it *is* active: it
constrains where writes can land, not what the command can read, download, or execute.
