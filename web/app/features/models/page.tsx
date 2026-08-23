import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { StatusTable } from "@/components/ui/StatusTable";
import { PROVIDER_ROWS } from "@/lib/providers";

const LEDE =
  "One streaming client, every backend — and an honest note about which paths have actually run.";

export const metadata: Metadata = {
  title: "Models & providers",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Models & providers — Arcturn",
    description: LEDE,
    url: "/features/models",
  },
};

const MODEL_COMMANDS = `arcturn --model anthropic/claude-sonnet-4-5
arcturn --model openai/gpt-5.1
arcturn --model google/gemini-3-pro-preview

arcturn --list-models        # the catalog, then exit
arcturn --list-providers     # every provider and preset endpoint`;

const ROUTER_TABLE = `main         the main conversation loop
subagent     delegated sub-agent work — sub-agents, scouts and /team members
compaction   summarizing history when the context window fills — accepted in config, reserved
title        session-title suggestions — reserved; today's title is derived from the task text`;

export default function ModelsPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Capabilities" title="Models & providers" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection
            id="providers"
            title="Providers"
            media={
              <div className="flex flex-col gap-5">
                <StatusTable rows={PROVIDER_ROWS} />
                <p className="max-w-[68ch] text-caption text-faint">
                  Status means exactly what it says. <em>Proven</em> is a real request to a real
                  endpoint, correct across streaming, a tool call whose result is fed back and
                  answered on a second turn, and cost accounting that matches the published rates.
                  Six paths clear that bar: first-party Anthropic, Google, and OpenAI on both its
                  Chat Completions and Responses surfaces, plus both compatibility adapters.
                  Bedrock, Vertex and Azure have never reached their endpoints at all. Each
                  compatibility adapter was verified against one implementation of its protocol —{" "}
                  <Code>openai-compatible</Code> against Z.AI, <Code>anthropic-compatible</Code>{" "}
                  against a canonical Messages API — which proves the adapter, not any particular
                  third-party service.
                </p>
                <p className="max-w-[68ch] text-caption text-faint">
                  The distinction is drawn because it earned itself. Each of those live runs found a
                  bug the test suite could not: a <Code>--print</Code> that hung forever on the
                  inherited stdin every CI runner supplies, Gemini rejecting every second turn of
                  tool use over a dropped signature, and a Responses adapter that was registered and
                  documented but had no catalog entry, so nobody could select it. Three providers,
                  three bugs, all in code with passing tests.
                </p>
              </div>
            }
          >
            <p>
              Arcturn drives every model through a single client interface, so a provider change is
              a <Code>--model</Code> flag rather than a code change. Adapters register themselves
              into a provider registry, which is why adding a backend never touches dispatch code.
            </p>
            <p>
              The last two rows matter more than they look: most third-party inference services
              speak one of those two protocols, so Arcturn reaches them without a bespoke adapter
              each. Endpoint presets ship as remembered{" "}
              <Code>{"{ baseUrl, apiKeyEnv, protocol }"}</Code> triples — run{" "}
              <Code>arcturn --list-providers</Code> for the current set. A preset is a convenience,
              not a gate: any endpoint works by URL without one.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="switching"
            title="Model ids and switching"
            media={<CodeBlock code={MODEL_COMMANDS} language="bash" />}
          >
            <p>
              Model ids are <Code>&lt;provider&gt;/&lt;model&gt;</Code>. Pass one with{" "}
              <Code>--model</Code>, or switch mid-session with <Code>/model &lt;id&gt;</Code>. Model
              names pass through verbatim, so anything the endpoint serves works.
            </p>
            <p>
              A bare wire model name resolves too when it is unambiguous across the catalog, and a
              miss triggers the extended preset table to register itself once before retrying — so a
              fresh process never pays for the whole table unless something needs it.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="routing"
            title="Routing and failover"
            media={<CodeBlock code={ROUTER_TABLE} language="text" />}
          >
            <p>
              Two of the four route kinds reach a live call site today: <Code>main</Code> for the
              conversation loop, and <Code>subagent</Code> for delegated work — sub-agents, scouts
              and <Code>/team</Code> members alike — so a mechanical subtask need not run on the
              model steering the session. <Code>compaction</Code> and <Code>title</Code> are
              accepted in config and reserved; a session title is derived from the task text
              directly today and makes no model call at all. A missing route falls back to whatever{" "}
              <Code>main</Code> resolved to, and a bad id is caught rather than thrown — the kind
              falls back and records a warning, because a stale model id in a config file must never
              be the reason Arcturn fails to start.
            </p>
            <p>
              A model string can also be an array, which builds a failover chain. The rule that
              matters: failover only happens <em>before</em> output starts. Once a single delta
              reaches the consumer the turn is committed to that model, because splicing two
              half-answers together would corrupt the message. Only transient errors — rate limits,
              overload, network — trigger a switch; a bad key or a user abort fails identically on
              every link.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="catalog" title="Live catalog">
            <p>
              The curated catalog is hand-maintained, which means it goes stale the moment a
              provider ships a new generation. <Code>/model refresh</Code> queries each preset’s own
              list-models endpoint — for whichever presets already have a key set — and registers
              anything new it finds without ever overwriting a curated entry.
            </p>
            <p>
              Results are cached at <Code>~/.arcturn/live-models.json</Code> for 24 hours. A model
              discovered this way gets conservative defaults until a curated entry supersedes it,
              and a preset whose refresh fails falls back to its last cached result rather than
              dropping its models for that round.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="cost" title="Cost">
            <p>
              Costs are tracked per request whenever a model’s pricing is known. Where a price could
              not be sourced confidently it is omitted rather than guessed, so the cost field is
              simply absent instead of quietly wrong.
            </p>
            <p>
              Prompt caching is supported through the same interface, and <Code>--max-cost</Code>{" "}
              turns live spend into an enforcement mechanism: the run is aborted at the next turn
              boundary once cumulative cost reaches the ceiling, not flagged after the fact.
            </p>
          </ProseSection>
        </Reveal>

        <DocLinks
          links={[
            { href: "/docs/providers", title: "Model providers" },
            { href: "/docs/model-routing", title: "Model routing" },
            { href: "/docs/configuration", title: "Configuration" },
            { href: "/docs/audit-cost", title: "Audit trail & cost accounting" },
          ]}
        />
      </Container>

      <CTASection />
    </>
  );
}
