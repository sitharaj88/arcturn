import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import { EntryCard } from "@/components/hub/EntryCard";
import { HubFilter } from "@/components/hub/HubFilter";
import { KindPrimer } from "@/components/hub/KindPrimer";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { allEntries, commandsFor, kindLabel, kindsInUse, orderedKinds } from "@/lib/hub";
import { REPO_URL } from "@/lib/utils";

const LEDE =
  "Packages you install with one command: slash commands you type, pipelines you run, and the " +
  "roles they hand work to — each listed with the disclosure you would want before you run it.";

/** The registry of record, where a listing is made. */
const REGISTRY_README = `${REPO_URL}/blob/main/registry/README.md`;

export const metadata: Metadata = {
  title: "Hub",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Hub — Arcturn",
    description: LEDE,
    url: "/hub",
  },
};

/**
 * The hub index (RFC 0002).
 *
 * The page is static: `registry/*.json` is read at export time and every card
 * is server-rendered. The only client code is `<HubFilter>`, which mounts a
 * subset of cards it was handed — so the whole catalogue is in the HTML for a
 * crawler, for a JS-less reader, and in the window before hydration.
 *
 * The standing paragraph below the grid is not filler. A catalogue with two
 * entries either explains itself or reads as abandoned, and the explanation —
 * curated, small on purpose, listing is a pull request — is the actual
 * moderation model rather than a placeholder for a future one.
 */
export default function HubIndexPage() {
  const entries = allEntries();
  const kinds = kindsInUse(entries).map((kind) => ({ value: kind, label: kindLabel(kind) }));

  return (
    <>
      <Container className="pt-16 md:pt-20 lg:pt-24">
        <PageHeader eyebrow="Registry" title="Hub" lede={LEDE} />
      </Container>

      {/* One section, not two: the primer explains the badges the grid below
          is covered in, so it belongs to the grid's beat rather than sitting a
          full rhythm away from the thing it is explaining. */}
      <Section density="tight" eyebrow="Vocabulary" title="What a package can contain">
        <KindPrimer />
        <div className="mt-10 md:mt-12">
          <HubFilter
            kinds={kinds}
            items={entries.map((entry) => ({
              name: entry.name,
              kinds: orderedKinds(entry),
              // Built here, not in the browser: the search runs over what an
              // entry *does* — its commands — as well as what it is called,
              // because "retry" and "accessibility" are the queries a reader
              // actually types and neither is a package name.
              haystack: [
                entry.name,
                entry.description,
                ...commandsFor(entry).flatMap((command) => [command.command, command.line]),
              ]
                .join(" ")
                .toLowerCase(),
              card: <EntryCard entry={entry} />,
            }))}
          />
        </div>
      </Section>

      <Section
        band
        eyebrow="How this works"
        title="Curated, and small on purpose"
        lede="The repository is the registry. There is no backend, no account and no upload endpoint — one JSON file per listed package, and a pull request to add one."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="min-w-0">
            <p className="max-w-(--measure-body) text-body text-muted">
              Every entry carries a{" "}
              <strong className="font-medium text-text">disclosure block</strong>: the agent roles
              it would install and the lane each one runs on, the workflows with their stage counts
              and budgets, the skills, the MCP servers, and whether any of it is executable code.
              The page you read and the install you run are built from the same file, so they cannot
              describe two different packages.
            </p>
            <p className="mt-4 max-w-(--measure-body) text-body text-muted">
              A listing is not an audit. It means a human read the source once and thought it was
              what it said it was. Before you install anything from here, run{" "}
              <code className="font-mono text-text">arcturn inspect</code> against the source and
              read what it derives from the package itself — that beats this page, always.
            </p>
          </div>

          <div className="min-w-0">
            <h3 className="text-h4 text-text">Listing a package</h3>
            <ol className="mt-4 flex list-none flex-col gap-3 border-y border-default py-4">
              <li className="min-w-0 text-body-sm text-muted">
                <span className="font-mono text-caption text-faint">1</span> Publish it where{" "}
                <code className="font-mono">arcturn add</code> can reach it — a public git repo, or
                a subdirectory of one.
              </li>
              <li className="min-w-0 text-body-sm text-muted">
                <span className="font-mono text-caption text-faint">2</span> Add{" "}
                <code className="font-mono">registry/&lt;name&gt;.json</code> with its disclosure
                block.
              </li>
              <li className="min-w-0 text-body-sm text-muted">
                <span className="font-mono text-caption text-faint">3</span> Open a pull request.
                Expect questions about anything the tree does not support.
              </li>
            </ol>
            <a
              href={REGISTRY_README}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-body-sm text-accent transition-colors dur-fast ease-out hover:text-accent-hover sm:min-h-0"
            >
              The schema and the curation stance
              <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
            </a>
          </div>
        </div>
      </Section>
    </>
  );
}
