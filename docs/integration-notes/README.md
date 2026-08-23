# Integration notes

Design and wiring notes written while the 2026-08-18 feature wave was built:
hooks, checkpoints, `@`-mentions, skills, web search, the bash sandbox, LSP
diagnostics, the live model catalog, transcript export, custom themes, git
status and shell completions.

Each note was authored by the agent that built its feature, *before* the
feature was wired into the shared files (`runtime.ts`, `commands.ts`,
`config.ts`, `interactive/app.ts`). They record the reasoning behind each
seam — why checkpoints wrap per agent rather than once, why the sandbox is
foreground-only, which `@`-mention sources are pluggable — which the code's
TSDoc states but does not argue.

**These are history, not instructions.** Every feature described here is
integrated; the wiring recipes have been applied and in places superseded by
what the adversarial review pass changed afterwards (see `PLAN.md`). For how
the features behave today, read the user documentation under
`website/src/content/docs/` and the TSDoc on the modules themselves.
