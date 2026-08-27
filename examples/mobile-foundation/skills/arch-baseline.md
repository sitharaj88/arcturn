---
name: arch-baseline
description: Map the architecture this mobile repository actually has, then propose a baseline against it — with the cost of each proposal named.
---

Map what `$CWD` actually is, then propose a baseline for it. In that order,
and the second half is worthless without the first.

**Describe before prescribing.** Read the tree and report, each with a
representative `path:line`: how it is layered, where state lives and how it
flows, how navigation is expressed, what dependency injection is in use, what
the module graph is, and how the UI is written. If there is no consistent
pattern, say that — an inconsistent codebase is a finding, and it is more
useful than a pattern name chosen to fill the field.

**Then propose, against this tree.** For every proposal:

1. Name the problem **in this repository** it solves, with the `path:line`
   where that problem shows.
2. Name what it costs — files touched, what stops compiling, what has to be
   migrated in one go versus incrementally.
3. Say what happens if it is not done.

A proposal with no named cost has not been thought about, and a proposal with
no `path:line` is a template rather than a reading. Where the repository
already does something consistently and it works, the baseline **records** it
rather than replacing it: nobody is served by migrating a working app to a
different state-management library because it is the current fashion.

The choices worth being explicit about, when the tree gives you cause:
unidirectional state flow and a single source of truth per screen; navigation
declared in one place rather than scattered across call sites; dependency
injection at the composition root rather than singletons reached from
anywhere; module boundaries that compile independently; and a rendering layer
that does not know about the network. Each is a real improvement to some
codebases and an expensive rewrite in others. Which one it is here is a fact
about this repository, not a preference.

**Two registers, never blended.** Anything traceable to a `path:line` is a
finding and carries the citation inline. Everything else goes under
`Assumed — unconfirmed` with the check that would settle it. There is no third
register, and an unevidenced recommendation sitting in the prose reads exactly
like a finding to the person who has to act on it.

End with `Open — owner needed`: the decisions this reading cannot make,
who would make each, and what becomes hard to reverse once they do.

Focus: $ARGUMENTS
