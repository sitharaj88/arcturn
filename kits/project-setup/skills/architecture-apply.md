---
name: architecture-apply
description: Add the layering a generator leaves out — boundaries, a composition root, a real test — on top of the tree that actually exists.
---

Add the architecture `$CWD` is missing, for `$ARGUMENTS`.

**Read the tree first, and keep what is already there.** Generators differ and
change between versions; the one that ran is the one you are extending. A
folder scheme applied over a layout that is not there leaves two architectures
in one repository, which is worse than the one the generator shipped with.

Where the generator already decided — a router convention, a test runner, a
path alias — **keep it**. A second way to do the same thing is the most common
way an agent makes a clean project worse.

## What earns its place

Each of these only if the tree or the brief gives you cause, and each with its
cost named:

- **A boundary with a direction.** UI may import domain; domain may not import
  UI. Two or three real layers beat seven named after a blog post — and seven
  is what you get when the layers were chosen before the code existed.
- **A composition root.** One place the app is wired, so a test can wire it
  differently. This is what makes everything else testable and it is the piece
  most often missing.
- **One real test** through the generator's own runner, exercising something,
  so the suite exists from the first commit rather than arriving when it is
  inconvenient.
- **A typed edge.** Whatever crosses a boundary — an HTTP response, a form, a
  route param — validated where it enters, not trusted inward.

## Write the rule as a check, not a paragraph

A README section saying "components must not import from pages" is a rule
nobody can enforce. `dependency-cruiser` for a JS or TS tree makes it a
command; `design-docs`' `/fitness-function` carries recipes for five other
ecosystems. Wire it into the project's own scripts so it runs where the tests
run.

**A rule nobody can violate by accident is worth more than a document everybody
agrees with.**

## Do not claim it works

Writing the config is not proving it bites. A glob matching no file, a severity
left at `warn`, an unresolved path alias — each passes forever. Name the
command that would prove it and run `/boundary-prove` for the answer.

## Report in two registers

What you added, with the file for each. And what you **deliberately did not
add**, with the reason — that second list is the more useful one, because a
reader deciding whether to keep your layering needs to know what you considered
and declined.

End with `Open — owner needed` for anything the brief did not settle.

Scope: $ARGUMENTS
