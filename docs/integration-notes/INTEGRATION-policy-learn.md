# Integrating `policy-learn.ts`

`packages/cli/src/policy-learn.ts` and its test are new, standalone files.
Nothing in the repo imports them yet — this document is the wiring guide for
whoever does that next. Per the task constraints for this pass, **no existing
file was edited** (not `runtime.ts`, `config.ts`, `commands.ts`, nor the
permission engine in `packages/core`); everything below is a sketch of the
follow-up diff, not a diff that landed.

## What it does

`createPolicyLearner()` watches `(PermissionRequest, PermissionDecision)`
pairs and clusters them the same way the permission dialog's `suggestRule`
(`packages/cli/src/interactive/dialogs.ts`) turns one request into a rule —
it calls `suggestRule` directly rather than re-deriving the bash-prefix
widening, so `git status`, `git diff` and `git log` all land in the same
`bash git *` cluster. Once a cluster has `threshold` (default 3) *consistent*
decisions — all allow, or all deny — `suggestions()` returns a
`PolicySuggestion`. A cluster with mixed allow/deny history never suggests,
at any occurrence count: see the module's top comment and the
`"never suggests a cluster with mixed allow/deny decisions"` test.

The module never calls `persistPermissionRule` itself and has no side
effects — it only observes and suggests. That's deliberate (see below).

## 1. Where `runtime.ts` observes permission decisions

The exact spot is `ArcturnRuntime.#ask` in `packages/cli/src/runtime.ts`
(currently lines 784–793):

```ts
async #ask(request: PermissionRequest): Promise<PermissionDecision> {
  if (!this.#requester) {
    return {
      requestId: request.id,
      behavior: "deny",
      message: `Permission required for "${request.toolName}" but this session cannot prompt.`,
    };
  }
  return this.#requester(request);
}
```

This is the single funnel every permission prompt goes through — the main
turn loop (`onPermissionAsk: (request) => this.#ask(request)` at line 627,
also used when building sub-agents) and `confirmTainted` (line 654, the
taint-gated confirm) both call it. It is also where the audit observer's
sibling would go: `this.audit` is written to via `auditObserver`
(`audit.ts`) on every `AgentEvent`, but `#ask` itself is the request/decision
pair *before* it becomes two separate events — the natural place to feed a
learner that wants both halves together, without reconstructing pairs from
the `permissionRequest` / `permissionDecision` event stream afterward.

Sketch (not applied):

```ts
async #ask(request: PermissionRequest): Promise<PermissionDecision> {
  if (!this.#requester) {
    return { requestId: request.id, behavior: "deny", message: /* ... */ };
  }
  const decision = await this.#requester(request);
  this.policyLearner?.observe(request, decision);
  this.#maybeNotifySuggestion();
  return decision;
}
```

`this.policyLearner` would be an optional `PolicyLearner` constructed in
`createArcturnRuntime` (or lazily), mirroring how `this.audit` is optional and
gated on a config flag (`config.audit`) — a `config.policyLearn` (or similar)
flag would gate this the same way, defaulting to on since the module is
inert without a UI wired to act on its suggestions.

## 2. How the TUI would surface a suggestion

Two-step, matching the existing "notify, then let the user act" shape used
elsewhere in `runtime.ts` (e.g. `notify()` at line 837, used for cost-ceiling
trips and provider failovers):

1. **Notice.** After `observe()`, check `policyLearner.suggestions()`; if a
   *new* suggestion appeared (the caller diffs against what it last showed,
   since `suggestions()` is idempotent and doesn't self-track "already
   offered"), call the existing live notice channel:

   ```ts
   this.notify("info", formatSuggestion(suggestion));
   ```

   That's the same `notify()` used today — it fans out to whatever UI is
   currently subscribed, so it works whether the runtime is driving the
   interactive TUI or something else entirely.

2. **Confirm dialog.** The TUI (`packages/cli/src/interactive/app.ts`, which
   already owns `setOverlay` and drives `permissionDialog` /
   `planDialog` from `dialogs.ts`) would react to the notice by opening a new
   small confirm dialog — `policySuggestionDialog(suggestion)` alongside
   `permissionDialog`/`planDialog` in `dialogs.ts` — offering "Add rule" /
   "Not now". On "Add rule", the TUI does exactly what the "Allow always"
   choice in `permissionDialog` already does: pick a scope (project vs.
   user, reusing the same picker) and call

   ```ts
   await persistPermissionRule({ ...suggestion.rule, scope }, runtime.paths);
   ```

   `persistPermissionRule` (`config.ts`) is the only thing that ever writes a
   rule to disk — the learner hands it a ready-shaped
   `Omit<PermissionRule, "scope">` and stops there, on purpose: the human
   picks the scope and clicks confirm, same as every other rule that gets
   persisted today. Nothing about this bypasses the existing "always ask
   before persisting" path.

## 3. `/permissions suggest` command sketch

`commands.ts` already has a `permissions` command (around line 493) that
prints current rules and offers to change the mode. A `suggest` subcommand
would extend it the same way `/cost limit <usd>` extends `/cost` (see
`cost` command, ~line 566: it regex-matches `args` for a subcommand before
falling through to the default view):

```ts
{
  name: "permissions",
  description: "Show permission rules, change the mode, or: suggest",
  source: "built-in",
  async run({ ui, runtime, args }) {
    if (args.trim() === "suggest") {
      const suggestions = runtime.policyLearner?.suggestions() ?? [];
      if (suggestions.length === 0) {
        ui.print("No patterns learned yet — arcturn needs to see the same decision a few times.");
        return;
      }
      for (const suggestion of suggestions) {
        ui.print(formatSuggestion(suggestion));
        const choice = await ui.select("Add this rule?", [
          { value: "project", label: "Add to project config", data: "project" },
          { value: "user", label: "Add to user config", data: "user" },
          { value: "skip", label: "Not now", data: "skip" },
        ]);
        if (!choice || choice === "skip") continue;
        await persistPermissionRule({ ...suggestion.rule, scope: choice }, runtime.paths);
        ui.notice("info", `Rule added: ${suggestion.rule.tool} ${suggestion.rule.specifier ?? ""}`);
      }
      return;
    }
    // ...existing rules-listing / mode-picker behavior unchanged...
  },
},
```

This requires `runtime.policyLearner` to exist (part 1) and `ui.select` /
`ui.notice` / `persistPermissionRule`, all of which `commands.ts` already
imports or has access to via `runtime`.

## Design constraint, restated

`policy-learn.ts` only ever *suggests*. It cannot call
`persistPermissionRule`, does not import `config.ts`, and
`PolicyLearner.observe` has no return value that could be mistaken for an
auto-applied decision. Every path above ends at a human confirming a scope
and clicking "add rule" — exactly the same gate that already exists for
"Allow always" in the permission dialog today. A learner that silently
widened permissions from observed behavior would be indistinguishable, from
a prompt-injected tool's perspective, from a vulnerability: it is the exact
shape of "get denied a few times, then earn a standing allow rule" that an
adversarial actor would want. Suggest, never apply, is not a convenience
shortcut here — it is the whole safety property.

## Verification

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/policy-learn.test.ts   # 13 tests, all passing
npx tsc -p packages/cli/tsconfig.json --noEmit          # no errors from policy-learn.ts
                                                          # (two pre-existing errors in
                                                          # cost-preview.ts / vcr.ts are
                                                          # unrelated to this change)
npx biome check packages/cli/src/policy-learn.ts packages/cli/src/policy-learn.test.ts
```
