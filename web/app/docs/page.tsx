import { ArrowRight, BookOpen, Compass, KeyRound, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CTASection } from "@/components/site/CTASection";
import { ArcRule } from "@/components/ui/ArcRule";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/ui/Container";
import { LinkCard } from "@/components/ui/LinkCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { allDocs, docMetaBySlug, docNav } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Reference for the Arcturn CLI, the runtime and the SDK — permissions, sessions, providers, skills, hooks and the embeddable harness.",
};

/** The pages a first-time reader needs, in the order they need them. */
const START_HERE = [
  { slug: "providers", icon: KeyRound },
  { slug: "configuration", icon: Compass },
  { slug: "permissions", icon: ShieldCheck },
] as const;

function sectionId(section: string): string {
  return section.toLowerCase().replace(/\s+/g, "-");
}

export default function DocsIndexPage() {
  const nav = docNav();
  const total = allDocs().length;
  const gettingStarted = docMetaBySlug("getting-started");

  return (
    <>
      <Container className="pt-16 md:pt-20 lg:pt-24">
        <PageHeader
          eyebrow="Documentation"
          title="Documentation"
          lede={`${total} pages covering the CLI, the runtime and the SDK. Start by installing it; the rest is reference.`}
        />

        <div className="mt-10 grid gap-5 lg:grid-cols-[1.5fr_1fr_1fr]">
          {gettingStarted ? (
            <Card
              variant="accent"
              href={`/docs/${gettingStarted.slug}`}
              className="group lg:row-span-1"
            >
              <span className="flex items-center gap-2 text-eyebrow uppercase text-accent">
                <BookOpen className="size-4" aria-hidden="true" />
                Start here
              </span>
              <span className="mt-3 flex items-center gap-2 text-h3 text-text">
                {gettingStarted.title}
                <ArrowRight
                  aria-hidden="true"
                  className="size-5 shrink-0 text-accent transition-transform dur-fast ease-out group-hover:translate-x-0.5"
                />
              </span>
              <span className="mt-2 block max-w-[52ch] text-body-sm text-muted">
                {gettingStarted.description}
              </span>
            </Card>
          ) : null}

          {START_HERE.map(({ slug, icon: Icon }) => {
            const doc = docMetaBySlug(slug);
            if (!doc) return null;
            return (
              <Card key={slug} href={`/docs/${slug}`} className="group">
                <span className="flex items-start justify-between gap-3">
                  <Icon className="size-5 text-accent" aria-hidden="true" />
                  <ArrowRight
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-faint transition-colors dur-fast ease-out group-hover:text-accent"
                  />
                </span>
                <span className="mt-3 block text-h4 text-text">{doc.title}</span>
                <span className="mt-2 block text-body-sm text-muted">{doc.description}</span>
              </Card>
            );
          })}
        </div>
      </Container>

      {nav.map((group) => (
        <div key={group.section}>
          <ArcRule className="my-14" />
          <Container>
            <section aria-labelledby={`section-${sectionId(group.section)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id={`section-${sectionId(group.section)}`} className="text-h3 text-text">
                  {group.section}
                </h2>
                <p className="text-caption text-faint">
                  {group.items.length} {group.items.length === 1 ? "page" : "pages"}
                </p>
              </div>
              <ul className="mt-6 grid list-none gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((doc) => (
                  <li key={doc.slug}>
                    <LinkCard title={doc.title} body={doc.description} href={`/docs/${doc.slug}`} />
                  </li>
                ))}
              </ul>
            </section>
          </Container>
        </div>
      ))}

      <ArcRule className="my-14" />

      <Container>
        <p className="max-w-[68ch] text-body-sm text-muted">
          Prefer to read the source first?{" "}
          <Link
            href="/docs/architecture"
            className="text-accent underline decoration-1 underline-offset-4"
          >
            Architecture
          </Link>{" "}
          traces one turn end to end through the package map.
        </p>
      </Container>

      <CTASection />
    </>
  );
}
