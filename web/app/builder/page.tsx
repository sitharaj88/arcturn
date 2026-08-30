import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { BuilderApp } from "@/components/builder/BuilderApp";
import type { BuilderExample } from "@/components/builder/ImportPanel";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DefinitionTable } from "@/components/ui/DefinitionTable";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { kitsDir } from "@/lib/kits";

const LEDE =
  "Assemble an Arcturn workflow visually — stages, parallel branches, model tags and roles — " +
  "and take away the markdown file the CLI runs. Everything happens in your browser; nothing " +
  "is uploaded or stored.";

export const metadata: Metadata = {
  title: "Workflow builder",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Workflow builder — Arcturn",
    description: LEDE,
    url: "/builder",
  },
};

/**
 * The example picker's seeds: real kit workflows, read from disk at export
 * time via the same root `lib/kits.ts` reads — never a paraphrase, so the
 * builder demonstrably round-trips the files this repository actually ships.
 * A missing file drops its example rather than failing the export.
 */
const SEEDS = [
  { kit: "enterprise-org", name: "bug-fix", label: "bug-fix — four sequential stages" },
  { kit: "enterprise-org", name: "release-check", label: "release-check — parallel oracle lanes" },
  { kit: "rag-blueprint", name: "rag-setup", label: "rag-setup — nine stages, long preamble" },
];

function loadExamples(): BuilderExample[] {
  return SEEDS.flatMap((seed) => {
    try {
      const file = path.join(kitsDir(), seed.kit, "workflows", `${seed.name}.md`);
      return [
        { id: `${seed.kit}/${seed.name}`, label: seed.label, markdown: readFileSync(file, "utf8") },
      ];
    } catch {
      return [];
    }
  });
}

/** The one-line grammar, shown to crawlers and highlighted for everyone else. */
const SAMPLE = `---
name: review-and-fix
description: Reproduce, fix, then verify from two angles at once.
budgetUsd: 10
---
Prose before the first numbered line is documentation — the parser skips it.

1. @qa Reproduce the bug and write a failing test. Report: {{input}}
2. @developer Fix the code until that test passes. Repro: {{prev}}
3. Verify in parallel:
   - [tier:fast] Run the full suite over the fix: {{prev}}
   - @qa-adversarial Try to break the fix from a new angle: {{prev}}
`;

const FRONTMATTER_ROWS = [
  {
    term: <code className="font-mono">name</code>,
    definition:
      'Required. Lowercased and stripped to letters, digits and "-" — the builder warns when what you typed is not what installs.',
  },
  {
    term: <code className="font-mono">description</code>,
    definition: "One free-text line. Only the first colon on the line separates key from value.",
  },
  {
    term: <code className="font-mono">continueOnError</code>,
    definition: 'Exactly "true" or "false". When true, a failed stage does not stop the run.',
  },
  {
    term: <code className="font-mono">stepTimeoutMs</code>,
    definition: "Wall clock per step, a whole number of milliseconds above zero.",
  },
  {
    term: <code className="font-mono">maxStepRetries</code>,
    definition: "Transient-failure retries per step. A whole number; 0 disables retry.",
  },
  {
    term: <code className="font-mono">budgetUsd</code>,
    definition: "Run-level spend ceiling in US dollars. Decimals are legal; 0 disables it.",
  },
  {
    term: <code className="font-mono">budgetTokens</code>,
    definition: "Run-level token ceiling. A whole number of tokens; 0 disables it.",
  },
];

/**
 * The workflow builder (the HubFilter doctrine, DESIGN.md §3): a static
 * server-rendered shell whose only client code is `<BuilderApp>`. The grammar
 * reference below the island is real page content — a crawler or a JS-less
 * reader gets the file format itself, not an empty mount point.
 */
export default function BuilderPage() {
  const examples = loadExamples();

  return (
    <>
      <Container className="pt-16 md:pt-20 lg:pt-24">
        <PageHeader eyebrow="Tooling" title="Workflow builder" lede={LEDE} />
      </Container>

      <Section density="tight">
        <BuilderApp examples={examples} />
      </Section>

      <Section
        band
        eyebrow="The format"
        title="What the file means"
        lede="A workflow is one markdown file: optional frontmatter, optional prose, then a numbered list where every line is a step. The engine's parser is strict on purpose — a typo fails loudly instead of silently reaching a model."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="text-h4 text-text">Stages, branches, prefixes</h3>
            <p className="mt-3 max-w-(--measure-body) text-body-sm text-muted">
              Stages are numbered consecutively from 1, one physical line each. Indented{" "}
              <code className="font-mono text-text">-</code> bullets under a stage run as parallel
              branches; the parent line is then empty or a label ending in{" "}
              <code className="font-mono text-text">:</code>. A step line reads{" "}
              <code className="font-mono text-text">[model-tag] @role prompt</code>, in that order,
              both prefixes optional — a tag may name a tier (
              <code className="font-mono text-text">tier:judgment</code>) or a concrete model id.
            </p>
            <p className="mt-3 max-w-(--measure-body) text-body-sm text-muted">
              Three placeholders exist: <code className="font-mono text-text">{"{{input}}"}</code>{" "}
              is the text the workflow was invoked with,{" "}
              <code className="font-mono text-text">{"{{prev}}"}</code> the previous stage&apos;s
              output, and <code className="font-mono text-text">{"{{journal}}"}</code> the run
              journal so far. The last two have no value in stage 1, and anything else in double
              braces is a parse error, not passed-through text.
            </p>
            <div className="mt-5">
              <CodeBlock code={SAMPLE} language="markdown" filename="review-and-fix.md" />
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="text-h4 text-text">Frontmatter keys</h3>
            <div className="mt-4">
              <DefinitionTable rows={FRONTMATTER_ROWS} termHeader="Key" defHeader="Rule" />
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
