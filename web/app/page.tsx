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
import { Section } from "@/components/ui/Section";
import { TerminalMock } from "@/components/ui/TerminalMock";
import { REPO_URL } from "@/lib/utils";

const HERO_LEDE =
  "Arcturn is an open-source terminal coding agent and the TypeScript harness underneath it. " +
  "Every tool call clears a permission engine before it runs. Every edit is snapshotted before " +
  "it lands. Every session is a file on disk you can replay, bisect and blame.";

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
          <div className="grid items-center gap-12 pb-14 pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pb-20 lg:pt-24">
            <div className="min-w-0">
              <Badge variant="accent">Open source · Apache-2.0 · TypeScript</Badge>
              <h1 className="mt-5 text-display-1 text-balance text-text">
                The coding agent you can <span className="text-gradient">hold accountable</span>.
              </h1>
              <p className="mt-6 max-w-[60ch] text-lede text-muted">{HERO_LEDE}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button href="/docs/getting-started" size="lg">
                  Get started
                </Button>
                <Button href="/blog/why-arcturn" variant="ghost" size="lg">
                  Why I built it
                </Button>
              </div>
              <div className="mt-8 max-w-lg">
                <CommandChip
                  command="git clone https://github.com/sitharaj88/arcturn"
                  caption={
                    <>
                      Not on npm yet — clone and build. See{" "}
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
              <TerminalMock
                variant="session"
                size="lg"
                className="relative"
                description="An arcturn session: a prompt to add input validation, then read, grep and edit tool calls, LSP diagnostics, and a running cost against a session budget."
              />
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
                <h3 className="text-h4 text-text">{card.title}</h3>
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
                className="h-full"
              />
            </Reveal>
          ))}
        </div>
      </Section>

      <ArcRule />

      {/* ── Control ──────────────────────────────────────────────────── */}
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
          deny or ask; scopes resolve session over project over user. Read-only tools pass. Anything
          that reaches the ask step with no permission requester configured resolves to deny, not
          “assume it’s fine.”
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
        <SectionLink href="/docs/permissions">How permissions resolve</SectionLink>
      </SplitSection>

      <ArcRule />

      {/* ── Accountability ───────────────────────────────────────────── */}
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
          Every session is a <Code>.jsonl</Code> file — a header line, then one JSON line per entry,
          appended in order. The structure is a tree: each entry carries a <Code>parentId</Code>, so
          resuming from three turns ago and trying a different approach starts a branch instead of
          overwriting what came after. Both branches stay walkable.
        </p>
        <p className="text-body text-muted">
          Underneath, every <Code>write</Code> and <Code>edit</Code> snapshots the file’s prior
          content first, so <Code>/rewind</Code> can restore it.
        </p>
        <SectionLink href="/features/accountability">Replay, bisect and blame</SectionLink>
      </SplitSection>

      <ArcRule />

      {/* ── Extensibility ────────────────────────────────────────────── */}
      <Section
        id="extensibility"
        eyebrow="Extend"
        title="Add a capability without recompiling anything."
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
        <div className="flex flex-col gap-5">
          <CodeBlock code={MODEL_COMMANDS} language="bash" />
          <p className="max-w-[68ch] text-caption text-faint">
            Only the OpenAI-compatible path has completed real multi-turn tool-calling sessions
            against a live endpoint. The first-party Anthropic, OpenAI and Google adapters are
            unproven against real traffic, and Bedrock, Vertex and Azure have not reached their
            endpoints at all.
          </p>
          <SectionLink href="/features/models">Providers and status</SectionLink>
        </div>
      </Section>

      <ArcRule />

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
      <Section id="open-source" eyebrow="Open source" title="Apache-2.0, and checkable.">
        <div className="flex flex-col gap-6">
          <p className="max-w-[68ch] text-body text-muted">
            No commercial-use restriction, no source-available licence with a catch in clause four.
            The codebase has been through four waves of adversarial review, and the findings are on
            the security page rather than quietly patched out — including two features that turned
            out to be present but unreachable.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button href={REPO_URL} external variant="ghost">
              On GitHub
            </Button>
            <Button href="/open-source" variant="quiet">
              How to verify it
            </Button>
          </div>
        </div>
      </Section>

      <CTASection />
    </>
  );
}
