---
name: scaffold-run
description: Stand a project up with the ecosystem's own generator, and report what actually landed. Never hand-writes a file a generator produces.
---

Stand up `$ARGUMENTS` in `$CWD` using the tool the ecosystem already ships for
it. `$SKILL_DIR/generators.md` carries the generator per stack and what each
one leaves you to decide.

## The one rule

**Never hand-write a file a generator produces.**

A `package.json`, `tsconfig.json`, `vite.config.ts` or `pubspec.yaml` written
from memory is the characteristic failure of an agent standing up a project. It
looks right. It carries versions that were current a year ago, flags that were
renamed, and a config shape the current tool no longer reads — and it fails at
the first install with an error nobody traces back to its cause, precisely
because the file looks hand-checked.

The generator is a program that is correct by construction and maintained by
the people who own the format. Run it.

## And never recall a flag

Ask the generator before you use it:

```
npm create vite@latest --help
npx create-next-app@latest --help
npx create-expo-app@latest --help
flutter create --help
```

Paste what `--help` printed, then run the command you built from it. A
remembered flag is a guess with a command prompt in front of it.

**If the generator cannot be reached** — no network, a registry that refuses —
say so and stop. Do not fall back to writing the files yourself: that is this
command's one prohibition, reached through the back door.

## Then report what landed, not what you asked for

- The generator command verbatim, and its real exit code
- The dependency versions it **resolved**, read from the lockfile — not from
  the manifest's ranges
- The scripts it defined, read from the manifest
- `npm install`, then the build, then the test script if one exists — each with
  its command and real exit code
- Anything it created that the brief did not ask for

**A generator that succeeded and produced a project that does not build is a
finding, not a success**, and it belongs on line one.

## Add no architecture

No folder scheme, no state library, no barrel files, no extra lint rules.
`/architecture-apply` does that against what is really here, and it can only do
it honestly if you have not already guessed at it.

End with the top two levels of the tree, the resolved versions, and
`BUILDS: yes | no | unproven` with the command behind it.

Target: $ARGUMENTS
