---
title: LSP diagnostics
description: Language-server diagnostics appended to write and edit results, for the languages you already have tooling for.
section: Core concepts
order: 4.6
---

## Turning it on

Set `lsp` to `"on"` in `.arcturn/config.json` (default `"off"` — zero behavior change until
you opt in):

```json
{ "lsp": "on" }
```

There is no `--lsp` command-line flag; it's config-only. See
[Configuration](/docs/configuration#config-key-reference) for where this key sits among
the rest.

## Supported servers

Arcturn doesn't bundle any language server — it spawns whichever binary is already on
`PATH`, keyed by file extension:

| Extensions | Server command |
|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | `typescript-language-server --stdio` |
| `.py` | `pyright-langserver --stdio` |
| `.go` | `gopls` |
| `.rs` | `rust-analyzer` |

If the binary for an extension isn't installed (or, more precisely, not resolvable on
`PATH`), that extension's diagnostics are silently unavailable — never a hard failure.
Install whichever ones you need:

```bash
npm install -g typescript-language-server typescript
pip install pyright
go install golang.org/x/tools/gopls@latest
rustup component add rust-analyzer
```

Binary lookups are cached per process, so the first `write`/`edit` to a given language pays
the `PATH` scan once.

## When diagnostics fire

Only `write` and `edit` are wrapped — every other tool passes through unchanged. After a
call to either succeeds (an error result skips the diagnostics step entirely), Arcturn:

1. Reads the file back from disk.
2. Opens (or updates) it with the matching language server, keyed by extension.
3. Waits up to a per-file diagnostics budget — **3 seconds by default**, overridable per
   call site — for `publishDiagnostics` notifications to arrive.
4. Appends whatever arrived to the tool result, under an `lsp diagnostics:` header.

```text
lsp diagnostics:
src/agent.ts:12:5 error: Cannot find name 'foo'.
src/agent.ts:20:1 warning: 'bar' is declared but never used.
```

Output is one-based (line:column), formatted `path:line:col severity: message`, and capped
at **10 lines**, collapsing anything past that into a trailing `… N more`. A server stays
alive across edits to the same working directory — it's opened once via the LSP
`initialize`/`initialized` handshake and `textDocument/didOpen`, then sent
`textDocument/didChange` notifications on every subsequent edit, not respawned per call —
so the second edit to a file is fast even though the first paid the server's startup cost.

This never turns a successful `write`/`edit` into a failure: a missing server, a spawn
failure, a malformed response, or a timeout is swallowed — `diagnosticsFor` returns `null`
rather than throwing — and the original tool result is returned unchanged. Worst case, it
adds the diagnostics timeout's worth of latency to the call.

## Symbols

The same `lsp: "on"` gate also turns on a `symbols` tool: a structural map of code via the
language servers Arcturn already spawns for diagnostics, rather than a grep-based guess at
where a class or function lives.

Provide exactly one of:

- `file` — document symbols for one file (classes, functions, methods, variables, ...),
  via `textDocument/documentSymbol`.
- `query` — a workspace-wide symbol search by name (or substring), via `workspace/symbol`,
  fanned out to every language server already spawned this session.

```text
class Foo  src/agent.ts:12
method bar  src/agent.ts:20
function helper  src/agent.ts:40
```

Output is compact `kind name  path:line` lines, one-based, capped at **50 entries**,
collapsing anything past that into a trailing `… N more`.

A few behaviors worth knowing:

- `textDocument/documentSymbol` can come back from a server as either a hierarchical
  `DocumentSymbol[]` (with nested `children`) or a flat `SymbolInformation[]` — both shapes
  are handled, and a hierarchical response is flattened before rendering.
- A workspace-wide `query` only reaches servers already spawned this session (i.e. some
  file of that language has already been opened via diagnostics or a prior `file` lookup).
  It never spawns a new server on its own, so the very first symbol search after startup
  may only cover the languages already touched.
- Like diagnostics, this is read-only and fails closed: no server for the relevant
  language, a spawn failure, or a timeout all resolve to a friendly "no language server
  available" message rather than an error — never a hard failure.
- `file` and `query` are mutually exclusive; providing both, or neither, is an error result.

## Under the hood

The LSP client is a small, hand-rolled JSON-RPC implementation — no LSP SDK dependency.
It speaks only what this feature needs: the `initialize`/`initialized` handshake,
`textDocument/didOpen` / `textDocument/didChange`, collecting `publishDiagnostics`, and a
`shutdown`/`exit` teardown on process exit. Message framing
(`Content-Length: <n>\r\n\r\n<body>`) is parsed and written by hand rather than pulled in
from a library.

One `LspManager` is created per working directory and lazily spawns one client per
language as files in that language are touched — a session editing both `.ts` and `.py`
files runs two server processes, not one per file.

## Interaction with the verify loop

LSP diagnostics and the `verify` config key (see
[Configuration](/docs/configuration#verify)) both hook the same two tools — `write` and
`edit` — and append their findings to the result the model sees, but they're independent
and can be combined:

- `lsp` gives fast, incremental, single-file feedback straight from a running language
  server — no process spawn beyond the server itself.
- `verify` runs a project-level command (`pnpm typecheck`, `pnpm test`, a linter) after an
  edit, which catches cross-file breakage an LSP diagnostic on one file can't see, at the
  cost of actually running that command on every matching edit.

Both are additive to the same tool result and both fail closed: a broken verify command or
an unreachable language server degrades to "no extra feedback," never to a failed
`write`/`edit`.
