# The Arcturn registry

This directory **is** the registry. One JSON file per listed asset, no
database, no backend, no upload endpoint. The hub at
[arcturn.dev/hub](https://arcturn.dev/hub) is a build-time render of exactly
these files, and the same build exports them as one JSON document,
[`https://arcturn.dev/hub/index.json`](https://arcturn.dev/hub/index.json),
which is what `arcturn search` reads and what `arcturn add <name>` resolves a
bare name through — the file is the API (RFC 0002, *Discovery: the hub at
arcturn.dev*). Listing a package is therefore a pull request here and a site
deploy; no CLI release is involved.

Listing is a pull request. That is the moderation model, and this README is
where it is stated plainly rather than implied.

---

## Why an entry exists at all

Installing a package means handing it your skills root, your agent roles, your
workflows — and, if it carries `extensions/`, arbitrary code execution. The CLI
already refuses to guess on your behalf: executable code fails closed behind a
confirmation that names the files, and declining installs nothing.

An entry's job is to let you make that decision **before** you type the install
command. Everything in `disclosure` is a claim about what the package would add
to your machine, written in the same vocabulary `arcturn inspect` prints:
derived lanes, declared tools, stage counts, budgets, executable files. The hub
page and the install are not allowed to describe two different packages.

## Schema

```jsonc
{
  "name": "enterprise-org",              // required — must equal the filename stem
  "kinds": ["org-kit", "agents"],        // required — one or more, see below
  "source": "owner/repo/subdir",         // required — a source the CLI accepts
  "ref": "v1.2.0",                       // optional — a tag, branch or commit to pin
  "description": "One sentence.",        // required — one sentence, no marketing
  "maintainer": { "name": "…", "url": "https://…" },   // required
  "disclosure": {                        // required
    "agents":    [{ "name": "…", "lane": "read|exec|write", "tools": ["…"] }],
    "workflows": [{ "name": "…", "stages": 4, "budgetUsd": 15 }],
    "skills":    [{ "name": "…", "line": "…" }],
    "mcp":       [{ "name": "…", "transport": "stdio|http|sse" }],
    "executable": false                  // required — true if the package ships extensions/
  }
}
```

### `kinds`

The asset taxonomy, in the order the hub renders badges:

| Kind | What it is | Installs into |
|---|---|---|
| `skills` | markdown + frontmatter | `~/.arcturn/skills/` |
| `agents` | role markdown; `tools:` decides its lane | `~/.arcturn/agents/` |
| `workflows` | numbered-markdown pipelines | `~/.arcturn/workflows/` |
| `org-kit` | agents and workflows meant to be used together | both roots |
| `mcp` | an `mcp.json` servers block | merged into `~/.arcturn/mcp.json` |
| `themes` | JSON | `~/.arcturn/themes/` |
| `extensions` | **JS/TS modules — arbitrary code execution** | `~/.arcturn/extensions/`, confirm-gated |

An `org-kit` also lists `agents` and `workflows`: `org-kit` says how the pieces
are meant to be used, the other two say what actually lands.

### `source`

Exactly what a person will type after `arcturn add`, so the command on the hub
page is copy-pasteable rather than a reconstruction. The resolver accepts a git
URL, a GitHub `owner/repo[/subdir][@ref]` shorthand, or a local path; hub
entries use the shorthand, because a listing has to be fetchable by anyone.
The CLI holds the hub to that: an index entry whose `source` is anything but
the shorthand — a local path, a git URL — is refused as malformed, whole, so a
bare name can never resolve to somewhere a listing is not allowed to point.

### `ref`

Optional. A tag, branch or commit — no whitespace, no `/`, no `@`, no leading
`-` — that the listing pins. When present, the CLI installs `source@ref`: the
command on the hub page carries it, and so does `arcturn add <name>`, so a
listing that vouched for one commit cannot quietly install another. Omit it to
install the source's default branch, exactly as typing the source would. A
`source` may spell the pin itself (`owner/repo/subdir@v1`); it may not do both.

### The index

`https://arcturn.dev/hub/index.json` is `{ "v": 1, "generatedAt": "<ISO>",
"entries": [ …every entry above, validated… ] }`, written by the site build
from this directory. The CLI reads it over https, treats every field as data —
`source` goes through the same resolver, the same executable-code confirmation
and the same `--yes` semantics as a typed source — and rejects the whole file
on any deviation from that shape. `ARCTURN_HUB_URL` points a CLI at another
copy (plain http only on localhost, for a local `next build`).

### `disclosure`

Every sub-block is optional **except `executable`**, which is required and is a
boolean — "we didn't say" and "no executable code" must not look the same on a
page a person reads before granting code execution.

- **`agents[].lane`** is derived from `tools`, never declared by hand:
  `write`/`edit`/`multiedit` → `write`; otherwise `bash` → `exec`; otherwise
  `read`. It is the same rule `roleDispatch` applies in
  `packages/cli/src/workflow.ts`, and `web/scripts/hub.test.ts` re-derives it
  from that file's own tool sets. A lane typed by wishful thinking fails the
  suite.
- **`workflows[].stages`** is the count of numbered lines in the pipeline file
  (a parallel stage is one stage, however many branches it has).
  **`budgetUsd`** is the file's own `budgetUsd:` frontmatter — omit it when the
  workflow declares none rather than writing `0`, which means something else.
- **`skills[].line`** is the skill's first description line, post-sanitisation.
  It is optional, and omitted is honest: `starter-skills` was listed before its
  files existed, and a hand-typed line the package could contradict is worse
  than no line at all. The hub says so on the page.

## Listing a package

1. Publish the package somewhere `arcturn add` can reach — a public git repo,
   optionally a subdirectory of one.
2. Add `registry/<name>.json` here, following the schema above.
3. Run `npx vitest run web/scripts/hub.test.ts`. For a first-party entry (one
   pointing into this repository) the suite checks your disclosure against the
   real files and fails on drift.
4. Open a pull request. Expect questions about anything in `disclosure` that
   the tree does not support, and about `executable: true` in particular.
5. Once the site deploys, `arcturn search <word>` finds the entry and
   `arcturn add <name>` installs it. Nothing about the CLI changes.

## The curation stance, and its honest gap

Curation is a human reading a diff. It is not a security guarantee, and this
repository does not pretend otherwise:

- **Third-party disclosure is unverified by machine.** The test suite can only
  check entries whose tree is on this disk — the first-party ones. For anyone
  else's package, the disclosure block is the maintainer's claim, checked by a
  reviewer reading the source at listing time and never again automatically.
  `arcturn inspect <source>` re-derives the same table from the code that would
  actually be installed; run it, and trust that over this page.
- **A listing is not an audit.** Being here means someone read it once and
  thought it was what it said it was.
- **Nothing here auto-updates.** A package that changes under you is the
  supply-chain failure mode, not a convenience. `arcturn update` is a command a
  person runs.
- **The extensions gate is not relaxed for listed packages.** Hub-listed or
  not, executable code confirms per install, and a non-TTY install of it fails
  closed.

Small on purpose. Two honest entries beat ten padded ones, and the day this
model saturates is the day it earns replacing — not before.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../LICENSE). © 2026 Sitharaj Seenivasan.
