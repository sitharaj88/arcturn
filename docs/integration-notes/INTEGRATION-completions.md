# Wiring `arcturn completions` into Arcturn

This is a recipe, not a patch. `packages/cli/src/completions.ts` and its test
are the only files this work added; `args.ts` and `main.ts` are untouched. It
documents exactly where and how a follow-up change should wire the
`completions` subcommand into the real CLI.

## What `completions.ts` provides

```ts
import {
  COMPLETION_SHELLS,           // readonly ["bash", "zsh", "fish"]
  DEFAULT_COMPLETION_SPEC,      // the flag/subcommand table, kept in sync with args.ts by hand
  generateCompletions,          // (shell: string, spec = DEFAULT_COMPLETION_SPEC) => string
  isCompletionShell,            // (value: string) => value is CompletionShell
  UnknownCompletionShellError,  // thrown by generateCompletions for any other shell string
} from "./completions.js";

generateCompletions("bash");  // -> full bash script, throws UnknownCompletionShellError for e.g. "powershell"
```

`generateCompletions` takes a plain `string` (not the narrower
`CompletionShell` type) precisely so a raw `argv` word can be handed to it
directly without the caller pre-validating — invalid input becomes the typed
error instead of a type error, which is what `main.ts` wants to catch and
turn into the same tidy usage-error exit path used elsewhere.

`completions.ts` has no imports from `args.ts`, `config.ts` or anywhere else
in the package — `DEFAULT_COMPLETION_SPEC` is a hand-written table that
mirrors the real flag list. **This is the one thing a follow-up must keep
doing by hand**: any future edit to `VALUE_FLAGS`, the flag `case`s in
`parseArgs`, or `AUTH_ACTIONS` in `args.ts` needs a matching edit to the
`flags`/`subcommands` arrays in `DEFAULT_COMPLETION_SPEC`
(`packages/cli/src/completions.ts`). `completions.test.ts` only checks the
table against itself, so it cannot catch drift — it is not a substitute for
remembering to update the table.

## 1. `args.ts`: a new positional command family

`args.ts` already has one positional command family, `auth`
(`AUTH_COMMAND_NAME`, `AuthCommand`, `parseAuthCommand`). `completions` should
become a second one, following the same shape:

```ts
// Alongside AuthCommand's definition:
export interface CompletionsCommand {
  readonly kind: "completions";
  /** Raw word from argv; validated later by generateCompletions(), not here. */
  readonly shell: string;
}

// Widen the union:
export type CliCommand = AuthCommand | CompletionsCommand;

// Alongside AUTH_COMMAND_NAME:
export const COMPLETIONS_COMMAND_NAME = "completions";
```

Deliberately *not* validating `shell` against `CompletionShell` here: `args.ts`
has no dependency on `completions.ts` today, and adding one just to duplicate
the three-shell check would create two places that must agree on what a valid
shell is. Parsing stays permissive (`shell: string`), and `main.ts` (§2) is
where `generateCompletions()` — the single source of truth for valid shells —
gets the first and only chance to reject a bad one.

In `parseArgs`, right after the existing block that turns `auth …` positionals
into a command (`packages/cli/src/args.ts`, the `if (positional[0] ===
AUTH_COMMAND_NAME && commandCandidates > 0)` block), add a sibling:

```ts
if (positional[0] === COMPLETIONS_COMMAND_NAME && commandCandidates > 0) {
  const shell = positional[1];
  if (shell === undefined || commandCandidates !== 2) {
    return {
      ok: false,
      error: `completions needs exactly one shell: ${COMPLETION_SHELLS.join(", ")}`,
    };
  }
  args.command = { kind: "completions", shell };
  args.prompt = "";
  return { ok: true, args };
}
```

This needs `COMPLETION_SHELLS` imported from `./completions.js` purely for the
error message's list of names (`bash, zsh, fish`) — it does not need
`generateCompletions` or `isCompletionShell` here, since the real shell check
still happens in `main.ts`. If pulling in `completions.ts` from `args.ts` is
undesirable, the three names can instead be hard-coded in the error string;
either way, `commandCandidates !== 2` is what rejects `arcturn completions` (no
shell) and `arcturn completions bash extra` (too many words) before `main.ts` ever
sees them.

Note the existing `auth` branch checks `commandCandidates > 0`, not `=== N`,
because `auth status` (2 words) and `auth login <provider>` (3 words) are both
valid. `completions` always takes exactly one word, so the check above is
stricter on purpose.

### Help text

Add one line to the `Commands` section of `helpText()`
(`packages/cli/src/args.ts`), next to the three `auth …` lines:

```
  completions <bash|zsh|fish>   Print a shell completion script.
```

## 2. `main.ts`: dispatch and error handling

`main.ts` already special-cases `args.command?.kind === "auth"` right before
the `try { buildRuntime(...) }` block (`packages/cli/src/main.ts`, lines
87–92). Add a sibling branch there, importing `generateCompletions` and
`UnknownCompletionShellError` from `./completions.js`:

```ts
if (args.command?.kind === "completions") {
  try {
    process.stdout.write(generateCompletions(args.command.shell));
    return 0;
  } catch (error) {
    if (error instanceof UnknownCompletionShellError) {
      process.stderr.write(`arcturn: ${error.message}\n\nRun "arcturn --help" for usage.\n`);
      return 2;
    }
    throw error;
  }
}
```

Placed before the `buildRuntime()` call (same as `auth`), so `arcturn completions
bash` never touches config loading, extension loading, or model resolution —
it is a pure, synchronous, dependency-free print, same as `--help`/`--version`.
Exit code `2` on an unknown shell matches every other "bad CLI input" path in
`main.ts`/`parseArgs` (see the `!parsed.ok` branch at the top of `main()`);
`0` on success matches `--help`/`--version`/`--list-models`.

No other file needs to change: `buildRuntime`, `runAuthCommand`,
`runInteractive` and `runPrint` are all still reached exactly as before for
every other command shape, since this branch returns before any of them run.

## 3. Manual smoke test after wiring

```sh
arcturn completions bash | bash -n   # should exit 0
arcturn completions zsh  | zsh -n    # should exit 0
arcturn completions fish             # eyeball; skip -n check if fish isn't installed
arcturn completions powershell       # should print "arcturn: Unknown completion shell ..." to stderr, exit 2
arcturn completions                  # should print the "needs exactly one shell" error, exit 2
```

## Summary of the follow-up work (not done here)

1. `args.ts`: add `CompletionsCommand`, widen `CliCommand`, add
   `COMPLETIONS_COMMAND_NAME`, add the `completions …` branch in `parseArgs`
   (mirroring the existing `auth` branch), add one `Commands` line to
   `helpText()`.
2. `main.ts`: import `generateCompletions`/`UnknownCompletionShellError` from
   `./completions.js`; add the `args.command?.kind === "completions"` branch
   before the `buildRuntime()` try block, alongside the existing `"auth"`
   branch.
3. Whenever a flag is added to, removed from, or changed in `args.ts`'s
   `VALUE_FLAGS`/`parseArgs` switch, or a new `auth` action is added to
   `AUTH_ACTIONS`: make the matching edit to `DEFAULT_COMPLETION_SPEC` in
   `packages/cli/src/completions.ts` by hand. Nothing enforces this
   automatically today.
