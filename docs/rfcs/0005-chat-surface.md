# RFC 0005 — The chat surface

Status: accepted · Author: Sitharaj Seenivasan · 2026-08-25

## 0. Why this exists

The VS Code panel can hold a conversation and little else. It cannot attach a
file, cannot say which permission mode it is running under, cannot offer the
skills the workspace already installed, and cannot show that the engine has a
browser at all. RFC 0004 §0 forbids the extension from reaching around the
protocol to get any of it, and that rule is right — so the gaps are the
protocol's to close, not the panel's to fake.

Four of them are load-bearing, and one is a bug rather than a gap:

1. **`@`-mentions are not expanded on the serve path.** `expandMentions` runs
   in `print.ts` and the TUI. A prompt arriving over the wire is passed
   through verbatim, so `@src/auth.ts` reaches the model as six words about a
   file rather than the file. Every remote client is silently degraded, and
   nobody noticed because the TUI is where mentions were tested.
2. **No permission verb.** A client cannot read the mode it is running under,
   cannot change it, and cannot offer "always allow this tool" when a request
   arrives — the one moment a person actually wants that choice.
3. **No command discovery.** Skills are markdown files the workspace already
   holds; `loadSkills` reads them. A remote client cannot list them, so the
   ecosystem the hub exists to distribute is invisible from the panel.
4. **Text-only prompts.** No image, no attachment, no way to say "this is
   context, not instruction".

## 1. The contract

Additive verbs, `PROTOCOL_VERSION` stays 1, unknown-method degradation per the
`listModels` precedent. Each carries its own refusal rather than a silent
best effort.

### 1.1 Context

**Fix the bug first.** The served agent expands mentions exactly as the TUI
does, from the session's `cwd`, with the same workspace confinement. A mention
that resolves outside the workspace is refused, not read — this path is
reachable by anyone holding the serve token, so it inherits the strictest
existing rule rather than a new one.

`prompt` grows an optional `attachments` array. Each attachment names its kind
(`file` | `image`), its path or data, and is subject to the same confinement.
Images become vision blocks; files become context blocks that say what they
are. A prompt with attachments the model cannot use (an image to a text-only
model) is refused with the reason, never silently dropped — the catalog
already knows which models see images.

`resolveContext` lets a client ask what a mention *would* resolve to before
sending: the path, the byte count, whether it is inside the workspace. That is
what makes a file picker honest rather than hopeful.

### 1.2 Permissions

`permissionState` returns the session's current mode and its rules.
`setPermissionMode` changes the mode. Both are session-scoped.

The engine remains the authority: a mode is a *request*, and a deny rule still
wins over `yolo` exactly as it does in the TUI. A client that sets a mode is
not granted anything the permission engine would not grant a local user, and
`setPermissionMode` never edits rules — that is a file a person owns.

`permissionDecision` grows an optional scope so "allow once" and "allow for
this session" are distinguishable at the moment of asking. Nothing persists to
disk from a remote client: a session-scoped allow dies with the session. A
rule that outlives a session is written by a person, in their own config.

### 1.3 Commands

`listCommands` returns what a `/` could invoke here: each skill's name,
description and source, plus the built-ins a remote client can actually reach.
A command the panel cannot execute is not listed — a menu offering `/rewind`
to a client with no rewind verb is a menu that lies.

Execution stays `prompt`: a skill is prompt text, and inventing a second
execution path would give the same skill two behaviours.

### 1.4 Web

Nothing new. `fetch` and `websearch` are already tools; what is missing is
that a client cannot see whether they are enabled. `permissionState` carries
the tool names available to the session, so the panel can say "this engine can
browse" truthfully instead of implying it.

## 2. What the panel does with it

A composer that reads as one control rather than a text box with buttons
bolted on: attach and context on the left, model and mode as chips, send and
stop on the right.

- **`@` opens a context picker** — workspace files, fuzzy, showing what will
  actually be injected and its size. Chips above the composer show what is
  attached, each removable. Drag-and-drop and paste-an-image land in the same
  place.
- **`/` opens the command menu** — skills first with their descriptions, then
  built-ins, filtered as you type, Enter to insert.
- **A mode chip** showing `default` / `acceptEdits` / `plan` / `yolo`, with
  what each grants stated in one line. Changing it is one click and takes
  effect on the next turn.
- **Permission requests** stay native modals, and gain "allow for this
  session" where the engine reports the request is repeatable.
- **A tools line** in the empty state naming what this engine can do —
  including whether it can reach the web — so the panel's capabilities are
  legible before the first prompt rather than discovered by failure.

## 3. What this RFC refuses

- **No client-side context assembly.** The panel never reads a file to build a
  prompt. It asks the engine what a mention resolves to and sends the mention.
  A file read by the extension is a file the permission engine never saw.
- **No mode that outranks a deny rule**, and no remote write to a user's
  permission config.
- **No command the panel cannot run**, and no second execution path for
  skills.
- **No capability implied by an affordance.** A browse button on an engine
  without `fetch` is worse than no button, so every affordance is driven by
  what `permissionState` actually reports.

## 4. Acceptance

Attach a file with `@`, watch the chip appear with its real size, send, and
see the model answer about the file's contents. Switch to `plan` and watch a
write get refused. Type `/` and run a workspace skill. Paste an image into a
vision model and have it answer; paste it into one without vision and be told
why, before the turn is spent.
