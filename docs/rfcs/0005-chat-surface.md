# RFC 0005 — The chat surface

Status: accepted · Author: Sitharaj Seenivasan · 2026-08-25
Amended: 2026-08-26 — §2, permission requests (see §2.1)

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
- **Permission requests are answered in the panel**, in a reserved region of
  the dock, and gain "allow for this session" where the engine reports the
  request is repeatable. This clause originally read "stay native modals";
  §2.1 says what changed and why it is safe.
- **A tools line** in the empty state naming what this engine can do —
  including whether it can reach the web — so the panel's capabilities are
  legible before the first prompt rather than discovered by failure.

### 2.1 Permission requests, amended

This section used to say permission requests stay native modals, and the code
called that "a security decision". Neither said what the threat was, and that
omission is the actual bug: a rule nobody can restate is a rule nobody can
check.

**The threat was spoofing.** Model output lands in the transcript. If a model
could draw something that looked like a permission card, a person could click
a forged Allow and grant a tool nobody asked to grant. A native modal is drawn
by the workbench, so it cannot be forged from inside the page — and that, and
only that, is what the modal was buying.

**The threat does not reach this panel.** The webview builds every node with
`createElement`/`createElementNS` and fills it with `textContent`. There is no
`innerHTML` anywhere in the shipped script and `webview-html.test.ts` asserts
there is none; the markdown renderer walks a tree of objects rather than
concatenating tags, precisely so no string of HTML exists for an injection to
land in. Model text therefore becomes text nodes. **A model cannot create a
button.** The most it can author is a sentence saying "click Allow below",
which is social engineering — the same thing it could already do in a
transcript sitting behind a modal — and not a forged control.

Against that, the modal was costing something real. It steals focus, it
appears in the middle of the screen far from the transcript it is about, and
it interrupts. Every comparable extension approves inline. So the surface
moves, and these are the properties that keep the move sound:

1. **A reserved region.** The card renders into `#permission`, which lives in
   `#dock` beside the composer — the same region that already holds the plan
   card and the dry-run review card. It is never rendered into the message
   flow. `#turns` is the only place transcript content is appended, so a
   permission card can never appear where model text appears and model text
   can never appear where a permission card does. This is structural, not a
   convention: it is asserted in `webview-html.test.ts` and in
   `webview-render.test.ts`.
2. **Engine-authored content only.** Every string on the card comes from the
   validated `permissionRequest` payload by way of `describePermissionRequest`,
   which quotes the engine verbatim (RFC 0004 §1 Stage 2). None of it is
   transcript text. The arguments block is rendered by the same function the
   modal uses, so the two surfaces cannot disagree about what was asked.
3. **The page names a button, never a decision.** It posts back a *label*; the
   host runs it through `answerFromChoice` — the same function the modal's
   answer goes through — which denies anything that is not one of two known
   allow labels. "Allow for this session" persists the rule the *engine*
   attached, re-derived on the host from the request; a page that presses that
   label on a request with no suggested rule gets a plain allow. The panel
   cannot express a behaviour, a rule, or a scope.

**A modal is visible wherever the user is looking; a panel is not.** That is
the one thing the modal had that the card does not, and it is not negotiable:
a pending permission must never be invisible while a run waits on it. The
answer is three things, in order:

- **Reveal.** Every request first asks the view to show itself, with
  `preserveFocus` — the half of a modal's behaviour worth keeping (put the
  question where it can be seen) without the half worth losing (take the caret
  out of whatever was being typed).
- **Fall back.** The host asks whether the view is *actually* visible. If it is
  not — never opened, removed from its container, or a workbench that would not
  bring it up — the request is asked as a native modal instead. The one
  outcome that is not allowed is asking nowhere.
- **Badge, and escalate.** While the engine is waiting, the view's activity-bar
  icon carries the count, which is legible in every layout that has an activity
  bar. And because `retainContextWhenHidden` is off (RFC 0004 §3), hiding the
  panel *destroys* the page and the card with it — so a view that goes hidden
  with a request outstanding withdraws the card and re-asks it as a modal.

**One live surface per request.** Escalation withdraws before it raises, and an
answer from a surface that no longer owns the request is dropped, so the card
and the modal can never both be showing the same question or disagree about
what it was.

Nothing about the *decision* moved. "Every outcome that is not an explicit
allow is a denial" still holds — a dismissed modal, a prompt that could not be
shown, a label the extension does not recognise, and the denials a disposal,
a session switch or a dropped connection send all produce `deny`. "Allow for
this session" is still offered only where the engine attached a rule, and the
scope on the wire is still `session` and nothing else. Those rules live in
`dialog.ts`, which has no window in it and is tested without one; only the
presentation moved.

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
- **No permission control outside the reserved region**, and no `innerHTML` in
  the panel. §2.1 rests on both; either one going away puts a grantable
  control back within reach of model output.

## 4. Acceptance

Attach a file with `@`, watch the chip appear with its real size, send, and
see the model answer about the file's contents. Switch to `plan` and watch a
write get refused. Type `/` and run a workspace skill. Paste an image into a
vision model and have it answer; paste it into one without vision and be told
why, before the turn is spent.

For §2.1: ask for something that needs permission and answer it in the panel
without a modal appearing, with the keyboard, from the button focus lands on.
Then hide the Arcturn view and ask again — see the modal appear instead, and
see the activity-bar badge while it waits. Then start a request, hide the view
while the card is up, and watch the same request arrive as a modal rather than
sit on a page that no longer exists.
