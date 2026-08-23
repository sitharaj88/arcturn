---
title: Permissions
description: The rule-based permission engine — modes, scopes, resolution order, and the rule cookbook.
section: Core concepts
order: 5
---

## Why a permission engine

A coding agent that can write files and run shell commands needs a gate between "the
model wants to" and "it happens." Arcturn ships `PermissionEngine` from `@arcturn/core`:
a rule-based allow/deny/ask resolver with session, project, and user scopes, wired into
the agent by default. See [/security](/security) for the broader threat model this is
one layer of — this page is the operational reference for that one layer.

## Modes

```json
"default" | "acceptEdits" | "yolo" | "plan"
```

- **`default`** — read-only tools run freely; anything else is asked about, unless a
  rule already settles it.
- **`acceptEdits`** — like `default`, but `write` and `edit` are also auto-approved. Good
  for a session where you're actively reviewing every diff yourself.
- **`plan`** — only read-only tools may run. Every mutating tool is denied outright, with
  a message telling the model to use the `plan` tool instead. This is the enforcement
  half of [plan mode](/docs/sub-agents#plan-mode-and-todos): the model can look around and
  reason, but the only way out is presenting a plan for approval.
- **`yolo`** — everything is auto-approved. For sandboxes and CI, not your laptop.

Switch modes at runtime with `agent.setPermissionMode(mode)`, or in the CLI with
`/permissions` — it prints the current rules, then prompts you to pick a mode from the list.

The default tool classifications a mode reasons about:

- **Read-only** (usable in `plan` mode, auto-allowed in `default`): `read`, `grep`, `glob`, `ls`.
  `fetch` is deliberately *not* on this list — it reads nothing local but sends data to an
  arbitrary host, so it is gated like a mutating tool and prompted per origin.
- **Edit tools** (auto-approved by `acceptEdits`): `write`, `edit`. `DEFAULT_EDIT_TOOLS`
  carries a third entry, `multiedit`, which no package registers — it is a
  [reserved name with no tool behind it](/docs/tools#multiedit-reserved-and-currently-inert)
  and matches no call.
- **Always-allow** (pass silently in every mode, no prompt ever): `todo`, `plan` — pure
  session state, never worth interrupting the model over.

Every one of these lists is overridable per engine instance (`readOnlyTools`, `editTools`,
`alwaysAllowTools` in `PermissionEngineOptions`).

Anything not on one of those lists is neither auto-allowed nor auto-denied: it falls through
to the prompt. That includes tools that only read — `search_code` and `symbols` are both
absent from the read-only list, so both are asked in `default` and refused in `plan`. See
[Code search § Limits](/docs/code-search#limits).

## Rules

```json
{
  "tool": "bash",
  "specifier": "git *",
  "action": "allow",
  "scope": "project"
}
```

| Field | Meaning |
| --- | --- |
| `tool` | A tool name, or `"*"` for every tool. |
| `specifier` | Matched against the subject — a command prefix, a path glob, or an exact string. Omitted or `"*"` matches anything. |
| `action` | `"allow"`, `"deny"`, or `"ask"`. |
| `scope` | `"session"`, `"project"`, or `"user"`. |

The **subject** a specifier is matched against is derived from the tool call's arguments:
the first present key of `command`, `file_path`, `filePath`, `path`, `url`, `pattern`,
`query`, `target` wins. Path-valued keys (`file_path`, `filePath`, `path`, `target`) are
resolved against the working directory and normalized first, so `.env`, `./.env`, and
`/repo/sub/../.env` all present the same subject — a deny rule written with an absolute
path still matches the same file named relatively. If none of those keys are present, the
subject is `""`, which only matches wildcard rules.

### Specifier forms

- **Command prefix** — a specifier ending in `" *"` (e.g. `"git *"`) matches a subject
  that is exactly the prefix or starts with `"<prefix> "`. The match is applied
  **per shell segment**: the subject is split on `;`, `&`, `&&`, `||`, `|`, newlines,
  `$(`, `` ` ``, `<(`, `>(`, and *every resulting segment* must match the prefix for the
  rule to fire. This is what keeps `allow bash "git *"` from also approving
  `git status; rm -rf ~` — one segment (`rm -rf ~`) fails the prefix test, so the whole
  subject fails to match and the rule does not apply. Quoting is not interpreted, which
  over-splits rather than under-splits, so it can never accidentally widen a rule.
- **Glob** — a specifier containing `*` or `?` (and not ending in `" *"`) is compiled to a
  regular expression: `**` crosses directory separators, a single `*` does not, `?`
  matches exactly one non-separator character. `**/*.ts` matches any absolute path ending
  in `.ts`; `**/src/**/*.ts` matches any absolute path with a `src/` directory component
  somewhere in it, ending in `.ts`. Both `/` and `\` count as separators, on every
  platform, so `**/.env` also denies `C:\repo\.env` and `C:\repo\*` grants that one
  directory rather than everything beneath it. A backslash is therefore a separator, not
  an escape — globs have no escape syntax.
- **Exact string** — anything else must match the subject exactly, character for character
  (a path specifier aside — see below).

Path-valued specifiers need the leading `**/` (or a full absolute path) because the
subject a `write`/`edit`/`read` call is matched against is always the tool's `path`
argument **resolved to an absolute path first** — a specifier like `src/**/*.ts`, anchored
at the start with no wildcard before it, will never match `/Users/you/project/src/app.ts`.

### Paths are compared the way the filesystem compares them

A specifier or subject that names a file — it holds a separator or opens with `**`, and is
not a command line or a URL — is compared by filesystem rules rather than byte for byte:
either separator matches either separator, and **case is insignificant wherever the
filesystem says it is**. That last part is decided by probing the real filesystem, not by
guessing from the platform, so it is on for Windows volumes and for a stock macOS (APFS is
case-insensitive as it ships) and off on Linux.

It matters because `deny **/.env` is only worth writing if it also refuses `.ENV` — on a
case-insensitive volume those are one file, and comparing them byte for byte left the
second spelling as a free bypass of the rule. The tradeoff is symmetric and worth stating:
a `deny` gets strictly safer, and an `allow` gets correspondingly broader
(`allow write /repo/src/**` also allows `/REPO/SRC/app.ts`) — on a filesystem where those
name the same files anyway.

Commands and URLs are **not** folded: `argv` is case-sensitive on every platform, so
`allow bash "npm test"` never approves `NPM TEST`, and a backslash inside a command stays
a backslash.

## Resolution order

For every tool call, the engine works through this order and stops at the first hit:

1. **Always-allow tools pass silently.** Tools in `alwaysAllowTools` (`todo`, `plan` by
   default) return `allow` immediately — before a request is even built, so no
   `permissionRequest` event fires and no rule is consulted.
2. **`plan` mode denies non-read-only tools outright.** This check runs *before* rules are
   evaluated: in `plan` mode, no stored `allow` rule — however specific, however recently
   added — can let a mutating tool through. The denial message is:

   ```text
   Plan mode is active: "<tool>" cannot run because it may modify state. Present a plan
   with the plan tool and wait for approval.
   ```

   A read-only tool falls through to step 3 like normal — a `deny` rule can still block a
   read in plan mode.
3. **Stored rules are matched.** See [Scope precedence](#scope-precedence-and-the-specificity-tiebreak)
   below. A match resolves the call as `allow` or `deny`, terminal. No match (or an
   explicit `"ask"` rule) falls through.
4. **Read-only tools are allowed.** `read`, `grep`, `glob`, `ls` by default, unless a rule
   already said otherwise in step 3. Prompting for every file read would make `default`
   mode unusable.
5. **`yolo` allows what's left; `acceptEdits` allows edit tools.** In `yolo` mode anything
   still unresolved is allowed. In `acceptEdits`, only `write`/`edit` are — plus the
   reserved `multiedit` name, which no tool answers to.
6. **Whatever's left is asked.** The configured `PermissionRequester` is called. With no
   requester configured, the call is denied — `"Permission required for \"<tool>\" but no
   permission requester is configured."` — never assumed safe.

### Scope precedence and the specificity tiebreak

Among rules that match a call's tool and subject, precedence is:

1. **Scope**: `session` beats `project` beats `user`.
2. **Specificity**, within a scope: an exact tool name (`2` points) beats `"*"` (`0`
   points); an exact specifier (`2` points) beats a glob (`1` point) beats no specifier
   or `"*"` (`0` points). The two scores add, so `{tool: "edit", specifier: "src/a.ts"}`
   (specificity 4) outranks `{tool: "edit", specifier: "src/**/*.ts"}` (specificity 3)
   outranks `{tool: "*", specifier: "*"}` (specificity 0).
3. **Deny bias**, on a tie: if the two most-specific matching rules disagree and are
   equally specific, `deny` wins.
4. **Insertion order**, on a further tie: earlier rules win.

There is one more twist, applied after the above picks a winner: **a more specific `deny`
beats a broader permissive rule even from a nearer scope.** Scope precedence alone would
let a project-scoped `{tool: "*", action: "allow", scope: "project"}` override a
user-scoped `{tool: "bash", specifier: "rm -rf *", action: "deny", scope: "user"}` — which
would mean a checked-in project config could escalate its own privileges just by being
cloned. So after the normal precedence picks a winner, the engine separately finds the
most specific `deny` among *all* matching rules (any scope) and lets it override the
winner if it is strictly more specific than what precedence alone chose.

### The plan-gate exit path bypasses all of this

Leaving `plan` mode is not decided by rules at all. The `plan` tool's approval flow calls
`PermissionEngine.ask()` directly — the same low-level primitive `check()` is built on,
but skipping rule matching, mode logic, and read-only/edit shortcuts entirely. It always
goes straight to the configured requester with `subject: "exitPlanMode"`. This is
deliberate: a stored `allow` rule for the `plan` tool (there is one by default — it's in
`alwaysAllowTools`) must not be able to pre-approve leaving plan mode, or plan mode would
have no teeth.

## Persisting a decision

When a user approves a request, they can attach a `persistRule` so the same class of
action never asks again:

```json
{
  "requestId": "perm_abc123",
  "behavior": "allow",
  "persistRule": {
    "tool": "edit",
    "specifier": "src/**/*.ts",
    "action": "allow",
    "scope": "project"
  }
}
```

Tools that call `requestPermission` fill in `suggestedRule` on the request, so a UI can
offer "always allow" with a sensible default specifier already chosen — that's the
"Allow always: bash git *" prompt you see in the terminal for a `bash git status` call
(a `bash` subject is widened to its first word plus `" *"`; other tools default to their
exact subject).

### Where a persisted rule lands

`persistPermissionRule(rule, paths)` writes the rule into a config file matching its
scope:

- **`session`** — not written anywhere; it lives only in the running `PermissionEngine`
  for the process's lifetime.
- **`project`** — appended to `<cwd>/.arcturn/config.json`'s `"permissions"` array. If
  `cwd` is the user's home directory (so "project" and "user" would be the same file),
  the rule is silently re-tagged `"user"` first, so its declared scope always matches the
  file it actually lands in.
- **`user`** — appended to `~/.arcturn/config.json`'s `"permissions"` array (`~/.arcturn`
  is overridable via `ARCTURN_HOME`).

A rule identical to one already in the file (same `tool`, `specifier`, `action`) is not
duplicated. A config file cannot declare a rule with a *stronger* scope than the layer it
lives in — a project file that labels one of its rules `"session"` has that label
downgraded to `"project"` with a warning, so a checked-in config can't claim session-level
authority just by asserting it.

## Cookbook

Every rule below is valid against the real matcher described above.

**Allow read-only git everywhere, ask for everything else in git:**

```json
{ "tool": "bash", "specifier": "git status", "action": "allow", "scope": "user" }
{ "tool": "bash", "specifier": "git log *", "action": "allow", "scope": "user" }
{ "tool": "bash", "specifier": "git diff *", "action": "allow", "scope": "user" }
```

Exact/prefix matches only — `git push` and `git commit` still fall through to `ask`.

**Allow all git subcommands, but hard-deny the destructive ones:**

```json
{ "tool": "bash", "specifier": "git *", "action": "allow", "scope": "user" }
{ "tool": "bash", "specifier": "git push --force *", "action": "deny", "scope": "user" }
```

Both specifiers contain `*`, so both score the same specificity (`3`: exact tool + one
glob/prefix point) — a tie. On a specificity tie the engine's deny bias applies: `deny`
wins over `allow` automatically, so `git push --force origin main` is refused without
needing any scope trickery.

**Restrict edits to `src/`, deny everywhere else:**

```json
{ "tool": "edit", "specifier": "**/src/**/*.ts", "action": "allow", "scope": "project" }
{ "tool": "edit", "specifier": "*", "action": "deny", "scope": "project" }
```

For a path under `src/`, the first rule's glob specificity (3) beats the second rule's
wildcard specificity (2), so it wins. For a path outside `src/`, only the second rule
matches, so it wins. This is how "allow only here" gets expressed — there's no negated
glob syntax, so it's always an `allow` for the narrow case plus a `deny` for the wide one.

**Ask before any bash call, by default (the do-nothing rule, written down):**

```json
{ "tool": "bash", "action": "ask", "scope": "user" }
```

Equivalent to having no rule at all — `bash` isn't read-only, so it falls through to
step 6 either way — but useful as a placeholder to attach a comment to in a checked-in
config, or to override a broader `allow *` from a lower-precedence scope.

**Deny writing to secrets, from any scope, permanently:**

```json
{ "tool": "write", "specifier": "**/.env", "action": "deny", "scope": "user" }
{ "tool": "edit", "specifier": "**/.env", "action": "deny", "scope": "user" }
```

`write`/`edit` subjects are the tool's `path` argument, resolved to an absolute path
before matching — so the specifier has to be a glob (`**/.env`), not the bare relative
string `.env`, or it will never match. Because the subject is normalized first, this glob
catches `.env`, `./.env`, and `sub/../.env` alike, all resolving to the same absolute
path — and per the deny-override rule above, no project-scoped `allow *` can out-rank it.

## `/permissions`

Run `/permissions` with no arguments to see the active mode and every stored rule, then
pick a new mode:

```text
Permission mode: default
Rules (most specific wins; session > project > user):
  allow bash git *  (user)
  deny  edit .env  (user)
```

Each rule line is `<action padded to 5> <tool><specifier?>  (<scope>)` — e.g.
`allow bash git *  (user)`.

### `/permissions suggest`

Arcturn's policy learner watches every permission decision in the session. Once the same
`(tool, widened-specifier)` cluster has accumulated **3 consistent decisions** (all
allows, or all denies — a mixed cluster never suggests, since that means you're
discriminating *within* it) in the last 20 observed decisions, it becomes a suggestion:

```text
You've denied "bash git push" 3 times. Add a deny rule to your project config?
```

`/permissions suggest` lists every current suggestion; picking one calls
`persistPermissionRule` with `scope: "project"` — suggestions always save to the project
file, never session or user, regardless of where the individual denials happened to be
resolved. This module only ever suggests; it never writes a rule on its own.

## Config file locations

| Scope | File |
| --- | --- |
| User | `~/.arcturn/config.json` (or `$ARCTURN_HOME/config.json`) |
| Project | `<cwd>/.arcturn/config.json` |

Both are loaded and merged at startup — user first, then project — with permission rules
concatenated (not replaced) across layers, so a project's rules add to the user's rather
than overriding them. See [Configuration](/docs/configuration) for the full layering
story across every setting, not just permissions.

## Wiring it up

```json
{
  "permissionMode": "default",
  "permissions": [
    { "tool": "bash", "specifier": "git *", "action": "allow", "scope": "user" }
  ]
}
```

```bash
arcturn --permission-mode yolo   # sets the starting mode for this run — see arcturn --help
```

`createAgent` builds a `PermissionEngine` internally from `AgentOptions.permissions` and
`onPermissionAsk` — most hosts never construct one directly. See
[the SDK guide](/docs/sdk) for wiring `onPermissionAsk` into your own UI.
