import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Code, HonestyBand, PILLARS, SectionLink, SplitSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { ArcHalo } from "@/components/ui/ArcHalo";
import { ArcRule } from "@/components/ui/ArcRule";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CheckList } from "@/components/ui/CheckList";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CommandChip } from "@/components/ui/CommandChip";
import { CommandList } from "@/components/ui/CommandList";
import { Container } from "@/components/ui/Container";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { LinkCard } from "@/components/ui/LinkCard";
import { Reveal } from "@/components/ui/Reveal";
import { SECTION_BAND, Section } from "@/components/ui/Section";
import { StatusTable } from "@/components/ui/StatusTable";
import { TerminalMock } from "@/components/ui/TerminalMock";
import { TerminalPlayer } from "@/components/ui/TerminalPlayer";
import { PROVEN_PROVIDERS, PROVIDER_ROWS, UNREACHED_PROVIDERS } from "@/lib/providers";
import { REPO_URL } from "@/lib/utils";

const HERO_INTRO =
  "Arcturn is an open-source terminal coding agent and the TypeScript harness underneath it.";

/**
 * The three guarantees that used to be sentences two, three and four of one
 * four-sentence lede. Nobody reads the fourth sentence of a hero paragraph, and
 * each of these is a claim with a page that proves it — so each gets a row and
 * a link instead of a comma.
 */
const HERO_GUARANTEES = [
  {
    term: "Every tool call",
    rest: "clears a permission engine before it runs.",
    href: "/docs/permissions",
  },
  {
    term: "Every edit",
    rest: "is snapshotted before it lands.",
    href: "/docs/checkpoints",
  },
  {
    term: "Every session",
    rest: "is a file on disk you can replay, bisect and blame.",
    href: "/docs/sessions",
  },
];

/**
 * The search-result and social-card description. Composed from the same strings
 * the hero renders, so the summary a reader sees before they arrive cannot
 * drift from the one they see when they do.
 */
const HERO_LEDE = [HERO_INTRO, ...HERO_GUARANTEES.map((item) => `${item.term} ${item.rest}`)].join(
  " ",
);

export const metadata: Metadata = {
  title: { absolute: "Arcturn — Every turn counts." },
  description: HERO_LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Arcturn — Every turn counts.",
    description: HERO_LEDE,
    url: "/",
  },
};

const GAP_CARDS = [
  {
    key: "diff",
    title: (
      <>
        <Code>git diff</Code> is the whole forensic story.
      </>
    ),
    body: "Forty tool calls leave the residue of maybe twelve, in a flat pile, with no indication of which turn produced which hunk.",
  },
  {
    key: "shell",
    title: <>The shell commands leave no trace at all.</>,
    body: "Fetches, background tasks, and the sub-agent that ran for ninety seconds and cost more than the rest of the session.",
  },
  {
    key: "undo",
    title: (
      <>
        “Undo” means <Code>git checkout</Code> plus remembering.
      </>
    ),
    body: "The conversation that produced the change isn’t in version control, so going back means losing it.",
  },
];

const EXTEND_CARDS = [
  {
    title: "MCP",
    body: "Connect stdio and streamable-HTTP servers; their tools, resources and prompts just work.",
    href: "/docs/mcp",
  },
  {
    title: "Markdown skills",
    body: "Drop a file in .arcturn/skills and it’s a slash command — frontmatter, $ARGUMENTS, $SKILL_DIR, no build step.",
    href: "/docs/skills",
  },
  {
    title: "Hooks",
    body: "Shell commands at tool and session boundaries, with veto power over a preToolUse call.",
    href: "/docs/hooks",
  },
  {
    title: "Sub-agents",
    body: "Scoped child agents with their own tools and models; their events stream back into the parent session.",
    href: "/docs/sub-agents",
  },
  {
    title: "Workflows",
    body: "A markdown numbered list is the control flow; the model fills in only the content.",
    href: "/docs/workflows",
  },
  {
    title: "Custom tools",
    body: "The Tool interface in TypeScript when a markdown file isn’t enough.",
    href: "/docs/sdk-tools",
  },
];

const MODEL_COMMANDS = `arcturn --model anthropic/claude-sonnet-4-5
arcturn --model openai/gpt-5.1
arcturn --model google/gemini-3-pro-preview`;

/** Verbatim from `content/docs/sdk.md` — the SDK page owns no invented API. */
const SDK_SAMPLE = `import { createAgent } from "@arcturn/core";
import { createClient, requireModel } from "@arcturn/ai";
import { createDefaultTools } from "@arcturn/tools";

const llm = createClient(); // resolves API keys from the environment
const { tools } = createDefaultTools({ cwd: process.cwd() });

const agent = createAgent({
  llm,
  model: requireModel("anthropic/claude-sonnet-4-5"),
  systemPrompt: "You are a focused, careful coding agent.",
  tools,
  cwd: process.cwd(),
  sessionDir: ".arcturn/sessions", // omit for an unpersisted, in-memory agent
  permissions: { mode: "default" },
});

agent.subscribe((event) => {
  if (event.type === "toolStart") console.log("→", event.toolName);
});

await agent.prompt("Add input validation to the signup handler");
console.log(agent.finalText());`;

export default function HomePage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <Container size="wide" className="relative">
          {/*
            `items-center`, re-judged against the player's real height: the
            transcript is a fixed 491px at `lg`, and the copy column runs
            roughly 700px, so aligning to the start would hang 200px of void
            under the terminal. Centring puts the frame's optical middle
            against the middle of the claim it is evidence for.
          */}
          <div className="grid items-center gap-12 pb-14 pt-16 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-16 lg:pb-20 lg:pt-24">
            <div className="min-w-0">
              <Badge variant="accent">Open source · Apache-2.0 · TypeScript</Badge>
              <h1 className="mt-5 text-display-1 text-balance text-text">
                The coding agent you can <span className="text-gradient">hold accountable</span>.
              </h1>
              <p className="mt-6 max-w-(--measure-lede) text-lede text-muted">{HERO_INTRO}</p>

              {/*
                Three claims, three ways to check them. Each row is the whole
                link so the target clears 44px, and the arrow moves on the
                `translate` property because that is what Tailwind v4 compiles
                `translate-x-0.5` to (§2.5).
              */}
              <ul className="mt-7 flex flex-col border-t border-default">
                {HERO_GUARANTEES.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="group flex min-h-11 items-center gap-3 border-b border-default py-2.5 text-body-sm"
                    >
                      <span className="min-w-0 wrap-anywhere">
                        <span className="font-medium text-text">{item.term}</span>{" "}
                        <span className="text-muted">{item.rest}</span>
                      </span>
                      <ArrowRight
                        aria-hidden="true"
                        className="ml-auto size-4 shrink-0 text-faint transition-[translate,color] dur-fast ease-out group-hover:translate-x-0.5 group-hover:text-accent"
                      />
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex flex-wrap gap-3">
                {/* §2.3.4 — the one glowing CTA on the page. */}
                <Button href="/docs/getting-started" size="lg" className="elev-glow">
                  Get started
                </Button>
                <Button href="/blog/why-arcturn" variant="ghost" size="lg">
                  Why I built it
                </Button>
              </div>
              <div className="mt-8 max-w-lg">
                <CommandChip
                  command="npm install -g arcturn"
                  caption={
                    <>
                      Node 20 or newer. See{" "}
                      <Link
                        href="/docs/getting-started"
                        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
                      >
                        Getting started
                      </Link>
                      .
                    </>
                  }
                />
              </div>
            </div>

            <div className="relative min-w-0">
              <ArcHalo size={760} opacity={0.5} className="-top-56 right-[-18%] hidden lg:block" />
              <ArcHalo size={440} opacity={0.4} className="-top-24 right-[-24%] lg:hidden" />
              {/*
                The hero plays the session instead of posing as one: it stops at
                the permission gate and waits. A still of a gate and an enforced
                gate look identical, which is exactly the claim this page is
                making — so the reader answers it themselves. The script,
                the transcript and the reduced-motion frame all live in the
                component; it takes no copy from here by design.
              */}
              <TerminalPlayer size="lg" glow className="relative" />
            </div>
          </div>
        </Container>
      </section>

      <HonestyBand />

      {/* ── The gap ──────────────────────────────────────────────────── */}
      <Section
        eyebrow="The problem"
        title="Capability raced ahead of accountability."
        lede="The models write the code — that question is settled. The one I actually have is whether I can let an agent run, and, twenty minutes later, what exactly it did."
      >
        <div className="grid gap-5 md:grid-cols-3 md:gap-6">
          {GAP_CARDS.map((card, index) => (
            <Reveal key={card.key} delay={index * 0.06}>
              <Card variant="quiet" className="h-full">
                <h3 className="text-h3 text-text">{card.title}</h3>
                <p className="mt-2 text-body-sm text-muted">{card.body}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      <ArcRule />

      {/* ── Four pillars ─────────────────────────────────────────────── */}
      <Section
        eyebrow="What’s different"
        title="Four things Arcturn does that a capable agent still doesn’t."
      >
        <div className="grid gap-5 md:grid-cols-2 md:gap-6">
          {PILLARS.map((pillar, index) => (
            <Reveal key={pillar.href} delay={index * 0.06}>
              <FeatureCard
                icon={pillar.icon}
                title={pillar.title}
                body={pillar.body}
                href={pillar.href}
                size="lg"
                className="h-full"
              />
            </Reveal>
          ))}
        </div>
      </Section>

      {/*
        One band, two beats (§2.3.1). Control and Accountability are a single
        demonstration — the gate, then the receipt the gate leaves — so they
        share one raised ground and nothing divides them. `SECTION_BAND` is
        lifted onto this wrapper rather than passed to each section because
        `band` on both would draw the hairline between them twice and split the
        pair back into two. The band's own `border-y` is the break at each end,
        which is why the `<ArcRule />` that used to sit either side is gone.
      */}
      <div className={SECTION_BAND}>
        {/* ── Control ────────────────────────────────────────────────── */}
        <SplitSection
          id="control"
          eyebrow="Control"
          title="Decide once, at the choke point."
          media={
            <TerminalMock
              variant="permission"
              description="A permission prompt in an arcturn session: editing src/routes/signup.ts requires approval, with allow, deny, and always-allow for src/**.ts offered."
            />
          }
        >
          <p className="text-body text-muted">
            The runtime’s tool dispatcher checks the permission engine and returns a denial before a
            tool’s <Code>execute</Code> is ever reached — there is no second path. Rules are allow,
            deny or ask; scopes resolve session over project over user. Read-only tools pass.
            Anything that reaches the ask step with no permission requester configured resolves to
            deny, not “assume it’s fine.”
          </p>
          <CheckList
            items={[
              <>
                Four modes — <Code>default</Code>, <Code>acceptEdits</Code>, <Code>plan</Code>,{" "}
                <Code>yolo</Code>
              </>,
              <>
                <Code>--dry-run</Code> sends file mutations to a shadow tree for <Code>/diff</Code>{" "}
                before <Code>/apply</Code>
              </>,
              <>
                Lifecycle hooks can veto a <Code>preToolUse</Code> call
              </>,
              <>
                An opt-in OS sandbox confines <Code>bash</Code> writes to the workspace
              </>,
            ]}
          />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <SectionLink href="/docs/permissions">How permissions resolve</SectionLink>
            <SectionLink href="/terminal">See a whole session</SectionLink>
          </div>
        </SplitSection>

        {/* ── Accountability ─────────────────────────────────────────── */}
        <SplitSection
          id="accountability"
          eyebrow="Accountability"
          title="The session is the artifact."
          reverse
          media={
            <CommandList
              items={[
                {
                  command: "arcturn replay <session>",
                  body: "Re-runs the original prompts against the same model or another one, emitting NDJSON per turn, so you can diff two runs mechanically.",
                },
                {
                  command: "arcturn bisect <session>",
                  body: "Binary-searches those prompts for the turn where behaviour diverged, replaying a recorded cassette hermetically: no provider, no network.",
                },
                {
                  command: "arcturn blame <file>",
                  body: "Per line, which turn wrote it and what evidence that turn had: files read, pages fetched, commands run, with anything from a fetch or an MCP server marked untrusted.",
                },
              ]}
            />
          }
        >
          <p className="text-body text-muted">
            Every session is a <Code>.jsonl</Code> file — a header line, then one JSON line per
            entry, appended in order. The structure is a tree: each entry carries a{" "}
            <Code>parentId</Code>, so resuming from three turns ago and trying a different approach
            starts a branch instead of overwriting what came after. Both branches stay walkable.
          </p>
          <p className="text-body text-muted">
            Underneath, every <Code>write</Code> and <Code>edit</Code> snapshots the file’s prior
            content first, so <Code>/rewind</Code> can restore it.
          </p>
          <SectionLink href="/features/accountability">Replay, bisect and blame</SectionLink>
        </SplitSection>
      </div>

      {/* ── Extensibility ────────────────────────────────────────────── */}
      <Section
        id="extensibility"
        eyebrow="Extend"
        title="Add a capability without recompiling anything."
        density="tight"
      >
        <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3 md:gap-6">
          {EXTEND_CARDS.map((card, index) => (
            <Reveal key={card.href} delay={(index % 3) * 0.06}>
              <LinkCard title={card.title} body={card.body} href={card.href} />
            </Reveal>
          ))}
        </div>
      </Section>

      <ArcRule />

      {/* ── Models ───────────────────────────────────────────────────── */}
      <Section
        id="models"
        eyebrow="Models"
        title="Bring your own provider."
        lede={
          <>
            One interface across Anthropic, OpenAI and every OpenAI-compatible endpoint, Google
            Gemini, Bedrock, Vertex and Azure — streaming, tool calls, thinking, prompt caching and
            cost tracking included. Point <Code>--model</Code> at{" "}
            <Code>&lt;provider&gt;/&lt;model&gt;</Code>, route different roles to different models,
            or set a failover chain.
          </>
        }
      >
        <CodeBlock code={MODEL_COMMANDS} language="bash" />
      </Section>

      {/* ── Receipts ─────────────────────────────────────────────────── */}
      {/*
        The status of every provider path used to be a 13px footnote under the
        code block above, which is the typographic size of an apology. It is the
        most checkable thing on the page, so it takes a beat of its own, on the
        band, at full size. Counts come from the ledger itself — nothing here is
        a number somebody typed.
      */}
      <Section
        id="receipts"
        band
        eyebrow="Receipts"
        title="What has actually run, and what hasn’t."
        lede={
          <>
            {PROVEN_PROVIDERS} of the {PROVIDER_ROWS.length} provider paths have completed real
            multi-turn tool-calling sessions against a live endpoint. Another {UNREACHED_PROVIDERS}{" "}
            have never reached their endpoints at all. Which is which is in the table, not in a
            footnote.
          </>
        }
      >
        <Reveal>
          <div className="flex flex-col gap-8">
            <StatusTable rows={PROVIDER_ROWS} />
            <div className="flex flex-col gap-4">
              <p className="max-w-(--measure-body) text-body text-muted">
                Four waves of adversarial review went at the seams. They found <Code>/apply</Code>{" "}
                writing outside the workspace through an in-workspace symlink, served sessions and
                sub-agents escaping the audit trail entirely, a WebSocket upgrade with no{" "}
                <Code>Origin</Code> check, and two features that were present but unreachable. All
                four are{" "}
                <Link
                  href="/security#adversarial-review"
                  className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
                >
                  written up on the security page
                </Link>{" "}
                rather than quietly patched out.
              </p>
              <p className="max-w-(--measure-body) text-body text-text">
                Every fix landed with a regression test verified to fail against the previous
                behaviour first.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <SectionLink href="/features/models">Providers and status</SectionLink>
              <SectionLink href="/security">Every known limit</SectionLink>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ── SDK ──────────────────────────────────────────────────────── */}
      <Section
        id="sdk"
        eyebrow="Embed it"
        title="The same runtime, without a terminal in front of it."
        lede={
          <>
            <Code>@arcturn/core</Code> is what the CLI is built on. One <Code>Agent</Code> per
            session, one <Code>AgentEvent</Code> stream out — the same events the CLI emits with{" "}
            <Code>--output-format json</Code>.
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <CodeBlock code={SDK_SAMPLE} language="ts" filename="agent.ts" />
          <SectionLink href="/sdk">Embedding with the SDK</SectionLink>
        </div>
      </Section>

      <ArcRule />

      {/* ── Open source ──────────────────────────────────────────────── */}
      <Section
        id="open-source"
        eyebrow="Open source"
        title="Apache-2.0, and checkable."
        density="tight"
      >
        <div className="flex flex-col gap-6">
          <p className="max-w-(--measure-body) text-body text-muted">
            No commercial-use restriction, no source-available licence with a catch in clause four.
            One repository holds the CLI, the runtime, the harness and the regression tests behind
            the findings above — and the commands that check them are written down rather than
            described.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button href={REPO_URL} external variant="ghost">
              On GitHub
            </Button>
            <Button href="/open-source" variant="quiet">
              How to verify it
            </Button>
            <Button href="/security" variant="quiet">
              Read the limits
            </Button>
          </div>
        </div>
      </Section>

      <CTASection />
    </>
  );
}
