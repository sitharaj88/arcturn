---
name: app-setup
description: Choose a stack with its costs named, stand it up with the ecosystem's own generator, add the layering a generator leaves out, and prove the boundary check actually fails on a violation.
continueOnError: false
budgetUsd: 20
stepTimeoutMs: 2400000
---
Run it as `/workflow app-setup <what you are building, for whom, and the one
constraint you actually care about>`.

The premise: an agent standing up a project should run the tool the ecosystem
already ships for it, not imitate one. A `package.json` written from memory
carries versions that were current a year ago and flags that were renamed, and
it fails at the first install with an error nobody traces back to its cause —
because the file looks hand-checked. So stage 2 runs the real generator, and
the rule that it must never hand-write what a generator produces is written
into the role rather than hoped for.

Stage 1 cannot write and cannot run, which is deliberate: it is the stage that
has an opinion, and an opinion costs nothing to correct before a generator has
touched the disk. It ends at a person whenever two stacks are genuinely
defensible, because that choice is cheap to ask about now and expensive to
revisit once `node_modules` exists.

Stage 2 holds `bash` and `write` together, which is the only role in this kit
that does. That combination is the write lane — a worktree whose patch is
applied — and it is what lets a generator's output survive. An exec-lane role
could run the generator and its work would be discarded unread.

Stage 3 has no shell on purpose. It adds layering and writes the boundary rule
as a check, and it structurally cannot tell you the check works. Stage 4 is a
different role with a shell and no writer, and it decides that by planting a
violation. The one thing this kit is built to prevent is a stage certifying its
own architecture.

1. @stack-advisor Decide what this should be built with. Read the tree for anything that already answers it — .tool-versions, .nvmrc, engines, a lockfile, a CI workflow, an existing app — and report what you found with a path:line, marking anything you could not establish UNKNOWN with the command that would settle it. Give the stack as a list of named choices, and for every one name what it buys, what it costs and what it forecloses; a recommendation carrying only benefits has not been made. Where the brief names an acronym rather than a decision, take it apart — MERN is four choices and three of them are usually habit — or say plainly that you are honouring the acronym as asked. End with the exact generator command stage 2 should run. Then, only if two stacks are genuinely defensible on this evidence, emit exactly one ORG-ASK line carrying the whole question with its options and their costs on that single line; if the brief settles it, say so and continue rather than pausing for the sake of a gate. Brief: {{input}}
2. @scaffolder If the recommendation below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise stand the project up by running the ecosystem's own generator. Ask each generator for its flags before you use them — run its --help and paste what it said — because a remembered flag is a guess with a command prompt in front of it. Then run the command and record its real exit code. Never hand-write a file a generator produces: a package.json, tsconfig, vite.config or pubspec written from memory is the characteristic failure here, and if the generator cannot be reached you stop and say so rather than writing the files yourself. Afterwards report what actually landed rather than what you asked for: the resolved dependency versions read from the lockfile, the scripts read from the manifest, and whether install, build and test each succeeded with their commands and real exit codes. Add no architecture — no folder scheme, no state library, no extra lint rules — because stage 3 must work against what is really here. End with the top two levels of the tree and BUILDS: yes, no or unproven. Plan: {{prev}}
3. @architecture-author If the report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise read the tree the generator actually produced and add what it deliberately left out. Keep every decision the generator already made — its router convention, its test runner, its path aliases — because a second way to do the same thing is how a clean project gets worse. Add only what the brief or the tree gives you cause for, and name what each costs: a boundary with a direction rather than seven layers named after a blog post, one composition root so a test can wire the app differently, one real test through the generator's own runner, and validation where untrusted data crosses an edge rather than inward of it. Then write the layering rule as a machine-checkable config — dependency-cruiser for a JS or TS tree, and design-docs' fitness-function skill carries recipes for five other ecosystems — and wire it into the project's own scripts. You have no shell, so run nothing and claim nothing passes: name the command that would verify it and leave that to stage 4. End with the files you wrote, what you deliberately did not add and why, and Open — owner needed. Tree: {{prev}} Brief: {{input}}
4. @boundary-oracle If the report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise decide whether the architecture check actually fails when the rule is broken. For every rule the config declares, not just the first: run the check exactly as the project defines it and record the command and exit code, plant the smallest violation that rule names — the one import, in a real file — paste the diff, run the identical command again, record the exit code, restore and confirm the baseline returned. Report BITES, TOOTHLESS or NO-ORACLE per rule with both exit codes, and never "configured": a glob matching no file, a severity left at warn, an unresolved path alias and a script no test command invokes all pass forever while the architecture rots. Then say where the check is actually invoked from, read from the manifest or the CI workflow, and say plainly when the answer is nowhere. Repair nothing. End with BITES, TOOTHLESS, NO-ORACLE and RULES counts. Architecture: {{prev}}
