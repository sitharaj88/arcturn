import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommandTable } from "@/components/hub/CommandTable";
import { DisclosureBlocks } from "@/components/hub/Disclosure";
import { KindBadges } from "@/components/hub/KindBadges";
import { CommandChip } from "@/components/ui/CommandChip";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import {
  allEntryNames,
  disclosureSummary,
  entryByName,
  installCommand,
  sourceUrl,
} from "@/lib/hub";
import { SITE_URL } from "@/lib/utils";

interface HubEntryPageProps {
  params: Promise<{ name: string }>;
}

/** Every route this page owns, straight from the registry directory. */
export function generateStaticParams(): { name: string }[] {
  return allEntryNames().map((name) => ({ name }));
}

export async function generateMetadata({ params }: HubEntryPageProps): Promise<Metadata> {
  const { name } = await params;
  const entry = entryByName(name);
  if (!entry) return {};

  const url = `${SITE_URL}/hub/${entry.name}`;
  const title = `${entry.name} — Hub`;
  return {
    title: entry.name,
    description: entry.description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "Arcturn",
      title,
      description: entry.description,
      url,
    },
    twitter: { card: "summary_large_image", title, description: entry.description },
  };
}

/**
 * One listed package (RFC 0002, *Disclosure before trust*).
 *
 * The order is the argument: the command comes first because it is what the
 * reader came for, and the disclosure sits under it — on its own band — so the
 * decision and the evidence for it are on one screen rather than one link
 * apart. Everything below the header is derived from the entry file; nothing
 * on this page is typed per package.
 */
export default async function HubEntryPage({ params }: HubEntryPageProps) {
  const { name } = await params;
  const entry = entryByName(name);
  if (!entry) notFound();

  const command = installCommand(entry);
  const source = sourceUrl(entry);

  return (
    <>
      <Container className="pt-16 md:pt-20">
        <Link
          href="/hub"
          className="inline-flex min-h-11 items-center gap-1.5 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-accent sm:min-h-0"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All packages
        </Link>

        <PageHeader className="mt-6" eyebrow="Hub" title={entry.name} lede={entry.description}>
          <KindBadges entry={entry} />
        </PageHeader>
      </Container>

      <Section density="tight">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0">
            <h2 className="text-h4 text-text">Install</h2>
            <CommandChip
              className="mt-4"
              command={command}
              caption={
                <>
                  Staged first, the resolved commit pinned in{" "}
                  <code className="font-mono">.arcturn-install.json</code>, then linked into the
                  roots Arcturn scans. Nothing is linked before the pin.
                </>
              }
            />
            <p className="mt-4 max-w-(--measure-body) text-body-sm text-muted">
              To see the table below derived from the package itself rather than from this entry,
              run <code className="font-mono text-text">arcturn inspect {entry.source}</code> — it
              stages exactly as an install would, links nothing, and prints what it would add.
            </p>
          </div>

          <div className="min-w-0">
            <h2 className="text-h4 text-text">Source</h2>
            <dl className="mt-4 border-y border-default">
              <div className="min-w-0 border-b border-default py-3">
                <dt className="text-caption uppercase tracking-wide text-faint">Repository</dt>
                <dd className="mt-1.5 min-w-0">
                  <a
                    href={source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-baseline gap-1.5 break-all text-body-sm text-accent transition-colors dur-fast ease-out hover:text-accent-hover sm:min-h-0"
                  >
                    <span className="min-w-0 break-all font-mono">{entry.source}</span>
                    <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 self-center" />
                  </a>
                </dd>
              </div>
              <div className="min-w-0 border-b border-default py-3">
                <dt className="text-caption uppercase tracking-wide text-faint">Maintainer</dt>
                <dd className="mt-1.5 min-w-0">
                  <a
                    href={entry.maintainer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-baseline gap-1.5 text-body-sm text-accent transition-colors dur-fast ease-out hover:text-accent-hover sm:min-h-0"
                  >
                    <span className="min-w-0 break-words">{entry.maintainer.name}</span>
                    <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 self-center" />
                  </a>
                </dd>
              </div>
              <div className="min-w-0 py-3">
                <dt className="text-caption uppercase tracking-wide text-faint">Contents</dt>
                <dd className="mt-1.5 min-w-0 text-body-sm text-muted">
                  {disclosureSummary(entry)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="Usage"
        title="What you would type"
        lede="Every command this package adds, in the form you would run it. A slash command is invoked by its own name; a pipeline goes through /workflow."
      >
        <CommandTable entry={entry} />
      </Section>

      <Section
        band
        eyebrow="Disclosure"
        title="What this would add to your machine"
        lede="Read in the same vocabulary the installer uses: derived lanes, declared tools, stage counts, budgets, and whether any of it is executable code."
      >
        <DisclosureBlocks entry={entry} />
      </Section>
    </>
  );
}
