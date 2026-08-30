# Arcturn — Website Design Specification

> **Status:** normative. This file is the single source of truth for the new site in `web/`.
> Four build agents implement it in parallel without talking to each other, so every value
> here is exact on purpose. If something is genuinely missing, pick the option most
> consistent with the rest of this document and note it in your return — do not invent a
> second design language.

**Scope of the site:** `web/` only. Never touch `packages/**`, `website/**` (the old Astro
site, reference only), or any lockfile / workspace file. Do not install packages.

**Build constraints you must honour**

| Constraint | Consequence |
|---|---|
| `output: "export"` | No route handlers, no server actions, no `cookies()`/`headers()`, no dynamic server APIs, no ISR. Every dynamic route needs `generateStaticParams()`. |
| `trailingSlash: true` | Write internal `href`s **without** a trailing slash (`/docs/mcp`); Next emits the trailing-slash URL. Never hand-write `/docs/mcp/`. |
| `images.unoptimized` | Use `next/image` with explicit `width`/`height`, or plain `<img>`. No loaders, no remote images. |
| Tailwind v4, CSS-first | All tokens live in `web/app/globals.css` under `@theme`. **There is no `tailwind.config.js` and you must not create one.** |
| Next 16 async params | `const { slug } = await params;` in every page/layout that takes `params` or `searchParams`. |
| TS strict, no `any` | Named exports everywhere. Doc comments on non-obvious modules. |

**Verification gate (both must pass before anyone reports done):**

```bash
npx next build && npx tsc --noEmit
```

---

## 0. Truth rules (read before writing a single word of copy)

Arcturn is a real, pre-1.0, single-maintainer project with no users yet. False claims are
the one unrecoverable failure mode for this site.

1. **No invented metrics, benchmarks, testimonials, customer logos, user counts, stars,
   "trusted by", or "10x faster".** None. Not as placeholder, not as lorem.
2. **No counts baked into marketing copy.** Test counts, package counts and doc counts
   drift with every commit (they already drifted away from the numbers in
   `content/blog/why-arcturn.md`). Where the site wants to establish evidence it shows the
   **command the reader can run**, not the number. The single exception is `/open-source`,
   which may print counts *only* alongside the command that produces them and dated
   "as of" framing — see §3.10.
3. **Every capability claim must trace to** `README.md`, `web/content/docs/*.md`, or
   `web/content/blog/why-arcturn.md`. If you cannot point at the sentence, cut the claim.
4. **Limitations are content, not fine print.** The `/security` limits table and the
   `/open-source` status table are required sections and must not be softened, collapsed
   behind a toggle, or moved below the fold of their page. The hero honesty band was
   removed by the owner's decision (2026-08-23) — the landing page's Receipts section
   carries the proven/unreached ledger at full weight instead. Do not re-add the band.
5. **The prose in `content/**` is source of truth and is never rewritten.** Docs and blog
   pages render the markdown as-is. Marketing copy in this spec is new and is what you type.
6. Install copy: the install is **`npm install -g arcturn`**, written down once in
   `web/lib/utils.ts` as `INSTALL_COMMAND` and imported everywhere it is shown — never
   retyped. That command names a published package, which couples the two releases: **the
   site may not be deployed before `arcturn` is published to npm.** A clone + build stays
   documented on `/docs/getting-started` as the way to run an unreleased commit, not as
   the install.

---

## 1. Positioning & messaging

### 1.1 What Arcturn is

Arcturn is an open-source (Apache-2.0), TypeScript agent harness that ships in two shapes
from one runtime:

- **`arcturn`** — an interactive terminal coding agent.
- **`@arcturn/core`** — the same event-driven runtime, embeddable in your own product.

The tagline is **"Every turn counts."** The name is the star Arcturus — the one you steer
by. Navigation, not autocomplete.

### 1.2 Who the site is for

Two readers, in priority order:

1. **The developer evaluating an agent CLI.** Already uses one. Skeptical. Wants to know
   in ten seconds what is different, and wants to check it rather than be told. Lands on
   `/`, goes to `/features/accountability` or `/security`, then `/docs/getting-started`.
2. **The engineer who needs an embeddable harness.** Building an agent into a product and
   tired of writing the permission layer, the session store and the provider adapters
   again. Lands on `/` or a search result, goes to `/sdk` then `/docs/sdk`.

A third, quieter reader: **the person who has to sign off** on an agent touching a repo.
They read `/security` and `/open-source`. The honesty of those two pages is the whole
pitch to them.

### 1.3 The differentiators that actually matter

Ordered by how much they separate Arcturn from what the reader already has.

1. **Accountability as a first-class object.** The session is the artifact, not the diff:
   an append-only `.jsonl` tree on disk. `arcturn replay` re-runs a session's prompts
   against the same or another model; `arcturn bisect` binary-searches for the turn where
   behaviour diverged, replaying a recorded cassette hermetically; `arcturn blame` answers
   per line which turn wrote it and what evidence that turn was working from. Plus an
   append-only permission/tool audit trail and live cost accounting with a `--max-cost`
   ceiling that includes sub-agent spend.
2. **Control before the fact, not forgiveness after it.** A rule-based permission engine
   at a single choke point — the runtime's tool dispatcher — with allow / deny / ask rules
   scoped session over project over user, and four modes: `default`, `acceptEdits`,
   `plan`, `yolo`. Around it: checkpoints before every `write`/`edit` with a `/rewind` that
   restores files and **forks** the conversation instead of deleting it; `--dry-run`'s
   shadow tree with `/diff`, `/apply`, `/discard`; taint tracking; canary tokens; and an
   opt-in OS sandbox confining `bash` writes to the workspace.
3. **Extensible without a build step.** MCP client built in (stdio and streamable HTTP).
   Markdown skills — drop a file in `.arcturn/skills` and it is a slash command. Lifecycle
   hooks that are shell commands and can veto a `preToolUse` call. Sub-agents, plan mode
   and todos. File-defined workflows. Custom tools and extensions in TypeScript.
4. **Provider-agnostic by construction.** Anthropic, OpenAI and every OpenAI-compatible
   endpoint, Google Gemini, Bedrock, Vertex, Azure — with streaming, tool calls, thinking,
   prompt caching and cost tracking through one interface, plus per-role model routing,
   failover chains and a live model catalog (`/model refresh`).
5. **The harness and the CLI are the same code.** Whatever the terminal agent can do, the
   SDK can do, over the same `AgentEvent` stream — the CLI's `--output-format json` emits
   exactly the events the SDK gives you.

Secondary, worth mentioning but not a pillar: LSP diagnostics appended to every write and
edit (TypeScript, Python, Go, Rust); the verify loop; deferred tools; context offloading;
project memory; scouts; agent teams; server mode; ACP editor integration; telemetry.

### 1.4 Voice

Technical, specific, first-person-singular where the project speaks for itself (it is one
maintainer, and saying so is a strength). Short declaratives. Concrete nouns —
`preToolUse`, `.jsonl`, `--max-cost` — beat adjectives. Never "revolutionary",
"seamless", "effortless", "supercharge", "unleash", "game-changing". No exclamation marks.
Sentence case for all headings including nav and buttons ("Get started", not "Get Started").
The product name is lowercase `arcturn` in command context and code, **Arcturn** in prose.

---

## 2. Design system

Everything in §2.1–§2.4 is written to be pasted into `web/app/globals.css` by the
foundation agent, in this order: `@import "tailwindcss";` → `@theme` → `:root` semantic
layer → theme overrides → base → utilities.

### 2.1 Colour

**Palette source.** The Arcturus brand: gold `#f2af48`, starlight `#fad185`, ember
`#b87436`, on a warm ink neutral ramp. **No blue cast anywhere** — every neutral is warm
(hue ~35–45°). The old site's light theme used `#fbfbfe` / `#0d0d1a`; those are cool and
are replaced.

**Two-layer model.** Raw brand ramps go in `@theme` (they are theme-independent and
generate `bg-*`/`text-*` utilities). Semantic tokens are plain CSS custom properties on
`:root` and get re-declared per theme. Components consume **semantic tokens only**, via
the `@theme` aliases in §2.1.3 so Tailwind utilities like `bg-surface` and `text-muted`
just work.

#### 2.1.1 `@theme` — raw ramps

```css
@theme {
  /* Warm ink neutrals — hue ≈ 38°, no blue cast */
  --color-ink-950: #0c0a07;
  --color-ink-900: #13100c;
  --color-ink-850: #181410;
  --color-ink-800: #1f1b16;
  --color-ink-700: #26201a;
  --color-ink-600: #332c24;
  --color-ink-500: #4a4238;
  --color-ink-400: #6b6359;
  --color-ink-350: #857e74;
  --color-ink-300: #a8a29a;
  --color-ink-200: #cec6b8;
  --color-ink-150: #e3ddd2;
  --color-ink-100: #f0ece5;
  --color-ink-75:  #f6f3ed;
  --color-ink-50:  #faf8f4;

  /* Brand */
  --color-gold: #f2af48;
  --color-gold-hover: #fac169;
  --color-star: #fad185;
  --color-ember: #b87436;
  --color-ember-deep: #8a5216;
  --color-on-accent: #241a0a;

  /* Status — warm-compatible, one pair per theme */
  --color-good-dark: #5fd39b;
  --color-good-light: #0f7040;
  --color-warn-dark: #e8b53a;
  --color-warn-light: #8a5a06;
  --color-bad-dark:  #f2726b;
  --color-bad-light: #b3253c;
}
```

#### 2.1.2 Semantic tokens, both themes

Dark is the default. Light is applied two ways — by `prefers-color-scheme` when the reader
has made no choice, and by an explicit `[data-theme="light"]` — and **the two blocks must
stay byte-identical**, or a system-light visitor and a toggled-light visitor see two
different sites. That is asserted, not trusted.

The token *values* live here. The contrast ratios do not. They used to be hand-typed into
the comments below, and most of them disagreed with the hexes shipping beside them —
`--accent` on dark was published as 11.1:1 against a real 10.35:1, `--accent-quiet` on
light as 4.3:1 against a real 3.54:1, `--on-accent` on the gold fill as 9.6:1 against a
real 8.96:1. Overstated accessibility numbers are the one kind of marketing inflation this
site cannot afford, so they are computed now: `scripts/contrast.test.ts` parses these
blocks, computes every pairing the components produce, fails under the floor, and writes
the generated table below.

```css
:root {
  color-scheme: dark;

  --surface:        #0c0a07; /* page ground */
  --surface-raised: #13100c; /* nav bar, footer, sticky chrome */
  --surface-card:   #181410; /* cards, panels, docs sidebar active row */
  --surface-inset:  #080705; /* code blocks, terminal body, inputs */
  --surface-hover:  #1f1b16;

  --border:         #26201a; /* hairlines, card borders  — decorative */
  --border-strong:  #3a3128; /* dividers, table rules    — decorative */
  --border-control: #726a5f; /* ghost buttons, inputs    — the ≥3:1 boundary */
  --border-accent:  #6b4a1c; /* accent-tinted edges      — decorative */

  --text:           #f0ece5; /* body + headings */
  --text-muted:     #a8a29a; /* secondary prose, lede */
  --text-faint:     #918a80; /* captions, metadata — the floor */
  --text-inverse:   #0c0a07;

  --accent:         #f2af48; /* links, accent text, graphic fill */
  --accent-hover:   #fad185;
  --accent-quiet:   #b87436; /* decorative strokes and marks — never text */
  --accent-tint-card:  color-mix(in oklab, var(--accent) 7%,  var(--surface-card));
  --accent-tint-chip:  color-mix(in oklab, var(--accent) 8%,  var(--surface-card));
  --accent-tint-icon:  color-mix(in oklab, var(--accent) 10%, transparent);
  --accent-tint-badge: color-mix(in oklab, var(--accent) 12%, transparent);
  --on-accent:      #241a0a; /* text on gold fills */

  --good: #5fd39b;
  --warn: #e8b53a;
  --bad:  #f2726b;

  --focus-ring: #fad185;
  --selection:  rgb(242 175 72 / 0.32);
  --glow:       rgb(242 175 72 / 0.22);
  --code-bg:    #080705;
}

/* Light: applied for system preference when the reader has made no choice … */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) { /* …identical block to :root[data-theme="light"] */ }
}
/* …and for an explicit choice. KEEP THE TWO BLOCKS BYTE-IDENTICAL. */
:root[data-theme="light"] {
  color-scheme: light;

  --surface:        #faf8f4;
  --surface-raised: #ffffff;
  --surface-card:   #ffffff;
  --surface-inset:  #f3efe8;
  --surface-hover:  #f3efe8;

  --border:         #e3ddd2;
  --border-strong:  #cec6b8;
  --border-control: #8a8377;
  --border-accent:  #e3b877;

  --text:           #1a150f;
  --text-muted:     #575046;
  --text-faint:     #6f675c;
  --text-inverse:   #faf8f4;

  --accent:         #8a5216; /* the READABLE accent on light */
  --accent-hover:   #6f4110;
  --accent-quiet:   #b87436; /* decorative only, never body text */
  --accent-tint-card:  color-mix(in oklab, var(--accent) 7%,  var(--surface-card));
  --accent-tint-chip:  color-mix(in oklab, var(--accent) 8%,  var(--surface-card));
  --accent-tint-icon:  color-mix(in oklab, var(--accent) 10%, transparent);
  --accent-tint-badge: color-mix(in oklab, var(--accent) 12%, transparent);
  --on-accent:      #241a0a;

  --good: #0f7040;
  --warn: #8a5a06;
  --bad:  #b3253c;

  --focus-ring: #b87436;
  --selection:  rgb(242 175 72 / 0.38);
  --glow:       rgb(242 175 72 / 0.16);
  --code-bg:    #f3efe8;
}
```

**Borders have two jobs and two floors.** `--border`, `--border-strong` and
`--border-accent` are hairlines: they separate things that are already legible, so they sit
below 3:1 on purpose and never carry information on their own. `--border-control` is the
*boundary of an interactive control* — a ghost button, an input, a segmented control —
which WCAG 1.4.11 puts at ≥3:1 because it is the only thing telling the reader where the
target is. Never let a decorative hairline be the only edge of a control.

**The four accent tints** replace four ad-hoc `color-mix()` strengths that used to be typed
inline in `Card`, `CommandChip`, `Badge` and the feature-icon tiles. Two are opaque mixes
over `--surface-card`; two carry alpha and composite over whatever surface they land on.
All four are declared inside **every** theme block, `.force-dark` included — a `color-mix()`
stored in a custom property substitutes its `var()`s where it is *declared*, so a single
declaration on `:root` would paint the page theme's tint inside always-dark terminal art.

*Known limit:* Lightning CSS wraps every `color-mix()` in an `@supports` guard and
down-levels the fallback to the mix's **first** colour, so a browser without `color-mix`
(pre-2023 — Chrome <111, Safari <16.2, Firefox <113) paints a badge solid accent under
accent text. The contrast test computes the supported path, which is the one every browser
in the support matrix takes. This is not new to the tints: the four inline `color-mix()`
utilities they replaced down-levelled identically, and the site already depends on
`color-mix` for the header ground and prose link underlines.

<!-- BEGIN GENERATED: contrast — do not hand-edit, see scripts/contrast.test.ts -->

Computed from the token hexes in `app/globals.css` by
`scripts/contrast.test.ts`, which fails the build if any pair drops below its
floor. **Do not hand-edit these numbers** — regenerate them with
`UPDATE_CONTRAST_TABLE=1 npx vitest run scripts/contrast.test.ts` from `web/`.

*Worst ground* is the lowest-contrast surface the token can legally land on,
across `--surface`, `--surface-raised`, `--surface-card`, `--surface-inset` and
`--surface-hover`. The floor is the one that has to hold.

**Dark**

| Token | Value | vs `--surface` | Worst ground | Worst | Floor | Used for |
|---|---|---|---|---|---|---|
| `--text` | `#f0ece5` | 16.79:1 | `--surface-hover` | 14.53:1 | 4.5:1 | body + headings |
| `--text-muted` | `#a8a29a` | 7.81:1 | `--surface-hover` | 6.76:1 | 4.5:1 | secondary prose, lede |
| `--text-faint` | `#918a80` | 5.79:1 | `--surface-hover` | 5.01:1 | 4.5:1 | captions, metadata |
| `--accent` | `#f2af48` | 10.35:1 | `--surface-hover` | 8.96:1 | 4.5:1 | links, accent text |
| `--accent-hover` | `#fad185` | 13.67:1 | `--surface-hover` | 11.84:1 | 4.5:1 | link hover |
| `--accent-quiet` | `#b87436` | 5.26:1 | `--surface-hover` | 4.55:1 | 3:1 | decoration only — never text |
| `--good` | `#5fd39b` | 10.61:1 | `--surface-hover` | 9.19:1 | 4.5:1 | status |
| `--warn` | `#e8b53a` | 10.45:1 | `--surface-hover` | 9.05:1 | 4.5:1 | status |
| `--bad` | `#f2726b` | 6.96:1 | `--surface-hover` | 6.02:1 | 4.5:1 | status |
| `--focus-ring` | `#fad185` | 13.67:1 | `--surface-hover` | 11.84:1 | 3:1 | focus outline |
| `--border-control` | `#726a5f` | 3.71:1 | `--surface-hover` | 3.21:1 | 3:1 | ghost button + input boundary |

**Light**

| Token | Value | vs `--surface` | Worst ground | Worst | Floor | Used for |
|---|---|---|---|---|---|---|
| `--text` | `#1a150f` | 17.09:1 | `--surface-inset` | 15.82:1 | 4.5:1 | body + headings |
| `--text-muted` | `#575046` | 7.49:1 | `--surface-inset` | 6.93:1 | 4.5:1 | secondary prose, lede |
| `--text-faint` | `#6f675c` | 5.25:1 | `--surface-inset` | 4.85:1 | 4.5:1 | captions, metadata |
| `--accent` | `#8a5216` | 6.00:1 | `--surface-inset` | 5.55:1 | 4.5:1 | links, accent text |
| `--accent-hover` | `#6f4110` | 8.11:1 | `--surface-inset` | 7.51:1 | 4.5:1 | link hover |
| `--accent-quiet` | `#b87436` | 3.54:1 | `--surface-inset` | 3.27:1 | 3:1 | decoration only — never text |
| `--good` | `#0f7040` | 5.80:1 | `--surface-inset` | 5.37:1 | 4.5:1 | status |
| `--warn` | `#8a5a06` | 5.58:1 | `--surface-inset` | 5.16:1 | 4.5:1 | status |
| `--bad` | `#b3253c` | 6.09:1 | `--surface-inset` | 5.64:1 | 4.5:1 | status |
| `--focus-ring` | `#b87436` | 3.54:1 | `--surface-inset` | 3.27:1 | 3:1 | focus outline |
| `--border-control` | `#8a8377` | 3.53:1 | `--surface-inset` | 3.27:1 | 3:1 | ghost button + input boundary |

The gold fill is the same in both themes, so `--on-accent` on it is one number: 8.96:1 at rest, 10.50:1 on hover.

`.force-dark` resolves every one of these to its dark value — the always-dark
scope redeclares the full block, which is asserted rather than assumed.

<!-- END GENERATED: contrast -->

**Critical distinction.** `--accent` is the *readable* accent and changes per theme
(`#f2af48` dark → `#8a5216` light). The raw brand golds `--color-gold` / `--color-star` /
`--color-ember` **never** change — they are for gradient fills, glows, the star mark, and
the always-dark terminal art, where darkening them would destroy the brand. Rule of thumb:
**text and icons use `--accent`; pixels use `--color-gold`.**

**Gold fill buttons** are `#f2af48` in both themes with `--on-accent` text, so the primary
CTA is identical everywhere; the ratio is in the table above. Do not darken the gold button
on light.

#### 2.1.3 Tailwind aliases (also inside `@theme`)

So page agents write `bg-surface-card text-muted border-default` and never touch
`var(--…)` by hand:

```css
@theme inline {
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-surface-card: var(--surface-card);
  --color-surface-inset: var(--surface-inset);
  --color-surface-hover: var(--surface-hover);
  --color-default: var(--border);          /* border-default */
  --color-strong: var(--border-strong);    /* border-strong  */
  --color-control: var(--border-control);  /* border-control — the >=3:1 one */
  --color-accent-edge: var(--border-accent);
  --color-text: var(--text);
  --color-muted: var(--text-muted);
  --color-faint: var(--text-faint);
  --color-inverse: var(--text-inverse);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-quiet: var(--accent-quiet);
  --color-accent-tint-card: var(--accent-tint-card);      /* bg-accent-tint-card  */
  --color-accent-tint-chip: var(--accent-tint-chip);      /* bg-accent-tint-chip  */
  --color-accent-tint-icon: var(--accent-tint-icon);      /* bg-accent-tint-icon  */
  --color-accent-tint-badge: var(--accent-tint-badge);    /* bg-accent-tint-badge */
  --color-on-accent: var(--on-accent);
  --color-good: var(--good);
  --color-warn: var(--warn);
  --color-bad: var(--bad);
  --color-focus: var(--focus-ring);
}
```

The four accent tints have aliases so no component has to write a `color-mix()` inline: an
accent-toned card is `bg-accent-tint-card`, a badge is `bg-accent-tint-badge`. `Card`,
`Badge`, `CommandChip`, `FeatureCard` and `/sdk` still carry the inline literals they were
built with and should take the utilities as those files are next touched — the values are
identical, so the swap is not a visual change.

#### 2.1.4 The always-dark scope

Terminal mockups depict a real terminal and stay dark in both themes. A `.force-dark`
class re-declares the full dark semantic block plus `color-scheme: dark`, exactly as the
old site did. Any component rendering terminal art wraps itself in `.force-dark`. This is
the only place a theme is pinned.

**Full means full.** `.force-dark` is a descendant scope, so any token it leaves out
inherits from whichever root is active — that is, the *light* value, inside dark terminal
art. `--elev-glow` was missing exactly that way and the hero terminal lost its halo on
light. `scripts/contrast.test.ts` now asserts that `.force-dark` declares every token
`:root` does, with the same value; add a token to one and you must add it to the other.

#### 2.1.5 Contrast rules

These are floors, not aspirations: `scripts/contrast.test.ts` computes every pairing the
components actually produce, in both themes and inside `.force-dark`, and fails under them.
Run it before shipping a token edit.

- Body and UI text: **≥ 4.5:1**. Large text (≥ 24px, or ≥ 19px bold): ≥ 3:1 but prefer 4.5.
- Non-text (focus rings, control borders, icon-only affordances): **≥ 3:1**.
- `--text-faint` is the floor. Nothing lighter than it may carry text. It is measured
  against `--surface-hover` (dark) and `--surface-inset` (light), not against the page
  ground — the worst legal ground is the one that has to clear 4.5:1, which is why dark
  `--text-faint` is `#918a80` and not the `#857e74` that cleared only the easy surface.
- A control's boundary is `--border-control`, never `--border-strong`. The decorative
  hairlines sit near 1.5:1 by design; a ghost button edged with one is a control the reader
  cannot find. See the border note in §2.1.2. **Outstanding:** `Button`'s `ghost` variant
  still reads `border-strong` (1.55:1 dark, 1.60:1 light) and needs `border-control` — one
  token swap, no other change.
- `--accent-quiet` is **decoration only**, never text — it clears the 3:1 non-text floor and
  nothing more. Every element that paints it must be `aria-hidden`, and that is asserted.
- Never place text on a gradient without a solid fallback colour underneath.
- The gradient headline treatment (§2.4) must keep a solid `color` fallback so a failed
  `background-clip` still renders readable text.

### 2.2 Typography

#### 2.2.1 Fonts

- **Sans: Inter**, via `next/font/google` in `app/layout.tsx`:
  `Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" })`.
- **Mono: JetBrains Mono**, via `next/font/google`:
  `JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jetbrains" })`.
- Apply both variables on `<html className={`${inter.variable} ${jetbrains.variable}`}>`.

```css
@theme {
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: var(--font-jetbrains), ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
}
```

`body { font-family: var(--font-sans); font-feature-settings: "cv11", "ss01"; }` —
`cv11` gives Inter the single-storey `l`/`a` that reads better next to mono code.

> **Offline-build fallback (foundation agent, mandatory check).** `next/font/google`
> fetches at build time. Run the build gate immediately after wiring the fonts. If it
> fails to reach Google Fonts, delete the `next/font/google` imports and let
> `--font-sans` / `--font-mono` fall through to the stacks above (drop the leading
> `var(--font-inter)` / `var(--font-jetbrains)` entries). Report which path you took.
> A green build outranks Inter. Do not add a `<link>` to fonts.googleapis.com — it is a
> render-blocking third-party request on a static site and a privacy regression.

#### 2.2.2 Scale

Registered in `@theme` as `--text-*` so utilities exist; `clamp()` handles responsive
display sizes with no breakpoint variants needed.

| Token | Size | Line-height | Tracking | Weight | Used for |
|---|---|---|---|---|---|
| `display-1` | `clamp(2.5rem, 1.55rem + 4.2vw, 4.5rem)` | 1.04 | -0.032em | 600 | Home `h1` only |
| `display-2` | `clamp(2.1rem, 1.5rem + 2.6vw, 3.25rem)` | 1.08 | -0.026em | 600 | Every other page `h1` |
| `h2` | `clamp(1.75rem, 1.3rem + 1.9vw, 2.5rem)` | 1.15 | -0.021em | 600 | Landing section headings |
| `h3` | `1.375rem` | 1.3 | -0.012em | 600 | Card titles, doc `h2` |
| `h4` | `1.0625rem` | 1.4 | -0.006em | 600 | Sub-headings, doc `h3` |
| `lede` | `clamp(1.0625rem, 0.98rem + 0.45vw, 1.25rem)` | 1.6 | -0.006em | 400 | Hero subhead, section intros |
| `body` | `1rem` | 1.7 | 0 | 400 | Prose |
| `body-sm` | `0.875rem` | 1.6 | 0 | 400 | Cards, nav, footer |
| `caption` | `0.8125rem` | 1.5 | 0 | 400/500 | Metadata, table cells |
| `eyebrow` | `0.75rem` | 1.2 | 0.13em | 600 | Section eyebrows, uppercase |
| `code-inline` | `0.875em` | inherit | 0 | 500 | Inline `<code>` |
| `code-block` | `0.8125rem` | 1.65 | 0 | 400 | `<pre>`, terminal art |
| `code-block-lg` | `0.875rem` | 1.65 | 0 | 400 | Terminal art at hero scale |

Weights loaded: 400, 500, 600, 700. **700 is reserved for the wordmark and `<strong>`.**
Headings are 600 — Inter 700 at display sizes reads shouty.

All twelve are real `--text-*` entries in `@theme`, `code-inline` and `code-block-lg`
included. A component that needs a size writes the utility (`text-code-block-lg`) and never
`text-[0.875rem]`: a hard-coded size is a value the scale cannot be changed from. The two
that predate the tokens — `TerminalMock`'s `text-[0.875rem]` and `Code`'s `text-[0.875em]`
— should take `text-code-block-lg` and `text-code-inline`; the values are identical.

#### 2.2.3 Prose rules

- Measure: **the column and the measure are two different numbers.** `--width-prose`
  (44rem / 704px) is the *column* — at Inter's 16px digit advance that is ≈79ch, well past
  the readable ceiling, but code blocks, tables and images want every pixel of it. Running
  text inside the column is capped separately at `--measure-body` (68ch); ledes get
  `--measure-lede` (60ch). The old spec claimed 44rem *was* 68ch, which it never was, and
  the pages hand-typed seven different `max-w-[NNch]` values on top of it. Both are gone:
  §2.3.2 owns the two tokens and nothing else sets a text measure.
- Paragraph spacing 1.25em; `h2` gets `margin-top: 2.5em`, `h3` `2em`; first heading in a
  flow has no top margin.
- Links in prose: `color: var(--accent)`, `text-decoration: underline`,
  `text-underline-offset: 0.2em`, `text-decoration-thickness: 1px`,
  `text-decoration-color: color-mix(in oklab, var(--accent) 40%, transparent)`; on hover
  the decoration colour goes to full `--accent`. Never colour-only — the underline is the
  non-colour affordance.
- Lists: `1.5rem` indent, markers in `--text-faint`, `0.4em` between items.
- Tables in prose: full width, hairline `--border` row separators only (no vertical rules,
  no zebra), header row `--text-faint` uppercase `caption`, cells `body-sm`, and the whole
  table wrapped in `overflow-x: auto` (§2.3.5).

#### 2.2.4 Code

- Inline `code`: `--surface-inset` background, `1px solid var(--border)`,
  `border-radius: var(--radius-xs)`, `padding: 0.12em 0.36em`,
  `font-size: var(--text-code-inline)`, colour `--text` (**not** accent — accent is for links, and coloured inline code next to
  coloured links is unreadable).
- Block: `rehype-pretty-code` + Shiki, **dual theme**
  `{ light: "github-light", dark: "github-dark-default" }`. Shiki emits both palettes as
  CSS variables on the token spans; select them with
  `:root[data-theme="dark"] [data-theme] span { color: var(--shiki-dark) !important; }`
  and the matching `prefers-color-scheme` guard, mirroring §2.1.2's two-block pattern.
  Highlighting happens at build time — **zero client JS**. Two markup shapes reach the
  stylesheet — `.shiki > span.line` from `<CodeBlock>` and `pre[data-theme] > span` from the
  docs pipeline — so every dark selector list must carry **both**, `.force-dark` included,
  or a docs-shaped block dropped into always-dark terminal art renders light tokens on a
  near-black ground.
- `pre` chrome: `--surface-inset` ground, `1px solid var(--border)`,
  `border-radius: var(--radius-md)`, `padding: 1rem 1.15rem`, `overflow-x: auto`,
  `tab-size: 2`. A language chip (`caption`, `--text-faint`, uppercase) sits top-right,
  from `data-language`. A `CopyButton` (§4) sits beside it, visible on hover/focus and
  always visible on touch.
- Shell blocks whose only line starts with `$` render without the `$` in the copy payload.

### 2.3 Space, layout, shape, elevation

#### 2.3.1 Rhythm

4px base. **Two vertical tiers between landing sections, and no third.** They live in
`components/ui/Section.tsx` as `SECTION_RHYTHM`, and `<Section>`, `<SplitSection>` and
`<CTASection>` all consume that constant, so a page cannot invent a fourth spacing.

| Tier | Class | <640px | ≥768px | ≥1024px | For |
|---|---|---|---|---|---|
| `default` | `py-16 md:py-20 lg:py-24` | 64px | 80px | 96px | A full beat: eyebrow, heading, lede, body |
| `tight` | `py-10 md:py-14 lg:py-16` | 40px | 56px | 64px | An inventory grid or table continuing the beat above it |

The tiers replaced a single `py-20 md:py-28 lg:py-32`. That was not too *much* space, it
was too *uniform*: eight consecutive sections at 128px read as one grey ribbon, because
identical spacing carries no information. Rhythm is the contrast between the tiers, plus
the band below — never the padding alone.

**The band.** `SECTION_BAND` = `bg-surface-raised border-y border-default`, exposed as
`band` on all three section components. One step of surface, with the two hairlines that
make the step read as deliberate rather than as a rendering seam. Apply it to *chosen*
beats down a long page; never to two touching sections, which doubles the hairline and
cancels the alternation that gives a band its meaning. A band's own `border-y` is the
break at its edges, so do not also put an `<ArcRule />` there.

Inside a section: eyebrow → heading `0.75rem`; heading → lede `1rem`; lede → content
`3rem` (mobile `2rem`). Card grid gap `1.25rem` mobile, `1.5rem` ≥ 768px.

#### 2.3.2 Containers

```css
@theme {
  /* Columns — a distance. */
  --width-prose:   44rem;  /*  704px — article column: prose + its figures */
  --width-content: 72rem;  /* 1152px — marketing sections                  */
  --width-wide:    82rem;  /* 1312px — hero, full-bleed feature grids      */
  --width-shell:   90rem;  /* 1440px — docs three-column shell             */

  /* Measures — a count of characters, so they track the font, not the viewport. */
  --measure-body: 68ch;    /* running body copy inside any column */
  --measure-lede: 60ch;    /* ledes, section intros, CTA subheads */
}
```

**Never hand-type a measure.** `max-w-(--measure-body)` and `max-w-(--measure-lede)` are the
only two allowed. The pages had scattered six of them — `48ch`, `52ch`, `56ch`, `60ch`,
`62ch`, `68ch` — which is six numbers for two ideas, and no reader has ever seen the
difference between 60ch and 62ch. `<Section>`, `<SplitSection>` and `<CTASection>` are
converted; the remaining call sites in `app/**` and in `PageHeader` / `ProseSection` still
carry the literals and should take the tokens as those files are next touched.

Inside `.prose-arc` the split is automatic: the block keeps the full column so code and
tables get their width, and the running text (`p`, `ul`, `ol`, `blockquote`, `h2`–`h4`) is
capped at `--measure-body`.

`.container` = `width:100%; margin-inline:auto; max-width: var(--width-content);` with
padding-inline `1.25rem` (<640px), `1.5rem` (≥640px), `2rem` (≥1024px). Variants
`.container-wide`, `.container-prose`, `.container-shell` swap only the max-width.
Minimum supported viewport is **360px** — nothing may overflow it horizontally.

#### 2.3.3 Radii

```css
--radius-xs: 0.25rem;  --radius-sm: 0.375rem; --radius-md: 0.625rem;
--radius-lg: 0.875rem; --radius-xl: 1.25rem;  --radius-2xl: 1.75rem;
--radius-pill: 999px;
```

Buttons and inputs `--radius-md`; cards `--radius-lg`; large panels and the terminal
`--radius-xl`; badges and chips `--radius-pill`.

#### 2.3.4 Elevation

Dark mode elevates with **surface + hairline**, not shadow (shadows are invisible on
`#0c0a07`). Light mode uses warm shadows — never neutral grey, never black.

```css
--shadow-sm:   0 1px 2px rgb(36 26 10 / 0.06);
--shadow-md:   0 4px 16px -4px rgb(36 26 10 / 0.10), 0 1px 2px rgb(36 26 10 / 0.05);
--shadow-lg:   0 18px 48px -16px rgb(36 26 10 / 0.18), 0 2px 6px rgb(36 26 10 / 0.06);
--shadow-glow: 0 0 40px -6px rgb(242 175 72 / 0.35);
```

Dark: `--shadow-sm/md/lg` collapse to `none`; a card at rest is `--surface-card` +
`1px solid var(--border)`, on hover `--surface-hover` + `--border-strong`. Light: card at
rest `--surface-card` + `1px solid var(--border)` + `--shadow-sm`; hover `--shadow-md`.
`--shadow-glow` is used **only** on the primary CTA and the hero terminal.

Border treatment: hairlines are always exactly `1px` and always a token
(`--border` / `--border-strong` / `--border-accent`). No `2px` borders anywhere except the
focus ring and the docs sidebar active indicator.

#### 2.3.5 Overflow discipline (non-negotiable)

`body` must never scroll horizontally at 360px. Every wide child owns its own scroll
container: `pre`, prose `table`, the docs breadcrumb, the terminal body, any horizontal
card rail. Long unbroken tokens in prose get `overflow-wrap: anywhere`.

#### 2.3.6 The z-layer scale

```css
@theme {
  --z-sticky:  60;  /* in-page sticky chrome: the docs nav bar          */
  --z-header:  70;  /* the site header                                  */
  --z-drawer:  80;  /* mobile nav, docs nav drawer, and their scrims    */
  --z-modal:   90;  /* anything that must cover a drawer                */
  --z-skip:   100;  /* the skip link — above everything, always         */
}
```

Written as `z-(--z-header)`. Ten apart so a new layer can be slotted between two without
renumbering the site. **Never a bare number.** The six arbitrary values in the tree today
— `z-50`, `z-[60]`, `z-[70]`, `z-[78]`, `z-[80]`, `z-[100]` — encode their stacking order
nowhere but in the gaps between them, and `z-[78]` exists only because it had to be under
`80` and someone guessed. They map onto the scale exactly:

| Today | Component | Becomes |
|---|---|---|
| `z-[60]` | `DocsNavDrawer` sticky bar | `z-(--z-sticky)` |
| `z-[70]` | `SiteHeader` | `z-(--z-header)` |
| `z-[78]` | `DocsNavDrawer` overlay | `z-(--z-drawer)` |
| `z-[80]` | `MobileNav` overlay | `z-(--z-drawer)` |
| `z-[100]` | `SkipLink` | `z-(--z-skip)` |
| `z-50` | `NavMenu`, `ThemeToggle` popovers | unchanged |

The popovers are the one exception: they live *inside* the header's stacking context, so
they only have to beat their siblings and a local `z-50` is the honest value. Nothing yet
needs `--z-modal`; it exists so the next thing that must cover a drawer does not guess.

### 2.4 The signature device: **the Turn Arc**

One idea, four scales. It comes straight from the existing `BootesMark`: a 270° orbital arc
with a four-point star at its open end — *a turn, and the star you steer by*. Everything
decorative on this site is a piece of the same circle. This is what stops the site reading
as a Tailwind template, and it is cheap: pure SVG and CSS, no canvas, no WebGL, no 3D.

Geometry, fixed once and reused: `viewBox="-50 -50 100 100"`; arc
`M 31.51 -5.56 A 32 32 0 1 1 5.56 -31.51`; star
`M0 -40C3 -11 11 -3 40 0C11 3 3 11 0 40C-3 11 -11 3 -40 0C-11 -3 -3 -11 0 -40Z`
translated to `(22.63, -22.63)` and scaled. Stroke ramps ember → gold along the
`(-30,30) → (30,-30)` axis.

**Scale 1 — `<StarMark />`, 20–32px.** Nav wordmark, footer, 404. Solid gold stroke, no
glow. Always `aria-hidden`; the adjacent text carries the name.

**Scale 0 — the app icon** (`app/icon.svg`, favicon, apple-icon, PWA icons, the VS Code
extension icon, and the CLI's pixel-art mark). The same device at *icon weight*: on the
64-unit tile the arc is `r=18`, `stroke-width 5.8`, star scale `0.32` — heavier stroke and
a larger star than scale 1 so the mark survives 16px. Tail end of the arc ramp drops to
0.7 opacity (the turn fades in from ember; the star end stays lit), with a soft
`--glow`-toned radial behind the star. Rounded tile (`rx` 22.5%) for favicon/marketplace;
full-bleed opaque square with the device inside the 80% safe zone for apple-touch and
maskable PWA icons.

**Scale 2 — `<ArcEyebrow />`, 14px.** The 90° top-right quadrant of the same arc plus the
star, inline before every section eyebrow. Colour `--accent-quiet`. It is the site's
bullet character — used *only* here, so it stays meaningful.

**Scale 3 — `<ArcHalo />`, hero.** A single ~760px SVG behind the hero, centred on the
terminal's top-right, opacity 0.5 dark / 0.28 light, with a `--glow` radial blur behind it.
The star sits at the arc's open end. Under motion-allowed it rotates once every **240s**,
`linear`, infinite — imperceptible frame to frame, alive if you stare. `will-change:
transform` on the rotating group only. `prefers-reduced-motion: reduce` → static, no
rotation. Below 768px the halo drops to 440px and opacity 0.35, and is `aria-hidden`
decoration in all cases.

**Scale 4 — `<ArcRule />`, section divider.** Replaces the flat `<hr>` between landing
sections: a 1px SVG path, an extremely shallow arc (`M0 8 Q 600 -6 1200 8` over a
`0 0 1200 16` viewBox, `preserveAspectRatio="none"`), stroked with a linear gradient that
is transparent → `--border-strong` → `--accent-quiet` at 50% → `--border-strong` →
transparent. Reads as a hairline; on a second look it is bowed, because it belongs to a
circle that is bigger than the page.

**Supporting motif — the corner tick.** Feature cards and the hero terminal get a `::before`
quarter-arc in the top-left corner: `width/height: 18px; border-top: 1px solid;
border-left: 1px solid; border-color: var(--border-accent); border-top-left-radius:
var(--radius-lg);` inset by `-1px`, opacity 0.9 → 1 on hover. One rule in `globals.css`
(`.arc-corner`), applied by class. It ties every rectangle back to the circle.

**Banned:** particle fields, animated star canvases, parallax scroll-jacking, mesh
gradients, glassmorphism, 3D scenes, mouse-tracking spotlights. One device, applied with
discipline.

The one other brand flourish permitted: `.text-gradient`, used on **at most one phrase per
page** (`background: linear-gradient(105deg, var(--color-ember) 0%, var(--color-gold) 55%,
var(--color-star) 100%)` with `background-clip: text` and a solid `color: var(--accent)`
fallback declared first).

### 2.5 Motion

```css
@theme {
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --duration-fast: 120ms;   /* hover/active colour + border */
  --duration-base: 180ms;   /* buttons, chips, theme swap   */
  --duration-slow: 280ms;   /* panels, dropdowns, drawers   */
  --duration-enter: 420ms;  /* scroll-reveal                */
}
```

**What animates**

| Thing | Animation |
|---|---|
| Buttons / links / cards | `background-color`, `border-color`, `color`, `box-shadow` over `--duration-fast`, `--ease-out`. Cards also `translateY(-2px)` on hover ≥1024px only. |
| Scroll reveal | `opacity 0→1` + `translateY(12px→0)`, `--duration-enter`, `--ease-out`, `once: true`, viewport margin `-80px`, stagger `60ms` (cap a group at 6 children). Framer Motion, in a `"use client"` `<Reveal>` wrapper. |
| Hero terminal lines | Staggered fade-up, `60ms` apart, CSS `animation-delay` only — **no client JS**. |
| Cursor | 1.1s `steps(1)` blink. |
| `<ArcHalo />` | 240s linear rotation. |
| Nav dropdown / mobile drawer | opacity + `translateY(-4px)`, `--duration-slow`, `--ease-out`. |
| Theme toggle | Icon crossfade + 90° rotate, `--duration-base`. The page's colour swap is instantaneous — **never transition `background-color` on `body`**, it smears during navigation. |

**What never animates:** page transitions, scroll position, layout width, font size, or
anything triggered by mouse position.

**Reduced motion.** In `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    animation-delay: 0.001ms !important;   /* a delay is motion too */
    transition-duration: 0.001ms !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
  /* Lifts are dropped, not merely instant. */
  *:hover { translate: none !important; }
  [class*="group-hover:translate"],
  [class*="group-hover:-translate"] { translate: none !important; }
}
```

Two things about that kill switch are load-bearing and easy to undo by accident.

**`translate`, not `transform`.** Tailwind v4 compiles `-translate-y-*` to the individual
`translate` property, so that is what has to be reset. Declaring `transform: none`
alongside it is actively worse: the minifier folds the neighbouring `transform` over the
`translate` reset and the lift comes back. If a component ever animates the `transform`
shorthand, reset it in its own rule, not in this one.

**Both halves of the lift.** `:hover` matches the element under the pointer and its
*ancestors*, never its descendants — so `*:hover` reaches a card that lifts itself but not
the arrow that `group-hover:translate-x-0.5` nudges inside it. The second rule matches the
utility class instead. It is unconditional because those elements carry no translate at
rest, which is also why it cannot flatten a layout transform the way `:hover *` would.

Plus: `<Reveal>` reads `useReducedMotion()` and renders children with no initial state at
all (content is visible immediately, never a stuck `opacity: 0`); `<ArcHalo />` renders
static. **Everything must be fully readable with all animation disabled** — that is the
acceptance test.

### 2.6 Accessibility baseline (every agent, every page)

- One `<h1>` per page; heading levels never skip.
- Landmarks: `<header>` with `<nav aria-label="Main">`, `<main id="content">`, `<footer>`.
  Docs adds `<nav aria-label="Documentation">` and `<nav aria-label="On this page">`.
- A skip link is the first focusable element: visually hidden until focused, then a pinned
  gold chip at top-left, `href="#content"`.
- `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px;
  border-radius: var(--radius-xs); }` — global, never removed. `:focus:not(:focus-visible)`
  gets no outline.
- Every interactive target ≥ **44×44px** on touch (pad with padding or a pseudo-element;
  do not inflate visual size).
- Icon-only controls carry `aria-label`. Decorative SVG carries `aria-hidden="true"` and
  `focusable="false"`.
- Current page: `aria-current="page"` on nav and sidebar links.
- Dropdown/drawer: `aria-expanded`, `aria-controls`, closes on `Escape`, restores focus to
  its trigger, traps focus while the mobile drawer is open, and sets `inert`/`aria-hidden`
  on the backgrounded content.
- Colour is never the sole signal: status pills pair colour with an icon and a word.
- `<html lang="en">`. Images have real `alt`, or `alt=""` when decorative.
- Terminal mockups: the whole block is `aria-hidden="true"` **and** accompanied by a
  visually-hidden `<p>` describing the session in one sentence, so screen readers get the
  meaning without the ANSI-art noise.

### 2.7 Theme toggle without flash

1. A **blocking inline script** in `<head>` (via `<script dangerouslySetInnerHTML>` in
   `app/layout.tsx`, *not* `next/script`) runs before first paint:
   read `localStorage.getItem("arcturn-theme")`; if it is `"light"` or `"dark"`, set
   `document.documentElement.dataset.theme` to it; otherwise leave the attribute absent so
   `prefers-color-scheme` decides. Wrap in `try {} catch {}` for blocked storage.
2. `<html suppressHydrationWarning>` because that script mutates the element pre-hydration.
3. `<ThemeToggle>` is a `"use client"` component. It renders a neutral placeholder until
   mounted (so SSR and client markup agree), then a 3-state control: **System / Light /
   Dark**, an icon button with a small popover, `aria-label="Colour theme"`. Choosing
   System removes both the attribute and the storage key.
4. The three-state model is why §2.1.2 declares light twice. Never collapse those blocks.
5. `<meta name="theme-color">` is emitted twice with `media` on `prefers-color-scheme`:
   `#0c0a07` dark, `#faf8f4` light.

---

## 3. Page blueprints

Shared shell for **all** pages: skip link → `<SiteHeader>` (sticky, `h-16`,
`--surface-raised` at 82% + `backdrop-blur-md`, `border-b border-default`, becomes fully
opaque past 8px of scroll) → `<main id="content">` → `<SiteFooter>`.

Every page exports `metadata` with a unique `title` (template
`"%s — Arcturn"`, home is `"Arcturn — Every turn counts."`) and a `description` drawn from
the page's own lede.

### 3.1 `/` — Home

The page has one job the interior pages do not: it has to *show* the thing it claims,
because a description of an accountable agent reads exactly like a description of an
unaccountable one. So the hero plays a real session and stops at the permission gate, and
the provider ledger sits at body size in a beat of its own instead of shrinking into a
footnote.

**Sequence and rhythm** (tiers and the band rule are §2.3.1; `default` unless marked):

| # | Beat | Tier | Ground | What breaks it from the beat above |
|---|---|---|---|---|
| 1 | Hero | — | page | — |
| 2 | The gap | `default` | page | — |
| 3 | Four pillars | `default` | page | `<ArcRule />` |
| 5 | Control | `default` | **one shared band** | the band's `border-y` |
| 6 | Accountability | `default` | *the same band* | **nothing — deliberate** |
| 7 | Extensibility | `tight` | page | the band's `border-y` |
| 8 | Models | `default` | page | `<ArcRule />` |
| 9 | Receipts | `default` | band | the band's `border-y` |
| 10 | SDK | `default` | page | the band's `border-y` |
| 11 | Open source | `tight` | page | `<ArcRule />` |
| 12 | Final CTA | `default` | page | — |

**Three `<ArcRule />` on this page, not eight.** A band's own hairlines are the break at
its edges, so a rule beside one draws a second line 1px away from the first. The rules
survive only where two page-ground sections meet: pillars → Control's band is a band edge,
Models → Receipts is a band edge, and so on. The alternation — page, band, page, band —
is what carries the rhythm now; the padding alone never did.

**§ Hero.** Desktop ≥1024px: two columns inside `.container-wide`,
`grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]`, `gap-16`, `items-center`, copy left /
`<TerminalPlayer>` right, `<ArcHalo>` absolutely positioned behind the player,
`pt-24 pb-20`. <1024px: single column, copy first, player below at full width,
`pt-16 pb-14`; halo shrinks per §2.4.

The player takes the wider track because it is the evidence. `items-center` and not
`items-start`: the player's height is fixed and self-reserving (491px at `lg`, 519px at
360px) while the copy column runs roughly 700px, so aligning to the start hangs ~200px of
void under the terminal. If the copy column ever shortens past ~550px, revisit this.

- Eyebrow (`<Badge variant="accent">`): `Open source · Apache-2.0 · TypeScript`
- `h1` (display-1): **The coding agent you can hold accountable.** Exact. `hold accountable`
  carries `.text-gradient`; nothing else on the page does.
- Lede — **one** sentence: *Arcturn is an open-source terminal coding agent and the
  TypeScript harness underneath it.*
- **The guarantee triad.** Sentences two to four of the old lede, promoted out of the
  paragraph: three hairline-separated rows, each row a whole link ≥44px tall, the leading
  term in `--text` and the rest in `--text-muted`, with an `ArrowRight` that slides on
  hover. Nobody reads the fourth sentence of a hero paragraph, and each of these is a
  claim with a page that proves it.

  | Row | Links to |
  |---|---|
  | **Every tool call** clears a permission engine before it runs. | `/docs/permissions` |
  | **Every edit** is snapshotted before it lands. | `/docs/checkpoints` |
  | **Every session** is a file on disk you can replay, bisect and blame. | `/docs/sessions` |

  The page `description` is **composed** from the lede sentence plus these three rows
  (`HERO_LEDE = [HERO_INTRO, ...HERO_GUARANTEES]`), never retyped, so the summary in a
  search result cannot drift from the one on the screen.
- Buttons: primary `Get started` → `/docs/getting-started`, carrying `elev-glow` (§2.3.4 —
  the one glowing CTA); ghost `Why I built it` → `/blog/why-arcturn`.
- Below the buttons, `<CommandChip>`: `INSTALL_COMMAND` (`npm install -g arcturn`) with a
  copy button and the caption *Node 20 or newer. See*
  [Getting started](/docs/getting-started).

**§ The hero terminal plays.** `<TerminalPlayer size="lg" glow className="relative" />` —
the interactive session player (§3.9), not a `<TerminalMock>`. It types the prompt,
streams the read and the grep, **stops at `⚠ Permission required — edit
src/routes/signup.ts`**, and waits for the reader to press allow or deny; six seconds of
no answer takes allow and the caption says so, so the page never claims the reader chose.
Deny is the branch that proves the gate: no edit, no cost line, and the verbatim message
the model receives.

It takes **no** `description` prop, by design — the transcript is built in and switches
with the branch, so a caller cannot narrate something other than what is on screen. It
needs no width or height from the page. `glow` lands here and on nothing else on this
page except the primary CTA.

This is not decoration and may not be swapped back for a still. A screenshot of a
permission gate and an enforced permission gate are the same picture, and that picture is
the entire claim of the page — so the gate has to be answerable.

**§ The gap.** Eyebrow `The problem`. `h2`: **Capability raced ahead of accountability.**
Lede: *The models write the code — that question is settled. The one I actually have is
whether I can let an agent run, and, twenty minutes later, what exactly it did.*
Then three `<Card variant="quiet">` in a `md:grid-cols-3`:

1. **`git diff` is the whole forensic story.** Forty tool calls leave the residue of maybe
   twelve, in a flat pile, with no indication of which turn produced which hunk.
2. **The shell commands leave no trace at all.** Fetches, background tasks, and the
   sub-agent that ran for ninety seconds and cost more than the rest of the session.
3. **"Undo" means `git checkout` plus remembering.** The conversation that produced the
   change isn't in version control, so going back means losing it.

**§ Four pillars.** Eyebrow `What's different`. `h2`: **Four things Arcturn does that a
capable agent still doesn't.** `md:grid-cols-2` of `<FeatureCard>` (icon, title, body,
"Explore →"), each linking to its feature page. The four rows live in
`components/marketing/pillars.tsx` and are shared with `/features`; never retype them here.

| Icon | Title | Href |
|---|---|---|
| `ShieldCheck` | Control before the fact | `/features/control` |
| `History` | Accountability after it | `/features/accountability` |
| `Puzzle` | Extensible without a build step | `/features/extensibility` |
| `Network` | Every provider, one interface | `/features/models` |

**§ Control and § Accountability — one band, two beats.** The two `<SplitSection>` are
wrapped in a single `<div className={SECTION_BAND}>` rather than each taking `band`.
Passing `band` twice draws the hairline between them and splits the pair back into two
sections; one wrapper gives them one continuous raised ground and nothing in between. They
are one demonstration — the gate, then the receipt the gate leaves — and the `<ArcRule />`
that used to sit either side of them is gone because the wrapper's `border-y` is the break.

- **Control.** `lg:grid-cols-2 gap-14 items-center`, copy left, a
  `<TerminalMock variant="permission">` right. The still is correct here precisely because
  the hero already played the live one: this is the anatomy of the prompt, not a claim that
  it stops. Eyebrow `Control`. `h2`: **Decide once, at the choke point.** Body: *The
  runtime's tool dispatcher checks the permission engine and returns a denial before a
  tool's `execute` is ever reached — there is no second path. Rules are allow, deny or ask;
  scopes resolve session over project over user. Read-only tools pass. Anything that
  reaches the ask step with no permission requester configured resolves to deny, not
  "assume it's fine."* `<CheckList>`: four modes — `default`, `acceptEdits`, `plan`,
  `yolo` · `--dry-run` sends file mutations to a shadow tree for `/diff` before `/apply` ·
  Lifecycle hooks can veto a `preToolUse` call · An opt-in OS sandbox confines `bash`
  writes to the workspace. Two links: `How permissions resolve →` `/docs/permissions` and
  `See a whole session →` `/terminal`.
- **Accountability.** Mirrored (`reverse`, copy right on desktop). Eyebrow
  `Accountability`. `h2`: **The session is the artifact.** Body: *Every session is a
  `.jsonl` file — a header line, then one JSON line per entry, appended in order. The
  structure is a tree: each entry carries a `parentId`, so resuming from three turns ago
  and trying a different approach starts a branch instead of overwriting what came after.
  Both branches stay walkable.* Then a `<CommandList>` of three rows: `arcturn replay
  <session>` · `arcturn bisect <session>` · `arcturn blame <file>`, one line each. Closing
  line: *Underneath, every `write` and `edit` snapshots the file's prior content first, so
  `/rewind` can restore it.* Link `Replay, bisect and blame →` `/features/accountability`.

**§ Extensibility.** `density="tight"` — six one-line cards are an inventory, not a beat,
and the tighter tier is what stops the run of full beats reading as one ribbon. Eyebrow
`Extend`. `h2`: **Add a capability without recompiling anything.** `sm:grid-cols-2
md:grid-cols-3` of `<LinkCard>`: MCP · Markdown skills · Hooks · Sub-agents · Workflows ·
Custom tools, each one line and a `/docs/<slug>` link.

**§ Models.** Eyebrow `Models`. `h2`: **Bring your own provider.** Lede: *One interface
across Anthropic, OpenAI and every OpenAI-compatible endpoint, Google Gemini, Bedrock,
Vertex and Azure — streaming, tool calls, thinking, prompt caching and cost tracking
included. Point `--model` at `<provider>/<model>`, route different roles to different
models, or set a failover chain.* A `<CodeBlock>` with the three `arcturn --model …` lines
from `docs/getting-started.md`, and nothing else: the honesty footnote that used to sit
under it in `--text-faint` is now the Receipts beat below. **Removing it from here was a
promotion, not a deletion** — it may never be dropped, only made larger.

**§ Receipts.** New, and the point of the second half of the page. `band`, eyebrow
`Receipts`, `h2`: **What has actually run, and what hasn't.**

- Lede, at `--text-lede` where the old footnote was 13px `--text-faint`: *N of the M
  provider paths have completed real multi-turn tool-calling sessions against a live
  endpoint. Another K have never reached their endpoints at all. Which is which is in the
  table, not in a footnote.* **N, M and K are computed** — `PROVEN_PROVIDERS`,
  `PROVIDER_ROWS.length`, `UNREACHED_PROVIDERS` — never typed. A row changing status
  changes the sentence.
- `<StatusTable rows={PROVIDER_ROWS} />`, all nine rows, in order, no filtering to the
  proven six and no softened status. `PROVIDER_ROWS` lives in `lib/providers.ts` and is
  the single copy, read by this page and by `/features/models`; the statuses are gated by
  the disclosure in `content/blog/why-arcturn.md` and cannot be upgraded without it.
  StatusTable's ground is transparent by construction, so it sits on the band as-is.
- Then, at `body` size and `--text-muted`: *Four waves of adversarial review went at the
  seams. They found `/apply` writing outside the workspace through an in-workspace
  symlink, served sessions and sub-agents escaping the audit trail entirely, a WebSocket
  upgrade with no `Origin` check, and two features that were present but unreachable. All
  four are* [written up on the security page](/security#adversarial-review) *rather than
  quietly patched out.*
- Then the strongest sentence on the site, alone, at `body` size in `--text` rather than
  `--text-muted`: **Every fix landed with a regression test verified to fail against the
  previous behaviour first.** It is not an aside and never gets caption size.
- Links: `Providers and status →` `/features/models` · `Every known limit →` `/security`.

**§ SDK.** Eyebrow `Embed it`. `h2`: **The same runtime, without a terminal in front of
it.** Body: *`@arcturn/core` is what the CLI is built on. One `Agent` per session, one
`AgentEvent` stream out — the same events the CLI emits with `--output-format json`.*
`<CodeBlock>` with a short TypeScript snippet taken verbatim from `content/docs/sdk.md` —
do not write new API surface. Link `Embedding with the SDK →` `/sdk`.

**§ Open source.** `density="tight"` — a coda, not a beat. Eyebrow `Open source`. `h2`:
**Apache-2.0, and checkable.** Body: *No commercial-use restriction, no source-available
licence with a catch in clause four. One repository holds the CLI, the runtime, the
harness and the regression tests behind the findings above — and the commands that check
them are written down rather than described.* It back-references Receipts instead of
restating it: the adversarial-review findings are named once on this page, in Receipts.
Buttons: `On GitHub` ↗ · `How to verify it →` `/open-source` · `Read the limits →`
`/security`.

**§ Final CTA.** `<CTASection />` with no props: centred, `.container-prose`, the shared
`default` tier, `<ArcHalo>` at 30% opacity behind. `h2`: **Every turn counts.** Lede:
*Start a session, watch every tool call ask first, then go back and read exactly what
happened.* Primary `Get started` → `/docs/getting-started`; ghost `Read the docs` →
`/docs`. Below: the install `<CommandChip>` again, on `INSTALL_COMMAND` — so the two
install chips on the page cannot disagree.

### 3.2 `/features` — Overview

`h1` (display-2): **Features.** Lede: *Arcturn is one runtime with two front ends: a
terminal coding agent and an embeddable TypeScript harness. Here is what it does, grouped
four ways.* Then four large `<FeatureCard variant="lg">` (the §3.1 pillar table, one per
row on mobile, `md:grid-cols-2`), followed by a **"Everything else"** section: a
`sm:grid-cols-2 lg:grid-cols-3` of compact `<LinkCard>` for LSP diagnostics, verify loop,
deferred tools, context management, project memory, scouts, agent teams, background
processes, `@`-mentions & images, web search, server mode, editor integration (ACP),
telemetry — each a title + one line + a `/docs/<slug>` link. Close with the standard
`<CTASection>` (§4).

### 3.3 `/features/control`

`h1`: **Control.** Lede: *Every mutating tool call clears a rule before it runs — and when
the rules can't decide, the answer is no.*

Sections, each `<ProseSection>` (eyebrow + h2 + body + supporting block):

1. **One choke point** — the dispatcher check, denial before `execute`, read-only tools
   pass, ask-with-no-requester resolves to deny. Supporting: `<TerminalMock variant="permission">`.
2. **Rules, scopes, resolution** — allow / deny / ask; session over project over user;
   `always allow src/**.ts` writes a rule to project scope. Supporting: `<CodeBlock>` of a
   rules snippet lifted from `docs/permissions.md`.
3. **Four modes** — a `<DefinitionTable>` with rows quoted from `docs/permissions.md`:
   `default` (*Read-only tools run freely; everything else is asked about unless a rule
   already settles it.*), `acceptEdits` (*Like default, but `write`, `edit` and `multiedit`
   are also auto-approved.*), `plan` (*Only read-only tools may run; every mutating tool is
   denied outright.*), `yolo` (*Everything is auto-approved — for sandboxes and CI, not
   your laptop.*).
4. **Dry run and the shadow tree** — `--dry-run`, `/diff`, `/apply`, `/discard`. Include
   the limit inline: *`--dry-run` deliberately does not wrap `bash`, `grep` or `glob` —
   they take commands and patterns rather than a single path — so a shell command still
   reads and mutates the real tree while dry-run is active.*
5. **Hooks with veto power** and **the OS sandbox** (opt-in, confines `bash` writes to the
   workspace).
6. **Speculative approval** — while a permission prompt sits in front of you, the agent
   keeps working in a shadow overlay instead of idling.

Footer of the page: `<DocLinks>` to `/docs/permissions`, `/docs/dry-run`, `/docs/hooks`,
`/docs/speculation`, `/docs/injection-defense`, then `<CTASection>`.

### 3.4 `/features/accountability`

`h1`: **Accountability.** Lede: *A run you can reconstruct: what it was allowed to do, what
it cost, what it changed, and how to get back.*

1. **The session is a file** — `.jsonl`, header + one line per entry, `parentId` tree,
   branches stay walkable.
2. **Checkpoints and `/rewind`** — content-addressed blobs under
   `~/.arcturn/checkpoints/<sessionId>/` with an append-only manifest; `/rewind` restores
   the files changed after a turn and **forks** the conversation. **Required limit,
   verbatim in tone:** *It covers `write` and `edit`. A shell command that mutates the tree
   is not checkpointed, so `sed -i` and `rm` are invisible to `/rewind`. The conversation
   side is genuinely non-destructive; the file side is a real disk mutation.*
3. **Replay** — `arcturn replay <session>`, `-m` for another model, NDJSON per turn.
4. **Bisect** — `arcturn bisect <session> --cassette run.jsonl`, hermetic, `execute` never
   invoked. Note: *cassettes are recorded through the SDK today; there is no CLI flag yet.*
5. **Blame and provenance** — per-line turn attribution plus the evidence that turn had,
   untrusted sources marked. Opt-in via `"provenance": true` because the recording costs disk.
6. **Audit trail and cost** — append-only permission/tool trail, live spend, `--max-cost`
   aborting at the next turn boundary, including sub-agent spend.

`<DocLinks>`: `/docs/sessions`, `/docs/checkpoints`, `/docs/replay-bisect`,
`/docs/provenance`, `/docs/audit-cost`, `/docs/memory`. Then `<CTASection>`.

### 3.5 `/features/extensibility`

`h1`: **Extensibility.** Lede: *Most of what you'll want to add is a markdown file or a
config entry. The rest is a TypeScript interface.*

Sections: **MCP** (stdio + streamable HTTP; tools, resources and prompts) · **Markdown
skills** (frontmatter, `$ARGUMENTS`, `$SKILL_DIR`, no build step; plus model-invoked skills
via the `skill` tool) · **Hooks** (tool and session boundaries, veto) · **Sub-agents, plan
mode and todos** · **Agent teams and background agents** (a synchronous sub-agent, a
durable `/bg` task, a coordinated `/team`) · **Workflows** (a markdown numbered list is the
control flow) · **Custom tools and extensions** (the `Tool` interface; `.arcturn/extensions`).
Each carries a `<CodeBlock>` or config snippet taken from the matching doc.
`<DocLinks>`: `/docs/mcp`, `/docs/skills`, `/docs/skill-tool`, `/docs/hooks`,
`/docs/sub-agents`, `/docs/teams`, `/docs/workflows`, `/docs/sdk-tools`. `<CTASection>`.

### 3.6 `/features/models`

`h1`: **Models & providers.** Lede: *One streaming client, every backend — and an honest
note about which paths have actually run.*

1. **Providers** — a `<StatusTable>` (columns: Provider · How you authenticate · Status).
   Rows from `docs/providers.md`. The Status column uses `<StatusPill>` and must reflect
   the blog's disclosure: OpenAI-compatible = `Proven` (*has completed real multi-turn
   tool-calling sessions*); Anthropic / OpenAI / Google = `Unproven` (*adapter implemented,
   not yet exercised against real traffic*); Bedrock / Vertex / Azure = `Unreached`
   (*never reached its endpoint*). **The build agent must re-read `docs/providers.md`
   before shipping this table and must not upgrade any status this spec sets.**
2. **Model ids and switching** — `<provider>/<model>`, `--model`, `/model`,
   `--list-models`, `--list-providers`.
3. **Routing and failover** — per-role overrides, failover chains.
4. **Live catalog** — `/model refresh` merges newly released models without touching
   curated entries.
5. **Cost** — per-turn cost tracking, prompt caching, `--max-cost`.

`<DocLinks>`: `/docs/providers`, `/docs/model-routing`, `/docs/configuration`,
`/docs/audit-cost`. `<CTASection>`.

### 3.7 `/sdk`

`h1`: **Embed the runtime.** Lede: *`@arcturn/core` is the same event-driven agent the
`arcturn` CLI is built on — one `Agent` per session, one `AgentEvent` stream out. No
terminal required.*

Layout: hero (copy left, a large `<CodeBlock>` right on `lg:`, stacked below `lg:`) →
**What you get** (`md:grid-cols-2` of six cards: the agent loop and steering · the same
permission engine, wired from code · `JsonlSessionStore` / `MemorySessionStore`, resume,
fork, compaction · custom tools with a real `execute` contract · sub-agents and MCP
bridging · VCR record/replay and cost accounting) → **The event stream** (a
`<CodeBlock>` of NDJSON events, verbatim from `docs/getting-started.md`, plus *runs never
reject — failures arrive as events*) → **Package map** (a `<DefinitionTable>` reproducing
the README package table exactly) → `<DocLinks>` to `/docs/sdk`, `/docs/sdk-agent-options`,
`/docs/sdk-events`, `/docs/sdk-tools`, `/docs/sdk-permissions`, `/docs/sdk-sessions`,
`/docs/sdk-models`, `/docs/sdk-advanced`, `/docs/server-mode`, `/docs/architecture` →
`<CTASection>` with primary `Read the SDK docs` → `/docs/sdk`.

Every code sample on this page is copied from `content/docs/sdk*.md`. Do not invent API.

### 3.8 `/security`

The most important page on the site for the sign-off reader. Tone: plain, unhedged.

`h1`: **Security.** Lede: *Arcturn's safety features are controls with edges, and the edges
are written down. A safety feature whose limits you can't see is worse than no feature,
because you'll trust it.*

Sections:

1. **The choke point** — where enforcement happens and why there is only one path.
2. **The controls** — `md:grid-cols-2` of `<Card>`: permission engine · checkpoints ·
   dry-run overlay · OS sandbox · taint tracking · canary tokens · cost ceiling · audit
   trail. Each: what it does, in two sentences.
3. **Known limits** — a full-width `<LimitsTable>` (Control · What it does not cover), one
   row per control. Required rows include: `/rewind` does not cover shell mutations
   (`sed -i`, `rm`); `--dry-run` does not wrap `bash`, `grep` or `glob`; canary matching is
   exact substring containment, so base64 defeats it completely. Style: `--warn` left
   border, **not** a red alarm — these are disclosures, not failures.
4. **Adversarial review** — four waves, findings published rather than patched out. Name
   the classes of defect found, as the blog does: `/apply` could write outside the
   workspace through an in-workspace symlink; served sessions and sub-agents escaped the
   audit trail; the WebSocket upgrade had no `Origin` check, so any web page could drive a
   loopback server; and two features were present but unreachable. Close with: *Every fix
   landed with a regression test verified to fail against the previous behaviour first.*
5. **Reporting a vulnerability** — GitHub issues link, and *this is a pre-1.0 single-
   maintainer project; there is no SLA.* Do not promise a response time.

`<DocLinks>`: `/docs/permissions`, `/docs/injection-defense`, `/docs/dry-run`,
`/docs/audit-cost`.

### 3.9 `/terminal`

A showcase page for the TUI. `h1`: **The terminal.** Lede: *Differential rendering, a
composed frame, and a prompt that stays responsive while the model streams.*

Layout: a full-bleed `<TerminalMock size="lg">` under the lede, then an alternating
sequence of narrow copy + `<TerminalMock>` blocks, one per moment of a session: **the
prompt** · **a tool call** · **a permission ask** · **a diff** · **a sub-agent** ·
**`/rewind`**. Each mock is static HTML/CSS in `.force-dark`, `aria-hidden`, with a
visually-hidden description (§2.6). Copy describes only what the mock shows.
Close with a `<Card>` on slash commands (`/model`, `/rewind`, `/diff`, `/apply`, `/bg`,
`/team`, `/skills`) linking to the relevant docs, then `<CTASection>`.

**Rule:** these are illustrations of real output, transcribed from
`content/docs/getting-started.md` and the other docs. Do not fabricate output that the CLI
would not print. Do not show timings, token counts or dollar figures that are not in the docs.

### 3.10 `/open-source`

`h1`: **Open source.** Lede: *Apache-2.0, one maintainer, pre-1.0, no users yet. Here is
how to check every claim on this site yourself.*

1. **The licence** — Apache-2.0 for all of it; no commercial-use restriction, no
   source-available catch. Link to `LICENSE` on GitHub.
2. **Project status** — a `<StatusTable>` stating plainly: not published to npm (install
   from source) · pre-1.0, APIs may change · one maintainer · no production users · one
   proven provider path (§3.6).
3. **Verify it yourself** — a `<CodeBlock>` of the commands, with the surrounding copy
   framing them as *run these, don't take my word for it*:

   ```bash
   find packages -name "*.test.ts" | wc -l      # test files
   grep -rE "^ +(it|test)[.(]" packages | wc -l # test cases
   ls packages                                  # the package list
   ```

   **This is the only page allowed to print counts, and only with an explicit
   "as of <date>, on `main`" qualifier immediately adjacent**, because these numbers move
   with every commit (they have already drifted past the figures quoted in the blog post).
   Prefer printing no number at all and letting the command speak.
4. **Contributing** — issues and PRs on GitHub; no CLA; Node ≥ 20, pnpm ≥ 10;
   `pnpm install`, `pnpm build`, `pnpm check`, `pnpm test` (from the README).
5. **The author** — a short `<Card>`: built by Sitharaj Seenivasan, with the four Author &
   Support links (§5.3). This is in addition to the footer, not instead of it.

`<CTASection>`.

### 3.11 `/docs` and `/docs/[slug]`

**Data layer** (`web/lib/docs.ts`, built by the foundation agent, consumed by everyone):
read `content/docs/*.md` with `gray-matter`; frontmatter type
`{ title: string; description: string; section: DocSection; order: number }` where
`DocSection = "Start" | "Core concepts" | "Extend" | "Reference"`. Group by `section` in
**that fixed order** (it is not alphabetical), sort within a group by `order` **ascending
and numeric** — orders are floats (`4.65`, `8.92`, `10.5`), so never sort them as strings.
Build a flat ordered list from the grouped structure for prev/next. Render markdown with
`unified → remark-parse → remark-gfm → remark-rehype → rehype-slug →
rehype-autolink-headings → rehype-pretty-code → rehype-stringify`. Headings get ids from
`rehype-slug`; the autolink is `behavior: "append"`, an `aria-hidden` `#` link that appears
on heading hover. Collect `h2`/`h3` into a TOC during the same pass. `generateStaticParams`
returns every filename stem.

**`/docs` (index).** `h1`: **Documentation.** Lede: *Forty pages covering the CLI, the
runtime and the SDK. Start with installing it; the rest is reference.* Then one block per
section (`Start`, `Core concepts`, `Extend`, `Reference`) with the section name as `h2` and
a `sm:grid-cols-2 lg:grid-cols-3` of `<LinkCard>` (title + `description`). A prominent
`<Card variant="accent">` at the top links to Getting started.

**`/docs/[slug]` layout.**

- ≥1280px: three columns in `.container-shell` —
  `grid-cols-[16rem_minmax(0,1fr)_15rem] gap-10`. Left: sticky sidebar (`top-16`,
  `h-[calc(100vh-4rem)]`, `overflow-y-auto`, `overscroll-contain`), grouped by section,
  section labels in `eyebrow` style, items `body-sm`, active item `--text` + `--surface-card`
  + a 2px `--accent` left indicator + `aria-current="page"`. Right: `<TableOfContents>`,
  sticky, `h2` flush / `h3` indented `0.75rem`, active heading tracked by an
  `IntersectionObserver` in a `"use client"` component with `rootMargin: "0px 0px -70% 0px"`;
  it degrades to a plain link list without JS.
- 1024–1279px: sidebar + content, TOC hidden.
- <1024px: content only. The sidebar becomes a `<DocsNavDrawer>` opened by a sticky
  "Documentation" bar under the header showing the current section and page; the TOC
  becomes a collapsed `<details>` labelled "On this page" above the article.
- Article: `.container-prose`, `h1` = frontmatter `title` (display-2), then the
  `description` as a lede in `--text-muted`, then a hairline, then the rendered prose.
- Prev/next: a two-up `<PrevNext>` at the article foot from the flat ordered list; each
  card shows direction label + page title; either side may be absent (first/last).
- Below that: `<EditOnGitHub>` linking
  `https://github.com/sitharaj88/arcturn/blob/main/web/content/docs/<slug>.md`.
- Breadcrumb above `h1`: `Docs / <Section> / <Title>`, `caption`, own overflow scroll.

`metadata` per page comes from the frontmatter `title` + `description`.

### 3.12 `/blog` and `/blog/[slug]`

Same markdown pipeline; frontmatter `{ title, description, date, author }`. Sort by `date`
descending. Format dates as `20 August 2026` via
`new Intl.DateTimeFormat("en-GB", { dateStyle: "long" })` with an explicit UTC timezone, and
wrap in `<time dateTime={iso}>` — a locale-dependent or timezone-dependent format will
produce a hydration mismatch, so pin both.

**`/blog`.** `h1`: **Blog.** Lede: *Notes on building an agent harness you can audit.*
Then a single-column stack of `<PostCard>` (date + title as `h3` link + description +
author), `--width-prose`, hairline between entries. There is currently one post — the
layout must look deliberate with one entry: no empty grid cells, no "load more".

**`/blog/[slug]`.** `.container-prose`. Above `h1`: a back link `← All posts`. Header:
`h1` (display-2), then `caption` line `<time> · <author>`, then a hairline. Body uses the
same prose styles as docs. Foot: an `<AuthorCard>` (name, one line, the four Author &
Support links) and a `<CTASection variant="compact">`.

### 3.13 `/404` (`app/not-found.tsx`)

Centred, `.container-prose`, `min-h-[60vh]`, `<ArcHalo>` at 25% behind a 64px
`<StarMark>`. `h1` (display-2): **Off course.** Body: *That page isn't here. The star is
still where it was.* Buttons: `Home` (primary) · `Documentation` (ghost) · `Blog` (ghost).
Below: a small list of the four feature pages. Full header and footer render normally.
Note: with `output: "export"`, `app/not-found.tsx` emits `404.html`, which is what static
hosts serve — do not add a catch-all route.

---

## 4. Component inventory

Foundation agent builds all of these in `web/components/`, one file per component, **named
exports only**, props typed with an exported `interface`. Anything marked ⚡ is
`"use client"`; **everything else must be a server component** — do not add the directive
to a static component.

**Utility:** `web/lib/cn.ts` → `export function cn(...inputs: ClassValue[]): string` using
`clsx` + `tailwind-merge`. Every component with a `className` prop merges through `cn`.

### Layout & chrome

| Component | Props | Notes |
|---|---|---|
| `SiteHeader` | — | Sticky, blur, scroll-shadow. Composes `Logo`, `NavMenu`, `ThemeToggle`, `MobileNav`, GitHub icon link, CTA `Button`. |
| `NavMenu` ⚡ | — | Desktop nav incl. the Features dropdown. Keyboard + `Escape` + focus return per §2.6. |
| `MobileNav` ⚡ | — | <1024px drawer, focus trap, `inert` background, body scroll lock. |
| `ThemeToggle` ⚡ | — | 3-state System/Light/Dark, §2.7. |
| `SiteFooter` | — | Columns + Author & Support + legal row (§5.3). |
| `Logo` | `size?: number; showWordmark?: boolean` | `StarMark` + "arcturn" at weight 700. |
| `Container` | `size?: "prose" \| "content" \| "wide" \| "shell"; as?: ElementType` | |
| `Section` | `eyebrow?: string; title?: ReactNode; lede?: ReactNode; align?: "start" \| "center"; size?: ContainerSize; density?: "default" \| "tight"; band?: boolean; headingLevel?: 2 \| 3; id?: string` | The landing-section wrapper: rhythm, `ArcEyebrow`, heading levels. Also exports `SECTION_RHYTHM` and `SECTION_BAND` (§2.3.1) — the other two section components import them rather than restating the numbers. |
| `PageHeader` | `title: string; lede?: ReactNode; eyebrow?: string; breadcrumb?: ReactNode` | Interior-page `h1` block. |

### Primitives

| Component | Props |
|---|---|
| `Button` | `variant?: "primary" \| "ghost" \| "quiet"; size?: "sm" \| "md" \| "lg"; href?: string; external?: boolean; iconLeft?/iconRight?: ReactNode; disabled?` — renders `<Link>` when `href` is internal, `<a target="_blank" rel="noopener noreferrer">` + external icon when `external`, else `<button>`. |
| `Badge` | `variant?: "neutral" \| "accent" \| "good" \| "warn" \| "bad"; icon?: ReactNode` — pill, `caption`, hairline border, 12% tint fill. |
| `StatusPill` | `status: "proven" \| "unproven" \| "unreached" \| "planned"; label?: string` — colour **and** icon **and** word (§2.6). |
| `Card` | `variant?: "default" \| "quiet" \| "accent" \| "limit"; href?: string; className?` — `arc-corner`, hover per §2.3.4; becomes a whole-card link when `href` is set (single `<a>`, no nested interactives). |
| `FeatureCard` | `icon: LucideIcon; title: string; body: ReactNode; href: string; size?: "md" \| "lg"` |
| `LinkCard` | `title: string; body?: string; href: string; external?: boolean` |
| `CheckList` | `items: ReactNode[]` — `Check` icons in `--accent`, `list-none`. |
| `DefinitionTable` | `rows: { term: ReactNode; definition: ReactNode }[]; termHeader?: string; defHeader?: string` — responsive: table ≥768px, definition-list stack below. |
| `StatusTable` | `rows: { name: string; detail: ReactNode; status: StatusPillProps }[]` |
| `LimitsTable` | `rows: { control: string; limit: ReactNode }[]` — `--warn` left border, not red. |
| `CommandList` | `items: { command: string; body: ReactNode }[]` — mono command + prose. |
| `Prose` | `children` (or `html: string`) — the shared typographic scope (§2.2.3) used by docs, blog, and long-form marketing. **One implementation. Every long-form page uses it.** |
| `DocLinks` | `links: { href: string; title: string }[]; title?: string` — "Read the docs" block. |
| `CTASection` | `variant?: "default" \| "compact"; title?: string; lede?: string; showCommand?: boolean; command?: string; band?: boolean` — defaults to the §3.1 final-CTA copy. `compact` is the `tight` rhythm tier, not a third spacing. |
| `Reveal` ⚡ | `delay?: number; children` — the scroll-reveal wrapper, reduced-motion-aware (§2.5). |
| `AuthorCard` | — | Name, one line, the four Author & Support links. |
| `SkipLink` | — | |
| `VisuallyHidden` | `as?: ElementType; children` | |

### Code & terminal

| Component | Props |
|---|---|
| `CodeBlock` | `code: string; language?: string; filename?: string; showLineNumbers?: boolean` — build-time Shiki, language chip, `CopyButton`, own `overflow-x`. |
| `CopyButton` ⚡ | `value: string; label?: string` — `navigator.clipboard` with a `document.execCommand` fallback, 1.6s "Copied" state, `aria-live="polite"`. |
| `CommandChip` ⚡ | `command: string; caption?: ReactNode` — mono chip on a gold-tinted plate + `CopyButton`. |
| `TerminalMock` | `variant?: "session" \| "permission" \| "diff" \| "subagent" \| "rewind"; size?: "md" \| "lg"; description: string` — `.force-dark`, traffic-light chrome, mono body, CSS-only stagger, blinking cursor, `arc-corner`, `aria-hidden` + `VisuallyHidden` description (§2.6). |

### Brand

`StarMark({ size?, className? })` · `ArcEyebrow({ className? })` ·
`ArcHalo({ size?, opacity?, className? })` · `ArcRule({ className? })` — §2.4. `ArcRule` spans `.container`, matching the sections it divides; it used to span `.container-wide` and hang 80px past the copy on each side.
**All four generate SVG gradient ids with `useId()`, never `Math.random()`** (the old
site used random ids; that breaks SSR hydration and static export determinism).

### Docs & blog

`DocsSidebar` · `DocsNavDrawer` ⚡ · `TableOfContents` ⚡ · `PrevNext` · `EditOnGitHub` ·
`Breadcrumb` · `PostCard` · `PostMeta`.

### Ownership note

The foundation agent owns `app/globals.css`, `app/layout.tsx`, `lib/**` and
`components/**`. Page agents own only their own `app/**/page.tsx` and never edit shared
components — if a primitive is missing, note it in your return rather than forking one.

---

## 5. IA, navigation, URL map

### 5.1 Top nav

Left: `<Logo>` → `/`.
Centre (≥1024px): **Features** ▾ · **Docs** → `/docs` · **SDK** → `/sdk` · **Security** →
`/security` · **Blog** → `/blog`.
Right: `<ThemeToggle>` · GitHub icon link (`aria-label="Arcturn on GitHub"`, external) ·
`Button variant="primary" size="sm"` **Get started** → `/docs/getting-started`.
<1024px: logo · theme toggle · hamburger → `MobileNav` containing every item above plus the
CTA at the bottom.

**Features dropdown** — one panel, two labelled columns:

- *Capabilities*: Control `/features/control` · Accountability `/features/accountability` ·
  Extensibility `/features/extensibility` · Models & providers `/features/models` ·
  All features `/features`
- *Project*: The terminal `/terminal` · Open source `/open-source`

Each item is a title + one-line description. Panel: `--surface-raised`, `--border`,
`--radius-lg`, `--shadow-lg`, `--duration-slow` entrance.

Active state: nav item matching the current top-level route gets `--text` (vs `--text-muted`
at rest) and `aria-current="page"`.

### 5.2 Footer

Four columns ≥768px (`1.6fr 1fr 1fr 1fr`), two columns 480–767px, stacked below.

- **Column 0 (brand):** `<Logo>`, then: *An open-source coding agent you can actually
  audit — every turn checkpointed, priced and replayable.* and *Named for Arcturus, the
  star you steer by. Navigation, not autocomplete.*
- **Product:** Control · Accountability · Extensibility · Models & providers · The terminal
  · All features
- **Developers:** Documentation (`/docs`) · Getting started · SDK · Architecture
  (`/docs/architecture`) · Security · GitHub ↗ · Issues ↗
- **Project:** Open source · Blog · Why I built Arcturn (`/blog/why-arcturn`) ·
  Apache-2.0 licence ↗

### 5.3 Author & Support — mandatory, exact

Below the columns, above/beside the legal line, as a labelled row (`Author & support`):

| Label | URL |
|---|---|
| Website | `https://sitharaj.in` |
| LinkedIn | `https://www.linkedin.com/in/sitharaj08` |
| Buy me a coffee | `https://buymeacoffee.com/sitharaj88` |
| GitHub | `https://github.com/sitharaj88` |

All four are `target="_blank" rel="noopener noreferrer"`. **These four links must appear on
every page via the footer and must not be removed, reordered away, or hidden behind a
disclosure.** They also appear in `<AuthorCard>` on `/blog/[slug]` and `/open-source`.

Legal row: `© <current year> Arcturn. Licensed under Apache-2.0.` (compute the year at
build time — static export freezes it, which is fine and matches the old site) and
`Built by Sitharaj Seenivasan` → `https://sitharaj.in`.

### 5.4 URL map — every one of these must exist and must not break

| URL | Source | Notes |
|---|---|---|
| `/` | `app/page.tsx` | §3.1 |
| `/features` | `app/features/page.tsx` | §3.2 — new page, not on the old site |
| `/features/control` | `app/features/control/page.tsx` | §3.3 |
| `/features/accountability` | `app/features/accountability/page.tsx` | §3.4 |
| `/features/extensibility` | `app/features/extensibility/page.tsx` | §3.5 |
| `/features/models` | `app/features/models/page.tsx` | §3.6 |
| `/sdk` | `app/sdk/page.tsx` | §3.7 |
| `/security` | `app/security/page.tsx` | §3.8 |
| `/terminal` | `app/terminal/page.tsx` | §3.9 |
| `/open-source` | `app/open-source/page.tsx` | §3.10 |
| `/docs` | `app/docs/page.tsx` | §3.11 |
| `/docs/<slug>` | `app/docs/[slug]/page.tsx` + `generateStaticParams` | 40 pages |
| `/blog` | `app/blog/page.tsx` | §3.12 |
| `/blog/<slug>` | `app/blog/[slug]/page.tsx` + `generateStaticParams` | |
| `/hub` | `app/hub/page.tsx` | Package hub — server-rendered catalogue, one client filter island |
| `/hub/<name>` · `/hub/<name>/<item>` | `app/hub/[name]/**` + `generateStaticParams` | |
| `/builder` | `app/builder/page.tsx` | Visual workflow builder — static shell, one client island, no backend |
| `/404` | `app/not-found.tsx` → `404.html` | §3.13 |

The old site linked `/#accountability` from its footer — the home page must therefore give
the Accountability section `id="accountability"`, and likewise `id="control"`,
`id="extensibility"`, `id="models"`, `id="sdk"`, `id="open-source"`. Add
`scroll-margin-top: 5rem` to every anchor target so the sticky header doesn't cover it.

### 5.5 Metadata

`app/layout.tsx` sets `metadataBase`, `title.template = "%s — Arcturn"`,
`title.default = "Arcturn — Every turn counts."`, a shared `description`, `openGraph`
(`type: "website"`, `siteName: "Arcturn"`), `twitter: { card: "summary_large_image" }`,
and `icons`. The old site had a dynamic OG image route (`/og/[...route].ts`) — **that
cannot exist under `output: "export"`**. Ship one static `opengraph-image` in `app/`
instead (dark ground, `StarMark`, wordmark, tagline); do not attempt a runtime OG route.
Add `app/robots.ts` and `app/sitemap.ts` (both are statically exportable) covering every
URL in §5.4.

---

## 6. Definition of done

1. `npx next build` and `npx tsc --noEmit` both pass.
2. Every URL in §5.4 renders, in both themes, with no flash of the wrong theme on reload.
3. No horizontal scroll on `body` at 360px on any page.
4. Keyboard-only traversal of header, features dropdown, mobile drawer, docs sidebar, TOC
   and footer works, with a visible focus ring at all times.
5. With `prefers-reduced-motion: reduce`, every page is fully readable and nothing is stuck
   at `opacity: 0`.
6. No `any`, no default exports outside `app/**` route files, no `tailwind.config.js`, no
   new dependencies, no edits outside `web/`.
7. Every factual claim traces to `README.md` or `content/**`. The `/security` limits
   table, the landing Receipts ledger, and the `/open-source` status table are present
   and unsoftened.
8. The four Author & Support links resolve, in the footer, on every page.
