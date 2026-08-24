# RFC 0002 — The Arcturn ecosystem

**Status:** Phase 1 in progress · **Author:** Sitharaj Seenivasan · **Date:** 2026-08-24

Arcturn ships as one binary, but the things that make it useful in a
particular team are content, not code: the skills a team reaches for, the
agent roles it trusts, the workflows it runs, the MCP servers it connects,
the themes it looks at. Today that content is copy-paste folklore. This RFC
turns it into an **ecosystem**: assets that are packaged, discoverable on
arcturn.dev, installable in one command, and inspectable before they touch
anything.

## What already exists (and is kept)

The registry (`packages/cli/src/registry.ts`) already installs **packages**
— a directory, usually a git repo — carrying any mix of `skills/`,
`extensions/`, `themes/`, and `mcp.json`, from three source shapes: a git
URL, a GitHub `owner/repo[/subdir][@ref]` shorthand, or a local path.
Installs are staged, the resolved commit is pinned in
`.arcturn-install.json`, names are traversal-proofed, git is spawned
argv-style with ref-injection guards, and **executable code fails closed**:
a package with `extensions/` links nothing until a per-install confirmation
names the files, and declining installs nothing at all.

That security model is the ecosystem's foundation, not an obstacle to it.
Nothing below weakens it.

## The asset taxonomy

| Asset | Format | Risk class | Installs into |
|---|---|---|---|
| Skill | markdown + frontmatter | prompt-injection surface | `~/.arcturn/skills/` |
| Agent role | markdown + frontmatter (`tools:` decides its lane) | capability surface | `~/.arcturn/agents/` |
| Workflow | numbered-markdown pipeline | orchestration (spends money) | `~/.arcturn/workflows/` |
| Org kit | agents + workflows together | both of the above | both roots |
| MCP config | `mcp.json` servers block | remote capability surface | merged into `~/.arcturn/mcp.json` |
| Theme | JSON | none | `~/.arcturn/themes/` |
| Extension | JS/TS module | **arbitrary code execution** | `~/.arcturn/extensions/`, confirm-gated |

Phase 1 closes the taxonomy gap: packages learn `agents/` and `workflows/`
(and therefore org kits), with the same convention-plus-manifest detection
the existing kinds use.

## Discovery: the hub at arcturn.dev

A static site can host a first-class catalog without a backend:

- A top-level `registry/` directory in this repo holds one JSON entry per
  listed asset — name, kinds, source (GitHub shorthand), description,
  maintainer, and the **disclosure block** (see below). Listing is by pull
  request; curation is the moderation model, exactly as it is for module
  registries' early days, and honest about being that.
- The site builds `/hub` from those entries at export time: category pages,
  an asset page per entry with its README, the one-line install command, and
  the disclosure table. Client-side filtering; no server.
- The CLI can later read the same generated `index.json` for
  `arcturn search` — the file is the API.

## Disclosure before trust

The install command's counterpart is `arcturn inspect <source>`: stage the
package exactly as an install would (same resolver, same pinning), link
nothing, and print what it WOULD add —

- each agent role with its **derived lane** and tool list (the same
  `roleDispatch` the engine uses — what it can touch, not what it claims),
- each workflow with its stage count, `budgetUsd`, and any `@role` deps,
- each skill's name and first description line (post-sanitisation),
- any `mcp.json` servers (name + transport + URL),
- any executable extension files, loudly.

The hub renders the same table from the same code path via the entry's
disclosure block, so the page a person reads and the install they run cannot
describe two different packages. This is the provider-table discipline
("verified live" vs "implemented") applied to third-party content: **show
the receipts, then ask for the decision.**

## Authoring

`arcturn new skill|agent|workflow <name>` scaffolds a valid file with the
frontmatter the parsers actually require, into the project or user root.
`arcturn add ./my-pack` already installs a local directory, so the author
loop is: scaffold → edit → `arcturn inspect .` → `arcturn add .` → iterate —
no publish step required to use your own work. Publishing to the hub is a PR
adding a `registry/` entry pointing at your repo.

## Phases

1. **Now:** packages carry agents/workflows/org kits; top-level
   `arcturn add|remove|packages|update|inspect|new` (the registry verbs leave
   the TUI and reach the shell/CI); the hub on arcturn.dev seeded with
   first-party assets (the enterprise-org kit foremost); a docs page for the
   package format and its security model.
2. **Next:** `arcturn search` against the hub index; `update` surfacing
   upstream diffs before relinking; signed entries (provenance for packages,
   as npm provenance is for the binaries); counts-and-health on hub pages
   generated, never hand-typed.
3. **Later, if earned:** community namespaces, install counts, an org-kit
   composition tool ("start from enterprise-org, swap the security
   reviewer"). Not before real third-party packages exist.

## Deliberately not doing

- **No hosted backend, no accounts, no upload endpoint.** The repo is the
  registry of record; a static index is the API. Revisit only when PR-based
  curation actually saturates.
- **No auto-update.** `update` is a command a person runs; a package that
  changes under you is the supply-chain failure mode, not a convenience.
- **No relaxation of the extensions gate** — hub-listed or not, executable
  code confirms per install, and non-TTY installs of it fail closed.
