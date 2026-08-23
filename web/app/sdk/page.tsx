import { Boxes, CircleDollarSign, GitBranch, Radio, ShieldCheck, Wrench } from "lucide-react";
import type { Metadata } from "next";
import { Code } from "@/components/marketing";
import { ArcRule } from "@/components/ui/ArcRule";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DefinitionTable } from "@/components/ui/DefinitionTable";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { Section } from "@/components/ui/Section";

const LEDE =
  "@arcturn/core is the same event-driven agent the arcturn CLI is built on — one Agent per " +
  "session, one AgentEvent stream out. No terminal required.";

export const metadata: Metadata = {
  title: "Embed the runtime",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Embed the runtime — Arcturn",
    description: LEDE,
    url: "/sdk",
  },
};

/** Verbatim from `content/docs/sdk.md`. Do not invent API surface here. */
const AGENT_SAMPLE = `import { createAgent } from "@arcturn/core";
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

await agent.prompt("Add input validation to the signup handler");
console.log(agent.finalText());`;

/** Verbatim from `content/docs/sdk-events.md`. */
const SUBSCRIBE_SAMPLE = `const off = agent.subscribe((event) => {
  if (event.type === "toolEnd") {
    console.log(event.result.isError ? "✗" : "✓", event.toolCallId);
  }
});
// off() to unsubscribe

agent.on("runEnd", (event) => {
  switch (event.reason) {
    case "completed":
      break; // normal
    case "aborted":
      break; // agent.abort() was called, or the external signal fired
    case "error":
      console.error(event.errorMessage); // model, provider, or a thrown hook
      break;
  }
});`;

/** Verbatim from `content/docs/getting-started.md` — the CLI emits these too. */
const NDJSON_SAMPLE = `{"type":"turnStart","turn":1}
{"type":"toolCallStart","toolCallId":"tc_1","toolName":"grep","input":{"pattern":"TODO"}}
{"type":"toolCallEnd","toolCallId":"tc_1","result":{"content":[{"type":"text","text":"…"}]}}
{"type":"runEnd","reason":"completed"}`;

const CAPABILITIES = [
  {
    icon: Radio,
    title: "The agent loop and steering",
    body: "One Agent per session, options in and events out. agent.prompt() resolves when the model stops calling tools; steer() injects text mid-run.",
  },
  {
    icon: ShieldCheck,
    title: "The same permission engine",
    body: "PermissionEngine with rules, scopes and modes, wired from code — plus a PermissionRequester callback for your own UI, and the plan-mode exit gate.",
  },
  {
    icon: GitBranch,
    title: "Sessions that branch",
    body: "JsonlSessionStore or MemorySessionStore behind one SessionStore interface: resume a branch, fork from an older entry, force compaction.",
  },
  {
    icon: Wrench,
    title: "Custom tools",
    body: "A JSON-Schema definition and an execute contract, with an abort signal, a permission callback and an incremental progress channel in context.",
  },
  {
    icon: Boxes,
    title: "Sub-agents and MCP bridging",
    body: "Delegate to child agents whose whole event stream re-publishes on the parent, and bridge MCP server tools into ordinary Tool objects.",
  },
  {
    icon: CircleDollarSign,
    title: "VCR record/replay and cost",
    body: "Record a cassette of stream events and tool results, replay it hermetically, and read per-turn usage and cost off the same stream.",
  },
];

const PACKAGE_ROWS = [
  {
    term: <Code>@arcturn/types</Code>,
    definition:
      "Zero-dependency shared contracts (messages, events, tools, permissions, sessions, protocol)",
  },
  {
    term: <Code>@arcturn/ai</Code>,
    definition: "Unified multi-provider LLM streaming client with model catalog and retry",
  },
  {
    term: <Code>@arcturn/core</Code>,
    definition:
      "Agent runtime: event loop, steering, sessions, compaction, permissions, sub-agents",
  },
  {
    term: <Code>@arcturn/tools</Code>,
    definition: "Built-in tools: read, write, edit, bash (+background), grep, glob, ls, fetch",
  },
  { term: <Code>@arcturn/mcp</Code>, definition: "Model Context Protocol client bridge" },
  {
    term: <Code>@arcturn/tui</Code>,
    definition: "Terminal UI library with differential rendering",
  },
  {
    term: <Code>@arcturn/index</Code>,
    definition: "Token-optimized code index and BM25 semantic search",
  },
  { term: <Code>@arcturn/protocol</Code>, definition: "NDJSON wire protocol for server mode" },
  {
    term: <Code>@arcturn/server</Code>,
    definition: "WebSocket server exposing agent sessions to remote clients",
  },
  {
    term: <Code>@arcturn/evals</Code>,
    definition: "Task-level eval harness: real coding tasks with programmatic assertions",
  },
  {
    term: <Code>arcturn</Code>,
    definition: "The interactive coding agent, workflow engine, and agent-org runtime",
  },
];

export default function SdkPage() {
  return (
    <>
      <section className="pb-4 pt-16 md:pt-20">
        <Container>
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
            <div className="min-w-0">
              <PageHeader
                eyebrow="Embed it"
                title="Embed the runtime"
                lede={
                  <>
                    <Code>@arcturn/core</Code> is the same event-driven agent the{" "}
                    <Code>arcturn</Code> CLI is built on — one <Code>Agent</Code> per session, one{" "}
                    <Code>AgentEvent</Code> stream out. No terminal required.
                  </>
                }
              >
                <div className="flex flex-wrap gap-3">
                  <Button href="/docs/sdk">Read the SDK docs</Button>
                  <Button href="/docs/architecture" variant="ghost">
                    Architecture
                  </Button>
                </div>
              </PageHeader>
            </div>
            <Reveal delay={0.06} className="min-w-0">
              <CodeBlock code={AGENT_SAMPLE} language="ts" filename="agent.ts" />
            </Reveal>
          </div>
        </Container>
      </section>

      <Section
        eyebrow="What you get"
        title="Everything the terminal agent has, as a library."
        lede="There is no separate embedding API. The TUI, the HTTP server and --output-format json are all just different consumers of the same Agent."
      >
        <div className="grid gap-5 md:grid-cols-2 md:gap-6">
          {CAPABILITIES.map((item, index) => {
            const Icon = item.icon;
            return (
              <Reveal key={item.title} delay={(index % 2) * 0.06}>
                <Card className="h-full">
                  <span
                    aria-hidden="true"
                    className="inline-flex size-10 items-center justify-center rounded-md border border-accent-edge bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-accent"
                  >
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-4 text-h4 text-text">{item.title}</h3>
                  <p className="mt-2 text-body-sm text-muted">{item.body}</p>
                </Card>
              </Reveal>
            );
          })}
        </div>
      </Section>

      <ArcRule />

      <Section
        eyebrow="The event stream"
        title="One subscription, every event."
        lede="Subscribe once and you have what the TUI renders, what the server forwards, and what the CLI prints as NDJSON — the same union, in the same order."
      >
        <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
          {/* `min-w-0` is load-bearing: a grid item's automatic minimum size is
              its content's min-content, and a code sample's longest line is
              wider than a phone. Without it these two items grew to the NDJSON
              sample's 832px and dragged the whole page to 852px at 360 —
              every paragraph on the page clipped mid-word. The hero grid and
              SplitSection already carry it; this grid just never did. */}
          <Reveal className="min-w-0">
            <CodeBlock code={SUBSCRIBE_SAMPLE} language="ts" />
          </Reveal>
          <Reveal delay={0.06} className="min-w-0">
            <CodeBlock
              code={NDJSON_SAMPLE}
              language="json"
              filename="arcturn -p '…' --output-format json"
            />
          </Reveal>
        </div>
        <p className="mt-6 max-w-[68ch] text-body-sm text-muted">
          Runs never reject. <Code>agent.prompt()</Code> resolves when the model stops calling
          tools, the run is aborted, or a runtime error occurs — the outcome always arrives as a
          terminal <Code>runEnd</Code> event instead, so failure handling lives in one place.
          Listener exceptions are swallowed by the agent: one bad subscriber can never break a run.
        </p>
      </Section>

      <ArcRule />

      <Section
        eyebrow="Package map"
        title="Eleven packages, split by concern."
        lede="The runtime is split by concern and each piece has its own dependency surface — @arcturn/types, core, index and protocol carry no external runtime dependencies at all."
      >
        <DefinitionTable rows={PACKAGE_ROWS} termHeader="Package" defHeader="What it is" />
      </Section>

      <Container className="pb-16 md:pb-20">
        <DocLinks
          links={[
            { href: "/docs/sdk", title: "Embedding with the SDK" },
            { href: "/docs/sdk-agent-options", title: "Agent options reference" },
            { href: "/docs/sdk-events", title: "Events reference" },
            { href: "/docs/sdk-tools", title: "Custom tools" },
            { href: "/docs/sdk-permissions", title: "Permissions from the SDK" },
            { href: "/docs/sdk-sessions", title: "Sessions & persistence from the SDK" },
            { href: "/docs/sdk-models", title: "Models & providers from the SDK" },
            { href: "/docs/sdk-advanced", title: "Advanced: sub-agents, MCP, VCR, hooks" },
            { href: "/docs/server-mode", title: "Server mode" },
            { href: "/docs/architecture", title: "Architecture" },
          ]}
        />
      </Container>

      <section className="py-20 md:py-24">
        <Container size="prose" className="flex flex-col items-center text-center">
          <h2 className="text-h2 text-balance text-text">Every turn counts.</h2>
          <p className="mt-4 max-w-[56ch] text-lede text-muted">
            The SDK docs start where this page stops: every option, every event, and a worked custom
            tool.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button href="/docs/sdk" size="lg">
              Read the SDK docs
            </Button>
            <Button href="/docs/getting-started" variant="ghost" size="lg">
              Get started
            </Button>
          </div>
        </Container>
      </section>
    </>
  );
}
