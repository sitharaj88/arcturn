import type { Metadata } from "next";
import { PILLARS } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { Container } from "@/components/ui/Container";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { LinkCard } from "@/components/ui/LinkCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { Section } from "@/components/ui/Section";

const LEDE =
  "Arcturn is one runtime with two front ends: a terminal coding agent and an embeddable " +
  "TypeScript harness. Here is what it does, grouped four ways.";

export const metadata: Metadata = {
  title: "Features",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Features — Arcturn",
    description: LEDE,
    url: "/features",
  },
};

/** The secondary capabilities (DESIGN.md §1.3, §3.2) — one line, one doc each. */
const EVERYTHING_ELSE = [
  {
    title: "LSP diagnostics",
    body: "Language-server errors and warnings appended to every write and edit result.",
    href: "/docs/lsp",
  },
  {
    title: "Verify loop",
    body: "Run a build, test or lint command after every edit and feed a failure straight back to the model.",
    href: "/docs/verify",
  },
  {
    title: "Deferred tools",
    body: "Progressive disclosure — withhold most tool schemas until the model asks for them.",
    href: "/docs/deferred-tools",
  },
  {
    title: "Context management",
    body: "Tool-output offloading and tool-result editing, with compaction as the backstop.",
    href: "/docs/context-management",
  },
  {
    title: "Project memory",
    body: "Durable notes the agent writes for itself, read back into every later session.",
    href: "/docs/memory",
  },
  {
    title: "Scouts",
    body: "Time-boxed parallel exploration of an approach in throwaway git worktrees.",
    href: "/docs/scouts",
  },
  {
    title: "Agent teams",
    body: "Disjoint subtasks, one agent per worktree, reconciled by applying patches back.",
    href: "/docs/teams",
  },
  {
    title: "Background agents",
    body: "A durable /bg task that runs off the foreground thread and can be adopted later.",
    href: "/docs/teams",
  },
  {
    title: "@-mentions & images",
    body: "Fuzzy file completion in the prompt editor, inline file content and image attachments.",
    href: "/docs/mentions",
  },
  {
    title: "Built-in tools",
    body: "read, write, edit, bash with background tasks, grep, glob, ls, fetch and websearch.",
    href: "/docs/tools",
  },
  {
    title: "Server mode",
    body: "Expose sessions to remote clients over a typed WebSocket protocol.",
    href: "/docs/server-mode",
  },
  {
    title: "Editor integration (ACP)",
    body: "Run Arcturn as an in-editor agent over the Agent Client Protocol.",
    href: "/docs/acp",
  },
  {
    title: "Telemetry",
    body: "Turn the event stream into an OTel-shaped span tree and a metrics union.",
    href: "/docs/telemetry",
  },
];

export default function FeaturesPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader title="Features" lede={LEDE} />
      </Container>

      <Section>
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

      <Section
        eyebrow="Also included"
        title="Everything else"
        lede="The rest of the surface, each a page of documentation away."
      >
        <div className="grid gap-5 sm:grid-cols-2 md:gap-6 lg:grid-cols-3">
          {EVERYTHING_ELSE.map((item, index) => (
            <Reveal key={item.title} delay={(index % 3) * 0.06}>
              <LinkCard title={item.title} body={item.body} href={item.href} />
            </Reveal>
          ))}
        </div>
      </Section>

      <CTASection />
    </>
  );
}
