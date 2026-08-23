import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { type StatusRow, StatusTable } from "@/components/ui/StatusTable";

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

/**
 * Rows from `content/docs/providers.md`; statuses from the disclosure in
 * `content/blog/why-arcturn.md`. No status here may be upgraded without that
 * disclosure changing first.
 */
const PROVIDER_ROWS: StatusRow[] = [
  {
    name: "openai-compatible",
    detail:
      "Any OpenAI-shaped endpoint, credentials per endpoint. Has completed real multi-turn tool-calling sessions.",
    status: { status: "proven" },
  },
  {
    name: "anthropic",
    detail: "Claude, direct — ANTHROPIC_API_KEY, or an OAuth subscription sign-in.",
    status: { status: "unproven" },
  },
  {
    name: "openai",
    detail: "GPT via Chat Completions — OPENAI_API_KEY.",
    status: { status: "unproven" },
  },
  {
    name: "openai-responses",
    detail: "GPT via the Responses API — OPENAI_API_KEY.",
    status: { status: "unproven" },
  },
  {
    name: "google",
    detail: "Gemini, direct — GOOGLE_API_KEY (GEMINI_API_KEY also works).",
    status: { status: "unproven" },
  },
  {
    name: "anthropic-compatible",
    detail: "Any Anthropic-Messages endpoint, credentials per endpoint.",
    status: { status: "unproven" },
  },
  {
    name: "bedrock",
    detail: "Claude, Nova, Llama, Mistral and Titan on AWS — the standard AWS provider chain.",
    status: { status: "unreached" },
  },
  {
    name: "vertex",
    detail: "Gemini and Claude on Google Cloud — application-default credentials.",
    status: { status: "unreached" },
  },
  {
    name: "azure",
    detail: "GPT on Azure OpenAI, addressed by deployment — AZURE_OPENAI_API_KEY or Entra ID.",
    status: { status: "unreached" },
  },
];

const MODEL_COMMANDS = `arcturn --model anthropic/claude-sonnet-4-5
arcturn --model openai/gpt-5.1
arcturn --model google/gemini-3-pro-preview

arcturn --list-models        # the catalog, then exit
arcturn --list-providers     # every provider and preset endpoint`;

const ROUTER_TABLE = `main         the main conversation loop
subagent     delegated sub-agent work — often mechanical, so a cheaper model is fine
compaction   summarizing history when the context window fills
title        session-title suggestions — a few words`;

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
                  Status means exactly what it says. Exactly one provider path has completed real
                  multi-turn tool-calling sessions against a live endpoint — the OpenAI-compatible
                  one. The first-party Anthropic, OpenAI and Google adapters are unproven against
                  real traffic, and Bedrock, Vertex and Azure have never reached their endpoints at
                  all.
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
              each. Thirty-five endpoint presets ship as remembered{" "}
              <Code>{"{ baseUrl, apiKeyEnv, protocol }"}</Code> triples — and a preset is a
              convenience, not a gate: any endpoint works by URL without one.
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
              Four call sites can use four different models instead of one flagship everywhere. A
              missing route falls back to whatever <Code>main</Code> resolved to, and a bad id is
              caught rather than thrown — the kind falls back and records a warning, because a stale
              model id in a config file must never be the reason Arcturn fails to start.
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
