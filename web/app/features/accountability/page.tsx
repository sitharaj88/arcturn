import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { TerminalMock } from "@/components/ui/TerminalMock";

const LEDE =
  "A run you can reconstruct: what it was allowed to do, what it cost, what it changed, and " +
  "how to get back.";

export const metadata: Metadata = {
  title: "Accountability",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Accountability — Arcturn",
    description: LEDE,
    url: "/features/accountability",
  },
};

const CHECKPOINT_LAYOUT = `~/.arcturn/checkpoints/<sessionId>/
├── manifest.jsonl   append-only log of turn / file / error records
└── blobs/<sha256>   content-addressed file snapshots`;

const REPLAY_SAMPLE = `$ arcturn replay 019c4a2f --model openai/gpt-5.1
arcturn: replaying 6 prompts on GPT-5.1
arcturn: [1/6] rate-limit the login route
{"prompt":"rate-limit the login route","finalText":"Added a 5-req…","toolCalls":["read","edit"],"costUsd":0.0412}
arcturn: [2/6] add a test for the limiter
{"prompt":"add a test for the limiter","finalText":"Added auth.test…","toolCalls":["read","write"],"costUsd":0.0388}
arcturn: replay total $0.2317`;

const BISECT_SAMPLE = `arcturn bisect <session> --cassette <file> [--model <id>] [--cwd <dir>]`;

const AUDIT_SAMPLE = `14:03:12  tool  bash  git status  ✓
14:03:20  perm  write  src/auth.ts  ask-allow
14:03:21  tool  write  src/auth.ts  ✓
14:03:44  perm  bash  rm -rf dist  ask-deny
14:04:02  hook  preToolUse  deny: no writes under infra/
14:04:19  tool  edit  src/auth.test.ts  ✗

4 tool calls, 1 denied, 1 hook veto`;

export default function AccountabilityPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Capabilities" title="Accountability" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection id="session-file" title="The session is a file">
            <p>
              Every session is a <Code>.jsonl</Code> file — a header line, then one JSON line per
              entry, appended in order. Sessions are bucketed per working directory under{" "}
              <Code>~/.arcturn/sessions/&lt;hash&gt;/</Code>, so resuming only ever offers you
              sessions from the same project root.
            </p>
            <p>
              The structure is a tree, not a flat log: every entry carries a <Code>parentId</Code>,
              so appending after an older entry starts a new branch instead of overwriting what came
              after. Resuming from three turns ago and trying a different approach is an ordinary
              operation, and both branches stay walkable afterwards.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="checkpoints"
            title="Checkpoints and /rewind"
            media={
              <div className="flex flex-col gap-5">
                <CodeBlock code={CHECKPOINT_LAYOUT} language="text" />
                <TerminalMock
                  variant="rewind"
                  description="A /rewind in an arcturn session: two files are restored to their pre-turn content and the conversation forks at turn 3, leaving both branches walkable."
                />
              </div>
            }
          >
            <p>
              Before a <Code>write</Code> or <Code>edit</Code> touches a file for the first time in
              a turn, Arcturn records that file’s content — or its absence, if it did not exist yet.
              Snapshots are content-addressed blobs with an append-only manifest, and a snapshot
              failure is written to the manifest as an error record rather than blocking the call
              that triggered it.
            </p>
            <p>
              <Code>/rewind</Code> picks a turn, restores the files that changed after it, and{" "}
              <strong className="text-text">forks</strong> the conversation rather than deleting it
              — every branch you rewound past stays reachable by resuming its own leaf.
            </p>
            <p>
              The limit, exactly: it covers <Code>write</Code> and <Code>edit</Code>. A shell
              command that mutates the tree is not checkpointed, so <Code>sed -i</Code> and{" "}
              <Code>rm</Code> are invisible to <Code>/rewind</Code>. The conversation side is
              genuinely non-destructive; the file side is a real disk mutation.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="replay"
            title="Replay"
            media={<CodeBlock code={REPLAY_SAMPLE} language="bash" />}
          >
            <p>
              <Code>arcturn replay &lt;session&gt;</Code> pulls the original prompts back out and
              re-runs them, one at a time, in order — against the same model or, with{" "}
              <Code>-m</Code>, another one. Progress goes to stderr and results are one JSON object
              per turn on stdout, carrying the prompt, final text, tool-call order and cost, so a
              replay pipes straight into a diff without cleanup.
            </p>
            <p>
              Replay is live, which makes it the tool for cross-model comparison and regression
              testing against a real provider — not for reproducing a run byte for byte. A turn that
              errors is recorded and the next prompt still runs.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="bisect"
            title="Bisect"
            media={<CodeBlock code={BISECT_SAMPLE} language="bash" />}
          >
            <p>
              <Code>arcturn bisect</Code> binary-searches the same prompts for the turn where
              behaviour left a recorded cassette. Each probe replays against a freshly loaded copy
              of the cassette, so the run is hermetic: no provider, no network, and the underlying
              tool’s <Code>execute</Code> is never invoked at all.
            </p>
            <p>
              A cassette is a JSONL recording of everything Arcturn does not control — LLM stream
              events and tool results, keyed by a content hash rather than by position. Cassettes
              are recorded through the SDK today; there is no CLI flag for it yet.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="blame" title="Blame and provenance">
            <p>
              <Code>arcturn blame &lt;file&gt;</Code> answers, per line, which turn wrote it and
              what evidence that turn was working from: files read, pages fetched, commands run —
              with anything that arrived from a fetch or an MCP server marked untrusted. Not who
              wrote a line, but which reasoning step did.
            </p>
            <p>
              It is opt-in, because the recording costs disk: set{" "}
              <Code>&quot;provenance&quot;: true</Code> in config to start capturing it.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="audit-cost"
            title="Audit trail and cost"
            media={<CodeBlock code={AUDIT_SAMPLE} language="text" />}
          >
            <p>
              <Code>arcturn audit</Code> answers a different question than blame — not why a line is
              here, but what happened in this session and what approved it. Every completed tool
              call, every interactive permission decision and every hook verdict is recorded as the
              run happens, not reconstructed afterwards. It is off by default; enable it with{" "}
              <Code>&quot;audit&quot;: true</Code>.
            </p>
            <p>
              Cost accounting has no opt-in — it is always on, updated after every turn.{" "}
              <Code>/cost</Code> prints current spend; <Code>--max-cost</Code> and{" "}
              <Code>/cost limit</Code> set a ceiling that aborts the run the moment cumulative spend
              reaches it, at the next turn boundary. Sub-agent spend counts against the same
              ceiling, which is otherwise trivially easy to treat as free.
            </p>
          </ProseSection>
        </Reveal>

        <DocLinks
          links={[
            { href: "/docs/sessions", title: "Sessions, branching & compaction" },
            { href: "/docs/checkpoints", title: "Checkpoints & /rewind" },
            { href: "/docs/replay-bisect", title: "Replay & bisect" },
            { href: "/docs/provenance", title: "Provenance & arcturn blame" },
            { href: "/docs/audit-cost", title: "Audit trail & cost accounting" },
            { href: "/docs/memory", title: "Project memory" },
          ]}
        />
      </Container>

      <CTASection />
    </>
  );
}
