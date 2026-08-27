import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Prose } from "@/components/ui/Prose";
import { Section } from "@/components/ui/Section";
import { renderMarkdown } from "@/lib/docs";
import { allEntries, entryByName, type HubEntry } from "@/lib/hub";
import { type KitItem, kitItem, workflowPreamble, workflowStages } from "@/lib/kits";
import { SITE_URL } from "@/lib/utils";

interface ItemPageProps {
  params: Promise<{ name: string; item: string }>;
}

/** Which kind a slug belongs to, decided by the entry's own disclosure. */
function kindOf(entry: HubEntry, item: string): "skills" | "workflows" | undefined {
  if (entry.disclosure.skills?.some((skill) => skill.name === item)) return "skills";
  if (entry.disclosure.workflows?.some((workflow) => workflow.name === item)) return "workflows";
  return undefined;
}

/**
 * A page per skill and per workflow, for every first-party entry.
 *
 * Generated from the disclosure rather than from the tree, so the routes that
 * exist are exactly the ones the registry claims. A claimed item whose file is
 * missing still gets a page — one that says the file could not be read, which
 * is a more useful thing to publish than a 404 that looks like a typo.
 */
export function generateStaticParams(): { name: string; item: string }[] {
  return allEntries().flatMap((entry) => [
    ...(entry.disclosure.skills ?? []).map((skill) => ({ name: entry.name, item: skill.name })),
    ...(entry.disclosure.workflows ?? []).map((workflow) => ({
      name: entry.name,
      item: workflow.name,
    })),
  ]);
}

export async function generateMetadata({ params }: ItemPageProps): Promise<Metadata> {
  const { name, item } = await params;
  const entry = entryByName(name);
  if (!entry) return {};
  const kind = kindOf(entry, item);
  if (!kind) return {};

  const command = kind === "skills" ? `/${item}` : `/workflow ${item}`;
  const source = kitItem(name, kind, item);
  const description = source?.description ?? `${command} — part of the ${name} package.`;
  const url = `${SITE_URL}/hub/${name}/${item}`;
  return {
    title: `${command} — ${name}`,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      siteName: "Arcturn",
      title: `${command} — ${name}`,
      description,
      url,
    },
  };
}

/**
 * The prompt, rendered.
 *
 * Shown as prose rather than as a monospaced dump, because it *is* markdown —
 * that is how it is authored and how the model reads it, so rendering the
 * headings and emphasis is faithful rather than decorative. A raw dump made
 * every `**` and `##` visible noise in the one thing a reader came to read.
 *
 * Through the docs pipeline, which treats raw HTML in the source as text: this
 * body is package-supplied content, and it renders on the same origin as the
 * rest of the site.
 */
async function Body({ source, markdown }: { source: KitItem; markdown?: string }) {
  const { html } = await renderMarkdown(markdown ?? source.body);
  return <Prose html={html} />;
}

export default async function HubItemPage({ params }: ItemPageProps) {
  const { name, item } = await params;
  const entry = entryByName(name);
  if (!entry) notFound();
  const kind = kindOf(entry, item);
  if (!kind) notFound();

  const command = kind === "skills" ? `/${item}` : `/workflow ${item}`;
  const source = kitItem(name, kind, item);
  const declared =
    kind === "skills"
      ? entry.disclosure.skills?.find((skill) => skill.name === item)?.line
      : undefined;
  const workflow =
    kind === "workflows" ? entry.disclosure.workflows?.find((row) => row.name === item) : undefined;
  const stages = source && kind === "workflows" ? workflowStages(source.body) : [];

  return (
    <>
      <Container className="pt-12 md:pt-16">
        <Link
          href={`/hub/${entry.name}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-text sm:min-h-0"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          <span className="font-mono">{entry.name}</span>
        </Link>
        <div className="mt-6">
          <PageHeader
            eyebrow={kind === "skills" ? "Slash command" : "Pipeline"}
            title={command}
            lede={source?.description || declared || entry.description}
          />
        </div>
      </Container>

      {source === undefined ? (
        <Section density="tight">
          <p className="max-w-(--measure-body) text-body text-muted">
            This entry declares <code className="font-mono">{command}</code>, and its source is not
            in this repository — so the page can show what the registry discloses and not the file
            itself. Run <code className="font-mono">arcturn inspect {entry.source}</code> to read it
            from the package.
          </p>
        </Section>
      ) : (
        <>
          {kind === "workflows" ? (
            <Section
              density="tight"
              eyebrow="Shape"
              title="What runs, in order"
              lede={`${workflow?.stages ?? stages.length} stages${
                workflow?.budgetUsd === undefined
                  ? ""
                  : `, and the engine aborts the run at $${workflow.budgetUsd}`
              }. A stage with more than one step runs those beside each other.`}
            >
              <ol className="flex list-none flex-col gap-4">
                {stages.map((stage) => (
                  <li key={stage.number} className="flex gap-4">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-default font-mono text-caption text-muted"
                    >
                      {stage.number}
                    </span>
                    <ul className="flex min-w-0 flex-1 list-none flex-col gap-2 border-default border-b pb-4">
                      {stage.steps.map((step) => {
                        const role = /^@([a-z0-9-]+)/i.exec(step);
                        return (
                          <li key={step.slice(0, 80)} className="min-w-0">
                            {role ? (
                              <span className="mr-2 rounded border border-accent-edge bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] px-1.5 py-0.5 font-mono text-caption text-accent">
                                @{role[1]}
                              </span>
                            ) : null}
                            <span className="text-body-sm text-muted">
                              {role ? step.slice(role[0].length).trim() : step}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          <Section
            band
            eyebrow={kind === "skills" ? "The prompt" : "The reasoning"}
            title={kind === "skills" ? "What it actually sends" : "Why it is shaped this way"}
            lede={
              kind === "skills"
                ? "A skill is a prompt template, not code. This is the whole of it — expanded fresh on every call, with $ARGUMENTS and $1..$9 filled in from what you type."
                : "The pipeline file's own argument for its shape: which stages can write, which cannot, and where the human gate sits. The stages themselves are above."
            }
          >
            <Body
              source={source}
              markdown={kind === "workflows" ? workflowPreamble(source.body) : undefined}
            />
            {source.references.length === 0 ? null : (
              <div className="mt-6">
                <h3 className="text-body font-medium text-text">Reference files it reads</h3>
                <p className="mt-1.5 max-w-(--measure-body) text-body-sm text-muted">
                  Shipped beside the prompt and reachable from it as{" "}
                  <code className="font-mono">$SKILL_DIR</code>.
                </p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {source.references.map((reference) => (
                    <li
                      key={reference}
                      className="rounded border border-default bg-surface-sunken px-2 py-1 font-mono text-body-sm text-muted"
                    >
                      {reference}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {source.meta.length === 0 ? null : (
              <dl className="mt-6 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
                {source.meta.map((row) => (
                  <div key={row.key} className="contents">
                    <dt className="font-mono text-caption text-faint">{row.key}</dt>
                    <dd className="min-w-0 break-words text-body-sm text-muted">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
        </>
      )}

      <Section density="tight">
        <Prose>
          <p>
            Part of{" "}
            <Link href={`/hub/${entry.name}`} className="font-mono">
              {entry.name}
            </Link>
            . Install it with <code className="font-mono">arcturn add {entry.source}</code>, then
            type <code className="font-mono">{command}</code> in a session.
          </p>
        </Prose>
      </Section>
    </>
  );
}
