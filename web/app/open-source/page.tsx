import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { AuthorCard } from "@/components/site/AuthorCard";
import { CTASection } from "@/components/site/CTASection";
import { Button } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { type StatusRow, StatusTable } from "@/components/ui/StatusTable";
import { REPO_URL } from "@/lib/utils";

const LEDE =
  "Apache-2.0, one maintainer, pre-1.0, no users yet. Here is how to check every claim on this " +
  "site yourself.";

export const metadata: Metadata = {
  title: "Open source",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Open source — Arcturn",
    description: LEDE,
    url: "/open-source",
  },
};

const STATUS_ROWS: StatusRow[] = [
  {
    name: "Licence",
    detail: "Apache-2.0 for all of it — no commercial-use restriction, no source-available catch.",
    status: { status: "proven", label: "Apache-2.0" },
  },
  {
    name: "Published to npm",
    detail: "Not yet. Install from source: clone the monorepo, pnpm install, pnpm -r build.",
    status: { status: "planned", label: "Not yet" },
  },
  {
    name: "Version",
    detail: "Pre-1.0. APIs may change between releases, and some of them will.",
    status: { status: "unproven", label: "Pre-1.0" },
  },
  {
    name: "Maintainers",
    detail: "One person, working on it in the open. Issues and pull requests are welcome.",
    status: { status: "unproven", label: "One" },
  },
  {
    name: "Production users",
    detail:
      "None that I know of. There are no adoption numbers to show you, so there are none here.",
    status: { status: "unreached", label: "None" },
  },
  {
    name: "Proven provider path",
    detail:
      "The OpenAI-compatible path, which has completed real multi-turn tool-calling sessions against a live endpoint. Everything else is unproven or unreached.",
    status: { status: "proven", label: "One" },
  },
];

const VERIFY_COMMANDS = `find packages -name "*.test.ts" | wc -l      # test files
grep -rE "^ +(it|test)[.(]" packages | wc -l # test cases
ls packages                                  # the package list`;

const CONTRIBUTE_COMMANDS = `git clone https://github.com/sitharaj88/arcturn.git
cd arcturn
pnpm install
pnpm build     # build all packages
pnpm check     # lint + typecheck
pnpm test      # run all tests`;

export default function OpenSourcePage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Project" title="Open source" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection id="licence" title="The licence">
            <p>
              Apache-2.0, all of it — the runtime, the tools, the CLI and this site. No
              commercial-use restriction, no source-available licence with a catch in clause four,
              no separate enterprise build with the interesting features in it.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button href={`${REPO_URL}/blob/main/LICENSE`} external variant="ghost">
                Read the licence
              </Button>
              <Button href={REPO_URL} external variant="quiet">
                Browse the source
              </Button>
            </div>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="status"
            title="Project status"
            media={<StatusTable rows={STATUS_ROWS} />}
          >
            <p>
              The useful thing I can offer instead of adoption numbers is a plain statement of where
              the project actually is, and evidence you can check yourself. Both are below.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="verify"
            title="Verify it yourself"
            media={<CodeBlock code={VERIFY_COMMANDS} language="bash" />}
          >
            <p>
              Run these, don’t take my word for it. Every number this project could quote about
              itself moves with every commit, so the commands are the claim — clone the repository
              and see what they print on <Code>main</Code> today.
            </p>
            <p>
              The same applies to the security page: every limit listed there is a property of code
              you can read, and every fix from the adversarial-review waves landed with a regression
              test verified to fail against the previous behaviour first. Those tests are in{" "}
              <Code>packages/*/src</Code> beside what they cover.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="contributing"
            title="Contributing"
            media={<CodeBlock code={CONTRIBUTE_COMMANDS} language="bash" />}
          >
            <p>
              Issues and pull requests on GitHub. There is no CLA. You need Node ≥ 20 and pnpm ≥ 10;
              the monorepo is a pnpm workspace, so a build is <Code>pnpm install</Code> then{" "}
              <Code>pnpm build</Code>.
            </p>
            <p>
              <Code>pnpm check</Code> runs lint and typecheck, <Code>pnpm test</Code> runs the
              suites. A change that touches a safety control is easiest to review when it arrives
              with the regression test that fails without it.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="author" title="The author">
            <p>
              Arcturn is built and maintained by Sitharaj Seenivasan. If it is useful to you, the
              links below are the ways to say so.
            </p>
          </ProseSection>
          <div className="mt-8">
            <AuthorCard />
          </div>
        </Reveal>
      </Container>

      <CTASection />
    </>
  );
}
