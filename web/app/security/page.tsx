import type { Metadata } from "next";
import Link from "next/link";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/ui/Container";
import { DocLinks } from "@/components/ui/DocLinks";
import { type LimitRow, LimitsTable } from "@/components/ui/LimitsTable";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { REPO_URL } from "@/lib/utils";

const LEDE =
  "Arcturn’s safety features are controls with edges, and the edges are written down. A safety " +
  "feature whose limits you can’t see is worse than no feature, because you’ll trust it.";

export const metadata: Metadata = {
  title: "Security",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Security — Arcturn",
    description: LEDE,
    url: "/security",
  },
};

const CONTROLS = [
  {
    title: "Permission engine",
    body: "A rule-based allow/deny/ask resolver checked by the tool dispatcher before a tool’s execute is reached. Rules are scoped session over project over user, and a more specific deny beats a broader permissive rule even from a nearer scope.",
  },
  {
    title: "Checkpoints",
    body: "Before a write or edit touches a file for the first time in a turn, its prior content — or its absence — is stored as a content-addressed blob. /rewind restores those files and forks the conversation instead of deleting it.",
  },
  {
    title: "Dry-run overlay",
    body: "--dry-run reroutes every file mutation into a shadow copy of the workspace. You review one aggregate diff with /diff, then /apply writes back through a temp-file-plus-rename, or /discard deletes the shadow tree.",
  },
  {
    title: "OS sandbox",
    body: 'Opt-in, and separate from dry run: with "sandbox": "workspace-write", a bash command is wrapped by sandbox-exec on macOS or Bubblewrap on Linux. Writes are denied everywhere except the working directory, the OS temp directory and $HOME/.arcturn.',
  },
  {
    title: "Taint tracking",
    body: "Distinctive text from fetch, websearch and MCP output is remembered, and a later mutating call whose arguments repeat it is flagged. Extraction is biased toward silence — a tracker that cries wolf gets turned off.",
  },
  {
    title: "Canary tokens",
    body: "High-entropy decoy tokens, or real secret values you register yourself, are watched on the way out. Any egress-capable tool call whose arguments contain one verbatim is treated as exfiltration in progress.",
  },
  {
    title: "Cost ceiling",
    body: "Cost accounting is always on and updated after every turn. --max-cost aborts the run the moment cumulative spend reaches the ceiling, including spend from sub-agents — an enforcement mechanism, not a warning.",
  },
  {
    title: "Audit trail",
    body: 'An append-only log of every completed tool call, every interactive permission decision and every hook verdict, recorded as the run happens rather than reconstructed afterwards. Enable it with "audit": true.',
  },
];

const LIMITS: LimitRow[] = [
  {
    control: "Permission engine",
    limit: (
      <>
        Two edges, both structural. <Code>alwaysAllowTools</Code> is consulted at step 1 of
        resolution, before any rule: a tool on that list is allowed without the rule set being
        reached at all, so a host that widens it past the runtime’s own <Code>todo</Code> and{" "}
        <Code>plan</Code> puts those tools beyond even a <Code>deny</Code>. And a rule matches the
        subject a tool reports — an absolute path from <Code>write</Code> and <Code>edit</Code>, the
        command line from <Code>bash</Code>, tested per shell segment — so a path rule never sees
        the path a shell command reaches by another spelling: <Code>deny **/*.env</Code> stops an{" "}
        <Code>edit</Code> of that file and does not stop <Code>cat .env</Code>.
      </>
    ),
  },
  {
    control: "Checkpoints and /rewind",
    limit: (
      <>
        Only <Code>write</Code> and <Code>edit</Code> are checkpointed. A shell command that mutates
        the tree is not, so <Code>sed -i</Code> and <Code>rm</Code> are invisible to{" "}
        <Code>/rewind</Code> and will not come back. The conversation side is genuinely
        non-destructive; the file side is a real disk mutation.
      </>
    ),
  },
  {
    control: "Dry-run overlay",
    limit: (
      <>
        <Code>--dry-run</Code> deliberately does not wrap <Code>bash</Code>, <Code>grep</Code> or{" "}
        <Code>glob</Code> — they take commands and patterns rather than a single path — so a shell
        command still reads and mutates the real tree while dry-run is active.
      </>
    ),
  },
  {
    control: "Canary tokens",
    limit: (
      <>
        Matching is exact substring containment, so any encoding of the secret defeats it
        completely: base64 the value and nothing fires. It catches a verbatim leak, not a determined
        exfiltrator.
      </>
    ),
  },
  {
    control: "Taint tracking",
    limit: (
      <>
        Matching is substring containment over whitespace-normalized text, one direction only and
        case-sensitive. A genuine echo of an injected instruction is verbatim; an instruction the
        model paraphrases rather than repeats is not detected.
      </>
    ),
  },
  {
    control: "OS sandbox",
    limit: (
      <>
        It narrows write access only — reads, network access and process spawning are left alone —
        and it needs a backend: <Code>sandbox-exec</Code> on macOS or <Code>bwrap</Code> on Linux.
        Anything else is unsupported.
      </>
    ),
  },
  {
    control: "Speculative approval",
    limit: (
      <>
        Not one of the eight above: speculation is off by default and is introduced on{" "}
        <Link
          href="/features/control"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
        >
          Control
        </Link>
        . Only <Code>write</Code> and <Code>edit</Code> can be speculated, because only file
        mutations can be undone by throwing a directory away. Everything else is blocked outright
        while a speculation is open — including a <Code>bash</Code> call that would only have
        touched files, because the wrapper cannot know that in advance.
      </>
    ),
  },
  {
    control: "Cost ceiling",
    limit: (
      <>
        The guard checks cumulative cost after every turn, so it aborts at the next turn boundary
        rather than mid-turn. A limit of <Code>0</Code>, or leaving it unset, disables the guard
        entirely.
      </>
    ),
  },
  {
    control: "Audit trail and provenance",
    limit: (
      <>
        Both are off by default and record only while enabled — a session you did not turn them on
        for cannot be reconstructed retroactively. The permission log captures the interactive ask
        path only: a decision resolved automatically by a rule or by the mode has no{" "}
        <Code>toolName</Code> to attribute and never reaches it, though the tool call itself is
        still captured.
      </>
    ),
  },
];

export default function SecurityPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Trust" title="Security" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection id="choke-point" title="The choke point">
            <p>
              Enforcement happens in one place: the runtime’s tool dispatcher checks the permission
              engine and returns a denial before a tool’s <Code>execute</Code> is ever reached.
              There is no second path into a tool, which is the property that makes the rest of this
              page meaningful — a control with two entrances is not a control.
            </p>
            <p>
              Read-only tools pass without a prompt. <Code>fetch</Code> is deliberately excluded
              from that list: it reads nothing local but sends data to an arbitrary host, so it is
              gated like a mutating tool. Anything that reaches the ask step with no permission
              requester configured resolves to deny — and in non-interactive mode, where there is no
              user to answer, a check that would have prompted is denied automatically with a note
              on stderr saying which flag would have allowed it.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="controls" title="The controls">
            <p>
              Eight layers, each doing one thing. None of them is a boundary you should treat as
              airtight on its own; together they are the difference between an agent you supervise
              and an agent you hope about.
            </p>
          </ProseSection>
          <div className="mt-8 grid gap-5 md:grid-cols-2 md:gap-6">
            {CONTROLS.map((control, index) => (
              <Reveal key={control.title} delay={(index % 2) * 0.06}>
                <Card className="h-full">
                  <h3 className="text-h4 text-text">{control.title}</h3>
                  <p className="mt-2 text-body-sm text-muted">{control.body}</p>
                </Card>
              </Reveal>
            ))}
          </div>
        </Reveal>

        <Reveal>
          <ProseSection id="limits" title="Known limits">
            <p>
              Every control above has an edge it does not cover. These are disclosures, not failures
              — they are here so that you calibrate to what the feature actually does rather than to
              its name.
            </p>
          </ProseSection>
          <div className="mt-8">
            <LimitsTable rows={LIMITS} />
          </div>
        </Reveal>

        <Reveal>
          <ProseSection id="adversarial-review" title="Adversarial review">
            <p>
              The codebase has been through four waves of adversarial review — parallel reviewers
              whose only job was to break the new seams. The findings are published here rather than
              quietly patched out, because a security feature that has never been adversarially
              poked at is a claim, not a control.
            </p>
            <p>The findings were not cosmetic:</p>
            <ul className="ml-6 list-disc space-y-2 text-body text-muted marker:text-faint">
              <li>
                <Code>/apply</Code> could write outside the workspace through an in-workspace
                symlink.
              </li>
              <li>Served sessions and sub-agents escaped the audit trail entirely.</li>
              <li>
                The WebSocket upgrade had no <Code>Origin</Code> check, so any web page could drive
                a loopback server.
              </li>
              <li>
                Two features were present but unreachable: the canary guard was watching a generated
                token nobody had ever seen, and speculative approval could never shelter a single
                byte because tools ran sequentially.
              </li>
            </ul>
            <p>
              Every fix landed with a regression test verified to fail against the previous
              behaviour first.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="reporting" title="Reporting a vulnerability">
            <p>
              Open an issue on GitHub. If you would rather not describe the problem in public, open
              an issue saying so and I will follow up there.
            </p>
            <p>
              This is a pre-1.0, single-maintainer project; there is no SLA. I would still rather
              hear about it than not.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button href={`${REPO_URL}/issues`} external variant="ghost">
                Open an issue
              </Button>
              <Button href="/open-source" variant="quiet">
                Project status
              </Button>
            </div>
          </ProseSection>
        </Reveal>

        <DocLinks
          links={[
            { href: "/docs/permissions", title: "Permissions" },
            { href: "/docs/injection-defense", title: "Injection defense" },
            { href: "/docs/dry-run", title: "Dry run & sandbox" },
            { href: "/docs/audit-cost", title: "Audit trail & cost accounting" },
          ]}
        />
      </Container>

      <CTASection
        title="Read the limits, then run it."
        lede="Every control on this page has an edge, and every edge is written down. Start a session and watch the first one hold."
      />
    </>
  );
}
