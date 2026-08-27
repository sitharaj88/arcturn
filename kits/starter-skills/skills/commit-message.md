---
name: commit-message
description: Draft a Conventional Commits message from the staged diff alone — type and scope derived from the changed paths, never invented.
---
Draft one Conventional Commits message for the changes that are **staged right now**
in $CWD. Extra context from the author, which may be empty: $ARGUMENTS

Read the change before describing it:

```bash
git diff --staged --stat
git diff --staged
```

If the staged diff is empty, say exactly that and stop. Do not describe unstaged work,
do not run `git add`, and do not write a message for a change you cannot see.

## Deriving the message

**Type** comes from what the diff does, not from what the author called it:

| Type | Use when the staged diff... |
|---|---|
| `feat` | adds a capability a user or caller can now reach |
| `fix` | corrects behaviour that was wrong — there is a defect being closed |
| `perf` | leaves behaviour identical and improves time, memory or IO |
| `refactor` | leaves behaviour identical and changes structure |
| `test` | touches only tests or fixtures |
| `docs` | touches only documentation or comments |
| `build` / `ci` | touches only build config or pipeline files |
| `chore` | none of the above — dependency bumps, generated files, metadata |

When the diff spans several types, choose the one a reader would most want to find in
the log — usually the user-visible one — and mention the rest in the body. Never chain
two types into one subject.

**Scope is derived or omitted. It is never guessed.** A scope is legitimate only when
the staged paths themselves name one:

- every staged file under one package or module directory → that directory's name
  (`packages/cli/src/registry.ts` plus `packages/cli/src/registry.test.ts` → `cli`);
- files spanning unrelated areas → **no scope at all**: write `fix: ...`, not
  `fix(core): ...`;
- a layout that offers no such name → **no scope at all**.

An invented scope is worse than a missing one. It is a claim about how the codebase is
organised, a future reader will believe it, and `git log --grep` will act on it.

**Subject**: imperative mood ("add", not "added" or "adds"), lower case after the
colon, no trailing period, the whole line at most 72 characters.

**Body**, omitted when the subject genuinely says everything: wrapped at 72 columns and
spent on *why* — the behaviour before, the behaviour after, and what made the change
necessary. The diff already shows what changed; do not narrate it hunk by hunk.

**`BREAKING CHANGE:` footer**: only when the staged diff itself shows an incompatible
change to something a caller depends on — a removed or renamed export, a changed
signature or return shape, a config key that stops working, a default that moved. State
the migration as what a caller must now write instead. If the diff does not let you name
that migration, do not assert the break: raise it in the body as unconfirmed.

## Honesty rules

- Describe only what is in the staged diff. Unstaged and untracked files do not exist
  for the purposes of this message.
- Never assert that a test ran or passed. A diff cannot show that.
- Reference an issue, ticket or PR **only** if the author supplied it in $ARGUMENTS.
  Never synthesise a `#123` or a `Refs:` trailer.
- If the author's context contradicts the diff, follow the diff and name the specific
  claim you could not confirm.

## Output

Output the commit message alone, in one fenced block, ready to pipe into
`git commit -F -`. Anything the author needs to know — a scope you deliberately left
off, a suspected break you could not confirm, a claim in $ARGUMENTS the diff did not
support — goes in a short note *after* the block, never inside it.
